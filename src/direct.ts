import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { dispatch, checkModel, modelCheckMode, sameModel, type DispatchOptions, type DispatchResult } from './harness.ts'
import { git, headSha } from './git.ts'
import { describe, isSubsetOfBaseline, runGate, selectGates, type GateResult } from './gates.ts'
import { signaturesMatch } from './classify.ts'
import {
  RiskChecklist,
  ReviewVerdict,
  TaskResult,
  type ProjectConfig,
  type RoleBinding,
} from './types.ts'

export type DirectStatus =
  | 'completed'
  | 'refused'
  | 'cancelled'
  | 'implementation-failed'
  | 'gate-failed'
  | 'review-failed'
  | 'changes-required'
  | 'safety-conflict'
  | 'crashed'

export interface DirectPathState {
  path: string
  status: string
  originalPath?: string
  worktreeHash: string | null
  indexEntry: string | null
}

export interface DirectCheckoutSnapshot {
  head: string
  branch: string
  status: string
  dirtyPaths: string[]
  pathStates: DirectPathState[]
  /** Binary-capable patch for tracked content, relative to this snapshot's HEAD. */
  trackedPatch: string
  stagedPatch: string
  untracked: Array<{ path: string; hash: string | null; bytes: number | null }>
  patchComplete: boolean
}

export interface DirectCheckpoint {
  version: 1
  before: DirectCheckoutSnapshot
  after: DirectCheckoutSnapshot
  touchedPaths: string[]
  protectedPaths: string[]
  protectedConflicts: string[]
  headMoved: boolean
  committedPatch: string
  limitations: string[]
}

export interface DirectTranscript {
  phase: 'risk' | 'implement' | 'review'
  requestedModel: string
  observedModels: string[]
  modelStatus: 'ok' | 'drift' | 'unverified'
  terminalReason: string
  transcript: string
}

export interface DirectFindingCheck {
  file: string
  line: number
  claim: string
  command: string
  /** False when the operator declined to run reviewer-authored commands. */
  ran: boolean
  reproduced: boolean
  result: GateResult | null
}

export interface DirectRunResult {
  ok: boolean
  status: DirectStatus
  reason: string
  checkpoint: DirectCheckpoint
  /** Ready to persist as an artifact; Arc does not write it into the project. */
  checkpointArtifact: string
  implementation?: typeof TaskResult._output
  riskChecklist?: typeof RiskChecklist._output
  review?: typeof ReviewVerdict._output
  gates: Array<{ ok: boolean; result: GateResult }>
  findingChecks: DirectFindingCheck[]
  transcripts: DirectTranscript[]
}

/**
 * Reports each lane dispatch into the caller's durable attempt ledger, so
 * lane agents share the deep lane's lifecycle: visible in liveAttempts, usage
 * recorded, transcripts attempt-linked — without the lane touching SQLite.
 */
export interface LaneAttemptObserver {
  start(input: { phase: string; role: string; cli: string; model: string }): string
  finish(attemptId: string, outcome: {
    terminalReason: string
    exitCode: number | null
    observedModel: string | null
    transcript: string
    usage: DispatchResult['usage']
  }): void
}

export interface DirectRunOptions {
  config: ProjectConfig
  brief: string
  /** If known, refuse before dispatch when a requested path is already dirty. */
  targetPaths?: string[]
  /** Undefined runs every declared project gate. An explicit list selects it. */
  gateNames?: string[]
  signal?: AbortSignal
  onEvent?: DispatchOptions['onEvent']
  log?: (line: string) => void
  /**
   * Fired the moment the pre-agent snapshot exists, before any dispatch. The
   * caller persists it: a crash later in the lane must never cost the one
   * artifact that records what the checkout looked like before agents ran.
   */
  onCheckpoint?: (artifact: string) => void
  /**
   * Asked once, with the exact command list, before reviewer-authored finding
   * commands run in the operator's checkout. Absent means run them.
   */
  confirmFindingChecks?: (commands: string[]) => Promise<boolean>
  observer?: LaneAttemptObserver
  /**
   * How many implementation attempts a red gate may trigger (default 1 —
   * single shot). Retries feed the failed gate output back to the writer;
   * a repeated failure signature or a safety conflict always stops early.
   */
  repairAttempts?: number
}

export interface DirectDependencies {
  dispatch: (options: DispatchOptions) => Promise<DispatchResult>
  runGate: (
    gate: Parameters<typeof runGate>[0], cwd: string, baseSha: string, signal?: AbortSignal,
  ) => GateResult | Promise<GateResult>
}

const DEFAULT_DEPENDENCIES: DirectDependencies = { dispatch, runGate }
const MAX_PATCH_CHARS = 2 * 1024 * 1024

interface ParsedStatus {
  status: string
  path: string
  originalPath?: string
}

function parseStatus(output: string): ParsedStatus[] {
  if (!output) return []
  const records = output.split('\0')
  const rows: ParsedStatus[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record || record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    let originalPath: string | undefined
    if (/[RC]/.test(status)) {
      const original = records[i + 1]
      if (original) { originalPath = original; i++ }
    }
    rows.push({ status, path, ...(originalPath ? { originalPath } : {}) })
  }
  return rows
}

function rawGit(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function indexEntries(repo: string): Map<string, string> {
  const entries = new Map<string, string[]>()
  const output = git(repo, 'ls-files', '--stage', '-z')
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const path = record.slice(tab + 1)
    const metadata = record.slice(0, tab)
    const current = entries.get(path) ?? []
    current.push(metadata)
    entries.set(path, current)
  }
  return new Map([...entries].map(([path, rows]) => [path, rows.sort().join('|')]))
}

function hashPath(repo: string, path: string): { hash: string | null; bytes: number | null } {
  const absolute = resolve(repo, path)
  // A status path must remain inside the checkout. Git normally guarantees
  // this, but keep the artifact reader closed against malformed fixture data.
  if (relative(repo, absolute).startsWith('..') || !existsSync(absolute)) {
    return { hash: null, bytes: null }
  }
  try {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      const bytes = Buffer.from(readlinkSync(absolute))
      return { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    }
    if (!stat.isFile()) return { hash: null, bytes: null }
    const bytes = readFileSync(absolute)
    return { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  } catch {
    return { hash: null, bytes: null }
  }
}

function boundedPatch(patch: string): { text: string; complete: boolean } {
  if (patch.length <= MAX_PATCH_CHARS) return { text: patch, complete: true }
  return {
    text: `${patch.slice(0, MAX_PATCH_CHARS)}\n[arc: checkpoint patch truncated]`,
    complete: false,
  }
}

export function captureDirectSnapshot(repo: string): DirectCheckoutSnapshot {
  // Do not use git() here: it trims output, and the leading space in porcelain
  // status (` M file`) is semantic.
  const status = rawGit(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  const rows = parseStatus(status)
  const index = indexEntries(repo)
  const dirtyPaths = new Set<string>()
  const pathStates: DirectPathState[] = []

  for (const row of rows) {
    dirtyPaths.add(row.path)
    if (row.originalPath) dirtyPaths.add(row.originalPath)
    const worktree = hashPath(repo, row.path)
    pathStates.push({
      path: row.path,
      status: row.status,
      ...(row.originalPath ? { originalPath: row.originalPath } : {}),
      worktreeHash: worktree.hash,
      indexEntry: index.get(row.path) ?? null,
    })
  }

  const tracked = boundedPatch(git(repo, 'diff', '--binary', '--full-index', 'HEAD', '--'))
  const staged = boundedPatch(git(repo, 'diff', '--cached', '--binary', '--full-index', 'HEAD', '--'))
  const untracked = rows
    .filter(row => row.status === '??')
    .map(row => ({ path: row.path, ...hashPath(repo, row.path) }))

  return {
    head: headSha(repo),
    branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status,
    dirtyPaths: [...dirtyPaths].sort(),
    pathStates: pathStates.sort((a, b) => a.path.localeCompare(b.path)),
    trackedPatch: tracked.text,
    stagedPatch: staged.text,
    untracked,
    patchComplete: tracked.complete && staged.complete,
  }
}

function pathState(snapshot: DirectCheckoutSnapshot, path: string): string {
  const rows = snapshot.pathStates.filter(row => row.path === path || row.originalPath === path)
  if (rows.length === 0) return 'clean'
  return JSON.stringify(rows)
}

function changedPaths(before: DirectCheckoutSnapshot, after: DirectCheckoutSnapshot): string[] {
  const candidates = new Set([...before.dirtyPaths, ...after.dirtyPaths])
  return [...candidates]
    .filter(path => pathState(before, path) !== pathState(after, path))
    .sort()
}

function overlaps(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/^\.\//, '').replace(/\/$/, '')
  const left = clean(a)
  const right = clean(b)
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function makeCheckpoint(
  repo: string,
  before: DirectCheckoutSnapshot,
  after: DirectCheckoutSnapshot,
): DirectCheckpoint {
  const touched = new Set(changedPaths(before, after))
  let committedPatch = ''
  if (before.head !== after.head) {
    try {
      const names = git(repo, 'diff', '--name-only', before.head, after.head, '--')
      for (const path of names.split('\n').filter(Boolean)) touched.add(path)
      committedPatch = boundedPatch(git(repo, 'diff', '--binary', '--full-index', before.head, after.head, '--')).text
    } catch {
      // A rewritten/unrelated HEAD is still a safety failure. The hashes in the
      // checkpoint retain the fact even if Git cannot construct a diff.
    }
  }
  const protectedPaths = before.dirtyPaths
  const protectedConflicts = protectedPaths.filter(path => pathState(before, path) !== pathState(after, path))
  const limitations: string[] = []
  if (!before.patchComplete || !after.patchComplete) limitations.push('one or more tracked patches exceeded 2 MiB and were truncated')
  if (before.untracked.length > 0 || after.untracked.length > 0) {
    limitations.push('untracked files are recorded by path, hash, and size; their contents are not copied into the artifact')
  }
  if (before.head !== after.head) limitations.push('HEAD moved during the lane; Arc recorded it but did not reset or rewrite history')
  return {
    version: 1,
    before,
    after,
    touchedPaths: [...touched].sort(),
    protectedPaths,
    protectedConflicts,
    headMoved: before.head !== after.head,
    committedPatch,
    limitations,
  }
}

function directTranscript(
  phase: DirectTranscript['phase'],
  role: RoleBinding,
  result: DispatchResult,
): DirectTranscript {
  return {
    phase,
    requestedModel: role.model,
    observedModels: result.observedModels,
    modelStatus: checkModel(role.model, result.observedModels, result.modelVerified, modelCheckMode(role.cli), result.usage),
    terminalReason: result.terminalReason,
    transcript: result.transcript,
  }
}

function failureReason(phase: string, transcript: DirectTranscript): string | null {
  if (transcript.terminalReason === 'cancelled') return `${phase} was cancelled`
  if (transcript.terminalReason !== 'ok') return `${phase} ended ${transcript.terminalReason}`
  if (transcript.modelStatus !== 'ok') return `${phase} model was ${transcript.modelStatus}`
  return null
}

function checkpointResult(
  repo: string,
  before: DirectCheckoutSnapshot,
  fields: Omit<DirectRunResult, 'checkpoint' | 'checkpointArtifact'>,
): DirectRunResult {
  const checkpoint = makeCheckpoint(repo, before, captureDirectSnapshot(repo))
  return { ...fields, checkpoint, checkpointArtifact: JSON.stringify(checkpoint, null, 2) }
}

function authorPrompt(brief: string, before: DirectCheckoutSnapshot): string {
  return [
    '# DIRECT CHANGE',
    '',
    'Work in the current checkout and make only the focused change requested below.',
    'Do not stage, commit, reset, checkout, clean, stash, or rewrite history.',
    'The operator may already have work here. Never touch these protected paths:',
    ...(before.dirtyPaths.length ? before.dirtyPaths.map(path => `- ${path}`) : ['- (none)']),
    '',
    'Return the structured task result after editing. Arc will run the project gates and review the diff.',
    '',
    '## Request',
    brief,
  ].join('\n')
}

function riskPrompt(brief: string, before: DirectCheckoutSnapshot): string {
  return [
    '# PREDICT DIRECT-CHANGE RISKS — DO NOT EDIT',
    '',
    'You are the independent reviewer. The implementation has not run yet.',
    'Read the current tree and predict concrete correctness or regression risks for this request.',
    'Do not change, stage, or commit anything.',
    '',
    '## Request', brief,
    '',
    `Base HEAD: ${before.head}`,
    `Pre-existing dirty paths: ${before.dirtyPaths.join(', ') || '(none)'}`,
  ].join('\n')
}

function reviewPrompt(
  brief: string,
  checklist: typeof RiskChecklist._output,
  before: DirectCheckoutSnapshot,
  after: DirectCheckoutSnapshot,
  gates: Array<{ ok: boolean; result: GateResult }>,
): string {
  const touched = changedPaths(before, after)
  return [
    '# REVIEW DIRECT CHANGE — DO NOT EDIT',
    '',
    'Review correctness and regressions, not style. The checkout may have contained operator work before this task.',
    'The before patch is supplied so you can distinguish that protected work from the direct change.',
    'Every finding must name a file and line. Use checkCommand only for a read/check command that is safe to run.',
    '',
    '## Request', brief,
    '',
    '## Risks predicted before implementation',
    ...checklist.risks.map(risk => `- ${risk.id}: ${risk.text} — ${risk.howToCheck}`),
    '',
    '## Gates',
    ...(gates.length ? gates.map(gate => `- ${describe(gate.result)}; accepted=${gate.ok}`) : ['- (none declared)']),
    '',
    '## Net paths changed by the direct lane',
    ...(touched.length ? touched.map(path => `- ${path}`) : ['- (none)']),
    'Read new untracked paths from the checkout; Git does not include them in an unstaged patch.',
    '',
    '## Patch already present before implementation',
    '```diff', before.trackedPatch.slice(0, 120_000), '```',
    '',
    '## Checkout patch after implementation',
    '```diff', after.trackedPatch.slice(0, 120_000), '```',
  ].join('\n')
}

export async function runDirect(
  options: DirectRunOptions,
  dependencies: DirectDependencies = DEFAULT_DEPENDENCIES,
): Promise<DirectRunResult> {
  const repo = options.config.repo
  const transcripts: DirectTranscript[] = []
  const gates: Array<{ ok: boolean; result: GateResult }> = []
  const findingChecks: DirectFindingCheck[] = []
  const before = captureDirectSnapshot(repo)
  // Hand the recovery artifact out BEFORE any agent can touch the checkout.
  options.onCheckpoint?.(JSON.stringify(makeCheckpoint(repo, before, before), null, 2))

  try {
    return await runDirectFrom(options, dependencies, before, transcripts, gates, findingChecks)
  } catch (error) {
    // Cancellation propagates so the caller's honest "stopped" copy runs; any
    // other throw must still return the checkpoint — losing the before/after
    // record exactly when an agent may have half-edited the checkout is the
    // worst possible failure of this lane.
    if (options.signal?.aborted) throw error
    return checkpointResult(repo, before, {
      gates, findingChecks, transcripts,
      ok: false, status: 'crashed',
      reason: `the direct lane crashed before finishing: ${(error as Error).message.slice(0, 300)}`,
    })
  }
}

async function runDirectFrom(
  options: DirectRunOptions,
  dependencies: DirectDependencies,
  before: DirectCheckoutSnapshot,
  transcripts: DirectTranscript[],
  gates: Array<{ ok: boolean; result: GateResult }>,
  findingChecks: DirectFindingCheck[],
): Promise<DirectRunResult> {
  const { config } = options
  const repo = config.repo
  const log = options.log ?? (() => {})

  const dispatchObserved = async (
    phase: DirectTranscript['phase'], agentRole: string, roleUsed: RoleBinding, opts: DispatchOptions,
  ): Promise<{ result: DispatchResult; transcript: DirectTranscript }> => {
    const attemptId = options.observer?.start({ phase, role: agentRole, cli: roleUsed.cli, model: roleUsed.model })
    const result = await dependencies.dispatch(opts)
    const transcript = directTranscript(phase, roleUsed, result)
    transcripts.push(transcript)
    if (attemptId) {
      options.observer?.finish(attemptId, {
        terminalReason: transcript.modelStatus === 'drift' ? 'model-drift' : result.terminalReason,
        exitCode: result.exitCode,
        observedModel: result.observedModels.join(',') || null,
        transcript: result.transcript,
        usage: result.usage,
      })
    }
    return { result, transcript }
  }

  const implementRole = config.roles.implement
  const reviewRole = config.roles.review
  const emptyFields = { gates, findingChecks, transcripts }

  if (implementRole.sandbox !== 'workspace-write') {
    return checkpointResult(repo, before, {
      ...emptyFields, ok: false, status: 'refused',
      reason: 'the configured implement role is read-only',
    })
  }
  if (!reviewRole) {
    return checkpointResult(repo, before, {
      ...emptyFields, ok: false, status: 'refused',
      reason: 'direct changes require an independent review role',
    })
  }
  // Alias-aware: `opus` and `claude-opus-5` are the same model, and a review
  // by the model that wrote the change is not independent whatever it is
  // called in the config.
  if (implementRole.cli === reviewRole.cli && sameModel(implementRole.model, reviewRole.model)) {
    return checkpointResult(repo, before, {
      ...emptyFields, ok: false, status: 'refused',
      reason: 'implementer and reviewer resolve to the same provider/model; independent review is required',
    })
  }

  const requestedConflict = (options.targetPaths ?? []).filter(target =>
    before.dirtyPaths.some(path => overlaps(target, path)))
  if (requestedConflict.length > 0) {
    return checkpointResult(repo, before, {
      ...emptyFields, ok: false, status: 'refused',
      reason: `requested path already has operator changes: ${requestedConflict.join(', ')}`,
    })
  }

  // A baseline-subset gate is measured before any agent runs, against this
  // exact checkout state. That keeps an existing flaky failure from being
  // blamed on the direct task without creating or switching worktrees.
  const baselines = new Map<string, GateResult>()
  for (const gate of config.gates.filter(gate => gate.baselineSubset)) {
    const result = await dependencies.runGate(gate, repo, before.head, options.signal)
    baselines.set(gate.name, result)
    log(`baseline ${describe(result)}`)
  }
  const afterBaselines = captureDirectSnapshot(repo)
  const baselineCheckpoint = makeCheckpoint(repo, before, afterBaselines)
  if (baselineCheckpoint.headMoved || baselineCheckpoint.protectedConflicts.length > 0 || baselineCheckpoint.touchedPaths.length > 0) {
    return checkpointResult(repo, before, {
      ...emptyFields, ok: false, status: 'safety-conflict',
      reason: 'a baseline gate changed the checkout; direct execution stopped without rollback',
    })
  }

  // Anti-anchoring, enforced by GEOGRAPHY instead of sequencing: the reviewer
  // predicts against a disposable worktree pinned at the pre-change HEAD
  // while the author works in the live checkout. It cannot rationalise a
  // patch that never exists in its tree — which is what lets both model
  // turns run CONCURRENTLY instead of paying them serially. (The serial
  // risk turn was the dogfood run's #1 latency complaint.)
  const readOnlyReviewRole: RoleBinding = { ...reviewRole, sandbox: 'read-only' }
  const riskTemp = mkdtempSync(join(tmpdir(), 'arc-direct-risk-'))
  const riskTree = join(riskTemp, 'tree')
  const cleanupRiskTree = () => {
    try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', riskTree], { stdio: 'ignore' }) } catch { /* prune reclaims it */ }
    try { rmSync(riskTemp, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
  let riskPromise: Promise<{ result: DispatchResult; transcript: DirectTranscript }>
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', riskTree, before.head], { stdio: 'ignore' })
    riskPromise = dispatchObserved('risk', 'review', readOnlyReviewRole, {
      role: readOnlyReviewRole,
      cwd: riskTree,
      prompt: riskPrompt(options.brief, before),
      schema: RiskChecklist,
      signal: options.signal,
      onEvent: options.onEvent,
    }).finally(cleanupRiskTree)
  } catch (error) {
    cleanupRiskTree()
    return checkpointResult(repo, before, {
      ...emptyFields, ok: false, status: 'review-failed',
      reason: `could not isolate a base tree for risk prediction: ${(error as Error).message.slice(0, 200)}`,
    })
  }
  // An early return must not surface the in-flight risk turn as unhandled.
  riskPromise.catch(() => { /* awaited (or abandoned) below */ })
  let riskChecklist: typeof RiskChecklist._output | undefined
  let riskAwaited = false

  const selectedGates = options.gateNames === undefined
    ? config.gates
    : selectGates(config.gates, options.gateNames)

  // The bounded repair loop: a red gate feeds its concrete output back to the
  // writer and rechecks, like fixing a failed test by hand — with the same
  // stops the deep lane has. Safety conflicts never retry: an agent that
  // touched protected work has lost the benefit of the doubt. A repeated
  // normalized failure signature stops the loop instead of spinning.
  const repairBudget = Math.max(1, options.repairAttempts ?? 1)
  let implementation: typeof TaskResult._output | undefined
  let afterGates = before
  let feedback = ''
  let lastSignature = ''
  for (let attempt = 1; ; attempt++) {
    const { result: implementationResult, transcript: implementationTranscript } = await dispatchObserved(
      'implement', 'implement', implementRole, {
        role: implementRole,
        cwd: repo,
        prompt: authorPrompt(
          feedback ? `${options.brief}\n\n# WHAT FAILED LAST TIME\n${feedback}` : options.brief,
          before),
        schema: TaskResult,
        signal: options.signal,
        onEvent: options.onEvent,
      })
    const afterImplementation = captureDirectSnapshot(repo)
    const implementationCheckpoint = makeCheckpoint(repo, before, afterImplementation)

    if (implementationCheckpoint.headMoved || implementationCheckpoint.protectedConflicts.length > 0) {
      const details = [
        ...(implementationCheckpoint.headMoved ? ['HEAD moved'] : []),
        ...(implementationCheckpoint.protectedConflicts.length
          ? [`protected paths changed: ${implementationCheckpoint.protectedConflicts.join(', ')}`]
          : []),
      ]
      return checkpointResult(repo, before, {
        ...emptyFields, riskChecklist,
        ok: false, status: 'safety-conflict',
        reason: `${details.join('; ')}; changes were left in place for the operator`,
      })
    }

    // The risk turn ran concurrently with the implementation; its verdict is
    // still a hard requirement before any result is graded or accepted.
    if (!riskAwaited) {
      riskAwaited = true
      const { result: riskResult, transcript: riskTranscript } = await riskPromise
      const riskFailure = failureReason('risk prediction', riskTranscript)
      if (riskFailure || !riskResult.parsed) {
        return checkpointResult(repo, before, {
          ...emptyFields,
          ok: false,
          status: riskResult.terminalReason === 'cancelled' ? 'cancelled' : 'review-failed',
          reason: riskFailure ?? 'risk prediction returned no validated checklist',
        })
      }
      riskChecklist = riskResult.parsed as typeof RiskChecklist._output
    }

    const implementationFailure = failureReason('implementation', implementationTranscript)
    if (implementationFailure || !implementationResult.parsed) {
      return checkpointResult(repo, before, {
        ...emptyFields, riskChecklist,
        ok: false,
        status: implementationResult.terminalReason === 'cancelled' ? 'cancelled' : 'implementation-failed',
        reason: implementationFailure ?? 'implementation returned no validated result',
      })
    }
    implementation = implementationResult.parsed as typeof TaskResult._output
    if (implementation.status !== 'done') {
      return checkpointResult(repo, before, {
        ...emptyFields, riskChecklist, implementation,
        ok: false, status: 'implementation-failed',
        reason: `implementation reported ${implementation.status}`,
      })
    }
    if (implementationCheckpoint.touchedPaths.length === 0 && !implementation.noop) {
      return checkpointResult(repo, before, {
        ...emptyFields, riskChecklist, implementation,
        ok: false, status: 'implementation-failed',
        reason: 'implementation reported done but produced no checkout change and did not declare a no-op',
      })
    }

    // Each attempt is judged on its own gate run; earlier attempts' results
    // would otherwise mark a now-green checkout as failed.
    gates.length = 0
    for (const gate of selectedGates) {
      const result = await dependencies.runGate(gate, repo, before.head, options.signal)
      const baseline = baselines.get(gate.name)
      const ok = gate.baselineSubset && baseline ? isSubsetOfBaseline(result, baseline) : result.pass
      gates.push({ ok, result })
      log(describe(result))
    }

    afterGates = captureDirectSnapshot(repo)
    const gateCheckpoint = makeCheckpoint(repo, before, afterGates)
    if (gateCheckpoint.headMoved || gateCheckpoint.protectedConflicts.length > 0) {
      return checkpointResult(repo, before, {
        ...emptyFields, riskChecklist, implementation,
        ok: false, status: 'safety-conflict',
        reason: 'a project gate changed HEAD or protected operator work; changes were left in place',
      })
    }

    const failedNow = gates.filter((gate) => !gate.ok)
    if (failedNow.length === 0) break
    if (attempt >= repairBudget) break // review still runs; the gate failure is terminal below

    const signature = failedNow.map((gate) => gate.result.signature).join('\n')
    if (lastSignature && signaturesMatch(signature, lastSignature)) {
      log('same failure signature twice — another attempt would spin, stopping')
      break
    }
    lastSignature = signature
    feedback = failedNow
      .map((gate) => `## ${gate.result.name} (exit ${gate.result.exitCode})\n${gate.result.output.slice(-2_000)}`)
      .join('\n\n')
    log(`red gate(s) — retrying the implementation (attempt ${attempt + 1}/${repairBudget})`)
  }

  const { result: reviewResult, transcript: reviewTranscript } = await dispatchObserved('review', 'review', readOnlyReviewRole, {
    role: readOnlyReviewRole,
    cwd: repo,
    prompt: reviewPrompt(options.brief, riskChecklist!, before, afterGates, gates),
    schema: ReviewVerdict,
    signal: options.signal,
    onEvent: options.onEvent,
  })
  const reviewFailure = failureReason('review', reviewTranscript)
  if (reviewFailure || !reviewResult.parsed) {
    return checkpointResult(repo, before, {
      ...emptyFields, riskChecklist, implementation,
      ok: false,
      status: reviewResult.terminalReason === 'cancelled' ? 'cancelled' : 'review-failed',
      reason: reviewFailure ?? 'review returned no validated verdict',
    })
  }
  const review = reviewResult.parsed as typeof ReviewVerdict._output

  // These commands are MODEL-AUTHORED shell run in the operator's checkout.
  // They get the minimal gate environment (never shell credentials), and in
  // ask mode the operator sees the exact list and can decline.
  const commandFindings = review.findings.filter(finding => finding.file && finding.checkCommand)
  const checksApproved = commandFindings.length === 0 || !options.confirmFindingChecks
    ? true
    : await options.confirmFindingChecks(commandFindings.map(finding => finding.checkCommand!))
  for (const finding of commandFindings) {
    if (!checksApproved) {
      findingChecks.push({
        file: finding.file, line: finding.line, claim: finding.claim,
        command: finding.checkCommand!, ran: false, reproduced: false, result: null,
      })
      continue
    }
    const result = await dependencies.runGate({
      name: `direct-review:${finding.file}:${finding.line}`,
      command: finding.checkCommand!,
      proves: finding.claim,
      cwd: '.',
      timeoutMs: 300_000,
      heavy: false,
      baselineSubset: false,
      readOnly: true,
    }, repo, before.head, options.signal)
    findingChecks.push({
      file: finding.file,
      line: finding.line,
      claim: finding.claim,
      command: finding.checkCommand!,
      ran: true,
      reproduced: result.pass,
      result,
    })
  }

  const finalSnapshot = captureDirectSnapshot(repo)
  const finalCheckpoint = makeCheckpoint(repo, before, finalSnapshot)
  const reviewerMutation = makeCheckpoint(repo, afterGates, finalSnapshot)
  if (finalCheckpoint.headMoved || finalCheckpoint.protectedConflicts.length > 0) {
    return checkpointResult(repo, before, {
      ...emptyFields, riskChecklist, implementation, review,
      ok: false, status: 'safety-conflict',
      reason: 'review verification changed HEAD or protected operator work; changes were left in place',
    })
  }
  if (reviewerMutation.headMoved || reviewerMutation.touchedPaths.length > 0) {
    return checkpointResult(repo, before, {
      ...emptyFields, riskChecklist, implementation, review,
      ok: false, status: 'safety-conflict',
      reason: 'the read-only review or its verification command changed the checkout; changes were left in place',
    })
  }

  const failedGates = gates.filter(gate => !gate.ok)
  if (failedGates.length > 0) {
    return checkpointResult(repo, before, {
      ...emptyFields, riskChecklist, implementation, review,
      ok: false, status: 'gate-failed',
      reason: `${failedGates.map(gate => gate.result.name).join(', ')} failed`,
    })
  }

  const criticals = review.findings.filter(finding => finding.severity === 'critical')
  if (!['PASS', 'PASS_WITH_NOTES'].includes(review.verdict) || criticals.length > 0) {
    return checkpointResult(repo, before, {
      ...emptyFields, riskChecklist, implementation, review,
      ok: false, status: 'changes-required',
      reason: criticals.length > 0
        ? `review carried ${criticals.length} critical finding(s)`
        : `review verdict was ${review.verdict}`,
    })
  }

  return checkpointResult(repo, before, {
    ...emptyFields, riskChecklist, implementation, review,
    ok: true, status: 'completed',
    reason: 'implementation, project gates, and independent review passed',
  })
}
