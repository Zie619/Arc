import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/store.ts'
import { runArc } from '../src/orchestrator.ts'
import { ProjectConfig, type Plan } from '../src/types.ts'
import * as G from '../src/git.ts'

/**
 * Full-orchestrator runs against the fake CLIs. No tokens, no network, and
 * deterministic — which is the only way the run loop itself stays covered.
 */

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
let repo: string
let home: string
let originalPath: string | undefined
const logs: string[] = []
const sandboxUsable = process.platform !== 'darwin' || (() => {
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  originalPath = process.env.PATH
  process.env.PATH = `${FIXTURES}:${originalPath}`
  process.env.ARC_FAKE_WRITE = 'auto'
  process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
    status: 'done', noop: false,
    shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
    criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
  })
  repo = mkdtempSync(join(tmpdir(), 'arcorch-repo-'))
  home = mkdtempSync(join(tmpdir(), 'arcorch-home-'))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@t.t')
  sh(repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  sh(repo, 'add', 'README.md')
  sh(repo, 'commit', '-q', '-m', 'init')
  logs.length = 0
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  delete process.env.ARC_FAKE_WRITE
  delete process.env.ARC_FAKE_PAYLOAD
  delete process.env.ARC_FAKE_QUEUE
  delete process.env.ARC_FAKE_WRITE_AT
  delete process.env.ARC_FAKE_MODEL
  delete process.env.ARC_FAKE_CLAUDE_WRITE
  delete process.env.ARC_CAPACITY_BACKOFF_MS
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function config(over: Partial<any> = {}) {
  return ProjectConfig.parse({
    sandboxPolicy: 'caveat', // Explicitly trusted fixture commands; refusal is covered in security.test.ts.
    name: 'test',
    repo,
    mainBranch: 'main',
    // 'none' by default: a test that is not ABOUT delivery must not silently
    // exercise a push to an origin it never set up. The delivery suite sets its
    // own strategy explicitly, and the arc's status now depends on delivery.
    landStrategy: 'none',
    agentConcurrency: 3,
    heavyGateLimit: 1,
    maxAttempts: 1,
    gates: [{ name: 'always-green', command: 'true', proves: 'nothing, it is a fixture' }],
    roles: {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
    },
    ...over,
  })
}

function task(id: string, over: Partial<any> = {}) {
  return {
    id, title: id, spec: 'do it',
    // Each fixture task declares the file it will actually create. `['.']` is
    // the honest "may touch anything", and it serialises against everything —
    // which is correct, and no use for the parallelism tests.
    dependsOn: [], footprint: [`e2e--${id}-generated.ts`], contractsMutated: ['none'], contractsRead: [],
    gates: ['always-green'],
    // A REAL discriminating proof: it fails at the base commit and passes once
    // the writer has created the file. `proofCommand: 'true'` was vacuous — it
    // passed before the work existed, which is precisely what the dry-run now
    // refuses, and what would otherwise put a green tick beside nothing.
    acceptance: [{
      id: 'c1', text: 'it ran', proofKind: 'command',
      proofCommand: `test -f e2e--${id}-generated.ts`, requiredTier: 'checked',
    }],
    ...over,
  }
}

/**
 * A criterion that is honestly INVARIANT: it holds before and after. For tasks
 * whose fixture writes somewhere other than the default generated file, or
 * writes nothing at all — a discriminating proof about a file that never
 * appears would be a lie, and the dry-run correctly refuses one.
 */
const INVARIANT_CRITERION = [{
  id: 'c1', text: 'the tree still works', proofKind: 'command',
  proofCommand: 'true', polarity: 'invariant', requiredTier: 'checked',
}]

function plan(tasks: any[]): Plan {
  return { arcId: 'e2e', charter: { goal: 'ship it', objectives: [], nonGoals: [] }, tasks } as Plan
}

const log = (l: string) => { logs.push(l); if (process.env.ARC_TEST_VERBOSE) console.log(l) }

describe('run ownership and recovery boundaries', () => {
  it('recovers a task at its original base after a sibling advanced integration', async () => {
    const store = new Store(home)
    const p = plan([task('a'), task('b')])
    const cfg = config()
    const base = G.headSha(repo)
    const integration = 'arc/e2e-integration'
    store.createArc(p, repo, base, integration)
    store.saveRunSnapshot(p.arcId, cfg)
    G.git(repo, 'branch', integration, base)
    const b = G.provisionWorktree(repo, home, 'e2e--b', base)
    writeFileSync(join(b.path, 'partial.txt'), 'keep my committed work')
    G.commitPaths(b.path, ['partial.txt'], 'partial work')
    store.setTaskWorkspace(p.arcId, 'b', b.path, b.branch, base)
    store.setTaskState(p.arcId, 'b', 'running', 90_000)
    const a = G.provisionWorktree(repo, home, 'e2e--a', base)
    writeFileSync(join(a.path, 'e2e--a-generated.ts'), 'export const a = 1\n')
    G.commitPaths(a.path, ['e2e--a-generated.ts'], 'land a')
    expect(G.landBranch(repo, integration, a.branch).ok).toBe(true)
    store.setTaskState(p.arcId, 'a', 'landed')
    const artifact = store.putArtifact(p.arcId, 'criterion-proof', 'a passed')
    store.promoteCriterion(p.arcId, 'a', 'c1', 'checked', 'a passed', artifact)
    try {
      await runArc({ store, plan: p, config: cfg, resume: true, log })
      expect(store.getArc(p.arcId)?.status).toBe('done')
      expect(store.getTask(p.arcId, 'b')?.state).toBe('landed')
      expect(G.git(repo, 'show', `${integration}:partial.txt`)).toBe('keep my committed work')
    } finally { store.close() }
  })

  it('rejects a reviewer that commits changes while claiming to be read-only', async () => {
    const store = new Store(home)
    process.env.ARC_FAKE_CLAUDE_WRITE = 'reviewer-change.ts'
    try {
      await runArc({ store, plan: plan([task('a')]), config: config({ roles: {
        implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write' },
        review: { cli: 'claude', model: 'opus', sandbox: 'read-only' },
      } }), log })
      expect(store.getArc('e2e')?.status).toBe('incomplete')
      expect(store.allTasks('e2e').filter((t) => t.state === 'landed')).toHaveLength(0)
      expect(store.eventsSince('e2e', 0).some((e) => e.kind === 'safety.read-only-violation')).toBe(true)
    } finally { store.close() }
  })

  it('re-probes a changed capability grant and resumes a quarantined task', async () => {
    const store = new Store(home)
    const p = plan([task('a', { needs: [{ capability: 'service', because: 'test fixture' }] })])
    const cfg = config({ capabilities: { service: { probe: 'echo arc-cap-service', elevate: false } } })
    process.env.ARC_FAKE_CAP_LEVEL = 'arc-cap-service=danger-full-access'
    try {
      await runArc({ store, plan: p, config: cfg, log })
      expect(store.getTask(p.arcId, 'a')?.state).toBe('quarantined')
      const granted = { ...cfg, capabilities: { service: { probe: 'echo arc-cap-service', elevate: true } } }
      await runArc({ store, plan: p, config: granted, resume: true, log })
      expect(store.getTask(p.arcId, 'a')?.state).toBe('landed')
      expect(store.getArc(p.arcId)?.status).toBe('done')
    } finally { delete process.env.ARC_FAKE_CAP_LEVEL; store.close() }
  })

  it('does not reuse a previously green criterion after its proof fails', async () => {
    const store = new Store(home)
    const p = plan([task('a', { acceptance: [{ ...INVARIANT_CRITERION[0], proofCommand: 'false' }] })])
    const cfg = config()
    const base = G.headSha(repo)
    store.createArc(p, repo, base, 'arc/e2e-integration')
    store.saveRunSnapshot(p.arcId, cfg)
    G.git(repo, 'branch', 'arc/e2e-integration', base)
    const evidence = store.putArtifact(p.arcId, 'criterion-proof', 'passed on an earlier revision')
    store.promoteCriterion(p.arcId, 'a', 'c1', 'checked', 'earlier proof', evidence)
    try {
      await runArc({ store, plan: p, config: cfg, resume: true, log })
      expect(store.getArc(p.arcId)?.status).toBe('incomplete')
      expect(store.getTask(p.arcId, 'a')?.state).not.toBe('landed')
      expect(store.criteriaFor(p.arcId, 'a')[0]?.tier).toBe('unproven')
    } finally { store.close() }
  })

  it('checks earlier tasks criteria against the final integrated tree', async () => {
    const store = new Store(home)
    const p = plan([
      task('a', { acceptance: [{ ...INVARIANT_CRITERION[0], proofCommand: 'test ! -f e2e--b-generated.ts' }] }),
      task('b', { dependsOn: ['a'] }),
    ])
    try {
      await runArc({ store, plan: p, config: config(), log })
      expect(store.allTasks(p.arcId).filter((t) => t.state === 'landed')).toHaveLength(2)
      expect(store.getArc(p.arcId)?.status).toBe('incomplete')
      expect(logs.join('\n')).toContain('final criterion a/c1')
    } finally { store.close() }
  })

  it('fills a free worker slot while another independent task is still running', async () => {
    const store = new Store(home)
    const p = plan([task('fast'), task('slow', { gates: ['slow'] }), task('next', { dependsOn: ['fast'] })])
    let slowStateAtNext: string | undefined
    try {
      await runArc({ store, plan: p, config: config({ agentConcurrency: 2, gates: [
        { name: 'always-green', command: 'true', proves: 'fixture' },
        { name: 'slow', command: 'sleep 1', proves: 'slow fixture' },
      ] }), log, onTaskResult: (result) => {
        if (result.taskId === 'next') slowStateAtNext = store.getTask(p.arcId, 'slow')?.state
      } })
      expect(['running', 'reviewing', 'landing']).toContain(slowStateAtNext)
      expect(store.getArc(p.arcId)?.status).toBe('done')
    } finally { store.close() }
  })

  it('stops admitting tasks when an unresolved blocking operation needs the operator', async () => {
    const store = new Store(home)
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: false,
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture' }],
      pendingOps: [{ kind: 'external', description: 'provision a test database', blocking: true }],
    })
    try {
      const p = plan([task('a'), task('b')])
      await runArc({ store, plan: p, config: config({ agentConcurrency: 1 }), log })
      expect(store.getArc(p.arcId)?.status).toBe('incomplete')
      expect(store.getTask(p.arcId, 'b')?.state).toBe('pending')
      expect(store.eventsSince(p.arcId, 0).some((event) => event.kind === 'arc.needs-input')).toBe(true)
    } finally { store.close() }
  })

  it('refuses a competing resume before changing any task or event', async () => {
    const owner = new Store(home)
    const contender = new Store(home)
    const p = plan([task('a')])
    const cfg = config()
    const base = G.headSha(repo)
    owner.createArc(p, repo, base, 'arc/e2e-integration')
    owner.saveRunSnapshot(p.arcId, cfg)
    G.git(repo, 'branch', 'arc/e2e-integration', base)
    owner.setTaskState(p.arcId, 'a', 'running', 90_000)
    owner.claimArc(p.arcId, 90_000)
    const events = owner.eventsSince(p.arcId, 0)
    try {
      await runArc({ store: contender, plan: p, config: cfg, resume: true, log })
      expect(owner.getTask(p.arcId, 'a')?.state).toBe('running')
      expect(owner.eventsSince(p.arcId, 0)).toEqual(events)
      expect(owner.getArc(p.arcId)?.lease_owner).toBe(owner.owner)
    } finally { owner.close(); contender.close() }
  })

  it('releases ownership when a proof dry-run refuses the plan', async () => {
    const store = new Store(home)
    const contender = new Store(home)
    try {
      const p = plan([task('a', { acceptance: [{ ...INVARIANT_CRITERION[0], polarity: 'discriminating' }] })])
      await runArc({ store, plan: p, config: config(), log })
      expect(store.getArc(p.arcId)?.status).toBe('incomplete')
      expect(store.getArc(p.arcId)?.lease_owner).toBeNull()
      expect(contender.claimArc(p.arcId, 90_000)).toBe(true)
    } finally { store.close(); contender.close() }
  })

  it('releases ownership on exceptions after acquiring it', async () => {
    const store = new Store(home)
    try {
      await expect(runArc({ store, plan: plan([task('a')]), config: config(), log: (line) => {
        if (line.startsWith('dry-running')) throw new Error('observer crashed')
      } })).rejects.toThrow('observer crashed')
      expect(store.getArc('e2e')?.lease_owner).toBeNull()
    } finally { store.close() }
  })

  it('resets a resumed incomplete run to running before attempting work', async () => {
    const store = new Store(home)
    const p = plan([task('a')])
    const cfg = config()
    const base = G.headSha(repo)
    store.createArc(p, repo, base, 'arc/e2e-integration')
    store.saveRunSnapshot(p.arcId, cfg)
    G.git(repo, 'branch', 'arc/e2e-integration', base)
    store.closeArc(p.arcId, 'incomplete')
    try {
      await expect(runArc({ store, plan: p, config: cfg, resume: true, log: (line) => {
        if (line.startsWith('resuming arc')) {
          expect(store.getArc(p.arcId)?.status).toBe('running')
          expect(store.getArc(p.arcId)?.closed_at).toBeNull()
          throw new Error('resume observed')
        }
      } })).rejects.toThrow('resume observed')
    } finally { store.close() }
  })
})

describe('the orchestrator, end to end', () => {
  it('waits out cheaper-model capacity weather and discards every substituted result', async () => {
    const queue = join(home, 'queue-capacity')
    mkdirSync(queue)
    const payloads = [
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
      },
      { __model: 'claude-haiku-4-5', risks: [{ id: 'impostor-1', text: 'discard me', howToCheck: 'never' }] },
      { __model: 'claude-sonnet-4-6', risks: [{ id: 'impostor-2', text: 'discard me too', howToCheck: 'never' }] },
      { risks: [{ id: 'real', text: 'real risk', howToCheck: 'inspect' }] },
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0,3'
    process.env.ARC_CAPACITY_BACKOFF_MS = '20'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('weather')]), config: config({ landStrategy: 'none', roles }), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(store.eventsSince('e2e', 0).filter((event) => event.kind === 'capacity.wait')).toHaveLength(2)
    const reviews = store.attemptsFor('e2e', 'weather').filter((attempt) => attempt.role === 'review')
    expect(reviews.map((attempt) => attempt.terminal_reason)).toEqual(['model-drift', 'model-drift', 'ok', 'ok'])
    const reviewBrief = store.artifactsFor('e2e', 'brief')
      .map((artifact) => readFileSync(String(store.artifactPath(String(artifact.id))), 'utf8'))
      .find((brief) => brief.includes('# REVIEW'))
    expect(reviewBrief).toContain('real risk')
    expect(reviewBrief).not.toContain('discard me')
    store.close()
  }, 60_000)

  it('fails honestly when the capacity wait budget is exhausted', async () => {
    const queue = join(home, 'queue-capacity-exhausted')
    mkdirSync(queue)
    const payloads = [
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
      },
      { __model: 'claude-haiku-4-5', risks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0,3'
    process.env.ARC_CAPACITY_BACKOFF_MS = '20'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('no-capacity')]), config: config({ landStrategy: 'none', roles, capacityWaitMinutes: 0 }), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(logs.join('\n')).toMatch(/claude.*capacity.*0 minute/i)
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'capacity.exhausted')).toBe(true)
    store.close()
  }, 60_000)

  it('removes commits produced by a substituted implementer before retrying', async () => {
    const queue = join(home, 'queue-capacity-implement')
    mkdirSync(queue)
    const result = {
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }
    writeFileSync(join(queue, '0.json'), JSON.stringify({ ...result, __model: 'claude-haiku-4-5' }))
    writeFileSync(join(queue, '1.json'), JSON.stringify(result))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_CLAUDE_WRITE = 'generated.ts'
    process.env.ARC_FAKE_WRITE_AT = '0,1'
    process.env.ARC_CAPACITY_BACKOFF_MS = '20'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'claude', model: 'opus', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('discard-impostor', { acceptance: INVARIANT_CRITERION })]), config: config({ landStrategy: 'none', roles }), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(sh(repo, 'show', 'arc/e2e-integration:generated.ts')).toContain('x = 2')
    expect(sh(repo, 'rev-list', '--count', `${sh(repo, 'rev-parse', 'main')}..arc/e2e-integration`)).toBe('1')
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'capacity.discard')).toBe(true)
    store.close()
  }, 60_000)

  it('refuses wave one when preflight observes a cheaper substitute without supervision', async () => {
    // Preflight is read-only. The fake writer must not edit before its actual
    // implementation turn, or the mutation guard correctly refuses it first.
    delete process.env.ARC_FAKE_WRITE
    const queue = join(home, 'queue-preflight-refusal')
    mkdirSync(queue)
    writeFileSync(join(queue, '0.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({ __model: 'claude-haiku-4-5', ok: true }))
    process.env.ARC_FAKE_QUEUE = queue
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('not-started')]),
      config: config({ landStrategy: 'none', roles }), log, preflight: true,
    })

    expect(store.getArc('e2e')?.status).toBe('incomplete')
    expect(store.allTasks('e2e')[0]!.state).toBe('pending')
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'preflight.refused')).toBe(true)
    expect(store.attemptsFor('e2e', 'not-started')).toHaveLength(0)
    store.close()
  }, 60_000)

  it('waits for the requested model during supervised preflight', async () => {
    const queue = join(home, 'queue-preflight-wait')
    mkdirSync(queue)
    const payloads = [
      { __model: 'claude-haiku-4-5', ok: true },
      { ok: true },
      { status: 'done', noop: true, noopReason: 'preflight recovered' },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_CAPACITY_BACKOFF_MS = '20'
    delete process.env.ARC_FAKE_PAYLOAD
    delete process.env.ARC_FAKE_WRITE

    const roles = {
      implement: { cli: 'claude', model: 'opus', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('starts-after-wait', { acceptance: INVARIANT_CRITERION })]),
      config: config({ landStrategy: 'none', roles }), log,
      preflight: true, waitForPreflightCapacity: true,
    })

    expect(store.getArc('e2e')?.status).toBe('done')
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'capacity.wait' && event.taskId === null)).toBe(true)
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    store.close()
  }, 60_000)

  it('runs two independent tasks IN PARALLEL and lands both', async () => {
    const store = new Store(home)
    const products: any[] = []
    await runArc({
      store, plan: plan([task('alpha'), task('beta')]), config: config(), log,
      onTaskResult: result => products.push(result),
    })

    expect(logs.join('\n')).toContain('2 tasks in parallel')
    const states = store.allTasks('e2e').map((t) => t.state)
    expect(states).toEqual(['landed', 'landed'])
    expect(store.getArc('e2e')?.status).toBe('done')
    expect(products.map((result) => result.taskId).sort()).toEqual(['alpha', 'beta'])
    expect(products.every((result) => result.shipped[0]?.whatChanged === 'created')).toBe(true)
    expect(store.eventsSince('e2e', 0).filter((event) => event.kind === 'task.result')).toHaveLength(2)
    store.close()
  }, 60_000)

  it('SERIALISES two tasks that mutate the same contract', async () => {
    // Disjoint files, same exported symbol — the case per-branch CI is green
    // against by construction.
    const store = new Store(home)
    await runArc({
      store,
      plan: plan([
        task('one', { footprint: ['a.ts'], contractsMutated: ['SharedType'] }),
        task('two', { footprint: ['b.ts'], contractsMutated: ['SharedType'] }),
      ]),
      config: config(),
      log,
    })
    expect(logs.join('\n')).not.toContain('in parallel')
    expect(store.allTasks('e2e').map((t) => t.state)).toEqual(['landed', 'landed'])
    store.close()
  }, 60_000)

  it('accepts a genuine no-op ONLY when its criteria still hold', async () => {
    // "I did nothing, because X" must be a first-class successful answer, or
    // agents invent work to avoid looking idle. It still has to be graded.
    delete process.env.ARC_FAKE_WRITE
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: true, noopReason: 'already correct',
    })
    const store = new Store(home)
    await runArc({ store, plan: plan([task('nothing-to-do', { acceptance: INVARIANT_CRITERION })]), config: config(), log })
    expect(logs.join('\n')).toContain('accepted as a no-op')
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    store.close()
  }, 60_000)

  it('REJECTS a no-op whose criteria cannot be proved', async () => {
    delete process.env.ARC_FAKE_WRITE
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: true, noopReason: 'claiming nothing needed',
    })
    const store = new Store(home)
    await runArc({
      store,
      // proof command fails, so the criterion cannot reach `checked`
      plan: plan([task('lying', {
        acceptance: [{ id: 'c1', text: 'must hold', proofKind: 'command', proofCommand: 'false', requiredTier: 'checked' }],
      })]),
      config: config(), log,
    })
    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    store.close()
  }, 60_000)

  it('refuses to start when the repo has tracked modifications', async () => {
    writeFileSync(join(repo, 'README.md'), 'dirty\n')
    const store = new Store(home)
    await expect(runArc({ store, plan: plan([task('x')]), config: config(), log }))
      .rejects.toThrow(/uncommitted TRACKED changes/)
    store.close()
  })

  it('skips integration review when every task failed and includes the bill', async () => {
    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      integrate: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({
      store,
      plan: plan([task('all-red', { gates: ['red'] })]),
      config: config({ landStrategy: 'none', roles, gates: [{ name: 'red', command: 'false', proves: 'forced failure' }] }),
      log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'attempt.start' &&
      (event.payload as { role: string }).role === 'integrate')).toBe(false)
    expect(logs.join('\n')).toContain('nothing landed — skipping integration review')
    expect(logs.join('\n')).toContain('token bill — provider receipts')
    store.close()
  }, 60_000)

  it('leaves no worktree or branch behind after a landed task, so it can re-run', async () => {
    const store = new Store(home)
    await runArc({ store, plan: plan([task('reruns')]), config: config(), log })
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    // The task branch is gone; only the integration branch survives.
    expect(G.gitOk(repo, 'rev-parse', '--verify', 'arc/reruns^{commit}')).toBe(false)
    store.close()
  }, 60_000)

  it('resume requeues a task stranded mid-flight by a crash', async () => {
    const store = new Store(home)
    const p = plan([task('stranded')])
    const frozenConfig = config({ landStrategy: 'none' })
    // Simulate a process killed while the task was running.
    store.createArc(p, repo, sh(repo, 'rev-parse', 'main'), 'arc/e2e-integration')
    store.saveRunSnapshot('e2e', frozenConfig)
    store.setTaskState('e2e', 'stranded', 'running', 60_000)

    // Resume must ignore both a changed caller plan and changed caller config.
    const changed = plan([task('wrong-task')])
    await runArc({
      store, plan: changed,
      config: config({ mainBranch: 'does-not-exist', maxAttempts: 9 }),
      log, resume: true,
    })

    expect(logs.join('\n')).toContain('requeueing, keeping its branch')
    expect(store.allTasks('e2e').map((row) => row.id)).toEqual(['stranded'])
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    store.close()
  }, 60_000)

  it('resume sees a task that already landed and does not rebuild it', async () => {
    const store = new Store(home)
    const p = plan([task('half-landed')])
    const base = sh(repo, 'rev-parse', 'main')
    // landTask merges, THEN writes the state. A crash in that window leaves the
    // row saying "landing" over work the integration branch already carries —
    // and rebuilding it means rebasing a change onto itself, which conflicts,
    // which reports a task that genuinely LANDED as failed.
    const landedSha = sh(repo, 'commit-tree', sh(repo, 'rev-parse', 'main^{tree}'), '-p', base, '-m', 'landed work')
    sh(repo, 'branch', 'arc/e2e-integration', landedSha)
    store.createArc(p, repo, base, 'arc/e2e-integration')
    store.saveRunSnapshot('e2e', config())
    store.setTaskHead('e2e', 'half-landed', landedSha, [])
    store.setTaskState('e2e', 'half-landed', 'landing', 60_000)

    await runArc({ store, plan: p, config: config(), log, resume: true })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(logs.join('\n')).toContain('it landed')
    expect(logs.join('\n')).not.toContain('releasing and requeueing')
    expect(store.attemptsFor('e2e', 'half-landed')).toHaveLength(0)
    store.close()
  }, 60_000)

  it('resume keeps the writer\'s commits instead of rebuilding from attempt one', async () => {
    const store = new Store(home)
    const p = plan([task('crashed')])
    const base = sh(repo, 'rev-parse', 'main')
    store.createArc(p, repo, base, 'arc/e2e-integration')
    store.saveRunSnapshot('e2e', config())
    sh(repo, 'branch', 'arc/e2e-integration', base)

    // Simulate a process killed mid-task with work already committed.
    const wt = G.provisionWorktree(repo, store.root, 'e2e--crashed', base)
    writeFileSync(join(wt.path, 'half-done.ts'), 'export const x = 1\n')
    sh(wt.path, 'add', '-A')
    sh(wt.path, '-c', 'user.email=f@f.f', '-c', 'user.name=fake', 'commit', '-q', '-m', 'partial work')
    const rescued = sh(wt.path, 'rev-parse', 'HEAD')
    store.setTaskState('e2e', 'crashed', 'reviewing', 60_000)

    await runArc({ store, plan: p, config: config(), log, resume: true })

    // The commit survived. Before this, resume force-deleted the branch, so a
    // task in `reviewing` — committed work, passing gates, possibly a finished
    // review — started over from nothing on every relaunch.
    expect(logs.join('\n')).toContain('RECOVERED with')
    // The sha changes — landing rebases and stamps task trailers — so assert on
    // the WORK, which is the thing that used to be deleted.
    expect(sh(repo, 'log', '--format=%s', 'arc/e2e-integration')).toContain('partial work')
    expect(sh(repo, 'show', `arc/e2e-integration:half-done.ts`)).toBe('export const x = 1')
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    void rescued
    store.close()
  }, 60_000)

  it('blocks a task when either review call runs on the wrong model', async () => {
    const queue = join(home, 'queue-model-drift')
    mkdirSync(queue)
    writeFileSync(join(queue, '0.json'), JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({
      risks: [{ id: 'r1', text: 'risk', howToCheck: 'inspect' }],
    }))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0'
    process.env.ARC_FAKE_MODEL = 'claude-unknown-1'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('drift')]), config: config({ landStrategy: 'none', roles }), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(store.attemptsFor('e2e', 'drift').some((attempt) => attempt.terminal_reason === 'model-drift')).toBe(true)
    expect(logs.join('\n')).toContain('MODEL DRIFT in risk prediction')
    store.close()
  }, 60_000)

  it.skipIf(!sandboxUsable)('runs reviewer checkCommand and attaches its output to the exact finding', async () => {
    const queue = join(home, 'queue-review-check')
    mkdirSync(queue)
    const payloads = [
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
      },
      { risks: [{ id: 'r1', text: 'risk', howToCheck: 'run a command' }] },
      {
        verdict: 'PASS_WITH_NOTES',
        findings: [{
          severity: 'minor', file: 'generated.ts', line: 1,
          claim: 'the generated file exists', failureScenario: 'missing file',
          suggestedFix: null, checkCommand: 'test -f generated.ts',
        }],
        criteriaAssessment: [{ id: 'c1', met: true, evidence: 'command proof already ran' }],
        seamRisks: [],
      },
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0'
    // The checkCommand names this exact file; "auto" would write a worktree-unique one.
    process.env.ARC_FAKE_WRITE = 'generated.ts'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
      integrate: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('review-check')]), config: config({ landStrategy: 'none', roles }), log })

    const finding = store.findingsFor('e2e').find((row) => row.kind === 'review')
    expect(finding).toBeDefined()
    expect(store.evidenceForFinding(String(finding!.id))).toMatchObject([{ verdict: 'pass', exit_code: 0 }])
    expect(store.gatesFor('e2e', 'review-check').some((gate) => String(gate.name).startsWith('review:'))).toBe(true)
    store.close()
  }, 60_000)

  it('prepares each worktree with setupCommand and fails the task fast when setup fails', async () => {
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('needs-env')]),
      config: config({ setupCommand: 'echo simulated dependency failure; false' }), log,
    })
    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    const setupGate = store.gatesFor('e2e', 'needs-env').find((gate) => gate.name === 'worktree-setup')
    expect(setupGate?.verdict).toBe('fail')
    // No agent was dispatched into a worktree that cannot run project checks.
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'attempt.start' &&
      (event.payload as { role: string }).role === 'implement')).toBe(false)
    store.close()
  }, 60_000)

  it('runs setupCommand in the worktree before the writer, and still lands', async () => {
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('setup-ok')]),
      config: config({ setupCommand: 'touch setup-ran.marker' }), log,
    })
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    const setupGate = store.gatesFor('e2e', 'setup-ok').find((gate) => gate.name === 'worktree-setup')
    expect(setupGate?.verdict).toBe('pass')
    store.close()
  }, 60_000)

  it('commits post-implement refresh output before gates inspect it', async () => {
    const store = new Store(home)
    await runArc({
      store,
      plan: plan([task('refreshes', { gates: ['refreshed'] })]),
      config: config({
        landStrategy: 'none',
        refreshCommands: [{ name: 'generated-types', command: "printf 'fresh\\n' > refreshed.txt" }],
        gates: [{ name: 'refreshed', command: "test \"$(cat refreshed.txt)\" = fresh && git diff --quiet", proves: 'refresh output is committed' }],
      }),
      log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(sh(repo, 'log', '--format=%s', 'arc/e2e-integration')).toContain('refresh: generated-types')
    expect(sh(repo, 'show', 'arc/e2e-integration:refreshed.txt')).toBe('fresh')
    expect(store.gatesFor('e2e', 'refreshes').some((gate) => gate.name === 'refresh:generated-types' && gate.verdict === 'pass')).toBe(true)
    store.close()
  }, 60_000)

  it('feeds a named refresh failure and its output into the next attempt', async () => {
    const queue = join(home, 'queue-refresh-failure')
    mkdirSync(queue)
    const payload = {
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }
    writeFileSync(join(queue, '0.json'), JSON.stringify(payload))
    writeFileSync(join(queue, '1.json'), JSON.stringify(payload))
    process.env.ARC_FAKE_QUEUE = queue
    delete process.env.ARC_FAKE_PAYLOAD

    const store = new Store(home)
    await runArc({
      store, plan: plan([task('refresh-fails')]),
      config: config({
        landStrategy: 'none', maxAttempts: 2,
        refreshCommands: [{ name: 'db-types', command: 'echo docker daemon unavailable; false' }],
      }),
      log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    const briefs = store.artifactsFor('e2e', 'brief').map((artifact) =>
      readFileSync(String(store.artifactPath(String(artifact.id))), 'utf8'))
    expect(briefs[0]).toContain('db-types')
    expect(briefs[0]).toContain('docker daemon unavailable')
    store.close()
  }, 60_000)

  it('a passing harness-executed proof outranks a modest claim', async () => {
    // A sandboxed writer that cannot run the proof honestly claims
    // 'unproven' — but the harness DID run it and it passed. The evidence
    // decides, not the humility. (Observed live: a green 334-test proof
    // discarded because the claim was 'unproven'.)
    delete process.env.ARC_FAKE_PAYLOAD
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'unproven', evidence: 'my sandbox could not execute the proof' }],
    })
    const store = new Store(home)
    await runArc({ store, plan: plan([task('modest')]), config: config(), log })
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(store.allCriteria('e2e').find((row: any) => row.id === 'c1')?.tier).toBe('checked')
    store.close()
  }, 60_000)

  it('proves an unclaimed command criterion by running it, instead of leaving it unproven', async () => {
    // The fixture claims only c1; c2 goes unclaimed — as a sandboxed writer
    // that cannot run the proof itself honestly does. Arc runs it anyway.
    delete process.env.ARC_FAKE_PAYLOAD
    process.env.ARC_FAKE_PAYLOAD = JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    })
    const store = new Store(home)
    await runArc({
      store,
      plan: plan([task('unclaimed', {
        acceptance: [
          { id: 'c1', text: 'it ran', proofKind: 'command', proofCommand: 'true', polarity: 'invariant', requiredTier: 'checked' },
          // Discriminating and honest: no generated file exists at base.
          { id: 'c2', text: 'the generated file exists', proofKind: 'command', proofCommand: 'test -n "$(echo *-generated.ts)" && test -f $(echo *-generated.ts)', requiredTier: 'checked' },
        ],
      })]),
      config: config(), log,
    })
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    const c2 = store.allCriteria('e2e').find((row: any) => row.id === 'c2')
    expect(c2?.tier).toBe('checked')
    store.close()
  }, 60_000)

  it('rejects a no-op claim when the worktree already holds committed work', async () => {
    // Attempt 1 commits real work, its gate fails, and the retry then claims
    // "no change needed". Accepting that marked the task landed while the
    // commits sat abandoned in the worktree — observed live in the self-arc.
    const queue = join(home, 'queue-false-noop')
    mkdirSync(queue)
    writeFileSync(join(queue, '0.json'), JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({
      status: 'done', noop: true, noopReason: 'already committed on this branch',
    }))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0'
    delete process.env.ARC_FAKE_PAYLOAD

    const store = new Store(home)
    await runArc({
      store,
      plan: plan([task('false-noop', { gates: ['always-red'] })]),
      config: config({
        maxAttempts: 2,
        gates: [{ name: 'always-red', command: 'false', proves: 'forces a retry' }],
      }),
      log,
    })
    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(store.findingsFor('e2e').some((row) => String(row.text).includes('no-op claim rejected'))).toBe(true)
    store.close()
  }, 60_000)

  it('records post-rebase regate runs without forging an attempt id', async () => {
    const store = new Store(home)
    await runArc({ store, plan: plan([task('regate')]), config: config(), log })
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    const gates = store.gatesFor('e2e', 'regate')
    // The regate is not tied to an attempt; a made-up id would corrupt every
    // attempt-joined query.
    expect(gates.some((gate) => gate.attempt_id === null)).toBe(true)
    expect(gates.every((gate) => gate.attempt_id !== 'rebase-regate')).toBe(true)
    store.close()
  }, 60_000)

  it('fails only the crashing task while its parallel sibling still lands', async () => {
    class Exploding extends Store {
      setTaskWorkspace(arcId: string, taskId: string, wt: string, branch: string, baseSha: string): void {
        if (taskId === 'boom') throw new Error('kaboom: injected workspace-row failure')
        super.setTaskWorkspace(arcId, taskId, wt, branch, baseSha)
      }
    }
    const store = new Exploding(home)
    await runArc({ store, plan: plan([task('boom'), task('steady')]), config: config(), log })

    const states = Object.fromEntries(store.allTasks('e2e').map((t) => [t.id, t.state]))
    expect(states.boom).toBe('failed')
    expect(states.steady).toBe('landed')
    expect(store.eventsSince('e2e', 0).some((event) => event.kind === 'task.crashed')).toBe(true)
    store.close()
  }, 60_000)

  it('releases the integration-review worktree even when the review path throws', async () => {
    const queue = join(home, 'queue-leak')
    mkdirSync(queue)
    writeFileSync(join(queue, '0.json'), JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({
      verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [],
    }))
    process.env.ARC_FAKE_QUEUE = queue
    delete process.env.ARC_FAKE_PAYLOAD

    class Exploding extends Store {
      appendEvent(arcId: string, kind: string, payload: unknown, taskId?: string | null, attemptId?: string | null): number {
        if (kind === 'integration.verdict') throw new Error('disk full: injected store failure')
        return super.appendEvent(arcId, kind, payload, taskId, attemptId)
      }
    }
    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      integrate: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Exploding(home)
    await expect(runArc({
      store, plan: plan([task('leaky')]),
      config: config({ landStrategy: 'none', roles }), log,
    })).rejects.toThrow('disk full')

    // The throw must not leak the review branch or worktree — a leak would
    // fail-close every future integration review of this arc.
    expect(G.gitOk(repo, 'rev-parse', '--verify', 'arc/e2e-integration-review^{commit}')).toBe(false)
    expect(sh(repo, 'worktree', 'list')).not.toContain('integration-review')
    store.close()
  }, 60_000)

  it('keeps steering PENDING when the attempt it was compiled into is cancelled', async () => {
    const store = new Store(home)
    store.addIntervention({ threadId: 'th-1', kind: 'steer', text: 'prefer the small fix', arcId: 'e2e' })
    process.env.ARC_FAKE_HANG = '1'
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 800)
    try {
      await runArc({
        store, plan: plan([task('steered')]),
        config: config({ landStrategy: 'none' }), log, signal: ctrl.signal,
      })
    } finally {
      delete process.env.ARC_FAKE_HANG
    }
    // The brief contained the steering, but no attempt ran to completion on
    // it — marking it applied here is exactly how steering used to vanish.
    expect(store.pendingInterventionsForArc('e2e', 'steer')).toHaveLength(1)
    store.close()
  }, 60_000)

  it('marks steering applied once an attempt actually completes on it', async () => {
    const store = new Store(home)
    store.addIntervention({ threadId: 'th-1', kind: 'steer', text: 'prefer the small fix', arcId: 'e2e' })
    await runArc({ store, plan: plan([task('steered-ok')]), config: config({ landStrategy: 'none' }), log })
    // Tier-0 inclusion of pending steering is covered in design.test.ts; this
    // proves the applied flip happens exactly once an attempt completes.
    expect(store.pendingInterventionsForArc('e2e', 'steer')).toHaveLength(0)
    store.close()
  }, 60_000)

  it('refuses to call the arc complete when whole-integration review rejects it', async () => {
    const queue = join(home, 'queue')
    mkdirSync(queue)
    writeFileSync(join(queue, '0.json'), JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({
      verdict: 'REJECT',
      findings: [{
        severity: 'critical', file: 'generated.ts', line: 1,
        claim: 'the combined result violates the charter',
        failureScenario: 'the integration branch is consumed as complete',
        suggestedFix: null, checkCommand: null,
      }],
      criteriaAssessment: [], seamRisks: ['charter coverage'],
    }))
    process.env.ARC_FAKE_QUEUE = queue
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      integrate: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('integration-reject')]),
      config: config({ landStrategy: 'none', roles }), log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(store.getArc('e2e')?.status).toBe('incomplete')
    expect(logs.join('\n')).toContain('INTEGRATION REVIEW DID NOT PASS')
    expect(logs.join('\n')).not.toContain('COMPLETE — every criterion')
    store.close()
  }, 60_000)
})

describe('the gate surface is not the writer\'s to move', () => {
  it('lets a task ADD tests, because in a test-first repo that is every task', async () => {
    // This used to fail. The check could not tell "wrote the tests for this
    // feature" from "deleted the tests that were failing", so a repo whose
    // method is test-first had to declare touchesGateSurface on every single
    // task — a control waived every time is a control switched off.
    process.env.ARC_FAKE_WRITE = 'thing.test.ts'
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('adds-tests', { acceptance: INVARIANT_CRITERION })]),
      config: config(), log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(logs.join('\n')).not.toContain('protected gate-surface path')
    store.close()
  }, 60_000)

  it('refuses a task that REMOVES lines from a test file', async () => {
    // Deleting a test, and hollowing out an assertion, are both deletions —
    // and the second is invisible to testsExecuted, because the count does not
    // change when `expect(x).toBe(1)` becomes `expect(true).toBe(true)`.
    writeFileSync(join(repo, 'thing.test.ts'), [
      "import { expect, it } from 'vitest'",
      "it('a', () => expect(compute(1)).toBe(2))",
      "it('b', () => expect(compute(2)).toBe(4))",
      "it('c', () => expect(compute(3)).toBe(6))",
    ].join('\n') + '\n')
    sh(repo, 'add', 'thing.test.ts')
    sh(repo, 'commit', '-q', '-m', 'seed tests')

    process.env.ARC_FAKE_WRITE = 'thing.test.ts'   // overwrites it with one line
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('guts-tests', { acceptance: INVARIANT_CRITERION })]),
      config: config(), log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(logs.join('\n')).toContain('line(s) removed')
    // The work is a declaration problem, not lost work — say so, rather than
    // leaving the operator to discover the branch was salvageable.
    expect(logs.join('\n')).toContain('The work is not lost')
    store.close()
  }, 60_000)

  it('allows the removal when the task declares WHY, and records the exception', async () => {
    writeFileSync(join(repo, 'thing.test.ts'), 'a\nb\nc\nd\n')
    sh(repo, 'add', 'thing.test.ts')
    sh(repo, 'commit', '-q', '-m', 'seed tests')
    process.env.ARC_FAKE_WRITE = 'thing.test.ts'
    const store = new Store(home)
    const p = plan([{
      ...task('honest', { acceptance: INVARIANT_CRITERION }),
      touchesGateSurface: 'this task rewrites the importer tests around the new API',
    }])
    await runArc({ store, plan: p, config: config(), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(store.findingsFor('e2e').some((f) =>
      String(f.text).includes('rewrites the importer tests'))).toBe(true)
    store.close()
  }, 60_000)

  it('still refuses ANY change to runner or CI config', async () => {
    // Different surface, different rule: nobody edits vitest.config or a
    // workflow file as part of shipping a feature, so any touch is blocking.
    process.env.ARC_FAKE_WRITE = 'vitest.config.ts'
    const store = new Store(home)
    await runArc({
      store, plan: plan([task('retunes', { acceptance: INVARIANT_CRITERION })]),
      config: config(), log,
    })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(logs.join('\n')).toContain('protected gate-surface path')
    store.close()
  }, 60_000)

  it('refuses a green gate that ran fewer tests than the baseline', async () => {
    // Both runs EXIT 0. `result.pass` short-circuits every baseline comparison,
    // so nothing else in the system can see that two proofs disappeared.
    const store = new Store(home)
    const countingGate = {
      name: 'suite',
      command: 'if ls *-generated.ts >/dev/null 2>&1; then echo "Tests  5 passed (5)"; else echo "Tests  7 passed (7)"; fi',
      proves: 'the suite is green',
      baselineSubset: true,
    }
    await runArc({
      store, plan: plan([{ ...task('alpha'), gates: ['suite'] }]),
      config: config({ gates: [countingGate] }), log,
    })

    expect(logs.join('\n')).toContain('2 fewer test(s) than baseline')
    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    store.close()
  }, 60_000)

  it('rewriting package.json scripts is gate surface even though package.json is not', async () => {
    // package.json is deliberately unprotected by path — every dependency bump
    // touches it. `scripts.test = echo ok` is the attack, and only a content
    // comparison sees it.
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }, null, 2))
    sh(repo, 'add', 'package.json')
    sh(repo, 'commit', '-q', '-m', 'add package.json')
    process.env.ARC_FAKE_WRITE = 'package.json'
    const store = new Store(home)
    await runArc({ store, plan: plan([task('rewrite')]), config: config(), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(logs.join('\n')).toContain('protected gate-surface path')
    store.close()
  }, 60_000)
})

describe('CHANGES_REQUIRED buys a repair round, not a burial', () => {
  it('feeds the findings back to the writer once, re-reviews, and lands', async () => {
    // A real overnight run died with a PERFECT review naming exactly what to
    // fix (a missing INSERT policy) — and a writer who never got to see it.
    const queue = join(home, 'queue-repair-round')
    mkdirSync(queue)
    const payloads = [
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
      },
      { risks: [{ id: 'r1', text: 'risk', howToCheck: 'look' }] },
      {
        verdict: 'CHANGES_REQUIRED',
        findings: [{
          severity: 'critical', file: 'generated.ts', line: 1,
          claim: 'no INSERT policy on the new table', failureScenario: 'users cannot write',
          suggestedFix: 'add the policy',
        }],
        criteriaAssessment: [], seamRisks: [],
      },
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'added the policy' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran again' }],
      },
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0,3'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('fix-me')]), config: config({ landStrategy: 'none', roles }), log })

    const out = logs.join('\n')
    expect(out).toContain('review requires changes — one repair round with 1 finding(s)')
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    // The repair brief carried the reviewer's finding verbatim.
    const briefs = store.artifactsFor('e2e', 'brief')
    const { readFileSync: rf } = await import('node:fs')
    const texts = briefs.map((b) => rf(String(store.artifactPath(String(b.id))), 'utf8'))
    expect(texts.some((t) => t.includes('no INSERT policy on the new table'))).toBe(true)
    store.close()
  }, 60_000)

  it('lands after repair when the second review has only minor findings and scopes the brief to the fix', async () => {
    const queue = join(home, 'queue-repair-minor')
    mkdirSync(queue)
    const payloads = [
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
      },
      { risks: [{ id: 'r1', text: 'risk', howToCheck: 'look' }] },
      {
        verdict: 'CHANGES_REQUIRED',
        findings: [{ severity: 'major', file: 'generated.ts', line: 1, claim: 'needs a repair', failureScenario: 'breaks', suggestedFix: 'repair it' }],
        criteriaAssessment: [], seamRisks: [],
      },
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'repaired' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran again' }],
      },
      {
        verdict: 'CHANGES_REQUIRED',
        findings: [{ severity: 'minor', file: 'generated.ts', line: 1, claim: 'small note remains', failureScenario: 'cosmetic', suggestedFix: null }],
        criteriaAssessment: [], seamRisks: [],
      },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0,3'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('minor-after-repair')]), config: config({ landStrategy: 'none', roles }), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    expect(store.findingsFor('e2e').some((finding) => String(finding.text).includes('small note remains'))).toBe(true)
    const briefs = store.artifactsFor('e2e', 'brief').map((artifact) =>
      readFileSync(String(store.artifactPath(String(artifact.id))), 'utf8'))
    const repairReview = briefs.find((brief) => brief.includes('# REPAIR REVIEW'))
    expect(repairReview).toContain('CHANGES_REQUIRED')
    expect(repairReview).toContain('needs a repair')
    expect(repairReview).toContain('diff --git')
    store.close()
  }, 60_000)

  it('fails after repair when the second review retains a critical finding', async () => {
    const queue = join(home, 'queue-repair-critical')
    mkdirSync(queue)
    const baseResult = {
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'changed' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
    }
    const payloads = [
      baseResult,
      { risks: [] },
      { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'major', file: 'generated.ts', line: 1, claim: 'repair me', failureScenario: 'breaks', suggestedFix: 'fix' }], criteriaAssessment: [], seamRisks: [] },
      baseResult,
      { verdict: 'PASS_WITH_NOTES', findings: [{ severity: 'critical', file: 'generated.ts', line: 1, claim: 'still unsafe', failureScenario: 'data loss', suggestedFix: 'fix' }], criteriaAssessment: [], seamRisks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0,3'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('critical-after-repair')]), config: config({ landStrategy: 'none', roles }), log })

    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    expect(logs.join('\n')).toContain('critical')
    store.close()
  }, 60_000)
})

describe('a slow review does not bury a green task', () => {
  it('retries the review once after a hard timeout, then lands', async () => {
    const queue = join(home, 'queue-slow-review')
    mkdirSync(queue)
    const payloads = [
      {
        status: 'done', noop: false,
        shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
        criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture ran' }],
      },
      { risks: [{ id: 'r1', text: 'risk', howToCheck: 'run a command' }] },
      { __hang: 8 },   // the review itself dies on the clock…
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },   // …and the retry answers
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0'
    delete process.env.ARC_FAKE_PAYLOAD

    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 2500, stallMs: 2500 },
    }
    const store = new Store(home)
    await runArc({ store, plan: plan([task('slow-review')]), config: config({ landStrategy: 'none', roles }), log })

    expect(logs.join('\n')).toContain('review gets one more try')
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
    const reviews = store.attemptsFor('e2e', 'slow-review').filter((a) => a.role === 'review' && a.attempt_no >= 1)
    expect(reviews.map((a) => a.terminal_reason)).toEqual(['hard-timeout', 'ok'])
    store.close()
  }, 60_000)
})

describe('the retry loop refuses to burn attempts on a failure that never changes', () => {
  it('stops when a failure repeats — even interleaved with a flake and with noise reordered', async () => {
    // The exact anatomy of a real run: lint failure → transient 502 →
    // the SAME lint failure with the provider's warning lines in a
    // different order. Consecutive byte-comparison never fires on that.
    const counter = join(home, 'gate-count')
    const gate = [
      `C=${counter}; n=$(cat $C 2>/dev/null || echo 0); echo $((n+1)) > $C;`,
      `if [ "$n" = "1" ]; then echo "Error status 502: invalid response from upstream";`,
      `elif [ "$n" = "0" ]; then printf "WARN: unset GOOGLE\\nWARN: unset APPLE\\nlint error: operator does not exist\\nfail-on error\\n";`,
      `else printf "WARN: unset APPLE\\nWARN: unset GOOGLE\\nlint error: operator does not exist\\nfail-on error\\n"; fi; exit 1`,
    ].join(' ')
    const store = new Store(home)
    await runArc({
      store,
      plan: plan([task('t-lint', { gates: ['flaky-lint'] })]),
      config: config({
        maxAttempts: 4, landStrategy: 'none',
        gates: [{ name: 'flaky-lint', command: gate, proves: 'a fixture failure that never changes' }],
      }),
      log,
    })
    const out = logs.join('\n')
    expect(out).toContain("identical to attempt 1's")
    expect(out).toContain('GATE or its environment')
    expect(store.allTasks('e2e')[0]!.state).toBe('failed')
    // Three gate runs, not four: the fourth attempt was refused as waste.
    expect(readFileSync(counter, 'utf8').trim()).toBe('3')
    store.close()
  }, 60_000)
})

describe('delivery leaves ZERO local residue', () => {
  // A completed arc must not cost the operator gigabytes of worktrees and
  // branches — the work lives in the PR (or main), or it is not delivered.
  let bare: string
  let ghDir: string

  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'arcorch-bare-'))
    sh(bare, 'init', '-q', '--bare', '-b', 'main')
    sh(repo, 'remote', 'add', 'origin', bare)
    ghDir = mkdtempSync(join(tmpdir(), 'arcorch-gh-'))
    process.env.PATH = `${ghDir}:${process.env.PATH}`
  })
  afterEach(() => {
    rmSync(bare, { recursive: true, force: true })
    rmSync(ghDir, { recursive: true, force: true })
  })
  const fakeGh = (script: string) => {
    writeFileSync(join(ghDir, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  }

  it('pr: pushes the branch, prints the PR URL, and removes every local arc ref', async () => {
    fakeGh('echo https://example.test/pr/1')
    const store = new Store(home)
    await runArc({ store, plan: plan([task('shipit')]), config: config({ landStrategy: 'pr' }), log })

    expect(logs.join('\n')).toContain('https://example.test/pr/1')
    expect(logs.join('\n')).toContain('zero local residue')
    // The remote holds the work; the local checkout holds NOTHING arc-shaped.
    expect(sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/arc/')).toBe('arc/e2e-integration')
    expect(sh(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/arc/')).toBe('')
    expect(sh(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
    store.close()
  }, 60_000)

  it('pr: when gh fails, the branch survives locally and the failure is loud', async () => {
    fakeGh('echo "gh exploded" >&2; exit 1')
    const store = new Store(home)
    await runArc({ store, plan: plan([task('shipit')]), config: config({ landStrategy: 'pr' }), log })

    expect(logs.join('\n')).toContain('gh pr create failed')
    // No PR exists, so deleting the local branch would orphan the work.
    expect(sh(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/arc/')).toBe('arc/e2e-integration')
    store.close()
  }, 60_000)

  it('push: after landing on main and pushing, the integration branch is gone', async () => {
    const store = new Store(home)
    await runArc({ store, plan: plan([task('shipit')]), config: config({ landStrategy: 'push' }), log })

    expect(logs.join('\n')).toContain('zero local residue')
    expect(sh(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/arc/')).toBe('')
    // "push" means the REMOTE's main has the work. Landing locally first meant
    // checking out main — usually THE checked-out branch — and hoping to restore
    // afterwards. The operator's checkout is now never touched, so local main
    // stays where they left it and the delivery still happened.
    expect(sh(bare, 'rev-parse', 'main')).not.toBe(sh(repo, 'rev-parse', 'main'))
    expect(logs.join('\n')).toContain(`local "main" left alone`)
    store.close()
  }, 60_000)

  it('push: a rejected push leaves the arc INCOMPLETE, never done', async () => {
    const store = new Store(home)
    sh(repo, 'remote', 'set-url', 'origin', join(home, 'no-such-remote.git'))
    await runArc({ store, plan: plan([task('undelivered')]), config: config({ landStrategy: 'push' }), log })

    // The arc used to be closed 'done' BEFORE delivery was attempted, so a
    // rejected push still exited 0 and an unattended caller recorded success
    // for work that never left the machine.
    expect(logs.join('\n')).toContain('push rejected')
    expect(store.getArc('e2e')?.status).toBe('incomplete')
    store.close()
  }, 60_000)

  it('builds the GitHub compare URL as the fallback when gh cannot open the PR', () => {
    sh(repo, 'remote', 'set-url', 'origin', 'git@github.com:Zie619/Arc.git')
    expect(G.compareUrl(repo, 'arc/x-integration', 'main'))
      .toBe('https://github.com/Zie619/Arc/compare/main...arc/x-integration?expand=1')
    sh(repo, 'remote', 'set-url', 'origin', 'https://github.com/Zie619/Arc.git')
    expect(G.compareUrl(repo, 'arc/x-integration', 'main'))
      .toBe('https://github.com/Zie619/Arc/compare/main...arc/x-integration?expand=1')
  })
})
