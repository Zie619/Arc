import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { resolve, join, dirname } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dispatch, extractJson, checkModel, auxiliaryModels, codexSessionModels, capacityFailure } from '../src/harness.ts'
import { resetHelpProbeCacheForTests } from '../src/provider-runtime.ts'
import { TaskResult, type RoleBinding } from '../src/types.ts'

/**
 * Dispatch is exercised against FAKE CLI executables on PATH. The whole
 * spawn/stream/parse/classify path is covered without spending a token, which
 * is the only way this stays testable in CI.
 */

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const originalPath = process.env.PATH

const FAKE_VARS = ['ARC_FAKE_PAYLOAD', 'ARC_FAKE_MODEL', 'ARC_FAKE_ERROR', 'ARC_FAKE_NOINIT', 'ARC_FAKE_HANG', 'ARC_FAKE_ERRTEXT', 'ARC_FAKE_HELP_OMIT', 'ARC_FAKE_HELP_FAIL', 'ARC_FAKE_QUEUE']

beforeAll(() => { process.env.PATH = `${FIXTURES}:${originalPath}` })
// Unconditional cleanup: a test that times out never reaches its own inline
// delete, and a leaked ARC_FAKE_HANG would then wedge every test after it.
afterEach(() => { for (const k of FAKE_VARS) delete process.env[k] })
afterAll(() => {
  process.env.PATH = originalPath
  for (const k of FAKE_VARS) delete process.env[k]
})

const claudeRole: RoleBinding = {
  cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only',
  timeoutMs: 15_000, stallMs: 10_000,
}
const codexRole: RoleBinding = {
  cli: 'codex', model: 'gpt-5.6-sol', effort: 'high', sandbox: 'workspace-write',
  timeoutMs: 15_000, stallMs: 10_000,
}

describe('dispatch parses a real-shaped event stream', () => {
  it('classifies only known cheaper substitutions and rate limits as capacity weather', () => {
    expect(capacityFailure({
      terminalReason: 'model-drift', observedModels: ['claude-haiku-4-5'], errorText: undefined,
    }, 'claude', 'opus')).toMatchObject({ kind: 'model-substitution', observed: 'claude-haiku-4-5' })
    expect(capacityFailure({
      terminalReason: 'model-drift', observedModels: ['claude-opus-4-6'], errorText: undefined,
    }, 'claude', 'sonnet')).toBeNull()
    expect(capacityFailure({
      terminalReason: 'provider-error', observedModels: [], errorText: 'HTTP 429: rate limit exceeded',
    }, 'claude', 'opus')).toMatchObject({ kind: 'rate-limit' })
    expect(capacityFailure({
      terminalReason: 'ok', observedModels: ['claude-opus-4-6'], errorText: 'retried after 429, recovered',
    }, 'claude', 'opus')).toBeNull()
  })

  it('validates the envelope and reports the model claude actually used', async () => {
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'a.ts', whatChanged: 'added a' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'suite green' }],
    })
    const events: Array<{ kind: string; payload: unknown }> = []
    const r = await dispatch({
      role: claudeRole, cwd: process.cwd(), prompt: 'go', schema: TaskResult,
      onEvent: event => events.push(event),
    })

    expect(r.terminalReason).toBe('ok')
    expect(r.modelVerified).toBe(true)
    expect(r.observedModels).toContain('opus')
    const parsed = r.parsed as any
    expect(parsed.shipped[0].path).toBe('a.ts')
    expect(r.eventCount).toBeGreaterThan(0)
    expect(events.some(event => event.kind === 'result' &&
      (event.payload as any).subtype === 'success')).toBe(true)
    expect(r.usage).toEqual([expect.objectContaining({
      provider: 'claude', model: 'opus', inputTokens: 11,
      cachedInputTokens: 22, cacheWriteInputTokens: 33,
      outputTokens: 44, costUsd: 0.0123,
    })])
    expect(r.transcript).toContain('"--effort","high"')
    delete process.env.ARC_FAKE_PAYLOAD
  })

  it('reads codex output from its -o file and marks the model UNVERIFIED', async () => {
    // codex emits no model receipt in its stream. We record that honestly as
    // unverified rather than forging a pass from silence.
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({ status: 'done', noop: true, noopReason: 'nothing to do' })
    const r = await dispatch({ role: codexRole, cwd: process.cwd(), prompt: 'go', schema: TaskResult })

    expect(r.terminalReason).toBe('ok')
    expect((r.parsed as any).noop).toBe(true)
    expect(r.modelVerified).toBe(false)
    expect(checkModel('gpt-5.6-sol', r.observedModels, r.modelVerified)).toBe('unverified')
    expect(r.usage).toEqual([expect.objectContaining({
      provider: 'codex', inputTokens: 101, cachedInputTokens: 51,
      cacheWriteInputTokens: 7, outputTokens: 13, reasoningOutputTokens: 3,
    })])
    expect(r.usage[0]).not.toHaveProperty('costUsd')
    delete process.env.ARC_FAKE_PAYLOAD
  })

  it('refuses before workload spawn when Claude help omits --effort', async () => {
    const queue = mkdtempSync(join(tmpdir(), 'arc-refusal-'))
    const queuedPayload = join(queue, '0.json')
    writeFileSync(queuedPayload, JSON.stringify({ status: 'done', noop: true, noopReason: 'must not run' }))
    resetHelpProbeCacheForTests()
    process.env.ARC_FAKE_HELP_OMIT = '--effort'
    process.env.ARC_FAKE_QUEUE = queue
    try {
      const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go' })

      expect(r.terminalReason).toBe('provider-error')
      expect(r.errorText).toContain('claude')
      expect(r.errorText).toContain('--effort')
      expect(r.exitCode).toBeNull()
      expect(r.eventCount).toBe(0)
      expect(existsSync(queuedPayload), 'the workload consumed its queued payload').toBe(true)
    } finally {
      delete process.env.ARC_FAKE_HELP_OMIT
      delete process.env.ARC_FAKE_QUEUE
      resetHelpProbeCacheForTests()
      rmSync(queue, { recursive: true, force: true })
    }
  })

  it('dispatches normally when the help probe fails with no output', async () => {
    resetHelpProbeCacheForTests()
    process.env.ARC_FAKE_HELP_FAIL = '1'
    try {
      const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go' })

      expect(r.terminalReason).toBe('ok')
      expect(r.eventCount).toBeGreaterThan(0)
    } finally {
      delete process.env.ARC_FAKE_HELP_FAIL
      resetHelpProbeCacheForTests()
    }
  })

  it('removes its arc- temp dir once dispatch settles', async () => {
    const r = await dispatch({ role: codexRole, cwd: process.cwd(), prompt: 'go' })
    const outputPath = r.transcript.match(/"-o","([^"]*\/arc-[^/"]+\/last\.txt)"/)?.[1]
    expect(outputPath).toBeDefined()
    expect(existsSync(dirname(outputPath!))).toBe(false)
  })

  it('rejects a well-formed run whose payload fails the schema', async () => {
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({ status: 'not-a-valid-status' })
    const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go', schema: TaskResult })
    expect(r.terminalReason).toBe('bad-envelope')
    expect(r.parsed).toBeUndefined()
    // The concrete field errors travel with the rejection — a retry that is
    // not told what failed repeats it verbatim. (First dogfood run: three
    // identical bad-envelope plans in a row.)
    expect(r.errorText).toContain('schema validation failed')
    expect(r.errorText).toContain('status')
    delete process.env.ARC_FAKE_PAYLOAD
  })

  it('classifies a run that never produced model output as no-init', async () => {
    process.env.ARC_FAKE_NOINIT = '1'
    const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go', schema: TaskResult })
    expect(r.terminalReason).toBe('no-init')
    delete process.env.ARC_FAKE_NOINIT
  })

  it('stall-kills a process that is alive but has stopped emitting events', async () => {
    process.env.ARC_FAKE_HANG = '1'
    const r = await dispatch({
      role: { ...claudeRole, stallMs: 2_000, timeoutMs: 60_000 },
      cwd: process.cwd(), prompt: 'go',
    })
    expect(r.terminalReason).toBe('stall-kill')
    delete process.env.ARC_FAKE_HANG
  }, 30_000)

  it('extends stall liveness exactly once while hard timeout stays unconditional', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arc-liveness-'))
    const liveFile = join(cwd, 'progress.txt')
    process.env.ARC_FAKE_HANG = '1'
    let touches = 0
    const touch = setInterval(() => {
      writeFileSync(liveFile, String(++touches))
    }, 1_200)

    try {
      const startedAt = Date.now()
      const stalled = await dispatch({
        role: { ...claudeRole, stallMs: 2_000, timeoutMs: 15_000 },
        cwd, prompt: 'go',
      })
      const elapsed = Date.now() - startedAt
      expect(stalled.terminalReason).toBe('stall-kill')
      expect(elapsed).toBeGreaterThanOrEqual(4_000)
      expect(elapsed).toBeLessThan(8_000)

      const timedOut = await dispatch({
        role: { ...claudeRole, stallMs: 2_000, timeoutMs: 3_500 },
        cwd, prompt: 'go',
      })
      expect(timedOut.terminalReason).toBe('hard-timeout')
    } finally {
      clearInterval(touch)
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('always captures a transcript, even on failure', async () => {
    process.env.ARC_FAKE_ERROR = '1'
    const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go', schema: TaskResult })
    expect(r.transcript).toContain('arc dispatch')
    expect(r.transcript.length).toBeGreaterThan(0)
    delete process.env.ARC_FAKE_ERROR
  })
})

describe('model drift detection', () => {
  it('does not let a substring pass for a pinned version', () => {
    // `gpt-5` normalises to a prefix of `gpt-5.6-sol`, so the substring test
    // alone reported a 5.6 run as an ok 5 run — and did it in 'every' mode too,
    // which exists precisely to catch a mid-session downgrade.
    expect(checkModel('gpt-5', ['gpt-5.6-sol'], true)).toBe('drift')
    expect(checkModel('gpt-5', ['gpt-5.6-sol'], true, 'every')).toBe('drift')
    expect(auxiliaryModels('gpt-5', ['gpt-5.6-sol'])).toEqual(['gpt-5.6-sol'])
  })

  it('still treats a bare family word as an alias, and a date stamp as noise', () => {
    expect(checkModel('opus', ['claude-opus-5'], true)).toBe('ok')
    expect(checkModel('claude-opus-4-8', ['claude-opus-4-8-20260115'], true)).toBe('ok')
  })

  it('accepts an alias that resolves to a dated model id', () => {
    // `opus` means "the latest Opus", so equality is the wrong comparison.
    expect(checkModel('opus', ['claude-opus-4-8-20260115'], true)).toBe('ok')
    expect(checkModel('haiku', ['claude-haiku-4-5-20251001'], true)).toBe('ok')
  })

  it('reads which model did the WORK, not merely which ones were billed', () => {
    const receipt = (model: string, outputTokens: number) =>
      ({ provider: 'claude' as const, model, outputTokens, raw: {} })

    // The ordinary shape: Opus reviewed, Haiku did the harness's own bookkeeping.
    expect(checkModel('opus', ['claude-opus-5', 'claude-haiku-4-5'], true, 'present',
      [receipt('claude-opus-5', 8_000), receipt('claude-haiku-4-5', 120)])).toBe('ok')

    // A mid-session switch leaves the requested model PRESENT while another
    // model writes the actual verdict. Presence alone would grade the wrong work.
    expect(checkModel('opus', ['claude-opus-5', 'claude-haiku-4-5'], true, 'present',
      [receipt('claude-opus-5', 120), receipt('claude-haiku-4-5', 8_000)])).toBe('drift')

    // No receipts: unchanged: presence is all there is to go on.
    expect(checkModel('opus', ['claude-opus-5', 'claude-haiku-4-5'], true, 'present', [])).toBe('ok')
  })

  it('flags a run that silently executed on a different family', async () => {
    // This is the whole point: a reviewer that quietly downgraded is exactly
    // what "the agent started to slack" looks like from the outside.
    process.env.ARC_FAKE_MODEL = 'claude-haiku-4-5-20251001'
    const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go' })
    expect(checkModel('opus', r.observedModels, r.modelVerified)).toBe('drift')
    delete process.env.ARC_FAKE_MODEL
  })

  it('treats silence as unverified, never as agreement', () => {
    expect(checkModel('opus', [], false)).toBe('unverified')
  })

  it('accepts an auxiliary model billed ALONGSIDE the requested one', () => {
    // Real regression: a genuine Opus run also bills Haiku for Claude Code's
    // own internal work. Requiring every observed model to match rejected that
    // as drift and stopped an entire arc on its first step.
    expect(checkModel('opus', ['claude-opus-5', 'claude-haiku-4-5-20251001'], true)).toBe('ok')
    expect(auxiliaryModels('opus', ['claude-opus-5', 'claude-haiku-4-5-20251001']))
      .toEqual(['claude-haiku-4-5-20251001'])
  })

  it('still catches the failure that matters — the requested model absent', () => {
    expect(checkModel('opus', ['claude-haiku-4-5-20251001'], true)).toBe('drift')
    expect(checkModel('gpt-5.6-sol', ['gpt-5.6-luna'], true)).toBe('drift')
  })

  it('rejects model ids whose explicit version digits differ', () => {
    expect(checkModel('claude-opus-5', ['claude-opus-4-1'], true)).toBe('drift')
    expect(checkModel('gpt-5.6-sol', ['gpt-5.5-sol'], true)).toBe('drift')
  })
})

describe('extractJson survives the ways models actually wrap JSON', () => {
  it('reads bare json', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('reads a fenced block', () => {
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```\nHope that helps!')).toEqual({ a: 2 })
  })
  it('reads an object embedded in prose', () => {
    expect(extractJson('Sure — {"a":3} — done')).toEqual({ a: 3 })
  })
  it('returns undefined rather than throwing on garbage', () => {
    expect(extractJson('no json here')).toBeUndefined()
    expect(extractJson('')).toBeUndefined()
  })
})

describe('codex model verification via the session rollout', () => {
  it('returns nothing for an unknown thread rather than guessing', async () => {
    // Silence must never be read as agreement — an unreadable receipt means
    // unverified, not "probably fine".
    expect(await codexSessionModels('no-such-thread-id')).toEqual([])
    expect(checkModel('gpt-5.6-sol', [], false)).toBe('unverified')
  })

  it('reads every turn_context model out of a rollout file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codexhome-'))
    const sessions = join(dir, 'sessions', '2026', '08', '21')
    mkdirSync(sessions, { recursive: true })
    const threadId = '01a024f8-1687-7ac3-8c10-eaaefd4324f5'
    writeFileSync(join(sessions, `rollout-2026-08-21T18-37-13-${threadId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      // A session that switched part-way: BOTH must be reported, or a mid-run
      // downgrade stays invisible.
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-luna' } }),
      JSON.stringify({ type: 'response_item', payload: { text: 'noise' } }),
    ].join('\n'))

    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = dir
    try {
      const models = await codexSessionModels(threadId)
      expect(models.sort()).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol'])
      // codex records the model PER TURN, so a second one means the session
      // really did switch mid-run — the silent downgrade we watch for.
      expect(checkModel('gpt-5.6-sol', models, true, 'every')).toBe('drift')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the newest matching rollout by mtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codexhome-'))
    const sessions = join(dir, 'sessions', '2026', '08', '21')
    mkdirSync(sessions, { recursive: true })
    const threadId = '01a024f8-1687-7ac3-8c10-eaaefd4324f6'
    const older = join(sessions, `rollout-older-${threadId}.jsonl`)
    const newer = join(sessions, `rollout-newer-${threadId}.jsonl`)
    writeFileSync(older, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-luna' } }))
    writeFileSync(newer, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }))
    utimesSync(older, new Date('2026-08-21T12:00:00Z'), new Date('2026-08-21T12:00:00Z'))
    utimesSync(newer, new Date('2026-08-21T12:00:10Z'), new Date('2026-08-21T12:00:10Z'))

    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = dir
    try {
      expect(await codexSessionModels(threadId)).toEqual(['gpt-5.6-sol'])
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('escape actually stops the work', () => {
  it('kills a running agent and reports it as cancelled, not as a failure', async () => {
    process.env.ARC_FAKE_HANG = '1'
    const ctrl = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ctrl.abort(), 300)

    const r = await dispatch({
      role: { ...claudeRole, timeoutMs: 60_000, stallMs: 60_000 },
      cwd: process.cwd(), prompt: 'go', signal: ctrl.signal,
    })

    // Must come back promptly — not after the 60s timeout it would otherwise
    // have waited for.
    expect(Date.now() - t0).toBeLessThan(5_000)
    // A run you deliberately stopped did not go wrong.
    expect(r.terminalReason).toBe('cancelled')
    delete process.env.ARC_FAKE_HANG
  }, 20_000)

  it('kills the GRANDCHILD too, not just the agent it spawned', async () => {
    // The fake hangs by running `sleep`. Killing only the direct child leaves
    // that sleep alive holding the pipe — which is the bug that made an earlier
    // version wait forever on an agent that was already dead.
    // A duration unique to THIS test: pgrep for "sleep 300" matched every
    // hang fixture on the machine, so two concurrently running suites (e.g.
    // two arc task worktrees gating at once) cross-contaminated this check.
    process.env.ARC_FAKE_HANG = '287'
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 300)
    const r = await dispatch({
      role: { ...claudeRole, timeoutMs: 60_000, stallMs: 60_000 },
      cwd: process.cwd(), prompt: 'go', signal: ctrl.signal,
    })
    expect(r.terminalReason).toBe('cancelled')

    const { execSync } = await import('node:child_process')
    // The probe runs through `sh -c`, whose OWN command line contains the
    // pattern — on Linux pgrep -f happily matched the probe's wrapper and
    // reported the kill as failed forever. The character class breaks the
    // self-match while still matching a real surviving sleep.
    let strays = ''
    for (let i = 0; i < 10; i++) {
      strays = execSync('pgrep -f "sleep [2]87" || true', { encoding: 'utf8' }).trim()
      if (strays === '') break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(strays, 'a sleep survived the kill').toBe('')
    delete process.env.ARC_FAKE_HANG
  }, 20_000)

  it('refuses to start at all when the signal is already aborted', async () => {
    const r = await dispatch({
      role: claudeRole, cwd: process.cwd(), prompt: 'go',
      signal: AbortSignal.abort(),
    })
    expect(r.terminalReason).toBe('cancelled')
  }, 20_000)
})

describe('permission denials are detected from EVENTS, not from text', () => {
  it('does not trip on an agent merely reading a file that mentions permissions', async () => {
    // This killed three scouts for real. They were reading src/classify.ts,
    // which contains the strings "permission-blocked" and "approval required",
    // and the file's own contents were counted as denials.
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: true,
      noopReason: 'read a file about permission-blocked and approval required handling',
    })
    const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go', schema: TaskResult })
    expect(r.terminalReason).toBe('ok')
    delete process.env.ARC_FAKE_PAYLOAD
  })

  it('still fails a run that is genuinely walled off', async () => {
    process.env.ARC_FAKE_ERROR = '1'
    process.env.ARC_FAKE_ERRTEXT = 'this tool requires approval'
    const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go' })
    expect(['permission-blocked', 'provider-error']).toContain(r.terminalReason)
    delete process.env.ARC_FAKE_ERROR
    delete process.env.ARC_FAKE_ERRTEXT
  })
})

describe('the project setup travels with the delegate', () => {
  it('loads project settings so a repo CLAUDE.md is respected', () => {
    // Measured directly: a repo whose CLAUDE.md said "reply PINEAPPLE" got
    // "Ready." with --setting-sources '' and "PINEAPPLE" with `project`. Every
    // agent was writing code in someone's repo while ignoring that repo's own
    // instructions.
    const src = readFileSync(new URL('../src/harness.ts', import.meta.url), 'utf8')
    expect(src).toContain("'--setting-sources', 'project'")
    expect(src).not.toContain("'--setting-sources', ''")
  })

  it('keeps the OPERATOR out while letting the PROJECT in', () => {
    // A delegate must not inherit whatever the human has connected to their own
    // editor — Chrome, session history, personal MCP servers.
    const src = readFileSync(new URL('../src/harness.ts', import.meta.url), 'utf8')
    expect(src).toContain('--no-chrome')
    expect(src).toContain('--no-session-persistence')
    expect(src).toContain('--strict-mcp-config')
    expect(src).toContain(".mcp.json")
  })

  it('passes the configured effort to Claude without enabling fallback', async () => {
    const r = await dispatch({
      role: { ...claudeRole, effort: 'low' }, cwd: process.cwd(), prompt: 'go',
    })
    expect(r.transcript).toContain('"--effort","low"')
    expect(r.transcript).not.toContain('--fallback-model')
  })

  it('grants a workspace-write codex sandbox the extra roots a worktree commit needs', async () => {
    const r = await dispatch({
      role: codexRole, cwd: process.cwd(), prompt: 'go',
      writableRoots: ['/repo/.git'],
    })
    expect(r.transcript).toContain('sandbox_workspace_write.writable_roots=[\\"/repo/.git\\"]')
    const readOnly = await dispatch({
      role: { ...codexRole, sandbox: 'read-only' }, cwd: process.cwd(), prompt: 'go',
      writableRoots: ['/repo/.git'],
    })
    // A read-only sandbox never gains write roots.
    expect(readOnly.transcript).not.toContain('writable_roots')
  })

  it('classifies a missing provider binary as spawn-failed instead of crashing on the stdin write', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'arc-nopath-'))
    process.env.PATH = emptyDir
    try {
      const r = await dispatch({ role: claudeRole, cwd: process.cwd(), prompt: 'go' })
      expect(r.terminalReason).toBe('spawn-failed')
    } finally {
      process.env.PATH = `${FIXTURES}:${originalPath}`
    }
  })

})
