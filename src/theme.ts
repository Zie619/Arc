/**
 * The palette. Every colour in the interface comes from here.
 *
 * Centralised so a retheme is one file rather than a hunt through three
 * components — and so the meaning of a colour is named once. `theme.sol` is
 * "the colour Sol is", not "cyan", which is what stops the same idea drifting
 * to three different shades.
 *
 * Hex is used deliberately: Ink degrades hex to the nearest 256-colour on
 * terminals that cannot do truecolor, which is better than picking a flat
 * ANSI name that looks wrong everywhere.
 */

export const theme = {
  // ---- the violet spine -------------------------------------------------
  /** Headings, the prompt caret, the thing your eye should land on. */
  accent: '#a78bfa',
  /** Rules, borders, the frame around things. Present but quiet. */
  accentDim: '#6d5aa8',
  /** Live activity — the spinner, the step in progress. Brighter than accent. */
  accentBright: '#c4b5fd',
  /** Deep violet for filled areas and selected rows. */
  accentDeep: '#7c3aed',

  // ---- the two agents, always the same colours ---------------------------
  /** Sol writes the code. */
  sol: '#22d3ee',
  /** Opus reviews it. */
  opus: '#f0abfc',

  // ---- semantics, kept away from the accent so they still read as status --
  ok: '#4ade80',
  warn: '#fbbf24',
  bad: '#fb7185',

  // ---- text -------------------------------------------------------------
  text: undefined as string | undefined,   // the terminal's own foreground
  muted: '#8b8296',
  faint: '#5c556b',
} as const

/** Which colour an agent is, by the CLI it runs on. */
export function agentColor(cli: string): string {
  return cli === 'codex' ? theme.sol : theme.opus
}

/** What we call an agent. Sol and Opus, not codex and claude. */
export function agentName(cli: string): string {
  return cli === 'codex' ? 'Sol' : 'Opus'
}

/**
 * A soft violet gradient across a string, brightest in the middle.
 *
 * Used once, on the wordmark. Applied to anything else it would be noise —
 * the point of an accent is that it is rare.
 */
export function gradient(s: string): Array<{ char: string; color: string }> {
  const ramp = ['#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#a78bfa', '#8b5cf6']
  return [...s].map((char, i) => ({ char, color: ramp[i % ramp.length]! }))
}
