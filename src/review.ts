import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch, checkModel, modelCheckMode } from './harness.ts'
import { captureDirectSnapshot, type DirectTranscript, type DirectFindingCheck, type LaneAttemptObserver } from './direct.ts'
import { checkOutcome, describe, isSubsetOfBaseline, runGate, type GateResult } from './gates.ts'
import { RiskChecklist, ReviewVerdict, type ProjectConfig, type RoleBinding } from './types.ts'

export interface ReviewLaneResult {
  ok: boolean
  status: 'completed' | 'cancelled' | 'review-failed' | 'changes-required' | 'safety-conflict'
  reason: string
  checklist?: typeof RiskChecklist._output
  review?: typeof ReviewVerdict._output
  gates: Array<{ ok: boolean; result: GateResult }>
  /** Reviewer-authored reproduction commands, executed under the same policy as the direct lane. */
  findingChecks: DirectFindingCheck[]
  /** Honest limits of this run's evidence — e.g. baselines measured in an uninstalled tree. */
  caveats: string[]
  transcripts: DirectTranscript[]
}

function transcript(phase: 'risk' | 'review', role: RoleBinding, result: Awaited<ReturnType<typeof dispatch>>): DirectTranscript {
  return {
    phase, requestedModel: role.model, observedModels: result.observedModels,
    modelStatus: checkModel(role.model, result.observedModels, result.modelVerified, modelCheckMode(role.cli), result.usage),
    terminalReason: result.terminalReason, transcript: result.transcript,
  }
}

function snapshotEqual(a: ReturnType<typeof captureDirectSnapshot>, b: ReturnType<typeof captureDirectSnapshot>): boolean {
  return a.head === b.head && a.status === b.status &&
    JSON.stringify(a.pathStates) === JSON.stringify(b.pathStates)
}

/** Review the current checkout without starting an implementation agent. */
export async function runReviewLane(options: {
  config: ProjectConfig
  brief: string
  signal?: AbortSignal
  log?: (line: string) => void
  observer?: LaneAttemptObserver
  /** Same policy as the direct lane: ask mode sees the exact command list first. */
  confirmFindingChecks?: (commands: string[]) => Promise<boolean>
}): Promise<ReviewLaneResult> {
  const { config, brief, signal } = options
  const role = config.roles.review
  const gates: Array<{ ok: boolean; result: GateResult }> = []
  const findingChecks: DirectFindingCheck[] = []
  const caveats: string[] = []
  const transcripts: DirectTranscript[] = []
  if (!role) return { ok: false, status: 'review-failed', reason: 'no independent review role is configured', gates, findingChecks, caveats, transcripts }
  const readOnly: RoleBinding = { ...role, sandbox: 'read-only' }

  const observed = async (phase: 'risk' | 'review', opts: Parameters<typeof dispatch>[0]) => {
    const attemptId = options.observer?.start({ phase, role: 'review', cli: readOnly.cli, model: readOnly.model })
    const result = await dispatch(opts)
    const t = transcript(phase, readOnly, result)
    transcripts.push(t)
    if (attemptId) {
      options.observer?.finish(attemptId, {
        terminalReason: t.modelStatus === 'drift' ? 'model-drift' : result.terminalReason,
        exitCode: result.exitCode,
        observedModel: result.observedModels.join(',') || null,
        transcript: result.transcript,
        usage: result.usage,
      })
    }
    return { result, transcript: t }
  }
  const before = captureDirectSnapshot(config.repo)
  const temp = mkdtempSync(join(tmpdir(), 'arc-review-base-'))
  const baseTree = join(temp, 'tree')
  try {
    execFileSync('git', ['-C', config.repo, 'worktree', 'add', '--detach', baseTree, before.head], { stdio: 'ignore' })
    // Baselines in a bare tree fail for environmental reasons, not code
    // reasons. Install first; if setup itself fails, say so as a caveat.
    if (config.setupCommand) {
      const setup = await runGate({
        name: 'baseline-setup', command: config.setupCommand,
        proves: 'the detached base tree can run project checks',
        cwd: '.', timeoutMs: 600_000, heavy: false, baselineSubset: false,
      }, baseTree, before.head, signal)
      if (!setup.pass) {
        caveats.push(`base-tree setup failed (${config.setupCommand}, exit ${setup.exitCode}) — baseline comparisons are environment-unproven`)
      }
    }
    const { result: risk, transcript: riskTranscript } = await observed('risk', {
      role: readOnly, cwd: baseTree, signal, schema: RiskChecklist,
      prompt: [
        '# PREDICT REVIEW RISKS — THE CHANGE IS HIDDEN', '',
        'Read this base tree and predict concrete correctness risks before seeing the current checkout diff.',
        'Do not edit anything.', '', '## Review request', brief,
      ].join('\n'),
    })
    if (risk.terminalReason !== 'ok' || riskTranscript.modelStatus !== 'ok' || !risk.parsed) {
      return { ok: false, status: risk.terminalReason === 'cancelled' ? 'cancelled' : 'review-failed', reason: `risk prediction was ${risk.terminalReason}/${riskTranscript.modelStatus}`, gates, findingChecks, caveats, transcripts }
    }
    const checklist = risk.parsed as typeof RiskChecklist._output
    const baselines = new Map<string, GateResult>()
    for (const gate of config.gates.filter((item) => item.baselineSubset)) {
      const baseline = await runGate(gate, baseTree, before.head, signal)
      baselines.set(gate.name, baseline)
      if (!baseline.pass) {
        // The detached base worktree has no installed dependencies or build
        // cache; a red baseline here may be the environment, not the code.
        caveats.push(`baseline for "${gate.name}" failed in a fresh detached worktree with no installed dependencies — its subset comparison is environment-unproven`)
      }
    }
    for (const gate of config.gates) {
      const result = await runGate(gate, config.repo, before.head, signal)
      const baseline = baselines.get(gate.name)
      const ok = gate.baselineSubset && baseline ? isSubsetOfBaseline(result, baseline) : result.pass
      gates.push({ ok, result })
      options.log?.(describe(result))
    }
    const afterGates = captureDirectSnapshot(config.repo)
    if (!snapshotEqual(before, afterGates)) {
      return { ok: false, status: 'safety-conflict', reason: 'a review gate changed the checkout; Arc did not roll it back', checklist, gates, findingChecks, caveats, transcripts }
    }
    const { result: review, transcript: reviewTranscript } = await observed('review', {
      role: readOnly, cwd: config.repo, signal, schema: ReviewVerdict,
      prompt: [
        '# REVIEW THE CURRENT CHECKOUT — DO NOT EDIT', '',
        'Review correctness and regressions, not style. Every finding needs file and line.',
        'The checkout may contain staged, unstaged, and untracked changes; inspect all of them.',
        '', '## Request', brief, '', '## Risks predicted against the hidden base tree',
        ...checklist.risks.map((item) => `- ${item.id}: ${item.text} — ${item.howToCheck}`),
        '', '## Gate evidence', ...gates.map((item) => `- ${describe(item.result)}; accepted=${item.ok}`),
        '', `Base HEAD: ${before.head}`, `Changed paths: ${before.dirtyPaths.join(', ') || '(none)'}`,
      ].join('\n'),
    })
    if (review.terminalReason !== 'ok' || reviewTranscript.modelStatus !== 'ok' || !review.parsed) {
      return { ok: false, status: review.terminalReason === 'cancelled' ? 'cancelled' : 'review-failed', reason: `review was ${review.terminalReason}/${reviewTranscript.modelStatus}`, checklist, gates, findingChecks, caveats, transcripts }
    }
    const verdict = review.parsed as typeof ReviewVerdict._output
    const afterReview = captureDirectSnapshot(config.repo)
    if (!snapshotEqual(before, afterReview)) {
      return { ok: false, status: 'safety-conflict', reason: 'the read-only reviewer changed the checkout; Arc did not roll it back', checklist, review: verdict, gates, findingChecks, caveats, transcripts }
    }

    // Reviewer-authored reproduction commands, under the same policy as the
    // direct lane: minimal env always, operator approval where configured,
    // and the checkout re-verified afterwards.
    const commandFindings = verdict.findings.filter((finding) => finding.file && finding.checkCommand)
    const checksApproved = commandFindings.length === 0 || !options.confirmFindingChecks
      ? true
      : await options.confirmFindingChecks(commandFindings.map((finding) => finding.checkCommand!))
    for (const finding of commandFindings) {
      if (!checksApproved) {
        findingChecks.push({
          file: finding.file, line: finding.line, claim: finding.claim,
          command: finding.checkCommand!, ran: false, reproduced: false, result: null,
        })
        continue
      }
      const result = await runGate({
        name: `review-lane:${finding.file}:${finding.line}`,
        command: finding.checkCommand!,
        proves: finding.claim,
        cwd: '.',
        timeoutMs: 300_000,
        heavy: false,
        baselineSubset: false,
        readOnly: true,
      }, config.repo, before.head, signal)
      if (!result.sandboxed) {
        caveats.push(`the check for ${finding.file}:${finding.line} ran with NO write sandbox — this platform has none available, and the command was model-authored`)
      }
      findingChecks.push({
        file: finding.file, line: finding.line, claim: finding.claim,
        command: finding.checkCommand!, ran: checkOutcome(result) !== 'could-not-run', reproduced: result.pass, result,
      })
    }
    const after = captureDirectSnapshot(config.repo)
    if (!snapshotEqual(before, after)) {
      return { ok: false, status: 'safety-conflict', reason: 'a reviewer finding check changed the checkout; Arc did not roll it back', checklist, review: verdict, gates, findingChecks, caveats, transcripts }
    }

    const critical = verdict.findings.some((finding) => finding.severity === 'critical')
    const ok = ['PASS', 'PASS_WITH_NOTES'].includes(verdict.verdict) && !critical && gates.every((gate) => gate.ok)
    return {
      ok, status: ok ? 'completed' : 'changes-required',
      reason: ok ? 'project gates and independent review passed' : `review verdict ${verdict.verdict}; ${gates.filter((gate) => !gate.ok).length} gate(s) failed`,
      checklist, review: verdict, gates, findingChecks, caveats, transcripts,
    }
  } finally {
    try { execFileSync('git', ['-C', config.repo, 'worktree', 'remove', '--force', baseTree], { stdio: 'ignore' }) } catch { /* cleanup is reported by git prune later */ }
    rmSync(temp, { recursive: true, force: true })
  }
}
