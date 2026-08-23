import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { detectProject, findRepos, NoRepoHere } from '../src/autoconfig.ts'

let repo: string
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  // realpath: on macOS /var is a symlink to /private/var, and git reports
  // the resolved path.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'autoconf-')))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@t.t')
  sh(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'README.md'), 'x')
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'init')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

function pkg(scripts: Record<string, string>, lock = 'pnpm-lock.yaml') {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts }))
  writeFileSync(join(repo, lock), '')
}

describe('detectProject', () => {
  it('finds the repo ROOT from a nested subdirectory', () => {
    const deep = join(repo, 'apps', 'web', 'src')
    mkdirSync(deep, { recursive: true })
    expect(detectProject(deep).config.repo).toBe(repo)
  })

  it('uses the project OWN scripts as gates, never a hand-rolled equivalent', () => {
    pkg({ typecheck: 'tsc --noEmit', test: 'vitest run', build: 'next build' })
    const { config } = detectProject(repo)
    const names = config.gates.map((g) => g.name)
    expect(names).toEqual(['typecheck', 'test', 'build'])
    for (const g of config.gates) expect(g.command).toContain('pnpm')
    // build is CPU-bound: several at once wedge the machine.
    expect(config.gates.find((g) => g.name === 'build')!.heavy).toBe(true)
    // suites drift between runs; equality would turn ordinary flake into a red.
    expect(config.gates.find((g) => g.name === 'test')!.baselineSubset).toBe(true)
  })

  it('declares a worktree setup command so isolated trees can run project checks', () => {
    pkg({ test: 'vitest run' })
    // A bare worktree has no node_modules; without an install pass every
    // proof command fails environmentally (the first self-arc's death).
    expect(detectProject(repo).config.setupCommand).toContain('pnpm install')
  })

  it('does NOT invent a gate for a script that does not exist', () => {
    // A repo whose root has no `test` script must not get a `test` gate — it
    // would pass vacuously and read as verification that never happened.
    pkg({ build: 'next build' })
    expect(detectProject(repo).config.gates.map((g) => g.name)).toEqual(['build'])
  })

  it('warns rather than silently proceeding when nothing can verify the work', () => {
    pkg({})
    const { config, notes } = detectProject(repo)
    expect(config.gates).toEqual([])
    expect(notes.join(' ')).toContain('nothing will verify')
  })

  it('picks the package manager from the lockfile', () => {
    pkg({ test: 'jest' }, 'yarn.lock')
    expect(detectProject(repo).config.gates[0]!.command).toContain('yarn')
  })

  it('leaves work on its branch with no remote, and opens a PR when there is one', () => {
    pkg({})
    // No remote means no PR is possible — and quietly merging into main is not
    // a decision to make for someone.
    expect(detectProject(repo).config.landStrategy).toBe('none')
    sh(repo, 'remote', 'add', 'origin', 'https://example.com/x.git')
    // A repo with a remote almost certainly protects main; pushing at it just
    // fails at the very end of an arc.
    expect(detectProject(repo).config.landStrategy).toBe('pr')
  })

  it('an explicit arc.yaml always beats detection', () => {
    pkg({ test: 'vitest' })
    writeFileSync(join(repo, 'arc.yaml'), [
      'name: explicit', `repo: ${repo}`, 'gates: []',
      'roles:', '  implement:', '    cli: codex', '    model: custom-model',
    ].join('\n'))
    const d = detectProject(repo)
    expect(d.source).toBe('arc.yaml')
    expect(d.config.name).toBe('explicit')
    expect(d.config.gates).toEqual([])
  })

  it('refuses to run outside a git repository, with a reason', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'notrepo-'))
    try {
      expect(() => detectProject(notRepo)).toThrow(/not inside a git repository/)
    } finally { rmSync(notRepo, { recursive: true, force: true }) }
  })
})

describe('edge cases that should not crash detection', () => {
  it('handles a repo with no commits yet', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'fresh-')))
    try {
      sh(fresh, 'init', '-q', '-b', 'main')
      // HEAD is unborn here; rev-parse fails. Detection must still return
      // something usable so the real error surfaces at run time instead.
      expect(() => detectProject(fresh)).not.toThrow()
      expect(detectProject(fresh).config.mainBranch).toBe('main')
    } finally { rmSync(fresh, { recursive: true, force: true }) }
  })
})

describe('a folder that holds repos rather than being one', () => {
  it('finds the repos below it instead of just refusing', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'holder-')))
    try {
      for (const name of ['alpha', 'beta']) {
        const r = join(parent, name)
        mkdirSync(r)
        sh(r, 'init', '-q', '-b', 'main')
      }
      // A git WORKTREE has a .git FILE, not a directory. Offering one as a
      // project would be actively wrong, so it must not be listed.
      const wt = join(parent, '_wt-scratch')
      mkdirSync(wt)
      writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/else\n')

      const found = findRepos(parent).map((p) => p.split('/').pop())
      expect(found).toEqual(['alpha', 'beta'])
    } finally { rmSync(parent, { recursive: true, force: true }) }
  })

  it('throws NoRepoHere carrying the candidates, so the caller can ask', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'holder2-')))
    try {
      const r = join(parent, 'only-one')
      mkdirSync(r)
      sh(r, 'init', '-q', '-b', 'main')
      try {
        detectProject(parent)
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(NoRepoHere)
        expect((e as InstanceType<typeof NoRepoHere>).candidates).toEqual([r])
      }
    } finally { rmSync(parent, { recursive: true, force: true }) }
  })

  it('--repo overrides where you are standing', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'holder3-')))
    try {
      const r = join(parent, 'target')
      mkdirSync(r)
      sh(r, 'init', '-q', '-b', 'main')
      writeFileSync(join(r, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
      expect(detectProject(parent, r).config.repo).toBe(r)
    } finally { rmSync(parent, { recursive: true, force: true }) }
  })

  it('still fails clearly when there is nothing anywhere', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'empty-')))
    try {
      expect(() => detectProject(empty)).toThrow(/none were found below it/)
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })
})

describe('a stale config pointing at another repo', () => {
  it('refuses rather than silently editing the wrong repository', () => {
    // This nearly happened for real: a leftover project.yaml in one repo still
    // named a different one, and detection would have followed it.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'other-')))
    try {
      sh(other, 'init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'arc.yaml'), [
        'name: stale', `repo: ${other}`, 'gates: []',
        'roles:', '  implement:', '    cli: codex', '    model: m',
      ].join('\n'))
      expect(() => detectProject(repo)).toThrow(/belongs to another project/)
    } finally { rmSync(other, { recursive: true, force: true }) }
  })
})
