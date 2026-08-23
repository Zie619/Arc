import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function config(over: Partial<any> = {}) {
  return ProjectConfig.parse({
    name: 'test',
    repo,
    mainBranch: 'main',
    landStrategy: 'push',
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
    dependsOn: [], footprint: [], contractsMutated: [], contractsRead: [],
    gates: ['always-green'],
    acceptance: [{ id: 'c1', text: 'it ran', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' }],
    ...over,
  }
}

function plan(tasks: any[]): Plan {
  return { arcId: 'e2e', charter: { goal: 'ship it', objectives: [], nonGoals: [] }, tasks } as Plan
}

const log = (l: string) => { logs.push(l); if (process.env.ARC_TEST_VERBOSE) console.log(l) }

describe('the orchestrator, end to end', () => {
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
    await runArc({ store, plan: plan([task('nothing-to-do')]), config: config(), log })
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

    expect(logs.join('\n')).toContain('releasing and requeueing')
    expect(store.allTasks('e2e').map((row) => row.id)).toEqual(['stranded'])
    expect(store.allTasks('e2e')[0]!.state).toBe('landed')
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
    process.env.ARC_FAKE_MODEL = 'sonnet'
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

  it('runs reviewer checkCommand and attaches its output to the exact finding', async () => {
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
          suggestedFix: null, checkCommand: 'test -n "$(git diff-tree --no-commit-id --name-only -r HEAD)"',
        }],
        criteriaAssessment: [{ id: 'c1', met: true, evidence: 'command proof already ran' }],
        seamRisks: [],
      },
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))
    process.env.ARC_FAKE_QUEUE = queue
    process.env.ARC_FAKE_WRITE_AT = '0'
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
          { id: 'c1', text: 'it ran', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' },
          { id: 'c2', text: 'the generated file exists', proofKind: 'command', proofCommand: 'ls | grep -q generated', requiredTier: 'checked' },
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
