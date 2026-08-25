import { execFileSync, spawnSync } from 'node:child_process'
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

/** Tracked and untracked paths exactly as git sees them. NUL framing keeps
 *  spaces and rename arrows in filenames from becoming staging syntax. */
export function worktreeChanges(repo: string): string[] {
  const out = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  if (!out) return []
  const entries = out.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') index++
  }
  return paths
}

export interface Worktree {
  path: string
  branch: string
  baseSha: string
  /** True when an existing worktree was REUSED with the writer's commits still
   *  on it, rather than created fresh. Only a resume produces this. */
  recovered?: boolean
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
      if (expectedBase === head) return { path, branch, baseSha: head }
      // AHEAD of the base is the crash case, and it is the writer's committed
      // work. Resume used to force-delete this branch and rebuild from attempt
      // one — so a task caught in `reviewing`, with passing gates and possibly a
      // finished review, lost all of it. Keep it: the base stays the ORIGINAL
      // base so the diff still covers everything committed.
      if (gitOk(repo, 'merge-base', '--is-ancestor', expectedBase, head)) {
        return { path, branch, baseSha: expectedBase, recovered: true }
      }
      throw new Error(`worktree path ${path} is on "${head}", which does not descend from "${expectedBase}" — refusing to reuse`)
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
  // Task branches are `arc/<arcId>--<taskId>`, so this can now be exact.
  // It used to sweep up every branch that did not LOOK like an integration
  // branch, which meant another arc's task branches as well.
  return all.filter((b) =>
    b === `arc/${arcId}-integration` ||
    b === `arc/${arcId}-integration-review` ||
    b.startsWith(`arc/${arcId}--`))
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
      ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body],
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
    // The branch IS pushed — hand the operator the one-click URL gh could not.
    return { ok: false, url: compareUrl(repo, branch, base), message: `gh pr create failed: ${detail.slice(0, 300)}` }
  }
}

/** GitHub compare URL for origin, or '' when origin is not a GitHub remote. */
export function compareUrl(repo: string, branch: string, base: string): string {
  let origin = ''
  try { origin = git(repo, 'remote', 'get-url', 'origin') } catch { return '' }
  const m = origin.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
  if (!m) return ''
  return `https://github.com/${m[1]}/${m[2]}/compare/${base}...${branch}?expand=1`
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
}

/** Where a branch is checked out, if anywhere. `git update-ref` will happily
 *  move a branch that IS checked out, leaving that worktree's index desynced
 *  against a head it never produced — verified by direct experiment. */
export function checkedOutAt(repo: string, branch: string): string | null {
  const out = git(repo, 'worktree', 'list', '--porcelain')
  let path: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return null
}

/**
 * Land by COMPARE-AND-SWAP. Never check anything out.
 *
 * This used to `git checkout` the integration branch in the operator's own
 * working checkout, merge, and try to put their branch back. The blast radius
 * is visible in the vocabulary that decision required: a `restoreFailed` flag,
 * a "parked" message builder, a "your checkout was left on…" warning, and three
 * dedicated tests. It was also a read-then-write race — nothing stopped the
 * operator running `git checkout` in between.
 *
 * `git update-ref refs/heads/<branch> <new> <old>` is atomic and REFUSES a
 * stale old-value, which is strictly stronger than the read-then-compare it
 * replaces, and it deletes the entire parked-checkout failure class rather than
 * asserting against it.
 *
 * One hazard, easy to miss and verified by experiment: update-ref will happily
 * move a branch that IS checked out somewhere, leaving that worktree's index
 * desynced against a head it never produced. So this asserts the target is
 * checked out NOWHERE and fails closed if it is.
 */
export function landBranch(repo: string, integrationBranch: string, taskBranch: string): LandResult {
  const before = git(repo, 'rev-parse', integrationBranch)
  const expected = git(repo, 'rev-parse', taskBranch)
  const fail = (message: string): LandResult => ({ ok: false, before, after: before, expected, message })

  const heldBy = checkedOutAt(repo, integrationBranch)
  if (heldBy !== null) {
    return fail(`"${integrationBranch}" is checked out at ${heldBy} — refusing to move a ref out from under a working tree`)
  }
  // Prove the fast-forward is legal before claiming one. `merge --ff-only`
  // decided this implicitly; saying it out loud is what lets us skip the
  // checkout entirely.
  if (!gitOk(repo, 'merge-base', '--is-ancestor', before, expected)) {
    return fail(`not a fast-forward: "${taskBranch}" (${expected.slice(0, 8)}) does not descend from "${integrationBranch}" (${before.slice(0, 8)})`)
  }
  if (before === expected) return fail('ref did not move — land reported success but nothing changed')

  // Atomic, and refuses if someone else moved the ref since `before` was read.
  if (!gitOk(repo, 'update-ref', `refs/heads/${integrationBranch}`, expected, before)) {
    const now = git(repo, 'rev-parse', integrationBranch)
    return fail(`"${integrationBranch}" moved to ${now.slice(0, 8)} while landing (expected ${before.slice(0, 8)}) — nothing was merged`)
  }

  const after = git(repo, 'rev-parse', integrationBranch)
  if (after !== expected) return fail(`ref moved to ${after.slice(0, 8)}, expected ${expected.slice(0, 8)}`)
  return { ok: true, before, after, expected, message: '' }
}

/**
 * Would merging these two produce conflicts, and in which files?
 *
 * `git merge-tree --write-tree` (git 2.38+) answers without touching a working
 * tree at all: a tree sha on a clean merge, exit 1 plus the conflicted paths
 * otherwise. Proactive conflict detection is an old idea (Brun et al., FSE
 * 2011) that never shipped widely because it needed a background merge server;
 * this made it a local one-liner.
 *
 * TEXTUAL ONLY. It will not catch "task A deletes the only writer of a field,
 * task B adds a reader" — which is exactly what integration review exists for.
 * A clean result here is never licence to skip that.
 */
export function conflictsWith(repo: string, ours: string, theirs: string): string[] | null {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', ours, theirs],
    { cwd: repo, encoding: 'utf8' })
  if (result.status === 0) return null
  // stdout is: <tree-sha>\n<conflicted path>\n<conflicted path>...
  const lines = (result.stdout ?? '').split('\n').filter(Boolean)
  return lines.slice(1)
}

/**
 * Remember conflict resolutions across worktrees.
 *
 * `.git/rr-cache` lives in the COMMON dir, so it IS shared across every
 * worktree of one repo — which makes Arc's N-worktrees-off-one-repo shape the
 * ideal case for rerere, by accident. Sibling tasks share a base and often a
 * hot file, so they hit the identical conflict and each would otherwise pay
 * full price for it.
 *
 * Deliberately NOT `rerere.autoUpdate`: auto-staging a replayed resolution is
 * silent-success behaviour of exactly the species this system exists to
 * eliminate. Resolutions are applied but left unstaged, and the existing
 * post-rebase re-gate is the proof — which also covers rerere replaying a stale
 * resolution into a context where it is wrong.
 */
export function enableRerere(repo: string): void {
  gitOk(repo, 'config', 'rerere.enabled', 'true')
  gitOk(repo, 'config', 'rerere.autoUpdate', 'false')
}

/**
 * Stamp every commit in a range with the task that produced it.
 *
 * `setTaskHead` records a sha that the land-time rebase invalidates minutes
 * later, so after landing nothing on the integration branch said which commit
 * came from which task: the integration review saw one flat undifferentiated
 * diff and the PR body listed task ids that linked to nothing.
 *
 * Trailers survive rebase; `git notes` do NOT, because they are keyed by sha.
 * Every stacked-diff tool converged on trailers independently (Gerrit's
 * Change-Id, ghstack's ghstack-source-id, spr's Commit-UID) for exactly that
 * reason. Done HERE rather than by asking the agent, because writers author
 * their own commit messages and would be unreliable about it.
 */
export function stampTaskTrailers(wt: string, baseSha: string, arcId: string, taskId: string, model: string): boolean {
  const trailers = [
    `--trailer=Arc-Task=${taskId}`,
    `--trailer=Arc-Arc=${arcId}`,
    `--trailer=Arc-Model=${model}`,
  ]
  return gitOk(wt, 'rebase', baseSha, '--exec',
    `git commit --amend --no-edit ${trailers.map((t) => `'${t}'`).join(' ')}`)
}

/** Commits on `range` grouped by the task that produced them. */
export function commitsByTask(repo: string, range: string): Map<string, string[]> {
  const out = git(repo, 'log', '--format=%H%x1f%(trailers:key=Arc-Task,valueonly)%x1e', range)
  const byTask = new Map<string, string[]>()
  for (const entry of out.split('\x1e')) {
    const [sha, task] = entry.trim().split('\x1f')
    if (!sha || !task) continue
    const id = task.trim()
    if (!id) continue
    byTask.set(id, [...(byTask.get(id) ?? []), sha])
  }
  return byTask
}
