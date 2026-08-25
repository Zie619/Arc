import { spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { normalizeFailureSignature } from './classify.ts'
import { buildGateChildEnv } from './provider-runtime.ts'
import type { GateDef } from './types.ts'

/**
 * A gate is DATA: a command, the property it proves, and an expected baseline.
 *
 * Rules encoded here, each of which is a documented failure from the source
 * material:
 *   - capture the exit code DIRECTLY; never end a pipeline in `tail`, which
 *     returns tail's own exit code and reports a red build as green
 *   - a check that TIMES OUT or CRASHES is FAILED, never passing
 *   - a gate result carries the base sha it was computed against, and is
 *     invalid the moment the integration target moves past it
 *   - grep CLASSIFIES failures; it never DETECTS them
 */

export interface GateResult {
  name: string
  command: string
  proves: string
  exitCode: number | null
  pass: boolean
  timedOut: boolean
  output: string
  signature: string
  baseSha: string
  durationMs: number
  /** Whether the deny-write profile ACTUALLY applied. A readOnly gate that ran
   *  without one is not the same evidence, and must not be recorded as if it were. */
  sandboxed: boolean
}

// Deny-write profile for reviewer-authored commands. Temp dirs and /dev stay
// writable so ordinary read-only tooling (node, grep pipelines) still runs —
// but the tree being checked gets a FINAL deny (seatbelt: last match wins),
// because a repo or worktree can itself live under a temp path.
const READ_ONLY_PROFILE =
  '(version 1)(allow default)(deny file-write*)' +
  '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev"))'

/**
 * Seatbelt refuses to NEST — a profile cannot even tighten inside another one.
 * `sandbox-exec` then exits 71 without ever running the command, which is
 * indistinguishable from a check that failed to reproduce. That fires on every
 * read-only gate whenever arc itself is invoked from inside a sandboxed agent
 * session, so probe once and stop launching a sandbox that cannot apply.
 */
let sandboxProbe: boolean | undefined
export function sandboxUsable(): boolean {
  if (sandboxProbe !== undefined) return sandboxProbe
  if (process.platform !== 'darwin') { sandboxProbe = false; return sandboxProbe }
  const probe = spawnSync('/usr/bin/sandbox-exec',
    ['-p', '(version 1)(allow default)(deny file-write*)', '/usr/bin/true'],
    { stdio: 'ignore', timeout: 5_000 })
  sandboxProbe = probe.status === 0
  return sandboxProbe
}

function gateArgv(gate: GateDef, dir: string): { bin: string; args: string[]; sandboxed: boolean } {
  if (gate.readOnly && sandboxUsable()) {
    const target = JSON.stringify(realpathSync(dir))
    const profile = `${READ_ONLY_PROFILE}(deny file-write* (subpath ${target}))`
    return { bin: '/usr/bin/sandbox-exec', args: ['-p', profile, 'bash', '-c', gate.command], sandboxed: true }
  }
  return { bin: 'bash', args: ['-c', gate.command], sandboxed: false }
}

export async function runGate(
  gate: GateDef,
  cwd: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<GateResult> {
  const started = Date.now()
  const dir = isAbsolute(gate.cwd) ? gate.cwd : join(cwd, gate.cwd)
  const { bin, args, sandboxed } = gateArgv(gate, dir)
  return await new Promise<GateResult>((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    const child = spawn(bin, args, {
      cwd: dir,
      env: buildGateChildEnv(process.env, gate.envAllowlist ?? []),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-64 * 1024 * 1024)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const kill = (): void => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const trimmed = output.trim()
      const exitCode = timedOut || signal?.aborted ? null : code
      const pass = !timedOut && !signal?.aborted && exitCode === 0
      resolve({
        name: gate.name, command: gate.command, proves: gate.proves,
        exitCode, pass, timedOut,
        output: trimmed.slice(-20_000),
        signature: normalizeFailureSignature(trimmed),
        baseSha, durationMs: Date.now() - started, sandboxed,
      })
    }
    const abort = (): void => { kill() }
    const timer = setTimeout(() => { timedOut = true; kill() }, gate.timeoutMs)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

/**
 * Compare a result against a baseline measured on the SAME base sha in the
 * SAME run.
 *
 * Requiring equality turns ordinary flake into a false red — the baseline of a
 * real suite drifts by a few files between runs. So the rule is SUBSET: the
 * task may not introduce a failure the baseline did not already have.
 */
export function isSubsetOfBaseline(result: GateResult, baseline: GateResult): boolean {
  // A run that did not FINISH proved nothing. Its signature is empty or partial,
  // so every comparison below would be vacuous — and `[].every()` is true, which
  // would report a timed-out gate as within baseline.
  if (result.timedOut || result.exitCode === null) return false
  if (result.pass) return true
  if (baseline.pass) return false // baseline was green, we are red: genuinely ours

  const newLines = failureLines(result.signature)
  // Fail closed. A red gate whose output we could not parse into failure lines
  // is not a PROVEN subset of anything; accepting it is the vacuous-truth hole
  // that let ordinary `2 failed | 5 passed` runner output through untouched.
  if (newLines.length === 0) return false
  const baseLines = new Set(failureLines(baseline.signature))
  return newLines.every((l) => baseLines.has(l))
}

/**
 * Classify, never detect (see the header). Deliberately NO trailing `\b`: the
 * word is `failed`, `failure`, `errors` far more often than it is bare `fail`,
 * and a trailing boundary makes the pattern miss every one of them. Over-matching
 * is the safe direction — an extra line the baseline lacks fails the gate.
 */
function failureLines(signature: string): string[] {
  return signature
    .split('\n')
    .filter((l) => /(fail|error|✗|✕|err!)/i.test(l))
    .map((l) => l.trim())
}

/**
 * How many tests a run actually EXECUTED, when the runner says so.
 *
 * A gate comparison over failure lines is structurally blind to deletion: a
 * removed test produces no failure line, so deleting the inconvenient tests
 * makes every gate strictly greener, forever, and the evidence system records
 * `checked` against a proof that no longer exists. Nothing else in Arc would
 * notice — the footprint audit records a test-file edit as a note.
 *
 * Deliberately conservative: an unrecognised runner returns undefined and the
 * count check simply does not apply, rather than guessing a number and failing
 * honest work. `protectedGatePaths` covers what this cannot parse.
 */
export function testsExecuted(output: string): number | undefined {
  // vitest: "Tests  2 failed | 5 passed (7)" — the parenthesised total.
  const vitest = output.match(/^\s*Tests\s+.*?\((\d+)\)\s*$/m)
  if (vitest) return Number(vitest[1])
  // jest: "Tests:       2 failed, 5 passed, 7 total"
  const jest = output.match(/^\s*Tests:\s+.*?(\d+)\s+total\s*$/m)
  if (jest) return Number(jest[1])
  // pytest: "5 passed, 2 failed in 0.42s" / "7 passed in 0.1s"
  const pytest = output.match(/^=+\s*(.*?\b\d+ (?:passed|failed|error).*?)\s+in\s+[\d.]+s\s*=+$/m)
  if (pytest) {
    const counts = [...pytest[1]!.matchAll(/(\d+)\s+(?:passed|failed|xfailed|xpassed|error(?:s)?)\b/g)]
    if (counts.length > 0) return counts.reduce((n, m) => n + Number(m[1]), 0)
  }
  return undefined
}

/**
 * The gate surface a task may not quietly move. A green suite that got green by
 * losing tests is the canonical reward-hacking vector, and `isSubsetOfBaseline`
 * cannot see it: `result.pass` short-circuits before any comparison happens.
 */
export function testsVanished(result: GateResult, baseline: GateResult): number {
  const before = testsExecuted(baseline.output)
  const after = testsExecuted(result.output)
  if (before === undefined || after === undefined) return 0
  return Math.max(0, before - after)
}

export type CheckOutcome = 'reproduced' | 'refuted' | 'could-not-run'

/**
 * Three outcomes, not two. A command that could not RUN — missing binary,
 * a sandbox that refused to launch, a timeout — proved nothing in either
 * direction. Calling that "did not reproduce" silently deletes the reviewer's
 * evidence, which is the one thing this system exists not to do.
 */
export function checkOutcome(r: GateResult): CheckOutcome {
  if (r.pass) return 'reproduced'
  // 126/127: not executable / not found. 71: sandbox-exec could not apply its
  // profile, so the command never ran at all.
  if (r.timedOut || r.exitCode === null) return 'could-not-run'
  if (r.exitCode === 126 || r.exitCode === 127) return 'could-not-run'
  if (r.sandboxed && r.exitCode === 71) return 'could-not-run'
  return 'refuted'
}

export function selectGates(all: GateDef[], names: string[]): GateDef[] {
  if (names.length === 0) return all.filter((g) => !g.heavy)
  const byName = new Map(all.map((g) => [g.name, g]))
  const out: GateDef[] = []
  for (const n of names) {
    const g = byName.get(n)
    if (!g) throw new Error(`unknown gate "${n}" — declared gates are: ${[...byName.keys()].join(', ')}`)
    out.push(g)
  }
  return out
}

/** A one-line human summary. Says what it PROVED, not just that it passed. */
export function describe(r: GateResult): string {
  if (r.timedOut) return `${r.name}: TIMED OUT after ${Math.round(r.durationMs / 1000)}s → FAILED (a check that hangs is a broken check)`
  return `${r.name}: ${r.pass ? 'pass' : `FAIL (exit ${r.exitCode})`} — proves: ${r.proves}`
}

/**
 * Minimal glob for operator-authored path patterns: `*` matches inside a path
 * segment, `**` crosses segments, and `** /` (no space) also matches zero
 * directories so `**\/*.test.*` catches a test file at the repo root.
 * Deliberately not a dependency.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c !== '*') { rx += /[a-zA-Z0-9/_-]/.test(c) ? c : `\\${c}`; continue }
    if (pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { rx += '(?:.*/)?'; i += 2 } else { rx += '.*'; i += 1 }
    } else rx += '[^/]*'
  }
  return new RegExp(`^${rx}$`).test(path)
}
