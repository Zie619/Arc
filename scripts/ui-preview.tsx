/** Reproducible interface previews, with fixture data and no provider calls. */
import React from 'react'
import { render } from 'ink'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/store.ts'
import { Plan } from '../src/types.ts'
import { Dashboard } from '../src/dashboard.tsx'
import { ApprovalPanel } from '../src/app.tsx'
import { fakeTerminal } from '../test/fake-terminal.ts'

const root = mkdtempSync(join(tmpdir(), 'arc-preview-'))
const store = new Store(root)
const capture = process.argv.includes('--write') || process.argv.includes('--snapshot')
const originalNow = Date.now
if (capture) Date.now = () => new Date('2026-09-05T09:41:00Z').getTime()
const tasks = [
  ['idempotency', 'Make duplicate requests safe', 'landed'],
  ['retry-policy', 'Review bounded retry behavior', 'reviewing'],
  ['transactions', 'Keep writes atomic on failure', 'running'],
  ['integration', 'Verify the complete checkout flow', 'pending'],
  ['database', 'Exercise the database failure cases', 'quarantined'],
]
const plan = Plan.parse({ arcId: 'checkout-resilience', charter: { goal: 'Make checkout resilient to retries and partial failures.' }, tasks: tasks.map(([id, title], i) => ({
  id, title, spec: `Implement and independently verify: ${title}.`,
  dependsOn: i === 3 ? ['idempotency', 'retry-policy', 'transactions'] : [],
  footprint: [`src/checkout/${id}.ts`], gates: ['test', 'typecheck'],
  acceptance: [{ id: 'behavior', text: `${title}; existing behavior still passes`, proofKind: 'command', proofCommand: `pnpm test -- checkout/${id}.test.ts`, requiredTier: 'checked' }],
})) })
store.createArc(plan, '/projects/payments', 'a'.repeat(40), 'arc/checkout-resilience-integration')
for (const [id, , state] of tasks) store.setTaskState(plan.arcId, id!, state!)
store.db.prepare("UPDATE criterion SET tier = 'checked', evidence = 'All duplicate-request cases pass' WHERE task_id = 'idempotency'").run()
store.startAttempt({ arcId: plan.arcId, taskId: 'retry-policy', attemptNo: 2, role: 'review', cli: 'claude', requestedModel: 'opus' })
store.startAttempt({ arcId: plan.arcId, taskId: 'transactions', attemptNo: 1, role: 'implement', cli: 'codex', requestedModel: 'gpt-5.6-sol' })
store.addPendingOp(plan.arcId, 'database', 'capability', 'Start the test database, then verify connectivity.', true)
store.appendEvent(plan.arcId, 'gate', { name: 'typecheck', verdict: 'pass' }, 'idempotency')
store.appendEvent(plan.arcId, 'land', { head: 'b'.repeat(40) }, 'idempotency')

let closed = false
function cleanup() {
  if (closed) return
  closed = true; store.close(); rmSync(root, { recursive: true, force: true }); Date.now = originalNow
}
const isPlan = process.argv.includes('--plan')
const node = isPlan
  ? <ApprovalPanel plan={plan} width={104} mainBranch="main" landStrategy="none" onDecision={() => app.unmount()} onCancel={() => app.unmount()} onExit={() => app.unmount()} />
  : <Dashboard store={store} width={104} interactive={capture || Boolean(process.stdin.isTTY)} />
const terminal = capture ? fakeTerminal(104, 30) : undefined
if (!capture) process.stdout.write('Preview uses example data. q exits; no models are called.\n')
const app = render(node, { ...(terminal ? { stdout: terminal.stream, stdin: terminal.stdin } : {}), patchConsole: false, exitOnCtrlC: false, incrementalRendering: true, maxFps: 10 })
if (capture) {
  setTimeout(() => {
    const frame = terminal!.text()
    app.unmount()
    if (process.argv.includes('--snapshot')) process.stdout.write(frame + '\n')
    if (process.argv.includes('--write')) {
      const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      const lines = frame.split('\n')
      const body = lines.map((text, i) => {
        const color = /blocking|quarantined/.test(text) ? '#fbbf24' : /✓|landed.*idempotency/.test(text) ? '#4ade80'
          : /reviewing/.test(text) ? '#f0abfc' : /running.*transactions/.test(text) ? '#22d3ee'
            : /ARC \/|─|\[activity\]/.test(text) ? '#c4b5fd' : '#aaa3b8'
        return `<text x="28" y="${94 + i * 20}" fill="${color}" xml:space="preserve">${escape(text)}</text>`
      }).join('\n')
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${130 + lines.length * 20}" viewBox="0 0 1080 ${130 + lines.length * 20}">
<title>ARC run dashboard rendered from the real terminal components with example mission data</title>
<rect width="1080" height="100%" rx="18" fill="#121018"/>
<rect x="1" y="1" width="1078" height="${128 + lines.length * 20}" rx="18" fill="none" stroke="#342b46"/>
<circle cx="28" cy="28" r="5" fill="#fb7185"/><circle cx="46" cy="28" r="5" fill="#fbbf24"/><circle cx="64" cy="28" r="5" fill="#4ade80"/>
<text x="104" y="33" fill="#a69ab9" font-family="monospace" font-size="13">arc / mission control</text>
<text x="1052" y="33" text-anchor="end" fill="#a69ab9" font-family="monospace" font-size="12">EXAMPLE DATA · NO MODEL CALLS</text>
<path d="M1 56H1079" stroke="#342b46"/>
<g font-family="Menlo,Consolas,monospace" font-size="15">${body}</g>
</svg>\n`
      writeFileSync(resolve('docs/assets/dashboard.svg'), svg)
      process.stdout.write('Wrote docs/assets/dashboard.svg from the rendered dashboard.\n')
    }
    cleanup()
  }, 180)
} else {
  if (!process.stdin.isTTY) setTimeout(() => app.unmount(), 150)
  void app.waitUntilExit().finally(cleanup)
}
process.once('exit', cleanup)
