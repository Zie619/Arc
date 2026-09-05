import React, { useEffect, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { Store } from './store.ts'
import { TIER_RANK, type ClaimTier } from './types.ts'
import { theme, agentColor } from './theme.ts'
import { clip, draftRows, plain, Section, useTerminalSize, windowStart } from './terminal-ui.tsx'
import { useRawKeys } from './prompt.tsx'

/** A bounded, read-only view. Closing it never cancels a mission. */
type Pane = 'activity' | 'findings' | 'evidence' | 'actions'
const PANES: Pane[] = ['activity', 'findings', 'evidence', 'actions']
const ATTENTION = new Set(['failed', 'blocked', 'quarantined'])
const STATE: Record<string, { color: string; icon: string }> = {
  landed: { color: theme.ok, icon: '✓' }, running: { color: theme.sol, icon: '●' },
  reviewing: { color: theme.opus, icon: '◉' }, landing: { color: theme.accent, icon: '↗' },
  failed: { color: theme.bad, icon: '×' }, blocked: { color: theme.warn, icon: '!' },
  quarantined: { color: theme.warn, icon: '!' }, pending: { color: theme.muted, icon: '○' },
}
interface Line { text: string; color?: string; bold?: boolean }
const line = (text: string, color?: string, bold = false): Line => ({ text, color, bold })
const duration = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s`
  : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms / 60_000) % 60}m`
const met = (c: Record<string, any>) => TIER_RANK[c.tier as ClaimTier] >= TIER_RANK[c.required_tier as ClaimTier]

/** Read a bounded tail even when a transcript is several megabytes. */
function tailFile(path: string): string[] {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const want = Math.min(8192, size)
      const buf = Buffer.alloc(want)
      readSync(fd, buf, 0, want, size - want)
      const rows = buf.toString('utf8').split('\n')
      if (size > want) rows.shift()
      return rows.filter((s) => s.trim()).slice(-12)
    } finally { closeSync(fd) }
  } catch { return [] }
}

function evidenceLines(store: Store, arcId: string, taskId?: string): Line[] {
  const criteria = taskId ? store.criteriaFor(arcId, taskId) : store.allCriteria(arcId)
  if (!criteria.length) return [line('No acceptance criteria recorded.', theme.muted)]
  return criteria.flatMap((c) => [
    line(`${met(c) ? '✓' : '!'} ${c.task_id}/${c.id} · ${c.tier}${met(c) ? '' : ` → needs ${c.required_tier}`}`, met(c) ? theme.ok : theme.warn),
    line(`  ${c.text}`),
    ...(c.evidence ? [line(`  Evidence: ${c.evidence}`, theme.muted)] : []),
    ...(c.proof_command ? [line(`  Check: ${c.proof_command}`, theme.muted)] : []),
  ])
}

function actionLines(store: Store, arcId: string): Line[] {
  const ops = store.pendingOps(arcId)
  const tasks = store.allTasks(arcId).filter((t) => ATTENTION.has(t.state))
  return [
    ...ops.flatMap((op) => [
      line(`${op.blocking ? 'BLOCKING' : 'Optional'} · ${op.kind} · ${op.task_id}`, op.blocking ? theme.warn : theme.muted, true),
      line(String(op.description)),
      line(`arc ops resolve ${op.id} --id ${arcId} --note "what you completed"`, theme.accent),
    ]),
    ...tasks.flatMap((t) => [
      line(`${t.id} · ${t.state} · ${t.title}`, theme.warn),
      line(t.state === 'quarantined' ? 'Check capability grants in arc.yaml, then resume.' : `Inspect: arc why ${t.id} --id ${arcId}`, theme.muted),
    ]),
    ...(!ops.length && !tasks.length ? [line('No pending operator actions.', theme.ok)] : []),
    line(`Inspect the run: arc digest --id ${arcId}`, theme.muted),
    line(`Continue when ready: arc resume --id ${arcId}`, theme.accent),
    line('Resolution records your note; it never runs the operation description.', theme.muted),
  ]
}

function taskLines(store: Store, arcId: string, task: Record<string, any>): Line[] {
  const id = String(task.id)
  const planTask = store.getPlan(arcId)?.tasks.find((t) => t.id === id)
  const attempts = store.attemptsFor(arcId, id)
  const latest = attempts.at(-1)
  const path = latest?.transcript_artifact_id ? store.artifactPath(String(latest.transcript_artifact_id)) : undefined
  const tail = path ? tailFile(path) : []
  const gates = store.gatesFor(arcId, id).slice(-8)
  return [
    line(String(task.title), undefined, true),
    line(`Task ${id} · ${task.state}`, STATE[task.state]?.color),
    ...(planTask ? [line(`Depends on: ${planTask.dependsOn.join(', ') || 'none'}`, theme.muted),
      line(`Files: ${planTask.footprint.join(', ') || 'not declared'}`, theme.muted)] : []),
    line('Attempts', theme.accent, true),
    ...(!attempts.length ? [line('None yet — the task has not been dispatched.', theme.muted)] : []),
    ...attempts.map((a) => line(`#${a.attempt_no} ${a.role} · ${a.cli}/${a.requested_model} · ${a.ended_at ? `${a.terminal_reason} · ${duration(a.ended_at - a.started_at)}` : `running ${duration(Date.now() - a.started_at)}`}`, a.ended_at ? theme.muted : agentColor(a.cli))),
    ...(latest && !latest.ended_at ? [line('The transcript is saved when this attempt ends.', theme.muted)] : []),
    ...(tail.length ? [line(`Transcript · arc show ${latest!.transcript_artifact_id}`, theme.accent), ...tail.map((t) => line(t))] : []),
    line('Acceptance evidence', theme.accent, true),
    ...evidenceLines(store, arcId, id),
    ...(gates.length ? [line('Recent checks', theme.accent, true), ...gates.map((g) => line(`${g.verdict === 'pass' ? '✓' : '×'} ${g.name} · ${g.verdict}${g.signature ? ` · ${g.signature}` : ''}`, g.verdict === 'pass' ? theme.ok : theme.bad))] : []),
    ...store.findingsFor(arcId).filter((f) => f.task_id === id).slice(-8).map((f) => line(`[${f.severity}] ${f.text}`, theme.warn)),
  ]
}

function activityLines(store: Store, arcId: string): Line[] {
  const events = store.eventsSince(arcId, 0).slice(-80).reverse()
  return events.map((e) => {
    const p = e.payload as Record<string, any> | undefined
    const description = e.kind === 'task.state' ? `Task ${p?.state}`
      : e.kind === 'gate' ? `Check ${p?.name ?? ''} · ${p?.verdict ?? ''}`
        : e.kind === 'pending-op.resolved' ? `Operation resolved · ${p?.note ?? ''}`
          : e.kind === 'land' ? 'Changes landed on integration'
            : e.kind === 'arc.needs-input' ? 'Waiting for operator action'
              : `${e.kind.replace(/[.-]/g, ' ')}${p?.message || p?.reason || p?.text ? ` · ${p.message ?? p.reason ?? p.text}` : ''}`
    return line(`${new Date(e.at).toTimeString().slice(0, 8)}  ${e.taskId ?? 'run'} · ${description}`, theme.muted)
  })
}

export interface DashboardProps {
  store: Store
  width: number
  interactive: boolean
  compact?: boolean
  initialArcId?: string
  onClose?: () => void
  onExit?: () => void
}

export function Dashboard({ store, width, interactive, compact = false, initialArcId, onClose, onExit }: DashboardProps) {
  const { exit } = useApp()
  const terminal = useTerminalSize()
  const [, refresh] = useState(0)
  const arcs = store.allArcs()
  const [selectedId, setSelectedId] = useState(() => initialArcId || String(arcs.find((a) => a.status === 'running')?.id ?? arcs[0]?.id ?? ''))
  const [taskIdx, setTaskIdx] = useState(0)
  const [opened, setOpened] = useState(false)
  const [pane, setPane] = useState<Pane>('activity')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    if (!interactive) return
    const timer = setInterval(() => refresh((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [interactive])

  // Selection is an identity, never a row index: a new run cannot steal focus.
  const focusedDesign = selectedId && !arcs.some((a) => a.id === selectedId) && store.getDesign(selectedId)
  const arc = focusedDesign ? undefined : arcs.find((a) => a.id === selectedId) ?? arcs.find((a) => a.status === 'running') ?? arcs[0]
  useEffect(() => { if (arc && arc.id !== selectedId) setSelectedId(String(arc.id)) }, [arc?.id, selectedId])
  const arcId = String(arc?.id ?? '')
  const order = new Map((arc ? store.getPlan(arcId)?.tasks ?? [] : []).map((t, i) => [t.id, i]))
  const allTasks = arc ? store.allTasks(arcId).sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)) : []
  const tasks = attentionOnly ? allTasks.filter((t) => ATTENTION.has(t.state)) : allTasks
  const selected = Math.min(taskIdx, Math.max(0, tasks.length - 1))
  const task = tasks[selected]
  const cols = Math.min(width, terminal.width)
  const height = Math.max(12, (terminal.rows ?? 36) - (compact ? 5 : 1))
  const taskRows = Math.min(tasks.length || 1, height < 28 ? 3 : 7)
  const start = windowStart(selected, tasks.length, taskRows)
  const ops = arc ? store.openBlockingOps(arcId) : []
  const criteria = arc ? store.allCriteria(arcId) : []
  const missing = criteria.filter((c) => !met(c)).length
  const waived = criteria.filter((c) => c.tier === 'waived').length
  const live = arc ? store.liveAttempts(arcId) : []
  const attention = allTasks.filter((t) => ATTENTION.has(t.state)).length + ops.length
  const landed = allTasks.filter((t) => t.state === 'landed').length
  const source: Line[] = !arc ? [] : opened && task ? taskLines(store, arcId, task)
    : pane === 'evidence' ? evidenceLines(store, arcId, task?.id)
      : pane === 'actions' ? actionLines(store, arcId)
        : pane === 'findings' ? store.findingsFor(arcId).slice().reverse().flatMap((f) => [line(`[${f.severity}] ${f.task_id ?? 'run'} · ${f.kind}`, f.severity === 'high' || f.severity === 'critical' ? theme.bad : theme.warn), line(String(f.text))])
          : activityLines(store, arcId)
  const content = source.flatMap((l) => draftRows(plain(l.text), cols - 2).map((row) => ({ ...l, text: row.text })))
  const contentRows = Math.max(2, height - (opened ? 9 : 11 + taskRows))
  const scroll = Math.min(offset, Math.max(0, content.length - contentRows))

  useRawKeys((key) => {
    if (key.ctrl && key.name === 'c') { (onExit ?? onClose ?? exit)(); return }
    if (key.text === 'q') { (onClose ?? exit)(); return }
    if (key.name === 'escape') { if (opened) { setOpened(false); setOffset(0) } else onClose?.(); return }
    if (key.name === 'return' && task) { setOpened((o) => !o); setOffset(0); return }
    if (key.name === 'up' || key.text === 'k') { setTaskIdx((i) => Math.max(0, Math.min(i, tasks.length - 1) - 1)); setOffset(0) }
    if (key.name === 'down' || key.text === 'j') { setTaskIdx((i) => Math.max(0, Math.min(tasks.length - 1, i + 1))); setOffset(0) }
    if (key.name === 'left' || key.name === 'right' || key.text === '[' || key.text === ']') {
      const at = arcs.findIndex((a) => a.id === arcId)
      const next = Math.max(0, Math.min(arcs.length - 1, at + (key.name === 'left' || key.text === '[' ? -1 : 1)))
      if (arcs[next]) setSelectedId(String(arcs[next]!.id))
      setTaskIdx(0); setOpened(false); setOffset(0)
    }
    if (key.name === 'tab') { setPane(PANES[(PANES.indexOf(pane) + (key.shift ? 3 : 1)) % 4]!); setOpened(false); setOffset(0) }
    if (key.text === 'f') { setAttentionOnly((v) => !v); setTaskIdx(0); setOpened(false); setOffset(0) }
    if (key.name === 'pagedown') setOffset(Math.min(Math.max(0, content.length - contentRows), scroll + contentRows))
    if (key.name === 'pageup') setOffset(Math.max(0, scroll - contentRows))
  }, interactive)

  if (!arc) {
    const designId = initialArcId || store.latestDesignId()
    const design = designId ? store.getDesign(designId) : undefined
    const workers = designId ? store.liveAttempts(designId) : []
    const finished = designId ? store.eventsSince(designId, 0).findLast((e) => e.kind === 'lane.end') : undefined
    return <Box flexDirection="column" width={cols} paddingX={1} paddingY={1}>
      <Text bold color={theme.accent}>ARC · Run dashboard</Text>
      <Text>{design ? finished ? 'Latest session finished' : `Designing (${design.status})` : initialArcId || workers.length ? 'Preparing the mission. Build tasks will appear after planning.' : 'Your first mission starts with a brief.'}</Text>
      {workers.map((w) => <Text key={w.id} color={agentColor(w.cli)}>{clip(`${w.role} · ${w.requested_model} · ${duration(Date.now() - w.started_at)}`, cols - 2)}</Text>)}
      <Text color={theme.muted}>{design ? 'Build tasks appear after a deep plan is approved.' : 'Describe an outcome in ARC, or run:'}</Text>
      {!design && <Text color={theme.accent}>{'arc "what you want done"'}</Text>}
      <Text color={theme.muted}>{onClose ? 'esc back to conversation' : 'q to quit'}{arcs.length ? ' · ←→ browse deep missions' : ''}</Text>
    </Box>
  }

  const goal = JSON.parse(String(arc.charter_json)).goal
  const next = ops.length ? `${ops.length} blocking operation${ops.length === 1 ? '' : 's'} · open Actions with tab`
    : attention ? `${attention} task${attention === 1 ? '' : 's'} need attention · f filters the list`
      : arc.status === 'done' ? 'Run complete · delivery and checks are in Activity and Evidence'
        : arc.status === 'incomplete' ? 'Run stopped · inspect evidence and Actions before resuming'
          : live.length ? `${live.length} agent${live.length === 1 ? '' : 's'} working · enter opens a task`
            : 'No active agent · preparing, checking, or waiting; inspect Activity'
  const footer = opened ? '↑↓ other task · esc to go back · pgup/pgdn scroll'
    : cols < 70 ? '↑↓ task · enter open · tab pane · f filter' : '↑↓ task · enter open · ←→ run · tab pane · f needs attention'
  return <Box flexDirection="column" width={cols} height={height}>
    <Box paddingX={1} justifyContent="space-between">
      <Text bold color={theme.accent}>{clip(`ARC / ${arcId}`, cols - 19)}</Text>
      <Text color={arc.status === 'done' ? theme.ok : attention || arc.status === 'incomplete' ? theme.warn : theme.sol}>{String(arc.status)} · {arcs.findIndex((a) => a.id === arcId) + 1}/{arcs.length}</Text>
    </Box>
    <Box paddingX={1}><Text>{clip(goal, cols - 2)}</Text></Box>
    <Box paddingX={1}><Text color={theme.muted}>{clip(`${landed}/${allTasks.length} landed · ${criteria.length ? `${criteria.length - missing}/${criteria.length} evidence requirements met${waived ? ` · ${waived} waived` : ''}` : 'no acceptance criteria'}`, cols - 2)}</Text></Box>
    {arc.status !== 'running' && <Box paddingX={1}><Text color={theme.muted}>{clip(`${arc.closed_at ? 'ended' : 'started'} ${duration(Date.now() - Number(arc.closed_at ?? arc.created_at))} ago · kept as the run's evidence record`, cols - 2)}</Text></Box>}
    <Box paddingX={1}><Text color={attention || arc.status === 'incomplete' ? theme.warn : theme.accentBright}>{clip(next, cols - 2)}</Text></Box>
    <Section title={opened ? `Task ${task?.id ?? ''}` : `Tasks${attentionOnly ? ' · needs attention' : ''}`} hint={!opened ? `${tasks.length ? selected + 1 : 0}/${tasks.length}` : 'pgup/pgdn to scroll'} width={cols} />
    {!opened && <Box flexDirection="column" paddingX={1}>
      {!tasks.length && <Text color={theme.muted}>{attentionOnly ? 'No tasks need attention. Press f to show all.' : 'No tasks recorded.'}</Text>}
      {tasks.slice(start, start + taskRows).map((t, i) => {
        const on = start + i === selected
        const state = STATE[t.state] ?? STATE.pending!
        return <Text key={t.id} bold={on}><Text color={on ? theme.accentBright : theme.muted}>{on ? '❯ ' : '  '}</Text><Text color={state.color}>{state.icon} {String(t.state).padEnd(12)}</Text>{clip(`${t.id} · ${t.title}`, cols - 19)}</Text>
      })}
    </Box>}
    {!opened && <Box paddingX={1} marginTop={1}>
      {cols < 48 ? <Text color={theme.accentBright}>[{pane}] · tab to switch</Text> : PANES.map((p) => <Text key={p} color={pane === p ? theme.accentBright : theme.muted} bold={pane === p}>{pane === p ? `[${p}]` : p}{'  '}</Text>)}
    </Box>}
    <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
      {content.length ? content.slice(scroll, scroll + contentRows).map((l, i) => <Text key={`${scroll}-${i}`} color={l.color} bold={l.bold}>{clip(l.text, cols - 2)}</Text>)
        : <Text color={theme.muted}>{pane === 'findings' ? 'No findings recorded.' : 'No activity recorded yet.'}</Text>}
    </Box>
    <Section title={content.length > contentRows ? `${scroll + 1}–${Math.min(content.length, scroll + contentRows)} of ${content.length} · pgup/pgdn` : 'Live evidence'} hint={interactive ? onClose ? 'esc / q back' : 'q quit' : 'snapshot'} width={cols} />
    <Box paddingX={1}><Text color={theme.muted}>{clip(interactive ? footer : 'snapshot · open in a terminal to navigate', cols - 2)}</Text></Box>
  </Box>
}
