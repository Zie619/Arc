import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Store } from './store.ts'
import { runArc } from './orchestrator.ts'
import { ProjectConfig, type Plan } from './types.ts'

/**
 * Arc grading Arc.
 *
 * Arc has graded everyone else's work since it existed and has never graded its
 * own. There was no success rate, no baseline, no regression signal — so "did
 * that change make Arc better?" was not a question it could answer, and every
 * decision about its own behaviour was argued rather than measured.
 *
 * This is deliberately TIER 1 and deliberately free. It runs the real
 * orchestrator — design excepted — end to end against the fake provider CLIs
 * the test suite already uses, so a full arc costs zero tokens and finishes in
 * seconds. That is what makes it runnable on every commit, which is the only
 * property that makes a regression suite useful.
 *
 * What it does NOT do, on purpose: measure model capability. A paid benchmark
 * (SWE-bench Verified, Aider polyglot) answers "can the model do it"; this
 * answers "does the harness hold its invariants", which is Arc's actual claim
 * and the only thing a fake provider can speak to. Buy the paid one when a
 * tier-1 result and an intuition disagree.
 *
 * Half these scenarios are ADVERSARIAL: a writer that deletes tests, a writer
 * that edits the thing that proves it, a reviewer whose reproduction cannot
 * run. Each must FAIL, and a bench where they pass is a bench measuring only
 * what Arc already does well.
 */

export interface Scenario {
  id: string
  /** What invariant this scenario is here to defend. */
  defends: string
  /** Files seeded into a fresh repo before the arc starts. */
  seed?: Record<string, string>
  plan: Plan
  config?: Record<string, unknown>
  /** Fake provider env: payloads, write targets. */
  env?: Record<string, string>
  /** Structured payloads served one per claude call, in order — a risk
   *  checklist then a review verdict, the way a real review lane consumes them. */
  queue?: unknown[]
  expect: {
    arcStatus: 'done' | 'incomplete'
    landed: number
    /** Substrings that MUST appear in the run log. Absence is a regression. */
    logContains?: string[]
  }
}

export interface ScenarioResult {
  id: string
  defends: string
  passed: boolean
  why: string[]
  arcStatus: string
  landed: number
  failed: number
  attempts: number
  /** How many implement attempts the first landed task needed. The number the
   *  retry and repair work is really trying to move. */
  attemptsToGreen: number | null
  findingsKept: number
  outputTokens: number
  wallMs: number
}

const FIXTURES = resolve(import.meta.dirname, '..', 'test', 'fixtures')

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function seedRepo(seed: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'arcbench-repo-'))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 'bench@arc')
  sh(repo, 'config', 'user.name', 'arc bench')
  for (const [path, body] of Object.entries({ 'README.md': 'bench\n', ...seed })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'seed')
  return repo
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now()
  const repo = seedRepo(scenario.seed ?? {})
  const home = mkdtempSync(join(tmpdir(), 'arcbench-home-'))
  const logs: string[] = []
  const savedPath = process.env.PATH
  const savedEnv: Record<string, string | undefined> = {}
  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  let store: Store | undefined
  try {
    process.env.PATH = `${FIXTURES}:${savedPath}`
    for (const [key, value] of Object.entries(scenario.env ?? {})) setEnv(key, value)
    if (scenario.queue) {
      const dir = join(home, 'queue')
      mkdirSync(dir, { recursive: true })
      scenario.queue.forEach((payload, i) => writeFileSync(join(dir, `${i}.json`), JSON.stringify(payload)))
      setEnv('ARC_FAKE_QUEUE', dir)
    }

    const config = ProjectConfig.parse({
      name: 'bench',
      // These commands are trusted fixtures; exercise their verdicts on Linux too.
      sandboxPolicy: 'caveat',
      repo,
      mainBranch: 'main',
      landStrategy: 'none',
      agentConcurrency: 3,
      heavyGateLimit: 1,
      maxAttempts: 2,
      // A bench must never sit in a capacity backoff: it is measuring the
      // harness, not the weather.
      capacityWaitMinutes: 0,
      gates: [{ name: 'always-green', command: 'true', proves: 'nothing, it is a fixture' }],
      roles: {
        implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 20_000, stallMs: 15_000 },
      },
      ...scenario.config,
    })

    store = new Store(home)
    await runArc({
      store, plan: scenario.plan, config,
      log: (line) => { logs.push(line); if (process.env.ARC_BENCH_DEBUG) console.log(line) },
    })

    const tasks = store.allTasks(scenario.plan.arcId)
    const landed = tasks.filter((t) => t.state === 'landed').length
    const failed = tasks.filter((t) => t.state === 'failed').length
    const arcStatus = String(store.getArc(scenario.plan.arcId)?.status ?? 'missing')
    const attempts = store.allAttempts(scenario.plan.arcId)
    const implementAttempts = attempts.filter((a) => a.role === 'implement')
    const firstLanded = tasks.find((t) => t.state === 'landed')
    const attemptsToGreen = firstLanded
      ? implementAttempts.filter((a) => a.task_id === firstLanded.id).length
      : null
    const usage = store.usageFor(scenario.plan.arcId)

    const why: string[] = []
    if (arcStatus !== scenario.expect.arcStatus) why.push(`arc status ${arcStatus}, expected ${scenario.expect.arcStatus}`)
    if (landed !== scenario.expect.landed) why.push(`${landed} landed, expected ${scenario.expect.landed}`)
    const text = logs.join('\n')
    for (const needle of scenario.expect.logContains ?? []) {
      if (!text.includes(needle)) why.push(`log never said "${needle}"`)
    }

    return {
      id: scenario.id,
      defends: scenario.defends,
      passed: why.length === 0,
      why,
      arcStatus,
      landed,
      failed,
      attempts: attempts.length,
      attemptsToGreen,
      findingsKept: store.findingsFor(scenario.plan.arcId).length,
      outputTokens: usage.reduce((n, row) => n + Number(row.output_tokens ?? 0), 0),
      wallMs: Date.now() - started,
    }
  } finally {
    store?.close()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

export async function runBench(scenarios: Scenario[]): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  // Serial on purpose: these mutate PATH and ARC_FAKE_* process-wide, and a
  // bench that races itself measures the race.
  for (const scenario of scenarios) out.push(await runScenario(scenario))
  return out
}

export function formatBench(results: ScenarioResult[]): string[] {
  const lines: string[] = []
  const pad = Math.max(...results.map((r) => r.id.length), 8)
  for (const r of results) {
    lines.push(
      `  ${r.passed ? '✓' : '✗'} ${r.id.padEnd(pad)}  ` +
      `${String(r.landed).padStart(2)} landed  ${String(r.failed).padStart(2)} failed  ` +
      `${String(r.attempts).padStart(2)} attempt(s)  ` +
      `${r.attemptsToGreen === null ? '  —' : String(r.attemptsToGreen).padStart(3)} to green  ` +
      `${String(r.findingsKept).padStart(2)} finding(s)  ${String(Math.round(r.wallMs / 100) / 10).padStart(5)}s`)
    lines.push(`      defends: ${r.defends}`)
    for (const why of r.why) lines.push(`      ✗ ${why}`)
  }
  const passed = results.filter((r) => r.passed).length
  lines.push('')
  lines.push(`  ${passed}/${results.length} scenarios held` +
    `  ·  ${results.reduce((n, r) => n + r.outputTokens, 0)} output tokens` +
    `  ·  ${Math.round(results.reduce((n, r) => n + r.wallMs, 0) / 1000)}s`)
  return lines
}
