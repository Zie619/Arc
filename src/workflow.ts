import { z } from 'zod'

/** The product lane is separate from approval/trust mode. */
export const Lane = z.enum(['chat', 'direct', 'research', 'plan', 'review', 'deep'])
export type Lane = z.infer<typeof Lane>

export const WorkflowRole = z.enum(['head', 'triage', 'scout', 'implement', 'review', 'integrate'])
export type WorkflowRole = z.infer<typeof WorkflowRole>

export const StageMode = z.enum(['one', 'fan_out', 'fan_in'])
export type StageMode = z.infer<typeof StageMode>

export const WorkflowStep = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mode: StageMode.default('one'),
  role: WorkflowRole,
  dependsOn: z.array(z.string()).default([]),
  consumes: z.array(z.string()).default([]),
  produces: z.array(z.string()).default([]),
  contractsRead: z.array(z.string()).default([]),
  contractsMutated: z.array(z.string()).default([]),
  footprint: z.array(z.string()).default([]),
  maxAttempts: z.number().int().positive().default(1),
  requiresApproval: z.boolean().default(false),
  writeCapable: z.boolean().default(false),
})
export type WorkflowStep = z.infer<typeof WorkflowStep>

export const WorkflowDefinition = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  lane: Lane,
  steps: z.array(WorkflowStep).min(1),
})
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>

export type WorkflowStepState = 'pending' | 'running' | 'blocked' | 'failed' | 'done' | 'waived'

/** Structural validation happens before a generated workflow can be snapshotted. */
export function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const producers = new Map<string, string>()

  for (const step of workflow.steps) {
    if (ids.has(step.id)) errors.push(`duplicate step id "${step.id}"`)
    ids.add(step.id)
    if (step.mode === 'fan_in' && step.dependsOn.length === 0) {
      errors.push(`fan-in step "${step.id}" has no upstream steps`)
    }
    for (const artifact of step.produces) {
      const prior = producers.get(artifact)
      if (prior) errors.push(`artifact "${artifact}" is produced by both "${prior}" and "${step.id}"`)
      else producers.set(artifact, step.id)
    }
  }

  for (const step of workflow.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) errors.push(`step "${step.id}" depends on unknown step "${dep}"`)
      if (dep === step.id) errors.push(`step "${step.id}" depends on itself`)
    }
    for (const artifact of step.consumes) {
      if (!producers.has(artifact)) errors.push(`step "${step.id}" consumes unknown artifact "${artifact}"`)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(workflow.steps.map((step) => [step.id, step]))
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep) && visit(dep)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  if (workflow.steps.some((step) => visit(step.id))) errors.push('workflow contains a dependency cycle')

  return [...new Set(errors)]
}

function pathsOverlap(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/^\.\//, '').replace(/\/$/, '')
  const x = clean(a)
  const y = clean(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

function collides(a: WorkflowStep, b: WorkflowStep): boolean {
  const aMut = new Set(a.contractsMutated)
  const bMut = new Set(b.contractsMutated)
  if (b.contractsRead.some((c) => aMut.has(c))) return true
  if (a.contractsRead.some((c) => bMut.has(c))) return true
  if (b.contractsMutated.some((c) => aMut.has(c))) return true
  return a.footprint.some((x) => b.footprint.some((y) => pathsOverlap(x, y)))
}

/** Pure frontier calculation for durable stage rows. */
export function computeWorkflowFrontier(
  workflow: WorkflowDefinition,
  state: Record<string, WorkflowStepState>,
  concurrency: number,
): WorkflowStep[] {
  const active = workflow.steps.filter((step) => state[step.id] === 'running')
  const capacity = Math.max(0, concurrency - active.length)
  if (capacity === 0) return []

  const candidates = workflow.steps.filter((step) => {
    if ((state[step.id] ?? 'pending') !== 'pending') return false
    return step.dependsOn.every((dep) => state[dep] === 'done' || state[dep] === 'waived')
  })
  const selected: WorkflowStep[] = []
  for (const step of candidates) {
    if ([...active, ...selected].some((other) => collides(step, other))) continue
    selected.push(step)
    if (selected.length === capacity) break
  }
  return selected
}

function step(
  id: string,
  role: WorkflowRole,
  dependsOn: string[],
  over: Partial<WorkflowStep> = {},
): WorkflowStep {
  return WorkflowStep.parse({ id, title: id.replaceAll('-', ' '), role, dependsOn, ...over })
}

/** Built-ins are data. Skills may contribute additional validated definitions. */
export function builtInWorkflow(lane: Lane): WorkflowDefinition {
  const definitions: Record<Lane, WorkflowStep[]> = {
    chat: [step('respond', 'head', [])],
    direct: [
      step('implement', 'implement', [], { writeCapable: true, produces: ['change'] }),
      step('gate', 'integrate', ['implement'], { consumes: ['change'], produces: ['gate-evidence'] }),
      step('review', 'review', ['gate'], { consumes: ['change', 'gate-evidence'], produces: ['review'] }),
    ],
    research: [
      step('map', 'head', [], { produces: ['map'] }),
      step('gather-evidence', 'scout', ['map'], { mode: 'fan_out', consumes: ['map'], produces: ['evidence'] }),
      step('synthesize', 'head', ['gather-evidence'], { mode: 'fan_in', consumes: ['evidence'], produces: ['synthesis'] }),
    ],
    plan: [
      step('clarify', 'head', [], { produces: ['charter'], requiresApproval: true }),
      step('map', 'scout', ['clarify'], { mode: 'fan_out', consumes: ['charter'], produces: ['map'] }),
      step('plan', 'head', ['map'], { mode: 'fan_in', consumes: ['charter', 'map'], produces: ['plan'] }),
    ],
    review: [
      step('predict-risks', 'review', [], { produces: ['risk-checklist'] }),
      step('review-diff', 'review', ['predict-risks'], { consumes: ['risk-checklist'], produces: ['review'] }),
      step('verify-findings', 'integrate', ['review-diff'], { consumes: ['review'], produces: ['verified-review'] }),
    ],
    deep: [
      step('clarify', 'head', [], { produces: ['charter'], requiresApproval: true }),
      step('map-contracts', 'scout', ['clarify'], { mode: 'fan_out', consumes: ['charter'], produces: ['map'] }),
      step('synthesize-evidence', 'head', ['map-contracts'], { mode: 'fan_in', consumes: ['map'], produces: ['synthesis'] }),
      step('plan', 'head', ['synthesize-evidence'], { consumes: ['charter', 'synthesis'], produces: ['plan'], requiresApproval: true }),
      step('implement', 'implement', ['plan'], { mode: 'fan_out', consumes: ['plan'], produces: ['changes'], writeCapable: true, maxAttempts: 4 }),
      step('gate', 'integrate', ['implement'], { mode: 'fan_in', consumes: ['changes'], produces: ['gate-evidence'] }),
      step('task-review', 'review', ['gate'], { mode: 'fan_out', consumes: ['changes', 'gate-evidence'], produces: ['task-reviews'] }),
      step('integrate', 'integrate', ['task-review'], { mode: 'fan_in', consumes: ['changes', 'task-reviews'], produces: ['integration'], writeCapable: true }),
      step('integration-review', 'review', ['integrate'], { consumes: ['charter', 'integration'], produces: ['integration-review'] }),
      step('deliver', 'integrate', ['integration-review'], { consumes: ['integration-review'] }),
    ],
  }
  return WorkflowDefinition.parse({ id: `builtin-${lane}`, lane, steps: definitions[lane] })
}
