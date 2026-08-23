import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sandboxUsable } from './gates.test.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runDirect, type DirectDependencies } from '../src/direct.ts'
import type { DispatchOptions, DispatchResult } from '../src/harness.ts'
import { ProjectConfig, ReviewVerdict, RiskChecklist, TaskResult } from '../src/types.ts'
import { runGate } from '../src/gates.ts'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arc-direct-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'direct@test.invalid')
  git('config', 'user.name', 'Direct Test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git('add', '--', 'README.md')
  git('commit', '-q', '-m', 'base')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

function config(command = 'true') {
  return ProjectConfig.parse({
    name: 'direct-test', repo, mainBranch: 'main', landStrategy: 'none',
    gates: [{ name: 'project', command, proves: 'the project remains valid' }],
    roles: {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write' },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only' },
    },
  })
}

function result(role: DispatchOptions['role'], parsed: unknown): DispatchResult {
  return {
    terminalReason: 'ok', exitCode: 0,
    observedModels: [role.model], modelVerified: true,
    finalText: JSON.stringify(parsed), parsed,
    transcript: `fixture ${role.cli}/${role.model}`,
    eventCount: 2, durationMs: 1, usage: [],
  }
}

interface FakeOptions {
  implement?: () => void
  review?: ReturnType<typeof ReviewVerdict.parse>
  unverifiedPhase?: 'risk' | 'implement' | 'review'
  onRisk?: () => void
}

function dependencies(fake: FakeOptions = {}): DirectDependencies & { calls: DispatchOptions[] } {
  const calls: DispatchOptions[] = []
  const dep = {
    calls,
    runGate,
    dispatch: async (options: DispatchOptions): Promise<DispatchResult> => {
      calls.push(options)
      const phase = calls.length === 1 ? 'risk' : calls.length === 2 ? 'implement' : 'review'
      if (phase === 'risk') fake.onRisk?.()
      if (phase === 'implement') fake.implement?.()
      const parsed = phase === 'risk'
        ? RiskChecklist.parse({ risks: [{ id: 'r1', text: 'regression', howToCheck: 'run the gate' }] })
        : phase === 'implement'
          ? TaskResult.parse({ status: 'done', shipped: [{ path: 'feature.ts', whatChanged: 'added it' }] })
          : fake.review ?? ReviewVerdict.parse({ verdict: 'PASS', findings: [], criteriaAssessment: [] })
      const dispatchResult = result(options.role, parsed)
      if (fake.unverifiedPhase === phase) {
        dispatchResult.observedModels = []
        dispatchResult.modelVerified = false
      }
      return dispatchResult
    },
  }
  return dep
}

describe('the direct lane', () => {
  it('predicts first, edits the current checkout, gates and reviews without committing', async () => {
    const originalHead = git('rev-parse', 'HEAD')
    const dep = dependencies({
      onRisk: () => expect(() => readFileSync(join(repo, 'feature.ts'))).toThrow(),
      implement: () => writeFileSync(join(repo, 'feature.ts'), 'export const feature = true\n'),
    })

    const direct = await runDirect({ config: config(), brief: 'add feature.ts' }, dep)

    expect(direct.status).toBe('completed')
    expect(direct.ok).toBe(true)
    expect(dep.calls.map(call => call.role.cli)).toEqual(['claude', 'codex', 'claude'])
    expect(dep.calls[0]?.role.sandbox).toBe('read-only')
    expect(dep.calls[1]?.cwd).toBe(repo)
    expect(git('rev-parse', 'HEAD')).toBe(originalHead)
    expect(git('status', '--porcelain')).toContain('?? feature.ts')
    expect(direct.gates[0]?.ok).toBe(true)
    expect(direct.checkpoint.touchedPaths).toContain('feature.ts')
    expect(direct.checkpointArtifact).toContain('feature.ts')
    expect(direct.checkpoint.limitations.join('\n')).toContain('untracked files')
  })

  it('refuses before dispatch when an explicitly targeted path is already dirty', async () => {
    writeFileSync(join(repo, 'README.md'), 'operator work\n')
    const dep = dependencies()
    const direct = await runDirect({
      config: config(), brief: 'change README', targetPaths: ['README.md'],
    }, dep)
    expect(direct.status).toBe('refused')
    expect(direct.reason).toContain('already has operator changes')
    expect(dep.calls).toHaveLength(0)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('operator work\n')
  })

  it('flags an implementer that changes protected operator work and never rolls it back', async () => {
    writeFileSync(join(repo, 'README.md'), 'operator work\n')
    const dep = dependencies({
      implement: () => writeFileSync(join(repo, 'README.md'), 'agent overwrote it\n'),
    })
    const direct = await runDirect({ config: config(), brief: 'add an unrelated feature' }, dep)
    expect(direct.status).toBe('safety-conflict')
    expect(direct.checkpoint.protectedConflicts).toEqual(['README.md'])
    expect(dep.calls).toHaveLength(2)
    // Detection is not permission for destructive recovery.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('agent overwrote it\n')
  })

  it('allows unrelated operator work to remain beside a safe direct change', async () => {
    writeFileSync(join(repo, 'README.md'), 'operator work\n')
    const dep = dependencies({
      implement: () => writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n'),
    })
    const direct = await runDirect({ config: config(), brief: 'add feature' }, dep)
    expect(direct.status).toBe('completed')
    expect(direct.checkpoint.protectedPaths).toContain('README.md')
    expect(direct.checkpoint.protectedConflicts).toEqual([])
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('operator work\n')
  })

  it('blocks acceptance on unverified risk-model proof, predicted blind to the diff', async () => {
    // The risk turn now runs CONCURRENTLY with the author (the serial turn was
    // the dogfood run's top latency complaint). Invariant 20 — the reviewer
    // predicts before SEEING the implementation — is enforced by geography:
    // risk runs in a detached worktree at the pre-change HEAD, so the diff
    // never exists in its tree. An unverified risk model still blocks the
    // result before anything is graded or accepted.
    const dep = dependencies({ unverifiedPhase: 'risk' })
    const direct = await runDirect({ config: config(), brief: 'change something' }, dep)
    expect(direct.status).toBe('review-failed')
    expect(direct.reason).toContain('model was unverified')
    expect(dep.calls).toHaveLength(2)
    // The risk agent's cwd is the disposable base tree, never the live checkout.
    expect(dep.calls[0]?.cwd).not.toBe(repo)
    expect(git('status', '--porcelain')).toBe('')
  })

  it('rejects a false done report with no checkout change', async () => {
    const dep = dependencies()
    const direct = await runDirect({ config: config(), brief: 'change something' }, dep)
    expect(direct.status).toBe('implementation-failed')
    expect(direct.reason).toContain('produced no checkout change')
    expect(dep.calls).toHaveLength(2)
  })

  it('detects a forbidden agent commit and leaves history untouched by Arc', async () => {
    const before = git('rev-parse', 'HEAD')
    const dep = dependencies({
      implement: () => {
        writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n')
        git('add', '--', 'feature.ts')
        git('commit', '-q', '-m', 'agent committed')
      },
    })
    const direct = await runDirect({ config: config(), brief: 'add feature' }, dep)
    expect(direct.status).toBe('safety-conflict')
    expect(direct.checkpoint.headMoved).toBe(true)
    expect(direct.checkpoint.committedPatch).toContain('feature.ts')
    expect(git('rev-parse', 'HEAD')).not.toBe(before)
    expect(git('log', '-1', '--pretty=%s')).toBe('agent committed')
  })

  it('still completes independent review when a project gate fails', async () => {
    const dep = dependencies({
      implement: () => writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n'),
    })
    const direct = await runDirect({ config: config('echo FAIL project; exit 1'), brief: 'add feature' }, dep)
    expect(dep.calls).toHaveLength(3)
    expect(direct.review?.verdict).toBe('PASS')
    expect(direct.status).toBe('gate-failed')
    expect(direct.gates[0]?.ok).toBe(false)
  })

  it('refuses an alias-disguised same-model reviewer', async () => {
    const dep = dependencies()
    const cfg = ProjectConfig.parse({
      name: 'direct-test', repo, mainBranch: 'main', landStrategy: 'none', gates: [],
      roles: {
        // `opus` and `claude-opus-5` are the same model wearing two names; a
        // string comparison used to let this pass the independence gate.
        implement: { cli: 'claude', model: 'opus', sandbox: 'workspace-write' },
        review: { cli: 'claude', model: 'claude-opus-5', sandbox: 'read-only' },
      },
    })
    const direct = await runDirect({ config: cfg, brief: 'change something' }, dep)
    expect(direct.status).toBe('refused')
    expect(direct.reason).toContain('independent review is required')
    expect(dep.calls).toHaveLength(0)
  })

  it('returns the checkpoint instead of throwing when the lane crashes mid-flight', async () => {
    const events: string[] = []
    const dep: DirectDependencies = {
      runGate,
      dispatch: async () => { events.push('dispatch'); throw new Error('provider exploded') },
    }
    const direct = await runDirect({
      config: config(), brief: 'change something',
      onCheckpoint: () => events.push('checkpoint'),
    }, dep)
    expect(direct.status).toBe('crashed')
    expect(direct.ok).toBe(false)
    expect(direct.reason).toContain('provider exploded')
    expect(direct.checkpointArtifact).toContain('"version": 1')
    // The recovery artifact was handed out BEFORE any agent could run. (Risk
    // and implement now both dispatch — concurrently — so two dispatch events.)
    expect(events[0]).toBe('checkpoint')
    expect(events.filter((event) => event === 'checkpoint')).toHaveLength(1)
  })

  it('does not run reviewer-authored commands the operator declined', async () => {
    const dep = dependencies({
      implement: () => writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n'),
      review: ReviewVerdict.parse({
        verdict: 'PASS',
        findings: [{
          severity: 'minor', file: 'feature.ts', line: 1,
          claim: 'check it', failureScenario: 'n/a',
          checkCommand: `touch ${join(repo, 'HACKED')}`,
        }],
      }),
    })
    const shown: string[][] = []
    const direct = await runDirect({
      config: config(), brief: 'add feature',
      confirmFindingChecks: async (commands) => { shown.push(commands); return false },
    }, dep)
    expect(direct.status).toBe('completed')
    expect(shown[0]![0]).toContain('HACKED')
    expect(direct.findingChecks[0]).toMatchObject({ ran: false, reproduced: false, result: null })
    expect(() => readFileSync(join(repo, 'HACKED'))).toThrow()
  })

  it('runs approved finding checks with the minimal gate environment, never shell credentials', { skip: !sandboxUsable }, async () => {
    process.env.DIRECT_SECRET_PROBE = 'leaked'
    try {
      const dep = dependencies({
        implement: () => writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n'),
        review: ReviewVerdict.parse({
          verdict: 'PASS',
          findings: [{
            severity: 'minor', file: 'feature.ts', line: 1,
            claim: 'the operator shell env is not visible', failureScenario: 'n/a',
            checkCommand: 'test -z "${DIRECT_SECRET_PROBE:-}"',
          }],
        }),
      })
      const direct = await runDirect({
        config: config(), brief: 'add feature',
        confirmFindingChecks: async () => true,
      }, dep)
      expect(direct.status).toBe('completed')
      expect(direct.findingChecks[0]).toMatchObject({ ran: true, reproduced: true })
    } finally {
      delete process.env.DIRECT_SECRET_PROBE
    }
  })

  it('repairs a red gate by retrying the writer with the concrete failure, then completes', async () => {
    let implementCalls = 0
    const prompts: string[] = []
    const dep: DirectDependencies = {
      runGate,
      dispatch: async (opts: DispatchOptions): Promise<DispatchResult> => {
        if (opts.schema === RiskChecklist) return result(opts.role, RiskChecklist.parse({ risks: [{ id: 'r1', text: 'x', howToCheck: 'y' }] }))
        if (opts.schema === TaskResult) {
          implementCalls++
          prompts.push(opts.prompt)
          writeFileSync(join(repo, 'feature.ts'), implementCalls === 1 ? 'broken\n' : 'fixed\n')
          return result(opts.role, TaskResult.parse({ status: 'done', shipped: [{ path: 'feature.ts', whatChanged: 'edited' }] }))
        }
        return result(opts.role, ReviewVerdict.parse({ verdict: 'PASS', findings: [], criteriaAssessment: [] }))
      },
    }
    const direct = await runDirect({
      config: config('grep -q fixed feature.ts'), brief: 'fix feature', repairAttempts: 3,
    }, dep)
    expect(direct.status).toBe('completed')
    expect(implementCalls).toBe(2)
    expect(prompts[1]).toContain('WHAT FAILED LAST TIME')
    expect(direct.gates.every((gate) => gate.ok)).toBe(true)
  })

  it('stops repairing on a repeated failure signature instead of spinning', async () => {
    let implementCalls = 0
    const dep: DirectDependencies = {
      runGate,
      dispatch: async (opts: DispatchOptions): Promise<DispatchResult> => {
        if (opts.schema === RiskChecklist) return result(opts.role, RiskChecklist.parse({ risks: [{ id: 'r1', text: 'x', howToCheck: 'y' }] }))
        if (opts.schema === TaskResult) {
          implementCalls++
          writeFileSync(join(repo, 'feature.ts'), `attempt ${implementCalls}\n`)
          return result(opts.role, TaskResult.parse({ status: 'done', shipped: [{ path: 'feature.ts', whatChanged: 'edited' }] }))
        }
        return result(opts.role, ReviewVerdict.parse({ verdict: 'PASS', findings: [], criteriaAssessment: [] }))
      },
    }
    const direct = await runDirect({
      config: config('echo FAIL identical every time; exit 1'), brief: 'x', repairAttempts: 5,
    }, dep)
    expect(direct.status).toBe('gate-failed')
    // Attempt 2 failed with the same normalized signature as attempt 1 —
    // burning attempts 3-5 on it would be spinning, not converging.
    expect(implementCalls).toBe(2)
  })

  it('reports every dispatch to the attempt observer', async () => {
    const started: string[] = []
    const finished: Array<{ id: string; reason: string }> = []
    let n = 0
    const dep = dependencies({ implement: () => writeFileSync(join(repo, 'feature.ts'), 'x\n') })
    const direct = await runDirect({
      config: config(), brief: 'add feature',
      observer: {
        start: (a) => { started.push(a.phase); return `att-${++n}` },
        finish: (id, outcome) => finished.push({ id, reason: outcome.terminalReason }),
      },
    }, dep)
    expect(direct.status).toBe('completed')
    expect(started).toEqual(['risk', 'implement', 'review'])
    expect(finished.map((f) => f.id)).toEqual(['att-1', 'att-2', 'att-3'])
    expect(finished.every((f) => f.reason === 'ok')).toBe(true)
  })

  it('runs risk prediction concurrently with the implementation', async () => {
    // The risk fake refuses to finish until the implement dispatch has
    // started — under the old serial flow this deadlocks and times out.
    let implementCalled!: () => void
    const implementStarted = new Promise<void>((resolve) => { implementCalled = resolve })
    const order: string[] = []
    const dep: DirectDependencies = {
      runGate,
      dispatch: async (opts: DispatchOptions): Promise<DispatchResult> => {
        if (opts.schema === RiskChecklist) {
          order.push('risk-start')
          await implementStarted
          order.push('risk-end')
          return result(opts.role, RiskChecklist.parse({ risks: [{ id: 'r1', text: 'x', howToCheck: 'y' }] }))
        }
        if (opts.schema === TaskResult) {
          order.push('implement')
          implementCalled()
          writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n')
          return result(opts.role, TaskResult.parse({ status: 'done', shipped: [{ path: 'feature.ts', whatChanged: 'added' }] }))
        }
        return result(opts.role, ReviewVerdict.parse({ verdict: 'PASS', findings: [], criteriaAssessment: [] }))
      },
    }
    const direct = await runDirect({ config: config(), brief: 'add feature' }, dep)
    expect(direct.status).toBe('completed')
    expect(order).toEqual(['risk-start', 'implement', 'risk-end'])
  }, 10_000)

  it('returns changes-required for an independent rejection', async () => {
    const dep = dependencies({
      implement: () => writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n'),
      review: ReviewVerdict.parse({
        verdict: 'CHANGES_REQUIRED',
        findings: [{
          severity: 'major', file: 'feature.ts', line: 1,
          claim: 'wrong value', failureScenario: 'import gives the wrong value',
        }],
      }),
    })
    const direct = await runDirect({ config: config(), brief: 'add feature' }, dep)
    expect(direct.status).toBe('changes-required')
    expect(direct.ok).toBe(false)
    expect(direct.review?.findings[0]?.file).toBe('feature.ts')
  })
})
