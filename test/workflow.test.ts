import { describe, expect, it } from 'vitest'
import {
  WorkflowDefinition, builtInWorkflow, computeWorkflowFrontier, validateWorkflow,
} from '../src/workflow.ts'
import { WorkflowEngine } from '../src/workflow-engine.ts'
import { Store } from '../src/store.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('workflow IR', () => {
  it('all built-in lanes are structurally valid', () => {
    for (const lane of ['chat', 'direct', 'research', 'plan', 'review', 'deep'] as const) {
      expect(validateWorkflow(builtInWorkflow(lane)), lane).toEqual([])
    }
  })

  it('rejects unknown dependencies, artifact edges and cycles', () => {
    const workflow = WorkflowDefinition.parse({
      id: 'bad', lane: 'deep', steps: [
        { id: 'a', title: 'a', role: 'head', dependsOn: ['b'], consumes: ['missing'] },
        { id: 'b', title: 'b', role: 'head', dependsOn: ['a'] },
      ],
    })
    expect(validateWorkflow(workflow).join('\n')).toContain('unknown artifact')
    expect(validateWorkflow(workflow).join('\n')).toContain('dependency cycle')
  })

  it('rejects ambiguous artifact producers', () => {
    const workflow = WorkflowDefinition.parse({
      id: 'bad', lane: 'research', steps: [
        { id: 'a', title: 'a', role: 'scout', produces: ['evidence'] },
        { id: 'b', title: 'b', role: 'scout', produces: ['evidence'] },
      ],
    })
    expect(validateWorkflow(workflow).join()).toContain('produced by both')
  })

  it('unlocks only completed dependencies', () => {
    const workflow = builtInWorkflow('direct')
    expect(computeWorkflowFrontier(workflow, {}, 3).map((x) => x.id)).toEqual(['implement'])
    expect(computeWorkflowFrontier(workflow, { implement: 'done' }, 3).map((x) => x.id)).toEqual(['gate'])
  })

  it('serializes nested footprints and reader/writer contract conflicts', () => {
    const workflow = WorkflowDefinition.parse({
      id: 'parallel', lane: 'deep', steps: [
        { id: 'reader', title: 'reader', role: 'scout', footprint: ['src'], contractsRead: ['Schema'] },
        { id: 'writer', title: 'writer', role: 'implement', footprint: ['src/types.ts'], contractsMutated: ['Schema'] },
      ],
    })
    expect(computeWorkflowFrontier(workflow, {}, 2)).toHaveLength(1)
  })

  it('accounts for already running work', () => {
    const workflow = WorkflowDefinition.parse({
      id: 'parallel', lane: 'deep', steps: [
        { id: 'a', title: 'a', role: 'scout' },
        { id: 'b', title: 'b', role: 'scout' },
        { id: 'c', title: 'c', role: 'scout' },
      ],
    })
    expect(computeWorkflowFrontier(workflow, { a: 'running' }, 2).map((x) => x.id)).toEqual(['b'])
  })
})

describe('durable workflow execution', () => {
  it('recovers its frontier from rows and enforces dependency transitions', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'arc-workflow-')))
    const thread = store.createThread({ repo: '/repo', title: 'Direct' })
    const engine = new WorkflowEngine(store)
    const run = engine.start(thread, builtInWorkflow('direct'), 'run-1')

    expect(engine.frontier(run, 3).map((step) => step.id)).toEqual(['implement'])
    expect(() => engine.transition(run, 'gate', 'running')).toThrow(/not on the frontier/)
    engine.transition(run, 'implement', 'running')
    engine.transition(run, 'implement', 'done')
    expect(new WorkflowEngine(store).frontier(run, 3).map((step) => step.id)).toEqual(['gate'])
    store.close()
  })

  it('projects a failed run and blocks everything downstream of the failure', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'arc-workflow-')))
    const thread = store.createThread({ repo: '/repo', title: 'Deep' })
    const engine = new WorkflowEngine(store)
    const workflow = WorkflowDefinition.parse({
      id: 'chain', lane: 'deep', steps: [
        { id: 'a', title: 'a', role: 'implement' },
        { id: 'b', title: 'b', role: 'review', dependsOn: ['a'] },
        { id: 'c', title: 'c', role: 'integrate', dependsOn: ['b'] },
      ],
    })
    const run = engine.start(thread, workflow)
    engine.transition(run, 'a', 'running')
    engine.transition(run, 'a', 'failed')
    // A failed step used to leave the run 'running' forever with b and c
    // permanently pending — limbo dressed as progress.
    const states = store.workflowStepStates(run) as Record<string, string>
    expect(states.b).toBe('blocked')
    expect(states.c).toBe('blocked')
    expect(store.workflowRun(run)?.status).toBe('failed')
    expect(store.workflowRun(run)?.ended_at).not.toBeNull()
    store.close()
  })

  it('projects a blocked run when nothing failed but nothing can proceed', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'arc-workflow-')))
    const thread = store.createThread({ repo: '/repo', title: 'Deep' })
    const engine = new WorkflowEngine(store)
    const workflow = WorkflowDefinition.parse({
      id: 'pair', lane: 'deep', steps: [
        { id: 'a', title: 'a', role: 'implement' },
        { id: 'b', title: 'b', role: 'review', dependsOn: ['a'] },
      ],
    })
    const run = engine.start(thread, workflow)
    engine.transition(run, 'a', 'running')
    engine.transition(run, 'a', 'blocked')
    expect((store.workflowStepStates(run) as Record<string, string>).b).toBe('blocked')
    expect(store.workflowRun(run)?.status).toBe('blocked')
    store.close()
  })

  it('marks a run done only after every stage succeeds or is waived', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'arc-workflow-')))
    const thread = store.createThread({ repo: '/repo', title: 'Chat' })
    const engine = new WorkflowEngine(store)
    const run = engine.start(thread, builtInWorkflow('chat'))
    engine.transition(run, 'respond', 'running')
    engine.transition(run, 'respond', 'done')
    expect(store.workflowRun(run)?.status).toBe('done')
    expect(() => engine.transition(run, 'respond', 'running')).toThrow(/already done/)
    store.close()
  })
})
