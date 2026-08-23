import React, { useState, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { Store } from './store.ts'
import { TIER_RANK, type ClaimTier } from './types.ts'

/**
 * The live view over an arc. A pure READER: it opens the same SQLite store the
 * orchestrator writes to and polls it. No IPC, no server, no shared memory — so
 * opening or closing it can never perturb a running arc, and several can run at
 * once.
 *
 * `compact` drops the chrome for embedding inside the interactive app, where
 * the phase list above it already says where we are.
 */

const POLL_MS = 1000

const TIER_COLOR: Record<string, string> = {
  observed: 'green',
  checked: 'cyan',
  claimed: 'yellow',
  unproven: 'red',
  waived: 'gray',
}

const STATE_COLOR: Record<string, string> = {
  landed: 'green',
  failed: 'red',
  blocked: 'red',
  running: 'yellow',
  reviewing: 'magenta',
  landing: 'cyan',
  pending: 'gray',
}

function ago(ms: number | null | undefined): string {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function Rule({ label, width }: { label?: string; width: number }) {
  const text = label ? `─ ${label} ` : ''
  return <Text color="gray">{text + '─'.repeat(Math.max(0, width - text.length))}</Text>
}

type Pane = 'events' | 'findings' | 'criteria'

export function Dashboard({ store, width, interactive, compact = false }: { store: Store; width: number; interactive: boolean; compact?: boolean }) {
  const { exit } = useApp()
  const [tick, setTick] = useState(0)
  // Open on the arc that is RUNNING, not merely the newest — a dead run
  // sitting on screen while a live one builds sent a real operator chasing
  // failures that were already history.
  const [arcIdx, setArcIdx] = useState(() => {
    const idx = store.allArcs().findIndex((a) => String(a.status) === 'running')
    return idx >= 0 ? idx : 0
  })
  const [taskIdx, setTaskIdx] = useState(0)
  const [pane, setPane] = useState<Pane>('events')

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS)
    return () => clearInterval(t)
  }, [])

  const arcs = store.allArcs()
  const arc = arcs[Math.min(arcIdx, Math.max(0, arcs.length - 1))]

  // Keyboard only when stdin is a real TTY. Piped or redirected (`arc ui >
  // snapshot.txt`, CI), raw mode is unavailable and asking for it throws — so
  // the dashboard degrades to a one-frame snapshot instead of crashing.
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }
    if (key.upArrow || input === 'k') setTaskIdx((i) => Math.max(0, i - 1))
    if (key.downArrow || input === 'j') setTaskIdx((i) => i + 1)
    if (key.leftArrow || input === '[') { setArcIdx((i) => Math.max(0, i - 1)); setTaskIdx(0) }
    if (key.rightArrow || input === ']') { setArcIdx((i) => Math.min(arcs.length - 1, i + 1)); setTaskIdx(0) }
    if (key.tab) setPane((p) => (p === 'events' ? 'findings' : p === 'findings' ? 'criteria' : 'events'))
  }, { isActive: interactive })

  if (!arc) {
    // An empty build table does NOT mean nothing is happening — the design
    // phase (interview, scouts, planning) runs before any arc row exists, and
    // a real operator watched "no arcs yet" for hours while it worked.
    const designId = store.latestDesignId()
    const design = designId ? store.getDesign(designId) : undefined
    const live = designId ? store.liveAttempts(designId) : []
    const worker = live[live.length - 1]
    const mins = worker ? Math.max(0, Math.round((Date.now() - Number(worker.started_at)) / 60_000)) : 0
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>arc</Text>
        {design ? (
          <>
            <Text color="magenta">Designing ({design.status})
              {worker ? ` — ${worker.role} agent (${worker.model}) working, ${mins}m` : ''}</Text>
            <Text color="gray">Interview, scouting, and planning happen before any build task exists.</Text>
            <Text color="gray">This table fills in the moment the build starts.</Text>
          </>
        ) : (
          <Text color="gray">Nothing here yet. Start with: arc "what you want done"</Text>
        )}
        <Text color="gray">q to quit</Text>
      </Box>
    )
  }

  const arcId = String(arc.id)
  const charter = JSON.parse(String(arc.charter_json))
  const tasks = store.allTasks(arcId)
  const summary = store.arcSummary(arcId)
  const live = store.liveAttempts(arcId)
  const sel = tasks[Math.min(taskIdx, Math.max(0, tasks.length - 1))]

  const goalLines = String(charter.goal).trim().split('\n').slice(0, 2)

  return (
    <Box flexDirection="column" width={width}>
      {/* ── the charter. never scrolls away. ─────────────────────────── */}
      <Box flexDirection="column" paddingX={1} display={compact ? 'none' : 'flex'}>
        <Box>
          <Text bold color="cyan">{arcId}</Text>
          <Text color="gray">{'  '}{String(arc.status)}</Text>
          {String(arc.status) !== 'running' && (() => {
            const at = Number(arc.closed_at ?? arc.created_at)
            const m = Math.max(1, Math.round((Date.now() - at) / 60_000))
            const ago = m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
            return <Text color="gray">{'  '}{arc.closed_at ? `ended ${ago}` : `started ${ago}`} — kept as the run's evidence record</Text>
          })()}
          {String(arc.status) !== 'running' && arcs.some((a) => a.id !== arc.id && String(a.status) === 'running') && (
            <Text color="yellow" bold>{'  '}a newer run is LIVE — ←→ to switch</Text>
          )}
          <Text color="gray">{'  '}{arcs.length > 1 ? `[${arcIdx + 1}/${arcs.length}] ←→ to switch` : ''}</Text>
        </Box>
        {goalLines.map((l, i) => <Text key={i} color="white">{l.slice(0, width - 2)}</Text>)}
        <Box>
          <Text color="green">{summary.landed} landed</Text>
          <Text color="gray"> · </Text>
          <Text color={summary.running ? 'yellow' : 'gray'}>{summary.running} running</Text>
          <Text color="gray"> · </Text>
          <Text color={summary.failed ? 'red' : 'gray'}>{summary.failed} failed</Text>
          <Text color="gray"> · of {summary.total}</Text>
          <Text color="gray">{'   '}</Text>
          <Text color={summary.unproven ? 'red' : 'green'}>
            {summary.unproven ? `${summary.unproven} criteria UNPROVEN` : 'every criterion proven'}
          </Text>
        </Box>
      </Box>

      <Rule label="now" width={width} />

      {/* ── what is actually in flight right now ─────────────────────── */}
      <Box flexDirection="column" paddingX={1}>
        {live.length === 0 && <Text color="gray">nothing in flight</Text>}
        {live.map((a) => (
          <Box key={String(a.id)}>
            <Text color="yellow">▶ </Text>
            <Text>{String(a.task_id ?? 'arc').padEnd(16).slice(0, 16)}</Text>
            <Text color="magenta">{String(a.role).padEnd(10)}</Text>
            <Text color="gray">{String(a.cli)}/{String(a.requested_model)}</Text>
            <Text color="gray">{'  '}{ago(a.started_at as number)}</Text>
          </Box>
        ))}
      </Box>

      <Rule label="tasks" width={width} />

      {/* ── task list ────────────────────────────────────────────────── */}
      <Box flexDirection="column" paddingX={1}>
        {tasks.map((t, i) => {
          const on = i === Math.min(taskIdx, tasks.length - 1)
          const unmet = store.unmetCriteria(arcId, String(t.id)).length
          return (
            <Box key={String(t.id)}>
              <Text color={on ? 'cyan' : 'gray'}>{on ? '❯ ' : '  '}</Text>
              <Text color={STATE_COLOR[String(t.state)] ?? 'white'}>
                {String(t.state).padEnd(10)}
              </Text>
              <Text bold={on}>{String(t.title).slice(0, Math.max(10, width - 40))}</Text>
              {unmet > 0 && <Text color="red">{'  '}{unmet} unproven</Text>}
            </Box>
          )
        })}
      </Box>

      <Rule label={pane === 'events' ? 'events (tab)' : pane === 'findings' ? 'findings (tab)' : `criteria — ${sel ? String(sel.id) : ''} (tab)`} width={width} />

      {/* ── bottom pane ──────────────────────────────────────────────── */}
      <Box flexDirection="column" paddingX={1} minHeight={8}>
        {pane === 'events' && <Events store={store} arcId={arcId} width={width} />}
        {pane === 'findings' && <Findings store={store} arcId={arcId} width={width} />}
        {pane === 'criteria' && sel && <Criteria store={store} arcId={arcId} taskId={String(sel.id)} width={width} />}
      </Box>

      <Rule width={width} />
      <Box paddingX={1}>
        <Text color="gray">
          {interactive ? '↑↓ task · ←→ arc · tab pane · q quit' : 'snapshot (no tty — run in a terminal for live view)'}
        </Text>
        <Text color="gray">{'   '}{interactive ? `refreshed ${tick % 2 === 0 ? '·' : ' '}` : ''}</Text>
      </Box>
    </Box>
  )
}

function Events({ store, arcId, width }: { store: Store; arcId: string; width: number }) {
  const all = store.eventsSince(arcId, 0)
  const recent = all.slice(-10)
  if (recent.length === 0) return <Text color="gray">no events yet</Text>
  return (
    <>
      {recent.map((e) => (
        <Box key={e.seq}>
          <Text color="gray">{new Date(e.at).toTimeString().slice(0, 8)} </Text>
          <Text color="cyan">{(e.taskId ?? 'arc').padEnd(14).slice(0, 14)}</Text>
          <Text>{e.kind.padEnd(16)}</Text>
          <Text color="gray">
            {e.payload ? JSON.stringify(e.payload).slice(0, Math.max(10, width - 46)) : ''}
          </Text>
        </Box>
      ))}
    </>
  )
}

function Findings({ store, arcId, width }: { store: Store; arcId: string; width: number }) {
  const f = store.findingsFor(arcId).slice(-10)
  if (f.length === 0) return <Text color="gray">no findings</Text>
  return (
    <>
      {f.map((x) => (
        <Box key={String(x.id)}>
          <Text color={x.severity === 'high' ? 'red' : x.severity === 'medium' ? 'yellow' : 'gray'}>
            {String(x.severity).padEnd(7)}
          </Text>
          <Text color="cyan">{String(x.kind).padEnd(12)}</Text>
          <Text>{String(x.text).replace(/\s+/g, ' ').slice(0, Math.max(10, width - 24))}</Text>
        </Box>
      ))}
    </>
  )
}

/** The scoreboard — the literal answer to "did he do it good?" */
function Criteria({ store, arcId, taskId, width }: { store: Store; arcId: string; taskId: string; width: number }) {
  const crit = store.criteriaFor(arcId, taskId)
  if (crit.length === 0) return <Text color="gray">no criteria</Text>
  return (
    <>
      {crit.map((c) => {
        const below = TIER_RANK[c.tier as ClaimTier] < TIER_RANK[c.required_tier as ClaimTier]
        return (
          <Box key={String(c.id)} flexDirection="column">
            <Box>
              <Text color={TIER_COLOR[String(c.tier)] ?? 'white'}>{String(c.tier).padEnd(9)}</Text>
              <Text>{String(c.text).slice(0, Math.max(10, width - 30))}</Text>
              {below && <Text color="red">{'  '}needs {String(c.required_tier)}</Text>}
            </Box>
            {c.evidence && (
              <Text color="gray">
                {'          '}{String(c.evidence).replace(/\s+/g, ' ').slice(0, Math.max(10, width - 14))}
              </Text>
            )}
          </Box>
        )
      })}
    </>
  )
}

