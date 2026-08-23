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
