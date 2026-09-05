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

  it('refuses malformed ownership instead of deleting it', () => {
    writeFileSync(checkoutLockPath(), '')
    expect(() => acquire(repo)).toThrow('malformed')
    expect(readFileSync(checkoutLockPath(), 'utf8')).toBe('')
  })

  it('does not treat a foreign host pid as a dead local process', async () => {
    const foreign = { ...holder(await deadPid()), hostname: 'another-machine' }
    writeFileSync(checkoutLockPath(), JSON.stringify(foreign))
    expect(acquire(repo)).toEqual(foreign)
  })

  it('admits exactly one process when stale-lock contenders race', async () => {
    writeFileSync(checkoutLockPath(), JSON.stringify(holder(await deadPid())))
    const module = new URL('../src/checkout-lock.ts', import.meta.url).href
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e',
      `const { acquire } = await import(${JSON.stringify(module)});
       const result = acquire(${JSON.stringify(repo)});
       process.stdout.write(JSON.stringify({ pid: process.pid, result }) + "\\n");
       setInterval(() => {}, 1000);`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }))
    try {
      const results = await Promise.all(children.map((child) => new Promise<{ pid: number; result: CheckoutLockHolder | null }>((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (chunk) => {
          out += chunk
          if (out.includes('\n')) resolve(JSON.parse(out.trim()))
        })
        child.on('error', reject)
        child.on('exit', (code) => reject(new Error(`contender exited ${code}: ${out}`)))
      })))
      const winners = results.filter((r) => r.result === null)
      expect(winners).toHaveLength(1)
      expect(JSON.parse(readFileSync(checkoutLockPath(), 'utf8')).pid).toBe(winners[0]!.pid)
    } finally {
      await Promise.all(children.map(async (child) => {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }))
    }
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
