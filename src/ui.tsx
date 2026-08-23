import React from 'react'
import { render, useStdout, useStdin } from 'ink'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Store } from './store.ts'
import { ProjectConfig } from './types.ts'
import { detectProject } from './autoconfig.ts'
import { Dashboard } from './dashboard.tsx'

/** `arc ui` — the standalone live dashboard. */

function Standalone({ store }: { store: Store }) {
  const { stdout } = useStdout()
  const { isRawModeSupported } = useStdin()
  const width = Math.min(Math.max(stdout?.columns || 80, 40), 160)
  return <Dashboard store={store} width={width} interactive={Boolean(isRawModeSupported)} />
}

function main(): void {
  const argv = process.argv.slice(2)
  const ci = argv.indexOf('--config')
  const configPath = ci >= 0 ? resolve(argv[ci + 1]!) : null

  let config
  if (configPath) {
    if (!existsSync(configPath)) { console.error(`no project config at ${configPath}`); process.exit(1) }
    config = ProjectConfig.parse(parseYaml(readFileSync(configPath, 'utf8')))
  } else {
    try { config = detectProject(process.cwd()).config }
    catch (e) { console.error((e as Error).message); process.exit(1) }
  }

  const root = process.env.ARC_HOME ?? join(process.env.HOME ?? '.', '.arc', config.name)
  const store = new Store(root)

  const interactive = Boolean(process.stdin.isTTY)
  const app = render(<Standalone store={store} />)
  if (!interactive) {
    // One frame, then out — so `arc ui > snapshot.txt` works.
    setTimeout(() => { app.unmount(); store.close() }, 150)
    return
  }
  app.waitUntilExit().then(() => store.close())
}

main()
