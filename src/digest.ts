import type { Store } from './store.ts'

/**
 * You come back after six hours. Your options were scrolling forty thousand
 * lines of buffer or running four separate commands, none of which answered
 * *"what happened, and what do I do now?"*
 *
 * This is a FOLD over the `event` table, which already carries the entire
 * narrative — arc.start, task.state, gate, finding, land, pr, capacity.*,
 * arc.crash, arc.supervisor.relaunch, criterion.tier. No new instrumentation,
 * and testable with zero model calls.
 *
 * Five rules are what make it a digest rather than a log:
 *
 *   1. NEEDS-YOU FIRST, and only things actually blocked on a human. If nothing
 *      is, that block is absent and line one is the outcome.
 *   2. Successes collapse, failures expand. A landed task is one line; a failed
 *      one gets its first gate error verbatim, plus the artifact id.
 *   3. Self-healed events get a quieter block of their own. Relaunches, lease
 *      expiries and capacity waits are interesting but not actionable — hiding
 *      them is dishonest, leading with them is noise.
 *   4. Every truncation names its escape hatch. Print the artifact id, always.
 *   5. `--since last-seen`. What makes it useful on the SECOND return.
 */

export interface DigestOptions {
  /** Only events after this sequence number. */
  sinceSeq?: number
  /** Markdown rather than ANSI-free plain text, for a PR body. */
  markdown?: boolean
}

export interface Digest {
  lines: string[]
  /** Where to resume from next time. */
  lastSeq: number
  needsYou: number
}

export function buildDigest(store: Store, arcId: string, options: DigestOptions = {}): Digest {
  const events = store.eventsSince(arcId, options.sinceSeq ?? 0)
  const lastSeq = events.length > 0 ? Number(events.at(-1)!.seq) : (options.sinceSeq ?? 0)
  const arc = store.getArc(arcId)
  const tasks = store.allTasks(arcId)
  const bullet = options.markdown ? '- ' : '  '
  const head = (text: string): string => options.markdown ? `## ${text}` : text

  const lines: string[] = []

  // 1. Needs you — and ONLY things blocked on a human.
  const blocking = store.openBlockingOps(arcId)
  const interventions = store.pendingInterventionsForArc(arcId)
  const needsYou = blocking.length + interventions.length
  if (needsYou > 0) {
    lines.push(head('NEEDS YOU'))
    for (const op of blocking) lines.push(`${bullet}[${op.kind}] ${op.description}`)
    for (const i of interventions) lines.push(`${bullet}[steering] ${String(i.text ?? '').slice(0, 160)}`)
    lines.push('')
  }

  // The outcome, in one line.
  const landed = tasks.filter((t) => t.state === 'landed')
  const failed = tasks.filter((t) => t.state === 'failed')
  lines.push(head(`arc ${arcId} — ${arc?.status ?? 'unknown'}`))
  lines.push(`${bullet}${landed.length}/${tasks.length} landed${failed.length > 0 ? `, ${failed.length} failed` : ''}`)

  // 2. Successes collapse.
  if (landed.length > 0) {
    lines.push('')
    lines.push(head('Landed'))
    for (const t of landed) lines.push(`${bullet}${t.id} — ${t.title}`)
  }

  // 2. Failures expand — with the actual error, and the artifact id for the rest.
  if (failed.length > 0) {
    lines.push('')
    lines.push(head('Failed'))
    for (const t of failed) {
      lines.push(`${bullet}${t.id} — ${t.title}`)
      const redGate = store.gatesFor(arcId, String(t.id)).filter((g) => g.verdict === 'fail').at(-1)
      if (redGate) {
        const excerpt = String(redGate.signature ?? '').split('\n').filter(Boolean).slice(0, 3)
        for (const line of excerpt) lines.push(`${bullet}    ${line.slice(0, 160)}`)
        // Rule 4: every truncation names its escape hatch.
        if (redGate.artifact_id) lines.push(`${bullet}    full output: arc show ${redGate.artifact_id}`)
      }
    }
  }

  const findings = store.findingsFor(arcId).filter((f) => f.severity === 'high' || f.severity === 'critical')
  if (findings.length > 0) {
    lines.push('')
    lines.push(head('Findings worth reading'))
    for (const f of findings.slice(0, 10)) lines.push(`${bullet}[${f.severity}] ${String(f.text).slice(0, 200)}`)
    if (findings.length > 10) lines.push(`${bullet}… and ${findings.length - 10} more: arc findings`)
  }

  // 3. Self-healed: interesting, not actionable, and NOT hidden.
  const healed = events.filter((e) =>
    ['capacity.wait', 'arc.supervisor.relaunch', 'task.orphan.killed', 'land.recovered', 'task.workspace.recovered']
      .includes(String(e.kind)))
  if (healed.length > 0) {
    lines.push('')
    lines.push(head('Handled without you'))
    const counted = new Map<string, number>()
    for (const e of healed) counted.set(String(e.kind), (counted.get(String(e.kind)) ?? 0) + 1)
    for (const [kind, n] of counted) lines.push(`${bullet}${kind} × ${n}`)
  }

  return { lines, lastSeq, needsYou }
}
