import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ProjectConfig } from './types.ts'
import type { Lane } from './workflow.ts'
import { Lane as LaneSchema, builtInWorkflow } from './workflow.ts'
import { compileThreadContext, type CompiledThreadContext, type ContextArtifact } from './context.ts'
import { Store } from './store.ts'

// The agreement is Tier-0 prompt material. Both sides of the JSON round-trip
// are validated: a malformed row must throw loudly, never render
// "[undefined] undefined" into the most protected part of a prompt.
const AgreementConstraint = z.object({ text: z.string(), hardness: z.enum(['MUST', 'SHOULD']) })
const AgreementDecision = z.object({
  id: z.string(), question: z.string(), chosen: z.string(),
  rationale: z.string().optional(), rejected: z.array(z.string()).optional(),
})

/**
 * UI-facing application boundary. Ink and future remote clients talk to this
 * object, not to SQLite or provider processes. It deliberately contains no
 * conversation memory: every view is reconstructed from durable rows.
 */
export class ArcService {
  constructor(readonly store: Store, readonly config: ProjectConfig) {}

  createThread(title: string, lane: Lane = 'chat'): string {
    return this.store.createThread({ repo: this.config.repo, title, lane })
  }

  listThreads(includeArchived = false): Array<Record<string, any>> {
    return this.store.threadsForRepo(this.config.repo, includeArchived)
  }

  threadView(threadId: string): { id: string; title: string; lane: Lane; laneSource: 'user' | 'auto'; status: string } | undefined {
    const row = this.store.getThread(threadId)
    if (!row || row.repo !== this.config.repo) return undefined
    return {
      id: String(row.id), title: String(row.title), lane: LaneSchema.parse(row.lane),
      laneSource: row.lane_source === 'user' ? 'user' : 'auto', status: String(row.status),
    }
  }

  chooseThread(threadId?: string): string {
    if (threadId) {
      const found = this.store.getThread(threadId)
      if (!found || found.repo !== this.config.repo) throw new Error(`thread "${threadId}" is not in this repo`)
      return threadId
    }
    return String(this.listThreads()[0]?.id ?? this.createThread('New thread'))
  }

  resolveThread(reference: string): string {
    const needle = reference.trim()
    if (!needle) throw new Error('Usage: /thread <id-prefix|title>')
    const lower = needle.toLowerCase()
    const matches = this.listThreads().filter((row) =>
      String(row.id) === needle || String(row.id).startsWith(needle) || String(row.title).toLowerCase() === lower,
    )
    if (matches.length === 0) throw new Error(`No active thread matches “${needle}”.`)
    if (matches.length > 1) throw new Error(`“${needle}” matches more than one thread; use a longer id prefix.`)
    return String(matches[0]!.id)
  }

  renameThread(threadId: string, title: string): void {
    this.chooseThread(threadId)
    this.store.renameThread(threadId, title)
  }

  forkThread(threadId: string, title: string): string {
    this.chooseThread(threadId)
    return this.store.forkThread(threadId, title)
  }

  archiveThread(threadId: string): string {
    this.chooseThread(threadId)
    this.store.archiveThread(threadId)
    return this.chooseThread()
  }

  steer(threadId: string, text: string, arcId?: string): string {
    this.chooseThread(threadId)
    return this.store.addIntervention({ threadId, arcId, kind: 'steer', text })
  }

  appendMessage(threadId: string, role: 'user' | 'assistant' | 'system', text: string): string {
    return this.store.appendThreadMessage(threadId, role, text)
  }

  setAgreement(threadId: string, agreement: {
    goal: string
    constraints?: Array<{ text: string; hardness: 'MUST' | 'SHOULD' }>
    decisions?: Array<{ id: string; question: string; chosen: string; rationale?: string; rejected?: string[] }>
  }): number {
    return this.store.setThreadAgreement(threadId, {
      goal: agreement.goal,
      constraints: agreement.constraints?.map((c) => AgreementConstraint.parse(c)),
      decisions: agreement.decisions?.map((d) => AgreementDecision.parse(d)),
    })
  }

  /**
   * 'user' locks the lane: automatic routing may no longer change it. 'auto'
   * is the triage write-back, which the store refuses on a user-locked thread.
   */
  setLane(threadId: string, lane: Lane, source: 'user' | 'auto' = 'auto'): void {
    const parsed = LaneSchema.parse(lane)
    if (source === 'user') this.store.setThreadLane(threadId, parsed, 'user')
    else this.store.setThreadLaneIfAuto(threadId, parsed)
  }

  /** Hand routing back to triage without changing the current lane. */
  unlockLane(threadId: string): void {
    const thread = this.threadView(threadId)
    if (!thread) throw new Error(`thread "${threadId}" is not in this repo`)
    this.store.setThreadLane(threadId, thread.lane, 'auto')
  }

  workflowFor(threadId: string) {
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`thread "${threadId}" does not exist`)
    return builtInWorkflow(LaneSchema.parse(thread.lane))
  }

  compileContext(threadId: string, query: string, options: {
    artifacts?: ContextArtifact[]
    provider?: string
    model?: string
    budgetBytes?: number
  } = {}): CompiledThreadContext & { snapshotId: string } {
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`thread "${threadId}" does not exist`)
    const agreement = this.store.latestThreadAgreement(threadId)
    const messages = this.store.threadMessages(threadId).map((row) => ({
      id: String(row.id),
      role: row.role as 'user' | 'assistant' | 'system',
      text: String(row.text),
      at: Number(row.created_at),
    }))
    const constraints = agreement
      ? z.array(AgreementConstraint).parse(JSON.parse(String(agreement.constraints_json)))
      : []
    const decisions = agreement
      ? z.array(AgreementDecision).parse(JSON.parse(String(agreement.decisions_json)))
      : []
    const compiled = compileThreadContext({
      goal: agreement ? String(agreement.goal) : undefined,
      constraints,
      decisions,
      messages,
      artifacts: options.artifacts,
      query,
      budgetBytes: options.budgetBytes,
    })
    const snapshotId = this.store.saveThreadContextSnapshot({
      threadId, provider: options.provider, model: options.model,
      text: compiled.text, bytes: compiled.bytes,
      includedMessageIds: compiled.includedMessageIds,
      includedArtifactIds: compiled.includedArtifactIds,
      omitted: compiled.omitted,
    })
    return { ...compiled, snapshotId }
  }

  /**
   * The ONE context seam for provider dispatch. Compiles the thread's durable
   * agreement + dialogue into a header the caller prepends to its prompt, and
   * snapshots exactly what was compiled. Empty header when the thread holds
   * nothing durable yet — a fresh thread costs nothing.
   */
  compileDispatchEnvelope(threadId: string, query: string, options: {
    provider?: string
    model?: string
    budgetBytes?: number
  } = {}): { header: string; snapshotId: string; omitted: string[] } {
    const compiled = this.compileContext(threadId, query, { ...options, budgetBytes: options.budgetBytes ?? 24_000 })
    if (!compiled.text.trim()) return { header: '', snapshotId: compiled.snapshotId, omitted: compiled.omitted }
    const header = [
      '# THREAD CONTEXT — durable, compiled from stored rows, never from a provider session',
      '',
      compiled.text,
    ].join('\n')
    return { header, snapshotId: compiled.snapshotId, omitted: compiled.omitted }
  }

  /** Evidence views are read from artifacts, never trusted from an agent's prose. */
  readArtifact(id: string): string | undefined {
    const path = this.store.artifactPath(id)
    return path ? readFileSync(path, 'utf8') : undefined
  }
}

export type ThreadCommandResult = { text: string; threadId: string; quit?: false }

/** Local thread controls. They never spend a model turn. */
export function runThreadCommand(
  input: string,
  service: ArcService,
  currentThreadId: string,
  currentArcId?: string,
): ThreadCommandResult | null {
  const [command, ...rest] = input.trim().split(/\s+/)
  if (!command) return null
  const arg = rest.join(' ').trim()
  if (!['/threads', '/thread', '/new', '/rename', '/fork', '/archive', '/lane', '/steer'].includes(command)) return null

  if (command === '/steer') {
    if (!arg) return { threadId: currentThreadId, text: 'Usage: /steer <guidance for the next agent dispatch>' }
    service.steer(currentThreadId, arg, currentArcId)
    return {
      threadId: currentThreadId,
      text: currentArcId
        ? 'Steering recorded. The next task brief will include it at the durable agreement tier.'
        : 'Steering recorded on this thread. The next deep or direct run here will carry it.',
    }
  }

  if (command === '/threads') {
    const rows = service.listThreads()
    return {
      threadId: currentThreadId,
      text: rows.length
        ? rows.map((row) => `${row.id === currentThreadId ? '●' : '○'} ${String(row.id).slice(0, 8)} · ${row.lane} · ${row.title}`).join('\n')
        : 'No active threads.',
    }
  }
  if (command === '/thread') {
    try {
      const id = service.resolveThread(arg)
      const thread = service.threadView(id)!
      return { threadId: id, text: `Switched to ${thread.title} · ${thread.lane} · ${id.slice(0, 8)}` }
    } catch (error) {
      return { threadId: currentThreadId, text: (error as Error).message }
    }
  }
  if (command === '/new') {
    const id = service.createThread(arg || 'New thread')
    return { threadId: id, text: `Created and switched to thread ${id}: ${arg || 'New thread'}` }
  }
  if (command === '/rename') {
    if (!arg) return { threadId: currentThreadId, text: 'Usage: /rename <title>' }
    service.renameThread(currentThreadId, arg)
    return { threadId: currentThreadId, text: `Renamed this thread to “${arg}”.` }
  }
  if (command === '/fork') {
    const id = service.forkThread(currentThreadId, arg || 'Fork')
    return { threadId: id, text: `Forked and switched to thread ${id}: ${arg || 'Fork'}` }
  }
  if (command === '/archive') {
    const id = service.archiveThread(currentThreadId)
    return { threadId: id, text: `Archived the previous thread and switched to ${id}.` }
  }
  if (arg === 'auto') {
    service.unlockLane(currentThreadId)
    return { threadId: currentThreadId, text: 'Routing is automatic again — triage picks this thread’s lane per request.' }
  }
  const parsed = LaneSchema.safeParse(arg)
  if (!parsed.success) {
    return { threadId: currentThreadId, text: 'Usage: /lane chat|direct|research|plan|review|deep|auto' }
  }
  service.setLane(currentThreadId, parsed.data, 'user')
  return { threadId: currentThreadId, text: `This thread is locked to the ${parsed.data} lane. /lane auto hands routing back to triage.` }
}
