import { spawn } from 'node:child_process'

/**
 * Arc's defining use case is "start it and walk away", and it had no channel to
 * your attention at all: `grep -rn "notif|bell|osascript|webhook" src/` returned
 * one hit, in clipboard.ts. Walking away meant finding out by going back and
 * looking.
 *
 * Two tiers, no dependencies.
 *
 * TIER 0 — passive terminal signals. Zero config, always on. The window title
 * carries state, the tab progress ring carries shape and colour, and a toast
 * fires on the three moments that actually want a human. A failed run turns the
 * tab ring red, which is visible from across the room without focusing the
 * window.
 *
 * TIER 1 — an external hook, copying Codex's contract: a command array, the
 * JSON event appended as the final argv argument, stdio null, spawned detached,
 * short timeout, and a notifier failure NEVER fails the arc. Whatever else is
 * true, an arc must not die because a Slack webhook was down.
 *
 * Ink owns stdout, so every sequence goes to stderr — writing to stdout races
 * the frame.
 */

export type NotifyKind =
  | 'progress'      // routine transition, title + ring only
  | 'needs-input'   // blocked on a human
  | 'done'
  | 'failed'

export interface NotifyEvent {
  kind: NotifyKind
  arcId: string
  /** One line, already human-readable. */
  message: string
  /** 0-100 where known; omitted during a phase with no denominator. */
  percent?: number
}

/** OSC 9;4 progress states, as Windows Terminal defined them and every other
 *  terminal that implements it copied. */
const RING = { hide: 0, value: 1, error: 2, indeterminate: 3, warning: 4 } as const

/** Written as codepoints so the sequences are readable and cannot be mangled. */
const ESC = '\x1b'
const BEL = '\x07'

function osc(sequence: string): void {
  // stderr, never stdout: Ink renders to stdout and this would race the frame.
  try { process.stderr.write(sequence) } catch { /* a closed pipe is not an arc failure */ }
}

/** Passive signals. Nothing to configure, nothing to install. */
export function paintTerminal(event: NotifyEvent): void {
  if (!process.stderr.isTTY) return

  osc(ESC + ']2;arc · ' + event.message + ESC + '\\')

  const state = event.kind === 'failed' ? RING.error
    : event.kind === 'needs-input' ? RING.warning
      : event.percent === undefined ? RING.indeterminate
        : RING.value
  const value = event.percent === undefined ? 0 : Math.max(0, Math.min(100, Math.round(event.percent)))
  osc(ESC + ']9;4;' + state + ';' + value + BEL)

  if (event.kind === 'progress') return
  // A toast on the three moments that want a human, plus BEL for terminals
  // that do not implement OSC 9.
  osc(ESC + ']9;arc: ' + event.message + ESC + '\\')
  osc(BEL)
}

export interface NotifyOptions {
  /** Command array; the JSON event is appended as the final argument. */
  command?: string[]
  timeoutMs?: number
}

/**
 * Fire the operator's hook. Detached, silent, and incapable of failing the arc.
 * Returns immediately — a notifier is never on the critical path.
 */
export function runNotifyHook(event: NotifyEvent, options: NotifyOptions): void {
  const command = options.command
  if (!command || command.length === 0) return
  const [bin, ...args] = command
  try {
    const child = spawn(bin!, [...args, JSON.stringify(event)], {
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', () => { /* a broken notifier is not a broken arc */ })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } },
      options.timeoutMs ?? 5_000)
    timer.unref?.()
    child.unref()
  } catch { /* same */ }
}

export function notify(event: NotifyEvent, options: NotifyOptions = {}): void {
  paintTerminal(event)
  runNotifyHook(event, options)
}

/** Put the tab ring back when the process is finished with it, so a stale
 *  red ring does not outlive the run that set it. */
export function clearTerminal(): void {
  if (!process.stderr.isTTY) return
  osc(ESC + ']9;4;' + RING.hide + ';0' + BEL)
  osc(ESC + ']2;' + ESC + '\\')
}
