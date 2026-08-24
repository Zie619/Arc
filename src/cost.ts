export function formatTokenCount(n: number | null): string {
  if (n == null || n === 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

export function formatCostSummary(rows: Array<Record<string, any>>): { lines: string[]; missing: number } {
  let missing = 0
  const lines = rows.map((row) => {
    const mins = Math.round(Number(row.wall_ms) / 60_000)
    missing += Number(row.attempts) - Number(row.receipted)
    return `  ${String(row.role).padEnd(10)} ${String(row.cli).padEnd(7)} ${String(row.attempts).padStart(2)} attempt(s)  ${String(mins).padStart(4)}min  ` +
      `in ${formatTokenCount(row.input_tokens).padStart(7)} (${formatTokenCount(row.cached_input_tokens)} cached)  ` +
      `out ${formatTokenCount(row.output_tokens).padStart(6)}  reasoning ${formatTokenCount(row.reasoning_tokens)}` +
      (row.cost_usd ? `  $${Number(row.cost_usd).toFixed(2)}` : '')
  })
  return { lines, missing }
}
