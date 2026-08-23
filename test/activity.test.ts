import { describe, expect, it } from 'vitest'
import { describeEvent } from '../src/activity.ts'

describe('activity lines', () => {
  it('names the tool and target for a claude tool_use', () => {
    const line = describeEvent({
      kind: 'assistant',
      payload: { message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/slug.js' } }] } },
    })
    expect(line).toBe('Opus · Edit src/slug.js')
  })

  it('names the command for a codex command_execution', () => {
    const line = describeEvent({
      kind: 'item.started',
      payload: { item: { type: 'command_execution', command: `/bin/zsh -lc 'pnpm test'` } },
    })
    expect(line).toBe('Sol runs pnpm test')
  })

  it('names the files for a codex file_change', () => {
    const line = describeEvent({
      kind: 'item.completed',
      payload: { item: { type: 'file_change', changes: [{ path: '/wt/src/a.ts' }, { path: '/wt/test/a.test.ts' }] } },
    })
    expect(line).toBe('Sol edited a.ts, a.test.ts')
  })

  it('drops lifecycle noise instead of printing raw event kinds', () => {
    // "system" and "result" painted verbatim told the operator nothing —
    // the first dogfood run's detail rows.
    expect(describeEvent({ kind: 'system', payload: { subtype: 'init' } })).toBeNull()
    expect(describeEvent({ kind: 'result', payload: { subtype: 'success' } })).toBeNull()
    expect(describeEvent({ kind: 'turn.completed', payload: { usage: {} } })).toBeNull()
  })

  it('keeps lines to one bounded row', () => {
    const line = describeEvent({
      kind: 'item.started',
      payload: { item: { type: 'command_execution', command: 'x'.repeat(500) } },
    })
    expect(line!.length).toBeLessThanOrEqual(90)
  })
})
