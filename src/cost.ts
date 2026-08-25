/**
 * What fraction of the input we did NOT pay full price for. A 5-minute cache
 * write costs 1.25x base input and a read costs 0.1x, so a prefix reused even
 * once has already paid for itself — which makes this ratio the number that
 * decides whether any caching work is worth doing at all.
 */
export function cacheHitRatio(row: Record<string, any>): string {
  const read = Number(row.cached_input_tokens ?? 0)
  const total = read + Number(row.cache_write_tokens ?? 0) + Number(row.input_tokens ?? 0)
  if (total === 0) return '—'
  return `${formatTokenCount(read)}, ${Math.round((read / total) * 100)}%`
}

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
      `in ${formatTokenCount(row.billed_input_tokens ?? row.input_tokens).padStart(7)} (${cacheHitRatio(row)} cached)  ` +
      `out ${formatTokenCount(row.output_tokens).padStart(6)}  reasoning ${formatTokenCount(row.reasoning_tokens)}` +
      (row.cost_usd ? `  $${Number(row.cost_usd).toFixed(2)}` : '')
  })
  return { lines, missing }
}
