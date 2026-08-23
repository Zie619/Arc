import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useStdin, useStdout } from 'ink'
import { decode, enableKeyProtocols, disableKeyProtocols, type Key } from './keys.ts'
import * as B from './buffer.ts'

/**
 * The input box.
 *
 * Reads stdin directly rather than through Ink's `useInput`, because the keys
 * that make a text box usable — shift+enter, ctrl+left, home, a paste — cannot
 * be expressed in what `useInput` hands you.
 *
 * Everything here is deliberately the behaviour people already have in their
 * fingers: enter sends, shift+enter (or `\`+enter) adds a line, arrows and
 * home/end move, alt/ctrl+arrow jump words, ctrl+a/e/u/k/w do what they do in
 * every shell, and up/down walk your history when the cursor is at the edge.
 */

export interface SlashCommand {
  name: string
  /** Shown after the name; when required, enter completes instead of running. */
  args?: string
  argsRequired?: boolean
  description: string
}

export interface PromptProps {
  onSubmit: (text: string) => void
  /** Typing while it works is allowed; submissions queue instead of blocking. */
  busy: boolean
  placeholder?: string
  history: string[]
  onInterrupt?: () => void
  onExit: () => void
  active?: boolean
  /** shift+tab cycles the mode. It has to be handled here because the Prompt
   *  owns the keyboard whenever the compose box is up. */
  onCycleMode?: (back: boolean) => void
  /** Typing "/" pops a filtered menu of these; ↑↓ choose, tab completes, enter runs. */
  slashCommands?: SlashCommand[]
  /** ctrl+v: returns inserted marker text for a clipboard image, or null. */
  onPasteImage?: () => string | null
}

/**
 * Raw keys, decoded.
 *
 * `active` matters: exactly one consumer may be listening, or a keypress gets
 * handled twice. The screens take turns rather than all subscribing.
 */
export function useRawKeys(onKey: (k: Key) => void, active = true): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin()
  const { stdout } = useStdout()
  const handler = useRef(onKey)
  handler.current = onKey

  useEffect(() => {
    if (!active || !isRawModeSupported || !stdin) return
    setRawMode(true)
    // Ask the terminal to disambiguate keys. Without this, shift+enter and
    // plain enter are byte-identical and no amount of parsing can separate them.
    enableKeyProtocols(stdout)
    const onData = (chunk: Buffer | string) => {
      for (const k of decode(String(chunk))) handler.current(k)
    }
    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      disableKeyProtocols(stdout)
    }
  }, [stdin, isRawModeSupported, setRawMode, stdout, active])
}

export function Prompt({ onSubmit, busy, placeholder, history, onInterrupt, onExit, active = true, onCycleMode, slashCommands, onPasteImage }: PromptProps) {
  const { stdout } = useStdout()
  const [buf, setBuf] = useState<B.Buf>(B.empty)
  const [histAt, setHistAt] = useState<number | null>(null)
  const [blink, setBlink] = useState(true)
  const draftBeforeHistory = useRef('')
  const [menuAt, setMenuAt] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)

  // The menu lives while the draft is a bare "/word": one keystroke into an
  // argument (a space) puts the keyboard back to normal.
  const menuMatches = (slashCommands ?? []).filter((command) =>
    buf.text.startsWith('/') && !buf.text.includes(' ') && !buf.text.includes('\n') &&
    command.name.startsWith(buf.text.toLowerCase()))
  const menuOpen = !menuDismissed && menuMatches.length > 0 && buf.text.length > 0
  const menuPick = menuMatches[Math.min(menuAt, Math.max(0, menuMatches.length - 1))]

  useEffect(() => { setMenuAt(0); setMenuDismissed(false) }, [buf.text])

  useEffect(() => {
    const t = setInterval(() => setBlink((b) => !b), 530)
    return () => clearInterval(t)
  }, [])

  useRawKeys((k) => handle(k), active)

  function handle(k: Key): void {
    // ---- leaving / interrupting
    if (k.ctrl && k.name === 'c') { onExit(); return }
    if (k.ctrl && k.name === 'd') { setBuf((b) => (b.text.length === 0 ? (onExit(), b) : b)); return }
    if (k.name === 'escape') {
      if (menuOpen) { setMenuDismissed(true); return }
      onInterrupt?.()
      return
    }

    // ---- the slash menu owns navigation while it is open
    if (menuOpen && menuPick) {
      if (k.name === 'up') { setMenuAt((i) => Math.max(0, i - 1)); return }
      if (k.name === 'down') { setMenuAt((i) => Math.min(menuMatches.length - 1, i + 1)); return }
      if (k.name === 'tab' && !k.shift) {
        setBuf(B.from(`${menuPick.name}${menuPick.args ? ' ' : ''}`))
        return
      }
      if (k.name === 'return' && !k.shift && !k.meta) {
        if (menuPick.argsRequired) {
          setBuf(B.from(`${menuPick.name} `))
          return
        }
        setBuf(B.empty)
        setHistAt(null)
        queueMicrotask(() => onSubmit(menuPick.name))
        return
      }
    }

    if (k.name === 'tab') { onCycleMode?.(k.shift); return }

    // ---- ctrl+v pulls an image off the system clipboard (terminals paste
    // text on their own; an image never arrives as keystrokes).
    if (k.ctrl && k.name === 'v') {
      const marker = onPasteImage?.()
      if (marker) { setBuf((b) => B.insert(b, marker)); setHistAt(null) }
      return
    }

    // ---- a paste is text, always. Newlines in it are newlines, never a submit.
    if (k.name === 'paste') { setBuf((b) => B.insert(b, k.text)); setHistAt(null); return }

    // ---- newline vs submit
    if (k.name === 'return') {
      if (k.shift || k.meta) { setBuf((b) => B.insert(b, '\n')); return }
      // `\` at the end is the fallback for terminals that will not report
      // shift+enter at all.
      if (buf.text.endsWith('\\')) {
        setBuf(B.insert({ ...buf, cursor: buf.text.length - 1, text: buf.text.slice(0, -1) }, '\n'))
        return
      }
      if (buf.text.trim().length > 0) {
        const text = buf.text
        setBuf(B.empty)
        setHistAt(null)
        // A state updater must stay pure. Calling the parent's onSubmit from
        // inside setBuf made React update App while rendering Prompt.
        queueMicrotask(() => onSubmit(text))
      }
      return
    }

    // ---- readline bindings
    if (k.ctrl) {
      switch (k.name) {
        case 'a': setBuf(B.home); return
        case 'e': setBuf(B.end); return
        case 'u': setBuf(B.killToLineStart); return
        case 'k': setBuf(B.killToLineEnd); return
        case 'w': setBuf(B.killWordLeft); return
        case 'b': setBuf(B.left); return
        case 'f': setBuf(B.right); return
        case 'left': setBuf(B.wordLeft); return
        case 'right': setBuf(B.wordRight); return
      }
    }
    if (k.meta) {
      if (k.name === 'b' || k.name === 'left') { setBuf(B.wordLeft); return }
      if (k.name === 'f' || k.name === 'right') { setBuf(B.wordRight); return }
    }

    switch (k.name) {
      case 'backspace': setBuf(B.backspace); return
      case 'delete': setBuf(B.del); return
      case 'left': setBuf((b) => (k.ctrl || k.meta ? B.wordLeft(b) : B.left(b))); return
      case 'right': setBuf((b) => (k.ctrl || k.meta ? B.wordRight(b) : B.right(b))); return
      case 'home': setBuf(B.home); return
      case 'end': setBuf(B.end); return

      // Up/down move within a multi-line draft; at the edge they walk history,
      // which is what every shell does and what fingers expect.
      case 'up':
        setBuf((b) => {
          const moved = B.upLine(b)
          if (moved) return moved
          if (history.length === 0) return b
          setHistAt((at) => {
            const next = at === null ? history.length - 1 : Math.max(0, at - 1)
            if (at === null) draftBeforeHistory.current = b.text
            queueMicrotask(() => setBuf(B.from(history[next] ?? '')))
            return next
          })
          return b
        })
        return
      case 'down':
        setBuf((b) => {
          const moved = B.downLine(b)
          if (moved) return moved
          setHistAt((at) => {
            if (at === null) return null
            const next = at + 1
            if (next >= history.length) {
              queueMicrotask(() => setBuf(B.from(draftBeforeHistory.current)))
              return null
            }
            queueMicrotask(() => setBuf(B.from(history[next] ?? '')))
            return next
          })
          return b
        })
        return
    }

    if (k.text) { setBuf((b) => B.insert(b, k.text)); setHistAt(null) }
  }

  const cols = Math.min(Math.max(stdout?.columns || 80, 40), 200)
  const rule = '─'.repeat(Math.max(0, cols - 2))
  const lines = buf.text.length === 0 ? [''] : buf.text.split('\n')
  const pos = B.position(buf)

  return (
    <Box flexDirection="column">
      <Text color="gray">{rule}</Text>
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, i) => {
          const marker = i === 0 ? '> ' : '  '
          if (i !== pos.line) {
            return <Text key={i}><Text color="gray">{marker}</Text>{line}</Text>
          }
          const before = line.slice(0, pos.col)
          const under = line[pos.col] ?? ' '
          const after = line.slice(pos.col + 1)
          const showHint = buf.text.length === 0 && placeholder
          return (
            <Text key={i}>
              <Text color="cyan">{marker}</Text>
              {before}
              <Text inverse={blink}>{under}</Text>
              {showHint ? <Text color="gray">{placeholder}</Text> : after}
            </Text>
          )
        })}
      </Box>
      {menuOpen && (() => {
        const leftWidth = Math.max(...menuMatches.map((command) =>
          `${command.name}${command.args ? ` ${command.args}` : ''}`.length))
        const descriptionWidth = Math.max(0, cols - leftWidth - 6)
        const sel = Math.min(menuAt, menuMatches.length - 1)
        return (
          <Box flexDirection="column" paddingX={1}>
            {menuMatches.slice(0, 8).map((command, i) => {
              const left = `${command.name}${command.args ? ` ${command.args}` : ''}`
              return (
                <Text key={command.name} color={i === sel ? 'cyan' : 'gray'}>
                  {i === sel ? '❯ ' : '  '}
                  <Text bold>{left.padEnd(leftWidth)}</Text>
                  {'  '}
                  <Text color="gray">{command.description.slice(0, descriptionWidth)}</Text>
                </Text>
              )
            })}
          </Box>
        )
      })()}
      <Text color="gray">{rule}</Text>
    </Box>
  )
}
