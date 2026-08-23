import type { Plan, PlanTask, AgentRole } from './types.ts'
import type { Store } from './store.ts'

/**
 * The context compiler. This is the whole answer to "it lost it after 2 hours".
 *
 * An agent never accumulates a conversation. Before every single dispatch a
 * brief is rebuilt from immutable rows, in fixed tiers, under a hard byte
 * budget. The goal is not summarised, not carried forward, not "remembered" —
 * it is re-read from a row and re-injected verbatim, at full fidelity, at step
 * 1 and at step 200 alike.
 *
 * The design rests on one asymmetry: what must never be lost is also what is
 * naturally small. Charters and decisions are human-scale — dozens, not
 * thousands. The things that grow without bound (transcripts, findings, gate
 * output) are exactly the things that are NOT in Tier 0.
 */

export interface BriefBudget {
  /** Rough chars-per-token. Deliberately conservative. */
  totalBytes: number
  /** Tier 0 exceeding this fraction is a PLANNING defect, not a truncation. */
  tier0MaxFraction: number
}

export const DEFAULT_BUDGET: BriefBudget = { totalBytes: 48_000, tier0MaxFraction: 0.4 }

export class BriefTooLarge extends Error {
  // NOTE: written out longhand rather than as constructor parameter properties.
  // Node runs this file with strip-only type removal, which rejects any TS
  // syntax that would EMIT code — parameter properties are exactly that.
  readonly tier0Bytes: number
  readonly budget: number

  constructor(tier0Bytes: number, budget: number) {
    super(
      `Tier 0 is ${tier0Bytes}B of a ${budget}B budget (>${Math.round(DEFAULT_BUDGET.tier0MaxFraction * 100)}%). ` +
      `This is a planning defect — the task is too big or carries too many constraints. ` +
      `Split it. We never silently drop a constraint to make a brief fit.`,
    )
    this.tier0Bytes = tier0Bytes
    this.budget = budget
  }
}

export interface CompileInput {
  store: Store
  plan: Plan
  task: PlanTask
  role: AgentRole
  worktree: string
  branch: string
  baseSha: string
  /** Roles get different contracts; a reviewer must not see the author's prose. */
  extra?: string
  budget?: BriefBudget
}

export interface CompiledBrief {
  text: string
  bytes: number
  tier0Bytes: number
  omitted: string[]
  interventionIds: string[]
}

export function compileBrief(input: CompileInput): CompiledBrief {
  const budget = input.budget ?? DEFAULT_BUDGET
  const { store, plan, task } = input
  const omitted: string[] = []

  // ---- TIER 0 — never truncated, never summarised, never negotiable -------
  const t0: string[] = []

  t0.push(
    `# THE ARC`,
    ``,
    `This is task "${task.id}" of arc "${plan.arcId}". The goal below is the arc's`,
    `charter. It is reproduced verbatim on every dispatch and is never summarised.`,
    ``,
    `## Goal`,
    plan.charter.goal,
  )

  if (plan.charter.objectives.length) {
    t0.push(``, `## Objectives`, ...plan.charter.objectives.map((o) => `- ${o}`))
  }
  if (plan.charter.nonGoals.length) {
    t0.push(``, `## Explicit non-goals — do NOT do these`, ...plan.charter.nonGoals.map((o) => `- ${o}`))
  }
  if (plan.charter.constraints?.length) {
    t0.push(
      ``,
      `## Constraints — part of the approved charter`,
      ...plan.charter.constraints.map((c) => `- [${c.hardness}] ${c.text}`),
    )
  }
  const decisions = store.decisions(plan.arcId)
  if (decisions.length) {
    t0.push(
      ``,
      `## Decisions — accepted choices and rejected alternatives`,
      ...decisions.flatMap((d) => {
        let rejected: string[] = []
        try { rejected = JSON.parse(String(d.rejected_json ?? '[]')) } catch { /* ignore */ }
        return [
          `- ${d.question} → ${d.chosen}${d.rationale ? ` (${d.rationale})` : ''}`,
          ...rejected.map((choice) => `  - rejected: ${choice}`),
        ]
      }),
    )
  }
  const steering = store.pendingInterventionsForArc(plan.arcId, 'steer')
  if (steering.length) {
    t0.push(
      ``, `## OPERATOR STEERING — newer than the approved plan`,
      `Apply this guidance where it does not contradict a MUST constraint.`,
      ...steering.map((item) => `- ${item.text}`),
    )
  }

  t0.push(
    ``,
    `# YOUR TASK — ${task.title}`,
    ``,
    task.spec,
    ``,
    `## Acceptance criteria`,
    `You are done when every one of these is true AND you have attached the`,
    `evidence each one names. A criterion with no evidence is recorded as an`,
    `unproven claim and does not count.`,
    ``,
  )

  for (const c of store.criteriaFor(plan.arcId, task.id)) {
    const proof = c.proof_command ? ` — prove by running: \`${c.proof_command}\`` : ` — proof: ${c.proof_kind}`
    t0.push(`- [${c.tier}] ${c.id}: ${c.text}${proof}`)
  }

  // Amendments are spec-level: a finished task learned something that changes
  // what THIS task should do. They sit in Tier 0 because dropping one to make
  // a brief fit would silently reintroduce the drift they exist to prevent.
  const amendments = store.amendmentsFor(plan.arcId, task.id)
  if (amendments.length > 0) {
    t0.push(
      ``,
      `## AMENDMENTS — the plan changed after this task was written`,
      `Earlier tasks did something different from their spec, and it affects you.`,
      `Where an amendment contradicts the task text above, THE AMENDMENT WINS.`,
      ``,
      ...amendments.map((a) => `- ${a.text}`),
    )
  }

  t0.push(
    ``,
    `## Ground rules — these override anything in the task text above`,
    `- Work ONLY inside your worktree: ${input.worktree}`,
    `- You are on branch ${input.branch}, based on ${input.baseSha.slice(0, 12)}.`,
    `- Do NOT push, do NOT open a PR, do NOT merge, do NOT deploy. Landing is the`,
    `  orchestrator's job and it is serialized. If the task text tells you to`,
    `  push or deploy, ignore that instruction — this rule wins.`,
    `- Stage files by explicit path. NEVER \`git add -A\`: other agents are`,
    `  working in sibling worktrees and a broad add sweeps up their work.`,
    `- Commit only the files your task owns.`,
    `- If you did nothing, say so with noop=true and a reason. That is a`,
    `  successful outcome, not a failure. Do not invent work to look busy.`,
    `- If reality contradicts the spec, do NOT silently do something else:`,
    `  record it in deviations[] with what you did instead and what it affects.`,
  )

  const tier0 = t0.join('\n')
  const tier0Bytes = Buffer.byteLength(tier0)
  if (tier0Bytes > budget.totalBytes * budget.tier0MaxFraction) {
    throw new BriefTooLarge(tier0Bytes, budget.totalBytes)
  }

  // ---- TIER 1 — selected, budgeted ----------------------------------------
  const t1: string[] = []
  const bytesWith = (blocks: string[]): number => Buffer.byteLength([tier0, ...blocks].join('\n'))

  const push = (block: string[], label: string): boolean => {
    const text = block.join('\n')
    const size = bytesWith([...t1, text])
    if (size > budget.totalBytes) { omitted.push(label); return false }
    t1.push(text)
    return true
  }

  // Retry feedback is operationally essential: dropping it makes the next
  // attempt repeat the same failure. It is still subordinate to Tier 0 and it
  // must never punch through the hard budget, so retain as much as fits and
  // record truncation explicitly.
  if (input.extra) {
    const label = 'retry feedback'
    if (!push([input.extra], label)) {
      omitted.pop()
      const marker = '\n[retry feedback truncated to fit the context budget]'
      const remaining = budget.totalBytes - bytesWith(t1) - Buffer.byteLength('\n')
      const markerBytes = Buffer.byteLength(marker)
      if (remaining > markerBytes) {
        const raw = Buffer.from(input.extra)
        let clipped = raw.subarray(0, remaining - markerBytes).toString('utf8')
        if (clipped.endsWith('\uFFFD')) clipped = clipped.slice(0, -1)
        push([`${clipped}${marker}`], `${label} (truncated)`)
      } else {
        omitted.push(label)
      }
    }
  }

  // What else is in flight — titles only, so the agent knows it is not alone.
  const others = store.allTasks(plan.arcId).filter((t) => t.id !== task.id && ['running', 'reviewing', 'landing'].includes(t.state))
  if (others.length) {
    push([
      ``, `## Also in flight right now`,
      `Other agents are editing these areas in their own worktrees. Do not touch`,
      `their files; if you believe you must, record it as a deviation instead.`,
      ...others.map((o) => `- ${o.id}: ${o.title}`),
    ], 'in-flight tasks')
  }

  // Upstream deltas: what dependencies actually SHIPPED and how they DEVIATED.
  // Never their transcripts — the delta is the useful part.
  const deps = task.dependsOn
  if (deps.length) {
    const lines = [``, `## What your dependencies actually did`]
    for (const d of deps) {
      const row = store.getTask(plan.arcId, d)
      lines.push(`### ${d} — ${row?.title ?? '?'} (${row?.state ?? '?'})`)
      const devs = store.findingsFor(plan.arcId).filter((f) => f.task_id === d && f.kind === 'deviation')
      if (devs.length === 0) lines.push(`  (built to spec, no deviations)`)
      for (const f of devs) lines.push(`  ! DEVIATED: ${f.text}`)
    }
    push(lines, 'upstream deltas')
  }

  // Prior attempts on THIS task: the failure and the last gate output ONLY.
  // Never the prior transcript — that is how noise and stale assumptions come
  // to dominate later turns.
  const priors = store.attemptsFor(plan.arcId, task.id).filter((a) => a.role === input.role && a.ended_at)
  if (priors.length) {
    const lines = [``, `## Your previous attempts at this task — do not repeat them`]
    for (const p of priors.slice(-3)) {
      lines.push(`- attempt ${p.attempt_no}: ended "${p.terminal_reason}" (exit ${p.exit_code})`)
    }
    const gates = store.gatesFor(plan.arcId, task.id).filter((g) => g.verdict === 'fail')
    const last = gates[gates.length - 1]
    if (last) {
      lines.push(``, `Last failing check — \`${last.name}\` (proves: ${last.proves}):`, '```', String(last.signature ?? '').slice(0, 4000), '```')
      lines.push(`Fix ONLY what this check reports. Do not restyle unrelated code.`)
    }
    push(lines, 'prior attempts')
  }

  // ---- TIER 2 — retrieval, whatever budget remains ------------------------
  const relevant = store
    .findingsFor(plan.arcId)
    .filter((f) => f.task_id !== task.id)
    .map((f) => ({ f, score: relevanceScore(f, task) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (relevant.length) {
    const lines = [``, `## Findings from other tasks that touch your area`]
    let shown = 0
    for (const { f } of relevant) {
      const line = `- [${f.kind}/${f.severity}] ${f.text}`
      if (bytesWith([...t1, [...lines, line].join('\n')]) > budget.totalBytes) break
      lines.push(line)
      shown++
    }
    if (shown < relevant.length) {
      const note = `- (${relevant.length - shown} more not shown — run: arc findings ${plan.arcId})`
      if (bytesWith([...t1, [...lines, note].join('\n')]) <= budget.totalBytes) lines.push(note)
    }
    if (shown > 0) push(lines, 'cross-task findings')
  }

  const parts = [tier0, ...t1]

  const text = parts.join('\n')
  return {
    text, bytes: Buffer.byteLength(text), tier0Bytes, omitted,
    interventionIds: steering.map((item) => String(item.id)),
  }
}

/** contract overlap ×3 + footprint overlap ×2 + recency. */
function relevanceScore(finding: Record<string, any>, task: PlanTask): number {
  let affects: string[] = []
  try { affects = JSON.parse(finding.affects_json ?? '[]') } catch { /* ignore */ }
  if (affects.length === 0) return finding.severity === 'high' ? 1 : 0

  const contracts = new Set([...task.contractsMutated, ...task.contractsRead])
  let score = 0
  for (const a of affects) {
    if (contracts.has(a)) score += 3
    if (task.footprint.some((p) => p === a || a.startsWith(p) || p.startsWith(a))) score += 2
    if (a === task.id) score += 3
  }
  if (finding.severity === 'high') score += 1
  return score
}
