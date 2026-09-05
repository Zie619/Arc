import { lintShell } from './shell-lint.ts'
import { PlanIdentifier, type Plan, type PlanTask } from './types.ts'
import { posix } from 'node:path'

/**
 * The scheduler is a PURE FUNCTION over persisted rows. There is no queue
 * table and no in-memory frontier.
 *
 * That single property is what makes a crash survivable: kill the process at
 * any instant, restart, recompute, and you get the identical frontier. It is
 * also what makes the hardest logic in the system testable without spawning a
 * single process.
 */

export type TaskState =
  | 'pending'
  | 'running'
  | 'reviewing'
  | 'landing'
  | 'landed'
  | 'blocked'
  /**
   * Refused for a reason a human can clear, not for a reason the writer caused
   * — today, a capability its sandbox cannot reach. Distinct from `failed`
   * because the work was never attempted and nothing is wrong with it: the
   * frontier skips it, the report separates it, the rest of the DAG runs to
   * completion, and `arc resume` picks it up once you grant.
   *
   * (This is the state declined during v2 planning on the grounds that nothing
   * produced the signal. Capability refusal produces it.)
   */
  | 'quarantined'
  | 'failed'

export interface TaskRuntime {
  id: string
  state: TaskState
  /** Set while a slot is held. A lease that has expired is a dead worker. */
  leaseExpiresAt?: number | null
}

export interface SchedulerInput {
  plan: Plan
  runtime: Record<string, TaskRuntime>
  now: number
  agentConcurrency: number
}

export interface Blocked {
  id: string
  reason: string
}

export interface Frontier {
  ready: PlanTask[]
  blocked: Blocked[]
  /** Leases that expired — their worker is gone and the row must be reclaimed. */
  reclaimable: string[]
}

const OCCUPYING: TaskState[] = ['running', 'reviewing', 'landing']

/**
 * Footprints may name either a file or a directory. Equality alone misses the
 * common `src` versus `src/foo.ts` collision; raw startsWith is also wrong
 * because `src/foo` and `src/foobar` are siblings. Normalise to slash-delimited
 * repo-relative paths and compare at a segment boundary.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const clean = (value: string): string => {
    const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '')
    return normalized === '.' ? '' : normalized.replace(/\/$/, '')
  }
  const left = clean(a)
  const right = clean(b)
  if (!left || !right) return true
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * An EMPTY footprint means "not declared", which is not the same as "touches
 * nothing" — and the scheduler must not read it as "impose no constraint".
 *
 * `[].find(...)` is undefined, so a task declaring nothing never collided with
 * anything and was always schedulable alongside everything. The tell was ten
 * lines up: `pathsOverlap` treats an empty STRING conservatively (`'.'` collides
 * with everything) while the empty ARRAY took the opposite branch. One
 * fail-closed, one fail-open, side by side.
 *
 * validatePlan rejects an empty footprint outright; this is the second line of
 * defence for a plan that reached the scheduler another way.
 */
/** An UNDECLARED footprint is "unknown", not "nothing" — so it means the whole
 *  tree. `pathsOverlap` already treats `'.'` as colliding with everything; the
 *  empty ARRAY simply never reached it. */
const declared = (footprint: string[]): string[] => footprint.length > 0 ? footprint : ['.']

/** `["none"]` is how a task SAYS it mutates no shared contract, as opposed to
 *  saying nothing. It is a sentinel, never a contract name. */
export const NO_CONTRACT = 'none'
const contracts = (names: string[]): string[] => names.filter((n) => n !== NO_CONTRACT)

function footprintCollision(paths: string[], claimed: string[]): string | undefined {
  return declared(paths).find((path) => claimed.some((other) => pathsOverlap(path, other)))
}

/**
 * A task is ready when ALL of:
 *   1. it is pending
 *   2. every dependency has landed
 *   3. no in-flight task mutates a contract it touches (read or write)
 *   4. no in-flight task overlaps its file footprint
 *   5. a concurrency slot is free
 *
 * Rule 3 is the one none of the source codebases implements, and it is the
 * class of breakage that per-branch CI is green against by construction: two
 * branches can each be green and still land contradictory versions of one
 * exported signature, enum, or schema.
 */
export function computeFrontier(input: SchedulerInput): Frontier {
  const { plan, runtime, now, agentConcurrency } = input
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))

  const stateOf = (id: string): TaskState => runtime[id]?.state ?? 'pending'

  const reclaimable = plan.tasks
    .filter((t) => {
      const r = runtime[t.id]
      if (!r || !OCCUPYING.includes(r.state)) return false
      return typeof r.leaseExpiresAt === 'number' && r.leaseExpiresAt < now
    })
    .map((t) => t.id)

  // A task whose lease expired is not really occupying anything.
  const occupied = plan.tasks.filter(
    (t) => OCCUPYING.includes(stateOf(t.id)) && !reclaimable.includes(t.id),
  )

  const occupiedMutations = new Set<string>()
  const occupiedReads = new Set<string>()
  for (const t of occupied) {
    for (const c of contracts(t.contractsMutated)) occupiedMutations.add(c)
    for (const c of contracts(t.contractsRead)) occupiedReads.add(c)
  }

  const occupiedPaths = occupied.flatMap((t) => declared(t.footprint))

  const slots = Math.max(0, agentConcurrency - occupied.length)

  const ready: PlanTask[] = []
  const blocked: Blocked[] = []

  for (const task of plan.tasks) {
    if (stateOf(task.id) !== 'pending') continue

    const missingDep = task.dependsOn.find((d) => !byId.has(d))
    if (missingDep) {
      blocked.push({ id: task.id, reason: `depends on unknown task "${missingDep}"` })
      continue
    }

    const unlanded = task.dependsOn.filter((d) => stateOf(d) !== 'landed')
    if (unlanded.length > 0) {
      blocked.push({ id: task.id, reason: `waiting on ${unlanded.join(', ')}` })
      continue
    }

    // A contract may have exactly one mutator in flight. Readers wait too:
    // reading a signature that is being changed under you is the bug.
    const touched = [...contracts(task.contractsMutated), ...contracts(task.contractsRead)]
    const contended = touched.find((c) => occupiedMutations.has(c))
    if (contended) {
      blocked.push({ id: task.id, reason: `contract "${contended}" has a mutator in flight` })
      continue
    }
    const readerContended = contracts(task.contractsMutated).find((c) => occupiedReads.has(c))
    if (readerContended) {
      blocked.push({ id: task.id, reason: `contract "${readerContended}" has a reader in flight` })
      continue
    }

    const overlap = footprintCollision(task.footprint, occupiedPaths)
    if (overlap) {
      blocked.push({ id: task.id, reason: `footprint "${overlap}" in use` })
      continue
    }

    ready.push(task)
  }

  // Admit in plan order, but only as many as there are slots — and never two
  // that would collide with EACH OTHER in the same tick.
  const admitted: PlanTask[] = []
  const claimedMutations = new Set(occupiedMutations)
  const claimedReads = new Set(occupiedReads)
  const claimedPaths = [...occupiedPaths]

  for (const task of ready) {
    if (admitted.length >= slots) break
    // Readers may share a contract. A writer conflicts with both readers and
    // writers, regardless of which one appeared first in the plan.
    if (task.contractsRead.some((c) => claimedMutations.has(c))) continue
    if (contracts(task.contractsMutated).some((c) => claimedMutations.has(c) || claimedReads.has(c))) continue
    if (footprintCollision(task.footprint, claimedPaths)) continue
    for (const c of contracts(task.contractsMutated)) claimedMutations.add(c)
    for (const c of contracts(task.contractsRead)) claimedReads.add(c)
    claimedPaths.push(...declared(task.footprint))
    admitted.push(task)
  }

  return { ready: admitted, blocked, reclaimable }
}

/** Cycle detection that PRINTS THE CYCLE. An opaque "deadlock" is useless. */
export function findCycle(plan: Plan): string[] | null {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const seen = new Map<string, 0 | 1 | 2>() // 0 unvisited, 1 on-stack, 2 done
  const stack: string[] = []

  const walk = (id: string): string[] | null => {
    const mark = seen.get(id) ?? 0
    if (mark === 1) return [...stack.slice(stack.indexOf(id)), id]
    if (mark === 2) return null
    seen.set(id, 1)
    stack.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue
      const cycle = walk(dep)
      if (cycle) return cycle
    }
    stack.pop()
    seen.set(id, 2)
    return null
  }

  for (const t of plan.tasks) {
    const cycle = walk(t.id)
    if (cycle) return cycle
  }
  return null
}

/**
 * Structural validation, run BEFORE anything is dispatched.
 *
 * `config` is optional only because `arc validate` can be pointed at a plan
 * without one. Pass it wherever you have it: a plan naming a gate the project
 * does not declare used to throw at TASK RUNTIME, after the implement dispatch
 * had already been paid for.
 */
export function validatePlan(
  plan: Plan,
  config?: {
    gates: Array<{ name: string; requires?: string[] }>
    capabilities?: Record<string, unknown>
  },
): string[] {
  const errors: string[] = []
  if (!PlanIdentifier.safeParse(plan.arcId).success) errors.push(`unsafe arc id "${plan.arcId}"`)
  for (const task of plan.tasks) {
    if (!PlanIdentifier.safeParse(task.id).success) errors.push(`unsafe task id "${task.id}"`)
  }
  const ids = new Set<string>()
  const gateNames = config ? new Set(config.gates.map((g) => g.name)) : null
  if (config && gateNames!.size !== config.gates.length) errors.push('gate names must be unique')
  const capabilityNames = config?.capabilities ? new Set(Object.keys(config.capabilities)) : null

  // A gate that requires a capability nobody defined can never be probed, so
  // this is a config error rather than a runtime surprise.
  for (const gate of config?.gates ?? []) {
    for (const need of gate.requires ?? []) {
      if (capabilityNames && !capabilityNames.has(need)) {
        errors.push(`gate "${gate.name}" requires capability "${need}", which the project config does not define`
          + ` — add it under \`capabilities:\` with a probe`)
      }
    }
  }

  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id "${t.id}"`)
    ids.add(t.id)
    // `footprint: []` collapsed three meanings into one value the scheduler read
    // as "no constraint": the model did not say, it touches no files, and it may
    // touch anything. Make the degenerate value inexpressible: a task that may
    // touch anything says so.
    if (t.footprint.length === 0) {
      errors.push(`task "${t.id}" declares no footprint — say which paths it touches, or ["."] if it may touch anything (which serialises it against every other task)`)
    }
    // Contracts are 100% honour system: there is no measured counterpart to
    // measuredFootprint anywhere. Two tasks that both forget to declare
    // `contractsMutated` run concurrently and land contradictory signatures,
    // and contract serialisation is the one mechanism nothing else in the field
    // has. Silence must not be spelled the same way as "nothing".
    if (t.contractsMutated.length === 0) {
      errors.push(`task "${t.id}" declares no contractsMutated — name the exported signatures it changes, or ["none"]`)
    }
    for (const need of t.needs ?? []) {
      if (capabilityNames && !capabilityNames.has(need.capability)) {
        errors.push(`task "${t.id}" needs capability "${need.capability}", which the project config does not define`
          + ` — add it under \`capabilities:\` with a probe, or remove the need`)
      }
    }
    if (gateNames) {
      for (const g of t.gates) {
        if (!gateNames.has(g)) {
          errors.push(`task "${t.id}" names unknown gate "${g}" — declared gates are: ${[...gateNames].join(', ') || '(none)'}`)
        }
      }
    }
    const critIds = new Set<string>()
    for (const c of t.acceptance) {
      if (critIds.has(c.id)) errors.push(`task "${t.id}": duplicate criterion id "${c.id}"`)
      critIds.add(c.id)
      if (c.proofKind === 'command' && !c.proofCommand) {
        errors.push(`task "${t.id}": criterion "${c.id}" is proofKind=command with no proofCommand`)
      }
      // Model-authored shell, linted before anything runs it. These feed the
      // planner's existing repair loop, so each rule is a self-repairing
      // constraint at no extra control-flow cost.
      for (const issue of c.proofCommand ? lintShell(c.proofCommand) : []) {
        errors.push(`task "${t.id}": criterion "${c.id}" proofCommand [${issue.rule}] — ${issue.message}`)
      }
    }
  }

  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) errors.push(`task "${t.id}" depends on unknown task "${d}"`)
    }
  }

  const cycle = findCycle(plan)
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' → ')}`)

  // Traceability between what the operator approved and what got planned. Arc
  // had none: an objective could be dropped silently and a task could exist for
  // no stated reason. Only enforced once ANY task declares coverage, so plans
  // written before this still validate.
  const objectives = plan.charter.objectives ?? []
  if (objectives.length > 0 && plan.tasks.some((t) => (t.covers ?? []).length > 0)) {
    const covered = new Set(plan.tasks.flatMap((t) => t.covers ?? []))
    for (const objective of objectives) {
      if (!covered.has(objective)) {
        errors.push(`no task covers the objective "${objective}" — the goal cannot shrink silently`)
      }
    }
    for (const t of plan.tasks) {
      if ((t.covers ?? []).length === 0) {
        errors.push(`task "${t.id}" covers no charter objective — say which one it advances, or drop it`)
      }
      for (const c of t.covers ?? []) {
        if (!objectives.includes(c)) {
          errors.push(`task "${t.id}" claims to cover "${c}", which is not one of the charter's objectives`)
        }
      }
    }
  }

  // Ambiguity words: a criterion nobody can fail is a criterion nobody can pass.
  const VAGUE = /\b(properly|correctly|robust|robustly|clean(?:ly)?|as needed|appropriate(?:ly)?|reasonable|sensible)\b/i
  for (const t of plan.tasks) {
    for (const c of t.acceptance) {
      const vague = c.text.match(VAGUE)
      if (vague) {
        errors.push(`task "${t.id}": criterion "${c.id}" says "${vague[0]}" — name the observable behaviour instead, `
          + 'or nobody can tell whether it held')
      }
    }
  }

  return errors
}
