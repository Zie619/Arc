import { describe, it, expect } from 'vitest'
import { ProjectConfig } from '../src/types.ts'
import { describeConfig } from '../src/config-report.ts'

/** The smallest config the schema accepts; everything else is a default. */
function config(extra: Record<string, unknown> = {}) {
  return ProjectConfig.parse({
    name: 'demo',
    repo: '/tmp/demo',
    roles: { implement: { cli: 'codex', model: 'gpt-5.6-sol' } },
    ...extra,
  })
}

const line = (lines: string[], field: string) => lines.find((l) => l.trim().startsWith(field))!

describe('describeConfig', () => {
  it('attributes a value that differs from the schema default to the source', () => {
    const lines = describeConfig(config({ landStrategy: 'push', maxAttempts: 9 }), 'arc.yaml', [])
    expect(line(lines, 'landStrategy')).toContain('(arc.yaml)')
    expect(line(lines, 'landStrategy')).toContain('push')
    expect(line(lines, 'maxAttempts')).toContain('(arc.yaml)')
    expect(line(lines, 'maxAttempts')).toContain('9')
  })

  it('attributes an untouched value to default', () => {
    const lines = describeConfig(config({ landStrategy: 'push' }), 'arc.yaml', [])
    // Nobody chose `main`, or 4 attempts — knowing that is the whole point.
    expect(line(lines, 'mainBranch')).toContain('(default)')
    expect(line(lines, 'maxAttempts')).toContain('(default)')
  })

  it('never calls name, repo or roles a default — they have none', () => {
    const lines = describeConfig(config(), 'detected', [])
    expect(line(lines, 'name')).toContain('(detected)')
    expect(line(lines, 'repo')).toContain('(detected)')
    expect(line(lines, 'roles')).toContain('(detected)')
    expect(lines.some((l) => l.includes('role implement') && l.includes('gpt-5.6-sol'))).toBe(true)
  })

  it('flags a config with no gates: nothing proves anything', () => {
    const lines = describeConfig(config(), 'detected', [])
    const gaps = lines.filter((l) => l.startsWith('!'))
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain('no gate proves anything')
  })

  it('flags gates that prove no tests, and stays quiet when one does', () => {
    const typecheckOnly = describeConfig(
      config({ gates: [{ name: 'typecheck', command: 'pnpm typecheck', proves: 'the types line up' }] }),
      'arc.yaml', [])
    expect(typecheckOnly.filter((l) => l.startsWith('!'))).toEqual([
      expect.stringContaining('no gate proves the tests pass'),
    ])

    const withTests = describeConfig(
      config({ gates: [{ name: 'unit', command: 'pnpm vitest run', proves: 'the test suite passes' }] }),
      'arc.yaml', [])
    expect(withTests.filter((l) => l.startsWith('!'))).toEqual([])
  })

  it('prints what each gate proves, not just that a gate exists', () => {
    const lines = describeConfig(
      config({ gates: [{ name: 'test', command: 'pnpm test', proves: 'the suite passes', heavy: true }] }),
      'arc.yaml', ['config: arc.yaml'])
    expect(lines[1]).toBe('  config: arc.yaml')
    expect(lines.some((l) => l.includes('proves: the suite passes'))).toBe(true)
    expect(lines.some((l) => l.includes('gate test') && l.includes('[heavy]'))).toBe(true)
  })
})
