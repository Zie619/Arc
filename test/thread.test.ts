import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { ArcService, runThreadCommand } from '../src/service.ts'
import { ProjectConfig } from '../src/types.ts'

const stores: Store[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'arc-thread-'))
  const store = new Store(root)
  stores.push(store)
  const config = ProjectConfig.parse({
    name: 'sample', repo: '/repo', roles: { implement: { cli: 'codex', model: 'gpt-5.6' } },
  })
  return { store, service: new ArcService(store, config) }
}
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('durable threads', () => {
  it('preserves immutable messages and versioned agreements', () => {
    const { store, service } = setup()
    const id = service.createThread('memory layer redesign', 'deep')
    service.appendMessage(id, 'user', 'Keep the original brief verbatim.')
    service.setAgreement(id, { goal: 'Build the memory layer', constraints: [{ text: 'No context loss', hardness: 'MUST' }] })
    service.setAgreement(id, { goal: 'Build the memory layer well', constraints: [{ text: 'No context loss', hardness: 'MUST' }] })

    expect(store.threadMessages(id).map((m) => m.text)).toEqual(['Keep the original brief verbatim.'])
    expect(store.latestThreadAgreement(id)?.version).toBe(2)
    expect(store.getThread(id)?.lane).toBe('deep')
  })

  it('forks the active agreement without rewriting the parent history', () => {
    const { store, service } = setup()
    const parent = service.createThread('Parent', 'research')
    service.setAgreement(parent, { goal: 'Investigate' })
    service.appendMessage(parent, 'user', 'original')
    const child = store.forkThread(parent, 'Alternative')

    expect(store.getThread(child)?.parent_thread_id).toBe(parent)
    expect(store.latestThreadAgreement(child)?.goal).toBe('Investigate')
    expect(store.threadMessages(child)).toEqual([])
    expect(store.threadMessages(parent)).toHaveLength(1)
  })

  it('recompiles and stores bounded context independently of provider sessions', () => {
    const { store, service } = setup()
    const id = service.createThread('Durable')
    service.setAgreement(id, { goal: 'Never lose this exact goal' })
    service.appendMessage(id, 'user', 'Inspect scheduler contracts')
    const result = service.compileContext(id, 'scheduler contracts', { provider: 'claude', model: 'opus' })

    expect(result.text).toContain('Never lose this exact goal')
    expect(result.text).toContain('Inspect scheduler contracts')
    expect(store.latestThreadContextSnapshot(id)?.model).toBe('opus')
  })

  it('persists steering and consumes it explicitly', () => {
    const { store, service } = setup()
    const id = service.createThread('Steerable')
    const intervention = store.addIntervention({ threadId: id, kind: 'steer', text: 'Preserve the public API' })
    expect(store.pendingInterventions(id).map((row) => row.text)).toEqual(['Preserve the public API'])
    store.applyIntervention(intervention)
    expect(store.pendingInterventions(id)).toEqual([])
  })

  it('lets an operator /lane lock beat the triage write-back, whatever the timing', () => {
    const { store, service } = setup()
    const id = service.createThread('Locked')
    // The write-back path may not reroute a user-locked thread — checked at
    // write time, so a /lane typed during in-flight triage also wins.
    service.setLane(id, 'review', 'user')
    service.setLane(id, 'deep')
    expect(store.getThread(id)?.lane).toBe('review')
    expect(service.threadView(id)?.laneSource).toBe('user')
    // /lane auto hands routing back, and the classifier may steer again.
    service.unlockLane(id)
    service.setLane(id, 'deep')
    expect(store.getThread(id)?.lane).toBe('deep')
    expect(service.threadView(id)?.laneSource).toBe('auto')
  })

  it('adopts arc-less thread steering into the run that starts next', () => {
    const { store, service } = setup()
    const id = service.createThread('Steered later')
    service.steer(id, 'prefer the small fix')
    expect(store.pendingInterventionsForArc('arc-9', 'steer')).toEqual([])
    store.adoptInterventions(id, 'arc-9')
    expect(store.pendingInterventionsForArc('arc-9', 'steer').map((row) => row.text)).toEqual(['prefer the small fix'])
    // Already-adopted steering is not stolen by a later run.
    store.adoptInterventions(id, 'arc-10')
    expect(store.pendingInterventionsForArc('arc-9', 'steer')).toHaveLength(1)
    expect(store.pendingInterventionsForArc('arc-10', 'steer')).toEqual([])
  })

  it('compiles one dispatch envelope from the durable agreement and dialogue', () => {
    const { service } = setup()
    const id = service.createThread('Enveloped')
    // A fresh thread costs nothing: no header, no fake context.
    expect(service.compileDispatchEnvelope(id, 'anything').header).toBe('')
    service.setAgreement(id, { goal: 'Ship the safe version', constraints: [{ text: 'No new deps', hardness: 'MUST' }] })
    service.appendMessage(id, 'user', 'Remember the scheduler contract rule')
    const envelope = service.compileDispatchEnvelope(id, 'scheduler contracts')
    expect(envelope.header).toContain('THREAD CONTEXT')
    expect(envelope.header).toContain('Ship the safe version')
    expect(envelope.header).toContain('[MUST] No new deps')
    expect(envelope.header).toContain('Remember the scheduler contract rule')
  })

  it('throws on a malformed stored agreement instead of rendering undefined into Tier 0', () => {
    const { store, service } = setup()
    const id = service.createThread('Corrupt')
    // Bypass the service's write-side validation, as a buggy writer would.
    store.setThreadAgreement(id, { goal: 'ok', constraints: [{ bogus: true } as any] })
    expect(() => service.compileContext(id, 'q')).toThrow()
  })

  it('links designs and arcs back to the thread that started them', () => {
    const { store, service } = setup()
    const id = service.createThread('Linked')
    store.startDesign('arc-linked', 'the brief', id)
    expect(store.getDesign('arc-linked')?.threadId).toBe(id)
    store.createArc(
      { arcId: 'arc-linked', charter: { goal: 'g', objectives: [], nonGoals: [] }, tasks: [] } as any,
      '/repo', 'sha', 'arc/arc-linked-integration', id,
    )
    expect(store.getArc('arc-linked')?.thread_id).toBe(id)
  })

  it('archives threads without deleting their evidence', () => {
    const { store, service } = setup()
    const id = service.createThread('Old')
    service.appendMessage(id, 'assistant', 'durable')
    store.archiveThread(id)
    expect(service.listThreads()).toEqual([])
    expect(service.listThreads(true)).toHaveLength(1)
    expect(store.threadMessages(id)[0]?.text).toBe('durable')
  })

  it('controls threads locally without invoking a provider', () => {
    const { store, service } = setup()
    const first = service.createThread('First')
    const created = runThreadCommand('/new Second', service, first)!
    expect(created.threadId).not.toBe(first)
    expect(runThreadCommand('/lane direct', service, created.threadId)?.text).toContain('direct')
    expect(store.getThread(created.threadId)?.lane).toBe('direct')
    expect(runThreadCommand('/threads', service, created.threadId)?.text).toContain('Second')
    expect(runThreadCommand(`/thread ${first.slice(0, 8)}`, service, created.threadId)?.threadId).toBe(first)
    expect(runThreadCommand('/steer preserve the API', service, created.threadId, 'arc-1')?.text).toContain('next task brief')
    expect(store.pendingInterventionsForArc('arc-1', 'steer')[0]?.text).toBe('preserve the API')
  })
})
