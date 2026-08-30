import { existsSync } from 'node:fs'
import type { Store } from './store.ts'

/**
 * One task failed. `arc digest` tells you THAT; this tells you what to do about
 * it — and the answer turns almost entirely on one question nothing in Arc was
 * asking out loud.
 *
 * Four rules, in the order they earn their space:
 *
 *   1. DIFF THE ATTEMPTS. "The same error every time" and "a different error
 *      each time" are different failures with different human responses — one
 *      is stuck against something it cannot see (read the error, fix it
 *      yourself, or change the spec), the other is thrashing (the task is too
 *      big, or the gate is flaky). The `signature` column exists precisely to
 *      make that comparison stable across runs, and until now only the stall
 *      guard read it. Said early, because everything below is read differently
 *      depending on the answer.
 *   2. HEAD of the error, not the tail. tsc and vitest print the CAUSE first
 *      and its consequences after, so the first error is the one worth a human's
 *      attention. This is deliberately the OPPOSITE of `failureExcerpt` in
 *      src/orchestrator.ts, which tail-weights because a model gets the whole
 *      window and needs the summary. Two audiences, two rules — do not unify
 *      them.
 *   3. NAME THE WORKTREE. A failure whose evidence you cannot walk into is a
 *      claim, not a report. Print the path, and say so when it is already gone
 *      rather than sending the operator to a directory that no longer exists.
 *   4. Every truncation names its escape hatch — the artifact id, per attempt,
 *      so `arc show <id>` gets the untruncated output for any round.
 */

export function explainFailure(store: Store, arcId: string, taskId: string): string[] {
  const task = store.getTask(arcId, taskId)
  if (!task) return [`no task "${taskId}" in arc ${arcId}`]

  const attemptNo = new Map<string, number>()
  for (const a of store.attemptsFor(arcId, taskId)) attemptNo.set(String(a.id), Number(a.attempt_no))
  const rounds = failureRounds(store.gatesFor(arcId, taskId).filter((g) => g.verdict === 'fail'))

  const lines = [`task ${taskId} — ${task.title} (${task.state})`]

  // 1. The sentence the rest of the report is read through.
  if (rounds.length === 0) {
    lines.push('  no failed gate recorded — it never got as far as being graded')
  } else if (rounds.length === 1) {
    lines.push('  one failed attempt — nothing to compare it against yet')
  } else {
    const distinct = new Set(rounds.map((r) => r.signature)).size
    lines.push(distinct === 1
      ? `  the same error every time — ${rounds.length} attempts, one signature. Stuck, not thrashing: it cannot see the fix, so reading the error yourself is the cheapest next move.`
      : `  a different error each time — ${distinct} signatures across ${rounds.length} attempts. Thrashing, not stuck: the task is probably too big, or the gate is unstable.`)
  }

  // An attempt that died before it produced output failed for a reason that has
  // nothing to do with the code, and reading gate output for it is wasted time.
  const unfinished = store.attemptsFor(arcId, taskId)
    .filter((a) => a.terminal_reason && a.terminal_reason !== 'ok')
  if (unfinished.length > 0) {
    lines.push('')
    lines.push('  attempts that never finished:')
    for (const a of unfinished) lines.push(`    #${a.attempt_no} ${a.role} — ${a.terminal_reason}`)
  }

  // 2. The head of the newest failure.
  const last = rounds.at(-1)
  if (last) {
    const head = errorHead(last.signature)
    if (head.shown.length > 0) {
      lines.push('')
      lines.push('  first error (what follows it is usually its consequence):')
      for (const l of head.shown) lines.push(`    ${l.slice(0, 160)}`)
      if (head.hidden > 0) lines.push(`    … ${head.hidden} more error line(s) after it`)
    }
  }

  // 3. Where the evidence is — and whether it still exists.
  lines.push('')
  const wt = task.worktree ? String(task.worktree) : ''
  if (!wt) lines.push('  worktree: none recorded')
  else if (!existsSync(wt)) lines.push(`  worktree: ${wt} (gone — cleaned up after the run)`)
  else {
    lines.push(`  worktree: ${wt}`)
    if (last?.command) lines.push(`  reproduce: cd ${wt} && ${last.command}`)
  }

  // 4. One escape hatch per round, so any attempt can be read in full — and the
  //    diff in rule 1 can be checked by hand rather than taken on trust.
  const withArtifacts = rounds.filter((r) => r.artifactId)
  if (withArtifacts.length > 0) {
    lines.push('')
    lines.push('  full output, per attempt:')
    for (const [i, r] of withArtifacts.entries()) {
      const label = attemptNo.get(r.key) ?? i + 1
      lines.push(`    #${label} ${r.gates} — arc show ${r.artifactId}`)
    }
  }

  const findings = store.findingsFor(arcId).filter((f) => f.task_id === taskId)
  if (findings.length > 0) {
    lines.push('')
    lines.push('  findings recorded against this task:')
    for (const f of findings.slice(0, 10)) lines.push(`    [${f.severity}] ${String(f.text).slice(0, 200)}`)
  }

  return lines
}

interface Round {
  /** attempt id when the gate recorded one; otherwise the gate row's own id. */
  key: string
  signature: string
  gates: string
  command: string
  artifactId: string
}

/**
 * One entry per attempt, oldest first.
 *
 * Keyed on attempt_id so that two gates failing inside one attempt count as one
 * round — otherwise a task whose tsc and vitest both go red would read as two
 * "attempts" with different errors, which is exactly the wrong answer to rule 1.
 * Gates recorded without an attempt fall back to their own row id and stay
 * separate, which is the honest reading of "we do not know which run this was".
 */
function failureRounds(failed: Array<Record<string, any>>): Round[] {
  const byAttempt = new Map<string, Round>()
  for (const g of failed) {
    const key = String(g.attempt_id ?? g.id)
    const round = byAttempt.get(key)
    const signature = String(g.signature ?? '')
    if (!round) {
      byAttempt.set(key, {
        key, signature, gates: String(g.name),
        command: String(g.command ?? ''), artifactId: String(g.artifact_id ?? ''),
      })
    } else {
      round.signature = `${round.signature}\n${signature}`
      round.gates = `${round.gates}, ${g.name}`
    }
  }
  return [...byAttempt.values()]
}

/** Deliberately loose — over-matching costs a line of context, missing costs the error. */
const ERROR_LINE = /(error|fail|✗|✕|err!)/i

function errorHead(signature: string, keep = 5): { shown: string[]; hidden: number } {
  const all = signature.split('\n').filter((l) => l.trim().length > 0)
  // A runner's banner and per-file progress come first; the causal error is the
  // first line that looks like one, not the first line printed.
  const start = Math.max(0, all.findIndex((l) => ERROR_LINE.test(l)))
  const shown = all.slice(start, start + keep)
  return { shown, hidden: all.slice(start + keep).filter((l) => ERROR_LINE.test(l)).length }
}
