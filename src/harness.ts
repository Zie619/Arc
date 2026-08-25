import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { classifyExit, type ExitFacts } from './classify.ts'
import { buildProviderChildEnv, getProviderHelpText } from './provider-runtime.ts'
import { ProviderUsage, jsonSchemaFor, type RoleBinding, type TerminalReason } from './types.ts'

/**
 * The ONLY module allowed messy I/O.
 *
 * Both CLIs expose a structured, non-interactive mode, so we never scrape
 * prose and never drive a TUI. Event shapes below were probed against the
 * real binaries (codex-cli 0.149.0, Claude Code 2.1.238), not assumed:
 *
 *   codex exec --json   → thread.started | turn.started | item.completed | turn.completed
 *   claude -p --output-format stream-json
 *                       → system | assistant (.message.model) | result (.modelUsage, .result)
 */

export interface DispatchOptions {
  role: RoleBinding
  prompt: string
  cwd: string
  /** Zod schema the agent's final message must satisfy. */
  schema?: z.ZodType
  /** Called on every parsed event — this is what feeds liveness. */
  onEvent?: (event: { kind: string; at: number; payload: unknown }) => void
  /** Abort from the UI (escape). Kills the whole process tree, not just the
   *  direct child — an agent that spawned a build would otherwise keep going
   *  after you told it to stop. */
  signal?: AbortSignal
  /**
   * Extra paths a workspace-write sandbox may write. A git WORKTREE keeps its
   * index/refs/objects under the main repository's .git — outside the
   * sandbox cwd — so committing from a worktree fails `index.lock: Operation
   * not permitted` without this. (Found by the first self-arc.)
   */
  writableRoots?: string[]
}

export interface DispatchResult {
  terminalReason: TerminalReason
  exitCode: number | null
  /**
   * Models actually observed, read back from the run's own record — EVERY one,
   * because a session can start on one model and change part-way.
   *   claude: the `modelUsage` map on its result event.
   *   codex:  `turn_context.model` in the session rollout it writes to disk
   *           (its event stream carries no model at all).
   * If neither source can be read, this stays empty and `modelVerified` is
   * false — the run is recorded unverified rather than given a forged pass.
   */
  observedModels: string[]
  modelVerified: boolean
  /** Raw final message text (before schema parsing). */
  finalText: string
  /** Parsed + validated envelope, when a schema was supplied and it passed. */
  parsed?: unknown
  /** Full JSONL transcript for the artifact store. */
  transcript: string
  eventCount: number
  durationMs: number
  /** Verbatim provider rejection, when terminalReason is 'provider-error'. */
  errorText?: string
  /** Exact provider counters. Missing fields were not reported and stay missing. */
  usage: ProviderUsage[]
}

/** Non-fatal shell noise that must never count as "the model produced output". */
function isModelOutputEvent(cli: 'codex' | 'claude', type: string): boolean {
  if (cli === 'claude') return type === 'assistant'
  return type === 'item.completed' || type === 'turn.completed'
}

function numeric(o: Record<string, unknown>, key: string): number | undefined {
  const value = o[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One level down, for the receipt fields the providers nest. */
function nested(o: Record<string, unknown>, outer: string, key: string): number | undefined {
  const inner = o[outer]
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return undefined
  return numeric(inner as Record<string, unknown>, key)
}

/**
 * Anthropic and OpenAI disagree on the NAME and on the MEANING of every cache
 * field, and each verified against a live receipt from the shipped CLI:
 *
 *   claude, camelCase (`modelUsage[model]`)
 *     inputTokens · cacheReadInputTokens · cacheCreationInputTokens · outputTokens
 *     and NO reasoning field at all — thinking tokens are not present here.
 *   claude, snake_case (the aggregate `usage` object)
 *     input_tokens · cache_read_input_tokens · cache_creation_input_tokens ·
 *     output_tokens · output_tokens_details.thinking_tokens ·
 *     cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens
 *   codex, snake_case
 *     input_tokens · cached_input_tokens · cache_write_input_tokens ·
 *     output_tokens · reasoning_output_tokens
 *
 * Reading OpenAI's names off an Anthropic receipt is not a near miss: a measured
 * call reported 10 input and 89 output while 38,213 cache tokens vanished —
 * $0.000455 recorded against $0.042415 actually billed.
 */
function exactUsage(
  provider: 'claude' | 'codex', raw: unknown, model?: string, costUsd?: number,
  style: 'camel' | 'snake' = provider === 'claude' ? 'camel' : 'snake',
): ProviderUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const snakeCacheRead = provider === 'claude' ? 'cache_read_input_tokens' : 'cached_input_tokens'
  const snakeCacheWrite = provider === 'claude' ? 'cache_creation_input_tokens' : 'cache_write_input_tokens'
  const pick = (camel: string, snake: string) => numeric(r, style === 'camel' ? camel : snake)

  const inputTokens = pick('inputTokens', 'input_tokens')
  const cachedInputTokens = pick('cacheReadInputTokens', snakeCacheRead)
  const cacheWriteInputTokens = pick('cacheCreationInputTokens', snakeCacheWrite)
  const outputTokens = pick('outputTokens', 'output_tokens')
  // codex reports reasoning flat; Anthropic nests it, and only on the aggregate.
  const reasoningOutputTokens = numeric(r, 'reasoning_output_tokens')
    ?? nested(r, 'output_tokens_details', 'thinking_tokens')
  const cacheWrite5mTokens = nested(r, 'cache_creation', 'ephemeral_5m_input_tokens')
  const cacheWrite1hTokens = nested(r, 'cache_creation', 'ephemeral_1h_input_tokens')

  if ([inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
    reasoningOutputTokens, costUsd].every(value => value === undefined)) return null
  const candidate = {
    provider,
    usageSemantics: provider === 'claude' ? 'additive' : 'subset',
    ...(model === undefined ? {} : { model }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens }),
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    raw: r,
  }
  const parsed = ProviderUsage.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function buildArgs(o: DispatchOptions, schemaPath: string | null, lastMsgPath: string): string[] {
  const r = o.role
  if (r.cli === 'codex') {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd', o.cwd,
      '--sandbox', r.sandbox,
      '-m', r.model,
      '-c', `model_reasoning_effort="${r.effort}"`,
      '-o', lastMsgPath,
    ]
    if (r.sandbox === 'workspace-write' && o.writableRoots?.length) {
      args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(o.writableRoots)}`)
    }
    if (schemaPath) args.push('--output-schema', schemaPath)
    args.push('-')            // prompt arrives on stdin, so it is never argv-visible
    return args
  }
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', r.model,
    '--effort', r.effort,
    // THE PROJECT'S setup travels with the delegate. The OPERATOR'S does not.
    //
    // `--setting-sources project` loads the repo's own settings and, crucially,
    // its CLAUDE.md. Passing '' instead — which is what this did — silently
    // discarded it: measured directly, a repo whose CLAUDE.md said "reply
    // PINEAPPLE" got "Ready." with '' and "PINEAPPLE" with `project`. Every
    // agent was writing code in someone's repo while ignoring that repo's own
    // instructions.
    //
    // The operator's personal global settings, Chrome integration and session
    // history still stay out. A delegate should not inherit whatever the human
    // happens to have connected to their own editor; its capabilities should be
    // the project's plus what this role declares.
    '--setting-sources', 'project',
    '--no-chrome',
    '--no-session-persistence',
  ]

  // MCP: the project's servers, never the operator's. `--strict-mcp-config`
  // with an explicit --mcp-config means "only these"; without a project file it
  // means "none at all", which is the right default.
  const projectMcp = join(o.cwd, '.mcp.json')
  if (existsSync(projectMcp)) args.push('--mcp-config', projectMcp)
  args.push('--strict-mcp-config')
  // NOTE: --fallback-model is deliberately never set. It is the exact silent
  // downgrade vector this engine exists to make visible.
  if (r.tools) args.push('--allowedTools', r.tools)
  if (schemaPath) args.push('--json-schema', readFileSync(schemaPath, 'utf8'))
  return args
}

export async function dispatch(o: DispatchOptions): Promise<DispatchResult> {
  const started = Date.now()
  const tmp = mkdtempSync(join(tmpdir(), 'arc-'))
  try {
  const lastMsgPath = join(tmp, 'last.txt')

  let schemaPath: string | null = null
  if (o.schema) {
    schemaPath = join(tmp, 'schema.json')
    writeFileSync(schemaPath, JSON.stringify(jsonSchemaFor(o.schema), null, 2))
  }

  const args = buildArgs(o, schemaPath, lastMsgPath)
  const cli = o.role.cli
  const gatedFlags = cli === 'claude'
    ? ['--effort', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '--json-schema']
    : ['--output-schema', '--sandbox']
  const helpText = await getProviderHelpText(cli)
  if (helpText !== null) {
    const missingFlag = gatedFlags
      .filter(flag => args.includes(flag))
      .find(flag => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s=,]|$)`, 'm').test(helpText))
    if (missingFlag) {
      const errorText = `${cli} --help does not advertise ${missingFlag}; refusing to dispatch`
      return {
        terminalReason: 'provider-error',
        exitCode: null,
        observedModels: [],
        modelVerified: false,
        finalText: '',
        transcript: [
          `# arc dispatch — ${cli} ${o.role.model} (${o.role.sandbox})`,
          `# args: ${JSON.stringify(args)}`,
          '# exit=null reason=provider-error events=0',
          '# observed models: (none reported by this CLI)',
          '',
          errorText,
        ].join('\n'),
        eventCount: 0,
        durationMs: Date.now() - started,
        errorText,
        usage: [],
      }
    }
  }
  const allowedProjectEnv = Object.fromEntries(
    (o.role.envAllowlist ?? [])
      .map((key) => [key, process.env[key]] as const)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )

  const facts: ExitFacts = {
    exitCode: null, signal: null, sawModelOutput: false, sawTerminalMarker: false,
    timedOut: false, stalled: false, permissionDenials: 0, truncated: false, spawnError: false,
    providerError: false, cancelled: false,
  }
  let providerErrorText = ''

  const observed = new Set<string>()
  const usage: ProviderUsage[] = []
  let modelVerified = false
  let threadId = ''
  let finalText = ''
  let eventCount = 0
  const lines: string[] = []
  let lastEventAt = Date.now()
  let stallExtended = false

  // detached:true puts the child in its OWN process group so we can kill the
  // whole tree. Killing only the direct child leaves its grandchildren alive
  // holding the stdout pipe open — and then 'close' never fires and the
  // orchestrator waits forever on an agent that is already dead.
  const child = spawn(cli, args, {
    cwd: o.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildProviderChildEnv(cli, process.env, { ...allowedProjectEnv, ARC_RUN: '1' }),
    detached: true,
  })

  const killTree = (): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
    try { child.kill('SIGKILL') } catch { /* already dead */ }
  }

  // A missing or instantly-dead provider binary surfaces as a stream error on
  // stdin (EPIPE/ENOENT), not only as a child 'error' event. Without a stdin
  // listener that stream error is an uncaught exception that kills Arc itself
  // instead of classifying the dispatch as spawn-failed.
  child.stdin.on('error', () => { /* the child 'error'/'exit' handlers carry the outcome */ })
  try {
    child.stdin.write(o.prompt)
    child.stdin.end()
  } catch { /* same: classified by the child handlers */ }

  const handleLine = (line: string) => {
    lines.push(line)
    const t = line.trim()
    if (!t.startsWith('{')) return
    let d: any
    try { d = JSON.parse(t) } catch { return }

    eventCount++
    lastEventAt = Date.now()
    const type: string = d.type ?? d?.msg?.type ?? 'unknown'
    o.onEvent?.({ kind: type, at: lastEventAt, payload: d })

    if (isModelOutputEvent(cli, type)) facts.sawModelOutput = true

    if (cli === 'claude') {
      const m = d?.message?.model
      if (typeof m === 'string' && !m.startsWith('<')) observed.add(m)
      if (type === 'result') {
        // Authoritative: every model the run actually billed, not just the first.
        const modelUsage = d.modelUsage
        if (modelUsage && typeof modelUsage === 'object') {
          // `<synthetic>` is Claude Code's marker for a response that never
          // reached a model at all — an invalid model name, a refused request.
          // Recording it as an observed MODEL turned "the call failed" into
          // "it ran on the wrong model", which sent us hunting the wrong bug.
          for (const [model, raw] of Object.entries(modelUsage)) {
            if (model.startsWith('<')) continue
            observed.add(model)
            const row = exactUsage('claude', raw, model,
              raw && typeof raw === 'object' && !Array.isArray(raw)
                ? numeric(raw as Record<string, unknown>, 'costUSD')
                : undefined)
            if (row) usage.push(row)
          }
          modelVerified = observed.size > 0
          // Thinking tokens and the cache-write TTL split exist ONLY on the
          // aggregate `usage` object, never in the per-model map — verified
          // against a live receipt. With one model they unambiguously belong to
          // it. With several nobody can attribute them, so they stay off rather
          // than being invented.
          // ponytail: single-model attribution only; split them per model if a
          // multi-model attempt ever needs an exact per-model bill.
          if (usage.length === 1 && d.usage && typeof d.usage === 'object') {
            const agg = d.usage as Record<string, unknown>
            const only = usage[0]!
            const detail = {
              reasoningOutputTokens: nested(agg, 'output_tokens_details', 'thinking_tokens'),
              cacheWrite5mTokens: nested(agg, 'cache_creation', 'ephemeral_5m_input_tokens'),
              cacheWrite1hTokens: nested(agg, 'cache_creation', 'ephemeral_1h_input_tokens'),
            }
            for (const [key, value] of Object.entries(detail)) {
              if (value !== undefined) (only as Record<string, unknown>)[key] = value
            }
          }
        }
        // Older Claude Code results may omit the per-model map. Its aggregate
        // uses snake_case, so preserve that exact receipt without inventing a
        // model or attempting to split it among models.
        if (usage.length === 0) {
          const row = exactUsage('claude', d.usage, undefined,
            numeric(d as Record<string, unknown>, 'total_cost_usd'), 'snake')
          if (row) usage.push(row)
        }
        if (typeof d.result === 'string') finalText = d.result
        if (d.subtype && d.subtype !== 'success') facts.truncated = d.subtype === 'error_max_turns'
        if (d.is_error === true) {
          facts.sawTerminalMarker = false
          facts.providerError = true
          if (typeof d.result === 'string' && d.result.length > providerErrorText.length) providerErrorText = d.result
        }
        else facts.sawTerminalMarker = true
      }
    } else {
      if (type === 'thread.started' && typeof d.thread_id === 'string') threadId = d.thread_id
      if (type === 'turn.completed') {
        facts.sawTerminalMarker = true
        const row = exactUsage('codex', d.usage)
        if (row) usage.push(row)
      }
      if (type === 'item.completed') {
        const txt = d?.item?.text ?? d?.item?.content
        if (typeof txt === 'string' && txt.length > 0) finalText = txt
      }
    }

    // A provider rejection (bad schema, auth, quota) explains why no model
    // output ever arrived. Capture it verbatim so the log names the cause.
    if (type === 'error' || type === 'turn.failed') {
      facts.providerError = true
      const msg = d?.message ?? d?.error?.message ?? ''
      if (typeof msg === 'string' && msg.length > providerErrorText.length) providerErrorText = msg
    }

    // Count a permission denial ONLY from an event that IS one.
    //
    // This used to grep the whole raw line, which meant an agent READING a
    // file that mentions permissions tripped the detector. Sending scouts over
    // this very repo killed three of them: src/classify.ts contains the
    // strings "permission-blocked" and "approval required", so the file's own
    // contents looked like denials. Grep classifies a failure; it must never
    // be what detects one.
    if (type === 'error' || type === 'turn.failed' || type === 'permission_denial' ||
        (type === 'result' && d.is_error === true)) {
      const msg = String(d?.message ?? d?.error?.message ?? d?.result ?? '')
      if (/permission|not permitted|approval required|requires approval/i.test(msg)) {
        facts.permissionDenials++
      }
    }
  }

  let stdoutBuf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    let i: number
    while ((i = stdoutBuf.indexOf('\n')) >= 0) {
      handleLine(stdoutBuf.slice(0, i))
      stdoutBuf = stdoutBuf.slice(i + 1)
    }
  })

  const stderrChunks: string[] = []
  child.stderr.on('data', (c: Buffer) => { stderrChunks.push(c.toString()) })

  // Cancelling has to reach the grandchildren too. `arc` spawns a CLI, which
  // spawns a build; killing only the CLI leaves the build running.
  const onAbort = () => { facts.cancelled = true; killTree() }
  o.signal?.addEventListener('abort', onAbort, { once: true })
  if (o.signal?.aborted) onAbort()

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      if (stdoutBuf.trim()) handleLine(stdoutBuf)
      clearTimeout(hard)
      clearInterval(stallTick)
      resolve()
    }

    // Two independent timers. A hard timeout bounds the whole run; the stall
    // timer catches a process that is alive but has stopped producing events.
    // A watchdog that kills a healthy job is worse than the hang it prevents,
    // so the stall timer is reset by any event, not just output bytes.
    const hard = setTimeout(() => {
      facts.timedOut = true
      killTree()
    }, o.role.timeoutMs)

    const stallTick = setInterval(() => {
      if (Date.now() - lastEventAt > o.role.stallMs * (stallExtended ? 2 : 1)) {
        if (!stallExtended) {
          try {
            let freshFile = false
            for (const entry of readdirSync(o.cwd)) {
              if (entry === '.git' || entry === 'node_modules') continue
              try {
                const stat = statSync(join(o.cwd, entry))
                if (stat.isFile() && stat.mtimeMs > lastEventAt) freshFile = true
              } catch { /* a vanished child is not evidence of liveness */ }
            }
            if (freshFile) {
              stallExtended = true
              return
            }
          } catch { /* an unreadable cwd is not evidence of liveness */ }
        }
        facts.stalled = true
        clearInterval(stallTick)
        killTree()
      }
    }, 1_000)

    child.on('error', () => { facts.spawnError = true; finish() })

    // Settle on 'exit' (the process is gone), NOT on 'close' (all stdio ended).
    // A killed agent's orphaned grandchild can hold the pipe open indefinitely,
    // and waiting on that is an unbounded hang. We give stdio a short grace
    // period to flush and then proceed regardless.
    child.on('exit', (code, signal) => {
      facts.exitCode = code
      facts.signal = signal
      killTree()
      setTimeout(finish, 150)
    })
    child.on('close', () => { setTimeout(finish, 0) })
  })

  // codex writes its final message to a file rather than the event stream.
  if (cli === 'codex' && existsSync(lastMsgPath)) {
    const t = readFileSync(lastMsgPath, 'utf8').trim()
    if (t) finalText = t
  }

  // codex emits no model receipt in its event stream, but it DOES record one
  // in the session rollout it writes to disk. Read it back and we get real
  // verification for this lane instead of a permanent "unverified".
  if (cli === 'codex' && threadId) {
    const models = await codexSessionModels(threadId)
    if (models.length > 0) {
      for (const m of models) observed.add(m)
      modelVerified = true
    }
  }

  o.signal?.removeEventListener('abort', onAbort)
  let terminalReason = classifyExit(facts)
  let parsed: unknown

  if (terminalReason === 'ok' && o.schema) {
    const candidate = extractJson(finalText)
    const res = o.schema.safeParse(candidate)
    if (res.success) parsed = res.data
    else {
      terminalReason = 'bad-envelope'
      // The concrete field errors are the difference between a retry that
      // fixes the payload and one that repeats it verbatim three times.
      const issues = candidate === undefined
        ? 'the final output contained no parseable JSON'
        : res.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      if (issues.length > providerErrorText.length) providerErrorText = `schema validation failed — ${issues}`
    }
  }

  const stderrText = stderrChunks.join('')
  const capacityErrorText = /(?:\b429\b|rate[ -]?limit|usage[ -]?limit|overloaded)/i.test(stderrText)
    ? stderrText.trim()
    : ''
  const transcript = [
    `# arc dispatch — ${cli} ${o.role.model} (${o.role.sandbox})`,
    `# args: ${JSON.stringify(args)}`,
    `# exit=${facts.exitCode} reason=${terminalReason} events=${eventCount}`,
    `# observed models: ${[...observed].join(', ') || '(none reported by this CLI)'}`,
    '',
    ...lines,
    '',
    '# ---- stderr ----',
    stderrText,
  ].join('\n')

  return {
    terminalReason,
    exitCode: facts.exitCode,
    observedModels: [...observed],
    modelVerified,
    finalText,
    parsed,
    transcript,
    eventCount,
    durationMs: Date.now() - started,
    errorText: providerErrorText || capacityErrorText || undefined,
    usage,
  }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
}

/**
 * Read back which model a codex run actually used.
 *
 * codex writes a session "rollout" JSONL under $CODEX_HOME/sessions, and each
 * `turn_context` entry carries the model for that turn. Reading EVERY entry
 * matters for the same reason it does on the claude side: a session can start
 * on one model and change part-way.
 *
 * Best-effort by design — if the file cannot be found or read we return
 * nothing, and the caller records the run as unverified rather than assuming
 * it was fine. Silence is not agreement.
 */
export async function codexSessionModels(threadId: string): Promise<string[]> {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []

  const found = findRollout(root, threadId, 0)
  if (!found) return []

  const models = new Set<string>()
  try {
    let size = statSync(found).size
    for (let waited = 0; waited < 2_000; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const nextSize = statSync(found).size
      if (nextSize === size) break
      size = nextSize
    }
    for (const line of readFileSync(found, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      let d: any
      try { d = JSON.parse(line) } catch { continue }
      if (d?.type !== 'turn_context') continue
      const m = d?.payload?.model ?? d?.model
      if (typeof m === 'string' && m.length > 0) models.add(m)
    }
  } catch { return [] }
  return [...models]
}

/** Sessions are nested year/month/day; the thread id is the filename suffix. */
function findRollout(dir: string, threadId: string, depth: number): string | null {
  if (depth > 5) return null
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return null }

  let newest: string | null = null
  let newestMtime = -Infinity
  const consider = (path: string) => {
    try {
      const stat = statSync(path)
      if (stat.isFile() && stat.mtimeMs > newestMtime) {
        newest = path
        newestMtime = stat.mtimeMs
      }
    } catch { /* unreadable entries are ignored */ }
  }
  for (const e of entries) {
    if (e.endsWith(`${threadId}.jsonl`)) consider(join(dir, e))
  }
  // Newest directories first — the run we just made is almost always today.
  const dirs = entries
    .map((e) => join(dir, e))
    .filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
    .sort()
    .reverse()
  for (const d of dirs) {
    const hit = findRollout(d, threadId, depth + 1)
    if (hit) consider(hit)
  }
  return newest
}

/**
 * Models wrap JSON in prose or fences no matter how firmly you ask them not
 * to. Pull the outermost object rather than failing the whole attempt on a
 * stray "Here you go:".
 */
export function extractJson(text: string): unknown {
  const t = text.trim()
  if (!t) return undefined
  try { return JSON.parse(t) } catch { /* fall through */ }

  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  if (fence?.[1]) {
    try { return JSON.parse(fence[1].trim()) } catch { /* fall through */ }
  }

  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch { /* fall through */ }
  }
  return undefined
}

/**
 * Did the run actually execute on what we asked for?
 *
 * The rule is that the requested model must be PRESENT among the models the
 * run billed — not that it was the only one. A real Claude Code run bills a
 * small auxiliary model alongside the main one for its own internal work, and
 * an earlier version of this check demanded every observed model match, so a
 * perfectly good Opus run was rejected as drift because Haiku appeared next to
 * it. That false positive stopped a whole arc.
 *
 * The failure that matters is the opposite one: asking for Opus and finding
 * Opus nowhere in the record.
 *
 * Returns 'unverified' when nothing can be read — the caller records that
 * rather than a pass. Silence is not agreement.
 */
export function checkModel(
  requested: string, observed: string[], verified: boolean,
  /**
   * The two lanes report different things and need different rules.
   *
   * claude's `modelUsage` includes small models the harness bills for its OWN
   * internal work, so the requested model being PRESENT is the right test.
   *
   * codex's rollout records `turn_context.model` per turn, so a second model
   * there is not a helper — the session genuinely changed model mid-run, which
   * is exactly the silent downgrade we are watching for. Every entry must match.
   */
  mode: 'present' | 'every' = 'present',
  /**
   * Per-model receipts, when the run reported them. Presence answers "was it
   * billed"; only the counters answer "did it do the work" — and a session can
   * switch models part-way and finish on the substitute, which leaves the
   * requested model present while another one writes the actual output.
   */
  usage: ProviderUsage[] = [],
): 'ok' | 'drift' | 'unverified' {
  if (!verified || observed.length === 0) return 'unverified'
  if (mode === 'every') return observed.every((m) => sameModel(requested, m)) ? 'ok' : 'drift'
  if (!observed.some((m) => sameModel(requested, m))) return 'drift'

  let requestedOutput = 0
  let otherOutput = 0
  for (const row of usage) {
    if (row.model === undefined || row.outputTokens === undefined) continue
    if (sameModel(requested, row.model)) requestedOutput += row.outputTokens
    else otherOutput += row.outputTokens
  }
  return otherOutput > requestedOutput ? 'drift' : 'ok'
}

/** Which rule applies to a given CLI. */
export function modelCheckMode(cli: 'codex' | 'claude'): 'present' | 'every' {
  return cli === 'codex' ? 'every' : 'present'
}

/** Version digits, ignoring a trailing date stamp: `claude-opus-4-8-20260115`
 *  IS `claude-opus-4-8`, but `gpt-5.6-sol` is NOT `gpt-5`. */
function versionDigits(s: string): string[] {
  return (s.match(/\d+/g) ?? []).filter((d) => d.length < 6)
}

/** `opus` is an alias for "the latest Opus", so this is a family match. */
export function sameModel(requested: string, observed: string): boolean {
  // Version digits decide FIRST. The substring test below is what makes `opus`
  // an alias, but it also makes `gpt-5` match `gpt-5.6-sol` — so a run that
  // executed on 5.6 reported ok against a request pinned to 5, which is exactly
  // the silent version downgrade drift detection exists to catch.
  const rd = versionDigits(requested)
  const od = versionDigits(observed)
  if (rd.length > 0 && od.length > 0 && rd.join('.') !== od.join('.')) return false
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '')
  const r = norm(requested)
  const o = norm(observed)
  if (o.includes(r) || r.includes(o)) return true
  // Compare the DISTINGUISHING word, which is the last one: `gpt-5.6-sol` and
  // `gpt-5.6-luna` share their prefix and are different models, so matching on
  // the first token would call a luna run an ok sol run.
  const variant = (s: string) =>
    s.toLowerCase().split(/[-_.]/).filter((w) => w.length > 2 && /^[a-z]+$/.test(w)).pop()
  const rv = variant(requested)
  const ov = variant(observed)
  return Boolean(rv && ov && rv === ov)
}

/** Models billed that were NOT what we asked for — worth showing, not fatal. */
export function auxiliaryModels(requested: string, observed: string[]): string[] {
  return observed.filter((m) => !sameModel(requested, m))
}

export interface CapacityFailure {
  kind: 'model-substitution' | 'rate-limit'
  observed?: string
  errorClass?: string
}

/** Claude Code may silently serve a cheaper family when the requested pool is
 *  exhausted. This names only the substitutions observed in that provider;
 *  every other mismatch remains ordinary model drift and fails closed. */
export function capacityFailure(
  result: Pick<DispatchResult, 'terminalReason' | 'observedModels' | 'errorText'>,
  cli: 'codex' | 'claude',
  requested: string,
): CapacityFailure | null {
  // A dispatch that ended 'ok' is evidence about the work; stderr retry noise
  // carrying a rate-limit signature must never turn a success into weather.
  if (result.terminalReason === 'ok') return null
  if (cli === 'claude' && /(?:opus|fable)/i.test(requested)) {
    const observed = result.observedModels.find((model) => /(?:haiku|sonnet)/i.test(model))
    if (observed && !result.observedModels.some((model) => sameModel(requested, model))) {
      return { kind: 'model-substitution', observed }
    }
  }
  const error = result.errorText ?? ''
  if (/(?:\b429\b|rate[ -]?limit|usage[ -]?limit|overloaded)/i.test(error)) {
    const signature = error.match(/\b429\b/i) ? '429'
      : error.match(/rate[ -]?limit/i) ? 'rate-limit'
        : error.match(/usage[ -]?limit/i) ? 'usage-limit' : 'overloaded'
    return { kind: 'rate-limit', errorClass: signature }
  }
  return null
}
