import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sandboxUsable } from './gates.test.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProjectConfig } from '../src/types.ts'
import { runReviewLane } from '../src/review.ts'

let repo = ''
let queue = ''
let oldPath: string | undefined
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arc-review-'))
  queue = mkdtempSync(join(tmpdir(), 'arc-review-queue-'))
  oldPath = process.env.PATH
  process.env.PATH = `${resolve(import.meta.dirname, 'fixtures')}:${oldPath}`
  process.env.ARC_FAKE_QUEUE = queue
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'r@r.r'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'review'], { cwd: repo })
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo })
})
afterEach(() => {
  process.env.PATH = oldPath
  delete process.env.ARC_FAKE_QUEUE
  rmSync(repo, { recursive: true, force: true })
  rmSync(queue, { recursive: true, force: true })
})

function config() {
  return ProjectConfig.parse({
    sandboxPolicy: 'caveat', // Explicitly trusted fixture commands; refusal is covered in security.test.ts.
    name: 'review', repo, gates: [{ name: 'syntax', command: 'true', proves: 'syntax' }],
    roles: {
      implement: { cli: 'codex', model: 'sol', sandbox: 'workspace-write' },
      review: { cli: 'claude', model: 'opus', sandbox: 'read-only' },
    },
  })
}

describe('review lane', () => {
  it('predicts against a clean base tree then reviews the current checkout without editing it', async () => {
    writeFileSync(join(queue, '0.json'), JSON.stringify({ risks: [{ id: 'r', text: 'wrong value', howToCheck: 'inspect value.ts' }] }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({ verdict: 'PASS', findings: [], criteriaAssessment: [] }))
    writeFileSync(join(repo, 'value.ts'), 'export const value = 2\n')
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    const result = await runReviewLane({ config: config(), brief: 'review the value change' })
    const after = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(result.status).toBe('completed')
    expect(result.transcripts.map((item) => item.phase)).toEqual(['risk', 'review'])
    expect(after).toBe(before)
  })

  it('executes reviewer finding checks with evidence, matching the other lanes', { skip: !sandboxUsable }, async () => {
    writeFileSync(join(queue, '0.json'), JSON.stringify({ risks: [{ id: 'r', text: 'wrong value', howToCheck: 'inspect value.ts' }] }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({
      verdict: 'PASS_WITH_NOTES',
      findings: [{
        severity: 'minor', file: 'value.ts', line: 1,
        claim: 'the new value is present', failureScenario: 'n/a',
        checkCommand: 'grep -q "value = 2" value.ts',
      }],
      criteriaAssessment: [],
    }))
    writeFileSync(join(repo, 'value.ts'), 'export const value = 2\n')
    const result = await runReviewLane({ config: config(), brief: 'review the value change' })
    expect(result.status).toBe('completed')
    expect(result.findingChecks).toHaveLength(1)
    expect(result.findingChecks[0]).toMatchObject({ ran: true, reproduced: true })
    expect(result.findingChecks[0]!.result?.exitCode).toBe(0)
  })

  it('records but does not run finding checks the operator declined', async () => {
    writeFileSync(join(queue, '0.json'), JSON.stringify({ risks: [{ id: 'r', text: 'x', howToCheck: 'y' }] }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({
      verdict: 'PASS',
      findings: [{
        severity: 'minor', file: 'value.ts', line: 1,
        claim: 'check it', failureScenario: 'n/a',
        checkCommand: `touch ${join(repo, 'HACKED')}`,
      }],
      criteriaAssessment: [],
    }))
    const shown: string[][] = []
    const result = await runReviewLane({
      config: config(), brief: 'review',
      confirmFindingChecks: async (commands) => { shown.push(commands); return false },
    })
    expect(result.status).toBe('completed')
    expect(shown[0]![0]).toContain('HACKED')
    expect(result.findingChecks[0]).toMatchObject({ ran: false, result: null })
    expect(() => execFileSync('test', ['-e', join(repo, 'HACKED')])).toThrow()
  })

  it('names a failed detached-worktree baseline as environment-unproven evidence', async () => {
    writeFileSync(join(queue, '0.json'), JSON.stringify({ risks: [{ id: 'r', text: 'x', howToCheck: 'y' }] }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({ verdict: 'PASS', findings: [], criteriaAssessment: [] }))
    const cfg = ProjectConfig.parse({
      name: 'review', repo,
      // Depends on a file that only exists in the REAL checkout (untracked),
      // so the fresh detached baseline tree fails for environmental reasons —
      // exactly the uninstalled-dependencies shape.
      gates: [{ name: 'needs-env', command: 'test -e node_modules.marker', proves: 'env-dependent check', baselineSubset: true }],
      roles: {
        implement: { cli: 'codex', model: 'sol', sandbox: 'workspace-write' },
        review: { cli: 'claude', model: 'opus', sandbox: 'read-only' },
      },
    })
    writeFileSync(join(repo, 'node_modules.marker'), '')
    const result = await runReviewLane({ config: cfg, brief: 'review' })
    expect(result.caveats.some((caveat) => caveat.includes('environment-unproven'))).toBe(true)
    expect(result.caveats[0]).toContain('needs-env')
  })

  it('reports both dispatches to the attempt observer', async () => {
    writeFileSync(join(queue, '0.json'), JSON.stringify({ risks: [{ id: 'r', text: 'x', howToCheck: 'y' }] }))
    writeFileSync(join(queue, '1.json'), JSON.stringify({ verdict: 'PASS', findings: [], criteriaAssessment: [] }))
    const started: string[] = []
    const finished: string[] = []
    let n = 0
    const result = await runReviewLane({
      config: config(), brief: 'review',
      observer: {
        start: (a) => { started.push(`${a.phase}:${a.role}`); return `att-${++n}` },
        finish: (id) => finished.push(id),
      },
    })
    expect(result.status).toBe('completed')
    expect(started).toEqual(['risk:review', 'review:review'])
    expect(finished).toEqual(['att-1', 'att-2'])
  })
})
