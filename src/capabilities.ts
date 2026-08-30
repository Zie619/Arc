import { spawnSync } from 'node:child_process'

/**
 * What can a SANDBOXED writer actually reach?
 *
 * Arc failed a task it could never have completed: the gate that judged it
 * needed the Docker socket, codex's workspace-write sandbox blocks that socket,
 * and Arc's own gate runs are unsandboxed — so verification worked while the
 * agent wrote SQL it could never execute, learning one bit per dispatch.
 *
 * The rule this module exists to enforce: **an agent must be able to run the
 * checks it will be graded by, and where it cannot, Arc must know before it
 * spends anything.**
 *
 * Arc's existing `ProviderCapability` is a different thing entirely — it reads
 * a CLI's help text to see whether the binary supports `--output-schema`.
 * Nothing anywhere asked what the sandbox lets through at runtime.
 *
 * The load-bearing discovery is that `codex sandbox` runs a command under the
 * exact policy the writer gets, with NO model call. So this costs subprocesses
 * and zero tokens. Verified on macOS 2026-08-30:
 *
 *   codex sandbox -c 'sandbox_mode="read-only"'          -- docker info  → 1
 *   codex sandbox -c 'sandbox_mode="workspace-write"'    -- docker info  → 1
 *   codex sandbox -c 'sandbox_mode="danger-full-access"' -- docker info  → 0
 *   codex sandbox -c 'sandbox_mode="read-only"'       -- sh -c 'touch x' → 1
 *   codex sandbox -c 'sandbox_mode="workspace-write"' -- sh -c 'touch x' → 0
 *
 * There is deliberately NO table here mapping a capability to a sandbox level.
 * Arc walks the ladder and takes the tightest rung that passes, which means:
 * it self-disables where the capability is already reachable, it self-corrects
 * when the provider changes policy, and — because the ladder has an unsandboxed
 * top rung — it can tell "you have not granted this" apart from "you have not
 * started Docker".
 */

/** Tightest first. `null` is the unsandboxed rung: no policy at all. */
export const SANDBOX_LADDER = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxLevel = (typeof SANDBOX_LADDER)[number]

/** Where a capability first becomes reachable. */
export type Reachability =
  | { at: SandboxLevel }
  /** Only outside any sandbox — Arc's gates can use it, a codex writer cannot. */
  | { at: 'unsandboxed' }
  /** Not reachable at all. Docker is not running; the binary is missing. */
  | { at: 'nowhere' }
  /**
   * The sandbox MECHANISM could not be exercised — no codex on PATH, or a build
   * without `codex sandbox`. Every rung then fails for the same uninformative
   * reason, and concluding "unsandboxed only" from that would quarantine every
   * task on the strength of a probe that never ran. Silence is not a verdict.
   */
  | { at: 'unknown' }

export interface CapabilityProbe {
  name: string
  command: string
  reachability: Reachability
  /** Per-rung exit codes, kept so `arc doctor` can show its working. */
  rungs: Array<{ level: SandboxLevel | 'unsandboxed'; exitCode: number | null }>
}

const PROBE_TIMEOUT_MS = 20_000

/**
 * Can we exercise the sandbox at all? Probed once with a command that MUST
 * succeed, so a mechanism failure is never mistaken for a capability denial.
 * The same shape as the seatbelt `sandboxUsable` guard the gate tests already
 * use — a probe you cannot run tells you nothing about the thing you probed.
 */
let mechanismUsable: boolean | undefined
export function sandboxProbeUsable(): boolean {
  if (mechanismUsable === undefined) {
    const spawn = spawnSync('codex', ['sandbox', '--', '/bin/echo', 'arc'],
      { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' })
    mechanismUsable = !spawn.error && spawn.status === 0
  }
  return mechanismUsable
}

/** Test seam: the mechanism probe is memoized for the process. */
export function resetSandboxProbeForTests(): void { mechanismUsable = undefined }

function runAt(level: SandboxLevel | 'unsandboxed', command: string, cwd: string): number | null {
  const spawn = level === 'unsandboxed'
    ? spawnSync('bash', ['-c', command], { cwd, timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' })
    : spawnSync('codex', ['sandbox', '-c', `sandbox_mode="${level}"`, '--', 'bash', '-c', command],
      { cwd, timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' })
  // A missing `codex` binary is not "capability unavailable" — it is "we cannot
  // tell", and the caller must not read a spawn failure as a sandbox verdict.
  if (spawn.error) return null
  return spawn.status
}

/**
 * Walk the ladder. Stops at the first rung that passes, so the common case
 * (already reachable at read-only) costs exactly one subprocess.
 */
export function probeCapability(name: string, command: string, cwd: string): CapabilityProbe {
  if (!sandboxProbeUsable()) {
    return { name, command, reachability: { at: 'unknown' }, rungs: [] }
  }
  const rungs: CapabilityProbe['rungs'] = []
  for (const level of SANDBOX_LADDER) {
    const exitCode = runAt(level, command, cwd)
    rungs.push({ level, exitCode })
    if (exitCode === 0) return { name, command, reachability: { at: level }, rungs }
  }
  const bare = runAt('unsandboxed', command, cwd)
  rungs.push({ level: 'unsandboxed', exitCode: bare })
  return {
    name,
    command,
    reachability: bare === 0 ? { at: 'unsandboxed' } : { at: 'nowhere' },
    rungs,
  }
}

/**
 * The claude lane has no OS sandbox to probe or widen (see F-2 in the README),
 * so the only question that still means anything there is whether the
 * capability is reachable on this machine at all.
 */
export function probeUnsandboxedOnly(name: string, command: string, cwd: string): CapabilityProbe {
  const exitCode = runAt('unsandboxed', command, cwd)
  return {
    name,
    command,
    reachability: exitCode === 0 ? { at: 'unsandboxed' } : { at: 'nowhere' },
    rungs: [{ level: 'unsandboxed', exitCode }],
  }
}

/** Is `a` at least as permissive as `b`? */
export function atLeast(a: SandboxLevel, b: SandboxLevel): boolean {
  return SANDBOX_LADDER.indexOf(a) >= SANDBOX_LADDER.indexOf(b)
}

/** The looser of two levels. A task's level is the max over its capabilities,
 *  floored at the role's configured level — elevation only ever raises. */
export function looser(a: SandboxLevel, b: SandboxLevel): SandboxLevel {
  return atLeast(a, b) ? a : b
}

export function describeReachability(probe: CapabilityProbe): string {
  switch (probe.reachability.at) {
    case 'nowhere':
      return `${probe.name}: NOT reachable at all (\`${probe.command}\` fails even unsandboxed)`
    case 'unsandboxed':
      return `${probe.name}: reachable only OUTSIDE a sandbox — no writer sandbox can reach it`
    case 'unknown':
      return `${probe.name}: UNPROBED — \`codex sandbox\` is unavailable here, so nothing can be`
        + ' said about what the writer can reach'
    default:
      return `${probe.name}: reachable at ${probe.reachability.at}`
  }
}
