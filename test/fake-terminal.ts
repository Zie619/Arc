import { PassThrough, Writable } from 'node:stream'

/**
 * A small normal-screen terminal for Ink tests.
 *
 * Ink does not write a fresh frame on every render. It erases lines, moves the
 * cursor, and overwrites the live region. Joining stdout chunks therefore
 * keeps text that a real terminal has already removed and lets assertions pass
 * against stale frames. This interprets the CSI sequences Ink emits so tests
 * can ask what is visible now, or what remains recoverable in scrollback.
 */
export function fakeTerminal(columns: number, rows = 40) {
  const lines: string[] = ['']
  let row = 0
  let col = 0

  const ensure = (at: number) => {
    while (lines.length <= at) lines.push('')
  }

  const writeText = (text: string) => {
    ensure(row)
    const line = lines[row] ?? ''
    const padded = line.length < col ? line + ' '.repeat(col - line.length) : line
    lines[row] = padded.slice(0, col) + text + padded.slice(col + text.length)
    col += text.length
  }

  const eraseLine = (mode: number) => {
    ensure(row)
    const line = lines[row] ?? ''
    if (mode === 2) lines[row] = ''
    else if (mode === 1) lines[row] = ' '.repeat(Math.min(col + 1, line.length)) + line.slice(col + 1)
    else lines[row] = line.slice(0, col)
  }

  const eraseDisplay = (mode: number) => {
    if (mode === 3) {
      // Clear scrollback. Ink only emits this as part of a full-terminal reset.
      lines.splice(0, lines.length, '')
      row = 0
      col = 0
      return
    }
    if (mode === 2) {
      for (let i = 0; i < lines.length; i++) lines[i] = ''
    }
  }

  const csi = (paramsText: string, command: string) => {
    if (paramsText.startsWith('?')) return // cursor visibility / synchronized updates
    const params = paramsText.length === 0
      ? [0]
      : paramsText.split(';').map((p) => Number(p || 0))
    const n = params[0] || 1

    switch (command) {
      case 'A': row = Math.max(0, row - n); break
      case 'B': row += n; ensure(row); break
      case 'C': col += n; break
      case 'D': col = Math.max(0, col - n); break
      case 'E': row += n; col = 0; ensure(row); break
      case 'F': row = Math.max(0, row - n); col = 0; break
      case 'G': col = Math.max(0, n - 1); break
      case 'H':
      case 'f': row = Math.max(0, (params[0] || 1) - 1); col = Math.max(0, (params[1] || 1) - 1); ensure(row); break
      case 'J': eraseDisplay(params[0] ?? 0); break
      case 'K': eraseLine(params[0] ?? 0); break
      // SGR and terminal mode sequences do not alter the text buffer.
    }
  }

  const consume = (chunk: string) => {
    for (let i = 0; i < chunk.length;) {
      const ch = chunk[i]!
      if (ch === '\x1b' && chunk[i + 1] === '[') {
        let end = i + 2
        while (end < chunk.length && !/[\x40-\x7e]/.test(chunk[end]!)) end++
        if (end >= chunk.length) break
        csi(chunk.slice(i + 2, end), chunk[end]!)
        i = end + 1
        continue
      }
      if (ch === '\x1b' && chunk[i + 1] === ']') {
        // OSC (for example hyperlinks): discard through BEL or string terminator.
        let end = i + 2
        while (end < chunk.length && chunk[end] !== '\x07' && !(chunk[end] === '\x1b' && chunk[end + 1] === '\\')) end++
        i = chunk[end] === '\x1b' ? end + 2 : end + 1
        continue
      }
      if (ch === '\n') { row++; col = 0; ensure(row); i++; continue }
      if (ch === '\r') { col = 0; i++; continue }
      if (ch === '\b') { col = Math.max(0, col - 1); i++; continue }
      if (ch < ' ') { i++; continue }

      let end = i + 1
      while (end < chunk.length && chunk[end]! >= ' ' && chunk[end] !== '\x1b') end++
      writeText(chunk.slice(i, end))
      i = end
    }
  }

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      consume(String(chunk))
      callback()
    },
  }) as Writable & { columns: number; rows: number; isTTY: boolean }
  stream.columns = columns
  stream.rows = rows
  stream.isTTY = true

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (raw: boolean) => PassThrough
    ref: () => PassThrough
    unref: () => PassThrough
  }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin

  const joined = (selected: string[]) => selected.join('\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
  return {
    stream,
    stdin,
    send: (keys: string) => { stdin.write(keys) },
    /** What is painted in the current viewport. */
    text: () => joined(lines.slice(Math.max(0, lines.length - (stream.rows || rows)))),
    /** Normal-screen contents, including lines recoverable with terminal scrollback. */
    scrollback: () => joined(lines),
  }
}
