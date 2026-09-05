import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rememberedRepo, rememberRepo } from '../src/repo-choice.ts'

let home: string
let realHome: string | undefined

beforeEach(() => {
  realHome = process.env.HOME
  home = mkdtempSync(join(tmpdir(), 'arc-choice-'))
  process.env.HOME = home
})
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

describe('arc stops asking which repo you meant', () => {
  it.each(['null', '[]', '42', '{"/w/x":42}'])('ignores malformed choice data: %s', (content) => {
    mkdirSync(join(home, '.arc'))
    writeFileSync(join(home, '.arc', 'repo-choice.json'), content)
    expect(rememberedRepo('/w/x')).toBeUndefined()
    expect(rememberedRepo('__proto__')).toBeUndefined()
  })
  it('remembers the choice per directory, and keeps them separate', () => {
    expect(rememberedRepo('/w/gambit')).toBeUndefined()
    rememberRepo('/w/gambit', '/w/gambit/openflow')
    rememberRepo('/w/other', '/w/other/thing')
    expect(rememberedRepo('/w/gambit')).toBe('/w/gambit/openflow')
    expect(rememberedRepo('/w/other')).toBe('/w/other/thing')
  })

  it('overwrites rather than accumulating when you change your mind', () => {
    rememberRepo('/w/gambit', '/w/gambit/openflow')
    rememberRepo('/w/gambit', '/w/gambit/parks')
    expect(rememberedRepo('/w/gambit')).toBe('/w/gambit/parks')
  })

  it('never fails a run over an unreadable or unwritable choice file', () => {
    // A remembered convenience is not worth an exception. HOME pointing at
    // something impossible must degrade to "just ask me".
    process.env.HOME = '/proc/nonexistent-for-sure'
    expect(() => rememberRepo('/w/x', '/w/x/y')).not.toThrow()
    expect(rememberedRepo('/w/x')).toBeUndefined()
  })
})
