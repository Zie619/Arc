import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GateDef } from '../src/types.ts'
import { runGate, isSubsetOfBaseline, checkOutcome, type GateResult } from '../src/gates.ts'

function gate(command: string, timeoutMs = 2_000, envAllowlist?: string[]) {
  return GateDef.parse({ name: 'probe', command, proves: 'the probe', timeoutMs, envAllowlist })
}

/**
 * sandbox-exec cannot nest — inside another sandbox (a codex agent running
 * this suite, some CI setups) it dies with "sysmond service not found".
 * Skipping there is honest: the sandbox behavior is unobservable, not broken.
 */
export const sandboxUsable = (() => {
  if (process.platform !== 'darwin') return false
  try {
    execSync(`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`, { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch { return false }
})()

describe('async gates', () => {
  it('does not freeze the event loop while a project check runs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-gate-'))
    let painted = false
    const run = runGate(gate(`node -e "setTimeout(() => {}, 100)"`), cwd, 'base')
    setTimeout(() => { painted = true }, 10)
    const result = await run
    expect(painted).toBe(true)
    expect(result.pass).toBe(true)
  })

  it('fails closed on timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-gate-'))
    const result = await runGate(gate(`node -e "setTimeout(() => {}, 5000)"`, 30), cwd, 'base')
    expect(result.timedOut).toBe(true)
    expect(result.pass).toBe(false)
    expect(result.exitCode).toBeNull()
  })

  it('never hands the operator shell credentials to a gate command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-gate-'))
    process.env.GITHUB_TOKEN_GATE_PROBE = 'leaked'
    try {
      const result = await runGate(gate('echo -n "${GITHUB_TOKEN_GATE_PROBE:-}${AWS_SECRET_ACCESS_KEY:-}"'), cwd, 'base')
      expect(result.pass).toBe(true)
      expect(result.output).toBe('')
    } finally {
      delete process.env.GITHUB_TOKEN_GATE_PROBE
    }
  })

  it('passes through only variables the gate declared it needs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-gate-'))
    process.env.GATE_DECLARED_VALUE = 'declared'
    process.env.GATE_UNDECLARED_VALUE = 'undeclared'
    try {
      const result = await runGate(
        gate('echo -n "${GATE_DECLARED_VALUE:-}|${GATE_UNDECLARED_VALUE:-}"', 2_000, ['GATE_DECLARED_VALUE']),
        cwd, 'base',
      )
      expect(result.output).toBe('declared|')
    } finally {
      delete process.env.GATE_DECLARED_VALUE
      delete process.env.GATE_UNDECLARED_VALUE
    }
  })

  it.skipIf(!sandboxUsable)('denies writes to a read-only gate while reads still work', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-gate-'))
    writeFileSync(join(cwd, 'data.txt'), 'readable\n')
    // A reviewer-authored "check" that also mutates — the exact shape a real
    // reviewer produced in the first dogfood run (`npm version patch`).
    const mutating = GateDef.parse({
      name: 'probe', command: 'cat data.txt && echo HACKED > data.txt', proves: 'the probe',
      timeoutMs: 4_000, readOnly: true,
    })
    const result = await runGate(mutating, cwd, 'base')
    expect(result.pass).toBe(false)
    expect(readFileSync(join(cwd, 'data.txt'), 'utf8')).toBe('readable\n')

    const reading = GateDef.parse({
      name: 'probe', command: 'grep -q readable data.txt', proves: 'the probe',
      timeoutMs: 4_000, readOnly: true,
    })
    expect((await runGate(reading, cwd, 'base')).pass).toBe(true)
  })

  it('kills a gate when the operator cancels', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-gate-'))
    const controller = new AbortController()
    const run = runGate(gate(`node -e "setTimeout(() => {}, 5000)"`), cwd, 'base', controller.signal)
    setTimeout(() => controller.abort(), 30)
    const result = await run
    expect(result.pass).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.durationMs).toBeLessThan(1_000)
  })
})

function result(over: Partial<GateResult> = {}): GateResult {
  return {
    name: 'probe', command: 'x', proves: 'y', exitCode: 1, pass: false, timedOut: false,
    output: '', signature: '', baseSha: 'base', durationMs: 1, sandboxed: false, ...over,
  }
}

describe('baseline comparison fails closed', () => {
  // The trailing \b in the old pattern meant `failed`, `errors` and `failure`
  // never matched — so `.every()` ran over an EMPTY list and every red gate
  // from a normal runner was accepted as "within baseline".
  const vitestRed = 'Tests  2 failed | 5 passed\nFAIL  src/a.test.ts > does the thing'

  it('sees the failure lines a real runner prints', () => {
    const baseline = result({ signature: 'Tests  1 failed | 6 passed' })
    expect(isSubsetOfBaseline(result({ signature: vitestRed }), baseline)).toBe(false)
  })

  it('refuses a red result whose output yields no failure line at all', () => {
    // Unparseable is not proven-equivalent. Vacuous truth is how a red gate
    // walked through this function untouched.
    expect(isSubsetOfBaseline(result({ signature: 'exited oddly' }), result({ signature: 'exited oddly too' })))
      .toBe(false)
  })

  it('refuses a run that never finished, however green the baseline looked', () => {
    expect(isSubsetOfBaseline(result({ timedOut: true, exitCode: null }), result({ signature: 'FAIL a' })))
      .toBe(false)
    expect(isSubsetOfBaseline(result({ exitCode: null, pass: false }), result({ signature: 'FAIL a' })))
      .toBe(false)
  })

  it('still accepts a genuine subset of the same failures', () => {
    const baseline = result({ signature: 'FAIL a\nFAIL b' })
    expect(isSubsetOfBaseline(result({ signature: 'FAIL a' }), baseline)).toBe(true)
  })
})

describe('a check that could not RUN refuted nothing', () => {
  it('separates refuted from could-not-run', () => {
    expect(checkOutcome(result({ pass: true, exitCode: 0 }))).toBe('reproduced')
    expect(checkOutcome(result({ exitCode: 1 }))).toBe('refuted')
    expect(checkOutcome(result({ exitCode: 127 }))).toBe('could-not-run')   // no such command
    expect(checkOutcome(result({ exitCode: 126 }))).toBe('could-not-run')   // not executable
    expect(checkOutcome(result({ timedOut: true, exitCode: null }))).toBe('could-not-run')
    // sandbox-exec exits 71 when Seatbelt refuses to nest: the command never ran.
    expect(checkOutcome(result({ exitCode: 71, sandboxed: true }))).toBe('could-not-run')
    expect(checkOutcome(result({ exitCode: 71, sandboxed: false }))).toBe('refuted')
  })
})
