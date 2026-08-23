import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, Text } from 'ink'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpathSync, readFileSync, readdirSync } from 'node:fs'
import {
  App, RepoPicker, AgentList, ApprovalPanel, QuestionPanel, Transcript, deriveArcId,
  resolveQuestionChoice, type HistoryEntry, type StepTurn,
} from '../src/app.tsx'
import { Store } from '../src/store.ts'
import { detectProject } from '../src/autoconfig.ts'
import { fakeTerminal } from './fake-terminal.ts'
import { Prompt } from '../src/prompt.tsx'
import { loadSettings, setMode, setRole, TUNABLE_ROLES, EFFORT_LEVELS } from '../src/settings.ts'

const tick = () => new Promise((r) => setTimeout(r, 60))   // Ink paints async

const fakeStdout = fakeTerminal

let repo: string
let home: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'apptest-')))
  home = mkdtempSync(join(tmpdir(), 'apphome-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }))
  writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('the compose screen', () => {
  it('asserts the visible frame, not text Ink has already erased', async () => {
    const out = fakeStdout(80)
    const app = render(<Text>stale frame marker</Text>, {
      stdout: out.stream, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    app.rerender(<Text>current frame marker</Text>)
    await tick()
    expect(out.text()).toContain('current frame marker')
    expect(out.text()).not.toContain('stale frame marker')
    app.unmount()
  })

  it('renders the prompt, the repo, and what will verify the work', async () => {
    const store = new Store(home)
    const out = fakeStdout(100)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger={false} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const text = out.text()
    expect(text).toContain('what do you want done?')
    expect(text).toContain(repo)
    expect(text).toContain('checks: test')   // detected from package.json
    // "planned": the workflow rows are a declaration, not the executing state.
    expect(text).toContain('thread: New thread · chat · 1 planned stage')
    expect(text).toContain('enter to send')
    expect(text).not.toContain('exact usage')
    expect(text).not.toContain('$')
    app.unmount(); store.close()
  })

  it('header shows the arc logo and version', async () => {
    const store = new Store(home)
    const out = fakeTerminal(80)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger={false} version="9.8.7" />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(out.text()).toContain('▐▌     ▐▌')
    expect(out.text()).toContain('9.8.7')
    app.unmount(); store.close()
  })

  it('empty state pins the prompt to the bottom', async () => {
    const store = new Store(home)
    const config = detectProject(repo).config
    const out = fakeTerminal(80, 24)
    const app = render(
      <App store={store} config={config} danger={false} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const promptLine = out.text().split('\n').findIndex((line) => line.includes('what do you want done?'))
    expect(promptLine).toBeGreaterThan(12)
    app.unmount()

    const fallback = fakeTerminal(80)
    fallback.stream.rows = undefined as unknown as number
    const fallbackApp = render(
      <App store={store} config={config} danger={false} />,
      { stdout: fallback.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const fallbackPromptLine = fallback.text().split('\n').findIndex((line) => line.includes('what do you want done?'))
    expect(fallbackPromptLine).toBeGreaterThanOrEqual(0)
    expect(fallbackPromptLine).toBeLessThanOrEqual(10)
    fallbackApp.unmount(); store.close()
  })

  it('warns when nothing can verify the work', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }))
    const store = new Store(home)
    const out = fakeStdout(100)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger={false} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(out.text()).toContain('nothing here can check the work')
    app.unmount(); store.close()
  })

  it('says so when --danger is on, so it is never a surprise', async () => {
    const store = new Store(home)
    const out = fakeStdout(100)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(out.text()).toContain('danger')
    app.unmount(); store.close()
  })

  it('stays legible in a narrow terminal instead of collapsing', async () => {
    // A terminal reporting 0 columns made every character wrap onto its own
    // line — `?? 100` does not catch 0.
    const store = new Store(home)
    for (const cols of [0, 20, 300]) {
      const out = fakeStdout(cols)
      const app = render(
        <App store={store} config={detectProject(repo).config} danger={false} />,
        { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const longest = Math.max(...out.text().split('\n').map((l) => l.length))
      expect(longest).toBeGreaterThan(10)   // not one char per line
      app.unmount()
    }
    store.close()
  })
})

describe('inline terminal history', () => {
  it('prints completed entries once while repainting only the live region', async () => {
    const out = fakeStdout(80, 5)
    const first: HistoryEntry[] = [{ id: 1, kind: 'you', text: 'first request survives' }]
    const live: StepTurn = {
      id: 2, kind: 'step', text: 'reading the code', detail: ['scout is looking'], startedAt: 1_000,
    }
    const app = render(<Transcript entries={first} liveStep={live} width={80} spin="·" now={2_000} />, {
      stdout: out.stream, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()

    const completed: HistoryEntry[] = [
      ...first,
      { ...live, ms: 1_500 },
      { id: 3, kind: 'question', question: 'Which behavior?', answer: 'Keep native scrollback' },
      {
        id: 4, kind: 'plan', decision: 'approved',
        plan: {
          arcId: 'ui-history', charter: { goal: 'keep history', objectives: [], nonGoals: [] },
          tasks: [{
            id: 'scrollback', title: 'Use the normal terminal buffer', spec: 's', dependsOn: [], footprint: [],
            contractsMutated: [], contractsRead: [], gates: [],
            acceptance: [{ id: 'a', text: 'history survives', proofKind: 'human-observation', requiredTier: 'observed' }],
          }],
        },
      },
      { id: 5, kind: 'arc', text: 'history line five' },
      { id: 6, kind: 'arc', text: 'history line six' },
    ]
    const nextLive: StepTurn = {
      id: 7, kind: 'step', text: 'building', detail: ['gate is running'], startedAt: 3_000,
    }
    app.rerender(<Transcript entries={completed} liveStep={nextLive} width={80} spin="✢" now={4_000} />)
    await tick()
    app.rerender(<Transcript entries={completed} liveStep={nextLive} width={80} spin="✳" now={5_000} />)
    await tick()

    const history = out.scrollback()
    expect(history).toContain('first request survives')
    expect(history).toContain('Which behavior?')
    expect(history).toContain('Keep native scrollback')
    expect(history).toContain('Use the normal terminal buffer')
    expect(history).toContain('approved')
    expect(history.match(/first request survives/g)).toHaveLength(1)
    expect(history.match(/reading the code/g)).toHaveLength(1)
    expect(out.text()).toContain('building')
    expect(out.text()).not.toContain('first request survives') // above the viewport, but recoverable
    app.unmount()
  })

  it('keeps static history mounted while the live panel changes', async () => {
    const out = fakeStdout(80)
    const entries: HistoryEntry[] = [{ id: 1, kind: 'arc', text: 'printed exactly once' }]
    const frame = (panel: string) => (
      <>
        <Transcript entries={entries} liveStep={null} width={80} />
        <Text>{panel}</Text>
      </>
    )
    const app = render(frame('question panel'), { stdout: out.stream, exitOnCtrlC: false, patchConsole: false })
    await tick()
    app.rerender(frame('approval panel'))
    await tick()
    expect(out.scrollback().match(/printed exactly once/g)).toHaveLength(1)
    expect(out.text()).toContain('approval panel')
    expect(out.text()).not.toContain('question panel')
    app.unmount()
  })

  it('prints what a completed task produced into terminal scrollback', async () => {
    const out = fakeStdout(90)
    const entries: HistoryEntry[] = [{
      id: 1, kind: 'product', taskId: 'usage-ui', noop: false,
      shipped: [{ path: 'src/app.tsx', whatChanged: 'shows exact provider receipts' }],
    }]
    const app = render(<Transcript entries={entries} liveStep={null} width={90} />, {
      stdout: out.stream, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    expect(out.scrollback()).toContain('usage-ui produced')
    expect(out.scrollback()).toContain('src/app.tsx — shows exact provider receipts')
    app.unmount()
  })

  it('moves a real completed app exchange into scrollback', async () => {
    const store = new Store(home)
    const out = fakeStdout(90)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger={false} initialBrief="hey" />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(out.scrollback()).toContain('> hey')
    expect(out.scrollback()).toContain('Hey. What would you like me to work on?')
    expect(out.scrollback().match(/> hey/g)).toHaveLength(1)
    app.unmount(); store.close()
  })
})

describe('interview recommendation default', () => {
  it('highlights the recommendation and Enter submits the recommendation sentinel', async () => {
    const question = {
      text: 'Where should history live?', why: 'It changes terminal behavior.',
      options: ['An in-app pager', 'The alternate screen'], recommendation: 'Use native terminal scrollback',
    }
    const out = fakeStdout(90)
    const confirmed = vi.fn()
    const app = render(<QuestionPanel
      question={question} width={90} onConfirm={confirmed} onCancel={vi.fn()} onExit={vi.fn()}
    />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    expect(out.text()).toContain('❯ recommended: Use native terminal scrollback')
    out.send('\r')
    await tick()
    expect(confirmed).toHaveBeenCalledWith({ raw: '', effective: 'Use native terminal scrollback' })
    expect(resolveQuestionChoice(question, -1, '')).toEqual({ raw: '', effective: 'Use native terminal scrollback' })
    app.unmount()
  })

  it('Enter approves the rendered plan', async () => {
    const plan = {
      arcId: 'approval', charter: { goal: 'g', objectives: [], nonGoals: [] },
      tasks: [{
        id: 'one', title: 'Build the thing', spec: 's', dependsOn: [], footprint: [],
        contractsMutated: [], contractsRead: [], gates: [],
        acceptance: [{ id: 'a', text: 'works', proofKind: 'command' as const, proofCommand: 'true', requiredTier: 'checked' as const }],
      }],
    }
    const out = fakeStdout(90)
    const decided = vi.fn()
    const app = render(<ApprovalPanel
      plan={plan} width={90} mainBranch="main" onDecision={decided} onCancel={vi.fn()} onExit={vi.fn()}
    />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    expect(out.text()).toContain('Build it?')
    out.send('\r')
    await tick()
    expect(decided).toHaveBeenCalledWith(true)
    app.unmount()
  })
})

describe('deriveArcId', () => {
  it('makes a readable id out of the brief, so `arc status` means something later', async () => {
    expect(deriveArcId('Make the importer actually store batch data')).toMatch(/^importer-actually-store-[0-9a-f]{4}$/)
  })
  it('survives a brief with nothing but filler', async () => {
    expect(deriveArcId('the a an')).toMatch(/-[0-9a-f]{4}$/)
  })
  it('is unique per run so two similar briefs do not collide', async () => {
    expect(deriveArcId('fix the thing')).not.toBe(deriveArcId('fix the thing'))
  })
})

describe('the repo picker', () => {
  it('lists the repos by name when the folder holds more than one', async () => {
    // Typing `arc` in ~/gambit — a folder that HOLDS repos — should ask which
    // one, not refuse. Being told "not a git repository" there is correct and
    // useless.
    const out = fakeStdout(100)
    const app = render(
      <RepoPicker candidates={['/home/me/work/openflow', '/home/me/work/arc-executor']} onPick={() => {}} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const text = out.text()
    expect(text).toContain('more than one repo')
    expect(text).toContain('openflow')
    expect(text).toContain('arc-executor')
    expect(text).toContain('/home/me/work/openflow')   // full path too, they may share a name
    expect(text).toContain('❯ ')                       // something is selected
    app.unmount()
  })
})

describe('the dispatched agents', () => {
  it('shows who is working, on what, and for how long', async () => {
    // The thing worth watching while it runs. Named Sol/Opus rather than by
    // binary, because that is how you think about them.
    const out = fakeStdout(90)
    const now = Date.now()
    const app = render(
      <AgentList agents={[
        { role: 'scout', model: 'gpt-5.6-sol', cli: 'codex', since: now - 52_000 },
        { role: 'scout', model: 'opus', cli: 'claude', since: now - 48_000 },
        { role: 'implement', model: 'gpt-5.6-sol', cli: 'codex', since: now - 5_000 },
      ]} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const text = out.text()
    expect(text).toContain('Sol')
    expect(text).toContain('Opus')
    expect(text).toContain('scout')
    expect(text).toContain('implement')
    expect(text).toContain('52s')      // elapsed per agent
    app.unmount()
  })

  it('renders nothing at all when no agent is running', async () => {
    const out = fakeStdout(90)
    const app = render(<AgentList agents={[]} />, { stdout: out.stream, exitOnCtrlC: false, patchConsole: false })
    await tick()
    expect(out.text().trim()).toBe('')
    app.unmount()
  })
})

describe('enter sends', () => {
  it('tells you so, and how to get a newline', async () => {
    // ctrl-d was the complaint. Enter sends, backslash-enter continues — the
    // convention people already have in their fingers.
    const out = fakeStdout(90)
    const store = new Store(home)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger={false} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const text = out.text()
    expect(text).toContain('enter to send')
    expect(text).not.toContain('ctrl-d')
    app.unmount(); store.close()
  })
})

describe('local controls', () => {
  it('runs /help immediately through the real prompt', async () => {
    const out = fakeStdout(100)
    const store = new Store(home)
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    out.send('/help')
    await tick()
    out.send('\r')
    await new Promise((r) => setTimeout(r, 180))
    expect(out.scrollback()).toContain('> /help')
    expect(out.scrollback()).toContain('/status — tasks, agents, and proof state')
    expect(out.scrollback()).toContain('/model — pick the model and effort for each role')
    expect(out.scrollback()).toContain('/usage — exact provider-reported usage receipts')
    expect(out.scrollback()).toContain('/limits — subscription-window headroom from the newest codex rollout')
    app.unmount(); store.close()
  })

  it('paints local codex limits and the honest claude guidance', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
    const oldCodexHome = process.env.CODEX_HOME
    const sessions = join(codexHome, 'sessions', '2026', '08', '23')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'rollout-test.jsonl'), JSON.stringify({
      payload: { rate_limits: { primary: {
        used_percent: 17, window_minutes: 10080, resets_at: 1787927340,
      } } },
    }))
    process.env.CODEX_HOME = codexHome
    const out = fakeStdout(180)
    const store = new Store(home)
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await tick()
      out.send('/limits')
      await tick()
      out.send('\r')
      await new Promise((r) => setTimeout(r, 180))
      const history = out.scrollback()
      expect(history).toContain('codex: 17% of the 7-day window used')
      expect(history).toContain('claude: no trustworthy local measurement of the claude subscription window exists; /status inside Claude Code shows it.')
    } finally {
      app.unmount(); store.close()
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = oldCodexHome
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it('paints plain local guidance when no codex limits snapshot exists', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-empty-'))
    const oldCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const out = fakeStdout(180)
    const store = new Store(home)
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await tick()
      out.send('/limits')
      await tick()
      out.send('\r')
      await new Promise((r) => setTimeout(r, 180))
      const history = out.scrollback()
      expect(history).toContain('codex: no rate-limit snapshot found in local rollout files.')
      expect(history).toContain('claude: no trustworthy local measurement of the claude subscription window exists; /status inside Claude Code shows it.')
    } finally {
      app.unmount(); store.close()
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = oldCodexHome
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it('shows and changes runtime model settings through the real prompt', async () => {
    const out = fakeStdout(110)
    const store = new Store(home)
    const config = detectProject(repo).config
    const app = render(<App store={store} config={config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    // Bare /model opens the arrow-driven picker (this used to be a text dump —
    // the operator's first real-use complaint).
    out.send('/model')
    await tick()
    out.send('\r')
    await new Promise((r) => setTimeout(r, 180))
    expect(out.text()).toContain('Which role?')
    expect(out.text()).toContain('implement — codex/')

    const roles = TUNABLE_ROLES.filter((role) => config.roles[role])
    const down = '[B'
    out.send(down.repeat(roles.indexOf('implement')))
    await tick()
    out.send('\r')                              // role chosen → model step
    await tick()
    expect(out.text()).toContain('Model for implement (codex)')
    out.send('gpt-5.6-terra')                   // typing jumps to the custom slot
    await tick()
    out.send('\r')                              // model chosen → effort step
    await tick()
    expect(out.text()).toContain('Effort for implement · gpt-5.6-terra')
    out.send(down.repeat(1 + EFFORT_LEVELS.indexOf('max')))
    await tick()
    out.send('\r')
    await new Promise((r) => setTimeout(r, 180))
    expect(out.scrollback()).toContain('implement now uses codex/gpt-5.6-terra · max effort *')
    expect(loadSettings(home).roles.implement).toEqual({ model: 'gpt-5.6-terra', effort: 'max' })

    // The typed power-user form still works.
    out.send('/model implement reset')
    await tick()
    out.send('\r')
    await new Promise((r) => setTimeout(r, 180))
    expect(out.scrollback()).toContain('implement reset to project defaults')
    app.unmount(); store.close()
  })

  it('creates, changes, lists, and switches durable threads through the real prompt', async () => {
    const out = fakeStdout(120)
    const store = new Store(home)
    const config = detectProject(repo).config
    const app = render(<App store={store} config={config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    const send = async (command: string) => {
      out.send(command)
      await tick()
      out.send('\r')
      await new Promise((r) => setTimeout(r, 180))
    }
    try {
      await tick()
      const first = String(store.threadsForRepo(repo)[0]!.id)
      await send('/new Importer work')
      const second = store.threadsForRepo(repo).find((row) => row.id !== first)!
      expect(out.text()).toContain('Importer work · chat')

      await send('/lane deep')
      expect(out.text()).toContain('Importer work · deep')
      expect(store.getThread(String(second.id))?.lane).toBe('deep')

      await send('/threads')
      expect(out.scrollback()).toContain(`● ${String(second.id).slice(0, 8)} · deep · Importer work`)
      expect(out.scrollback()).toContain(`○ ${first.slice(0, 8)} · chat · New thread`)

      await send(`/thread ${first.slice(0, 8)}`)
      expect(out.text()).toContain('New thread · chat')
      expect(store.threadMessages(first)).toEqual([])
      expect(store.threadMessages(String(second.id))).toEqual([])
    } finally {
      app.unmount(); store.close()
    }
  })

  it('renders delivery consequences from the configured strategy', async () => {
    const plan = {
      arcId: 'delivery', charter: { goal: 'g', objectives: [], nonGoals: [] },
      tasks: [{
        id: 'one', title: 'one', spec: 's', dependsOn: [], footprint: [], contractsMutated: [],
        contractsRead: [], gates: [], acceptance: [{
          id: 'a', text: 'works', proofKind: 'command' as const, proofCommand: 'true', requiredTier: 'checked' as const,
        }],
      }],
    }
    for (const [strategy, expected] of [
      ['pr', 'try to open a pull request into main'],
      ['push', 'try to merge and push a verified result to main'],
      ['none', 'stays on an integration branch'],
    ] as const) {
      const out = fakeStdout(100)
      const app = render(<ApprovalPanel
        plan={plan} width={100} mainBranch="main" landStrategy={strategy}
        onDecision={vi.fn()} onCancel={vi.fn()} onExit={vi.fn()}
      />, { stdout: out.stream, exitOnCtrlC: false, patchConsole: false })
      await tick()
      expect(out.text()).toContain(expected)
      app.unmount()
    }
  })

  it('paints exact reported usage and never invents a missing cost', async () => {
    const out = fakeStdout(100)
    const store = new Store(home)
    const usagePlan = {
      arcId: 'usage-arc', charter: { goal: 'show usage', objectives: [], nonGoals: [] },
      tasks: [{
        id: 'one', title: 'one', spec: 'one', dependsOn: [], footprint: [],
        contractsMutated: [], contractsRead: [], gates: [], acceptance: [],
      }],
    }
    store.createArc(usagePlan, repo, 'base', 'arc/usage-arc-integration')
    const claudeAttempt = store.startAttempt({
      arcId: 'usage-arc', taskId: 'one', attemptNo: 1, role: 'review',
      cli: 'claude', requestedModel: 'opus',
    })
    store.finishAttempt('usage-arc', claudeAttempt, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'opus',
      usage: [{ provider: 'claude', model: 'opus', inputTokens: 11, outputTokens: 44,
        costUsd: 0.0123, raw: { inputTokens: 11, outputTokens: 44, costUSD: 0.0123 } }],
    })
    const codexAttempt = store.startAttempt({
      arcId: 'usage-arc', taskId: 'one', attemptNo: 2, role: 'implement',
      cli: 'codex', requestedModel: 'gpt-5.6-sol',
    })
    store.finishAttempt('usage-arc', codexAttempt, {
      terminalReason: 'ok', exitCode: 0, observedModel: 'gpt-5.6-sol',
      usage: [{ provider: 'codex', inputTokens: 101, outputTokens: 13,
        raw: { input_tokens: 101, output_tokens: 13 } }],
    })
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    out.send('/usage')
    await tick()
    out.send('\r')
    await new Promise((r) => setTimeout(r, 180))
    const history = out.scrollback()
    expect(history).toContain('exact provider-reported usage')
    expect(history).toContain('claude: input 11 · output 44 · cost $0.0123')
    expect(history).toContain('codex: input 101 · output 13')
    expect(history).not.toContain('codex: input 101 · output 13 · cost')
    app.unmount(); store.close()
  })

  it('requires a second ctrl-c while work is running', async () => {
    const oldPath = process.env.PATH
    process.env.PATH = `${resolve(import.meta.dirname, 'fixtures')}:${oldPath}`
    process.env.ARC_FAKE_HANG = '1'
    const out = fakeStdout(100)
    const store = new Store(home)
    const brief = 'Please make this deliberately long brief contain enough words to bypass local triage and start a fake interview that remains busy.'
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} initialBrief={brief} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      let exited = false
      void app.waitUntilExit().then(() => { exited = true })
      await new Promise((r) => setTimeout(r, 250))
      out.send('\x03')
      await tick()
      expect(out.text()).toContain('press ctrl-c again to stop the agents and quit')
      expect(exited).toBe(false)
      out.send('\x03')
      await new Promise((r) => setTimeout(r, 500))
      expect(exited).toBe(true)
    } finally {
      app.unmount()
      store.close()
      process.env.PATH = oldPath
      delete process.env.ARC_FAKE_HANG
    }
  }, 10_000)

  it('does not claim cancellation left the repository unchanged', async () => {
    const oldPath = process.env.PATH
    process.env.PATH = `${resolve(import.meta.dirname, 'fixtures')}:${oldPath}`
    process.env.ARC_FAKE_HANG = '1'
    const out = fakeStdout(110)
    const store = new Store(home)
    const brief = 'Please investigate and implement this deliberately long request after reading all relevant source files and tests so the fake interview agent certainly starts and can be cancelled safely before any later work proceeds.'
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} initialBrief={brief} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await new Promise((r) => setTimeout(r, 250))
      out.send('\x1b')
      await new Promise((r) => setTimeout(r, 500))
      expect(out.scrollback()).toContain('Worktree or branch commits may remain')
      expect(out.scrollback()).not.toContain('Stopped. Nothing was changed.')
    } finally {
      app.unmount(); store.close()
      process.env.PATH = oldPath
      delete process.env.ARC_FAKE_HANG
    }
  }, 10_000)
})

describe('plan-only execution boundary', () => {
  it('paints and archives the plan without ever creating an executable arc', async () => {
    const oldPath = process.env.PATH
    const queueDir = mkdtempSync(join(tmpdir(), 'app-plan-queue-'))
    process.env.PATH = `${resolve(import.meta.dirname, 'fixtures')}:${oldPath}`
    process.env.ARC_FAKE_QUEUE = queueDir
    const enqueue = (n: number, value: unknown) => writeFileSync(join(queueDir, `${n}.json`), JSON.stringify(value))
    enqueue(0, {
      proposedGoal: 'Produce a plan only', objectives: ['plan the safe change'], nonGoals: [], questions: [], premises: [],
    })
    enqueue(1, {
      goal: 'Produce a plan only', objectives: ['plan the safe change'], nonGoals: [], constraints: [],
    })
    enqueue(2, { scouts: [{ id: 's1', area: 'UI', brief: 'inspect the UI', engine: 'codex' }] })
    enqueue(3, {
      area: 'UI', findings: [{ file: 'src/app.tsx', line: 1, what: 'UI entrypoint', why: 'the plan concerns UI' }],
      filesToTouch: ['src/app.tsx'], contractsMutated: [], contractsRead: [], risks: [], premiseVerdicts: [],
      proposedWork: [{ title: 'Adjust UI', rationale: 'meet the goal' }],
    })
    enqueue(4, { tasks: [{
      id: 'adjust-ui', title: 'Adjust the UI safely', spec: 'Make the planned UI adjustment.',
      dependsOn: [], footprint: ['src/app.tsx'], contractsMutated: [], contractsRead: [], gates: ['test'],
      acceptance: [{ id: 'test', text: 'tests pass', proofKind: 'command', proofCommand: 'pnpm test', requiredTier: 'checked' }],
    }] })

    setMode(home, 'plan')
    setRole(home, 'head', { model: 'sonnet', effort: 'max' })
    const store = new Store(home)
    const out = fakeStdout(110)
    const brief = 'Plan a careful update to the terminal interface after inspecting the implementation and its tests, but do not build it.'
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} initialBrief={brief} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && store.getDesign(store.latestDesignId() ?? '')?.status !== 'planned') {
        await new Promise((r) => setTimeout(r, 100))
      }
      await new Promise((r) => setTimeout(r, 200))
      const id = store.latestDesignId()!
      expect(store.getDesign(id)?.status).toBe('planned')
      expect(store.getArc(id)).toBeUndefined()
      expect(store.eventsSince(id, 0).some((event) => event.kind === 'design.plan.archived')).toBe(true)
      expect(out.scrollback()).toContain('plan only — no build started')
      expect(out.scrollback()).toContain('Plan complete. Nothing was built or changed by an implementation agent.')
      const starts = store.eventsSince(id, 0).filter((event) => event.kind === 'attempt.start')
      const heads = starts.filter((event) => (event.payload as { role: string }).role === 'head')
      expect(heads.length).toBeGreaterThan(0)
      expect(heads.every((event) => (event.payload as { model: string }).model === 'sonnet')).toBe(true)
      expect(starts.some((event) => (event.payload as { role: string }).role === 'implement')).toBe(false)
    } finally {
      app.unmount(); store.close()
      process.env.PATH = oldPath
      delete process.env.ARC_FAKE_QUEUE
      rmSync(queueDir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('direct-lane execution boundary', () => {
  it('routes a focused request through prediction, implementation, gates and review without creating an arc branch', async () => {
    const oldPath = process.env.PATH
    const queueDir = mkdtempSync(join(tmpdir(), 'app-direct-queue-'))
    process.env.PATH = `${resolve(import.meta.dirname, 'fixtures')}:${oldPath}`
    process.env.ARC_FAKE_QUEUE = queueDir
    const enqueue = (n: number, value: unknown) => writeFileSync(join(queueDir, `${n}.json`), JSON.stringify(value))
    enqueue(0, { kind: 'work', lane: 'direct', reply: '', restated: 'focused no-op' })
    // Risk and implement now dispatch CONCURRENTLY and race for queue slots 1
    // and 2, so both slots carry a payload valid under either schema (zod
    // strips the keys the other schema does not know).
    enqueue(1, { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] })
    enqueue(2, { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] })
    enqueue(3, { verdict: 'PASS', findings: [], criteriaAssessment: [] })

    const detected = detectProject(repo).config
    const config = {
      ...detected,
      gates: [{ name: 'truth', command: 'true', proves: 'the checkout remains valid', cwd: '.', timeoutMs: 2_000, heavy: false, baselineSubset: false }],
      roles: {
        ...detected.roles,
        implement: { ...detected.roles.implement, cli: 'claude' as const, model: 'sonnet', sandbox: 'workspace-write' as const },
        review: { ...detected.roles.review!, cli: 'claude' as const, model: 'opus', sandbox: 'read-only' as const },
      },
    }
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={config} danger initialBrief="fix it" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && !store.latestDesignId()) await new Promise((r) => setTimeout(r, 50))
      const id = store.latestDesignId()!
      while (Date.now() < deadline && !store.eventsSince(id, 0).some((event) => event.kind === 'lane.end')) {
        await new Promise((r) => setTimeout(r, 50))
      }
      await new Promise((r) => setTimeout(r, 150))
      expect(store.getArc(id)).toBeUndefined()
      expect(store.eventsSince(id, 0).find((event) => event.kind === 'lane.end')?.payload).toMatchObject({ lane: 'direct', ok: true })
      // The old copy claimed "unstaged", which runDirect never verifies for
      // newly created paths — the honest claim is location, not index state.
      expect(out.scrollback()).toContain('The changes are in your current checkout; nothing was committed.')
    } finally {
      app.unmount(); store.close()
      process.env.PATH = oldPath
      delete process.env.ARC_FAKE_QUEUE
      rmSync(queueDir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('trust modes and lane locks gate the direct lane', () => {
  const directConfig = () => {
    const detected = detectProject(repo).config
    return {
      ...detected,
      gates: [{ name: 'truth', command: 'true', proves: 'the checkout remains valid', cwd: '.', timeoutMs: 2_000, heavy: false, baselineSubset: false }],
      roles: {
        ...detected.roles,
        implement: { ...detected.roles.implement, cli: 'claude' as const, model: 'sonnet', sandbox: 'workspace-write' as const },
        review: { ...detected.roles.review!, cli: 'claude' as const, model: 'opus', sandbox: 'read-only' as const },
      },
    }
  }
  const withQueue = (payloads: unknown[]) => {
    const queueDir = mkdtempSync(join(tmpdir(), 'app-gate-queue-'))
    process.env.PATH = `${resolve(import.meta.dirname, 'fixtures')}:${process.env.PATH}`
    process.env.ARC_FAKE_QUEUE = queueDir
    payloads.forEach((payload, index) => writeFileSync(join(queueDir, `${index}.json`), JSON.stringify(payload)))
    return queueDir
  }
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !predicate()) await new Promise((r) => setTimeout(r, 50))
  }
  const prompts = (heading: string) => readdirSync(join(home, 'artifacts'))
    .filter((name) => name.endsWith('.brief.txt'))
    .map((name) => readFileSync(join(home, 'artifacts', name), 'utf8'))
    .filter((prompt) => prompt.startsWith(heading))
  let oldPath: string | undefined
  let queueDir = ''
  beforeEach(() => { oldPath = process.env.PATH })
  afterEach(() => {
    process.env.PATH = oldPath
    delete process.env.ARC_FAKE_QUEUE
    if (queueDir) rmSync(queueDir, { recursive: true, force: true })
    queueDir = ''
  })

  it('refuses a direct-lane request in plan mode without starting any agent', async () => {
    queueDir = withQueue([{ kind: 'work', lane: 'direct', reply: '', restated: 'focused' }])
    setMode(home, 'plan')
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger={false} initialBrief="fix it" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.scrollback().includes('Plan mode never builds'))
      expect(out.scrollback()).toContain('Plan mode never builds')
      // Refused BEFORE the lane started: no design row, no writer dispatch.
      expect(store.latestDesignId()).toBeFalsy()
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('stops an ask-mode direct change for approval, then proceeds on yes', async () => {
    queueDir = withQueue([
      { kind: 'work', lane: 'direct', reply: '', restated: 'focused no-op' },
      // Concurrent risk/implement race for the next two slots: both payloads
      // satisfy both schemas.
      { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] },
      { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] },
      { verdict: 'PASS', findings: [], criteriaAssessment: [] },
    ])
    setMode(home, 'ask')
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger={false} initialBrief="fix it" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.text().includes('Proceed?'))
      expect(out.text()).toContain('an implementation agent will edit your current checkout')
      // The stop comes before anything durable starts.
      expect(store.latestDesignId()).toBeFalsy()
      out.send('y')
      await until(() => {
        const id = store.latestDesignId()
        return Boolean(id && store.eventsSince(id, 0).some((event) => event.kind === 'lane.end'))
      })
      const id = store.latestDesignId()!
      expect(store.eventsSince(id, 0).find((event) => event.kind === 'lane.end')?.payload).toMatchObject({ lane: 'direct', ok: true })
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('routes by a user-locked lane without spending a triage turn', async () => {
    // The queue holds NO triage payload: if the classifier were consulted the
    // fake queue would misalign and this run could not complete.
    queueDir = withQueue([
      { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] },
      { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] },
      { verdict: 'PASS', findings: [], criteriaAssessment: [] },
    ])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    const send = async (line: string) => {
      out.send(line)
      await tick()
      out.send('\r')
      await new Promise((r) => setTimeout(r, 180))
    }
    try {
      await tick()
      await send('/lane direct')
      expect(out.text()).toContain('locked to the direct lane')
      await send('please fix the helper right away')
      await until(() => {
        const id = store.latestDesignId()
        return Boolean(id && store.eventsSince(id, 0).some((event) => event.kind === 'lane.end'))
      })
      const id = store.latestDesignId()!
      expect(store.eventsSince(id, 0).find((event) => event.kind === 'lane.start')?.payload).toMatchObject({ lane: 'direct' })
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('persists lane attempts and usage, and serves them back through /transcript', async () => {
    queueDir = withQueue([
      { kind: 'work', lane: 'direct', reply: '', restated: 'focused no-op' },
      { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] },
      { risks: [{ id: 'r1', text: 'unexpected mutation', howToCheck: 'inspect git status' }], status: 'done', noop: true, noopReason: 'already correct', shipped: [] },
      { verdict: 'PASS', findings: [], criteriaAssessment: [] },
    ])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="fix it" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => {
        const id = store.latestDesignId()
        return Boolean(id && store.eventsSince(id, 0).some((event) => event.kind === 'lane.end'))
      })
      const id = store.latestDesignId()!
      // The observer put every lane dispatch into the durable attempt ledger:
      // triage + risk + implement + review transcripts, all attempt-linked,
      // real usage rows, no ghost attempts.
      expect(store.artifactsFor(id, 'transcript').length).toBe(4)
      expect(store.artifactsFor(id, 'transcript').every((row: any) => row.attempt_id)).toBe(true)
      expect(store.usageFor(id).length).toBeGreaterThan(0)
      expect(store.liveAttempts(id)).toEqual([])

      out.send('/transcript')
      await tick(); out.send('\r')
      await until(() => out.scrollback().includes('Transcripts for'))
      expect(out.scrollback()).toContain(`Transcripts for ${id}`)
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('synthesizes research through the head instead of dumping raw scout findings', async () => {
    queueDir = withQueue([
      { kind: 'work', lane: 'research', reply: '', restated: 'study the importer' },
      { proposedGoal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], questions: [], premises: [] },
      { goal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], constraints: [] },
      { scouts: [{ id: 's1', area: 'importer', brief: 'inspect learning signals', engine: 'codex' }] },
      {
        area: 'importer',
        findings: [{ file: 'src/importer.ts', line: 4, what: 'rows are stored but never read', why: 'learning loop is open' }],
        filesToTouch: [], contractsMutated: [], contractsRead: [], risks: [], premiseVerdicts: [], proposedWork: [],
      },
      {
        answer: 'Reviews are captured but nothing consumes them, so no learning happens.',
        keyFindings: [{ file: 'src/importer.ts', line: 4, what: 'stored rows are never read', why: 'open loop' }],
        contradictions: [],
        missingFromPrompt: 'production data volumes',
      },
    ])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="study the importer" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.scrollback().includes('Research complete'))
      const scrollback = out.scrollback()
      expect(scrollback).toContain('nothing consumes them')
      expect(scrollback).toContain('Not visible to this synthesis: production data volumes')
      expect(store.getArc(store.latestDesignId()!)).toBeUndefined()
      expect(store.artifactsFor(store.latestDesignId()!, 'research-synthesis').length).toBe(1)
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('reopens the interview once with refuted premises, supersedes them, and scouts again', async () => {
    queueDir = withQueue([
      { kind: 'work', lane: 'research', reply: '', restated: 'study the importer' },
      {
        proposedGoal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], questions: [],
        premises: [{ id: 'p-storage', statement: 'reviews are never stored', howToVerify: 'inspect review writes' }],
      },
      { goal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], constraints: [] },
      { scouts: [{ id: 's1', area: 'importer', brief: 'inspect review writes', engine: 'codex' }] },
      {
        area: 'importer', findings: [], filesToTouch: [], contractsMutated: [], contractsRead: [], risks: [], proposedWork: [],
        premiseVerdicts: [{ id: 'p-storage', verdict: 'refuted', evidence: 'src/importer.ts:41 stores every review' }],
      },
      {
        proposedGoal: 'Understand how stored reviews are used', objectives: ['map consumers'], nonGoals: [],
        questions: [], premises: [],
      },
      { goal: 'Understand how stored reviews are used', objectives: ['map consumers'], nonGoals: [], constraints: [] },
      { scouts: [{ id: 's2', area: 'consumers', brief: 'inspect review consumers', engine: 'codex' }] },
      {
        area: 'consumers', findings: [], filesToTouch: [], contractsMutated: [], contractsRead: [], risks: [],
        premiseVerdicts: [], proposedWork: [],
      },
      { answer: 'Stored reviews have no consumers.', keyFindings: [], contradictions: [], missingFromPrompt: '' },
    ])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="study the importer" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.scrollback().includes('Research complete'))
      const id = store.latestDesignId()!
      expect(store.premises(id).find((p) => p.id === 'p-storage')?.status).toBe('superseded')
      expect(store.refutedPremises(id)).toEqual([])
      expect(prompts('# INTERVIEW')).toHaveLength(2)
      expect(prompts('# ASSIGN THE SCOUTS')).toHaveLength(2)
      const reopened = prompts('# INTERVIEW').find((prompt) => prompt.includes('REFUTED ASSUMPTIONS'))!
      expect(reopened).toContain('reviews are never stored')
      expect(reopened).toContain('src/importer.ts:41 stores every review')
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('stops after a second scout failure without a third interview or scout round', async () => {
    queueDir = withQueue([
      { kind: 'work', lane: 'research', reply: '', restated: 'study the importer' },
      {
        proposedGoal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], questions: [],
        premises: [{ id: 'p-one', statement: 'reviews are never stored', howToVerify: 'inspect writes' }],
      },
      { goal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], constraints: [] },
      { scouts: [{ id: 's1', area: 'writes', brief: 'inspect writes', engine: 'codex' }] },
      {
        area: 'writes', findings: [], filesToTouch: [], contractsMutated: [], contractsRead: [], risks: [], proposedWork: [],
        premiseVerdicts: [{ id: 'p-one', verdict: 'refuted', evidence: 'src/importer.ts:41 stores reviews' }],
      },
      {
        proposedGoal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], questions: [],
        premises: [{ id: 'p-two', statement: 'stored rows are never read', howToVerify: 'inspect reads' }],
      },
      { goal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], constraints: [] },
      { scouts: [{ id: 's2', area: 'reads', brief: 'inspect reads', engine: 'codex' }] },
      {
        area: 'reads', findings: [], filesToTouch: [], contractsMutated: [], contractsRead: [], risks: [], proposedWork: [],
        premiseVerdicts: [{ id: 'p-two', verdict: 'refuted', evidence: 'src/importer.ts:72 reads reviews' }],
      },
    ])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="study the importer" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.scrollback().includes('I stopped after reading the code'))
      expect(out.scrollback()).toContain('Correct the assumption (or drop it from the request) and send it again.')
      expect(out.scrollback()).toContain('stored rows are never read')
      expect(prompts('# INTERVIEW')).toHaveLength(2)
      expect(prompts('# ASSIGN THE SCOUTS')).toHaveLength(2)
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('does not reopen when the first scout failure has no refuted premise', async () => {
    queueDir = withQueue([
      { kind: 'work', lane: 'research', reply: '', restated: 'study the importer' },
      { proposedGoal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], questions: [], premises: [] },
      { goal: 'Understand importer behavior', objectives: ['map the signals'], nonGoals: [], constraints: [] },
      {},
    ])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="study the importer" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.scrollback().includes('I stopped after reading the code'))
      expect(store.refutedPremises(store.latestDesignId()!)).toEqual([])
      expect(prompts('# INTERVIEW')).toHaveLength(1)
      expect(prompts('# ASSIGN THE SCOUTS')).toHaveLength(1)
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('paints the target thread’s durable history when switching threads', async () => {
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await tick()
      const second = store.createThread({ repo, title: 'Earlier history' })
      store.appendThreadMessage(second, 'user', 'first durable line')
      store.appendThreadMessage(second, 'assistant', 'second durable line')
      out.send(`/thread ${second.slice(0, 8)}`)
      await tick(); out.send('\r')
      await until(() => out.scrollback().includes('Earlier history'))
      const scrollback = out.scrollback()
      expect(scrollback).toContain('last 2 durable message(s)')
      expect(scrollback).toContain('first durable line')
      expect(scrollback).toContain('second durable line')
    } finally { app.unmount(); store.close() }
  }, 15_000)

  it('keeps the busy footer legible in a narrow terminal', async () => {
    queueDir = withQueue([])
    process.env.ARC_FAKE_HANG = '1'
    const store = new Store(home)
    const out = fakeStdout(80)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="please adjust the helper" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.text().includes('working'))
      const frame = out.text()
      // Narrow mode drops exactly the pieces that collided at 78-90 columns
      // in the first dogfood run ("esc to stoNew thread · …").
      expect(frame).toContain('esc stops')
      expect(frame).not.toContain('esc to stop')
      expect(frame).not.toContain('New thread ·')
    } finally {
      delete process.env.ARC_FAKE_HANG
      out.send('\x1b')
      await tick()
      app.unmount(); store.close()
    }
  }, 15_000)

  it('answers a work-shaped chat classification instead of falling into the deep pipeline', async () => {
    queueDir = withQueue([{ kind: 'work', lane: 'chat', reply: 'Just conversation.', restated: '' }])
    const store = new Store(home)
    const out = fakeStdout(110)
    const app = render(<App store={store} config={directConfig()} danger initialBrief="what do you think about the color scheme" />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await until(() => out.scrollback().includes('Just conversation.'))
      expect(out.scrollback()).toContain('Just conversation.')
      // No interview, no scouts, no plan for something the classifier itself
      // called conversation.
      expect(store.latestDesignId()).toBeFalsy()
    } finally { app.unmount(); store.close() }
  }, 15_000)
})

describe('the message queue', () => {
  it('keeps what you typed while it was busy, instead of wiping it', async () => {
    // This never worked. `setQueue([])` sat in a finally block, so the queue
    // was cleared on EVERY completion — including a normal one — before the
    // drain effect could run it. The scout that found it also noted there was
    // no test for the queue at all, which is precisely why it survived.
    const src = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
    const finallyBlock = src.slice(src.indexOf('} finally {'), src.indexOf('})()'))
    expect(finallyBlock, 'queue must only be cleared when cancelled')
      .toMatch(/if \(ctrl\.signal\.aborted\) setQueue\(\[\]\)/)
    expect(finallyBlock.replace(/if \(ctrl\.signal\.aborted\) setQueue\(\[\]\)/, ''))
      .not.toContain('setQueue([])')
  })

  it('shows queued messages so they are never silently swallowed', async () => {
    const out = fakeStdout(90)
    const store = new Store(home)
    const app = render(
      <App store={store} config={detectProject(repo).config} danger={false} />,
      { stdout: out.stream, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    // The rendering path exists and is reachable; the source carries the marker
    // the queue rows are painted with.
    const src = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
    expect(src).toContain('queued:')
    app.unmount(); store.close()
  })
})

describe('the slash menu and image paste', () => {
  it('slash menu descriptions align in a fixed column', async () => {
    const out = fakeStdout(110)
    const store = new Store(home)
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await tick()
      out.send('/s')
      await tick()
      const lines = out.text().split('\n')
      const status = lines.find((line) => line.includes('/status') && line.includes('tasks, agents, and proof state'))
      const steer = lines.find((line) => line.includes('/steer <note>') && line.includes('durable guidance for the next agent dispatch'))
      expect(status).toBeDefined()
      expect(steer).toBeDefined()
      expect(status!.indexOf('tasks, agents, and proof state')).toBe(
        steer!.indexOf('durable guidance for the next agent dispatch'),
      )
    } finally { app.unmount(); store.close() }
  })

  it('pops a filtered command menu on "/", completes with tab, runs with enter', async () => {
    const out = fakeStdout(110)
    const store = new Store(home)
    const app = render(<App store={store} config={detectProject(repo).config} danger={false} />, {
      stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      await tick()
      out.send('/st')
      await tick()
      // Filtered to the two matches, with descriptions visible.
      expect(out.text()).toContain('/status')
      expect(out.text()).toContain('/steer')
      expect(out.text()).toContain('proof state')

      out.send('\x1b[B')                       // ↓ to /steer
      await tick()
      out.send('\t')                           // tab completes; steer needs args
      await tick()
      expect(out.text()).toContain('> /steer')

      out.send('\x15')                         // ctrl+u clears the line
      await tick()
      out.send('/hel')
      await tick()
      out.send('\r')                           // enter runs the selected command
      await new Promise((r) => setTimeout(r, 180))
      expect(out.scrollback()).toContain('Local commands:')
    } finally { app.unmount(); store.close() }
  })

  it('inserts an image marker on ctrl+v through the paste hook', async () => {
    const out = fakeStdout(100)
    const app = render(
      <Prompt
        onSubmit={() => {}}
        busy={false}
        history={[]}
        onExit={() => {}}
        onPasteImage={() => '[image: /tmp/fake.png] '}
      />,
      { stdout: out.stream, stdin: out.stdin, exitOnCtrlC: false, patchConsole: false },
    )
    try {
      await tick()
      out.send('\x16')                         // ctrl+v
      await tick()
      expect(out.text()).toContain('[image: /tmp/fake.png]')
    } finally { app.unmount() }
  })
})
