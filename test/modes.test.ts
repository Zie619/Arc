import { describe, it, expect } from 'vitest'
import { MODES, mode, nextMode, prevMode } from '../src/modes.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings, setMode, setRole, clearRole, applySettings } from '../src/settings.ts'
import { ProjectConfig } from '../src/types.ts'

describe('modes', () => {
  it('cycles forward and wraps', () => {
    expect(nextMode('ask')).toBe('auto')
    expect(nextMode('auto')).toBe('danger')
    expect(nextMode('plan')).toBe('ask')
  })

  it('cycles backwards too', () => {
    expect(prevMode('auto')).toBe('ask')
    expect(prevMode('ask')).toBe('plan')
  })

  it('gives up exactly one gate per step, so the order is predictable', () => {
    // Cycling should always move in one direction of trust — you should be able
    // to predict what the next press does without reading the label.
    const gates = (n: 'ask' | 'auto' | 'danger') =>
      Number(mode(n).asksQuestions) + Number(mode(n).asksApproval)
    expect(gates('ask')).toBe(2)
    expect(gates('auto')).toBe(1)
    expect(gates('danger')).toBe(0)
  })

  it('plan mode never builds', () => {
    expect(mode('plan').planOnly).toBe(true)
    expect(MODES.filter((m) => m.planOnly)).toHaveLength(1)
  })

  it('every mode explains itself in one line', () => {
    for (const m of MODES) {
      expect(m.hint.length, m.name).toBeGreaterThan(10)
      expect(m.label.length, m.name).toBeGreaterThan(0)
    }
  })

  it('falls back to asking rather than to danger on an unknown name', () => {
    expect(mode('nonsense' as never).name).toBe('ask')
  })
})

describe('settings', () => {
  const baseConfig = () => ProjectConfig.parse({
    name: 'x', repo: '/tmp/x',
    roles: {
      implement: { cli: 'codex', model: 'gpt-5.6-sol', effort: 'high', sandbox: 'workspace-write' },
      review: { cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only', tools: 'Read' },
    },
  })

  let root: string
  const fresh = () => { root = mkdtempSync(join(tmpdir(), 'settings-')); return root }

  it('returns defaults when there is nothing saved', () => {
    const r = fresh()
    try { expect(loadSettings(r).mode).toBe('ask') } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('survives a corrupt settings file instead of crashing', () => {
    // Preferences are not worth refusing to start over.
    const r = fresh()
    try {
      saveSettings(r, { mode: 'danger', roles: {} })
      require('node:fs').writeFileSync(join(r, 'settings.json'), '{ not json')
      expect(loadSettings(r).mode).toBe('ask')
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('remembers the mode and the role overrides', () => {
    const r = fresh()
    try {
      setMode(r, 'danger')
      setRole(r, 'implement', { model: 'gpt-5.6-terra', effort: 'low' })
      const s = loadSettings(r)
      expect(s.mode).toBe('danger')
      expect(s.roles.implement).toEqual({ model: 'gpt-5.6-terra', effort: 'low' })
      clearRole(r, 'implement')
      expect(loadSettings(r).roles.implement).toBeUndefined()
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('layers the override over the project config', () => {
    const merged = applySettings(baseConfig(), { mode: 'ask', roles: { implement: { model: 'gpt-5.6-luna' } } })
    expect(merged.roles.implement!.model).toBe('gpt-5.6-luna')
    expect(merged.roles.review!.model).toBe('opus')   // untouched
  })

  it('accepts the full effort range supported by runtime role bindings', () => {
    const merged = applySettings(baseConfig(), { mode: 'ask', roles: { implement: { effort: 'max' } } })
    expect(merged.roles.implement!.effort).toBe('max')
  })

  it('NEVER lets a model choice widen what an agent may touch', () => {
    // The picker changes model and effort. The cli, the sandbox and the tool
    // allowlist are safety properties and stay where the project put them.
    const merged = applySettings(baseConfig(), {
      mode: 'ask',
      roles: { review: { model: 'sonnet', ...( { sandbox: 'workspace-write', cli: 'codex', tools: '*' } as never) } },
    })
    expect(merged.roles.review!.sandbox).toBe('read-only')
    expect(merged.roles.review!.cli).toBe('claude')
    expect(merged.roles.review!.tools).toBe('Read')
    expect(merged.roles.review!.model).toBe('sonnet')
  })
})

describe('shift+tab is actually wired to the prompt', () => {
  it('the Prompt forwards tab to onCycleMode instead of swallowing it', () => {
    // Easy to add a mode system and forget the key that reaches it: the Prompt
    // owns the keyboard whenever the compose box is up.
    const src = require('node:fs').readFileSync(new URL('../src/prompt.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/if \(k\.name === 'tab'\) \{ onCycleMode\?\.\(k\.shift\)/)
  })

  it('the app passes cycleMode down', () => {
    const src = require('node:fs').readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
    expect(src).toContain('onCycleMode={cycleMode}')
  })
})
