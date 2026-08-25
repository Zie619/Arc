import * as G from './git.ts'

/**
 * Assembling the diff a reviewer actually sees.
 *
 * This replaces `git diff ….slice(0, 120_000)`. That expression cut at a byte
 * offset — mid-hunk, mid-line, possibly mid-UTF-8-sequence — and handed the
 * result to the reviewer with no marker and no record. The reviewer did not
 * know it was looking at a quarter of a change, reviewed what it received,
 * returned PASS, and Arc recorded a clean verdict for the WHOLE task. A
 * criterion could reach `checked` over code no reviewer ever saw.
 *
 * Arc already knew how to do this properly one module over: `brief.ts` budgets
 * in tiers, marks every omission explicitly, and clips UTF-8 safely. The review
 * lane simply never used it.
 *
 * Three rules here:
 *   1. Nothing is dropped silently. Everything excluded is NAMED.
 *   2. Whole files, never partial hunks — a half-hunk is worse than an absence,
 *      because it looks complete.
 *   3. Budget goes to the surprising files first, and the caller decides what
 *      surprising means: predicted risks, mutated contracts, and above all the
 *      files the plan did NOT predict.
 */

export interface DiffFile {
  path: string
  added: number
  deleted: number
  binary: boolean
}

export interface AssembledDiff {
  text: string
  /** False when any file was summarised or excluded. A verdict derived from an
   *  incomplete diff must never carry full confidence. */
  complete: boolean
  shown: string[]
  summarised: string[]
  excluded: string[]
}

/**
 * Provably uninteresting to a reviewer and capable of consuming an entire
 * budget on its own. A regenerated lockfile is tens of thousands of lines that
 * say nothing about correctness.
 */
const NOISE = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$/,
  /(^|\/)(dist|build|out|coverage|vendor|node_modules)\//,
  /(^|\/)__snapshots__\//,
  /\.min\.(js|css)$/,
  /\.map$/,
]

function isNoise(path: string): boolean {
  return NOISE.some((rx) => rx.test(path))
}

/** `--numstat` with rename detection ON: a rename rendered as delete-plus-add
 *  can eat the whole budget for zero semantic change. */
export function changedFiles(repo: string, range: string): DiffFile[] {
  const raw = G.git(repo, 'diff', '-M', '-C', '--numstat', range)
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((line) => {
    const [added, deleted, ...rest] = line.split('\t')
    const path = rest.join('\t')
    return {
      path,
      added: Number(added) || 0,
      deleted: Number(deleted) || 0,
      // numstat writes '-' for both counts on a binary file.
      binary: added === '-' && deleted === '-',
    }
  })
}

export interface AssembleOptions {
  budget: number
  /** Files to spend the budget on first, most surprising first. */
  priority?: string[]
  /** `git diff -W`: whole enclosing function rather than three context lines.
   *  A changed line without its guard clauses is frequently unjudgeable. */
  functionContext?: boolean
}

export function assembleDiff(repo: string, range: string, opts: AssembleOptions): AssembledDiff {
  const files = changedFiles(repo, range)
  if (files.length === 0) return { text: '', complete: true, shown: [], summarised: [], excluded: [] }

  const excluded = files.filter((f) => isNoise(f.path))
  const candidates = files.filter((f) => !isNoise(f.path))
  const rank = new Map((opts.priority ?? []).map((p, i) => [p, i]))
  const ordered = [...candidates].sort((a, b) => {
    const ra = rank.get(a.path) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b.path) ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    // Then biggest change first: a 400-line rewrite deserves the budget more
    // than a one-line import.
    return (b.added + b.deleted) - (a.added + a.deleted)
  })

  const shown: string[] = []
  const summarised: string[] = []
  const chunks: string[] = []
  let used = 0
  for (const file of ordered) {
    if (file.binary) { summarised.push(file.path); continue }
    const args = ['diff', '-M', '-C', ...(opts.functionContext ? ['-W'] : []), range, '--', file.path]
    const patch = G.git(repo, ...args)
    // Whole file or nothing. Half a hunk reads as a complete one.
    if (used + patch.length > opts.budget && shown.length > 0) { summarised.push(file.path); continue }
    chunks.push(patch)
    shown.push(file.path)
    used += patch.length
  }

  const complete = summarised.length === 0 && excluded.length === 0
  const header: string[] = []
  if (!complete) {
    header.push(
      `> INCOMPLETE DIFF — ${shown.length} of ${candidates.length} changed file(s) shown in full.`,
      `> You are NOT looking at the whole change. Do not report on what is not here,`,
      `> and do not treat silence about a file below as approval of it.`,
    )
    const named = (label: string, list: DiffFile[]) => {
      if (list.length === 0) return
      header.push(`> ${label}:`)
      for (const f of list) header.push(`>   ${f.path}  (+${f.added} -${f.deleted})`)
    }
    named('NOT SHOWN (over budget)', ordered.filter((f) => summarised.includes(f.path)))
    named('EXCLUDED as generated or vendored', excluded)
    header.push('')
  }

  return {
    text: [...header, ...chunks].join('\n'),
    complete,
    shown,
    summarised,
    excluded: excluded.map((f) => f.path),
  }
}
