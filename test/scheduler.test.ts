import { describe, it, expect } from 'vitest'
import { computeFrontier, findCycle, validatePlan } from '../src/scheduler.ts'
import type { Plan, PlanTask } from '../src/types.ts'

function task(id: string, over: Partial<PlanTask> = {}): PlanTask {
  return {
    id, title: id, spec: 'do it',
    dependsOn: [], footprint: [], contractsMutated: [], contractsRead: [], gates: [],
    acceptance: [{ id: 'c1', text: 'works', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' }],
    ...over,
  }
}

function plan(...tasks: PlanTask[]): Plan {
  return { arcId: 'test', charter: { goal: 'g', objectives: [], nonGoals: [] }, tasks }
}

const NOW = 1_000_000

describe('computeFrontier', () => {
  it('admits independent tasks up to the concurrency limit', () => {
    const p = plan(task('a'), task('b'), task('c'), task('d'))
    const f = computeFrontier({ plan: p, runtime: {}, now: NOW, agentConcurrency: 3 })
    expect(f.ready.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('holds a task until every dependency has LANDED, not merely finished', () => {
    const p = plan(task('a'), task('b', { dependsOn: ['a'] }))
    const running = computeFrontier({
      plan: p, runtime: { a: { id: 'a', state: 'running' } }, now: NOW, agentConcurrency: 3,
    })
    expect(running.ready.map((t) => t.id)).toEqual([])
    expect(running.blocked.find((b) => b.id === 'b')?.reason).toContain('waiting on a')

    // "reviewing" is not "landed" either — the code is not on the integration
    // head yet, so anything depending on it would build against nothing.
    const reviewing = computeFrontier({
      plan: p, runtime: { a: { id: 'a', state: 'reviewing' } }, now: NOW, agentConcurrency: 3,
    })
    expect(reviewing.ready.map((t) => t.id)).toEqual([])

    const landed = computeFrontier({
      plan: p, runtime: { a: { id: 'a', state: 'landed' } }, now: NOW, agentConcurrency: 3,
    })
    expect(landed.ready.map((t) => t.id)).toEqual(['b'])
  })

  it('allows only ONE mutator per contract, even across disjoint files', () => {
    // This is the case per-branch CI is green against by construction: two
    // tasks touching different files, both changing one exported signature.
    const p = plan(
      task('a', { footprint: ['src/a.ts'], contractsMutated: ['AgentConfig'] }),
      task('b', { footprint: ['src/b.ts'], contractsMutated: ['AgentConfig'] }),
    )
    const f = computeFrontier({ plan: p, runtime: {}, now: NOW, agentConcurrency: 3 })
    expect(f.ready.map((t) => t.id)).toEqual(['a'])
  })

  it('blocks a READER while a contract has a mutator in flight', () => {
    const p = plan(
      task('a', { contractsMutated: ['Schema'] }),
      task('b', { contractsRead: ['Schema'] }),
    )
    const f = computeFrontier({
      plan: p, runtime: { a: { id: 'a', state: 'running' } }, now: NOW, agentConcurrency: 3,
    })
    expect(f.ready).toEqual([])
    expect(f.blocked.find((x) => x.id === 'b')?.reason).toContain('mutator in flight')
  })

  it('blocks a writer behind a reader regardless of plan order', () => {
    const readerFirst = plan(
      task('reader', { contractsRead: ['Schema'] }),
      task('writer', { contractsMutated: ['Schema'] }),
    )
    const writerFirst = plan(...readerFirst.tasks.toReversed())

    expect(computeFrontier({ plan: readerFirst, runtime: {}, now: NOW, agentConcurrency: 3 }).ready.map((t) => t.id))
      .toEqual(['reader'])
    expect(computeFrontier({ plan: writerFirst, runtime: {}, now: NOW, agentConcurrency: 3 }).ready.map((t) => t.id))
      .toEqual(['writer'])
  })

  it('allows multiple readers of the same contract in one tick', () => {
    const p = plan(
      task('a', { contractsRead: ['Schema'] }),
      task('b', { contractsRead: ['Schema'] }),
    )
    expect(computeFrontier({ plan: p, runtime: {}, now: NOW, agentConcurrency: 3 }).ready.map((t) => t.id))
      .toEqual(['a', 'b'])
  })

  it('never admits two colliding tasks in the SAME tick', () => {
    const p = plan(
      task('a', { footprint: ['shared.ts'] }),
      task('b', { footprint: ['shared.ts'] }),
    )
    const f = computeFrontier({ plan: p, runtime: {}, now: NOW, agentConcurrency: 3 })
    expect(f.ready.map((t) => t.id)).toEqual(['a'])
  })

  it('treats parent and child footprints as collisions, but not prefix siblings', () => {
    const nested = computeFrontier({
      plan: plan(task('parent', { footprint: ['src'] }), task('child', { footprint: ['src/foo.ts'] })),
      runtime: {}, now: NOW, agentConcurrency: 3,
    })
    expect(nested.ready.map((t) => t.id)).toEqual(['parent'])

    const siblings = computeFrontier({
      plan: plan(task('foo', { footprint: ['src/foo'] }), task('foobar', { footprint: ['src/foobar'] })),
      runtime: {}, now: NOW, agentConcurrency: 3,
    })
    expect(siblings.ready.map((t) => t.id)).toEqual(['foo', 'foobar'])
  })

  it('treats an expired lease as a dead worker and frees its resources', () => {
    const p = plan(
      task('a', { contractsMutated: ['X'] }),
      task('b', { contractsMutated: ['X'] }),
    )
    const f = computeFrontier({
      plan: p,
      runtime: { a: { id: 'a', state: 'running', leaseExpiresAt: NOW - 1 } },
      now: NOW,
      agentConcurrency: 3,
    })
    expect(f.reclaimable).toEqual(['a'])
    // 'a' no longer holds the contract, so 'b' becomes admissible.
    expect(f.ready.map((t) => t.id)).toEqual(['b'])
  })

  it('a live lease still occupies its slot', () => {
    const p = plan(task('a'), task('b'))
    const f = computeFrontier({
      plan: p,
      runtime: { a: { id: 'a', state: 'running', leaseExpiresAt: NOW + 60_000 } },
      now: NOW,
      agentConcurrency: 1,
    })
    expect(f.reclaimable).toEqual([])
    expect(f.ready).toEqual([])
  })
})

describe('findCycle', () => {
  it('returns the actual cycle, not an opaque deadlock marker', () => {
    const p = plan(
      task('a', { dependsOn: ['c'] }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] }),
    )
    const cycle = findCycle(p)
    expect(cycle).not.toBeNull()
    expect(cycle!.length).toBeGreaterThan(1)
    expect(cycle![0]).toBe(cycle![cycle!.length - 1])
  })

  it('returns null for a DAG', () => {
    expect(findCycle(plan(task('a'), task('b', { dependsOn: ['a'] })))).toBeNull()
  })
})

describe('validatePlan', () => {
  it('rejects a criterion that declares a command proof but names no command', () => {
    const p = plan(task('a', {
      acceptance: [{ id: 'c1', text: 'x', proofKind: 'command', requiredTier: 'checked' }],
    }))
    expect(validatePlan(p).join()).toContain('no proofCommand')
  })

  it('rejects unknown dependencies and duplicate ids', () => {
    expect(validatePlan(plan(task('a', { dependsOn: ['ghost'] }))).join()).toContain('unknown task "ghost"')
    expect(validatePlan(plan(task('a'), task('a'))).join()).toContain('duplicate task id')
  })

  it('accepts a well-formed plan', () => {
    expect(validatePlan(plan(task('a'), task('b', { dependsOn: ['a'] })))).toEqual([])
  })
})
