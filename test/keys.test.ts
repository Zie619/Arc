import { describe, it, expect } from 'vitest'
import { decode } from '../src/keys.ts'

const ESC = String.fromCharCode(27)

describe('shift+enter', () => {
  it('decodes the kitty form (ESC[13;2u)', () => {
    // This is why shift+enter did not work before: a terminal sends plain \r
    // for BOTH enter and shift+enter unless you ask it to disambiguate. Once
    // asked, kitty-protocol terminals send this instead.
    const [k] = decode(`${ESC}[13;2u`)
    expect(k?.name).toBe('return')
    expect(k?.shift).toBe(true)
  })

  it('decodes the xterm modifyOtherKeys form (ESC[27;2;13~)', () => {
    // Ghostty, tmux and xterm use this one instead. Both must work or it
    // silently fails on half of all terminals.
    const [k] = decode(`${ESC}[27;2;13~`)
    expect(k?.name).toBe('return')
    expect(k?.shift).toBe(true)
  })

  it('still reads a plain enter as unshifted, so it submits', () => {
    const [k] = decode('\r')
    expect(k?.name).toBe('return')
    expect(k?.shift).toBe(false)
  })

  it('reads an unmodified kitty enter as unshifted', () => {
    const [k] = decode(`${ESC}[13u`)
    expect(k?.name).toBe('return')
    expect(k?.shift).toBe(false)
  })
})

describe('a paste is text, never commands', () => {
  it('keeps newlines inside a bracketed paste instead of submitting on them', () => {
    // Pasting a three-line brief used to fire three submits.
    const [k] = decode(`${ESC}[200~line one\nline two\nline three${ESC}[201~`)
    expect(k?.name).toBe('paste')
    expect(k?.text).toBe('line one\nline two\nline three')
  })

  it('handles a paste that arrives without its terminator yet', () => {
    const [k] = decode(`${ESC}[200~partial text`)
    expect(k?.name).toBe('paste')
    expect(k?.text).toBe('partial text')
  })
})

describe('movement keys', () => {
  it('decodes the arrows', () => {
    expect(decode(`${ESC}[A`)[0]?.name).toBe('up')
    expect(decode(`${ESC}[B`)[0]?.name).toBe('down')
    expect(decode(`${ESC}[C`)[0]?.name).toBe('right')
    expect(decode(`${ESC}[D`)[0]?.name).toBe('left')
  })

  it('decodes ctrl+arrow for word jumps', () => {
    const [k] = decode(`${ESC}[1;5D`)
    expect(k?.name).toBe('left')
    expect(k?.ctrl).toBe(true)
  })

  it('decodes alt+arrow, which is what macOS terminals send', () => {
    const [k] = decode(`${ESC}[1;3C`)
    expect(k?.name).toBe('right')
    expect(k?.meta).toBe(true)
  })

  it('decodes home, end and delete', () => {
    expect(decode(`${ESC}[H`)[0]?.name).toBe('home')
    expect(decode(`${ESC}[F`)[0]?.name).toBe('end')
    expect(decode(`${ESC}[3~`)[0]?.name).toBe('delete')
  })
})

describe('control and meta', () => {
  it('decodes the readline bindings', () => {
    for (const [seq, name] of [['\x01', 'a'], ['\x05', 'e'], ['\x15', 'u'], ['\x0b', 'k'], ['\x17', 'w']] as const) {
      const [k] = decode(seq)
      expect(k?.name, seq).toBe(name)
      expect(k?.ctrl, seq).toBe(true)
    }
  })

  it('decodes alt+b and alt+f', () => {
    expect(decode(`${ESC}b`)[0]).toMatchObject({ name: 'b', meta: true })
    expect(decode(`${ESC}f`)[0]).toMatchObject({ name: 'f', meta: true })
  })

  it('decodes ctrl+c so it can never be swallowed as text', () => {
    expect(decode('\x03')[0]).toMatchObject({ name: 'c', ctrl: true })
  })

  it('reads a bare escape as escape', () => {
    expect(decode(ESC)[0]?.name).toBe('escape')
  })
})

describe('ordinary typing', () => {
  it('takes a whole printable run at once rather than one char per render', () => {
    const [k] = decode('hello world')
    expect(k?.name).toBe('text')
    expect(k?.text).toBe('hello world')
  })

  it('handles several keypresses arriving in one chunk', () => {
    // A fast typist, or any paste into a terminal without bracketed paste.
    const keys = decode(`ab${ESC}[Dc`)
    expect(keys.map((k) => k.name)).toEqual(['text', 'left', 'text'])
    expect(keys[0]?.text).toBe('ab')
    expect(keys[2]?.text).toBe('c')
  })

  it('keeps emoji and other astral characters intact', () => {
    const [k] = decode('ship it 🚀')
    expect(k?.text).toBe('ship it 🚀')
  })

  it('decodes backspace whichever byte the terminal sends', () => {
    expect(decode('\x7f')[0]?.name).toBe('backspace')
    expect(decode('\b')[0]?.name).toBe('backspace')
  })
})

describe('shift+tab', () => {
  it('decodes CSI Z, which is what terminals actually send', () => {
    // Not "tab with a shift modifier" — terminals send a distinct back-tab
    // sequence. Without this it fell through to the control-character branch
    // and came out as ctrl+{.
    const [k] = decode(`${ESC}[Z`)
    expect(k?.name).toBe('tab')
    expect(k?.shift).toBe(true)
  })

  it('still reads a plain tab as unshifted', () => {
    const [k] = decode('\t')
    expect(k?.name).toBe('tab')
    expect(k?.shift).toBe(false)
  })
})
