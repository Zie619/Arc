import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

export interface CodexLimitsSnapshot {
  usedPercent: number
  windowMinutes: number
  resetsAt: Date
  observedAt: Date
}

interface RolloutFile {
  path: string
  mtimeMs: number
  mtime: Date
}

export function codexLimitsSnapshot(): CodexLimitsSnapshot | null {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const root = join(home, 'sessions')

  try {
    const rollouts: RolloutFile[] = []
    findRollouts(root, 0, rollouts)
    if (rollouts.length === 0) return null

    rollouts.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const newest = rollouts[rollouts.length - 1]
    if (!newest) return null

    let snapshot: CodexLimitsSnapshot | null = null
    for (const line of readFileSync(newest.path, 'utf8').split('\n')) {
      if (line.length === 0 || !line.startsWith('{')) continue

      let event: unknown
      try { event = JSON.parse(line) } catch { continue }

      const primary = rateLimitsPrimary(event)
      if (!primary) continue

      const resetsAt = new Date(primary.resets_at * 1000)
      if (!Number.isFinite(resetsAt.getTime())) continue
      snapshot = {
        usedPercent: primary.used_percent,
        windowMinutes: primary.window_minutes,
        resetsAt,
        observedAt: newest.mtime,
      }
    }
    return snapshot
  } catch {
    return null
  }
}

function findRollouts(dir: string, depth: number, found: RolloutFile[]): void {
  if (depth > 5) return

  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      findRollouts(path, depth + 1, found)
    } else if (stat.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) {
      found.push({ path, mtimeMs: stat.mtimeMs, mtime: stat.mtime })
    }
  }
}

function rateLimitsPrimary(event: unknown): {
  used_percent: number
  window_minutes: number
  resets_at: number
} | null {
  if (typeof event !== 'object' || event === null) return null

  const payload = (event as Record<string, unknown>).payload
  if (typeof payload !== 'object' || payload === null) return null

  const rateLimits = (payload as Record<string, unknown>).rate_limits
  if (typeof rateLimits !== 'object' || rateLimits === null) return null

  const primary = (rateLimits as Record<string, unknown>).primary
  if (typeof primary !== 'object' || primary === null) return null

  const values = primary as Record<string, unknown>
  if (
    typeof values.used_percent !== 'number' || !Number.isFinite(values.used_percent)
    || typeof values.window_minutes !== 'number' || !Number.isFinite(values.window_minutes)
    || typeof values.resets_at !== 'number' || !Number.isFinite(values.resets_at)
  ) return null

  return {
    used_percent: values.used_percent,
    window_minutes: values.window_minutes,
    resets_at: values.resets_at,
  }
}
