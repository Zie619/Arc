import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleDiff, changedFiles } from '../src/diff.ts'
import { testsExecuted, testsVanished, matchesGlob, type GateResult } from '../src/gates.ts'

let repo: string
const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arcdiff-'))
  sh('init', '-q', '-b', 'main')
  sh('config', 'user.email', 't@t.t')
  sh('config', 'user.name', 'test')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  sh('add', '-A'); sh('commit', '-q', '-m', 'init')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

function commitFiles(files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  sh('add', '-A'); sh('commit', '-q', '-m', 'change')
}

describe('a reviewer is never quietly shown part of a change', () => {
  it('says so, loudly and by name, when the budget does not fit', () => {
    commitFiles({
      'big.ts': 'export const big = 1\n'.repeat(400),
      'small.ts': 'export const small = 1\n',
    })
    const a = assembleDiff(repo, 'HEAD~1...HEAD', { budget: 200 })

    expect(a.complete).toBe(false)
    // The old code sliced at a byte offset and said nothing. A reviewer that
    // does not know it saw a quarter of a diff returns PASS for the whole task.
    expect(a.text).toContain('INCOMPLETE DIFF')
    expect(a.text).toContain('NOT SHOWN (over budget)')
    // Everything left out is NAMED. Nothing is dropped silently.
    expect([...a.shown, ...a.summarised].sort()).toEqual(['big.ts', 'small.ts'])
    expect(a.text).toContain(a.summarised[0]!)
  })

  it('never cuts mid-hunk — a half hunk reads as a whole one', () => {
    commitFiles({ 'a.ts': 'export const a = 1\n'.repeat(200), 'b.ts': 'export const b = 1\n' })
    const a = assembleDiff(repo, 'HEAD~1...HEAD', { budget: 300 })

    for (const path of a.shown) {
      // Every shown file appears as a complete patch, header and all.
      expect(a.text).toContain(`+++ b/${path}`)
    }
  })

  it('drops lockfiles and build output by name instead of by budget', () => {
    commitFiles({
      'pnpm-lock.yaml': 'lockfile\n'.repeat(500),
      'dist/bundle.js': 'built\n'.repeat(500),
      'src/real.ts': 'export const real = 1\n',
    })
    const a = assembleDiff(repo, 'HEAD~1...HEAD', { budget: 100_000 })

    expect(a.excluded.sort()).toEqual(['dist/bundle.js', 'pnpm-lock.yaml'])
    expect(a.shown).toEqual(['src/real.ts'])
    expect(a.text).toContain('EXCLUDED as generated or vendored')
    expect(a.complete).toBe(false)
  })

  it('spends the budget on the files the caller says are surprising', () => {
    commitFiles({
      'zzz-risky.ts': 'export const risky = 1\n',
      'aaa-boring.ts': 'export const boring = 1\n'.repeat(200),
    })
    const a = assembleDiff(repo, 'HEAD~1...HEAD', { budget: 300, priority: ['zzz-risky.ts'] })

    // Alphabetical order correlates with nothing. Footprint drift and predicted
    // risks are what a reviewer most needs to see.
    expect(a.shown[0]).toBe('zzz-risky.ts')
  })

  it('counts a rename as a rename, not as a delete plus an add', () => {
    writeFileSync(join(repo, 'old.ts'), 'export const x = 1\n'.repeat(50))
    sh('add', '-A'); sh('commit', '-q', '-m', 'add')
    sh('mv', 'old.ts', 'new.ts')
    sh('commit', '-q', '-m', 'rename')

    const files = changedFiles(repo, 'HEAD~1...HEAD')
    // Without -M this is two files and 100 changed lines of nothing.
    expect(files).toHaveLength(1)
    expect(files[0]!.added + files[0]!.deleted).toBe(0)
  })

  it('is complete, and silent about it, when everything fits', () => {
    commitFiles({ 'a.ts': 'export const a = 1\n' })
    const a = assembleDiff(repo, 'HEAD~1...HEAD', { budget: 100_000 })

    expect(a.complete).toBe(true)
    expect(a.text).not.toContain('INCOMPLETE')
  })
})

function gate(over: Partial<GateResult>): GateResult {
  return {
    name: 'suite', command: 'x', proves: 'y', exitCode: 0, pass: true, timedOut: false,
    output: '', signature: '', baseSha: 'base', durationMs: 1, sandboxed: false, ...over,
  }
}

describe('a suite that got greener by losing tests is not greener', () => {
  it('reads the executed count from the runners people actually use', () => {
    expect(testsExecuted('\n Test Files  2 passed (2)\n      Tests  2 failed | 5 passed (7)\n')).toBe(7)
    expect(testsExecuted('Tests:       2 failed, 5 passed, 7 total\n')).toBe(7)
    expect(testsExecuted('==== 5 passed, 2 failed in 0.42s ====\n')).toBe(7)
    // An unrecognised runner returns undefined so the check does not apply,
    // rather than guessing a number and failing honest work.
    expect(testsExecuted('error TS2345: bad\n')).toBeUndefined()
  })

  it('notices proofs disappearing even when both runs exit 0', () => {
    const baseline = gate({ output: 'Tests  7 passed (7)' })
    const after = gate({ output: 'Tests  5 passed (5)' })
    expect(testsVanished(after, baseline)).toBe(2)
    // Adding tests is not a deletion.
    expect(testsVanished(gate({ output: 'Tests  9 passed (9)' }), baseline)).toBe(0)
    // Unparseable at either end means no claim either way.
    expect(testsVanished(gate({ output: 'ok' }), baseline)).toBe(0)
  })

  it('matches the gate surface the way an operator would write it', () => {
    expect(matchesGlob('src/deep/a.test.ts', '**/*.test.*')).toBe(true)
    expect(matchesGlob('a.test.ts', '**/*.test.*')).toBe(true)
    expect(matchesGlob('src/a.ts', '**/*.test.*')).toBe(false)
    expect(matchesGlob('test/x/y.ts', 'test/**')).toBe(true)
    expect(matchesGlob('testing/x.ts', 'test/**')).toBe(false)
    expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/**')).toBe(true)
  })
})
