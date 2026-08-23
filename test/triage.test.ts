import { describe, it, expect } from 'vitest'
import { quickTriage } from '../src/design.ts'

/**
 * The local fast path. Typing "hey" and waiting while three agents interview,
 * scout and plan was the single worst thing about using this.
 */
describe('quickTriage', () => {
  it('answers a greeting instantly, with no model call at all', () => {
    for (const g of ['hey', 'Hey!', 'hi', 'HELLO', 'thanks', 'yo', 'ok']) {
      const r = quickTriage(g)
      expect(r?.kind, `"${g}" should be chat`).toBe('chat')
      expect(r?.reply.length).toBeGreaterThan(0)
    }
  })

  it('explains itself when asked what it does', () => {
    const r = quickTriage('what can you do')
    expect(r?.kind).toBe('chat')
    expect(r?.reply).toContain('repo')
  })

  it('treats a long brief as work without asking a classifier', () => {
    // Nothing a classifier could add, and the interview re-reads all of it.
    const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ')
    expect(quickTriage(long)?.kind).toBe('work')
  })

  it('defers to the model when it is genuinely ambiguous', () => {
    // Short but actionable, or short and hopeless — either way a local guess
    // would be wrong often enough to be worse than a two-second call.
    for (const t of ['fix login', 'make it better', 'the tests are red', 'why is this slow']) {
      expect(quickTriage(t), `"${t}" should defer`).toBeNull()
    }
  })

  it('defers on empty input rather than inventing a reply', () => {
    expect(quickTriage('   ')).toBeNull()
  })
})
