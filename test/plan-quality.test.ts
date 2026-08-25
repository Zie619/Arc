import { describe, expect, it } from 'vitest'
import { lintShell } from '../src/shell-lint.ts'
import { validatePlan } from '../src/scheduler.ts'
import type { Plan, PlanTask } from '../src/types.ts'

function task(id: string, over: Partial<PlanTask> = {}): PlanTask {
  return {
    id, title: id, spec: 'do it', dependsOn: [],
    footprint: [`${id}.ts`], contractsMutated: ['none'], contractsRead: [], gates: [],
    acceptance: [{
      id: 'c1', text: 'works', proofKind: 'command',
      proofCommand: 'test -f out.ts', polarity: 'discriminating', requiredTier: 'checked',
    }],
    ...over,
  } as PlanTask
}
const plan = (...tasks: PlanTask[]): Plan =>
  ({ arcId: 'test', charter: { goal: 'g', objectives: [], nonGoals: [] }, tasks })

describe('model-authored shell is linted before anything runs it', () => {
  it('catches the exact bug that started this, and names the fix', () => {
    // Reproduced on this machine: BSD `wc -l` pads to width 8, so
    //   printf '' | wc -l | grep -qx 0   → exit 1. FAILS.
    //   [ "$(printf '' | wc -l)" -eq 0 ] → exit 0. PASSES.
    const issues = lintShell(`rg -n 'foo' src/ | wc -l | grep -qx 0`)
    expect(issues.map((i) => i.rule)).toContain('wc-l-string-compare')
    expect(issues[0]!.message).toContain('-eq 0')
  })

  it('catches grep -c reporting failure exactly when the assertion is true', () => {
    // `grep -c` exits 1 on a zero count and prints nothing, so "there are no
    // matches" is reported as a failure precisely when it holds.
    expect(lintShell('git grep -c TODO src/ | grep -qx 0').map((i) => i.rule)).toContain('grep-c-zero')
    expect(lintShell('grep -c needle file.txt').map((i) => i.rule)).toContain('grep-c-zero')
    // The portable expression it should have reached for is clean.
    expect(lintShell('! grep -rq pattern src/')).toEqual([])
  })

  it('catches a pipeline whose last stage swallows the real exit code', () => {
    expect(lintShell('npm test | tail -5').map((i) => i.rule)).toContain('exit-code-masked')
  })

  it('catches the GNU-isms that simply are not present on macOS', () => {
    for (const [command, rule] of [
      ["sed -i 's/a/b/' f.ts", 'sed-i-suffix'],
      ["date -d '1 day ago'", 'date-d'],
      ['timeout 30 npm test', 'timeout-missing'],
      ["grep -P '\\d+' f", 'grep-P'],
      ["echo -e 'a'", 'echo-e'],
      ['stat -c %s f', 'stat-c'],
      ['ls src/ | grep foo', 'ls-parsing'],
    ] as const) {
      expect(lintShell(command).map((i) => i.rule), command).toContain(rule)
    }
  })

  it('leaves the commands a careful author would write alone', () => {
    for (const clean of ['npx tsc --noEmit', 'test -f src/cost.ts', 'pnpm test', '! grep -rq TODO src/']) {
      expect(lintShell(clean), clean).toEqual([])
    }
  })

  it('feeds the planner through validatePlan rather than failing at run time', () => {
    const errors = validatePlan(plan(task('a', {
      acceptance: [{
        id: 'c1', text: 'no todos', proofKind: 'command',
        proofCommand: `rg TODO src/ | wc -l | grep -qx 0`, polarity: 'discriminating', requiredTier: 'checked',
      }],
    } as Partial<PlanTask>)))
    expect(errors.join('\n')).toContain('wc-l-string-compare')
  })
})

describe('the plan is checked for being GOOD, not merely well-formed', () => {
  const charter = { goal: 'g', objectives: ['ship the importer', 'keep the API stable'], nonGoals: [] }
  const withCharter = (...tasks: PlanTask[]): Plan => ({ arcId: 'test', charter, tasks })

  it('refuses a plan that quietly drops an objective', () => {
    const errors = validatePlan(withCharter(task('a', { covers: ['ship the importer'] } as Partial<PlanTask>)))
    expect(errors.join('\n')).toContain('no task covers the objective "keep the API stable"')
  })

  it('refuses a task that exists for no stated reason', () => {
    const errors = validatePlan(withCharter(
      task('a', { covers: charter.objectives } as Partial<PlanTask>),
      task('b'),
    ))
    expect(errors.join('\n')).toContain('task "b" covers no charter objective')
  })

  it('stays quiet for plans written before coverage existed', () => {
    // Enforced only once ANY task declares coverage, so nothing already on disk
    // becomes invalid overnight.
    expect(validatePlan(withCharter(task('a'), task('b')))).toEqual([])
  })

  it('refuses a criterion nobody could fail', () => {
    const errors = validatePlan(withCharter(task('a', {
      acceptance: [{
        id: 'c1', text: 'the importer handles duplicates properly', proofKind: 'agent-review',
        polarity: 'discriminating', requiredTier: 'claimed',
      }],
    } as Partial<PlanTask>)))
    expect(errors.join('\n')).toContain('says "properly"')
  })
})
