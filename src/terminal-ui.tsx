import React, { useEffect, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import { stripVTControlCharacters } from 'node:util'
import { theme } from './theme.ts'

/** Terminal dimensions change without a React render, including while idle. */
export function useTerminalSize() {
  const { stdout } = useStdout()
  const read = () => ({
    width: Math.min(160, Math.max(20, stdout.columns || 80)),
    rows: stdout.rows > 0 ? stdout.rows : undefined,
  })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const resize = () => setSize(read())
    stdout.on('resize', resize)
    resize()
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  return size
}

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const wide = /[\p{Extended_Pictographic}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u
const cells = (s: string) => wide.test(s) ? 2 : /^\p{Mark}+$/u.test(s) ? 0 : 1

/** Receipts and pasted text are content, never terminal control sequences. */
export function plain(text: unknown): string {
  return stripVTControlCharacters(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

export function clip(text: unknown, width: number): string {
  const one = plain(text).replace(/\s+/g, ' ').trim()
  const parts = [...segments.segment(one)].map((p) => p.segment)
  const limit = Math.max(0, width)
  if (parts.reduce((n, p) => n + cells(p), 0) <= limit) return one
  if (limit < 1) return ''
  let result = '', used = 0
  for (const p of parts) {
    if (used + cells(p) > limit - 1) break
    result += p; used += cells(p)
  }
  return `${result}…`
}

/** A moving window keeps the selected row visible, including the final item. */
export function windowStart(selected: number, total: number, size: number): number {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size))
}

/** Visual rows retain UTF-16 offsets so wrapping never changes the draft. */
export function draftRows(text: string, width: number): Array<{ text: string; start: number }> {
  const rows: Array<{ text: string; start: number }> = []
  let row = '', start = 0, used = 0
  for (const part of segments.segment(text)) {
    if (part.segment === '\n') {
      rows.push({ text: row, start }); row = ''; used = 0; start = part.index + 1
      continue
    }
    const size = cells(part.segment)
    if (used + size > Math.max(1, width)) {
      rows.push({ text: row, start }); row = ''; used = 0; start = part.index
    }
    row += part.segment; used += size
  }
  rows.push({ text: row, start })
  return rows
}

export function Section({ title, hint, width }: { title: string; hint?: string; width: number }) {
  const label = clip(`─ ${title}${hint ? ` · ${hint}` : ''} `, width - 1)
  return <Text color={theme.accentDim}>{label}{'─'.repeat(Math.max(0, width - [...label].length))}</Text>
}

export function KeyHint({ children }: { children: React.ReactNode }) {
  return <Box paddingX={1}><Text color={theme.muted}>{children}</Text></Box>
}
