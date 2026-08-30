import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { explainFailure } from '../src/why.ts'
import type { Plan } from '../src/types.ts'

let home: string
let store: Store

const plan = (arcId: string): Plan => ({
  arcId,
  charter: { goal: 'g', objectives: ['o'], nonGoals: [] },
  tasks: ['alpha'].map((id) => ({
    id, title: `do ${id}`, spec: 's', dependsOn: [], footprint: [`${id}.ts`],
    contractsMutated: ['none'], contractsRead: [], gates: [], covers: [],
    acceptance: [{ id: 'c1', text: 'x', proofKind: 'agent-review', polarity: 'discriminating', requiredTier: 'claimed' }],
  })),
} as unknown as Plan)

/** A failed attempt: the writer ran, the gate went red, the output was stored. */
function redAttempt(signature: string, no: number): string {
  const attemptId = store.startAttempt({
    arcId: 'a', taskId: 'alpha', attemptNo: no, role: 'implement',
    cli: 'claude', requestedModel: 'opus',
  })
  const artifactId = store.putArtifact('a', 'gate-output', `${signature}\n${'x'.repeat(5000)}`, attemptId)
  store.recordGate({
    arcId: 'a', taskId: 'alpha', attemptId, name: 'typecheck', command: 'pnpm build',
    proves: 'compiles', exitCode: 2, baseSha: 'base', verdict: 'fail', signature, artifactId,
  })
  return artifactId
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'arc-why-'))
  store = new Store(home)
  store.createArc(plan('a'), '/repo', 'base', 'arc/a')
  store.setTaskState('a', 'alpha', 'failed')
})
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }) })

describe('why one task failed', () => {
  it('says STUCK when every attempt failed the same way', () => {
    const sig = 'src/a.ts(3,1): error TS2345: Argument of type string is not assignable'
    redAttempt(sig, 1)
    redAttempt(sig, 2)
    redAttempt(sig, 3)

    const text = explainFailure(store, 'a', 'alpha').join('\n')
    expect(text).toContain('the same error every time')
    expect(text).not.toContain('a different error each time')
    // The sentence is useless buried: it belongs in the first few lines.
    expect(explainFailure(store, 'a', 'alpha')[1]).toContain('the same error every time')
  })

  it('says THRASHING when each attempt failed a different way', () => {
    redAttempt('src/a.ts(3,1): error TS2345: bad argument', 1)
    redAttempt('src/b.ts(9,4): error TS2554: wrong arity', 2)

    const text = explainFailure(store, 'a', 'alpha').join('\n')
    expect(text).toContain('a different error each time')
    expect(text).not.toContain('the same error every time')
  })

  it('prints the worktree to cd into and an artifact id for the rest', () => {
    const first = redAttempt('src/a.ts(3,1): error TS2345: bad argument', 1)
    // A real run's worktree; `home` exists, so it is reported as reachable.
    store.setTaskWorkspace('a', 'alpha', home, 'arc/a/alpha', 'base')

    const text = explainFailure(store, 'a', 'alpha').join('\n')
    expect(text).toContain(`worktree: ${home}`)
    expect(text).toContain(`cd ${home} && pnpm build`)
    expect(text).toContain(`arc show ${first}`)
  })

  it('leads with the CAUSE, not the consequences that follow it', () => {
    redAttempt([
      'RUN v3.0.0 /repo',
      'src/a.ts(3,1): error TS2345: the one real mistake',
      'src/b.ts(1,1): error TS2307: cannot find module ./a',
      'src/c.ts(1,1): error TS2307: cannot find module ./a',
      'src/d.ts(1,1): error TS2307: cannot find module ./a',
      'src/e.ts(1,1): error TS2307: cannot find module ./a',
      'src/f.ts(1,1): error TS2307: cannot find module ./a',
    ].join('\n'), 1)

    const text = explainFailure(store, 'a', 'alpha').join('\n')
    expect(text).toContain('TS2345: the one real mistake')
    expect(text).toContain('1 more error line(s) after it')  // rule 4: truncation is named
  })

  it('does not read gate output for an attempt that never produced any', () => {
    const attemptId = store.startAttempt({
      arcId: 'a', taskId: 'alpha', attemptNo: 1, role: 'implement',
      cli: 'claude', requestedModel: 'opus',
    })
    store.finishAttempt('a', attemptId, {
      terminalReason: 'hard-timeout', exitCode: null, observedModel: null,
    })

    const text = explainFailure(store, 'a', 'alpha').join('\n')
    expect(text).toContain('no failed gate recorded')
    expect(text).toContain('#1 implement — hard-timeout')
  })
})
