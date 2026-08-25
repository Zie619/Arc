import { z } from 'zod'

/** The product lane is separate from approval/trust mode. */
/**
 * A declarative workflow IR whose authoritative executor was never built.
 *
 * What remains is the honest part: `builtInWorkflow(lane).steps.length`, read
 * once (service.ts → app.tsx) to print a stage count. `WorkflowEngine`,
 * `computeWorkflowFrontier` and `validateWorkflow` were DELETED rather than
 * kept — they had no production caller, and their passing tests reported
 * coverage of a subsystem that never ran, which is worse than no coverage
 * because it reads as reassurance.
 *
 * Finishing it instead would mean re-platforming the orchestrator, the direct
 * lane and the review lane onto one interpreter. Those three are not naive:
 * each is a long list of incident-driven fixes earned by dogfooding, and
 * direct.ts's hand-tuned concurrency is BETTER than a generic scheduler would
 * produce for a two-node graph.
 *
 * The trigger to revisit is a genuinely new lane forcing a FOURTH hand-rolled
 * tick loop. Not a date.
 */
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
