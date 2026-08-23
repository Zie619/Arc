import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ProjectConfig, type GateDef } from './types.ts'
import { git, gitOk } from './git.ts'

/**
 * Work out the project from where you are standing.
 *
 * You should be able to cd into a repo and type `arc`. Writing a config file
 * before you can try something is the friction that stops people trying it.
 * An explicit `arc.yaml` always wins; this is what happens when there isn't one.
 */

export interface Detected {
  config: ProjectConfig
  source: 'arc.yaml' | 'detected'
  notes: string[]
}

const CONFIG_NAMES = ['arc.yaml', 'arc.yml', '.arc.yaml', 'project.yaml']

/**
 * Thrown when we are not in a repo but there are repos NEARBY.
 *
 * A folder that CONTAINS your repos is a completely reasonable place to type
 * `arc` from — `~/gambit` holds openflow and arc-executor. Erroring out there
 * is technically correct and useless; the candidates travel with the error so
 * the caller can just ask which one.
 */
export class NoRepoHere extends Error {
  readonly candidates: string[]
  constructor(cwd: string, candidates: string[]) {
    super(
      candidates.length > 0
        ? `${cwd} is not a git repository, but it contains ${candidates.length}:\n` +
          candidates.map((c) => `  ${c}`).join('\n')
        : `${cwd} is not inside a git repository, and none were found below it.\n` +
          `arc works on a git repo — it needs branches and worktrees to keep agents apart.`,
    )
    this.candidates = candidates
  }
}

/**
 * Git repositories directly below `dir`.
 *
 * Only two levels deep, and only real repos: a git WORKTREE has a `.git` file
 * rather than a directory, which is how the `_wt-*` scratch worktrees sitting
 * beside these repos are excluded — offering someone a worktree as their
 * project would be actively wrong.
 */
export function findRepos(dir: string, depth = 2): string[] {
  const out: string[] = []
  const walk = (d: string, left: number) => {
    if (left < 0) return
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue
      const p = join(d, e)
      try { if (!statSync(p).isDirectory()) continue } catch { continue }
      const dotgit = join(p, '.git')
      let isRepo = false
      try { isRepo = statSync(dotgit).isDirectory() } catch { /* not a repo */ }
      if (isRepo) { out.push(p); continue }   // do not descend into a repo
      walk(p, left - 1)
    }
  }
  walk(dir, depth - 1)
  return out.sort()
}

export function detectProject(cwd: string, repoOverride?: string): Detected {
  const repo = repoOverride ? repoRoot(repoOverride) : repoRoot(cwd)
  const notes: string[] = []

  for (const name of CONFIG_NAMES) {
    const p = join(repo, name)
    if (!existsSync(p)) continue
    const parsed = ProjectConfig.safeParse(parseYaml(readFileSync(p, 'utf8')))
    if (parsed.success) {
      const notes = [`config: ${name}`]
      // A config file whose `repo:` points somewhere else entirely is almost
      // always a stale copy, and following it silently would run the arc
      // against the WRONG repository.
      const target = git(parsed.data.repo, 'rev-parse', '--show-toplevel')
      if (target !== repo) {
        throw new Error(
          `${p} says repo: ${parsed.data.repo}\n` +
          `but you are in ${repo}.\n` +
          `That config belongs to another project — running it here would edit the wrong repo.\n` +
          `Fix the repo: line, delete the file, or pass --config explicitly.`,
        )
      }
      return { config: parsed.data, source: 'arc.yaml', notes }
    }
    throw new Error(`${p} is invalid:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`)
  }

  const pm = packageManager(repo)
  const gates = detectGates(repo, pm, notes)
  const mainBranch = detectMainBranch(repo)
  // A repo with a remote almost certainly protects its main branch, so default
  // to a PR. Pushing straight at a protected branch just fails at the very end.
  const hasRemote = gitOk(repo, 'remote', 'get-url', 'origin')

  notes.push(`repo: ${repo}`)
  notes.push(`main branch: ${mainBranch}`)
  notes.push(`landing: ${hasRemote ? 'pull request' : 'left on its own branch (no origin remote)'}`)

  const config = ProjectConfig.parse({
    name: repo.split('/').pop() || 'project',
    repo,
    mainBranch,
    // No remote means no PR is possible, and quietly merging into main is not
    // a decision to make on someone's behalf. Stop at the branch and say so.
    landStrategy: hasRemote ? 'pr' : 'none',
    gates,
    // A fresh worktree has no dependencies; every gate and proof command
    // fails environmentally without an install pass.
    setupCommand: existsSync(join(repo, 'package.json'))
      ? { pnpm: 'pnpm install --prefer-offline --silent',
          yarn: 'yarn install --silent',
          bun: 'bun install --silent',
          npm: 'npm install --no-audit --no-fund --silent' }[pm]
      : undefined,
    roles: {
      head:      { cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only',
                   tools: 'Read,Grep,Glob', timeoutMs: 2_400_000, stallMs: 300_000 },
      // Fast on purpose: this runs on every single thing you type.
      triage:    { cli: 'claude', model: 'haiku', effort: 'low', sandbox: 'read-only',
                   tools: 'Read,Grep,Glob', timeoutMs: 120_000, stallMs: 60_000 },
      implement: { cli: 'codex', model: 'gpt-5.6-sol', effort: 'high', sandbox: 'workspace-write',
                   timeoutMs: 2_700_000, stallMs: 420_000 },
      review:    { cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only',
                   tools: 'Read,Grep,Glob,Bash(git *)', timeoutMs: 1_800_000, stallMs: 300_000 },
      scout:     { cli: 'codex', model: 'gpt-5.6-sol', effort: 'medium', sandbox: 'read-only',
                   timeoutMs: 900_000, stallMs: 240_000 },
      integrate: { cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only',
                   tools: 'Read,Grep,Glob,Bash(git *)', timeoutMs: 2_400_000, stallMs: 300_000 },
    },
  })

  return { config, source: 'detected', notes }
}

function repoRoot(cwd: string): string {
  try {
    return git(cwd, 'rev-parse', '--show-toplevel')
  } catch {
    throw new NoRepoHere(cwd, findRepos(cwd))
  }
}

function detectMainBranch(repo: string): string {
  for (const b of ['main', 'master', 'trunk']) {
    if (gitOk(repo, 'rev-parse', '--verify', `${b}^{commit}`)) return b
  }
  // Fall back to whatever is checked out rather than inventing a branch. On a
  // repo with no commits yet HEAD is unborn and rev-parse fails, so name the
  // conventional default and let the run report the real problem (no base
  // commit) rather than dying here with a git error nobody can act on.
  try { return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') } catch { return 'main' }
}

function packageManager(repo: string): string {
  if (existsSync(join(repo, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(repo, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(repo, 'bun.lockb'))) return 'bun'
  return 'npm'
}

/**
 * Use the project's OWN scripts as gates.
 *
 * Never hand-roll an equivalent command: a reconstructed pipeline drifts from
 * what actually gates a merge, and then a gate passes while CI fails.
 */
function detectGates(repo: string, pm: string, notes: string[]): GateDef[] {
  const pkgPath = join(repo, 'package.json')
  if (!existsSync(pkgPath)) {
    notes.push('no package.json — no gates detected; add some to arc.yaml or nothing verifies the work')
    return []
  }

  let scripts: Record<string, string> = {}
  try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {} } catch { /* ignore */ }

  const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`)
  const gates: GateDef[] = []

  if (scripts.typecheck) {
    gates.push(GateOf('typecheck', `NODE_OPTIONS=--max-old-space-size=8192 ${run('typecheck')}`,
      'types are sound', { baselineSubset: true, timeoutMs: 900_000 }))
  } else if (scripts.tsc) {
    gates.push(GateOf('typecheck', run('tsc'), 'types are sound', { baselineSubset: true }))
  }

  if (scripts.test) {
    // Suites drift by a few files between runs, so compare as a SUBSET of the
    // baseline rather than demanding equality — otherwise ordinary flake reads
    // as "this task broke the tests".
    gates.push(GateOf('test', run('test'), 'the test suite does not regress',
      { baselineSubset: true, timeoutMs: 1_200_000 }))
  }

  if (scripts.build) {
    gates.push(GateOf('build', run('build'), 'the project builds exactly as CI builds it',
      { heavy: true, timeoutMs: 2_400_000 }))
  }

  if (gates.length === 0) notes.push('package.json has no typecheck/test/build script — nothing will verify the work')
  else notes.push(`gates: ${gates.map((g) => g.name).join(', ')} (via ${pm})`)

  return gates
}

function GateOf(name: string, command: string, proves: string, over: Partial<GateDef> = {}): GateDef {
  return GateDefaults({ name, command, proves, ...over })
}

function GateDefaults(g: Partial<GateDef> & { name: string; command: string; proves: string }): GateDef {
  return {
    cwd: '.', timeoutMs: 20 * 60_000, heavy: false, baselineSubset: false, ...g,
  }
}

/** What we would write to arc.yaml, so a detected setup can be made explicit. */
export function toYamlConfig(c: ProjectConfig): unknown {
  return {
    name: c.name, repo: c.repo, mainBranch: c.mainBranch, landStrategy: c.landStrategy,
    agentConcurrency: c.agentConcurrency, heavyGateLimit: c.heavyGateLimit,
    maxAttempts: c.maxAttempts, maxTaskMinutes: c.maxTaskMinutes,
    roles: c.roles, gates: c.gates,
  }
}
