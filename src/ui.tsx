import React from 'react'
import { render, useStdin } from 'ink'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Store } from './store.ts'
import { ProjectConfig } from './types.ts'
import { detectProject } from './autoconfig.ts'
import { Dashboard } from './dashboard.tsx'
import { useTerminalSize } from './terminal-ui.tsx'

/** `arc ui` — the standalone live dashboard. */

function Standalone({ store, initialArcId, interactive }: { store: Store; initialArcId?: string; interactive: boolean }) {
  const { width } = useTerminalSize()
  const { isRawModeSupported } = useStdin()
  return <Dashboard store={store} width={width} interactive={interactive && Boolean(isRawModeSupported)} initialArcId={initialArcId} />
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
    const ri = argv.indexOf('--repo')
    try { config = detectProject(process.cwd(), ri >= 0 ? resolve(argv[ri + 1]!) : undefined).config }
    catch (e) { console.error((e as Error).message); process.exit(1) }
  }

  const root = process.env.ARC_HOME ?? join(process.env.HOME ?? '.', '.arc', config.name)
  const store = new Store(root)
  const ai = argv.indexOf('--id')
  const initialArcId = ai >= 0 ? argv[ai + 1] : undefined
  if (initialArcId && !store.getArc(initialArcId) && !store.getDesign(initialArcId)) {
    console.error(`no saved run "${initialArcId}"`); store.close(); process.exitCode = 1; return
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const app = render(<Standalone store={store} initialArcId={initialArcId} interactive={interactive} />, { incrementalRendering: true, maxFps: 10 })
  if (!interactive) {
    // One frame, then out — so `arc ui > snapshot.txt` works.
    setTimeout(() => { app.unmount(); store.close() }, 150)
    return
  }
  app.waitUntilExit().then(() => store.close())
}

main()
