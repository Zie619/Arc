import React from 'react'
import { render } from 'ink'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Store } from './store.ts'
import { ProjectConfig } from './types.ts'
import { detectProject, findRepos, NoRepoHere } from './autoconfig.ts'
import { App, RepoPicker } from './app.tsx'

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
      const picker = render(
        <RepoPicker candidates={e.candidates} onPick={(repo) => { picker.unmount(); launch(detectProject(repo).config) }} />,
      )
      return
    }
    console.error((e as Error).message)
    process.exit(1)
  }
}

main()
