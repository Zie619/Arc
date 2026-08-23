import type { TerminalReason } from './types.ts'

/**
 * Pure. Turns raw check output into a signature stable across identical runs.
 *
 * A byte-comparison stall guard NEVER fires on real test output, because every
 * run carries fresh timestamps, durations and temp paths. So we normalise those
 * away — but we deliberately KEEP small integers, because "5 tests failed" →
 * "3 tests failed" is convergence, and erasing it would kill a loop that is
 * actually working.
 */
export function normalizeFailureSignature(raw: string): string {
  return raw
    // ISO timestamps and clock times
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TS>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<TS>')
    // durations: "1.23s", "450ms", "2 m"
    .replace(/\b\d+(\.\d+)?\s?(ms|m?s|min|h)\b/gi, '<DUR>')
    // temp dirs and per-run scratch paths
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, '<TMP>')
    .replace(/\/[\w.\-/]*worktrees?\/[\w.\-]+/g, '<WT>')
    // hashes and long ids — a sha changes every run and means nothing here
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<SHA>')
    // large numbers (byte counts, pids, ports) but NOT small ones
    .replace(/\b\d{5,}\b/g, '<N>')
    // ansi colour
    .replace(/\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim()
}

/** Two attempts that failed the same way. The loop is not converging — stop. */
export function signaturesMatch(a: string, b: string): boolean {
  return a.length > 0 && a === b
}

export interface ExitFacts {
  exitCode: number | null
  signal: string | null
  sawModelOutput: boolean
  sawTerminalMarker: boolean
  timedOut: boolean
  stalled: boolean
  permissionDenials: number
  truncated: boolean
  spawnError: boolean
  /** The provider rejected the request outright — retrying unchanged repeats it. */
  providerError: boolean
  /** You pressed escape. Not a failure — a decision. */
  cancelled: boolean
}

/**
 * Pure. Maps observed facts to one named terminal reason.
 *
 * The ordering is the whole design. Every arm here is a scar from one of the
 * source codebases, and the two that matter most are the ones that refuse to
 * call something successful:
 *
 *  - a clean exit that never produced a signed terminal marker is NOT done
 *  - a clean exit whose output was truncated at the token limit is NOT done,
 *    because a cut-off answer reads exactly like a complete one
 */
export function classifyExit(f: ExitFacts): TerminalReason {
  // Ranked first: everything below describes a run that went wrong, and a run
  // you deliberately stopped did not go wrong.
  if (f.cancelled) return 'cancelled'
  if (f.spawnError) return 'spawn-failed'
  // Ranked above the liveness arms: an API rejection explains the silence, and
  // reporting it as 'no-init' would hide the actual cause.
  if (f.providerError) return 'provider-error'
  // One is enough now. The old threshold of three existed to absorb false
  // positives from grepping raw output; detection is from real error events
  // only, so a single denial is authoritative and waiting for three just burns
  // budget arriving at the same place.
  if (f.permissionDenials >= 1) return 'permission-blocked'
  if (f.timedOut) return 'hard-timeout'
  if (f.stalled) return 'stall-kill'
  if (!f.sawModelOutput) return 'no-init'
  if (f.truncated) return 'output-token-limit'
  if (f.exitCode === 0 && !f.sawTerminalMarker) return 'silent-delegate'
  if (f.exitCode !== 0) return 'silent-delegate'
  return 'ok'
}

/** Only `ok` is a result you may read. Everything else is an incident. */
export function isUsable(reason: TerminalReason): boolean {
  return reason === 'ok'
}

/**
 * A terminal reason a fresh attempt could plausibly fix, vs one that will
 * repeat identically. Retrying a permission wall or a drifted model just burns
 * budget to arrive at the same place.
 */
export function isRetryable(reason: TerminalReason): boolean {
  switch (reason) {
    case 'stall-kill':
    case 'hard-timeout':
    case 'empty-output':
    case 'silent-delegate':
    case 'bad-envelope':
    case 'output-token-limit':
      return true
    case 'provider-error':
    case 'cancelled':
    case 'permission-blocked':
    case 'model-drift':
    case 'spawn-failed':
    case 'no-init':
    case 'ok':
      return false
  }
}
