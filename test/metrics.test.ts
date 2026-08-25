import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'

/**
 * The self-benchmark itself runs as its own CI step (`pnpm bench`), not as a
 * test file: it spawns a dozen full arcs and starved the other spawn-heavy
 * suites of CPU when vitest ran them in parallel. Its own runner is the gate.
 * What stays here is the reporting built on the same rows.
 */
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
