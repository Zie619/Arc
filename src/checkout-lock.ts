import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { git } from './git.ts'

export interface CheckoutLockHolder {
  pid: number
  processStartHint: number
  hostname: string
  acquiredAt: number
}

function lockPath(repo: string): string {
  return resolve(repo, git(repo, 'rev-parse', '--git-common-dir'), 'arc-checkout.lock')
}

function readRaw(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
}

function parseHolder(raw: string | null): CheckoutLockHolder | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value !== 'object' || value === null ||
      !Number.isInteger((value as CheckoutLockHolder).pid) || (value as CheckoutLockHolder).pid <= 0 ||
      typeof (value as CheckoutLockHolder).processStartHint !== 'number' ||
      typeof (value as CheckoutLockHolder).hostname !== 'string' ||
      typeof (value as CheckoutLockHolder).acquiredAt !== 'number'
    ) return null
    return value as CheckoutLockHolder
  } catch { return null }
}

function readHolder(path: string): CheckoutLockHolder | null {
  return parseHolder(readRaw(path))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * When the OS says `pid` began, or null when it will not say. There is no node
 * API for another process's start time, so `ps` is the only way to ask.
 */
function startedAt(pid: number): number | null {
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  const parsed = Date.parse((probe.stdout ?? '').trim())
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * A pid is not an identity: pids recycle, and the moment an unrelated process
 * inherits a dead holder's pid the lock reads as held by a live process for
 * good — nothing ever breaks it again. processStartHint was recorded to settle
 * exactly that and was then never consulted. A pid that is alive but began at a
 * different time is a new tenant of the number, not the holder.
 */
function isHolderRunning(holder: CheckoutLockHolder): boolean {
  // A pid on another host cannot be tested against this host's process table.
  if (holder.hostname !== hostname()) return true
  if (!isAlive(holder.pid)) return false
  const started = startedAt(holder.pid)
  // `ps` reports whole seconds and the hint is derived from process.uptime(),
  // so only a gap far wider than either can explain means a different process.
  return started === null || Math.abs(started - holder.processStartHint) <= 5_000
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

/** Read-only UI preflight. The execution boundary still acquires atomically. */
export function inspectCheckoutLock(repo: string): CheckoutLockHolder | null {
  const holder = readHolder(lockPath(repo))
  return holder && isHolderRunning(holder) ? holder : null
}

/** SQLite owns the short filesystem transaction, including stale recovery.
 * Its OS locks are released on process death. Renaming a stale JSON file by
 * itself opens a gap where another contender can install a second live owner. */
function withGuard<T>(path: string, fn: () => T): T {
  const db = new DatabaseSync(`${path}.guard`)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    const result = fn()
    db.exec('COMMIT')
    return result
  } finally { db.close() }
}

/** Returns the live holder when refused, or null after acquiring the lock. */
export function acquire(repo: string): CheckoutLockHolder | null {
  const path = lockPath(repo)
  return withGuard(path, () => {
    const raw = readRaw(path)
    const holder = parseHolder(raw)
    if (raw !== null && !holder) {
      throw new Error(`checkout lock ${path} is unreadable or malformed — refusing to assume it is stale`)
    }
    if (holder && isHolderRunning(holder)) return holder
    const ours: CheckoutLockHolder = {
      pid: process.pid,
      processStartHint: Date.now() - Math.round(process.uptime() * 1000),
      hostname: hostname(),
      acquiredAt: Date.now(),
    }
    // Publish a complete record. A crash while writing the temporary file can
    // never turn a live lock into a zero-byte record that looks abandoned.
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(ours, null, 2), { flag: 'wx', mode: 0o600 })
      renameSync(temp, path)
    } finally {
      try { unlinkSync(temp) } catch (error) { if (!isCode(error, 'ENOENT')) throw error }
    }
    return null
  })
}

export function release(repo: string): void {
  const path = lockPath(repo)
  withGuard(path, () => {
    const holder = readHolder(path)
    if (holder?.pid !== process.pid || holder.hostname !== hostname()) return
    const ourStart = Date.now() - process.uptime() * 1000
    if (Math.abs(holder.processStartHint - ourStart) > 5_000) return
    try { unlinkSync(path) } catch (error) { if (!isCode(error, 'ENOENT')) throw error }
  })
}
