import type { Execution, OptExecutionGroup } from '../../types'
import type { StrategyOpportunity } from '../../api'

export type LedgerOptSectionGroupBy = 'opportunity' | 'structure' | 'watchlist_symbol'

/** Dollar cost basis for STK snapshot: |shares| × avg cost per share. */
export function stkCostBasisFromSnapshot(
  snap: { position: number | null; avgCost: number | null } | null | undefined,
): number | null {
  if (!snap) return null
  const { position, avgCost } = snap
  if (position == null || avgCost == null) return null
  if (!Number.isFinite(position) || !Number.isFinite(avgCost)) return null
  if (Math.abs(position) < 1e-12) return null
  return Math.abs(position) * avgCost
}

/** Percent = 100 × numer / denom; null if denominator unusable. */
export function stkPctOf(numer: number, denom: number | null): number | null {
  if (denom == null || !Number.isFinite(denom) || Math.abs(denom) < 1e-6) return null
  if (!Number.isFinite(numer)) return null
  return (100 * numer) / denom
}

/** Trade size in dollars: |quantity| × price (same as summary notional sum). */
export function stkNotionalAbsUsd(ex: Execution): number | null {
  const p = Number(ex.price)
  const q = Math.abs(Number(ex.quantity) || 0)
  if (!Number.isFinite(p) || q <= 0) return null
  return q * p
}

/** Notional cell color: Buy = green, Sell = red, unknown = neutral. */
export function stkNotionalSideColorClass(ex: Execution): string {
  const s = (ex.side ?? '').toString().trim().toUpperCase()
  if (s === 'BUY' || s === 'BOT' || s === 'B') return 'replay-pnl-realized'
  if (s === 'SELL' || s === 'SLD' || s === 'S') return 'replay-pnl-detail-negative'
  return 'replay-ledger-summary-realized-zero'
}

/** Latest activity in a stock ledger group: max execution `time`, else max parsed `trade_date`. */
export function stockGroupLatestSortKey(execs: Execution[]): number {
  let maxTs = 0
  for (const ex of execs) {
    const t = Number(ex.time)
    if (Number.isFinite(t) && t > maxTs) maxTs = t
  }
  if (maxTs > 0) return maxTs
  let maxMs = 0
  for (const ex of execs) {
    const d = (ex.trade_date ?? '').trim()
    if (d.length >= 8) {
      const ms = Date.parse(`${d}T12:00:00.000Z`)
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms
    }
  }
  return maxMs / 1000
}

export function getLedgerOpportunityDimensionMeta(
  opportunityId: number | 'none',
  opportunitiesList: StrategyOpportunity[],
): { structureName: string; symbols: string[] } {
  if (opportunityId === 'none') {
    return { structureName: '—', symbols: [] }
  }
  const o = opportunitiesList.find(x => x.strategy_opportunity_id === opportunityId)
  const structureName = (o?.structure_name ?? '').trim() || '—'
  const symbols = [
    ...new Set(
      (o?.symbols ?? []).map(s => String(s).trim().toUpperCase()).filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b))
  return { structureName, symbols }
}

export function aggregateStrategyOgListStats(
  ogs: {
    instanceSubgroups: { groups: OptExecutionGroup[] }[]
  }[],
) {
  let instances = 0
  let closed = 0
  let open = 0
  let pnl = 0
  for (const og of ogs) {
    instances += og.instanceSubgroups.length
    for (const sg of og.instanceSubgroups) {
      for (const g of sg.groups) {
        if (g.status === 'realized') {
          closed++
          pnl += Number(g.realized_pnl) || 0
        } else {
          open++
        }
      }
    }
  }
  return { instances, closed, open, pnl }
}

export function aggregateInstanceIgListStats(igs: { groups: OptExecutionGroup[] }[]) {
  let closed = 0
  let open = 0
  let pnl = 0
  for (const ig of igs) {
    for (const g of ig.groups) {
      if (g.status === 'realized') {
        closed++
        pnl += Number(g.realized_pnl) || 0
      } else {
        open++
      }
    }
  }
  return { instances: igs.length, closed, open, pnl }
}

export function normalizeExpiryCompact(expiryRaw: string): string {
  return (expiryRaw || '').trim().replace(/-/g, '')
}

/** Expiry filter: year optional; month only when year set (YYYY + MM vs OPT expiry). */
export function executionMatchesExpiryYearMonth(
  expiryRaw: string | undefined,
  yearStr: string,
  monthStr: string,
): boolean {
  const y = yearStr.trim()
  if (!y) return true
  const ex = normalizeExpiryCompact(expiryRaw ?? '')
  const ys = y.slice(0, 4)
  if (!monthStr.trim()) {
    const cmp = ex.length >= 4 ? ex.slice(0, 4) : ex
    return cmp === ys
  }
  const mm = monthStr.trim().padStart(2, '0').slice(0, 2)
  const target6 = `${ys}${mm}`
  const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
  return cmp === target6
}

export function ledgerUrPnlLineClass(v: number): string {
  if (v > 0) return 'replay-pnl-realized'
  if (v < 0) return 'replay-pnl-detail-negative'
  return 'replay-ledger-summary-realized-zero'
}

/** YYYY-MM-DD → M/D for compact trade-window hints */
export function fmtMdHint(iso: string): string {
  const s = String(iso ?? '').trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return s
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`
}
