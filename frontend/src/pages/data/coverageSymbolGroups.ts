import type { BarCoverageItem } from '../../types'

/** Same grouping as IB Live Data Coverage: Indices (reference_indices) vs Watchlist. */
export function splitCoverageByReferenceIndices(
  coverage: BarCoverageItem[],
  referenceIndices: { symbol: string; label?: string }[] | undefined,
): { label: string; rows: BarCoverageItem[] }[] {
  if (!coverage || coverage.length === 0) return []
  const refSymbols = new Set((referenceIndices ?? []).map((r) => r.symbol))
  const indices = coverage.filter((r) => refSymbols.has(r.symbol))
  const watchlist = coverage.filter((r) => !refSymbols.has(r.symbol))
  const out: { label: string; rows: BarCoverageItem[] }[] = []
  if (indices.length > 0) out.push({ label: 'Indices', rows: indices })
  if (watchlist.length > 0) out.push({ label: 'Watchlist', rows: watchlist })
  return out.length > 0 ? out : [{ label: '', rows: coverage }]
}
