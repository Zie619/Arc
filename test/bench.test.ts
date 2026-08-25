import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { SCENARIOS } from '../bench/scenarios.ts'
import { runBench } from '../src/bench.ts'

/**
 * The self-benchmark runs in CI because a regression suite nobody runs is a
 * document. It costs no tokens and finishes in seconds, so there is no reason
 * for it to be optional.
 */
describe('arc grades arc', () => {
  it('holds every invariant, including the ones under attack', async () => {
    const results = await runBench(SCENARIOS)
    const broken = results.filter((r) => !r.passed)
    expect(broken.map((r) => `${r.id}: ${r.why.join('; ')}`)).toEqual([])
    // Half of them must be attacks. A bench of happy paths measures only what
    // Arc already does well, which is the failure mode a self-written benchmark
    // is most prone to.
    expect(results.filter((r) => r.defends.startsWith('ATTACK')).length)
      .toBeGreaterThanOrEqual(Math.floor(results.length / 2))
  }, 120_000)
})

describe('comparing two runs, and catching a gate that contradicts itself', () => {
  it('diffs one arc against another and proves flakiness rather than inferring it', () => {
    const home = mkdtempSync(join(tmpdir(), 'arcmetrics-'))
    const store = new Store(home)
    const plan = {
      arcId: 'a', charter: { goal: 'g', objectives: ['o'], nonGoals: [] },
      tasks: [{
        id: 't1', title: 't', spec: 's', dependsOn: [], footprint: [],
        contractsMutated: [], contractsRead: [], gates: [],
        acceptance: [{ id: 'c1', text: 'x', proofKind: 'agent-review', requiredTier: 'claimed' }],
      }],
    } as any
    store.createArc(plan, '/repo', 'base', 'arc/a')
    store.createArc({ ...plan, arcId: 'b' }, '/repo', 'base', 'arc/b')
    store.setTaskState('a', 't1', 'landed')

    expect(store.arcMetrics('a').landed).toBe(1)
    expect(store.arcMetrics('b').landed).toBe(0)
    expect(store.arcMetrics('nope').status).toBe('missing')

    // Same gate, same commit, both answers — a contradiction, not a guess.
    const gate = (verdict: 'pass' | 'fail') => store.recordGate({
      arcId: 'a', name: 'suite', command: 'npm test', proves: 'green',
      exitCode: verdict === 'pass' ? 0 : 1, baseSha: 'deadbeef', verdict,
    })
    gate('pass'); gate('fail'); gate('pass')
    const flaky = store.flakyGates()
    expect(flaky).toHaveLength(1)
    expect(flaky[0]).toMatchObject({ name: 'suite', base_sha: 'deadbeef', passes: 2, fails: 1 })

    // A gate that only ever failed is BROKEN, not flaky, and must never be
    // filed as noise.
    for (let i = 0; i < 3; i++) store.recordGate({
      arcId: 'a', name: 'always-red', command: 'false', proves: 'nothing',
      exitCode: 1, baseSha: 'deadbeef', verdict: 'fail',
    })
    expect(store.flakyGates().map((r) => r.name)).toEqual(['suite'])
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
})
