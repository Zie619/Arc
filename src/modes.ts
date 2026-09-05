/**
 * How much it asks before doing things.
 *
 * Shift+tab cycles. The order is deliberate: each step gives up one gate, so
 * cycling always moves in one direction of trust and you can predict what the
 * next press does without reading the label.
 */

export type ModeName = 'ask' | 'auto' | 'danger' | 'plan'

export interface Mode {
  name: ModeName
  label: string
  /** One line, shown under the prompt. Says what it will and will not do. */
  hint: string
  /** Ask the operator the interview's questions? */
  asksQuestions: boolean
  /** Stop for approval before building? */
  asksApproval: boolean
  /** Stop after producing the plan, without building at all. */
  planOnly: boolean
}

export const MODES: Mode[] = [
  {
    name: 'ask',
    label: 'asks first',
    hint: 'asks questions, shows the plan, waits for approval',
    asksQuestions: true,
    asksApproval: true,
    planOnly: false,
  },
  {
    name: 'auto',
    label: 'auto',
    hint: 'takes recommendations; waits for approval to build',
    asksQuestions: false,
    asksApproval: true,
    planOnly: false,
  },
  {
    name: 'danger',
    label: 'danger',
    hint: 'approves decisions and starts builds without asking',
    asksQuestions: false,
    asksApproval: false,
    planOnly: false,
  },
  {
    name: 'plan',
    label: 'plan only',
    hint: 'interviews, reads your code and plans — but never builds',
    asksQuestions: true,
    asksApproval: false,
    planOnly: true,
  },
]

export function mode(name: ModeName): Mode {
  return MODES.find((m) => m.name === name) ?? MODES[0]!
}

export function nextMode(current: ModeName): ModeName {
  const i = MODES.findIndex((m) => m.name === current)
  return MODES[(i + 1) % MODES.length]!.name
}

export function prevMode(current: ModeName): ModeName {
  const i = MODES.findIndex((m) => m.name === current)
  return MODES[(i - 1 + MODES.length) % MODES.length]!.name
}
