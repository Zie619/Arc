import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every git call goes through one helper that THROWS on a non-zero exit.
 *
 * That is not fussiness: in the source material every single git-related
 * failure was an exit code that got swallowed — a failed `--ff-only` followed
 * by a push that says "Everything up-to-date", which reads exactly like
 * success. We never use a git wrapper library; we spawn git and check.
 */
export function git(repo: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Capture stderr rather than letting it inherit our terminal: probing
      // for a branch that does not exist is normal control flow, and leaking
      // `fatal: Needed a single revision` into the arc log reads like a crash.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string }
    const detail = err.stderr ? String(err.stderr).trim() : (err.message ?? '')
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
}

export function gitOk(repo: string, ...args: string[]): boolean {
  try { git(repo, ...args); return true } catch { return false }
}

export function headSha(repo: string): string {
  return git(repo, 'rev-parse', 'HEAD')
}

/**
 * TRACKED modifications only.
 *
 * The hazard this guards against is destroying work: `git checkout -- .` and
 * friends discard tracked edits irrecoverably. Untracked files carry no such
 * risk, and blocking an arc because a config file is sitting in the tree would
 * make the guard something people route around — which is worse than not
 * having it. Untracked files are reported separately as a warning.
 */
export function isClean(repo: string): boolean {
  return git(repo, 'status', '--porcelain', '--untracked-files=no').length === 0
}

export function dirtyFiles(repo: string): string[] {
  return git(repo, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean)
}

/** Stray untracked files can still break a build. Worth saying, not worth blocking. */
export function untrackedFiles(repo: string): string[] {
  const out = git(repo, 'ls-files', '--others', '--exclude-standard')
  return out ? out.split('\n').filter(Boolean) : []
}

export interface Worktree {
  path: string
  branch: string
  baseSha: string
}

/**
 * One worktree per task, at a PINNED base sha so every task in a wave branches
 * from the same commit instead of racing on whatever HEAD was at its launch
 * instant.
 *
 * FAILS CLOSED. outsourcerer, on a worktree failure, prints "running in the
 * normal checkout" and proceeds — which silently drops an agent into the
 * shared checkout beside the others and reaches the `git add -A` WIP-stealing
 * hazard automatically. There is no fallback here. If isolation cannot be
 * established, the task does not run.
 */
export function provisionWorktree(repo: string, root: string, taskId: string, baseSha: string): Worktree {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-')
  const path = join(root, 'worktrees', safe)
  const branch = `arc/${safe}`

  if (existsSync(path)) {
    // Reuse only if it is genuinely the branch we expect; otherwise refuse.
    const actual = gitOk(path, 'rev-parse', '--git-dir') ? git(path, 'rev-parse', '--abbrev-ref', 'HEAD') : null
    if (actual === branch) {
      const expectedBase = git(repo, 'rev-parse', `${baseSha}^{commit}`)
      const head = git(path, 'rev-parse', 'HEAD')
      if (expectedBase !== head) throw new Error(`worktree path ${path} expected "${expectedBase}", actual "${head}" — refusing to reuse`)
      return { path, branch, baseSha: head }
    }
    throw new Error(`worktree path ${path} exists but is on "${actual}", expected "${branch}" — refusing to reuse`)
  }

  if (gitOk(repo, 'rev-parse', '--verify', `${branch}^{commit}`)) {
    throw new Error(`branch ${branch} already exists — refusing to clobber; delete it or use a new task id`)
  }

  try {
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, baseSha)
  } catch (e) {
    throw new Error(
      `worktree isolation FAILED for ${taskId}: ${(e as Error).message}\n` +
      `Refusing to fall back to the shared checkout — parallel agents in one tree corrupt each other.`,
    )
  }
  return { path, branch, baseSha }
}

export function removeWorktree(repo: string, wt: string): void {
  gitOk(repo, 'worktree', 'remove', '--force', wt)
  gitOk(repo, 'worktree', 'prune')
}

/**
 * Tear down one task's isolation so it can be retried.
 *
 * Needed because provisionWorktree refuses to clobber an existing branch — the
 * right default, but it means a failed task could never be re-run without
 * manual git surgery. Resume and `arc clean` go through here instead.
 */
export function releaseTaskWorkspace(repo: string, root: string, taskId: string): void {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-')
  const path = join(root, 'worktrees', safe)
  const branch = `arc/${safe}`
  if (existsSync(path)) removeWorktree(repo, path)
  gitOk(repo, 'worktree', 'prune')
  gitOk(repo, 'branch', '-D', branch)
}

/** Every branch this arc created, for cleanup and for reporting. */
export function arcBranches(repo: string, arcId: string): string[] {
  const out = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/arc/')
  const all = out ? out.split('\n').filter(Boolean) : []
  return all.filter((b) =>
    b === `arc/${arcId}-integration` ||
    b === `arc/${arcId}-integration-review` ||
    (!b.endsWith('-integration') && !b.endsWith('-integration-review')))
}

/**
 * Push the integration branch and open a PR.
 *
 * A protected `main` requires (PR + green required), so an arc must NOT
 * push there directly. Tasks land locally onto the integration branch — fast,
 * no CI churn per task — and the whole arc arrives as ONE pull request at the
 * end, which is also the diff a human actually wants to read.
 */
export function openPullRequest(
  repo: string, branch: string, base: string, title: string, body: string,
): { ok: boolean; url: string; message: string } {
  try {
    git(repo, 'push', '-u', 'origin', `${branch}:refs/heads/${branch}`)
  } catch (e) {
    return { ok: false, url: '', message: `push failed: ${(e as Error).message}` }
  }
  try {
    const url = execFileSync('gh',
      ['pr', 'create', '--repo-root', repo, '--base', base, '--head', branch, '--title', title, '--body', body],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { ok: true, url, message: '' }
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string }
    const detail = err.stderr ? String(err.stderr).trim() : (err.message ?? '')
    // An existing PR for this branch is success, not failure.
    if (/already exists/i.test(detail)) {
      const existing = detail.match(/https:\/\/\S+/)?.[0] ?? ''
      return { ok: true, url: existing, message: 'PR already existed' }
    }
    return { ok: false, url: '', message: `gh pr create failed: ${detail.slice(0, 300)}` }
  }
}

/** Files the task ACTUALLY touched. Compared against the declared footprint;
 *  drift between the two is an incident, and it is the data that earns a real
 *  contract graph later instead of guessing at one now. */
export function measuredFootprint(wt: string, baseSha: string): string[] {
  const out = git(wt, 'diff', '--name-only', `${baseSha}...HEAD`)
  return out ? out.split('\n').filter(Boolean) : []
}

export function commitCount(wt: string, baseSha: string): number {
  const out = git(wt, 'rev-list', '--count', `${baseSha}..HEAD`)
  return Number(out) || 0
}

export function hasCommits(wt: string, baseSha: string): boolean {
  return commitCount(wt, baseSha) > 0
}

/** Stage by explicit path only. `git add -A` in a shared checkout sweeps another
 *  agent's work-in-progress into your commit. */
export function commitPaths(wt: string, paths: string[], message: string): string | null {
  if (paths.length === 0) return null
  for (const p of paths) git(wt, 'add', '--', p)
  const staged = git(wt, 'diff', '--cached', '--name-only')
  if (!staged) return null
  git(wt, 'commit', '-q', '-m', message)
  return headSha(wt)
}

export interface RebaseResult {
  ok: boolean
  conflictFiles: string[]
  message: string
  commitsBefore: number
  commitsAfter: number
}

/**
 * Rebase the task branch onto the integration head.
 *
 * Never auto-resolves. A blind `git rebase --skip` in the source material
 * dropped an entire session's commit and then reported `merged: true`. On
 * conflict we abort, name the files, and escalate. We also assert the commit
 * count survives — a rebase that silently loses a commit is the failure that
 * is hardest to notice afterwards.
 */
export function rebaseOnto(wt: string, baseSha: string, onto: string): RebaseResult {
  const before = commitCount(wt, baseSha)
  try {
    git(wt, 'rebase', onto)
  } catch (e) {
    let conflicts: string[] = []
    try {
      const u = git(wt, 'diff', '--name-only', '--diff-filter=U')
      conflicts = u ? u.split('\n').filter(Boolean) : []
    } catch { /* ignore */ }
    gitOk(wt, 'rebase', '--abort')
    return { ok: false, conflictFiles: conflicts, message: (e as Error).message.slice(0, 400), commitsBefore: before, commitsAfter: before }
  }
  const after = commitCount(wt, onto)
  if (after < before) {
    return {
      ok: false,
      conflictFiles: [],
      message: `rebase LOST commits: ${before} before, ${after} after — refusing to land`,
      commitsBefore: before,
      commitsAfter: after,
    }
  }
  return { ok: true, conflictFiles: [], message: '', commitsBefore: before, commitsAfter: after }
}

export interface LandResult {
  ok: boolean
  before: string
  after: string
  expected: string
  message: string
  /**
   * Landing checks out the integration branch in the operator's shared
   * checkout. If restoring their original branch then fails, the operator is
   * parked somewhere they did not choose — that must be loud, never swallowed.
   */
  restoreFailed: boolean
}

/**
 * Land, then ASSERT THE REF MOVED.
 *
 * Never trust a command's own report of success. The three-sha check is the
 * only thing that distinguishes "landed" from "the command exited 0 and
 * nothing happened".
 */
export function landBranch(repo: string, integrationBranch: string, taskBranch: string): LandResult {
  const before = git(repo, 'rev-parse', integrationBranch)
  const expected = git(repo, 'rev-parse', taskBranch)
  // Whatever branch you were on is yours. Landing must not move your working
  // tree out from under you — and when arc is editing its OWN repo, leaving it
  // parked on the integration branch is worse than untidy.
  const wasOn = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  const restore = (): boolean => wasOn === integrationBranch || gitOk(repo, 'checkout', '-q', wasOn)
  const parked = (restored: boolean): string =>
    restored ? '' : ` — AND the operator checkout is parked on "${integrationBranch}"; checkout back to "${wasOn}" failed`

  try {
    git(repo, 'checkout', '-q', integrationBranch)
    git(repo, 'merge', '--ff-only', taskBranch)
  } catch (e) {
    const restored = restore()
    return { ok: false, before, after: git(repo, 'rev-parse', integrationBranch), expected, restoreFailed: !restored, message: `${(e as Error).message.slice(0, 400)}${parked(restored)}` }
  }

  const after = git(repo, 'rev-parse', integrationBranch)
  const restored = restore()
  if (after === before) {
    return { ok: false, before, after, expected, restoreFailed: !restored, message: `ref did not move — land reported success but nothing changed${parked(restored)}` }
  }
  if (after !== expected) {
    return { ok: false, before, after, expected, restoreFailed: !restored, message: `ref moved to ${after.slice(0, 8)}, expected ${expected.slice(0, 8)}${parked(restored)}` }
  }
  return {
    ok: true, before, after, expected, restoreFailed: !restored,
    message: restored ? '' : `landed, but the operator checkout is parked on "${integrationBranch}" — checkout back to "${wasOn}" failed`,
  }
}
