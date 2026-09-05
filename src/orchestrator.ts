import { z } from 'zod'
import { resolve } from 'node:path'
import { Store } from './store.ts'
import { compileBrief, BriefTooLarge } from './brief.ts'
import {
  dispatch, checkModel, auxiliaryModels, capacityFailure, modelCheckMode,
  type DispatchOptions, type DispatchResult,
} from './harness.ts'
import { computeFrontier, validatePlan, pathsOverlap } from './scheduler.ts'
import { runGate, selectGates, isSubsetOfBaseline, describe, testsVanished, matchesGlob, type GateResult } from './gates.ts'
import { checkReviewFinding, type FindingOutcome } from './finding-check.ts'
import { captureDirectSnapshot } from './direct.ts'
import { assembleDiff, changedFiles } from './diff.ts'
import { dryRunProofs } from './dry-run.ts'
import { scanContracts, contractDrift, type ContractScan } from './contracts.ts'
import {
  probeCapability, probeUnsandboxedOnly, describeReachability, atLeast, looser,
  type CapabilityProbe, type SandboxLevel,
} from './capabilities.ts'
import { notify, clearTerminal } from './notify.ts'

/** Byte budgets for what a reviewer is shown. Deliberately named rather than
 *  inlined: they used to be three unrelated magic numbers, and the implement
 *  lane's own ceiling was a fourth that disagreed with all of them. */
const REVIEW_DIFF_BUDGET = 120_000
const INTEGRATION_DIFF_BUDGET = 200_000
import { signaturesMatch, signatureSimilarity, isRetryable } from './classify.ts'
import * as G from './git.ts'
import { formatCostSummary } from './cost.ts'
import {
  TaskResult, ReviewVerdict, RiskChecklist, ProjectConfig, PlanIdentifier, TIER_RANK,
  type Plan, type PlanTask, type AgentRole, type RoleBinding, type ClaimTier,
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
  /** Per-task sandbox elevations resolved at preflight. Set by runArc; callers
   *  never populate it. */
  elevations?: Map<string, SandboxLevel>
  /** The arc's base contract surface, scanned once and reused by every task
   *  because they all branch from the same sha. Populated lazily by runArc. */
  baseContractScans?: Map<string, ContractScan>
  /** Proceed with no gates. Explicit only: a gate-less arc proves nothing, so
   *  it must be something the operator SAID, never something inferred. */
  allowNoGates?: boolean
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
  /** Run the provider/model probe before the first scheduling wave. */
  preflight?: boolean
  /** A supervised CLI may wait at preflight; an interactive start refuses. */
  waitForPreflightCapacity?: boolean
  /** Shared across every step so the configured budget is an arc budget. */
  capacityState?: { waitedMs: number }
}

export interface TaskProduct {
  taskId: string
  status: z.infer<typeof TaskResult>['status']
  shipped: z.infer<typeof TaskResult>['shipped']
  noop: boolean
  noopReason?: string
}

const ARC_LEASE_MS = 90_000
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

const activeRuns = new Set<string>()

export async function runArc(o: RunOptions): Promise<void> {
  const key = `${resolve(o.store.root)}\0${o.plan.arcId}`
  if (activeRuns.has(key)) {
    o.log(`✗ arc "${o.plan.arcId}" is already running in this process.`)
    return
  }
  activeRuns.add(key)
  let lease: ReturnType<typeof setInterval> | undefined
  let claimed = false
  const claim = (): boolean => {
    if (!o.store.claimArc(o.plan.arcId, ARC_LEASE_MS)) {
      o.log(`✗ arc "${o.plan.arcId}" is already being run by another process (its lease is live).`)
      return false
    }
    claimed = true
    lease = setInterval(() => {
      try { o.store.renewArcLease(o.plan.arcId, ARC_LEASE_MS) } catch { /* retry at the next heartbeat */ }
    }, ARC_LEASE_MS / 3)
    lease.unref()
    return true
  }
  try {
    await executeArc(o, claim)
  } finally {
    if (lease) clearInterval(lease)
    try { if (claimed) o.store.releaseArc(o.plan.arcId) }
    finally { activeRuns.delete(key) }
  }
}

async function executeArc(o: RunOptions, claim: () => boolean): Promise<void> {
  if (o.resume) {
    const persistedPlan = o.store.getPlan(o.plan.arcId)
    const persistedConfig = o.store.getRunSnapshot(o.plan.arcId)
    if (!persistedPlan) throw new Error(`cannot resume unknown arc "${o.plan.arcId}"`)
    o = {
      ...o,
      plan: persistedPlan,
      // Execution commands stay frozen; capability grants are operator decisions
      // that must be refreshable when resuming a quarantined task.
      config: persistedConfig ? ProjectConfig.parse({
        ...ProjectConfig.parse(persistedConfig), capabilities: o.config.capabilities,
      }) : o.config,
    }
  }

  const { store, plan, config, log } = o
  PlanIdentifier.parse(plan.arcId)
  for (const task of plan.tasks) PlanIdentifier.parse(task.id)
  if (o.resume && store.getArc(plan.arcId)?.status === 'done') {
    log(`arc "${plan.arcId}" is already done; no work was dispatched.`)
    return
  }
  const persistedCapacityWait = o.resume
    ? store.eventsSince(plan.arcId, 0)
      .filter((event) => event.kind === 'capacity.wait')
      .reduce((total, event) => total + Number((event.payload as { waitMs?: number } | null)?.waitMs ?? 0), 0)
    : 0
  o.capacityState ??= { waitedMs: persistedCapacityWait }
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
    if (!claim()) return
    store.markArcRunning(arcId)
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
    // NOTE: this loop no longer force-deletes a stuck task's branch. It used to,
    // which meant every crash threw away committed work, passing gates and
    // sometimes a finished review — and under `--until-done`, ten relaunches
    // were ten opportunities to do it again. provisionWorktree now reuses a
    // worktree whose head DESCENDS from the base, so the writer picks up where
    // it stopped and the durable attempt budget stops it re-running forever.
    // A quarantined task was refused for a reason a HUMAN can clear — a
    // capability grant, a Docker daemon started. Resume re-probes from scratch,
    // so putting them back on the queue is what makes `arc resume` the way you
    // act on the decision.
    const held = store.allTasks(arcId).filter((t) => ['quarantined', 'blocked'].includes(String(t.state)))
    for (const t of held) {
      log(`resume: ${t.id} was ${t.state} — re-checking whether it can run now`)
      store.setTaskState(arcId, String(t.id), 'pending')
    }

    const stuck = store.allTasks(arcId).filter((t) => ['running', 'reviewing', 'landing'].includes(String(t.state)))
    let requeued = 0
    for (const t of stuck) {
      // The merge and the state write are two operations; a crash between them
      // leaves the row saying "landing" over work that IS already merged. Ask
      // git, which is the only thing that actually knows. Rebuilding the task
      // would re-derive a change the integration branch already carries, and
      // then fail its own rebase and report a LANDED task as failed.
      const head = String(t.head_sha ?? '')
      if (head && G.gitOk(repo, 'merge-base', '--is-ancestor', head, integrationBranch)) {
        log(`resume: ${t.id} was "${t.state}" but ${head.slice(0, 8)} is already on ${integrationBranch} — it landed`)
        store.setTaskState(arcId, String(t.id), 'landed')
        store.appendEvent(arcId, 'land.recovered', { headSha: head }, String(t.id))
        G.releaseTaskWorkspace(repo, store.root, workspaceId(arcId, String(t.id)))
        continue
      }
      // "No live worker" was an assumption. A SIGKILL to arc runs none of its
      // handlers, so the provider CLI and everything it spawned survive,
      // reparented to init — and then a resume works in a tree an orphan is
      // still writing to. Ask the OS before believing the row.
      const pgid = Number(t.worker_pgid ?? 0)
      if (pgid > 0 && killGroupIfAlive(pgid)) {
        log(`resume: ${t.id} left an ORPHANED provider (pgid ${pgid}) still running — killed it before reclaiming`)
        store.appendEvent(arcId, 'task.orphan.killed', { pgid }, String(t.id))
      }
      store.setTaskWorker(arcId, String(t.id), null)
      log(`resume: ${t.id} was "${t.state}" with no live worker — requeueing, keeping its branch`)
      store.setTaskState(arcId, String(t.id), 'pending')
      requeued++
    }
    store.appendEvent(arcId, 'arc.resume', { requeued, recovered: stuck.length - requeued })
    log(`resuming arc ${arcId} from persisted base ${baseSha.slice(0, 8)} — ${requeued} task(s) requeued`)
  } else {
    if (store.getArc(arcId)) throw new Error(`arc "${arcId}" already exists — use arc resume`)
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
    if (!claim()) return
    store.saveRunSnapshot(arcId, config)
    store.appendEvent(arcId, 'arc.start', { baseSha, integrationBranch, tasks: plan.tasks.length })
    log(`arc ${arcId} — ${plan.tasks.length} tasks, base ${baseSha.slice(0, 8)}, integration ${integrationBranch}`)
  }

  // Test-only fault injection exercises the process-level crash recorder at a
  // point where the arc row exists but no normal terminal event can be written.
  if (process.env.ARC_TEST_CRASH_AFTER_START) {
    throw new Error(process.env.ARC_TEST_CRASH_AFTER_START)
  }

  // A gate-less run is a CATEGORY ERROR, not a warning. This system's thesis is
  // that nothing counts as done without evidence on disk, and an arc with no
  // gates cannot prove anything by construction — the README already argues
  // this position; the code should hold it.
  if (config.gates.length === 0 && !o.allowNoGates) {
    log('✗ this project declares NO gates, so this arc cannot prove anything.')
    log('  Add a typecheck/test/build gate to arc.yaml, or pass --no-gates to say you mean it.')
    store.closeArc(arcId, 'incomplete')
    return
  }

  // Validate the plan AGAINST THIS CONFIG before spending anything. A task
  // naming a gate the project does not declare used to throw from selectGates
  // at task runtime — after the implement dispatch had already been billed.
  const planErrors = validatePlan(plan, config)
  if (planErrors.length > 0) {
    for (const e of planErrors) log(`  ✗ ${e}`)
    store.closeArc(arcId, 'incomplete')
    log('INCOMPLETE — the plan does not fit this project config; nothing was dispatched.')
    return
  }

  if (o.preflight && !o.resume && !await preflightCapacity(o)) {
    store.closeArc(arcId, 'incomplete')
    log('INCOMPLETE — provider capacity preflight refused to dispatch wave 1.')
    logCostSummary(o)
    return
  }

  // What can the WRITER actually reach? Arc's gates run unsandboxed, so
  // verification always worked — but an agent that cannot run the check it is
  // graded by writes blind, and every retry costs a full dispatch to learn one
  // bit. Probed before anything is spent: four subprocesses per capability,
  // zero tokens.
  const implementRole = config.roles.implement
  const capabilityPlan = planCapabilities(o, implementRole.sandbox, implementRole.cli === 'codex')
  store.appendEvent(arcId, 'capability.probe', {
    probes: [...capabilityPlan.probes.values()].map((probe) => ({
      name: probe.name, reachability: probe.reachability, rungs: probe.rungs,
    })),
  })
  for (const [taskId, why] of capabilityPlan.refusals) {
    log(`  ✗ ${taskId} QUARANTINED — ${why}`)
    store.setTaskState(arcId, taskId, 'quarantined')
    store.addFinding({ arcId, taskId, kind: 'risk', severity: 'high',
      text: `quarantined: ${why.split('\n')[0]}` })
  }
  o.elevations = new Map([...capabilityPlan.elevations].map(([id, e]) => [id, e.level]))
  if (capabilityPlan.elevations.size > 0) {
    const n = capabilityPlan.elevations.size
    if (n === plan.tasks.length && n > 1) {
      // Arithmetically correct — those tasks do run that gate — but rarely
      // intended. The lever is task.gates, and it belongs to the planner.
      log(`  ! ${n} of ${plan.tasks.length} tasks will run ELEVATED. Scope the gate in the plan (task.gates) if that is not what you meant.`)
    }
    for (const [taskId, e] of capabilityPlan.elevations) {
      log(`  ▲ ${taskId} will run ELEVATED at "${e.level}" — declared for \`${e.because}\``)
      store.appendEvent(arcId, 'task.elevated', { level: e.level, capability: e.because }, taskId)
    }
  }

  // Every proof command executed at the base commit BEFORE anything is
  // dispatched. A vacuous proof — one that already passes — would otherwise
  // grant `checked` and put a green tick beside a criterion nothing
  // established, which is the one thing this system exists not to do.
  if (!o.resume && config.dryRunProofs) {
    const dry = await dryRunProofs(plan, config, store.root, baseSha, o.signal, log)
    if (!dry.ran) {
      log(`! proof dry-run could not run (${dry.reason}) — criteria are unproven-at-base, not proven-discriminating`)
      store.addFinding({ arcId, kind: 'risk', severity: 'medium',
        text: `proof dry-run did not run: ${dry.reason}` })
    }
    for (const f of dry.findings) {
      log(`  ✗ ${f.taskId}/${f.criterionId}: ${f.message}`)
      store.addFinding({ arcId, taskId: f.taskId, kind: 'risk', severity: 'high',
        text: `${f.criterionId} (${f.polarity}) — ${f.message}` })
    }
    if (dry.findings.length > 0) {
      store.closeArc(arcId, 'incomplete')
      log(`INCOMPLETE — ${dry.findings.length} criterion/criteria cannot distinguish done from not-done. Nothing was dispatched.`)
      return
    }
  }

  // Sibling tasks share a base and often a hot file, so they hit the identical
  // conflict against the integration head and each pays full price for it.
  // rr-cache lives in the common dir, so it is shared across every worktree.
  G.enableRerere(repo)

  const heavy = new Semaphore(config.heavyGateLimit)
  // Agents and their local gates may run in parallel; rebasing/advancing the
  // one integration ref is a serial transaction. Synchronous gates used to
  // hide this race by accident.
  const landing = new Semaphore(1)

  const baselines = await measureBaselines(o, baseSha)

  const inFlight = new Map<string, Promise<void>>()
  const crashed = (task: PlanTask, error: unknown): void => {
    if (o.signal?.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    const landed = store.getTask(arcId, task.id)?.state === 'landed'
    log(`✗ ${task.id}: crashed${landed ? ' after landing (work is preserved)' : ''} — ${message}`)
    store.appendEvent(arcId, 'task.crashed', { message: message.slice(0, 400), afterLanding: landed }, task.id)
    if (!landed) store.setTaskState(arcId, task.id, 'failed')
  }
  let ticks = 0
  try {
    for (;;) {
      if (o.signal?.aborted) { log('cancelled — stopping. Nothing further will be landed.'); break }
      if (o.maxTicks && ++ticks > o.maxTicks) { log('max ticks reached'); break }
      const pendingOps = store.openBlockingOps(arcId)
      if (pendingOps.length > 0) {
        log(`NEEDS INPUT — ${pendingOps.length} blocking operation(s); finishing active tasks and pausing new dispatches.`)
        store.appendEvent(arcId, 'arc.needs-input', { operations: pendingOps.map((op) => op.id) })
        notify({ kind: 'needs-input', arcId, message: 'resolve blocking operations with arc ops, then resume' },
          { command: config.notifyCommand })
        break
      }

      const runtime = store.taskRuntime(arcId)
      // A synchronous git/compiler call can delay heartbeats. A promise we
      // still own is a live worker, regardless of its last database timestamp.
      for (const id of inFlight.keys()) {
        if (runtime[id]) runtime[id]!.leaseExpiresAt = null
      }
      const frontier = computeFrontier({ plan, runtime, now: Date.now(), agentConcurrency: config.agentConcurrency })
      for (const id of frontier.reclaimable) {
        store.appendEvent(arcId, 'lease.expired', {}, id)
        store.setTaskState(arcId, id, 'pending')
      }
      if (frontier.ready.length === 0) {
        if (inFlight.size > 0) { await Promise.race(inFlight.values()); continue }
        if (frontier.reclaimable.length > 0) continue
        const stuck = plan.tasks.filter((t) => (runtime[t.id]?.state ?? 'pending') === 'pending')
        if (stuck.length > 0) {
          log(`DEADLOCK: ${stuck.length} task(s) pending but none runnable:`)
          for (const item of frontier.blocked) log(`  ${item.id}: ${item.reason}`)
          for (const task of stuck) store.setTaskState(arcId, task.id, 'blocked')
        }
        break
      }
      if (frontier.ready.length > 1) {
        log(`▶ ${frontier.ready.length} tasks in parallel: ${frontier.ready.map((t) => t.id).join(', ')}`)
      }
      const landed = store.allTasks(arcId).filter((t) => t.state === 'landed').length
      notify({ kind: 'progress', arcId,
        message: `${landed}/${plan.tasks.length} · ${frontier.ready.map((t) => t.id).join(', ')}`,
        percent: landed / Math.max(1, plan.tasks.length) * 100,
      }, { command: config.notifyCommand })
      for (const task of frontier.ready) {
        const running = runTask(o, task, baselines, integrationBranch, heavy, landing)
          .catch((error: unknown) => crashed(task, error))
          .finally(() => { inFlight.delete(task.id) })
        inFlight.set(task.id, running)
      }
      await Promise.race(inFlight.values())
    }
  } finally {
    // Cancellation, observer failure, and a task exception all drain owned
    // workers before the caller can release the run lease or close SQLite.
    await Promise.allSettled(inFlight.values())
  }

  const landedCount = store.allTasks(arcId).filter((task) => task.state === 'landed').length
  let integrationApproved = true
  if (landedCount === 0) log('nothing landed — skipping integration review')
  else if (o.signal?.aborted || store.openBlockingOps(arcId).length > 0) integrationApproved = false
  else {
    integrationApproved = await verifyFinalState(o, integrationBranch, baselines, heavy)
    if (integrationApproved) integrationApproved = await finalReview(o, integrationBranch, baseSha)
  }
  const complete = report(o, integrationBranch, integrationApproved)
  // Delivery is part of being done. Closing the arc before pushing meant a
  // rejected push or a failed `gh pr create` still stored 'done', and `arc run`
  // exited 0 — a false success for an unattended caller, which is the exact
  // thing the exit code exists to prevent.
  const delivered = await finalize(o, integrationBranch, baseSha, complete)
  if (complete && !delivered) {
    log('')
    log('  NOT DELIVERED — the work is green but never left this machine. The arc is INCOMPLETE.')
  }
  const finalStatus = complete && delivered ? 'done' : 'incomplete'
  store.closeArc(arcId, finalStatus)
  const landedNow = store.allTasks(arcId).filter((t) => t.state === 'landed').length
  notify({
    kind: finalStatus === 'done' ? 'done' : 'failed',
    arcId,
    message: finalStatus === 'done'
      ? `done — ${landedNow}/${plan.tasks.length} landed and delivered`
      : `INCOMPLETE — ${landedNow}/${plan.tasks.length} landed`,
    percent: 100,
  }, { command: config.notifyCommand })
  clearTerminal()
}

async function preflightCapacity(o: RunOptions): Promise<boolean> {
  const seen = new Set<string>()
  for (const [name, binding] of Object.entries(o.config.roles)) {
    if (!binding) continue
    const role = binding as RoleBinding
    const key = `${role.cli}:${role.model}`
    if (seen.has(key)) continue
    seen.add(key)
    const roleName = name as AgentRole
    o.log(`preflight: probing ${role.cli}/${role.model}`)
    const probeRole: RoleBinding = { ...role, sandbox: 'read-only', tools: undefined }
    const probe = await dispatchStep(o, {
      roleName, role: probeRole, taskId: null, attemptNo: 0,
      waitForCapacity: o.waitForPreflightCapacity === true,
      dispatch: {
        cwd: o.config.repo,
        prompt: 'Arc capacity probe. Reply with a single short acknowledgement; do not inspect or modify the repository.',
        signal: o.signal,
      },
    })
    if (probe.capacityError) {
      o.log(`! capacity preflight: ${probe.capacityError}`)
      o.store.appendEvent(o.plan.arcId, 'preflight.refused', {
        provider: role.cli, requested: role.model, message: probe.capacityError,
      })
      return false
    }
    if (probe.model === 'drift') {
      o.log(`! capacity preflight: MODEL DRIFT — asked for ${role.model}, observed ${probe.result.observedModels.join(', ')}`)
      return false
    }
    if (probe.result.terminalReason !== 'ok') {
      o.log(`! capacity preflight: ${role.cli}/${role.model} ended ${probe.result.terminalReason}`)
      return false
    }
  }
  return true
}

/**
 * Deliver the arc's work, per `landStrategy`.
 *
 * ONLY when the arc is complete. An incomplete arc leaves its integration
 * branch sitting locally and says so — publishing half-finished work, or
 * worse pushing it at a protected branch, is exactly the false-completion
 * failure this engine exists to prevent.
 */
/** Returns whether the work was actually DELIVERED — pushed, or a PR opened.
 *  The caller gates the arc's stored status on this: a green build that never
 *  left the machine is not done. */
async function finalize(
  o: RunOptions, integrationBranch: string, baseSha: string, complete: boolean,
): Promise<boolean> {
  const { config, log, store, plan } = o
  const head = G.git(config.repo, 'rev-parse', integrationBranch)
  if (head === baseSha) return true   // nothing landed; nothing to deliver

  if (!complete) {
    log('')
    log(`arc is INCOMPLETE — not ${config.landStrategy === 'pr' ? 'opening a PR' : 'pushing'}.`)
    log(`Work is on "${integrationBranch}" (${head.slice(0, 8)}). Inspect it, then re-run or resume.`)
    return false
  }

  const landed = store.allTasks(plan.arcId).filter((t) => t.state === 'landed')
  const title = `arc(${plan.arcId}): ${landed.length} task(s)`
  const body = buildPullRequestBody(o, integrationBranch, baseSha, head, landed)

  if (config.landStrategy === 'none') {
    log('')
    log(`✓ done, and left on "${integrationBranch}" (${head.slice(0, 8)}) as configured.`)
    log(`  Look at it:  git -C ${config.repo} log --oneline ${baseSha.slice(0, 8)}..${integrationBranch}`)
    log(`  Take it:     git -C ${config.repo} merge --ff-only ${integrationBranch}`)
    return true
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
    return r.ok
  }

  // landStrategy: push — the REMOTE's main branch is what "push" means, and it
  // is reachable without touching the operator's checkout at all. Landing
  // locally first meant checking out main (usually THE checked-out branch) and
  // hoping to restore afterwards, which is the whole parked-checkout failure
  // class that landBranch now refuses to create.
  log('')
  log(`pushing ${integrationBranch} → ${config.mainBranch}`)
  try {
    G.git(config.repo, 'push', 'origin', `${integrationBranch}:${config.mainBranch}`)
  } catch (e) {
    log(`  ✗ push rejected: ${(e as Error).message.slice(0, 200)}`)
    log(`  Nothing was merged locally either. If "${config.mainBranch}" is protected, set landStrategy: pr.`)
    store.appendEvent(plan.arcId, 'push', { ok: false, message: (e as Error).message.slice(0, 400) })
    return false
  }
  log(`  ✓ origin/${config.mainBranch} → ${head.slice(0, 8)}`)

  // Fast-forward the LOCAL main too, but only when it is checked out nowhere.
  // Moving a ref out from under a working tree desyncs its index against a head
  // it never produced.
  const local = G.landBranch(config.repo, config.mainBranch, integrationBranch)
  store.appendEvent(plan.arcId, 'push', local)
  if (local.ok) log(`  ✓ local ${config.mainBranch} ${local.before.slice(0, 8)} → ${local.after.slice(0, 8)}`)
  else log(`  · local "${config.mainBranch}" left alone — ${local.message}`)

  if (G.gitOk(config.repo, 'branch', '-D', integrationBranch)) {
    log(`  ✓ local "${integrationBranch}" removed — zero local residue`)
  }
  return true
}

// ---------------------------------------------------------------------------

/**
 * Measure the baseline AT THE BASE SHA, in a tree of its own.
 *
 * `baseSha` used to be passed as metadata only while the commands ran in the
 * operator's shared checkout, at whatever HEAD it happened to be on — and the
 * log said "on <baseSha>" while doing no such thing. An operator sitting on a
 * WIP branch with three broken tests donated them to the baseline of an arc
 * based on main, and every task was then measured against a tree the arc never
 * built from. The reverse is worse: a green WIP branch over a red main turns
 * pre-existing failures into task failures.
 *
 * The secondary damage was that a baseline gate ran in the operator's tree
 * WITHOUT setupCommand, so a formatter or a snapshot updater left it dirty —
 * and landBranch then runs `git checkout` in that same tree.
 *
 * review.ts already did exactly this. The pattern existed and was not used.
 */
/**
 * The PR body a human can actually review.
 *
 * The old one was a task-id list and a flat criterion dump, over a diff ordered
 * alphabetically — which correlates with nothing. Four changes, none of which
 * touch git semantics:
 *
 *   1. LEAD with what is unusual. `TaskResult.deviations` — what the writer did
 *      differently from the spec, and what it affects — is arguably the single
 *      highest-value field for a human reviewer, and it never reached the PR at
 *      all.
 *   2. Group by task, using the Arc-Task trailers, with each task's spec as its
 *      cover letter. Review effectiveness degrades sharply with size, and
 *      comprehension rather than defect-spotting is the reviewer's bottleneck.
 *   3. Name a review ORDER, risk first. File position materially affects defect
 *      detection, and Arc knows which files are risky when nothing else does.
 *   4. Put the evidence next to the criterion, so the human verifies rather
 *      than re-derives.
 */
function buildPullRequestBody(
  o: RunOptions, integrationBranch: string, baseSha: string, head: string,
  landed: Array<Record<string, unknown>>,
): string {
  const { store, plan } = o
  const arcId = plan.arcId
  const byTask = G.commitsByTask(o.config.repo, `${baseSha}..${head}`)
  const findings = store.findingsFor(arcId)
  const criteria = store.allCriteria(arcId)

  const deviations = findings.filter((f) => f.kind === 'deviation')
  const risky = findings.filter((f) => f.severity === 'high' || f.severity === 'critical')

  const lines: string[] = [
    `Produced by arc-executor. Every acceptance criterion below carries evidence,`,
    `and anything that could not be proved says so.`,
    ``,
    `## Goal`,
    plan.charter.goal.trim(),
  ]

  if (deviations.length > 0) {
    lines.push('', '## Read this first — what differs from the plan')
    for (const d of deviations) lines.push(`- **${d.task_id ?? 'arc'}**: ${d.text}`)
  }
  if (risky.length > 0) {
    lines.push('', '## Open findings at high severity')
    for (const f of risky) lines.push(`- \`${f.task_id ?? 'arc'}\` ${f.text}`)
  }

  lines.push('', '## Suggested review order')
  const affected = new Set(findings.flatMap((f) => JSON.parse(String(f.affects_json ?? '[]')) as string[]))
  if (affected.size > 0) {
    lines.push('Files a finding already touched — read these first:')
    for (const file of affected) lines.push(`1. \`${file}\``)
  } else {
    lines.push('No findings name a specific file; read the tasks in the order below.')
  }

  for (const task of landed) {
    const id = String(task.id)
    const spec = plan.tasks.find((t) => t.id === id)?.spec ?? ''
    const commits = byTask.get(id) ?? []
    lines.push('', `## \`${id}\` ${task.title}`)
    if (spec) lines.push('', spec.trim())
    if (commits.length > 0) {
      lines.push('', `Commits: ${commits.map((c) => c.slice(0, 8)).join(', ')}`)
    }
    for (const c of criteria.filter((row) => row.task_id === id)) {
      const mark = c.tier === 'observed' || c.tier === 'checked' ? '✓' : '·'
      lines.push(`- ${mark} **[${c.tier}]** ${c.text}`)
      if (c.proof_command) lines.push(`  - proof: \`${c.proof_command}\``)
      if (c.evidence) lines.push(`  - evidence: ${String(c.evidence).slice(0, 300)}`)
    }
  }

  lines.push('', `---`, `Branch \`${integrationBranch}\` · ${baseSha.slice(0, 8)}..${head.slice(0, 8)}`)
  return lines.join('\n')
}

async function measureBaselines(o: RunOptions, baseSha: string): Promise<Map<string, GateResult>> {
  const out = new Map<string, GateResult>()
  const needed = o.config.gates.filter((g) => g.baselineSubset)
  if (needed.length === 0) return out
  o.log(`measuring ${needed.length} gate baseline(s) on ${baseSha.slice(0, 8)} — in this run, not from memory`)

  const workspaceId = `${o.plan.arcId}-baseline`
  G.releaseTaskWorkspace(o.config.repo, o.store.root, workspaceId)
  let baseTree: G.Worktree
  try {
    baseTree = G.provisionWorktree(o.config.repo, o.store.root, workspaceId, baseSha)
  } catch (error) {
    // Fail closed rather than silently measuring the wrong tree. Without a
    // baseline, `baselineSubset` gates simply require green, which is stricter.
    o.log(`! baseline isolation failed (${(error as Error).message}) — baselineSubset gates will require GREEN, not subset`)
    o.store.addFinding({ arcId: o.plan.arcId, kind: 'risk', severity: 'medium',
      text: `baseline worktree could not be provisioned: ${(error as Error).message}` })
    return out
  }

  try {
    if (o.config.setupCommand) {
      const setup = await runGate({
        name: 'baseline-setup', command: o.config.setupCommand,
        proves: 'the detached base tree can run project checks',
        cwd: '.', timeoutMs: 600_000, heavy: false, baselineSubset: false,
      }, baseTree.path, baseSha, o.signal)
      if (!setup.pass) {
        // A bare tree fails for environmental reasons, not code reasons. Say so
        // rather than letting it look like the base was red.
        o.log(`  ! baseline setup failed (exit ${setup.exitCode}) — baseline comparisons are environment-unproven`)
        o.store.addFinding({ arcId: o.plan.arcId, kind: 'risk', severity: 'medium',
          text: `baseline setup failed in the detached base tree (${o.config.setupCommand}, exit ${setup.exitCode}) — subset comparisons are environment-unproven` })
      }
    }
    for (const g of needed) {
      const r = await runGate(g, baseTree.path, baseSha, o.signal, { sandboxPolicy: o.config.sandboxPolicy })
      out.set(g.name, r)
      o.store.recordGate({
        arcId: o.plan.arcId, name: g.name, command: g.command, proves: g.proves,
        exitCode: r.exitCode, baseSha, verdict: 'baseline', signature: r.signature,
        durationMs: r.durationMs,
      })
      o.log(`  baseline ${g.name}: exit ${r.exitCode}`)
    }
  } finally {
    G.releaseTaskWorkspace(o.config.repo, o.store.root, workspaceId)
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
    const previous = store.getTask(arcId, task.id)
    const baseSha = previous?.worktree && G.gitOk(String(previous.worktree), 'rev-parse', '--git-dir')
      ? String(previous.base_sha)
      : G.git(config.repo, 'rev-parse', integrationBranch)
    let wt: G.Worktree
    try {
      wt = G.provisionWorktree(config.repo, store.root, workspaceId(arcId, task.id), baseSha)
    } catch (e) {
      // Fails CLOSED. No fallback into the shared checkout, ever.
      log(`✗ ${task.id}: ${(e as Error).message}`)
      store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high', text: (e as Error).message })
      store.setTaskState(arcId, task.id, 'failed')
      return
    }
    store.setTaskWorkspace(arcId, task.id, wt.path, wt.branch, wt.baseSha)
    if (wt.recovered) {
      const commits = G.commitCount(wt.path, wt.baseSha)
      log(`▶ ${task.id} — ${task.title}  [${wt.branch} @ ${wt.baseSha.slice(0, 8)}, RECOVERED with ${commits} commit(s)]`)
      store.appendEvent(arcId, 'task.workspace.recovered', { commits, head: G.headSha(wt.path) }, task.id)
    } else {
      log(`▶ ${task.id} — ${task.title}  [${wt.branch} @ ${wt.baseSha.slice(0, 8)}]`)
    }

    // A bare worktree cannot run the project's own checks (the first
    // self-arc died with `vitest: command not found` in every worktree).
    // Setup runs in Arc's process — the sandboxed agent may have no network.
    if (config.setupCommand && !await setupWorktree(o, wt, task.id)) {
      store.setTaskState(arcId, task.id, 'failed')
      return
    }

    const outcome = await implementLoop(o, task, wt, baselines, heavy)
    if (outcome === 'failed') { store.setTaskState(arcId, task.id, 'failed'); return }
    // implementLoop already recorded the state and the reason; a quarantined
    // task is not a failure and must not be rewritten into one.
    if (outcome === 'quarantined') return

    // A no-op produced no diff, so there is nothing to review and nothing to
    // land — but its criteria still have to hold, and the worktree must
    // actually BE at base: a retrying writer that committed work on attempt 1
    // and then reported "no change needed — already committed" would get its
    // task marked landed while its commits sat abandoned in the worktree.
    // (The self-arc produced exactly this false-landed state.)
    if (outcome === 'noop') {
      if (!G.isClean(wt.path) || G.untrackedFiles(wt.path).length > 0) {
        log(`✗ ${task.id}: claimed no-op but left uncommitted changes — preserving the worktree`)
        store.setTaskState(arcId, task.id, 'failed')
        return
      }
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
      G.releaseTaskWorkspace(config.repo, store.root, workspaceId(arcId, task.id))
      return
    }

    store.setTaskState(arcId, task.id, 'reviewing', LEASE_MS)
    let review = await reviewLoop(o, task, wt)
    if (review.status === 'repair') {
      // CHANGES_REQUIRED used to be a death sentence — a real overnight run
      // died with a perfect review naming exactly what to fix and a writer
      // who never got to see it. The findings are on record; the writer gets
      // ONE repair round with them before the task is failed.
      const reviewFindings = store.findingsFor(arcId)
        .filter((f) => f.task_id === task.id && f.kind === 'review')
        .slice(-12)
        .map((f) => `- [${f.severity}] ${f.text}`)
      log(`  · ${task.id}: review requires changes — one repair round with ${reviewFindings.length} finding(s)`)
      store.setTaskState(arcId, task.id, 'running', LEASE_MS)
      const repairBaseSha = G.headSha(wt.path)
      const repaired = await implementLoop(o, task, wt, baselines, heavy,
        `The reviewer requires changes. Fix ALL of these findings in your existing branch:\n${reviewFindings.join('\n')}`,
        'repair')
      if (repaired === 'ok') {
        store.setTaskState(arcId, task.id, 'reviewing', LEASE_MS)
        review = await reviewLoop(o, task, wt, {
          previousVerdict: review.verdict ?? 'CHANGES_REQUIRED',
          findings: reviewFindings,
          ...(() => {
            const a = assembleDiff(wt.path, `${repairBaseSha}...HEAD`,
              { budget: REVIEW_DIFF_BUDGET, functionContext: true })
            return { diff: a.text, diffComplete: a.complete }
          })(),
        })
      } else {
        review = { status: 'fail', findings: [] }
      }
    }
    if (review.status !== 'pass') { store.setTaskState(arcId, task.id, 'failed'); return }

    const unmet = store.unmetCriteria(arcId, task.id)
    if (unmet.length > 0) {
      log(`✗ ${task.id}: ${unmet.length} criterion/criteria below required tier — not landing`)
      for (const c of unmet) log(`    ${c.id}: ${c.tier} < required ${c.required_tier}`)
      store.setTaskState(arcId, task.id, 'failed')
      return
    }

    // Footprint drift was recorded as a `medium` finding and the task landed
    // anyway — a declaration the scheduler trusted for its collision analysis,
    // then found to be false, and then ignored. Re-check the MEASURED footprint
    // against what is still in flight before landing, and serialise on a real
    // collision instead of merging into it.
    // An undeclared contract change that collides with a task still in flight is
    // the exact hazard: the scheduler let them run together on the strength of
    // declarations that turned out to be wrong. A merely-undeclared change is a
    // finding; a colliding one does not land.
    const contractCollision = undeclaredContractCollision(o, task)
    if (contractCollision.length > 0) {
      log(`  ✗ ${task.id}: changed ${contractCollision.join(', ')} — contracts an in-flight task declared. Not landing into a collision.`)
      store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high',
        text: `undeclared contract change collides with an in-flight task: ${contractCollision.join(', ')}`,
        affects: contractCollision })
      store.setTaskState(arcId, task.id, 'failed')
      return
    }

    const drifted = driftedIntoInflight(o, task)
    if (drifted.length > 0) {
      log(`  ✗ ${task.id}: touched ${drifted.join(', ')} — files an in-flight task declared. Not landing into a collision.`)
      store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'high',
        text: `undeclared footprint collides with an in-flight task: ${drifted.join(', ')}`,
        affects: drifted })
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
      G.releaseTaskWorkspace(config.repo, store.root, workspaceId(arcId, task.id))
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
type ImplementOutcome = 'ok' | 'noop' | 'failed' | 'quarantined'

function modelStatus(
  o: RunOptions,
  role: NonNullable<ProjectConfig['roles'][keyof ProjectConfig['roles']]>,
  result: DispatchResult,
  attemptId: string,
  taskId: string | null,
): 'ok' | 'drift' | 'unverified' {
  const status = checkModel(role.model, result.observedModels, result.modelVerified, modelCheckMode(role.cli), result.usage)
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

interface DispatchStepOptions {
  roleName: AgentRole
  role: RoleBinding
  taskId: string | null
  attemptNo: number
  baseSha?: string
  briefArtifactId?: string
  /** Which budget this attempt spends — 'implement' or 'repair'. */
  phase?: string
  dispatch: Omit<DispatchOptions, 'role'>
  waitForCapacity?: boolean
}

interface DispatchStepResult {
  result: DispatchResult
  attemptId: string
  model: 'ok' | 'drift' | 'unverified'
  capacityError?: string
}

function capacityBackoffMs(round: number): number {
  const override = Number(process.env.ARC_CAPACITY_BACKOFF_MS)
  const floor = Number.isFinite(override) && override > 0 ? override : 5 * 60_000
  return Math.min(floor * (2 ** round), 30 * 60_000)
}

async function sleepForCapacity(o: RunOptions, taskId: string | null, ms: number): Promise<void> {
  if (o.signal?.aborted) return
  if (taskId) {
    try { o.store.renewLease(o.plan.arcId, taskId, LEASE_MS) } catch { /* the task heartbeat is the second line */ }
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    o.signal?.addEventListener('abort', finish, { once: true })
  })
  if (taskId) {
    try { o.store.renewLease(o.plan.arcId, taskId, LEASE_MS) } catch { /* lease expiry remains recoverable */ }
  }
}

/** Capacity retries remain inside one logical step. Every substituted output
 *  is receipted as model-drift, then discarded before another attempt starts. */
async function dispatchStep(o: RunOptions, step: DispatchStepOptions): Promise<DispatchStepResult> {
  const { store, plan, config, log } = o
  if (step.roleName !== 'implement') step = { ...step, role: { ...step.role, sandbox: 'read-only' } }
  let capacityRound = 0
  for (;;) {
    const readOnlyCheckpoint = step.role.sandbox === 'read-only'
      && G.gitOk(step.dispatch.cwd, 'rev-parse', '--git-dir')
      ? JSON.stringify(captureDirectSnapshot(step.dispatch.cwd)) : null
    if (step.taskId && step.roleName === 'implement') {
      store.invalidateCriteria(plan.arcId, step.taskId, 'new implementation attempt')
    }
    const writableCheckpoint = step.role.sandbox !== 'read-only'
      ? { head: G.headSha(step.dispatch.cwd), untracked: new Set(G.untrackedFiles(step.dispatch.cwd)) }
      : null
    const attemptId = store.startAttempt({
      arcId: plan.arcId, taskId: step.taskId, attemptNo: step.attemptNo,
      role: step.roleName, cli: step.role.cli, requestedModel: step.role.model,
      baseSha: step.baseSha, briefArtifactId: step.briefArtifactId,
      effort: step.role.effort, phase: step.phase,
    })
    const result = await dispatch({
      role: step.role,
      ...step.dispatch,
      onSpawn: step.taskId ? (pgid) => {
        try { store.setTaskWorker(plan.arcId, step.taskId!, pgid) } catch { /* best effort */ }
      } : undefined,
    })
    if (readOnlyCheckpoint) {
      let unchanged = false
      try { unchanged = JSON.stringify(captureDirectSnapshot(step.dispatch.cwd)) === readOnlyCheckpoint } catch { /* removed tree */ }
      if (!unchanged) {
        const message = `read-only ${step.roleName} changed its checkout; its output was rejected`
        result.terminalReason = 'provider-error'
        result.errorText = message
        result.parsed = undefined
        store.appendEvent(plan.arcId, 'safety.read-only-violation', { role: step.roleName }, step.taskId, attemptId)
        store.addFinding({ arcId: plan.arcId, taskId: step.taskId ?? undefined, attemptId,
          kind: 'risk', severity: 'high', text: message })
        log(`✗ ${message}`)
      }
    }
    if (step.taskId) {
      try { store.setTaskWorker(plan.arcId, step.taskId, null) } catch { /* best effort */ }
    }
    const model = modelStatus(o, step.role, result, attemptId, step.taskId)
    store.finishAttempt(plan.arcId, attemptId, {
      terminalReason: model === 'drift' ? 'model-drift' : result.terminalReason,
      exitCode: result.exitCode,
      observedModel: result.observedModels.join(',') || null,
      transcriptArtifactId: store.putArtifact(plan.arcId, 'transcript', result.transcript, attemptId),
      usage: result.usage,
    })

    const weather = capacityFailure({
      terminalReason: model === 'drift' ? 'model-drift' : result.terminalReason,
      observedModels: result.observedModels,
      errorText: result.errorText,
    }, step.role.cli, step.role.model)
    if (!weather) return { result, attemptId, model }

    if (writableCheckpoint) {
      G.git(step.dispatch.cwd, 'reset', '--hard', writableCheckpoint.head)
      const created = G.untrackedFiles(step.dispatch.cwd).filter((path) => !writableCheckpoint.untracked.has(path))
      for (const path of created) G.git(step.dispatch.cwd, 'clean', '-fd', '--', path)
      store.appendEvent(plan.arcId, 'capacity.discard', {
        role: step.roleName, restoredHead: writableCheckpoint.head, removedUntracked: created,
      }, step.taskId, attemptId)
    }

    if (step.waitForCapacity === false) {
      const detail = weather.observed ? `observed ${weather.observed}` : weather.errorClass
      const capacityError = `${step.role.cli} capacity unavailable for ${step.role.model} (${detail}); re-run with --until-done to wait for the requested model`
      store.appendEvent(plan.arcId, 'capacity.warning', {
        role: step.roleName, provider: step.role.cli, requested: step.role.model,
        ...(weather.observed ? { observed: weather.observed } : { errorClass: weather.errorClass }),
      }, step.taskId, attemptId)
      return { result, attemptId, model, capacityError }
    }

    const state = o.capacityState!
    const budgetMs = config.capacityWaitMinutes * 60_000
    const remainingMs = Math.max(0, budgetMs - state.waitedMs)
    if (remainingMs === 0) {
      const minutes = Math.round(state.waitedMs / 60_000 * 10) / 10
      const detail = weather.observed ? `observed ${weather.observed}` : weather.errorClass
      const capacityError = `${step.role.cli} capacity unavailable for ${step.role.model} (${detail}); capacity wait budget exhausted after ${minutes} minute(s)`
      store.appendEvent(plan.arcId, 'capacity.exhausted', {
        role: step.roleName, provider: step.role.cli, requested: step.role.model,
        ...(weather.observed ? { observed: weather.observed } : { errorClass: weather.errorClass }),
        attempt: step.attemptNo, waitedMs: state.waitedMs,
      }, step.taskId, attemptId)
      log(`  ✗ ${capacityError}`)
      return { result, attemptId, model, capacityError }
    }
    const delayMs = Math.min(capacityBackoffMs(capacityRound), remainingMs)

    store.appendEvent(plan.arcId, 'capacity.wait', {
      role: step.roleName, provider: step.role.cli, requested: step.role.model,
      ...(weather.observed ? { observed: weather.observed } : { errorClass: weather.errorClass }),
      attempt: step.attemptNo, waitMs: delayMs, waitedMs: state.waitedMs,
    }, step.taskId, attemptId)
    const detail = weather.observed ? `served ${weather.observed}` : weather.errorClass
    log(`  ! ${step.role.cli}/${step.role.model} capacity weather (${detail}) — waiting ${Math.round(delayMs / 1000)}s and retrying ${step.roleName}`)
    // Reserve before yielding, so concurrent waiters cannot each spend the
    // same remaining budget. Resume sums these same durable reservations.
    state.waitedMs += delayMs
    await sleepForCapacity(o, step.taskId, delayMs)
    capacityRound++
  }
}

async function implementLoop(
  o: RunOptions, task: PlanTask, wt: G.Worktree, baselines: Map<string, GateResult>, heavy: Semaphore,
  initialFeedback = '',
  phase: 'implement' | 'repair' = 'implement',
): Promise<ImplementOutcome> {
  const { store, plan, config, log } = o
  const arcId = plan.arcId
  const configured = config.roles.implement
  if (!configured) throw new Error('project.yaml defines no "implement" role')
  // Elevation only ever RAISES, and only for a task that declared the need and
  // whose capability the operator permitted.
  const elevated = o.elevations?.get(task.id)
  const role = elevated && elevated !== configured.sandbox
    ? { ...configured, sandbox: elevated }
    : configured

  // Every budget is derived from ROWS, so a resume continues one task rather
  // than starting a fresh one wearing the same name. capacityWaitMinutes was
  // already durable; nothing else was.
  const spent = store.spentBudget(arcId, task.id, 'implement', phase)
  const maxAttempts = phase === 'repair' ? config.maxRepairAttempts : config.maxAttempts
  const budgetMinutes = phase === 'repair' ? config.maxRepairMinutes : config.maxTaskMinutes
  const deadline = (spent.startedAt ?? Date.now()) + budgetMinutes * 60_000
  const priorSignatures: string[] = [...spent.signatures]
  const alreadySpent = spent.attempts
  if (alreadySpent > 0) {
    log(`  · ${task.id}: ${alreadySpent} ${phase} attempt(s) already spent, ` +
      `${Math.max(0, Math.round((deadline - Date.now()) / 60_000))}min of wall clock left`)
  }
  let feedback = initialFeedback

  for (let attempt = alreadySpent + 1; attempt <= maxAttempts; attempt++) {
    // Wall clock is checked BETWEEN attempts so nothing is abandoned half-done.
    if (Date.now() > deadline) {
      log(`✗ ${task.id}: ${phase} budget (${budgetMinutes}min) exhausted across ${attempt - 1} attempt(s) — this budget survives resume`)
      return 'failed'
    }

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
    log(`  · ${task.id} ${phase} attempt ${attempt}/${maxAttempts} (${role.cli}/${role.model}, brief ${brief.bytes}B)`)

    const dispatched = await dispatchStep(o, {
      roleName: 'implement', role, taskId: task.id, attemptNo: attempt, phase,
      baseSha: wt.baseSha, briefArtifactId: briefId,
      dispatch: {
        cwd: wt.path, prompt: brief.text, schema: TaskResult,
        onEvent: () => { try { store.renewLease(arcId, task.id, LEASE_MS) } catch { /* lease expiry is the recovery path */ } },
        signal: o.signal,
        // Commits from a worktree write into the main repo's .git; without this
        // the sandboxed writer dies on index.lock the moment the repo lives
        // outside the sandbox-writable temp areas.
        writableRoots: [resolve(wt.path, G.git(wt.path, 'rev-parse', '--git-common-dir'))],
      },
    })
    const { result: res, attemptId, model: drift } = dispatched

    // Steering counts as APPLIED only once an attempt ran to completion on a
    // brief that contained it. Marking it before dispatch silently dropped it
    // whenever the attempt was cancelled, stalled, or the process died first —
    // a pending intervention is re-included in every retry brief instead.
    if (res.terminalReason === 'ok' && drift !== 'drift' && !dispatched.capacityError) {
      for (const interventionId of brief.interventionIds) store.applyIntervention(interventionId)
    }

    if (dispatched.capacityError) {
      store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
        text: dispatched.capacityError })
      return 'failed'
    }

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
      // isRetryable already encodes which endings a retry can actually fix, and
      // this loop ignored it — so a permission-blocked or provider-error attempt
      // burned every remaining attempt on feedback that could not possibly help.
      // The classifier existed, with a doc comment describing exactly this waste.
      if (!isRetryable(res.terminalReason)) {
        log(`      "${res.terminalReason}" is not something a retry can fix — stopping instead of burning ${maxAttempts - attempt} more attempt(s)`)
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
          text: `implement ended "${res.terminalReason}", which no retry can fix` })
        return 'failed'
      }
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

    const refreshResults = await runRefreshCommands(o, task, wt, attemptId)
    const refreshFailed = refreshResults.filter((entry) => !entry.ok)
    let failed = refreshFailed
    if (refreshFailed.length === 0) {
      const measured = G.measuredFootprint(wt.path, wt.baseSha)
      store.setTaskHead(arcId, task.id, G.headSha(wt.path), measured)

      if (task.footprint.length > 0) {
        const undeclared = measured.filter((f) => !task.footprint.some((d) => pathsOverlap(f, d)))
        if (undeclared.length > 0) {
          store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'medium',
            text: `touched ${undeclared.length} file(s) outside declared footprint: ${undeclared.slice(0, 5).join(', ')}`,
            affects: undeclared })
          log(`  ! footprint drift: ${undeclared.length} undeclared file(s)`)
        }
      }

      // Contracts, measured against the real declarations rather than trusted.
      const contracts = undeclaredContracts(o, task, wt, measured)
      if (contracts.unmeasured) {
        log(`  ! ${task.id}: contracts UNMEASURED — ${contracts.unmeasured}`)
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'low',
          text: `exported contracts could not be measured: ${contracts.unmeasured}` })
      }
      if (contracts.undeclared.length > 0) {
        log(`  ! ${task.id}: changed ${contracts.undeclared.length} exported signature(s) it never declared: ${contracts.undeclared.slice(0, 5).join(', ')}`)
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
          text: `changed exported contracts without declaring them: ${contracts.undeclared.slice(0, 8).join(', ')}`
            + ' — the scheduler used contractsMutated to decide this task could run alongside others',
          affects: contracts.undeclared })
      }

      const protectedTouched = protectedSurfaceTouched(o, measured, wt)
      if (protectedTouched.length > 0 && !task.touchesGateSurface) {
        // Blocking, not a note. Everything else Arc proves rests on the gate
        // surface staying put, so a task that moves it without saying so has
        // changed what "green" means underneath its own evidence.
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
          text: `changed the gate surface without declaring it: ${protectedTouched.slice(0, 5).join(', ')}`
            + ' — set touchesGateSurface on the task with a reason if this is intended',
          affects: protectedTouched })
        log(`  ✗ ${task.id}: changed ${protectedTouched.length} protected gate-surface path(s) undeclared`)
        for (const path of protectedTouched.slice(0, 5)) log(`      ${path}`)
        // The WORK is fine here — this is a declaration problem, and the branch
        // still holds every commit. Say how to keep it instead of leaving the
        // operator to work out that it was salvageable.
        log(`      The work is not lost: it is committed on "${wt.branch}".`)
        log(`      Add to this task in the plan, then \`arc resume\`:`)
        log(`        touchesGateSurface: "why this task legitimately changes the gate surface"`)
        return 'failed'
      }
      if (protectedTouched.length > 0) {
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'deviation', severity: 'medium',
          text: `changed the gate surface, as declared: ${task.touchesGateSurface}`,
          affects: protectedTouched })
        log(`  · ${task.id}: gate surface changed by declaration — ${task.touchesGateSurface}`)
      }

        const gateResults = await runTaskGates(o, task, wt, baselines, attemptId, heavy)
      failed = gateResults.filter((g) => !g.ok)

      // The backstop. Declarations can be wrong, and Docker can die mid-run.
      // When a gate fails AND the capability it needs is gone at this moment,
      // that is a capability loss, not a code failure: do not burn a retry on
      // it and do not raise a finding blaming the writer.
      const lost = capabilityLost(o, failed.map((f) => f.result.name))
      if (lost) {
        log(`  ✗ ${task.id} QUARANTINED mid-run — ${lost}`)
        store.addFinding({ arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
          text: `quarantined: ${lost}` })
        store.setTaskState(arcId, task.id, 'quarantined')
        return 'quarantined'
      }
    }

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
      ...failed.map((f) => `\n## ${f.result.name} (proves: ${f.result.proves})\n\`\`\`\n${failureExcerpt(f.result.output)}\n\`\`\``),
    ].join('\n')
    log(`  ✗ attempt ${attempt}: ${failed.map((f) => f.result.name).join(', ')} failed`)
  }

  log(`  ✗ ${task.id}: exhausted ${config.maxAttempts} attempts`)
  return 'failed'
}

async function runRefreshCommands(
  o: RunOptions, task: PlanTask, wt: G.Worktree, attemptId: string,
): Promise<Array<{ ok: boolean; result: GateResult }>> {
  const out: Array<{ ok: boolean; result: GateResult }> = []
  for (const refresh of o.config.refreshCommands ?? []) {
    const name = `refresh:${refresh.name}`
    const result = await runGate({
      name, command: refresh.command,
      proves: `operator-owned refresh "${refresh.name}" completed`,
      cwd: '.', timeoutMs: refresh.timeoutMs ?? 20 * 60_000,
      heavy: false, baselineSubset: false,
    }, wt.path, wt.baseSha, o.signal)
    const artifactId = o.store.putArtifact(o.plan.arcId, 'gate-output', result.output, attemptId)
    o.store.recordGate({
      arcId: o.plan.arcId, taskId: task.id, attemptId,
      name, command: refresh.command, proves: result.proves,
      exitCode: result.exitCode, baseSha: wt.baseSha,
      verdict: result.pass ? 'pass' : 'fail', signature: result.signature, artifactId,
      durationMs: result.durationMs,
    })
    if (!result.pass) {
      const tail = result.output.slice(-800)
      o.log(`    ${name}: FAIL (exit ${result.exitCode ?? 'timeout'})${tail ? ` — ${tail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
      out.push({ ok: false, result })
      break
    }

    const changed = G.worktreeChanges(wt.path)
    if (changed.length > 0) G.commitPaths(wt.path, changed, `refresh: ${refresh.name}`)
    o.log(`    ${name}: pass${changed.length > 0 ? ` — committed ${changed.length} file(s)` : ''}`)
    out.push({ ok: true, result })
  }
  return out
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
    durationMs: setup.durationMs,
  })
  if (!setup.pass) {
    log(`  ✗ ${taskId ?? wt.branch}: worktree setup failed — ${setup.output.slice(-300)}`)
    store.addFinding({ arcId: o.plan.arcId, taskId, kind: 'risk', severity: 'high',
      text: `worktree setup failed: ${config.setupCommand} (exit ${setup.exitCode})` })
  }
  return setup.pass
}

/**
 * Which of the measured footprint is gate surface the task did not declare.
 *
 * `package.json` is deliberately NOT a protected path: every dependency change
 * touches it, so blocking on the path would produce enough false positives that
 * an operator disables the whole check. Its `scripts` block IS gate surface, so
 * that is compared by content instead — rewriting `scripts.test` to `echo ok`
 * is the canonical version of this attack and path matching cannot see it.
 */
function protectedSurfaceTouched(o: RunOptions, measured: string[], wt: G.Worktree): string[] {
  const { protectedGatePaths, protectedTestPaths } = o.config
  // Runner and CI config: any change at all. Nobody edits vitest.config or a
  // workflow file as part of shipping a feature.
  const hits = measured.filter((path) =>
    protectedGatePaths.some((pattern) => matchesGlob(path, pattern)))

  // Tests: only REMOVAL. Adding tests is what a task is supposed to do, and in
  // a test-first repo it is what EVERY task does — treating that as tampering
  // made the control something the operator had to waive every time, which is
  // the same as not having it.
  const changed = changedFiles(wt.path, `${wt.baseSha}...HEAD`)
  for (const file of changed) {
    if (!protectedTestPaths.some((pattern) => matchesGlob(file.path, pattern))) continue
    // Covers both real attacks: deleting a test, and hollowing out its
    // assertion — which testsExecuted cannot see, because the count is
    // unchanged when `expect(x).toBe(1)` becomes `expect(true).toBe(true)`.
    if (file.deleted > 0) hits.push(`${file.path} (${file.deleted} line(s) removed)`)
  }

  if (measured.includes('package.json') && gateScriptsChanged(wt)) hits.push('package.json (scripts)')
  return hits
}

function gateScriptsChanged(wt: G.Worktree): boolean {
  const read = (ref: string): string => {
    try {
      const raw = G.git(wt.path, 'show', `${ref}:package.json`)
      return JSON.stringify((JSON.parse(raw) as { scripts?: unknown }).scripts ?? null)
    } catch {
      // Unreadable at either end (added, deleted, unparseable) is a CHANGE we
      // cannot rule out. Fail closed: this is the surface that defines green.
      return `unreadable:${ref}`
    }
  }
  return read(wt.baseSha) !== read('HEAD')
}

/**
 * What the writer is TOLD about why it failed.
 *
 * Two defects lived in the one expression this replaces.
 *
 * It sent `signature`, which is the output of `normalizeFailureSignature` — a
 * function written to decide whether two failures are the SAME failure, and
 * which destroys detail on purpose to do that job. Its `<SHA>` rule rewrites any
 * 7-40 hex characters, so fixture ids, colour values and hashes under assertion
 * all collapse: a failing assertion arrives as `expected <SHA> to equal <SHA>`,
 * and the writer is asked to fix a bug whose evidence has been redacted.
 *
 * And it took `.slice(0, 3000)` — the HEAD. Every common runner prints its
 * banner, its config and per-file progress first and the failure summary last,
 * so the window was disproportionately preamble. Tail-weighted here, with the
 * head kept because the first error is often the causal one.
 *
 * `signature` still serves signaturesMatch/signatureSimilarity, where it is
 * correct. The raw output was already on disk the whole time.
 */
function failureExcerpt(output: string, head = 500, tail = 3_500): string {
  const text = output.trim()
  if (text.length <= head + tail) return text
  const elided = text.length - head - tail
  return `${text.slice(0, head)}\n\n[... ${elided} characters elided ...]\n\n${text.slice(-tail)}`
}

/**
 * Worktree and branch names are scoped to the ARC, not just the task.
 *
 * Two concurrent arcs on one repo whose plans both contain a task called
 * `task-1` collided on both the path and the branch. Unreachable today — Arc
 * runs one mission at a time — but it is the FIRST bug concurrent missions
 * would hit, long before any UI work becomes the bottleneck, and it costs a
 * line now against a migration later.
 */
/**
 * Kill a process group if it still exists. Returns whether it did.
 *
 * `killTree` only ever ran from arc's own signal handlers, and a SIGKILL
 * executes none of them, so the orphan outlives the process that spawned it.
 */
function killGroupIfAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
  } catch {
    return false
  }
  try { process.kill(-pgid, 'SIGKILL') } catch { /* it exited between the probe and the kill */ }
  return true
}

/**
 * Files this task actually touched that another IN-FLIGHT task declared.
 *
 * The scheduler let these two run together on the strength of declarations that
 * turned out to be wrong. Measuring afterwards is the only correction available,
 * and it is worth nothing if the answer is a note.
 */
function driftedIntoInflight(o: RunOptions, task: PlanTask): string[] {
  const measured = JSON.parse(
    String(o.store.allTasks(o.plan.arcId).find((t) => t.id === task.id)?.footprint_measured ?? '[]'),
  ) as string[]
  const undeclared = measured.filter((f) => !task.footprint.some((d) => pathsOverlap(f, d)))
  if (undeclared.length === 0) return []
  const inflight = o.store.allTasks(o.plan.arcId)
    .filter((t) => t.id !== task.id && ['running', 'reviewing', 'landing'].includes(String(t.state)))
    .map((t) => String(t.id))
  const claimed = new Set(
    o.plan.tasks.filter((t) => inflight.includes(t.id)).flatMap((t) => t.footprint),
  )
  return undeclared.filter((f) => [...claimed].some((c) => pathsOverlap(f, c)))
}

function workspaceId(arcId: string, taskId: string): string {
  return `${arcId}--${taskId}`
}

/**
 * Which capabilities a task needs: the union over the gates it will actually
 * run, plus its own explicit `needs`.
 *
 * Gates are the primary source because that is where the knowledge already is —
 * you wrote `npm run db:test`, so you know it needs Docker. A planner does not,
 * reliably, and a planner that forgets puts you back at discovering the gap on
 * attempt two.
 */
function requiredCapabilities(config: ProjectConfig, task: PlanTask): Set<string> {
  const out = new Set<string>()
  for (const gate of selectGates(config.gates, task.gates)) {
    for (const name of gate.requires ?? []) out.add(name)
  }
  for (const need of task.needs ?? []) out.add(need.capability)
  return out
}

export interface CapabilityPlan {
  /** Probe result per declared capability. */
  probes: Map<string, CapabilityProbe>
  /** Tasks that cannot run, and why — in operator-readable form. */
  refusals: Map<string, string>
  /** Tasks that will run above the role's configured sandbox. */
  elevations: Map<string, { level: SandboxLevel; because: string }>
}

/**
 * Probe once, then decide for every task. Runs BEFORE any dispatch, costs at
 * most four subprocesses per capability, and spends no tokens.
 */
function planCapabilities(o: RunOptions, roleLevel: SandboxLevel, osSandboxed: boolean): CapabilityPlan {
  const { config, log } = o
  const declared = Object.entries(config.capabilities ?? {})
  const plan: CapabilityPlan = { probes: new Map(), refusals: new Map(), elevations: new Map() }
  const wanted = new Set(o.plan.tasks.flatMap((t) => [...requiredCapabilities(config, t)]))
  if (wanted.size === 0) return plan

  for (const [name, spec] of declared) {
    if (!wanted.has(name)) continue
    // The claude lane has no OS sandbox to probe or widen, so the only question
    // that still means anything is whether it is reachable on this machine.
    const probe = osSandboxed
      ? probeCapability(name, spec.probe, config.repo)
      : probeUnsandboxedOnly(name, spec.probe, config.repo)
    plan.probes.set(name, probe)
    log(`  ${describeReachability(probe)}`)
  }

  for (const task of o.plan.tasks) {
    if (o.store.getTask(o.plan.arcId, task.id)?.state !== 'pending') continue
    for (const name of requiredCapabilities(config, task)) {
      const probe = plan.probes.get(name)
      const spec = config.capabilities?.[name]
      if (!probe || !spec) continue // validatePlan already refused an undefined one
      const reason = (text: string) => { if (!plan.refusals.has(task.id)) plan.refusals.set(task.id, text) }

      if (probe.reachability.at === 'unknown') {
        // We could not exercise the sandbox at all, so we know nothing about
        // what the writer can reach. Quarantining on that would be a verdict
        // derived from silence. Run, and say plainly that the check did not
        // happen — this is exactly the pre-existing behaviour, plus a caveat.
        log(`  ! ${task.id}: \`${name}\` could not be probed — running anyway, unverified`)
        o.store.addFinding({ arcId: o.plan.arcId, taskId: task.id, kind: 'risk', severity: 'medium',
          text: `capability "${name}" was never probed (\`codex sandbox\` unavailable) — this task may be writing blind` })
        continue
      }
      if (probe.reachability.at === 'nowhere') {
        reason(`\`${name}\` is not reachable at all — \`${spec.probe}\` fails even unsandboxed. Is it running?`)
        continue
      }
      if (!osSandboxed) continue // nothing to elevate; reachable is reachable
      if (probe.reachability.at === 'unsandboxed') {
        reason(`\`${name}\` is reachable only outside a sandbox, so no writer sandbox can reach it.`
          + ' Run this task yourself, or make the capability reachable from a sandbox.')
        continue
      }
      const needed = probe.reachability.at
      if (atLeast(roleLevel, needed)) continue // already reachable; silent

      if (!spec.elevate) {
        reason(`\`${name}\` needs sandbox "${needed}" but the writer runs at "${roleLevel}",`
          + ` and the project config does not permit elevating for it.\n`
          + `      Add to arc.yaml, then \`arc resume\`:\n`
          + `        capabilities:\n          ${name}:\n            probe: ${spec.probe}\n            elevate: true`)
        continue
      }
      const current = plan.elevations.get(task.id)
      const level = current ? looser(current.level, needed) : needed
      plan.elevations.set(task.id, { level, because: name })
    }
  }
  return plan
}

/**
 * A gate failed. Is the reason that its capability is no longer reachable?
 *
 * Re-probes only the capabilities the FAILING gates declared, so the common
 * case (a genuine code failure on a gate that needs nothing) costs nothing.
 */
function capabilityLost(o: RunOptions, failedGateNames: string[]): string | null {
  const { config } = o
  const suspects = new Set(
    config.gates
      .filter((g) => failedGateNames.includes(g.name))
      .flatMap((g) => g.requires ?? []),
  )
  for (const name of suspects) {
    const spec = config.capabilities?.[name]
    if (!spec) continue
    const probe = probeUnsandboxedOnly(name, spec.probe, config.repo)
    if (probe.reachability.at === 'nowhere') {
      return `\`${name}\` stopped being reachable (\`${spec.probe}\` now fails) — the gate failure is environmental, not the writer's`
    }
  }
  return null
}

/**
 * Contracts, MEASURED — the half the mechanism never had.
 *
 * `computeFrontier` refuses to run two tasks that declare the same
 * `contractsMutated`, which is the answer to the failure per-branch CI is green
 * against by construction: two branches can each be green and still land
 * contradictory versions of one exported signature. Footprints were declared and
 * then measured against the real diff; contracts were declared and measured by
 * nothing at all, so two tasks that both simply forgot were invisible.
 *
 * The base scan is cached for the whole arc: every task branches from the same
 * base sha, so scanning it once and reusing it turns an expensive check into a
 * cheap one. An unsupported scan (no tsconfig, tsc unreachable) yields null and
 * is reported as unmeasured — never as "no drift".
 */
function baseContracts(o: RunOptions, baseSha: string): ContractScan {
  o.baseContractScans ??= new Map()
  if (!o.baseContractScans.has(baseSha)) {
    const workspace = `${o.plan.arcId}-contracts`
    G.releaseTaskWorkspace(o.config.repo, o.store.root, workspace)
    try {
      const tree = G.provisionWorktree(o.config.repo, o.store.root, workspace, baseSha)
      try { o.baseContractScans.set(baseSha, scanContracts(tree.path)) }
      finally { G.releaseTaskWorkspace(o.config.repo, o.store.root, workspace) }
    } catch (error) {
      o.baseContractScans.set(baseSha, { supported: false, why: `base tree unavailable: ${(error as Error).message}` })
    }
  }
  return o.baseContractScans.get(baseSha)!
}

/** Exported symbols this task changed that it never declared. */
function undeclaredContracts(o: RunOptions, task: PlanTask, wt: G.Worktree, measured: string[]): {
  undeclared: string[]
  unmeasured?: string
} {
  // Emitting declarations twice is not cheap, so only pay for it when the task
  // actually touched TypeScript.
  if (!measured.some((file) => /\.tsx?$/.test(file))) return { undeclared: [] }

  const before = baseContracts(o, wt.baseSha)
  const after = scanContracts(wt.path)
  const drift = contractDrift(before, after)
  if (!drift) {
    const why = before.supported === false ? before.why : (after as { why: string }).why
    return { undeclared: [], unmeasured: why }
  }
  const declared = new Set(task.contractsMutated)
  // `added` is not drift a sibling can collide with — a new export contradicts
  // nothing that already existed. Changed and removed are the hazard.
  return {
    undeclared: [...drift.changed, ...drift.removed].filter((name) => !declared.has(name)),
  }
}

/**
 * Undeclared contract changes that a task still in flight DID declare.
 *
 * Findings are recorded for every undeclared change; only this subset blocks,
 * because only this subset is the failure the serialisation rule exists to stop.
 * Read from the finding already written at gate time so the expensive scan runs
 * once per task, not again at land.
 */
function undeclaredContractCollision(o: RunOptions, task: PlanTask): string[] {
  const finding = o.store.findingsFor(o.plan.arcId).find((f) =>
    f.task_id === task.id && String(f.text).startsWith('changed exported contracts without declaring them'))
  if (!finding) return []
  const undeclared = JSON.parse(String(finding.affects_json ?? '[]')) as string[]
  if (undeclared.length === 0) return []

  const inflight = o.store.allTasks(o.plan.arcId)
    .filter((t) => t.id !== task.id && ['running', 'reviewing', 'landing'].includes(String(t.state)))
    .map((t) => String(t.id))
  const claimed = new Set(
    o.plan.tasks.filter((t) => inflight.includes(t.id)).flatMap((t) => t.contractsMutated),
  )
  return undeclared.filter((name) => claimed.has(name))
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
      ? await heavy.run(() => runGate(g, wt.path, wt.baseSha, o.signal, { sandboxPolicy: o.config.sandboxPolicy }))
      : await runGate(g, wt.path, wt.baseSha, o.signal, { sandboxPolicy: o.config.sandboxPolicy })
    const base = baselines.get(g.name)
    let ok = g.baselineSubset && base ? isSubsetOfBaseline(r, base) : r.pass
    // A suite that got greener by losing tests is not greener. `result.pass`
    // short-circuits every baseline comparison, so this is the only place the
    // deletion is visible at all — a removed test produces no failure line.
    const vanished = base ? testsVanished(r, base) : 0
    if (vanished > 0) {
      ok = false
      o.store.addFinding({
        arcId: o.plan.arcId, taskId: task.id, attemptId, kind: 'risk', severity: 'high',
        text: `gate "${g.name}" executed ${vanished} fewer test(s) than the baseline — a proof was removed, not satisfied`,
      })
      o.log(`    ! ${g.name}: ${vanished} fewer test(s) than baseline — NOT green`)
    }
    o.store.recordGate({
      arcId: o.plan.arcId, taskId: task.id, attemptId, name: g.name, command: g.command,
      proves: g.proves, exitCode: r.exitCode, baseSha: wt.baseSha,
      verdict: ok ? 'pass' : 'fail', signature: r.signature,
      artifactId: o.store.putArtifact(o.plan.arcId, 'gate-output', r.output, attemptId),
      durationMs: r.durationMs,
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
): Promise<{ keep: boolean; outcome: FindingOutcome; caveat?: string; artifactId?: string; exitCode?: number | null }> {
  const name = `${taskId ? `review:${taskId}` : 'integration-review'}:${finding.file}:${finding.line}`
  const check = await checkReviewFinding(finding, cwd, baseSha, {
    name, sandboxPolicy: o.config.sandboxPolicy, signal: o.signal,
  })
  const caveat = check.caveats.length > 0 ? check.caveats.join('; ') : undefined
  if (!check.result) {
    if (caveat) o.log(`    ! ${name}: ${caveat}`)
    return { keep: check.keep, outcome: check.outcome, caveat }
  }
  const artifactId = o.store.putArtifact(o.plan.arcId, 'review-check', check.result.output, attemptId)
  o.store.recordGate({
    arcId: o.plan.arcId,
    taskId,
    attemptId,
    name,
    command: finding.checkCommand!,
    proves: finding.claim,
    exitCode: check.result.exitCode,
    baseSha,
    verdict: check.result.pass ? 'pass' : 'fail',
    signature: check.result.signature,
    artifactId,
    durationMs: check.result.durationMs,
  })
  for (const c of check.caveats) o.log(`    ! ${name}: ${c}`)
  o.log(`    ${name}: ${check.outcome} (exit ${check.result.exitCode ?? 'timeout'})`)
  return { keep: check.keep, outcome: check.outcome, caveat, artifactId, exitCode: check.result.exitCode }
}

/**
 * Review, with the anti-anchoring step: Opus writes a risk checklist from the
 * SPEC and BASE TREE first, before it is allowed to see the implementation.
 * Otherwise review degenerates into rationalising whatever was written.
 */
interface ReviewOutcome {
  status: 'pass' | 'repair' | 'fail'
  verdict?: z.infer<typeof ReviewVerdict>['verdict']
  findings: string[]
}

interface RepairReviewContext {
  previousVerdict: string
  findings: string[]
  diff: string
  /** False when the repair diff itself was over budget. Carried through so the
   *  criterion cap survives a repair round. */
  diffComplete?: boolean
}

/** 'repair': the review found CONTENT problems the writer can fix; 'fail': infrastructure or a rejection. */
async function reviewLoop(
  o: RunOptions, task: PlanTask, wt: G.Worktree, repair?: RepairReviewContext,
): Promise<ReviewOutcome> {
  const { store, plan, config, log } = o
  const arcId = plan.arcId
  const role = config.roles.review
  if (!role) { log('  (no review role configured — skipping)'); return { status: 'pass', findings: [] } }

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
    `For each risk, name the files it would live in. They get shown to you first.`,
    ``,
    ...charterContext(o),
    ``,
    `## Task spec`, task.spec,
    ``, `## Acceptance criteria`,
    ...task.acceptance.map((c) => `- ${c.id}: ${c.text}`),
    ``, `Base commit: ${wt.baseSha}. Read the tree at that commit with your tools.`,
  ].join('\n')

  let checklist: z.infer<typeof RiskChecklist>['risks'] = []
  if (!repair && !config.reviewRiskPhase) {
    log(`  · ${task.id} review: risk phase OFF (reviewRiskPhase: false) — the reviewer sees the diff cold`)
    store.appendEvent(arcId, 'review.risk-phase-skipped', {}, task.id)
  }
  if (!repair && config.reviewRiskPhase) {
    const dispatched = await dispatchStep(o, {
      roleName: 'review', role, taskId: task.id, attemptNo: 0,
      dispatch: { cwd: wt.path, prompt: checklistBrief, schema: RiskChecklist, signal: o.signal },
    })
    const { result: cl, attemptId: clAttempt, model: clModel } = dispatched
    if (dispatched.capacityError) {
      store.addFinding({ arcId, taskId: task.id, attemptId: clAttempt, kind: 'risk', severity: 'high', text: dispatched.capacityError })
      return { status: 'fail', findings: [] }
    }
    if (clModel === 'drift') {
      log(`  ✗ MODEL DRIFT in risk prediction: asked for ${role.model}, ran on ${cl.observedModels.join(', ')}`)
      store.addFinding({ arcId, taskId: task.id, attemptId: clAttempt, kind: 'risk', severity: 'high',
        text: `review model drift: requested ${role.model}, observed ${cl.observedModels.join(', ')}` })
      return { status: 'fail', findings: [] }
    }
    if (cl.terminalReason !== 'ok' || !cl.parsed) {
      log(`  ✗ ${task.id}: risk prediction ended "${cl.terminalReason}" — treating as not-reviewed`)
      return { status: 'fail', findings: [] }
    }
    checklist = (cl.parsed as z.infer<typeof RiskChecklist> | undefined)?.risks ?? []
    log(`  · ${task.id} review: ${checklist.length} risk(s) predicted before seeing the diff`)
  }

  // Spend the budget on the SURPRISING files first. Arc knows which those are
  // and no generic review tool does: the risks phase 1 just named, the contracts
  // this task mutates, its declared footprint — and, ahead of all of them, the
  // files it touched that the plan never predicted.
  const measured = String(store.allTasks(arcId).find((t) => t.id === task.id)?.footprint_measured ?? '[]')
  const drifted = (JSON.parse(measured) as string[])
    .filter((f) => !task.footprint.some((d) => pathsOverlap(f, d)))
  const priority = [
    ...drifted,
    ...checklist.flatMap((r) => r.files ?? []),
    ...task.footprint,
  ]
  const assembled = repair
    ? { text: repair.diff, complete: repair.diffComplete !== false, shown: [], summarised: [], excluded: [] }
    : assembleDiff(wt.path, `${wt.baseSha}...HEAD`, { budget: REVIEW_DIFF_BUDGET, priority, functionContext: true })
  const diff = assembled.text
  if (!assembled.complete) {
    // Recorded, not just printed. A partial review must be visible in the
    // ledger, and it caps what the verdict may promote.
    log(`  ! ${task.id} review sees a PARTIAL diff: ${assembled.shown.length} file(s) in full,`
      + ` ${assembled.summarised.length} named only, ${assembled.excluded.length} excluded as generated`)
    store.appendEvent(arcId, 'review.truncated', {
      shown: assembled.shown.length, summarised: assembled.summarised, excluded: assembled.excluded,
    }, task.id)
    store.addFinding({ arcId, taskId: task.id, kind: 'risk', severity: 'medium',
      text: `review saw a partial diff — ${assembled.summarised.length} changed file(s) were named but not shown`,
      affects: assembled.summarised })
  }
  const gates = store.gatesFor(arcId, task.id).filter((g) => g.verdict !== 'baseline')

  const reviewBrief = repair ? [
    `# REPAIR REVIEW`,
    ``,
    `Judge whether the requested repair fixed the previously reviewed defects.`,
    `Do not re-litigate the original implementation or introduce unrelated`,
    `minor work. New findings must be consequences of the repair diff below.`,
    `Every finding must carry file and line; use checkCommand when it can be`,
    `executed, because non-reproducing command findings are discarded.`,
    ``,
    `## Previous verdict`, repair.previousVerdict,
    ``, `## Findings sent to the writer`, ...repair.findings,
    ``, `## Repair diff only`, '```diff', diff, '```',
    ``, `Return REJECT only when the repair makes the approach untenable.`,
  ].join('\n') : [
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
    const briefArtifactId = store.putArtifact(arcId, 'brief', reviewBrief)
    const dispatched = await dispatchStep(o, {
      roleName: 'review', role, taskId: task.id, attemptNo: round,
      briefArtifactId,
      dispatch: { cwd: wt.path, prompt: reviewBrief, schema: ReviewVerdict, signal: o.signal },
    })
    rv = dispatched.result
    rvAttempt = dispatched.attemptId

    if (dispatched.capacityError) {
      store.addFinding({ arcId, taskId: task.id, attemptId: rvAttempt, kind: 'risk', severity: 'high', text: dispatched.capacityError })
      return { status: 'fail', findings: [] }
    }
    if (dispatched.model === 'drift') {
      log(`  ✗ MODEL DRIFT in review: asked for ${role.model}, ran on ${rv.observedModels.join(', ')}`)
      store.addFinding({ arcId, taskId: task.id, attemptId: rvAttempt, kind: 'risk', severity: 'high',
        text: `review model drift: requested ${role.model}, observed ${rv.observedModels.join(', ')}` })
      return { status: 'fail', findings: [] }
    }
    if ((rv.terminalReason === 'hard-timeout' || rv.terminalReason === 'stall-kill') && round === 1) {
      log(`  ! ${task.id}: review ${rv.terminalReason} — the task is green, so the review gets one more try`)
      continue
    }
    break
  }

  if (rv.terminalReason !== 'ok' || !rv.parsed) {
    log(`  ✗ ${task.id}: review ended "${rv.terminalReason}" — treating as not-reviewed`)
    return { status: 'fail', findings: [] }
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
        verdict: check.outcome === 'reproduced' ? 'pass' : 'inconclusive',
        caveat: check.caveat,
      })
    }
  }

  for (const assessment of verdict.criteriaAssessment.filter((item) => item.met)) {
    const criterion = task.acceptance.find((item) => item.id === assessment.id)
    if (criterion?.proofKind !== 'agent-review') continue
    // A reviewer that saw part of a diff cannot grant full-confidence evidence
    // for the whole task. `checked` is supposed to mean the harness held the
    // proof; here it would mean a model held an opinion about code it was not
    // shown. Cap it, and say so — never let the shortfall be silent.
    if (!assembled.complete) {
      store.promoteCriterion(arcId, task.id, criterion.id, 'claimed', assessment.evidence, verdictArtifact)
      store.appendEvent(arcId, 'tier.capped', {
        id: criterion.id, from: 'checked', to: 'claimed', why: 'the review saw a partial diff',
      }, task.id)
      continue
    }
    store.promoteCriterion(arcId, task.id, criterion.id, 'checked', assessment.evidence, verdictArtifact)
  }

  const criticals = findings.filter((f) => f.severity === 'critical')
  log(`  · ${task.id} verdict ${verdict.verdict}: ${findings.length} finding(s), ${criticals.length} critical`)

  if (repair) {
    const blockers = findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
    if (verdict.verdict === 'REJECT') {
      log(`  ✗ ${task.id}: repaired approach was rejected`)
      return { status: 'fail', verdict: verdict.verdict, findings: findings.map((finding) => finding.claim) }
    }
    if (blockers.length > 0) {
      log(`  ✗ ${task.id}: ${blockers.length} critical/major finding(s) remain after repair`)
      return { status: 'fail', verdict: verdict.verdict, findings: findings.map((finding) => finding.claim) }
    }
    // CHANGES_REQUIRED with no blocker left is a PASS by design: a repair round
    // ends on the surviving findings, and a finding that a check REFUTED is not
    // a finding. What made that unsafe was collapsing "the check could not run"
    // into "refuted" — fixed in runReviewFindingCheck, which now keeps an
    // unverifiable finding rather than deleting it. Say which one happened.
    if (verdict.verdict === 'CHANGES_REQUIRED') {
      log(`  · ${task.id}: CHANGES_REQUIRED, but no critical/major finding survived its check — landing`)
    }
    return { status: 'pass', verdict: verdict.verdict, findings: findings.map((finding) => finding.claim) }
  }

  if (verdict.verdict === 'PASS' || verdict.verdict === 'PASS_WITH_NOTES') {
    if (criticals.length > 0) {
      log(`  ✗ ${task.id}: verdict says pass but carries ${criticals.length} critical finding(s) — gate wins`)
      return { status: 'repair', verdict: verdict.verdict, findings: findings.map((finding) => finding.claim) }
    }
    for (const a of verdict.criteriaAssessment.filter((c) => !c.met)) {
      log(`  ! reviewer says criterion ${a.id} NOT met: ${a.evidence}`)
      store.addFinding({ arcId, taskId: task.id, attemptId: rvAttempt, kind: 'risk', severity: 'medium',
        text: `reviewer: criterion ${a.id} not met — ${a.evidence}` })
    }
    return {
      status: (verdict.criteriaAssessment.every((c) => c.met !== false) || verdict.verdict === 'PASS') ? 'pass' : 'repair',
      verdict: verdict.verdict,
      findings: findings.map((finding) => finding.claim),
    }
  }

  // REJECT means "this approach is wrong" — a repair round cannot save it.
  return {
    status: verdict.verdict === 'CHANGES_REQUIRED' ? 'repair' : 'fail',
    verdict: verdict.verdict,
    findings: findings.map((finding) => finding.claim),
  }
}

async function landTask(
  o: RunOptions, task: PlanTask, wt: G.Worktree,
  integrationBranch: string, baselines: Map<string, GateResult>, heavy: Semaphore,
): Promise<boolean> {
  const { store, config, log } = o
  const arcId = o.plan.arcId
  const onto = G.git(config.repo, 'rev-parse', integrationBranch)

  // Ask BEFORE the destructive attempt. `git merge-tree --write-tree` answers
  // without touching a working tree, so a conflict becomes a non-destructive
  // probe rather than a failed rebase to clean up after. Textual only — it will
  // not see "A deletes the only writer of a field, B adds a reader", which is
  // what integration review is for.
  const predicted = G.conflictsWith(config.repo, onto, G.headSha(wt.path))
  if (predicted !== null) {
    log(`  ! ${task.id}: merge-tree predicts conflicts in ${predicted.join(', ')} — attempting the rebase anyway`)
    store.appendEvent(arcId, 'land.conflict.predicted', { files: predicted }, task.id)
  }

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

  // Stamp before the rebase, so provenance survives it. After landing, nothing
  // on the integration branch said which commit came from which task.
  // `onto`, not wt.baseSha: the branch has just been rebased onto the
  // integration head, so that is where its commits now start.
  const model = config.roles.implement.model
  if (!G.stampTaskTrailers(wt.path, onto, arcId, task.id, model)) {
    log(`  ! ${task.id}: could not stamp task trailers — provenance will be missing from the integration branch`)
  }

  if (o.signal?.aborted) return false
  // Rebase and commit trailers can change the commit id. Persist the exact
  // candidate before moving the integration ref so crash recovery can find it.
  store.setTaskHead(arcId, task.id, G.headSha(wt.path), G.measuredFootprint(wt.path, onto))
  const lr = G.landBranch(config.repo, integrationBranch, wt.branch)
  store.appendEvent(arcId, 'land', lr, task.id)
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
async function verifyFinalState(
  o: RunOptions, integrationBranch: string, baselines: Map<string, GateResult>, heavy: Semaphore,
): Promise<boolean> {
  const { config, store, plan, log } = o
  const head = G.git(config.repo, 'rev-parse', integrationBranch)
  const workspace = `${plan.arcId}-verify`
  G.releaseTaskWorkspace(config.repo, store.root, workspace)
  const tree = G.provisionWorktree(config.repo, store.root, workspace, head)
  try {
    if (config.setupCommand && !await setupWorktree(o, tree)) return false
    let ok = true
    for (const gate of config.gates) {
      const result = await heavy.run(() => runGate(gate, tree.path, head, o.signal, { sandboxPolicy: config.sandboxPolicy }))
      const baseline = baselines.get(gate.name)
      const accepted = (gate.baselineSubset && baseline ? isSubsetOfBaseline(result, baseline) : result.pass)
        && (!baseline || testsVanished(result, baseline) === 0)
      store.recordGate({ arcId: plan.arcId, name: `final:${gate.name}`, command: gate.command,
        proves: gate.proves, exitCode: result.exitCode, baseSha: head,
        verdict: accepted ? 'pass' : 'fail', signature: result.signature, durationMs: result.durationMs,
        artifactId: store.putArtifact(plan.arcId, 'gate-output', result.output),
      })
      log(`final ${describe(result)}`)
      ok &&= accepted
    }
    const landed = new Set(store.allTasks(plan.arcId).filter((t) => t.state === 'landed').map((t) => t.id))
    for (const task of plan.tasks.filter((t) => landed.has(t.id))) {
      for (const criterion of task.acceptance) {
        if (criterion.proofKind !== 'command' || !criterion.proofCommand) continue
        const result = await runGate({ name: `final-criterion:${task.id}:${criterion.id}`,
          command: criterion.proofCommand, proves: criterion.text, cwd: '.', timeoutMs: 300_000,
          heavy: false, baselineSubset: false,
        }, tree.path, head, o.signal)
        store.recordGate({ arcId: plan.arcId, taskId: task.id, name: result.name, command: result.command,
          proves: result.proves, exitCode: result.exitCode, baseSha: head,
          verdict: result.pass ? 'pass' : 'fail', signature: result.signature, durationMs: result.durationMs,
          artifactId: store.putArtifact(plan.arcId, 'criterion-proof', result.output),
        })
        if (!result.pass) {
          log(`✗ final criterion ${task.id}/${criterion.id}: FAILED on the integrated tree`)
          store.invalidateCriteria(plan.arcId, task.id, 'proof failed on final integrated tree', criterion.id)
          store.addFinding({ arcId: plan.arcId, taskId: task.id, kind: 'integration', severity: 'high',
            text: `criterion ${criterion.id} failed on final integration ${head}` })
          ok = false
        }
      }
    }
    if (!G.isClean(tree.path) || G.headSha(tree.path) !== head) {
      log('✗ final verification changed tracked files or HEAD — refusing to deliver different code from the code tested')
      ok = false
    }
    return ok && !o.signal?.aborted
  } finally { G.releaseTaskWorkspace(config.repo, store.root, workspace) }
}

async function finalReview(o: RunOptions, integrationBranch: string, baseSha: string): Promise<boolean> {
  const { store, config, log } = o
  const arcId = o.plan.arcId
  const role = config.roles.integrate ?? config.roles.review
  if (!role) return true

  const head = G.git(config.repo, 'rev-parse', integrationBranch)
  if (head === baseSha) { log('nothing landed — skipping integration review'); return true }

  const assembled = assembleDiff(config.repo, `${baseSha}...${head}`, { budget: INTEGRATION_DIFF_BUDGET })
  const diff = assembled.text
  log(`integration review over ${baseSha.slice(0, 8)}...${head.slice(0, 8)}`)
  if (!assembled.complete) {
    log(`! integration review sees a PARTIAL diff: ${assembled.summarised.length} file(s) named but not shown`)
    store.appendEvent(arcId, 'review.truncated', {
      scope: 'integration', shown: assembled.shown.length,
      summarised: assembled.summarised, excluded: assembled.excluded,
    })
    store.addFinding({ arcId, kind: 'integration', severity: 'medium',
      text: `integration review saw a partial diff — ${assembled.summarised.length} changed file(s) were named but not shown`,
      affects: assembled.summarised })
  }

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

  const dispatched = await dispatchStep(o, {
    roleName: 'integrate', role, taskId: null, attemptNo: 1,
    dispatch: { cwd: reviewWt.path, prompt, schema: ReviewVerdict, signal: o.signal },
  })
  const { result: rv, attemptId } = dispatched

  if (dispatched.capacityError) {
    store.addFinding({ arcId, attemptId, kind: 'integration', severity: 'high', text: dispatched.capacityError })
    return false
  }
  if (dispatched.model === 'drift') {
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
        verdict: check.outcome === 'reproduced' ? 'pass' : 'inconclusive',
        caveat: check.caveat,
      })
    }
  }
  const retained = checkedFindings.filter(({ check }) => check.keep).length
  log(`integration verdict: ${v.verdict} (${retained}/${v.findings.length} finding(s) reproduced or retained)`)
  store.appendEvent(arcId, 'integration.verdict', { verdict: v.verdict, findings: retained })
  const blocking = checkedFindings.some(({ finding, check }) => check.keep && finding.severity !== 'minor')
  return !blocking && (v.verdict === 'PASS' || v.verdict === 'PASS_WITH_NOTES')
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
  const quarantined = tasks.filter((t) => t.state === 'quarantined')

  const byTier = (t: string) => crit.filter((c) => c.tier === t).length

  log('')
  log('════════════════════════════════════════════')
  log(`ARC ${arcId}`)
  log(`  goal: ${plan.charter.goal.split('\n')[0]?.slice(0, 70)}`)
  log('')
  log(`  landed   ${landed.length}/${tasks.length}`)
  if (failed.length) log(`  FAILED   ${failed.length}  (${failed.map((t) => t.id).join(', ')})`)
  if (blocked.length) log(`  blocked  ${blocked.length}  (${blocked.map((t) => t.id).join(', ')})`)
  if (quarantined.length) log(`  waiting on YOU  ${quarantined.length}  (${quarantined.map((t) => t.id).join(', ')})`)
  log('')
  log(`  criteria: observed ${byTier('observed')} · checked ${byTier('checked')} · claimed-only ${byTier('claimed')} · unproven ${byTier('unproven')}`)

  // Against the criterion's OWN declared bar, not an absolute floor. A plan may
  // legitimately set requiredTier: 'claimed' for something no command can prove
  // — the absolute test reported such an arc INCOMPLETE forever, disagreeing
  // with unmetCriteria, which is what actually gates landing.
  const weak = crit.filter((c) =>
    TIER_RANK[c.tier as ClaimTier] < TIER_RANK[c.required_tier as ClaimTier])
  if (weak.length) {
    log('')
    log('  NOT PROVEN — below the tier the plan itself asked for:')
    for (const c of weak) log(`    ${c.task_id}/${c.id}: ${c.tier} < required ${c.required_tier} — ${c.text.slice(0, 64)}`)
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

  logCostSummary(o)

  if (quarantined.length > 0) {
    log('')
    log('  QUARANTINED — never attempted, and nothing is wrong with them.')
    log('  Each needs a decision from you; the rest of the arc ran to completion.')
    for (const t of quarantined) {
      const why = store.findingsFor(arcId)
        .find((f) => f.task_id === t.id && String(f.text).startsWith('quarantined: '))
      log(`    ${t.id}: ${String(why?.text ?? 'see findings').replace(/^quarantined: /, '')}`)
    }
  }

  const complete = integrationApproved && failed.length === 0 && blocked.length === 0
    && quarantined.length === 0 && weak.length === 0 && ops.length === 0
  log('')
  log(`  integration branch: ${integrationBranch}`)
  log(`  ${complete ? 'COMPLETE — every criterion has evidence' : 'INCOMPLETE — see above. Nothing merged to your main branch.'}`)
  log('════════════════════════════════════════════')

  return complete
}

function logCostSummary(o: RunOptions): void {
  const cost = formatCostSummary(o.store.costSummary(o.plan.arcId))
  o.log('')
  o.log(`  token bill — ${cost.lines.length > 0 ? 'provider receipts' : 'no attempts recorded'}`)
  for (const line of cost.lines) o.log(line)
  if (cost.missing > 0) o.log(`  ! ${cost.missing} attempt(s) reported no usage receipt — every number above is a FLOOR.`)
}
