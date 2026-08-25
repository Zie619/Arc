import { runGate, checkOutcome, sandboxUsable, type CheckOutcome, type GateResult } from './gates.ts'

/**
 * ONE implementation of "the reviewer said there is a bug — is there?".
 *
 * This used to exist three times: once in the orchestrator, once inline in the
 * direct lane, once inline in the review lane. Each lane's tests exercised its
 * own copy, so a change to what counts as a reproduced finding — or to the
 * sandbox policy underneath it — could be applied twice and silently drift on
 * the third. That is live correctness drift in the most safety-relevant path in
 * the system, so the kernel lives here and the lanes differ only in what they
 * do with the answer.
 *
 * The rule it encodes, which is the whole point: a finding is DROPPED only when
 * a command that actually ran refuted it. Anything else keeps the finding and
 * says why it is unproven.
 */

export interface ReviewFinding {
  file: string
  line: number
  claim: string
  checkCommand?: string | null
}

/** Four outcomes. `declined` is the operator refusing to run model-authored
 *  shell; `no-command` is a reviewer that attached no reproduction at all. */
export type FindingOutcome = CheckOutcome | 'no-command' | 'declined'

export interface FindingCheck {
  keep: boolean
  outcome: FindingOutcome
  /** Honest limits of this particular check. Never empty when `outcome` is
   *  anything other than a clean sandboxed `reproduced`. */
  caveats: string[]
  result: GateResult | null
}

export const FINDING_CHECK_TIMEOUT_MS = 300_000

export interface FindingCheckOptions {
  /** Gate name, which is also how the run shows up in the gate ledger. */
  name: string
  sandboxPolicy: 'caveat' | 'refuse'
  signal?: AbortSignal
  /** The operator declined to run reviewer-authored commands in their checkout. */
  declined?: boolean
}

export async function checkReviewFinding(
  finding: ReviewFinding,
  cwd: string,
  baseSha: string,
  opts: FindingCheckOptions,
): Promise<FindingCheck> {
  if (!finding.checkCommand) {
    // Nothing to run. Note the asymmetry this creates and do not "fix" it by
    // dropping such findings: a reviewer that attaches a reproduction must
    // never end up worse off than one that attaches nothing.
    return { keep: true, outcome: 'no-command', caveats: [], result: null }
  }
  if (opts.declined) {
    return {
      keep: true, outcome: 'declined', result: null,
      caveats: ['not run: the operator declined to execute reviewer-authored commands'],
    }
  }
  // 'refuse' is for an operator who would rather have no check than an
  // unsandboxed one. The finding is still KEPT — refusing to verify is not
  // evidence that there is nothing to verify.
  if (opts.sandboxPolicy === 'refuse' && !sandboxUsable()) {
    return {
      keep: true, outcome: 'could-not-run', result: null,
      caveats: ['not run: sandboxPolicy is "refuse" and this platform has no OS write sandbox'],
    }
  }

  const result = await runGate({
    name: opts.name,
    command: finding.checkCommand,
    proves: finding.claim,
    cwd: '.',
    timeoutMs: FINDING_CHECK_TIMEOUT_MS,
    heavy: false,
    baselineSubset: false,
    readOnly: true,
  }, cwd, baseSha, opts.signal)

  const outcome = checkOutcome(result)
  const caveats: string[] = []
  if (outcome === 'could-not-run') {
    caveats.push(
      `the check could not run (exit ${result.exitCode ?? 'none'}${result.timedOut ? ', timed out' : ''})`
      + ' — this finding is UNVERIFIED, not refuted')
  }
  if (!result.sandboxed) {
    caveats.push('ran without an OS write sandbox — model-authored shell had write access to the tree it was grading')
  }
  return { keep: outcome !== 'refuted', outcome, caveats, result }
}
