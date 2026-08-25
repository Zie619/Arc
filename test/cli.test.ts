import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version

describe('arc version flag', () => {
  for (const flag of ['--version', '-V']) {
    it(`${flag} prints the package version and exits successfully`, () => {
      const result = spawnSync(process.execPath, ['src/cli.ts', flag], {
        cwd: root,
        encoding: 'utf8',
      })

      expect(result.stdout.trim()).toBe(version)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
    })
  }
})

describe('--until-done is never a silent no-op', () => {
  // The check lived inside `case 'run'`, so the advertised form —
  // `arc "<goal>" --until-done` — accepted the flag, printed it in --help, and
  // supervised nothing at all.
  it('refuses the flag on a command it cannot supervise, and says what to run', () => {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'do the thing', '--until-done'], {
      cwd: root, encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--until-done')
    expect(result.stderr).toContain('arc run plan.yaml --until-done')
  })

  it('accepts it on resume, which owns a run and can be relaunched', () => {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'resume', 'no-such-plan.yaml', '--until-done'], {
      cwd: root, encoding: 'utf8',
    })

    expect(result.stderr).not.toContain('supervises `arc run`')
  })
})
