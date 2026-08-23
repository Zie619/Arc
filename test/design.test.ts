import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/store.ts'
import { runInterview, runScouts, runPlanner, type Ask } from '../src/design.ts'
import { compileBrief } from '../src/brief.ts'
import { PlanTask, ProjectConfig, type Plan } from '../src/types.ts'

// Providers' structured output emits an explicit null for command-less
// criteria; `.optional()` rejected it and failed every real plan.
// (First dogfood run, three bad-envelopes in a row.)
it('accepts a plan task whose criterion has proofCommand: null', () => {
  const task = PlanTask.parse({
    id: 't1', title: 't', spec: 's',
    acceptance: [{ id: 'c1', text: 'observed by a human', proofKind: 'human-observation', proofCommand: null, requiredTier: 'claimed' }],
  })
  expect(task.acceptance[0]!.proofCommand).toBeNull()
})

/**
 * The design phase (interview → scouts → plan) against fake CLIs, driven by a
 * queued sequence of payloads. No tokens, no network.
 */

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
let repo: string
let home: string
let queue: string
let briefPath: string
let originalPath: string | undefined
const logs: string[] = []
const log = (l: string) => { logs.push(l) }

let qn = 0
function enqueue(payload: unknown): void {
  writeFileSync(join(queue, `${qn++}.json`), JSON.stringify(payload))
}

function prompts(heading: string): string[] {
  return readdirSync(join(home, 'artifacts'))
    .filter((name) => name.endsWith('.brief.txt'))
    .map((name) => readFileSync(join(home, 'artifacts', name), 'utf8'))
    .filter((prompt) => prompt.startsWith(heading))
}

beforeEach(() => {
  originalPath = process.env.PATH
  process.env.PATH = `${FIXTURES}:${originalPath}`
  repo = mkdtempSync(join(tmpdir(), 'design-repo-'))
  home = mkdtempSync(join(tmpdir(), 'design-home-'))
  queue = mkdtempSync(join(tmpdir(), 'design-queue-'))
  process.env.ARC_FAKE_QUEUE = queue
  qn = 0
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  briefPath = join(repo, 'brief.md')
  writeFileSync(briefPath, 'Make the memory layer actually store data. Should we use Obsidian? I dont know.')
  logs.length = 0
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  delete process.env.ARC_FAKE_QUEUE
  for (const d of [repo, home, queue]) rmSync(d, { recursive: true, force: true })
})

function config() {
  return ProjectConfig.parse({
    name: 'design-test',
    repo,
    gates: [{ name: 'cheap', command: 'true', proves: 'nothing' }],
    roles: {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', timeoutMs: 20000, stallMs: 15000 },
      review: { cli: 'claude', model: 'opus', timeoutMs: 20000, stallMs: 15000 },
      scout: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'read-only', timeoutMs: 20000, stallMs: 15000 },
    },
  })
}

const EXTRACT = {
  proposedGoal: 'Make the memory layer store and use agent data',
  objectives: ['memory layer captures data'],
  nonGoals: ['do not rewrite the agent runtime'],
  questions: [
    { id: 'q1', text: 'Use Obsidian or stay in Mongo?', why: 'changes the storage layer',
      options: ['Obsidian', 'Stay in Mongo'], recommendation: 'Stay in Mongo', blocking: true },
    { id: 'q2', text: 'Nice-to-have colour scheme?', why: 'cosmetic',
      options: [], recommendation: 'whatever', blocking: false },
  ],
  premises: [{ id: 'p1', statement: 'the memory layer stores almost no data', howToVerify: 'count Memory rows' }],
}

const CHARTER = {
  goal: 'Make the memory layer capture agent experience and feed it back.',
  objectives: ['memory layer captures data', 'agents read it back'],
  nonGoals: ['do not rewrite the agent runtime'],
  constraints: [{ text: 'no new infrastructure', hardness: 'MUST' }],
}

describe('the interview', () => {
  it('asks only BLOCKING questions and records each answer as a decision', async () => {
    enqueue(EXTRACT)
    enqueue(CHARTER)
    const store = new Store(home)
    const asked: string[] = []
    const ask: Ask = async (q) => { asked.push(q.id); return 'Stay in Mongo' }

    const ok = await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, ask)
    expect(ok).toBe(true)

    // q2 is non-blocking — asking about it would waste the user's attention.
    expect(asked).toEqual(['q1'])

    const decisions = store.decisions('a1')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.question).toContain('Obsidian')
    expect(decisions[0]!.chosen).toBe('Stay in Mongo')
    // The alternative that was NOT taken is recorded, so nobody re-litigates it.
    expect(JSON.parse(String(decisions[0]!.rejected_json))).toContain('Obsidian')
    store.close()
  }, 30_000)

  it('stores the brief byte-for-byte and never rewrites it', async () => {
    enqueue(EXTRACT); enqueue(CHARTER)
    const store = new Store(home)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => 'x')
    expect(store.getDesign('a1')!.briefText)
      .toBe('Make the memory layer actually store data. Should we use Obsidian? I dont know.')
    store.close()
  }, 30_000)

  it('an empty answer accepts the recommendation rather than recording nothing', async () => {
    enqueue(EXTRACT); enqueue(CHARTER)
    const store = new Store(home)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => '')
    expect(store.decisions('a1')[0]!.chosen).toBe('Stay in Mongo')
    store.close()
  }, 30_000)

  it('puts repository refutations in the interview prompt only when supplied', async () => {
    enqueue(EXTRACT); enqueue(CHARTER)
    const store = new Store(home)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => '')

    const firstPrompt = prompts('# INTERVIEW')[0]!
    expect(firstPrompt).not.toContain('REFUTED ASSUMPTIONS')

    enqueue(EXTRACT); enqueue(CHARTER)
    await runInterview(
      { store, config: config(), arcId: 'a2', log },
      briefPath,
      async () => '',
      [{
        id: 'p-storage',
        statement: 'the memory layer stores almost no data',
        evidence: 'src/memory layer.ts:41 writes a memory row on every run',
      }],
    )

    const reopenedPrompt = prompts('# INTERVIEW')
      .find((prompt) => prompt.includes('p-storage'))!
    expect(reopenedPrompt).toContain('REFUTED ASSUMPTIONS — CHECKED AGAINST THE REAL REPOSITORY')
    expect(reopenedPrompt).toContain('are FALSE')
    expect(reopenedPrompt).toContain('MUST NOT re-assume')
    expect(reopenedPrompt).toContain('the memory layer stores almost no data')
    expect(reopenedPrompt).toContain('src/memory layer.ts:41 writes a memory row on every run')
    store.close()
  }, 60_000)
})

describe('scouts verify premises against real code', () => {
  it('a REFUTED premise stops planning dead', async () => {
    // The whole point: the brief rested on something untrue, and we find out
    // before ten tasks are built on top of it.
    enqueue(EXTRACT); enqueue(CHARTER)
    const store = new Store(home)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => '')

    enqueue({ scouts: [{ id: 's1', area: 'memory layer writes', brief: 'find write paths', engine: 'codex' }] })
    enqueue({
      area: 'memory layer writes', findings: [], filesToTouch: [], contractsMutated: [], contractsRead: [],
      risks: [], proposedWork: [],
      premiseVerdicts: [{ id: 'p1', verdict: 'refuted', evidence: 'lib/memory layer.ts:41 writes on every run' }],
    })

    const ok = await runScouts({ store, config: config(), arcId: 'a1', log })
    expect(ok).toBe(false)
    expect(logs.join('\n')).toContain('PREMISE(S) REFUTED')
    expect(store.refutedPremises('a1')).toHaveLength(1)

    // And the planner refuses to proceed on a false footing.
    const plan = await runPlanner({ store, config: config(), arcId: 'a1', log })
    expect(plan).toBeNull()
    expect(logs.join('\n')).toContain('refusing to plan')
    store.close()
  }, 60_000)

  it('a confirmed premise lets planning continue', async () => {
    enqueue(EXTRACT); enqueue(CHARTER)
    const store = new Store(home)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => '')

    enqueue({ scouts: [{ id: 's1', area: 'memory layer', brief: 'look', engine: 'codex' }] })
    enqueue({
      area: 'memory layer',
      findings: [{ file: 'lib/memory layer.ts', line: 12, what: 'no writer', why: 'that is the bug' }],
      filesToTouch: ['lib/memory layer.ts'], contractsMutated: ['MemoryRow'], contractsRead: [],
      risks: [], proposedWork: [{ title: 'add a writer', rationale: 'nothing writes today' }],
      premiseVerdicts: [{ id: 'p1', verdict: 'confirmed', evidence: 'lib/memory layer.ts:12 — no write path' }],
    })

    expect(await runScouts({ store, config: config(), arcId: 'a1', log })).toBe(true)
    expect(store.refutedPremises('a1')).toHaveLength(0)
    expect(store.scoutReports('a1')[0].contractsMutated).toContain('MemoryRow')
    store.close()
  }, 60_000)

  it('asks scouts to verify only assumed and unclear premises', async () => {
    enqueue(EXTRACT); enqueue(CHARTER)
    const store = new Store(home)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => '')

    store.addPremise('a1', 'p-unclear', 'unclear statement', 'inspect uncertainty')
    store.setPremise('a1', 'p-unclear', 'unclear', 'not enough evidence')
    store.addPremise('a1', 'p-confirmed', 'confirmed statement', 'inspect confirmation')
    store.setPremise('a1', 'p-confirmed', 'confirmed', 'confirmed evidence')
    store.addPremise('a1', 'p-refuted', 'refuted statement', 'inspect refutation')
    store.setPremise('a1', 'p-refuted', 'refuted', 'refuted evidence')

    enqueue({ scouts: [{ id: 's1', area: 'memory layer', brief: 'look', engine: 'codex' }] })
    enqueue({
      area: 'memory layer', findings: [], filesToTouch: [], contractsMutated: [], contractsRead: [],
      risks: [], proposedWork: [], premiseVerdicts: [],
    })
    await runScouts({ store, config: config(), arcId: 'a1', log })

    const scoutPrompts = [
      ...prompts('# ASSIGN THE SCOUTS'),
      ...prompts('# SCOUT —'),
    ]
    expect(scoutPrompts).toHaveLength(2)
    for (const prompt of scoutPrompts) {
      expect(prompt).toContain('the memory layer stores almost no data')
      expect(prompt).toContain('unclear statement')
      expect(prompt).not.toContain('confirmed statement')
      expect(prompt).not.toContain('refuted statement')
    }
    store.close()
  }, 60_000)
})

describe('the planner', () => {
  const validTask = {
    id: 't1', title: 'add a writer', spec: 'write memory rows on each run',
    dependsOn: [], footprint: ['lib/memory layer.ts'], contractsMutated: ['MemoryRow'], contractsRead: [],
    gates: ['cheap'],
    acceptance: [{ id: 'c1', text: 'rows appear', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' }],
  }

  async function seedThroughScouting(store: Store) {
    enqueue(EXTRACT); enqueue(CHARTER)
    await runInterview({ store, config: config(), arcId: 'a1', log }, briefPath, async () => '')
    enqueue({ scouts: [{ id: 's1', area: 'memory layer', brief: 'look', engine: 'codex' }] })
    enqueue({
      area: 'memory layer', findings: [], filesToTouch: ['lib/memory layer.ts'],
      contractsMutated: [], contractsRead: [], risks: [], proposedWork: [],
      premiseVerdicts: [{ id: 'p1', verdict: 'confirmed', evidence: 'ok' }],
    })
    await runScouts({ store, config: config(), arcId: 'a1', log })
  }

  it('produces a validated plan carrying the charter', async () => {
    const store = new Store(home)
    await seedThroughScouting(store)
    enqueue({ tasks: [validTask] })

    const plan = await runPlanner({ store, config: config(), arcId: 'a1', log }) as Plan
    expect(plan).not.toBeNull()
    expect(plan.arcId).toBe('a1')
    expect(plan.charter.goal).toBe(CHARTER.goal)
    expect(plan.charter.constraints).toEqual(CHARTER.constraints)
    expect(plan.tasks[0]!.contractsMutated).toEqual(['MemoryRow'])

    const persisted = store.getPlan('a1') ?? plan
    store.createArc(persisted, repo, 'sha', 'arc/a1-integration')
    const compiled = compileBrief({
      store, plan, task: plan.tasks[0]!, role: 'implement',
      worktree: '/wt', branch: 'arc/t1', baseSha: 'abc123',
    })
    expect(compiled.text).toContain('[MUST] no new infrastructure')
    expect(compiled.text.indexOf('no new infrastructure')).toBeLessThan(compiled.tier0Bytes)
    store.close()
  }, 60_000)

  it('RETRIES with the concrete field errors instead of re-sending the same prompt', async () => {
    const store = new Store(home)
    await seedThroughScouting(store)
    // First draft has a dependency cycle; second is clean.
    enqueue({ tasks: [
      { ...validTask, id: 'a', dependsOn: ['b'] },
      { ...validTask, id: 'b', dependsOn: ['a'] },
    ] })
    enqueue({ tasks: [validTask] })

    const plan = await runPlanner({ store, config: config(), arcId: 'a1', log })
    expect(plan).not.toBeNull()
    const out = logs.join('\n')
    expect(out).toContain('structurally invalid')
    expect(out).toContain('dependency cycle')
    expect(out).toContain('attempt 2/3')
    store.close()
  }, 60_000)

  it('gives up rather than emitting an invalid plan', async () => {
    const store = new Store(home)
    await seedThroughScouting(store)
    for (let i = 0; i < 3; i++) {
      enqueue({ tasks: [{ ...validTask, dependsOn: ['ghost'] }] })
    }
    expect(await runPlanner({ store, config: config(), arcId: 'a1', log })).toBeNull()
    store.close()
  }, 90_000)
})

describe('deviation propagation', () => {
  it('amends a not-yet-dispatched task and puts it in TIER 0 of its brief', () => {
    // Without this, task 3 builds against what task 1's spec SAID while task 1
    // actually did something else, and nothing notices until integration.
    const store = new Store(home)
    const plan: Plan = {
      arcId: 'a2',
      charter: { goal: 'g', objectives: [], nonGoals: [], constraints: [] },
      tasks: [
        { id: 'first', title: 'first', spec: 'do A', dependsOn: [], footprint: ['shared.ts'],
          contractsMutated: ['Shape'], contractsRead: [], gates: [],
          acceptance: [{ id: 'c1', text: 'x', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' }] },
        { id: 'second', title: 'second', spec: 'build on A', dependsOn: ['first'], footprint: ['other.ts'],
          contractsMutated: [], contractsRead: ['Shape'], gates: [],
          acceptance: [{ id: 'c1', text: 'y', proofKind: 'command', proofCommand: 'true', requiredTier: 'checked' }] },
      ],
    }
    store.createArc(plan, repo, 'sha', 'arc/a2-integration')
    store.addAmendment('a2', 'second', 'Shape gained a required `kind` field', 'first')

    const brief = compileBrief({
      store, plan, task: plan.tasks[1]!, role: 'implement',
      worktree: '/wt', branch: 'arc/second', baseSha: 'abc123',
    })

    expect(brief.text).toContain('AMENDMENTS')
    expect(brief.text).toContain('gained a required `kind` field')
    expect(brief.text).toContain('[from first]')
    // Tier 0 is the never-truncated region, so the amendment cannot be dropped
    // to make the brief fit.
    expect(brief.text.indexOf('AMENDMENTS')).toBeLessThan(brief.tier0Bytes)
    store.close()
  })

  it('puts durable operator steering in Tier 0 and exposes its consumption id', () => {
    const store = new Store(home)
    const plan: Plan = {
      arcId: 'steered', charter: { goal: 'g', objectives: [], nonGoals: [], constraints: [] },
      tasks: [{ id: 'one', title: 'one', spec: 'work', dependsOn: [], footprint: [],
        contractsMutated: [], contractsRead: [], gates: [], acceptance: [] }],
    }
    store.createArc(plan, repo, 'sha', 'arc/steered-integration')
    const thread = store.createThread({ repo, title: 'thread' })
    const intervention = store.addIntervention({
      threadId: thread, arcId: 'steered', kind: 'steer', text: 'Preserve the public memory layer API',
    })
    const brief = compileBrief({
      store, plan, task: plan.tasks[0]!, role: 'implement',
      worktree: '/wt', branch: 'arc/one', baseSha: 'abc123',
    })
    expect(brief.text).toContain('OPERATOR STEERING')
    expect(brief.text).toContain('Preserve the public memory layer API')
    expect(brief.text.indexOf('OPERATOR STEERING')).toBeLessThan(brief.tier0Bytes)
    expect(brief.interventionIds).toEqual([intervention])
    store.close()
  })
})
