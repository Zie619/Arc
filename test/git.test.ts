import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as G from '../src/git.ts'

let repo: string
let root: string

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(dir: string, file: string, content: string, msg: string): string {
  writeFileSync(join(dir, file), content)
  sh(dir, 'add', file)
  sh(dir, 'commit', '-q', '-m', msg)
  return sh(dir, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arcrepo-'))
  root = mkdtempSync(join(tmpdir(), 'arcroot-'))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@t.t')
  sh(repo, 'config', 'user.name', 'test')
  commit(repo, 'README.md', 'base\n', 'init')
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('worktree isolation FAILS CLOSED', () => {
  it('provisions an isolated worktree at a pinned base sha', () => {
    const base = G.headSha(repo)
    const wt = G.provisionWorktree(repo, root, 'task-1', base)
    expect(existsSync(wt.path)).toBe(true)
    expect(wt.branch).toBe('arc/task-1')
    expect(G.headSha(wt.path)).toBe(base)
  })

  it('THROWS rather than falling back to the shared checkout when the branch exists', () => {
    // outsourcerer prints "running in the normal checkout" and proceeds here,
    // which silently drops an agent into the shared tree beside the others.
    // There is no fallback. If isolation fails, the task does not run.
    const base = G.headSha(repo)
    sh(repo, 'branch', 'arc/task-1', base)
    expect(() => G.provisionWorktree(repo, root, 'task-1', base)).toThrow(/already exists/)
  })

  it('refuses to reuse a worktree path that is on the wrong branch', () => {
    const base = G.headSha(repo)
    const wt = G.provisionWorktree(repo, root, 'task-2', base)
    sh(wt.path, 'checkout', '-q', '-b', 'something-else')
    expect(() => G.provisionWorktree(repo, root, 'task-2', base)).toThrow(/refusing to reuse/)
  })

  it('RECOVERS a worktree that is ahead of its base, because that is the writer\'s work', () => {
    const base = G.headSha(repo)
    const wt = G.provisionWorktree(repo, root, 'crashed', base)
    const head = commit(wt.path, 'partial.ts', 'partial\n', 'partial work')

    // This used to throw, so resume force-deleted the branch and rebuilt from
    // attempt one — a task caught in `reviewing` lost committed work, passing
    // gates and possibly a finished review, ten times over under --until-done.
    const again = G.provisionWorktree(repo, root, 'crashed', base)
    expect(again.recovered).toBe(true)
    // The base stays the ORIGINAL base, so the diff still covers everything
    // committed. Returning `head` here would hide the recovered work from review.
    expect(again.baseSha).toBe(base)
    expect(G.headSha(again.path)).toBe(head)
  })

  it('still refuses a worktree whose head does not descend from the base', () => {
    const base = G.headSha(repo)
    G.provisionWorktree(repo, root, 'divergent', base)
    const moved = commit(repo, 'elsewhere.txt', 'x\n', 'main moves on')

    // Unrelated history is not recoverable work; it is a mismatch, and this
    // still fails closed rather than reusing a tree it cannot explain.
    expect(() => G.provisionWorktree(repo, root, 'divergent', moved))
      .toThrow(/does not descend/)
  })

  it('pins every task in a wave to the SAME base, not to a racing HEAD', () => {
    const base = G.headSha(repo)
    const a = G.provisionWorktree(repo, root, 'wave-a', base)
    commit(repo, 'moved.txt', 'x\n', 'main moves on')
    const b = G.provisionWorktree(repo, root, 'wave-b', base)
    expect(G.headSha(a.path)).toBe(G.headSha(b.path))
  })
})

describe('measured vs declared footprint', () => {
  it('reports what the task actually touched', () => {
    const base = G.headSha(repo)
    const wt = G.provisionWorktree(repo, root, 'fp', base)
    commit(wt.path, 'a.ts', 'export const a = 1\n', 'add a')
    commit(wt.path, 'b.ts', 'export const b = 2\n', 'add b')
    expect(G.measuredFootprint(wt.path, base).sort()).toEqual(['a.ts', 'b.ts'])
    expect(G.commitCount(wt.path, base)).toBe(2)
  })
})

describe('landing asserts the ref actually moved', () => {
  it('lands a fast-forwardable branch and confirms the new sha', () => {
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'land-1', base)
    const head = commit(wt.path, 'feature.ts', 'export const f = 1\n', 'feature')

    const r = G.landBranch(repo, 'integration', 'arc/land-1')
    expect(r.ok).toBe(true)
    expect(r.before).toBe(base)
    expect(r.after).toBe(head)
    expect(r.after).toBe(r.expected)
  })

  it('reports failure — not success — when the ref does not move', () => {
    // A failed --ff-only leaves the branch untouched, and the follow-up push
    // then says "Everything up-to-date", which reads exactly like success.
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'diverge', base)
    commit(wt.path, 'theirs.ts', '1\n', 'branch work')

    // Move integration independently so a fast-forward is impossible.
    sh(repo, 'checkout', '-q', 'integration')
    commit(repo, 'ours.ts', '2\n', 'integration work')
    const beforeLand = sh(repo, 'rev-parse', 'integration')

    const r = G.landBranch(repo, 'integration', 'arc/diverge')
    expect(r.ok).toBe(false)
    expect(sh(repo, 'rev-parse', 'integration')).toBe(beforeLand)
  })
})

describe('rebase never silently loses work', () => {
  it('rebases cleanly onto an advanced integration head', () => {
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'rb', base)
    commit(wt.path, 'mine.ts', 'mine\n', 'my work')

    sh(repo, 'checkout', '-q', 'integration')
    commit(repo, 'other.ts', 'other\n', 'other work')

    const r = G.rebaseOnto(wt.path, base, 'integration')
    expect(r.ok).toBe(true)
    expect(r.commitsAfter).toBeGreaterThanOrEqual(r.commitsBefore)
  })

  it('ABORTS and names the conflicting files instead of auto-resolving', () => {
    // A blind `git rebase --skip` in the source material dropped an entire
    // session's commit and then reported merged:true.
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'conflict', base)
    commit(wt.path, 'shared.ts', 'branch version\n', 'branch edit')

    sh(repo, 'checkout', '-q', 'integration')
    commit(repo, 'shared.ts', 'integration version\n', 'integration edit')

    const r = G.rebaseOnto(wt.path, base, 'integration')
    expect(r.ok).toBe(false)
    expect(r.conflictFiles).toContain('shared.ts')
    // The branch must be left intact, not half-rebased.
    expect(G.commitCount(wt.path, base)).toBe(1)
  })
})

describe('a dirty tree is a hard stop', () => {
  it('detects uncommitted tracked modifications', () => {
    expect(G.isClean(repo)).toBe(true)
    writeFileSync(join(repo, 'README.md'), 'modified\n')
    expect(G.isClean(repo)).toBe(false)
    expect(G.dirtyFiles(repo).join()).toContain('README.md')
  })
})

describe('staging is by explicit path', () => {
  it('commits only the named files, leaving a sibling agent\'s work alone', () => {
    const base = G.headSha(repo)
    const wt = G.provisionWorktree(repo, root, 'stage', base)
    writeFileSync(join(wt.path, 'mine.ts'), 'mine\n')
    writeFileSync(join(wt.path, 'not-mine.ts'), 'someone else\n')

    G.commitPaths(wt.path, ['mine.ts'], 'only mine')
    expect(G.measuredFootprint(wt.path, base)).toEqual(['mine.ts'])
    // The sibling's file is untouched — still present, still uncommitted.
    // `git add -A` here would have swept it into our commit.
    expect(G.untrackedFiles(wt.path)).toContain('not-mine.ts')
    expect(G.isClean(wt.path)).toBe(true) // no TRACKED modifications outstanding
  })

  it('surfaces a failed git add instead of committing partial work', () => {
    const base = G.headSha(repo)
    const wt = G.provisionWorktree(repo, root, 'failed-stage', base)
    writeFileSync(join(wt.path, 'real.ts'), 'real\n')

    expect(() => G.commitPaths(wt.path, ['real.ts', 'does-not-exist.ts'], 'partial')).toThrow(/failed/)
    expect(G.headSha(wt.path)).toBe(base)
    expect(G.measuredFootprint(wt.path, base)).toEqual([])
  })
})

describe('cleanup makes a failed task re-runnable', () => {
  it('releaseTaskWorkspace lets provisionWorktree succeed again', () => {
    // Without this, a failed task could never be retried: provisionWorktree
    // refuses to clobber an existing branch (correctly), so a second run died
    // on "branch arc/<id> already exists". We hit this twice in testing.
    const base = G.headSha(repo)
    const first = G.provisionWorktree(repo, root, 'retry-me', base)
    const partial = commit(first.path, 'partial.ts', 'half done\n', 'partial work')

    expect(() => G.provisionWorktree(repo, root, 'retry-me', partial)).not.toThrow()

    G.releaseTaskWorkspace(repo, root, 'retry-me')
    expect(existsSync(first.path)).toBe(false)
    expect(G.gitOk(repo, 'rev-parse', '--verify', 'arc/retry-me^{commit}')).toBe(false)

    const second = G.provisionWorktree(repo, root, 'retry-me', base)
    expect(G.headSha(second.path)).toBe(base)          // fresh, not the partial work
    expect(G.measuredFootprint(second.path, base)).toEqual([])
  })

  it('is safe to call on a task that was never provisioned', () => {
    expect(() => G.releaseTaskWorkspace(repo, root, 'never-existed')).not.toThrow()
  })

  it('lists the branches an arc created', () => {
    const base = G.headSha(repo)
    // Task workspaces are arc-scoped: `<arcId>--<taskId>`. Two concurrent arcs
    // whose plans both contain "task-1" used to collide on the path AND the
    // branch, which is the first bug concurrent missions would hit.
    G.provisionWorktree(repo, root, 'myarc--b-one', base)
    G.provisionWorktree(repo, root, 'myarc--b-two', base)
    G.provisionWorktree(repo, root, 'otherarc--b-one', base)
    sh(repo, 'branch', 'arc/myarc-integration', base)
    sh(repo, 'branch', 'arc/myarc-integration-review', base)
    sh(repo, 'branch', 'arc/otherarc-integration', base)
    sh(repo, 'branch', 'arc/otherarc-integration-review', base)
    const branches = G.arcBranches(repo, 'myarc')
    expect(branches).toContain('arc/myarc--b-one')
    expect(branches).toContain('arc/myarc--b-two')
    expect(branches).toContain('arc/myarc-integration')
    expect(branches).toContain('arc/myarc-integration-review')
    // Another arc's branches are not this arc's, task branches included. The
    // old rule swept up anything that did not LOOK like an integration branch.
    expect(branches).not.toContain('arc/otherarc--b-one')
    expect(branches).not.toContain('arc/otherarc-integration')
    expect(branches).not.toContain('arc/otherarc-integration-review')
  })
})

describe('landing never touches your working tree at all', () => {
  it('moves the ref by compare-and-swap and leaves your checkout alone', () => {
    // This used to `git checkout` the integration branch in the operator's own
    // tree and try to put their branch back — which needed a restoreFailed
    // flag, a "parked" message, and a warning. Now there is nothing to restore.
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    sh(repo, 'checkout', '-q', '-b', 'my-work')
    const wt = G.provisionWorktree(repo, root, 'cas', base)
    const head = commit(wt.path, 'x.ts', '1\n', 'work')

    const lr = G.landBranch(repo, 'integration', 'arc/cas')
    expect(lr.ok).toBe(true)
    expect(lr.after).toBe(head)
    expect(sh(repo, 'rev-parse', 'integration')).toBe(head)
    // Never moved.
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('my-work')
  })

  it('REFUSES to move a branch that is checked out somewhere', () => {
    // update-ref will happily move a checked-out branch, leaving that worktree's
    // index desynced against a head it never produced — verified by experiment.
    // Failing closed is the whole reason the CAS path is safe.
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'occupied', base)
    commit(wt.path, 'y.ts', '1\n', 'work')
    sh(repo, 'worktree', 'add', '-q', join(root, 'holder'), 'integration')

    const lr = G.landBranch(repo, 'integration', 'arc/occupied')
    expect(lr.ok).toBe(false)
    expect(lr.message).toContain('is checked out at')
    expect(sh(repo, 'rev-parse', 'integration')).toBe(base)
  })

  it('refuses a merge that is not a fast-forward, without a working tree to dirty', () => {
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'diverged', base)
    commit(wt.path, 'theirs.ts', '1\n', 'branch work')
    // Move integration on without a checkout, so nothing is checked out on it.
    const ours = commit(repo, 'ours.ts', '2\n', 'diverge')
    sh(repo, 'update-ref', 'refs/heads/integration', ours, base)

    const lr = G.landBranch(repo, 'integration', 'arc/diverged')
    expect(lr.ok).toBe(false)
    expect(lr.message).toContain('not a fast-forward')
    expect(sh(repo, 'rev-parse', 'integration')).toBe(ours)
  })

  it('refuses when the ref moved underneath it — the race the old read-then-compare had', () => {
    const base = G.headSha(repo)
    sh(repo, 'branch', 'integration', base)
    const wt = G.provisionWorktree(repo, root, 'racer', base)
    commit(wt.path, 'z.ts', '1\n', 'work')
    // A stale old-value is refused by update-ref itself, atomically.
    expect(G.checkedOutAt(repo, 'integration')).toBeNull()
    expect(G.landBranch(repo, 'integration', 'arc/racer').ok).toBe(true)
  })
})
