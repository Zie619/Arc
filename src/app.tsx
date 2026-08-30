import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Box, Static, Text, useApp, useStdout } from 'ink'
import { Prompt, useRawKeys, type SlashCommand } from './prompt.tsx'
import { saveClipboardImage } from './clipboard.ts'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Store } from './store.ts'
import { ArcService, runThreadCommand } from './service.ts'
import { runDirect, DEFAULT_DEPENDENCIES, type LaneAttemptObserver } from './direct.ts'
import { runReviewLane } from './review.ts'
import { runTriage, quickTriage, runInterview, runScouts, runPlanner, runResearchSynthesis, Cancelled, type Ask } from './design.ts'
import { runArc, type TaskProduct } from './orchestrator.ts'
import type { ProjectConfig, Plan, AgentRole, TerminalReason, SettledCharter } from './types.ts'
import { theme, agentColor, agentName } from './theme.ts'
import { mode as getMode, nextMode, prevMode, type ModeName } from './modes.ts'
import { codexLimitsSnapshot } from './limits.ts'
import { describeEvent } from './activity.ts'
import { acquire as acquireCheckoutLock, release as releaseCheckoutLock } from './checkout-lock.ts'
import { git } from './git.ts'
import { ArcLogo } from './logo.tsx'
import {
  loadSettings, setMode as persistMode, setRole, clearRole, applySettings,
  describeRole, TUNABLE_ROLES, KNOWN_MODELS, EFFORT_LEVELS, type Settings,
} from './settings.ts'

/**
 * The interface, shaped after Claude Code because that is what this is for.
 *
 * Enter sends. A conversation scrolls up the screen. The input sits between two
 * rules at the bottom with a status line under it. Work in progress appears as
 * an indented tree under the thing that started it, so you can see which agents
 * are dispatched and what each is doing.
 */

type Mode = 'compose' | 'question' | 'approve' | 'confirm' | 'model'

export interface AppProps {
  store: Store
  config: ProjectConfig
  danger: boolean
  initialBrief?: string
  version?: string
}

interface PendingQuestion {
  text: string
  why: string
  options: string[]
  recommendation: string
  resolve: (answer: string) => void
  reject: (reason: unknown) => void
}

/** A yes/no stop before an action that writes to the operator's checkout. */
interface PendingConfirm {
  title: string
  lines: string[]
  resolve: (ok: boolean) => void
}

interface YouTurn {
  id: number
  kind: 'you'
  text: string
}

interface ArcTurn {
  id: number
  kind: 'arc'
  text: string
}

export interface StepTurn {
  id: number
  kind: 'step'
  text: string
  /** Only the live step paints detail. Produced-output history comes later. */
  detail: string[]
  startedAt: number
  ms?: number
}

interface QuestionTurn {
  id: number
  kind: 'question'
  question: string
  answer: string
}

interface PlanTurn {
  id: number
  kind: 'plan'
  plan: Plan
  decision: 'approved' | 'rejected' | 'auto-approved' | 'planned'
}

export interface ProductTurn {
  id: number
  kind: 'product'
  taskId: string
  shipped: Array<{ path: string; whatChanged: string }>
  noop: boolean
  noopReason?: string
}

export type HistoryEntry = YouTurn | ArcTurn | StepTurn | QuestionTurn | PlanTurn | ProductTurn
type EntryWithoutId = HistoryEntry extends infer T ? T extends HistoryEntry ? Omit<T, 'id'> : never : never

interface Timeline {
  completed: HistoryEntry[]
  liveStep: StepTurn | null
  nextId: number
}

const emptyTimeline: Timeline = { completed: [], liveStep: null, nextId: 1 }

function appendEntry(timeline: Timeline, entry: EntryWithoutId): Timeline {
  return {
    ...timeline,
    completed: [...timeline.completed, { ...entry, id: timeline.nextId } as HistoryEntry],
    nextId: timeline.nextId + 1,
  }
}

function startStep(timeline: Timeline, text: string, now: number): Timeline {
  let next = timeline
  if (timeline.liveStep) {
    next = {
      ...timeline,
      completed: [...timeline.completed, { ...timeline.liveStep, ms: now - timeline.liveStep.startedAt }],
      liveStep: null,
    }
  }
  return {
    ...next,
    liveStep: { id: next.nextId, kind: 'step', text, detail: [], startedAt: now },
    nextId: next.nextId + 1,
  }
}

function closeStep(timeline: Timeline, now: number): Timeline {
  if (!timeline.liveStep) return timeline
  return {
    ...timeline,
    completed: [...timeline.completed, { ...timeline.liveStep, ms: now - timeline.liveStep.startedAt }],
    liveStep: null,
  }
}

/** Long enough to collapse a provider's event storm into one repaint, short
 *  enough that the live region still reads as live. */
const TIMELINE_FLUSH_MS = 100

/**
 * The transcript, with the writers a provider drives coalesced.
 *
 * describeEvent turns every provider event into a detail line, and a chatty
 * codex run emits many a second — each one used to be its own setState, so a
 * walk-away six-hour run repainted the whole tree tens of thousands of times
 * for a laptop nobody was watching. Buffered edits are applied together on a
 * timer. Everything that ENDS a beat — a message, a closed step — drains the
 * buffer first, so the order is still what happened and the tail of a run is
 * never lost.
 */
export function useTimeline() {
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline)
  const pending = useRef<Array<(t: Timeline) => Timeline>>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (pending.current.length === 0) return
    const edits = pending.current
    pending.current = []
    setTimeline((t) => edits.reduce((acc, edit) => edit(acc), t))
  }, [])

  const buffer = useCallback((edit: (t: Timeline) => Timeline) => {
    pending.current.push(edit)
    timer.current ??= setTimeout(flush, TIMELINE_FLUSH_MS)
  }, [flush])

  /** Start a step; the previous one is closed with how long it took. */
  const step = useCallback((text: string) => {
    buffer((t) => startStep(t, text, Date.now()))
  }, [buffer])

  const detail = useCallback((line: string) => {
    buffer((t) => t.liveStep
      ? { ...t, liveStep: { ...t.liveStep, detail: [...t.liveStep.detail.slice(-3), line] } }
      : t)
  }, [buffer])

  const append = useCallback((entry: EntryWithoutId) => {
    pending.current.push((t) => appendEntry(t, entry))
    flush()
  }, [flush])

  const closeSteps = useCallback(() => {
    const now = Date.now()
    pending.current.push((t) => closeStep(t, now))
    flush()
  }, [flush])

  // Whatever is still buffered when this goes away is the tail of the run.
  useEffect(() => flush, [flush])

  return { timeline, step, detail, append, closeSteps }
}

/**
 * Completed entries go through Ink's static-output channel, which writes them
 * above the live region once and leaves them in the terminal's normal buffer.
 * The spinner and its details remain repaintable below them.
 */
/** Reserved id for the one-shot header. Real entries are non-negative. */
const BANNER_ID = -1
type StaticItem = HistoryEntry | { id: typeof BANNER_ID }

export function Transcript({
  entries, liveStep, width, spin = '·', now = Date.now(), banner,
}: {
  entries: HistoryEntry[]
  liveStep: StepTurn | null
  width: number
  spin?: string
  now?: number
  /** Printed ONCE, into scrollback, as the first Static item.
   *
   *  It used to live in the live-redraw tree inside a height-pinned Box, so
   *  every repaint had to fit banner + body + composer into the terminal — and
   *  when it did not, the top of the banner was pushed off screen and resizing
   *  did not bring it back. Static is where a thing that never changes belongs;
   *  it also means the banner stays visible above the transcript instead of
   *  vanishing the moment the first turn lands. */
  banner?: React.ReactNode
}) {
  const items: StaticItem[] = banner ? [{ id: BANNER_ID }, ...entries] : entries
  return (
    <>
      <Static items={items}>
        {(entry) => entry.id === BANNER_ID
          ? <Box key={BANNER_ID}>{banner}</Box>
          : <TurnView key={entry.id} entry={entry as HistoryEntry} width={width} />}
      </Static>
      {liveStep && <TurnView entry={liveStep} width={width} live spin={spin} now={now} />}
    </>
  )
}

function TurnView({
  entry, width, live = false, spin = '·', now = Date.now(),
}: {
  entry: HistoryEntry
  width: number
  live?: boolean
  spin?: string
  now?: number
}) {
  if (entry.kind === 'you') {
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        {wrap(entry.text, width - 4).map((line, i) => (
          <Text key={i}><Text color="gray">{i === 0 ? '> ' : '  '}</Text>{line}</Text>
        ))}
      </Box>
    )
  }
  if (entry.kind === 'arc') {
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        {wrap(entry.text, width - 4).map((line, i) => <Text key={i}>{i === 0 ? '' : '  '}{line}</Text>)}
      </Box>
    )
  }
  if (entry.kind === 'question') {
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        {wrap(entry.question, width - 6).map((line, i) => (
          <Text key={i}><Text color="cyan">{i === 0 ? '? ' : '  '}</Text>{line}</Text>
        ))}
        {wrap(entry.answer, width - 8).map((line, i) => (
          <Text key={i} color="green">{'  '}{i === 0 ? '→ ' : '  '}{line}</Text>
        ))}
      </Box>
    )
  }
  if (entry.kind === 'plan') {
    return <PlanCard plan={entry.plan} width={width} decision={entry.decision} />
  }
  if (entry.kind === 'product') {
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color="green">⎿ <Text bold>{entry.taskId}</Text>{entry.noop ? ' produced no code change' : ' produced'}</Text>
        {entry.noop ? (
          <Text color="gray">{'  '}{entry.noopReason ?? 'no reason reported'}</Text>
        ) : entry.shipped.map((item, i) => (
          <Text key={`${item.path}-${i}`} color="gray">
            {'  '}{item.path} — {item.whatChanged.slice(0, Math.max(1, width - item.path.length - 7))}
          </Text>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={live ? 'yellow' : 'green'}>{live ? spin : '⏺'} </Text>
        <Text bold={live}>{entry.text}</Text>
        <Text color="gray">
          {live ? `  ${elapsed(now - entry.startedAt)}` : entry.ms ? `  ${elapsed(entry.ms)}` : ''}
        </Text>
      </Box>
      {live && entry.detail.slice(-2).map((line, i) => (
        <Text key={i} color="gray">{'  ⎿  '}{line.slice(0, width - 8)}</Text>
      ))}
    </Box>
  )
}

function PlanCard({
  plan, width, decision,
}: {
  plan: Plan
  width: number
  decision?: PlanTurn['decision']
}) {
  const verdict = decision === 'auto-approved' ? 'auto-approved (danger)'
    : decision === 'approved' ? 'approved'
      : decision === 'rejected' ? 'rejected'
        : decision === 'planned' ? 'plan only — no build started' : undefined
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={decision ? 1 : 0}>
      <Text bold>The plan — {plan.tasks.length} task{plan.tasks.length === 1 ? '' : 's'}</Text>
      <Box marginTop={1} flexDirection="column">
        {plan.tasks.map((task, i) => (
          <Box key={task.id} flexDirection="column" marginBottom={1}>
            <Text><Text color="cyan">{i + 1}. </Text>{task.title}</Text>
            <Text color="gray">
              {'   '}{task.acceptance.length} check{task.acceptance.length === 1 ? '' : 's'}
              {task.footprint.length ? ` · ${task.footprint.slice(0, 3).join(', ')}` : ''}
            </Text>
          </Box>
        ))}
      </Box>
      {verdict && <Text color={decision === 'rejected' ? 'yellow' : 'green'}>  → {verdict}</Text>}
    </Box>
  )
}

export function resolveQuestionChoice(
  question: Pick<PendingQuestion, 'options' | 'recommendation'>,
  selected: number,
  customAnswer: string,
): { raw: string; effective: string } {
  const raw = selected < 0
    ? ''
    : selected < question.options.length ? (question.options[selected] ?? '') : customAnswer
  return { raw, effective: raw.trim().length > 0 ? raw.trim() : question.recommendation }
}

export function QuestionPanel({
  question, width, onConfirm, onCancel, onExit,
}: {
  question: Pick<PendingQuestion, 'text' | 'why' | 'options' | 'recommendation'>
  width: number
  onConfirm: (choice: { raw: string; effective: string }) => void
  onCancel: () => void
  onExit: () => void
}) {
  const [selected, setSelected] = useState(-1)
  const [answer, setAnswer] = useState('')
  useRawKeys((key) => {
    if (key.ctrl && key.name === 'c') { onExit(); return }
    if (key.name === 'escape') { onCancel(); return }
    if (key.name === 'up') { setSelected((i) => Math.max(-1, i - 1)); return }
    if (key.name === 'down') { setSelected((i) => Math.min(question.options.length, i + 1)); return }
    if (key.name === 'return') { onConfirm(resolveQuestionChoice(question, selected, answer)); return }
    if (key.name === 'backspace') { setAnswer((a) => a.slice(0, -1)); return }
    if (key.text) { setSelected(question.options.length); setAnswer((a) => a + key.text) }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {wrap(question.text, width - 4).map((line, i) => <Text key={i} bold>{line}</Text>)}
      <Text color="gray">{question.why}</Text>
      <Box marginTop={1} flexDirection="column">
        {wrap(`recommended: ${question.recommendation}`, width - 6).map((line, i) => (
          <Text key={i} color={selected === -1 ? 'cyan' : 'green'}>
            {i === 0 ? (selected === -1 ? '❯ ' : '  ') : '  '}{line}
          </Text>
        ))}
        {question.options.map((option, i) => (
          <Text key={i} color={i === selected ? 'cyan' : undefined}>
            {i === selected ? '❯ ' : '  '}{option}
          </Text>
        ))}
        <Text color={selected === question.options.length ? 'cyan' : undefined}>
          {selected === question.options.length ? '❯ ' : '  '}
          {answer || <Text color="gray">something else…</Text>}
          {selected === question.options.length && <Text color="cyan">▊</Text>}
        </Text>
      </Box>
      <Box marginTop={1}><Text color="gray">↑↓ choose · type your own · enter to confirm</Text></Box>
    </Box>
  )
}

export function ConfirmPanel({
  confirm, width, onDecision, onExit,
}: {
  confirm: Pick<PendingConfirm, 'title' | 'lines'>
  width: number
  onDecision: (ok: boolean) => void
  onExit: () => void
}) {
  useRawKeys((key) => {
    if (key.ctrl && key.name === 'c') { onExit(); return }
    if (key.name === 'escape') { onDecision(false); return }
    if (key.text?.toLowerCase() === 'n') { onDecision(false); return }
    if (key.text?.toLowerCase() === 'y' || key.name === 'return') onDecision(true)
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {wrap(confirm.title, width - 4).map((line, i) => <Text key={i} bold>{line}</Text>)}
      {confirm.lines.map((line, i) => <Text key={i} color="gray">{'  '}{line.slice(0, width - 6)}</Text>)}
      <Box marginTop={1}><Text bold>Proceed? </Text><Text color="gray">enter = yes · n = no</Text></Box>
    </Box>
  )
}

/**
 * Arrow-driven /model: pick a role, then a model, then an effort — the same
 * interaction the repo picker already has. The typed `/model role model`
 * form still works for muscle memory; this is for everyone else.
 */
export function ModelPickerPanel({
  config, root, width, onDone, onCancel,
}: {
  config: ProjectConfig
  root: string
  width: number
  onDone: (settings: Settings, summary: string) => void
  onCancel: () => void
}) {
  const roles = TUNABLE_ROLES.filter((role) => config.roles[role])
  const [step, setStep] = useState<'role' | 'model' | 'effort'>('role')
  const [selected, setSelected] = useState(0)
  const [role, setRolePick] = useState<(typeof TUNABLE_ROLES)[number] | null>(null)
  const [model, setModel] = useState('')
  const [custom, setCustom] = useState('')
  const settings = loadSettings(root)

  const binding = role ? applySettings(config, settings).roles[role] : undefined
  const modelRows = binding
    ? [...KNOWN_MODELS[binding.cli], 'reset to project default']
    : []
  const effortRows = ['keep current effort', ...EFFORT_LEVELS]
  const rows = step === 'role' ? roles.map((r) => `${r} — ${describeRole(config, settings, r)}`)
    : step === 'model' ? modelRows
    : effortRows
  const customSlot = step === 'model' ? rows.length : -1

  useRawKeys((key) => {
    if (key.ctrl && key.name === 'c') { onCancel(); return }
    if (key.name === 'escape') {
      if (step === 'role') onCancel()
      else { setStep(step === 'effort' ? 'model' : 'role'); setSelected(0); setCustom('') }
      return
    }
    if (key.name === 'up') { setSelected((i) => Math.max(0, i - 1)); return }
    if (key.name === 'down') { setSelected((i) => Math.min(rows.length - (customSlot >= 0 ? 0 : 1), i + 1)); return }
    if (key.name === 'backspace') { setCustom((c) => c.slice(0, -1)); return }
    if (key.name === 'return') {
      if (step === 'role') {
        setRolePick(roles[selected] ?? null)
        setStep('model'); setSelected(0)
        return
      }
      if (step === 'model' && role) {
        if (selected === customSlot) {
          if (!custom.trim()) return
          setModel(custom.trim()); setStep('effort'); setSelected(0)
          return
        }
        const pick = modelRows[selected]!
        if (pick === 'reset to project default') {
          const next = clearRole(root, role)
          onDone(next, `${role} reset to project defaults: ${describeRole(config, next, role)}`)
          return
        }
        setModel(pick); setStep('effort'); setSelected(0)
        return
      }
      if (step === 'effort' && role) {
        const effort = selected === 0 ? undefined : (effortRows[selected] as (typeof EFFORT_LEVELS)[number])
        const next = setRole(root, role, { model, ...(effort ? { effort } : {}) })
        onDone(next, `${role} now uses ${describeRole(config, next, role)}`)
        return
      }
    }
    if (step === 'model' && key.text) { setSelected(customSlot); setCustom((c) => c + key.text) }
  })

  const title = step === 'role' ? 'Which role?'
    : step === 'effort' ? `Effort for ${role} · ${model}`
    : `Model for ${role} (${binding?.cli})`
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{title}</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => (
          <Text key={i} color={i === selected ? 'cyan' : undefined}>
            {i === selected ? '❯ ' : '  '}{row.slice(0, width - 6)}
          </Text>
        ))}
        {customSlot >= 0 && (
          <Text color={selected === customSlot ? 'cyan' : undefined}>
            {selected === customSlot ? '❯ ' : '  '}
            {custom || <Text color="gray">another model id…</Text>}
            {selected === customSlot && <Text color="cyan">▊</Text>}
          </Text>
        )}
      </Box>
      <Box marginTop={1}><Text color="gray">↑↓ choose · enter to confirm · esc to go back</Text></Box>
    </Box>
  )
}

export function ApprovalPanel({
  plan, width, mainBranch, landStrategy = 'pr', onDecision, onCancel, onExit,
}: {
  plan: Plan
  width: number
  mainBranch: string
  landStrategy?: ProjectConfig['landStrategy']
  onDecision: (approved: boolean) => void
  onCancel: () => void
  onExit: () => void
}) {
  useRawKeys((key) => {
    if (key.ctrl && key.name === 'c') { onExit(); return }
    if (key.name === 'escape') { onCancel(); return }
    if (key.text?.toLowerCase() === 'n') { onDecision(false); return }
    if (key.text?.toLowerCase() === 'y' || key.name === 'return') onDecision(true)
  })

  return (
    <Box flexDirection="column" paddingY={1}>
      <PlanCard plan={plan} width={width} />
      <Box paddingX={1} flexDirection="column">
        <Text color="gray">{deliveryPreview(landStrategy, mainBranch)}</Text>
        <Box marginTop={1}><Text bold>Build it? </Text><Text color="gray">enter = yes · n = no</Text></Box>
      </Box>
    </Box>
  )
}

const SPINNER = ['·', '✢', '✳', '∗', '✻', '✽', '✻', '∗', '✳', '✢']

function elapsed(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** A long path wraps the header into porridge; keep the ends, drop the middle. */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.max(4, Math.floor((max - 1) / 2))
  return `${text.slice(0, keep)}…${text.slice(-keep)}`
}

function tilde(p: string): string {
  const h = homedir()
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p
}

type SlashResult = { kind: 'reply'; text: string; settings?: Settings } | { kind: 'quit' }

function deliveryPreview(strategy: ProjectConfig['landStrategy'], mainBranch: string): string {
  if (strategy === 'push') return `Work is isolated first; Arc will then try to merge and push a verified result to ${mainBranch}.`
  if (strategy === 'none') return `Work stays on an integration branch for you to inspect; ${mainBranch} is not changed.`
  return `Work is isolated first; Arc will try to open a pull request into ${mainBranch}.`
}

function modelHelp(config: ProjectConfig, settings: Settings): string {
  const lines = TUNABLE_ROLES
    .filter((role) => config.roles[role])
    .map((role) => `${role}: ${describeRole(config, settings, role)}`)
  return [
    'Models (* = your override):',
    ...lines,
    '',
    'Set: /model <role> <model> [low|medium|high|xhigh|max]',
    'Reset: /model <role> reset',
    'Known aliases/ids are suggestions; another installed model id is accepted.',
  ].join('\n')
}

function modelResult(input: string, store: Store, config: ProjectConfig): SlashResult {
  const [, rawRole, rawModel, rawEffort] = input.trim().split(/\s+/)
  const settings = loadSettings(store.root)
  if (!rawRole) return { kind: 'reply', text: modelHelp(config, settings) }

  const role = rawRole.toLowerCase() as (typeof TUNABLE_ROLES)[number]
  if (!TUNABLE_ROLES.includes(role) || !config.roles[role]) {
    return { kind: 'reply', text: `Role "${rawRole}" is not configured here.\n\n${modelHelp(config, settings)}` }
  }
  if (!rawModel) {
    const binding = applySettings(config, settings).roles[role]!
    return {
      kind: 'reply',
      text: `${role}: ${describeRole(config, settings, role)}\nSuggestions: ${KNOWN_MODELS[binding.cli].join(' · ')}`,
    }
  }
  if (rawModel.toLowerCase() === 'reset') {
    const next = clearRole(store.root, role)
    return { kind: 'reply', text: `${role} reset to project defaults: ${describeRole(config, next, role)}`, settings: next }
  }
  const effort = rawEffort?.toLowerCase()
  if (effort && !EFFORT_LEVELS.includes(effort as (typeof EFFORT_LEVELS)[number])) {
    return { kind: 'reply', text: `Unknown effort "${rawEffort}". Use ${EFFORT_LEVELS.join(', ')}.` }
  }
  const next = setRole(store.root, role, {
    model: rawModel,
    ...(effort ? { effort: effort as (typeof EFFORT_LEVELS)[number] } : {}),
  })
  return { kind: 'reply', text: `${role} now uses ${describeRole(config, next, role)}`, settings: next }
}

/**
 * The one catalog behind /help and the "/" popup menu — a command missing
 * here is a command nobody discovers.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/status', description: 'tasks, agents, and proof state' },
  { name: '/criteria', description: 'every acceptance criterion and its evidence tier' },
  { name: '/findings', description: 'reviewer findings and deviations' },
  { name: '/model', description: 'pick the model and effort for each role (arrows), or /model <role> <model>' },
  { name: '/threads', description: 'list durable conversations' },
  { name: '/thread', args: '<id-prefix|title>', argsRequired: true, description: 'switch to another thread' },
  { name: '/new', args: '[title]', description: 'start a fresh thread' },
  { name: '/rename', args: '<title>', argsRequired: true, description: 'rename this thread' },
  { name: '/fork', args: '[title]', description: 'branch this thread, keeping its agreement' },
  { name: '/archive', description: 'archive this thread (evidence is kept)' },
  { name: '/lane', args: 'chat|direct|research|plan|review|deep|auto', argsRequired: true, description: 'lock this thread’s routing, or hand it back' },
  { name: '/steer', args: '<note>', argsRequired: true, description: 'durable guidance for the next agent dispatch' },
  { name: '/transcript', args: '[id-prefix]', description: 'list or read stored agent transcripts' },
  { name: '/usage', description: 'exact provider-reported usage receipts' },
  { name: '/limits', description: 'subscription-window headroom from the newest codex rollout' },
  { name: '/help', description: 'this list' },
  { name: '/quit', description: 'stop and leave (asks again while work is running)' },
]

/** Local commands never enter the agent queue. They read durable rows directly. */
export function slashResult(
  input: string, store: Store, currentArcId: string, config?: ProjectConfig,
): SlashResult | null {
  const command = input.trim().toLowerCase().split(/\s+/, 1)[0]
  if (!command?.startsWith('/')) return null
  if (command === '/quit' || command === '/exit') return { kind: 'quit' }
  if (command === '/help') {
    return {
      kind: 'reply',
      text: [
        'Local commands:',
        ...SLASH_COMMANDS.map((c) => `${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`),
      ].join('\n'),
    }
  }

  if (command === '/model') {
    return config
      ? modelResult(input, store, config)
      : { kind: 'reply', text: 'Model settings are only available in the interactive app.' }
  }

  if (command === '/limits') {
    const scope = input.trim().split(/\s+/)[1] ?? 'local'
    return scope.toLowerCase() === 'local'
      ? { kind: 'reply', text: limitsSummary() }
      : { kind: 'reply', text: 'Usage: /limits local' }
  }

  const arcId = currentArcId || store.latestArcId() || store.latestDesignId() || ''
  if (!arcId) return { kind: 'reply', text: 'No arc has started yet.' }

  if (command === '/transcript') {
    const needle = input.trim().split(/\s+/)[1] ?? ''
    const rows = store.artifactsFor(arcId, 'transcript')
    if (rows.length === 0) return { kind: 'reply', text: `No stored transcripts for ${arcId}.` }
    if (!needle) {
      return {
        kind: 'reply',
        text: [
          `Transcripts for ${arcId} (newest first) — /transcript <id-prefix> to read one:`,
          ...rows.slice(0, 12).map((row) => `  ${String(row.id).slice(0, 8)} · ${row.bytes}B · ${new Date(Number(row.created_at)).toLocaleTimeString()}`),
        ].join('\n'),
      }
    }
    const match = rows.find((row) => String(row.id).startsWith(needle))
    if (!match) return { kind: 'reply', text: `No transcript starting with “${needle}”.` }
    const path = store.artifactPath(String(match.id))
    const content = path ? readFileSync(path, 'utf8') : ''
    return {
      kind: 'reply',
      text: `transcript ${String(match.id).slice(0, 8)} (last 4000 of ${content.length} chars):\n${content.slice(-4_000)}`,
    }
  }

  if (command === '/status') {
    const arc = store.getArc(arcId)
    if (!arc) {
      const design = store.getDesign(arcId)
      return { kind: 'reply', text: design ? `arc ${arcId}: ${design.status}` : `No arc "${arcId}".` }
    }
    const s = store.arcSummary(arcId)
    const active = store.liveAttempts(arcId)
    return {
      kind: 'reply',
      text: [
        `arc ${arcId}: ${String(arc.status)}`,
        `${s.landed}/${s.total} landed · ${s.running} running · ${s.failed} failed · ${s.unproven} criteria unproven`,
        active.length ? `active: ${active.map((a) => `${a.role}/${a.requested_model}`).join(' · ')}` : 'active: none',
      ].join('\n'),
    }
  }

  if (command === '/criteria') {
    const criteria = store.allCriteria(arcId)
    return {
      kind: 'reply',
      text: criteria.length
        ? criteria.map((c) => `[${c.tier} → ${c.required_tier}] ${c.task_id}/${c.id} — ${c.text}`).join('\n')
        : `arc ${arcId} has no recorded criteria yet.`,
    }
  }

  if (command === '/findings') {
    const findings = store.findingsFor(arcId)
    return {
      kind: 'reply',
      text: findings.length
        ? findings.map((f) => `[${f.severity}] ${f.task_id ?? 'arc'} · ${f.kind} — ${f.text}`).join('\n')
        : `arc ${arcId} has no findings.`,
    }
  }

  if (command === '/usage') return { kind: 'reply', text: usageSummary(store, arcId) }
  return { kind: 'reply', text: `Unknown command "${command}". Type /help.` }
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 12 }).format(n)
}

function usageLines(store: Store, arcId: string): string[] {
  const rows = store.usageFor(arcId)
  const providers = [...new Set(rows.map((row) => String(row.provider)))]
  return providers.map((provider) => {
    const own = rows.filter((row) => row.provider === provider)
    const parts: string[] = []
    const metrics: Array<[string, string]> = [
      ['input_tokens', 'input'], ['cached_input_tokens', 'cache read'],
      ['cache_write_input_tokens', 'cache write'], ['output_tokens', 'output'],
      ['reasoning_output_tokens', 'reasoning'],
    ]
    for (const [field, label] of metrics) {
      const values = own.map((row) => row[field]).filter((value) => typeof value === 'number') as number[]
      if (values.length > 0) parts.push(`${label} ${formatNumber(values.reduce((a, b) => a + b, 0))}`)
    }
    const costs = own.map((row) => row.cost_usd).filter((value) => typeof value === 'number') as number[]
    if (costs.length > 0) parts.push(`cost $${formatNumber(costs.reduce((a, b) => a + b, 0))}`)
    return `${provider}: ${parts.join(' · ')}`
  })
}

export function usageSummary(store: Store, arcId: string): string {
  const lines = usageLines(store, arcId)
  return lines.length > 0
    ? [`arc ${arcId} · exact provider-reported usage`, ...lines].join('\n')
    : `arc ${arcId}: no provider usage reported yet.`
}

function limitsSummary(now = new Date()): string {
  const snapshot = codexLimitsSnapshot()
  const codex = snapshot
    ? `codex: ${snapshot.usedPercent}% of the ${formatWindow(snapshot.windowMinutes)} window used; resets ${formatLocalTime(snapshot.resetsAt)}; observed ${formatAge(snapshot.observedAt, now)} ago.`
    : 'codex: no rate-limit snapshot found in local rollout files.'
  return [
    codex,
    'claude: no trustworthy local measurement of the claude subscription window exists; /status inside Claude Code shows it.',
  ].join('\n')
}

function formatWindow(minutes: number): string {
  return minutes % (24 * 60) === 0
    ? `${minutes / (24 * 60)}-day`
    : `${minutes / 60}-hour`
}

function formatLocalTime(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'short' })
  const day = date.getDate()
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month} ${day} ${hour}:${minute}`
}

function formatAge(observedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

export function RepoPicker({ candidates, onPick }: { candidates: string[]; onPick: (repo: string) => void }) {
  const { exit } = useApp()
  const [i, setI] = useState(0)
  useRawKeys((k) => {
    if (k.ctrl && k.name === 'c') { exit(); return }
    if (k.name === 'up') setI((n) => Math.max(0, n - 1))
    if (k.name === 'down') setI((n) => Math.min(candidates.length - 1, n + 1))
    if (k.name === 'return') onPick(candidates[i]!)
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text>This folder holds more than one repo. Which one?</Text>
      <Box marginTop={1} flexDirection="column">
        {candidates.map((c, n) => (
          <Text key={c} color={n === i ? 'cyan' : undefined}>
            {n === i ? '❯ ' : '  '}{basename(c)}<Text color="gray">   {tilde(c)}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}><Text color="gray">↑↓ to choose · enter to confirm</Text></Box>
    </Box>
  )
}

export function App({ store, config, danger, initialBrief, version = '0.2.0' }: AppProps) {
  const service = useMemo(() => new ArcService(store, config), [store, config])
  const [threadId, setThreadId] = useState(() => service.chooseThread())
  const [settings, setSettings] = useState<Settings>(() => loadSettings(store.root))
  const runtimeConfig = useMemo(() => applySettings(config, settings), [config, settings])
  // --danger is a starting mode, not a permanent state — shift+tab changes it.
  const [modeName, setModeName] = useState<ModeName>(
    () => (danger ? 'danger' : settings.mode),
  )
  const M = getMode(modeName)
  const cycleMode = useCallback((back = false) => {
    setModeName((cur) => {
      const next = back ? prevMode(cur) : nextMode(cur)
      try { persistMode(store.root, next) } catch { /* preferences are not worth a crash */ }
      return next
    })
  }, [store.root])
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.min(Math.max(stdout?.columns || 80, 40), 200)
  const rows = stdout?.rows && stdout.rows > 0 ? stdout.rows : undefined
  const [branch] = useState(() => {
    try {
      return git(config.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    } catch {
      return ''
    }
  })

  const [mode, setMode] = useState<Mode>('compose')
  const { timeline, step, detail, append: appendTimeline, closeSteps } = useTimeline()
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [approve, setApprove] = useState<((ok: boolean) => void) | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [arcId, setArcId] = useState('')
  const [tick, setTick] = useState(0)
  const [agents, setAgents] = useState<Array<{ role: string; model: string; cli: string; since: number }>>([])
  /** Typed while it was working. Drained in order once it goes idle — the same
   *  as queueing a message in any chat, and far better than a blocked prompt. */
  const [queue, setQueue] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [exitArmed, setExitArmed] = useState(false)
  const busy = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quitAfterCancel = useRef(false)
  const initialSubmitted = useRef(false)

  const working = busy.current

  // One timer drives the spinner, the elapsed counters, and the live agent list.
  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1)
      if (busy.current && arcId) {
        try {
          setAgents(store.liveAttempts(arcId).map((a) => ({
            role: String(a.role), model: String(a.requested_model),
            cli: String(a.cli), since: Number(a.started_at),
          })))
        } catch { /* store busy */ }
      } else {
        setAgents([])
      }
    }, 150)
    return () => clearInterval(t)
  }, [store, arcId])

  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current) }, [])

  const say = useCallback((kind: 'you' | 'arc', text: string) => {
    appendTimeline({ kind, text })
    try { service.appendMessage(threadId, kind === 'you' ? 'user' : 'assistant', text) } catch { /* paint still wins */ }
  }, [appendTimeline, service, threadId])

  /** Local command output is terminal history, not conversation context. */
  const localSay = useCallback((kind: 'you' | 'arc', text: string) => {
    appendTimeline({ kind, text })
  }, [appendTimeline])

  const archiveQuestion = useCallback((q: Pick<PendingQuestion, 'text' | 'recommendation'>, rawAnswer: string) => {
    const answer = rawAnswer.trim().length > 0 ? rawAnswer.trim() : q.recommendation
    appendTimeline({ kind: 'question', question: q.text, answer })
  }, [appendTimeline])

  const archivePlan = useCallback((p: Plan, decision: PlanTurn['decision']) => {
    appendTimeline({ kind: 'plan', plan: p, decision })
  }, [appendTimeline])

  /** Paint a yes/no stop and wait. The decision lands in terminal history. */
  const askConfirm = useCallback((title: string, lines: string[] = []) =>
    new Promise<boolean>((resolve) => {
      setConfirm({ title, lines, resolve })
      setMode('confirm')
    }), [])

  const archiveProduct = useCallback((result: TaskProduct) => {
    appendTimeline({
      kind: 'product', taskId: result.taskId, shipped: result.shipped,
      noop: result.noop, noopReason: result.noopReason,
    })
  }, [appendTimeline])

  const submit = useCallback((text: string) => {
    if (busy.current || text.trim().length === 0) return
    busy.current = true
    say('you', text.trim())

    const ctrl = new AbortController()
    abort.current = ctrl

    void (async () => {
      const id = deriveArcId(text)
      setArcId(id)
      const d = {
        store, config: runtimeConfig, arcId: id, signal: ctrl.signal,
        log: (l: string) => { if (l.trim()) detail(l.trim()) },
        progress: (a: string, det?: string) => { step(a); if (det) detail(det) },
        threadId,
        threadContext: undefined as string | undefined,
      }
      // Every lane dispatch shares one durable attempt ledger, so lane agents
      // show in the live list and their exact usage is never dropped.
      const laneObserver = (): LaneAttemptObserver => {
        let n = 0
        return {
          start: (a) => store.startAttempt({
            arcId: id, taskId: null, attemptNo: ++n,
            role: a.role as AgentRole, cli: a.cli as 'claude' | 'codex', requestedModel: a.model,
          }),
          finish: (attemptId, outcome) => {
            const transcriptId = store.putArtifact(id, 'transcript', outcome.transcript, attemptId)
            store.finishAttempt(id, attemptId, {
              terminalReason: outcome.terminalReason as TerminalReason,
              exitCode: outcome.exitCode,
              observedModel: outcome.observedModel,
              transcriptArtifactId: transcriptId,
              usage: outcome.usage,
            })
          },
        }
      }
      // A crash between observer start/finish would leave a ghost 'running'
      // attempt in the ledger forever.
      const sweepAttempts = () => {
        try {
          for (const row of store.liveAttempts(id)) {
            store.finishAttempt(id, String(row.id), { terminalReason: 'provider-error', exitCode: null, observedModel: null })
          }
        } catch { /* ledger sweep is best-effort */ }
      }
      try {
        const view = service.threadView(threadId)
        const locked = view?.laneSource === 'user' ? view.lane : null
        let t
        if (locked && locked !== 'chat') {
          // The operator locked this thread's lane: the classifier may not
          // reroute it, and no triage model turn is spent. Exact greetings
          // still get their canned conversational answer.
          const q = quickTriage(text)
          t = q && q.kind !== 'work'
            ? q
            : { kind: 'work' as const, lane: locked, reply: '', restated: text.split('\n')[0]!.slice(0, 120) }
        } else {
          t = await runTriage(d, text)
        }
        if (!t || t.kind !== 'work') {
          closeSteps()
          say('arc', t?.reply ?? 'I could not read that — try describing the change you want.')
          return
        }
        // Auto write-back only: the store refuses this on a user-locked
        // thread, at write time, so a /lane during in-flight triage also wins.
        const lane = locked ?? t.lane
        try { service.setLane(threadId, t.lane) } catch { /* durable run still proceeds */ }
        if (lane === 'chat') {
          // kind 'work' + lane 'chat' used to fall through into the deep
          // pipeline — an interview for something the classifier itself called
          // conversation.
          closeSteps()
          say('arc', t.reply || 'That reads as conversation. Tell me what you want changed and I will route it.')
          return
        }
        // The ONE context seam (13.1): the thread's durable agreement and
        // dialogue reach every work lane through this compiled envelope, never
        // through a provider session's memory.
        let envelopeHeader = ''
        try {
          envelopeHeader = service.compileDispatchEnvelope(threadId, text).header
        } catch (error) {
          detail(`thread context unavailable: ${(error as Error).message}`)
        }
        d.threadContext = envelopeHeader || undefined
        if (lane === 'direct') {
          if (M.planOnly) {
            closeSteps()
            say('arc', 'Plan mode never builds, and this request routed to the direct lane, which edits your checkout. Switch modes (shift+tab), or /lane review to inspect without writing.')
            return
          }
          if (M.asksApproval) {
            const ok = await askConfirm(
              'Direct change: an implementation agent will edit your current checkout.',
              [text.split('\n')[0]!.slice(0, 120)],
            )
            if (!ok) { closeSteps(); say('arc', 'Stopped before any agent ran. Nothing was changed.'); return }
          }
          // Parallel sessions corrupt a shared tree. Only lanes that WRITE
          // the checkout take the lock — deep work runs in its own worktrees
          // and needs none. Known gap: deep landing briefly checks out the
          // integration branch here unlocked; that race is narrower than the
          // whole-lane one this closes, and lands under the semaphore.
          // Released in this submit's finally (owner-guarded, so a no-op
          // everywhere else).
          const holder = acquireCheckoutLock(runtimeConfig.repo)
          if (holder) {
            closeSteps()
            const age = Math.round((Date.now() - holder.acquiredAt) / 1000)
            say('arc', `Another session is editing this checkout — pid ${holder.pid} on ${holder.hostname}, holding it for ${age}s. Wait for it to finish, or send this to the deep lane: isolated worktree, no lock needed.`)
            return
          }
          store.startDesign(id, text, threadId)
          store.appendEvent(id, 'lane.start', { lane: 'direct', threadId })
          step('making a focused change')
          detail('Opus predicts · Sol writes · checks run · Opus reviews')
          // Steering recorded on this thread rides along in the writer's brief
          // and is marked applied only when the lane completes.
          let steering: Array<Record<string, any>> = []
          try { steering = store.pendingInterventions(threadId).filter((row) => row.kind === 'steer' && !row.arc_id) } catch { /* brief still runs */ }
          const directBrief = [
            ...(envelopeHeader ? [envelopeHeader] : []),
            ...(steering.length ? [`# OPERATOR STEERING\n${steering.map((row) => `- ${row.text}`).join('\n')}`] : []),
            text,
          ].join('\n\n')
          const result = await runDirect({
            config: runtimeConfig,
            brief: directBrief,
            signal: ctrl.signal,
            log: detail,
            onEvent: (event) => { const line = describeEvent(event); if (line) detail(line) },
            observer: laneObserver(),
            repairAttempts: runtimeConfig.maxAttempts,
            // Persisted before any agent runs: a crash mid-lane must never
            // lose the record of what the checkout looked like.
            onCheckpoint: (artifact) => { try { store.putArtifact(id, 'direct-checkpoint-before', artifact) } catch { /* the final checkpoint still lands */ } },
            confirmFindingChecks: M.asksApproval
              ? (commands) => askConfirm(
                  'The reviewer wants to run its finding checks in your checkout.',
                  commands.slice(0, 6))
              : undefined,
          }, {
            ...DEFAULT_DEPENDENCIES,
            // The direct lane already shares the attempt ledger through the
            // observer; gate runs were the one thing it dropped, which is what
            // a flake ledger and any cross-lane accounting need most.
            runGate: async (gate, cwd, baseSha, signal) => {
              const r = await DEFAULT_DEPENDENCIES.runGate(gate, cwd, baseSha, signal)
              try {
                store.recordGate({
                  arcId: id, name: r.name, command: r.command, proves: r.proves,
                  exitCode: r.exitCode, baseSha: r.baseSha, durationMs: r.durationMs,
                  verdict: r.pass ? 'pass' : 'fail', signature: r.signature,
                })
              } catch { /* the ledger is best-effort; the lane run is not */ }
              return r
            },
          })
          sweepAttempts()
          if (result.ok) for (const row of steering) { try { store.applyIntervention(String(row.id)) } catch { /* stays pending */ } }
          const checkpointId = store.putArtifact(id, 'direct-checkpoint', result.checkpointArtifact)
          for (const finding of result.review?.findings ?? []) {
            store.addFinding({
              arcId: id, kind: 'review',
              severity: finding.severity === 'critical' ? 'high' : finding.severity === 'major' ? 'medium' : 'low',
              text: `${finding.file}:${finding.line} — ${finding.claim}`, affects: [finding.file],
            })
          }
          store.appendEvent(id, 'lane.end', {
            lane: 'direct', status: result.status, ok: result.ok,
            checkpointArtifactId: checkpointId, touchedPaths: result.checkpoint.touchedPaths,
          })
          closeSteps()
          const changed = result.checkpoint.touchedPaths.length
            ? `\nChanged: ${result.checkpoint.touchedPaths.join(', ')}` : ''
          say('arc', result.ok
            ? `Direct change passed its project checks and independent review.${changed}\nThe changes are in your current checkout; nothing was committed.`
            : `Direct change stopped: ${result.reason}.${changed}\nArc did not reset or discard anything; inspect the checkpoint evidence before continuing.`)
          return
        }
        if (lane === 'review') {
          store.startDesign(id, text, threadId)
          store.appendEvent(id, 'lane.start', { lane: 'review', threadId })
          step('reviewing the current checkout')
          detail('Opus predicts against HEAD before it sees the working diff')
          const result = await runReviewLane({
            config: runtimeConfig,
            brief: envelopeHeader ? `${envelopeHeader}\n\n${text}` : text,
            signal: ctrl.signal,
            log: detail,
            observer: laneObserver(),
            confirmFindingChecks: M.asksApproval
              ? (commands) => askConfirm(
                  'The reviewer wants to run its finding checks in your checkout.',
                  commands.slice(0, 6))
              : undefined,
          })
          sweepAttempts()
          for (const finding of result.review?.findings ?? []) {
            store.addFinding({
              arcId: id, kind: 'review',
              severity: finding.severity === 'critical' ? 'high' : finding.severity === 'major' ? 'medium' : 'low',
              text: `${finding.file}:${finding.line} — ${finding.claim}`, affects: [finding.file],
            })
          }
          store.appendEvent(id, 'lane.end', { lane: 'review', status: result.status, ok: result.ok })
          closeSteps()
          const reproduced = result.findingChecks.filter((check) => check.ran && check.reproduced).length
          const extras = [
            ...(result.findingChecks.length ? [`${reproduced}/${result.findingChecks.length} finding check(s) reproduced.`] : []),
            ...result.caveats.map((caveat) => `⚠ ${caveat}`),
          ]
          const extraText = extras.length ? `\n${extras.join('\n')}` : ''
          say('arc', result.ok
            ? `Review complete: project gates and the independent review passed. The checkout was not modified.${extraText}`
            : `Review stopped: ${result.reason}. Arc did not modify or repair the checkout.${extraText}`)
          return
        }
        const briefPath = join(tmpdir(), `arc-brief-${randomBytes(4).toString('hex')}.md`)
        writeFileSync(briefPath, text)

        const ask: Ask = (q) => {
          // The work that produced this question is complete. Commit it before
          // the live region turns into an input panel, so history stays in order.
          closeSteps()
          if (!M.asksQuestions) {
            archiveQuestion(q, '')
            return Promise.resolve('')
          }
          return new Promise<string>((resolve, reject) => {
            setQuestion({ ...q, resolve, reject })
            setMode('question')
          })
        }

        let refutations: Array<{ id: string; statement: string; evidence: string }> | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          const interviewed = await runInterview(d, briefPath, ask, refutations)
          if (!interviewed && attempt === 0) { closeSteps(); say('arc', 'I could not pin down what you want. Try saying more about the outcome you are after.'); return }
          if (interviewed) {
            // The settled charter IS this thread's agreement — version it durably
            // so the next request in this thread starts from what was agreed, not
            // from a provider session's memory of it.
            try {
              const settled = store.getDesign(id)?.charter as SettledCharter | null
              if (settled) service.setAgreement(threadId, { goal: settled.goal, constraints: settled.constraints })
            } catch { /* the design rows remain the source */ }
            if (await runScouts(d)) break
          }

          if (attempt === 0) {
            let firstRefuted: Array<Record<string, any>> = []
            try { firstRefuted = store.refutedPremises(id) } catch { /* stop below with the generic copy */ }
            if (firstRefuted.length > 0) {
              refutations = firstRefuted.map((p) => ({
                id: String(p.id), statement: String(p.statement), evidence: String(p.evidence ?? ''),
              }))
              for (const p of refutations) store.setPremise(id, p.id, 'superseded', p.evidence)
              continue
            }
          }

          closeSteps()
          // Name the refuted premise and its evidence — "see above" pointed
          // at detail lines that had already collapsed out of view.
          let refuted: Array<Record<string, any>> = []
          try { refuted = store.refutedPremises(id) } catch { /* the generic copy still paints */ }
          say('arc', [
            'I stopped after reading the code — something the brief assumed turned out not to be true:',
            ...refuted.map((p) => `- ${p.statement}\n    evidence: ${String(p.evidence ?? '(none recorded)').slice(0, 300)}`),
            'Correct the assumption (or drop it from the request) and send it again.',
          ].join('\n'))
          return
        }

        if (lane === 'research') {
          const synthesis = await runResearchSynthesis(d)
          closeSteps()
          if (synthesis) {
            say('arc', [
              'Research complete — no implementation agent was started.',
              '',
              synthesis.answer,
              ...(synthesis.keyFindings.length
                ? ['', 'Key evidence:', ...synthesis.keyFindings.slice(0, 20).map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''} — ${f.what}`)]
                : []),
              ...(synthesis.contradictions.length
                ? ['', 'The scouts disagree on:', ...synthesis.contradictions.map((c) => `- ${c}`)]
                : []),
              ...(synthesis.missingFromPrompt.trim()
                ? ['', `Not visible to this synthesis: ${synthesis.missingFromPrompt}`]
                : []),
            ].join('\n'))
            return
          }
          const reports = store.scoutReports(id)
          const evidence = reports.flatMap((report) => report.findings ?? []).slice(0, 30)
          say('arc', evidence.length
            ? ['Research complete — no implementation agent was started. Synthesis failed; the raw scout findings:', ...evidence.map((f: any) => `- ${f.file}:${f.line} — ${f.what}`)].join('\n')
            : 'Research complete — no implementation agent was started. The scouts recorded no file-level findings.')
          return
        }

        const p = await runPlanner(d)
        if (!p) { closeSteps(); say('arc', 'I could not turn that into a workable plan.'); return }
        setPlan(p)
        closeSteps()

        if (M.planOnly || lane === 'plan') {
          store.appendEvent(id, 'design.plan.archived', p)
          archivePlan(p, 'planned')
          say('arc', 'Plan complete. Nothing was built or changed by an implementation agent.')
          return
        }

        if (M.asksApproval) {
          const ok = await new Promise<boolean>((resolve) => { setApprove(() => resolve); setMode('approve') })
          setMode('compose')
          if (!ok) { say('arc', 'Stopped. Nothing was changed.'); return }
        } else {
          archivePlan(p, 'auto-approved')
        }

        step('building')
        // Steering typed on this thread before the arc existed belongs to the
        // run that is about to start; compileBrief reads it by arc id.
        try { store.adoptInterventions(threadId, p.arcId) } catch { /* steering stays thread-scoped */ }
        await runArc({
          store, plan: p, config: runtimeConfig, signal: ctrl.signal,
          log: (l) => { if (l.trim()) detail(l.trim()) },
          onTaskResult: archiveProduct,
          threadId,
        })
        closeSteps()
        const arc = store.getArc(id)
        if (arc?.status === 'done') {
          // The pr/push event holds what ACTUALLY happened — the operator
          // should never have to dig in the run output for their own URL.
          const delivered = store.eventsSince(id, 0).filter((ev) => ev.kind === 'pr' || ev.kind === 'push').at(-1)
          const d = delivered?.payload as { ok?: boolean; url?: string; message?: string } | undefined
          const outcome =
            !d ? `The work stayed local (landStrategy: ${runtimeConfig.landStrategy}).` :
            d.ok ? (delivered!.kind === 'pr' ? `Pull request: ${d.url || 'created'}` : `Pushed to ${runtimeConfig.mainBranch}.`) :
            d.url ? `The branch is pushed, but the PR could not be opened (${d.message}). Open it yourself: ${d.url}` :
            `Delivery failed: ${d.message}`
          say('arc', `Work completed with the required evidence. ${outcome}`)
        } else {
          say('arc', `Stopped short — not everything could be proved. Work may remain on an integration branch, but no completed delivery was claimed. Run \`arc criteria\` to see what is missing.`)
        }
      } catch (e) {
        closeSteps()
        if (e instanceof Cancelled || ctrl.signal.aborted) say('arc', 'Stopped. Agents were cancelled. Worktree or branch commits may remain; no completed delivery was claimed.')
        else say('arc', `Something broke: ${(e as Error).message}`)
      } finally {
        busy.current = false
        abort.current = null
        setAgents([])
        // Owner-guarded: removes the checkout lock only when this process
        // holds it, so it is a no-op for every lane that never took it.
        try { releaseCheckoutLock(runtimeConfig.repo) } catch { /* lock file already gone */ }
        // A finished run's arc id must not linger: /steer typed after this
        // would bind to a dead arc and never reach any future brief.
        setArcId('')
        // ONLY on cancel. This used to run unconditionally, so the queue was
        // wiped the instant any run finished and the drain effect never got to
        // it — queueing has never actually worked. Escape means "stop
        // everything", including what was waiting; finishing normally means
        // "take the next one".
        if (ctrl.signal.aborted) setQueue([])
        if (quitAfterCancel.current) exit()
      }
    })()
  }, [store, runtimeConfig, M, say, step, detail, closeSteps, archiveQuestion, archivePlan, archiveProduct, exit, service, threadId, askConfirm])

  useEffect(() => {
    if (!initialBrief || initialSubmitted.current) return
    initialSubmitted.current = true
    submit(initialBrief)
  }, [initialBrief, submit])

  // Drain one queued message per idle tick, in the order they were typed.
  useEffect(() => {
    if (busy.current || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    if (next) submit(next)
  }, [queue, tick, submit])

  const cancel = useCallback(() => {
    if (!abort.current) return
    abort.current.abort()
    detail('cancelling — stopping the agents')
  }, [detail])

  const requestExit = useCallback(() => {
    if (!busy.current) { exit(); return }
    if (!exitArmed) {
      setExitArmed(true)
      if (exitTimer.current) clearTimeout(exitTimer.current)
      exitTimer.current = setTimeout(() => setExitArmed(false), 4_000)
      return
    }

    if (exitTimer.current) clearTimeout(exitTimer.current)
    setExitArmed(false)
    quitAfterCancel.current = true
    cancel()
    if (mode === 'question' && question) {
      question.reject(new Cancelled())
      setQuestion(null)
      setMode('compose')
    } else if (mode === 'approve' && approve) {
      if (plan) archivePlan(plan, 'rejected')
      approve(false)
      setApprove(null)
    } else if (mode === 'confirm' && confirm) {
      confirm.resolve(false)
      setConfirm(null)
      setMode('compose')
    }
  }, [exit, exitArmed, cancel, mode, question, approve, plan, archivePlan, confirm])

  const accept = useCallback((text: string) => {
    const trimmed = text.trim()
    setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100))
    // A command that throws must answer in the transcript, never crash the
    // keypress handler and eat the typed line.
    let threadCommand
    try {
      threadCommand = runThreadCommand(trimmed, service, threadId, arcId || undefined)
    } catch (error) {
      localSay('you', trimmed)
      localSay('arc', (error as Error).message)
      return
    }
    if (threadCommand) {
      localSay('you', trimmed)
      if (threadCommand.threadId !== threadId) {
        setThreadId(threadCommand.threadId)
        // Terminal scrollback is append-only; a switch paints the target
        // thread's recent durable history instead of pretending the screen
        // can be rewound.
        try {
          const recent = store.threadMessages(threadCommand.threadId).slice(-6)
          if (recent.length > 0) {
            const title = service.threadView(threadCommand.threadId)?.title ?? threadCommand.threadId.slice(0, 8)
            localSay('arc', [
              `── “${title}” — its last ${recent.length} durable message(s) ──`,
              ...recent.map((m) => `${m.role === 'user' ? ' >' : '  ⏺'} ${String(m.text).split('\n')[0]!.slice(0, 160)}`),
            ].join('\n'))
          }
        } catch { /* the switch reply still paints */ }
      }
      localSay('arc', threadCommand.text)
      return
    }
    // Bare /model opens the arrow-driven picker; the typed `/model role model`
    // form still goes through the text path below.
    if (trimmed.toLowerCase() === '/model') {
      localSay('you', trimmed)
      setMode('model')
      return
    }
    let command
    try {
      command = slashResult(trimmed, store, arcId, config)
    } catch (error) {
      localSay('you', trimmed)
      localSay('arc', (error as Error).message)
      return
    }
    if (command) {
      localSay('you', trimmed)
      if (command.kind === 'quit') requestExit()
      else {
        if (command.settings) setSettings(command.settings)
        localSay('arc', command.text)
      }
      return
    }
    if (busy.current) setQueue((q) => [...q, text])
    else submit(text)
  }, [store, arcId, config, localSay, requestExit, submit, service, threadId])

  // ---- pieces -------------------------------------------------------------

  const spin = SPINNER[tick % SPINNER.length]
  const thread = service.threadView(threadId)
  const workflowStages = thread ? service.workflowFor(threadId).steps.length : 0

  // Three rows beside the three-row mark. It was five, which is taller than
  // Claude Code's own header and left less room for the thing you came to read.
  const Banner = () => (
    <Box paddingX={1} marginBottom={1}>
      <ArcLogo />
      <Box flexDirection="column" marginLeft={2}>
        <Text>
          <Text bold>arc</Text><Text color="gray"> v{version} · </Text>
          <Text color={theme.sol}>Sol</Text><Text color="gray"> writes · </Text>
          <Text color={theme.opus}>Opus</Text><Text color="gray"> reviews</Text>
        </Text>
        <Text color="gray">{middleTruncate(tilde(config.repo), Math.max(20, width - 24))}{branch ? ` · ${branch}` : ''}</Text>
        {/* Only what CANNOT change: this is printed once and lives in
            scrollback. The thread can change mid-session, so it belongs in the
            live footer — where it already was, and where it was duplicated. */}
        {config.gates.length === 0
          ? <Text color="yellow">⚠ nothing here can check the work — no test or build script</Text>
          : <Text color="gray">checks: {config.gates.map((g) => g.name).join(' · ')}</Text>}
      </Box>
    </Box>
  )

  // Keep one root and one <Static> mounted for the whole session. Remounting
  // Static when a question opens would print the entire history a second time.
  const empty = timeline.completed.length === 0 && !timeline.liveStep
  const pinCompose = mode === 'compose' && empty && rows !== undefined
  // The banner is printed ONCE, into scrollback, ABOVE this box — so the box
  // cannot also claim the whole screen or the two together overflow and push
  // the banner off the top. That was the bug: resizing never helped, because
  // the sum was always one banner taller than the terminal.
  // `empty` is false the moment anything happens, and by then the banner has
  // scrolled away on its own, so this only ever applies while it is on screen.
  const BANNER_ROWS = 4
  return (
    <Box
      flexDirection="column"
      width={width}
      height={pinCompose ? Math.max(rows - 1 - BANNER_ROWS, 1) : undefined}
    >
      <Transcript
        entries={timeline.completed} liveStep={timeline.liveStep} width={width} spin={spin}
        banner={<Banner />}
      />

      {mode === 'question' && question && (
        <QuestionPanel
          question={question}
          width={width}
          onConfirm={(choice) => {
            archiveQuestion(question, choice.raw)
            question.resolve(choice.raw)
            setQuestion(null)
            setMode('compose')
          }}
          onCancel={() => {
            cancel()
            question.reject(new Cancelled())
            setQuestion(null)
            setMode('compose')
          }}
          onExit={requestExit}
        />
      )}

      {mode === 'approve' && plan && approve && (
        <ApprovalPanel
          plan={plan}
          width={width}
          mainBranch={config.mainBranch}
          landStrategy={config.landStrategy}
          onDecision={(approved) => {
            archivePlan(plan, approved ? 'approved' : 'rejected')
            approve(approved)
            setApprove(null)
          }}
          onCancel={() => {
            cancel()
            archivePlan(plan, 'rejected')
            approve(false)
            setApprove(null)
          }}
          onExit={requestExit}
        />
      )}

      {mode === 'confirm' && confirm && (
        <ConfirmPanel
          confirm={confirm}
          width={width}
          onDecision={(ok) => {
            localSay('arc', `${confirm.title} — ${ok ? 'approved' : 'declined'}`)
            confirm.resolve(ok)
            setConfirm(null)
            setMode('compose')
          }}
          onExit={requestExit}
        />
      )}

      {mode === 'model' && (
        <ModelPickerPanel
          config={config}
          root={store.root}
          width={width}
          onDone={(next, summary) => {
            setSettings(next)
            localSay('arc', summary)
            setMode('compose')
          }}
          onCancel={() => setMode('compose')}
        />
      )}

      {pinCompose && <Box flexGrow={1} />}

      {mode === 'compose' && (
        <>
          <AgentList agents={agents} />

          {queue.length > 0 && (
            <Box flexDirection="column" paddingX={1} marginTop={1}>
              {queue.map((q, i) => (
                <Text key={i} color="gray">  ⏵ queued: {q.split('\n')[0]!.slice(0, width - 14)}</Text>
              ))}
            </Box>
          )}

          <Box marginTop={1}>
            <Prompt
              onSubmit={accept}
              busy={working}
              history={history}
              active
              placeholder={empty ? 'what do you want done?' : undefined}
              onInterrupt={cancel}
              onCycleMode={cycleMode}
              onExit={requestExit}
              slashCommands={SLASH_COMMANDS}
              onPasteImage={() => {
                const path = saveClipboardImage()
                if (!path) return null
                localSay('arc', `image attached: ${path}`)
                return `[image: ${path}] `
              }}
            />
          </Box>

          <Box paddingX={1} justifyContent="space-between">
            {exitArmed ? (
              <Text color="red" bold>press ctrl-c again to stop the agents and quit</Text>
            ) : working ? (
              // The busy line needs a width budget just like hint() has: at 78
              // columns the old copy collided with the right-hand status and
              // wrapped the footer (found in the first dogfood run).
              <Text color="yellow">
                {spin} working
                {agents.length ? ` · ${agents.length}${width < 95 ? '' : ` agent${agents.length === 1 ? '' : 's'}`}` : ''}
                {queue.length ? ` · ${queue.length} queued` : ''}
                <Text color="gray">{width < 95 ? '  esc stops' : '  esc to stop'}</Text>
              </Text>
            ) : (
              <Text color={theme.faint}>{hint(width)}</Text>
            )}
            <Text>
              {width >= 95 && (
                <Text color={theme.accent}>{thread?.title.slice(0, width >= 100 ? 18 : 10) ?? 'thread'} · </Text>
              )}
              <Text color={theme.accent}>{thread?.lane ?? 'chat'}</Text>
              <Text color={modeName === 'danger' ? theme.warn : theme.accent}> · {M.label}</Text>
              <Text color={theme.faint}>{width < 95 ? ' · ⇧tab' : ' · ⇧tab · ^c'}</Text>
            </Text>
          </Box>
        </>
      )}
    </Box>
  )
}

export function ThreadStatus({ title, lane, stages }: { title: string; lane: string; stages: number }) {
  // "planned": the count comes from the lane's declared workflow, which is a
  // description of intent — nothing executes those rows yet.
  return (
    <Text color="gray">
      {'  '}thread: <Text color={theme.accent}>{title}</Text> · {lane} · {stages} planned stage{stages === 1 ? '' : 's'}
    </Text>
  )
}

export interface LiveAgent { role: string; model: string; cli: string; since: number }

/**
 * The dispatched agents — the thing actually worth watching while it works.
 *
 * Named by who they are (Sol / Opus) rather than by which binary, because that
 * is how you think about them, and shown with what each is doing and for how
 * long.
 */
export function AgentList({ agents }: { agents: LiveAgent[] }) {
  if (agents.length === 0) return null
  return (
    <Box flexDirection="column" paddingX={1}>
      {agents.map((a, i) => (
        <Box key={i}>
          <Text color="gray">{'  ⎿  '}</Text>
          <Text color={a.cli === 'codex' ? 'green' : 'magenta'}>
            {(a.cli === 'codex' ? 'Sol' : 'Opus').padEnd(6)}
          </Text>
          <Text>{a.role.padEnd(12)}</Text>
          <Text color="gray">{a.model.padEnd(16)}{elapsed(Date.now() - a.since)}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** The keys worth mentioning, as many as fit — never overlapping the right side. */
function hint(width: number): string {
  if (width < 90) return 'enter · shift+enter newline'
  const all = ['enter to send', 'shift+enter for a new line', '↑ for history']
  // The right-hand status now carries the mode name too. Under-reserving here
  // wrapped the footer onto two lines and truncated the mode mid-word.
  const budget = width - 52
  let out = ''
  for (const h of all) {
    const next = out ? `${out} · ${h}` : h
    if (next.length > budget) break
    out = next
  }
  return out
}

/** Wrap without cutting words — Ink will happily split mid-word otherwise. */
function wrap(text: string, cols: number): string[] {
  const out: string[] = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line.length + word.length + 1 > cols) { out.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** A readable id from the brief itself, so `arc status` means something later. */
export function deriveArcId(brief: string): string {
  const words = brief.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const stop = new Set(['the', 'a', 'an', 'and', 'to', 'of', 'for', 'in', 'on', 'is', 'it',
                        'make', 'we', 'i', 'want', 'need', 'please', 'should', 'that', 'this'])
  const meaningful = words.filter((w) => !stop.has(w) && w.length > 2).slice(0, 3)
  const slug = (meaningful.length ? meaningful : words.slice(0, 3)).join('-') || 'arc'
  return `${slug}-${randomBytes(2).toString('hex')}`
}
