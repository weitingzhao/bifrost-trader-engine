import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { Execution, OpenOrder, PositionCategory, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
import { fetchBarsBenchmark, fetchExecutions, fetchMarketStreamsSymbolOrder, fetchOpenOrders, fetchPositionCategories, fetchQuotes, fetchWatchlist, patchPositionCategory, putMarketStreamsSymbolOrder, subscribeQuotes } from '../api'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { BREADCRUMB_LINK_CLASS, SECTION_TITLE_CLASS } from '../components/SectionPageTitle'
import { InfoTooltip } from '../components/InfoTooltip'
import { SettingsTitleLamp } from './settings/SettingsTitleLamp'
import { fmtSince, fmtTs, fmtUsd, fmtUsdRound0, parseOptionContractKey } from '../utils/format'
import {
  computeAccountSyncLamp,
  computeMarketStreamsOk,
  computeOpenOrdersSectionOk,
} from '../utils/livePageLamps'
import {
  computeDailyChange,
  mergeQuotesIntoSymbolMap,
  normalizeBenchmarkMap,
  quoteDisplayLast,
  resolveDailyBasePrice,
  type DailyBenchmark,
} from './accounts/accountsUtils'
import { computeOptionLiveAvgPerShareFromExecutions } from '../utils/optionLiveBasis'

const SYMBOL_ORDER_STORAGE_KEY = 'market_streams_symbol_order'
const OPT_ROW_ORDER_STORAGE_KEY = 'market_streams_opt_row_order'

function loadOptRowOrderFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(OPT_ROW_ORDER_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function saveOptRowOrderToStorage(order: string[]): void {
  try {
    localStorage.setItem(OPT_ROW_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    /* ignore */
  }
}

/** IB TWS-style FIN INSTRUMENT column sort cycle (unified STK + OPT → 9 modes). */
type MarketStreamsSortMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

type MarketStreamsRow = {
  symbol: string
  quote?: RealtimeQuote | null
  qty: number | null
  avgCost: number | null
  changePct: number | null
  pnlVsBench: number | null
  pnlCost: number | null
  streamCategory: 'host' | 'secondary' | 'both' | null
  isInWatchlist: boolean
  category: string
  hostQty: number | null
  hostAvgCost: number | null
  hostPnlCost: number | null
  secondaryQty: number | null
  secondaryAvgCost: number | null
  secondaryPnlCost: number | null
  positionDailyPrevClose: number | null
}

type OptPositionRow = {
  account_id: string
  contract_key: string
  symbol: string
  expiry: string
  strike: number
  right: string
  qty: number
  avg_cost: number | null
}

function cmpSymbolLocale(a: string, b: string, dir: 1 | -1): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) * dir
}

/** YYYYMMDD → sortable int; invalid → 0 */
function expiryDigitsToSortKey(expiry: string): number {
  const s = String(expiry ?? '').replace(/\D/g, '')
  if (s.length >= 8) return parseInt(s.slice(0, 8), 10) || 0
  if (s.length === 6) return parseInt(`${s}01`, 10) || 0
  return 0
}

/** IB-style e.g. May 08'26 */
function formatExpiryIbGroupLabel(expiry: string): string {
  const s = String(expiry ?? '').replace(/\D/g, '')
  if (s.length < 8) return expiry?.trim() ? String(expiry).trim() : 'Other'
  const y = parseInt(s.slice(0, 4), 10)
  const mo = parseInt(s.slice(4, 6), 10) - 1
  const d = parseInt(s.slice(6, 8), 10)
  if (!Number.isFinite(y) || mo < 0 || mo > 11 || !Number.isFinite(d)) return String(expiry).trim() || 'Other'
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo] ?? ''
  return `${mon} ${String(d).padStart(2, '0')}'${String(y).slice(2)}`
}

function optionRowSortKey(row: OptPositionRow): string {
  const exp = String(row.expiry ?? '').replace(/\D/g, '')
  const strike = Number.isFinite(row.strike) ? String(row.strike).padStart(12, '0') : '0'
  const sym = (row.symbol || '').toUpperCase()
  const ck = (row.contract_key || '').toUpperCase()
  return `${sym}|${exp}|${strike}|${ck}`
}

/**
 * IB sometimes returns OPT avgCost scaled (e.g. 350 for $3.50/share). Match Positions page heuristic.
 */
function normalizeIbOptionAvgCostPerShare(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(Number(raw))) return null
  const n = Number(raw)
  return Math.abs(n) >= 10 ? n / 100 : n
}

/** Human label: Long/Short + Call/Put (MTM is still $/share × signed contracts × 100 for both rights). */
function describeOptionLegMtm(row: OptPositionRow): string {
  const r = String(row.right ?? '').trim().toUpperCase()
  const leg =
    r === 'P' || r === 'PUT' || r.startsWith('P')
      ? 'Put'
      : r === 'C' || r === 'CALL' || r.startsWith('C')
        ? 'Call'
        : (row.right || 'Opt').trim() || 'Opt'
  if (row.qty > 0) return `Long ${leg}`
  if (row.qty < 0) return `Short ${leg}`
  return leg
}

/** Listed equity OPT: MTM $ = (mark − avg $/share) × signed contract count × 100. Long qty&gt;0, short qty&lt;0; Call/Put both $/share premium. */
function computeOptionMtmPnlUsd(midPerShare: number, avgCostPerShare: number, signedContracts: number): number {
  return (midPerShare - avgCostPerShare) * signedContracts * 100
}

function resolveOptAvgCostPerShareForMtm(
  row: OptPositionRow,
  basis: { avgPerShare: number | null; basisSource: 'flex_trades' | 'tws_client' | null } | undefined,
): number | null {
  const raw =
    basis?.avgPerShare != null && Number.isFinite(basis.avgPerShare) ? basis.avgPerShare : row.avg_cost
  return normalizeIbOptionAvgCostPerShare(raw)
}

/**
 * IB short OPT: `avgCost` is often **negative** $/share (credit received). For MTM `(mid − avg)×qty×100`
 * we need average **premium received as a positive** $/sh when qty &lt; 0, so flip sign once.
 * Long legs keep IB avg as-is (positive cost).
 */
function effectiveOptAvgCostPerShareForMtm(row: OptPositionRow, avgNormalized: number | null): number | null {
  if (avgNormalized == null || !Number.isFinite(avgNormalized)) return null
  if (row.qty < 0 && avgNormalized < 0) return -avgNormalized
  return avgNormalized
}

function computeOptMidAndLivePnl(
  row: OptPositionRow,
  q: RealtimeQuote | undefined,
  basis: { avgPerShare: number | null; basisSource: 'flex_trades' | 'tws_client' | null } | undefined,
): { mid: number | null; livePnl: number | null } {
  const mid = q?.mid ?? (q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null)
  const rawAvg = resolveOptAvgCostPerShareForMtm(row, basis)
  const avgForPnl = effectiveOptAvgCostPerShareForMtm(row, rawAvg)
  const livePnl =
    mid != null && avgForPnl != null && Number.isFinite(avgForPnl) && Number.isFinite(row.qty) && row.qty !== 0
      ? computeOptionMtmPnlUsd(mid, avgForPnl, row.qty)
      : null
  return { mid, livePnl }
}

function sumFiniteMsPnl(rows: MarketStreamsRow[]): number {
  return rows.reduce((acc, r) => {
    const v = r.pnlCost
    return acc + (v != null && Number.isFinite(v) ? v : 0)
  }, 0)
}

function marketStreamsSortHeaderMeta(mode: MarketStreamsSortMode): { suffix: string | null; arrow: 'up' | 'down' | null } {
  if (mode === 1) return { suffix: null, arrow: null }
  if (mode === 2) return { suffix: null, arrow: 'up' }
  if (mode === 3) return { suffix: null, arrow: 'down' }
  if (mode === 4 || mode === 5) return { suffix: 'T+', arrow: mode === 4 ? 'up' : 'down' }
  if (mode === 6 || mode === 7) return { suffix: 'T+S+', arrow: mode === 6 ? 'up' : 'down' }
  if (mode === 8 || mode === 9) return { suffix: 'E+', arrow: mode === 8 ? 'up' : 'down' }
  return { suffix: null, arrow: null }
}

/** Visual accent on Symbol header for each sort family (color in CSS). */
function marketStreamsSortHeaderAccentClass(mode: MarketStreamsSortMode): string {
  if (mode === 1) return 'live-sort-header--accent-default'
  if (mode === 2 || mode === 3) return 'live-sort-header--accent-alpha'
  if (mode === 4 || mode === 5) return 'live-sort-header--accent-type'
  if (mode === 6 || mode === 7) return 'live-sort-header--accent-gamma'
  return 'live-sort-header--accent-expiry'
}

type LiveSortGroupMs = { label: string; showGroupHeader: boolean; stkRows: MarketStreamsRow[]; optRows: OptPositionRow[]; totalPnl: number }

function sortOptRowsAlpha(rows: OptPositionRow[], dir: 1 | -1): OptPositionRow[] {
  return [...rows].sort((a, b) => optionRowSortKey(a).localeCompare(optionRowSortKey(b), undefined, { sensitivity: 'base' }) * dir)
}

/** Total Daily $ and weighted Daily % for Market Streams (denominator = Σ base × |qty| per Accounts group logic). */
function aggregateMarketStreamsDailyTotals(
  rows: {
    symbol: string
    quote?: RealtimeQuote | null
    qty: number | null
    positionDailyPrevClose: number | null
    pnlVsBench: number | null
  }[],
  benchmarks: Record<string, DailyBenchmark>,
): { totalDailyDollar: number; totalDailyPct: number | null } {
  let totalDailyDollar = 0
  let totalDailyDenom = 0
  for (const r of rows) {
    const sym = (r.symbol || '').trim().toUpperCase()
    const bench = benchmarks[sym]
    const qty = r.qty != null && Number.isFinite(r.qty) ? r.qty : 0
    if (r.pnlVsBench != null && Number.isFinite(r.pnlVsBench)) totalDailyDollar += r.pnlVsBench
    const base = resolveDailyBasePrice(bench, r.positionDailyPrevClose ?? undefined)
    if (base != null && qty !== 0) totalDailyDenom += base * Math.abs(qty)
  }
  const totalDailyPct =
    totalDailyDenom !== 0 && Number.isFinite(totalDailyDollar) ? (totalDailyDollar / totalDailyDenom) * 100 : null
  return { totalDailyDollar, totalDailyPct }
}

function loadSymbolOrderFromStorage(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(SYMBOL_ORDER_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string[]>
  } catch {
    /* ignore */
  }
  return {}
}

function saveSymbolOrderToStorage(order: Record<string, string[]>): void {
  try {
    localStorage.setItem(SYMBOL_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    /* ignore */
  }
}

/** Watchlist STK `category` → show in Watching Stocks pane (not Market Streams). */
function isWatchlistStockCategoryWatching(category: string | null | undefined): boolean {
  return String(category ?? '').trim().toLowerCase() === 'watching'
}

/** Quote age → Symbol cell freshness: under 3s normal, 3–10s gray, over 10s darker (replaces Since column). */
function getQuoteFreshness(ts: number | null | undefined): 'fresh' | 'stale' | 'very-stale' | null {
  if (ts == null || !Number.isFinite(ts)) return null
  const ageSec = Date.now() / 1000 - ts
  if (ageSec < 3) return 'fresh'
  if (ageSec <= 10) return 'stale'
  return 'very-stale'
}

/** Hover breakdown for Market Streams Daily % / $ (substituted values, English UI). */
function MarketStreamsDailyCalcBreakdown({
  symbol,
  bench,
  positionDailyPrevClose,
  last,
  qty,
}: {
  symbol: string
  bench: DailyBenchmark | undefined
  positionDailyPrevClose: number | null
  last: number | null
  qty: number | null
}): ReactElement {
  const base = resolveDailyBasePrice(bench, positionDailyPrevClose ?? undefined)
  const qNum = qty != null && Number.isFinite(qty) ? qty : null

  let baseSource = '—'
  if (positionDailyPrevClose != null && Number.isFinite(positionDailyPrevClose) && positionDailyPrevClose > 0) {
    baseSource = 'Position daily_prev_close (IB / account_positions)'
  } else if (bench && Number.isFinite(bench.close) && bench.close > 0) {
    const prevOk = bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0
    baseSource =
      bench.is_today && prevOk
        ? 'Benchmark prev_close (GET /bars/benchmark, stock_day)'
        : 'Benchmark close (GET /bars/benchmark, stock_day)'
    if (Number.isFinite(bench.bar_time) && bench.bar_time > 0) {
      const barDate = new Date(bench.bar_time * 1000).toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      baseSource += ` · bar date ${barDate}`
    }
  }

  if (last == null || !Number.isFinite(last)) {
    return (
      <div className="market-streams-daily-calc-body">
        <div className="market-streams-daily-calc-title">Daily % / Daily $</div>
        <p className="market-streams-daily-calc-muted">No usable last price (quote last/mid). Add a live quote or refresh.</p>
      </div>
    )
  }

  if (base == null || !Number.isFinite(base) || base <= 0) {
    return (
      <div className="market-streams-daily-calc-body">
        <div className="market-streams-daily-calc-title">Daily % / Daily $ · {symbol}</div>
        <p className="market-streams-daily-calc-muted">
          No prior close: need position <code>daily_prev_close</code> or a benchmark row for this symbol.
        </p>
      </div>
    )
  }

  const diff = last - base
  const pctRaw = (diff / base) * 100
  const dollarRaw = qNum != null ? diff * qNum : null
  const fmt4 = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : '—')

  return (
    <div className="market-streams-daily-calc-body">
      <div className="market-streams-daily-calc-title">Daily % / Daily $ · {symbol}</div>
      <div className="market-streams-daily-calc-line">
        <strong>Base</strong> (prior close): {fmtUsd(base)} — {baseSource}
      </div>
      <div className="market-streams-daily-calc-line">
        <strong>Last</strong> (quote last or mid): {fmtUsd(last)}
      </div>
      <div className="market-streams-daily-calc-line">
        <strong>Qty</strong> (STK shares, all accounts, signed): {qNum ?? '—'}
      </div>
      <div className="market-streams-daily-calc-divider" />
      <div className="market-streams-daily-calc-line">Daily % = ((Last − Base) / Base) × 100</div>
      <div className="market-streams-daily-calc-line market-streams-daily-calc-mono">
        = (({fmt4(last)} − {fmt4(base)}) / {fmt4(base)}) × 100 = {fmt4(pctRaw)}%
      </div>
      <div className="market-streams-daily-calc-hint">The table shows the absolute % with color for direction.</div>
      <div className="market-streams-daily-calc-divider" />
      <div className="market-streams-daily-calc-line">Daily $ = (Last − Base) × Qty</div>
      <div className="market-streams-daily-calc-line market-streams-daily-calc-mono">
        = ({fmt4(last)} − {fmt4(base)}) × ({qNum ?? '—'}) = {dollarRaw != null && Number.isFinite(dollarRaw) ? fmtUsd(dollarRaw) : '—'}
      </div>
      <div className="market-streams-daily-calc-hint">The table shows the absolute dollar amount with color for direction.</div>
    </div>
  )
}

/** Tooltip text for Symbol: raw data used for Daily % / Daily $ (ref price, bar date). */
function getDailyRefTooltip(bench: DailyBenchmark | undefined, last: number | null | undefined): string {
  if (!bench || !Number.isFinite(bench.close) || bench.close <= 0) return ''
  const prevOk = bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0
  const ref = bench.is_today && prevOk ? bench.prev_close! : bench.close
  const refLabel = bench.is_today && prevOk ? 'prev close' : 'latest close'
  const barDate =
    Number.isFinite(bench.bar_time) && bench.bar_time > 0
      ? new Date(bench.bar_time * 1000).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '—'
  const lines: string[] = [`Daily % / Daily $ ref: ${fmtUsd(ref)} (${refLabel}), bar date: ${barDate}`]
  if (last != null && Number.isFinite(last)) lines.push(`Current last: ${fmtUsd(last)}`)
  return lines.join('\n')
}

/** Watchlist Options: format expiry for display (YYYYMMDD → YYYY-MM-DD). */
function formatExpiry(expiry: string | null | undefined): string {
  if (expiry == null || expiry === '') return '—'
  const s = String(expiry).trim()
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return s
}

/** Watchlist Options: C → CALL, P → PUT. */
function formatOptionRight(right: string | null | undefined): string {
  if (right == null || right === '') return '—'
  const r = String(right).trim().toUpperCase()
  if (r === 'C') return 'CALL'
  if (r === 'P') return 'PUT'
  return right
}

/** Watchlist Options: strike as USD. */
function formatStrike(strike: number | null | undefined): string {
  if (strike == null) return '—'
  const n = Number(strike)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(n)
}

/** Watchlist Options: Last + Bid/Ask spread vs Last (same as Watchlist page). */
function renderLastBidAskOption(q: RealtimeQuote | undefined): ReactNode {
  if (!q) return '—'
  const ref = quoteDisplayLast(q)
  const bid = q.bid != null && Number.isFinite(q.bid) ? q.bid : null
  const ask = q.ask != null && Number.isFinite(q.ask) ? q.ask : null
  const bidDiff = ref != null && bid != null ? bid - ref : null
  const askDiff = ref != null && ask != null ? ask - ref : null
  return (
    <>
      {ref != null ? fmtUsd(ref) : '—'}
      {bidDiff != null && (
        <span className={`realtime-quote-spread ${bidDiff > 0 ? 'pnl-positive' : bidDiff < 0 ? 'pnl-negative' : ''}`} title="Bid vs Last"> {Math.abs(bidDiff).toFixed(2)}</span>
      )}
      {askDiff != null && (
        <span className={`realtime-quote-spread ${askDiff > 0 ? 'pnl-positive' : askDiff < 0 ? 'pnl-negative' : ''}`} title="Ask vs Last"> {Math.abs(askDiff).toFixed(2)}</span>
      )}
    </>
  )
}

/** Watchlist Options: display label for one option item. */
function watchlistOptionLabel(item: WatchlistItem): string {
  if (item.display_label && String(item.display_label).trim()) return item.display_label.trim()
  if (item.sec_type === 'OPT' && item.symbol) {
    const exp = item.expiry || ''
    const right = item.option_right || ''
    const strike = item.strike != null ? String(item.strike) : ''
    return `${item.symbol} ${exp} ${right} ${strike}`.trim() || item.contract_key
  }
  return (item.symbol || item.contract_key || '').trim() || item.contract_key
}

/** Format qty for Qty / Filled/Rem: integer part bold+yellow, whole numbers add muted ".0". */
function fmtQtyWithMutedDecimal(v: number | string | null | undefined): ReactNode {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return '—'
  const num = Number(v)
  if (!Number.isFinite(num)) return '—'
  const intPart = Math.floor(num)
  const isWhole = Number.isInteger(num) || num === intPart
  if (isWhole) {
    return <><span className="open-order-qty-intrinsic">{intPart}</span><span className="decimal-muted">.0</span></>
  }
  return <><span className="open-order-qty-intrinsic">{intPart}</span><span className="decimal-muted">.{String(num).split('.')[1] ?? '0'}</span></>
}

export interface LivePageProps {
  status: StatusResponse | null
  /** Navigate to Strategy → Structure (Manage). */
  onNavigateToStrategy?: () => void
  /** Navigate to Settings → Subscribe (IB Event Subscribe). */
  onNavigateToSubscribe?: () => void
}

export function LivePage({ status, onNavigateToStrategy, onNavigateToSubscribe }: LivePageProps) {
  const j = status
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [quotesByContractKey, setQuotesByContractKey] = useState<Record<string, RealtimeQuote>>({})
  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  const [watchlistSymbolSet, setWatchlistSymbolSet] = useState<Set<string>>(new Set())
  /** STK (and non-OPT) watchlist rows — used to read Watchlist category (e.g. Watching). */
  const [watchlistStkItems, setWatchlistStkItems] = useState<WatchlistItem[]>([])
  const [watchlistOptionItems, setWatchlistOptionItems] = useState<WatchlistItem[]>([])
  const [freshnessTick, setFreshnessTick] = useState(0)
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  /** Custom category order (names). Empty = use default from API + data. */
  const [categoryOrder, setCategoryOrder] = useState<string[]>([])
  /** Symbol order per category (from DB; fallback localStorage). */
  const [symbolOrderByCategory, setSymbolOrderByCategory] = useState<Record<string, string[]>>(loadSymbolOrderFromStorage)
  /** Custom order for Options position rows in drag mode (list of basisKeys: `accId\tcontract_key`). */
  const [optRowOrder, setOptRowOrder] = useState<string[]>(loadOptRowOrderFromStorage)
  const [categoryOrderSaving, setCategoryOrderSaving] = useState(false)
  const [streamSyncFeedback, setStreamSyncFeedback] = useState<string | null>(null)
  const [msSortMode, setMsSortMode] = useState<MarketStreamsSortMode>(1)
  /** Open orders: from status (DB) + dedicated poll for live updates. */
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([])
  const [openOrdersUpdatedAt, setOpenOrdersUpdatedAt] = useState<number | null>(null)
  useEffect(() => {
    const id = setInterval(() => setFreshnessTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    let cancelled = false
    fetchWatchlist()
      .then((res) => {
        if (cancelled) return
        const set = new Set<string>()
        const items = res.items ?? []
        const stkItems: WatchlistItem[] = []
        for (const w of items) {
          const sym = (w.symbol ?? '').trim()
          const st = (w.sec_type ?? '').toString().toUpperCase()
          if (sym && (st === 'STK' || !st)) {
            set.add(sym.toUpperCase())
            if (st !== 'OPT') stkItems.push(w)
          }
        }
        setWatchlistSymbolSet(set)
        setWatchlistStkItems(stkItems)
        setWatchlistOptionItems(items.filter((w) => (w.sec_type ?? '').toString().toUpperCase() === 'OPT'))
      })
      .catch(() => {
        if (!cancelled) setWatchlistSymbolSet(new Set())
        if (!cancelled) setWatchlistStkItems([])
        if (!cancelled) setWatchlistOptionItems([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchPositionCategories()
      .then((r) => {
        if (!cancelled) setPositionCategories(r.items ?? [])
      })
      .catch(() => {
        if (!cancelled) setPositionCategories([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchMarketStreamsSymbolOrder()
      .then((res) => {
        if (!cancelled && res.ok && res.order && Object.keys(res.order).length > 0) {
          setSymbolOrderByCategory(res.order)
        }
      })
      .catch(() => { /* keep localStorage fallback */ })
    return () => { cancelled = true }
  }, [])

  // Open orders: sync from status (parent poll) and dedicated poll from DB
  useEffect(() => {
    const list = j?.portfolio?.open_orders ?? []
    setOpenOrders(list)
  }, [j?.portfolio?.open_orders])
  useEffect(() => {
    const poll = () => {
      fetchOpenOrders()
        .then((res) => {
          setOpenOrders(res.open_orders ?? [])
          setOpenOrdersUpdatedAt(Date.now() / 1000)
        })
        .catch(() => { /* keep previous */ })
    }
    poll()
    const id = setInterval(poll, 6000)
    return () => clearInterval(id)
  }, [])

  const accountsList = j?.portfolio?.accounts ?? []

  const optPositionRows = useMemo(() => {
    const rows: OptPositionRow[] = []
    const seen = new Set<string>()
    for (const acc of accountsList) {
      const accId = (acc?.account_id ?? (acc as { account?: string }).account ?? '').toString().trim()
      if (!accId) continue
      for (const p of (acc?.positions ?? [])) {
        const secType = (p.secType ?? '').toString().toUpperCase()
        if (secType !== 'OPT') continue
        const ck = (p.contract_key ?? '').trim()
        const qty = typeof p.position === 'number' ? p.position : 0
        if (!ck || qty === 0) continue
        const dedupeKey = `${accId.toLowerCase()}|${ck}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        rows.push({
          account_id: accId,
          contract_key: ck,
          symbol: p.symbol ?? '',
          expiry: p.expiry ?? '',
          strike: Number(p.strike ?? 0),
          right: p.right ?? '',
          qty,
          avg_cost: p.avgCost != null ? Number(p.avgCost) : null,
        })
      }
    }
    return rows
  }, [accountsList])

  const optPositionsExecFetchKey = useMemo(
    () => optPositionRows.map((r) => `${r.account_id}\t${r.contract_key}`).sort().join(';'),
    [optPositionRows],
  )

  const [optionAccountExecutions, setOptionAccountExecutions] = useState<Execution[]>([])
  useEffect(() => {
    const ids = [...new Set(optPositionRows.map((r) => r.account_id).filter(Boolean))]
    if (ids.length === 0) {
      setOptionAccountExecutions([])
      return
    }
    let cancelled = false
    Promise.all(
      ids.map((aid) =>
        fetchExecutions(undefined, undefined, 10000, false, undefined, undefined, undefined, aid).then((r) => r.executions ?? []),
      ),
    )
      .then((lists) => {
        if (!cancelled) setOptionAccountExecutions(lists.flat())
      })
      .catch(() => {
        if (!cancelled) setOptionAccountExecutions([])
      })
    return () => {
      cancelled = true
    }
  }, [optPositionsExecFetchKey])

  const optionLiveBasisByRow = useMemo(() => {
    const m = new Map<string, { avgPerShare: number | null; basisSource: 'flex_trades' | 'tws_client' | null }>()
    for (const row of optPositionRows) {
      const k = `${row.account_id.toLowerCase()}\t${row.contract_key}`
      m.set(
        k,
        computeOptionLiveAvgPerShareFromExecutions(optionAccountExecutions, row.account_id, row.contract_key, row.qty),
      )
    }
    return m
  }, [optPositionRows, optionAccountExecutions])

  // Host/Secondary account IDs from Settings → IB Connection → Event Account (config.ib_client.account.*).
  // No hardcoded account IDs: read from status (backend reads from DB settings), then match against accountsList[].account_id.
  const ibAcct = j?.config?.ib_client?.account
  const streamHostId = (ibAcct?.event_host ?? '').trim() || null
  const streamSecondaryId = (ibAcct?.event_secondary ?? '').trim() || null
  const hasStreamAccounts = streamHostId != null || streamSecondaryId != null

  const streamPositionSymbols = useMemo(() => {
    const host: string[] = []
    const secondary: string[] = []
    const norm = (id: string | null) => (id ?? '').trim().toLowerCase() || ''
    const wantHost = norm(streamHostId)
    const wantSecondary = norm(streamSecondaryId)
    for (const acc of accountsList) {
      const accId = (acc?.account_id ?? (acc as { account?: string }).account ?? '').toString().trim()
      const accIdNorm = norm(accId)
      const positions = acc?.positions ?? []
      for (const p of positions) {
        const sym = (p.symbol ?? '').trim()
        const secType = (p.secType ?? '').toString().toUpperCase()
        const posQty = typeof p.position === 'number' ? p.position : 0
        if (!sym || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
        if (wantHost && accIdNorm === wantHost && !host.includes(sym)) host.push(sym)
        if (wantSecondary && accIdNorm === wantSecondary && !secondary.includes(sym)) secondary.push(sym)
      }
    }
    return { host, secondary }
  }, [accountsList, streamHostId, streamSecondaryId])

  // Market Streams symbol list: show symbol if it appears in ANY of Wishlist, Host, or Secondary.
  const watchlistSymbols = useMemo(
    () =>
      [
        ...new Set([
          ...(j?.live_ui?.subscribed_tickers ?? []),
          ...streamPositionSymbols.host,
          ...streamPositionSymbols.secondary,
          ...Object.keys(quotesMap),
        ]),
      ].sort(),
    [j?.live_ui?.subscribed_tickers, streamPositionSymbols.host, streamPositionSymbols.secondary, quotesMap],
  )
  const benchmarkSymbols = useMemo(
    () =>
      [
        ...new Set([
          ...watchlistSymbols,
          ...(j?.live_ui?.reference_indices?.map((r: { symbol: string }) => r.symbol) ?? []),
        ]),
      ].sort(),
    [watchlistSymbols, j?.live_ui?.reference_indices],
  )

  useEffect(() => {
    if (benchmarkSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((r) => {
        if (!cancelled) setBenchmarks(normalizeBenchmarkMap(r.benchmarks))
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkSymbols.join(',')])

  const mergeQuotes = useCallback((quotes: RealtimeQuote[]) => {
    const nextByCk: Record<string, RealtimeQuote> = {}
    for (const q of quotes) {
      if (q.contract_key) {
        nextByCk[q.contract_key] = q
      }
    }
    setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, quotes))
    setQuotesByContractKey((prev) => ({ ...prev, ...nextByCk }))
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) mergeQuotes(res.quotes)
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      mergeQuotes([q])
    })
    const pollId = setInterval(() => {
      fetchQuotes()
        .then((res) => {
          if (!cancelled && res.quotes?.length) mergeQuotes(res.quotes)
        })
        .catch(() => {})
    }, 8000)
    return () => {
      cancelled = true
      unsub()
      clearInterval(pollId)
    }
  }, [mergeQuotes])

  /** Market Streams lamp: shared with App dashboard strip + Live nav (see livePageLamps). */
  const marketStreamsOk = useMemo(
    () => computeMarketStreamsOk(j, quotesMap),
    [j, quotesMap, freshnessTick],
  )
  const accountSyncLamp = useMemo(() => computeAccountSyncLamp(j), [j, freshnessTick])
  const openOrdersSectionOk = useMemo(
    () => computeOpenOrdersSectionOk(j, Date.now() / 1000),
    [j, freshnessTick],
  )

  const subscribedSet = useMemo(
    () =>
      new Set(
        (j?.live_ui?.subscribed_tickers ?? [])
          .map((s: string) => (s && typeof s === 'string' ? s.trim().toUpperCase() : ''))
          .filter(Boolean)
      ),
    [j?.live_ui?.subscribed_tickers]
  )
  const norm = (id: string | null) => (id ?? '').trim().toLowerCase() || ''
  const wantHost = norm(streamHostId)
  const wantSecondary = norm(streamSecondaryId)
  const wishlistSet = watchlistSymbolSet.size > 0 ? watchlistSymbolSet : subscribedSet
  const watchlistRows: MarketStreamsRow[] = watchlistSymbols.map((symbol) => {
    let qty = 0
    let totalCost = 0
    let hasCost = false
    let hostQty = 0
    let hostTotalCost = 0
    let hostHasCost = false
    let secondaryQty = 0
    let secondaryTotalCost = 0
    let secondaryHasCost = false
    let positionCategory = 'Uncategorized'
    const accountIdsWithSymbol: string[] = []
    let positionDailyPrevClose: number | null = null
    let positionDailyPrevClosePickWeight = -1
    for (const acc of accountsList) {
      const accId = (acc?.account_id ?? (acc as { account?: string }).account ?? '').toString().trim()
      const accIdNorm = norm(accId)
      const isAccHost = wantHost && accIdNorm === wantHost
      const isAccSecondary = wantSecondary && accIdNorm === wantSecondary
      const positions = acc?.positions ?? []
      for (const p of positions) {
        const sym = (p.symbol ?? '').trim()
        const secType = (p.secType ?? '').toString().toUpperCase()
        const posQty = typeof p.position === 'number' ? p.position : 0
        if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
        const absQ = Math.abs(posQty)
        const dpcRaw = p.daily_prev_close
        const dpc =
          dpcRaw != null && Number.isFinite(Number(dpcRaw)) && Number(dpcRaw) > 0 ? Number(dpcRaw) : null
        if (dpc != null && absQ > positionDailyPrevClosePickWeight) {
          positionDailyPrevClose = dpc
          positionDailyPrevClosePickWeight = absQ
        }
        if (positionCategory === 'Uncategorized' && p.category && String(p.category).trim()) {
          positionCategory = String(p.category).trim()
        }
        if (accId && !accountIdsWithSymbol.includes(accId)) accountIdsWithSymbol.push(accId)
        qty += posQty
        const avg = p.avgCost != null && Number.isFinite(p.avgCost as number) ? (p.avgCost as number) : null
        if (avg != null) {
          totalCost += avg * posQty
          hasCost = true
        }
        if (isAccHost) {
          hostQty += posQty
          if (avg != null) {
            hostTotalCost += avg * posQty
            hostHasCost = true
          }
        }
        if (isAccSecondary) {
          secondaryQty += posQty
          if (avg != null) {
            secondaryTotalCost += avg * posQty
            secondaryHasCost = true
          }
        }
      }
    }
    let streamCategory: 'host' | 'secondary' | 'both' | null = null
    if (hasStreamAccounts && accountIdsWithSymbol.length > 0) {
      const isHost = wantHost ? accountIdsWithSymbol.some((id) => norm(id) === wantHost) : false
      const isSecondary = wantSecondary ? accountIdsWithSymbol.some((id) => norm(id) === wantSecondary) : false
      if (isHost && isSecondary) streamCategory = 'both'
      else if (isHost) streamCategory = 'host'
      else if (isSecondary) streamCategory = 'secondary'
    }
    const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
    const hostAvgCost = hostHasCost && hostQty !== 0 ? hostTotalCost / hostQty : null
    const secondaryAvgCost = secondaryHasCost && secondaryQty !== 0 ? secondaryTotalCost / secondaryQty : null
    const symKey = (symbol || '').trim().toUpperCase()
    const quote = quotesMap[symKey] ?? quotesMap[symbol]
    const bench = benchmarks[symKey]
    const { changePct, pnlVsBench } = computeDailyChange(
      bench,
      quoteDisplayLast(quote),
      qty ?? 0,
      positionDailyPrevClose,
    )
    const lastVal = quoteDisplayLast(quote)
    const pnlCost =
      lastVal != null && avgCost != null && qty != null && Number.isFinite(qty) && qty !== 0
        ? (lastVal - avgCost) * qty
        : null
    const hostPnlCost =
      lastVal != null && hostAvgCost != null && hostQty !== 0
        ? (lastVal - hostAvgCost) * hostQty
        : null
    const secondaryPnlCost =
      lastVal != null && secondaryAvgCost != null && secondaryQty !== 0
        ? (lastVal - secondaryAvgCost) * secondaryQty
        : null
    const isInWatchlist = wishlistSet.has((symbol || '').trim().toUpperCase())
    return {
      symbol,
      quote,
      qty: qty || null,
      avgCost,
      changePct,
      pnlVsBench,
      pnlCost,
      streamCategory,
      isInWatchlist,
      category: positionCategory,
      hostQty: hostQty || null,
      hostAvgCost,
      hostPnlCost,
      secondaryQty: secondaryQty || null,
      secondaryAvgCost,
      secondaryPnlCost,
      positionDailyPrevClose,
    }
  })

  const watchlistStkBySymbol = useMemo(() => {
    const m = new Map<string, WatchlistItem>()
    for (const w of watchlistStkItems) {
      const sym = (w.symbol ?? '').trim().toUpperCase()
      if (sym) m.set(sym, w)
    }
    return m
  }, [watchlistStkItems])

  /** STK rows for Market Streams vs Watching Stocks (Watchlist category Watching uses IB quote row but not position category). */
  const { marketStreamsRows, watchingTickerRows } = useMemo(() => {
    const watching: MarketStreamsRow[] = []
    const rest: MarketStreamsRow[] = []
    for (const r of watchlistRows) {
      const sym = (r.symbol || '').trim().toUpperCase()
      const wl = watchlistStkBySymbol.get(sym)
      if (wl && isWatchlistStockCategoryWatching(wl.category)) {
        watching.push({ ...r, category: 'Watching' })
      } else {
        rest.push(r)
      }
    }
    return { watchingTickerRows: watching, marketStreamsRows: rest }
  }, [watchlistRows, watchlistStkBySymbol])

  const watchingTickerRowsSorted = useMemo(
    () => [...watchingTickerRows].sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, 1)),
    [watchingTickerRows],
  )

  /** Empty set = no filter (show all). OR when Host + Secondary both selected. */
  const [streamAccountFilters, setStreamAccountFilters] = useState<Set<'host' | 'secondary'>>(() => new Set())
  const toggleStreamAccountFilter = useCallback((key: 'host' | 'secondary') => {
    setStreamAccountFilters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** Empty set = all categories. */
  const [positionCategoryFilters, setPositionCategoryFilters] = useState<Set<string>>(() => new Set())
  const togglePositionCategoryFilter = useCallback((cat: string) => {
    setPositionCategoryFilters((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  const filteredByAccount = useMemo(() => {
    if (!hasStreamAccounts) return marketStreamsRows
    if (streamAccountFilters.size === 0) return marketStreamsRows
    return marketStreamsRows.filter((row) => {
      if (streamAccountFilters.has('host') && (row.streamCategory === 'host' || row.streamCategory === 'both')) return true
      if (streamAccountFilters.has('secondary') && (row.streamCategory === 'secondary' || row.streamCategory === 'both')) return true
      return false
    })
  }, [marketStreamsRows, hasStreamAccounts, streamAccountFilters])
  const filteredRows = useMemo(() => {
    if (positionCategoryFilters.size === 0) return filteredByAccount
    return filteredByAccount.filter((row) => positionCategoryFilters.has(row.category))
  }, [filteredByAccount, positionCategoryFilters])

  const marketStreamsDailyTotals = useMemo(
    () => aggregateMarketStreamsDailyTotals(filteredRows, benchmarks),
    [filteredRows, benchmarks],
  )

  /** Pre-computed summary for the top bar (SINCE $ / % and DAILY $ / %). */
  const streamsSummary = useMemo(() => {
    const totalCostPnl = filteredRows.reduce((a, r) => a + (r.pnlCost != null && Number.isFinite(r.pnlCost) ? r.pnlCost : 0), 0)
    const totalCost = filteredRows.reduce((a, r) => {
      const q = r.qty != null && Number.isFinite(r.qty) ? r.qty : 0
      const c = r.avgCost != null && Number.isFinite(r.avgCost) ? r.avgCost : 0
      return a + q * c
    }, 0)
    const sincePct = totalCost > 0 && Number.isFinite(totalCostPnl) ? (totalCostPnl / totalCost) * 100 : null
    const { totalDailyDollar, totalDailyPct } = marketStreamsDailyTotals
    return { totalCostPnl, sincePct, totalDailyDollar, totalDailyPct }
  }, [filteredRows, marketStreamsDailyTotals])

  /** Category names that appear in data. */
  const categoryNamesFromData = useMemo(() => {
    const set = new Set<string>()
    marketStreamsRows.forEach((row) => set.add(row.category))
    return Array.from(set)
  }, [marketStreamsRows])

  /** Default category order: Uncategorized first, then API categories by sort_order, then data-only names alphabetical. */
  const defaultCategoryOrder = useMemo(() => {
    const apiNames = new Set(positionCategories.map((c) => c.name))
    const apiOrdered = [...positionCategories]
      .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
      .map((c) => c.name)
    const dataOnly = categoryNamesFromData.filter((n) => n !== 'Uncategorized' && !apiNames.has(n)).sort((a, b) => a.localeCompare(b))
    const uncategorizedFirst = categoryNamesFromData.includes('Uncategorized') ? ['Uncategorized'] : []
    return [...uncategorizedFirst, ...apiOrdered.filter((n) => categoryNamesFromData.includes(n)), ...dataOnly]
  }, [positionCategories, categoryNamesFromData])

  /** Display order: user's categoryOrder if set, else default; append any new data categories. */
  const streamCategoryOrder = useMemo(() => {
    const base = categoryOrder.length > 0 ? [...categoryOrder] : [...defaultCategoryOrder]
    const set = new Set(base)
    for (const c of categoryNamesFromData) {
      if (!set.has(c)) {
        base.push(c)
        set.add(c)
      }
    }
    return base
  }, [categoryOrder, defaultCategoryOrder, categoryNamesFromData])

  /** Initialize categoryOrder from default once we have data (do not overwrite user order). */
  useEffect(() => {
    if (defaultCategoryOrder.length > 0 && categoryOrder.length === 0) {
      setCategoryOrder(defaultCategoryOrder)
    }
  }, [defaultCategoryOrder, categoryOrder.length])

  const persistCategoryOrder = useCallback(async (ordered: string[]) => {
    const orderWithoutUncat = ordered.filter((c) => c !== 'Uncategorized')
    const nameToOrder = new Map(orderWithoutUncat.map((name, i) => [name, i]))
    setCategoryOrderSaving(true)
    try {
      for (const cat of positionCategories) {
        const idx = nameToOrder.get(cat.name)
        const desired = idx ?? 999
        const current = cat.sort_order ?? 999
        if (desired !== current) {
          await patchPositionCategory(cat.id, { sort_order: desired })
        }
      }
      setCategoryOrder(ordered)
    } finally {
      setCategoryOrderSaving(false)
    }
  }, [positionCategories])

  const handleCategoryDragStart = useCallback((e: React.DragEvent, cat: string) => {
    e.dataTransfer.setData('text/plain', cat)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-market-streams-category', cat)
  }, [])

  const handleCategoryDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleCategoryDrop = useCallback(
    (e: React.DragEvent, dropTargetCat: string) => {
      e.preventDefault()
      const dragged = e.dataTransfer.getData('application/x-market-streams-category')
      if (!dragged || dragged === dropTargetCat) return
      const current = categoryOrder.length > 0 ? categoryOrder : defaultCategoryOrder
      const fromIdx = current.indexOf(dragged)
      const toIdx = current.indexOf(dropTargetCat)
      if (fromIdx === -1 || toIdx === -1) return
      const next = [...current]
      next.splice(fromIdx, 1)
      next.splice(next.indexOf(dropTargetCat), 0, dragged)
      persistCategoryOrder(next)
    },
    [categoryOrder, defaultCategoryOrder, persistCategoryOrder],
  )

  /** Group filtered rows by category for table sections. */
  const rowsByCategory = useMemo(() => {
    const map: Record<string, typeof filteredRows> = {}
    for (const row of filteredRows) {
      const cat = row.category
      if (!map[cat]) map[cat] = []
      map[cat].push(row)
    }
    return map
  }, [filteredRows])

  /** Rows per category sorted by symbol order (localStorage). Symbols not in order list appended at end. */
  const sortedRowsByCategory = useMemo(() => {
    const out: Record<string, typeof filteredRows> = {}
    for (const cat of Object.keys(rowsByCategory)) {
      const rows = rowsByCategory[cat]
      const order = symbolOrderByCategory[cat]
      if (!order || order.length === 0) {
        out[cat] = [...rows]
        continue
      }
      const orderSet = new Set(order)
      const inOrder: typeof rows = []
      const rest: typeof rows = []
      for (const sym of order) {
        const row = rows.find((r) => r.symbol === sym)
        if (row) inOrder.push(row)
      }
      for (const row of rows) {
        if (!orderSet.has(row.symbol)) rest.push(row)
      }
      out[cat] = [...inOrder, ...rest]
    }
    return out
  }, [rowsByCategory, symbolOrderByCategory])

  const categoryOrderFiltered = useMemo(() => {
    const keys = Object.keys(rowsByCategory)
    keys.sort((a, b) => {
      const orderA = streamCategoryOrder.indexOf(a)
      const orderB = streamCategoryOrder.indexOf(b)
      if (orderA !== -1 && orderB !== -1) return orderA - orderB
      if (a === 'Uncategorized') return -1
      if (b === 'Uncategorized') return 1
      return a.localeCompare(b)
    })
    return keys
  }, [rowsByCategory, streamCategoryOrder])

  const applySymbolReorder = useCallback((cat: string, fromSymbol: string, toSymbol: string) => {
    const rows = rowsByCategory[cat]
    if (!rows || rows.length < 2 || fromSymbol === toSymbol) return
    const order = symbolOrderByCategory[cat] ?? rows.map((r) => r.symbol)
    const fromIdx = order.indexOf(fromSymbol)
    const toIdx = order.indexOf(toSymbol)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...order]
    next.splice(fromIdx, 1)
    const newToIdx = next.indexOf(toSymbol)
    if (newToIdx === -1) return
    next.splice(newToIdx, 0, fromSymbol)
    const nextByCat = { ...symbolOrderByCategory, [cat]: next }
    setSymbolOrderByCategory(nextByCat)
    saveSymbolOrderToStorage(nextByCat)
    putMarketStreamsSymbolOrder(cat, next).catch(() => { /* DB failed; localStorage already updated */ })
  }, [rowsByCategory, symbolOrderByCategory])

  const applyOptRowReorder = useCallback((fromBasisKey: string, toBasisKey: string) => {
    if (fromBasisKey === toBasisKey) return
    const allBasisKeys = optPositionRows.map((r) => `${r.account_id.toLowerCase()}\t${r.contract_key}`)
    const knownOrder = optRowOrder.filter((k) => allBasisKeys.includes(k))
    const rest = allBasisKeys.filter((k) => !knownOrder.includes(k))
    const current = [...knownOrder, ...rest]
    const fromIdx = current.indexOf(fromBasisKey)
    const toIdx = current.indexOf(toBasisKey)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...current]
    next.splice(fromIdx, 1)
    const newToIdx = next.indexOf(toBasisKey)
    if (newToIdx === -1) return
    next.splice(newToIdx, 0, fromBasisKey)
    setOptRowOrder(next)
    saveOptRowOrderToStorage(next)
  }, [optPositionRows, optRowOrder])

  const sortedOptRows = useMemo(() => {
    const sorted = sortOptRowsAlpha(optPositionRows, 1)
    if (msSortMode !== 1) return sorted
    const basisKeyOf = (r: OptPositionRow) => `${r.account_id.toLowerCase()}\t${r.contract_key}`
    const knownOrder = optRowOrder.filter((k) => sorted.some((r) => basisKeyOf(r) === k))
    if (knownOrder.length === 0) return sorted
    const rowByBasisKey = new Map(sorted.map((r) => [basisKeyOf(r), r]))
    const inOrder = knownOrder.map((k) => rowByBasisKey.get(k)).filter((r): r is OptPositionRow => r != null)
    const rest = sorted.filter((r) => !knownOrder.includes(basisKeyOf(r)))
    return [...inOrder, ...rest]
  }, [optPositionRows, optRowOrder, msSortMode])

  /** Mode 1 = null (category + drag for STK, OPT appended). Modes 2–9 = unified sorted/grouped STK+OPT. */
  const unifiedGroupedRows = useMemo((): LiveSortGroupMs[] | null => {
    if (msSortMode === 1) return null

    const stkRows = [...filteredRows]
    const optRows = [...optPositionRows]

    const basisFor = (row: OptPositionRow) =>
      optionLiveBasisByRow.get(`${row.account_id.toLowerCase()}\t${row.contract_key}`)
    const sumOptPnl = (rows: OptPositionRow[]) =>
      rows.reduce((acc, row) => {
        const { livePnl } = computeOptMidAndLivePnl(row, quotesByContractKey[row.contract_key], basisFor(row))
        return acc + (livePnl != null && Number.isFinite(livePnl) ? livePnl : 0)
      }, 0)

    const grp = (label: string, show: boolean, stk: MarketStreamsRow[], opt: OptPositionRow[]): LiveSortGroupMs => ({
      label,
      showGroupHeader: show,
      stkRows: stk,
      optRows: opt,
      totalPnl: sumFiniteMsPnl(stk) + sumOptPnl(opt),
    })

    const sortStk = (rows: MarketStreamsRow[], dir: 1 | -1) =>
      [...rows].sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, dir))
    const sortOpt = (rows: OptPositionRow[], dir: 1 | -1) => sortOptRowsAlpha(rows, dir)

    if (msSortMode === 2) {
      return [grp('', false, sortStk(stkRows, 1), sortOpt(optRows, 1))]
    }
    if (msSortMode === 3) {
      return [grp('', false, sortStk(stkRows, -1), sortOpt(optRows, -1))]
    }
    if (msSortMode === 4) {
      // T+ ↑: Stocks first, Options second
      const out: LiveSortGroupMs[] = []
      if (stkRows.length) out.push(grp('Total Stocks', true, sortStk(stkRows, 1), []))
      if (optRows.length) out.push(grp('Total Options', true, [], sortOpt(optRows, 1)))
      return out.length ? out : [grp('', false, stkRows, optRows)]
    }
    if (msSortMode === 5) {
      // T+ ↓: Options first, Stocks second
      const out: LiveSortGroupMs[] = []
      if (optRows.length) out.push(grp('Total Options', true, [], sortOpt(optRows, -1)))
      if (stkRows.length) out.push(grp('Total Stocks', true, sortStk(stkRows, -1), []))
      return out.length ? out : [grp('', false, stkRows, optRows)]
    }
    if (msSortMode === 6) {
      // T+S+ ↑: Long Stocks → Short Options → Short Stocks → Long Options (gamma scalp view)
      const longStk = stkRows.filter((r) => (r.qty ?? 0) > 0)
      const shortStk = stkRows.filter((r) => (r.qty ?? 0) < 0)
      const flatStk = stkRows.filter((r) => !(r.qty ?? 0))
      const shortOpt = optRows.filter((r) => r.qty < 0)
      const longOpt = optRows.filter((r) => r.qty > 0)
      const out: LiveSortGroupMs[] = []
      if (longStk.length) out.push(grp('Total Long Stocks', true, sortStk(longStk, 1), []))
      if (shortOpt.length) out.push(grp('Total Short Options', true, [], sortOpt(shortOpt, 1)))
      if (shortStk.length) out.push(grp('Total Short Stocks', true, sortStk(shortStk, 1), []))
      if (longOpt.length) out.push(grp('Total Long Options', true, [], sortOpt(longOpt, 1)))
      if (flatStk.length) out.push(grp('No position', true, sortStk(flatStk, 1), []))
      return out.length ? out : [grp('', false, stkRows, optRows)]
    }
    if (msSortMode === 7) {
      // T+S+ ↓: Short Options → Long Stocks → Long Options → Short Stocks
      const longStk = stkRows.filter((r) => (r.qty ?? 0) > 0)
      const shortStk = stkRows.filter((r) => (r.qty ?? 0) < 0)
      const shortOpt = optRows.filter((r) => r.qty < 0)
      const longOpt = optRows.filter((r) => r.qty > 0)
      const out: LiveSortGroupMs[] = []
      if (shortOpt.length) out.push(grp('Total Short Options', true, [], sortOpt(shortOpt, -1)))
      if (longStk.length) out.push(grp('Total Long Stocks', true, sortStk(longStk, -1), []))
      if (longOpt.length) out.push(grp('Total Long Options', true, [], sortOpt(longOpt, -1)))
      if (shortStk.length) out.push(grp('Total Short Stocks', true, sortStk(shortStk, -1), []))
      return out.length ? out : [grp('', false, stkRows, optRows)]
    }
    if (msSortMode === 8 || msSortMode === 9) {
      // E+ ↑/↓: Stocks group, then OPT groups by expiry
      const dir: 1 | -1 = msSortMode === 8 ? 1 : -1
      const out: LiveSortGroupMs[] = []
      if (stkRows.length) out.push(grp('Stocks', true, sortStk(stkRows, dir), []))
      const expMap = new Map<string, OptPositionRow[]>()
      for (const r of optRows) {
        const k = String(r.expiry ?? '').trim() || 'Other'
        if (!expMap.has(k)) expMap.set(k, [])
        expMap.get(k)!.push(r)
      }
      const keys = Array.from(expMap.keys()).sort((a, b) => {
        const ka = expiryDigitsToSortKey(a)
        const kb = expiryDigitsToSortKey(b)
        if (ka !== kb) return dir === 1 ? ka - kb : kb - ka
        return a.localeCompare(b)
      })
      for (const k of keys) {
        out.push(grp(formatExpiryIbGroupLabel(k), true, [], sortOpt(expMap.get(k) ?? [], dir)))
      }
      return out.length ? out : [grp('', false, stkRows, optRows)]
    }
    return null
  }, [filteredRows, optPositionRows, msSortMode, quotesByContractKey, optionLiveBasisByRow])

  const msColSpan = hasStreamAccounts ? 12 : 6
  const msDragEnabled = msSortMode === 1
  const msHeaderMeta = marketStreamsSortHeaderMeta(msSortMode)
  const msHeaderAccentClass = marketStreamsSortHeaderAccentClass(msSortMode)

  const renderMarketStreamRow = useCallback(
    (row: MarketStreamsRow, categoryForDrag: string, dragEnabled: boolean, watchingStocksSlim = false) => {
      const {
        symbol,
        quote: q,
        qty,
        avgCost,
        changePct,
        pnlVsBench,
        pnlCost,
        hostQty,
        hostAvgCost,
        hostPnlCost,
        secondaryQty,
        secondaryAvgCost,
        secondaryPnlCost,
        positionDailyPrevClose,
      } = row
      const symbolFreshness = getQuoteFreshness(q?.ts)
      const symBench = benchmarks[(symbol || '').trim().toUpperCase()]
      const dailyLast = quoteDisplayLast(q)
      return (
        <tr
          key={row.symbol}
          onDragOver={dragEnabled ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } : undefined}
          onDrop={
            dragEnabled
              ? (e) => {
                  e.preventDefault()
                  try {
                    const raw = e.dataTransfer.getData('application/x-market-streams-symbol')
                    if (!raw) return
                    const { category: fromCat, symbol: fromSymbol } = JSON.parse(raw) as { category: string; symbol: string }
                    if (fromCat === categoryForDrag && fromSymbol !== row.symbol) applySymbolReorder(categoryForDrag, fromSymbol, row.symbol)
                  } catch {
                    /* ignore */
                  }
                }
              : undefined
          }
        >
          <td
            className={symbolFreshness ? `realtime-quote-symbol realtime-quote-symbol-${symbolFreshness}` : 'realtime-quote-symbol'}
            title={[
              q?.ts != null ? `Last update ${symbolFreshness === 'fresh' ? '<3s ago' : symbolFreshness === 'stale' ? '3–10s ago' : '>10s ago'}` : null,
              getDailyRefTooltip(benchmarks[(symbol || '').trim().toUpperCase()], quoteDisplayLast(q)),
            ]
              .filter(Boolean)
              .join('\n') || undefined}
          >
            {dragEnabled ? (
              <span
                className="realtime-quote-drag-handle"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-market-streams-symbol', JSON.stringify({ category: categoryForDrag, symbol: row.symbol }))
                  e.dataTransfer.effectAllowed = 'move'
                }}
                title="Drag to reorder symbol"
                aria-hidden
              >
                ⋮⋮
              </span>
            ) : null}
            <strong>{symbol}</strong>
          </td>
          {!watchingStocksSlim && hasStreamAccounts && (
            <>
              <td className="realtime-quote-num">{hostQty != null && Number.isFinite(hostQty) ? hostQty : '—'}</td>
              <td className="realtime-quote-num">{hostAvgCost != null && Number.isFinite(hostAvgCost) ? fmtUsd(hostAvgCost) : '—'}</td>
              <td className="realtime-quote-num">
                {hostPnlCost != null && Number.isFinite(hostPnlCost) ? (
                  <span className={hostPnlCost > 0 ? 'pnl-positive' : hostPnlCost < 0 ? 'pnl-negative' : ''}>
                    {fmtUsdRound0(hostPnlCost)}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td className="realtime-quote-num">{secondaryQty != null && Number.isFinite(secondaryQty) ? secondaryQty : '—'}</td>
              <td className="realtime-quote-num">{secondaryAvgCost != null && Number.isFinite(secondaryAvgCost) ? fmtUsd(secondaryAvgCost) : '—'}</td>
              <td className="realtime-quote-num">
                {secondaryPnlCost != null && Number.isFinite(secondaryPnlCost) ? (
                  <span className={secondaryPnlCost > 0 ? 'pnl-positive' : secondaryPnlCost < 0 ? 'pnl-negative' : ''}>
                    {fmtUsdRound0(secondaryPnlCost)}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </>
          )}
          {!watchingStocksSlim && (
            <>
              <td className="realtime-quote-num">{qty != null && Number.isFinite(qty) ? qty : '—'}</td>
              <td className="realtime-quote-num">{avgCost != null && Number.isFinite(avgCost) ? fmtUsd(avgCost) : '—'}</td>
            </>
          )}
          <td className="realtime-quote-num realtime-quote-last-bid-ask">
            {q ? (() => {
              const displayLast = quoteDisplayLast(q)
              const bid = q.bid != null && Number.isFinite(q.bid) ? q.bid : null
              const ask = q.ask != null && Number.isFinite(q.ask) ? q.ask : null
              const bidDiff = displayLast != null && bid != null ? bid - displayLast : null
              const askDiff = displayLast != null && ask != null ? ask - displayLast : null
              const bench = benchmarks[(symbol || '').trim().toUpperCase()]
              const prevClose = bench && (bench.prev_close != null && Number.isFinite(bench.prev_close))
                ? bench.prev_close
                : (bench && Number.isFinite(bench.close) ? bench.close : null)
              const lastVsPrev = displayLast != null && prevClose != null && prevClose > 0
                ? (displayLast > prevClose ? 'pnl-positive' : displayLast < prevClose ? 'pnl-negative' : '')
                : ''
              return (
                <>
                  {displayLast != null ? (
                    <span className={lastVsPrev}>{fmtUsd(displayLast)}</span>
                  ) : '—'}
                  {bidDiff != null && (
                    <span className={`realtime-quote-spread ${bidDiff > 0 ? 'pnl-positive' : bidDiff < 0 ? 'pnl-negative' : ''}`} title="Bid vs Last"> {Math.abs(bidDiff).toFixed(2)}</span>
                  )}
                  {askDiff != null && (
                    <span className={`realtime-quote-spread ${askDiff > 0 ? 'pnl-positive' : askDiff < 0 ? 'pnl-negative' : ''}`} title="Ask vs Last"> {Math.abs(askDiff).toFixed(2)}</span>
                  )}
                </>
              )
            })() : '—'}
          </td>
          <td className="realtime-quote-num realtime-quote-pnl-stacked market-streams-daily-calc-cell">
            <span className="realtime-quote-pnl-stacked-line">
              {changePct != null && Number.isFinite(changePct) ? (
                <span className={changePct > 0 ? 'pnl-positive' : changePct < 0 ? 'pnl-negative' : ''}>
                  {Math.abs(changePct).toFixed(2)}%
                </span>
              ) : (
                '—'
              )}
            </span>
            <span className="realtime-quote-pnl-stacked-line">
              {pnlVsBench != null && Number.isFinite(pnlVsBench) ? (
                <span className={pnlVsBench > 0 ? 'pnl-positive' : pnlVsBench < 0 ? 'pnl-negative' : ''}>
                  {fmtUsd(Math.abs(pnlVsBench))}
                </span>
              ) : (
                '—'
              )}
            </span>
            <div className="market-streams-daily-calc-popup" role="tooltip">
              <MarketStreamsDailyCalcBreakdown
                symbol={(symbol || '').trim() || '—'}
                bench={symBench}
                positionDailyPrevClose={positionDailyPrevClose}
                last={dailyLast}
                qty={qty}
              />
            </div>
          </td>
          <td className="realtime-quote-num realtime-quote-pnl-stacked">
            <span className="realtime-quote-pnl-stacked-line">
              {(() => {
                const dl = quoteDisplayLast(q)
                if (avgCost == null || !Number.isFinite(avgCost) || avgCost <= 0 || dl == null) return '—'
                const sincePct = ((dl - avgCost) / avgCost) * 100
                return (
                  <span className={sincePct > 0 ? 'pnl-positive' : sincePct < 0 ? 'pnl-negative' : ''}>
                    {Math.abs(sincePct).toFixed(2)}%
                  </span>
                )
              })()}
            </span>
            <span className="realtime-quote-pnl-stacked-line">
              {pnlCost != null && Number.isFinite(pnlCost) ? (
                <span className={pnlCost > 0 ? 'pnl-positive' : pnlCost < 0 ? 'pnl-negative' : ''}>
                  {fmtUsdRound0(pnlCost)}
                </span>
              ) : (
                '—'
              )}
            </span>
          </td>
        </tr>
      )
    },
    [hasStreamAccounts, benchmarks, applySymbolReorder],
  )

  const renderOptStreamRow = useCallback(
    (row: OptPositionRow, dragEnabled = false) => {
      const basisKey = `${row.account_id.toLowerCase()}\t${row.contract_key}`
      const q = quotesByContractKey[row.contract_key]
      const basis = optionLiveBasisByRow.get(basisKey)
      const { mid, livePnl } = computeOptMidAndLivePnl(row, q, basis)
      const avgForPnl = effectiveOptAvgCostPerShareForMtm(row, resolveOptAvgCostPerShareForMtm(row, basis))
      const mtmTooltip =
        mid != null && avgForPnl != null && Number.isFinite(row.qty) && row.qty !== 0
          ? [
              `MTM: (mid ${mid.toFixed(4)} − avg $/sh ${avgForPnl.toFixed(4)}) × ${row.qty} contracts × 100`,
              `${describeOptionLegMtm(row)} — Short legs: if IB avgCost is negative (credit), we convert to +$/sh for MTM. Call/Put use the same formula.`,
            ].join('\n')
          : `Live MTM needs quote mid and avg $/share (${describeOptionLegMtm(row)}).`
      const contractLabel = row.symbol
        ? `${row.symbol} ${row.right === 'C' ? 'CALL' : row.right === 'P' ? 'PUT' : row.right} ${row.strike}`
        : row.contract_key
      const accIdNorm = (row.account_id ?? '').trim().toLowerCase()
      const isHost = streamHostId != null && accIdNorm === streamHostId.trim().toLowerCase()
      const isSecondary = streamSecondaryId != null && accIdNorm === streamSecondaryId.trim().toLowerCase()
      const qtyCell = row.qty > 0 ? `Long ${row.qty}` : row.qty < 0 ? `Short ${Math.abs(row.qty)}` : '—'
      const costCell = avgForPnl != null && Number.isFinite(avgForPnl) ? fmtUsd(avgForPnl) : '—'
      const pnlCell = livePnl != null
        ? (
            <span className={`replay-pnl-unrealized ${livePnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`} title={mtmTooltip}>
              {fmtUsdRound0(livePnl)}
            </span>
          )
        : <span className="replay-muted" title={mtmTooltip}>—</span>
      const symbolFreshness = getQuoteFreshness(q?.ts)
      const freshnessTitle = q?.ts != null
        ? `Last update ${symbolFreshness === 'fresh' ? '<3s ago' : symbolFreshness === 'stale' ? '3–10s ago' : '>10s ago'}`
        : undefined
      return (
        <tr
          key={basisKey}
          className="live-opt-inline-row"
          onDragOver={dragEnabled ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } : undefined}
          onDrop={
            dragEnabled
              ? (e) => {
                  e.preventDefault()
                  try {
                    const raw = e.dataTransfer.getData('application/x-market-streams-opt')
                    if (!raw) return
                    const { basisKey: fromKey } = JSON.parse(raw) as { basisKey: string }
                    if (fromKey && fromKey !== basisKey) applyOptRowReorder(fromKey, basisKey)
                  } catch {
                    /* ignore */
                  }
                }
              : undefined
          }
        >
          <td
            title={[row.contract_key, freshnessTitle].filter(Boolean).join('\n') || row.contract_key}
            className={`live-opt-inline-label${symbolFreshness ? ` realtime-quote-symbol realtime-quote-symbol-${symbolFreshness}` : ' realtime-quote-symbol'}`}
          >
            {dragEnabled ? (
              <span
                className="realtime-quote-drag-handle"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-market-streams-opt', JSON.stringify({ basisKey }))
                  e.dataTransfer.effectAllowed = 'move'
                }}
                title="Drag to reorder option"
                aria-hidden
              >
                ⋮⋮
              </span>
            ) : null}
            {contractLabel}
          </td>
          {hasStreamAccounts && (
            <>
              {/* Host columns */}
              <td className="realtime-quote-num">{isHost ? qtyCell : <span className="replay-muted">—</span>}</td>
              <td className="realtime-quote-num">{isHost ? costCell : <span className="replay-muted">—</span>}</td>
              <td className="realtime-quote-num">{isHost ? pnlCell : <span className="replay-muted">—</span>}</td>
              {/* Secondary columns */}
              <td className="realtime-quote-num">{isSecondary ? qtyCell : <span className="replay-muted">—</span>}</td>
              <td className="realtime-quote-num">{isSecondary ? costCell : <span className="replay-muted">—</span>}</td>
              <td className="realtime-quote-num">{isSecondary ? pnlCell : <span className="replay-muted">—</span>}</td>
            </>
          )}
          {/* Combined columns */}
          <td className="realtime-quote-num">{qtyCell}</td>
          <td className="realtime-quote-num">{costCell}</td>
          <td className="positions-opt-live-quote">
            {q == null ? (
              <span className="replay-muted">—</span>
            ) : (
              <>
                {q.bid != null ? <span className="positions-opt-quote-bid">{q.bid.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                {' · '}
                <strong>{mid != null ? mid.toFixed(2) : '—'}</strong>
                {' · '}
                {q.ask != null ? <span className="positions-opt-quote-ask">{q.ask.toFixed(2)}</span> : <span className="replay-muted">—</span>}
              </>
            )}
          </td>
          <td className="realtime-quote-num replay-muted">—</td>
          <td className="realtime-quote-num realtime-quote-pnl-stacked">
            <span className="realtime-quote-pnl-stacked-line replay-muted" style={{ fontSize: '0.7em' }}>Live PNL</span>
            <span className="realtime-quote-pnl-stacked-line">{pnlCell}</span>
          </td>
        </tr>
      )
    },
    [hasStreamAccounts, streamHostId, streamSecondaryId, quotesByContractKey, optionLiveBasisByRow, applyOptRowReorder],
  )

  return (
    <div className="app-page-stack">
      {filteredRows.length > 0 && (
        <div className="live-streams-summary-bar">
          <span className="live-streams-summary-label">STK Streams</span>
          <span className="live-streams-summary-seg">
            <span className="live-streams-summary-key">SINCE $</span>
            <span className={`live-streams-summary-val ${streamsSummary.totalCostPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {fmtUsdRound0(streamsSummary.totalCostPnl)}
            </span>
          </span>
          {streamsSummary.sincePct != null && Number.isFinite(streamsSummary.sincePct) && (
            <span className="live-streams-summary-seg">
              <span className="live-streams-summary-key">SINCE %</span>
              <span className={`live-streams-summary-val ${streamsSummary.sincePct >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {streamsSummary.sincePct >= 0 ? '+' : ''}{streamsSummary.sincePct.toFixed(2)}%
              </span>
            </span>
          )}
          {(streamsSummary.totalDailyPct != null || streamsSummary.totalDailyDollar !== 0) && (
            <>
              <span className="live-streams-summary-divider" aria-hidden>|</span>
              <span className="live-streams-summary-seg">
                <span className="live-streams-summary-key">DAILY $</span>
                <span className={`live-streams-summary-val ${streamsSummary.totalDailyDollar >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                  {fmtUsdRound0(streamsSummary.totalDailyDollar)}
                </span>
              </span>
              {streamsSummary.totalDailyPct != null && Number.isFinite(streamsSummary.totalDailyPct) && (
                <span className="live-streams-summary-seg">
                  <span className="live-streams-summary-key">DAILY %</span>
                  <span className={`live-streams-summary-val ${streamsSummary.totalDailyPct >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                    {streamsSummary.totalDailyPct >= 0 ? '+' : ''}{streamsSummary.totalDailyPct.toFixed(2)}%
                  </span>
                </span>
              )}
            </>
          )}
        </div>
      )}
      <PageSection className="card-operations realtime-quotes-card gap-3">
        <div className="realtime-quotes-card-header-row">
          <div className="daemon-header-with-lamp realtime-quotes-card-header-title">
            <h2 className={`daemon-card-title ${SECTION_TITLE_CLASS}`}>
              <SettingsTitleLamp
                lamp={marketStreamsOk ? 'green' : 'red'}
                title="Market streams: green when Market API can read Redis quotes and IB ingestor is connected (socket)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                </svg>
              </SettingsTitleLamp>
              Market Streams
              <InfoTooltip
                text={
                  marketStreamsOk
                    ? `Live quotes: IB ingestor writes Redis (ib:ingester:tick:*); Market API SSE + polling. STK symbols: Watchlist ∪ Host & Secondary positions; Watchlist category "Watching" STK are shown in Watching Stocks (left). ${watchlistSymbols.length} stream symbol(s). Refresh reloads quotes and daily benchmarks from the API.`
                    : 'Requires Market API Redis (quotes) and IB ingestor connected (see System status). Watching-category STK are in Watching Stocks on the Live split card.'
                }
              />
            </h2>
          </div>
          <div className="realtime-stream-filters-inline" role="toolbar" aria-label="Market Streams filters">
            {hasStreamAccounts && (
              <div className="realtime-stream-filter">
                <span className="section-hint">Account:</span>
                <div className="realtime-stream-filter-pills" role="group" aria-label="Filter by stream account (multi-select; none selected = all)">
                  {(['host', 'secondary'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={`replay-filter-pill ${streamAccountFilters.has(key) ? 'active' : ''}`}
                      onClick={() => toggleStreamAccountFilter(key)}
                      aria-pressed={streamAccountFilters.has(key)}
                      title={streamAccountFilters.size === 0 ? 'No filter — showing all rows. Click to narrow.' : 'Toggle; Host and Secondary combine with OR.'}
                    >
                      {key === 'host' ? 'Host' : 'Secondary'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="realtime-stream-filter">
              <span className="section-hint">Category:</span>
              <div className="realtime-stream-filter-pills" role="group" aria-label="Filter by position category (multi-select; none selected = all)">
                {streamCategoryOrder.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`replay-filter-pill replay-filter-pill-draggable ${positionCategoryFilters.has(cat) ? 'active' : ''}`}
                    onClick={() => togglePositionCategoryFilter(cat)}
                    aria-pressed={positionCategoryFilters.has(cat)}
                    draggable
                    onDragStart={(e) => handleCategoryDragStart(e, cat)}
                    onDragOver={handleCategoryDragOver}
                    onDrop={(e) => handleCategoryDrop(e, cat)}
                    title="Click to toggle filter; drag to reorder. No pills active = all categories."
                  >
                    <span className="replay-filter-pill-grip" aria-hidden>⋮⋮</span>
                    {cat}
                  </button>
                ))}
              </div>
              {categoryOrderSaving && <span className="section-hint" style={{ marginLeft: '0.5rem' }}>Saving order…</span>}
            </div>
          </div>
          <div className="realtime-quotes-card-header-actions">
            {onNavigateToSubscribe && (
              <button
                type="button"
                className="section-header-icon-btn"
                onClick={onNavigateToSubscribe}
                title="Open Subscribe page (IB Event Subscribe — Redis ingestor stream health)"
                aria-label="Open Subscribe page"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="section-header-icon-btn"
              onClick={async () => {
                setStreamSyncFeedback('Refreshing…')
                try {
                  const [qRes, bRes] = await Promise.all([
                    fetchQuotes(),
                    fetchBarsBenchmark(benchmarkSymbols),
                  ])
                  if (qRes.quotes?.length) mergeQuotes(qRes.quotes)
                  setBenchmarks(normalizeBenchmarkMap(bRes.benchmarks))
                  setStreamSyncFeedback('Updated')
                } catch {
                  setStreamSyncFeedback('Failed')
                }
                setTimeout(() => setStreamSyncFeedback(null), 4000)
              }}
              title="Reload quotes (GET /quotes) and daily benchmarks (GET /bars/benchmark) from the Market API. Does not change daemon or ingestor processes."
              aria-label="Refresh quotes and daily benchmarks"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
              </svg>
            </button>
            {streamSyncFeedback != null && (
              <span className="section-hint" aria-live="polite">{streamSyncFeedback}</span>
            )}
          </div>
        </div>
        <div className="realtime-quotes-table-wrap">
          <table className="table-operations realtime-quotes-table">
            <colgroup>
              <col style={{ width: '5rem' }} />
              {hasStreamAccounts && <col style={{ width: '5.5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5.5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5.5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5.5rem' }} />}
              <col style={{ width: '5.5rem' }} />
              <col style={{ width: '5.5rem' }} />
              <col style={{ width: '8rem' }} />
              <col style={{ width: '6.25rem' }} />
              <col style={{ width: '6.25rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <button
                    type="button"
                    className={`live-sort-header ${msHeaderAccentClass}`}
                    onClick={() => setMsSortMode((m) => ((((m as number) % 9) + 1) as MarketStreamsSortMode))}
                    title="Cycle sort: default → A–Z → Z–A → Stocks/Options (T+↑) → Options/Stocks (T+↓) → Long Stocks/Short Options (T+S+↑) → Short Options/Long Stocks (T+S+↓) → by expiry ↑ (E+) → by expiry ↓ (E+). Header color indicates sort family."
                  >
                    <span className="live-sort-header__label">
                      Symbol
                      {msHeaderMeta.suffix ? <span className="live-sort-header__suffix">{msHeaderMeta.suffix}</span> : null}
                    </span>
                    {msHeaderMeta.arrow === 'up' ? <span className="live-sort-header__arrow live-sort-header__arrow--up" aria-hidden /> : null}
                    {msHeaderMeta.arrow === 'down' ? <span className="live-sort-header__arrow live-sort-header__arrow--down" aria-hidden /> : null}
                  </button>
                </th>
                {hasStreamAccounts && (
                  <>
                    <th colSpan={3} scope="colgroup" className="realtime-quote-colgroup">
                      Host
                    </th>
                    <th colSpan={3} scope="colgroup" className="realtime-quote-colgroup">
                      Secondary
                    </th>
                  </>
                )}
                <th>Qty</th>
                <th>Cost</th>
                <th title="Last price; Bid and Ask shown as spread vs Last (green if above Last, red if below). Last is colored green/red vs previous close.">Last (Bid / Ask)</th>
                <th scope="col" className="realtime-quote-pnl-stacked-th" title="Daily change vs prior close: percent (top) and dollar P&amp;L (bottom).">
                  Daily
                  <span className="realtime-quote-pnl-stacked-th-sub">% / $</span>
                </th>
                <th scope="col" className="realtime-quote-pnl-stacked-th" title="Since average cost: percent (top) and dollar P&amp;L (bottom).">
                  SINCE
                  <span className="realtime-quote-pnl-stacked-th-sub">% / $</span>
                </th>
              </tr>
              {hasStreamAccounts && (
                <tr>
                  <th aria-hidden />
                  <th>Qty</th>
                  <th>Cost</th>
                  <th>SINCE $</th>
                  <th>Qty</th>
                  <th>Cost</th>
                  <th>SINCE $</th>
                  <th aria-hidden colSpan={5} />
                </tr>
              )}
            </thead>
            <tbody>
              {filteredRows.length === 0 && optPositionRows.length === 0 ? (
                <tr>
                  <td colSpan={hasStreamAccounts ? 12 : 6}>
                    {watchlistSymbols.length === 0
                      ? 'No symbols (add symbols in Watchlist, or ensure Event Account (Host/Secondary) have positions, or daemon is running)'
                      : 'No rows match the selected filters.'}
                  </td>
                </tr>
              ) : unifiedGroupedRows != null ? (
                unifiedGroupedRows.map((g, gi) => (
                  <Fragment key={`ms-ov-${gi}-${g.label || 'flat'}`}>
                    {g.showGroupHeader ? (
                      <tr className="live-sort-group-header">
                        <td colSpan={msColSpan}>
                          <span className="live-sort-group-label">{g.label}</span>
                          <span className={`live-sort-group-total ${g.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                            PNL Σ {fmtUsdRound0(g.totalPnl)}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    {g.stkRows.map((row) => renderMarketStreamRow(row, row.category, false))}
                    {g.optRows.map((row) => renderOptStreamRow(row, false))}
                  </Fragment>
                ))
              ) : (
                <>
                  {categoryOrderFiltered.map((cat) => (
                    <Fragment key={cat}>
                      <tr className="ib-stock-group-header">
                        <td colSpan={msColSpan}>{cat}</td>
                      </tr>
                      {(sortedRowsByCategory[cat] ?? rowsByCategory[cat]).map((row) => renderMarketStreamRow(row, cat, msDragEnabled))}
                    </Fragment>
                  ))}
                  {optPositionRows.length > 0 && (
                    <Fragment>
                      <tr className="live-sort-group-header">
                        <td colSpan={msColSpan}>
                          <span className="live-sort-group-label">Options</span>
                        </td>
                      </tr>
                      {sortedOptRows.map((row) => renderOptStreamRow(row, msDragEnabled))}
                    </Fragment>
                  )}
                </>
              )}
              {filteredRows.length > 0 && (() => {
                const hostCostSum = filteredRows.reduce((a, r) => {
                  const q = r.hostQty != null && Number.isFinite(r.hostQty) ? r.hostQty : 0
                  const c = r.hostAvgCost != null && Number.isFinite(r.hostAvgCost) ? r.hostAvgCost : 0
                  return a + q * c
                }, 0)
                const hostPnlSum = filteredRows.reduce((a, r) => a + (r.hostPnlCost != null && Number.isFinite(r.hostPnlCost) ? r.hostPnlCost : 0), 0)
                const secondaryCostSum = filteredRows.reduce((a, r) => {
                  const q = r.secondaryQty != null && Number.isFinite(r.secondaryQty) ? r.secondaryQty : 0
                  const c = r.secondaryAvgCost != null && Number.isFinite(r.secondaryAvgCost) ? r.secondaryAvgCost : 0
                  return a + q * c
                }, 0)
                const secondaryPnlSum = filteredRows.reduce((a, r) => a + (r.secondaryPnlCost != null && Number.isFinite(r.secondaryPnlCost) ? r.secondaryPnlCost : 0), 0)
                const totalCost = filteredRows.reduce((a, r) => {
                  const q = r.qty != null && Number.isFinite(r.qty) ? r.qty : 0
                  const c = r.avgCost != null && Number.isFinite(r.avgCost) ? r.avgCost : 0
                  return a + q * c
                }, 0)
                const totalCostPnl = filteredRows.reduce((a, r) => a + (r.pnlCost != null && Number.isFinite(r.pnlCost) ? r.pnlCost : 0), 0)
                const { totalDailyDollar, totalDailyPct } = marketStreamsDailyTotals
                const totalPct = totalCost > 0 && Number.isFinite(totalCostPnl) ? (totalCostPnl / totalCost) * 100 : null
                return (
                  <tr className="realtime-quotes-sum-row">
                    <td><strong>Total</strong></td>
                    {hasStreamAccounts && (
                      <>
                        <td className="realtime-quote-num">—</td>
                        <td className="realtime-quote-num">{hostCostSum !== 0 ? fmtUsdRound0(hostCostSum) : '—'}</td>
                        <td className="realtime-quote-num">
                          <span className={hostPnlSum > 0 ? 'pnl-positive' : hostPnlSum < 0 ? 'pnl-negative' : ''}>
                            {hostPnlSum !== 0 ? fmtUsdRound0(hostPnlSum) : '—'}
                          </span>
                        </td>
                        <td className="realtime-quote-num">—</td>
                        <td className="realtime-quote-num">{secondaryCostSum !== 0 ? fmtUsdRound0(secondaryCostSum) : '—'}</td>
                        <td className="realtime-quote-num">
                          <span className={secondaryPnlSum > 0 ? 'pnl-positive' : secondaryPnlSum < 0 ? 'pnl-negative' : ''}>
                            {secondaryPnlSum !== 0 ? fmtUsdRound0(secondaryPnlSum) : '—'}
                          </span>
                        </td>
                      </>
                    )}
                    <td className="realtime-quote-num">—</td>
                    <td className="realtime-quote-num">{totalCost !== 0 ? fmtUsdRound0(totalCost) : '—'}</td>
                    <td className="realtime-quote-num">—</td>
                    <td className="realtime-quote-num realtime-quote-pnl-stacked">
                      <span className="realtime-quote-pnl-stacked-line">
                        {totalDailyPct != null && Number.isFinite(totalDailyPct) ? (
                          <span className={totalDailyPct > 0 ? 'pnl-positive' : totalDailyPct < 0 ? 'pnl-negative' : ''}>
                            {Math.abs(totalDailyPct).toFixed(2)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </span>
                      <span className="realtime-quote-pnl-stacked-line">
                        <span className={totalDailyDollar > 0 ? 'pnl-positive' : totalDailyDollar < 0 ? 'pnl-negative' : ''}>
                          {totalDailyPct != null || totalDailyDollar !== 0 ? fmtUsdRound0(totalDailyDollar) : '—'}
                        </span>
                      </span>
                    </td>
                    <td className="realtime-quote-num realtime-quote-pnl-stacked">
                      <span className="realtime-quote-pnl-stacked-line">
                        {totalPct != null && Number.isFinite(totalPct) ? (
                          <span className={totalPct > 0 ? 'pnl-positive' : totalPct < 0 ? 'pnl-negative' : ''}>
                            {Math.abs(totalPct).toFixed(2)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </span>
                      <span className="realtime-quote-pnl-stacked-line">
                        <span className={totalCostPnl > 0 ? 'pnl-positive' : totalCostPnl < 0 ? 'pnl-negative' : ''}>
                          {totalCostPnl !== 0 ? fmtUsdRound0(totalCostPnl) : '—'}
                        </span>
                      </span>
                    </td>
                  </tr>
                )
              })()}
            </tbody>
          </table>
        </div>
      </PageSection>

      <PageSection className="card-operations live-open-watchlist-split gap-3">
        <div className="live-open-watchlist-split-grid" role="group" aria-label="Watching stocks, Watching options, and open orders">
          <div className="live-watching-stocks-column">
            <div className="live-watching-stocks-pane">
              <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
                <h2 className={`daemon-card-title ${SECTION_TITLE_CLASS}`}>
                  <SettingsTitleLamp
                    lamp={marketStreamsOk ? 'green' : 'red'}
                    title="Quotes: green when Market API can read Redis quotes and IB ingestor is connected (same as Market Streams)."
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </SettingsTitleLamp>
                  Watching Stocks
                  <InfoTooltip text="STK symbols whose Watchlist category is Watching. Stock quotes and daily % match Market Streams; Host/Secondary and position qty/cost are omitted here." />
                </h2>
              </div>
              <div className="realtime-quotes-table-wrap live-watching-stocks-table-wrap">
                {watchingTickerRows.length === 0 ? (
                  <p className="section-hint">No STK symbols with Watchlist category Watching</p>
                ) : (
                  <table className="table-operations realtime-quotes-table" aria-label="Watching stocks quotes">
                    <colgroup>
                      <col style={{ width: '5.5rem' }} />
                      <col style={{ width: '9rem' }} />
                      <col style={{ width: '6.25rem' }} />
                      <col style={{ width: '6.25rem' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th title="Last price; Bid and Ask shown as spread vs Last">Last (Bid / Ask)</th>
                        <th scope="col" className="realtime-quote-pnl-stacked-th" title="Daily % / Daily $">
                          Daily
                          <span className="realtime-quote-pnl-stacked-th-sub">% / $</span>
                        </th>
                        <th scope="col" className="realtime-quote-pnl-stacked-th" title="SINCE % / SINCE $">
                          SINCE
                          <span className="realtime-quote-pnl-stacked-th-sub">% / $</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {watchingTickerRowsSorted.map((row) => renderMarketStreamRow(row, 'Watching', msDragEnabled, true))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          <div className="live-watch-right-column">
            <div className="live-watching-options-pane">
              <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
                <h2 className={`daemon-card-title ${SECTION_TITLE_CLASS}`}>
                  <SettingsTitleLamp
                    lamp={marketStreamsOk ? 'green' : 'red'}
                    title="Quotes: green when Market API can read Redis and IB ingestor is connected (OPT quotes via contract_quote_live)."
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </SettingsTitleLamp>
                  Watching Options
                  <InfoTooltip text="Option contracts from Watchlist; quotes from daemon (contract_quote_live). Same quote-path health as Market Streams." />
                </h2>
              </div>
              <div className="realtime-quotes-table-wrap">
                {watchlistOptionItems.length === 0 ? (
                  <p className="section-hint">No option contracts on Watchlist</p>
                ) : (
                  <table className="table-operations realtime-quotes-table" aria-label="Watching option quotes">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th title="Last price; Bid and Ask shown as spread vs Last">Last (Bid / Ask)</th>
                        <th>Expiry</th>
                        <th>Right</th>
                        <th>Strike</th>
                        <th>Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {watchlistOptionItems.map((item) => {
                        const q = quotesByContractKey[item.contract_key]
                        const categoryName = (item.category ?? '').trim() || 'Uncategorized'
                        return (
                          <tr key={item.contract_key}>
                            <td title={item.contract_key} style={{ fontWeight: 'bold' }}>{watchlistOptionLabel(item)}</td>
                            <td className="realtime-quote-num realtime-quote-last-bid-ask">{renderLastBidAskOption(q)}</td>
                            <td>{formatExpiry(item.expiry)}</td>
                            <td>{formatOptionRight(item.option_right)}</td>
                            <td>{item.strike != null ? formatStrike(item.strike) : '—'}</td>
                            <td>{categoryName}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="live-open-orders-pane">
              <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem', marginTop: 'var(--space-2)' }}>
                <h2 className={`daemon-card-title ${SECTION_TITLE_CLASS}`}>
                  <SettingsTitleLamp
                    lamp={openOrdersSectionOk ? 'green' : 'red'}
                    title={`Open orders lamp: green when Account Sync Daemon is healthy (GET /status account_sync_daemon) and heartbeat is fresh. ${accountSyncLamp.title}${openOrdersUpdatedAt != null ? ` · Last UI read (GET /open-orders): ${fmtSince(openOrdersUpdatedAt)} ago.` : ''}`}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                    </svg>
                  </SettingsTitleLamp>
                  Open Orders
                  <InfoTooltip text="Unfilled orders from PostgreSQL (daemon_open_orders). The Account Sync Daemon writes this table from the IB account stream. This page polls GET /open-orders every few seconds for UI updates. Account ID is the IB account that placed each order." />
                </h2>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {openOrdersUpdatedAt != null && (
                    <span
                      className="open-orders-freshness-badge"
                      title={`DB polled at ${fmtTs(openOrdersUpdatedAt)}`}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.7 }}>
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 6v6l4 2" />
                      </svg>
                      <span className="open-orders-freshness-age">{fmtSince(openOrdersUpdatedAt)} ago</span>
                    </span>
                  )}
                  {onNavigateToSubscribe && (
                    <button
                      type="button"
                      className="section-header-icon-btn"
                      onClick={onNavigateToSubscribe}
                      title="Open Subscribe page (IB Event Subscribe — account agent stream)"
                      aria-label="Open Subscribe page"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                      </svg>
                    </button>
                  )}
                </div>
                <span className="section-hint" style={{ marginLeft: 8 }}>Source: DB table daemon_open_orders</span>
              </div>
              <div className="open-orders-table-wrap">
                {openOrders.length === 0 ? (
                  <p className="section-hint">No open orders</p>
                ) : (
                  <>
                    {(() => {
                      const optionOrders = openOrders.filter((o) => ((o.sec_type ?? '').toString().toUpperCase()) === 'OPT')
                      const stockOrders = openOrders.filter((o) => ((o.sec_type ?? '').toString().toUpperCase()) === 'STK')
                      return (
                        <>
                          {optionOrders.length > 0 && (
                            <div className="open-orders-section" style={{ marginBottom: 'var(--space-3)' }}>
                              <h3 className="open-orders-subtitle" style={{ fontSize: 'var(--text-caption)', fontWeight: 600, marginBottom: 'var(--space-1)' }}>Option (OPT)</h3>
                              <table className="open-orders-table table-operations" role="grid" aria-label="Open orders Option">
                                <thead>
                                  <tr>
                                    <th scope="col">Account ID</th>
                                    <th scope="col">Symbol</th>
                                    <th scope="col">Expiry</th>
                                    <th scope="col">Strike</th>
                                    <th scope="col">Opt side</th>
                                    <th scope="col">Side</th>
                                    <th scope="col">Qty</th>
                                    <th scope="col">Limit</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Filled / Rem</th>
                                    <th scope="col">Submit</th>
                                    <th scope="col">Since</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {optionOrders.map((o, i) => {
                                    const optParts = parseOptionContractKey(o.contract_key)
                                    const submitTs = o.updated_ts != null && Number.isFinite(Number(o.updated_ts)) ? Number(o.updated_ts) : null
                                    return (
                                      <tr key={o.order_id ?? o.perm_id ?? i}>
                                        <td>{o.account_id ?? '—'}</td>
                                        <td>{o.symbol ?? '—'}</td>
                                        <td>{optParts.expiry}</td>
                                        <td>{optParts.strike === '—' ? '—' : fmtUsd(Number(optParts.strike))}</td>
                                        <td>{optParts.rightLabel}</td>
                                        <td>{o.action ?? '—'}</td>
                                        <td>{o.total_quantity != null ? Math.round(Number(o.total_quantity)) : '—'}</td>
                                        <td>{o.limit_price != null ? fmtUsd(Number(o.limit_price)) : '—'}</td>
                                        <td>{o.status ?? '—'}</td>
                                        <td>
                                          {o.filled != null && o.remaining != null ? (
                                            <>{Math.round(Number(o.filled))} / {Math.round(Number(o.remaining))}</>
                                          ) : (
                                            '—'
                                          )}
                                        </td>
                                        <td>{submitTs != null ? fmtTs(submitTs) : '—'}</td>
                                        <td>{submitTs != null ? `${fmtSince(submitTs)} ago` : '—'}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {stockOrders.length > 0 && (
                            <div className="open-orders-section">
                              <h3 className="open-orders-subtitle" style={{ fontSize: 'var(--text-caption)', fontWeight: 600, marginBottom: 'var(--space-1)' }}>Stock (STK)</h3>
                              <table className="open-orders-table table-operations" role="grid" aria-label="Open orders Stock">
                                <thead>
                                  <tr>
                                    <th scope="col">Account ID</th>
                                    <th scope="col">Symbol</th>
                                    <th scope="col">Side</th>
                                    <th scope="col">Qty</th>
                                    <th scope="col">Limit</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Filled / Rem</th>
                                    <th scope="col">Submit</th>
                                    <th scope="col">Since</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {stockOrders.map((o, i) => {
                                    const submitTs = o.updated_ts != null && Number.isFinite(Number(o.updated_ts)) ? Number(o.updated_ts) : null
                                    return (
                                      <tr key={o.order_id ?? o.perm_id ?? i}>
                                        <td>{o.account_id ?? '—'}</td>
                                        <td>{o.symbol ?? '—'}</td>
                                        <td>{o.action ?? '—'}</td>
                                        <td>{o.total_quantity != null ? fmtQtyWithMutedDecimal(o.total_quantity) : '—'}</td>
                                        <td>{o.limit_price != null ? fmtUsd(Number(o.limit_price)) : '—'}</td>
                                        <td>{o.status ?? '—'}</td>
                                        <td>
                                          {o.filled != null && o.remaining != null ? (
                                            <>{fmtQtyWithMutedDecimal(o.filled)} / {fmtQtyWithMutedDecimal(o.remaining)}</>
                                          ) : (
                                            '—'
                                          )}
                                        </td>
                                        <td>{submitTs != null ? fmtTs(submitTs) : '—'}</td>
                                        <td>{submitTs != null ? `${fmtSince(submitTs)} ago` : '—'}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {optionOrders.length === 0 && stockOrders.length === 0 && (
                            <p className="section-hint">No OPT or STK open orders (other sec types filtered)</p>
                          )}
                        </>
                      )
                    })()}
                  </>
                )}
              </div>
            </div>

            <div className="live-strategy-inline-bar" style={{ marginTop: 'var(--space-3)' }}>
              <span className="live-strategy-inline-title">
                Strategy Active
                <InfoTooltip text="Current active structure, gate safety set, and allocation. Daemon uses these on next start. To change them, click Manage to open Strategy → Structure." />
              </span>
              <span className="live-strategy-inline-pills">
                <span className="live-strategy-pill" title="Structure">
                  <span className="live-strategy-pill-key">S</span>
                  <span className="live-strategy-pill-val">{j?.strategy?.active?.structure?.name ?? '—'}</span>
                </span>
                <span className="live-strategy-pill" title="Gate safety">
                  <span className="live-strategy-pill-key">G</span>
                  <span className="live-strategy-pill-val">{j?.strategy?.active?.gate_safety?.name ?? '—'}</span>
                </span>
                <span className="live-strategy-pill" title="Allocation">
                  <span className="live-strategy-pill-key">A</span>
                  <span className="live-strategy-pill-val">{j?.strategy?.active?.allocation?.name ?? '—'}</span>
                </span>
              </span>
              {onNavigateToStrategy && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className={BREADCRUMB_LINK_CLASS}
                  onClick={onNavigateToStrategy}
                  aria-label="Manage strategy"
                  style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.15rem 0.5rem', height: 'auto' }}
                >
                  Manage
                </Button>
              )}
            </div>
          </div>
        </div>
      </PageSection>

    </div>
  )
}
