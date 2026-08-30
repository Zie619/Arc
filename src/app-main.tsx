import React from 'react'
import { render } from 'ink'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Store } from './store.ts'
import { ProjectConfig } from './types.ts'
import { detectProject, findRepos, NoRepoHere } from './autoconfig.ts'
import { App, RepoPicker } from './app.tsx'
import { rememberedRepo, rememberRepo, tilde } from './repo-choice.ts'


function main(): void {
  const argv = process.argv.slice(2)
  const ci = argv.indexOf('--config')
  const configPath = ci >= 0 ? resolve(argv[ci + 1]!) : null
  const danger = argv.includes('--danger')
  const bi = argv.indexOf('--brief')
  const initialBrief = bi >= 0 ? readFileSync(resolve(argv[bi + 1]!), 'utf8') : undefined

  const ri = argv.indexOf('--repo')
  const repoOverride = ri >= 0 ? resolve(argv[ri + 1]!) : undefined

  if (!process.stdin.isTTY) {
    console.error('arc needs a terminal to ask you things.')
    console.error('For a script, give it the brief up front: arc --danger "what you want"')
    process.exit(1)
  }

  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')

  const launch = (config: ProjectConfig) => {
    const root = process.env.ARC_HOME ?? join(process.env.HOME ?? '.', '.arc', config.name)
    const store = new Store(root)
    const app = render(<App store={store} config={config} danger={danger} initialBrief={initialBrief} />)
    app.waitUntilExit().then(() => store.close())
  }

  if (configPath) {
    if (!existsSync(configPath)) { console.error(`no project config at ${configPath}`); process.exit(1) }
    launch(ProjectConfig.parse(parseYaml(readFileSync(configPath, 'utf8'))))
    return
  }

  try {
    launch(detectProject(process.cwd(), repoOverride).config)
  } catch (e) {
    if (e instanceof NoRepoHere && e.candidates.length > 0) {
      // You are standing in a folder that HOLDS repos but is not one. Arc has
      // nothing to branch from here, so it does have to know which you meant —
      // but it should only ask when that is genuinely a question.
      const only = e.candidates.length === 1 ? e.candidates[0]! : null
      if (only) {
        console.log(`using ${tilde(only)} — the only repo in ${tilde(process.cwd())}`)
        launch(detectProject(only).config)
        return
      }
      const remembered = rememberedRepo(process.cwd())
      if (remembered && e.candidates.includes(remembered)) {
        console.log(`using ${tilde(remembered)} — your last choice here (arc --repo <path> to change)`)
        launch(detectProject(remembered).config)
        return
      }
      const picker = render(
        <RepoPicker candidates={e.candidates} onPick={(repo) => {
          picker.unmount()
          rememberRepo(process.cwd(), repo)
          launch(detectProject(repo).config)
        }} />,
      )
      return
    }
    console.error((e as Error).message)
    process.exit(1)
  }
}

main()
