import type { BarCoverageItem, BarCoveragePeriod } from '../../types'

/** Normalize symbol for matching coverage rows to reference_indices (trim, fullwidth ＾ → ^, uppercase). */
export function normCoverageSymbol(s: string): string {
  const t = (s || '').trim().replace(/\uFF3E/g, '^')
  return t.toUpperCase()
}

const EMPTY_PERIOD: BarCoveragePeriod = {
  count: 0,
  min_ts: null,
  max_ts: null,
  status: 'missing',
}

/** Placeholder row when a reference index is configured but not yet in GET /bars/coverage (e.g. before first Massive sync). */
export function emptyBarCoverageItem(symbol: string): BarCoverageItem {
  const s = (symbol || '').trim()
  return {
    symbol: s,
    stock_day: { ...EMPTY_PERIOD },
    stock_min: {
      '1 min': { ...EMPTY_PERIOD },
      '5 mins': { ...EMPTY_PERIOD },
      '1 hour': { ...EMPTY_PERIOD },
    },
  }
}

/** Same grouping as IB Live Data Coverage: Indices (reference_indices) vs Watchlist.
 * Ensures every configured reference index appears under Indices (with placeholder rows if needed) so Custom Bars Sync is always available.
 */
export function splitCoverageByReferenceIndices(
  coverage: BarCoverageItem[],
  referenceIndices: { symbol: string; label?: string }[] | undefined,
): { label: string; rows: BarCoverageItem[] }[] {
  const cov = coverage ?? []
  const refs = referenceIndices ?? []

  if (cov.length === 0 && refs.length === 0) {
    return []
  }

  const refSymbols = new Set(refs.map((r) => normCoverageSymbol(r.symbol)))
  const bySymbol = new Map<string, BarCoverageItem>()
  for (const r of cov) {
    const k = normCoverageSymbol(r.symbol)
    if (k) {
      bySymbol.set(k, r)
    }
  }

  const indicesRows: BarCoverageItem[] = refs.map((ref) => {
    const sym = (ref.symbol || '').trim()
    const existing = bySymbol.get(normCoverageSymbol(sym))
    if (existing) {
      return existing
    }
    return emptyBarCoverageItem(sym)
  })

  const watchlist = cov.filter((r) => !refSymbols.has(normCoverageSymbol(r.symbol)))

  const out: { label: string; rows: BarCoverageItem[] }[] = []
  if (indicesRows.length > 0) {
    out.push({ label: 'Indices', rows: indicesRows })
  }
  if (watchlist.length > 0) {
    out.push({ label: 'Watchlist', rows: watchlist })
  }

  if (out.length > 0) {
    return out
  }
  return [{ label: '', rows: cov }]
}
