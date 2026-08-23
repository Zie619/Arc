import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'arc-full-app-'))
const repo = join(root, 'repo')
const queue = join(root, 'queue')
const state = join(root, 'state')
const here = dirname(fileURLToPath(import.meta.url))

execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: repo })
writeFileSync(join(repo, 'README.md'), 'fixture repository\n')
execFileSync('git', ['add', '--', 'README.md'], { cwd: repo })
execFileSync('git', ['commit', '-q', '-m', 'fixture base'], { cwd: repo })

cpSync(here, queue, { recursive: true, filter: (source) => !source.endsWith('setup.mjs') })
const config = join(root, 'arc.yaml')
writeFileSync(config, [
  'name: full-app-fixture',
  `repo: ${JSON.stringify(repo)}`,
  'mainBranch: main',
  'landStrategy: none',
  'agentConcurrency: 2',
  'heavyGateLimit: 1',
  'maxAttempts: 1',
  'roles:',
  '  implement: { cli: codex, model: gpt-5.6-sol, effort: high, sandbox: workspace-write, timeoutMs: 20000, stallMs: 15000 }',
  '  review: { cli: claude, model: opus, effort: high, sandbox: read-only, timeoutMs: 20000, stallMs: 15000 }',
  '  scout: { cli: codex, model: gpt-5.6-sol, effort: medium, sandbox: read-only, timeoutMs: 20000, stallMs: 15000 }',
  '  integrate: { cli: claude, model: opus, effort: high, sandbox: read-only, timeoutMs: 20000, stallMs: 15000 }',
  'gates: []',
  '',
].join('\n'))

process.stdout.write(JSON.stringify({ root, repo, queue, state, config }))
