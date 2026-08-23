import { Store } from './store.ts'
import {
  WorkflowDefinition,
  computeWorkflowFrontier,
  validateWorkflow,
  type WorkflowStep,
  type WorkflowStepState,
} from './workflow.ts'

const TERMINAL = new Set<WorkflowStepState>(['done', 'failed', 'blocked', 'waived'])

/** Durable workflow state machine. Crashes recover from rows, not agent chat. */
export class WorkflowEngine {
  constructor(readonly store: Store) {}

  start(threadId: string, input: WorkflowDefinition, id?: string): string {
    const workflow = WorkflowDefinition.parse(input)
    const errors = validateWorkflow(workflow)
    if (errors.length) throw new Error(`invalid workflow:\n${errors.map((error) => `- ${error}`).join('\n')}`)
    return this.store.createWorkflowRun(threadId, workflow, id)
  }

  definition(runId: string): WorkflowDefinition {
    const row = this.store.workflowRun(runId)
    if (!row) throw new Error(`workflow run "${runId}" does not exist`)
    return WorkflowDefinition.parse(JSON.parse(String(row.definition_json)))
  }

  frontier(runId: string, concurrency: number): WorkflowStep[] {
    return computeWorkflowFrontier(
      this.definition(runId),
      this.store.workflowStepStates(runId) as Record<string, WorkflowStepState>,
      concurrency,
    )
  }

  transition(runId: string, stepId: string, next: WorkflowStepState): void {
    const states = this.store.workflowStepStates(runId) as Record<string, WorkflowStepState>
    const current = states[stepId]
    if (!current) throw new Error(`workflow step "${runId}/${stepId}" does not exist`)
    if (TERMINAL.has(current)) throw new Error(`workflow step "${stepId}" is already ${current}`)
    if (next === 'running') {
      if (current !== 'pending') throw new Error(`cannot start "${stepId}" from ${current}`)
      const ready = new Set(this.frontier(runId, Number.MAX_SAFE_INTEGER).map((step) => step.id))
      if (!ready.has(stepId)) throw new Error(`workflow step "${stepId}" is not on the frontier`)
    } else if (!TERMINAL.has(next) || current !== 'running') {
      throw new Error(`cannot move "${stepId}" from ${current} to ${next}`)
    }
    this.store.setWorkflowStepState(runId, stepId, next)
    // A failed/blocked step makes every pending step downstream of it
    // unreachable. Blocking them here is what lets the run project a terminal
    // failed/blocked status instead of sitting 'running' forever.
    if (next === 'failed' || next === 'blocked') this.blockUnreachable(runId)
  }

  private blockUnreachable(runId: string): void {
    const workflow = this.definition(runId)
    const states = this.store.workflowStepStates(runId) as Record<string, WorkflowStepState>
    const dead = new Set(Object.entries(states)
      .filter(([, state]) => state === 'failed' || state === 'blocked')
      .map(([id]) => id))
    let grew = true
    while (grew) {
      grew = false
      for (const step of workflow.steps) {
        if (dead.has(step.id) || states[step.id] !== 'pending') continue
        if (step.dependsOn.some((dep) => dead.has(dep))) {
          dead.add(step.id)
          states[step.id] = 'blocked'
          this.store.setWorkflowStepState(runId, step.id, 'blocked')
          grew = true
        }
      }
    }
  }
}
