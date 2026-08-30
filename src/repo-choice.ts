import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Which repo you picked last time you ran arc from this directory.
 *
 * The picker is correct — a folder that merely CONTAINS repos gives Arc nothing
 * to branch from — but asking the same question every time is not. `--repo`
 * always overrides, and a remembered answer that is no longer a candidate is
 * ignored rather than trusted.
 */
const CHOICE_FILE = (): string => join(process.env.HOME ?? '.', '.arc', 'repo-choice.json')

function readChoices(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(CHOICE_FILE(), 'utf8')) as Record<string, string>
  } catch { return {} }
}

export function rememberedRepo(cwd: string): string | undefined {
  return readChoices()[cwd]
}

export function rememberRepo(cwd: string, repo: string): void {
  try {
    mkdirSync(dirname(CHOICE_FILE()), { recursive: true })
    writeFileSync(CHOICE_FILE(), JSON.stringify({ ...readChoices(), [cwd]: repo }, null, 2))
  } catch { /* a remembered convenience is never worth failing a run over */ }
}

export function tilde(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}
