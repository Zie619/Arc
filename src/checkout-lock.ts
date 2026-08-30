import { spawnSync } from 'node:child_process'
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
  try { return readFileSync(path, 'utf8') } catch { return null }
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
  if (!isAlive(holder.pid)) return false
  // Another machine's pid says nothing about a local start time, so a holder
  // from elsewhere stays judged by the pid probe alone, as it always was.
  if (holder.hostname !== hostname()) return true
  const started = startedAt(holder.pid)
  // `ps` reports whole seconds and the hint is derived from process.uptime(),
  // so only a gap far wider than either can explain means a different process.
  return started === null || Math.abs(started - holder.processStartHint) <= 5_000
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

  const raw = readRaw(path)
  const holder = parseHolder(raw)
  if (holder && isHolderRunning(holder)) return holder

  // Breaking a stale lock used to be read -> unlink -> create, which two
  // contenders reading the same dead holder interleaved: the first replaced it
  // and the second then unlinked THAT fresh lock and created its own, so both
  // believed they held the checkout and the first one's release() silently did
  // nothing. Move the stale file aside instead — rename hands it to exactly one
  // contender — and break only what we can prove we captured.
  const captured = `${path}.stale.${process.pid}.${Date.now()}`
  try {
    renameSync(path, captured)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
  const capturedRaw = readRaw(captured)
  if (capturedRaw !== null && capturedRaw !== raw) {
    // Not the record we judged stale: someone broke the lock ahead of us and we
    // took their fresh one. It may be live, so put it back with an exclusive
    // link rather than discard it, and let the create below refuse us.
    try {
      linkSync(captured, path)
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
    }
  }
  if (capturedRaw !== null) unlinkSync(captured)

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
  // A pid alone is not ownership. The lock lives in the git common dir, which
  // can sit on a filesystem shared between machines where pids collide freely;
  // hostname is recorded for that case and was never compared, so this process
  // could delete a lock genuinely held by its pid-twin on another host.
  if (holder?.pid !== process.pid || holder.hostname !== hostname()) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}
