/**
 * Turn raw provider stream events into one line a person can read.
 *
 * The live detail rows used to print event kinds verbatim — "system",
 * "result" — which told the operator nothing (first dogfood run). Returns
 * null for events with no human-relevant content; callers drop those.
 */

const MAX_LINE = 88

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one
}

function claudeToolLine(name: string, input: Record<string, unknown>): string {
  const target =
    typeof input.file_path === 'string' ? input.file_path :
    typeof input.path === 'string' ? input.path :
    typeof input.pattern === 'string' ? input.pattern :
    typeof input.command === 'string' ? input.command :
    typeof input.description === 'string' ? input.description : ''
  return clip(`Opus · ${name}${target ? ` ${target}` : ''}`)
}

export function describeEvent(event: { kind: string; payload: unknown }): string | null {
  const d = event.payload as Record<string, any> | undefined
  if (!d) return null

  // ---- claude stream-json ----
  if (event.kind === 'assistant') {
    const content = d.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          return claudeToolLine(block.name, block.input ?? {})
        }
      }
      const text = content.find((block: any) => block?.type === 'text' && typeof block.text === 'string')
      if (text) return clip(`Opus · ${text.text}`)
    }
    return null
  }

  // ---- codex JSONL ----
  if (event.kind === 'item.started' || event.kind === 'item.completed') {
    const item = d.item
    if (!item) return null
    const done = event.kind === 'item.completed'
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      const command = item.command.replace(/^\/bin\/\w+ -lc\s*/, '').replace(/^['"]|['"]$/g, '')
      return clip(`Sol ${done ? 'ran' : 'runs'} ${command}`)
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const paths = item.changes
        .map((change: any) => String(change?.path ?? '').split('/').pop())
        .filter(Boolean)
        .slice(0, 3)
      if (paths.length) return clip(`Sol ${done ? 'edited' : 'edits'} ${paths.join(', ')}`)
    }
    if (item.type === 'agent_message' && !done && typeof item.text === 'string') {
      return clip(`Sol · ${item.text}`)
    }
    if (item.type === 'reasoning' && !done) return 'Sol is thinking'
    return null
  }

  // Lifecycle noise: inits, results, turn bookkeeping. The step/summary lines
  // already carry those outcomes.
  return null
}
