import { z } from 'zod'
import { resolve } from 'node:path'
import { Store } from './store.ts'
import { compileBrief, BriefTooLarge } from './brief.ts'
import { dispatch, checkModel, auxiliaryModels, modelCheckMode, type DispatchResult } from './harness.ts'
import { computeFrontier } from './scheduler.ts'
import { runGate, selectGates, isSubsetOfBaseline, describe, type GateResult } from './gates.ts'
import { signaturesMatch, signatureSimilarity } from './classify.ts'
import * as G from './git.ts'
import {
  TaskResult, ReviewVerdict, RiskChecklist, ProjectConfig,
  type Plan, type PlanTask, type AgentRole, type RoleBinding,
} from './types.ts'

/**
 * The run loop.
 *
 * The orchestrator is a PROGRAM, not an agent. It holds no memory: every model
 * call is a bounded, single-purpose turn whose prompt is rebuilt from rows.
 * Kill this process at any instant, restart, and the frontier recomputes
 * identically.
 */

export interface RunOptions {
  store: Store
  plan: Plan
  config: ProjectConfig
  log: (line: string) => void
  /** Stop after N ticks. Test seam. */
  maxTicks?: number
  /** Continue an existing arc rather than creating one. */
  resume?: boolean
  /** Escape. Every dispatch gets it; the loop checks it between tasks. */
  signal?: AbortSignal
  /** The implementer's structured output, surfaced without scraping log prose. */
  onTaskResult?: (result: TaskProduct) => void
  /** The durable thread this arc belongs to, recorded on the arc row. */
  threadId?: string
}

export interface TaskProduct {
  taskId: string
  status: z.infer<typeof TaskResult>['status']
  shipped: z.infer<typeof TaskResult>['shipped']
  noop: boolean
  noopReason?: string
}

const LEASE_MS = 90_000

/**
 * A counting semaphore. Two limits contend for DIFFERENT resources, so they
 * are separate numbers even when they happen to be equal:
 *   agentConcurrency — token / rate budget (enforced by the scheduler's slots)
 *   heavyGateLimit   — CPU and RAM; several concurrent `next build`s wedge the
 *                      machine no matter how much token budget is left
 */
class Semaphore {
  private free: number
  private waiting: Array<() => void> = []
  constructor(n: number) { this.free = n }
  async acquire(): Promise<void> {
    if (this.free > 0) { this.free--; return }
    await new Promise<void>((r) => this.waiting.push(r))
  }
  release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free++
  }
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire()
    try { return await fn() } finally { this.release() }
  }
}

export async function runArc(o: RunOptions): Promise<void> {
  if (o.resume) {
    const persistedPlan = o.store.getPlan(o.plan.arcId)
    const persistedConfig = o.store.getRunSnapshot(o.plan.arcId)
    if (!persistedPlan) throw new Error(`cannot resume unknown arc "${o.plan.arcId}"`)
    o = {
      ...o,
      plan: persistedPlan,
      config: persistedConfig ? ProjectConfig.parse(persistedConfig) : o.config,
    }
  }

  const { store, plan, config, log } = o
  const arcId = plan.arcId
  const repo = config.repo

  if (!G.isClean(repo)) {
    throw new Error(
      `repo ${repo} has uncommitted TRACKED changes — refusing to start.\n` +
      G.dirtyFiles(repo).map((f) => `  ${f}`).join('\n') +
      `\nThis is a hard stop: we never discard tracked modifications to make room.`,
    )
  }
  const untracked = G.untrackedFiles(repo)
  if (untracked.length > 0) {
    log(`! ${untracked.length} untracked file(s) in the repo — not blocking, but stray files can break a build:`)
    for (const f of untracked.slice(0, 5)) log(`    ${f}`)
  }

  let integrationBranch: string
  let baseSha: string

  if (o.resume) {
    const persisted = store.getArc(arcId)
    if (!persisted) throw new Error(`cannot resume unknown arc "${arcId}"`)
    if (String(persisted.repo) !== repo) {
      throw new Error(`arc "${arcId}" belongs to ${persisted.repo}, not ${repo}`)
    }
    integrationBranch = String(persisted.integration_branch)
    baseSha = String(persisted.base_sha)
    if (!G.gitOk(repo, 'rev-parse', '--verify', `${baseSha}^{commit}`)) {
      throw new Error(`persisted base ${baseSha} for arc "${arcId}" no longer exists`)
    }
    if (!G.gitOk(repo, 'rev-parse', '--verify', `${integrationBranch}^{commit}`)) {
      const anyLanded = store.allTasks(arcId).some((task) => task.state === 'landed' || task.head_sha)
      if (anyLanded) {
        throw new Error(`persisted integration branch "${integrationBranch}" no longer exists`)
      }
      G.git(repo, 'branch', integrationBranch, baseSha)
      log(`resume: recreated empty integration branch "${integrationBranch}" at persisted base`)
    }
    // A task left mid-flight by a crash holds no live worker. Release its
    // isolation and put it back on the queue — the frontier is a pure function
    // of rows, so everything else recomputes itself.
    const stuck = store.allTasks(arcId).filter((t) => ['running', 'reviewing', 'landing'].includes(String(t.state)))
    for (const t of stuck) {
      log(`resume: ${t.id} was "${t.state}" with no live worker — releasing and requeueing`)
      G.releaseTaskWorkspace(repo, store.root, String(t.id))
      store.setTaskState(arcId, String(t.id), 'pending')
    }
    store.appendEvent(arcId, 'arc.resume', { requeued: stuck.length })
    log(`resuming arc ${arcId} from persisted base ${baseSha.slice(0, 8)} — ${stuck.length} task(s) requeued`)
  } else {
    integrationBranch = `arc/${arcId}-integration`
    // Branch off the CONFIGURED main branch, not whatever happens to be checked
    // out. A repo sitting on someone's feature branch would otherwise silently
    // base the whole arc on unrelated work.
    if (!G.gitOk(repo, 'rev-parse', '--verify', `${config.mainBranch}^{commit}`)) {
      throw new Error(`configured mainBranch "${config.mainBranch}" does not exist in ${repo}`)
    }
    baseSha = G.git(repo, 'rev-parse', config.mainBranch)
    const checkedOut = G.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    if (checkedOut !== config.mainBranch) {
      log(`note: repo is on "${checkedOut}"; this arc bases off "${config.mainBranch}" (${baseSha.slice(0, 8)})`)
    }
    if (!G.gitOk(repo, 'rev-parse', '--verify', `${integrationBranch}^{commit}`)) {
      G.git(repo, 'branch', integrationBranch, baseSha)
    }
    store.createArc(plan, repo, baseSha, integrationBranch, o.threadId)
    store.saveRunSnapshot(arcId, config)
    store.appendEvent(arcId, 'arc.start', { baseSha, integrationBranch, tasks: plan.tasks.length })
    log(`arc ${arcId} — ${plan.tasks.length} tasks, base ${baseSha.slice(0, 8)}, integration ${integrationBranch}`)
  }

  const heavy = new Semaphore(config.heavyGateLimit)
  // Agents and their local gates may run in parallel; rebasing/advancing the
  // one integration ref is a serial transaction. Synchronous gates used to
  // hide this race by accident.
  const landing = new Semaphore(1)

  const baselines = await measureBaselines(o, baseSha)

  let ticks = 0
  for (;;) {
    if (o.signal?.aborted) { log('cancelled — stopping. Nothing further will be landed.'); break }
    if (o.maxTicks && ++ticks > o.maxTicks) { log('max ticks reached'); break }

    const runtime = store.taskRuntime(arcId)
    const frontier = computeFrontier({ plan, runtime, now: Date.now(), agentConcurrency: config.agentConcurrency })

    for (const id of frontier.reclaimable) {
      log(`! lease expired on ${id} — reclaiming`)
      store.appendEvent(arcId, 'lease.expired', {}, id)
      store.setTaskState(arcId, id, 'pending')
    }

    const done = plan.tasks.every((t) => ['landed', 'failed', 'blocked'].includes(runtime[t.id]?.state ?? 'pending'))
    if (done) break

    if (frontier.ready.length === 0) {
      if (frontier.reclaimable.length > 0) continue
      const stuck = plan.tasks.filter((t) => (runtime[t.id]?.state ?? 'pending') === 'pending')
      if (stuck.length > 0) {
        log(`DEADLOCK: ${stuck.length} task(s) pending but none runnable:`)
        for (const b of frontier.blocked) log(`  ${b.id}: ${b.reason}`)
        for (const s of stuck) store.setTaskState(arcId, s.id, 'blocked')
      }
      break
    }

    // The frontier is already capped to free slots and is guaranteed
    // collision-free (disjoint footprints, no shared contract mutator) by
    // computeFrontier — that analysis lives there, not here. So everything in
    // it can run at once.
    if (frontier.ready.length > 1) {
      log(`▶ ${frontier.ready.length} tasks in parallel: ${frontier.ready.map((t) => t.id).join(', ')}`)
    }
    // allSettled, not all: one task crashing must not detach its siblings
    // mid-flight or leave its own row 'running' until a lease expiry.
    const settled = await Promise.allSettled(
      frontier.ready.map((task) => runTask(o, task, baselines, integrationBranch, heavy, landing)))
    settled.forEach((s, i) => {
      if (s.status !== 'rejected' || o.signal?.aborted) return
      const task = frontier.ready[i]
      if (!task) return
      const message = s.reason instanceof Error ? s.reason.message : String(s.reason)
      log(`✗ ${task.id}: crashed — ${message}`)
      store.appendEvent(arcId, 'task.crashed', { message: message.slice(0, 400) }, task.id)
      store.setTaskState(arcId, task.id, 'failed')
    })
  }

  const integrationApproved = await finalReview(o, integrationBranch, baseSha)
  const complete = report(o, integrationBranch, integrationApproved)
  await finalize(o, integrationBranch, baseSha, complete)
}

/**
 * Deliver the arc's work, per `landStrategy`.
 *
 * ONLY when the arc is complete. An incomplete arc leaves its integration
 * branch sitting locally and says so — publishing half-finished work, or
 * worse pushing it at a protected branch, is exactly the false-completion
 * failure this engine exists to prevent.
 */
async function finalize(
  o: RunOptions, integrationBranch: string, baseSha: string, complete: boolean,
): Promise<void> {
  const { config, log, store, plan } = o
  const head = G.git(config.repo, 'rev-parse', integrationBranch)
  if (head === baseSha) return   // nothing landed; nothing to deliver

  if (!complete) {
    log('')
    log(`arc is INCOMPLETE — not ${config.landStrategy === 'pr' ? 'opening a PR' : 'pushing'}.`)
    log(`Work is on "${integrationBranch}" (${head.slice(0, 8)}). Inspect it, then re-run or resume.`)
    return
  }

  const landed = store.allTasks(plan.arcId).filter((t) => t.state === 'landed')
  const title = `arc(${plan.arcId}): ${landed.length} task(s)`
  const body = [
    `Produced by arc-executor. Every acceptance criterion below carries evidence.`,
    ``,
    `## Goal`,
    plan.charter.goal.trim(),
    ``,
    `## Landed`,
    ...landed.map((t) => `- \`${t.id}\` ${t.title}`),
    ``,
    `## Evidence`,
    ...store.allCriteria(plan.arcId).map((c) => `- [${c.tier}] \`${c.task_id}/${c.id}\` ${c.text}`),
  ].join('\n')

  if (config.landStrategy === 'none') {
    log('')
    log(`✓ done, and left on "${integrationBranch}" (${head.slice(0, 8)}) as configured.`)
    log(`  Look at it:  git -C ${config.repo} log --oneline ${baseSha.slice(0, 8)}..${integrationBranch}`)
    log(`  Take it:     git -C ${config.repo} merge --ff-only ${integrationBranch}`)
    return
  }

  if (config.landStrategy === 'pr') {
    log('')
    log(`opening a pull request: ${integrationBranch} → ${config.mainBranch}`)
    const r = G.openPullRequest(config.repo, integrationBranch, config.mainBranch, title, body)
    store.appendEvent(plan.arcId, 'pr', r)
    if (r.ok) {
      log(`  ✓ ${r.url || '(created)'}${r.message ? ` — ${r.message}` : ''}`)
      // The PR holds the work now; a lingering local copy is the residue that
      // piles up gigabytes across arcs. Remove it — loudly if we cannot.
      if (G.gitOk(config.repo, 'branch', '-D', integrationBranch)) log(`  ✓ local "${integrationBranch}" removed — zero local residue`)
      else log(`  local "${integrationBranch}" could not be removed (checked out?) — delete it yourself`)
    } else if (r.url) {
      log(`  ✗ ${r.message}\n  The branch IS pushed — open the PR yourself: ${r.url}`)
    } else {
      log(`  ✗ ${r.message}\n  Work is safe on "${integrationBranch}" — open the PR by hand.`)
    }
    return
  }

  // landStrategy: push — direct to the main branch. Asserts the ref moved,
  // same as every other land in this system.
  log('')
  log(`pushing ${integrationBranch} → ${config.mainBranch}`)
  const lr = G.landBranch(config.repo, config.mainBranch, integrationBranch)
  store.appendEvent(plan.arcId, 'push', lr)
  if (!lr.ok) { log(`  ✗ ${lr.message}`); return }
  try {
    G.git(config.repo, 'push', 'origin', config.mainBranch)
    log(`  ✓ ${config.mainBranch} ${lr.before.slice(0, 8)} → ${lr.after.slice(0, 8)}`)
    // Merged and pushed: the integration branch is fully contained in main.
    if (G.gitOk(config.repo, 'branch', '-d', integrationBranch)) log(`  ✓ local "${integrationBranch}" removed — zero local residue`)
  } catch (e) {
    log(`  ✗ push rejected: ${(e as Error).message.slice(0, 200)}`)
    log(`  The merge is local only. If "${config.mainBranch}" is protected, set landStrategy: pr.`)
  }
}

// ---------------------------------------------------------------------------

async function measureBaselines(o: RunOptions, baseSha: string): Promise<Map<string, GateResult>> {
  const out = new Map<string, GateResult>()
  const needed = o.config.gates.filter((g) => g.baselineSubset)
  if (needed.length === 0) return out
  o.log(`measuring ${needed.length} gate baseline(s) on ${baseSha.slice(0, 8)} — in this run, not from memory`)
  for (const g of needed) {
    const r = await runGate(g, o.config.repo, baseSha, o.signal)
    out.set(g.name, r)
    o.store.recordGate({
      arcId: o.plan.arcId, name: g.name, command: g.command, proves: g.proves,
      exitCode: r.exitCode, baseSha, verdict: 'baseline', signature: r.signature,
    })
    o.log(`  baseline ${g.name}: exit ${r.exitCode}`)
  }
  return out
}

async function runTask(
  o: RunOptions,
  task: PlanTask,
  baselines: Map<string, GateResult>,
  integrationBranch: string,
  heavy: Semaphore,
  landing: Semaphore,
): Promise<void> {
  const { store, plan, config, log } = o
  const arcId = plan.arcId

  store.setTaskState(arcId, task.id, 'running', LEASE_MS)
  // A throw inside a timer callback cannot be caught by the surrounding try —
  // it would be an uncaught exception. A missed renewal is fine: the lease
  // expiring is itself the designed recovery path.
  const heartbeat = setInterval(() => {
    try { store.renewLease(arcId, task.id, LEASE_MS) } catch { /* transient DB busy */ }
  }, LEASE_MS / 3)

  try {
    const baseSha = G.git(config.repo, 'rev-parse', integrationBranch)
    let wt: G.Worktree
    try {
      wt = G.provisionWorktree(config.repo, store.root, task.id, baseSha)
    } catch (e) {
      // Fails CLOSED. No fallback into the shared checkout, ever.
      log(`✗ ${task.id}: ${(e as Error).message}`)
      store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high', text: (e as Error).message })
      store.setTaskState(arcId, task.id, 'failed')
      return
    }
    store.setTaskWorkspace(arcId, task.id, wt.path, wt.branch, wt.baseSha)
    log(`▶ ${task.id} — ${task.title}  [${wt.branch} @ ${wt.baseSha.slice(0, 8)}]`)

    // A bare worktree cannot run the project's own checks (the first
    // self-arc died with `vitest: command not found` in every worktree).
    // Setup runs in Arc's process — the sandboxed agent may have no network.
    if (config.setupCommand && !await setupWorktree(o, wt, task.id)) {
      store.setTaskState(arcId, task.id, 'failed')
      return
    }

    const outcome = await implementLoop(o, task, wt, baselines, heavy)
    if (outcome === 'failed') { store.setTaskState(arcId, task.id, 'failed'); return }

    // A no-op produced no diff, so there is nothing to review and nothing to
    // land — but its criteria still have to hold, and the worktree must
    // actually BE at base: a retrying writer that committed work on attempt 1
    // and then reported "no change needed — already committed" would get its
    // task marked landed while its commits sat abandoned in the worktree.
    // (The self-arc produced exactly this false-landed state.)
    if (outcome === 'noop') {
      const worktreeHead = G.git(wt.path, 'rev-parse', 'HEAD')
      if (worktreeHead !== wt.baseSha) {
        log(`✗ ${task.id}: claimed no-op, but the worktree holds commits (${worktreeHead.slice(0, 8)} ≠ base ${wt.baseSha.slice(0, 8)}) — work exists, so the no-op claim is false`)
        store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high',
          text: `no-op claim rejected: worktree head ${worktreeHead.slice(0, 8)} differs from base ${wt.baseSha.slice(0, 8)}; committed work would have been silently abandoned` })
        store.setTaskState(arcId, task.id, 'failed')
        return
      }
      const unmetNoop = store.unmetCriteria(arcId, task.id)
      if (unmetNoop.length > 0) {
        log(`✗ ${task.id}: no-op, but ${unmetNoop.length} criterion/criteria unproven — not accepting`)
        for (const c of unmetNoop) log(`    ${c.id}: ${c.tier} < required ${c.required_tier}`)
        store.setTaskState(arcId, task.id, 'failed')
        return
      }
      log(`  ✓ ${task.id} accepted as a no-op — criteria hold with no change`)
      store.setTaskState(arcId, task.id, 'landed')
      G.releaseTaskWorkspace(config.repo, store.root, task.id)
      return
    }

    store.setTaskState(arcId, task.id, 'reviewing', LEASE_MS)
    const passed = await reviewLoop(o, task, wt)
    if (!passed) { store.setTaskState(arcId, task.id, 'failed'); return }

    const unmet = store.unmetCriteria(arcId, task.id)
    if (unmet.length > 0) {
      log(`✗ ${task.id}: ${unmet.length} criterion/criteria below required tier — not landing`)
      for (const c of unmet) log(`    ${c.id}: ${c.tier} < required ${c.required_tier}`)
      store.setTaskState(arcId, task.id, 'failed')
      return
    }

    store.setTaskState(arcId, task.id, 'landing', LEASE_MS)
    const landed = await landing.run(() => landTask(o, task, wt, integrationBranch, baselines, heavy))
    store.setTaskState(arcId, task.id, landed ? 'landed' : 'failed')
    if (landed) {
      propagateDeviations(o, task)
      // Merged into the integration branch, so the isolation has served its
      // purpose. Removing it here is what makes a re-run of the arc possible.
      G.releaseTaskWorkspace(config.repo, store.root, task.id)
    }
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * dispatch → run the task's own acceptance checks → on failure re-dispatch with
 * the failure text appended → stop when the NORMALISED signature repeats.
 *
 * The signature is normalised because real test output carries fresh
 * timestamps and paths every run, so a byte comparison never fires. Small
 * integers are deliberately kept: "5 failed" → "3 failed" is convergence, and
 * erasing it would kill a loop that is working.
 */
type ImplementOutcome = 'ok' | 'noop' | 'failed'

function modelStatus(
  o: RunOptions,
  role: NonNullable<ProjectConfig['roles'][keyof ProjectConfig['roles']]>,
  result: DispatchResult,
  attemptId: string,
  taskId: string | null,
): 'ok' | 'drift' | 'unverified' {
  const status = checkModel(role.model, result.observedModels, result.modelVerified, modelCheckMode(role.cli))
  if (status === 'unverified') {
    o.store.appendEvent(o.plan.arcId, 'model.unverified', {
      cli: role.cli, requested: role.model,
    }, taskId, attemptId)
  }
  const aux = auxiliaryModels(role.model, result.observedModels)
  if (aux.length > 0) {
    o.store.appendEvent(o.plan.arcId, 'model.auxiliary', {
      requested: role.model, also: aux,
    }, taskId, attemptId)
  }
  return status
}

async function implementLoop(
  o: RunOptions, task: PlanTask, wt: G.Worktree, baselines: Map<string, GateResult>, heavy: Semaphore,
): Promise<ImplementOutcome> {
  const { store, plan, config, log } = o
  const arcId = plan.arcId
  const role = config.roles.implement
  if (!role) throw new Error('project.yaml defines no "implement" role')

  const deadline = Date.now() + config.maxTaskMinutes * 60_000
  const priorSignatures: string[] = []
  let feedback = ''

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Wall clock is checked BETWEEN attempts so nothing is abandoned half-done.
    if (Date.now() > deadline) { log(`✗ ${task.id}: task wall clock exceeded`); return 'failed' }

    let brief
    try {
      brief = compileBrief({
        store, plan, task, role: 'implement',
        worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha,
        extra: feedback ? `\n# WHAT FAILED LAST TIME\n${feedback}` : undefined,
      })
    } catch (e) {
      if (e instanceof BriefTooLarge) { log(`✗ ${task.id}: ${e.message}`); return 'failed' }
      throw e
    }

    const briefId = store.putArtifact(arcId, 'brief', brief.text)
    const attemptId = store.startAttempt({
      arcId, taskId: task.id, attemptNo: attempt, role: 'implement',
      cli: role.cli, requestedModel: role.model, baseSha: wt.baseSha, briefArtifactId: briefId,
    })
    log(`  · ${task.id} implement attempt ${attempt}/${config.maxAttempts} (${role.cli}/${role.model}, brief ${brief.bytes}B)`)

    const res = await dispatch({
      role, cwd: wt.path, prompt: brief.text, schema: TaskResult,
      onEvent: () => { try { store.renewLease(arcId, task.id, LEASE_MS) } catch { /* lease expiry is the recovery path */ } },
      signal: o.signal,
      // Commits from a worktree write into the main repo's .git; without this
      // the sandboxed writer dies on index.lock the moment the repo lives
      // outside the sandbox-writable temp areas.
      writableRoots: [resolve(wt.path, G.git(wt.path, 'rev-parse', '--git-common-dir'))],
    })

    // Steering counts as APPLIED only once an attempt ran to completion on a
    // brief that contained it. Marking it before dispatch silently dropped it
    // whenever the attempt was cancelled, stalled, or the process died first —
    // a pending intervention is re-included in every retry brief instead.
    if (res.terminalReason === 'ok') {
      for (const interventionId of brief.interventionIds) store.applyIntervention(interventionId)
    }

    const transcriptId = store.putArtifact(arcId, 'transcript', res.transcript, attemptId)
    const drift = modelStatus(o, role, res, attemptId, task.id)
    store.finishAttempt(arcId, attemptId, {
      terminalReason: drift === 'drift' ? 'model-drift' : res.terminalReason,
      exitCode: res.exitCode,
      observedModel: res.observedModels.join(',') || null,
      transcriptArtifactId: transcriptId,
      usage: res.usage,
    })

    if (drift === 'drift') {
      log(`  ✗ MODEL DRIFT: asked for ${role.model}, ran on ${res.observedModels.join(', ')}`)
      store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
        text: `model drift: requested ${role.model}, observed ${res.observedModels.join(', ')}` })
      return 'failed'
    }
    if (res.terminalReason === 'cancelled') { log(`  · ${task.id} cancelled`); return 'failed' }
    if (res.terminalReason !== 'ok' || !res.parsed) {
      log(`  ✗ attempt ${attempt} ended "${res.terminalReason}"`)
      if (res.errorText) log(`      provider said: ${res.errorText.replace(/\s+/g, ' ').slice(0, 220)}`)
      feedback = `The previous attempt ended without a usable result: ${res.terminalReason}.`
      continue
    }

    const result = res.parsed as z.infer<typeof TaskResult>
    const product: TaskProduct = {
      taskId: task.id,
      status: result.status,
      shipped: result.shipped,
      noop: result.noop,
      noopReason: result.noopReason ?? undefined,
    }
    store.appendEvent(arcId, 'task.result', product, task.id, attemptId)
    o.onTaskResult?.(product)

    for (const d of result.deviations) {
      store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'deviation', severity: d.severity,
        text: `${d.from} → ${d.to}`, affects: d.affects })
    }
    for (const d of result.discoveries) {
      store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'discovery', severity: d.severity,
        text: d.text, affects: d.affects })
    }
    for (const p of result.pendingOps) {
      store.addPendingOp(arcId, task.id, p.kind, p.description, p.blocking)
    }

    if (result.noop) {
      // "I did nothing, because X" is a first-class SUCCESSFUL answer — but it
      // still has to satisfy the criteria. A no-op whose acceptance criteria
      // hold is done; one whose criteria fail is not, and must not slip through
      // ungraded just because no code changed.
      log(`  · ${task.id}: no-op — ${result.noopReason ?? 'no reason given'}`)
      store.appendEvent(arcId, 'task.noop', { reason: result.noopReason }, task.id)
      await verifyAllCriteria(o, task, attemptId)
      return 'noop'
    }

    if (!G.hasCommits(wt.path, wt.baseSha)) {
      log(`  ✗ attempt ${attempt}: agent reported "${result.status}" but committed nothing`)
      feedback = 'You reported work done but committed nothing. Commit your changes by explicit path.'
      continue
    }

    const measured = G.measuredFootprint(wt.path, wt.baseSha)
    store.setTaskHead(arcId, task.id, G.headSha(wt.path), measured)

    if (task.footprint.length > 0) {
      const undeclared = measured.filter((f) => !task.footprint.some((d) => f === d || f.startsWith(d)))
      if (undeclared.length > 0) {
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'medium',
          text: `touched ${undeclared.length} file(s) outside declared footprint: ${undeclared.slice(0, 5).join(', ')}`,
          affects: undeclared })
        log(`  ! footprint drift: ${undeclared.length} undeclared file(s)`)
      }
    }

    const gateResults = await runTaskGates(o, task, wt, baselines, attemptId, heavy)
    const failed = gateResults.filter((g) => !g.ok)

    if (failed.length === 0) {
      log(`  ✓ ${task.id} green after ${attempt} attempt(s)`)
      await gradeCriteria(o, task, result, attemptId)
      return 'ok'
    }

    // Compared against EVERY prior failure, not just the last one — a live
    // run interleaved two identical lint failures with a transient 502 and
    // the consecutive-only check never fired. Similarity, not equality,
    // because provider tooling reorders its own noise lines between runs.
    const signature = failed.map((f) => f.result.signature).join('\n--\n')
    const repeat = priorSignatures.findIndex((s) => signaturesMatch(signature, s) || signatureSimilarity(signature, s) >= 0.95)
    if (repeat >= 0) {
      log(`  ✗ ${task.id}: this failure is ≥95% identical to attempt ${repeat + 1}'s — the code is changing but the failure is not.`)
      log(`      That usually means the GATE or its environment is the problem, not the writer. Stopping instead of burning attempts.`)
      store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high',
        text: `loop not converging: failure signature matches attempt ${repeat + 1} on ${failed.map((f) => f.result.name).join(', ')} — suspect the gate or environment, not the code` })
      return 'failed'
    }
    priorSignatures.push(signature)

    feedback = [
      `These checks FAILED. Fix ONLY what they report; do not restyle unrelated code.`,
      ...failed.map((f) => `\n## ${f.result.name} (proves: ${f.result.proves})\n\`\`\`\n${f.result.signature.slice(0, 3000)}\n\`\`\``),
    ].join('\n')
    log(`  ✗ attempt ${attempt}: ${failed.map((f) => f.result.name).join(', ')} failed`)
  }

  log(`  ✗ ${task.id}: exhausted ${config.maxAttempts} attempts`)
  return 'failed'
}

/** Prepare a fresh worktree (dependency install, codegen) so project checks can run in it. */
async function setupWorktree(o: RunOptions, wt: G.Worktree, taskId?: string): Promise<boolean> {
  const { store, config, log } = o
  const setup = await runGate({
    name: 'worktree-setup', command: config.setupCommand!,
    proves: 'the isolated worktree can run project checks',
    cwd: '.', timeoutMs: 600_000, heavy: false, baselineSubset: false,
  }, wt.path, wt.baseSha, o.signal)
  store.recordGate({
    arcId: o.plan.arcId, taskId, name: 'worktree-setup', command: config.setupCommand!,
    proves: 'the isolated worktree can run project checks',
    exitCode: setup.exitCode, baseSha: wt.baseSha,
    verdict: setup.pass ? 'pass' : 'fail', signature: setup.signature,
    artifactId: store.putArtifact(o.plan.arcId, 'gate-output', setup.output),
  })
  if (!setup.pass) {
    log(`  ✗ ${taskId ?? wt.branch}: worktree setup failed — ${setup.output.slice(-300)}`)
    store.addFinding({ arcId: o.plan.arcId, taskId, kind: 'risk', severity: 'high',
      text: `worktree setup failed: ${config.setupCommand} (exit ${setup.exitCode})` })
  }
  return setup.pass
}

async function runTaskGates(
  o: RunOptions, task: PlanTask, wt: G.Worktree,
  // undefined for runs not tied to an attempt (the post-rebase regate) — a
  // made-up id would corrupt every attempt-joined query.
  baselines: Map<string, GateResult>, attemptId: string | undefined, heavy: Semaphore,
): Promise<Array<{ ok: boolean; result: GateResult }>> {
  const gates = selectGates(o.config.gates, task.gates)
  const out: Array<{ ok: boolean; result: GateResult }> = []
  for (const g of gates) {
    // Heavy gates hold the semaphore: a build is CPU/RAM-bound and several at
    // once wedge the machine regardless of how many agent slots are free.
    const r = g.heavy
      ? await heavy.run(() => runGate(g, wt.path, wt.baseSha, o.signal))
      : await runGate(g, wt.path, wt.baseSha, o.signal)
    const base = baselines.get(g.name)
    const ok = g.baselineSubset && base ? isSubsetOfBaseline(r, base) : r.pass
    o.store.recordGate({
      arcId: o.plan.arcId, taskId: task.id, attemptId, name: g.name, command: g.command,
      proves: g.proves, exitCode: r.exitCode, baseSha: wt.baseSha,
      verdict: ok ? 'pass' : 'fail', signature: r.signature,
      artifactId: o.store.putArtifact(o.plan.arcId, 'gate-output', r.output, attemptId),
    })
    o.log(`    ${describe(r)}${ok && !r.pass ? ' (within baseline)' : ''}`)
    out.push({ ok, result: r })
  }
  return out
}

/**
 * The harness grades, never the agent. A criterion claiming `checked` or
 * `observed` only reaches that tier if there is a stored artifact behind it.
 */
async function gradeCriteria(
  o: RunOptions, task: PlanTask,
  result: z.infer<typeof TaskResult>,
  attemptId: string,
): Promise<void> {
  const arcId = o.plan.arcId
  for (const claim of result.criteria) {
    const crit = task.acceptance.find((c) => c.id === claim.id)
    if (!crit) continue

    let artifactId: string | undefined
    if (crit.proofKind === 'command' && crit.proofCommand) {
      // We do not take the agent's word that a command passed — we run it.
      const r = await runGate(
        { name: `criterion:${claim.id}`, command: crit.proofCommand, proves: crit.text, cwd: '.', timeoutMs: 300_000, heavy: false, baselineSubset: false },
        o.store.getTask(arcId, task.id)?.worktree ?? o.config.repo,
        o.store.getTask(arcId, task.id)?.base_sha ?? '', o.signal,
      )
      artifactId = o.store.putArtifact(arcId, 'criterion-proof', r.output, attemptId)
      if (!r.pass) {
        o.log(`    criterion ${claim.id}: proof command FAILED → stays unproven`)
        continue
      }
    }

    // The harness grades, never the agent — in EITHER direction. Reaching
    // here with a command criterion means the harness EXECUTED the proof and
    // it PASSED; a modest claim ("unproven — my sandbox couldn't run it")
    // must not cap a grant the evidence itself earns. (Observed live: a
    // green 334-test proof discarded because the writer claimed 'unproven'.)
    const harnessProved = crit.proofKind === 'command' && artifactId
    const effectiveTier = harnessProved ? 'checked' : claim.claimedTier
    // A sandboxed author often CANNOT run the proof ("Docker denied") while
    // the harness just did — stored verbatim, that claim text sits beside a
    // 'checked' grant looking like a contradiction. Say who proved it.
    const evidence = harnessProved ? `harness ran the proof: PASSED. Author's account: ${claim.evidence}` : claim.evidence
    const granted = o.store.promoteCriterion(arcId, task.id, claim.id, effectiveTier, evidence, artifactId)
    if (granted !== effectiveTier) {
      o.log(`    criterion ${claim.id}: graded ${effectiveTier}, granted ${granted} (evidence did not support the claim)`)
    }
  }

  // The harness grades, never the agent — in BOTH directions. An agent that
  // honestly declines to claim a command criterion (its sandbox could not run
  // the proof) must not leave it unproven when Arc's own execution of the
  // proof passes. (Observed live: a task failed on suite-green while the
  // stored proof artifact showed the suite fully green.)
  const claimedIds = new Set(result.criteria.map((claim) => claim.id))
  for (const crit of task.acceptance) {
    if (claimedIds.has(crit.id) || crit.proofKind !== 'command' || !crit.proofCommand) continue
    const r = await runGate(
      { name: `criterion:${crit.id}`, command: crit.proofCommand, proves: crit.text, cwd: '.', timeoutMs: 300_000, heavy: false, baselineSubset: false },
      o.store.getTask(arcId, task.id)?.worktree ?? o.config.repo,
      o.store.getTask(arcId, task.id)?.base_sha ?? '', o.signal,
    )
    const artifactId = o.store.putArtifact(arcId, 'criterion-proof', r.output, attemptId)
    if (!r.pass) {
      o.log(`    criterion ${crit.id}: unclaimed, and its proof command FAILED → stays unproven`)
      continue
    }
    o.store.promoteCriterion(arcId, task.id, crit.id, 'checked', 'proof command executed by the harness (unclaimed by the agent)', artifactId)
    o.log(`    criterion ${crit.id}: unclaimed by the agent, but its proof command PASSED → checked`)
  }
}

/**
 * Write a finished task's deviations back into the specs of tasks not yet
 * dispatched. This is the anti-decay mechanism.
 *
 * Without it, task 3 builds against what task 1's spec SAID, while task 1
 * actually did something else — and nothing notices until integration. We
 * compute the affected set from `affects[]` rather than maintaining a
 * hand-written lookup table of which task touches what.
 *
 * A task already in flight or already landed cannot have its brief rewritten,
 * so those get a contradiction finding for the integration review instead of a
 * silent amendment nobody reads.
 */
function propagateDeviations(o: RunOptions, from: PlanTask): void {
  const { store, plan, log } = o
  const arcId = plan.arcId

  const deviations = store
    .findingsFor(arcId)
    .filter((f) => f.task_id === from.id && f.kind === 'deviation')
  if (deviations.length === 0) return

  const runtime = store.taskRuntime(arcId)

  for (const d of deviations) {
    let affects: string[] = []
    try { affects = JSON.parse(String(d.affects_json ?? '[]')) } catch { /* ignore */ }

    for (const other of plan.tasks) {
      if (other.id === from.id) continue

      const touches =
        affects.includes(other.id) ||
        affects.some((a) =>
          other.footprint.some((p) => a === p || a.startsWith(p) || p.startsWith(a)) ||
          other.contractsMutated.includes(a) ||
          other.contractsRead.includes(a))
      // No declared overlap? Fall back to the dependency edge — a task that
      // depends on this one is affected by definition.
      if (!touches && !other.dependsOn.includes(from.id)) continue

      const state = runtime[other.id]?.state ?? 'pending'
      if (state === 'pending') {
        store.addAmendment(arcId, other.id, String(d.text), from.id)
        log(`  ↳ amended ${other.id}: ${String(d.text).replace(/\s+/g, ' ').slice(0, 90)}`)
      } else {
        store.addFinding({
          arcId, taskId: other.id, kind: 'contradiction', severity: 'high',
          text: `${from.id} deviated after ${other.id} was already ${state}: ${d.text}`,
          affects: [other.id],
        })
        log(`  ! ${other.id} was already ${state} when ${from.id} deviated — flagged for integration review`)
      }
    }
  }
}

/**
 * Independently prove every criterion that CAN be proved by a command.
 *
 * Used on the no-op path: the agent claimed nothing, so there is nothing to
 * grade from its envelope — but "nothing needed doing" is a claim like any
 * other and has to be checked. We run the proofs ourselves rather than wait to
 * be told.
 */
async function verifyAllCriteria(o: RunOptions, task: PlanTask, attemptId: string): Promise<void> {
  const arcId = o.plan.arcId
  const row = o.store.getTask(arcId, task.id)
  const cwd = String(row?.worktree ?? o.config.repo)
  const baseSha = String(row?.base_sha ?? '')

  for (const crit of task.acceptance) {
    if (crit.proofKind !== 'command' || !crit.proofCommand) continue
    const r = await runGate(
      { name: `criterion:${crit.id}`, command: crit.proofCommand, proves: crit.text,
        cwd: '.', timeoutMs: 300_000, heavy: false, baselineSubset: false },
      cwd, baseSha, o.signal,
    )
    if (!r.pass) {
      o.log(`    criterion ${crit.id}: proof command FAILED → stays unproven`)
      continue
    }
    const artifactId = o.store.putArtifact(arcId, 'criterion-proof', r.output, attemptId)
    o.store.promoteCriterion(arcId, task.id, crit.id, 'checked', `no change needed; \`${crit.proofCommand}\` exited 0`, artifactId)
  }
}

function charterContext(o: RunOptions): string[] {
  const { charter } = o.plan
  const decisions = o.store.decisions(o.plan.arcId)
  return [
    `## Arc goal`, charter.goal,
    ``, `## Objectives`, ...(charter.objectives ?? []).map((item) => `- ${item}`),
    ``, `## Explicit non-goals`, ...(charter.nonGoals ?? []).map((item) => `- ${item}`),
    ``, `## Constraints`, ...(charter.constraints ?? []).map((item) => `- [${item.hardness}] ${item.text}`),
    ``, `## Decisions`, ...decisions.flatMap((decision) => {
      let rejected: string[] = []
      try { rejected = JSON.parse(String(decision.rejected_json ?? '[]')) } catch { /* ignore */ }
      return [
        `- ${decision.question} → ${decision.chosen}${decision.rationale ? ` (${decision.rationale})` : ''}`,
        ...rejected.map((choice) => `  - rejected: ${choice}`),
      ]
    }),
  ]
}

async function runReviewFindingCheck(
  o: RunOptions,
  finding: z.infer<typeof ReviewVerdict>['findings'][number],
  cwd: string,
  baseSha: string,
  attemptId: string,
  taskId?: string,
): Promise<{ keep: boolean; artifactId?: string; exitCode?: number | null }> {
  if (!finding.checkCommand) return { keep: true }
  const name = `${taskId ? `review:${taskId}` : 'integration-review'}:${finding.file}:${finding.line}`
  const result = await runGate({
    name,
    command: finding.checkCommand,
    proves: finding.claim,
    cwd: '.',
    timeoutMs: 300_000,
    heavy: false,
    baselineSubset: false,
    readOnly: true,
  }, cwd, baseSha, o.signal)
  const artifactId = o.store.putArtifact(o.plan.arcId, 'review-check', result.output, attemptId)
  o.store.recordGate({
    arcId: o.plan.arcId,
    taskId,
    attemptId,
    name,
    command: finding.checkCommand,
    proves: finding.claim,
    exitCode: result.exitCode,
    baseSha,
    verdict: result.pass ? 'pass' : 'fail',
    signature: result.signature,
    artifactId,
  })
  o.log(`    ${name}: ${result.pass ? 'reproduced' : 'did not reproduce'} (exit ${result.exitCode ?? 'timeout'})`)
  return { keep: result.pass, artifactId, exitCode: result.exitCode }
}

/**
 * Review, with the anti-anchoring step: Opus writes a risk checklist from the
 * SPEC and BASE TREE first, before it is allowed to see the implementation.
 * Otherwise review degenerates into rationalising whatever was written.
 */
async function reviewLoop(o: RunOptions, task: PlanTask, wt: G.Worktree): Promise<boolean> {
  const { store, plan, config, log } = o
  const arcId = plan.arcId
  const role = config.roles.review
  if (!role) { log('  (no review role configured — skipping)'); return true }

  const checklistBrief = [
    `# PREDICT THE RISKS — you have NOT seen the implementation`,
    ``,
    `A task is about to be reviewed. You are being shown ONLY its spec and the`,
    `code as it stood BEFORE any change. Predict what is most likely to go`,
    `wrong, and how you would check each one.`,
    ``,
    `You will be shown the diff afterwards. Committing to a checklist now is`,
    `what stops the review becoming a rationalisation of whatever was written.`,
    ``,
    ...charterContext(o),
    ``,
    `## Task spec`, task.spec,
    ``, `## Acceptance criteria`,
    ...task.acceptance.map((c) => `- ${c.id}: ${c.text}`),
    ``, `Base commit: ${wt.baseSha}. Read the tree at that commit with your tools.`,
  ].join('\n')

  const clAttempt = store.startAttempt({
    arcId, taskId: task.id, attemptNo: 0, role: 'review', cli: role.cli, requestedModel: role.model,
  })
  const cl = await dispatch({ role, cwd: wt.path, prompt: checklistBrief, schema: RiskChecklist, signal: o.signal })
  const clModel = modelStatus(o, role, cl, clAttempt, task.id)
  store.finishAttempt(arcId, clAttempt, {
    terminalReason: clModel === 'drift' ? 'model-drift' : cl.terminalReason, exitCode: cl.exitCode,
    observedModel: cl.observedModels.join(',') || null,
    transcriptArtifactId: store.putArtifact(arcId, 'transcript', cl.transcript, clAttempt),
    usage: cl.usage,
  })
  if (clModel === 'drift') {
    log(`  ✗ MODEL DRIFT in risk prediction: asked for ${role.model}, ran on ${cl.observedModels.join(', ')}`)
    store.addFinding({ arcId, taskId: task.id, attemptId: clAttempt, kind: 'risk', severity: 'high',
      text: `review model drift: requested ${role.model}, observed ${cl.observedModels.join(', ')}` })
    return false
  }
  if (cl.terminalReason !== 'ok' || !cl.parsed) {
    log(`  ✗ ${task.id}: risk prediction ended "${cl.terminalReason}" — treating as not-reviewed`)
    return false
  }
  const checklist = (cl.parsed as z.infer<typeof RiskChecklist> | undefined)?.risks ?? []
  log(`  · ${task.id} review: ${checklist.length} risk(s) predicted before seeing the diff`)

  const diff = G.git(wt.path, 'diff', `${wt.baseSha}...HEAD`).slice(0, 120_000)
  const gates = store.gatesFor(arcId, task.id).filter((g) => g.verdict !== 'baseline')

  const reviewBrief = [
    `# REVIEW`,
    ``,
    `Review this diff against the spec and the criteria. You are scoped to`,
    `CORRECTNESS, cross-module seams, and whether the acceptance criteria are`,
    `genuinely met. Do NOT comment on style — lint and typecheck already cover it,`,
    `and "do not restyle unrelated code" was an instruction to the author.`,
    ``,
    `Every finding MUST carry file and line. A finding without them is discarded.`,
    `Where a finding can be expressed as a command, put it in checkCommand — we`,
    `will RUN it. A finding that survives execution is a fact; one that fails to`,
    `reproduce is dropped.`,
    ``,
    ...charterContext(o),
    ``,
    `## The risks you predicted before seeing this code`,
    ...checklist.map((r) => `- ${r.id}: ${r.text} — check by: ${r.howToCheck}`),
    ``, `## Task spec`, task.spec,
    ``, `## Acceptance criteria`,
    ...task.acceptance.map((c) => `- ${c.id}: ${c.text}`),
    ``, `## Checks already run`,
    ...gates.map((g) => `- ${g.name}: ${g.verdict} (proves: ${g.proves})`),
    ``, `## The diff`, '```diff', diff, '```',
  ].join('\n')

  // The clock is infrastructure; the task is green. A review that dies on
  // TIME (timeout/stall) gets ONE fresh try before the task is buried — a
  // real 26-minute Opus review of a large schema diff was about to hard-fail
  // a task whose gates and criteria had all passed.
  let rv!: DispatchResult
  let rvAttempt = ''
  for (let round = 1; round <= 2; round++) {
    rvAttempt = store.startAttempt({
      arcId, taskId: task.id, attemptNo: round, role: 'review', cli: role.cli, requestedModel: role.model,
    })
    rv = await dispatch({ role, cwd: wt.path, prompt: reviewBrief, schema: ReviewVerdict, signal: o.signal })
    const rvModel = modelStatus(o, role, rv, rvAttempt, task.id)
    store.finishAttempt(arcId, rvAttempt, {
      terminalReason: rvModel === 'drift' ? 'model-drift' : rv.terminalReason, exitCode: rv.exitCode,
      observedModel: rv.observedModels.join(',') || null,
      transcriptArtifactId: store.putArtifact(arcId, 'transcript', rv.transcript, rvAttempt),
      usage: rv.usage,
    })

    if (rvModel === 'drift') {
      log(`  ✗ MODEL DRIFT in review: asked for ${role.model}, ran on ${rv.observedModels.join(', ')}`)
      store.addFinding({ arcId, taskId: task.id, attemptId: rvAttempt, kind: 'risk', severity: 'high',
        text: `review model drift: requested ${role.model}, observed ${rv.observedModels.join(', ')}` })
      return false
    }
    if ((rv.terminalReason === 'hard-timeout' || rv.terminalReason === 'stall-kill') && round === 1) {
      log(`  ! ${task.id}: review ${rv.terminalReason} — the task is green, so the review gets one more try`)
      continue
    }
    break
  }

  if (rv.terminalReason !== 'ok' || !rv.parsed) {
    log(`  ✗ ${task.id}: review ended "${rv.terminalReason}" — treating as not-reviewed`)
    return false
  }

  const verdict = rv.parsed as z.infer<typeof ReviewVerdict>
  const verdictArtifact = store.putArtifact(arcId, 'review-verdict', JSON.stringify(verdict, null, 2), rvAttempt)
  // A finding with no file:line is discarded, as advertised in the prompt.
  const checkedFindings = await Promise.all(verdict.findings
    .filter((f) => f.file && f.file.trim().length > 0)
    .map(async (finding) => ({
      finding,
      check: await runReviewFindingCheck(o, finding, wt.path, wt.baseSha, rvAttempt, task.id),
    })))
  const findings = checkedFindings.filter(({ check }) => check.keep).map(({ finding }) => finding)

  for (const { finding: f, check } of checkedFindings.filter(({ check }) => check.keep)) {
    const findingId = store.addFinding({
      arcId, taskId: task.id, attemptId: rvAttempt, kind: 'review',
      severity: f.severity === 'critical' ? 'high' : f.severity === 'major' ? 'medium' : 'low',
      text: `${f.file}:${f.line} — ${f.claim}`, affects: [f.file],
    })
    if (check.artifactId && f.checkCommand) {
      store.attachFindingEvidence(findingId, {
        artifactId: check.artifactId,
        command: f.checkCommand,
        exitCode: check.exitCode ?? null,
        verdict: 'pass',
      })
    }
  }

  for (const assessment of verdict.criteriaAssessment.filter((item) => item.met)) {
    const criterion = task.acceptance.find((item) => item.id === assessment.id)
    if (criterion?.proofKind === 'agent-review') {
      store.promoteCriterion(arcId, task.id, criterion.id, 'checked', assessment.evidence, verdictArtifact)
    }
  }

  const criticals = findings.filter((f) => f.severity === 'critical')
  log(`  · ${task.id} verdict ${verdict.verdict}: ${findings.length} finding(s), ${criticals.length} critical`)

  if (verdict.verdict === 'PASS' || verdict.verdict === 'PASS_WITH_NOTES') {
    if (criticals.length > 0) {
      log(`  ✗ ${task.id}: verdict says pass but carries ${criticals.length} critical finding(s) — gate wins`)
      return false
    }
    for (const a of verdict.criteriaAssessment.filter((c) => !c.met)) {
      log(`  ! reviewer says criterion ${a.id} NOT met: ${a.evidence}`)
      store.addFinding({ arcId, taskId: task.id, attemptId: rvAttempt, kind: 'risk', severity: 'medium',
        text: `reviewer: criterion ${a.id} not met — ${a.evidence}` })
    }
    return verdict.criteriaAssessment.every((c) => c.met !== false) || verdict.verdict === 'PASS'
  }

  return false
}

async function landTask(
  o: RunOptions, task: PlanTask, wt: G.Worktree,
  integrationBranch: string, baselines: Map<string, GateResult>, heavy: Semaphore,
): Promise<boolean> {
  const { store, config, log } = o
  const arcId = o.plan.arcId
  const onto = G.git(config.repo, 'rev-parse', integrationBranch)

  const rb = G.rebaseOnto(wt.path, wt.baseSha, onto)
  if (!rb.ok) {
    log(`  ✗ ${task.id}: rebase failed — ${rb.message}`)
    if (rb.conflictFiles.length) log(`      conflicts: ${rb.conflictFiles.join(', ')}`)
    store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high',
      text: `rebase onto integration failed: ${rb.message}`, affects: rb.conflictFiles })
    return false
  }

  // A pre-rebase green is NOT a post-rebase green. Re-gate on the rebased tree.
  const regated = await runTaskGates(o, task, { ...wt, baseSha: onto }, baselines, undefined, heavy)
  if (regated.some((g) => !g.ok)) {
    log(`  ✗ ${task.id}: red after rebase — not landing`)
    return false
  }

  const lr = G.landBranch(config.repo, integrationBranch, wt.branch)
  store.appendEvent(arcId, 'land', lr, task.id)
  if (lr.restoreFailed) {
    log(`  ⚠ ${task.id}: your checkout was left on "${integrationBranch}" — restoring your branch failed`)
  }
  if (!lr.ok) {
    log(`  ✗ ${task.id}: land failed — ${lr.message}`)
    return false
  }
  log(`  ✓ ${task.id} LANDED  ${lr.before.slice(0, 8)} → ${lr.after.slice(0, 8)}`)
  return true
}

/**
 * Whole-integration review. Required, not optional.
 *
 * Per-task review is green by construction against a whole class of breakage:
 * one task deletes the only writer of a field while three others build readers
 * against it, and no single diff contains both.
 */
async function finalReview(o: RunOptions, integrationBranch: string, baseSha: string): Promise<boolean> {
  const { store, config, log } = o
  const arcId = o.plan.arcId
  const role = config.roles.integrate ?? config.roles.review
  if (!role) return true

  const head = G.git(config.repo, 'rev-parse', integrationBranch)
  if (head === baseSha) { log('nothing landed — skipping integration review'); return true }

  const diff = G.git(config.repo, 'diff', `${baseSha}...${head}`).slice(0, 200_000)
  log(`integration review over ${baseSha.slice(0, 8)}...${head.slice(0, 8)}`)

  // The main checkout is intentionally left where the operator had it. Review
  // and reproduction commands need the INTEGRATION tree, so give them a
  // disposable read-only worktree rather than accidentally checking main.
  const reviewWorkspaceId = `${arcId}-integration-review`
  G.releaseTaskWorkspace(config.repo, store.root, reviewWorkspaceId)
  let reviewWt: G.Worktree
  try {
    reviewWt = G.provisionWorktree(config.repo, store.root, reviewWorkspaceId, head)
  } catch (error) {
    log(`! integration review isolation failed: ${(error as Error).message}`)
    store.addFinding({ arcId, kind: 'integration', severity: 'high',
      text: `integration review isolation failed: ${(error as Error).message}` })
    return false
  }

  // Any exit — a store write throwing, a dispatch rejection, a finding check
  // crashing — must still release the review worktree: the leaked branch
  // fail-closes every future integration review of this arc.
  try {
    if (config.setupCommand && !await setupWorktree(o, reviewWt)) {
      log('! integration review workspace could not be set up — review unavailable, arc cannot be complete')
      store.addFinding({ arcId, kind: 'integration', severity: 'high',
        text: 'integration review unavailable: worktree setup failed' })
      return false
    }
    return await reviewIntegrationHead(o, role, reviewWt, head, diff)
  } finally {
    G.releaseTaskWorkspace(config.repo, store.root, reviewWorkspaceId)
  }
}

/**
 * The dispatch/verdict half of the whole-integration review, split out so the
 * caller can `finally`-release the review worktree however this exits.
 */
async function reviewIntegrationHead(
  o: RunOptions, role: RoleBinding, reviewWt: G.Worktree, head: string, diff: string,
): Promise<boolean> {
  const { store, log } = o
  const arcId = o.plan.arcId

  const prompt = [
    `# WHOLE-INTEGRATION REVIEW`,
    ``,
    `Every task below already passed its own review. Your job is the class of`,
    `breakage that per-task review CANNOT see, because no single diff contains`,
    `both halves of it. Look specifically at the SEAMS:`,
    ``,
    `- a symbol, field, or export deleted in one task and still referenced in another`,
    `- types or data shapes that cross module boundaries inconsistently`,
    `- two tasks that each implemented half of one contract, differently`,
    `- requirements from the charter that no single task owns`,
    ``,
    ...charterContext(o),
    ``, `## Tasks that landed`,
    ...store.allTasks(arcId).filter((t) => t.state === 'landed').map((t) => `- ${t.id}: ${t.title}`),
    ``, `## The combined diff`, '```diff', diff, '```',
  ].join('\n')

  const attemptId = store.startAttempt({
    arcId, taskId: null, attemptNo: 1, role: 'integrate', cli: role.cli, requestedModel: role.model,
  })
  const rv = await dispatch({ role, cwd: reviewWt.path, prompt, schema: ReviewVerdict, signal: o.signal })
  const rvModel = modelStatus(o, role, rv, attemptId, null)
  store.finishAttempt(arcId, attemptId, {
    terminalReason: rvModel === 'drift' ? 'model-drift' : rv.terminalReason, exitCode: rv.exitCode,
    observedModel: rv.observedModels.join(',') || null,
    transcriptArtifactId: store.putArtifact(arcId, 'transcript', rv.transcript, attemptId),
    usage: rv.usage,
  })

  if (rvModel === 'drift') {
    log(`! MODEL DRIFT in integration review: asked for ${role.model}, ran on ${rv.observedModels.join(', ')}`)
    store.addFinding({ arcId, attemptId, kind: 'integration', severity: 'high',
      text: `integration review model drift: requested ${role.model}, observed ${rv.observedModels.join(', ')}` })
    return false
  }

  if (rv.terminalReason !== 'ok' || !rv.parsed) {
    log(`! integration review ended "${rv.terminalReason}" — arc cannot be complete`)
    store.addFinding({ arcId, attemptId, kind: 'integration', severity: 'high',
      text: `integration review unavailable: ${rv.terminalReason}` })
    return false
  }

  const v = rv.parsed as z.infer<typeof ReviewVerdict>
  const checkedFindings = await Promise.all(v.findings
    .filter((f) => f.file)
    .map(async (finding) => ({
      finding,
      check: await runReviewFindingCheck(o, finding, reviewWt.path, head, attemptId),
    })))
  for (const { finding: f, check } of checkedFindings.filter(({ check }) => check.keep)) {
    const findingId = store.addFinding({ arcId, attemptId, kind: 'integration',
      severity: f.severity === 'critical' ? 'high' : 'medium',
      text: `${f.file}:${f.line} — ${f.claim}`, affects: [f.file] })
    if (check.artifactId && f.checkCommand) {
      store.attachFindingEvidence(findingId, {
        artifactId: check.artifactId,
        command: f.checkCommand,
        exitCode: check.exitCode ?? null,
        verdict: 'pass',
      })
    }
  }
  const retained = checkedFindings.filter(({ check }) => check.keep).length
  log(`integration verdict: ${v.verdict} (${retained}/${v.findings.length} finding(s) reproduced or retained)`)
  store.appendEvent(arcId, 'integration.verdict', { verdict: v.verdict, findings: retained })
  return v.verdict === 'PASS' || v.verdict === 'PASS_WITH_NOTES'
}

/**
 * The final report. It may only assert what it OBSERVED.
 *
 * `landed` ≠ `active` ≠ `verified`. An arc that says "done" while a blocking
 * pending op is open is exactly the false completion this engine exists to
 * prevent.
 */
function report(o: RunOptions, integrationBranch: string, integrationApproved: boolean): boolean {
  const { store, plan, log } = o
  const arcId = plan.arcId
  const tasks = store.allTasks(arcId)
  const crit = store.allCriteria(arcId)
  const ops = store.openBlockingOps(arcId)

  const landed = tasks.filter((t) => t.state === 'landed')
  const failed = tasks.filter((t) => t.state === 'failed')
  const blocked = tasks.filter((t) => t.state === 'blocked')

  const byTier = (t: string) => crit.filter((c) => c.tier === t).length

  log('')
  log('════════════════════════════════════════════')
  log(`ARC ${arcId}`)
  log(`  goal: ${plan.charter.goal.split('\n')[0]?.slice(0, 70)}`)
  log('')
  log(`  landed   ${landed.length}/${tasks.length}`)
  if (failed.length) log(`  FAILED   ${failed.length}  (${failed.map((t) => t.id).join(', ')})`)
  if (blocked.length) log(`  blocked  ${blocked.length}  (${blocked.map((t) => t.id).join(', ')})`)
  log('')
  log(`  criteria: observed ${byTier('observed')} · checked ${byTier('checked')} · claimed-only ${byTier('claimed')} · unproven ${byTier('unproven')}`)

  const weak = crit.filter((c) => c.tier === 'claimed' || c.tier === 'unproven')
  if (weak.length) {
    log('')
    log('  NOT PROVEN — an agent asserted these but nothing verified them:')
    for (const c of weak) log(`    ${c.task_id}/${c.id}: ${c.text.slice(0, 64)}`)
  }
  if (ops.length) {
    log('')
    log('  BLOCKING PENDING OPS — the arc is NOT done until these are run:')
    for (const p of ops) log(`    [${p.kind}] ${p.description}`)
  }
  if (!integrationApproved) {
    log('')
    log('  INTEGRATION REVIEW DID NOT PASS — whole-branch findings block completion.')
  }

  const complete = integrationApproved && failed.length === 0 && blocked.length === 0 && weak.length === 0 && ops.length === 0
  log('')
  log(`  integration branch: ${integrationBranch}`)
  log(`  ${complete ? 'COMPLETE — every criterion has evidence' : 'INCOMPLETE — see above. Nothing merged to your main branch.'}`)
  log('════════════════════════════════════════════')

  store.closeArc(arcId, complete ? 'done' : 'incomplete')
  return complete
}
