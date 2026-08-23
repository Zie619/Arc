import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * Make shift+enter work.
 *
 * Some terminals genuinely cannot send it. Plain enter and shift+enter are the
 * same byte (\r), and the two protocols that would disambiguate them — kitty
 * keyboard and xterm modifyOtherKeys — are not implemented by VS Code, Cursor
 * or Terminal.app. No amount of parsing fixes that; the key never arrives.
 *
 * The way every terminal app solves this is a keybinding that sends something
 * distinguishable. ESC+CR is the conventional choice, and arc decodes it as
 * meta+return. This writes that binding.
 */

export interface SetupResult {
  ok: boolean
  editor: string
  path: string
  message: string
  alreadyPresent?: boolean
}

const BINDING = {
  key: 'shift+enter',
  command: 'workbench.action.terminal.sendSequence',
  args: { text: '\u001b\r' },
  when: 'terminalFocus',
}

interface Target { name: string; dir: string }

function targets(): Target[] {
  const home = homedir()
  const mac = process.platform === 'darwin'
  const base = mac ? join(home, 'Library', 'Application Support') : join(home, '.config')
  return [
    { name: 'VS Code', dir: join(base, 'Code', 'User') },
    { name: 'Cursor', dir: join(base, 'Cursor', 'User') },
    { name: 'VS Code Insiders', dir: join(base, 'Code - Insiders', 'User') },
    { name: 'Windsurf', dir: join(base, 'Windsurf', 'User') },
  ]
}

/** Which editor is this terminal running inside, if any. */
export function detectHost(): string | null {
  if (process.env.TERM_PROGRAM === 'vscode') {
    // Cursor and Windsurf both report as vscode; the app name gives it away.
    const app = process.env.__CFBundleIdentifier ?? ''
    if (app.toLowerCase().includes('cursor')) return 'Cursor'
    if (app.toLowerCase().includes('windsurf')) return 'Windsurf'
    return 'VS Code'
  }
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'Terminal.app'
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2'
  if (process.env.KITTY_WINDOW_ID || process.env.TERM?.includes('kitty')) return 'kitty'
  if (process.env.GHOSTTY_RESOURCES_DIR) return 'Ghostty'
  return null
}

/** Terminals that report shift+enter natively need no setup at all. */
export function needsSetup(): boolean {
  const host = detectHost()
  return host !== 'kitty' && host !== 'Ghostty'
}

export function setupTerminal(): SetupResult[] {
  const out: SetupResult[] = []

  for (const t of targets()) {
    if (!existsSync(t.dir)) continue
    const path = join(t.dir, 'keybindings.json')
    try {
      out.push(install(t.name, path))
    } catch (e) {
      out.push({ ok: false, editor: t.name, path, message: (e as Error).message })
    }
  }

  if (out.length === 0) {
    const host = detectHost() ?? 'this terminal'
    out.push({
      ok: false, editor: host, path: '',
      message:
        `No VS Code-family editor found to configure.\n` +
        (host === 'iTerm2'
          ? `  In iTerm2: Settings → Profiles → Keys → Key Mappings → +\n` +
            `  Shortcut: shift+enter · Action: "Send Escape Sequence" · Esc+: \\r`
          : host === 'Terminal.app'
          ? `  Terminal.app cannot send shift+enter. Use \\ then enter for a new line,\n` +
            `  or switch to iTerm2, Ghostty or kitty, which can.`
          : `  Bind shift+enter to send the two bytes ESC and CR (\\u001b\\r).`),
    })
  }
  return out
}

/**
 * Insert the binding without disturbing anything else in the file.
 *
 * keybindings.json is JSONC — it usually opens with a comment block and may
 * carry the user's own notes. Reformatting it as plain JSON would silently
 * delete those, so this splices in before the closing bracket instead of
 * parsing and re-serialising.
 */
function install(editor: string, path: string): SetupResult {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `// Created by arc\n[\n${indent(JSON.stringify(BINDING, null, 2))}\n]\n`)
    return { ok: true, editor, path, message: 'created, with the shift+enter binding' }
  }

  const raw = readFileSync(path, 'utf8')
  if (raw.includes('terminal.sendSequence') && /\\u001b\\r|\\u001b\\u000d/i.test(raw)) {
    return { ok: true, editor, path, message: 'already set up', alreadyPresent: true }
  }

  const close = raw.lastIndexOf(']')
  if (close === -1) throw new Error(`${path} does not look like a JSON array — add the binding by hand`)

  const before = raw.slice(0, close).trimEnd()
  const needsComma = /[}\]]$/.test(before.trimEnd())
  const body = `${before}${needsComma ? ',' : ''}\n${indent(JSON.stringify(BINDING, null, 2))}\n${raw.slice(close)}`

  // Keep a copy. This is someone's editor config, not ours.
  copyFileSync(path, `${path}.arc-backup`)
  writeFileSync(path, body)
  return { ok: true, editor, path, message: `added shift+enter (backup at ${path}.arc-backup)` }
}

const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n')
