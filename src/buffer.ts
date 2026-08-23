/**
 * A text buffer with a cursor.
 *
 * Pure functions over `{ text, cursor }` — every editing operation is a value
 * in, value out, which is the only reason cursor behaviour can be tested
 * without a terminal. Hand-rolling this as append-and-backspace inside a
 * component is what made the first version unusable: no arrow keys, no home,
 * no word jumps, no editing anything you had already typed.
 */

export interface Buf {
  text: string
  /** Index into `text`. Always 0..text.length. */
  cursor: number
}

export const empty: Buf = { text: '', cursor: 0 }

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max))

export function insert(b: Buf, s: string): Buf {
  const at = clamp(b.cursor, b.text.length)
  return { text: b.text.slice(0, at) + s + b.text.slice(at), cursor: at + s.length }
}

export function backspace(b: Buf): Buf {
  if (b.cursor <= 0) return b
  return { text: b.text.slice(0, b.cursor - 1) + b.text.slice(b.cursor), cursor: b.cursor - 1 }
}

export function del(b: Buf): Buf {
  if (b.cursor >= b.text.length) return b
  return { text: b.text.slice(0, b.cursor) + b.text.slice(b.cursor + 1), cursor: b.cursor }
}

export const left = (b: Buf): Buf => ({ ...b, cursor: clamp(b.cursor - 1, b.text.length) })
export const right = (b: Buf): Buf => ({ ...b, cursor: clamp(b.cursor + 1, b.text.length) })

/** Start of the current visual line, not of the whole buffer. */
export function lineStart(b: Buf): number {
  const i = b.text.lastIndexOf('\n', Math.max(0, b.cursor - 1))
  return i === -1 ? 0 : i + 1
}

export function lineEnd(b: Buf): number {
  const i = b.text.indexOf('\n', b.cursor)
  return i === -1 ? b.text.length : i
}

export const home = (b: Buf): Buf => ({ ...b, cursor: lineStart(b) })
export const end = (b: Buf): Buf => ({ ...b, cursor: lineEnd(b) })

const isWord = (c: string) => /\w/.test(c)

export function wordLeft(b: Buf): Buf {
  let i = b.cursor
  while (i > 0 && !isWord(b.text[i - 1]!)) i--
  while (i > 0 && isWord(b.text[i - 1]!)) i--
  return { ...b, cursor: i }
}

export function wordRight(b: Buf): Buf {
  let i = b.cursor
  const n = b.text.length
  while (i < n && !isWord(b.text[i]!)) i++
  while (i < n && isWord(b.text[i]!)) i++
  return { ...b, cursor: i }
}

/** ctrl+w — delete the word behind the cursor. */
export function killWordLeft(b: Buf): Buf {
  const to = wordLeft(b).cursor
  return { text: b.text.slice(0, to) + b.text.slice(b.cursor), cursor: to }
}

/** ctrl+u — delete to the start of the line. */
export function killToLineStart(b: Buf): Buf {
  const s = lineStart(b)
  return { text: b.text.slice(0, s) + b.text.slice(b.cursor), cursor: s }
}

/** ctrl+k — delete to the end of the line. */
export function killToLineEnd(b: Buf): Buf {
  return { text: b.text.slice(0, b.cursor) + b.text.slice(lineEnd(b)), cursor: b.cursor }
}

export interface Position { line: number; col: number }

export function position(b: Buf): Position {
  const before = b.text.slice(0, b.cursor)
  const lines = before.split('\n')
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length }
}

/** Move a line up/down, keeping the column where possible. */
export function upLine(b: Buf): Buf | null {
  const { line, col } = position(b)
  if (line === 0) return null            // caller decides: history, probably
  const lines = b.text.split('\n')
  const target = lines[line - 1]!
  const offset = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
  return { ...b, cursor: offset + Math.min(col, target.length) }
}

export function downLine(b: Buf): Buf | null {
  const { line, col } = position(b)
  const lines = b.text.split('\n')
  if (line >= lines.length - 1) return null
  const target = lines[line + 1]!
  const offset = lines.slice(0, line + 1).reduce((n, l) => n + l.length + 1, 0)
  return { ...b, cursor: offset + Math.min(col, target.length) }
}

export const from = (text: string): Buf => ({ text, cursor: text.length })
