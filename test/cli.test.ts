import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { Plan } from '../src/types.ts'

const root = new URL('../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version

for (const supervised of [false, true]) it(`resumes the explicitly selected stored run${supervised ? ' through the supervisor' : ''}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-resume-id-'))
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({ name: 'resume-id', repo: dir, roles: { implement: { cli: 'codex', model: 'fixture' } } }))
  const store = new Store(dir)
  const p = Plan.parse({ arcId: 'selected', charter: { goal: 'fixture' }, tasks: [{ id: 'task', title: 'fixture', spec: 'fixture', acceptance: [{ id: 'c', text: 'fixture', proofKind: 'agent-review' }] }] })
  store.createArc(p, dir, 'base', 'arc/selected-integration')
  store.closeArc(p.arcId, 'done')
  // A newer run and a local plan file must not override the selected identity.
  store.createArc({ ...p, arcId: 'newer' }, dir, 'base', 'arc/newer-integration')
  writeFileSync(join(dir, 'plan.yaml'), 'invalid local plan')
  try {
    const result = spawnSync(process.execPath, [new URL('src/cli.ts', root).pathname, 'resume', '--id', p.arcId, '--config', cfg, ...(supervised ? ['--until-done'] : [])], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, ARC_HOME: dir }, timeout: 15_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(store.getArc('newer')!.status).toBe('running')
    expect(store.eventsSince('newer', 0)).toHaveLength(0)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('lists and resolves a blocking operation through the CLI without running its description', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-ops-cli-'))
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({ name: 'ops', repo: dir,
    roles: { implement: { cli: 'codex', model: 'fixture' } } }))
  const store = new Store(dir)
  const p = Plan.parse({ arcId: 'ops', charter: { goal: 'fixture' }, tasks: [{
    id: 'task', title: 'fixture', spec: 'fixture', acceptance: [{ id: 'c', text: 'fixture', proofKind: 'agent-review' }],
  }] })
  store.createArc(p, dir, 'base', 'arc/ops-integration')
  store.addPendingOp(p.arcId, 'task', 'external', 'operator must prepare the database', true)
  const op = store.openBlockingOps(p.arcId)[0]!
  const run = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', 'ops', ...args, '--config', cfg, '--id', p.arcId], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ARC_HOME: dir },
  })
  try {
    const listed = run()
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain(op.id)
    expect(run('resolve', op.id).status).not.toBe(0)
    const resolved = run('resolve', op.id, '--note', 'prepared and checked')
    expect(resolved.status, resolved.stderr).toBe(0)
    expect(resolved.stdout).toContain('Run arc resume')
    expect(store.openBlockingOps(p.arcId)).toEqual([])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

describe('arc version flag', () => {
  for (const flag of ['--version', '-V']) {
    it(`${flag} prints the package version and exits successfully`, () => {
      const result = spawnSync(process.execPath, ['src/cli.ts', flag], {
        cwd: root,
        encoding: 'utf8',
      })

      expect(result.stdout.trim()).toBe(version)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
    })
  }
})

describe('--until-done is never a silent no-op', () => {
  // The check lived inside `case 'run'`, so the advertised form —
  // `arc "<goal>" --until-done` — accepted the flag, printed it in --help, and
  // supervised nothing at all.
  it('refuses the flag on a command it cannot supervise, and says what to run', () => {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'do the thing', '--until-done'], {
      cwd: root, encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--until-done')
    expect(result.stderr).toContain('arc run plan.yaml --until-done')
  })

  it('accepts it on resume, which owns a run and can be relaunched', () => {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'resume', 'no-such-plan.yaml', '--until-done'], {
      cwd: root, encoding: 'utf8',
    })

    expect(result.stderr).not.toContain('supervises `arc run`')
  })
})
