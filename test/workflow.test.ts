import { describe, expect, it } from 'vitest'
import { Lane, builtInWorkflow } from '../src/workflow.ts'

/**
 * What survives of the workflow IR. `WorkflowEngine`, `computeWorkflowFrontier`
 * and `validateWorkflow` were deleted with their tests: no production path
 * reached them, and a green suite over dead code reads as reassurance about a
 * subsystem that never ran.
 *
 * The one real consumer counts stages for a UI label, so that is what is tested.
 */
describe('the built-in lane definitions', () => {
  it('gives every lane at least one stage, with resolvable dependencies', () => {
    for (const lane of Lane.options) {
      const workflow = builtInWorkflow(lane)
      expect(workflow.steps.length, lane).toBeGreaterThan(0)
      const ids = new Set(workflow.steps.map((s) => s.id))
      for (const step of workflow.steps) {
        for (const dep of step.dependsOn) expect(ids, `${lane}/${step.id}`).toContain(dep)
      }
    }
  })
})
