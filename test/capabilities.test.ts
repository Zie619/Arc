import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  probeCapability, probeUnsandboxedOnly, atLeast, looser, describeReachability,
  sandboxProbeUsable, resetSandboxProbeForTests,
} from '../src/capabilities.ts'

/**
 * `codex sandbox` runs a command under the exact policy the writer gets, with
 * no model call — which is the whole reason this design is affordable. Skipped
 * where codex is absent, the same way the seatbelt tests guard themselves.
 */
const codexUsable = (() => {
  try {
    execFileSync('codex', ['sandbox', '--', '/bin/echo', 'ok'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch { return false }
})()

describe('the sandbox ladder is measured, not assumed', () => {
  it.skipIf(!codexUsable)('finds the TIGHTEST level a capability is reachable at', () => {
    // git needs nothing, so it passes on the first rung and costs ONE
    // subprocess — the common case is silent and cheap.
    const git = probeCapability('git', 'git --version', process.cwd())
    expect(git.reachability).toEqual({ at: 'read-only' })
    expect(git.rungs).toHaveLength(1)
  })

  it.skipIf(!codexUsable)('separates "not granted" from "not installed"', () => {
    // The unsandboxed rung is what makes these two distinguishable. Without it
    // a missing binary and a blocked socket look identical, and the operator
    // gets told to grant a capability that would not have helped.
    const missing = probeCapability('nope', 'definitely-not-a-real-binary', process.cwd())
    expect(missing.reachability).toEqual({ at: 'nowhere' })
    expect(describeReachability(missing)).toContain('NOT reachable at all')
    expect(missing.rungs.map((r) => r.level)).toContain('unsandboxed')
  })

  it.skipIf(!codexUsable)('walks past a level that genuinely denies the command', () => {
    // Writing to the worktree is denied at read-only and allowed at
    // workspace-write, so this proves the rungs actually differ rather than
    // the probe passing everywhere.
    const write = probeCapability('worktree-write', 'touch ./.arc-cap-probe && rm -f ./.arc-cap-probe', process.cwd())
    expect(write.reachability).toEqual({ at: 'workspace-write' })
    expect(write.rungs[0]).toMatchObject({ level: 'read-only' })
    expect(write.rungs[0]!.exitCode).not.toBe(0)
  })

  it('probes only the unsandboxed rung where there is no OS sandbox to widen', () => {
    // The claude lane. A grant means nothing there, so the only question left
    // is whether the capability exists on this machine at all.
    const probe = probeUnsandboxedOnly('git', 'git --version', process.cwd())
    expect(probe.reachability).toEqual({ at: 'unsandboxed' })
    expect(probe.rungs).toHaveLength(1)
  })

  it('does not give capability probes the operator credentials', () => {
    const old = process.env.ARC_PROBE_SECRET
    process.env.ARC_PROBE_SECRET = 'private'
    try {
      const probe = probeUnsandboxedOnly('env', 'test -z "${ARC_PROBE_SECRET:-}"', process.cwd())
      expect(probe.reachability).toEqual({ at: 'unsandboxed' })
    } finally {
      if (old === undefined) delete process.env.ARC_PROBE_SECRET
      else process.env.ARC_PROBE_SECRET = old
    }
  })

  it('orders levels so elevation only ever raises', () => {
    expect(atLeast('danger-full-access', 'workspace-write')).toBe(true)
    expect(atLeast('read-only', 'workspace-write')).toBe(false)
    expect(looser('read-only', 'workspace-write')).toBe('workspace-write')
    expect(looser('danger-full-access', 'read-only')).toBe('danger-full-access')
  })
})

describe('an unprobeable sandbox is not a verdict', () => {
  it('reports UNKNOWN rather than concluding "unsandboxed only"', () => {
    // With no codex on PATH every rung fails for the same uninformative
    // reason. Reading that as "reachable only outside a sandbox" would
    // quarantine every task with a requirement, on the strength of a probe
    // that never ran — a verdict derived from silence.
    const realPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    resetSandboxProbeForTests()
    try {
      expect(sandboxProbeUsable()).toBe(false)
      const probe = probeCapability('git', 'git --version', process.cwd())
      expect(probe.reachability).toEqual({ at: 'unknown' })
      expect(probe.rungs).toEqual([])
      expect(describeReachability(probe)).toContain('UNPROBED')
    } finally {
      process.env.PATH = realPath
      resetSandboxProbeForTests()
    }
  })
})
