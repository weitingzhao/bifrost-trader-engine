import type { Execution, IbAccountSnapshot, IbPositionRow } from '../../types'
import { pnlNegativeClass, pnlPositiveClass } from '@/components/shared/appUi'
import { fmtUsd, getContractLabelParts } from '../../utils/format'
import type { LivePositionRow, StockCoverageItem } from '../portfolio/types'

/** Align position vs execution contract_key: OCC local differs in segment 1; OPT|expiry|strike|right match. */
export function optExecutionMatchKey(accountId: string, contractKey: string): string {
  const acc = (accountId ?? '').trim()
  const parts = (contractKey ?? '').split('|')
  if (parts.length >= 5 && (parts[1] ?? '').toUpperCase().trim() === 'OPT') {
    const exp = (parts[2] ?? '').trim()
    const sn = parseFloat(String(parts[3] ?? '').trim())
    const strikeKey = Number.isFinite(sn) ? String(sn) : (parts[3] ?? '').trim()
    const right = (parts[4] ?? '').trim().toUpperCase().slice(0, 1)
    return `${acc}|OPT|${exp}|${strikeKey}|${right}`
  }
  return `${acc}|${(contractKey ?? '').trim()}`
}

/** OPT executions keyed like optExecutionMatchKey; from account_executions_final or executions_raw_tws lists only. */
export function buildLiveOptExecutionMap(executions: Execution[]): Map<string, Execution[]> {
  const map = new Map<string, Execution[]>()
  const opt = executions.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
  for (const ex of opt) {
    if (ex.account_executions_id == null) continue
    const key = optExecutionMatchKey(ex.account_id ?? '', ex.contract_key ?? '')
    const arr = map.get(key)
    if (arr) arr.push(ex)
    else map.set(key, [ex])
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  }
  return map
}

/**
 * Attribution / instance matching: prefer performance_book (Final); if none for this contract, use tws_raw (TWS).
 */
export function positionExecsForAttribution(full: { final: Execution[]; tws: Execution[] }): Execution[] {
  return full.final.length > 0 ? full.final : full.tws
}

export function mergeExecsUniqueById(a: Execution[], b: Execution[]): Execution[] {
  const seen = new Set<number>()
  const out: Execution[] = []
  for (const e of [...a, ...b]) {
    const id = e.account_executions_id
    if (id == null) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(e)
  }
  return out
}

export function splitOffTrackTradesBySource(
  trades: Execution[] | undefined,
  finalIds: Set<number>,
  twsIds: Set<number>,
): { final: Execution[]; tws: Execution[] } {
  const list = trades ?? []
  const final: Execution[] = []
  const tws: Execution[] = []
  for (const t of list) {
    const id = t.account_executions_id
    if (id != null && finalIds.has(id)) final.push(t)
    else if (id != null && twsIds.has(id)) tws.push(t)
    else if (id != null) final.push(t)
  }
  final.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  tws.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  return { final, tws }
}

/** Match a TWS raw row to a performance-book row (same fill): exec_id + account, else account + contract_key + exec_time. */
export function findMatchingFinalForTws(t: Execution, finals: Execution[]): Execution | null {
  const acc = (t.account_id ?? '').trim()
  const eid = (t.exec_id ?? '').trim()
  if (eid) {
    const hit = finals.find(f => (f.exec_id ?? '').trim() === eid && (f.account_id ?? '').trim() === acc)
    if (hit) return hit
  }
  const tt = t.time != null && Number.isFinite(Number(t.time)) ? Number(t.time) : null
  const ck = (t.contract_key ?? '').trim()
  if (tt == null || !ck) return null
  return (
    finals.find(f => {
      if ((f.account_id ?? '').trim() !== acc) return false
      if ((f.contract_key ?? '').trim() !== ck) return false
      const ft = f.time != null ? Number(f.time) : null
      return ft != null && Math.abs(ft - tt) < 1.5
    }) ?? null
  )
}

/** Inverse: match a final book row to a TWS raw row (same fill rules as findMatchingFinalForTws). */
export function findMatchingTwsForFinal(f: Execution, twsRows: Execution[]): Execution | null {
  const acc = (f.account_id ?? '').trim()
  const eid = (f.exec_id ?? '').trim()
  if (eid) {
    const hit = twsRows.find(t => (t.exec_id ?? '').trim() === eid && (t.account_id ?? '').trim() === acc)
    if (hit) return hit
  }
  const ft = f.time != null && Number.isFinite(Number(f.time)) ? Number(f.time) : null
  const ck = (f.contract_key ?? '').trim()
  if (ft == null || !ck) return null
  return (
    twsRows.find(t => {
      if ((t.account_id ?? '').trim() !== acc) return false
      if ((t.contract_key ?? '').trim() !== ck) return false
      const tt = t.time != null ? Number(t.time) : null
      return tt != null && Math.abs(tt - ft) < 1.5
    }) ?? null
  )
}

export function finalHasStrategyAttribution(f: Execution): boolean {
  return f.strategy_instance_id != null || f.strategy_opportunity_id != null
}

/** True when final has opp/instance set and TWS row differs (needs sync). */
export function twsNeedsStrategySyncFromFinal(t: Execution, f: Execution): boolean {
  if (!finalHasStrategyAttribution(f)) return false
  const siT = t.strategy_instance_id ?? null
  const soT = t.strategy_opportunity_id ?? null
  const siF = f.strategy_instance_id ?? null
  const soF = f.strategy_opportunity_id ?? null
  return siT !== siF || soT !== soF
}

/** True when TWS row has opp/instance set and final book row differs (needs sync the other way). */
export function finalNeedsStrategySyncFromTws(f: Execution, t: Execution): boolean {
  if (!finalHasStrategyAttribution(t)) return false
  const siT = t.strategy_instance_id ?? null
  const soT = t.strategy_opportunity_id ?? null
  const siF = f.strategy_instance_id ?? null
  const soF = f.strategy_opportunity_id ?? null
  return siT !== siF || soT !== soF
}

/** Open Options Contract column: icon before label from merged Final+TWS executions (deduped). */
export function instanceIconFillFromMergedExecutions(merged: Execution[]): 'empty' | 'none' | 'all' | 'mixed' {
  if (merged.length === 0) return 'empty'
  let withInstance = 0
  for (const ex of merged) {
    if (ex.strategy_instance_id != null) withInstance += 1
  }
  if (withInstance === 0) return 'none'
  if (withInstance === merged.length) return 'all'
  return 'mixed'
}

/** Option Last-column (Last − Strike) / Last %: color by right and side. Call+Sell: +% red, −% green; Call+Buy: opposite; Put+Sell: +% green, −% red; Put+Buy: opposite. */
export function optionLastStrikePctClass(right: string, side: 'Buy' | 'Sell', pct: number): string {
  if (pct === 0 || (right !== 'C' && right !== 'P')) return ''
  const positive = pct > 0
  if (right === 'C') {
    if (side === 'Sell') return positive ? pnlNegativeClass : pnlPositiveClass
    return positive ? pnlPositiveClass : pnlNegativeClass
  }
  if (side === 'Sell') return positive ? pnlPositiveClass : pnlNegativeClass
  return positive ? pnlNegativeClass : pnlPositiveClass
}

export function fmtSignedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** Expiry filter: digits only (YYYYMMDD or shorter prefix). Compares normalized option expiry. */
export function optionExpiryMatchesFilter(expiryRaw: string, filterRaw: string): boolean {
  const f = filterRaw.replace(/\D/g, '')
  if (!f) return true
  const ex = (expiryRaw ?? '').replace(/\D/g, '')
  if (!ex) return false
  if (ex.length >= f.length) return ex.startsWith(f)
  return f.startsWith(ex)
}

/** Account table total_cash / buying_power via status.accounts[].summary (TotalCashValue, BuyingPower). */
export function accountTotalCashBuyingPower(acc: IbAccountSnapshot | undefined): {
  cash: number | null
  bp: number | null
} {
  const s = acc?.summary
  if (!s || typeof s !== 'object') return { cash: null, bp: null }
  const rec = s as Record<string, unknown>
  const num = (k: string): number | null => {
    const v = rec[k]
    if (v == null || v === '') return null
    const n = Number(String(v).replace(/,/g, '').replace(/\s/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return { cash: num('TotalCashValue'), bp: num('BuyingPower') }
}

export function parseIbSummaryNumber(acc: IbAccountSnapshot | undefined, key: string): number | null {
  const s = acc?.summary
  if (!s || typeof s !== 'object') return null
  const rec = s as Record<string, unknown>
  const v = rec[key]
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, '').replace(/\s/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Sum of stock position market value (qty × last) for account filter; non-OPT rows only. */
export function sumStockMarketValueForAccountFilter(rows: LivePositionRow[], accountFilter: 'all' | string): number {
  let sum = 0
  for (const p of rows) {
    const acc = (p.account_id ?? '').trim()
    if (accountFilter !== 'all' && acc !== accountFilter) continue
    const q = Number(p.position)
    const px = p.price != null ? Number(p.price) : NaN
    if (!Number.isFinite(q) || !Number.isFinite(px)) continue
    sum += q * px
  }
  return sum
}

/** Single-row market value: qty × last (STK snapshot). */
export function fmtLivePositionMarketValueQtyTimesLast(position: LivePositionRow): string {
  const q = Number(position.position)
  const px = position.price != null ? Number(position.price) : NaN
  if (!Number.isFinite(q) || !Number.isFinite(px)) return '—'
  return fmtUsd(q * px)
}

/** Surplus / gap in shares: 3 decimal places. */
export function fmtSurplusShares(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3)
}

/** Held shares: whole shares (Option underlying Pool display). */
export function fmtHeldSharesWhole(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return String(Math.round(n))
}

/** Sortable columns for Option underlying / backing Pool tables. */
export type CoveragePoolSortCol =
  | 'symbol'
  | 'account'
  | 'held'
  | 'held_amt'
  /** Backing pool: contracts ≈ min(held, watchlist required) ÷ 100. */
  | 'backed_amt'
  | 'required'
  | 'cost_basis'
  | 'market_price'

/** held_shares × live_last_price; null if not computable. */
export function coverageRowMarketValueTotal(ci: StockCoverageItem): number | null {
  const h = ci.held_shares
  const p = ci.live_last_price
  if (h == null || !Number.isFinite(h) || h <= 0) return null
  if (p == null || !Number.isFinite(p)) return null
  return h * p
}

export function sortStockCoverageItemsByColumn(
  list: StockCoverageItem[],
  col: CoveragePoolSortCol,
  dir: 'asc' | 'desc',
): StockCoverageItem[] {
  const out = [...list]
  const m = dir === 'asc' ? 1 : -1
  out.sort((a, b) => {
    if (col === 'symbol') return m * a.symbol.localeCompare(b.symbol)
    if (col === 'account') return m * (a.account_id || '').localeCompare(b.account_id || '')
    if (col === 'held') return m * ((a.held_shares || 0) - (b.held_shares || 0))
    if (col === 'held_amt') {
      const ca = Math.floor(Math.max(0, a.held_shares) / 100)
      const cb = Math.floor(Math.max(0, b.held_shares) / 100)
      return m * (ca - cb)
    }
    if (col === 'backed_amt') {
      const ca = Math.floor(
        Math.max(0, Math.min(a.held_shares || 0, a.required_shares || 0)) / 100,
      )
      const cb = Math.floor(
        Math.max(0, Math.min(b.held_shares || 0, b.required_shares || 0)) / 100,
      )
      return m * (ca - cb)
    }
    if (col === 'required') {
      return m * ((a.required_shares || 0) - (b.required_shares || 0))
    }
    if (col === 'cost_basis') {
      const va = a.cost_basis_total
      const vb = b.cost_basis_total
      const fa = va != null && Number.isFinite(va)
      const fb = vb != null && Number.isFinite(vb)
      if (!fa && !fb) return 0
      if (!fa) return 1
      if (!fb) return -1
      return m * (va - vb)
    }
    if (col === 'market_price') {
      const va = coverageRowMarketValueTotal(a)
      const vb = coverageRowMarketValueTotal(b)
      const fa = va != null && Number.isFinite(va)
      const fb = vb != null && Number.isFinite(vb)
      if (!fa && !fb) return 0
      if (!fa) return 1
      if (!fb) return -1
      return m * (va - vb)
    }
    return a.symbol.localeCompare(b.symbol)
  })
  return out
}

export function groupCoverageByAccount(
  rows: StockCoverageItem[],
  sortCol: CoveragePoolSortCol,
  sortDir: 'asc' | 'desc',
  streamHostAccountId: string,
  streamSecondaryAccountId: string,
): { accountId: string; items: StockCoverageItem[] }[] {
  const by = new Map<string, StockCoverageItem[]>()
  for (const r of rows) {
    const k = (r.account_id ?? '').trim() || '—'
    if (!by.has(k)) by.set(k, [])
    by.get(k)!.push(r)
  }
  const rank = (id: string) => {
    const t = (id ?? '').trim()
    if (streamHostAccountId && t === streamHostAccountId) return 0
    if (streamSecondaryAccountId && t === streamSecondaryAccountId) return 1
    return 2
  }
  const keys = [...by.keys()].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return a.localeCompare(b)
  })
  return keys.map(accountId => ({
    accountId,
    items: sortStockCoverageItemsByColumn(by.get(accountId)!, sortCol, sortDir),
  }))
}

/** Stock metrics for exactly one (symbol, account); never mixes other accounts. */
export function underlyingCoverageStockMetrics(
  stocks: LivePositionRow[],
  symbol: string,
  accountId: string,
): {
  held: number
  cost_basis_total: number | null
  avg_cost_per_share: number | null
  live_last_price: number | null
  daily_pnl: number | null
  daily_pct: number | null
  total_pnl: number | null
  total_pct: number | null
} {
  const sym = (symbol ?? '').toUpperCase().trim()
  const acct = (accountId ?? '').trim()
  let held = 0
  let heldAbs = 0
  let costBasisAbs = 0
  let lastWeightedSum = 0
  let lastWeight = 0
  let dailyPnl = 0
  let dailyBaseAbs = 0
  let totalPnl = 0
  for (const s of stocks) {
    if ((s.symbol ?? '').toUpperCase().trim() !== sym) continue
    if ((s.account_id ?? '').trim() !== acct) continue
    const qty = Number(s.position)
    if (!Number.isFinite(qty) || qty === 0) continue
    const absQty = Math.abs(qty)
    const avgCost = s.avgCost != null && Number.isFinite(Number(s.avgCost)) ? Number(s.avgCost) : null
    const lastPrice = s.price != null && Number.isFinite(Number(s.price)) ? Number(s.price) : null
    const dailyPrevClose =
      s.daily_prev_close != null && Number.isFinite(Number(s.daily_prev_close))
        ? Number(s.daily_prev_close)
        : null
    const unrealizedPnl =
      s.unrealized_pnl != null && Number.isFinite(Number(s.unrealized_pnl))
        ? Number(s.unrealized_pnl)
        : lastPrice != null && avgCost != null
          ? (lastPrice - avgCost) * qty
          : 0
    held += qty
    heldAbs += absQty
    if (avgCost != null) costBasisAbs += absQty * avgCost
    if (lastPrice != null) {
      lastWeightedSum += absQty * lastPrice
      lastWeight += absQty
    }
    if (dailyPrevClose != null && lastPrice != null) {
      dailyPnl += (lastPrice - dailyPrevClose) * qty
      dailyBaseAbs += Math.abs(dailyPrevClose * qty)
    }
    totalPnl += unrealizedPnl
  }
  const costBasis = costBasisAbs > 0 ? costBasisAbs : null
  const totalPct =
    costBasis != null && costBasis > 0 && Number.isFinite(totalPnl) ? (totalPnl / costBasis) * 100 : null
  const dailyPct = dailyBaseAbs > 0 ? (dailyPnl / dailyBaseAbs) * 100 : null
  return {
    held,
    cost_basis_total: costBasis,
    avg_cost_per_share: heldAbs > 0 ? costBasisAbs / heldAbs : null,
    live_last_price: lastWeight > 0 ? lastWeightedSum / lastWeight : null,
    daily_pnl: heldAbs > 0 ? dailyPnl : null,
    daily_pct: dailyPct,
    total_pnl: heldAbs > 0 ? totalPnl : null,
    total_pct: totalPct,
  }
}

export const DONUT_SYMBOL_COLORS = [
  '#38bdf8', '#76b900', '#fbbf24', '#ef4444', '#a855f7',
  '#f97316', '#4ade80', '#ec4899', '#84cc16', '#14b8a6',
]

/** Option → Category ring: blue / orange / emerald (higher hue separation than teal / slate / lime on dark UI). */
export const OPTION_STOCK_MIX_COLORS: Record<string, string> = {
  'Backing Pool': '#60a5fa',
  'Other Stock': '#fb923c',
  'Cash-like': '#34d399',
}

export type OptionDetailFootnote =
  | { kind: 'stock'; costFmt: string; mvFmt: string; tone: 'profit' | 'loss' | 'flat' }
  | { kind: 'text'; text: string; tone: 'profit' | 'loss' | 'flat' }

export interface DonutSegment {
  label: string
  value: number
  color: string
  /** Option Detail: underlying stock cost / MV (colored) or margin line. */
  optionDetailFoot?: OptionDetailFootnote
  /** Category detail legend: hover copy for how market value was computed. */
  marketValueTooltip?: string
}

export type UnderlyingCategoryFilter = 'Stocks' | 'Fixed Income' | 'Cash-like'

/** Option → Category ring: backing vs residual optionable stock vs cash-like STK. */
export type OptionStockMixCategory = 'Backing Pool' | 'Other Stock' | 'Cash-like'

export const UNDERLYING_CATEGORY_ORDER: UnderlyingCategoryFilter[] = ['Stocks', 'Fixed Income', 'Cash-like']

export const UNDERLYING_CATEGORY_COLORS: Record<UnderlyingCategoryFilter, string> = {
  Stocks: '#38bdf8',
  'Fixed Income': '#fbbf24',
  'Cash-like': '#4ade80',
}

export function fmtMvAbbrev(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
  return `$${Math.round(v)}`
}

export function fmtQtyForMvTooltip(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n)
}

/** Explains ring MV for one symbol: sum of |position| × mark price per portfolio row. */
export function buildMarketValueTooltip(
  symbol: string,
  totalMv: number,
  lines: { qty: number; price: number; mv: number }[],
): string {
  const head =
    'Market value = |position| × mark price (per row; summed if multiple rows or accounts).'
  if (lines.length === 0) return head
  if (lines.length === 1) {
    const { qty, price, mv } = lines[0]
    return `${head}\nExample (${symbol}): ${fmtQtyForMvTooltip(qty)} × ${fmtUsd(price)} = ${fmtUsd(mv)}`
  }
  const body = lines.map(l => `  ${fmtQtyForMvTooltip(l.qty)} × ${fmtUsd(l.price)} = ${fmtUsd(l.mv)}`).join('\n')
  return `${head}\nExample (${symbol}):\n${body}\n  → ${fmtUsd(totalMv)}`
}

/** Open Positions account bubbles: row visible when it matches a selected HOST / Secondary (multi-select). */
export function openPosAccountMatchesFilter(
  accId: string,
  pick: { host: boolean; secondary: boolean },
  streamHostId: string,
  streamSecondaryRaw: string,
): boolean {
  const trimmed = (accId ?? '').trim()
  const hostId = streamHostId.trim()
  const secId =
    streamSecondaryRaw.trim() && streamSecondaryRaw.trim() !== hostId
      ? streamSecondaryRaw.trim()
      : ''
  if (!hostId && !secId) return true
  const hOn = pick.host
  const sOn = pick.secondary
  if (!hOn && !sOn) return false
  const isHost = !!hostId && trimmed === hostId
  const isSec = !!secId && trimmed === secId
  if (isHost) return hOn
  if (isSec) return sOn
  return hOn && sOn
}

/** Off-track synthetic rows: same rule as former "All" — show when both configured accounts are selected. */
export function openPosShowOffTrack(
  pick: { host: boolean; secondary: boolean },
  streamHostId: string,
  streamSecondaryRaw: string,
): boolean {
  const hostId = streamHostId.trim()
  const secId =
    streamSecondaryRaw.trim() && streamSecondaryRaw.trim() !== hostId
      ? streamSecondaryRaw.trim()
      : ''
  if (!hostId && !secId) return true
  if (!pick.host && !pick.secondary) return false
  if (hostId && !secId) return pick.host
  if (!hostId && secId) return pick.secondary
  return pick.host && pick.secondary
}

/** Stable key for (symbol, account) across live rows and coverage rows. */
export function liveStockRowCovKey(row: { symbol?: string; account_id?: string }): string {
  return `${(row.symbol ?? '').toUpperCase().trim()}\x1f${(row.account_id ?? '').trim()}`
}

/** Same contract key as Option Detail donut / legend rows. */
export function buildOptionContractLabel(pos: IbPositionRow): string {
  const qty = Number(pos.position)
  if (!Number.isFinite(qty) || qty === 0) return ''
  const right = (pos.right ?? '').toUpperCase()
  const side = qty > 0 ? 'L' : 'S'
  const rightLbl = right === 'C' ? 'C' : right === 'P' ? 'P' : 'O'
  const strike = pos.strike != null && Number.isFinite(pos.strike) ? String(pos.strike) : '?'
  const expiry = (pos.expiry ?? '').trim() || '—'
  const symbol = (pos.symbol ?? getContractLabelParts(pos.contract_key ?? '').symbol ?? '?').toUpperCase()
  return `${symbol} ${rightLbl}${strike} ${expiry} ${side}`
}

export function readPositionUnrealizedPnl(pos: IbPositionRow): number | null {
  const rec = pos as unknown as Record<string, unknown>
  const raw = rec.unrealized_pnl ?? rec.unrealizedPNL ?? null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

export function pnlToneFromSigned(v: number | null): 'profit' | 'loss' | 'flat' {
  if (v == null || !Number.isFinite(v)) return 'flat'
  if (v > 0) return 'profit'
  if (v < 0) return 'loss'
  return 'flat'
}

export function pnlClassForTone(tone: 'profit' | 'loss' | 'flat'): string {
  if (tone === 'profit') return pnlPositiveClass
  if (tone === 'loss') return pnlNegativeClass
  return ''
}

/**
 * Same-account underlying: stock cost + market value (tones from STK unrealized PnL, else MV − cost);
 * else short-put margin line (tone from OPT unrealized PnL).
 */
export function optionUnderlyingFootnote(
  pos: IbPositionRow,
  stockRows: IbPositionRow[],
  resolvePrice: (p: IbPositionRow) => number | null,
): OptionDetailFootnote {
  const symbol = (pos.symbol ?? getContractLabelParts(pos.contract_key ?? '').symbol ?? '').trim().toUpperCase()
  const optQty = Number(pos.position)
  const right = (pos.right ?? '').toUpperCase().slice(0, 1)
  const strike = pos.strike != null && Number.isFinite(Number(pos.strike)) ? Number(pos.strike) : null
  const optPnl = readPositionUnrealizedPnl(pos)

  const stk = stockRows.find(
    p =>
      (p.secType ?? '').toUpperCase() === 'STK' &&
      (p.symbol ?? '').trim().toUpperCase() === symbol &&
      Number(p.position) !== 0,
  )
  if (stk) {
    const sq = Number(stk.position)
    const ac = stk.avgCost != null ? Number(stk.avgCost) : NaN
    const px = resolvePrice(stk)
    const costUsd =
      Number.isFinite(sq) && sq !== 0 && Number.isFinite(ac) && ac > 0 ? Math.abs(sq) * ac : null
    const mvUsd =
      px != null && Number.isFinite(px) && px > 0 && Number.isFinite(sq) && sq !== 0 ? Math.abs(sq) * px : null
    const costFmt = costUsd != null ? fmtUsd(costUsd) : '—'
    const mvFmt = mvUsd != null ? fmtUsd(mvUsd) : '—'
    const stkPnl = readPositionUnrealizedPnl(stk)
    let tone = pnlToneFromSigned(stkPnl)
    if (tone === 'flat' && costUsd != null && mvUsd != null) {
      tone = pnlToneFromSigned(mvUsd - costUsd)
    }
    return { kind: 'stock', costFmt, mvFmt, tone }
  }
  if (optQty < 0 && right === 'P' && strike != null && strike > 0) {
    const marginUsd = strike * Math.abs(optQty) * 100
    return { kind: 'text', text: `Margin (est.) ${fmtUsd(marginUsd)}`, tone: pnlToneFromSigned(optPnl) }
  }
  if (optQty < 0 && right === 'C') {
    return { kind: 'text', text: 'Margin (naked est.) —', tone: pnlToneFromSigned(optPnl) }
  }
  return { kind: 'stock', costFmt: '—', mvFmt: '—', tone: 'flat' }
}
