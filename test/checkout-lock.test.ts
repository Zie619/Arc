import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquire, release, type CheckoutLockHolder } from '../src/checkout-lock.ts'

// The stale-lock break is a race, and a race is only testable if we can stop one
// contender in the middle of it. Both ways of breaking a lock start by moving
// the stale file out of the way, so a one-shot hook on the first rename or
// unlink of an acquire drops the second contender in at exactly the instant
// that used to produce two winners. Everything else passes through to real fs.
const hooks = vi.hoisted(() => ({ beforeBreak: undefined as (() => void) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const fire = (): void => {
    const hook = hooks.beforeBreak
    hooks.beforeBreak = undefined
    hook?.()
  }
  return {
    ...real,
    renameSync: (...args: Parameters<typeof real.renameSync>): void => {
      fire()
      return real.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof real.unlinkSync>): void => {
      fire()
      return real.unlinkSync(...args)
    },
  }
})

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

/** A real second contender: its own pid, its own view of the lock file. */
function acquireInChild(dir: string): { pid: number; result: CheckoutLockHolder | null } {
  const module = new URL('../src/checkout-lock.ts', import.meta.url).href
  const source = `const { acquire } = await import(${JSON.stringify(module)})\n` +
    `process.stdout.write(JSON.stringify({ pid: process.pid, result: acquire(${JSON.stringify(dir)}) }))`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })
  return JSON.parse(out) as { pid: number; result: CheckoutLockHolder | null }
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
  hooks.beforeBreak = undefined
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

  it('replaces a lock whose pid is alive but started at a different time', () => {
    // The recorded pid is this very process, so it is unambiguously alive and
    // `kill(pid, 0)` alone can never break this lock. Only processStartHint can
    // tell that the record belongs to an earlier tenant of that pid number.
    const recycled = { ...holder(process.pid), processStartHint: 0 }
    writeFileSync(checkoutLockPath(), JSON.stringify(recycled, null, 2))

    expect(acquire(repo)).toBeNull()

    const replacement = JSON.parse(readFileSync(checkoutLockPath(), 'utf8')) as CheckoutLockHolder
    expect(replacement.processStartHint).toBeGreaterThan(0)
    expect(replacement.acquiredAt).toBeGreaterThan(recycled.acquiredAt)
  })

  it('hands a stale lock to exactly one of two contenders that race to break it', async () => {
    writeFileSync(checkoutLockPath(), JSON.stringify(holder(await deadPid()), null, 2))

    // The child reads the same dead holder we just did and completes its whole
    // break while we are reaching for the stale file, so its fresh lock is
    // sitting at the lock path when we get there. Read -> unlink -> create
    // deleted that fresh lock and handed us the checkout as well: two winners,
    // and the child's release() then found our record and quietly gave up.
    let child: { pid: number; result: CheckoutLockHolder | null } | undefined
    hooks.beforeBreak = () => { child = acquireInChild(repo) }

    const held = acquire(repo)

    expect(child?.result).toBeNull()
    expect(held?.pid).toBe(child?.pid)
    const onDisk = JSON.parse(readFileSync(checkoutLockPath(), 'utf8')) as CheckoutLockHolder
    expect(onDisk.pid).toBe(child?.pid)
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

  it('release leaves a lock held by this pid on another host', () => {
    // Same pid number, different machine: on a shared filesystem that is a
    // stranger's live lock, not ours.
    const path = checkoutLockPath()
    const elsewhere = { ...holder(process.pid), hostname: `${hostname()}-other` }
    writeFileSync(path, JSON.stringify(elsewhere, null, 2))

    release(repo)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(elsewhere)
  })

  it('places a linked worktree lock in the main repository common dir', () => {
    const worktree = join(root, 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'linked-lock-test', worktree, 'HEAD')

    expect(acquire(worktree)).toBeNull()
    expect(existsSync(join(repo, '.git', 'arc-checkout.lock'))).toBe(true)
    expect(existsSync(join(worktree, '.git', 'arc-checkout.lock'))).toBe(false)
  })
})
