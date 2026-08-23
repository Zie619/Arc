/**
 * Context for durable conversational threads.
 *
 * Provider sessions are a latency cache. This compiler is the recovery path:
 * a restarted Claude/Codex process can be given the same formal agreement,
 * recent dialogue, and relevant older evidence without trusting compaction.
 */

export interface DurableMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
}

export interface ContextArtifact {
  id: string
  kind: string
  text: string
  tags?: string[]
  at: number
}

export interface ContextDecision {
  id: string
  question: string
  chosen: string
  rationale?: string
  rejected?: string[]
}

export interface ThreadContextInput {
  goal?: string
  constraints?: Array<{ text: string; hardness: 'MUST' | 'SHOULD' }>
  decisions?: ContextDecision[]
  messages: DurableMessage[]
  artifacts?: ContextArtifact[]
  query: string
  budgetBytes?: number
  recentMessages?: number
}

export interface CompiledThreadContext {
  text: string
  bytes: number
  includedMessageIds: string[]
  includedArtifactIds: string[]
  omitted: string[]
}

function terms(text: string): Set<string> {
  // Unicode-aware: an ASCII-only pattern made every non-Latin query score
  // zero, which silently emptied the whole retrieval tier.
  return new Set(
    text.toLowerCase().match(/[\p{L}\p{N}_./-]{2,}/gu)?.filter((word) => !STOP.has(word)) ?? [],
  )
}

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'what', 'when',
  'where', 'should', 'would', 'could', 'have', 'has', 'was', 'were', 'your',
])

function score(text: string, queryTerms: Set<string>): number {
  let n = 0
  const own = terms(text)
  for (const term of queryTerms) if (own.has(term)) n++
  return n
}

export function compileThreadContext(input: ThreadContextInput): CompiledThreadContext {
  const budget = input.budgetBytes ?? 64_000
  const recentCount = input.recentMessages ?? 12
  const omitted: string[] = []
  const messageIds: string[] = []
  const artifactIds: string[] = []
  const sections: string[] = []

  // Tier 0: the formal agreement is never summarized or silently truncated.
  const agreement: string[] = []
  if (input.goal) agreement.push('# ACTIVE GOAL — VERBATIM', input.goal)
  if (input.constraints?.length) {
    agreement.push('', '## Constraints', ...input.constraints.map((c) => `- [${c.hardness}] ${c.text}`))
  }
  if (input.decisions?.length) {
    agreement.push('', '## Settled decisions', ...input.decisions.map((d) => {
      const rejected = d.rejected?.length ? `; rejected: ${d.rejected.join(', ')}` : ''
      return `- ${d.question} → ${d.chosen}${d.rationale ? ` (${d.rationale})` : ''}${rejected}`
    }))
  }
  if (agreement.length) sections.push(agreement.join('\n'))

  let spent = Buffer.byteLength(sections.join('\n\n'))
  if (spent > budget) {
    throw new Error(`formal thread agreement is ${spent}B, larger than the ${budget}B context budget`)
  }

  const add = (label: string, block: string, id?: string, kind?: 'message' | 'artifact'): boolean => {
    const rendered = `${sections.length ? '\n\n' : ''}${label}\n${block}`
    const bytes = Buffer.byteLength(rendered)
    if (spent + bytes > budget) { omitted.push(id ? `${kind}:${id}` : label); return false }
    sections.push(`${label}\n${block}`)
    spent += bytes
    if (id && kind === 'message') messageIds.push(id)
    if (id && kind === 'artifact') artifactIds.push(id)
    return true
  }

  const ordered = [...input.messages].sort((a, b) => a.at - b.at)
  const recent = ordered.slice(-recentCount)
  const recentIds = new Set(recent.map((message) => message.id))
  let dialogueGaps = 0
  for (const message of recent) {
    if (!add(`## ${message.role} message`, message.text, message.id, 'message')) dialogueGaps++
  }
  if (dialogueGaps > 0) {
    // The model reading this prompt must see that the dialogue has holes —
    // an unmarked gap reads as a conversation that never happened.
    add('## note', `[${dialogueGaps} message(s) in this dialogue did not fit the context budget and are omitted]`)
  }

  const queryTerms = terms(input.query)
  const olderAll = ordered.filter((message) => !recentIds.has(message.id))
  const older = olderAll
    .map((message) => ({ message, score: score(message.text, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.message.at - a.message.at)
  for (const { message } of older) {
    add(`## Retrieved ${message.role} message`, message.text, message.id, 'message')
  }
  // "Scored zero" and "did not fit" are different absences; both are recorded
  // so a caller can tell retrieval-found-nothing from nothing-was-there.
  if (olderAll.length > older.length) {
    omitted.push(`retrieval:${olderAll.length - older.length} older message(s) scored 0 for this query`)
  }

  const artifactsAll = input.artifacts ?? []
  const artifacts = artifactsAll
    .map((artifact) => ({
      artifact,
      score: score(`${artifact.tags?.join(' ') ?? ''} ${artifact.text}`, queryTerms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.artifact.at - a.artifact.at)
  for (const { artifact } of artifacts) {
    add(`## Artifact ${artifact.kind} (${artifact.id})`, artifact.text, artifact.id, 'artifact')
  }
  if (artifactsAll.length > artifacts.length) {
    omitted.push(`retrieval:${artifactsAll.length - artifacts.length} artifact(s) scored 0 for this query`)
  }

  return {
    text: sections.join('\n\n'),
    bytes: Buffer.byteLength(sections.join('\n\n')),
    includedMessageIds: messageIds,
    includedArtifactIds: artifactIds,
    omitted,
  }
}
