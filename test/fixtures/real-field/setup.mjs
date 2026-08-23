import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2] ?? 'parallel'
const root = mkdtempSync(join(tmpdir(), `arc-real-${mode}-`))
const repo = join(root, 'repo')
const state = join(root, 'state')

execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['config', 'user.email', 'field@example.test'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'arc field test'], { cwd: repo })
writeFileSync(join(repo, 'README.md'), `# arc ${mode} field fixture\n`)
execFileSync('git', ['add', '--', 'README.md'], { cwd: repo })
execFileSync('git', ['commit', '-q', '-m', 'field fixture base'], { cwd: repo })

const common = {
  name: `real-${mode}-field`, repo, mainBranch: 'main', landStrategy: 'none',
  agentConcurrency: 2, heavyGateLimit: 1, maxAttempts: 1, maxTaskMinutes: 10,
  roles: {
    implement: {
      cli: 'codex', model: 'gpt-5.6-sol', effort: 'high', sandbox: 'workspace-write',
      timeoutMs: 600000, stallMs: 180000,
    },
    review: {
      cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only',
      tools: 'Read,Grep,Glob,Bash(git *)', timeoutMs: 600000, stallMs: 180000,
    },
    integrate: {
      cli: 'claude', model: 'opus', effort: 'high', sandbox: 'read-only',
      tools: 'Read,Grep,Glob,Bash(git *)', timeoutMs: 600000, stallMs: 180000,
    },
  },
}

let plan
let config
if (mode === 'parallel') {
  const lock = join(root, 'heavy.lock')
  const trace = join(root, 'heavy.trace')
  const check = join(root, 'heavy-check.mjs')
  writeFileSync(check, [
    `import { appendFileSync, openSync, closeSync, unlinkSync } from 'node:fs'`,
    `const lock = ${JSON.stringify(lock)}`,
    `const trace = ${JSON.stringify(trace)}`,
    `const who = process.cwd()`,
    `let fd`,
    `try { fd = openSync(lock, 'wx') } catch { appendFileSync(trace, 'OVERLAP ' + who + '\\n'); process.exit(42) }`,
    `appendFileSync(trace, 'start ' + Date.now() + ' ' + who + '\\n')`,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)`,
    `appendFileSync(trace, 'end ' + Date.now() + ' ' + who + '\\n')`,
    `closeSync(fd)`,
    `unlinkSync(lock)`,
    '',
  ].join('\n'))
  config = {
    ...common,
    gates: [{
      name: 'serialized-heavy-field', command: `node ${JSON.stringify(check)}`,
      proves: 'the configured heavy-gate semaphore prevents overlap', cwd: '.',
      timeoutMs: 30000, heavy: true, baselineSubset: false,
    }],
  }
  const task = (id, path, value) => ({
    id, title: `Create ${path}`,
    spec: `Create only ${path}. Export a constant named ${id} whose exact string value is ${JSON.stringify(value)}. Commit ${path} by explicit path. Do not edit README.md or any other file.`,
    dependsOn: [], footprint: [path], contractsMutated: [`${id} export`], contractsRead: [],
    gates: ['serialized-heavy-field'],
    acceptance: [{
      id: `${id}-exists`, text: `${path} exports the requested exact value`, proofKind: 'command',
      proofCommand: `test -f ${path} && grep -q ${JSON.stringify(value)} ${path}`, requiredTier: 'checked',
    }],
  })
  plan = {
    arcId: 'real-parallel-field',
    charter: {
      goal: 'Prove two real Sol implementers can run concurrently while heavy gates remain serialized and Opus reviews the result.',
      objectives: ['Create two disjoint modules', 'Exercise the heavy gate limit with real task concurrency'],
      nonGoals: ['Do not publish or merge to main'],
    },
    tasks: [task('alpha', 'alpha.ts', 'alpha-real'), task('beta', 'beta.ts', 'beta-real')],
  }
} else {
  config = { ...common, agentConcurrency: 1, gates: [] }
  plan = {
    arcId: 'real-resume-field',
    charter: {
      goal: 'Create a small resumed.ts module exporting the exact requested value.',
      objectives: ['Create resumed.ts with a checked export'], nonGoals: ['Do not publish or merge to main'],
    },
    tasks: [{
      id: 'resumed', title: 'Create resumed.ts',
      spec: 'Create only resumed.ts. Export a constant named resumed with exact value "recovered-real". Commit resumed.ts by explicit path. Do not edit README.md or any other file.',
      dependsOn: [], footprint: ['resumed.ts'], contractsMutated: ['resumed export'], contractsRead: [], gates: [],
      acceptance: [{
        id: 'resumed-exists', text: 'resumed.ts exports the recovered value', proofKind: 'command',
        proofCommand: 'test -f resumed.ts && grep -q recovered-real resumed.ts', requiredTier: 'checked',
      }],
    }],
  }
}

const configPath = join(root, 'arc.yaml')
const planPath = join(root, 'plan.yaml')
writeFileSync(configPath, JSON.stringify(config, null, 2))
writeFileSync(planPath, JSON.stringify(plan, null, 2))
process.stdout.write(JSON.stringify({ root, repo, state, config: configPath, plan: planPath }))
