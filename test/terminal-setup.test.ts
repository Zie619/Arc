import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The keybinding install. It edits SOMEONE ELSE'S editor config, so it has to
 * be careful: keep their comments, keep their bindings, take a backup, and
 * never write twice.
 */

const ESC = String.fromCharCode(27)
let home: string
let realHome: string | undefined
let kb: string

// homedir() is read inside the function, not at module load, so pointing HOME
// at a temp directory is enough to keep these tests off the real config.
import { setupTerminal } from '../src/terminal-setup.ts'

beforeEach(() => {
  realHome = process.env.HOME
  home = mkdtempSync(join(tmpdir(), 'tsetup-'))
  process.env.HOME = home
  const userDir = join(home, 'Library', 'Application Support', 'Code', 'User')
  mkdirSync(userDir, { recursive: true })
  kb = join(userDir, 'keybindings.json')
})
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

const parse = (s: string) => JSON.parse(s.replace(/^\/\/.*$/gm, ''))

describe('installing the shift+enter binding', () => {
  it('creates the file when there is none', () => {
    const r = setupTerminal().find((x) => x.editor === 'VS Code')
    expect(r?.ok).toBe(true)
    const written = readFileSync(kb, 'utf8')
    expect(written).toContain('shift+enter')
    expect(written).toContain('terminal.sendSequence')
    // The payload must be ESC then CR. Only CR is a plain enter, which would
    // submit instead of adding a line — the exact bug this command exists for.
    expect(parse(written)[0].args.text).toBe(ESC + '\r')
  })

  it('KEEPS the comments and bindings that were already there', () => {
    // keybindings.json is JSONC and usually opens with a comment block.
    // Re-serialising it as plain JSON would silently delete the user's notes.
    writeFileSync(kb, '// my notes, do not lose these\n[\n  { "key": "ctrl+x", "command": "mine" }\n]\n')
    setupTerminal()
    const after = readFileSync(kb, 'utf8')
    expect(after).toContain('// my notes, do not lose these')
    expect(after).toContain('"ctrl+x"')
    expect(after).toContain('shift+enter')
  })

  it('takes a backup before touching anything', () => {
    writeFileSync(kb, '[\n  { "key": "ctrl+x", "command": "mine" }\n]\n')
    setupTerminal()
    expect(existsSync(kb + '.arc-backup')).toBe(true)
    expect(readFileSync(kb + '.arc-backup', 'utf8')).toContain('ctrl+x')
  })

  it('is safe to run twice — it does not add the binding again', () => {
    setupTerminal()
    const once = readFileSync(kb, 'utf8')
    const second = setupTerminal().find((x) => x.editor === 'VS Code')
    expect(second?.alreadyPresent).toBe(true)
    expect(readFileSync(kb, 'utf8')).toBe(once)
  })

  it('handles an empty array without producing invalid JSON', () => {
    writeFileSync(kb, '[]\n')
    setupTerminal()
    expect(() => parse(readFileSync(kb, 'utf8'))).not.toThrow()
    expect(parse(readFileSync(kb, 'utf8'))).toHaveLength(1)
  })
})
