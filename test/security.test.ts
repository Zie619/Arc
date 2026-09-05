import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GateDef, ProjectConfig } from '../src/types.ts'
import { validatePlan } from '../src/scheduler.ts'
import { dryRunProofs } from '../src/dry-run.ts'
import { Store } from '../src/store.ts'
import * as G from '../src/git.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'arc-security-')); dirs.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const task = { id: 'a', title: 'a', spec: 'a', footprint: ['a.ts'], contractsMutated: ['none'],
  contractsRead: [], dependsOn: [], gates: [],
  acceptance: [{ id: 'c', text: 'proof', proofKind: 'command' as const, requiredTier: 'checked' as const,
    polarity: 'discriminating' as const, proofCommand: 'arc-no-such-command-42' }],
}
const plan = { arcId: 'safe', charter: { goal: 'safe', objectives: [], nonGoals: [] }, tasks: [task] }
const config = (repo: string) => ProjectConfig.parse({ name: 'fixture', repo, landStrategy: 'none',
  roles: { implement: { cli: 'codex', model: 'fixture' } } })

describe('unsafe identifiers never reach git or the filesystem', () => {
  it.each(['../escape', '.', '..', '-option', 'a/b', 'a--b', 'a b', 'a.lock'])('rejects %s as a plan identity', (id) => {
    expect(validatePlan({ ...plan, arcId: id }).length).toBeGreaterThan(0)
    expect(validatePlan({ ...plan, tasks: [{ ...task, id }] }).length).toBeGreaterThan(0)
  })
  it('rejects unsafe cleanup paths before touching git', () => {
    const dir = temp()
    writeFileSync(join(dir, 'sentinel'), 'keep')
    expect(() => G.releaseTaskWorkspace(dir, dir, '..')).toThrow('unsafe workspace')
    expect(() => G.provisionWorktree(dir, dir, 'a/b', 'HEAD')).toThrow('unsafe workspace')
    expect(readFileSync(join(dir, 'sentinel'), 'utf8')).toBe('keep')
  })
  it('rejects duplicate gate identities', () => {
    expect(validatePlan(plan, { gates: [{ name: 'test' }, { name: 'test' }] })).toContain('gate names must be unique')
  })
})

describe('unavailable command isolation fails closed', () => {
  it('defaults to refusal and preserves findings when the OS sandbox is unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.resetModules()
    try {
      const { runGate } = await import('../src/gates.ts')
      const { checkReviewFinding } = await import('../src/finding-check.ts')
      const dir = temp()
      const cfg = config(dir)
      expect(cfg.sandboxPolicy).toBe('refuse')
      const gate = GateDef.parse({ name: 'attack', command: 'echo tampered > proof.txt', proves: 'nothing', readOnly: true })
      const result = await runGate(gate, dir, 'base')
      expect(result.exitCode).toBeNull()
      expect(result.output).toContain('not run')
      const finding = await checkReviewFinding({ file: 'a', line: 1, claim: 'bug', checkCommand: gate.command }, dir, 'base', {
        name: 'review', sandboxPolicy: cfg.sandboxPolicy,
      })
      expect(finding.keep).toBe(true)
      expect(finding.outcome).toBe('could-not-run')
      expect(() => readFileSync(join(dir, 'proof.txt'))).toThrow()
      const optedIn = await runGate(gate, dir, 'base', undefined, { sandboxPolicy: 'caveat' })
      expect(optedIn.pass).toBe(true)
      expect(optedIn.sandboxed).toBe(false)
    } finally { Object.defineProperty(process, 'platform', original); vi.resetModules() }
  })

  it('does not call a missing executable a discriminating proof', async () => {
    const repo = temp()
    G.git(repo, 'init', '-q', '-b', 'main')
    G.git(repo, 'config', 'user.email', 'fixture@example.test')
    G.git(repo, 'config', 'user.name', 'fixture')
    writeFileSync(join(repo, 'README'), 'base')
    G.commitPaths(repo, ['README'], 'base')
    const result = await dryRunProofs(plan, { ...config(repo), sandboxPolicy: 'caveat' }, temp(), G.headSha(repo))
    expect(result.ran).toBe(false)
    expect(result.reason).toContain('could not run')
  })
})

describe('durable state transactions', () => {
  it('rolls back arc creation when a task row cannot be stored', () => {
    const store = new Store(temp())
    try {
      expect(() => store.createArc({ ...plan, tasks: [{ ...task, spec: undefined as any }] }, '/repo', 'base', 'arc/safe'))
        .toThrow()
      expect(store.getArc(plan.arcId)).toBeUndefined()
      expect(store.allTasks(plan.arcId)).toEqual([])
    } finally { store.close() }
  })

  it('loses a lease race when another connection claims after its read', () => {
    const root = temp()
    const a = new Store(root)
    const b = new Store(root)
    a.createArc(plan, '/repo', 'base', 'arc/safe')
    const db = (a as any).db
    const real = db.prepare.bind(db)
    let interrupted = false
    vi.spyOn(db, 'prepare').mockImplementation((...args: unknown[]) => {
      const statement = real(args[0])
      if (!interrupted && String(args[0]).startsWith('SELECT lease_owner')) {
        const get = statement.get.bind(statement)
        statement.get = (...values: unknown[]) => {
          const row = get(...values)
          interrupted = true
          expect(b.claimArc(plan.arcId, 60_000)).toBe(true)
          return row
        }
      }
      return statement
    })
    try {
      expect(a.claimArc(plan.arcId, 60_000)).toBe(false)
      expect(a.getArc(plan.arcId)?.lease_owner).toBe(b.owner)
    } finally { vi.restoreAllMocks(); a.close(); b.close() }
  })

  it('requires an operator note, scopes resolution to its arc, and records the receipt', () => {
    const store = new Store(temp())
    store.createArc(plan, '/repo', 'base', 'arc/safe')
    store.addPendingOp(plan.arcId, 'a', 'external', 'create database', true)
    const op = store.openBlockingOps(plan.arcId)[0]!
    try {
      expect(() => store.resolvePendingOp(plan.arcId, op.id, '')).toThrow('note')
      expect(() => store.resolvePendingOp('other', op.id, 'done')).toThrow('no open operation')
      expect(store.openBlockingOps(plan.arcId)).toHaveLength(1)
      store.resolvePendingOp(plan.arcId, op.id, 'database created and connection tested')
      expect(store.openBlockingOps(plan.arcId)).toEqual([])
      expect(store.eventsSince(plan.arcId, 0).at(-1)?.kind).toBe('pending-op.resolved')
      expect(() => store.resolvePendingOp(plan.arcId, op.id, 'again')).toThrow('no open operation')
    } finally { store.close() }
  })
})
