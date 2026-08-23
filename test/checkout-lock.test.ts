import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquire, release, type CheckoutLockHolder } from '../src/checkout-lock.ts'

let repo: string
let root: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function checkoutLockPath(dir = repo): string {
  return resolve(dir, git(dir, 'rev-parse', '--git-common-dir'), 'arc-checkout.lock')
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  const pid = child.pid
  if (pid === undefined) throw new Error('short-lived child did not start')
  await once(child, 'exit')
  return pid
}

function holder(pid: number): CheckoutLockHolder {
  return {
    pid,
    processStartHint: Date.now() - 1_000,
    hostname: hostname(),
    acquiredAt: Date.now() - 500,
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'arc-checkout-lock-repo-'))
  root = mkdtempSync(join(tmpdir(), 'arc-checkout-lock-root-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t.t')
  git(repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  release(repo)
  rmSync(repo, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('checkout lock', () => {
  it('reports a same-process second acquire as held', () => {
    expect(acquire(repo)).toBeNull()
    const original = readFileSync(checkoutLockPath(), 'utf8')

    const held = acquire(repo)

    expect(held?.pid).toBe(process.pid)
    expect(readFileSync(checkoutLockPath(), 'utf8')).toBe(original)
  })

  it('replaces a lock belonging to a process that has exited', async () => {
    const stalePid = await deadPid()
    writeFileSync(checkoutLockPath(), JSON.stringify(holder(stalePid), null, 2))

    expect(acquire(repo)).toBeNull()

    const replacement = JSON.parse(readFileSync(checkoutLockPath(), 'utf8')) as CheckoutLockHolder
    expect(replacement.pid).toBe(process.pid)
    expect(replacement.pid).not.toBe(stalePid)
  })

  it('release removes only a lock owned by this process', async () => {
    const path = checkoutLockPath()
    const foreign = holder(await deadPid())
    writeFileSync(path, JSON.stringify(foreign, null, 2))

    release(repo)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(foreign)

    writeFileSync(path, JSON.stringify(holder(process.pid), null, 2))
    release(repo)
    expect(existsSync(path)).toBe(false)
  })

  it('places a linked worktree lock in the main repository common dir', () => {
    const worktree = join(root, 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'linked-lock-test', worktree, 'HEAD')

    expect(acquire(worktree)).toBeNull()
    expect(existsSync(join(repo, '.git', 'arc-checkout.lock'))).toBe(true)
    expect(existsSync(join(worktree, '.git', 'arc-checkout.lock'))).toBe(false)
  })
})
