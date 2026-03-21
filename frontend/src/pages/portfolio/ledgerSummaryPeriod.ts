/** Trade ledger summary aggregation: month → quarter / half-year / year. */

export type LedgerSummaryPeriod = 'month' | 'quarter' | 'half_year' | 'year'

export const LEDGER_SUMMARY_PERIOD_TABS: { id: LedgerSummaryPeriod; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'half_year', label: 'Half-year' },
  { id: 'year', label: 'Year' },
]

const MONTH_RE = /^(\d{4})-(\d{2})$/

/** Map YYYY-MM bucket key to period bucket key. */
export function monthKeyToPeriodKey(monthKey: string, period: LedgerSummaryPeriod): string {
  const m = monthKey.match(MONTH_RE)
  if (!m) return monthKey
  const y = Number(m[1])
  const month = Number(m[2]) - 1
  if (!Number.isFinite(y) || month < 0 || month > 11) return monthKey
  if (period === 'month') return monthKey
  if (period === 'year') return String(y)
  if (period === 'quarter') return `${y}-Q${Math.floor(month / 3) + 1}`
  return `${y}-H${month < 6 ? 1 : 2}`
}

function parsePeriodSortKey(k: string, period: LedgerSummaryPeriod): number[] {
  if (period === 'year') {
    const n = Number(k)
    return Number.isFinite(n) ? [n, 0] : [0, 0]
  }
  if (period === 'month') {
    const m = k.match(MONTH_RE)
    if (m) return [Number(m[1]), Number(m[2])]
    return [0, 0]
  }
  const q = k.match(/^(\d{4})-Q([1-4])$/)
  if (q) return [Number(q[1]), Number(q[2])]
  const h = k.match(/^(\d{4})-H([12])$/)
  if (h) return [Number(h[1]), Number(h[2])]
  return [0, 0]
}

/** Newest first. */
export function comparePeriodKeysDesc(a: string, b: string, period: LedgerSummaryPeriod): number {
  const ta = parsePeriodSortKey(a, period)
  const tb = parsePeriodSortKey(b, period)
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const va = ta[i] ?? 0
    const vb = tb[i] ?? 0
    if (vb !== va) return vb - va
  }
  return 0
}

export function formatPeriodLabel(key: string, period: LedgerSummaryPeriod): string {
  if (period === 'year') {
    const n = Number(key)
    return Number.isFinite(n) ? String(n) : key
  }
  if (period === 'month') return key
  const q = key.match(/^(\d{4})-Q([1-4])$/)
  if (q) return `${q[1]} Q${q[2]}`
  const h = key.match(/^(\d{4})-H([12])$/)
  if (h) return `${h[1]} H${h[2]}`
  return key
}

export function rollupOptionsFromMonthly(
  monthly: Array<[string, { count: number; realizedPnl: number }]>,
  period: LedgerSummaryPeriod,
): Array<[string, { count: number; realizedPnl: number }]> {
  const m = new Map<string, { count: number; realizedPnl: number }>()
  for (const [mk, d] of monthly) {
    const pk = monthKeyToPeriodKey(mk, period)
    const cur = m.get(pk) ?? { count: 0, realizedPnl: 0 }
    cur.count += d.count
    cur.realizedPnl += d.realizedPnl
    m.set(pk, cur)
  }
  const keys = Array.from(m.keys())
  keys.sort((a, b) => comparePeriodKeysDesc(a, b, period))
  return keys.map(k => [k, m.get(k)!])
}

export function rollupStocksFromMonthly(
  monthly: Array<[string, { count: number; notional: number; realizedPnl: number }]>,
  period: LedgerSummaryPeriod,
): Array<[string, { count: number; notional: number; realizedPnl: number }]> {
  const m = new Map<string, { count: number; notional: number; realizedPnl: number }>()
  for (const [mk, d] of monthly) {
    const pk = monthKeyToPeriodKey(mk, period)
    const cur = m.get(pk) ?? { count: 0, notional: 0, realizedPnl: 0 }
    cur.count += d.count
    cur.notional += d.notional
    cur.realizedPnl += d.realizedPnl
    m.set(pk, cur)
  }
  const keys = Array.from(m.keys())
  keys.sort((a, b) => comparePeriodKeysDesc(a, b, period))
  return keys.map(k => [k, m.get(k)!])
}
