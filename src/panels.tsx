import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { useRawKeys } from './prompt.tsx'
import { clip, Section, useTerminalSize, windowStart } from './terminal-ui.tsx'
import { theme } from './theme.ts'

export const LANES = [
  { id: 'auto', title: 'Choose for me', detail: 'ARC selects a workflow for each request.', effect: 'Good default when you know the outcome you want.' },
  { id: 'direct', title: 'Small change', detail: 'Edit the current checkout, run checks, and review.', effect: 'Changes stay uncommitted in your checkout.' },
  { id: 'deep', title: 'Multi-agent mission', detail: 'Plan dependent tasks, build in worktrees, and verify together.', effect: 'Use for larger work, isolation, and crash recovery.' },
  { id: 'research', title: 'Investigate', detail: 'Read the repository and return findings with evidence.', effect: 'No implementation agent is started.' },
  { id: 'review', title: 'Review changes', detail: 'Check the current diff and independently review it.', effect: 'Reports findings without repairing the checkout.' },
  { id: 'plan', title: 'Make a plan', detail: 'Clarify the goal, investigate, and design tasks.', effect: 'Stops before implementation.' },
  { id: 'chat', title: 'Conversation', detail: 'Discuss the request without starting a build.', effect: 'Use another workflow when you are ready for work.' },
] as const

export function LanePicker({ current, onChoose, onCancel }: { current: string; onChoose: (lane: string) => void; onCancel: () => void }) {
  const { width, rows } = useTerminalSize()
  const [selected, setSelected] = useState(() => Math.max(0, LANES.findIndex((l) => l.id === current)))
  const count = Math.max(3, Math.min(7, (rows ?? 30) - 12))
  const first = windowStart(selected, LANES.length, count)
  const lane = LANES[selected]!
  useRawKeys((key) => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { onCancel(); return }
    if (key.name === 'up') setSelected((n) => Math.max(0, n - 1))
    if (key.name === 'down') setSelected((n) => Math.min(LANES.length - 1, n + 1))
    if (key.name === 'return') onChoose(lane.id)
  })
  return <Box flexDirection="column" paddingY={1}>
    <Section title="Choose a workflow" hint="for this thread" width={width} />
    <Box flexDirection="column" paddingX={1} marginY={1}>
      {LANES.slice(first, first + count).map((l) => <Text key={l.id} color={l.id === lane.id ? theme.accentBright : undefined} bold={l.id === lane.id}>
        {l.id === lane.id ? '❯ ' : '  '}{clip(`${l.title} · ${l.id}${l.id === current ? ' (current)' : ''}`, width - 4)}
      </Text>)}
    </Box>
    <Box flexDirection="column" paddingX={1}>
      <Text>{lane.detail}</Text>
      <Text color={theme.muted}>{lane.effect}</Text>
      <Text color={theme.muted}>↑↓ choose · enter select · esc back</Text>
    </Box>
  </Box>
}

export function Welcome({ width, returning = false }: { width: number; returning?: boolean }) {
  return <Box flexDirection="column" paddingX={1} marginTop={1}>
    <Text bold>{returning ? 'Pick up where you left off.' : 'Turn a request into checked work.'}</Text>
    <Text color={theme.muted}>{width < 60 ? 'Describe the outcome. ARC guides the work.' : 'Describe the outcome. ARC plans, builds, reviews, and checks the result.'}</Text>
    <Text color={theme.accent}>{clip('/lane choose a workflow · /dashboard view runs', width - 2)}</Text>
    {width >= 60 && <Text color={theme.muted}>/help all commands · /model choose your agents</Text>}
  </Box>
}
