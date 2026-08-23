/**
 * Terminal key decoding.
 *
 * Ink's own `useInput` collapses everything into a character plus a few
 * booleans, which cannot represent shift+enter, ctrl+left, home, or a paste.
 * Those are the things a text box actually needs, so we read stdin ourselves.
 *
 * Shift+enter is the one worth explaining. A terminal does NOT send anything
 * distinguishable for it by default — plain enter and shift+enter both arrive
 * as \r. You have to ASK for the disambiguated form first, and there are two
 * competing ways to ask:
 *
 *   kitty keyboard protocol   CSI >1u      → shift+enter becomes ESC[13;2u
 *   xterm modifyOtherKeys     CSI >4;2m    → shift+enter becomes ESC[27;2;13~
 *
 * We turn on both. Terminals ignore the one they do not speak, and anything
 * that speaks neither still works — it just falls back to `\` + enter.
 */

export interface Key {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** Literal text to insert (printable input and pastes). */
  text: string
}

const ESC = '\u001b'

/** Ask the terminal for disambiguated keys, and for bracketed paste. */
export function enableKeyProtocols(out: NodeJS.WriteStream): void {
  out.write(`${ESC}[>1u`)      // kitty: report alternate keys
  out.write(`${ESC}[>4;2m`)    // xterm: modifyOtherKeys level 2
  out.write(`${ESC}[?2004h`)   // bracketed paste
}

export function disableKeyProtocols(out: NodeJS.WriteStream): void {
  out.write(`${ESC}[?2004l`)
  out.write(`${ESC}[>4;0m`)
  out.write(`${ESC}[<1u`)
}

const CSI_U = /^\u001b\[(\d+)(?:;(\d+))?u/
const MODIFY_OTHER = /^\u001b\[27;(\d+);(\d+)~/
const CSI_ARROW = /^\u001b\[(?:(\d+);(\d+))?([ABCDHF])/
const CSI_TILDE = /^\u001b\[(\d+)(?:;(\d+))?~/

/** xterm modifier bitmask, 1-based: 1=none, 2=shift, 3=alt, 5=ctrl … */
function mods(n: number): { shift: boolean; meta: boolean; ctrl: boolean } {
  const m = Math.max(0, n - 1)
  return { shift: (m & 1) !== 0, meta: (m & 2) !== 0, ctrl: (m & 4) !== 0 }
}

function named(name: string, m = { shift: false, meta: false, ctrl: false }): Key {
  return { name, ctrl: m.ctrl, meta: m.meta, shift: m.shift, text: '' }
}

const CODEPOINT_NAMES: Record<number, string> = {
  13: 'return', 10: 'return', 27: 'escape', 9: 'tab', 127: 'backspace', 32: 'space',
}

const TILDE_NAMES: Record<number, string> = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
  7: 'home', 8: 'end',
}

const ARROW_NAMES: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
}

/**
 * Decode one chunk of stdin into keys.
 *
 * A chunk can hold several keypresses, or a whole pasted document, so this
 * consumes the buffer rather than assuming one key per read.
 */
export function decode(data: string): Key[] {
  const out: Key[] = []
  let s = data

  while (s.length > 0) {
    // ---- bracketed paste: everything up to the terminator is literal text.
    if (s.startsWith(`${ESC}[200~`)) {
      const end = s.indexOf(`${ESC}[201~`)
      const body = end >= 0 ? s.slice(6, end) : s.slice(6)
      // A paste is text, never a command: newlines inside it stay newlines and
      // must not submit the form.
      out.push({ name: 'paste', ctrl: false, meta: false, shift: false, text: body })
      s = end >= 0 ? s.slice(end + 6) : ''
      continue
    }

    let m: RegExpExecArray | null

    // ---- kitty: ESC [ codepoint ; modifier u
    if ((m = CSI_U.exec(s))) {
      const cp = Number(m[1])
      const mm = mods(m[2] ? Number(m[2]) : 1)
      const name = CODEPOINT_NAMES[cp] ?? String.fromCodePoint(cp)
      const printable = !CODEPOINT_NAMES[cp] && !mm.ctrl && !mm.meta
      out.push({ name, ...mm, text: printable ? String.fromCodePoint(cp) : '' })
      s = s.slice(m[0].length)
      continue
    }

    // ---- xterm modifyOtherKeys: ESC [ 27 ; modifier ; codepoint ~
    if ((m = MODIFY_OTHER.exec(s))) {
      const mm = mods(Number(m[1]))
      const cp = Number(m[2])
      const name = CODEPOINT_NAMES[cp] ?? String.fromCodePoint(cp)
      const printable = !CODEPOINT_NAMES[cp] && !mm.ctrl && !mm.meta
      out.push({ name, ...mm, text: printable ? String.fromCodePoint(cp) : '' })
      s = s.slice(m[0].length)
      continue
    }

    // ---- shift+tab arrives as CSI Z ("back-tab"), not as tab with a modifier
    if (s.startsWith(`${ESC}[Z`)) {
      out.push({ name: 'tab', ctrl: false, meta: false, shift: true, text: '' })
      s = s.slice(3)
      continue
    }

    // ---- arrows / home / end, with optional modifiers
    if ((m = CSI_ARROW.exec(s))) {
      const mm = mods(m[2] ? Number(m[2]) : 1)
      out.push(named(ARROW_NAMES[m[3]!] ?? 'unknown', mm))
      s = s.slice(m[0].length)
      continue
    }

    // ---- delete / home / end / page, ESC [ n ~
    if ((m = CSI_TILDE.exec(s))) {
      const mm = mods(m[2] ? Number(m[2]) : 1)
      out.push(named(TILDE_NAMES[Number(m[1])] ?? 'unknown', mm))
      s = s.slice(m[0].length)
      continue
    }

    // ---- ESC then a character: alt+<key>.
    //
    // ESC+CR matters more than it looks. Terminals that speak neither key
    // protocol — VS Code, Cursor, Terminal.app — can still be given a
    // keybinding that sends ESC+CR for shift+enter, which is exactly what
    // `arc setup-terminal` installs. So this has to decode to a RETURN with a
    // modifier, not to a key literally named "\r", or the keybinding lands and
    // still does nothing.
    if (s.length >= 2 && s[0] === ESC && s[1] !== '[' && s[1] !== 'O') {
      const ch = s[1]!
      const code = ch.codePointAt(0)!
      const name = CODEPOINT_NAMES[code] ?? ch
      const isControl = code < 32 || code === 127
      out.push({
        name: isControl ? name : ch,
        ctrl: false, meta: true, shift: false, text: '',
      })
      s = s.slice(2)
      continue
    }

    if (s === ESC) { out.push(named('escape')); break }

    const ch = s[0]!
    const code = ch.codePointAt(0)!

    if (ch === '\r' || ch === '\n') { out.push(named('return')); s = s.slice(1); continue }
    if (ch === '\t') { out.push(named('tab')); s = s.slice(1); continue }
    if (code === 127 || ch === '\b') { out.push(named('backspace')); s = s.slice(1); continue }

    // ---- control characters: ctrl+a is 0x01, ctrl+z is 0x1a
    if (code < 32) {
      out.push({ name: String.fromCharCode(code + 96), ctrl: true, meta: false, shift: false, text: '' })
      s = s.slice(1)
      continue
    }

    // ---- ordinary text. Take the whole printable run at once so a fast paste
    // without bracketing does not arrive one character per render.
    let i = 0
    while (i < s.length) {
      const c = s.codePointAt(i)!
      if (c < 32 || c === 127) break
      i += c > 0xffff ? 2 : 1
    }
    out.push({ name: 'text', ctrl: false, meta: false, shift: false, text: s.slice(0, i) })
    s = s.slice(i)
  }

  return out
}
