import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render } from 'ink'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Prompt } from '../src/prompt.tsx'
import { Dashboard } from '../src/dashboard.tsx'
import { App, ApprovalPanel, RepoPicker, SLASH_COMMANDS, slashResult } from '../src/app.tsx'
import { clip, draftRows } from '../src/terminal-ui.tsx'
import { Store } from '../src/store.ts'
import { Plan, ProjectConfig } from '../src/types.ts'
import { fakeTerminal } from './fake-terminal.ts'

const tick = () => new Promise((r) => setTimeout(r, 85))
let home: string
let store: Store
const apps: Array<ReturnType<typeof render>> = []
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'arc-ux-')); store = new Store(home) })
afterEach(() => { for (const app of apps.splice(0)) app.unmount(); store.close(); rmSync(home, { recursive: true, force: true }) })
function paint(node: React.ReactNode, width = 80, rows = 24) {
  const terminal = fakeTerminal(width, rows)
  apps.push(render(node, { stdout: terminal.stream, stdin: terminal.stdin, patchConsole: false, exitOnCtrlC: false }))
  return terminal
}
const plan = (id = 'mission', count = 1) => Plan.parse({ arcId: id, charter: { goal: `Goal for ${id}` }, tasks: Array.from({ length: count }, (_, i) => ({
  id: `task${i + 1}`, title: `Feature ${i + 1}`, spec: `Implement feature ${i + 1}`,
  footprint: [`src/feature${i + 1}.ts`], acceptance: [{ id: 'proof', text: `Feature ${i + 1} works`, proofKind: 'command', proofCommand: `verify-feature-${i + 1} --strict`, requiredTier: 'observed' }],
})) })
function seed(id = 'mission', count = 1, threadId?: string) {
  const p = plan(id, count); store.createArc(p, home, 'a'.repeat(40), `arc/${id}-integration`, threadId); return p
}
async function send(out: ReturnType<typeof fakeTerminal>, text: string) { out.send(text); await tick(); out.send('\r'); await tick() }
function config() {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: home })
  return ProjectConfig.parse({ name: 'ux', repo: home, roles: { implement: { cli: 'codex', model: 'fixture' } }, gates: [{ name: 'test', command: 'true', proves: 'tests pass' }] })
}

describe('composer navigation', () => {
  it('releases raw input when a panel gives up keyboard ownership', async () => {
    const out = fakeTerminal(80)
    const raw = vi.spyOn(out.stdin, 'setRawMode')
    const props = { busy: false, history: [], onSubmit: vi.fn(), onExit: vi.fn() }
    const app = render(<Prompt {...props} active />, { stdout: out.stream, stdin: out.stdin, patchConsole: false, exitOnCtrlC: false })
    apps.push(app)
    await tick(); expect(raw).toHaveBeenCalledWith(true)
    app.rerender(<Prompt {...props} active={false} />)
    await tick(); expect(raw).toHaveBeenCalledWith(false)
  })
  it('keeps the final slash command visible and runs the selected command', async () => {
    const submit = vi.fn()
    const out = paint(<Prompt busy={false} history={[]} onSubmit={submit} onExit={vi.fn()} slashCommands={SLASH_COMMANDS} />)
    await tick(); out.send('/'); await tick()
    out.send('\x1b[B'.repeat(SLASH_COMMANDS.length - 1)); await tick()
    expect(out.text()).toContain('❯ /quit')
    expect(out.text()).toContain(`${SLASH_COMMANDS.length}/${SLASH_COMMANDS.length}`)
    out.send('\r'); await tick()
    expect(submit).toHaveBeenCalledWith('/quit')
  })

  it('dismisses the menu before Escape interrupts active work', async () => {
    const stop = vi.fn()
    const out = paint(<Prompt busy history={[]} onSubmit={vi.fn()} onInterrupt={stop} onExit={vi.fn()} slashCommands={SLASH_COMMANDS} />)
    await tick(); out.send('/'); await tick(); out.send('\x1b'); await tick()
    expect(stop).not.toHaveBeenCalled()
    out.send('\x1b'); await tick(); expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps a large pasted draft bounded and submits every line intact', async () => {
    const submit = vi.fn()
    const out = paint(<Prompt busy={false} history={[]} onSubmit={submit} onExit={vi.fn()} />)
    const draft = Array.from({ length: 35 }, (_, i) => `requirement ${i + 1}`).join('\n')
    await tick(); out.send(`\x1b[200~${draft}\x1b[201~`); await tick()
    expect(out.text()).toContain('35/35 lines')
    expect(out.text()).toContain('requirement 35')
    expect(out.text()).not.toContain('requirement 1\n')
    expect(out.text().split('\n').length).toBeLessThan(12)
    out.send('\r'); await tick(); expect(submit).toHaveBeenCalledWith(draft)
  })

  it('wraps an unbroken draft without losing content or overflowing the terminal', async () => {
    const submit = vi.fn()
    const out = paint(<Prompt busy={false} history={[]} onSubmit={submit} onExit={vi.fn()} />, 40)
    const draft = 'abcdef'.repeat(100)
    await tick(); out.send(draft); await tick()
    expect(out.text().split('\n').length).toBeLessThan(12)
    expect(out.text().split('\n').every((l) => l.length <= 40)).toBe(true)
    out.send('\r'); await tick(); expect(submit).toHaveBeenCalledWith(draft)
  })

  it('clips at grapheme boundaries and removes terminal controls from display content', () => {
    expect(clip('ab😀cd', 5)).toBe('ab😀…')
    expect(clip('e\u0301clair', 3)).toBe('e\u0301c…')
    expect(clip('\x1b[31mhello\x1b[0m', 8)).toBe('hello')
    expect(draftRows('ab😀cd', 4)).toEqual([{ text: 'ab😀', start: 0 }, { text: 'cd', start: 4 }])
  })
})

describe('bounded mission dashboard', () => {
  it('scrolls to the last task and clamps navigation without hiding the header or controls', async () => {
    seed('mission', 30)
    const out = paint(<Dashboard store={store} width={80} interactive />)
    await tick(); out.send('\x1b[B'.repeat(40)); await tick()
    expect(out.text()).toContain('ARC / mission')
    expect(out.text()).toContain('task30 · Feature 30')
    expect(out.text()).toContain('enter open')
    out.send('\x1b[A'); await tick()
    expect(out.text()).toContain('29/30')
  })

  it('does not jump to a newly inserted run while polling', async () => {
    seed('original')
    const out = paint(<Dashboard store={store} width={80} interactive />)
    await tick(); seed('newer')
    await new Promise((r) => setTimeout(r, 1150))
    expect(out.text()).toContain('Goal for original')
    expect(out.text()).not.toContain('Goal for newer')
  })

  it('honors an explicit run instead of the newest or running one', async () => {
    seed('older'); store.closeArc('older', 'incomplete'); seed('newer')
    const out = paint(<Dashboard store={store} width={80} interactive={false} initialArcId="older" />)
    await tick(); expect(out.text()).toContain('Goal for older')
  })

  it('shows the selected design session even when older build runs exist', async () => {
    seed('old-build'); store.startDesign('designing', 'Investigate checkout failures')
    const out = paint(<Dashboard store={store} width={80} interactive initialArcId="designing" />)
    await tick()
    expect(out.text()).toContain('Designing')
    expect(out.text()).not.toContain('Goal for old-build')
  })

  it('compares evidence against its required tier instead of labeling checked proof sufficient', async () => {
    seed()
    store.db.prepare("UPDATE criterion SET tier = 'checked'").run()
    const out = paint(<Dashboard store={store} width={80} interactive />)
    await tick(); expect(out.text()).toContain('0/1 evidence requirements met')
    out.send('\t'); await tick(); out.send('\t'); await tick()
    expect(out.text()).toContain('checked → needs observed')
  })

  it('names operator blockers and includes quarantined tasks in the attention filter', async () => {
    seed('mission', 3)
    store.setTaskState('mission', 'task2', 'quarantined')
    store.addPendingOp('mission', 'task2', 'capability', 'Prepare the test database', true)
    const out = paint(<Dashboard store={store} width={80} interactive />)
    await tick(); expect(out.text()).toContain('1 blocking operation')
    out.send('f'); await tick()
    expect(out.text()).toContain('quarantined')
    expect(out.text()).not.toContain('task1 ·')
    out.send('\x1b[Z'); await tick() // backwards Tab opens Actions
    expect(out.text()).toContain('Prepare the test database')
  })

  it('keeps task evidence readable through paging, including full long commands', async () => {
    seed()
    const command = 'verify ' + 'very-long-path/'.repeat(12) + 'IMPORTANT-SUFFIX'
    store.db.prepare('UPDATE criterion SET proof_command = ?').run(command)
    const out = paint(<Dashboard store={store} width={80} interactive />)
    await tick(); out.send('\r'); await tick()
    let seen = out.text()
    for (let i = 0; i < 5; i++) { out.send('\x1b[6~'); await tick(); seen += out.text() }
    expect(seen).toContain('IMPORTANT-SUFFIX')
    expect(out.text()).toContain('esc to go back')
  })

  it('returns to its parent without quitting or cancelling the mission', async () => {
    seed()
    const close = vi.fn(), exit = vi.fn()
    const out = paint(<Dashboard store={store} width={80} interactive compact onClose={close} onExit={exit} />)
    await tick(); out.send('q'); await tick()
    expect(close).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled()
    expect(store.getArc('mission')!.status).toBe('running')
  })

  it('reflows on a terminal resize and keeps navigation on screen', async () => {
    seed('mission', 20)
    const out = paint(<Dashboard store={store} width={100} interactive />, 100, 32)
    await tick()
    out.stream.columns = 48; out.stream.rows = 20; out.stream.emit('resize'); await tick()
    expect(out.text()).toContain('ARC / mission')
    expect(out.text()).toContain('enter open')
    expect(out.text().split('\n').every((l) => l.length <= 48)).toBe(true)
  })
})

describe('guided work and recovery', () => {
  it('opens and closes dashboard and workflow selection through the real conversation prompt', async () => {
    const cfg = config()
    const out = paint(<App store={store} config={cfg} danger={false} />, 100, 32)
    await tick(); expect(out.text()).toContain('Turn a request into checked work')
    await send(out, '/dashboard')
    expect(out.text()).toContain('Your first mission starts with a brief')
    out.send('\x1b'); await tick()
    await send(out, '/lane')
    expect(out.text()).toContain('Choose a workflow')
    out.send('\x1b[B\x1b[B'); await tick(); out.send('\r'); await tick()
    expect(out.scrollback()).toContain('locked to the deep lane')
    expect(store.latestDesignId()).toBeUndefined()
  })

  it('reviews a large plan and its actual commands without accidentally approving it', async () => {
    const decision = vi.fn()
    const out = paint(<ApprovalPanel plan={plan('approval', 20)} width={80} mainBranch="main" landStrategy="none"
      onDecision={decision} onCancel={vi.fn()} onExit={vi.fn()} />)
    await tick(); out.send('\x1b[B'.repeat(19)); await tick()
    expect(out.text()).toContain('Task 20/20 details')
    let seen = out.text()
    for (let i = 0; i < 3; i++) { out.send('\x1b[6~'); await tick(); seen += out.text() }
    expect(seen).toContain('verify-feature-20 --strict')
    expect(out.text()).toContain('Build it?')
    expect(decision).not.toHaveBeenCalled()
    out.send('n'); await tick(); expect(decision).toHaveBeenCalledWith(false)
  })

  it('filters repositories and refuses Enter on an empty result', async () => {
    const pick = vi.fn()
    const out = paint(<RepoPicker candidates={['/repos/alpha', '/repos/beta', '/repos/gamma']} onPick={pick} />)
    await tick(); out.send('missing'); await tick(); out.send('\r'); await tick()
    expect(pick).not.toHaveBeenCalled()
    expect(out.text()).toContain('No repositories match')
    out.send('\x1b'); await tick(); out.send('beta'); await tick(); out.send('\r'); await tick()
    expect(pick).toHaveBeenCalledWith('/repos/beta')
  })

  it('resolves an operation with an explicit note and scopes it to the inspected run', () => {
    seed('first'); seed('second')
    store.addPendingOp('first', 'task1', 'external', 'Prepare database', true)
    const op = store.pendingOps('first')[0]!
    expect(slashResult(`/ops resolve ${op.id} prepared`, store, 'second')).toMatchObject({ text: expect.stringContaining('No open operation') })
    expect(store.pendingOps('first')).toHaveLength(1)
    expect(slashResult(`/ops resolve ${String(op.id).slice(0, 8)} prepared`, store, 'first')).toMatchObject({ text: expect.stringContaining('Resolution recorded') })
    expect(store.pendingOps('first')).toHaveLength(0)
    expect(store.eventsSince('first', 0).at(-1)?.payload).toMatchObject({ note: 'prepared', source: 'operator' })
  })

  it('finds the latest mission within a thread, keeping focused work separate from resumable builds', () => {
    const a = store.createThread({ repo: home, title: 'a' })
    const b = store.createThread({ repo: home, title: 'b' })
    seed('first', 1, a); seed('other', 1, b)
    store.startDesign('research', 'investigate', a)
    store.db.prepare("UPDATE design SET created_at = created_at + 100 WHERE arc_id = 'research'").run()
    expect(store.latestThreadRunId(a)).toBe('research')
    expect(store.latestThreadRunId(a, true)).toBe('first')
    expect(store.latestThreadRunId(b)).toBe('other')
  })
})
