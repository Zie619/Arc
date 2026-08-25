import { z } from 'zod'

/**
 * Every artifact that crosses a process boundary is defined here, once.
 * The same Zod object produces the runtime validator AND the JSON Schema we
 * hand to `codex exec --output-schema` / `claude --json-schema`, so an agent
 * cannot be asked for a shape we cannot then parse.
 */

// ---------------------------------------------------------------------------
// Evidence grading. The harness assigns the tier from artifacts it can SEE.
// An agent claiming `observed` with nothing attached is recorded as `claimed`.
// ---------------------------------------------------------------------------
export const ClaimTier = z.enum(['unproven', 'claimed', 'checked', 'observed', 'waived'])
export type ClaimTier = z.infer<typeof ClaimTier>

/** Ordered weakest→strongest so a tier can be compared, not just matched. */
export const TIER_RANK: Record<ClaimTier, number> = {
  unproven: 0,
  claimed: 1,
  checked: 2,
  observed: 3,
  waived: 3,
}

// ---------------------------------------------------------------------------
// Terminal reasons. Vocabulary lifted from outsourcerer's watchdog, because a
// UI that can say WHY a task died beats one that can only say "wedged".
// ---------------------------------------------------------------------------
export const TerminalReason = z.enum([
  'ok',
  'no-init',            // child never produced a first model turn
  'silent-delegate',    // exited without ever emitting the signed terminal marker
  'stall-kill',         // no events for longer than the stall window
  'empty-output',       // clean exit, but nothing that counts as model output
  'output-token-limit', // truncated answer — NOT a completed one
  'permission-blocked', // walled off by a prompt a headless agent cannot answer
  'hard-timeout',
  'bad-envelope',       // returned JSON that failed schema validation
  'provider-error',     // the API rejected the request (bad schema, auth, quota)
  'cancelled',          // you pressed escape — a decision, not a failure
  'model-drift',        // ran on a model we did not request
  'spawn-failed',
])
export type TerminalReason = z.infer<typeof TerminalReason>

export const AgentRole = z.enum(['head', 'triage', 'scout', 'implement', 'review', 'integrate'])
export type AgentRole = z.infer<typeof AgentRole>

// ---------------------------------------------------------------------------
// project.yaml — everything project-specific lives here, never in code.
// One project at a time by decision, but the seam exists from day one because
// retrofitting it later is the expensive direction.
// ---------------------------------------------------------------------------
export const GateDef = z.object({
  name: z.string(),
  /** Run through a shell, from `cwd`. Invoke the project's OWN canonical script. */
  command: z.string(),
  /**
   * What this check actually proves. Required, because `next build` typechecks
   * nothing and two gates proving the same property are one gate.
   */
  proves: z.string(),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().default(20 * 60_000),
  /** Cheap gates run on every attempt; expensive ones hold the heavy semaphore. */
  heavy: z.boolean().default(false),
  /**
   * Measure this gate on the base SHA in the same run and require the task's
   * result to be a SUBSET of baseline failures, not equality — flaky suites
   * drift and equality turns that drift into a false red.
   */
  baselineSubset: z.boolean().default(false),
  /**
   * Env vars this gate genuinely needs beyond the runtime basics. Gates never
   * inherit the operator's full shell — a reviewer-authored finding check
   * would otherwise run with every exported credential.
   */
  envAllowlist: z.array(z.string()).optional(),
  /**
   * Run under a deny-write sandbox (macOS sandbox-exec). Set for
   * reviewer-authored finding checks: model-authored shell must not be able
   * to edit the checkout it is grading — post-hoc mutation detection is a
   * report, not a guard (a real reviewer authored `npm version patch` as a
   * "check" in the first dogfood run). On other platforms the minimal env
   * plus post-hoc detection remain the only line.
   */
  readOnly: z.boolean().optional(),
})
export type GateDef = z.infer<typeof GateDef>

export const RoleBinding = z.object({
  cli: z.enum(['codex', 'claude']),
  /**
   * Prefer an ALIAS (`opus`, `sonnet`) over a pinned id: an alias means a new
   * model ships and is live with zero action. A pinned id freezes you.
   */
  model: z.string(),
  /** Provider-native reasoning effort. Capability discovery decides which
   *  values the installed CLI actually supports for a selected model. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  sandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
  /** claude only: restrict the toolset. A scout that CAN write will start fixing. */
  tools: z.string().optional(),
  /** Named project variables that this role may receive. Provider auth and
   *  basic runtime variables are handled separately; the parent's complete
   *  credential-bearing environment is never inherited. */
  envAllowlist: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  /** No events for this long ⇒ stall-kill. Reasoning models need patience. */
  stallMs: z.number().int().positive().default(300_000),
})
export type RoleBinding = z.infer<typeof RoleBinding>

/** Exact counters reported by a CLI result event. Missing means unreported. */
export const ProviderUsage = z.object({
  provider: z.enum(['claude', 'codex']),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  // The TTL split, because they are priced differently: a 1-hour cache write is
  // 2.0x base input and a 5-minute one is 1.25x. Claude Code defaults to 1 hour
  // and cache writes are usually the DOMINANT term, so collapsing the two is a
  // 1.6x error on the biggest number in the bill.
  cacheWrite5mTokens: z.number().int().nonnegative().optional(),
  cacheWrite1hTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /**
   * Whether `cachedInputTokens` is INSIDE `inputTokens` or beside it. The two
   * providers disagree, so one column cannot mean one thing:
   *   - 'subset'   (OpenAI/codex): input_tokens already contains the cached ones
   *   - 'additive' (Anthropic):    input, cache-read and cache-write are three
   *                                separate, separately-priced buckets
   * Without this discriminator any single formula over attempt_usage is wrong
   * for one of the two providers.
   */
  usageSemantics: z.enum(['additive', 'subset']),
  raw: z.record(z.string(), z.unknown()),
})
export type ProviderUsage = z.infer<typeof ProviderUsage>

export const ProjectConfig = z.object({
  name: z.string(),
  /** Absolute path to the git repo the arc operates on. */
  repo: z.string(),
  /** Branch arcs integrate into. */
  mainBranch: z.string().default('main'),
  /**
   * How work lands. `push` is direct; `pr` opens a PR and waits for checks.
   * Probed at arc start rather than assumed — five session-master scripts died
   * the day `main` became protected.
   */
  /** `none` stops at the integration branch and tells you where it is —
   *  the right default for a repo with no remote, and the safe choice for a
   *  first run anywhere. */
  landStrategy: z.enum(['push', 'pr', 'none']).default('pr'),
  /**
   * What to do when a `readOnly` command has no OS sandbox to run under.
   * Reviewer-authored `checkCommand`s are model-authored shell that Arc
   * executes by design, and only macOS Seatbelt enforces the deny-write
   * profile — on Linux, and inside another sandbox where Seatbelt refuses to
   * nest, there is nothing underneath.
   *
   *   'caveat' — run it and record that it ran unprotected (default: an
   *              unverified finding is worse than an unsandboxed check)
   *   'refuse' — do not run it; the finding stays unverified and says why
   */
  sandboxPolicy: z.enum(['caveat', 'refuse']).default('caveat'),
  /**
   * The pre-diff risk phase: the reviewer predicts what will go wrong from the
   * spec and the base tree, BEFORE it is shown the diff. Precommitment is the
   * standard defence against a reviewer rationalising whatever was written.
   *
   * It is also a full extra dispatch per review, and — being honest — its
   * benefit has never been measured. This switch exists so it can be: run the
   * arm, compare findings that survive execution per dollar. Default on,
   * because the reasoning is sound; a switch, because sound reasoning is
   * exactly what Arc refuses to accept from a model and should not accept from
   * its author either.
   */
  reviewRiskPhase: z.boolean().default(true),
  /** Execute every proofCommand at the base commit before dispatching, and
   *  refuse a plan whose proofs cannot tell done from not-done. Costs one
   *  worktree and a few seconds; catches the failure static analysis cannot. */
  dryRunProofs: z.boolean().default(true),
  /**
   * What a CHANGES_REQUIRED repair round may spend. Explicit, because it used
   * to acquire a full second copy of maxAttempts and maxTaskMinutes purely by
   * re-entering the same function — so a config reading "4 attempts, 90
   * minutes" could mean eight and a hundred and eighty.
   */
  maxRepairAttempts: z.number().int().positive().default(1),
  maxRepairMinutes: z.number().int().positive().default(30),
  /**
   * The surface a task may not quietly move, because it is what PROVES the
   * task. A writer that deletes an inconvenient test makes every gate strictly
   * greener, and the baseline comparison is structurally blind to it — a
   * removed test produces no failure line.
   *
   * Touching one of these without declaring `touchesGateSurface` on the task is
   * a blocking finding, not a note. `package.json` is deliberately absent:
   * every dependency change touches it, so its `scripts` block is checked by
   * content instead (see gateScriptsChanged).
   */
  protectedGatePaths: z.array(z.string()).default([
    '**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '__tests__/**',
    'vitest.config.*', 'jest.config.*', 'pytest.ini', 'conftest.py',
    '.github/workflows/**', 'arc.yaml',
  ]),
  gates: z.array(GateDef).default([]),
  /**
   * Run once in every freshly provisioned worktree before agents or checks
   * use it (dependency install, codegen). A bare worktree has no
   * node_modules: without this, every proof command fails environmentally —
   * which is exactly how the first self-arc died.
   */
  setupCommand: z.string().optional(),
  /** Operator-owned commands that close capability gaps in writer sandboxes
   *  before project gates inspect generated artifacts. */
  refreshCommands: z.array(z.object({
    name: z.string(),
    command: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  })).optional(),
  /** Explicit rather than a record over the role enum: only `implement` is
   *  required, and naming each key gives a usable error when one is missing. */
  roles: z.object({
    /** Strong conversational/planning head. It owns judgment, never durable memory. */
    head: RoleBinding.optional(),
    /** Fast and cheap. Decides in a second or two whether you typed a job or
     *  just said hello — a full pipeline on "hey" is a minute of nothing. */
    triage: RoleBinding.optional(),
    scout: RoleBinding.optional(),
    implement: RoleBinding,
    review: RoleBinding.optional(),
    integrate: RoleBinding.optional(),
  }),
  /** Token/rate budget. Independent of heavyGateLimit — different resources. */
  agentConcurrency: z.number().int().positive().default(3),
  /** CPU/RAM. Five concurrent `next build`s wedge the machine. */
  heavyGateLimit: z.number().int().positive().default(1),
  /** Inner loop bound: attempts, and wall clock checked BETWEEN attempts. */
  maxAttempts: z.number().int().positive().default(4),
  maxTaskMinutes: z.number().int().positive().default(90),
  /** Provider capacity is weather, bounded separately from task work. */
  capacityWaitMinutes: z.number().nonnegative().default(240),
})
export type ProjectConfig = z.infer<typeof ProjectConfig>

/**
 * The very first thing that happens to anything you type.
 *
 * Most of what people type at a prompt is not a work order. "hey", "what can
 * you do", "is the build green" — those deserve an answer in two seconds, not
 * an interview, three scouts and a plan.
 */
export const Triage = z.object({
  kind: z.enum(['work', 'chat', 'too-vague']),
  /** Product lane, independent of ask/auto/danger approval mode. */
  lane: z.enum(['chat', 'direct', 'research', 'plan', 'review', 'deep']).default('deep'),
  /**
   * What to say back. For `chat` this is the whole answer. For `too-vague` it
   * names what is missing, so the next thing typed is usable.
   */
  reply: z.string(),
  /** One line, for the status screen, when this is real work. */
  restated: z.string().default(''),
})
export type Triage = z.infer<typeof Triage>

// ---------------------------------------------------------------------------
// PHASE 0 — the interview.
//
// The raw brief is stored byte-for-byte and never rewritten. The interviewer
// reads it with NO tools and NO repo access, so it cannot wander off into the
// code before the goal is pinned down.
// ---------------------------------------------------------------------------
export const InterviewExtract = z.object({
  /** What the interviewer believes the goal is, in the user's own vocabulary. */
  proposedGoal: z.string(),
  objectives: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  /**
   * Every question the brief ASKS, plus every ambiguity that would change the
   * work. The interview terminates on this list being answered — not on the
   * model feeling finished.
   */
  questions: z.array(z.object({
    id: z.string(),
    text: z.string(),
    why: z.string().describe('what changes depending on the answer'),
    options: z.array(z.string()).default([]),
    recommendation: z.string().describe('what you would choose, and why, in one line'),
    /** A question whose answer does not change the work is not worth asking. */
    blocking: z.boolean().default(true),
  })).default([]),
  /**
   * Load-bearing factual claims the brief assumes. Each gets checked against
   * live code in phase 1; a refuted premise re-opens the interview rather than
   * letting the plan proceed on a false footing.
   */
  premises: z.array(z.object({
    id: z.string(),
    statement: z.string(),
    howToVerify: z.string(),
  })).default([]),
})
export type InterviewExtract = z.infer<typeof InterviewExtract>

export const SettledCharter = z.object({
  goal: z.string().describe('the arc goal, <= 200 words, in the user own words where possible'),
  objectives: z.array(z.string()).min(1),
  nonGoals: z.array(z.string()).default([]),
  constraints: z.array(z.object({
    text: z.string(),
    hardness: z.enum(['MUST', 'SHOULD']).default('MUST'),
  })).default([]),
})
export type SettledCharter = z.infer<typeof SettledCharter>

// ---------------------------------------------------------------------------
// PHASE 1 — scouts. Read-only by CAPABILITY, not by instruction.
// ---------------------------------------------------------------------------
export const ScoutPlan = z.object({
  scouts: z.array(z.object({
    id: z.string(),
    area: z.string().describe('the subsystem or question this scout owns'),
    brief: z.string().describe('what to find out, concretely'),
    /** codex and claude read differently; a mixed panel finds more. */
    engine: z.enum(['codex', 'claude']).default('codex'),
  })).min(1).max(8),
})
export type ScoutPlan = z.infer<typeof ScoutPlan>

export const ScoutReport = z.object({
  area: z.string(),
  /** file:line evidence or it did not happen. */
  findings: z.array(z.object({
    file: z.string(),
    line: z.number().int().nonnegative().default(0),
    what: z.string(),
    why: z.string().describe('why this matters to the goal'),
  })).default([]),
  /** THIS is what the scheduler consumes — one cheap phase grounds the plan
   *  AND produces the parallelism structure. */
  filesToTouch: z.array(z.string()).default([]),
  contractsMutated: z.array(z.string()).default([]),
  contractsRead: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  premiseVerdicts: z.array(z.object({
    id: z.string(),
    /** 'corrected': the substance holds but a detail is off — the plan
     *  proceeds on the corrected fact instead of stopping the operator. */
    verdict: z.enum(['confirmed', 'corrected', 'refuted', 'unclear']),
    evidence: z.string().describe('file:line, or the command you ran'),
    correctedStatement: z.string().nullish().describe('the true fact, when verdict is corrected'),
  })).default([]),
  /** Work the scout believes is needed. Input to the planner, not a plan. */
  proposedWork: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
  })).default([]),
})
export type ScoutReport = z.infer<typeof ScoutReport>

/**
 * The research lane's fan-in. A list of raw scout findings is not an answer;
 * the head correlates them — and `missingFromPrompt` is REQUIRED so context
 * starvation surfaces as data instead of as confident prose.
 */
export const ResearchSynthesis = z.object({
  answer: z.string(),
  keyFindings: z.array(z.object({
    file: z.string(),
    line: z.number().int().nullish(),
    what: z.string(),
    why: z.string(),
  })).default([]),
  /** Disagreements between scouts, named instead of smoothed over. */
  contradictions: z.array(z.string()).default([]),
  missingFromPrompt: z.string(),
})
export type ResearchSynthesis = z.infer<typeof ResearchSynthesis>

// ---------------------------------------------------------------------------
// The plan. Hand-written YAML in M1 — by decision. The generator is the
// exciting part and the replaceable part; until execution is trustworthy a
// generated plan only produces failure faster.
// ---------------------------------------------------------------------------
export const AcceptanceCriterion = z.object({
  id: z.string(),
  text: z.string(),
  /** Each criterion names its OWN proof. A criterion with no proof is a wish. */
  proofKind: z.enum(['command', 'artifact', 'agent-review', 'human-observation']),
  /**
   * nullish, not optional: providers' structured output emits an explicit
   * `null` for command-less criteria, and rejecting it failed every real
   * plan with bad-envelope. (Found in the first dogfood run.)
   */
  proofCommand: z.string().nullish(),
  /**
   * What the proof should do BEFORE the work exists.
   *
   *   'discriminating' — the work makes it true, so it MUST FAIL at the base
   *                      commit. This is the default and the interesting case.
   *   'invariant'      — the work must not break it, so it MUST PASS at base.
   *
   * This exists because a proof can be VACUOUS: portable, runs fine, and proves
   * nothing because it already passed before anything was written.
   * `test -f src/cost.ts` on a file that already exists. `npm test` as the proof
   * of one specific criterion. Static analysis cannot catch that; execution
   * against the base commit catches it totally.
   *
   * And vacuity is more dangerous than fragility: a fragile proof fails loudly,
   * while a vacuous one grants `checked` and puts a green tick beside a
   * criterion nothing established — laundering a wish into evidence inside the
   * one subsystem whose entire value is that it does not do that.
   *
   * Declaring polarity turns the dry-run from a heuristic into a TOTAL
   * function: every criterion carries a mandatory, checkable assertion about
   * its behaviour at base. There is no "can't tell" bucket.
   */
  polarity: z.enum(['discriminating', 'invariant']).default('discriminating'),
  /** The tier this criterion must reach before its task may be called done. */
  requiredTier: ClaimTier.default('checked'),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>

export const PlanTask = z.object({
  id: z.string(),
  title: z.string(),
  /** Frozen at dispatch. Editing the plan mid-arc must not retroactively
   *  change what an already-queued agent will be told. */
  spec: z.string(),
  dependsOn: z.array(z.string()).default([]),
  /**
   * Declared, then MEASURED against the real diff. Drift between the two is an
   * incident worth surfacing, and it is the data that earns the contract graph
   * in M3 rather than guessing at it now.
   */
  footprint: z.array(z.string()).default([]),
  /**
   * The scheduling unit that actually matters: an exported signature, an enum,
   * a registry map, a flag ladder, a shared schema. Two tasks may share a file
   * safely; two tasks may NOT mutate one contract concurrently.
   */
  contractsMutated: z.array(z.string()).default([]),
  contractsRead: z.array(z.string()).default([]),
  /** Gate names from project.yaml. Empty ⇒ all non-heavy gates. */
  gates: z.array(z.string()).default([]),
  /**
   * Which charter objectives this task advances. Arc had ZERO traceability
   * between the thing the operator approved and the work that got planned: an
   * objective could be dropped silently, and a task could exist for no stated
   * reason at all. Optional for now so existing plans still parse; validated
   * when present.
   */
  covers: z.array(z.string()).default([]),
  /**
   * Why this task is allowed to change the thing that PROVES it — a test file,
   * a CI config, a runner script. Absent, touching `protectedGatePaths` is a
   * blocking finding. Present, it is allowed and the reason is recorded, so the
   * exception appears in the report instead of being invisible.
   *
   * The override exists because without one, operators turn the check off.
   */
  touchesGateSurface: z.string().optional(),
  acceptance: z.array(AcceptanceCriterion).min(1),
})
export type PlanTask = z.infer<typeof PlanTask>

export const Plan = z.object({
  arcId: z.string(),
  /**
   * Stored byte-for-byte and injected verbatim into EVERY dispatch. Never
   * summarised, never compacted. This is the whole point: at step 200 the goal
   * is re-read from an immutable row, not recalled from a compressed window.
   */
  charter: z.object({
    goal: z.string(),
    objectives: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    /** Constraints are part of the immutable agreement, not planner-only
     *  advice. Dropping them here meant every implementer and integration
     *  reviewer worked from a weaker charter than the user approved. */
    constraints: z.array(z.object({
      text: z.string(),
      hardness: z.enum(['MUST', 'SHOULD']).default('MUST'),
    })).default([]),
  }),
  tasks: z.array(PlanTask).min(1),
})
export type Plan = z.infer<typeof Plan>

// ---------------------------------------------------------------------------
// The implementer's envelope. Nothing is free prose at the top level: prose
// lives inside a typed field carrying `affects`, which is what lets the
// harness ROUTE it to the tasks it invalidates.
// ---------------------------------------------------------------------------
export const TaskResult = z.object({
  status: z.enum(['done', 'blocked', 'needs-review']),
  shipped: z.array(z.object({ path: z.string(), whatChanged: z.string() })).default([]),
  /** What it did DIFFERENTLY from the spec. The anti-decay mechanism: this
   *  delta is written back into specs not yet dispatched. */
  deviations: z.array(z.object({
    from: z.string(),
    to: z.string(),
    affects: z.array(z.string()).default([]),
    severity: z.enum(['low', 'medium', 'high']).default('low'),
  })).default([]),
  discoveries: z.array(z.object({
    text: z.string(),
    affects: z.array(z.string()).default([]),
    severity: z.enum(['low', 'medium', 'high']).default('low'),
  })).default([]),
  criteria: z.array(z.object({
    id: z.string(),
    claimedTier: ClaimTier,
    evidence: z.string().describe('command output, artifact path, or file:line'),
  })).default([]),
  /** Side effects the arc cannot close over: migrations, seeds, flag flips. */
  pendingOps: z.array(z.object({
    kind: z.string(),
    description: z.string(),
    blocking: z.boolean().default(true),
  })).default([]),
  /** "I did nothing, because X" must be a first-class SUCCESSFUL answer, or
   *  agents invent work to avoid looking idle. */
  noop: z.boolean().default(false),
  noopReason: z.string().nullish(),
})
export type TaskResult = z.infer<typeof TaskResult>

// ---------------------------------------------------------------------------
// The reviewer's envelope.
// ---------------------------------------------------------------------------
export const ReviewFinding = z.object({
  severity: z.enum(['critical', 'major', 'minor', 'note']),
  file: z.string(),
  line: z.number().int().nonnegative().default(0),
  claim: z.string(),
  failureScenario: z.string().describe('concrete inputs/state → wrong output'),
  suggestedFix: z.string().nullish(),
  /** If this can be turned into a command, we RUN it. A finding that survives
   *  execution is a fact; one that fails to reproduce is dropped, with the
   *  reproduction attempt recorded. */
  checkCommand: z.string().nullish(),
})
export type ReviewFinding = z.infer<typeof ReviewFinding>

export const ReviewVerdict = z.object({
  verdict: z.enum(['PASS', 'PASS_WITH_NOTES', 'CHANGES_REQUIRED', 'REJECT']),
  findings: z.array(ReviewFinding).default([]),
  criteriaAssessment: z.array(z.object({
    id: z.string(),
    met: z.boolean(),
    evidence: z.string(),
  })).default([]),
  seamRisks: z.array(z.string()).default([]),
})
export type ReviewVerdict = z.infer<typeof ReviewVerdict>

/**
 * Written BEFORE the reviewer is shown the implementation, from the spec and
 * base tree alone. Review then checks against a prediction instead of
 * rationalising whatever was already written. (Sol's idea, and the sharpest
 * one in the analysis.)
 */
export const RiskChecklist = z.object({
  risks: z.array(z.object({
    id: z.string(),
    text: z.string(),
    howToCheck: z.string(),
    /** Where the risk would live. Phase 1 explored the base tree to write this
     *  checklist and then threw the exploration away; naming the files keeps
     *  the cheapest part of it, and lets phase 2 spend its diff budget on the
     *  files a reviewer already predicted were dangerous. */
    files: z.array(z.string()).default([]),
  })).min(1),
})
export type RiskChecklist = z.infer<typeof RiskChecklist>

/**
 * JSON Schema for a CLI's structured-output flag. One source of truth.
 *
 * OpenAI's structured output runs in STRICT mode: every key in `properties`
 * must also appear in `required`, or the request 400s with
 * `invalid_json_schema`. Zod's `.optional()` produces exactly the shape it
 * rejects. So we strictify: every property becomes required, and the ones that
 * were optional become nullable instead — which preserves the intent ("this
 * may be absent") in a form the API accepts.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
  // Claude Code's validator cannot resolve the draft-2020-12 meta-schema ref
  // and rejects the whole document with "no schema with key or ref". Neither
  // CLI needs the declaration, so drop it.
  delete raw.$schema
  return strictify(raw)
}

function strictify(node: unknown): any {
  if (Array.isArray(node)) return node.map(strictify)
  if (node === null || typeof node !== 'object') return node

  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = strictify(v)

  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const keys = Object.keys(out.properties)
    const wasRequired = new Set<string>(Array.isArray(out.required) ? out.required : [])
    for (const k of keys) {
      if (wasRequired.has(k)) continue
      out.properties[k] = nullable(out.properties[k])
    }
    out.required = keys
    out.additionalProperties = false
  }
  return out
}

/** Widen a schema node to also accept null, however it expresses its type. */
function nullable(node: any): any {
  if (node === null || typeof node !== 'object') return node
  if (isNullable(node)) return node   // already accepts null — do not re-wrap
  if (Array.isArray(node.type)) return { ...node, type: [...node.type, 'null'] }
  if (typeof node.type === 'string') return { ...node, type: [node.type, 'null'] }
  if (node.anyOf || node.oneOf || node.$ref || node.enum) return { anyOf: [node, { type: 'null' }] }
  return node
}

function isNullable(node: any): boolean {
  if (node?.type === 'null') return true
  if (Array.isArray(node?.type)) return node.type.includes('null')
  const branches = node?.anyOf ?? node?.oneOf
  return Array.isArray(branches) && branches.some(isNullable)
}
