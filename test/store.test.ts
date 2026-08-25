import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { Store } from '../src/store.ts'
import { compileBrief } from '../src/brief.ts'
import type { Plan } from '../src/types.ts'

const plan: Plan = {
  arcId: 'arc1',
  charter: { goal: 'make the thing work', objectives: ['o1'], nonGoals: ['do not refactor'] },
  tasks: [{
    id: 't1', title: 'first', spec: 'do it',
    dependsOn: [], footprint: [], contractsMutated: [], contractsRead: [], gates: [],
    acceptance: [
      { id: 'c1', text: 'tests pass', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' },
      { id: 'c2', text: 'renders', proofKind: 'human-observation', requiredTier: 'observed' },
    ],
  }],
}

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arcstore-'))
  store = new Store(dir)
  store.createArc(plan, '/repo', 'base123', 'arc/integration')
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

describe('the harness grades evidence, never the agent', () => {
  it('demotes a claim of "checked" that has no stored artifact', () => {
    const granted = store.promoteCriterion('arc1', 't1', 'c1', 'checked', 'trust me, it passed')
    expect(granted).toBe('claimed')
  })

  it('demotes a claim of "observed" with no artifact', () => {
    expect(store.promoteCriterion('arc1', 't1', 'c2', 'observed', 'I saw it')).toBe('claimed')
  })

  it('grants the tier when the exact criterion proof backs it', () => {
    const art = store.putArtifact('arc1', 'criterion-proof', 'Tests: 20 passed')
    expect(store.promoteCriterion('arc1', 't1', 'c1', 'checked', 'suite green', art)).toBe('checked')
  })

  it('does not use an unrelated green gate or prose artifact as criterion proof', () => {
    const unrelatedGate = store.putArtifact('arc1', 'gate-output', 'unrelated lint passed')
    expect(store.promoteCriterion('arc1', 't1', 'c1', 'checked', 'therefore tests passed', unrelatedGate))
      .toBe('claimed')
  })

  it('does not turn command output into human observation', () => {
    const command = store.putArtifact('arc1', 'criterion-proof', 'exit 0')
    expect(store.promoteCriterion('arc1', 't1', 'c2', 'observed', 'looked good', command)).toBe('claimed')
  })

  it('never demotes a criterion already proven', () => {
    const art = store.putArtifact('arc1', 'criterion-proof', 'ok')
    store.promoteCriterion('arc1', 't1', 'c1', 'checked', 'green', art)
    expect(store.promoteCriterion('arc1', 't1', 'c1', 'claimed', 'hand-wave')).toBe('checked')
  })
})

describe('completion is gated on evidence, not assertion', () => {
  it('reports criteria still below their OWN required tier', () => {
    expect(store.unmetCriteria('arc1', 't1')).toHaveLength(2)

    const art = store.putArtifact('arc1', 'criterion-proof', 'ok')
    store.promoteCriterion('arc1', 't1', 'c1', 'checked', 'green', art)
    // c1 needs `checked` and now has it. c2 needs `observed` and has nothing.
    const unmet = store.unmetCriteria('arc1', 't1')
    expect(unmet.map((c) => c.id)).toEqual(['c2'])
  })

  it('a claimed-only criterion does NOT satisfy a required tier of checked', () => {
    store.promoteCriterion('arc1', 't1', 'c1', 'checked', 'no artifact')
    expect(store.unmetCriteria('arc1', 't1').map((c) => c.id)).toContain('c1')
  })
})

describe('the event log is append-only and ordered', () => {
  it('assigns monotonic sequence numbers and replays from any point', () => {
    store.appendEvent('arc1', 'one', { a: 1 })
    store.appendEvent('arc1', 'two', { b: 2 }, 't1')
    store.appendEvent('arc1', 'three', null)

    const all = store.eventsSince('arc1', 0)
    const kinds = all.map((e) => e.kind)
    expect(kinds).toContain('one')
    expect(kinds).toContain('two')
    expect(kinds).toContain('three')

    const seqs = all.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    const tail = store.eventsSince('arc1', all[all.length - 2]!.seq)
    expect(tail).toHaveLength(1)
    expect(tail[0]!.kind).toBe('three')
  })

  it('survives reopening the database — state is durable, not in-memory', () => {
    store.setTaskState('arc1', 't1', 'landed')
    store.close()

    const reopened = new Store(dir)
    expect(reopened.taskRuntime('arc1').t1!.state).toBe('landed')
    expect(reopened.getPlan('arc1')!.charter.goal).toBe('make the thing work')
    reopened.close()
    store = new Store(dir) // for afterEach
  })
})

describe('immutable run inputs', () => {
  it('does not allow a reused design id to replace the raw brief', () => {
    store.startDesign('design-1', 'first brief')
    expect(() => store.startDesign('design-1', 'different brief')).toThrow(/immutable brief/)
    expect(store.getDesign('design-1')?.briefText).toBe('first brief')
  })

  it('stores the first run configuration snapshot idempotently', () => {
    store.saveRunSnapshot('arc1', { mainBranch: 'main', maxAttempts: 2 })
    store.saveRunSnapshot('arc1', { mainBranch: 'changed', maxAttempts: 9 })
    expect(store.getRunSnapshot('arc1')).toEqual({ mainBranch: 'main', maxAttempts: 2 })
  })
})

describe('premise verdicts', () => {
  it('a verified premise survives repeated addPremise', () => {
    for (const status of ['confirmed', 'refuted', 'superseded'] as const) {
      const id = `${status}-premise`
      const statement = `${status} statement`
      const howToVerify = `${status} verification`
      const evidence = `${status} evidence`

      store.addPremise('arc1', id, statement, howToVerify)
      store.setPremise('arc1', id, status, evidence)
      const before = store.premises('arc1').find((premise) => premise.id === id)!

      store.addPremise('arc1', id, `different ${statement}`, `different ${howToVerify}`)
      const after = store.premises('arc1').find((premise) => premise.id === id)!

      expect(after).toMatchObject({ status, evidence, statement, how_to_verify: howToVerify })
      expect(after.checked_at).toBe(before.checked_at)
    }

    store.addPremise('arc1', 'assumed-premise', 'old assumed', 'old verification')
    store.addPremise('arc1', 'assumed-premise', 'new assumed', 'new verification')
    expect(store.premises('arc1').find((premise) => premise.id === 'assumed-premise')).toMatchObject({
      status: 'assumed', statement: 'new assumed', how_to_verify: 'new verification',
      evidence: null, checked_at: null,
    })

    store.addPremise('arc1', 'unclear-premise', 'old unclear', 'old verification')
    store.setPremise('arc1', 'unclear-premise', 'unclear', 'inconclusive evidence')
    store.addPremise('arc1', 'unclear-premise', 'new unclear', 'new verification')
    expect(store.premises('arc1').find((premise) => premise.id === 'unclear-premise')).toMatchObject({
      status: 'assumed', statement: 'new unclear', how_to_verify: 'new verification',
      evidence: null, checked_at: null,
    })
  })

  it('does not return superseded premises as refuted', () => {
    store.addPremise('arc1', 'refuted-premise', 'refuted statement', 'refuted verification')
    store.setPremise('arc1', 'refuted-premise', 'refuted', 'refuted evidence')
    store.addPremise('arc1', 'superseded-premise', 'superseded statement', 'superseded verification')
    store.setPremise('arc1', 'superseded-premise', 'superseded', 'superseded evidence')

    expect(store.refutedPremises('arc1').map((premise) => premise.id)).toEqual(['refuted-premise'])
  })
})

describe('compiled retry context', () => {
  it('never lets retry feedback exceed the hard brief budget', () => {
    const compiled = compileBrief({
      store,
      plan,
      task: plan.tasks[0]!,
      role: 'implement',
      worktree: '/tmp/worktree',
      branch: 'arc/t1',
      baseSha: '0123456789abcdef',
      extra: `# WHAT FAILED LAST TIME\n${'failure detail '.repeat(2_000)}`,
      budget: { totalBytes: 5_000, tier0MaxFraction: 0.8 },
    })

    expect(compiled.bytes).toBeLessThanOrEqual(5_000)
    expect(compiled.text).toContain('retry feedback truncated to fit')
  })
})

describe('provider usage receipts', () => {
  it('persists exact counters and leaves unreported cost null', () => {
    const attemptId = store.startAttempt({
      arcId: 'arc1', taskId: 't1', attemptNo: 1, role: 'implement',
      cli: 'codex', requestedModel: 'gpt-5.6-sol',
    })
    store.finishAttempt('arc1', attemptId, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'gpt-5.6-sol',
      usage: [{
        provider: 'codex', usageSemantics: 'subset' as const, inputTokens: 101, cachedInputTokens: 51,
        outputTokens: 13, raw: { input_tokens: 101, cached_input_tokens: 51, output_tokens: 13 },
      }],
    })

    const rows = store.usageForAttempt(attemptId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      arc_id: 'arc1', provider: 'codex', usage_semantics: 'subset', input_tokens: 101,
      cached_input_tokens: 51, output_tokens: 13, cost_usd: null,
    })
    expect(JSON.parse(rows[0]!.raw_json)).toEqual({
      input_tokens: 101, cached_input_tokens: 51, output_tokens: 13,
    })
    expect(store.eventsSince('arc1', 0).at(-1)?.payload).toMatchObject({ usageRecords: 1 })
  })
})

describe('blocking pending ops keep an arc from claiming done', () => {
  it('surfaces open blocking ops', () => {
    store.addPendingOp('arc1', 't1', 'db-push', 'run prisma db push against prod', true)
    store.addPendingOp('arc1', 't1', 'note', 'tidy up later', false)
    const open = store.openBlockingOps('arc1')
    expect(open).toHaveLength(1)
    expect(open[0]!.kind).toBe('db-push')
  })
})

describe('the token bill', () => {
  it('sums receipts per role and counts the attempts that reported nothing', () => {
    const withReceipt = store.startAttempt({
      arcId: 'arc1', taskId: 't1', attemptNo: 1, role: 'implement',
      cli: 'codex', requestedModel: 'gpt-5.6-sol',
    })
    store.finishAttempt('arc1', withReceipt, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'gpt-5.6-sol',
      usage: [{
        provider: 'codex', usageSemantics: 'subset' as const, inputTokens: 1000, cachedInputTokens: 600,
        outputTokens: 50, raw: {},
      }],
    })
    const silent = store.startAttempt({
      arcId: 'arc1', taskId: 't1', attemptNo: 2, role: 'implement',
      cli: 'codex', requestedModel: 'gpt-5.6-sol',
    })
    store.finishAttempt('arc1', silent, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'gpt-5.6-sol',
    })
    const review = store.startAttempt({
      arcId: 'arc1', taskId: 't1', attemptNo: 1, role: 'review',
      cli: 'claude', requestedModel: 'opus',
    })
    store.finishAttempt('arc1', review, { terminalReason: 'ok', exitCode: 0, observedModel: 'opus' })

    const rows = store.costSummary('arc1')
    const impl = rows.find((r) => r.role === 'implement')!
    expect(impl.attempts).toBe(2)
    expect(impl.receipted).toBe(1)         // the silent attempt makes totals a floor
    expect(impl.input_tokens).toBe(1000)
    expect(impl.cached_input_tokens).toBe(600)
    expect(rows.find((r) => r.role === 'review')!.receipted).toBe(0)
  })
})

describe('two writers wait instead of throwing', () => {
  it('sets a busy timeout, because the supervisor opens the db twice', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'arc-busy-')))
    // WAL lets a reader and a writer coexist; it does NOT serialize two
    // writers. Without this, a contended setTaskState throws SQLITE_BUSY
    // immediately, which under --until-done becomes a crash and a relaunch.
    expect((store as any).db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000)
    store.close()
  })
})

describe('the two providers do not mean the same thing by "cached"', () => {
  it('bills Anthropic additively and OpenAI as a subset, in one summary', () => {
    const anthropic = store.startAttempt({
      arcId: 'arc1', taskId: 't1', attemptNo: 1, role: 'review',
      cli: 'claude', requestedModel: 'opus', effort: 'high',
    })
    store.finishAttempt('arc1', anthropic, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'opus',
      usage: [{
        provider: 'claude', usageSemantics: 'additive' as const,
        inputTokens: 10, cachedInputTokens: 18_140, cacheWriteInputTokens: 20_073,
        cacheWrite1hTokens: 20_073, cacheWrite5mTokens: 0,
        outputTokens: 89, reasoningOutputTokens: 83, raw: {},
      }],
    })
    const openai = store.startAttempt({
      arcId: 'arc1', taskId: 't1', attemptNo: 1, role: 'implement',
      cli: 'codex', requestedModel: 'gpt-5.6-sol',
    })
    store.finishAttempt('arc1', openai, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'gpt-5.6-sol',
      usage: [{
        provider: 'codex', usageSemantics: 'subset' as const,
        inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 50, raw: {},
      }],
    })

    const rows = store.costSummary('arc1')
    const claude = rows.find((r) => r.role === 'review')!
    const codex = rows.find((r) => r.role === 'implement')!

    // Anthropic: input_tokens EXCLUDES cache, so the bill is the sum of three
    // buckets. Reporting input_tokens alone showed 10 against 38,223 real.
    expect(claude.billed_input_tokens).toBe(10 + 18_140 + 20_073)
    // OpenAI: cached tokens are already inside input_tokens. Adding them again
    // would double count.
    expect(codex.billed_input_tokens).toBe(1_000)
    expect(claude.reasoning_tokens).toBe(83)
  })
})

describe('a lease is a lock, not a timer', () => {
  it('refuses a second live claim, reclaims a dead one, and ignores a foreign renewal', () => {
    const root = mkdtempSync(join(tmpdir(), 'arc-lease-'))
    const a = new Store(root)
    const b = new Store(root)
    const p = { ...plan, arcId: 'leased' }
    a.createArc(p, '/repo', 'base', 'arc/leased')

    expect(a.claimArc('leased', 60_000)).toBe(true)
    // Two `arc resume` invocations both ran, both provisioned worktrees, and
    // collided nondeterministically. The second one refuses now.
    expect(b.claimArc('leased', 60_000)).toBe(false)
    // The holder may re-claim its own lease — a resume in the same process is
    // not a conflict with itself.
    expect(a.claimArc('leased', 60_000)).toBe(true)

    a.releaseArc('leased')
    expect(b.claimArc('leased', 60_000)).toBe(true)

    // A lease held by a process that no longer exists is reclaimable even while
    // unexpired: --until-done kills its child and relaunches within seconds,
    // well inside any sane lease, so expiry alone would lock out the successor.
    ;(b as any).db.prepare('UPDATE arc SET lease_owner = ?, lease_expires_at = ? WHERE id = ?')
      .run(`${hostname()}:999999:dead`, Date.now() + 60_000, 'leased')
    expect(a.claimArc('leased', 60_000)).toBe(true)

    a.close(); b.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('will not let another process renew a task lease it does not hold', () => {
    const root = mkdtempSync(join(tmpdir(), 'arc-tasklease-'))
    const mine = new Store(root)
    const theirs = new Store(root)
    mine.createArc({ ...plan, arcId: 'own' }, '/repo', 'base', 'arc/own')
    mine.setTaskState('own', 't1', 'running', 50_000)
    mine.renewLease('own', 't1', 50_000)
    const held = mine.allTasks('own')[0]!.lease_expires_at

    theirs.renewLease('own', 't1', 999_000)
    // No owner check meant any process could renew any task's lease, so two
    // processes could both believe they owned the task and both keep renewing.
    expect(mine.allTasks('own')[0]!.lease_expires_at).toBe(held)

    mine.close(); theirs.close()
    rmSync(root, { recursive: true, force: true })
  })
})
