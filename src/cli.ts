#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { Store } from './store.ts'
import { Plan, ProjectConfig, TIER_RANK, type ClaimTier } from './types.ts'
import { validatePlan } from './scheduler.ts'
import { runArc } from './orchestrator.ts'
import * as G from './git.ts'
import { detectProject, toYamlConfig, NoRepoHere } from './autoconfig.ts'
import { setupTerminal, detectHost } from './terminal-setup.ts'
import { decode, enableKeyProtocols, disableKeyProtocols } from './keys.ts'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { runInterview, runScouts, runPlanner, type Ask } from './design.ts'
import { createInterface } from 'node:readline/promises'
import { doctorProviders } from './provider-runtime.ts'
import { formatCostSummary } from './cost.ts'

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

function loadConfig(explicitPath: string | undefined, quiet = false): ProjectConfig {
  if (explicitPath) {
    if (!existsSync(explicitPath)) die(`no project config at ${explicitPath}`)
    const parsed = ProjectConfig.safeParse(parseYaml(readFileSync(explicitPath, 'utf8')))
    if (!parsed.success) die(`invalid config:\n${format(parsed.error)}`)
    return parsed.data
  }
  // No config? Work it out from where you are standing. Requiring a config
  // file before you can try the tool is the friction that stops people trying.
  try {
    const ri = process.argv.indexOf('--repo')
    const d = detectProject(process.cwd(), ri >= 0 ? resolve(process.argv[ri + 1]!) : undefined)
    if (!quiet) for (const n of d.notes) console.log(C.dim(`  ${n}`))
    if (!quiet && d.config.gates.length === 0) {
      console.log(C.yellow('  ! no gates detected — nothing will independently verify the work.'))
      console.log(C.dim('    Add a typecheck/test/build script, or run `arc init` and edit arc.yaml.'))
    }
    return d.config
  } catch (e) {
    if (e instanceof NoRepoHere && e.candidates.length > 0) {
      // Do not just refuse: name the repos we found and how to pick one.
      console.error(C.red('✗ ') + `${process.cwd()} is not a git repository, but it holds ${e.candidates.length}:`)
      for (const c of e.candidates) console.error(`    ${c}`)
      console.error(C.dim(`\n  Pick one:   arc --repo ${e.candidates[0]}`))
      console.error(C.dim(`  Or cd into it and just run: arc`))
      process.exit(1)
    }
    die((e as Error).message)
  }
}

function loadPlan(path: string): Plan {
  if (!existsSync(path)) die(`no plan at ${path}`)
  const parsed = Plan.safeParse(parseYaml(readFileSync(path, 'utf8')))
  if (!parsed.success) die(`invalid plan:\n${format(parsed.error)}`)
  const errors = validatePlan(parsed.data)
  if (errors.length) die(`plan is structurally invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  return parsed.data
}

function format(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}

/** A readable id from the brief itself, so `arc status` means something later. */
function deriveArcId(brief: string): string {
  const words = brief.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const stop = new Set(['the', 'a', 'an', 'and', 'to', 'of', 'for', 'in', 'on', 'is', 'it',
                        'make', 'we', 'i', 'want', 'need', 'please', 'should', 'that', 'this'])
  const meaningful = words.filter((w) => !stop.has(w) && w.length > 2).slice(0, 3)
  const slug = (meaningful.length ? meaningful : words.slice(0, 3)).join('-') || 'arc'
  return `${slug}-${randomBytes(2).toString('hex')}`
}

/**
 * JSX has to be bundled — Node's strip-only TS mode removes types but does not
 * transform JSX. Built on demand and only when stale, so it is invisible.
 */
function buildBundle(entry: string, outName: string): string {
  const root = resolve(import.meta.dirname, '..')
  const out = join(root, 'dist', outName)
  const src = join(root, 'src', entry)
  // esbuild follows the entry's local imports, so an engine-only edit can
  // change the bundle even when no TSX file moved. Watching only the entries
  // left `arc` running stale orchestrator code until the next UI edit.
  const sourceDir = join(root, 'src')
  const sources = readdirSync(sourceDir)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(sourceDir, file))
  const newest = Math.max(...sources.map((p) => statSync(p).mtimeMs))
  if (!existsSync(out) || newest > statSync(out).mtimeMs) {
    const b = spawnSync('pnpm', ['exec', 'esbuild', src, '--bundle', '--platform=node',
      '--format=esm', '--packages=external', `--outfile=${out}`, '--log-level=warning'],
      { cwd: root, stdio: 'inherit' })
    if (b.status !== 0) die('could not build the interface (run `pnpm install` in the arc-executor repo)')
  }
  return out
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function die(msg: string): never {
  console.error(C.red('✗ ') + msg)
  process.exit(1)
}

function stateRoot(config: ProjectConfig): string {
  // Run state lives in OUR store, never in the subject repo's working tree —
  // nothing about the target repo's git state should be able to delete the
  // record of what an agent did.
  return process.env.ARC_HOME ?? join(process.env.HOME ?? '.', '.arc', config.name)
}

let activeRun: { store: Store; arcId: string } | null = null
let crashRecorded = false

function errorRecord(reason: unknown): { message: string; stack: string } {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  return {
    message: error.message.slice(0, 800),
    stack: (error.stack ?? error.message).split('\n').slice(0, 12).join('\n').slice(0, 4_000),
  }
}

function recordActiveCrash(reason: unknown): void {
  if (!activeRun || crashRecorded) return
  crashRecorded = true
  try { activeRun.store.appendEvent(activeRun.arcId, 'arc.crash', errorRecord(reason)) } catch { /* stderr remains the final fallback */ }
}

function beginActiveRun(store: Store, arcId: string): void {
  activeRun = { store, arcId }
  crashRecorded = false
}

function endActiveRun(): void {
  activeRun = null
  crashRecorded = false
}

process.on('unhandledRejection', (reason) => {
  recordActiveCrash(reason)
  console.error(C.red('✗ ') + errorRecord(reason).message)
  try { activeRun?.store.close() } catch { /* process termination is already committed */ }
  process.exit(1)
})

process.on('uncaughtException', (error) => {
  recordActiveCrash(error)
  console.error(C.red('✗ ') + errorRecord(error).message)
  try { activeRun?.store.close() } catch { /* process termination is already committed */ }
  process.exit(1)
})

interface SupervisedExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: string
}

function supervisorArgs(mode: 'run' | 'resume', planPath: string, configPath?: string): string[] {
  const args = [resolve(process.argv[1]!), mode]
  // A TUI-born arc has no plan file; resume reads its plan from the store.
  if (planPath) args.push(planPath)
  if (configPath) args.push('--config', configPath)
  const repo = flag(process.argv.slice(2), '--repo')
  if (repo) args.push('--repo', resolve(repo))
  return args
}

async function launchSupervisedChild(
  mode: 'run' | 'resume', planPath: string, configPath?: string,
): Promise<SupervisedExit> {
  const nodeArgs = supervisorArgs(mode, planPath, configPath)
  const hasCaffeinate = process.platform === 'darwin' && spawnSync('which', ['caffeinate'], { stdio: 'ignore' }).status === 0
  const command = hasCaffeinate ? 'caffeinate' : process.execPath
  const args = hasCaffeinate ? ['-dims', process.execPath, ...nodeArgs] : nodeArgs
  return await new Promise((resolveExit) => {
    let settled = false
    const finish = (result: SupervisedExit): void => {
      if (settled) return
      settled = true
      resolveExit(result)
    }
    const child = spawn(command, args, {
      cwd: process.cwd(), stdio: 'inherit',
      env: { ...process.env, ARC_UNTIL_DONE_CHILD: '1' },
    })
    child.on('error', (error) => finish({ code: null, signal: null, error: error.message }))
    child.on('exit', (code, signal) => finish({ code, signal }))
  })
}

async function superviseRun(
  store: Store, plan: Plan, planPath: string, configPath?: string, startMode: 'run' | 'resume' = 'run',
): Promise<number> {
  const crashes: Array<SupervisedExit & { event?: unknown }> = []
  const delay = Number(process.env.ARC_SUPERVISOR_BACKOFF_MS)
  const relaunchDelayMs = Number.isFinite(delay) && delay >= 0 ? delay : 15_000
  let mode: 'run' | 'resume' = startMode
  let relaunches = 0

  for (;;) {
    const result = await launchSupervisedChild(mode, planPath, configPath)
    const arc = store.getArc(plan.arcId)
    if (arc?.status === 'done') return 0
    if (arc?.status !== 'running') return result.code ?? 2

    const last = store.eventsSince(plan.arcId, 0).at(-1)
    crashes.push({ ...result, event: last ? { kind: last.kind, payload: last.payload } : undefined })
    console.error(C.yellow(`! run child ${result.signal ? `died on ${result.signal}` : `exited ${result.code ?? 'without a code'}`} while arc is still running${result.error ? ` — ${result.error}` : ''}`))
    if (last) console.error(C.dim(`  last event: ${last.kind} ${JSON.stringify(last.payload).slice(0, 300)}`))

    if (relaunches >= 10) {
      store.appendEvent(plan.arcId, 'arc.supervisor.exhausted', { relaunches, crashes })
      store.closeArc(plan.arcId, 'incomplete')
      console.error(C.red(`✗ relaunch cap reached after ${crashes.length} crash(es); arc is INCOMPLETE`))
      crashes.forEach((crash, index) => console.error(`  ${index + 1}. code=${crash.code ?? 'null'} signal=${crash.signal ?? 'none'} last=${JSON.stringify(crash.event ?? null)}`))
      const cost = formatCostSummary(store.costSummary(plan.arcId))
      console.error('  token bill — ' + (cost.lines.length > 0 ? 'provider receipts' : 'no attempts recorded'))
      for (const line of cost.lines) console.error(line)
      if (cost.missing > 0) console.error(`  ! ${cost.missing} attempt(s) reported no usage receipt — every number above is a FLOOR.`)
      return 2
    }

    relaunches++
    store.appendEvent(plan.arcId, 'arc.supervisor.relaunch', {
      relaunch: relaunches, delayMs: relaunchDelayMs,
      code: result.code, signal: result.signal, lastEvent: last?.kind,
    })
    console.error(C.dim(`  relaunching through resume in ${Math.round(relaunchDelayMs / 1000)}s (${relaunches}/10)`))
    await new Promise((resolveDelay) => setTimeout(resolveDelay, relaunchDelayMs))
    mode = 'resume'
  }
}

const USAGE = `
${C.bold('arc')} — point it at a repo, describe what you want, walk away.

${C.bold('Usually all you need:')}

  cd ~/your/repo
  arc "make the importer handle duplicate rows"      ${C.dim('# it asks, plans, builds')}
  arc mybrief.md                                       ${C.dim('# same, from a file')}
  arc --danger "..."                                   ${C.dim('# never stops to ask')}
  arc ui                                               ${C.dim('# watch it live')}

${C.dim('It finds the repo, your test/build scripts, and your main branch on its own.')}
${C.dim('It works on its own branch and opens a PR — it never touches main directly.')}

${C.bold('When something needs a closer look:')}

  arc status                        where everything stands
  arc criteria                      every promise + whether it is actually proven
  arc findings                      what the reviewer caught
  arc cost                          the token bill per role — and what went unmeasured
  arc resume <plan.yaml>            continue after a crash
  arc clean                         reset so it can run again
  arc show <artifactId>             the exact prompt or transcript of one step

${C.bold('Plumbing — arc "..." already runs all of these for you:')}

  arc interview <brief.md> --id X   arc scout --id X    arc plan --id X
  arc validate <plan.yaml>          arc run <plan.yaml> arc watch

  arc init                          write an arc.yaml you can tune
  arc setup-terminal                make shift+enter work in your editor
  arc keys                          show what your terminal sends for each key
  arc doctor                        inspect installed provider capabilities (no model call)

Options:
  --danger        no approval stops: take every recommendation, run the plan
  --until-done    supervise arc run/resume, prevent sleep, relaunch after crashes
  --config <p>    use a specific config instead of auto-detection
  --id <name>     name the arc (default: derived from your brief)
  --version, -V   print the installed arc version
`

const SUBCOMMANDS = new Set([
  'interview', 'scout', 'plan', 'validate', 'run', 'resume', 'clean', 'status',
  'ui', 'watch', 'criteria', 'findings', 'show', 'init', 'go', 'cost',
  'setup-terminal', 'keys',
  'doctor',
])

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); return }
  if (argv.includes('-V') || argv.includes('--version')) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    return
  }
  const first = argv.find((a) => !a.startsWith('-'))
  // Bare `arc` opens the app and you type there — same as `claude`. Anything
  // that is not a known subcommand is a brief.
  const cmd = first && SUBCOMMANDS.has(first) ? first : 'go'

  // --until-done supervises a child process through crashes and sleep. Only the
  // two commands that OWN a run can be relaunched that way; the design phase
  // asks the operator questions, and a relaunch would restart the interview.
  // Accepting the flag anywhere else printed it in --help and did nothing —
  // which is precisely the silent no-op this tool exists to refuse.
  if (argv.includes('--until-done') && cmd !== 'run' && cmd !== 'resume') {
    die(`--until-done supervises \`arc run\` and \`arc resume\`, not \`arc ${cmd === 'go' ? '"<goal>"' : cmd}\`.\n`
      + `  Get a plan first, then supervise the build:\n`
      + `    arc "<goal>"                          # design + approve the plan\n`
      + `    arc run plan.yaml --until-done        # walk away`)
  }

  const ci = argv.indexOf('--config')
  const configPath = ci >= 0 ? resolve(argv[ci + 1]!) : undefined
  const danger = argv.includes('--danger') || argv.includes('--yolo')
  const valueFlags = ['--config', '--id', '-o', '--out', '--repo']
  const valueIdx = new Set(valueFlags.map((f) => argv.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1))
  const allPositional = argv.filter((a, i) => !a.startsWith('-') && !valueIdx.has(i))
  // For a bare `arc "brief..."` the brief IS the first positional, so nothing
  // is dropped.
  const positional = first && SUBCOMMANDS.has(first) ? allPositional.slice(1) : allPositional

  if (cmd === 'init') {
    const d = detectProject(process.cwd())
    const out = join(d.config.repo, 'arc.yaml')
    if (existsSync(out) && !argv.includes('--force')) die(`${out} already exists (--force to overwrite)`)
    writeFileSync(out, toYaml(toYamlConfig(d.config)))
    console.log(C.green('✓ ') + `wrote ${out}`)
    console.log(C.dim('  Edit the gates and models to taste; arc picks it up automatically.'))
    return
  }

  if (cmd === 'setup-terminal') {
    // Some terminals cannot send shift+enter at all: it is byte-identical to
    // plain enter, and the protocols that would separate them are unimplemented
    // in VS Code, Cursor and Terminal.app. A keybinding is the only fix.
    console.log(C.dim(`terminal: ${detectHost() ?? 'unknown'}`))
    for (const r of setupTerminal()) {
      if (r.ok) console.log(C.green('✓ ') + `${r.editor}: ${r.message}`)
      else console.log(C.yellow('! ') + `${r.editor}: ${r.message}`)
    }
    console.log(C.dim('\nReload the editor window, then shift+enter adds a line.'))
    console.log(C.dim('Until then, \\ followed by enter does the same thing.'))
    return
  }

  if (cmd === 'keys') {
    // The honest way to settle "shift+enter does not work": watch the bytes.
    if (!process.stdin.isTTY) die('arc keys needs a terminal')
    console.log(C.bold('Press keys to see what your terminal sends. ctrl-c to stop.\n'))
    console.log(C.dim(`terminal: ${detectHost() ?? 'unknown'}  TERM=${process.env.TERM ?? '?'}\n`))
    process.stdin.setRawMode(true)
    process.stdin.resume()
    enableKeyProtocols(process.stdout)
    process.stdin.on('data', (chunk: Buffer) => {
      const raw = chunk.toString()
      if (raw === '\u0003') {
        disableKeyProtocols(process.stdout)
        process.stdin.setRawMode(false)
        console.log(C.dim('\nbye'))
        process.exit(0)
      }
      const bytes = [...chunk].map((b) => (b === 27 ? 'ESC' : b < 32 || b === 127 ? `\\x${b.toString(16).padStart(2, '0')}` : String.fromCharCode(b))).join(' ')
      for (const k of decode(raw)) {
        const mods = [k.ctrl && 'ctrl', k.meta && 'alt', k.shift && 'shift'].filter(Boolean).join('+')
        const label = mods ? `${mods}+${k.name}` : k.name
        console.log(`  ${C.cyan(label.padEnd(22))} ${C.dim(bytes)}`)
        if (k.name === 'return' && (k.shift || k.meta)) {
          console.log(C.green('  ↑ that is shift+enter working — it will insert a new line.'))
        } else if (k.name === 'return') {
          console.log(C.dim('  ↑ a plain enter. If you pressed SHIFT+enter, your terminal is not'))
          console.log(C.dim('    sending anything different — run: arc setup-terminal'))
        }
      }
    })
    return
  }

  if (cmd === 'doctor') {
    const report = await doctorProviders({ cwd: process.cwd() })
    console.log(C.bold(`provider doctor · ${report.ready ? 'ready' : 'attention needed'}`))
    for (const provider of report.providers) {
      console.log(`\n${C.cyan(provider.provider)}  ${provider.version ?? 'not installed'}`)
      for (const [name, capability] of Object.entries(provider.capabilities)) {
        if (capability.status === 'unknown') continue
        const mark = capability.status === 'supported' ? C.green('✓')
          : capability.status === 'available-disabled' ? C.yellow('○') : C.red('✗')
        console.log(`  ${mark} ${name} · ${capability.status}`)
      }
      for (const diagnostic of provider.diagnostics) console.log(C.yellow(`  ! ${diagnostic}`))
    }
    if (!report.ready) process.exitCode = 2
    return
  }

  if (cmd === 'validate') {
    const plan = loadPlan(resolve(positional[0] ?? 'plan.yaml'))
    console.log(C.green('✓ ') + `plan "${plan.arcId}" is valid — ${plan.tasks.length} task(s)`)
    for (const t of plan.tasks) {
      const deps = t.dependsOn.length ? C.dim(` after ${t.dependsOn.join(', ')}`) : ''
      console.log(`  ${C.cyan(t.id)} ${t.title}${deps}`)
      console.log(C.dim(`    ${t.acceptance.length} criteria · ${t.footprint.length} declared paths · contracts: ${[...t.contractsMutated, ...t.contractsRead].join(', ') || 'none'}`))
    }
    return
  }

  // `go` hands off to the app, which does its own detection and can ASK which
  // repo you meant. Resolving config here would refuse before it gets the chance.
  if (cmd === 'go') {
    const arg = positional[0]
    let briefPath: string | null = null
    if (arg) {
      briefPath = existsSync(resolve(arg)) && statSync(resolve(arg)).isFile()
        ? resolve(arg)
        : join(tmpdir(), `arc-brief-${randomBytes(4).toString('hex')}.md`)
      if (briefPath.startsWith(tmpdir())) writeFileSync(briefPath, positional.join(' '))
    }
    const bundle = buildBundle('app-main.tsx', 'app.mjs')
    const args = [bundle]
    if (configPath) args.push('--config', configPath)
    if (danger) args.push('--danger')
    if (briefPath) args.push('--brief', briefPath)
    const rIdx = argv.indexOf('--repo')
    if (rIdx >= 0) args.push('--repo', resolve(argv[rIdx + 1]!))
    const r = spawnSync('node', args, { stdio: 'inherit', env: process.env, cwd: process.cwd() })
    process.exit(r.status ?? 0)
  }

  const config = loadConfig(configPath, true)
  const store = new Store(stateRoot(config))

  try {
    switch (cmd) {
      case 'run': {
        const planPath = resolve(positional[0] ?? 'plan.yaml')
        const plan = loadPlan(planPath)
        if (argv.includes('--until-done') && process.env.ARC_UNTIL_DONE_CHILD !== '1') {
          const code = await superviseRun(store, plan, planPath, configPath)
          if (code !== 0) { store.close(); process.exit(code) }
          break
        }
        beginActiveRun(store, plan.arcId)
        try {
          await runArc({
            store, plan, config, log: (l) => console.log(l), preflight: true,
            waitForPreflightCapacity: process.env.ARC_UNTIL_DONE_CHILD === '1',
          })
        } catch (error) {
          recordActiveCrash(error)
          throw error
        } finally {
          endActiveRun()
        }
        // Exit non-zero on an incomplete arc. A caller that cannot tell success
        // from failure by exit code is exactly how a false "done" propagates.
        if (store.getArc(plan.arcId)?.status !== 'done') { store.close(); process.exit(2) }
        break
      }
      case 'interview': {
        const brief = positional[0]
        if (!brief) die('usage: arc interview <brief.md> --id <arcId>')
        const arcId = flag(argv, '--id') ?? die('arc interview needs --id <arcId>')
        // Piped or redirected stdin (scripts, CI) cannot answer questions, and
        // readline throws the moment it is closed. Every question already
        // carries a recommendation, so a non-interactive run takes those and
        // says so loudly rather than crashing half-way through an interview.
        const interactive = Boolean(process.stdin.isTTY)
        const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
        if (!interactive) {
          console.log(C.yellow('! stdin is not a terminal — accepting every recommendation.'))
          console.log(C.dim('  Run this in a terminal to answer the questions yourself.'))
        }
        // Every question is presented with a recommendation, so pressing enter
        // is always a sane answer. An interview you cannot get through is an
        // interview nobody finishes.
        const ask: Ask = async (q) => {
          console.log('')
          console.log(C.bold(`Q: ${q.text}`))
          console.log(C.dim(`   why it matters: ${q.why}`))
          for (const [i, opt] of q.options.entries()) console.log(C.dim(`   ${i + 1}. ${opt}`))
          console.log(C.cyan(`   recommended: ${q.recommendation}`))
          if (!rl) { console.log(C.dim('   → accepted the recommendation')); return '' }
          const a = await rl.question(C.dim('   your answer (enter = accept recommendation): '))
          // A bare number picks that option, so common answers stay one keystroke.
          const n = Number(a.trim())
          if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1]!
          return a
        }
        try {
          const ok = await runInterview({ store, config, arcId, log: (l) => console.log(l) }, resolve(brief), ask)
          if (!ok) { store.close(); process.exit(2) }
          console.log('')
          console.log(C.green('✓ ') + `charter settled. Next: arc scout --id ${arcId}`)
        } finally { rl?.close() }
        break
      }
      case 'scout': {
        const arcId = flag(argv, '--id') ?? store.latestDesignId() ?? die('arc scout needs --id <arcId>')
        const ok = await runScouts({ store, config, arcId, log: (l) => console.log(l) })
        if (!ok) { store.close(); process.exit(2) }
        console.log('')
        console.log(C.green('✓ ') + `scouting done. Next: arc plan --id ${arcId}`)
        break
      }
      case 'plan': {
        const arcId = flag(argv, '--id') ?? store.latestDesignId() ?? die('arc plan needs --id <arcId>')
        const plan = await runPlanner({ store, config, arcId, log: (l) => console.log(l) })
        if (!plan) { store.close(); process.exit(2) }
        const out = resolve(flag(argv, '-o') ?? flag(argv, '--out') ?? `${arcId}.plan.yaml`)
        writeFileSync(out, toYaml(plan))
        console.log('')
        for (const t of plan.tasks) {
          const deps = t.dependsOn.length ? C.dim(` after ${t.dependsOn.join(', ')}`) : ''
          console.log(`  ${C.cyan(t.id)} ${t.title}${deps}`)
          console.log(C.dim(`    ${t.acceptance.length} criteria · ${t.footprint.length} files · contracts: ${[...t.contractsMutated, ...t.contractsRead].join(', ') || 'none'}`))
        }
        console.log('')
        console.log(C.green('✓ ') + `wrote ${out}`)
        console.log(C.dim('   Read it. Edit it if you disagree. Nothing runs until you say so:'))
        console.log(C.dim(`   arc run ${out}`))
        break
      }
      case 'resume': {
        // A TUI-born arc has no plan.yaml on disk — its plan lives in the
        // store, which resume trusts over the caller's file anyway. With no
        // argument, resume the latest arc from its stored plan.
        // (First dogfood run: crash recovery was impossible without this.)
        let plan: Plan
        let resumePlanPath = ''
        if (positional[0]) {
          resumePlanPath = resolve(positional[0])
          plan = loadPlan(resumePlanPath)
        } else if (existsSync(resolve('plan.yaml'))) {
          resumePlanPath = resolve('plan.yaml')
          plan = loadPlan(resumePlanPath)
        } else {
          const arcId = store.latestArcId()
          if (!arcId) die('no arcs yet')
          const stored = store.getPlan(arcId!)
          if (!stored) die(`arc "${arcId}" has no stored plan — pass a plan file`)
          plan = stored!
        }
        if (!store.getArc(plan.arcId)) die(`no arc "${plan.arcId}" to resume — use \`run\``)
        if (argv.includes('--until-done') && process.env.ARC_UNTIL_DONE_CHILD !== '1') {
          const code = await superviseRun(store, plan, resumePlanPath, configPath, 'resume')
          if (code !== 0) { store.close(); process.exit(code) }
          break
        }
        beginActiveRun(store, plan.arcId)
        try {
          await runArc({ store, plan, config, log: (l) => console.log(l), resume: true, preflight: true })
        } catch (error) {
          recordActiveCrash(error)
          throw error
        } finally {
          endActiveRun()
        }
        if (store.getArc(plan.arcId)?.status !== 'done') { store.close(); process.exit(2) }
        break
      }
      case 'clean': {
        const arcId = positional[0] ?? store.latestArcId()
        if (!arcId) die('no arcs yet')
        const plan = store.getPlan(arcId)
        if (!plan) die(`no arc "${arcId}"`)
        // Never clean an arc that is still running: releasing a worktree out
        // from under a live agent corrupts its work.
        const live = store.allTasks(arcId).filter((t) => ['running', 'reviewing', 'landing'].includes(String(t.state)))
        if (live.length > 0 && !argv.includes('--force')) {
          die(`${live.length} task(s) still in flight (${live.map((t) => t.id).join(', ')}).\n` +
              `  If the process really is dead, re-run with --force.`)
        }
        for (const t of plan.tasks) G.releaseTaskWorkspace(config.repo, store.root, t.id)
        const integration = `arc/${arcId}-integration`
        if (argv.includes('--all')) {
          G.gitOk(config.repo, 'branch', '-D', integration)
          console.log(C.yellow(`  removed ${integration} — any unmerged work on it is gone`))
        } else {
          console.log(C.dim(`  kept ${integration} (pass --all to delete it too)`))
        }
        console.log(C.green('✓ ') + `cleaned ${plan.tasks.length} task workspace(s) for ${arcId}`)
        break
      }
      case 'status': {
        const arcId = positional[0] ?? store.latestArcId()
        if (!arcId) die('no arcs yet')
        const arc = store.getArc(arcId)
        if (!arc) die(`no arc "${arcId}"`)
        console.log(C.bold(`arc ${arcId}`) + C.dim(` — ${arc.status}`))
        console.log(C.dim(JSON.parse(String(arc.charter_json)).goal.split('\n')[0]?.slice(0, 76) ?? ''))
        console.log('')
        for (const t of store.allTasks(arcId)) {
          const mark = t.state === 'landed' ? C.green('✓') : t.state === 'failed' ? C.red('✗') : t.state === 'pending' ? C.dim('·') : C.yellow('▶')
          const unmet = store.unmetCriteria(arcId, t.id).length
          const note = unmet ? C.yellow(` ${unmet} criteria unproven`) : ''
          console.log(`  ${mark} ${t.id.padEnd(14)} ${String(t.state).padEnd(10)} ${t.title}${note}`)
        }
        const ops = store.openBlockingOps(arcId)
        if (ops.length) {
          console.log('')
          console.log(C.yellow(`  ${ops.length} blocking pending op(s) — the arc cannot be done until these run`))
          for (const p of ops) console.log(`    [${p.kind}] ${p.description}`)
        }
        break
      }
      case 'cost': {
        const arcId = positional[0] ?? store.latestArcId()
        if (!arcId) die('no arcs yet')
        const rows = store.costSummary(arcId)
        if (rows.length === 0) { console.log('no attempts recorded for this arc'); break }
        console.log(C.bold(`token bill — arc ${arcId}`))
        console.log('')
        const { lines, missing } = formatCostSummary(rows)
        for (const line of lines) console.log(line)
        if (missing > 0) {
          console.log('')
          console.log(C.yellow(`  ! ${missing} attempt(s) reported no usage receipt — every number above is a FLOOR.`))
        }
        console.log(C.dim(`  Not counted here: design-phase runs in other stores, and any Claude session`))
        console.log(C.dim(`  driving arc from outside — that session's own tokens never pass through arc.`))
        break
      }
      case 'watch': {
        const arcId = positional[0] ?? store.latestArcId()
        if (!arcId) die('no arcs yet')
        console.log(C.dim(`watching ${arcId} — ctrl-c to stop`))
        let seq = 0
        for (;;) {
          for (const e of store.eventsSince(arcId, seq)) {
            seq = e.seq
            const t = new Date(e.at).toTimeString().slice(0, 8)
            const who = e.taskId ? C.cyan(e.taskId) : C.dim('arc')
            console.log(`${C.dim(t)} ${who} ${e.kind} ${e.payload ? C.dim(JSON.stringify(e.payload).slice(0, 110)) : ''}`)
          }
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
      case 'criteria': {
        const arcId = positional[0] ?? store.latestArcId()
        if (!arcId) die('no arcs yet')
        const colour: Record<string, (s: string) => string> = {
          observed: C.green, checked: C.cyan, claimed: C.yellow, unproven: C.red, waived: C.dim,
        }
        for (const c of store.allCriteria(arcId)) {
          const short = (c.tier as string).padEnd(9)
          const paint = colour[c.tier as string] ?? C.dim
          const below = TIER_RANK[c.tier as ClaimTier] < TIER_RANK[c.required_tier as ClaimTier]
          console.log(`${paint(short)} ${c.task_id}/${c.id} ${below ? C.red(`(needs ${c.required_tier})`) : ''}`)
          console.log(C.dim(`          ${c.text}`))
          if (c.evidence) console.log(C.dim(`          evidence: ${String(c.evidence).slice(0, 100)}`))
        }
        break
      }
      case 'findings': {
        const arcId = positional[0] ?? store.latestArcId()
        if (!arcId) die('no arcs yet')
        for (const f of store.findingsFor(arcId)) {
          const sev = f.severity === 'high' ? C.red('high') : f.severity === 'medium' ? C.yellow('med ') : C.dim('low ')
          console.log(`${sev} ${C.cyan(String(f.kind).padEnd(11))} ${f.task_id ?? '-'} — ${f.text}`)
        }
        break
      }
      case 'ui': {
        store.close()
        const out = buildBundle('ui.tsx', 'ui.mjs')
        const uiArgs = configPath ? [out, '--config', configPath] : [out]
        const r = spawnSync('node', uiArgs, { stdio: 'inherit', env: process.env, cwd: process.cwd() })
        process.exit(r.status ?? 0)
      }
      case 'show': {
        const id = positional[0]
        if (!id) die('usage: arc show <attemptId>')
        const p = store.artifactPath(id)
        if (!p) die(`no artifact ${id}`)
        console.log(readFileSync(p, 'utf8'))
        break
      }
      default:
        console.log(USAGE)
    }
  } finally {
    store.close()
  }
}

main().catch((e) => {
  console.error(C.red('✗ ') + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
