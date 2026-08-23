import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render } from 'ink'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dashboard } from '../src/dashboard.tsx'
import { Store } from '../src/store.ts'
import type { Plan } from '../src/types.ts'
import { fakeTerminal } from './fake-terminal.ts'

const tick = () => new Promise((r) => setTimeout(r, 60))

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dashtest-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const plan = (arcId: string): Plan => ({
  arcId, charter: { goal: `goal of ${arcId}`, objectives: [], nonGoals: [] },
  tasks: [{
    id: 't1', title: 'do it', spec: 's', dependsOn: [], footprint: [], contractsMutated: [],
    contractsRead: [], gates: [], acceptance: [],
  }],
} as unknown as Plan)

describe('the dashboard picks the arc that matters', () => {
  it('opens on the RUNNING arc even when a dead one is newer', async () => {
    const store = new Store(home)
    store.createArc(plan('alive'), '/r', 'a'.repeat(40), 'arc/alive-integration')
    await new Promise((r) => setTimeout(r, 5))   // distinct created_at
    store.createArc(plan('corpse'), '/r', 'b'.repeat(40), 'arc/corpse-integration')
    store.closeArc('corpse', 'incomplete')

    const out = fakeTerminal(120)
    const app = render(<Dashboard store={store} width={120} interactive={false} />, {
      stdout: out.stream, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    expect(out.text()).toContain('goal of alive')
    expect(out.text()).not.toContain('goal of corpse')
    app.unmount(); store.close()
  })

  it('labels a dead arc as the kept evidence record, with when it ended', async () => {
    const store = new Store(home)
    store.createArc(plan('corpse'), '/r', 'a'.repeat(40), 'arc/corpse-integration')
    store.closeArc('corpse', 'incomplete')

    const out = fakeTerminal(120)
    const app = render(<Dashboard store={store} width={120} interactive={false} />, {
      stdout: out.stream, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    expect(out.text()).toContain('goal of corpse')
    expect(out.text()).toContain('ended')
    expect(out.text()).toContain("kept as the run's evidence record")
    app.unmount(); store.close()
  })
})
