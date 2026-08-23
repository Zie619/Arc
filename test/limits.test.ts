import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexLimitsSnapshot } from '../src/limits.ts'

function withCodexHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'codexhome-limits-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  try {
    run(home)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

function rateLimits(usedPercent: number, windowMinutes = 300, resetsAt = 1787916578): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: usedPercent,
          window_minutes: windowMinutes,
          resets_at: resetsAt,
        },
      },
    },
  })
}

describe('codexLimitsSnapshot', () => {
  it('uses the last valid rate_limits event in the rollout', () => {
    withCodexHome((home) => {
      const sessions = join(home, 'sessions', '2026', '08', '21')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(join(sessions, 'rollout-last-wins.jsonl'), [
        rateLimits(12, 300, 1787916000),
        rateLimits(67, 10080, 1787916578),
      ].join('\n'))

      const snapshot = codexLimitsSnapshot()
      expect(snapshot?.usedPercent).toBe(67)
      expect(snapshot?.windowMinutes).toBe(10080)
      expect(snapshot?.resetsAt.getTime()).toBe(1787916578000)
    })
  })

  it('skips garbage and a truncated final line without throwing', () => {
    withCodexHome((home) => {
      const sessions = join(home, 'sessions', '2026', '08', '21')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(join(sessions, 'rollout-garbage.jsonl'), [
        '',
        'not json',
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
        rateLimits(42),
        '{"type":"event_msg","payload":',
      ].join('\n'))

      expect(() => codexLimitsSnapshot()).not.toThrow()
      expect(codexLimitsSnapshot()?.usedPercent).toBe(42)
    })
  })

  it('chooses the newest rollout by mtime across date directories', () => {
    withCodexHome((home) => {
      const olderDir = join(home, 'sessions', '2026', '08', '20')
      const newerDir = join(home, 'sessions', '2026', '08', '21')
      mkdirSync(olderDir, { recursive: true })
      mkdirSync(newerDir, { recursive: true })
      const older = join(olderDir, 'rollout-older.jsonl')
      const newer = join(newerDir, 'rollout-newer.jsonl')
      writeFileSync(older, rateLimits(15))
      writeFileSync(newer, rateLimits(85))
      utimesSync(older, new Date('2026-08-21T12:00:00Z'), new Date('2026-08-21T12:00:00Z'))
      utimesSync(newer, new Date('2026-08-21T12:00:10Z'), new Date('2026-08-21T12:00:10Z'))

      expect(codexLimitsSnapshot()?.usedPercent).toBe(85)
    })
  })

  it('returns null when the sessions directory is missing', () => {
    withCodexHome(() => {
      expect(codexLimitsSnapshot()).toBeNull()
    })
  })

  it('returns null when the newest rollout has no valid rate_limits event', () => {
    withCodexHome((home) => {
      const sessions = join(home, 'sessions', '2026', '08', '21')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(join(sessions, 'rollout-empty.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-id' } }),
        JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 10 } } } }),
        JSON.stringify({ payload: { rate_limits: { primary: {
          used_percent: '10', window_minutes: 300, resets_at: 1787916578,
        } } } }),
      ].join('\n'))

      expect(codexLimitsSnapshot()).toBeNull()
    })
  })

  it('converts resets_at from epoch seconds', () => {
    withCodexHome((home) => {
      const sessions = join(home, 'sessions', '2026', '08', '21')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(join(sessions, 'rollout-reset.jsonl'), rateLimits(25, 300, 1787916578))

      expect(codexLimitsSnapshot()?.resetsAt.getTime()).toBe(1787916578000)
    })
  })

  it('uses the rollout file mtime as observedAt', () => {
    withCodexHome((home) => {
      const sessions = join(home, 'sessions', '2026', '08', '21')
      mkdirSync(sessions, { recursive: true })
      const rollout = join(sessions, 'rollout-observed.jsonl')
      const observedAt = new Date('2026-08-21T12:34:56.000Z')
      writeFileSync(rollout, rateLimits(25))
      utimesSync(rollout, observedAt, observedAt)

      expect(codexLimitsSnapshot()?.observedAt.getTime()).toBe(observedAt.getTime())
    })
  })
})
