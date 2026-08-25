import * as G from './git.ts'
import { runGate } from './gates.ts'
import type { Plan, ProjectConfig } from './types.ts'

/**
 * Run every proof command at the BASE commit, before anything is dispatched.
 *
 * A proof can be vacuous: portable, runs fine, and proves nothing because it
 * already passed before the work started. `test -f src/cost.ts` on a file that
 * exists. `npm test` as the proof of one specific criterion. Static analysis
 * cannot see it. Execution against the base commit sees it completely.
 *
 * Polarity is what makes this total rather than heuristic. A `discriminating`
 * proof MUST fail at base — if it passes, it cannot distinguish done from
 * not-done. An `invariant` proof MUST pass at base — if it fails, it is
 * measuring something that was already broken and will blame this task for it.
 * There is no third answer, so every criterion gets a verdict.
 *
 * This is the filter behind Meta's TestGen-LLM: a generated verification
 * artifact is kept only if execution proves it improves something. Their funnel
 * discarded roughly three quarters of what the model produced, and the deployed
 * result was trustworthy BECAUSE of that discard rate. Expect the same shape.
 *
 * A bonus that costs nothing: a task whose proofs cannot be made discriminating
 * is a task that is too big or too vague, and you learn it at plan time for the
 * price of one worktree.
 */

export interface DryRunFinding {
  taskId: string
  criterionId: string
  polarity: 'discriminating' | 'invariant'
  command: string
  passedAtBase: boolean
  message: string
}

export interface DryRunResult {
  findings: DryRunFinding[]
  /** False when the base worktree could not be provisioned — no claim either way. */
  ran: boolean
  reason?: string
}

export async function dryRunProofs(
  plan: Plan,
  config: ProjectConfig,
  storeRoot: string,
  baseSha: string,
  signal?: AbortSignal,
  log: (line: string) => void = () => {},
): Promise<DryRunResult> {
  const withCommands = plan.tasks.flatMap((task) =>
    task.acceptance
      .filter((c) => c.proofKind === 'command' && c.proofCommand)
      .map((c) => ({ task, criterion: c })))
  if (withCommands.length === 0) return { findings: [], ran: true }

  // A FRESH worktree, not the operator's checkout: a proof that passes at base
  // only because of a stale `dist/` is the exact false negative this is for.
  const workspaceId = `${plan.arcId}-dryrun`
  G.releaseTaskWorkspace(config.repo, storeRoot, workspaceId)
  let tree: G.Worktree
  try {
    tree = G.provisionWorktree(config.repo, storeRoot, workspaceId, baseSha)
  } catch (error) {
    return { findings: [], ran: false, reason: (error as Error).message }
  }

  try {
    if (config.setupCommand) {
      const setup = await runGate({
        name: 'dryrun-setup', command: config.setupCommand,
        proves: 'the base tree can run project checks',
        cwd: '.', timeoutMs: 600_000, heavy: false, baselineSubset: false,
      }, tree.path, baseSha, signal)
      if (!setup.pass) {
        // Every proof would then fail at base for environmental reasons, and
        // every discriminating one would look correct. Refuse to judge.
        return {
          findings: [], ran: false,
          reason: `setupCommand failed in the base tree (exit ${setup.exitCode}) — every proof would fail for the wrong reason`,
        }
      }
    }

    log(`dry-running ${withCommands.length} proof command(s) at ${baseSha.slice(0, 8)} — before the work exists`)
    const findings: DryRunFinding[] = []
    for (const { task, criterion } of withCommands) {
      const result = await runGate({
        name: `dryrun:${task.id}:${criterion.id}`,
        command: criterion.proofCommand!,
        proves: criterion.text,
        cwd: '.', timeoutMs: 300_000, heavy: false, baselineSubset: false,
        readOnly: true,
      }, tree.path, baseSha, signal)

      const polarity = criterion.polarity
      if (polarity === 'discriminating' && result.pass) {
        findings.push({
          taskId: task.id, criterionId: criterion.id, polarity,
          command: criterion.proofCommand!, passedAtBase: true,
          message: `proofCommand \`${criterion.proofCommand}\` already PASSES at the base commit. `
            + 'A discriminating criterion must FAIL before the work, or it proves nothing. '
            + 'Either write a proof that distinguishes done from not-done, or mark it polarity: invariant.',
        })
      }
      if (polarity === 'invariant' && !result.pass) {
        findings.push({
          taskId: task.id, criterionId: criterion.id, polarity,
          command: criterion.proofCommand!, passedAtBase: false,
          message: `proofCommand \`${criterion.proofCommand}\` already FAILS at the base commit (exit ${result.exitCode}). `
            + 'An invariant criterion must PASS before the work, or this task will be blamed for a pre-existing failure.',
        })
      }
    }
    return { findings, ran: true }
  } finally {
    G.releaseTaskWorkspace(config.repo, storeRoot, workspaceId)
  }
}
