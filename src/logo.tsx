import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.ts'

/**
 * The mark: a violet arc with the two agents riding it — cyan for the writer,
 * magenta for the reviewer — same picture as the README hero. Small enough to
 * sit top-left of the screen and be recognized in a tab full of terminals.
 */
export function ArcLogo() {
  return (
    <Box flexDirection="column">
      <Text>
        {'  '}<Text color={theme.accent}>▄▄</Text>
        <Text color="magenta">█</Text>
        <Text color={theme.accent}>▄▄</Text>
      </Text>
      <Text>
        {' '}<Text color="cyan">▟</Text>
        <Text color={theme.accent}>▀   ▀</Text>
        <Text color={theme.accent}>▙</Text>
      </Text>
      <Text>
        <Text color={theme.accent}>▐▌</Text>
        {'     '}
        <Text color={theme.accent}>▐▌</Text>
      </Text>
    </Box>
  )
}
