import type { Plan, PlanTask } from './types.ts'
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
function pathsOverlap(a: string, b: string): boolean {
  const clean = (value: string): string => {
    const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '')
    return normalized === '.' ? '' : normalized.replace(/\/$/, '')
  }
  const left = clean(a)
  const right = clean(b)
  if (!left || !right) return true
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function footprintCollision(paths: string[], claimed: string[]): string | undefined {
  return paths.find((path) => claimed.some((other) => pathsOverlap(path, other)))
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
    for (const c of t.contractsMutated) occupiedMutations.add(c)
    for (const c of t.contractsRead) occupiedReads.add(c)
  }

  const occupiedPaths = occupied.flatMap((t) => t.footprint)

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
    const touched = [...task.contractsMutated, ...task.contractsRead]
    const contended = touched.find((c) => occupiedMutations.has(c))
    if (contended) {
      blocked.push({ id: task.id, reason: `contract "${contended}" has a mutator in flight` })
      continue
    }
    const readerContended = task.contractsMutated.find((c) => occupiedReads.has(c))
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
    if (task.contractsMutated.some((c) => claimedMutations.has(c) || claimedReads.has(c))) continue
    if (footprintCollision(task.footprint, claimedPaths)) continue
    for (const c of task.contractsMutated) claimedMutations.add(c)
    for (const c of task.contractsRead) claimedReads.add(c)
    claimedPaths.push(...task.footprint)
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

/** Structural validation, run BEFORE anything is dispatched. */
export function validatePlan(plan: Plan): string[] {
  const errors: string[] = []
  const ids = new Set<string>()

  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id "${t.id}"`)
    ids.add(t.id)
    const critIds = new Set<string>()
    for (const c of t.acceptance) {
      if (critIds.has(c.id)) errors.push(`task "${t.id}": duplicate criterion id "${c.id}"`)
      critIds.add(c.id)
      if (c.proofKind === 'command' && !c.proofCommand) {
        errors.push(`task "${t.id}": criterion "${c.id}" is proofKind=command with no proofCommand`)
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

  return errors
}
