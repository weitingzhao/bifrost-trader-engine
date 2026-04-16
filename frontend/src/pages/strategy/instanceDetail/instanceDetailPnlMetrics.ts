import type { Execution } from '../../../types'
import { fmtExpiry, parseOptionContractKey } from '../../../utils/format'
import { buildOptExecutionGroups } from '../../portfolio/buildOptExecutionGroups'

/** Same epsilon as {@link buildOptExecutionGroups} net flat check. */
const NET_QTY_EPS = 1e-9

/**
 * Instance position state from performance-book execution rows (this instance’s qty).
 * Per contract: buy volume vs sell volume → net qty; **Closed** when every contract is flat (net ≈ 0).
 */
export type InstancePositionStatus = 'no_fills' | 'open' | 'closed'

export function computeInstancePositionStatus(executions: Execution[]): InstancePositionStatus {
  if (!executions.length) return 'no_fills'

  const optGroups = buildOptExecutionGroups(executions)
  for (const g of optGroups) {
    if (Math.abs(g.net_qty) >= NET_QTY_EPS) return 'open'
  }

  const nonOpt = executions.filter((e) => (e.sec_type ?? '').toUpperCase() !== 'OPT')
  const keyOf = (e: Execution) => {
    const ck = (e.contract_key ?? '').trim()
    if (ck !== '') return ck
    const sym = (e.symbol ?? '').trim().split(/\s+/)[0] ?? ''
    const st = (e.sec_type ?? '').toUpperCase() || '—'
    return `${sym}|${st}`
  }
  const byKey = new Map<string, Execution[]>()
  for (const e of nonOpt) {
    const k = keyOf(e)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(e)
  }
  for (const [, trades] of byKey) {
    let net = 0
    for (const t of trades) {
      const q = Math.abs(Number(t.quantity) || 0)
      if (q < NET_QTY_EPS) continue
      const side = (t.side ?? '').toUpperCase()
      if (side === 'BUY' || side === 'BOT' || side === 'B') net += q
      else if (side === 'SELL' || side === 'SLD' || side === 'S') net -= q
    }
    if (Math.abs(net) >= NET_QTY_EPS) return 'open'
  }

  return 'closed'
}

/** IB-style sell side (open short / sell to open / sell leg). */
export function isExecutionSellSide(e: Execution): boolean {
  const s = (e.side ?? '').toUpperCase().trim()
  return s === 'SELL' || s === 'SLD' || s === 'S'
}

/** Parse YYYY-MM-DD to UTC ms; invalid → null. */
function parseYmdToUtcMs(s: string | null | undefined): number | null {
  if (s == null || typeof s !== 'string') return null
  const t = s.trim().slice(0, 10)
  if (t.length < 10) return null
  const ms = Date.parse(`${t}T12:00:00.000Z`)
  return Number.isFinite(ms) ? ms : null
}

function executionStrikeUsd(e: Execution): number | null {
  const direct = Number(e.strike)
  if (Number.isFinite(direct) && direct > 0) return direct
  const parsed = parseOptionContractKey(e.contract_key)
  const fromKey = Number(parsed.strike)
  if (Number.isFinite(fromKey) && fromKey > 0) return fromKey
  return null
}

/** One sell-side OPT row contributing to underlying cost (this instance’s execution slice). */
export type UnderlyingCostSellLine = {
  contractKey: string
  strike: number
  qty: number
  lineUsd: number
  side: string
}

/**
 * Per-row breakdown: strike × |qty| × 100 for each OPT sell (SELL / SLD / S), sorted by contract key.
 */
export function underlyingCostSellBreakdown(executions: Execution[]): UnderlyingCostSellLine[] {
  const rows: UnderlyingCostSellLine[] = []
  for (const e of executions) {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
    if (!isExecutionSellSide(e)) continue
    const strike = executionStrikeUsd(e)
    if (strike == null || strike <= 0) continue
    const q = Math.abs(Number(e.quantity) || 0)
    if (q <= 0) continue
    const lineUsd = strike * q * 100
    const contractKey = (e.contract_key ?? '').trim() || `(opt|strike=${strike})`
    rows.push({ contractKey, strike, qty: q, lineUsd, side: (e.side ?? '').trim() || '—' })
  }
  rows.sort((a, b) => a.contractKey.localeCompare(b.contractKey))
  return rows
}

/** Total underlying cost: Σ lineUsd from {@link underlyingCostSellBreakdown}. */
export function underlyingCostSellOptUsd(executions: Execution[]): number {
  return underlyingCostSellBreakdown(executions).reduce((s, r) => s + r.lineUsd, 0)
}

/** Min / max `report_date` (YYYY-MM-DD) across executions; null when none. */
export function reportDateStartEnd(executions: Execution[]): { start: string | null; end: string | null } {
  let min: string | null = null
  let max: string | null = null
  for (const e of executions) {
    const raw = e.report_date
    if (raw == null || typeof raw !== 'string') continue
    const d = raw.trim().slice(0, 10)
    if (d.length < 10) continue
    if (min == null || d < min) min = d
    if (max == null || d > max) max = d
  }
  return { start: min, end: max }
}

/**
 * Same annual return % as Instance Detail PnL strip: net × (365.25 ÷ hold days used) ÷ underlying cost × 100.
 * Returns null when report span or underlying cost blocks the calculation.
 */
export function annualReturnDetailFromNetAndExecutions(
  netPnl: number | null | undefined,
  executions: Execution[],
): {
  annualReturnPct: number
  net: number
  underlyingCostUsd: number
  daysUsedForAnnual: number
  factor: number
} | null {
  const holdSpanDays = holdTimeDaysFromReportDateSpan(executions)
  if (holdSpanDays == null) return null
  const underlyingCostUsd = underlyingCostSellOptUsd(executions)
  if (underlyingCostUsd <= 0) return null
  const net = Number(netPnl)
  if (!Number.isFinite(net)) return null
  const daysUsedForAnnual = holdDaysForAnnualization(holdSpanDays)
  const factor = 365.25 / daysUsedForAnnual
  let annualReturnPct = (net * factor) / underlyingCostUsd
  if (!Number.isFinite(annualReturnPct)) annualReturnPct = 0
  annualReturnPct *= 100
  if (annualReturnPct > 999) annualReturnPct = 999
  if (annualReturnPct < -999) annualReturnPct = -999
  return { annualReturnPct, net, underlyingCostUsd, daysUsedForAnnual, factor }
}

/** Calendar span (min→max Report date) in days; null if no execution has `report_date`. */
export function holdTimeDaysFromReportDateSpan(executions: Execution[]): number | null {
  let minMs = Infinity
  let maxMs = -Infinity
  let any = false
  for (const e of executions) {
    const ms = parseYmdToUtcMs(e.report_date)
    if (ms == null) continue
    any = true
    minMs = Math.min(minMs, ms)
    maxMs = Math.max(maxMs, ms)
  }
  if (!any || !Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null
  return Math.max((maxMs - minMs) / 86400000, 0)
}

/** Hold time label: calendar days rounded to integer (no decimal days). */
export function formatHoldDaysRounded0(spanDays: number): string {
  if (!Number.isFinite(spanDays) || spanDays < 0) return '—'
  return `${Math.round(spanDays)} d`
}

/** Days used in annualization: zero span (same min/max Report date) uses a 1-day floor. */
export function holdDaysForAnnualization(spanDays: number): number {
  if (!Number.isFinite(spanDays) || spanDays < 0) return 1
  return Math.max(spanDays, 1)
}

/** Parse list End Date display (YYYY-MM-DD or YYYY-MM) to UTC ms for sorting. */
function parseEndDisplayToUtcMs(s: string | null | undefined): number | null {
  if (s == null || typeof s !== 'string') return null
  const t = s.trim()
  if (!t) return null
  if (t.length >= 10) {
    const ms = Date.parse(`${t.slice(0, 10)}T12:00:00.000Z`)
    return Number.isFinite(ms) ? ms : null
  }
  const m = t.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null
  const last = new Date(y, mo, 0).getDate()
  return Date.UTC(y, mo - 1, last, 12, 0, 0)
}

function expirySortValueFromRaw(exp: string): number {
  const d = String(exp).replace(/\D/g, '')
  if (d.length >= 8) return parseInt(d.slice(0, 8), 10)
  if (d.length >= 6) {
    const y = parseInt(d.slice(0, 4), 10)
    const m = parseInt(d.slice(4, 6), 10)
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 0
    const lastDay = new Date(y, m, 0).getDate()
    return y * 10000 + m * 100 + lastDay
  }
  return 0
}

/**
 * Latest formatted OPT expiry among option legs with non-zero net qty (open).
 * Returns null when there is no such leg or expiry cannot be parsed.
 */
export function openPositionLatestOptExpiryYmd(executions: Execution[]): string | null {
  const groups = buildOptExecutionGroups(executions)
  let bestRaw: string | null = null
  let bestVal = -Infinity
  for (const g of groups) {
    if (Math.abs(g.net_qty) < NET_QTY_EPS) continue
    const raw = String(g.expiry ?? '').trim()
    const fromKey = parseOptionContractKey(g.contract_key).expiry
    const exp = raw && raw !== '—' ? raw : fromKey !== '—' ? fromKey : ''
    if (!exp || exp === '—') continue
    const v = expirySortValueFromRaw(exp)
    if (v > bestVal) {
      bestVal = v
      bestRaw = exp
    }
  }
  if (bestRaw == null) return null
  const formatted = fmtExpiry(bestRaw)
  return formatted === '—' ? null : formatted
}

/**
 * Instance list End Date column: for **open** positions, show latest OPT expiry among open legs;
 * otherwise max `report_date` (same as before). Sort key uses the displayed date.
 */
export function instanceListEndDateColumn(
  executions: Execution[],
  positionStatus: InstancePositionStatus,
): { display: string | null; sortUtcMs: number | null; cellTitle: string | undefined } {
  const report = reportDateStartEnd(executions)
  if (positionStatus === 'open') {
    const exp = openPositionLatestOptExpiryYmd(executions)
    if (exp != null) {
      return {
        display: exp,
        sortUtcMs: parseEndDisplayToUtcMs(exp),
        cellTitle: `Option expiry (latest among open legs). Max report date: ${report.end ?? '—'}.`,
      }
    }
  }
  const sortUtcMs = parseYmdToUtcMs(report.end)
  return {
    display: report.end,
    sortUtcMs,
    cellTitle: report.end != null ? 'Max report date in the performance window.' : undefined,
  }
}
