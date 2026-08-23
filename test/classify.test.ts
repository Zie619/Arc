import { describe, it, expect } from 'vitest'
import { normalizeFailureSignature, signaturesMatch, classifyExit, isUsable, isRetryable, type ExitFacts } from '../src/classify.ts'

const base: ExitFacts = {
  exitCode: 0, signal: null, sawModelOutput: true, sawTerminalMarker: true,
  timedOut: false, stalled: false, permissionDenials: 0, truncated: false, spawnError: false,
}

describe('normalizeFailureSignature', () => {
  it('makes two runs of the SAME failure identical despite fresh noise', () => {
    // Without this, a byte-comparison stall guard never fires on real test
    // output, because every run carries new timestamps, durations and paths.
    const a = normalizeFailureSignature(
      `FAIL src/auth.test.ts > login\n2026-08-21T10:00:00Z took 1.23s\n/private/tmp/xyz123/run/a.ts\ncommit 3f9a2b1c4d5e`,
    )
    const b = normalizeFailureSignature(
      `FAIL src/auth.test.ts > login\n2026-08-21T11:47:33Z took 4.51s\n/private/tmp/qqq999/run/a.ts\ncommit aa11bb22cc33`,
    )
    expect(a).toBe(b)
    expect(signaturesMatch(a, b)).toBe(true)
  })

  it('KEEPS small integers, because 5 failed → 3 failed is convergence', () => {
    // Erasing these would make a loop that is actually making progress look
    // stalled, and we would kill it one attempt from green.
    const five = normalizeFailureSignature('Tests: 5 failed, 20 passed')
    const three = normalizeFailureSignature('Tests: 3 failed, 22 passed')
    expect(five).not.toBe(three)
    expect(signaturesMatch(five, three)).toBe(false)
  })

  it('never reports two empty outputs as a matching failure', () => {
    expect(signaturesMatch('', '')).toBe(false)
  })
})

describe('classifyExit', () => {
  it('accepts a clean run that produced output and a terminal marker', () => {
    expect(classifyExit(base)).toBe('ok')
    expect(isUsable('ok')).toBe(true)
  })

  it('refuses to call a clean exit with no terminal marker "done"', () => {
    // exit 0 is not evidence of completion — the process may have died
    // between producing text and finishing its work.
    expect(classifyExit({ ...base, sawTerminalMarker: false })).toBe('silent-delegate')
  })

  it('treats a truncated answer as NOT done', () => {
    // A cut-off answer reads exactly like a complete one, which is how a
    // partial result gets kept and believed.
    expect(classifyExit({ ...base, truncated: true })).toBe('output-token-limit')
    expect(isUsable('output-token-limit')).toBe(false)
  })

  it('distinguishes never-started from stalled-midway', () => {
    expect(classifyExit({ ...base, sawModelOutput: false })).toBe('no-init')
    expect(classifyExit({ ...base, stalled: true })).toBe('stall-kill')
  })

  it('aborts on a permission denial rather than spiralling', () => {
    // One is authoritative: denials are now read from real error events, not
    // grepped out of arbitrary output, so there are no false positives to
    // absorb and no reason to wait for three.
    expect(classifyExit({ ...base, permissionDenials: 1 })).toBe('permission-blocked')
    expect(isRetryable('permission-blocked')).toBe(false)
  })

  it('ranks spawn failure above everything else', () => {
    expect(classifyExit({ ...base, spawnError: true, timedOut: true })).toBe('spawn-failed')
  })

  it('only "ok" is usable', () => {
    const all = ['no-init', 'silent-delegate', 'stall-kill', 'empty-output',
      'output-token-limit', 'permission-blocked', 'hard-timeout', 'bad-envelope',
      'model-drift', 'spawn-failed'] as const
    for (const r of all) expect(isUsable(r)).toBe(false)
  })

  it('does not retry failures that would repeat identically', () => {
    expect(isRetryable('model-drift')).toBe(false)
    expect(isRetryable('no-init')).toBe(false)
    expect(isRetryable('stall-kill')).toBe(true)
  })
})
