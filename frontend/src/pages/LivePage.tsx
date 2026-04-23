import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { Execution, OpenOrder, PositionCategory, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
import { fetchBarsBenchmark, fetchExecutions, fetchMarketStreamsSymbolOrder, fetchOpenOrders, fetchPositionCategories, fetchQuotes, fetchWatchlist, patchPositionCategory, putMarketStreamsSymbolOrder, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
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

/** IB TWS-style FIN INSTRUMENT column sort cycle (Market Streams = STK only → 5 modes). */
type MarketStreamsSortMode = 1 | 2 | 3 | 4 | 5
/** IB TWS-style Contract column sort cycle (Option Positions). */
type OptionPositionsSortMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

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

function msStockSide(qty: number | null): 'long' | 'short' | 'flat' {
  if (qty == null || !Number.isFinite(qty) || qty === 0) return 'flat'
  return qty > 0 ? 'long' : 'short'
}

function cmpSymbolLocale(a: string, b: string, dir: 1 | -1): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) * dir
}

function optionRightIsCall(right: string): boolean {
  const r = (right ?? '').toString().trim().toUpperCase()
  return r === 'C' || r === 'CALL'
}

function optionRightIsPut(right: string): boolean {
  const r = (right ?? '').toString().trim().toUpperCase()
  return r === 'P' || r === 'PUT'
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

function computeOptMidAndLivePnl(
  row: OptPositionRow,
  q: RealtimeQuote | undefined,
  basis: { avgPerShare: number | null; basisSource: 'flex_trades' | 'tws_client' | null } | undefined,
): { mid: number | null; livePnl: number | null } {
  const mid = q?.mid ?? (q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null)
  const avgForPnl = basis?.avgPerShare != null && Number.isFinite(basis.avgPerShare) ? basis.avgPerShare : row.avg_cost
  const livePnl =
    mid != null && avgForPnl != null && Number.isFinite(avgForPnl) && Number.isFinite(row.qty) && row.qty !== 0
      ? (mid - avgForPnl) * row.qty * 100
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
  switch (mode) {
    case 1: return { suffix: null, arrow: null }
    case 2: return { suffix: null, arrow: 'up' }
    case 3: return { suffix: null, arrow: 'down' }
    case 4: return { suffix: null, arrow: 'up' }
    case 5: return { suffix: null, arrow: 'down' }
    default: return { suffix: null, arrow: null }
  }
}

function optionPositionsSortHeaderMeta(mode: OptionPositionsSortMode): { suffix: string | null; arrow: 'up' | 'down' | null } {
  if (mode === 1) return { suffix: null, arrow: null }
  if (mode === 2) return { suffix: null, arrow: 'up' }
  if (mode === 3) return { suffix: null, arrow: 'down' }
  if (mode === 4 || mode === 5) return { suffix: 'T+', arrow: mode === 4 ? 'up' : 'down' }
  if (mode === 6 || mode === 7) return { suffix: 'T+S+', arrow: mode === 6 ? 'up' : 'down' }
  if (mode === 8 || mode === 9) return { suffix: 'E+', arrow: mode === 8 ? 'up' : 'down' }
  return { suffix: null, arrow: null }
}

type LiveSortGroupMs = { label: string; showGroupHeader: boolean; rows: MarketStreamsRow[]; totalPnl: number }
type LiveSortGroupOp = { label: string; showGroupHeader: boolean; rows: OptPositionRow[]; totalPnl: number }

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
}): JSX.Element {
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
  const [watchlistOptionItems, setWatchlistOptionItems] = useState<WatchlistItem[]>([])
  const [freshnessTick, setFreshnessTick] = useState(0)
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  /** Custom category order (names). Empty = use default from API + data. */
  const [categoryOrder, setCategoryOrder] = useState<string[]>([])
  /** Symbol order per category (from DB; fallback localStorage). */
  const [symbolOrderByCategory, setSymbolOrderByCategory] = useState<Record<string, string[]>>(loadSymbolOrderFromStorage)
  const [categoryOrderSaving, setCategoryOrderSaving] = useState(false)
  const [streamSyncFeedback, setStreamSyncFeedback] = useState<string | null>(null)
  const [msSortMode, setMsSortMode] = useState<MarketStreamsSortMode>(1)
  const [opSortMode, setOpSortMode] = useState<OptionPositionsSortMode>(1)
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
        for (const w of items) {
          const sym = (w.symbol ?? '').trim()
          const st = (w.sec_type ?? '').toString().toUpperCase()
          if (sym && (st === 'STK' || !st)) set.add(sym.toUpperCase())
        }
        setWatchlistSymbolSet(set)
        setWatchlistOptionItems(items.filter((w) => (w.sec_type ?? '').toString().toUpperCase() === 'OPT'))
      })
      .catch(() => {
        if (!cancelled) setWatchlistSymbolSet(new Set())
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

  const [streamCategoryFilter, setStreamCategoryFilter] = useState<'all' | 'host' | 'secondary' | 'wishlist'>('all')
  const [positionCategoryFilter, setPositionCategoryFilter] = useState<string>('all')
  const filteredByAccount = useMemo(() => {
    if (!hasStreamAccounts) return watchlistRows
    if (streamCategoryFilter === 'all') return watchlistRows
    if (streamCategoryFilter === 'wishlist') return watchlistRows.filter((row) => row.isInWatchlist === true)
    if (streamCategoryFilter === 'host')
      return watchlistRows.filter((row) => row.streamCategory === 'host' || row.streamCategory === 'both')
    if (streamCategoryFilter === 'secondary')
      return watchlistRows.filter((row) => row.streamCategory === 'secondary' || row.streamCategory === 'both')
    return watchlistRows.filter((row) => row.streamCategory === streamCategoryFilter)
  }, [watchlistRows, hasStreamAccounts, streamCategoryFilter])
  const filteredRows = useMemo(() => {
    if (positionCategoryFilter === 'all') return filteredByAccount
    return filteredByAccount.filter((row) => row.category === positionCategoryFilter)
  }, [filteredByAccount, positionCategoryFilter])

  const marketStreamsDailyTotals = useMemo(
    () => aggregateMarketStreamsDailyTotals(filteredRows, benchmarks),
    [filteredRows, benchmarks],
  )

  /** Category names that appear in data. */
  const categoryNamesFromData = useMemo(() => {
    const set = new Set<string>()
    watchlistRows.forEach((row) => set.add(row.category))
    return Array.from(set)
  }, [watchlistRows])

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

  /** Modes 2–5: flat / grouped rows; mode 1 uses category + drag order (null). */
  const marketStreamsGroupedOverride = useMemo((): LiveSortGroupMs[] | null => {
    if (msSortMode === 1) return null
    const rows = [...filteredRows]
    const push = (label: string, show: boolean, r: MarketStreamsRow[]): LiveSortGroupMs => ({
      label,
      showGroupHeader: show,
      rows: r,
      totalPnl: sumFiniteMsPnl(r),
    })
    if (msSortMode === 2) {
      rows.sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, 1))
      return [push('', false, rows)]
    }
    if (msSortMode === 3) {
      rows.sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, -1))
      return [push('', false, rows)]
    }
    if (msSortMode === 4) {
      const longs = rows.filter((r) => msStockSide(r.qty) === 'long').sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, 1))
      const shorts = rows.filter((r) => msStockSide(r.qty) === 'short').sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, 1))
      const flats = rows.filter((r) => msStockSide(r.qty) === 'flat').sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, 1))
      const out: LiveSortGroupMs[] = []
      if (longs.length) out.push(push('Total Long Stocks', true, longs))
      if (shorts.length) out.push(push('Total Short Stocks', true, shorts))
      if (flats.length) out.push(push('No position qty', true, flats))
      return out.length ? out : [push('', false, rows)]
    }
    if (msSortMode === 5) {
      const longs = rows.filter((r) => msStockSide(r.qty) === 'long').sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, -1))
      const shorts = rows.filter((r) => msStockSide(r.qty) === 'short').sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, -1))
      const flats = rows.filter((r) => msStockSide(r.qty) === 'flat').sort((a, b) => cmpSymbolLocale(a.symbol, b.symbol, -1))
      const out: LiveSortGroupMs[] = []
      if (shorts.length) out.push(push('Total Short Stocks', true, shorts))
      if (longs.length) out.push(push('Total Long Stocks', true, longs))
      if (flats.length) out.push(push('No position qty', true, flats))
      return out.length ? out : [push('', false, rows)]
    }
    return null
  }, [filteredRows, msSortMode])

  const optionPositionsDisplayGroups = useMemo((): LiveSortGroupOp[] => {
    const rows = optPositionRows
    if (rows.length === 0) return []
    const basisFor = (row: OptPositionRow) =>
      optionLiveBasisByRow.get(`${row.account_id.toLowerCase()}\t${row.contract_key}`)
    const totalPnlFor = (rs: OptPositionRow[]) =>
      rs.reduce((acc, row) => {
        const { livePnl } = computeOptMidAndLivePnl(row, quotesByContractKey[row.contract_key], basisFor(row))
        return acc + (livePnl != null && Number.isFinite(livePnl) ? livePnl : 0)
      }, 0)
    const grp = (label: string, show: boolean, r: OptPositionRow[]): LiveSortGroupOp => ({
      label,
      showGroupHeader: show,
      rows: r,
      totalPnl: totalPnlFor(r),
    })
    const rowKey = (r: OptPositionRow) => `${r.account_id.toLowerCase()}\t${r.contract_key}`
    switch (opSortMode) {
      case 1:
      case 2:
        return [grp('', false, sortOptRowsAlpha(rows, 1))]
      case 3:
        return [grp('', false, sortOptRowsAlpha(rows, -1))]
      case 4: {
        const calls = sortOptRowsAlpha(rows.filter((r) => optionRightIsCall(r.right)), 1)
        const puts = sortOptRowsAlpha(rows.filter((r) => optionRightIsPut(r.right)), 1)
        const other = sortOptRowsAlpha(
          rows.filter((r) => !optionRightIsCall(r.right) && !optionRightIsPut(r.right)),
          1,
        )
        const out: LiveSortGroupOp[] = []
        if (calls.length) out.push(grp('Calls', true, calls))
        if (puts.length) out.push(grp('Puts', true, puts))
        if (other.length) out.push(grp('Other', true, other))
        return out.length ? out : [grp('', false, rows)]
      }
      case 5: {
        const puts = sortOptRowsAlpha(rows.filter((r) => optionRightIsPut(r.right)), -1)
        const calls = sortOptRowsAlpha(rows.filter((r) => optionRightIsCall(r.right)), -1)
        const other = sortOptRowsAlpha(
          rows.filter((r) => !optionRightIsCall(r.right) && !optionRightIsPut(r.right)),
          -1,
        )
        const out: LiveSortGroupOp[] = []
        if (puts.length) out.push(grp('Puts', true, puts))
        if (calls.length) out.push(grp('Calls', true, calls))
        if (other.length) out.push(grp('Other', true, other))
        return out.length ? out : [grp('', false, rows)]
      }
      case 6: {
        const longCalls = rows.filter((r) => r.qty > 0 && optionRightIsCall(r.right))
        const shortPuts = rows.filter((r) => r.qty < 0 && optionRightIsPut(r.right))
        const used = new Set([...longCalls, ...shortPuts].map(rowKey))
        const other = rows.filter((r) => !used.has(rowKey(r)))
        const out: LiveSortGroupOp[] = []
        if (longCalls.length) out.push(grp('Long Calls', true, sortOptRowsAlpha(longCalls, 1)))
        if (shortPuts.length) out.push(grp('Short Puts', true, sortOptRowsAlpha(shortPuts, 1)))
        if (other.length) out.push(grp('Other', true, sortOptRowsAlpha(other, 1)))
        return out.length ? out : [grp('', false, rows)]
      }
      case 7: {
        const longCalls = rows.filter((r) => r.qty > 0 && optionRightIsCall(r.right))
        const shortPuts = rows.filter((r) => r.qty < 0 && optionRightIsPut(r.right))
        const used = new Set([...longCalls, ...shortPuts].map(rowKey))
        const other = rows.filter((r) => !used.has(rowKey(r)))
        const out: LiveSortGroupOp[] = []
        if (shortPuts.length) out.push(grp('Short Puts', true, sortOptRowsAlpha(shortPuts, -1)))
        if (longCalls.length) out.push(grp('Long Calls', true, sortOptRowsAlpha(longCalls, -1)))
        if (other.length) out.push(grp('Other', true, sortOptRowsAlpha(other, -1)))
        return out.length ? out : [grp('', false, rows)]
      }
      case 8:
      case 9: {
        const expMap = new Map<string, OptPositionRow[]>()
        for (const r of rows) {
          const k = String(r.expiry ?? '').trim() || 'Other'
          if (!expMap.has(k)) expMap.set(k, [])
          expMap.get(k)!.push(r)
        }
        const keys = Array.from(expMap.keys()).sort((a, b) => {
          const ka = expiryDigitsToSortKey(a)
          const kb = expiryDigitsToSortKey(b)
          if (ka !== kb) return opSortMode === 8 ? ka - kb : kb - ka
          return a.localeCompare(b)
        })
        const dir: 1 | -1 = opSortMode === 8 ? 1 : -1
        return keys.map((k) => grp(formatExpiryIbGroupLabel(k), true, sortOptRowsAlpha(expMap.get(k) ?? [], dir)))
      }
      default:
        return [grp('', false, sortOptRowsAlpha(rows, 1))]
    }
  }, [optPositionRows, opSortMode, quotesByContractKey, optionLiveBasisByRow])

  const msColSpan = hasStreamAccounts ? 12 : 6
  const msDragEnabled = msSortMode === 1
  const msHeaderMeta = marketStreamsSortHeaderMeta(msSortMode)
  const opHeaderMeta = optionPositionsSortHeaderMeta(opSortMode)

  const renderMarketStreamRow = useCallback(
    (row: MarketStreamsRow, categoryForDrag: string, dragEnabled: boolean) => {
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
          {hasStreamAccounts && (
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
          <td className="realtime-quote-num">{qty != null && Number.isFinite(qty) ? qty : '—'}</td>
          <td className="realtime-quote-num">{avgCost != null && Number.isFinite(avgCost) ? fmtUsd(avgCost) : '—'}</td>
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

  return (
    <div className="app-page-stack">
      <div className="card card-operations live-open-watchlist-split">
        <div className="live-open-watchlist-split-grid" role="group" aria-label="Open orders and Watchlist options">
          <div className="live-open-orders-pane">
            <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
              <h2 className="daemon-card-title page-title-with-tooltip">
                <span
                  className={`title-inline-lamp lamp-icon ${openOrdersSectionOk ? 'green' : 'red'}`}
                  title={`Open orders lamp: green when Account Sync Daemon is healthy (GET /status account_sync_daemon) and heartbeat is fresh. ${accountSyncLamp.title}${openOrdersUpdatedAt != null ? ` · Last UI read (GET /open-orders): ${fmtSince(openOrdersUpdatedAt)} ago.` : ''}`}
                  aria-hidden
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                  </svg>
                </span>
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

          <div className="live-watchlist-options-pane">
            <h2 className="daemon-card-title page-title-with-tooltip" style={{ marginBottom: '0.5rem' }}>
              Watchlist Options
              <InfoTooltip text="Option contracts from Watchlist; quotes from daemon (contract_quote_live). Updates every few seconds." />
            </h2>
            <div className="realtime-quotes-table-wrap">
              {watchlistOptionItems.length === 0 ? (
                <p className="section-hint">No option contracts on Watchlist</p>
              ) : (
                <table className="table-operations realtime-quotes-table" aria-label="Watchlist option quotes">
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
        </div>
      </div>

      {optPositionRows.length > 0 && (
        <div className="card card-operations">
          <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
            <h2 className="daemon-card-title page-title-with-tooltip">
              <span
                className={`title-inline-lamp lamp-icon ${marketStreamsOk ? 'green' : 'red'}`}
                title="Same as Market Streams: green when Market API can read Redis quotes and IB ingestor is connected (option marks use live quotes)."
                aria-hidden
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                </svg>
              </span>
              Option Positions
              <InfoTooltip text="Live Bid·Mid·Ask and PNL for open option positions (IB ingestor subscribes position contracts automatically). Live PNL uses FIFO cost from account_executions when available: fills with source flex_trades if any exist for the contract/account, otherwise tws_client / tws_event; otherwise IB avg cost." />
            </h2>
          </div>
          <div className="realtime-quotes-table-wrap">
            <table className="table-operations realtime-quotes-table" aria-label="Option position live quotes">
              <thead>
                <tr>
                  <th scope="col">
                    <button
                      type="button"
                      className="live-sort-header"
                      onClick={() => setOpSortMode((m) => ((((m as number) % 9) + 1) as OptionPositionsSortMode))}
                      title="Cycle sort: A–Z → Z–A → Calls/Puts → Puts/Calls → Long Calls·Short Puts → Short Puts·Long Calls → by expiry ↑ / ↓"
                    >
                      <span className="live-sort-header__label">
                        Contract
                        {opHeaderMeta.suffix ? <span className="live-sort-header__suffix">{opHeaderMeta.suffix}</span> : null}
                      </span>
                      {opHeaderMeta.arrow === 'up' ? <span className="live-sort-header__arrow live-sort-header__arrow--up" aria-hidden /> : null}
                      {opHeaderMeta.arrow === 'down' ? <span className="live-sort-header__arrow live-sort-header__arrow--down" aria-hidden /> : null}
                    </button>
                  </th>
                  <th>Qty</th>
                  <th>Avg Cost</th>
                  <th>Bid · Mid · Ask</th>
                  <th>Live PNL</th>
                  <th>Quote Age</th>
                </tr>
              </thead>
              <tbody>
                {optionPositionsDisplayGroups.map((g, gi) => (
                  <Fragment key={`op-grp-${gi}-${g.label || 'all'}`}>
                    {g.showGroupHeader ? (
                      <tr className="live-sort-group-header">
                        <td colSpan={6}>
                          <span className="live-sort-group-label">{g.label}</span>
                          <span className={`live-sort-group-total ${g.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                            Live PNL Σ {fmtUsd(g.totalPnl)}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    {g.rows.map((row) => {
                      const q = quotesByContractKey[row.contract_key]
                      const { mid, livePnl } = computeOptMidAndLivePnl(
                        row,
                        q,
                        optionLiveBasisByRow.get(`${row.account_id.toLowerCase()}\t${row.contract_key}`),
                      )
                      const basisKey = `${row.account_id.toLowerCase()}\t${row.contract_key}`
                      const basis = optionLiveBasisByRow.get(basisKey)
                      const avgForPnl = basis?.avgPerShare != null && Number.isFinite(basis.avgPerShare) ? basis.avgPerShare : row.avg_cost
                      const ageSec = q?.ts != null ? Math.floor(Date.now() / 1000 - q.ts) : null
                      const contractLabel = row.symbol
                        ? `${row.symbol} ${row.right === 'C' ? 'CALL' : row.right === 'P' ? 'PUT' : row.right} ${row.strike}`
                        : row.contract_key
                      const avgTitle =
                        basis?.avgPerShare != null && Number.isFinite(basis.avgPerShare)
                          ? `Live PNL basis: account_executions (FIFO open lot, source ${basis.basisSource ?? 'ledger'}) $/share. IB avg shown muted if different.`
                          : 'Live PNL basis: IB position avg (no execution match or ledger qty mismatch).'
                      return (
                        <tr key={basisKey}>
                          <td title={row.contract_key} style={{ fontWeight: 'bold' }}>{contractLabel}</td>
                          <td>{row.qty > 0 ? `Long ${row.qty}` : row.qty < 0 ? `Short ${Math.abs(row.qty)}` : '—'}</td>
                          <td title={avgTitle}>
                            {avgForPnl != null && Number.isFinite(avgForPnl) ? fmtUsd(avgForPnl) : '—'}
                            {basis?.avgPerShare != null && row.avg_cost != null && Number.isFinite(row.avg_cost) && Math.abs(basis.avgPerShare - row.avg_cost) > 1e-6 ? (
                              <span className="replay-muted" style={{ fontSize: '0.7em', marginLeft: '0.35em' }} title="IB avg cost">IB {fmtUsd(row.avg_cost)}</span>
                            ) : null}
                          </td>
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
                          <td>
                            {livePnl != null ? (
                              <span className={`replay-pnl-unrealized ${livePnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(livePnl)}</span>
                            ) : <span className="replay-muted">—</span>}
                          </td>
                          <td className="replay-muted">
                            {ageSec != null ? `${ageSec}s ago` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card card-operations realtime-quotes-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <h2 className="daemon-card-title page-title-with-tooltip">
            <span
              className={`title-inline-lamp lamp-icon ${marketStreamsOk ? 'green' : 'red'}`}
              title="Market streams: green when Market API can read Redis quotes and IB ingestor is connected (socket)"
              aria-hidden
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-4l-3 9L9 3 6 12H2" />
              </svg>
            </span>
            Market Streams
            <InfoTooltip
              text={
                marketStreamsOk
                  ? `Live quotes: IB ingestor writes Redis (ib:ingester:tick:*); Market API SSE + polling. Symbols: Watchlist ∪ Host & Secondary STK positions. ${watchlistSymbols.length} symbol(s). Refresh reloads quotes and daily benchmarks from the API.`
                  : 'Requires Market API Redis (quotes) and IB ingestor connected (see System status). Symbols: Watchlist ∪ Host & Secondary positions.'
              }
            />
          </h2>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
        <div className="realtime-stream-filters-row">
          {hasStreamAccounts && (
            <div className="realtime-stream-filter">
              <span className="section-hint">Account:</span>
              <div className="realtime-stream-filter-pills" role="group" aria-label="Filter by stream account">
                {(['all', 'host', 'secondary', 'wishlist'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`replay-filter-pill ${streamCategoryFilter === value ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter(value)}
                    aria-pressed={streamCategoryFilter === value}
                  >
                    {value === 'all' ? 'All' : value === 'host' ? 'Host' : value === 'secondary' ? 'Secondary' : 'Wishlist'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="realtime-stream-filter">
            <span className="section-hint">Category:</span>
            <div className="realtime-stream-filter-pills" role="group" aria-label="Filter by position category">
              <button
                type="button"
                className={`replay-filter-pill ${positionCategoryFilter === 'all' ? 'active' : ''}`}
                onClick={() => setPositionCategoryFilter('all')}
                aria-pressed={positionCategoryFilter === 'all'}
              >
                All
              </button>
              {streamCategoryOrder.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`replay-filter-pill replay-filter-pill-draggable ${positionCategoryFilter === cat ? 'active' : ''}`}
                  onClick={() => setPositionCategoryFilter(cat)}
                  aria-pressed={positionCategoryFilter === cat}
                  draggable
                  onDragStart={(e) => handleCategoryDragStart(e, cat)}
                  onDragOver={handleCategoryDragOver}
                  onDrop={(e) => handleCategoryDrop(e, cat)}
                  title="Drag to reorder category"
                >
                  <span className="replay-filter-pill-grip" aria-hidden>⋮⋮</span>
                  {cat}
                </button>
              ))}
            </div>
            {categoryOrderSaving && <span className="section-hint" style={{ marginLeft: '0.5rem' }}>Saving order…</span>}
          </div>
        </div>
        <div className="realtime-quotes-table-wrap">
          <table className="table-operations realtime-quotes-table">
            <colgroup>
              <col style={{ width: '5rem' }} />
              {hasStreamAccounts && <col style={{ width: '4rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5.5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '4rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5rem' }} />}
              {hasStreamAccounts && <col style={{ width: '5.5rem' }} />}
              <col style={{ width: '4rem' }} />
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
                    className="live-sort-header"
                    onClick={() => setMsSortMode((m) => ((((m as number) % 5) + 1) as MarketStreamsSortMode))}
                    title="Cycle sort: default (category + drag) → A–Z → Z–A → Long/Short groups → Short/Long groups"
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
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={hasStreamAccounts ? 12 : 6}>
                    {watchlistRows.length === 0
                      ? 'No symbols (add symbols in Watchlist, or ensure Event Account (Host/Secondary) have positions, or daemon is running)'
                      : 'No rows match the selected filters.'}
                  </td>
                </tr>
              ) : marketStreamsGroupedOverride != null ? (
                marketStreamsGroupedOverride.map((g, gi) => (
                  <Fragment key={`ms-ov-${gi}-${g.label || 'flat'}`}>
                    {g.showGroupHeader ? (
                      <tr className="live-sort-group-header">
                        <td colSpan={msColSpan}>
                          <span className="live-sort-group-label">{g.label}</span>
                          <span className={`live-sort-group-total ${g.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                            SINCE Σ {fmtUsdRound0(g.totalPnl)}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    {g.rows.map((row) => renderMarketStreamRow(row, row.category, false))}
                  </Fragment>
                ))
              ) : (
                categoryOrderFiltered.map((cat) => (
                  <Fragment key={cat}>
                    <tr className="ib-stock-group-header">
                      <td colSpan={msColSpan}>{cat}</td>
                    </tr>
                    {(sortedRowsByCategory[cat] ?? rowsByCategory[cat]).map((row) => renderMarketStreamRow(row, cat, msDragEnabled))}
                  </Fragment>
                ))
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
        {filteredRows.length > 0 &&
          (() => {
            const totalCostPnl = filteredRows.reduce((acc, row) => {
              const v = row.pnlCost
              return acc + (v != null && Number.isFinite(v) ? v : 0)
            }, 0)
            const totalCost = filteredRows.reduce((acc, row) => {
              const qty = row.qty != null && Number.isFinite(row.qty) ? row.qty : 0
              const cost = row.avgCost != null && Number.isFinite(row.avgCost) ? row.avgCost : 0
              return acc + qty * cost
            }, 0)
            const totalPct = totalCost > 0 && Number.isFinite(totalCostPnl) ? (totalCostPnl / totalCost) * 100 : null
            const { totalDailyDollar, totalDailyPct } = marketStreamsDailyTotals
            const showDailySummary = totalDailyPct != null || totalDailyDollar !== 0
            return (
              <div className="watchlist-summary-row" style={{ marginTop: 'var(--space-3)' }}>
                <span className="watchlist-summary-segment">
                  SINCE $
                  <span className={`watchlist-summary-value ${totalCostPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                    {fmtUsdRound0(totalCostPnl)}
                  </span>
                </span>
                {totalPct != null && Number.isFinite(totalPct) && (
                  <span className="watchlist-summary-segment">
                    SINCE %
                    <span className={`watchlist-summary-value watchlist-summary-value-pct ${totalPct >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                      {totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}%
                    </span>
                  </span>
                )}
                {showDailySummary && (
                  <>
                    <span className="watchlist-summary-segment">
                      DAILY $
                      <span className={`watchlist-summary-value ${totalDailyDollar >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                        {fmtUsdRound0(totalDailyDollar)}
                      </span>
                    </span>
                    {totalDailyPct != null && Number.isFinite(totalDailyPct) && (
                      <span className="watchlist-summary-segment">
                        DAILY %
                        <span className={`watchlist-summary-value watchlist-summary-value-pct ${totalDailyPct >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                          {totalDailyPct >= 0 ? '+' : ''}{totalDailyPct.toFixed(2)}%
                        </span>
                      </span>
                    )}
                  </>
                )}
              </div>
            )
          })()}
      </div>

      <div className="card card-operations strategy-active-live-card strategy-section" style={{ marginTop: 'var(--space-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <h2 className="daemon-card-title page-title-with-tooltip" style={{ margin: 0 }}>
            Strategy Active
            <InfoTooltip text="Current active structure, gate safety set, and allocation. Daemon uses these on next start. To change them, click Manage to open Strategy → Structure." />
          </h2>
          {onNavigateToStrategy && (
            <button
              type="button"
              className="btn-secondary page-title-breadcrumb-link"
              onClick={onNavigateToStrategy}
              aria-label="Manage strategy"
            >
              Manage
            </button>
          )}
        </div>
        <div className="statusSummary">
          <div>
            <strong>Structure:</strong> {j?.strategy?.active?.structure?.name ?? '—'}
            {j?.strategy?.active?.structure?.id != null && ` (${j?.strategy?.active?.structure?.id})`}
          </div>
          <div>
            <strong>Gate safety:</strong> {j?.strategy?.active?.gate_safety?.name ?? '—'}
            {j?.strategy?.active?.gate_safety?.id != null && ` (${j?.strategy?.active?.gate_safety?.id})`}
          </div>
          <div>
            <strong>Allocation:</strong> {j?.strategy?.active?.allocation?.name ?? '—'}
            {j?.strategy?.active?.allocation?.id != null && ` (${j?.strategy?.active?.allocation?.id})`}
          </div>
        </div>
        <p className="section-hint">Daemon uses these on next start.</p>
      </div>
    </div>
  )
}
