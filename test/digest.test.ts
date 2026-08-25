import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { buildDigest } from '../src/digest.ts'
import type { Plan } from '../src/types.ts'

let home: string
let store: Store

const plan = (arcId: string): Plan => ({
  arcId,
  charter: { goal: 'g', objectives: ['o'], nonGoals: [] },
  tasks: ['alpha', 'beta'].map((id) => ({
    id, title: `do ${id}`, spec: 's', dependsOn: [], footprint: [`${id}.ts`],
    contractsMutated: ['none'], contractsRead: [], gates: [], covers: [],
    acceptance: [{ id: 'c1', text: 'x', proofKind: 'agent-review', polarity: 'discriminating', requiredTier: 'claimed' }],
  })),
} as unknown as Plan)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'arc-digest-'))
  store = new Store(home)
  store.createArc(plan('a'), '/repo', 'base', 'arc/a')
})
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }) })

describe('the comeback moment', () => {
  it('leads with the OUTCOME when nothing is blocked on a human', () => {
    store.setTaskState('a', 'alpha', 'landed')
    const d = buildDigest(store, 'a')
    expect(d.needsYou).toBe(0)
    // No "NEEDS YOU" block at all when nothing needs you — its presence is the
    // signal, so an empty one would destroy the signal.
    expect(d.lines[0]).not.toContain('NEEDS YOU')
    expect(d.lines[0]).toContain('arc a')
    expect(d.lines.join('\n')).toContain('1/2 landed')
  })

  it('puts what needs a human FIRST, and says so in the exit code', () => {
    store.addPendingOp('a', 'alpha', 'db-push', 'run prisma db push against prod', true)
    const d = buildDigest(store, 'a')
    expect(d.lines[0]).toContain('NEEDS YOU')
    expect(d.lines[1]).toContain('run prisma db push against prod')
    expect(d.needsYou).toBe(1)
  })

  it('collapses successes and EXPANDS failures, with the escape hatch named', () => {
    store.setTaskState('a', 'alpha', 'landed')
    store.setTaskState('a', 'beta', 'failed')
    const artifactId = store.putArtifact('a', 'gate-output', 'a'.repeat(5000))
    store.recordGate({
      arcId: 'a', taskId: 'beta', name: 'test', command: 'npm test', proves: 'green',
      exitCode: 1, baseSha: 'base', verdict: 'fail', artifactId,
      signature: 'Tests  2 failed | 5 passed\nFAIL src/a.test.ts\nAssertionError: nope',
    })
    const text = buildDigest(store, 'a').lines.join('\n')

    expect(text).toContain('  alpha — do alpha')          // one line
    expect(text).toContain('Tests  2 failed | 5 passed')   // verbatim, not a dump
    expect(text).toContain(`arc show ${artifactId}`)       // rule 4
  })

  it('files self-healed events quietly instead of hiding them', () => {
    store.appendEvent('a', 'capacity.wait', { minutes: 5 })
    store.appendEvent('a', 'capacity.wait', { minutes: 10 })
    store.appendEvent('a', 'arc.supervisor.relaunch', { relaunch: 1 })
    const text = buildDigest(store, 'a').lines.join('\n')

    // Interesting, not actionable. Leading with them is noise; hiding them is
    // dishonest.
    expect(text).toContain('Handled without you')
    expect(text).toContain('capacity.wait × 2')
    expect(text).toContain('arc.supervisor.relaunch × 1')
  })

  it('shows only the delta on the second return', () => {
    store.appendEvent('a', 'capacity.wait', { minutes: 5 })
    const first = buildDigest(store, 'a')
    store.setLastSeenSeq('a', first.lastSeq)

    store.appendEvent('a', 'arc.supervisor.relaunch', { relaunch: 1 })
    const second = buildDigest(store, 'a', { sinceSeq: store.lastSeenSeq('a') })
    const text = second.lines.join('\n')
    expect(text).toContain('arc.supervisor.relaunch × 1')
    expect(text).not.toContain('capacity.wait')
  })
})
