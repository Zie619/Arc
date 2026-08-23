import { describe, expect, it } from 'vitest'
import { compileThreadContext, type DurableMessage } from '../src/context.ts'

const message = (id: string, role: DurableMessage['role'], text: string, at: number): DurableMessage =>
  ({ id, role, text, at })

describe('durable thread context', () => {
  it('keeps the goal, constraints and decisions verbatim', () => {
    const result = compileThreadContext({
      goal: 'Never lose this exact goal: Ø.',
      constraints: [{ text: 'No new dependencies', hardness: 'MUST' }],
      decisions: [{ id: 'd1', question: 'UI?', chosen: 'terminal', rejected: ['desktop'] }],
      messages: [], query: 'anything',
    })
    expect(result.text).toContain('Never lose this exact goal: Ø.')
    expect(result.text).toContain('[MUST] No new dependencies')
    expect(result.text).toContain('UI? → terminal; rejected: desktop')
  })

  it('includes recent messages and retrieves relevant older messages', () => {
    const result = compileThreadContext({
      messages: [
        message('old-relevant', 'user', 'The importer graph needs provenance edges', 1),
        message('old-noise', 'assistant', 'A completely unrelated greeting', 2),
        message('recent', 'user', 'Continue the implementation', 3),
      ],
      recentMessages: 1,
      query: 'How should importer provenance work?',
    })
    expect(result.includedMessageIds).toEqual(['recent', 'old-relevant'])
    expect(result.text).not.toContain('unrelated greeting')
  })

  it('selects artifacts by query relevance and reports budget omissions', () => {
    const result = compileThreadContext({
      messages: [], query: 'sqlite migration', budgetBytes: 180,
      artifacts: [
        { id: 'a', kind: 'finding', text: 'sqlite migration '.repeat(20), at: 1 },
        { id: 'b', kind: 'finding', text: 'terminal paint', at: 2 },
      ],
    })
    expect(result.includedArtifactIds).toEqual([])
    expect(result.omitted).toContain('artifact:a')
  })

  it('fails instead of truncating an oversized formal agreement', () => {
    expect(() => compileThreadContext({
      goal: 'x'.repeat(100), messages: [], query: '', budgetBytes: 20,
    })).toThrow('formal thread agreement')
  })

  it('retrieves for a non-Latin query instead of silently dropping the whole tier', () => {
    const result = compileThreadContext({
      messages: [
        message('old-cjk', 'user', '登录页面 需要修复 会话超时', 1),
        message('old-noise', 'assistant', 'unrelated chatter entirely', 2),
        message('recent', 'user', 'continue', 3),
      ],
      recentMessages: 1,
      query: '修复 登录页面',
    })
    expect(result.includedMessageIds).toContain('old-cjk')
    expect(result.text).toContain('登录页面')
  })

  it('records zero-scoring candidates as an explicit retrieval note, not silence', () => {
    const result = compileThreadContext({
      messages: [
        message('old-noise', 'user', 'nothing in common with the query', 1),
        message('recent', 'user', 'continue', 2),
      ],
      recentMessages: 1,
      query: 'scheduler contracts',
    })
    expect(result.omitted.some((entry) => entry.includes('scored 0'))).toBe(true)
  })

  it('marks a gap in the dialogue instead of splicing it silently', () => {
    const result = compileThreadContext({
      messages: [
        message('m1', 'user', 'short one', 1),
        message('m2', 'assistant', 'x'.repeat(400), 2),
        message('m3', 'user', 'short two', 3),
      ],
      recentMessages: 3,
      query: '',
      budgetBytes: 220,
    })
    // The oversized middle message is dropped; the prompt itself must say so.
    expect(result.includedMessageIds).toContain('m1')
    expect(result.includedMessageIds).not.toContain('m2')
    expect(result.text).toContain('did not fit the context budget')
  })
})
