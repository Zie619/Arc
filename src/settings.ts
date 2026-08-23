import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig, RoleBinding, AgentRole } from './types.ts'
import type { ModeName } from './modes.ts'

/**
 * Choices you make while using it, kept separately from the project's config.
 *
 * `arc.yaml` is the project's committed setup. This is yours: which model runs
 * which role, at what effort, and which mode you were last in. Changing a model
 * from inside the app should not rewrite a file that belongs to the repo, and
 * two people on one project should not fight over each other's preferences.
 *
 * Stored beside the arc's own state, so deleting `~/.arc/<project>` genuinely
 * resets everything.
 */

export const RoleOverride = z.object({
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
})

export const Settings = z.object({
  mode: z.enum(['ask', 'auto', 'danger', 'plan']).default('ask'),
  /** Per-role overrides layered over whatever the project config says. */
  roles: z.record(z.string(), RoleOverride).default({}),
})
export type Settings = z.infer<typeof Settings>

const EMPTY: Settings = { mode: 'ask', roles: {} }

export function settingsPath(root: string): string {
  return join(root, 'settings.json')
}

export function loadSettings(root: string): Settings {
  const p = settingsPath(root)
  if (!existsSync(p)) return EMPTY
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(p, 'utf8')))
    // A corrupt settings file must never stop the tool starting. Preferences
    // are not worth a crash; fall back to defaults and carry on.
    return parsed.success ? parsed.data : EMPTY
  } catch { return EMPTY }
}

export function saveSettings(root: string, s: Settings): void {
  const p = settingsPath(root)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(s, null, 2))
}

export function setMode(root: string, mode: ModeName): Settings {
  const s = { ...loadSettings(root), mode }
  saveSettings(root, s)
  return s
}

export function setRole(root: string, role: string, over: z.infer<typeof RoleOverride>): Settings {
  const cur = loadSettings(root)
  const s: Settings = { ...cur, roles: { ...cur.roles, [role]: { ...cur.roles[role], ...over } } }
  saveSettings(root, s)
  return s
}

export function clearRole(root: string, role: string): Settings {
  const cur = loadSettings(root)
  const roles = { ...cur.roles }
  delete roles[role]
  const s: Settings = { ...cur, roles }
  saveSettings(root, s)
  return s
}

/**
 * Layer your choices over the project's config.
 *
 * Only model and effort can be overridden. The CLI, the sandbox and the tool
 * allowlist stay where the project put them: those are safety properties, and
 * a model picker is not the place to widen what an agent is allowed to touch.
 */
export function applySettings(config: ProjectConfig, s: Settings): ProjectConfig {
  const roles: Record<string, RoleBinding> = {}
  for (const [name, binding] of Object.entries(config.roles)) {
    if (!binding) continue
    const over = s.roles[name]
    roles[name] = over ? { ...binding, ...(over.model ? { model: over.model } : {}), ...(over.effort ? { effort: over.effort } : {}) } : binding
  }
  return { ...config, roles: roles as ProjectConfig['roles'] }
}

/** What the model picker offers, per CLI. Aliases first — they never go stale. */
export const KNOWN_MODELS: Record<'codex' | 'claude', string[]> = {
  // `codex` needs explicit ids; there are no "latest" aliases.
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  // These are aliases for "the latest of that family", so a new model ships and
  // is usable here with no change. Prefer them to pinned ids.
  claude: ['opus', 'sonnet', 'haiku'],
}

/** Roles a person would sensibly want to re-point, in the order they matter. */
export const TUNABLE_ROLES: AgentRole[] = ['head', 'implement', 'review', 'scout', 'integrate', 'triage']
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function describeRole(config: ProjectConfig, s: Settings, role: AgentRole): string {
  const merged = applySettings(config, s).roles[role]
  if (!merged) return 'not configured'
  const over = s.roles[role]
  const changed = over?.model || over?.effort ? ' *' : ''
  return `${merged.cli}/${merged.model} · ${merged.effort} effort${changed}`
}
