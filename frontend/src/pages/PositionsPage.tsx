import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Execution, IbAccountSnapshot, PositionInstanceAttribution, RealtimeQuote, StatusResponse } from '../types'
import { deleteExecution, fetchQuotes, subscribeQuotes, updateExecution } from '../api'
import { fetchPositionAttribution } from '../api/trading/executions'
import { fetchOpportunities, fetchStructures } from '../api/strategy/strategies'
import type { StrategyOpportunity, StrategyStructure } from '../api/strategy/strategies'
import ExecSourceBadge from '../components/ExecSourceBadge'
import { InfoTooltip } from '../components/InfoTooltip'
import { computeRiskProfile, formatRiskHedgedBreakdown, formatRiskLabel } from '../utils/riskProfile'
import type { RiskPosition } from '../utils/riskProfile'
import { RiskProfileDl } from '../components/RiskProfileDl'
import {
  daysUntilExpiry,
  fmtDate,
  fmtDaysAgo,
  fmtExpiry,
  fmtUsd,
  getContractLabelParts,
  parseOptionContractKey,
} from '../utils/format'
import { executionMatchesInstanceGroup, sliceExecutionForInstanceOptView } from './portfolio/ledgerOptHelpers'
import { mergeQuotesIntoSymbolMap } from './accounts/accountsUtils'

type OpenPositionsTab = 'instance' | 'options' | 'stocks' | 'fixed_income' | 'cash_like'

/** Align position vs execution contract_key: OCC local differs in segment 1; OPT|expiry|strike|right match. */
function optExecutionMatchKey(accountId: string, contractKey: string): string {
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
function buildLiveOptExecutionMap(executions: Execution[]): Map<string, Execution[]> {
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
function positionExecsForAttribution(full: { final: Execution[]; tws: Execution[] }): Execution[] {
  return full.final.length > 0 ? full.final : full.tws
}

function mergeExecsUniqueById(a: Execution[], b: Execution[]): Execution[] {
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

function splitOffTrackTradesBySource(
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
function findMatchingFinalForTws(t: Execution, finals: Execution[]): Execution | null {
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
function findMatchingTwsForFinal(f: Execution, twsRows: Execution[]): Execution | null {
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

function finalHasStrategyAttribution(f: Execution): boolean {
  return f.strategy_instance_id != null || f.strategy_opportunity_id != null
}

/** True when final has opp/instance set and TWS row differs (needs sync). */
function twsNeedsStrategySyncFromFinal(t: Execution, f: Execution): boolean {
  if (!finalHasStrategyAttribution(f)) return false
  const siT = t.strategy_instance_id ?? null
  const soT = t.strategy_opportunity_id ?? null
  const siF = f.strategy_instance_id ?? null
  const soF = f.strategy_opportunity_id ?? null
  return siT !== siF || soT !== soF
}

/** True when TWS row has opp/instance set and final book row differs (needs sync the other way). */
function finalNeedsStrategySyncFromTws(f: Execution, t: Execution): boolean {
  if (!finalHasStrategyAttribution(t)) return false
  const siT = t.strategy_instance_id ?? null
  const soT = t.strategy_opportunity_id ?? null
  const siF = f.strategy_instance_id ?? null
  const soF = f.strategy_opportunity_id ?? null
  return siT !== siF || soT !== soF
}

/** Open Options Contract column: icon before label from merged Final+TWS executions (deduped). */
function instanceIconFillFromMergedExecutions(merged: Execution[]): 'empty' | 'none' | 'all' | 'mixed' {
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
function optionLastStrikePctClass(right: string, side: 'Buy' | 'Sell', pct: number): string {
  if (pct === 0 || (right !== 'C' && right !== 'P')) return ''
  const positive = pct > 0
  if (right === 'C') {
    if (side === 'Sell') return positive ? 'pnl-negative' : 'pnl-positive'
    return positive ? 'pnl-positive' : 'pnl-negative'
  }
  if (side === 'Sell') return positive ? 'pnl-positive' : 'pnl-negative'
  return positive ? 'pnl-negative' : 'pnl-positive'
}

function fmtSignedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** Expiry filter: digits only (YYYYMMDD or shorter prefix). Compares normalized option expiry. */
function optionExpiryMatchesFilter(expiryRaw: string, filterRaw: string): boolean {
  const f = filterRaw.replace(/\D/g, '')
  if (!f) return true
  const ex = (expiryRaw ?? '').replace(/\D/g, '')
  if (!ex) return false
  if (ex.length >= f.length) return ex.startsWith(f)
  return f.startsWith(ex)
}

/** Account table total_cash / buying_power via status.accounts[].summary (TotalCashValue, BuyingPower). */
function accountTotalCashBuyingPower(acc: IbAccountSnapshot | undefined): {
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

function parseIbSummaryNumber(acc: IbAccountSnapshot | undefined, key: string): number | null {
  const s = acc?.summary
  if (!s || typeof s !== 'object') return null
  const rec = s as Record<string, unknown>
  const v = rec[key]
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, '').replace(/\s/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Sum of stock position market value (qty × last) for account filter; non-OPT rows only. */
function sumStockMarketValueForAccountFilter(rows: LivePositionRow[], accountFilter: 'all' | string): number {
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
function fmtLivePositionMarketValueQtyTimesLast(position: LivePositionRow): string {
  const q = Number(position.position)
  const px = position.price != null ? Number(position.price) : NaN
  if (!Number.isFinite(q) || !Number.isFinite(px)) return '—'
  return fmtUsd(q * px)
}

/** Surplus / gap in shares: 3 decimal places. */
function fmtSurplusShares(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3)
}

/** Held shares: whole shares (Option underlying Pool display). */
function fmtHeldSharesWhole(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return String(Math.round(n))
}

/** Sortable columns for Option underlying / backing Pool tables. */
type CoveragePoolSortCol =
  | 'symbol'
  | 'account'
  | 'held'
  | 'held_amt'
  /** Backing pool: contracts ≈ min(held, watchlist required) ÷ 100. */
  | 'backed_amt'
  | 'required'
  | 'cost_basis'
  | 'market_price'

function sortStockCoverageItemsByColumn(
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

/** held_shares × live_last_price; null if not computable. */
function coverageRowMarketValueTotal(ci: StockCoverageItem): number | null {
  const h = ci.held_shares
  const p = ci.live_last_price
  if (h == null || !Number.isFinite(h) || h <= 0) return null
  if (p == null || !Number.isFinite(p)) return null
  return h * p
}

function groupCoverageByAccount(
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
import { isLedgerCashLikeCategory, isLedgerFixedIncomeCategory } from './portfolio/ledgerStockCategoryBuckets'
import { buildOptExecutionGroups } from './portfolio/buildOptExecutionGroups'
import { ExecutionFormModal } from './portfolio/ExecutionFormModal'
import type { LinkExecutionContext } from './portfolio/LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './portfolio/LinkExecutionRecordModal'
import { QuickCloseModal } from './portfolio/QuickCloseModal'
import type {
  InstanceAllGroup,
  InstancePositionGroup,
  InstanceStockCoverage,
  LivePositionRow,
  OpenOptionPosition,
  PortfolioView,
  StockCoverageItem,
} from './portfolio/types'
import { OFF_TRACK_ACCOUNT_ID, useExecutions } from './portfolio/useExecutions'

/** Rows for open STK table: account sub-headers + position lines (used under category sections). */
function buildOpenStockPositionRows(positions: LivePositionRow[], rowKeyPrefix: string): JSX.Element[] {
  const byAccount: Record<string, LivePositionRow[]> = {}
  for (const position of positions) {
    const accId = (position.account_id ?? '').trim() || '—'
    if (!byAccount[accId]) byAccount[accId] = []
    byAccount[accId].push(position)
  }
  const accountIds = Object.keys(byAccount).sort()
  const rows: JSX.Element[] = []
  for (const accId of accountIds) {
    rows.push(
      <tr key={`${rowKeyPrefix}-acc-${accId}`} className="replay-portfolio-group-header">
        <td colSpan={9}>
          <strong>{accId}</strong>
        </td>
      </tr>,
    )
    for (const position of byAccount[accId]) {
      const qty = Number(position.position)
      const lastPrice = position.price != null && Number.isFinite(Number(position.price)) ? Number(position.price) : null
      const avgCost = position.avgCost != null && Number.isFinite(Number(position.avgCost)) ? Number(position.avgCost) : null
      const prevClose =
        position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
          ? Number(position.daily_prev_close)
          : null
      const pnl =
        position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
          ? Number(position.unrealized_pnl)
          : null
      const sincePct =
        pnl != null && avgCost != null && avgCost !== 0 && Number.isFinite(qty) ? (pnl / (Math.abs(avgCost * qty))) * 100 : null
      const dailyPnl =
        lastPrice != null && prevClose != null && Number.isFinite(qty) ? (lastPrice - prevClose) * qty : null
      const dailyPct =
        dailyPnl != null && prevClose != null && prevClose !== 0 ? ((lastPrice! - prevClose) / prevClose) * 100 : null
      const contractKey = position.contract_key ?? `${position.symbol ?? ''}|STK|||`
      rows.push(
        <tr key={`${rowKeyPrefix}-open-stk-${accId}-${position.symbol ?? ''}-${contractKey}`}>
          <td>{accId}</td>
          <td>
            <strong>{position.symbol ?? '—'}</strong>
          </td>
          <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
          <td>{Number.isFinite(qty) ? qty : '—'}</td>
          <td>{fmtUsd(position.avgCost)}</td>
          <td>{fmtUsd(position.price)}</td>
          <td>{fmtLivePositionMarketValueQtyTimesLast(position)}</td>
          <td className="coverage-pnl-stacked-cell">
            <div className={(dailyPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}>
              {dailyPnl != null ? fmtUsd(dailyPnl) : '—'}
            </div>
            <div className={`coverage-pnl-stacked-pct ${(dailyPct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {dailyPct != null ? fmtSignedPct(dailyPct) : '—'}
            </div>
          </td>
          <td className="coverage-pnl-stacked-cell">
            <div className={(pnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}>{pnl != null ? fmtUsd(pnl) : '—'}</div>
            <div className={`coverage-pnl-stacked-pct ${(sincePct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {sincePct != null ? fmtSignedPct(sincePct) : '—'}
            </div>
          </td>
        </tr>,
      )
    }
  }
  return rows
}

function renderIndependentHoldingRow(position: LivePositionRow, keyPrefix: string): JSX.Element {
  const accId = (position.account_id ?? '').trim() || '—'
  const qty = Number(position.position)
  const lastPrice =
    position.price != null && Number.isFinite(Number(position.price)) ? Number(position.price) : null
  const dailyPrev =
    position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
      ? Number(position.daily_prev_close)
      : null
  let dailyPnl: number | null = null
  let dailyPct: number | null = null
  if (lastPrice != null && dailyPrev != null && Number.isFinite(qty) && qty !== 0) {
    dailyPnl = (lastPrice - dailyPrev) * qty
    const dBase = Math.abs(dailyPrev * qty)
    dailyPct = dBase > 0 ? (dailyPnl / dBase) * 100 : null
  }
  const totalPnl =
    position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
      ? Number(position.unrealized_pnl)
      : null
  const avgCost =
    position.avgCost != null && Number.isFinite(Number(position.avgCost)) ? Number(position.avgCost) : null
  const costBasis =
    avgCost != null && Number.isFinite(qty) && qty !== 0 ? Math.abs(qty) * avgCost : null
  const totalPct =
    costBasis != null && costBasis > 0 && totalPnl != null && Number.isFinite(totalPnl)
      ? (totalPnl / costBasis) * 100
      : null
  const ck = (position.contract_key ?? '').trim()
  return (
    <tr key={`${keyPrefix}-${accId}-${position.symbol ?? ''}-${ck || 'stk'}`}>
      <td>{accId}</td>
      <td>
        <strong>{position.symbol ?? '—'}</strong>
      </td>
      <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
      <td>{Number.isFinite(qty) ? qty : '—'}</td>
      <td>{fmtUsd(position.avgCost)}</td>
      <td>{fmtUsd(lastPrice)}</td>
      <td>{fmtLivePositionMarketValueQtyTimesLast(position)}</td>
      <td>
        <span className={((dailyPnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtUsd(dailyPnl)}</span>
        {' / '}
        <span className={((dailyPct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtSignedPct(dailyPct)}</span>
      </td>
      <td>
        <span className={((totalPnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtUsd(totalPnl)}</span>
        {' / '}
        <span className={((totalPct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtSignedPct(totalPct)}</span>
      </td>
    </tr>
  )
}

/** Stock metrics for exactly one (symbol, account); never mixes other accounts. */
function underlyingCoverageStockMetrics(
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

function StrategyAttributionCells({ ex }: { ex: Execution | null }) {
  if (!ex) return <td className="replay-strategy-opp-cell">—</td>
  const oppName = ex.strategy_opportunity_name?.trim()
  const instanceId = ex.strategy_instance_id
  const instanceLabel = ex.strategy_instance_label?.trim()
  const instanceTitle = instanceLabel ? `Strategy: ${instanceLabel}` : instanceId != null ? `View strategy #${instanceId}` : ''
  return (
    <td className="replay-strategy-opp-cell" title={[instanceTitle, oppName].filter(Boolean).join(' · ') || undefined}>
      <span className="replay-strategy-opp-cell-inner">
        {instanceId != null ? (
          <a href={`#/strategies/instances/${instanceId}`} className="ledger-instance-icon-link" target="_blank" rel="noopener noreferrer" title={instanceTitle} aria-label={instanceTitle || 'View strategy'} onClick={e => e.stopPropagation()}>
            <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
          </a>
        ) : null}
        <span className="replay-strategy-opp-text">{oppName || '—'}</span>
      </span>
    </td>
  )
}

function LinkStrategyIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button type="button" className="btn btn-icon-small" onClick={e => { e.stopPropagation(); onClick() }} title={title} aria-label={title}>
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </button>
  )
}

interface PositionsPageProps {
  status: StatusResponse | null
  currentView?: PortfolioView
  onViewChange?: (view: PortfolioView) => void
  showViewTabs?: boolean
}

export function PositionsPage({
  status,
  currentView: _currentView,
  onViewChange,
  showViewTabs: _showViewTabs = true,
}: PositionsPageProps) {
  const { executionsFinal, executionsTws, executionsCanonical, loadReplayData, executionAccountOptions } = useExecutions(
    status,
    undefined,
    false,
    true,
  )
  const [editExec, setEditExec] = useState<Execution | null>(null)
  const [editExecConfirmState, setEditExecConfirmState] = useState<{
    open: boolean
    exec: Execution | null
  }>({ open: false, exec: null })
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkContext, setLinkContext] = useState<LinkExecutionContext | null>(null)
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    open: boolean
    title: string
    message: string
    confirming: boolean
    exec: Execution | null
  }>({ open: false, title: '', message: '', confirming: false, exec: null })
  /** Pool=Off only: execution to close against; when set, show Quick Trade (Close) modal */
  const [closeAgainstExec, setCloseAgainstExec] = useState<Execution | null>(null)
  /** Inline error for e.g. delete execution failure (not modal form errors). */
  const [pageError, setPageError] = useState<string | null>(null)
  const [syncingTwsAttributionKey, setSyncingTwsAttributionKey] = useState<string | null>(null)
  const [syncingFinalAttributionKey, setSyncingFinalAttributionKey] = useState<string | null>(null)

  const handleSyncTwsStrategyFromFinal = useCallback(async (t: Execution, f: Execution) => {
    const id = t.account_executions_id
    if (id == null) return
    setSyncingTwsAttributionKey(String(id))
    setPageError(null)
    try {
      const res = await updateExecution(id, {
        strategy_instance_id: f.strategy_instance_id ?? null,
        strategy_opportunity_id: f.strategy_opportunity_id ?? null,
      })
      if (!res.ok) throw new Error(res.error || 'Sync failed')
      await loadReplayData()
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncingTwsAttributionKey(null)
    }
  }, [loadReplayData])

  const handleSyncFinalStrategyFromTws = useCallback(async (f: Execution, t: Execution) => {
    const id = f.account_executions_id
    if (id == null) return
    setSyncingFinalAttributionKey(String(id))
    setPageError(null)
    try {
      const res = await updateExecution(id, {
        strategy_instance_id: t.strategy_instance_id ?? null,
        strategy_opportunity_id: t.strategy_opportunity_id ?? null,
      })
      if (!res.ok) throw new Error(res.error || 'Sync failed')
      await loadReplayData()
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncingFinalAttributionKey(null)
    }
  }, [loadReplayData])

  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [structures, setStructures] = useState<StrategyStructure[]>([])

  const loadStrategyMeta = useCallback(async () => {
    try {
      const [oppRes, strRes] = await Promise.all([
        fetchOpportunities(false),
        fetchStructures(false),
      ])
      setOpportunities(oppRes.items ?? [])
      setStructures(strRes.items ?? [])
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { loadStrategyMeta() }, [loadStrategyMeta])

  const [attributions, setAttributions] = useState<PositionInstanceAttribution[]>([])
  const loadAttributions = useCallback(async () => {
    try {
      const res = await fetchPositionAttribution()
      setAttributions(res.attributions ?? [])
    } catch { /* non-critical: falls back to empty → unassigned */ }
  }, [])

  const oppMap = useMemo(() => {
    const m = new Map<number, StrategyOpportunity>()
    for (const o of opportunities) m.set(o.strategy_opportunity_id, o)
    return m
  }, [opportunities])

  const structureMap = useMemo(() => {
    const m = new Map<number, StrategyStructure>()
    for (const s of structures) m.set(s.strategy_structure_id, s)
    return m
  }, [structures])

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  const [openFilterAccountId, setOpenFilterAccountId] = useState<string>('all')
  const [openTab, setOpenTab] = useState<OpenPositionsTab>('instance')
  const [instanceFilterStructureType, setInstanceFilterStructureType] = useState<string>('all')
  const [instanceFilterScopeType, setInstanceFilterScopeType] = useState<string>('all')
  const [instanceFilterOppName, setInstanceFilterOppName] = useState<string>('all')
  const [instanceFilterAttributionType, setInstanceFilterAttributionType] = useState<string>('all')
  const getPositionKey = (p: OpenOptionPosition, instId: number | null) =>
    `${instId ?? 'none'}-${p.contract_key}-${p.strike}-${p.expiry}-${p.pool_label}-${p.account_id}${p.filtered_exec_lists ? '-unc' : ''}`
  /** Options tab (physical rows only): stable expand key without instance slice. */
  const getOptionsTabPositionKey = (p: OpenOptionPosition) =>
    `${p.pool_label}-${p.account_id}-${p.contract_key}-${p.expiry}-${p.strike}`
  const [expandedPositionKeys, setExpandedPositionKeys] = useState<string[]>([])
  const togglePositionExpand = (posKey: string) => {
    setExpandedPositionKeys(prev => {
      const isOpen = prev.includes(posKey)
      if (openAccordionMode) return isOpen ? [] : [posKey]
      return isOpen ? prev.filter(k => k !== posKey) : [...prev, posKey]
    })
  }
  type OpenOptSortCol =
    | 'contract'
    | 'expiry'
    | 'strike'
    | 'last'
    | 'qty'
    | 'avg_cost'
    | 'value'
    | 'time'
    | 'un_pnl'
  const [openOptSort, setOpenOptSort] = useState<{ column: OpenOptSortCol; dir: 'asc' | 'desc' }>({
    column: 'expiry',
    dir: 'desc',
  })

  const [openAccordionMode, setOpenAccordionMode] = useState<boolean>(true)
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then(res => {
        if (!cancelled) {
          setQuotesMap(() => {
            const map = mergeQuotesIntoSymbolMap({}, res.quotes || [])
            for (const q of res.quotes || []) {
              if (q.contract_key && (q.sec_type ?? '').toUpperCase() === 'OPT')
                map[q.contract_key] = q
            }
            return map
          })
        }
      })
      .catch(() => { if (!cancelled) setQuotesMap({}) })
    const unsub = subscribeQuotes(q => {
      setQuotesMap(prev => {
        const next = mergeQuotesIntoSymbolMap(prev, [q])
        if (q.contract_key && (q.sec_type ?? '').toUpperCase() === 'OPT')
          next[q.contract_key] = q
        return next
      })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  /** OPT rows present in unified `account_executions` (canonical), keyed like optExecutionMatchKey — for TWS sync precheck. */
  const canonicalOptContractKeySet = useMemo(() => {
    const s = new Set<string>()
    for (const e of executionsCanonical) {
      if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
      if (e.account_executions_id == null) continue
      s.add(optExecutionMatchKey(e.account_id ?? '', e.contract_key ?? ''))
    }
    return s
  }, [executionsCanonical])

  const renderOpenOptionExecutionRow = useCallback(
    (
      pos: OpenOptionPosition,
      posKey: string,
      ex: Execution,
      ei: number,
      book: 'final' | 'tws',
      finalRows: Execution[],
      twsRows: Execution[],
      includeAttrColumn: boolean,
    ) => {
      const crossBookMatch =
        book === 'final' ? findMatchingTwsForFinal(ex, twsRows) : findMatchingFinalForTws(ex, finalRows)
      const es = (ex.side ?? '').toUpperCase()
      const eSideLabel =
        es === 'BUY' || es === 'BOT' || es === 'B'
          ? 'Buy'
          : es === 'SELL' || es === 'SLD' || es === 'S'
            ? 'Sell'
            : (ex.side ?? '—')
      const eQty = Math.abs(Number(ex.quantity) || 0)
      const ePrice = Number(ex.price) || 0
      const eComm = Number(ex.commission) || 0
      const eTs = ex.time != null ? Number(ex.time) : null
      const isOffTrack = pos.kind === 'offtrack'
      const execInstanceId = ex.strategy_instance_id
      const bookLabel = book === 'final' ? '[Final]' : '[TWS client]'
      const rowKey = `${posKey}-exec-${book}-${ex.account_executions_id ?? ei}`
      const twsContractKey = optExecutionMatchKey(ex.account_id ?? '', ex.contract_key ?? '')
      const hasCanonicalContractRow = canonicalOptContractKeySet.has(twsContractKey)
      const showSyncTws =
        book === 'tws' &&
        hasCanonicalContractRow &&
        crossBookMatch != null &&
        twsNeedsStrategySyncFromFinal(ex, crossBookMatch)
      const showSyncFinal =
        book === 'final' &&
        hasCanonicalContractRow &&
        crossBookMatch != null &&
        finalNeedsStrategySyncFromTws(ex, crossBookMatch)
      const syncBusyTws = syncingTwsAttributionKey === String(ex.account_executions_id ?? '')
      const syncBusyFinal = syncingFinalAttributionKey === String(ex.account_executions_id ?? '')
      return (
        <tr key={rowKey} className="detail-execution-row">
          <td className="replay-opt-expand-col" />
          <td className="detail-exec-indent replay-muted detail-exec-indent--stack" colSpan={2}>
            <div className="detail-exec-indent-stack">
              <div className="detail-exec-line-primary">
                ↳ {bookLabel} exec #{ex.account_executions_id ?? '?'}
                {execInstanceId != null ? (
                  <>
                    {' '}
                    <span className="replay-muted">·</span>{' '}
                    <a
                      href={`#/strategies/instances/${execInstanceId}`}
                      className="ledger-instance-icon-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`strategy_instance_id ${execInstanceId}`}
                      aria-label={`View strategy #${execInstanceId}`}
                      onClick={e => e.stopPropagation()}
                    >
                      strategy #{execInstanceId}
                    </a>
                  </>
                ) : null}
              </div>
              {showSyncTws && crossBookMatch != null ? (
                <div className="detail-exec-line-sync">
                  <button
                    type="button"
                    className="btn btn-icon-small detail-exec-sync-btn"
                    title="Apply opportunity and strategy from the final book row"
                    aria-label="Sync strategy attribution from final book"
                    disabled={syncBusyTws}
                    onClick={e => {
                      e.stopPropagation()
                      handleSyncTwsStrategyFromFinal(ex, crossBookMatch)
                    }}
                  >
                    <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden>
                      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 9.02 4 10.48 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                    </svg>
                  </button>
                </div>
              ) : null}
              {showSyncFinal && crossBookMatch != null ? (
                <div className="detail-exec-line-sync">
                  <button
                    type="button"
                    className="btn btn-icon-small detail-exec-sync-btn"
                    title="Apply opportunity and strategy from the TWS client row"
                    aria-label="Sync strategy attribution from TWS client book"
                    disabled={syncBusyFinal}
                    onClick={e => {
                      e.stopPropagation()
                      handleSyncFinalStrategyFromTws(ex, crossBookMatch)
                    }}
                  >
                    <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden>
                      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 9.02 4 10.48 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                    </svg>
                  </button>
                </div>
              ) : null}
            </div>
          </td>
          <td>
            <ExecSourceBadge source={ex.source} />
          </td>
          <td />
          <td>
            {eSideLabel} {eQty || '—'}
          </td>
          <td>{fmtUsd(ePrice)}</td>
          <td />
          <td>
            {eTs != null && Number.isFinite(eTs) ? (
              <>
                {fmtDate(eTs)}
                {fmtDaysAgo(eTs) ? <span className="replay-time-ago"> {fmtDaysAgo(eTs)}</span> : null}
              </>
            ) : (
              '—'
            )}
          </td>
          <td>{eComm ? fmtUsd(eComm) : '—'}</td>
          <td className="replay-muted" />
          {includeAttrColumn ? <td className="replay-muted" /> : null}
          <td className="replay-muted positions-opt-account-cell">{ex.account_id ?? '—'}</td>
          <StrategyAttributionCells ex={ex} />
          <td className="replay-opt-actions-cell">
            <span className="replay-exec-row-actions">
              <button
                type="button"
                className="btn btn-icon-small"
                onClick={e => {
                  e.stopPropagation()
                  setPageError(null)
                  setEditExecConfirmState({ open: true, exec: ex })
                }}
                title="Edit"
                aria-label="Edit execution"
              >
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              {ex.account_executions_id != null ? (
                <LinkStrategyIconButton
                  title="Assign opportunity and strategy"
                  onClick={() => {
                    setLinkContext({ account_executions_id: ex.account_executions_id!, execution: ex })
                    setLinkModalOpen(true)
                    setPageError(null)
                  }}
                />
              ) : null}
              {isOffTrack ? (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={e => {
                    e.stopPropagation()
                    setCloseAgainstExec(ex)
                    setPageError(null)
                  }}
                >
                  Close
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-icon-small btn-icon-danger"
                onClick={e => {
                  e.stopPropagation()
                  setPageError(null)
                  setDeleteConfirmState({
                    open: true,
                    title: 'Delete execution',
                    message: 'This will permanently remove this execution from the trade ledger. This cannot be undone.',
                    confirming: false,
                    exec: ex,
                  })
                }}
                title="Delete"
                aria-label="Delete execution"
              >
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            </span>
          </td>
        </tr>
      )
    },
    [
      canonicalOptContractKeySet,
      handleSyncFinalStrategyFromTws,
      handleSyncTwsStrategyFromFinal,
      syncingFinalAttributionKey,
      syncingTwsAttributionKey,
    ],
  )

  const openOffTrackBaseExecutions = useMemo(() => {
    let list = [...executionsFinal, ...executionsTws]
    list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expFilter = openFilterExpiryStart.trim()
    if (expFilter) {
      list = list.filter(e => optionExpiryMatchesFilter((e.expiry ?? '').trim(), expFilter))
    }
    return list
  }, [executionsFinal, executionsTws, openFilterSymbol, openFilterExpiryStart])

  const livePositions = useMemo((): LivePositionRow[] => {
    const accounts = status?.portfolio?.accounts ?? []
    let rows = accounts.flatMap(account => {
      const accId = (account.account_id ?? '').trim()
      if (openFilterAccountId !== 'all' && accId !== openFilterAccountId) return []
      return (account.positions ?? [])
        .filter(position => {
          const qty = Number(position.position)
          return Number.isFinite(qty) && qty !== 0
        })
        .map(position => ({
          ...position,
          account_id: accId,
        }))
    })

    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) {
      rows = rows.filter(position => (position.symbol ?? '').toUpperCase() === sym)
    }

    const expFilter = openFilterExpiryStart.trim()
    if (expFilter) {
      rows = rows.filter(position => {
        if ((position.secType ?? '').toUpperCase() !== 'OPT') return true
        return optionExpiryMatchesFilter(
          (position.lastTradeDateOrContractMonth ?? position.expiry ?? '').trim(),
          expFilter,
        )
      })
    }

    rows.sort((a, b) => {
      const aSym = (a.symbol ?? '').toUpperCase()
      const bSym = (b.symbol ?? '').toUpperCase()
      if (aSym !== bSym) return aSym.localeCompare(bSym)
      return (a.account_id ?? '').localeCompare(b.account_id ?? '')
    })
    return rows
  }, [openFilterAccountId, openFilterExpiryStart, openFilterSymbol, status?.portfolio?.accounts])

  const liveOptionPositions = useMemo(
    () => livePositions.filter(position => (position.secType ?? '').toUpperCase() === 'OPT'),
    [livePositions],
  )

  const executionsFinalIdSet = useMemo(
    () => new Set(executionsFinal.map(e => e.account_executions_id).filter((id): id is number => id != null)),
    [executionsFinal],
  )
  const executionsTwsIdSet = useMemo(
    () => new Set(executionsTws.map(e => e.account_executions_id).filter((id): id is number => id != null)),
    [executionsTws],
  )

  const livePositionExecutionsFinalMap = useMemo(
    () => buildLiveOptExecutionMap(executionsFinal),
    [executionsFinal],
  )
  const livePositionExecutionsTwsMap = useMemo(
    () => buildLiveOptExecutionMap(executionsTws),
    [executionsTws],
  )

  const getPositionExecLists = useCallback(
    (pos: OpenOptionPosition): { final: Execution[]; tws: Execution[]; merged: Execution[] } => {
      if (pos.filtered_exec_lists) {
        const { final, tws } = pos.filtered_exec_lists
        return { final, tws, merged: mergeExecsUniqueById(final, tws) }
      }
      if (pos.kind === 'live' && pos.position) {
        const key = optExecutionMatchKey(pos.account_id, pos.contract_key)
        const final = livePositionExecutionsFinalMap.get(key) ?? []
        const tws = livePositionExecutionsTwsMap.get(key) ?? []
        return { final, tws, merged: mergeExecsUniqueById(final, tws) }
      }
      if (pos.kind === 'offtrack') {
        const { final, tws } = splitOffTrackTradesBySource(pos.trades, executionsFinalIdSet, executionsTwsIdSet)
        return { final, tws, merged: mergeExecsUniqueById(final, tws) }
      }
      return { final: [], tws: [], merged: [] }
    },
    [
      livePositionExecutionsFinalMap,
      livePositionExecutionsTwsMap,
      executionsFinalIdSet,
      executionsTwsIdSet,
    ],
  )

  /** Instance row: per option, abs execution qtys joined by comma; Final book when any Final matches (else TWS). Option groups separated by fullwidth | */
  const formatInstanceOptExecQtyCell = useCallback(
    (allGroup: InstanceAllGroup): string => {
      const instId = allGroup.strategy_instance_id
      const oppId = allGroup.strategy_opportunity_id
      const perOption: string[] = []
      for (const pos of allGroup.options) {
        const execMatchesInstance = (ex: Execution) => {
          if (pos.filtered_exec_lists) return true
          return executionMatchesInstanceGroup(ex, instId, oppId)
        }
        let final: Execution[] = []
        let tws: Execution[] = []
        if (pos.filtered_exec_lists) {
          final = pos.filtered_exec_lists.final.filter(execMatchesInstance)
          tws = pos.filtered_exec_lists.tws.filter(execMatchesInstance)
        } else {
          const lists = getPositionExecLists(pos)
          final = lists.final.filter(execMatchesInstance)
          tws = lists.tws.filter(execMatchesInstance)
        }
        const src = final.length > 0 ? final : tws
        const qtyStrs =
          src.length > 0
            ? src.map(ex => {
                const qRaw =
                  instId != null
                    ? sliceExecutionForInstanceOptView(ex, instId)?.quantity ?? ex.quantity
                    : ex.quantity
                return String(Math.abs(Number(qRaw) || 0))
              })
            : [String(Math.abs(pos.qty))]
        perOption.push(qtyStrs.join(', '))
      }
      return perOption.join(' ｜ ')
    },
    [getPositionExecLists],
  )

  /** Index live positions by (account_id, contract_key) for fast lookup when merging attribution data. */
  const livePositionMap = useMemo(() => {
    const m = new Map<string, LivePositionRow>()
    for (const pos of liveOptionPositions) {
      const key = `${(pos.account_id ?? '').trim()}\x00${(pos.contract_key ?? '').trim()}`
      m.set(key, pos)
    }
    return m
  }, [liveOptionPositions])

  const instanceGroups = useMemo((): InstancePositionGroup[] => {
    const byInstance = new Map<string, { id: number | null; label: string | null; oppName: string | null; openedAt: number | null; positions: OpenOptionPosition[] }>()

    const addToInstance = (instId: number | null, instLabel: string | null, oppName: string | null, openedAt: number | null, pos: OpenOptionPosition) => {
      const key = instId != null ? String(instId) : '__unassigned__'
      if (!byInstance.has(key)) byInstance.set(key, { id: instId, label: instLabel, oppName, openedAt, positions: [] })
      byInstance.get(key)!.positions.push(pos)
    }

    const positionsHandledByAttribution = new Set<string>()

    for (const a of attributions) {
      if ((a.sec_type ?? '').toUpperCase() !== 'OPT') continue
      const acct = (a.account_id ?? '').trim()
      const ck = (a.contract_key ?? '').trim()
      if (openFilterAccountId !== 'all' && acct !== openFilterAccountId) continue
      const sym = openFilterSymbol.trim().toUpperCase()
      if (sym && (a.symbol ?? '').toUpperCase() !== sym) continue
      const expFilter = openFilterExpiryStart.trim()
      if (expFilter && !optionExpiryMatchesFilter((a.expiry ?? '').trim(), expFilter)) continue

      positionsHandledByAttribution.add(`${acct}\x00${ck}`)

      const livePos = livePositionMap.get(`${acct}\x00${ck}`)
      const markPrice = livePos?.price != null && Number.isFinite(Number(livePos.price)) ? Number(livePos.price) : null
      const rawAvgCost = livePos?.avgCost != null && Number.isFinite(Number(livePos.avgCost)) ? Number(livePos.avgCost) : null
      const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
      const estQty = a.open_qty_est
      const pnl = markPrice != null && avgCostPerShare != null
        ? (markPrice - avgCostPerShare) * estQty * 100
        : (a.unrealized_pnl_est ?? 0)
      const attrType: 'single' | 'mixed' | 'unassigned' =
        a.strategy_instance_id == null ? 'unassigned' : a.is_mixed ? 'mixed' : 'single'

      const pos: OpenOptionPosition = {
        kind: 'live',
        contract_key: ck,
        strike: a.strike ?? 0,
        expiry: a.expiry ?? '',
        qty: estQty,
        avg_cost: avgCostPerShare,
        mark_price: markPrice,
        unrealized_pnl: pnl,
        pool_label: 'On',
        account_id: acct,
        position: livePos,
        attribution_type: attrType,
        attribution_ratio: a.attribution_ratio,
      }
      addToInstance(a.strategy_instance_id, a.strategy_instance_label, a.strategy_opportunity_name, a.strategy_instance_opened_at_epoch, pos)
    }

    for (const pos of liveOptionPositions) {
      const acct = (pos.account_id ?? '').trim()
      const ck = (pos.contract_key ?? '').trim()
      if (positionsHandledByAttribution.has(`${acct}\x00${ck}`)) continue

      const expiry = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
      const strike = Number(pos.strike) || 0
      const qty = Number(pos.position) || 0
      const rawAvgCost = pos.avgCost != null && Number.isFinite(Number(pos.avgCost)) ? Number(pos.avgCost) : null
      const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
      const markPrice = pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
      const pnl = markPrice != null && avgCostPerShare != null
        ? (markPrice - avgCostPerShare) * qty * 100
        : Number(pos.unrealized_pnl) || 0
      const contractKey = ck || `${pos.symbol ?? ''}|OPT|${expiry}|${strike}|${(pos.right ?? '').toUpperCase().slice(0, 1)}`
      addToInstance(null, null, null, null, {
        kind: 'live',
        contract_key: contractKey,
        strike,
        expiry,
        qty,
        avg_cost: avgCostPerShare,
        mark_price: markPrice,
        unrealized_pnl: pnl,
        pool_label: 'On',
        account_id: acct,
        position: pos,
        attribution_type: 'unassigned',
      })
    }

    if (openFilterAccountId === 'all') {
      const offTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions)
        .filter(g => g.status === 'unrealized')
      for (const group of offTrackGroups) {
        const pnl = group.sell_premium - group.buy_cost
        const avgPrice = group.net_qty > 0
          ? (group.buy_avg_price ?? 0)
          : (group.sell_avg_price ?? 0)
        addToInstance(null, null, null, null, {
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          qty: group.net_qty,
          avg_cost: avgPrice,
          mark_price: null,
          unrealized_pnl: pnl,
          pool_label: 'Off',
          account_id: (group.trades[0]?.account_id ?? '').trim(),
          trades: group.trades,
          attribution_type: 'unassigned',
        })
      }
    }

    const result: InstancePositionGroup[] = []
    for (const [, group] of byInstance) {
      group.positions.sort((a, b) => {
        const aSym = getContractLabelParts(a.contract_key).symbol
        const bSym = getContractLabelParts(b.contract_key).symbol
        if (aSym !== bSym) return aSym.localeCompare(bSym)
        if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry)
        return a.strike - b.strike
      })
      const totalPnl = group.positions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
      result.push({
        strategy_instance_id: group.id,
        strategy_instance_label: group.label,
        strategy_opportunity_name: group.oppName,
        strategy_instance_opened_at_epoch: group.openedAt,
        positions: group.positions,
        total_unrealized_pnl: totalPnl,
      })
    }
    result.sort((a, b) => {
      if (a.strategy_instance_id == null && b.strategy_instance_id != null) return 1
      if (a.strategy_instance_id != null && b.strategy_instance_id == null) return -1
      return (a.strategy_instance_label ?? '').localeCompare(b.strategy_instance_label ?? '')
    })
    return result
  }, [attributions, openFilterAccountId, openFilterSymbol, openFilterExpiryStart, liveOptionPositions, livePositionMap, openOffTrackBaseExecutions])

  /** Options tab: one row per actual holding (IB snapshot + off-track), not per attribution / instance slice. */
  const optionsTabPositions = useMemo((): OpenOptionPosition[] => {
    const rows: OpenOptionPosition[] = []
    for (const pos of liveOptionPositions) {
      const acct = (pos.account_id ?? '').trim()
      const ck = (pos.contract_key ?? '').trim()
      const expiry = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
      const strike = Number(pos.strike) || 0
      const qty = Number(pos.position) || 0
      const rawAvgCost = pos.avgCost != null && Number.isFinite(Number(pos.avgCost)) ? Number(pos.avgCost) : null
      const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
      const markPrice = pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
      const pnl =
        markPrice != null && avgCostPerShare != null
          ? (markPrice - avgCostPerShare) * qty * 100
          : Number(pos.unrealized_pnl) || 0
      const contractKey =
        ck || `${pos.symbol ?? ''}|OPT|${expiry}|${strike}|${(pos.right ?? '').toUpperCase().slice(0, 1)}`
      const optKey = optExecutionMatchKey(acct, contractKey)
      const attrs = attributions.filter(a => {
        if ((a.sec_type ?? '').toUpperCase() !== 'OPT') return false
        if ((a.account_id ?? '').trim() !== acct) return false
        return optExecutionMatchKey(acct, a.contract_key ?? '') === optKey
      })
      let attribution_type: OpenOptionPosition['attribution_type'] = 'unassigned'
      if (attrs.length === 1) {
        const a0 = attrs[0]!
        attribution_type = a0.strategy_instance_id == null ? 'unassigned' : a0.is_mixed ? 'mixed' : 'single'
      } else if (attrs.length > 1) {
        const ids = new Set(attrs.map(a => a.strategy_instance_id))
        const anyMixed = attrs.some(a => a.is_mixed)
        attribution_type =
          anyMixed || ids.size > 1 ? 'mixed' : attrs[0]!.strategy_instance_id == null ? 'unassigned' : 'single'
      }
      rows.push({
        kind: 'live',
        contract_key: contractKey,
        strike,
        expiry,
        qty,
        avg_cost: avgCostPerShare,
        mark_price: markPrice,
        unrealized_pnl: pnl,
        pool_label: 'On',
        account_id: acct,
        position: pos,
        attribution_type,
      })
    }
    if (openFilterAccountId === 'all') {
      const offTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions).filter(g => g.status === 'unrealized')
      for (const group of offTrackGroups) {
        const pnl = group.sell_premium - group.buy_cost
        const avgPrice = group.net_qty > 0 ? (group.buy_avg_price ?? 0) : (group.sell_avg_price ?? 0)
        rows.push({
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          qty: group.net_qty,
          avg_cost: avgPrice,
          mark_price: null,
          unrealized_pnl: pnl,
          pool_label: 'Off',
          account_id: (group.trades[0]?.account_id ?? '').trim(),
          trades: group.trades,
          attribution_type: 'unassigned',
        })
      }
    }
    return rows
  }, [liveOptionPositions, attributions, openFilterAccountId, openOffTrackBaseExecutions])

  const getPositionTime = (p: OpenOptionPosition): number | null => {
    if (p.kind === 'live' && p.position) {
      const ts = p.position.exec_time != null ? Number(p.position.exec_time) : null
      return ts != null && Number.isFinite(ts) ? ts : null
    }
    if (p.kind === 'offtrack' && p.trades?.length) {
      const ex = p.trades[0]
      const ts = ex.time != null ? Number(ex.time) : ex.created_at != null ? Number(ex.created_at) : null
      return ts != null && Number.isFinite(ts) ? ts : null
    }
    return null
  }

  const getPositionLast = (p: OpenOptionPosition): number | null => {
    const symbol = getContractLabelParts(p.contract_key).symbol
    if (!symbol) return null
    const q = quotesMap[symbol]
    return q?.last != null && Number.isFinite(q.last) ? q.last : null
  }

  /** Options tab: sorted physical rows. */
  const sortedOptionsTabPositions = useMemo((): OpenOptionPosition[] => {
    const list = [...optionsTabPositions]
    const { column, dir } = openOptSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (column === 'contract') {
        const aParts = getContractLabelParts(a.contract_key)
        const bParts = getContractLabelParts(b.contract_key)
        const cmp = (aParts.symbol ?? '').localeCompare(bParts.symbol ?? '')
        if (cmp !== 0) return mult * cmp
        const cmpExp = a.expiry.localeCompare(b.expiry)
        if (cmpExp !== 0) return mult * cmpExp
        return mult * (a.strike - b.strike)
      }
      if (column === 'expiry') {
        const cmp = a.expiry.localeCompare(b.expiry)
        if (cmp !== 0) return mult * cmp
        return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
      }
      if (column === 'strike') {
        const cmp = a.strike - b.strike
        if (cmp !== 0) return mult * cmp
        return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
      }
      if (column === 'last') {
        const aLast = getPositionLast(a) ?? -Infinity
        const bLast = getPositionLast(b) ?? -Infinity
        if (aLast !== bLast) return mult * (aLast - bLast)
        return 0
      }
      if (column === 'qty') {
        return mult * (Math.abs(a.qty) - Math.abs(b.qty))
      }
      if (column === 'avg_cost') {
        return mult * ((a.avg_cost ?? -Infinity) - (b.avg_cost ?? -Infinity))
      }
      if (column === 'value') {
        const aVal = (a.avg_cost ?? 0) * Math.abs(a.qty) * 100
        const bVal = (b.avg_cost ?? 0) * Math.abs(b.qty) * 100
        return mult * (aVal - bVal)
      }
      if (column === 'time') {
        return mult * ((getPositionTime(a) ?? 0) - (getPositionTime(b) ?? 0))
      }
      return mult * (a.unrealized_pnl - b.unrealized_pnl)
    })
    return list
  }, [optionsTabPositions, openOptSort, quotesMap])

  const liveStockPositions = useMemo(
    () => livePositions.filter(position => (position.secType ?? '').toUpperCase() !== 'OPT'),
    [livePositions],
  )

  const { fixedIncomeStockPositions, cashLikeStockPositions, coreStockPositions } = useMemo(() => {
    const fixedIncomeStockPositions: LivePositionRow[] = []
    const cashLikeStockPositions: LivePositionRow[] = []
    const coreStockPositions: LivePositionRow[] = []
    for (const p of liveStockPositions) {
      const cat = String(p.category ?? '').trim()
      if (isLedgerFixedIncomeCategory(cat)) fixedIncomeStockPositions.push(p)
      else if (isLedgerCashLikeCategory(cat)) cashLikeStockPositions.push(p)
      else coreStockPositions.push(p)
    }
    return { fixedIncomeStockPositions, cashLikeStockPositions, coreStockPositions }
  }, [liveStockPositions])

  const instanceAllGroups = useMemo((): InstanceAllGroup[] => {
    type Bucket = {
      id: number | null
      label: string | null
      oppName: string | null
      oppId: number | null
      openedAt: number | null
      options: OpenOptionPosition[]
    }
    const map = new Map<string, Bucket>()
    const mergeMeta = (bucket: Bucket, patch: { label?: string | null; oppName?: string | null; oppId?: number | null; openedAt?: number | null }) => {
      if (patch.label != null && patch.label !== '' && !bucket.label) bucket.label = patch.label
      if (patch.oppName != null && patch.oppName !== '' && !bucket.oppName) bucket.oppName = patch.oppName
      if (patch.oppId != null && bucket.oppId == null) bucket.oppId = patch.oppId
      if (patch.openedAt != null && Number.isFinite(patch.openedAt) && bucket.openedAt == null) bucket.openedAt = patch.openedAt
    }
    for (const g of instanceGroups) {
      const key = g.strategy_instance_id != null ? String(g.strategy_instance_id) : '__unassigned__'
      const existing = map.get(key)
      if (existing) {
        existing.options.push(...g.positions)
        mergeMeta(existing, {
          label: g.strategy_instance_label,
          oppName: g.strategy_opportunity_name,
          openedAt: g.strategy_instance_opened_at_epoch,
        })
      } else {
        map.set(key, {
          id: g.strategy_instance_id,
          label: g.strategy_instance_label,
          oppName: g.strategy_opportunity_name,
          oppId: null,
          openedAt: g.strategy_instance_opened_at_epoch,
          options: [...g.positions],
        })
      }
    }

    const resolveOppId = (bucket: Bucket): number | null => {
      /** Unassigned bucket: never infer opportunity from fills — no instance ⇒ no row-level opportunity (Uncategorized only). */
      if (bucket.id == null) return null
      if (bucket.oppId != null) return bucket.oppId
      for (const a of attributions) {
        if (a.strategy_instance_id === bucket.id && a.strategy_opportunity_id != null)
          return a.strategy_opportunity_id
      }
      for (const p of bucket.options) {
        if (p.filtered_exec_lists) continue
        const execs = positionExecsForAttribution(getPositionExecLists(p))
        for (const e of execs) {
          if (e.strategy_opportunity_id != null) return e.strategy_opportunity_id
        }
      }
      return null
    }

    /**
     * Fills that do not match this instance row → optional Uncategorized clone under Unassigned.
     * Skip positions already attributed by the backend (single or mixed) — the attribution API
     * is the source of truth; TWS raw fills lack instance tags by nature and must not cause
     * attributed positions to be duplicated under Uncategorized.
     */
    const unassignedKey = '__unassigned__'
    for (const [, b] of map) {
      if (b.id == null) continue
      const oppIdForMatch = resolveOppId(b)
      for (const p of b.options) {
        if (p.filtered_exec_lists) continue
        if (p.attribution_type === 'single' || p.attribution_type === 'mixed') continue
        const full = getPositionExecLists(p)
        const unscopedFinal = full.final.filter(
          ex => !executionMatchesInstanceGroup(ex, b.id, oppIdForMatch),
        )
        const unscopedTws = full.tws.filter(
          ex => !executionMatchesInstanceGroup(ex, b.id, oppIdForMatch),
        )
        if (unscopedFinal.length === 0 && unscopedTws.length === 0) continue
        let u = map.get(unassignedKey)
        if (!u) {
          u = { id: null, label: null, oppName: null, oppId: null, openedAt: null, options: [] }
          map.set(unassignedKey, u)
        }
        u.options.push({
          ...p,
          filtered_exec_lists: { final: unscopedFinal, tws: unscopedTws },
          attribution_type: 'unassigned',
        })
      }
    }

    const execPremiumPnl = (execs: Execution[]): number => {
      let sellPremium = 0
      let buyCost = 0
      for (const e of execs) {
        const side = (e.side ?? '').toUpperCase()
        const q = Math.abs(Number(e.quantity) || 0)
        const p = Number(e.price) || 0
        const c = Number(e.commission) || 0
        if (side === 'SELL' || side === 'SLD' || side === 'S') {
          sellPremium += p * q * 100 - c
        } else if (side === 'BUY' || side === 'BOT' || side === 'B') {
          buyCost += p * q * 100 + c
        }
      }
      return sellPremium - buyCost
    }

    const computeStockCoverage = (options: OpenOptionPosition[], str: StrategyStructure | undefined): InstanceStockCoverage[] => {
      if (!str?.legs?.length) return []
      const underlyingLeg = str.legs.find(l => (l.role ?? '').toLowerCase() === 'underlying')
      if (!underlyingLeg) return []
      const legDir = (underlyingLeg.direction ?? 'long').toLowerCase() as 'long' | 'short'
      const legQty = underlyingLeg.quantity ?? 1
      /** Same symbol may appear in multiple accounts; stock hedge is per account (no cross-margin). */
      const bySymbolAccount = new Map<string, { symbol: string; account_id: string; contracts: number }>()
      for (const p of options) {
        const sym = getContractLabelParts(p.contract_key).symbol
        if (!sym) continue
        const account_id = (p.account_id ?? '').trim()
        const k = `${sym}\x00${account_id}`
        const prev = bySymbolAccount.get(k) ?? { symbol: sym, account_id, contracts: 0 }
        prev.contracts += Math.abs(p.qty)
        bySymbolAccount.set(k, prev)
      }
      const result: InstanceStockCoverage[] = []
      for (const v of bySymbolAccount.values()) {
        result.push({
          symbol: v.symbol,
          account_id: v.account_id,
          required_shares: v.contracts * 100 * legQty,
          direction: legDir,
        })
      }
      result.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
      return result
    }

    const pickWorseRiskProfile = (a: import('../utils/riskProfile').RiskProfile, b: import('../utils/riskProfile').RiskProfile) => {
      if (a.naked_short_call_contracts !== b.naked_short_call_contracts) {
        return a.naked_short_call_contracts > b.naked_short_call_contracts ? a : b
      }
      if (a.max_loss == null && b.max_loss != null) return a
      if (a.max_loss != null && b.max_loss == null) return b
      if (a.max_loss != null && b.max_loss != null && a.max_loss !== b.max_loss) {
        return a.max_loss < b.max_loss ? a : b
      }
      return a
    }

    const result: InstanceAllGroup[] = []
    for (const [, b] of map) {
      const oppId = resolveOppId(b)
      let optPnl = 0
      for (const p of b.options) {
        if (p.filtered_exec_lists) {
          const matchedExecs = getPositionExecLists(p).merged
          if (matchedExecs.length > 0) {
            optPnl += execPremiumPnl(matchedExecs)
          } else {
            optPnl += p.unrealized_pnl
          }
          continue
        }
        const matchedExecs = positionExecsForAttribution(getPositionExecLists(p)).filter(ex =>
          executionMatchesInstanceGroup(ex, b.id, oppId),
        )
        if (matchedExecs.length > 0) {
          optPnl += execPremiumPnl(matchedExecs)
        } else {
          optPnl += p.unrealized_pnl
        }
      }
      const opp = oppId != null ? oppMap.get(oppId) : undefined
      const str = opp ? structureMap.get(opp.strategy_structure_id) : undefined
      const attrForInstance = b.id != null ? attributions.find(a => a.strategy_instance_id === b.id) : undefined
      const resolvedStructureType = str?.structure_type ?? attrForInstance?.structure_type ?? null
      const resolvedScopeType = opp?.scope_type ?? attrForInstance?.scope_type ?? null
      const optionsForRisk = b.options.filter(p => !p.filtered_exec_lists)
      const coverage = computeStockCoverage(optionsForRisk, str)

      let riskProfile = null as import('../utils/riskProfile').RiskProfile | null
      if (optionsForRisk.length > 0) {
        const byAcct = new Map<string, OpenOptionPosition[]>()
        for (const p of optionsForRisk) {
          const aid = (p.account_id ?? '').trim()
          if (!byAcct.has(aid)) byAcct.set(aid, [])
          byAcct.get(aid)!.push(p)
        }
        for (const optsInAcct of byAcct.values()) {
          const riskPositions: RiskPosition[] = []
          for (const p of optsInAcct) {
            const parsed = parseOptionContractKey(p.contract_key)
            const r = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
            if (r && p.avg_cost != null) {
              riskPositions.push({ strike: p.strike, right: r, qty: p.qty, avg_cost: p.avg_cost })
            }
          }
          if (riskPositions.length === 0) continue
          let covShares = 0
          let covAvgCost: number | null = null
          const covRows = computeStockCoverage(optsInAcct, str)
          if (covRows.length > 0) {
            const optSym = getContractLabelParts(optsInAcct[0].contract_key).symbol?.toUpperCase() ?? ''
            const row =
              optSym && covRows.some(c => c.symbol.toUpperCase() === optSym)
                ? covRows.find(c => c.symbol.toUpperCase() === optSym)!
                : covRows[0]
            const sym = row.symbol
            const acct = row.account_id
            const heldPos = liveStockPositions.find(
              s =>
                (s.symbol ?? '').toUpperCase() === sym.toUpperCase() &&
                (s.account_id ?? '').trim() === acct,
            )
            const held = heldPos ? Math.abs(Number(heldPos.position) || 0) : 0
            covShares = Math.min(held, row.required_shares)
            covAvgCost = heldPos?.avgCost != null ? Number(heldPos.avgCost) : null
          }
          const rp = computeRiskProfile(riskPositions, covShares, covAvgCost)
          riskProfile = riskProfile == null ? rp : pickWorseRiskProfile(riskProfile, rp)
        }
      }

      result.push({
        strategy_instance_id: b.id,
        strategy_instance_label: b.label,
        strategy_opportunity_name: b.oppName ?? opp?.name ?? null,
        strategy_opportunity_id: oppId,
        strategy_instance_opened_at_epoch: b.openedAt,
        options: b.options,
        stock_coverage: coverage,
        options_unrealized_pnl: optPnl,
        structure_type: resolvedStructureType,
        scope_type: resolvedScopeType,
        risk_profile: riskProfile,
      })
    }
    result.sort((a, b) => {
      if (a.strategy_instance_id == null && b.strategy_instance_id != null) return 1
      if (a.strategy_instance_id != null && b.strategy_instance_id == null) return -1
      return (a.strategy_instance_label ?? '').localeCompare(b.strategy_instance_label ?? '')
    })
    return result
  }, [instanceGroups, oppMap, structureMap, getPositionExecLists, liveStockPositions, attributions])

  const stockCoverageItems = useMemo((): StockCoverageItem[] => {
    const covKey = (sym: string, accountId: string) =>
      `${(sym ?? '').toUpperCase().trim()}\x1f${(accountId ?? '').trim()}`
    type DemandMeta = {
      required: number
      requiredWatchlist: number
      instances: number
      oppNames: Set<string>
      watchlistScopeInstances: number
    }
    const demandMap = new Map<string, DemandMeta>()
    for (const g of instanceAllGroups) {
      const oppName = (g.strategy_opportunity_name ?? '').trim()
      const isWl = (g.scope_type ?? '').trim() === 'watchlist_stk'
      for (const sc of g.stock_coverage) {
        const sym = (sc.symbol ?? '').toUpperCase().trim()
        if (!sym) continue
        const k = covKey(sym, sc.account_id)
        const prev = demandMap.get(k) ?? {
          required: 0,
          requiredWatchlist: 0,
          instances: 0,
          oppNames: new Set<string>(),
          watchlistScopeInstances: 0,
        }
        prev.required += sc.required_shares
        if (isWl) prev.requiredWatchlist += sc.required_shares
        prev.instances += 1
        if (oppName) prev.oppNames.add(oppName)
        if (isWl) prev.watchlistScopeInstances += 1
        demandMap.set(k, prev)
      }
    }

    type HeldMeta = {
      held: number
      heldAbs: number
      costBasisAbs: number
      lastWeightedSum: number
      lastWeight: number
      dailyPnl: number
      dailyBaseAbs: number
      totalPnl: number
      optionableTrue: number
      optionableFalse: number
      optionableUnknown: number
    }
    const heldMap = new Map<string, HeldMeta>()
    for (const s of liveStockPositions) {
      const sym = (s.symbol ?? '').toUpperCase().trim()
      if (!sym) continue
      const k = covKey(sym, (s.account_id ?? '').trim())
      const qty = Number(s.position)
      if (!Number.isFinite(qty) || qty === 0) continue
      const absQty = Math.abs(qty)
      const avgCost = s.avgCost != null && Number.isFinite(Number(s.avgCost)) ? Number(s.avgCost) : null
      const lastPrice = s.price != null && Number.isFinite(Number(s.price)) ? Number(s.price) : null
      const dailyPrevClose = s.daily_prev_close != null && Number.isFinite(Number(s.daily_prev_close))
        ? Number(s.daily_prev_close)
        : null
      const unrealizedPnl = s.unrealized_pnl != null && Number.isFinite(Number(s.unrealized_pnl))
        ? Number(s.unrealized_pnl)
        : (lastPrice != null && avgCost != null ? (lastPrice - avgCost) * qty : 0)

      const prev = heldMap.get(k) ?? {
        held: 0,
        heldAbs: 0,
        costBasisAbs: 0,
        lastWeightedSum: 0,
        lastWeight: 0,
        dailyPnl: 0,
        dailyBaseAbs: 0,
        totalPnl: 0,
        optionableTrue: 0,
        optionableFalse: 0,
        optionableUnknown: 0,
      }
      prev.held += qty
      prev.heldAbs += absQty
      if (avgCost != null) prev.costBasisAbs += absQty * avgCost
      if (lastPrice != null) {
        prev.lastWeightedSum += absQty * lastPrice
        prev.lastWeight += absQty
      }
      if (dailyPrevClose != null && lastPrice != null) {
        prev.dailyPnl += (lastPrice - dailyPrevClose) * qty
        prev.dailyBaseAbs += Math.abs(dailyPrevClose * qty)
      }
      prev.totalPnl += unrealizedPnl
      if (s.optionable === true) prev.optionableTrue += 1
      else if (s.optionable === false) prev.optionableFalse += 1
      else prev.optionableUnknown += 1
      heldMap.set(k, prev)
    }

    const allKeys = new Set([...demandMap.keys(), ...heldMap.keys()])
    const result: StockCoverageItem[] = []
    for (const key of allKeys) {
      const sep = key.indexOf('\x1f')
      const sym = sep >= 0 ? key.slice(0, sep) : key
      const account_id = sep >= 0 ? key.slice(sep + 1) : ''
      const demand = demandMap.get(key)
      const heldMeta = heldMap.get(key)
      const required = demand?.required ?? 0
      const held = heldMeta?.held ?? 0
      if (required === 0 && held === 0) continue
      const costBasis = heldMeta != null && heldMeta.costBasisAbs > 0 ? heldMeta.costBasisAbs : null
      const totalPnl = heldMeta != null && Number.isFinite(heldMeta.totalPnl) ? heldMeta.totalPnl : null
      const totalPct = costBasis != null && costBasis > 0 && totalPnl != null ? (totalPnl / costBasis) * 100 : null
      const dailyPct = heldMeta != null && heldMeta.dailyBaseAbs > 0 ? (heldMeta.dailyPnl / heldMeta.dailyBaseAbs) * 100 : null

      let optionableSupported: boolean | null = null
      if (heldMeta != null) {
        if (heldMeta.optionableTrue > 0 && heldMeta.optionableFalse === 0) optionableSupported = true
        else if (heldMeta.optionableFalse > 0 && heldMeta.optionableTrue === 0) optionableSupported = false
      }

      result.push({
        symbol: sym,
        account_id,
        required_shares: required,
        required_watchlist_shares: demand?.requiredWatchlist ?? 0,
        held_shares: held,
        surplus_or_gap: held - required,
        instances_needing: demand?.instances ?? 0,
        backing_opportunities: demand != null ? Array.from(demand.oppNames).sort() : [],
        watchlist_scope_instances: demand?.watchlistScopeInstances ?? 0,
        optionable_supported: optionableSupported,
        avg_cost_per_share: heldMeta != null && heldMeta.heldAbs > 0 ? heldMeta.costBasisAbs / heldMeta.heldAbs : null,
        live_last_price: heldMeta != null && heldMeta.lastWeight > 0 ? heldMeta.lastWeightedSum / heldMeta.lastWeight : null,
        cost_basis_total: costBasis,
        daily_pnl: heldMeta != null ? heldMeta.dailyPnl : null,
        daily_pct: dailyPct,
        total_pnl: totalPnl,
        total_pct: totalPct,
      })
    }
    result.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
    return result
  }, [instanceAllGroups, liveStockPositions])

  /** Watchlist opportunities: Required = watchlist-only hedge; Surplus vs that slice. */
  const watchlistOptionableCoverageItems = useMemo(
    () =>
      stockCoverageItems
        .filter((ci) => (ci.watchlist_scope_instances ?? 0) > 0 && ci.optionable_supported !== false)
        .map(ci => {
          const rw = ci.required_watchlist_shares ?? 0
          return { ...ci, required_shares: rw, surplus_or_gap: ci.held_shares - rw }
        }),
    [stockCoverageItems],
  )

  /**
   * Long stock left after all current opportunity hedges (watchlist + explicit); can back further options.
   */
  const optionUnderlyingPoolItems = useMemo((): StockCoverageItem[] => {
    const out: StockCoverageItem[] = []
    for (const ci of stockCoverageItems) {
      if (ci.optionable_supported === false) continue
      const held = ci.held_shares
      const req = ci.required_shares
      if (!Number.isFinite(held) || held <= 0) continue
      const avail = Math.max(0, held - req)
      if (avail <= 0) continue
      const ratio = held > 0 ? avail / held : 0
      const costSlice = ci.cost_basis_total != null ? ci.cost_basis_total * ratio : null
      const dailySlice = ci.daily_pnl != null ? ci.daily_pnl * ratio : null
      const totalSlice = ci.total_pnl != null ? ci.total_pnl * ratio : null
      const dailyPct =
        dailySlice != null && ci.daily_pnl != null && Math.abs(ci.daily_pnl) > 1e-9
          ? ci.daily_pct
          : null
      const totalPct =
        costSlice != null && costSlice > 0 && totalSlice != null ? (totalSlice / costSlice) * 100 : null
      out.push({
        ...ci,
        held_shares: avail,
        required_shares: 0,
        required_watchlist_shares: 0,
        surplus_or_gap: avail,
        cost_basis_total: costSlice,
        daily_pnl: dailySlice,
        daily_pct: dailyPct,
        total_pnl: totalSlice,
        total_pct: totalPct,
        instances_needing: 0,
        backing_opportunities: [],
        watchlist_scope_instances: 0,
      })
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
    return out
  }, [stockCoverageItems])

  const [stockCoverageSectionAccount, setStockCoverageSectionAccount] = useState<string>('all')

  const optionUnderlyingPoolMarketTotal = useMemo(() => {
    const rows =
      stockCoverageSectionAccount === 'all'
        ? optionUnderlyingPoolItems
        : optionUnderlyingPoolItems.filter(
            ci => (ci.account_id ?? '').trim() === stockCoverageSectionAccount,
          )
    return rows.reduce((s, ci) => {
      const h = ci.held_shares
      const p = ci.live_last_price
      if (p == null || !Number.isFinite(p) || !Number.isFinite(h)) return s
      return s + h * p
    }, 0)
  }, [optionUnderlyingPoolItems, stockCoverageSectionAccount])

  const streamHostAccountId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
  const streamSecondaryAccountId = (status?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()

  /** Open Positions account filter: All vs IB Host / Secondary only (Settings → IB Connection). */
  const openFilterAccountTabs = useMemo(() => {
    const tabs: { accountId: string; displayLabel: string }[] = []
    if (streamHostAccountId) {
      tabs.push({ accountId: streamHostAccountId, displayLabel: `IB Host ${streamHostAccountId}` })
    }
    if (streamSecondaryAccountId && streamSecondaryAccountId !== streamHostAccountId) {
      tabs.push({
        accountId: streamSecondaryAccountId,
        displayLabel: `IB Secondary ${streamSecondaryAccountId}`,
      })
    }
    return tabs
  }, [streamHostAccountId, streamSecondaryAccountId])

  useEffect(() => {
    if (openFilterAccountId === 'all') return
    const ok =
      (streamHostAccountId && openFilterAccountId === streamHostAccountId) ||
      (streamSecondaryAccountId && openFilterAccountId === streamSecondaryAccountId)
    if (!ok) setOpenFilterAccountId('all')
  }, [openFilterAccountId, streamHostAccountId, streamSecondaryAccountId])

  const hostSecondaryAccountCashBp = useMemo(() => {
    const list = status?.portfolio?.accounts ?? []
    const snap = (id: string) =>
      id ? list.find(a => (a.account_id ?? '').trim() === id) : undefined
    return {
      host: accountTotalCashBuyingPower(snap(streamHostAccountId)),
      secondary: accountTotalCashBuyingPower(snap(streamSecondaryAccountId)),
    }
  }, [status?.portfolio?.accounts, streamHostAccountId, streamSecondaryAccountId])

  const [underlyingPoolSort, setUnderlyingPoolSort] = useState<{
    col: CoveragePoolSortCol
    dir: 'asc' | 'desc'
  }>({ col: 'market_price', dir: 'desc' })

  const sortedOptionUnderlyingPoolItems = useMemo(
    () => sortStockCoverageItemsByColumn(optionUnderlyingPoolItems, underlyingPoolSort.col, underlyingPoolSort.dir),
    [optionUnderlyingPoolItems, underlyingPoolSort],
  )

  const sortedOptionUnderlyingPoolItemsForSection = useMemo(() => {
    if (stockCoverageSectionAccount === 'all') return sortedOptionUnderlyingPoolItems
    return sortedOptionUnderlyingPoolItems.filter(
      ci => (ci.account_id ?? '').trim() === stockCoverageSectionAccount,
    )
  }, [sortedOptionUnderlyingPoolItems, stockCoverageSectionAccount])

  const onUnderlyingPoolSortClick = useCallback((col: CoveragePoolSortCol) => {
    setUnderlyingPoolSort(prev =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    )
  }, [])

  const [backingPoolSort, setBackingPoolSort] = useState<{
    col: CoveragePoolSortCol
    dir: 'asc' | 'desc'
  }>({ col: 'market_price', dir: 'desc' })

  const sortedWatchlistOptionableCoverageItems = useMemo(
    () =>
      sortStockCoverageItemsByColumn(watchlistOptionableCoverageItems, backingPoolSort.col, backingPoolSort.dir),
    [watchlistOptionableCoverageItems, backingPoolSort],
  )

  const sortedWatchlistOptionableCoverageItemsForSection = useMemo(() => {
    if (stockCoverageSectionAccount === 'all') return sortedWatchlistOptionableCoverageItems
    return sortedWatchlistOptionableCoverageItems.filter(
      ci => (ci.account_id ?? '').trim() === stockCoverageSectionAccount,
    )
  }, [sortedWatchlistOptionableCoverageItems, stockCoverageSectionAccount])

  const onBackingPoolSortClick = useCallback((col: CoveragePoolSortCol) => {
    setBackingPoolSort(prev =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    )
  }, [])

  /** When false (default), donut compares stock vs net cash only; buying power still listed below. */
  const [coverageAssetPieIncludeBp, setCoverageAssetPieIncludeBp] = useState(false)
  /** Fixed income / cash-like STK positions: exclude from ring denominator when false (values still in legend). */
  const [coverageAssetPieIncludeFi, setCoverageAssetPieIncludeFi] = useState(false)
  const [coverageAssetPieIncludeCashLike, setCoverageAssetPieIncludeCashLike] = useState(true)

  const backingPoolChartData = useMemo(() => {
    const matchAcct = (acct: string) =>
      stockCoverageSectionAccount === 'all' || acct === stockCoverageSectionAccount

    const totalStockMV = stockCoverageItems
      .filter(ci => matchAcct(ci.account_id))
      .reduce((s, ci) => {
        const mv = coverageRowMarketValueTotal(ci)
        return mv != null ? s + mv : s
      }, 0)

    const backingMV = watchlistOptionableCoverageItems
      .filter(ci => matchAcct(ci.account_id))
      .reduce((s, ci) => {
        const rw = ci.required_watchlist_shares ?? 0
        const backedShares = Math.min(Math.max(0, ci.held_shares), rw)
        const price = ci.live_last_price
        if (price == null || !Number.isFinite(price) || !Number.isFinite(backedShares)) return s
        return s + backedShares * price
      }, 0)

    const pct = totalStockMV > 0 ? Math.min(1, Math.max(0, backingMV / totalStockMV)) : 0
    return { backingMV, totalStockMV, otherMV: totalStockMV - backingMV, pct }
  }, [stockCoverageItems, watchlistOptionableCoverageItems, stockCoverageSectionAccount])

  const coverageAssetPieData = useMemo(() => {
    const accounts = status?.portfolio?.accounts ?? []
    const snap = (id: string) =>
      id ? accounts.find(a => (a.account_id ?? '').trim() === id) : undefined

    const aggregateForAccounts = (ids: string[]) => {
      let cash: number | null = null
      let bp: number | null = null
      for (const id of ids) {
        const { cash: c, bp: b } = accountTotalCashBuyingPower(snap(id))
        if (c != null && Number.isFinite(c)) cash = (cash ?? 0) + c
        if (b != null && Number.isFinite(b)) bp = (bp ?? 0) + b
      }
      return { cash, bp }
    }

    let coreStockMV = 0
    let fixedIncomeMV = 0
    let cashLikeMV = 0
    let cash: number | null = null
    let bp: number | null = null

    const acct: 'all' | string = stockCoverageSectionAccount
    if (acct === 'all') {
      coreStockMV = sumStockMarketValueForAccountFilter(coreStockPositions, 'all')
      fixedIncomeMV = sumStockMarketValueForAccountFilter(fixedIncomeStockPositions, 'all')
      cashLikeMV = sumStockMarketValueForAccountFilter(cashLikeStockPositions, 'all')
      const ids = new Set<string>()
      for (const a of accounts) {
        const id = (a.account_id ?? '').trim()
        if (id) ids.add(id)
      }
      if (ids.size > 0) {
        const ag = aggregateForAccounts([...ids])
        cash = ag.cash
        bp = ag.bp
      }
    } else {
      coreStockMV = sumStockMarketValueForAccountFilter(coreStockPositions, acct)
      fixedIncomeMV = sumStockMarketValueForAccountFilter(fixedIncomeStockPositions, acct)
      cashLikeMV = sumStockMarketValueForAccountFilter(cashLikeStockPositions, acct)
      const ag = aggregateForAccounts([acct])
      cash = ag.cash
      bp = ag.bp
    }

    const wCore = Math.max(0, coreStockMV)
    const wFi = Math.max(0, fixedIncomeMV)
    const wCl = Math.max(0, cashLikeMV)
    const wCash = cash != null && Number.isFinite(cash) ? Math.max(0, cash) : 0
    const wBp = bp != null && Number.isFinite(bp) ? Math.max(0, bp) : 0
    const wFiIn = coverageAssetPieIncludeFi ? wFi : 0
    const wClIn = coverageAssetPieIncludeCashLike ? wCl : 0
    const wBpIn = coverageAssetPieIncludeBp ? wBp : 0
    const denom = wCore + wFiIn + wClIn + wCash + wBpIn
    const pStock = denom > 0 ? wCore / denom : 0
    const pFixedIncome = denom > 0 && coverageAssetPieIncludeFi ? wFi / denom : 0
    const pCashLike = denom > 0 && coverageAssetPieIncludeCashLike ? wCl / denom : 0
    const pCash = denom > 0 ? wCash / denom : 0
    const pBp = denom > 0 && coverageAssetPieIncludeBp ? wBp / denom : 0

    const netLiq =
      stockCoverageSectionAccount === 'all'
        ? accounts.reduce((s, a) => {
            const n = parseIbSummaryNumber(a, 'NetLiquidation')
            return s + (n != null && Number.isFinite(n) ? n : 0)
          }, 0)
        : parseIbSummaryNumber(snap(stockCoverageSectionAccount), 'NetLiquidation')

    const simpleCenterPct =
      !coverageAssetPieIncludeBp &&
      !coverageAssetPieIncludeFi &&
      !coverageAssetPieIncludeCashLike

    return {
      coreStockMV,
      fixedIncomeMV,
      cashLikeMV,
      cash,
      bp,
      denom,
      pStock,
      pFixedIncome,
      pCashLike,
      pCash,
      pBp,
      includeBpInChart: coverageAssetPieIncludeBp,
      includeFiInChart: coverageAssetPieIncludeFi,
      includeCashLikeInChart: coverageAssetPieIncludeCashLike,
      simpleCenterPct,
      netLiq: netLiq != null && Number.isFinite(netLiq) && netLiq > 0 ? netLiq : null,
    }
  }, [
    status?.portfolio?.accounts,
    coreStockPositions,
    fixedIncomeStockPositions,
    cashLikeStockPositions,
    stockCoverageSectionAccount,
    coverageAssetPieIncludeBp,
    coverageAssetPieIncludeFi,
    coverageAssetPieIncludeCashLike,
  ])

  const independentStockSections = useMemo(() => {
    const isIndep = (s: LivePositionRow) => s.optionable !== true
    return [
      { title: 'Stocks', key: 'ind-stk', rows: coreStockPositions.filter(isIndep) },
      { title: 'Fixed income', key: 'ind-fi', rows: fixedIncomeStockPositions.filter(isIndep) },
      { title: 'Cash-like', key: 'ind-cash', rows: cashLikeStockPositions.filter(isIndep) },
    ] as const
  }, [coreStockPositions, fixedIncomeStockPositions, cashLikeStockPositions])

  const filteredInstanceAllGroups = useMemo((): InstanceAllGroup[] => {
    let list = instanceAllGroups
    if (instanceFilterStructureType !== 'all') {
      list = list.filter(g => (g.structure_type ?? '') === instanceFilterStructureType)
    }
    if (instanceFilterScopeType !== 'all') {
      if (instanceFilterScopeType === '__none__') {
        list = list.filter(g => !g.scope_type)
      } else {
        list = list.filter(g => g.scope_type === instanceFilterScopeType)
      }
    }
    if (instanceFilterOppName !== 'all') {
      list = list.filter(g => (g.strategy_opportunity_name ?? '') === instanceFilterOppName)
    }
    if (instanceFilterAttributionType !== 'all') {
      list = list.filter(g => {
        const types = new Set(g.options.map(p => p.attribution_type ?? 'unassigned'))
        if (instanceFilterAttributionType === 'mixed') return types.has('mixed')
        if (instanceFilterAttributionType === 'single') return types.has('single') && !types.has('mixed')
        if (instanceFilterAttributionType === 'unassigned') return g.strategy_instance_id == null
        return true
      })
    }
    return list
  }, [instanceAllGroups, instanceFilterStructureType, instanceFilterScopeType, instanceFilterOppName, instanceFilterAttributionType])

  const instanceFilterOptions = useMemo(() => {
    const stSet = new Set<string>()
    const scSet = new Set<string>()
    const oppSet = new Set<string>()
    for (const g of instanceAllGroups) {
      if (g.structure_type) stSet.add(g.structure_type)
      scSet.add(g.scope_type ?? '')
      if (g.strategy_opportunity_name) oppSet.add(g.strategy_opportunity_name)
    }
    return {
      structureTypes: Array.from(stSet).sort(),
      scopeTypes: Array.from(scSet).sort(),
      oppNames: Array.from(oppSet).sort(),
    }
  }, [instanceAllGroups])

  const sortedInstanceAllGroups = useMemo((): InstanceAllGroup[] => {
    const { column, dir } = openOptSort
    const mult = dir === 'asc' ? 1 : -1
    const sortPositions = (positions: OpenOptionPosition[]) => {
      const list = [...positions]
      list.sort((a, b) => {
        if (column === 'contract') {
          const aParts = getContractLabelParts(a.contract_key)
          const bParts = getContractLabelParts(b.contract_key)
          const cmp = (aParts.symbol ?? '').localeCompare(bParts.symbol ?? '')
          if (cmp !== 0) return mult * cmp
          const cmpExp = a.expiry.localeCompare(b.expiry)
          if (cmpExp !== 0) return mult * cmpExp
          return mult * (a.strike - b.strike)
        }
        if (column === 'expiry') {
          const cmp = a.expiry.localeCompare(b.expiry)
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'strike') {
          const cmp = a.strike - b.strike
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'last') {
          const aLast = getPositionLast(a) ?? -Infinity
          const bLast = getPositionLast(b) ?? -Infinity
          if (aLast !== bLast) return mult * (aLast - bLast)
          return 0
        }
        if (column === 'qty') {
          return mult * (Math.abs(a.qty) - Math.abs(b.qty))
        }
        if (column === 'avg_cost') {
          return mult * ((a.avg_cost ?? -Infinity) - (b.avg_cost ?? -Infinity))
        }
        if (column === 'value') {
          const aVal = (a.avg_cost ?? 0) * Math.abs(a.qty) * 100
          const bVal = (b.avg_cost ?? 0) * Math.abs(b.qty) * 100
          return mult * (aVal - bVal)
        }
        if (column === 'time') {
          return mult * ((getPositionTime(a) ?? 0) - (getPositionTime(b) ?? 0))
        }
        return mult * (a.unrealized_pnl - b.unrealized_pnl)
      })
      return list
    }
    const out = filteredInstanceAllGroups.map(g => ({
      ...g,
      options: sortPositions(g.options),
    }))
    return out
  }, [filteredInstanceAllGroups, openOptSort, quotesMap])

  const [expandedInstanceKeys, setExpandedInstanceKeys] = useState<string[]>([])
  const toggleInstanceExpand = (key: string) => {
    setExpandedInstanceKeys(prev => {
      const isOpen = prev.includes(key)
      if (openAccordionMode) return isOpen ? [] : [key]
      return isOpen ? prev.filter(k => k !== key) : [...prev, key]
    })
  }

  /** Accordion: keep at most one expanded strategy row. */
  useEffect(() => {
    if (!openAccordionMode) return
    setExpandedInstanceKeys(prev => (prev.length <= 1 ? prev : [prev[prev.length - 1]!]))
  }, [openAccordionMode])

  const hasOpenOptions = optionsTabPositions.length > 0
  const hasCoreStocks = coreStockPositions.length > 0
  const hasFixedIncomeStocks = fixedIncomeStockPositions.length > 0
  const hasCashLikeStocks = cashLikeStockPositions.length > 0
  const hasInstances = instanceAllGroups.length > 0

  useEffect(() => {
    const order: OpenPositionsTab[] = ['instance', 'options', 'stocks', 'fixed_income', 'cash_like']
    const isAvailable = (t: OpenPositionsTab): boolean => {
      switch (t) {
        case 'instance':
          return hasInstances
        case 'options':
          return hasOpenOptions
        case 'stocks':
          return hasCoreStocks
        case 'fixed_income':
          return hasFixedIncomeStocks
        case 'cash_like':
          return hasCashLikeStocks
        default:
          return false
      }
    }
    if (isAvailable(openTab)) return
    for (const t of order) {
      if (isAvailable(t)) {
        setOpenTab(t)
        return
      }
    }
  }, [
    openTab,
    hasInstances,
    hasOpenOptions,
    hasCoreStocks,
    hasFixedIncomeStocks,
    hasCashLikeStocks,
  ])

  useEffect(() => {
    loadReplayData()
    loadAttributions()
  }, [loadReplayData, loadAttributions])

  const renderStockCoverageSummaryTable = (
    rows: StockCoverageItem[],
    keyPrefix: string,
    tableOpts?: {
      showAvailableHeldContracts?: boolean
      hideBackedOpportunities?: boolean
      /** Option underlying Pool: fewer columns, Host/Secondary account colors, held amt = contracts only. */
      underlyingPoolSlim?: boolean
      backingPoolSlim?: boolean
      underlyingPoolSort?: {
        column: CoveragePoolSortCol
        dir: 'asc' | 'desc'
        onColumnClick: (col: CoveragePoolSortCol) => void
      }
    },
  ) => {
    const slim = tableOpts?.underlyingPoolSlim === true
    const backingSlim = tableOpts?.backingPoolSlim === true
    const backingLayout = backingSlim && !slim
    const poolSort = tableOpts?.underlyingPoolSort
    const showAvail = slim || tableOpts?.showAvailableHeldContracts === true
    const hideBacked = slim || tableOpts?.hideBackedOpportunities === true
    const showHeldColumn = !backingLayout
    const showHeldAmtColumn = slim || backingLayout || (showAvail && !backingLayout && !slim)
    const accountCellClass = (accountId: string) => {
      const a = (accountId ?? '').trim()
      if (streamSecondaryAccountId && a === streamSecondaryAccountId) return 'coverage-account-id coverage-account-secondary'
      if (streamHostAccountId && a === streamHostAccountId) return 'coverage-account-id coverage-account-host'
      return 'coverage-account-id coverage-account-other'
    }
    const poolSortOn = !!(poolSort && (slim || backingLayout))
    const poolGroupByAccount = slim || backingLayout
    const accountGroupColSpan = poolGroupByAccount ? 7 : 0
    const sortCol = poolSort?.column ?? 'market_price'
    const sortDir = poolSort?.dir ?? 'desc'
    const accountGroups = poolGroupByAccount
      ? groupCoverageByAccount(
          rows,
          sortCol,
          sortDir,
          streamHostAccountId,
          streamSecondaryAccountId,
        )
      : null
    const sortTh = (label: ReactNode, col: CoveragePoolSortCol, title?: string) => {
      if (!poolSortOn) return <th title={title}>{label}</th>
      const active = poolSort.column === col
      return (
        <th
          className="replay-th-sortable coverage-pool-sort-th"
          title={title}
          role="button"
          tabIndex={0}
          aria-sort={active ? (poolSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
          onClick={() => poolSort.onColumnClick(col)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              poolSort.onColumnClick(col)
            }
          }}
        >
          {label}
          {active ? (poolSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
        </th>
      )
    }
    const renderCoverageDataRow = (ci: StockCoverageItem, rowKey: string) => {
      const statusLabel =
        ci.held_shares >= ci.required_shares
          ? 'Covered'
          : ci.held_shares > 0
            ? 'Partial'
            : 'Naked'
      const statusClass =
        ci.held_shares >= ci.required_shares
          ? 'coverage-status-covered'
          : ci.held_shares > 0
            ? 'coverage-status-partial'
            : 'coverage-status-naked'
      const optionSupportLabel =
        ci.optionable_supported === true
          ? 'Optionable'
          : ci.optionable_supported === false
            ? 'Not optionable'
            : 'Mixed / Unknown'
      const backedOpps = ci.backing_opportunities ?? []
      const availContracts = showAvail ? Math.floor(Math.max(0, ci.held_shares) / 100) : 0
      const acc = ci.account_id || '—'
      return (
        <tr key={rowKey}>
          <td>
            <strong>{ci.symbol}</strong>
          </td>
          {!poolGroupByAccount && <td className="replay-muted">{acc}</td>}
          {!hideBacked && (
            <td title={backedOpps.join(', ') || undefined}>
              {backedOpps.length > 0 ? backedOpps.join(', ') : '—'}
            </td>
          )}
          {showHeldColumn && (
            <td className={slim ? 'coverage-held-shares-cell' : undefined}>
              {slim ? fmtHeldSharesWhole(ci.held_shares) : ci.held_shares}
            </td>
          )}
          {showHeldAmtColumn &&
            (slim || backingLayout ? (
              <td
                className={`coverage-available-held-amt-cell coverage-available-held-amt-slim${slim && !backingLayout ? ' coverage-held-amt-underlying-narrow' : ''}`}
              >
                <span
                  className={`coverage-available-contracts-only${slim && !backingLayout ? ' coverage-held-amt-underlying-contracts' : ''}`}
                  title={
                    backingLayout
                      ? `${Math.floor(Math.max(0, Math.min(ci.held_shares, ci.required_shares)) / 100)} contracts — min(${ci.held_shares} held, ${ci.required_shares} required) sh ÷ 100`
                      : `${ci.held_shares} sh ÷ 100`
                  }
                >
                  {backingLayout
                    ? Math.floor(
                        Math.max(0, Math.min(ci.held_shares || 0, ci.required_shares || 0)) / 100,
                      )
                    : Math.floor(Math.max(0, ci.held_shares) / 100)}
                </span>
                {backingLayout && ci.instances_needing > 1 && (
                  <span className="coverage-shared-hint"> ({ci.instances_needing} strat.)</span>
                )}
              </td>
            ) : (
              <td className="coverage-available-held-amt-cell">
                <div className="coverage-available-contracts" title={`${ci.held_shares} sh ÷ 100`}>
                  {availContracts}
                </div>
                <div className="coverage-available-contracts-label">contracts</div>
                <div className="coverage-available-shares-line" title="Share qty (100 sh per contract)">
                  {ci.held_shares} sh
                </div>
              </td>
            ))}
          {!slim && !backingLayout && (
            <td>
              {ci.required_shares}
              {ci.instances_needing > 1 && (
                <span className="coverage-shared-hint"> ({ci.instances_needing} strat.)</span>
              )}
            </td>
          )}
          {!slim && !backingSlim && (
            <td>
              <span className={ci.surplus_or_gap >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                {fmtSurplusShares(ci.surplus_or_gap)}
              </span>
            </td>
          )}
          {!slim && !backingSlim && <td>{optionSupportLabel}</td>}
          {slim || backingLayout ? (
            <td className="coverage-cost-avg-cell" title="Cost basis (total) / avg cost per share">
              <div className="coverage-cost-avg-basis">{fmtUsd(ci.cost_basis_total)}</div>
              <div className="coverage-cost-avg-per-share">{fmtUsd(ci.avg_cost_per_share)}</div>
            </td>
          ) : (
            <>
              <td>{fmtUsd(ci.cost_basis_total)}</td>
              <td>{fmtUsd(ci.avg_cost_per_share)}</td>
            </>
          )}
          {slim || backingLayout ? (
            <td
              className="coverage-mkt-value-price-cell"
              title="Position market value (held × last) / price per share"
            >
              <div className="coverage-mkt-value-total">{fmtUsd(coverageRowMarketValueTotal(ci))}</div>
              <div className="coverage-mkt-value-per-share">{fmtUsd(ci.live_last_price)}</div>
            </td>
          ) : (
            <td>{fmtUsd(ci.live_last_price)}</td>
          )}
          {slim || backingLayout ? (
            <td className="coverage-pnl-stacked-cell">
              <div className={((ci.daily_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                {fmtUsd(ci.daily_pnl)}
              </div>
              <div className={`coverage-pnl-stacked-pct ${((ci.daily_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}`}>
                {fmtSignedPct(ci.daily_pct)}
              </div>
            </td>
          ) : (
            <td>
              <span className={((ci.daily_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                {fmtUsd(ci.daily_pnl)}
              </span>
              {' / '}
              <span className={((ci.daily_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                {fmtSignedPct(ci.daily_pct)}
              </span>
            </td>
          )}
          {slim || backingLayout ? (
            <td className="coverage-pnl-stacked-cell">
              <div className={((ci.total_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                {fmtUsd(ci.total_pnl)}
              </div>
              <div className={`coverage-pnl-stacked-pct ${((ci.total_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}`}>
                {fmtSignedPct(ci.total_pct)}
              </div>
            </td>
          ) : (
            <td>
              <span className={((ci.total_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                {fmtUsd(ci.total_pnl)}
              </span>
              {' / '}
              <span className={((ci.total_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                {fmtSignedPct(ci.total_pct)}
              </span>
            </td>
          )}
          {!slim && !backingSlim && (
            <td>
              <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
            </td>
          )}
        </tr>
      )
    }
    return (
    <div className="replay-portfolio-table-wrap">
      <table
        className={`table-operations instance-sheet-sub-table coverage-summary-table${poolSortOn ? ' coverage-underlying-pool-sortable' : ''}`}
      >
        <thead>
          <tr>
            {slim || backingLayout ? sortTh('Symbol', 'symbol') : <th>Symbol</th>}
            {!poolGroupByAccount && <th>Account</th>}
            {!hideBacked && <th>Backed opportunities</th>}
            {showHeldColumn &&
              (slim ? sortTh('Held', 'held', 'Long share qty (whole shares).') : <th>Held</th>)}
            {showHeldAmtColumn &&
              (backingLayout ? (
                sortTh(
                  <span className="coverage-pool-th-backed-amt">
                    Backed
                    <br />
                    Amt
                  </span>,
                  'backed_amt',
                  'Contracts backing watchlist hedge: min(held, required) ÷ 100.',
                )
              ) : slim && poolSortOn ? (
                sortTh(
                  <span className="coverage-pool-th-held-amt">
                    Held
                    <br />
                    Amt
                  </span>,
                  'held_amt',
                  'Contracts ≈ max(0, long shares) ÷ 100.',
                )
              ) : slim ? (
                <th title="Contracts ≈ max(0, long shares) ÷ 100.">
                  <span className="coverage-pool-th-held-amt">Held<br />Amt</span>
                </th>
              ) : (
                <th title="Option contracts ≈ max(0, long shares) ÷ 100.">Available Held Amt</th>
              ))}
            {!slim && !backingLayout && <th>Required</th>}
            {!slim && !backingSlim && <th>Surplus / Gap</th>}
            {!slim && !backingSlim && <th>Option support</th>}
            {slim || backingLayout ? (
              sortTh(
                'Basis / Avg',
                'cost_basis',
                'Total cost basis (top) and average cost per share (bottom).',
              )
            ) : (
              <>
                <th>Cost basis</th>
                <th>Avg cost</th>
              </>
            )}
            {backingLayout ? (
              sortTh(
                'Mkt / Price',
                'market_price',
                'Market value (held × last) / share price. Sort by value.',
              )
            ) : slim ? (
              sortTh(
                'Mkt value / Price',
                'market_price',
                'Total market value (held × last) and price per share. Sort by total value.',
              )
            ) : (
              <th>Live last</th>
            )}
            {slim || backingLayout ? <th className="coverage-pnl-stacked-th">Daily</th> : <th>Daily ($ / %)</th>}
            {slim || backingLayout ? <th className="coverage-pnl-stacked-th">Total</th> : <th>Total ($ / %)</th>}
            {!slim && !backingSlim && <th>Status</th>}
          </tr>
        </thead>
        <tbody>
          {accountGroups
            ? accountGroups.map(({ accountId, items }) => (
                <Fragment key={`${keyPrefix}-acc-${accountId}`}>
                  <tr className="coverage-pool-account-group-row">
                    <td
                      colSpan={accountGroupColSpan}
                      className={accountCellClass(accountId)}
                      title="Host vs Secondary use Settings → Stream host / secondary account IDs."
                    >
                      {accountId}
                    </td>
                  </tr>
                  {items.map(ci =>
                    renderCoverageDataRow(ci, `${keyPrefix}-${accountId}-${ci.symbol}`),
                  )}
                </Fragment>
              ))
            : rows.map(ci =>
                renderCoverageDataRow(ci, `${keyPrefix}-${ci.symbol}-${ci.account_id || '—'}`),
              )}
        </tbody>
      </table>
    </div>
    )
  }

  const openPositionsTabHint = (tab: OpenPositionsTab): string => {
    if (tab === 'instance') {
      return `Grouped by strategy (opportunity). Detail view ${openAccordionMode ? 'Accordion' : 'Multi'}: ${openAccordionMode ? 'only one strategy row expanded at a time' : 'several strategy rows may stay open'}.`
    }
    if (tab === 'options') {
      return `By contract; expand for executions. Same Detail view mode (${openAccordionMode ? 'Accordion' : 'Multi'}) controls how many contract rows show execution detail.`
    }
    return 'Open positions from account snapshots (Live only). Tag stock fills with strategy from Ledger / Executions if needed.'
  }

  const renderLiveStockBucketPanel = (
    panelId: string,
    tabButtonId: string,
    heading: string,
    rows: LivePositionRow[],
    rowKeyPrefix: string,
    emptyHint: string,
  ) => (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabButtonId}
      className="system-tab-panel"
    >
      <h5 className="replay-sub">{heading}</h5>
      {rows.length === 0 ? (
        <p className="section-hint">{emptyHint}</p>
      ) : (
        <div className="replay-portfolio-table-wrap">
          <table className="table-operations">
            <thead>
              <tr>
                <th>Account</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Avg Cost</th>
                <th>Last</th>
                <th>Market Value</th>
                <th className="coverage-pnl-stacked-th">Daily $/&nbsp;%</th>
                <th className="coverage-pnl-stacked-th">Since $/&nbsp;%</th>
              </tr>
            </thead>
            <tbody>{buildOpenStockPositionRows(rows, rowKeyPrefix)}</tbody>
          </table>
        </div>
      )}
    </div>
  )

  return (
    <div className="card process-section replay-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Positions'}
          <InfoTooltip text="Open positions (Pool On and Off) and manual execution records." />
        </h2>
      </div>

      <section className="replay-section replay-section-trade-records" aria-label="Open positions">
          <div className="replay-toolbar">
            <div className="replay-fetch-range-group" aria-label="Position filters">
              <input
                type="text"
                placeholder="Symbol"
                value={openFilterSymbol}
                onChange={e => setOpenFilterSymbol(e.target.value)}
                className="replay-filter-input replay-filter-input-symbol"
              />
              <label className="replay-filter-label-month">
                <span className="replay-filter-label">Exp</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYYMMDD"
                  value={openFilterExpiryStart}
                  onChange={e => setOpenFilterExpiryStart(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="replay-filter-input replay-filter-date"
                  title="Option expiry: YYYYMMDD digits; shorter prefix also matches (e.g. 202503)"
                  maxLength={8}
                  aria-label="Filter by option expiry YYYYMMDD"
                />
              </label>
            </div>
            <div className="ib-accounts-tabs ib-accounts-tabs--open-filter">
              <button
                type="button"
                className={`ib-accounts-tab ${openFilterAccountId === 'all' ? 'active' : ''}`}
                onClick={() => setOpenFilterAccountId('all')}
                title="All accounts"
              >
                All
              </button>
              {openFilterAccountTabs.map(({ accountId, displayLabel }) => (
                <button
                  key={accountId}
                  type="button"
                  className={`ib-accounts-tab ${openFilterAccountId === accountId ? 'active' : ''}`}
                  onClick={() => setOpenFilterAccountId(accountId)}
                  title={displayLabel}
                >
                  {displayLabel}
                </button>
              ))}
            </div>
            <div
              className="replay-fetch-range-group"
              role="radiogroup"
              aria-label="Detail view: accordion for Strategy rows and option execution rows"
            >
              <span className="replay-fetch-days-label">Detail view</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="accordion" checked={openAccordionMode} onChange={() => setOpenAccordionMode(true)} />
                <span>Accordion</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="multi" checked={!openAccordionMode} onChange={() => setOpenAccordionMode(false)} />
                <span>Multi</span>
              </label>
            </div>
          </div>
          {optionsTabPositions.length === 0 && liveStockPositions.length === 0 ? (
            <p className="section-hint">No open positions under the current filters. Position data comes from account snapshots in `Accounts`, while Off-Track options are inferred from execution history.</p>
          ) : (
            <div className="replay-portfolio-block">
              <div className="replay-portfolio-header">
                <div className="replay-portfolio-tabs-wrap">
                  <div className="replay-ledger-tab-matrix replay-ledger-tab-matrix--aligned replay-ledger-tab-matrix--open-positions">
                    <div className="replay-ledger-tab-matrix-labels" aria-hidden="true">
                      <span className="replay-ledger-tab-group-caption replay-ledger-tab-group-caption--positions-attr">
                        Attribution
                      </span>
                      <span className="replay-ledger-tab-group-caption replay-ledger-tab-group-caption--positions-inst">
                        Instruments
                      </span>
                    </div>
                    <div
                      className="system-tabs replay-portfolio-tabs replay-ledger-tab-button-row"
                      role="tablist"
                      aria-label="Open positions: attribution and instruments"
                    >
                      <button
                        type="button"
                        role="tab"
                        id="open-tab-strategy"
                        aria-selected={openTab === 'instance'}
                        aria-controls="open-panel-strategy"
                        className={`system-tab ${openTab === 'instance' ? 'active' : ''}`}
                        onClick={() => setOpenTab('instance')}
                        disabled={!hasInstances}
                      >
                        Strategy
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="open-tab-options"
                        aria-selected={openTab === 'options'}
                        aria-controls="open-panel-options"
                        className={`system-tab replay-ledger-tab-at-instruments ${openTab === 'options' ? 'active' : ''}`}
                        onClick={() => setOpenTab('options')}
                        disabled={!hasOpenOptions}
                      >
                        Options
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="open-tab-stocks"
                        aria-selected={openTab === 'stocks'}
                        aria-controls="open-panel-stocks"
                        className={`system-tab ${openTab === 'stocks' ? 'active' : ''}`}
                        onClick={() => setOpenTab('stocks')}
                        disabled={!hasCoreStocks}
                      >
                        Stocks
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="open-tab-fixed-income"
                        aria-selected={openTab === 'fixed_income'}
                        aria-controls="open-panel-fixed-income"
                        className={`system-tab ${openTab === 'fixed_income' ? 'active' : ''}`}
                        onClick={() => setOpenTab('fixed_income')}
                        disabled={!hasFixedIncomeStocks}
                      >
                        Fixed income
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="open-tab-cash-like"
                        aria-selected={openTab === 'cash_like'}
                        aria-controls="open-panel-cash-like"
                        className={`system-tab ${openTab === 'cash_like' ? 'active' : ''}`}
                        onClick={() => setOpenTab('cash_like')}
                        disabled={!hasCashLikeStocks}
                      >
                        Cash-like
                      </button>
                    </div>
                  </div>
                  <p className="section-hint replay-portfolio-tab-hint">
                    {openPositionsTabHint(openTab)}
                  </p>
                </div>
              </div>
              {openTab === 'instance' ? (
                <div
                  id="open-panel-strategy"
                  role="tabpanel"
                  aria-labelledby="open-tab-strategy"
                  className="system-tab-panel"
                >
                  <div className="instance-sheet-filters">
                    <select
                      className="replay-filter-select"
                      value={instanceFilterStructureType}
                      onChange={e => setInstanceFilterStructureType(e.target.value)}
                      aria-label="Filter by contract type"
                    >
                      <option value="all">All Contract Types</option>
                      {instanceFilterOptions.structureTypes.map(st => (
                        <option key={st} value={st}>{st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                      ))}
                    </select>
                    <select
                      className="replay-filter-select"
                      value={instanceFilterOppName}
                      onChange={e => setInstanceFilterOppName(e.target.value)}
                      aria-label="Filter by opportunity"
                    >
                      <option value="all">All Opportunities</option>
                      {instanceFilterOptions.oppNames.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <div className="instance-sheet-filter-bubble-row">
                      <span className="instance-sheet-filter-bubble-label" id="instance-filter-scope-label">
                        Symbol scope
                      </span>
                      <div
                        className="replay-bubble-switch instance-sheet-bubble-switch--wrap"
                        role="radiogroup"
                        aria-labelledby="instance-filter-scope-label"
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={instanceFilterScopeType === 'all'}
                          className={`replay-bubble-switch-btn ${instanceFilterScopeType === 'all' ? 'active' : ''}`}
                          onClick={() => setInstanceFilterScopeType('all')}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={instanceFilterScopeType === '__none__'}
                          className={`replay-bubble-switch-btn ${instanceFilterScopeType === '__none__' ? 'active' : ''}`}
                          onClick={() => setInstanceFilterScopeType('__none__')}
                        >
                          None
                        </button>
                        {instanceFilterOptions.scopeTypes.filter(s => s !== '').map(s => (
                          <button
                            key={s}
                            type="button"
                            role="radio"
                            aria-checked={instanceFilterScopeType === s}
                            className={`replay-bubble-switch-btn ${instanceFilterScopeType === s ? 'active' : ''}`}
                            onClick={() => setInstanceFilterScopeType(s)}
                          >
                            {s === 'watchlist_stk' ? 'Watchlist (stocks)' : s === 'explicit_symbols' ? 'Explicit symbols' : s}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="instance-sheet-filter-bubble-row">
                      <span className="instance-sheet-filter-bubble-label" id="instance-filter-attr-label">
                        Attribution
                      </span>
                      <div
                        className="replay-bubble-switch"
                        role="radiogroup"
                        aria-labelledby="instance-filter-attr-label"
                      >
                        {(['all', 'single', 'mixed', 'unassigned'] as const).map(v => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={instanceFilterAttributionType === v}
                            className={`replay-bubble-switch-btn ${instanceFilterAttributionType === v ? 'active' : ''}`}
                            onClick={() => setInstanceFilterAttributionType(v)}
                          >
                            {v === 'all' ? 'All' : v === 'single' ? 'Single' : v === 'mixed' ? 'Mixed' : 'Unassigned'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {(instanceFilterStructureType !== 'all' || instanceFilterScopeType !== 'all' || instanceFilterOppName !== 'all' || instanceFilterAttributionType !== 'all') && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => { setInstanceFilterStructureType('all'); setInstanceFilterScopeType('all'); setInstanceFilterOppName('all'); setInstanceFilterAttributionType('all') }}
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>
                  {sortedInstanceAllGroups.length === 0 ? (
                    <p className="section-hint">No strategies match the current filters.</p>
                  ) : (
                    <div className="replay-portfolio-table-wrap">
                      <table className="table-operations instance-sheet-table">
                        <thead>
                          <tr>
                            <th className="replay-opt-expand-col" />
                            <th title="Opportunity">Opp</th>
                            <th>Contract Type</th>
                            <th>Symbols</th>
                            <th>Opened</th>
                            <th title="Per option: execution quantities (comma-separated). Uses Final book only when at least one matching Final exists; otherwise TWS. Multiple option lines separated by |.">
                              Exec Qty
                            </th>
                            <th>Underlying</th>
                            <th>Opt PNL</th>
                            <th>Max Gain</th>
                            <th>Max Loss</th>
                            <th>Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedInstanceAllGroups.map(allGroup => {
                            const instKey = allGroup.strategy_instance_id != null ? String(allGroup.strategy_instance_id) : '__unassigned__'
                            const instLabel = allGroup.strategy_instance_label ?? (allGroup.strategy_instance_id != null ? `Strategy #${allGroup.strategy_instance_id}` : 'Uncategorized')
                            const oppName = allGroup.strategy_opportunity_name?.trim() || null
                            const openedAt = allGroup.strategy_instance_opened_at_epoch
                            const optN = allGroup.options.length
                            const optExecQtySummary = formatInstanceOptExecQtyCell(allGroup)
                            const covN = allGroup.stock_coverage.length
                            const isExpanded = expandedInstanceKeys.includes(instKey)
                            const structLabel = allGroup.structure_type
                              ? allGroup.structure_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                              : '—'
                            const structBadgeClass = allGroup.structure_type
                              ? `instance-sheet-badge instance-sheet-badge-${allGroup.structure_type.replace(/_/g, '-')}`
                              : 'instance-sheet-badge'
                            const opp = allGroup.strategy_opportunity_id != null ? oppMap.get(allGroup.strategy_opportunity_id) : undefined
                            const scopeSymbols = opp?.symbols ?? []
                            const scopeType = allGroup.scope_type
                            const symbolsCell = scopeType === 'watchlist_stk'
                              ? <span className="instance-sheet-badge instance-sheet-badge-scope">Watchlist</span>
                              : scopeSymbols.length > 0
                                ? <span className="instance-sheet-symbols">{scopeSymbols.join(', ')}</span>
                                : <span className="replay-muted">—</span>
                            return [
                              <tr
                                key={`inst-row-${instKey}`}
                                className={`instance-sheet-row ${isExpanded ? 'instance-sheet-row-expanded' : ''}`}
                                onClick={() => toggleInstanceExpand(instKey)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleInstanceExpand(instKey) } }}
                                aria-expanded={isExpanded}
                              >
                                <td className="replay-opt-expand-col">
                                  <span className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`} aria-hidden>
                                    {isExpanded ? '▼' : '▶'}
                                  </span>
                                </td>
                                <td className="instance-sheet-opp-cell">
                                  {allGroup.strategy_instance_id != null ? (
                                    <>
                                      {oppName ? (
                                        <span className="instance-sheet-opp-name">{oppName}</span>
                                      ) : null}
                                      <a
                                        href={`#/strategies/instances/${allGroup.strategy_instance_id}`}
                                        className="instance-sheet-inst-link instance-sheet-inst-sublabel"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={`View strategy: ${instLabel}`}
                                        onClick={e => e.stopPropagation()}
                                      >
                                        {instLabel}
                                      </a>
                                    </>
                                  ) : (
                                    <span>{oppName || instLabel}</span>
                                  )}
                                </td>
                                <td><span className={structBadgeClass}>{structLabel}</span></td>
                                <td>{symbolsCell}</td>
                                <td>
                                  {openedAt != null && Number.isFinite(openedAt) ? (
                                    <>{fmtDate(openedAt)}{fmtDaysAgo(openedAt) ? <span className="replay-time-ago"> {fmtDaysAgo(openedAt)}</span> : null}</>
                                  ) : '—'}
                                </td>
                                <td
                                  className="instance-sheet-exec-qty-cell"
                                  title="Per option: execution quantities (comma-separated). Final preferred over TWS when matching Finals exist. | separates option lines."
                                >
                                  {optN > 0 ? optExecQtySummary : '—'}
                                </td>
                                <td>
                                  {covN > 0 ? (() => {
                                    let allCovered = true
                                    let anyNaked = false
                                    for (const sc of allGroup.stock_coverage) {
                                      const hp = liveStockPositions.find(
                                        s =>
                                          (s.symbol ?? '').toUpperCase() === (sc.symbol ?? '').toUpperCase() &&
                                          (s.account_id ?? '').trim() === (sc.account_id ?? '').trim(),
                                      )
                                      const held = hp ? Math.abs(Number(hp.position) || 0) : 0
                                      if (held >= sc.required_shares) continue
                                      allCovered = false
                                      if (held === 0) anyNaked = true
                                    }
                                    const statusClass = allCovered
                                      ? 'coverage-status-covered'
                                      : anyNaked
                                        ? 'coverage-status-naked'
                                        : 'coverage-status-partial'
                                    const statusLabel = allCovered ? 'Covered' : anyNaked ? 'Naked' : 'Partial'
                                    return <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
                                  })() : <span className="replay-muted">—</span>}
                                </td>
                                <td>{optN > 0 ? <span className="replay-pnl-unrealized">{fmtUsd(allGroup.options_unrealized_pnl)}</span> : <span className="replay-muted">—</span>}</td>
                                {(() => {
                                  if (!allGroup.risk_profile) return <><td className="replay-muted">—</td><td className="replay-muted">—</td><td className="replay-muted">—</td></>
                                  const rl = formatRiskLabel(allGroup.risk_profile)
                                  return <>
                                    <td><span className="risk-value-gain">{rl.gainLabel}</span></td>
                                    <td><span className={allGroup.risk_profile.max_loss == null ? 'risk-value-loss risk-value-unlimited' : 'risk-value-loss'}>{rl.lossLabel}</span></td>
                                    <td><span className={`coverage-status-badge ${allGroup.risk_profile.risk_type === 'defined' ? 'risk-badge-defined' : 'risk-badge-unlimited'}`}>{rl.riskBadge}</span></td>
                                  </>
                                })()}
                              </tr>,
                              ...(isExpanded ? [
                                <tr key={`inst-detail-${instKey}`} className="instance-sheet-detail-row">
                                  <td colSpan={11} className="instance-sheet-detail-cell">
                                    {optN > 0 && (
                                      <div className="instance-sheet-sub-section">
                                        <h6 className="replay-sub instance-sheet-sub-heading">Options ({optN})</h6>
                                        <div className="replay-portfolio-table-wrap">
                                          <table className="table-operations replay-opt-groups instance-sheet-sub-table positions-opt-instance-table">
                                            <colgroup>
                                              <col className="poi-col-expand" />
                                              <col className="poi-col-contract" />
                                              <col className="poi-col-expiry" />
                                              <col className="poi-col-strike" />
                                              <col className="poi-col-last" />
                                              <col className="poi-col-qty" />
                                              <col className="poi-col-at" />
                                              <col className="poi-col-value" />
                                              <col className="poi-col-quote" />
                                              <col className="poi-col-time" />
                                              <col className="poi-col-unpnl" />
                                              <col className="poi-col-pool" />
                                              <col className="poi-col-attr" />
                                              <col className="poi-col-account" />
                                              <col className="poi-col-opp" />
                                              <col className="poi-col-actions" />
                                            </colgroup>
                                            <thead>
                                              <tr>
                                                <th className="replay-opt-expand-col" />
                                                <th>Contract</th>
                                                <th>Expiry</th>
                                                <th>Strike</th>
                                                <th>Last</th>
                                                <th>Qty</th>
                                                <th>@</th>
                                                <th>Value</th>
                                                <th title="Option live bid / mid / ask">Opt Quote</th>
                                                <th>Time</th>
                                                <th>UN PNL</th>
                                                <th>Pool</th>
                                                <th>Attr</th>
                                                <th>Account</th>
                                                <th title="Opportunity">Opp</th>
                                                <th className="replay-opt-actions-cell">Actions</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {allGroup.options.map((pos) => {
                                                const posKey = `ia-${instKey}-${getPositionKey(pos, allGroup.strategy_instance_id)}`
                                                const absQty = Math.abs(pos.qty)
                                                const sideLabel = pos.qty > 0 ? 'Long' : pos.qty < 0 ? 'Short' : '—'
                                                const value = (pos.avg_cost ?? 0) * absQty * 100
                                                const ts = getPositionTime(pos)
                                                const execLists = getPositionExecLists(pos)
                                                const execMatchesInstance = (ex: Execution) => {
                                                  if (pos.filtered_exec_lists) return true
                                                  return executionMatchesInstanceGroup(
                                                    ex,
                                                    allGroup.strategy_instance_id,
                                                    allGroup.strategy_opportunity_id,
                                                  )
                                                }
                                                const scopedFinalExecs = execLists.final.filter(execMatchesInstance)
                                                const scopedTwsExecs = execLists.tws.filter(execMatchesInstance)
                                                const execCount = scopedFinalExecs.length + scopedTwsExecs.length
                                                const hasExecutions = execCount > 0
                                                const isPosExpanded = expandedPositionKeys.includes(posKey)
                                                return [
                                                  <tr
                                                    key={posKey}
                                                    className="detail-position-row"
                                                    onClick={hasExecutions ? (e) => { e.stopPropagation(); togglePositionExpand(posKey) } : undefined}
                                                    role={hasExecutions ? 'button' : undefined}
                                                    tabIndex={hasExecutions ? 0 : undefined}
                                                    onKeyDown={hasExecutions ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePositionExpand(posKey) } } : undefined}
                                                    aria-expanded={hasExecutions ? isPosExpanded : undefined}
                                                  >
                                                    <td className="replay-opt-expand-col">
                                                      {hasExecutions ? (
                                                        <span className={`replay-opt-expand-icon ${isPosExpanded ? 'expanded' : ''}`} aria-hidden>
                                                          {isPosExpanded ? '▼' : '▶'}
                                                        </span>
                                                      ) : null}
                                                    </td>
                                                    <td className="replay-opt-contract">
                                                      {(() => {
                                                        const p = getContractLabelParts(pos.contract_key)
                                                        const strikeStr = pos.strike != null ? ` ${pos.strike}` : ''
                                                        return p.symbol ? (<><strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}</>) : pos.contract_key
                                                      })()}
                                                    </td>
                                                    <td className="positions-opt-expiry-cell">
                                                      <div className="positions-opt-expiry-line1">{fmtExpiry(pos.expiry)}</div>
                                                      {(() => {
                                                        const days = daysUntilExpiry(pos.expiry)
                                                        if (days == null) return null
                                                        const label = days >= 0 ? (days === 0 ? 'today' : `${days}d`) : `${-days}d ago`
                                                        return (
                                                          <div className="positions-opt-expiry-line2">
                                                            <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>{label}</span>
                                                          </div>
                                                        )
                                                      })()}
                                                    </td>
                                                    <td><strong>{fmtUsd(pos.strike)}</strong></td>
                                                    <td className="positions-opt-last-cell">
                                                      {(() => {
                                                        const underlying = getContractLabelParts(pos.contract_key).symbol
                                                        const q = underlying ? quotesMap[underlying] : undefined
                                                        const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                                        const strikeNum = pos.strike != null && Number.isFinite(pos.strike) ? pos.strike : null
                                                        const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                                                        const right = parseOptionContractKey(pos.contract_key).right
                                                        const side: 'Buy' | 'Sell' = pos.qty > 0 ? 'Buy' : 'Sell'
                                                        const pctClass = pct != null ? optionLastStrikePctClass(right, side, pct) : ''
                                                        return (
                                                          <>
                                                            <div className="positions-opt-last-line1">{last != null ? fmtUsd(last) : '—'}</div>
                                                            {pct != null ? (
                                                              <div className="positions-opt-last-line2">
                                                                <span className={`replay-last-strike-pct ${pctClass}`.trim()} title={`(Last − Strike) / Last = ${pct.toFixed(2)}%`}>
                                                                  {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                                                                </span>
                                                              </div>
                                                            ) : null}
                                                          </>
                                                        )
                                                      })()}
                                                    </td>
                                                    <td>{sideLabel} {absQty}</td>
                                                    <td>{fmtUsd(pos.avg_cost)}</td>
                                                    <td>{fmtUsd(value)}</td>
                                                    <td className="positions-opt-live-quote">
                                                      {(() => {
                                                        const liveQ = quotesMap[pos.contract_key]
                                                        if (!liveQ) return <span className="replay-muted">—</span>
                                                        const mid = liveQ.mid ?? (liveQ.bid != null && liveQ.ask != null ? (liveQ.bid + liveQ.ask) / 2 : null)
                                                        return (
                                                          <>
                                                            <div className="positions-opt-quote-line positions-opt-quote-line--bid">
                                                              {liveQ.bid != null ? <span className="positions-opt-quote-bid">{liveQ.bid.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                                                            </div>
                                                            <div className="positions-opt-quote-line positions-opt-quote-line--mid">
                                                              <strong>{mid != null ? mid.toFixed(2) : '—'}</strong>
                                                            </div>
                                                            <div className="positions-opt-quote-line positions-opt-quote-line--ask">
                                                              {liveQ.ask != null ? <span className="positions-opt-quote-ask">{liveQ.ask.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                                                            </div>
                                                          </>
                                                        )
                                                      })()}
                                                    </td>
                                                    <td className="positions-opt-time-cell">
                                                      {ts != null ? (
                                                        <>
                                                          <div className="positions-opt-time-line1">{fmtDate(ts)}</div>
                                                          {fmtDaysAgo(ts) ? <div className="positions-opt-time-line2"><span className="replay-time-ago">{fmtDaysAgo(ts)}</span></div> : null}
                                                        </>
                                                      ) : '—'}
                                                    </td>
                                                    <td>
                                                      {(() => {
                                                        const liveQ = quotesMap[pos.contract_key]
                                                        const liveMid = liveQ?.mid ?? (liveQ?.bid != null && liveQ?.ask != null ? (liveQ.bid + liveQ.ask) / 2 : null)
                                                        const livePnl = liveMid != null && pos.avg_cost != null
                                                          ? (liveMid - pos.avg_cost) * absQty * 100 : null
                                                        return (
                                                          <>
                                                            {livePnl != null && (
                                                              <div>
                                                                <span className={`replay-pnl-unrealized ${livePnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(livePnl)}</span>
                                                                <span className="replay-muted" style={{fontSize:'0.7em'}}> live</span>
                                                              </div>
                                                            )}
                                                            <div className={livePnl != null ? 'replay-muted' : undefined} style={livePnl != null ? {fontSize:'0.75em'} : undefined}>
                                                              <span className={`replay-pnl-unrealized ${pos.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(pos.unrealized_pnl)}</span>
                                                              {livePnl != null && <span style={{fontSize:'0.7em'}}> snap</span>}
                                                            </div>
                                                          </>
                                                        )
                                                      })()}
                                                    </td>
                                                    <td className="replay-muted">{pos.pool_label}</td>
                                                    <td>
                                                      {pos.filtered_exec_lists ? (
                                                        <span
                                                          className="attr-badge attr-unassigned"
                                                          title="Fills that do not match the instance row for this contract (Uncategorized)"
                                                        >
                                                          Uncategorized
                                                        </span>
                                                      ) : pos.attribution_type === 'mixed' ? (
                                                        <span className="attr-badge attr-mixed" title={`Estimated attribution (net): ${((pos.attribution_ratio ?? 0) * 100).toFixed(0)}%`}>Mixed</span>
                                                      ) : pos.attribution_type === 'single' ? (
                                                        <span className="attr-badge attr-single" title="Single instance attribution">Single</span>
                                                      ) : (
                                                        <span className="attr-badge attr-unassigned" title="No strategy attribution">—</span>
                                                      )}
                                                    </td>
                                                    <td className="positions-opt-account-cell">{pos.account_id || '—'}</td>
                                                    <td className="replay-strategy-opp-cell positions-opt-opp-hint-cell">
                                                      {execCount === 0 ? '—' : (
                                                        <span className="replay-muted" title={`${execCount} execution${execCount > 1 ? 's' : ''} — expand row`}>
                                                          {pos.filtered_exec_lists ? (
                                                            <abbr title="Uncategorized fills">Unct.</abbr>
                                                          ) : null}
                                                          {pos.filtered_exec_lists ? ' · ' : null}
                                                          {execCount} exec{execCount > 1 ? 's' : ''} ↓
                                                        </span>
                                                      )}
                                                    </td>
                                                    <td className="replay-opt-actions-cell">—</td>
                                                  </tr>,
                                                  ...(isPosExpanded ? [
                                                    ...scopedFinalExecs.map((ex, ei) =>
                                                      renderOpenOptionExecutionRow(
                                                        pos,
                                                        posKey,
                                                        ex,
                                                        ei,
                                                        'final',
                                                        scopedFinalExecs,
                                                        scopedTwsExecs,
                                                        true,
                                                      ),
                                                    ),
                                                    ...scopedTwsExecs.map((ex, ei) =>
                                                      renderOpenOptionExecutionRow(
                                                        pos,
                                                        posKey,
                                                        ex,
                                                        ei,
                                                        'tws',
                                                        scopedFinalExecs,
                                                        scopedTwsExecs,
                                                        true,
                                                      ),
                                                    ),
                                                  ] : []),
                                                ]
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    )}
                                    {covN > 0 && (
                                      <div className="instance-sheet-sub-section">
                                        <h6 className="replay-sub instance-sheet-sub-heading">Underlying Coverage</h6>
                                        <div className="replay-portfolio-table-wrap">
                                          <table className="table-operations instance-sheet-sub-table">
                                            <thead>
                                              <tr>
                                                <th>Symbol</th>
                                                <th>Account</th>
                                                <th>Cost basis</th>
                                                <th>Avg cost</th>
                                                <th>Live last</th>
                                                <th>Daily ($ / %)</th>
                                                <th>Total ($ / %)</th>
                                                <th>Direction</th>
                                                <th>Required</th>
                                                <th>Held</th>
                                                <th>Status</th>
                                                <th>Surplus / Gap</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {allGroup.stock_coverage.map(sc => {
                                                const acct = (sc.account_id ?? '').trim()
                                                const m = underlyingCoverageStockMetrics(liveStockPositions, sc.symbol, acct)
                                                const held = m.held
                                                const gap = held - sc.required_shares
                                                const statusLabel =
                                                  held >= sc.required_shares
                                                    ? 'Fully Covered'
                                                    : held > 0
                                                      ? `Partial (${held}/${sc.required_shares})`
                                                      : 'Naked'
                                                const statusClass =
                                                  held >= sc.required_shares
                                                    ? 'coverage-status-covered'
                                                    : held > 0
                                                      ? 'coverage-status-partial'
                                                      : 'coverage-status-naked'
                                                const hasStock = m.held !== 0 || m.cost_basis_total != null
                                                return (
                                                  <tr key={`ia-cov-${instKey}-${sc.symbol}-${acct || 'x'}`}>
                                                    <td><strong>{sc.symbol}</strong></td>
                                                    <td>
                                                      <span className="underlying-coverage-account" title="Stock hedge must be in this account (same as options above)">
                                                        {acct || '—'}
                                                      </span>
                                                    </td>
                                                    <td>{fmtUsd(m.cost_basis_total)}</td>
                                                    <td>{fmtUsd(m.avg_cost_per_share)}</td>
                                                    <td>{fmtUsd(m.live_last_price)}</td>
                                                    <td>
                                                      {hasStock ? (
                                                        <>
                                                          <span className={((m.daily_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtUsd(m.daily_pnl)}
                                                          </span>
                                                          {' / '}
                                                          <span className={((m.daily_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtSignedPct(m.daily_pct)}
                                                          </span>
                                                        </>
                                                      ) : (
                                                        '—'
                                                      )}
                                                    </td>
                                                    <td>
                                                      {hasStock ? (
                                                        <>
                                                          <span className={((m.total_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtUsd(m.total_pnl)}
                                                          </span>
                                                          {' / '}
                                                          <span className={((m.total_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtSignedPct(m.total_pct)}
                                                          </span>
                                                        </>
                                                      ) : (
                                                        '—'
                                                      )}
                                                    </td>
                                                    <td>{sc.direction === 'long' ? 'Long' : 'Short'}</td>
                                                    <td>{sc.required_shares}</td>
                                                    <td>{held}</td>
                                                    <td>
                                                      <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
                                                    </td>
                                                    <td><span className={gap >= 0 ? 'pnl-positive' : 'pnl-negative'}>{fmtSurplusShares(gap)}</span></td>
                                                  </tr>
                                                )
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    )}
                                    {allGroup.risk_profile && (
                                      <div className="instance-sheet-sub-section risk-profile-section">
                                        <h6 className="replay-sub instance-sheet-sub-heading">Risk Profile</h6>
                                        <RiskProfileDl profile={allGroup.risk_profile} fmtUsd={fmtUsd} />
                                        {allGroup.risk_profile.naked_short_call_contracts > 0 && (
                                          <ul className="risk-hedged-breakdown" style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                                            {formatRiskHedgedBreakdown(allGroup.risk_profile).map((line, i) => (
                                              <li key={i} className="risk-unlimited-warning">{line}</li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>,
                              ] : []),
                            ]
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="replay-opt-tfoot-total">
                            <td colSpan={7} className="replay-opt-tfoot-label">
                              Total ({sortedInstanceAllGroups.length}{' '}
                              {sortedInstanceAllGroups.length !== 1 ? 'strategies' : 'strategy'})
                            </td>
                            <td>
                              <strong>
                                <span className="replay-pnl-unrealized">
                                  {fmtUsd(sortedInstanceAllGroups.reduce((acc, g) => acc + g.options_unrealized_pnl, 0))}
                                </span>
                              </strong>
                            </td>
                            <td colSpan={3} className="replay-muted">
                              —
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                  {sortedInstanceAllGroups.length > 0 ? (
                  <div className="coverage-summary-section">
                      <div className="coverage-summary-intro">
                        <h6 className="replay-sub instance-sheet-sub-heading coverage-summary-heading-row">
                          Coverage summary
                          <InfoTooltip text="Asset mix and Backing pool coverage charts share the account filter in the charts block. Position pool tables below use the same filter. Optionable symbols only; Independent Holdings are not listed in pools. Underlying pool = stock left after opportunity hedges." />
                        </h6>
                      </div>
                      <div className="coverage-charts-section">
                        <div className="coverage-charts-toolbar">
                          <span className="coverage-charts-toolbar-label">Account</span>
                          <div
                            className="coverage-section-account-filter"
                            role="group"
                            aria-label="Account filter for asset mix and backing pool coverage"
                          >
                            {[
                              { id: 'all', label: 'All' },
                              ...(streamHostAccountId ? [{ id: streamHostAccountId, label: streamHostAccountId }] : []),
                              ...(streamSecondaryAccountId && streamSecondaryAccountId !== streamHostAccountId
                                ? [{ id: streamSecondaryAccountId, label: streamSecondaryAccountId }]
                                : []),
                            ].map(opt => (
                              <button
                                key={opt.id}
                                type="button"
                                className={`coverage-asset-pie-acct-btn${stockCoverageSectionAccount === opt.id ? ' active' : ''}`}
                                onClick={() => setStockCoverageSectionAccount(opt.id)}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="coverage-charts-grid">
                      {(() => {
                        const {
                          coreStockMV,
                          fixedIncomeMV,
                          cashLikeMV,
                          cash,
                          bp,
                          denom,
                          pStock,
                          pFixedIncome,
                          pCashLike,
                          pCash,
                          pBp,
                          netLiq,
                          includeBpInChart,
                          includeFiInChart,
                          includeCashLikeInChart,
                          simpleCenterPct,
                        } = coverageAssetPieData
                        const cx = 66
                        const cy = 66
                        const rO = 56
                        const rI = 36
                        const rMid = (rO + rI) / 2
                        const ringStroke = rO - rI
                        const circ = 2 * Math.PI * rMid
                        let ringOff = 0
                        const ringSeg = (frac: number, className: string, key: string) => {
                          const len = Math.max(0, frac) * circ
                          if (len < 0.5) return null
                          const el = (
                            <circle
                              key={key}
                              cx={cx}
                              cy={cy}
                              r={rMid}
                              fill="none"
                              className={className}
                              strokeWidth={ringStroke}
                              strokeLinecap="butt"
                              strokeDasharray={`${len} ${circ}`}
                              strokeDashoffset={-ringOff}
                              transform={`rotate(-90 ${cx} ${cy})`}
                            />
                          )
                          ringOff += len
                          return el
                        }
                        const centerMain =
                          netLiq != null
                            ? fmtUsd(netLiq)
                            : denom > 0
                              ? simpleCenterPct
                                ? `${(pStock * 100).toFixed(1)} · ${(pCash * 100).toFixed(1)}`
                                : fmtUsd(denom)
                              : '—'
                        const centerSub =
                          netLiq != null
                            ? 'Net liq.'
                            : denom > 0
                              ? simpleCenterPct
                                ? '% of sum'
                                : 'Chart basis'
                              : ''
                        const ringAriaParts = [
                          'Stock (core equities)',
                          includeFiInChart ? 'Fixed income' : null,
                          includeCashLikeInChart ? 'Cash-like' : null,
                          'Net cash',
                          includeBpInChart ? 'Buying power' : null,
                        ].filter(Boolean)
                        return (
                          <div className="coverage-charts-cell coverage-asset-pie-section">
                            <div className="coverage-asset-pie-header">
                              <span className="coverage-asset-pie-title">Asset mix</span>
                              <InfoTooltip text="Stock = market value of non-option positions classified as core equities (same as Stocks tab; excludes ledger Fixed income and Cash-like). Fixed income / Cash-like use position category labels. Net cash = IB TotalCashValue. Buying power = IB BuyingPower. Use Include to add a slice to the ring denominator; excluded categories stay in the legend. Center shows net liquidation when available; otherwise stock vs net cash percentages when only those two are in the ring, else the chart-basis total." />
                            </div>
                            <div className="coverage-asset-pie-body">
                              <div className="coverage-asset-pie-chart-block">
                                <svg
                                  width={132}
                                  height={132}
                                  viewBox="0 0 132 132"
                                  className="coverage-asset-pie-svg"
                                  role="img"
                                  aria-label={`Ring chart: ${ringAriaParts.join(', ')} as shares of their sum`}
                                >
                                  <circle
                                    cx={cx}
                                    cy={cy}
                                    r={rMid}
                                    fill="none"
                                    className="coverage-asset-pie-ring-track"
                                    strokeWidth={ringStroke}
                                  />
                                  {denom > 0 ? (
                                    <>
                                      {ringSeg(pStock, 'coverage-asset-pie-ring-seg-stock', 'seg-stock')}
                                      {includeFiInChart
                                        ? ringSeg(pFixedIncome, 'coverage-asset-pie-ring-seg-fi', 'seg-fi')
                                        : null}
                                      {includeCashLikeInChart
                                        ? ringSeg(pCashLike, 'coverage-asset-pie-ring-seg-cashlike', 'seg-cashlike')
                                        : null}
                                      {ringSeg(pCash, 'coverage-asset-pie-ring-seg-cash', 'seg-cash')}
                                      {includeBpInChart
                                        ? ringSeg(pBp, 'coverage-asset-pie-ring-seg-bp', 'seg-bp')
                                        : null}
                                    </>
                                  ) : null}
                                  <text
                                    x={cx}
                                    y={cy - 4}
                                    className={`coverage-asset-pie-center-val${
                                      netLiq != null
                                        ? ' coverage-asset-pie-center-val--netliq'
                                        : simpleCenterPct
                                          ? ''
                                          : ' coverage-asset-pie-center-val--basis'
                                    }`}
                                    textAnchor="middle"
                                    dominantBaseline="auto"
                                  >
                                    {centerMain}
                                  </text>
                                  <text
                                    x={cx}
                                    y={cy + 11}
                                    className="coverage-asset-pie-center-sub"
                                    textAnchor="middle"
                                    dominantBaseline="auto"
                                  >
                                    {centerSub}
                                  </text>
                                </svg>
                                <div className="coverage-asset-pie-bp-side">
                                  <div className="coverage-asset-pie-chart-toggle-row">
                                    <span className="coverage-asset-pie-bp-label">Fixed income in chart</span>
                                    <div
                                      className="coverage-asset-pie-bubble-switch"
                                      role="group"
                                      aria-label="Include fixed income in ring denominator"
                                    >
                                      <button
                                        type="button"
                                        className={`coverage-asset-pie-bubble-btn${!coverageAssetPieIncludeFi ? ' active' : ''}`}
                                        aria-pressed={!coverageAssetPieIncludeFi}
                                        onClick={() => setCoverageAssetPieIncludeFi(false)}
                                      >
                                        Exclude
                                      </button>
                                      <button
                                        type="button"
                                        className={`coverage-asset-pie-bubble-btn${coverageAssetPieIncludeFi ? ' active' : ''}`}
                                        aria-pressed={coverageAssetPieIncludeFi}
                                        onClick={() => setCoverageAssetPieIncludeFi(true)}
                                      >
                                        Include
                                      </button>
                                    </div>
                                  </div>
                                  <div className="coverage-asset-pie-chart-toggle-row">
                                    <span className="coverage-asset-pie-bp-label">Cash-like in chart</span>
                                    <div
                                      className="coverage-asset-pie-bubble-switch"
                                      role="group"
                                      aria-label="Include cash-like in ring denominator"
                                    >
                                      <button
                                        type="button"
                                        className={`coverage-asset-pie-bubble-btn${!coverageAssetPieIncludeCashLike ? ' active' : ''}`}
                                        aria-pressed={!coverageAssetPieIncludeCashLike}
                                        onClick={() => setCoverageAssetPieIncludeCashLike(false)}
                                      >
                                        Exclude
                                      </button>
                                      <button
                                        type="button"
                                        className={`coverage-asset-pie-bubble-btn${coverageAssetPieIncludeCashLike ? ' active' : ''}`}
                                        aria-pressed={coverageAssetPieIncludeCashLike}
                                        onClick={() => setCoverageAssetPieIncludeCashLike(true)}
                                      >
                                        Include
                                      </button>
                                    </div>
                                  </div>
                                  <div className="coverage-asset-pie-chart-toggle-row">
                                    <span className="coverage-asset-pie-bp-label">Buying power in chart</span>
                                    <div
                                      className="coverage-asset-pie-bubble-switch"
                                      role="group"
                                      aria-label="Include buying power in ring denominator"
                                    >
                                      <button
                                        type="button"
                                        className={`coverage-asset-pie-bubble-btn${!coverageAssetPieIncludeBp ? ' active' : ''}`}
                                        aria-pressed={!coverageAssetPieIncludeBp}
                                        onClick={() => setCoverageAssetPieIncludeBp(false)}
                                      >
                                        Exclude
                                      </button>
                                      <button
                                        type="button"
                                        className={`coverage-asset-pie-bubble-btn${coverageAssetPieIncludeBp ? ' active' : ''}`}
                                        aria-pressed={coverageAssetPieIncludeBp}
                                        onClick={() => setCoverageAssetPieIncludeBp(true)}
                                      >
                                        Include
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="coverage-asset-pie-legend">
                                <div className="coverage-asset-pie-legend-item">
                                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--stock" />
                                  <span className="coverage-asset-pie-legend-label">Stock</span>
                                  <span className="coverage-asset-pie-legend-pct">
                                    {denom > 0 ? `${(pStock * 100).toFixed(1)}%` : '—'}
                                  </span>
                                  <span className="coverage-asset-pie-legend-value">{fmtUsd(coreStockMV)}</span>
                                </div>
                                <div
                                  className={`coverage-asset-pie-legend-item${!includeFiInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                                  title={
                                    !includeFiInChart
                                      ? 'Fixed income MV is listed; not included in ring denominator.'
                                      : undefined
                                  }
                                >
                                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--fi" />
                                  <span className="coverage-asset-pie-legend-label">Fixed income</span>
                                  <span className="coverage-asset-pie-legend-pct">
                                    {includeFiInChart && denom > 0 ? `${(pFixedIncome * 100).toFixed(1)}%` : '—'}
                                  </span>
                                  <span className="coverage-asset-pie-legend-value">{fmtUsd(fixedIncomeMV)}</span>
                                </div>
                                <div
                                  className={`coverage-asset-pie-legend-item${!includeCashLikeInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                                  title={
                                    !includeCashLikeInChart
                                      ? 'Cash-like MV is listed; not included in ring denominator.'
                                      : undefined
                                  }
                                >
                                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--cashlike" />
                                  <span className="coverage-asset-pie-legend-label">Cash-like</span>
                                  <span className="coverage-asset-pie-legend-pct">
                                    {includeCashLikeInChart && denom > 0 ? `${(pCashLike * 100).toFixed(1)}%` : '—'}
                                  </span>
                                  <span className="coverage-asset-pie-legend-value">{fmtUsd(cashLikeMV)}</span>
                                </div>
                                <div className="coverage-asset-pie-legend-item">
                                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--cash" />
                                  <span className="coverage-asset-pie-legend-label">Net cash</span>
                                  <span className="coverage-asset-pie-legend-pct">
                                    {denom > 0 ? `${(pCash * 100).toFixed(1)}%` : '—'}
                                  </span>
                                  <span className="coverage-asset-pie-legend-value">{fmtUsd(cash)}</span>
                                </div>
                                <div
                                  className={`coverage-asset-pie-legend-item${!includeBpInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                                  title={
                                    !includeBpInChart
                                      ? 'Buying power is listed for reference; not included in ring denominator.'
                                      : undefined
                                  }
                                >
                                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--bp" />
                                  <span className="coverage-asset-pie-legend-label">Buying power</span>
                                  <span className="coverage-asset-pie-legend-pct">
                                    {includeBpInChart && denom > 0 ? `${(pBp * 100).toFixed(1)}%` : '—'}
                                  </span>
                                  <span className="coverage-asset-pie-legend-value">{fmtUsd(bp)}</span>
                                </div>
                                {denom > 0 && (
                                  <div className="coverage-asset-pie-legend-divider" aria-hidden />
                                )}
                                {denom > 0 && (
                                  <div className="coverage-asset-pie-legend-item coverage-asset-pie-legend-sum">
                                    <span className="coverage-asset-pie-legend-label">Sum (chart basis)</span>
                                    <span className="coverage-asset-pie-legend-value">{fmtUsd(denom)}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })()}
                      {(() => {
                        const { backingMV, totalStockMV, otherMV, pct } = backingPoolChartData
                        const cx = 66
                        const cy = 66
                        const rO = 56
                        const rI = 36
                        const pctLabel = (pct * 100).toFixed(1) + '%'
                        const toXY = (frac: number, r: number) => {
                          const a = frac * 2 * Math.PI - Math.PI / 2
                          return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
                        }
                        const buildArc = (startFrac: number, endFrac: number, r1: number, r2: number) => {
                          if (endFrac - startFrac >= 0.9999) {
                            return `M ${cx} ${cy - r1} A ${r1} ${r1} 0 1 1 ${cx - 0.001} ${cy - r1} Z`
                          }
                          if (endFrac - startFrac <= 0.0001) return ''
                          const s1 = toXY(startFrac, r1)
                          const e1 = toXY(endFrac, r1)
                          const s2 = toXY(endFrac, r2)
                          const e2 = toXY(startFrac, r2)
                          const lg = endFrac - startFrac > 0.5 ? 1 : 0
                          return [
                            `M ${s1.x.toFixed(3)} ${s1.y.toFixed(3)}`,
                            `A ${r1} ${r1} 0 ${lg} 1 ${e1.x.toFixed(3)} ${e1.y.toFixed(3)}`,
                            `L ${s2.x.toFixed(3)} ${s2.y.toFixed(3)}`,
                            `A ${r2} ${r2} 0 ${lg} 0 ${e2.x.toFixed(3)} ${e2.y.toFixed(3)}`,
                            'Z',
                          ].join(' ')
                        }
                        const backingArc = buildArc(0, pct, rO, rI)
                        const otherArc = buildArc(pct, 1, rO, rI)
                        return (
                          <div className="coverage-charts-cell backing-pool-chart-section backing-pool-chart-section--in-charts-grid">
                            <div className="backing-pool-chart-header">
                              <span className="backing-pool-chart-title">Backing Pool Coverage</span>
                              <InfoTooltip text="Backing pool market value vs total stock coverage (optionable rows) for the account selected in this charts section." />
                            </div>
                            <div className="backing-pool-chart-body">
                              <svg
                                width={132}
                                height={132}
                                viewBox="0 0 132 132"
                                className="backing-pool-chart-svg"
                                role="img"
                                aria-label={`Backing pool ${pctLabel} of total stock coverage`}
                              >
                                {totalStockMV > 0 ? (
                                  <>
                                    {otherArc ? <path d={otherArc} className="backing-pool-arc-other" /> : null}
                                    {backingArc ? <path d={backingArc} className="backing-pool-arc-backing" /> : null}
                                  </>
                                ) : (
                                  <circle cx={cx} cy={cy} r={rO} className="backing-pool-arc-other" />
                                )}
                                <circle cx={cx} cy={cy} r={rI} className="backing-pool-arc-hole" />
                                <text
                                  x={cx}
                                  y={cy - 7}
                                  className="backing-pool-chart-pct-text"
                                  textAnchor="middle"
                                  dominantBaseline="auto"
                                >
                                  {totalStockMV > 0 ? pctLabel : '—'}
                                </text>
                                <text
                                  x={cx}
                                  y={cy + 10}
                                  className="backing-pool-chart-sub-text"
                                  textAnchor="middle"
                                  dominantBaseline="auto"
                                >
                                  of total
                                </text>
                              </svg>
                              <div className="backing-pool-chart-legend">
                                <div className="backing-pool-chart-legend-item">
                                  <span className="backing-pool-chart-legend-dot backing-pool-chart-legend-dot--backing" />
                                  <span className="backing-pool-chart-legend-label">Backing Pool</span>
                                  <span className="backing-pool-chart-legend-value">{fmtUsd(backingMV)}</span>
                                </div>
                                <div className="backing-pool-chart-legend-item">
                                  <span className="backing-pool-chart-legend-dot backing-pool-chart-legend-dot--other" />
                                  <span className="backing-pool-chart-legend-label">Other stock</span>
                                  <span className="backing-pool-chart-legend-value">{fmtUsd(otherMV)}</span>
                                </div>
                                <div className="backing-pool-chart-legend-divider" />
                                <div className="backing-pool-chart-legend-item">
                                  <span className="backing-pool-chart-legend-label backing-pool-chart-legend-total">
                                    Total stock
                                  </span>
                                  <span className="backing-pool-chart-legend-value">{fmtUsd(totalStockMV)}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })()}
                        </div>
                      </div>
                      <div className="coverage-pools-row">
                          <div className="coverage-pool-panel">
                            <p className="section-hint" style={{ margin: '0 0 0.35rem' }}>
                              Option underlying Pool
                            </p>
                            <p className="section-hint" style={{ margin: '0 0 0.4rem', fontSize: '0.82em' }}>
                              Long shares not needed for existing opportunity hedges (all scopes); can back additional options.
                            </p>
                            {optionUnderlyingPoolItems.length === 0 && (
                              <p
                                className="section-hint coverage-pool-empty-explanation"
                                style={{ margin: '0 0 0.5rem', fontSize: '0.85em', lineHeight: 1.45 }}
                              >
                                No rows when every long share is already counted toward instance hedges, or when your instances do not require separate underlying stock backup. The table stays here so you can see the column layout when positions do create surplus.
                              </p>
                            )}
                            <p className="option-underlying-pool-totals" style={{ margin: '0 0 0.45rem' }}>
                              <span className="option-underlying-pool-total-item">
                                <span className="option-underlying-pool-total-label">Market Total</span>{' '}
                                <strong>{fmtUsd(optionUnderlyingPoolMarketTotal)}</strong>
                              </span>
                              <span className="option-underlying-pool-total-sep" aria-hidden>
                                {' · '}
                              </span>
                              <span className="option-underlying-pool-total-item">
                                {streamHostAccountId ? (
                                  <>
                                    <strong className="coverage-account-id coverage-account-host">
                                      {streamHostAccountId}
                                    </strong>{' '}
                                    <span
                                      className="option-underlying-pool-cash-bp"
                                      title="Total cash / buying power (account table)"
                                    >
                                      {fmtUsd(hostSecondaryAccountCashBp.host.cash)}
                                      {' / '}
                                      {fmtUsd(hostSecondaryAccountCashBp.host.bp)}
                                    </span>
                                  </>
                                ) : (
                                  <strong className="replay-muted">—</strong>
                                )}
                              </span>
                              <span className="option-underlying-pool-total-sep" aria-hidden>
                                {' · '}
                              </span>
                              <span className="option-underlying-pool-total-item">
                                {streamSecondaryAccountId ? (
                                  <>
                                    <strong className="coverage-account-id coverage-account-secondary">
                                      {streamSecondaryAccountId}
                                    </strong>{' '}
                                    <span
                                      className="option-underlying-pool-cash-bp"
                                      title="Total cash / buying power (account table)"
                                    >
                                      {fmtUsd(hostSecondaryAccountCashBp.secondary.cash)}
                                      {' / '}
                                      {fmtUsd(hostSecondaryAccountCashBp.secondary.bp)}
                                    </span>
                                  </>
                                ) : (
                                  <strong className="replay-muted">—</strong>
                                )}
                              </span>
                            </p>
                            {renderStockCoverageSummaryTable(sortedOptionUnderlyingPoolItemsForSection, 'underlying-pool', {
                              underlyingPoolSlim: true,
                              underlyingPoolSort: {
                                column: underlyingPoolSort.col,
                                dir: underlyingPoolSort.dir,
                                onColumnClick: onUnderlyingPoolSortClick,
                              },
                            })}
                          </div>
                        {watchlistOptionableCoverageItems.length > 0 && (
                          <div className="coverage-pool-panel">
                            <p className="section-hint" style={{ margin: '0 0 0.35rem' }}>
                              Option backing Pool
                            </p>
                            <p className="section-hint" style={{ margin: '0 0 0.45rem', fontSize: '0.82em' }}>
                              Watchlist-scoped opportunities: Required = hedge from those strategies only.
                            </p>
                            {renderStockCoverageSummaryTable(sortedWatchlistOptionableCoverageItemsForSection, 'watchlist-optionable', {
                              backingPoolSlim: true,
                              underlyingPoolSort: {
                                column: backingPoolSort.col,
                                dir: backingPoolSort.dir,
                                onColumnClick: onBackingPoolSortClick,
                              },
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="coverage-summary-section coverage-summary-section--placeholder">
                      <h6 className="replay-sub instance-sheet-sub-heading coverage-summary-heading-row">
                        Coverage summary
                        <InfoTooltip text="Option underlying pool, backing pool, and charts appear when instances match filters. Underlying pool = stock left after opportunity hedges." />
                      </h6>
                      <p className="section-hint coverage-summary-placeholder-text">
                        This section is computed from the instance table above. With no instances matching the current filters, there is nothing to show here—so the pools are hidden, not missing. Clear or widen filters to bring instances back and see Option underlying / backing pools.
                      </p>
                    </div>
                  )}
                  {independentStockSections.some(s => s.rows.length > 0) && (
                    <div className="instance-sheet-stock-section">
                      <h5 className="replay-sub instance-sheet-section-heading">Independent Holdings</h5>
                      <p className="section-hint">Positions without tradeable options (Index, ETF, etc.); not part of any option strategy. Grouped by position category (Stocks, Fixed income, Cash-like).</p>
                      <div className="replay-portfolio-table-wrap">
                        <table className="table-operations instance-sheet-sub-table">
                          <thead>
                            <tr>
                              <th>Account</th>
                              <th>Symbol</th>
                              <th>Side</th>
                              <th>Qty</th>
                              <th>Avg Cost</th>
                              <th>Last</th>
                              <th>Market Value</th>
                              <th>Daily ($ / %)</th>
                              <th>Total ($ / %)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {independentStockSections
                              .filter(s => s.rows.length > 0)
                              .flatMap(section => [
                                <tr key={`${section.key}-section`} className="replay-portfolio-group-header">
                                  <td colSpan={9}>
                                    <strong>{section.title}</strong>
                                  </td>
                                </tr>,
                                ...section.rows.map(p => renderIndependentHoldingRow(p, section.key)),
                              ])}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ) : openTab === 'options' ? (
                <div
                  id="open-panel-options"
                  role="tabpanel"
                  aria-labelledby="open-tab-options"
                  className="system-tab-panel"
                >
                  <h5 className="replay-sub">Option positions</h5>
                  {optionsTabPositions.length === 0 ? (
                    <p className="section-hint">No open option positions under the current filters.</p>
                  ) : (
                <div className="replay-portfolio-table-wrap">
                  <table className="table-operations replay-opt-groups positions-opt-main-table">
                    <colgroup>
                      <col className="pom-col-expand" />
                      <col className="pom-col-contract" />
                      <col className="pom-col-expiry" />
                      <col className="pom-col-strike" />
                      <col className="pom-col-last" />
                      <col className="pom-col-qty" />
                      <col className="pom-col-at" />
                      <col className="pom-col-value" />
                      <col className="pom-col-quote" />
                      <col className="pom-col-time" />
                      <col className="pom-col-unpnl" />
                      <col className="pom-col-pool" />
                      <col className="pom-col-account" />
                      <col className="pom-col-opp" />
                      <col className="pom-col-actions" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="replay-opt-expand-col" />
                        {(() => {
                          const cols: { col: OpenOptSortCol; label: string; title?: string }[] = [
                            { col: 'contract', label: 'Contract' },
                            { col: 'expiry', label: 'Expiry' },
                            { col: 'strike', label: 'Strike' },
                            { col: 'last', label: 'Last', title: 'Underlying last price; (Last − Strike) / Last %' },
                            { col: 'qty', label: 'Qty' },
                            { col: 'avg_cost', label: '@' },
                            { col: 'value', label: 'Value' },
                            { col: 'time', label: 'Time' },
                            { col: 'un_pnl', label: 'UN PNL' },
                          ]
                          return cols.flatMap(c => {
                            const th = (
                              <th
                                key={c.col}
                                className="replay-th-sortable"
                                title={c.title ?? `Sort by ${c.label}`}
                                onClick={() => setOpenOptSort(prev => prev.column === c.col ? { column: c.col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { column: c.col, dir: 'desc' })}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenOptSort(prev => prev.column === c.col ? { column: c.col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { column: c.col, dir: 'desc' }) } }}
                                aria-sort={openOptSort.column === c.col ? (openOptSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                              >
                                {c.label}{openOptSort.column === c.col ? (openOptSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                              </th>
                            )
                            if (c.col === 'value') {
                              return [th, <th key="opt-quote" title="Option live bid / mid / ask">Opt Quote</th>]
                            }
                            return [th]
                          })
                        })()}
                        <th>Pool</th>
                        <th>Account</th>
                        <th title="Opportunity">Opp</th>
                        <th className="replay-opt-actions-cell">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedOptionsTabPositions.flatMap(pos => {
                            const posKey = getOptionsTabPositionKey(pos)
                            const absQty = Math.abs(pos.qty)
                            const sideLabel = pos.qty > 0 ? 'Long' : pos.qty < 0 ? 'Short' : '—'
                            const value = (pos.avg_cost ?? 0) * absQty * 100
                            const ts = getPositionTime(pos)
                            const execLists = getPositionExecLists(pos)
                            const execCount = execLists.final.length + execLists.tws.length
                            const hasExecutions = execCount > 0
                            const isPosExpanded = expandedPositionKeys.includes(posKey)
                            const posRow = (
                              <tr
                                key={posKey}
                                className="detail-position-row"
                                onClick={hasExecutions ? () => togglePositionExpand(posKey) : undefined}
                                role={hasExecutions ? 'button' : undefined}
                                tabIndex={hasExecutions ? 0 : undefined}
                                onKeyDown={hasExecutions ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePositionExpand(posKey) } } : undefined}
                                aria-expanded={hasExecutions ? isPosExpanded : undefined}
                              >
                                <td className="replay-opt-expand-col">
                                  {hasExecutions ? (
                                    <span className={`replay-opt-expand-icon ${isPosExpanded ? 'expanded' : ''}`} aria-hidden>
                                      {isPosExpanded ? '▼' : '▶'}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="replay-opt-contract">
                                  {(() => {
                                    const p = getContractLabelParts(pos.contract_key)
                                    const strikeStr = pos.strike != null ? ` ${pos.strike}` : ''
                                    const fill = instanceIconFillFromMergedExecutions(execLists.merged)
                                    const instanceIcon =
                                      fill === 'empty'
                                        ? null
                                        : fill === 'none' ? (
                                            <span
                                              className="ledger-instance-icon-link ledger-instance-icon-link--different"
                                              title="None of the matched executions have a strategy instance"
                                              aria-label="No strategy instance on matched executions"
                                              role="img"
                                              onClick={e => e.stopPropagation()}
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </span>
                                          ) : fill === 'all' ? (
                                            <span
                                              className="ledger-instance-icon-link ledger-instance-icon-link--same"
                                              title="All matched executions have a strategy instance"
                                              aria-label="All matched executions have a strategy instance"
                                              role="img"
                                              onClick={e => e.stopPropagation()}
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </span>
                                          ) : (
                                            <span
                                              className="ledger-instance-icon-link ledger-instance-icon-link--mixed"
                                              title="Some matched executions have a strategy instance, some do not"
                                              aria-label="Mixed strategy instance on matched executions"
                                              role="img"
                                              onClick={e => e.stopPropagation()}
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </span>
                                          )
                                    return p.symbol ? (
                                      <>
                                        {instanceIcon}
                                        <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
                                      </>
                                    ) : (
                                      <>
                                        {instanceIcon}
                                        {pos.contract_key}
                                      </>
                                    )
                                  })()}
                                </td>
                                <td className="positions-opt-expiry-cell">
                                  <div className="positions-opt-expiry-line1">{fmtExpiry(pos.expiry)}</div>
                                  {(() => {
                                    const days = daysUntilExpiry(pos.expiry)
                                    if (days == null) return null
                                    const label = days >= 0 ? (days === 0 ? 'today' : `${days}d`) : `${-days}d ago`
                                    return (
                                      <div className="positions-opt-expiry-line2">
                                        <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>{label}</span>
                                      </div>
                                    )
                                  })()}
                                </td>
                                <td><strong>{fmtUsd(pos.strike)}</strong></td>
                                <td className="positions-opt-last-cell">
                                  {(() => {
                                    const underlying = getContractLabelParts(pos.contract_key).symbol
                                    const q = underlying ? quotesMap[underlying] : undefined
                                    const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                    const strikeNum = pos.strike != null && Number.isFinite(pos.strike) ? pos.strike : null
                                    const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                                    const right = parseOptionContractKey(pos.contract_key).right
                                    const side: 'Buy' | 'Sell' = pos.qty > 0 ? 'Buy' : 'Sell'
                                    const pctClass = pct != null ? optionLastStrikePctClass(right, side, pct) : ''
                                    return (
                                      <>
                                        <div className="positions-opt-last-line1">{last != null ? fmtUsd(last) : '—'}</div>
                                        {pct != null ? (
                                          <div className="positions-opt-last-line2">
                                            <span className={`replay-last-strike-pct ${pctClass}`.trim()} title={`(Last − Strike) / Last = ${pct.toFixed(2)}%`}>
                                              {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                                            </span>
                                          </div>
                                        ) : null}
                                      </>
                                    )
                                  })()}
                                </td>
                                <td>{sideLabel} {absQty}</td>
                                <td>{fmtUsd(pos.avg_cost)}</td>
                                <td>{fmtUsd(value)}</td>
                                <td className="positions-opt-live-quote">
                                  {(() => {
                                    const liveQ = quotesMap[pos.contract_key]
                                    if (!liveQ) return <span className="replay-muted">—</span>
                                    const mid = liveQ.mid ?? (liveQ.bid != null && liveQ.ask != null ? (liveQ.bid + liveQ.ask) / 2 : null)
                                    return (
                                      <>
                                        <div className="positions-opt-quote-line positions-opt-quote-line--bid">
                                          {liveQ.bid != null ? <span className="positions-opt-quote-bid">{liveQ.bid.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                                        </div>
                                        <div className="positions-opt-quote-line positions-opt-quote-line--mid">
                                          <strong>{mid != null ? mid.toFixed(2) : '—'}</strong>
                                        </div>
                                        <div className="positions-opt-quote-line positions-opt-quote-line--ask">
                                          {liveQ.ask != null ? <span className="positions-opt-quote-ask">{liveQ.ask.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                                        </div>
                                      </>
                                    )
                                  })()}
                                </td>
                                <td className="positions-opt-time-cell">
                                  {ts != null ? (
                                    <>
                                      <div className="positions-opt-time-line1">{fmtDate(ts)}</div>
                                      {fmtDaysAgo(ts) ? <div className="positions-opt-time-line2"><span className="replay-time-ago">{fmtDaysAgo(ts)}</span></div> : null}
                                    </>
                                  ) : '—'}
                                </td>
                                <td>
                                  {(() => {
                                    const liveQ = quotesMap[pos.contract_key]
                                    const liveMid = liveQ?.mid ?? (liveQ?.bid != null && liveQ?.ask != null ? (liveQ.bid + liveQ.ask) / 2 : null)
                                    const livePnl = liveMid != null && pos.avg_cost != null
                                      ? (liveMid - pos.avg_cost) * absQty * 100 : null
                                    return (
                                      <>
                                        {livePnl != null && (
                                          <div>
                                            <span className={`replay-pnl-unrealized ${livePnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(livePnl)}</span>
                                            <span className="replay-muted" style={{fontSize:'0.7em'}}> live</span>
                                          </div>
                                        )}
                                        <div className={livePnl != null ? 'replay-muted' : undefined} style={livePnl != null ? {fontSize:'0.75em'} : undefined}>
                                          <span className={`replay-pnl-unrealized ${pos.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(pos.unrealized_pnl)}</span>
                                          {livePnl != null && <span style={{fontSize:'0.7em'}}> snap</span>}
                                        </div>
                                      </>
                                    )
                                  })()}
                                </td>
                                <td className="replay-muted">{pos.pool_label}</td>
                                <td className="positions-opt-account-cell">{pos.account_id || '—'}</td>
                                <td className="replay-strategy-opp-cell positions-opt-opp-hint-cell">
                                  {execCount === 0 ? '—' : (
                                    <span className="replay-muted" title={`${execCount} execution${execCount > 1 ? 's' : ''} — expand row`}>
                                      {execCount} exec{execCount > 1 ? 's' : ''} ↓
                                    </span>
                                  )}
                                </td>
                                <td className="replay-opt-actions-cell">—</td>
                              </tr>
                            )
                            const execRows = isPosExpanded
                              ? [
                                  ...execLists.final.map((ex, ei) =>
                                    renderOpenOptionExecutionRow(pos, posKey, ex, ei, 'final', execLists.final, execLists.tws, false),
                                  ),
                                  ...execLists.tws.map((ex, ei) =>
                                    renderOpenOptionExecutionRow(pos, posKey, ex, ei, 'tws', execLists.final, execLists.tws, false),
                                  ),
                                ]
                              : []
                            return [posRow, ...execRows]
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="replay-opt-tfoot-total">
                        <td colSpan={14} className="replay-opt-tfoot-label">Total</td>
                        <td>
                          <span className="replay-pnl-unrealized">
                            {fmtUsd(optionsTabPositions.reduce((acc, p) => acc + p.unrealized_pnl, 0))}
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
                </div>
              ) : openTab === 'stocks' ? (
                renderLiveStockBucketPanel(
                  'open-panel-stocks',
                  'open-tab-stocks',
                  'Stock positions',
                  coreStockPositions,
                  'stk',
                  'No open stock positions under the current filters.',
                )
              ) : openTab === 'fixed_income' ? (
                renderLiveStockBucketPanel(
                  'open-panel-fixed-income',
                  'open-tab-fixed-income',
                  'Fixed income positions',
                  fixedIncomeStockPositions,
                  'fi',
                  'No open fixed income positions under the current filters.',
                )
              ) : (
                renderLiveStockBucketPanel(
                  'open-panel-cash-like',
                  'open-tab-cash-like',
                  'Cash-like positions',
                  cashLikeStockPositions,
                  'cash',
                  'No open cash-like positions under the current filters.',
                )
              )}
            </div>
          )}
        </section>


      {pageError && (
        <p className="section-hint replay-form-error" style={{ marginTop: '0.5rem' }}>{pageError}</p>
      )}
      {editExecConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="positions-edit-exec-confirm-title"
          onClick={() => setEditExecConfirmState({ open: false, exec: null })}
        >
          <div
            className="modal-panel replay-exec-modal"
            style={{ maxWidth: 440 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="positions-edit-exec-confirm-title" className="section-subtitle" style={{ marginTop: 0 }}>
              Edit execution?
            </h3>
            <p className="section-hint execution-flex-manual-warning" role="alert" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              When Flex and TWS sync are healthy, missing or late fills usually appear automatically after the next Flex refresh.
              Manual edits can conflict with or duplicate those rows. Continue only if you are intentionally reconciling or correcting
              this line.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditExecConfirmState({ open: false, exec: null })}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const ex = editExecConfirmState.exec
                  setEditExecConfirmState({ open: false, exec: null })
                  if (ex) {
                    setEditExec(ex)
                    setPageError(null)
                  }
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
      <ExecutionFormModal
        open={!!editExec}
        editExec={editExec}
        accountOptions={executionAccountOptions}
        initialDraft={null}
        onClose={() => {
          setEditExec(null)
          setPageError(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
          loadAttributions()
        }}
      />
      <LinkExecutionRecordModal
        open={linkModalOpen}
        context={linkContext}
        onClose={() => {
          setLinkModalOpen(false)
          setLinkContext(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
          loadAttributions()
        }}
      />
      {deleteConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="positions-delete-exec-title"
          onClick={() => {
            if (!deleteConfirmState.confirming) {
              setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))
            }
          }}
        >
          <div
            className="modal-panel replay-exec-modal"
            style={{ maxWidth: 400 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="positions-delete-exec-title" className="section-subtitle" style={{ marginTop: 0 }}>
              {deleteConfirmState.title}
            </h3>
            <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              {deleteConfirmState.message}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))}
                disabled={deleteConfirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={async () => {
                  const exec = deleteConfirmState.exec
                  if (!exec?.account_executions_id) {
                    setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))
                    return
                  }
                  setDeleteConfirmState(prev => ({ ...prev, confirming: true }))
                  const res = await deleteExecution(exec.account_executions_id)
                  if (res.ok) {
                    if (editExec?.account_executions_id === exec.account_executions_id) setEditExec(null)
                    await loadReplayData()
                    loadAttributions()
                  } else {
                    setPageError(res.error ?? 'Delete failed')
                  }
                  setDeleteConfirmState({ open: false, title: '', message: '', confirming: false, exec: null })
                }}
                disabled={deleteConfirmState.confirming}
              >
                {deleteConfirmState.confirming ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}
      <QuickCloseModal
        exec={closeAgainstExec}
        onClose={() => setCloseAgainstExec(null)}
        onSuccess={() => { loadReplayData(); loadAttributions() }}
      />
    </div>
  )
}

