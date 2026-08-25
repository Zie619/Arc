import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/store.ts'

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURES = join(ROOT, 'test', 'fixtures')
let repo: string
let home: string
let planPath: string
let configPath: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function task(id: string): Record<string, unknown> {
  return {
    id, title: id, spec: 'create the requested file',
    dependsOn: [], footprint: [`unattended--${id}-generated.ts`], contractsMutated: ['none'], contractsRead: [], gates: ['green'],
    // Discriminating: fails at base, passes once the file exists.
    acceptance: [{
      id: 'c1', text: 'the task ran', proofKind: 'command',
      proofCommand: `test -f unattended--${id}-generated.ts`, requiredTier: 'checked',
    }],
  }
}

function writeInputs(tasks = [task('one')], roles?: Record<string, unknown>): void {
  writeFileSync(planPath, JSON.stringify({
    arcId: 'unattended', charter: { goal: 'finish unattended', objectives: ['finish'], nonGoals: [] }, tasks,
  }))
  writeFileSync(configPath, JSON.stringify({
    name: 'unattended', repo, mainBranch: 'main', landStrategy: 'none',
    gates: [{ name: 'green', command: 'true', proves: 'fixture' }],
    agentConcurrency: 1, heavyGateLimit: 1, maxAttempts: 2, maxTaskMinutes: 5,
    capacityWaitMinutes: 1,
    roles: roles ?? {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 10000, stallMs: 5000 },
    },
  }))
}

function run(extraEnv: Record<string, string> = {}, untilDone = false) {
  return spawnSync(process.execPath, ['src/cli.ts', 'run', planPath, '--config', configPath, ...(untilDone ? ['--until-done'] : [])], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env, PATH: `${FIXTURES}:${process.env.PATH}`, ARC_HOME: home,
      ARC_SUPERVISOR_BACKOFF_MS: '10', ...extraEnv,
    },
  })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arc-unattended-repo-'))
  home = mkdtempSync(join(tmpdir(), 'arc-unattended-home-'))
  planPath = join(home, 'plan.json')
  configPath = join(home, 'config.json')
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'init')
  writeInputs()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('unattended run process boundaries', () => {
  it('records arc.crash as the final event when a run throws outside task recovery', () => {
    const result = run({ ARC_TEST_CRASH_AFTER_START: 'injected unattended crash' })
    expect(result.status).toBe(1)

    const store = new Store(home)
    const last = store.eventsSince('unattended', 0).at(-1)
    expect(last?.kind).toBe('arc.crash')
    expect(last?.payload).toMatchObject({ message: 'injected unattended crash' })
    expect((last?.payload as { stack: string }).stack).toContain('injected unattended crash')
    store.close()
  }, 30_000)

  it('relaunches through resume after the run child is killed and completes', () => {
    const queue = join(home, 'kill-once-queue')
    mkdirSync(queue)
    writeFileSync(join(queue, '0.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({ __kill_parent: true }))
    writeFileSync(join(queue, '2.json'), JSON.stringify({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged: 'created' }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture' }],
    }))

    const result = run({ ARC_FAKE_QUEUE: queue, ARC_FAKE_WRITE: 'auto', ARC_FAKE_WRITE_AT: '2' }, true)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('relaunching through resume')

    const store = new Store(home)
    expect(store.getArc('unattended')?.status).toBe('done')
    expect(store.eventsSince('unattended', 0).some((event) => event.kind === 'arc.resume')).toBe(true)
    expect(store.allTasks('unattended')[0]?.state).toBe('landed')
    store.close()
  }, 30_000)

  it('stops a deterministic crash after three relaunches that changed nothing', () => {
    // The cap used to be a flat ten relaunches, which counts the wrong thing: a
    // crash loop burns all ten in 150 seconds while a laptop that slept four
    // times overnight uses four. What matters is whether a relaunch moved the
    // ledger, and the event log already answers that.
    const result = run({ ARC_TEST_CRASH_AFTER_START: 'repeatable crash' }, true)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('produced no forward progress')

    const store = new Store(home)
    expect(store.getArc('unattended')?.status).toBe('incomplete')
    const exhausted = store.eventsSince('unattended', 0).at(-1)
    expect(exhausted?.kind).toBe('arc.supervisor.exhausted')
    const payload = exhausted?.payload as { crashes: unknown[]; barren: number; reason: string }
    expect(payload.reason).toBe('no forward progress')
    expect(payload.barren).toBe(3)
    // Every crash is still itemised, so the arc stays actionable.
    expect(payload.crashes).toHaveLength(3)
    store.close()
  }, 30_000)

  it('completes a two-task arc through capacity weather, process death, resume, and repair', () => {
    const roles = {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', timeoutMs: 10000, stallMs: 5000 },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only', timeoutMs: 10000, stallMs: 5000 },
    }
    writeInputs([task('first'), task('second')], roles)
    const queue = join(home, 'mission-queue')
    mkdirSync(queue)
    const taskResult = (whatChanged: string) => ({
      status: 'done', noop: false,
      shipped: [{ path: 'generated.ts', whatChanged }],
      criteria: [{ id: 'c1', claimedTier: 'checked', evidence: 'fixture' }],
    })
    const payloads = [
      { ok: true },
      { ok: true },
      taskResult('first task'),
      { __model: 'claude-haiku-4-5', risks: [{ id: 'discard-1', text: 'discarded', howToCheck: 'never' }] },
      { __model: 'claude-sonnet-4-6', risks: [{ id: 'discard-2', text: 'discarded', howToCheck: 'never' }] },
      { risks: [{ id: 'r1', text: 'real first-task risk', howToCheck: 'inspect' }] },
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },
      { __kill_parent: true },
      taskResult('second task after resume'),
      { risks: [{ id: 'r2', text: 'second-task risk', howToCheck: 'inspect' }] },
      {
        verdict: 'CHANGES_REQUIRED',
        findings: [{ severity: 'major', file: 'second-generated.ts', line: 1, claim: 'repair this once', failureScenario: 'breaks', suggestedFix: 'repair it' }],
        criteriaAssessment: [], seamRisks: [],
      },
      taskResult('repair'),
      {
        verdict: 'CHANGES_REQUIRED',
        findings: [{ severity: 'minor', file: 'second-generated.ts', line: 1, claim: 'minor note after repair', failureScenario: 'small edge', suggestedFix: null }],
        criteriaAssessment: [], seamRisks: [],
      },
      { verdict: 'PASS', findings: [], criteriaAssessment: [], seamRisks: [] },
    ]
    payloads.forEach((payload, index) => writeFileSync(join(queue, `${index}.json`), JSON.stringify(payload)))

    const result = run({
      ARC_FAKE_QUEUE: queue,
      ARC_FAKE_WRITE: 'auto',
      ARC_FAKE_WRITE_AT: '2,8,11',
      ARC_CAPACITY_BACKOFF_MS: '50',
    }, true)

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const store = new Store(home)
    expect(store.getArc('unattended')?.status).toBe('done')
    expect(store.allTasks('unattended').map((row) => row.state)).toEqual(['landed', 'landed'])
    const events = store.eventsSince('unattended', 0)
    expect(events.filter((event) => event.kind === 'capacity.wait')).toHaveLength(2)
    expect(events.filter((event) => event.kind === 'arc.resume')).toHaveLength(1)
    expect(store.attemptsFor('unattended', 'first').filter((attempt) => attempt.terminal_reason === 'model-drift')).toHaveLength(2)
    expect(store.findingsFor('unattended').some((finding) => String(finding.text).includes('minor note after repair'))).toBe(true)
    expect(result.stdout).toContain('COMPLETE — every criterion has evidence')
    store.close()
  }, 30_000)
})
