import { ProjectConfig } from './types.ts'

/**
 * `arc config` — the effective configuration, and where every value came from.
 *
 * The question is always "why is it doing that?", and answering it used to mean
 * reading arc.yaml, then the detection in autoconfig.ts, then the zod defaults
 * in types.ts, and holding all three in your head at once. A value someone
 * CHOSE and a value nobody ever thought about look identical in the running
 * system and lead to opposite next actions, so the origin is printed beside
 * every field instead of being left to be reconstructed.
 *
 * The defaults are derived by parsing a near-empty config, never listed here: a
 * second copy of the defaults would disagree with the schema the first time one
 * of them changed, and disagree silently — which is the exact failure this is
 * meant to end.
 */

/** name/repo/roles have no schema default, so the placeholders standing in for
 *  them must never compare equal to a real config's values. */
const UNMATCHABLE = '\u0000'

export function describeConfig(config: ProjectConfig, source: string, notes: string[]): string[] {
  const defaults = ProjectConfig.parse({
    name: UNMATCHABLE, repo: UNMATCHABLE,
    roles: { implement: { cli: 'codex', model: UNMATCHABLE } },
  }) as unknown as Record<string, unknown>
  const actual = config as unknown as Record<string, unknown>

  const lines: string[] = [`config: ${source}`]
  for (const note of notes) lines.push(`  ${note}`)
  lines.push('')

  // Schema order, not an order invented here — a field added to ProjectConfig
  // appears in this report without anyone remembering to come back and add it.
  for (const key of Object.keys(ProjectConfig.shape)) {
    const value = actual[key]
    // A value equal to the default is reported as `default` even when arc.yaml
    // states it outright: the file is not diffed key by key, and the behaviour
    // is identical either way. What this column answers is "does this differ
    // from what you would have got anyway", which is the question being asked.
    const from = same(value, defaults[key]) ? 'default' : source
    lines.push(`  ${key.padEnd(20)} ${`(${from})`.padEnd(11)} ${render(value)}`)
  }

  // Gates and roles are the two fields a one-line summary cannot settle: a gate
  // is worth exactly what it PROVES, and a role whose model you cannot see is
  // the one quietly spending the money.
  if (config.gates.length > 0) {
    lines.push('')
    for (const g of config.gates) {
      lines.push(`  gate ${g.name.padEnd(15)} ${g.command}${g.heavy ? '  [heavy]' : ''}`)
      lines.push(`  ${' '.repeat(20)} proves: ${g.proves}`)
    }
  }
  lines.push('')
  for (const [role, binding] of Object.entries(config.roles)) {
    if (!binding) continue
    lines.push(`  role ${role.padEnd(15)} ${binding.cli} ${binding.model}  effort=${binding.effort}  sandbox=${binding.sandbox}`)
  }

  const gaps = findGaps(config)
  if (gaps.length > 0) {
    lines.push('')
    for (const gap of gaps) lines.push(`! ${gap}`)
  }
  return lines
}

/**
 * Gaps, not a score. Both are the same fact stated at two strengths: nothing
 * here proves the property, so a green arc means only that the agents said so.
 * Anything subtler would be a taxonomy of my own invention printed as a finding.
 */
function findGaps(config: ProjectConfig): string[] {
  if (config.gates.length === 0) {
    return ['no gate proves anything — there are no gates, so nothing checks the work except the agent that did it']
  }
  const surface = config.gates.map((g) => `${g.name} ${g.proves}`).join(' ')
  if (!/test|spec|suite/i.test(surface)) {
    return ['no gate proves the tests pass — no gate name or `proves` line mentions tests']
  }
  return []
}

/** Key order is stable because both sides came out of the same zod schema. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function render(value: unknown): string {
  if (value === undefined || value === null) return 'unset'
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(label).join(', ')
  // Records (capabilities) and nested objects (roles): the keys are what you
  // scan for, and the detail blocks carry the rest.
  if (typeof value === 'object') return Object.keys(value).join(', ') || 'none'
  return String(value)
}

function label(item: unknown): string {
  if (item && typeof item === 'object') return String((item as { name?: unknown }).name ?? JSON.stringify(item))
  return String(item)
}
