import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

function readHolder(path: string): CheckoutLockHolder | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

/** Returns the live holder when refused, or null after acquiring the lock. */
export function acquire(repo: string): CheckoutLockHolder | null {
  const path = lockPath(repo)
  const ours: CheckoutLockHolder = {
    pid: process.pid,
    processStartHint: Date.now() - Math.round(process.uptime() * 1000),
    hostname: hostname(),
    acquiredAt: Date.now(),
  }
  const payload = JSON.stringify(ours, null, 2)

  try {
    writeFileSync(path, payload, { flag: 'wx' })
    return null
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error
  }

  const holder = readHolder(path)
  if (holder && isAlive(holder.pid)) return holder

  try {
    unlinkSync(path)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }

  try {
    writeFileSync(path, payload, { flag: 'wx' })
    return null
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error
  }

  // Another contender replaced the stale lock first. Its exclusive create won.
  return readHolder(path)
}

export function release(repo: string): void {
  const path = lockPath(repo)
  const holder = readHolder(path)
  if (holder?.pid !== process.pid) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}
