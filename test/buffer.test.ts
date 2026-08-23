import { describe, it, expect } from 'vitest'
import * as B from '../src/buffer.ts'

/** `hello| world` — cursor written as a pipe, so intent is readable. */
function buf(s: string): B.Buf {
  const cursor = s.indexOf('|')
  return { text: s.replace('|', ''), cursor: cursor === -1 ? 0 : cursor }
}
function show(b: B.Buf): string {
  return b.text.slice(0, b.cursor) + '|' + b.text.slice(b.cursor)
}

describe('typing and deleting', () => {
  it('inserts at the cursor, not at the end', () => {
    // The old version could only append. Editing anything you had already
    // typed was impossible.
    expect(show(B.insert(buf('hello| world'), ' there'))).toBe('hello there| world')
  })

  it('backspaces the character behind the cursor', () => {
    expect(show(B.backspace(buf('hello| world')))).toBe('hell| world')
  })

  it('does nothing at the very start', () => {
    expect(show(B.backspace(buf('|abc')))).toBe('|abc')
  })

  it('delete removes forwards', () => {
    expect(show(B.del(buf('hel|lo')))).toBe('hel|o')
    expect(show(B.del(buf('hello|')))).toBe('hello|')
  })
})

describe('moving around', () => {
  it('moves by character and stops at both ends', () => {
    expect(show(B.left(buf('ab|c')))).toBe('a|bc')
    expect(show(B.left(buf('|abc')))).toBe('|abc')
    expect(show(B.right(buf('ab|c')))).toBe('abc|')
    expect(show(B.right(buf('abc|')))).toBe('abc|')
  })

  it('jumps by word', () => {
    expect(show(B.wordLeft(buf('one two three|')))).toBe('one two |three')
    expect(show(B.wordLeft(buf('one two |three')))).toBe('one |two three')
    expect(show(B.wordRight(buf('|one two')))).toBe('one| two')
  })

  it('home and end work on the CURRENT line, not the whole buffer', () => {
    expect(show(B.home(buf('first\nsec|ond')))).toBe('first\n|second')
    expect(show(B.end(buf('fir|st\nsecond')))).toBe('first|\nsecond')
  })
})

describe('killing text', () => {
  it('ctrl+w removes the word behind the cursor', () => {
    expect(show(B.killWordLeft(buf('delete this word|')))).toBe('delete this |')
  })
  it('ctrl+u clears back to the start of the line', () => {
    expect(show(B.killToLineStart(buf('keep\nthrow away|')))).toBe('keep\n|')
  })
  it('ctrl+k clears to the end of the line, leaving later lines alone', () => {
    expect(show(B.killToLineEnd(buf('keep |this\nand this')))).toBe('keep |\nand this')
  })
})

describe('multi-line movement', () => {
  it('keeps the column when moving between lines', () => {
    const b = buf('abcdef\nghi|jkl')
    const up = B.upLine(b)!
    expect(show(up)).toBe('abc|def\nghijkl')
    expect(show(B.downLine(up)!)).toBe('abcdef\nghi|jkl')
  })

  it('clamps to the end of a shorter line rather than overshooting', () => {
    expect(show(B.upLine(buf('ab\ncdef|gh'))!)).toBe('ab|\ncdefgh')
  })

  it('returns null at the edges, so the caller can walk history instead', () => {
    // This is what makes up-arrow recall a previous message only when you are
    // already on the first line — exactly how a shell behaves.
    expect(B.upLine(buf('one|line'))).toBeNull()
    expect(B.downLine(buf('one|line'))).toBeNull()
    expect(B.upLine(buf('first\n|second'))).not.toBeNull()
  })

  it('reports the cursor as a line and column', () => {
    expect(B.position(buf('ab\ncd|e'))).toEqual({ line: 1, col: 2 })
  })
})
