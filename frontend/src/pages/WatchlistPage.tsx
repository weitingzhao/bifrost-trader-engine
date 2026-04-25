import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Bar,
  BarStatsResponse,
  IbAccountSnapshot,
  IbPositionRow,
  PerformanceSummary,
  PositionCategory,
  RealtimeQuote,
  StatusResponse,
  WatchlistItem,
} from '../types'
import {
  fetchBars,
  fetchBarStats,
  fetchMarketTradingDay,
  fetchPerformance,
  fetchPositionCategories,
  fetchQuotes,
  fetchWatchlist,
  postMassiveSync,
  postPositionCategory,
  postWatchlist,
  deleteWatchlist,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { fmtUsd } from '../utils/format'
import { computeAtr, computeKelly, computePositionSize } from '../api/research/risk'
import type { AtrResult, KellyMetrics, PositionSizeResult } from '../api/research/risk'
import {
  cashLikeStkMarketValueOnly,
  fixedIncomeMarketValue,
  getNetLiq,
  ibParsedTotalCashValue,
  positionsGrossMarketValue,
  stkMarketValueExFiExCashLike,
  totalCashIncludingCashLikePositions,
} from './accounts/accountsUtils'
import { BarsCandlestickChart } from './data/BarsCandlestickChart'
import { inspectBarsLimitForPeriod } from './data/dataCoverageUtils'
import {
  addCalendarDaysNy,
  nyCalendarDateIso,
  presetNyRegularSessionForDate,
} from './massive/customBarsTimePresets'

interface WatchlistPageProps {
  status: StatusResponse | null
  /** Breadcrumb: Research home (same pattern as other Research pages). */
  onBreadcrumbResearch?: () => void
}

async function findLastNyTradingDayForWatchlist(): Promise<string | null> {
  let ymd = nyCalendarDateIso()
  for (let i = 0; i < 15; i++) {
    const r = await fetchMarketTradingDay(ymd)
    if (r.is_trading_day) return ymd
    ymd = addCalendarDaysNy(ymd, -1)
  }
  return null
}

/** Position category names for Research → Screener → Stock Screener workflow (same DB as Portfolio → Accounts categories). */
const WL_CAT_WATCHING = 'Watching'
const WL_CAT_SIZING = 'Sizing'

const WL_HELP_PORTFOLIO_TABLE =
  'Per-account columns use the IB snapshot on this page. Cash (IB) is TotalCashValue; Cash-like is STK lines tagged cash-like (money market, etc.); Cash total is their sum. Positions MV is Σ|qty|×mark across all legs. Host / Secondary rows follow Settings → IB event_host / trading and event_secondary. Total sums every account in the snapshot.'

const WL_HELP_MAX_DD_SCENARIO =
  'Max drawdown $ = Net liq. × this % for Host / Secondary; Total row uses aggregate net liq. Static risk budget (left tile under slider) = same % × aggregate net liq. Max drawdown (history) (right tile) is from performance history vs NAV.'

const WL_HELP_CASH_PIE =
  'Each ring splits net liq. into cash total (IB + cash-like STK), STK ex-FI (stock legs not tagged fixed income or cash-like — common underlyings), and other (fixed income, options, etc.). Legend rows pair those slices with Net liq., Ex-FI net liq., and Cash / ex-FI (same row, right column).'

const WL_HELP_ORDER_RISK_VERIFY =
  'Distance vs bid % = ROUND((Entry - Bid) / Bid, 2) shown as a percent. Positional drawdown = ROUND(Risk per share / Entry price, 2). ATR sheet uses ATR(14) from sizing compute. Order risk ($) uses |Risk per share| × Share amt.'

const WL_HELP_ORDER_SECTION =
  'Danger zone: live bid and editable entry, exit, and share amount feed downstream order sizing. Share amount steps in 100s by default. Verify every field before trading.'

function categoryIdForName(cats: PositionCategory[], name: string): number | null {
  const n = name.trim().toLowerCase()
  const hit = cats.find(c => String(c.name ?? '').trim().toLowerCase() === n)
  return hit != null && Number.isFinite(Number(hit.id)) ? Number(hit.id) : null
}

function itemMatchesCategory(item: WatchlistItem, name: string, resolvedId: number | null): boolean {
  if (resolvedId != null && item.category_id != null && Number(item.category_id) === resolvedId) return true
  return String(item.category ?? '').trim().toLowerCase() === name.trim().toLowerCase()
}

function isStockRow(item: WatchlistItem): boolean {
  return (item.sec_type || 'STK').toUpperCase() !== 'OPT'
}

function isUncategorizedStock(item: WatchlistItem): boolean {
  if (!isStockRow(item)) return false
  if (item.category_id != null && Number.isFinite(Number(item.category_id))) return false
  const cat = String(item.category ?? '').trim()
  return !cat || cat.toLowerCase() === 'uncategorized'
}

function isUncategorizedOption(item: WatchlistItem): boolean {
  if ((item.sec_type || '').toUpperCase() !== 'OPT') return false
  if (item.category_id != null && Number.isFinite(Number(item.category_id))) return false
  const cat = String(item.category ?? '').trim()
  return !cat || cat.toLowerCase() === 'uncategorized'
}

function normalizeToContractKey(input: string): { contract_key: string; symbol?: string; sec_type?: string } {
  const t = input.trim()
  if (!t) return { contract_key: '' }
  if (t.includes('|')) return { contract_key: t }
  return { contract_key: `${t}|STK|||`, symbol: t, sec_type: 'STK' }
}
function positionToContractKey(p: IbPositionRow): string {
  const ck = (p as { contract_key?: string }).contract_key
  if (ck && typeof ck === 'string' && ck.trim()) return ck.trim()
  const sym = (p.symbol || '').trim()
  const sec = (p.secType || 'STK').trim() || 'STK'
  const exp = (p.expiry || p.lastTradeDateOrContractMonth || '').trim()
  const str = p.strike != null ? String(p.strike) : ''
  const rt = (p.right || '').trim()
  return `${sym}|${sec}|${exp}|${str}|${rt}`
}

function watchlistItemLabel(item: WatchlistItem): string {
  if (item.display_label && String(item.display_label).trim()) return item.display_label.trim()
  if (item.sec_type === 'OPT' && item.symbol) {
    const exp = item.expiry || ''
    const right = item.option_right || ''
    const strike = item.strike != null ? String(item.strike) : ''
    return `${item.symbol} ${exp} ${right} ${strike}`.trim() || item.contract_key
  }
  return (item.symbol || item.contract_key || '').trim() || item.contract_key
}

/** Substring (multi-token AND) or ordered subsequence over label + symbol + contract_key. */
function fuzzyMatchWatchlistItem(item: WatchlistItem, queryRaw: string): boolean {
  const q0 = queryRaw.trim().toLowerCase()
  if (!q0) return true
  const label = watchlistItemLabel(item).toLowerCase()
  const sym = String(item.symbol || '').trim().toLowerCase()
  const ck = String(item.contract_key || '').trim().toLowerCase()
  const hay = `${label} ${sym} ${ck}`.trim()
  const tokens = q0.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) return tokens.every(t => hay.includes(t))
  const single = tokens[0]
  if (hay.includes(single)) return true
  let i = 0
  for (const ch of single) {
    const j = hay.indexOf(ch, i)
    if (j === -1) return false
    i = j + 1
  }
  return true
}

/** Cash, ex‑FI stocks (STK ex cash-like), and remainder vs net liq. for Host / Secondary pie. */
function portfolioCashPieFromRow(
  row:
    | {
        cashTotal: number
        netLiq: number
        netLiqExFi: number
        cashPctExFi: number | null
        stkExFiMv: number
      }
    | null
    | undefined,
): {
  cash: number
  stkExFi: number
  other: number
  net: number
  cashPctOfNet: number
  stkPctOfNet: number
  otherPctOfNet: number
  cashTurnEnd: number
  stkTurnEnd: number
  netLiqExFi: number
  cashPctExFi: number | null
} | null {
  if (!row) return null
  const cash = row.cashTotal
  const stkExFi = Math.max(0, row.stkExFiMv)
  const net = row.netLiq
  const other = Math.max(0, net - cash - stkExFi)
  const sumParts = cash + stkExFi + other
  const ringDenom = sumParts > 0 ? sumParts : 1e-9
  const cashR = cash / ringDenom
  const stkR = stkExFi / ringDenom
  const cashTurnEnd = cashR
  const stkTurnEnd = cashR + stkR
  const cashPctOfNet = net > 0 ? (cash / net) * 100 : 0
  const stkPctOfNet = net > 0 ? (stkExFi / net) * 100 : 0
  const otherPctOfNet = net > 0 ? (other / net) * 100 : 0
  return {
    cash,
    stkExFi,
    other,
    net,
    cashPctOfNet,
    stkPctOfNet,
    otherPctOfNet,
    cashTurnEnd,
    stkTurnEnd,
    netLiqExFi: row.netLiqExFi,
    cashPctExFi: row.cashPctExFi,
  }
}

function formatExpiry(expiry: string | null | undefined): string {
  if (expiry == null || expiry === '') return '—'
  const s = String(expiry).trim()
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return s
}

function normalizeExpiryInput(input: string): string {
  const s = input.trim().replace(/-/g, '')
  if (/^\d{8}$/.test(s)) return s
  if (/^\d{6}$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return input.trim().replace(/-/g, '')
  return input.trim()
}

function formatOptionRight(right: string | null | undefined): string {
  if (right == null || right === '') return '—'
  const r = String(right).trim().toUpperCase()
  if (r === 'C') return 'C'
  if (r === 'P') return 'P'
  return right
}

function formatStrike(strike: number | null | undefined): string {
  if (strike == null) return '—'
  const n = Number(strike)
  if (Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n)
}

function renderQuoteCell(q: RealtimeQuote | undefined): ReactNode {
  if (!q) return <span className="wl2-muted">—</span>
  const last = q.last != null && Number.isFinite(q.last) ? q.last : null
  const bid = q.bid != null && Number.isFinite(q.bid) ? q.bid : null
  const ask = q.ask != null && Number.isFinite(q.ask) ? q.ask : null
  return (
    <span className="wl2-quote">
      <span className="wl2-quote__last">{last != null ? fmtUsd(last) : '—'}</span>
      {(bid != null || ask != null) && (
        <span className="wl2-quote__ba">
          {bid != null && (
            <span className={`wl2-quote__v${last != null && bid < last ? ' pnl-negative' : last != null && bid > last ? ' pnl-positive' : ''}`}>
              {bid.toFixed(2)}
            </span>
          )}
          <span className="wl2-quote__sep">/</span>
          {ask != null && (
            <span className={`wl2-quote__v${last != null && ask > last ? ' pnl-negative' : last != null && ask < last ? ' pnl-positive' : ''}`}>
              {ask.toFixed(2)}
            </span>
          )}
        </span>
      )}
    </span>
  )
}

export function WatchlistPage({ status, onBreadcrumbResearch }: WatchlistPageProps) {
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  const [watchlistError, setWatchlistError] = useState<string | null>(null)
  const [addContractKey, setAddContractKey] = useState('')
  const [addPending, setAddPending] = useState(false)
  const [addOptionForSymbol, setAddOptionForSymbol] = useState<string | null>(null)
  const [addOptExpiry, setAddOptExpiry] = useState('')
  const [addOptRight, setAddOptRight] = useState<'CALL' | 'PUT'>('CALL')
  const [addOptStrike, setAddOptStrike] = useState('')
  const [analysisLoadingSymbol, setAnalysisLoadingSymbol] = useState<string | null>(null)
  const [analysisResult, setAnalysisResult] = useState<{ symbol: string; stats: BarStatsResponse } | null>(null)
  const [fetchMarketDataStep, setFetchMarketDataStep] = useState<string | null>(null)
  const [fetchMarketDataError, setFetchMarketDataError] = useState<string | null>(null)
  /** Bar-stats panel: chart from PG via GET /bars (stock_day / stock_min). */
  const [analysisChartPeriod, setAnalysisChartPeriod] = useState<'1 D' | '1 min'>('1 D')
  const [analysisChartBars, setAnalysisChartBars] = useState<Bar[]>([])
  const [analysisChartLoading, setAnalysisChartLoading] = useState(false)
  const [analysisChartError, setAnalysisChartError] = useState<string | null>(null)
  const [analysisChartInfo, setAnalysisChartInfo] = useState<string | null>(null)
  const [chartShowVolume, setChartShowVolume] = useState(true)
  const [chartShowVwap, setChartShowVwap] = useState(false)
  const [chartShowMacd, setChartShowMacd] = useState(true)
  const [chartShowBb, setChartShowBb] = useState(true)
  const [chartShowRsi, setChartShowRsi] = useState(true)
  const [chartShowSr, setChartShowSr] = useState(false)
  const [realtimeQuotes, setRealtimeQuotes] = useState<RealtimeQuote[]>([])
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  const [showPositionPicker, setShowPositionPicker] = useState(false)
  const [primaryTab, setPrimaryTab] = useState<'watching' | 'sizing' | 'positions'>('watching')
  const [positionSubTab, setPositionSubTab] = useState<'stocks' | 'options'>('stocks')
  const [promoteContractKey, setPromoteContractKey] = useState('')
  const [promotePickerOpen, setPromotePickerOpen] = useState(false)
  const [promoteFilter, setPromoteFilter] = useState('')
  const promoteComboboxRef = useRef<HTMLDivElement>(null)
  const watchlistCategoryEnsureAttempted = useRef(false)
  const sizingPanelDismissedRef = useRef(false)
  const prevPrimaryTabRef = useRef(primaryTab)
  const sizingRowsKeySigRef = useRef('')
  const orderDraftSymbolRef = useRef<string | null>(null)

  // Sizing analysis state
  const [perfSummary, setPerfSummary] = useState<PerformanceSummary | null>(null)
  const [kellyFraction, setKellyFraction] = useState<number>(0.5)
  const [sizeAtrMultiplier, setSizeAtrMultiplier] = useState<number>(2)
  const [selectedSizingSymbol, setSelectedSizingSymbol] = useState<string | null>(null)
  const [sizeComputeLoading, setSizeComputeLoading] = useState(false)
  const [sizeComputeError, setSizeComputeError] = useState<string | null>(null)
  const [sizeCurrentPrice, setSizeCurrentPrice] = useState<number | null>(null)
  const [sizeAtrResult, setSizeAtrResult] = useState<AtrResult | null>(null)
  const [sizePosResult, setSizePosResult] = useState<PositionSizeResult | null>(null)
  const [orderEntryPrice, setOrderEntryPrice] = useState('')
  const [orderExitPrice, setOrderExitPrice] = useState('')
  const [orderShareAmt, setOrderShareAmt] = useState('100')
  const [portfolioRiskPowerCollapsed, setPortfolioRiskPowerCollapsed] = useState(false)
  /** Portfolio max-drawdown % (5–50); drives table Max DD $, static risk budget, and Order sizing ladder row. */
  const [staticMaxDdPctCap, setStaticMaxDdPctCap] = useState(20)
  /** Per-trade static risk rate (% of total capital). */
  const [staticRiskPctPerTrade, setStaticRiskPctPerTrade] = useState(1)

  const positions = useMemo(() => {
    return (status?.portfolio?.accounts || []).flatMap((acc: IbAccountSnapshot) => (acc.positions || []))
  }, [status?.portfolio?.accounts])

  const contractKeysWithPosition = useMemo(
    () => new Set(positions.map(p => positionToContractKey(p))),
    [positions],
  )

  const capital = useMemo<number>(() => {
    const accounts = status?.portfolio?.accounts ?? []
    return accounts.reduce((sum, a) => sum + getNetLiq(a), 0)
  }, [status?.portfolio?.accounts])

  const portfolioCashRollup = useMemo(() => {
    const accounts = status?.portfolio?.accounts ?? []
    const ibAcc = status?.config?.ib_client?.account
    const hostId =
      (ibAcc?.event_host ?? ibAcc?.trading ?? '').toString().trim() || null
    const secondaryId = (ibAcc?.event_secondary ?? '').toString().trim() || null

    let totalCashMerged = 0
    let totalBuyingPower = 0
    for (const a of accounts) {
      totalCashMerged += totalCashIncludingCashLikePositions(a)
      const bpRaw = a.summary?.BuyingPower
      if (bpRaw != null) {
        const n = parseFloat(String(bpRaw))
        if (Number.isFinite(n)) totalBuyingPower += n
      }
    }

    const findAcc = (id: string | null) =>
      id ? accounts.find(x => (x.account_id ?? '').toString().trim() === id) : undefined
    const hostAcc = findAcc(hostId)
    const secondaryAcc = findAcc(secondaryId)

    return {
      totalCashMerged,
      totalBuyingPower,
      hostId,
      secondaryId,
      hostMerged: hostId ? (hostAcc ? totalCashIncludingCashLikePositions(hostAcc) : null) : null,
      hostReason: !hostId ? ('no_config' as const) : !hostAcc ? ('no_account' as const) : null,
      secondaryMerged: secondaryId
        ? secondaryAcc
          ? totalCashIncludingCashLikePositions(secondaryAcc)
          : null
        : null,
      secondaryReason: !secondaryId
        ? ('no_config' as const)
        : !secondaryAcc
          ? ('no_account' as const)
          : null,
    }
  }, [status?.portfolio?.accounts, status?.config?.ib_client?.account])

  const portfolioAccountTable = useMemo(() => {
    const accounts = status?.portfolio?.accounts ?? []
    const ibAcc = status?.config?.ib_client?.account
    const hostId = (ibAcc?.event_host ?? ibAcc?.trading ?? '').toString().trim() || null
    const secondaryId = (ibAcc?.event_secondary ?? '').toString().trim() || null
    const findAcc = (id: string | null) =>
      id ? accounts.find(x => (x.account_id ?? '').toString().trim() === id) : undefined
    const hostAcc = findAcc(hostId)
    const secondaryAcc = findAcc(secondaryId)
    const pct = Math.max(5, Math.min(50, staticMaxDdPctCap)) / 100

    const rowFromAcc = (acc: IbAccountSnapshot | undefined) => {
      if (!acc) return null
      const ib = ibParsedTotalCashValue(acc)
      const cl = cashLikeStkMarketValueOnly(acc)
      const nl = getNetLiq(acc)
      const fiMv = fixedIncomeMarketValue(acc)
      const stkEx = stkMarketValueExFiExCashLike(acc)
      const ct = ib + cl
      const netLiqExFi = Math.max(0, nl - fiMv)
      const cashPctExFi = netLiqExFi > 0 ? (ct / netLiqExFi) * 100 : null
      return {
        ibCash: ib,
        cashLike: cl,
        cashTotal: ct,
        positionsMv: positionsGrossMarketValue(acc),
        fixedIncomeMv: fiMv,
        stkExFiMv: stkEx,
        netLiq: nl,
        netLiqExFi,
        cashPctExFi,
        maxDdUsd: nl * pct,
      }
    }

    const sumAcc = (fn: (a: IbAccountSnapshot) => number) => accounts.reduce((s, a) => s + fn(a), 0)
    const totalNet = accounts.reduce((s, a) => s + getNetLiq(a), 0)
    const totalFiMv = sumAcc(fixedIncomeMarketValue)
    const totalCashSum = sumAcc(totalCashIncludingCashLikePositions)
    const totalNetExFi = Math.max(0, totalNet - totalFiMv)
    const totalRow = {
      ibCash: sumAcc(ibParsedTotalCashValue),
      cashLike: sumAcc(cashLikeStkMarketValueOnly),
      cashTotal: totalCashSum,
      positionsMv: sumAcc(positionsGrossMarketValue),
      fixedIncomeMv: totalFiMv,
      stkExFiMv: sumAcc(stkMarketValueExFiExCashLike),
      netLiq: totalNet,
      netLiqExFi: totalNetExFi,
      cashPctExFi: totalNetExFi > 0 ? (totalCashSum / totalNetExFi) * 100 : null,
      maxDdUsd: totalNet * pct,
    }

    return {
      hostId,
      secondaryId,
      hostAcc,
      secondaryAcc,
      hostRow: rowFromAcc(hostAcc),
      secondaryRow: rowFromAcc(secondaryAcc),
      totalRow,
    }
  }, [status?.portfolio?.accounts, status?.config?.ib_client?.account, staticMaxDdPctCap])

  const hostCashPie = useMemo(
    () => portfolioCashPieFromRow(portfolioAccountTable.hostRow ?? undefined),
    [portfolioAccountTable],
  )
  const secondaryCashPie = useMemo(
    () => portfolioCashPieFromRow(portfolioAccountTable.secondaryRow ?? undefined),
    [portfolioAccountTable],
  )

  const portfolioDdFromHistory = useMemo(() => {
    const md = perfSummary?.max_drawdown
    if (md == null || !Number.isFinite(md)) return { usd: null as number | null, pctOfNav: null as number | null }
    const usd = Math.abs(md)
    const pctOfNav = capital > 0 ? (usd / capital) * 100 : null
    return { usd, pctOfNav }
  }, [perfSummary?.max_drawdown, capital])

  const staticRiskBudgetUsd = useMemo(() => {
    if (capital <= 0 || !Number.isFinite(staticMaxDdPctCap)) return 0
    const pct = Math.max(5, Math.min(50, staticMaxDdPctCap))
    return (capital * pct) / 100
  }, [capital, staticMaxDdPctCap])

  const staticRiskUsdPerTrade = useMemo(() => {
    if (capital <= 0 || !Number.isFinite(staticRiskPctPerTrade)) return 0
    const pct = Math.max(0.1, Math.min(5, staticRiskPctPerTrade))
    return (capital * pct) / 100
  }, [capital, staticRiskPctPerTrade])

  const kellyMetrics = useMemo<KellyMetrics>(() => {
    if (!perfSummary) return { kelly_pct: 0, effective_kelly: 0, is_valid: false }
    return computeKelly(perfSummary.win_rate, perfSummary.profit_factor, kellyFraction)
  }, [perfSummary, kellyFraction])

  const loadWatchlist = useCallback(async () => {
    setWatchlistLoading(true)
    setWatchlistError(null)
    try {
      const res = await fetchWatchlist()
      setWatchlistItems(res.items || [])
    } catch (e) {
      setWatchlistError(e instanceof Error ? e.message : 'Load failed')
      setWatchlistItems([])
    } finally {
      setWatchlistLoading(false)
    }
  }, [])

  useEffect(() => { loadWatchlist() }, [loadWatchlist])

  useEffect(() => {
    let cancelled = false
    fetchPositionCategories()
      .then((res) => { if (!cancelled) setPositionCategories(res.items ?? []) })
      .catch(() => { if (!cancelled) setPositionCategories([]) })
    return () => { cancelled = true }
  }, [])

  /** Ensure DB has Watching / Sizing categories for this workflow (single POST attempt per mount). */
  useEffect(() => {
    if (positionCategories.length === 0) return
    const wid = categoryIdForName(positionCategories, WL_CAT_WATCHING)
    const sid = categoryIdForName(positionCategories, WL_CAT_SIZING)
    if (wid != null && sid != null) return
    if (watchlistCategoryEnsureAttempted.current) return
    watchlistCategoryEnsureAttempted.current = true
    let cancelled = false
    ;(async () => {
      try {
        if (wid == null) await postPositionCategory({ name: WL_CAT_WATCHING, sort_order: 2 })
        if (!cancelled && sid == null) await postPositionCategory({ name: WL_CAT_SIZING, sort_order: 3 })
        const res = await fetchPositionCategories()
        if (!cancelled) setPositionCategories(res.items ?? [])
      } catch {
        /* keep existing categories */
      }
    })()
    return () => { cancelled = true }
  }, [positionCategories])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetchQuotes()
        if (!cancelled) setRealtimeQuotes(res.quotes || [])
      } catch {
        if (!cancelled) setRealtimeQuotes([])
      }
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchPerformance()
      .then(res => { if (!cancelled) setPerfSummary(res.summary) })
      .catch(() => { if (!cancelled) setPerfSummary(null) })
    return () => { cancelled = true }
  }, [])

  const loadAnalysisChartFromDb = useCallback(async (sym: string, period: '1 D' | '1 min') => {
    setAnalysisChartLoading(true)
    setAnalysisChartError(null)
    try {
      const res = await fetchBars(sym, period, inspectBarsLimitForPeriod(period))
      const rows = res.bars ?? []
      setAnalysisChartBars(rows)
      if (rows.length === 0) {
        const hint =
          (typeof res.message === 'string' && res.message.trim()) ||
          `No ${period} bars in PostgreSQL for ${sym}. Use Fetch from Massive, wait for the Celery job to finish, then Reload chart.`
        setAnalysisChartInfo(hint)
      } else {
        setAnalysisChartInfo(null)
      }
    } catch (e) {
      setAnalysisChartBars([])
      setAnalysisChartError(e instanceof Error ? e.message : 'Load chart failed')
    } finally {
      setAnalysisChartLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!analysisResult?.symbol) return
    void loadAnalysisChartFromDb(analysisResult.symbol, analysisChartPeriod)
  }, [analysisResult?.symbol, analysisChartPeriod, loadAnalysisChartFromDb])

  const analysisChartBarsSorted = useMemo(() => {
    if (analysisChartBars.length === 0) return []
    return [...analysisChartBars].filter(b => b.time != null).sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  }, [analysisChartBars])

  // Auto-recompute position result whenever inputs change without re-fetching bars
  useEffect(() => {
    if (sizeAtrResult != null && sizeCurrentPrice != null) {
      setSizePosResult(computePositionSize(capital, sizeCurrentPrice, sizeAtrResult, kellyMetrics, sizeAtrMultiplier))
    }
  }, [capital, sizeCurrentPrice, sizeAtrResult, kellyMetrics, sizeAtrMultiplier])

  const quoteBySymbol = useMemo(() => {
    const m: Record<string, RealtimeQuote> = {}
    for (const q of realtimeQuotes) {
      if (!q.symbol) continue
      const st = (q.sec_type ?? '').toUpperCase()
      if (st === 'STK' || (st === '' && !q.contract_key)) m[q.symbol] = q
    }
    return m
  }, [realtimeQuotes])

  const quoteBySymbolUpper = useMemo(() => {
    const m: Record<string, RealtimeQuote> = {}
    for (const [k, v] of Object.entries(quoteBySymbol)) {
      m[k.trim().toUpperCase()] = v
    }
    return m
  }, [quoteBySymbol])

  const quoteByContractKey = useMemo(
    () => Object.fromEntries(
      realtimeQuotes
        .filter((q): q is RealtimeQuote & { contract_key: string } => Boolean(q.contract_key))
        .map(q => [q.contract_key, q]),
    ),
    [realtimeQuotes],
  )

  function formatOrderInputNumber(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return ''
    return String(Number(v.toFixed(digits)))
  }

  function defaultShareAmt(shares: number | null | undefined): string {
    if (shares != null && Number.isFinite(shares) && shares > 0) {
      const conservativeHundreds = Math.floor(shares / 100) * 100
      return String(Math.max(100, conservativeHundreds || 100))
    }
    return '100'
  }

  const selectedSizingQuote = useMemo(
    () => (selectedSizingSymbol ? quoteBySymbolUpper[selectedSizingSymbol.trim().toUpperCase()] ?? null : null),
    [quoteBySymbolUpper, selectedSizingSymbol],
  )

  const selectedSizingBid = useMemo(() => {
    if (!selectedSizingQuote) return null
    const bid = selectedSizingQuote.bid
    return bid != null && Number.isFinite(Number(bid)) && Number(bid) > 0 ? Number(bid) : null
  }, [selectedSizingQuote])

  const sizingOrderAnalytics = useMemo(() => {
    const atr14 = sizeAtrResult?.atr14 ?? 0
    const stopD =
      sizePosResult != null && sizePosResult.stop_distance > 0
        ? sizePosResult.stop_distance
        : atr14 > 0
          ? sizeAtrMultiplier * atr14
          : 0
    const price = sizeCurrentPrice

    const shares = sizePosResult?.is_valid ? sizePosResult.shares : 0
    const notional = price != null && price > 0 && shares > 0 ? shares * price : null
    const investmentWeightPct = notional != null && capital > 0 ? (notional / capital) * 100 : null
    const intendedRiskPct = sizePosResult?.is_valid ? sizePosResult.risk_pct : null
    const cashLeftAfter = notional != null ? portfolioCashRollup.totalCashMerged - notional : null

    const maxSharesFromRisk = (usd: number | null | undefined) => {
      if (usd == null || !Number.isFinite(usd) || usd <= 0 || stopD <= 0) return null
      return Math.floor(usd / stopD)
    }

    const pctCap = Math.max(5, Math.min(50, staticMaxDdPctCap))
    const portfolioScenarioRiskUsd = capital > 0 && Number.isFinite(staticMaxDdPctCap) ? (capital * pctCap) / 100 : null
    const histMaxLossUsd =
      perfSummary?.max_loss != null && Number.isFinite(perfSummary.max_loss) ? Math.abs(perfSummary.max_loss) : null
    const histAvgLossUsd =
      perfSummary?.avg_loss != null && Number.isFinite(perfSummary.avg_loss) ? Math.abs(perfSummary.avg_loss) : null

    const kellyShares = sizePosResult?.is_valid ? sizePosResult.shares : null
    const kellyRiskUsd = sizePosResult?.is_valid ? sizePosResult.dollar_risk : null
    const capRows = [
      {
        key: 'kelly',
        label: 'Order sizing (Kelly)',
        maxRiskUsd: kellyRiskUsd,
        maxShares: kellyShares,
      },
      {
        key: 'portfolioDd',
        label: `Portfolio max DD budget (${pctCap}% NAV, linked)`,
        maxRiskUsd: portfolioScenarioRiskUsd,
        maxShares: maxSharesFromRisk(portfolioScenarioRiskUsd),
      },
      {
        key: 'histMax',
        label: 'History max loss (abs)',
        maxRiskUsd: histMaxLossUsd,
        maxShares: maxSharesFromRisk(histMaxLossUsd),
      },
      {
        key: 'histAvg',
        label: 'History avg loss (abs)',
        maxRiskUsd: histAvgLossUsd,
        maxShares: maxSharesFromRisk(histAvgLossUsd),
      },
    ] as const

    const cashCapShares =
      price != null && price > 0 && portfolioCashRollup.totalCashMerged > 0
        ? Math.floor(portfolioCashRollup.totalCashMerged / price)
        : null

    const shareCandidates = [
      ...capRows.map(r => r.maxShares).filter((x): x is number => x != null && Number.isFinite(x) && x >= 0),
      cashCapShares,
    ].filter((x): x is number => x != null && Number.isFinite(x))

    const availableMinShares = shareCandidates.length > 0 ? Math.min(...shareCandidates) : null

    return {
      stopD,
      intendedShares: shares,
      intendedRiskPct,
      investmentUsd: notional,
      investmentWeightPct,
      cashLeftAfter,
      capRows,
      cashCapShares,
      availableMinShares,
    }
  }, [
    sizeAtrResult,
    sizePosResult,
    sizeAtrMultiplier,
    sizeCurrentPrice,
    capital,
    portfolioCashRollup,
    staticMaxDdPctCap,
    perfSummary?.max_loss,
    perfSummary?.avg_loss,
  ])

  const manualOrderAnalytics = useMemo(() => {
    const entryNum = Number(orderEntryPrice)
    const exitNum = Number(orderExitPrice)
    const sharesNum = Number(orderShareAmt)
    const entry = Number.isFinite(entryNum) && entryNum > 0 ? entryNum : null
    const exit = Number.isFinite(exitNum) && exitNum > 0 ? exitNum : null
    const shares = Number.isFinite(sharesNum) && sharesNum > 0 ? Math.floor(sharesNum) : null
    const bid = selectedSizingBid
    const distance = entry != null && bid != null ? entry - bid : null
    const distancePctOfBid =
      entry != null && bid != null && bid !== 0
        ? Math.round(((entry - bid) / bid) * 100) / 100
        : null
    const riskPerShare = entry != null && exit != null ? entry - exit : null
    const riskPerShareAbs = riskPerShare != null ? Math.abs(riskPerShare) : null
    const orderRiskUsd = riskPerShareAbs != null && shares != null ? riskPerShareAbs * shares : null
    const riskPct = orderRiskUsd != null && capital > 0 ? (orderRiskUsd / capital) * 100 : null
    const investmentUsd = entry != null && shares != null ? entry * shares : null
    const investmentWeightPct = investmentUsd != null && capital > 0 ? (investmentUsd / capital) * 100 : null
    const cashLeftAfter = investmentUsd != null ? portfolioCashRollup.totalCashMerged - investmentUsd : null
    const atr14 = sizeAtrResult?.atr14 ?? null
    const atrPctPercent =
      atr14 != null && entry != null && entry > 0
        ? Math.round((atr14 / entry) * 100 * 100) / 100
        : null
    const atrRisk =
      atr14 != null && atr14 > 0 && riskPerShare != null
        ? Math.round((riskPerShare / atr14) * 100) / 100
        : null
    const positionalDrawdownRatio =
      riskPerShare != null && entry != null && entry > 0
        ? Math.round((riskPerShare / entry) * 100) / 100
        : null
    return {
      entry,
      exit,
      shares,
      distance,
      distancePctOfBid,
      riskPerShare,
      positionalDrawdownRatio,
      orderRiskUsd,
      riskPct,
      investmentUsd,
      investmentWeightPct,
      cashLeftAfter,
      atr14,
      atrPctPercent,
      atrRisk,
      isComplete: entry != null && exit != null && shares != null && riskPerShare != null,
    }
  }, [
    orderEntryPrice,
    orderExitPrice,
    orderShareAmt,
    capital,
    portfolioCashRollup.totalCashMerged,
    sizeAtrResult,
    selectedSizingBid,
  ])

  const handleAddWatchlist = useCallback(
    async (
      contract_key: string,
      source: string,
      symbol?: string,
      sec_type?: string,
      expiry?: string,
      strike?: number,
      option_right?: string,
      category_id?: number | null,
    ) => {
      const key = contract_key.trim()
      if (!key) return
      setAddPending(true)
      setWatchlistError(null)
      try {
        const res = await postWatchlist({
          contract_key: key,
          symbol: symbol || undefined,
          sec_type: sec_type || undefined,
          expiry: expiry || undefined,
          strike,
          option_right: option_right || undefined,
          source,
          ...(category_id !== undefined ? { category_id } : {}),
        })
        if (res.ok) await loadWatchlist()
        else setWatchlistError(res.error || 'Add failed')
      } catch (e) {
        setWatchlistError(e instanceof Error ? e.message : 'Add request failed')
      } finally {
        setAddPending(false)
      }
    },
    [loadWatchlist],
  )

  const handleRemoveWatchlist = useCallback(
    async (item: WatchlistItem) => {
      setWatchlistError(null)
      const res = await deleteWatchlist({ contract_key: item.contract_key })
      if (res.ok) await loadWatchlist()
      else setWatchlistError(res.error || 'Remove failed')
    },
    [loadWatchlist],
  )

  const handleWatchlistCategoryChange = useCallback(
    async (item: WatchlistItem, category_id: number | null) => {
      setWatchlistError(null)
      const res = await postWatchlist({
        contract_key: item.contract_key,
        symbol: item.symbol ?? undefined,
        sec_type: item.sec_type ?? undefined,
        expiry: item.expiry ?? undefined,
        strike: item.strike ?? undefined,
        option_right: item.option_right ?? undefined,
        display_label: item.display_label ?? undefined,
        source: item.source ?? undefined,
        category_id,
        optionable: item.optionable ?? undefined,
      })
      if (res.ok) await loadWatchlist()
      else setWatchlistError(res.error || 'Failed to update category')
    },
    [loadWatchlist],
  )

  const handleOptionableToggle = useCallback(
    async (item: WatchlistItem) => {
      setWatchlistError(null)
      const next = !(item.optionable === true)
      const res = await postWatchlist({
        contract_key: item.contract_key,
        symbol: item.symbol ?? undefined,
        sec_type: item.sec_type ?? undefined,
        expiry: item.expiry ?? undefined,
        strike: item.strike ?? undefined,
        option_right: item.option_right ?? undefined,
        display_label: item.display_label ?? undefined,
        source: item.source ?? undefined,
        category_id: item.category_id ?? undefined,
        optionable: next,
      })
      if (res.ok) await loadWatchlist()
      else setWatchlistError(res.error || 'Failed to update Option?')
    },
    [loadWatchlist],
  )

  const watchlistContractKeys = useMemo(() => new Set(watchlistItems.map(w => w.contract_key)), [watchlistItems])

  const positionsNotInWatchlist = useMemo(() => {
    return positions.filter(p => {
      const st = (p.secType ?? '').toString().trim().toUpperCase()
      if (st !== 'STK' && st !== '') return false
      return !watchlistContractKeys.has(positionToContractKey(p))
    })
  }, [positions, watchlistContractKeys])

  const allStocks = useMemo(
    () => watchlistItems.filter(w => (w.sec_type || 'STK').toUpperCase() !== 'OPT'),
    [watchlistItems],
  )
  const watchlistOptions = useMemo(
    () => watchlistItems.filter(w => (w.sec_type || '').toUpperCase() === 'OPT'),
    [watchlistItems],
  )

  const watchingCategoryId = useMemo(() => categoryIdForName(positionCategories, WL_CAT_WATCHING), [positionCategories])
  const sizingCategoryId = useMemo(() => categoryIdForName(positionCategories, WL_CAT_SIZING), [positionCategories])

  const hasPosition = useCallback(
    (item: WatchlistItem) => contractKeysWithPosition.has(item.contract_key.trim()),
    [contractKeysWithPosition],
  )

  const matchesWatching = useCallback(
    (item: WatchlistItem) => itemMatchesCategory(item, WL_CAT_WATCHING, watchingCategoryId),
    [watchingCategoryId],
  )
  const matchesSizing = useCallback(
    (item: WatchlistItem) => itemMatchesCategory(item, WL_CAT_SIZING, sizingCategoryId),
    [sizingCategoryId],
  )

  /** Stocks: Watching + uncategorized, excluding sizing-only rows (held names stay here too). */
  const watchingStockRows = useMemo(() => {
    return allStocks.filter((s) => {
      if (matchesSizing(s)) return false
      if (matchesWatching(s)) return true
      if (isUncategorizedStock(s)) return true
      return false
    })
  }, [allStocks, matchesSizing, matchesWatching])

  /** Stocks on other portfolio categories (not Watching/Sizing / uncategorized), including if held. */
  const otherCategoryStockRows = useMemo(() => {
    return allStocks.filter((s) => {
      if (matchesWatching(s) || matchesSizing(s)) return false
      if (isUncategorizedStock(s)) return false
      return true
    })
  }, [allStocks, matchesSizing, matchesWatching])

  const sizingStockRows = useMemo(
    () => allStocks.filter(s => matchesSizing(s)),
    [allStocks, matchesSizing],
  )

  const positionStockRows = useMemo(() => allStocks.filter(hasPosition), [allStocks, hasPosition])
  const positionOptRows = useMemo(() => watchlistOptions.filter(hasPosition), [watchlistOptions, hasPosition])

  /** Option legs: Watching + uncategorized (held legs stay here too). */
  const watchingOptionRows = useMemo(() => {
    return watchlistOptions.filter((o) => {
      if (matchesSizing(o)) return false
      if (matchesWatching(o)) return true
      if (isUncategorizedOption(o)) return true
      return false
    })
  }, [watchlistOptions, matchesSizing, matchesWatching])

  /** All STK rows on the watchlist (any category) — any can be moved to Sizing. */
  const stocksForPromoteToSizing = useMemo(
    () => [...allStocks].sort((a, b) => watchlistItemLabel(a).localeCompare(watchlistItemLabel(b))),
    [allStocks],
  )

  const stocksForPromoteMenu = useMemo(
    () => stocksForPromoteToSizing.filter(item => fuzzyMatchWatchlistItem(item, promoteFilter)),
    [stocksForPromoteToSizing, promoteFilter],
  )

  const closePromotePicker = useCallback(() => {
    setPromotePickerOpen(false)
    setPromoteFilter('')
  }, [])

  const watchingTabCount = watchingStockRows.length + watchingOptionRows.length
  const sizingTabCount = sizingStockRows.length
  const positionsTabCount = positionStockRows.length + positionOptRows.length

  const handlePromoteToSizing = useCallback(async () => {
    const ck = promoteContractKey.trim()
    if (!ck || sizingCategoryId == null) return
    const item = stocksForPromoteToSizing.find(i => i.contract_key.trim() === ck)
    if (!item) return
    await handleWatchlistCategoryChange(item, sizingCategoryId)
    setPromoteContractKey('')
    closePromotePicker()
  }, [promoteContractKey, sizingCategoryId, stocksForPromoteToSizing, handleWatchlistCategoryChange, closePromotePicker])

  const promoteSelectedItem = useMemo(
    () => stocksForPromoteToSizing.find(i => i.contract_key.trim() === promoteContractKey.trim()),
    [stocksForPromoteToSizing, promoteContractKey],
  )

  useEffect(() => {
    if (!promotePickerOpen) return
    function onPointerDown(ev: PointerEvent) {
      const root = promoteComboboxRef.current
      if (root && !root.contains(ev.target as Node)) closePromotePicker()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [promotePickerOpen, closePromotePicker])

  useEffect(() => {
    closePromotePicker()
  }, [primaryTab, closePromotePicker])

  function symbolFromItem(item: WatchlistItem): string {
    if (item.symbol && String(item.symbol).trim()) return String(item.symbol).trim()
    const parts = (item.contract_key || '').split('|')
    return (parts[0] || '').trim()
  }

  function openAddOptionModal(item: WatchlistItem) {
    const symbol = (item.symbol || (item.contract_key || '').split('|')[0] || '').trim()
    if (!symbol) return
    setAddOptionForSymbol(symbol)
    setAddOptExpiry('')
    setAddOptRight('CALL')
    setAddOptStrike('')
  }

  function closeAddOptionModal() {
    setAddOptionForSymbol(null)
    setAddOptExpiry('')
    setAddOptStrike('')
  }

  async function submitAddOption() {
    if (!addOptionForSymbol) return
    const expiry = normalizeExpiryInput(addOptExpiry)
    const strikeNum = parseFloat(addOptStrike.trim())
    if (!expiry || Number.isNaN(strikeNum) || strikeNum < 0) return
    const rightLetter = addOptRight === 'CALL' ? 'C' : 'P'
    const contract_key = `${addOptionForSymbol}|OPT|${expiry}|${strikeNum}|${rightLetter}`
    await handleAddWatchlist(contract_key, 'manual', addOptionForSymbol, 'OPT', expiry, strikeNum, rightLetter)
    closeAddOptionModal()
  }

  async function handleAnalyze(item: WatchlistItem) {
    const sym = symbolFromItem(item)
    if (!sym) return
    setAnalysisLoadingSymbol(sym)
    setAnalysisResult(null)
    setAnalysisChartPeriod('1 D')
    setAnalysisChartBars([])
    setAnalysisChartError(null)
    setAnalysisChartInfo(null)
    setFetchMarketDataError(null)
    try {
      const stats = await fetchBarStats(sym)
      setAnalysisResult({ symbol: sym, stats })
    } catch {
      setAnalysisResult({ symbol: sym, stats: { stock_day: 0, stock_min: {} } })
    } finally {
      setAnalysisLoadingSymbol(null)
    }
  }

  const handleSizeCompute = useCallback(async (sym: string) => {
    setPortfolioRiskPowerCollapsed(true)
    setSelectedSizingSymbol(sym)
    setSizeComputeLoading(true)
    setSizeComputeError(null)
    setSizeAtrResult(null)
    setSizePosResult(null)
    setSizeCurrentPrice(null)
    try {
      const [barsRes, quotesRes] = await Promise.all([fetchBars(sym, '1 D', 20), fetchQuotes([sym])])
      const bars = barsRes.bars ?? []
      if (bars.length < 2) {
        setSizeComputeError(`Insufficient bar data for ${sym} (${bars.length} bars, need ≥ 2)`)
        return
      }
      const atr = computeAtr(bars)
      setSizeAtrResult(atr)
      const quote = quotesRes.quotes.find(q => q.symbol.toUpperCase() === sym)
      const price = quote?.last ?? quote?.mid ?? bars[bars.length - 1]?.close ?? null
      setSizeCurrentPrice(price)
    } catch (e) {
      setSizeComputeError(e instanceof Error ? e.message : `Failed to fetch data for ${sym}`)
    } finally {
      setSizeComputeLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedSizingSymbol) {
      orderDraftSymbolRef.current = null
      setOrderEntryPrice('')
      setOrderExitPrice('')
      setOrderShareAmt('100')
      return
    }

    const sym = selectedSizingSymbol.trim().toUpperCase()
    const changedSymbol = orderDraftSymbolRef.current !== sym
    const entrySeed = selectedSizingBid ?? sizeCurrentPrice
    const exitSeed = sizePosResult?.is_valid ? sizePosResult.stop_loss_long : null
    const shareSeed = sizePosResult?.is_valid ? defaultShareAmt(sizePosResult.shares) : '100'

    if (changedSymbol) {
      orderDraftSymbolRef.current = sym
      setOrderEntryPrice(entrySeed != null ? formatOrderInputNumber(entrySeed) : '')
      setOrderExitPrice(exitSeed != null ? formatOrderInputNumber(exitSeed) : '')
      setOrderShareAmt(shareSeed)
      return
    }

    if (entrySeed != null) {
      setOrderEntryPrice(prev => (prev.trim() ? prev : formatOrderInputNumber(entrySeed)))
    }
    if (exitSeed != null) {
      setOrderExitPrice(prev => (prev.trim() ? prev : formatOrderInputNumber(exitSeed)))
    }
    setOrderShareAmt(prev => (prev.trim() ? prev : shareSeed))
  }, [selectedSizingSymbol, selectedSizingBid, sizeCurrentPrice, sizePosResult])

  /** Sizing tab: default-select first Sizing row + load Order sizing; respect panel dismiss until list or tab changes. */
  useEffect(() => {
    const prevTab = prevPrimaryTabRef.current
    if (primaryTab === 'sizing' && prevTab !== 'sizing') sizingPanelDismissedRef.current = false
    prevPrimaryTabRef.current = primaryTab

    if (primaryTab !== 'sizing') return

    const keysSig = sizingStockRows.map(r => r.contract_key).join('|')
    if (keysSig !== sizingRowsKeySigRef.current) {
      sizingRowsKeySigRef.current = keysSig
      sizingPanelDismissedRef.current = false
    }

    if (sizingStockRows.length === 0) {
      sizingPanelDismissedRef.current = false
      if (selectedSizingSymbol != null) {
        setSelectedSizingSymbol(null)
        setSizeAtrResult(null)
        setSizePosResult(null)
        setSizeCurrentPrice(null)
        setSizeComputeError(null)
      }
      return
    }

    const syms = sizingStockRows.map(s => symbolFromItem(s).trim().toUpperCase()).filter(Boolean)
    const cur = (selectedSizingSymbol ?? '').trim().toUpperCase()
    const inList = Boolean(cur && syms.includes(cur))
    if (inList) {
      sizingPanelDismissedRef.current = false
      return
    }

    if (sizingPanelDismissedRef.current) return

    const first = symbolFromItem(sizingStockRows[0]).trim()
    if (first) void handleSizeCompute(first)
  }, [primaryTab, sizingStockRows, selectedSizingSymbol, handleSizeCompute])

  async function handleFetchMarketData() {
    if (!analysisResult) return
    const sym = analysisResult.symbol.trim().toUpperCase()
    if (!sym) return
    setFetchMarketDataError(null)
    setAnalysisChartInfo(null)

    const steps: { label: string; run: () => Promise<{ ok: boolean; error?: string }> }[] = [
      {
        label: 'Enqueue daily OHLC (Massive → PostgreSQL)…',
        run: async () => {
          const res = await postMassiveSync('feed_stocks_aggregate', {
            mode: 'custom_bars',
            sync_all_periods: true,
            custom_bars_period_group: 'daily',
            custom_bars_sync_mode: 'daily_smart',
            start_ms: 0,
            end_ms: 0,
            ticker: sym,
          })
          return { ok: res.ok, error: res.error ?? res.message }
        },
      },
      {
        label: 'Enqueue intraday OHLC 1m / 5m / 1h (Massive → PostgreSQL)…',
        run: async () => {
          const ymd = (await findLastNyTradingDayForWatchlist()) ?? nyCalendarDateIso()
          const w = presetNyRegularSessionForDate(ymd)
          if (!w) {
            return { ok: false, error: 'Could not resolve a NY regular-session window for Massive intraday sync.' }
          }
          const res = await postMassiveSync('feed_stocks_aggregate', {
            mode: 'custom_bars',
            start_ms: w.startMs,
            end_ms: w.endMs,
            sync_all_periods: true,
            custom_bars_period_group: 'intraday',
            custom_bars_sync_mode: 'window',
            ticker: sym,
          })
          return { ok: res.ok, error: res.error ?? res.message }
        },
      },
    ]

    let lastError: string | null = null
    for (const { label, run } of steps) {
      setFetchMarketDataStep(label)
      try {
        const out = await run()
        if (!out.ok) {
          lastError = out.error || 'Massive sync enqueue failed'
          setFetchMarketDataError(lastError)
          break
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'Request failed'
        setFetchMarketDataError(lastError)
        break
      }
    }
    setFetchMarketDataStep(null)
    if (!lastError) {
      setAnalysisChartInfo(
        'Massive stock OHLC jobs were enqueued (daily + last NY session intraday). '
          + 'Celery writes to stock_day / stock_min; wait for jobs to finish, then use Reload chart.',
      )
      try {
        const stats = await fetchBarStats(sym)
        setAnalysisResult({ symbol: sym, stats })
        void loadAnalysisChartFromDb(sym, analysisChartPeriod)
      } catch {
        /* keep existing stats */
      }
    }
  }

  const renderStockRows = (items: WatchlistItem[], opts?: { showSizeBtn?: boolean; hideCategory?: boolean; hideOpt?: boolean }) =>
    items.map((item) => {
      const sym = symbolFromItem(item)
      const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[sym]
      const held = hasPosition(item)
      const optOn = item.optionable === true
      const symU = sym.trim().toUpperCase()
      const selU = (selectedSizingSymbol ?? '').trim().toUpperCase()
      const isSelected = Boolean(symU && selU === symU)
      const trClass = [opts?.showSizeBtn && isSelected ? 'wl2-row--sizing-selected' : '', !optOn ? 'wl2-row--dim' : '']
        .filter(Boolean)
        .join(' ') || undefined
      return (
        <tr key={item.contract_key} className={trClass}>
          <td className="wl2-td--sym" title={item.contract_key}>
            <span className="wl2-sym-cell">
              <button
                type="button"
                className="wl2-sym-btn"
                onClick={() => {
                  void handleAnalyze(item)
                  if (opts?.showSizeBtn && sym) void handleSizeCompute(sym)
                }}
                disabled={
                  analysisLoadingSymbol !== null
                  || (Boolean(opts?.showSizeBtn) && sizeComputeLoading && isSelected)
                }
                title={
                  opts?.showSizeBtn
                    ? 'Bar stats + position sizing (Sizing step)'
                    : 'Bar stats (PostgreSQL stock_day / stock_min)'
                }
                aria-label={
                  opts?.showSizeBtn
                    ? `Bar stats and position sizing for ${watchlistItemLabel(item)}`
                    : `Bar stats for ${watchlistItemLabel(item)}`
                }
              >
                <span className="wl2-sym">{watchlistItemLabel(item)}</span>
                {(analysisLoadingSymbol === sym
                  || (Boolean(opts?.showSizeBtn) && isSelected && sizeComputeLoading))
                  ? <span className="wl2-sym-btn__wait" aria-hidden> ⏳</span>
                  : null}
              </button>
              {held && <span className="wl2-badge wl2-badge--hold" title="Holding">H</span>}
            </span>
          </td>
          <td className="wl2-td--quote">{renderQuoteCell(q)}</td>
          {!opts?.hideOpt ? (
            <td className="wl2-td--opt">
              <button
                type="button"
                className={`wl2-opt-pill${optOn ? ' wl2-opt-pill--on' : ''}`}
                onClick={() => handleOptionableToggle(item)}
                aria-label={`Option? for ${watchlistItemLabel(item)}`}
                title={optOn ? 'Included in Option Discovery' : 'Not in Option Discovery'}
              >
                {optOn ? 'ON' : 'OFF'}
              </button>
            </td>
          ) : null}
          {!opts?.hideCategory ? (
            <td className="wl2-td--cat">
              <select
                className="wl2-cat-select"
                value={item.category_id ?? ''}
                onChange={e => {
                  const v = e.target.value
                  handleWatchlistCategoryChange(item, v ? Number(v) : null)
                }}
                aria-label={`Category for ${watchlistItemLabel(item)}`}
              >
                <option value="">—</option>
                {positionCategories.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </td>
          ) : null}
          <td className="wl2-td--acts">
            <span className="wl2-acts">
              <button
                type="button"
                className="wl2-act-icon"
                onClick={() => openAddOptionModal(item)}
                title="Add option contract"
                aria-label="Add option"
              >
                ＋
              </button>
              <button
                type="button"
                className="wl2-act-icon wl2-act-icon--rm"
                onClick={() => handleRemoveWatchlist(item)}
                title="Remove"
                aria-label="Remove from watchlist"
              >
                ✕
              </button>
            </span>
          </td>
        </tr>
      )
    })

  const renderOptionRows = (items: WatchlistItem[]) =>
    items.map((item) => {
      const und = symbolFromItem(item)
      const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[und]
      const held = hasPosition(item)
      return (
        <tr key={item.contract_key}>
          <td className="wl2-td--sym" title={item.contract_key}>
            <span className="wl2-sym-cell">
              <button
                type="button"
                className="wl2-sym-btn"
                onClick={() => void handleAnalyze(item)}
                disabled={analysisLoadingSymbol !== null}
                title="Bar stats for underlying (PostgreSQL stock_day / stock_min)"
                aria-label={`Bar stats for underlying ${und}`}
              >
                <span className="wl2-sym">{item.symbol || watchlistItemLabel(item)}</span>
                {analysisLoadingSymbol === und ? <span className="wl2-sym-btn__wait" aria-hidden> ⏳</span> : null}
              </button>
              {held && <span className="wl2-badge wl2-badge--hold" title="Holding">H</span>}
            </span>
          </td>
          <td className="wl2-td--quote">{renderQuoteCell(q)}</td>
          <td className="wl2-td--exp">{formatExpiry(item.expiry)}</td>
          <td className="wl2-td--right">
            <span className={`wl2-right-badge${(item.option_right || '').toUpperCase() === 'C' || (item.option_right || '').toUpperCase() === 'CALL' ? ' wl2-right-badge--c' : ' wl2-right-badge--p'}`}>
              {formatOptionRight(item.option_right)}
            </span>
          </td>
          <td className="wl2-td--strike">{item.strike != null ? formatStrike(item.strike) : '—'}</td>
          <td className="wl2-td--cat">
            <select
              className="wl2-cat-select"
              value={item.category_id ?? ''}
              onChange={e => {
                const v = e.target.value
                handleWatchlistCategoryChange(item, v ? Number(v) : null)
              }}
              aria-label={`Category for ${item.symbol || watchlistItemLabel(item)}`}
            >
              <option value="">—</option>
              {positionCategories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </td>
          <td className="wl2-td--acts">
            <button
              type="button"
              className="wl2-act-icon wl2-act-icon--rm"
              onClick={() => handleRemoveWatchlist(item)}
              title="Remove"
              aria-label="Remove from watchlist"
            >
              ✕
            </button>
          </td>
        </tr>
      )
    })

  const addCategoryForHeader = watchingCategoryId != null ? watchingCategoryId : undefined

  const barStatsAnalysisSection =
    analysisResult == null ? null : (
      <section className="wl2-analysis" aria-labelledby="wl2-analysis-head">
        <div className="wl2-analysis__header">
          <h3 id="wl2-analysis-head" className="wl2-analysis__title">
            {analysisResult.symbol}
            <span className="wl2-analysis__sub">bar stats</span>
          </h3>
          <button
            type="button"
            className="wl2-btn wl2-btn--primary"
            disabled={!!fetchMarketDataStep}
            onClick={() => handleFetchMarketData()}
          >
            {fetchMarketDataStep || 'Fetch from Massive'}
          </button>
          <button
            type="button"
            className="wl2-act-icon"
            onClick={() => {
              setAnalysisResult(null)
              setAnalysisChartBars([])
              setAnalysisChartError(null)
              setAnalysisChartInfo(null)
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
        {fetchMarketDataError && (
          <span className="wl2-error wl2-error--inline">{fetchMarketDataError}</span>
        )}
        <div className="wl2-analysis__grid">
          <div className="wl2-analysis__kpi">
            <span className="wl2-analysis__kpi-label">stock_day</span>
            <span className="wl2-analysis__kpi-val">{analysisResult.stats.stock_day.toLocaleString()}</span>
          </div>
          {analysisResult.stats.stock_min && Object.entries(analysisResult.stats.stock_min).map(([period, count]) => (
            <div className="wl2-analysis__kpi" key={period}>
              <span className="wl2-analysis__kpi-label">{period}</span>
              <span className="wl2-analysis__kpi-val">{(count as number).toLocaleString()}</span>
            </div>
          ))}
        </div>

        <div className="wl2-analysis__chart-toolbar">
          <div className="wl2-analysis__chart-tabs" role="tablist" aria-label="K-line from database">
            <button
              type="button"
              role="tab"
              aria-selected={analysisChartPeriod === '1 D'}
              className={`wl2-analysis__chart-tab${analysisChartPeriod === '1 D' ? ' wl2-analysis__chart-tab--active' : ''}`}
              onClick={() => setAnalysisChartPeriod('1 D')}
            >
              Daily
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={analysisChartPeriod === '1 min'}
              className={`wl2-analysis__chart-tab${analysisChartPeriod === '1 min' ? ' wl2-analysis__chart-tab--active' : ''}`}
              onClick={() => setAnalysisChartPeriod('1 min')}
            >
              1 min
            </button>
          </div>
          <button
            type="button"
            className="wl2-btn wl2-btn--ghost wl2-analysis__chart-reload"
            disabled={analysisChartLoading || !!fetchMarketDataStep}
            onClick={() => void loadAnalysisChartFromDb(analysisResult.symbol, analysisChartPeriod)}
          >
            {analysisChartLoading ? 'Loading…' : 'Reload chart'}
          </button>
        </div>
        <div className="wl2-analysis__chart-toggles" aria-label="Chart layers">
          <label className="wl2-analysis__toggle">
            <input type="checkbox" checked={chartShowVolume} onChange={e => setChartShowVolume(e.target.checked)} />
            Volume
          </label>
          <label className="wl2-analysis__toggle">
            <input type="checkbox" checked={chartShowVwap} onChange={e => setChartShowVwap(e.target.checked)} />
            VWAP
          </label>
          <label className="wl2-analysis__toggle">
            <input type="checkbox" checked={chartShowMacd} onChange={e => setChartShowMacd(e.target.checked)} />
            MACD
          </label>
          <label className="wl2-analysis__toggle">
            <input type="checkbox" checked={chartShowBb} onChange={e => setChartShowBb(e.target.checked)} />
            Bollinger
          </label>
          <label className="wl2-analysis__toggle">
            <input type="checkbox" checked={chartShowRsi} onChange={e => setChartShowRsi(e.target.checked)} />
            RSI
          </label>
          <label className="wl2-analysis__toggle">
            <input type="checkbox" checked={chartShowSr} onChange={e => setChartShowSr(e.target.checked)} />
            S/R
          </label>
        </div>
        <p className="wl2-analysis__chart-hint section-hint">
          Candles are read from PostgreSQL <code>stock_day</code> / <code>stock_min</code> via <code>GET /bars</code> (Massive and other sources may be present).{' '}
          <strong>Fetch from Massive</strong> enqueues Celery <code>feed_stocks_aggregate</code> jobs (daily + intraday); after they complete, use <strong>Reload chart</strong> or switch Daily / 1 min.
        </p>
        {analysisChartError && (
          <p className="msg-error" role="alert" style={{ marginTop: 'var(--space-2)' }}>{analysisChartError}</p>
        )}
        {analysisChartInfo && !analysisChartError && (
          <p className="section-hint" role="status" style={{ marginTop: 'var(--space-2)' }}>{analysisChartInfo}</p>
        )}
        {analysisChartLoading && analysisChartBarsSorted.length === 0 && (
          <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>Loading chart from database…</p>
        )}
        {analysisChartBarsSorted.length > 0 ? (
          <div className="wl2-analysis__chart-wrap">
            <BarsCandlestickChart
              bars={analysisChartBarsSorted}
              period={analysisChartPeriod}
              showVolume={chartShowVolume}
              showVwap={chartShowVwap}
              showMacd={chartShowMacd}
              showBollinger={chartShowBb}
              showRsi={chartShowRsi}
              showSr={chartShowSr}
            />
          </div>
        ) : (
          !analysisChartLoading && !analysisChartInfo && (
            <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
              No bars in the database for this symbol and period. Use <strong>Fetch from Massive</strong>, wait for jobs to finish, then reload the chart.
            </p>
          )
        )}
      </section>
    )

  return (
    <div className="card process-section watchlist-page stock-screener-page wl2">
      {/* ── Header bar ── */}
      <header className="wl2-header">
        <div className="research-page-head">
          <SectionPageTitle
            menu="Research"
            pageTitle="Stock Screener"
            onMenuClick={onBreadcrumbResearch}
            menuNavigateAriaLabel="Research home"
            infoText="Stock screener workflow: Watching (ideas) → Sizing (pre-trade sizing) → Positions (live IB holdings). Categories Watching / Sizing match Portfolio → Accounts. Quotes use IB / Redis. Bar-chart OHLC in the analysis panel is read from PostgreSQL (Massive or IB sources); use Fetch from Massive to enqueue Massive custom_bars sync."
            style={{ margin: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem' }}
          >
            <span className="wl2-header__count">{watchlistItems.length}</span>
          </SectionPageTitle>
          <div className="wl2-header__add">
          {(primaryTab === 'watching' || primaryTab === 'positions') && positionsNotInWatchlist.length > 0 && (
            <button
              type="button"
              className="wl2-btn wl2-btn--ghost wl2-header__pos-btn"
              onClick={() => setShowPositionPicker(v => !v)}
              title="Add from positions (category Watching)"
            >
              Pos ({positionsNotInWatchlist.length})
            </button>
          )}
          {primaryTab === 'watching' && (
            <>
              <input
                type="text"
                className="wl2-header__input"
                placeholder="Add symbol → Watching…"
                value={addContractKey}
                onChange={e => setAddContractKey(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && addContractKey.trim()) {
                    const { contract_key, symbol, sec_type } = normalizeToContractKey(addContractKey)
                    if (contract_key) {
                      handleAddWatchlist(contract_key, 'manual', symbol, sec_type, undefined, undefined, undefined, addCategoryForHeader)
                      setAddContractKey('')
                    }
                  }
                }}
                aria-label="Enter symbol to add as Watching"
              />
              <button
                type="button"
                className="wl2-btn wl2-btn--primary wl2-header__add-btn"
                disabled={addPending || !addContractKey.trim()}
                onClick={() => {
                  const { contract_key, symbol, sec_type } = normalizeToContractKey(addContractKey)
                  if (!contract_key) return
                  handleAddWatchlist(contract_key, 'manual', symbol, sec_type, undefined, undefined, undefined, addCategoryForHeader)
                  setAddContractKey('')
                }}
              >
                {addPending ? '…' : '+'}
              </button>
            </>
          )}
          </div>
        </div>
      </header>

      {watchlistError && (
        <div className="wl2-error" role="alert">{watchlistError}</div>
      )}

      {/* ── Position picker ── */}
      {showPositionPicker && positionsNotInWatchlist.length > 0 && (primaryTab === 'watching' || primaryTab === 'positions') && (
        <div className="wl2-pos-picker">
          {positionsNotInWatchlist.map((p, idx) => {
            const ck = positionToContractKey(p)
            const label = p.symbol || ck.split('|')[0]
            return (
              <button
                key={ck + String(idx)}
                type="button"
                className="wl2-pos-picker__chip"
                disabled={addPending}
                onClick={() => {
                  const exp = (p.expiry ?? p.lastTradeDateOrContractMonth) as string | undefined
                  handleAddWatchlist(ck, 'position', p.symbol || undefined, p.secType || undefined, exp, p.strike, p.right, addCategoryForHeader)
                }}
                title={ck}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Step-by-step workflow (Watching → Sizing → Positions) ── */}
      {!watchlistLoading && (
        <div className="wl2-stepper" role="tablist" aria-label="Position workflow steps">
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === 'watching'}
            aria-current={primaryTab === 'watching' ? 'step' : undefined}
            className={`wl2-step${primaryTab === 'watching' ? ' wl2-step--active' : ''}${primaryTab === 'sizing' || primaryTab === 'positions' ? ' wl2-step--done' : ''}`}
            onClick={() => { setPrimaryTab('watching'); setShowPositionPicker(false) }}
          >
            <span className="wl2-step__index" aria-hidden>1</span>
            <span className="wl2-step__body">
              <span className="wl2-step__title">Watching</span>
              <span className="wl2-step__desc">Screen names &amp; ideas</span>
            </span>
            <span className="wl2-step__badge">{watchingTabCount}</span>
          </button>
          <span
            className={`wl2-step-connector${primaryTab === 'sizing' || primaryTab === 'positions' ? ' wl2-step-connector--done' : ''}`}
            aria-hidden
          />
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === 'sizing'}
            aria-current={primaryTab === 'sizing' ? 'step' : undefined}
            className={`wl2-step wl2-step--sizing-hub${primaryTab === 'sizing' ? ' wl2-step--active' : ''}${primaryTab === 'positions' ? ' wl2-step--done' : ''}`}
            onClick={() => { setPrimaryTab('sizing'); setShowPositionPicker(false); setPromoteContractKey('') }}
          >
            <span className="wl2-step__index" aria-hidden>2</span>
            <span className="wl2-step__body">
              <span className="wl2-step__title">Sizing</span>
              <span className="wl2-step__desc">Size before you trade</span>
            </span>
            <span className="wl2-step__badge">{sizingTabCount}</span>
          </button>
          <span
            className={`wl2-step-connector${primaryTab === 'positions' ? ' wl2-step-connector--done' : ''}`}
            aria-hidden
          />
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === 'positions'}
            aria-current={primaryTab === 'positions' ? 'step' : undefined}
            className={`wl2-step${primaryTab === 'positions' ? ' wl2-step--active' : ''}`}
            onClick={() => { setPrimaryTab('positions'); setPromoteContractKey('') }}
          >
            <span className="wl2-step__index" aria-hidden>3</span>
            <span className="wl2-step__body">
              <span className="wl2-step__title">Positions</span>
              <span className="wl2-step__desc">Live IB holdings</span>
            </span>
            <span className="wl2-step__badge">{positionsTabCount}</span>
          </button>
        </div>
      )}

      {!watchlistLoading && primaryTab === 'positions' && (
        <div className="wl2-substep-wrap">
          <span className="wl2-substep-label">Step 3 — instrument type</span>
          <nav className="wl2-tabs wl2-tabs--sub" aria-label="Positions instrument type">
            <button
              type="button"
              className={`wl2-tabs__btn${positionSubTab === 'stocks' ? ' wl2-tabs__btn--active' : ''}`}
              onClick={() => setPositionSubTab('stocks')}
            >
              Stocks
              <span className="wl2-tabs__badge">{positionStockRows.length}</span>
            </button>
            <button
              type="button"
              className={`wl2-tabs__btn${positionSubTab === 'options' ? ' wl2-tabs__btn--active' : ''}`}
              onClick={() => setPositionSubTab('options')}
            >
              Options
              <span className="wl2-tabs__badge">{positionOptRows.length}</span>
            </button>
          </nav>
        </div>
      )}

      {/* ── Main content ── */}
      {watchlistLoading ? (
        <div className="wl2-empty">Loading…</div>
      ) : primaryTab === 'watching' ? (
        <>
          <p className="wl2-tier-hint">
            <strong>Step 1.</strong> Tickers you add in the header are stored with category <strong>Watching</strong> (same names as Portfolio → Accounts). Symbols may appear here even if you already hold them. Option legs in Watching / uncategorized are in the second table below.
          </p>
          {watchingCategoryId == null && (
            <p className="wl2-tier-hint wl2-tier-hint--warn">
              The <strong>Watching</strong> category is missing or still being created. If this persists, add <strong>Watching</strong> and <strong>Sizing</strong> under Portfolio → Accounts.
            </p>
          )}
          {watchlistItems.length === 0 && watchingStockRows.length === 0 && watchingOptionRows.length === 0 ? (
            <div className="wl2-empty">No symbols yet. Type a ticker in the header to start in Watching.</div>
          ) : (
            <>
              <div className="wl2-table-wrap">
                {watchingStockRows.length === 0 && otherCategoryStockRows.length === 0 ? (
                  <div className="wl2-empty">No stock rows in Watching / uncategorized.</div>
                ) : (
                  <table className="wl2-table">
                    <thead>
                      <tr>
                        <th className="wl2-th--sym">Symbol</th>
                        <th className="wl2-th--quote">Last / B·A</th>
                        <th className="wl2-th--opt" title="Show in Option Discovery">Opt</th>
                        <th className="wl2-th--cat">Category</th>
                        <th className="wl2-th--acts" />
                      </tr>
                    </thead>
                    <tbody>
                      {renderStockRows(watchingStockRows)}
                    </tbody>
                    {otherCategoryStockRows.length > 0 && (
                      <tbody>
                        <tr className="wl2-group-row">
                          <td colSpan={5}>
                            <span className="wl2-group-label">Other portfolio categories</span>
                            <span className="wl2-group-count">{otherCategoryStockRows.length}</span>
                          </td>
                        </tr>
                        {renderStockRows(otherCategoryStockRows)}
                      </tbody>
                    )}
                  </table>
                )}
              </div>
              {watchingOptionRows.length > 0 && (
                <>
                  <p className="wl2-tier-hint" style={{ marginTop: 'var(--space-4)' }}>Options on the list (Watching / uncategorized)</p>
                  <div className="wl2-table-wrap">
                    <table className="wl2-table">
                      <thead>
                        <tr>
                          <th className="wl2-th--sym">Symbol</th>
                          <th className="wl2-th--quote">Last / B·A</th>
                          <th className="wl2-th--exp">Expiry</th>
                          <th className="wl2-th--right">R</th>
                          <th className="wl2-th--strike">Strike</th>
                          <th className="wl2-th--cat">Category</th>
                          <th className="wl2-th--acts" />
                        </tr>
                      </thead>
                      <tbody>{renderOptionRows(watchingOptionRows)}</tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </>
      ) : primaryTab === 'sizing' ? (
        <>
          <p className="wl2-tier-hint">
            <strong>Step 2.</strong> The table lists stocks tagged <strong>Sizing</strong>. Pick any stock symbol from your watchlist below, then <strong>Move to Sizing</strong>.
          </p>

          {barStatsAnalysisSection}

          <section
            className="wl2-sizing-dash"
            aria-labelledby="wl2-sizing-dash-portfolio-risk-power-head"
          >
            <div className="wl2-sizing-dash__title-row">
              <h4 id="wl2-sizing-dash-portfolio-risk-power-head" className="wl2-sizing-dash__title wl2-sizing-dash__title--inline">
                Portfolio risk power
              </h4>
              <InfoTooltip text={WL_HELP_PORTFOLIO_TABLE} />
              <button
                type="button"
                className="section-header-icon-btn wl2-portfolio-risk-power__toggle"
                onClick={() => setPortfolioRiskPowerCollapsed(v => !v)}
                aria-expanded={!portfolioRiskPowerCollapsed}
                aria-controls="wl2-portfolio-risk-power-body"
                title={portfolioRiskPowerCollapsed ? 'Expand portfolio risk power' : 'Collapse portfolio risk power'}
                aria-label={portfolioRiskPowerCollapsed ? 'Expand portfolio risk power' : 'Collapse portfolio risk power'}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path
                    d={
                      portfolioRiskPowerCollapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'
                    }
                  />
                </svg>
              </button>
            </div>

            {portfolioRiskPowerCollapsed ? (
              <div id="wl2-portfolio-risk-power-body" className="wl2-portfolio-risk-power-summary" role="status" aria-live="polite">
                <div className="wl2-portfolio-risk-power-summary__item">
                  <span className="wl2-portfolio-risk-power-summary__name">Host</span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    Cash:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {hostCashPie ? fmtUsd(hostCashPie.cash) : '—'}
                    </span>
                  </span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    STK:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {hostCashPie ? fmtUsd(hostCashPie.stkExFi) : '—'}
                    </span>
                  </span>
                </div>
                <div className="wl2-portfolio-risk-power-summary__item">
                  <span className="wl2-portfolio-risk-power-summary__name">Secondary</span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    Cash:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {secondaryCashPie ? fmtUsd(secondaryCashPie.cash) : '—'}
                    </span>
                  </span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    STK:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {secondaryCashPie ? fmtUsd(secondaryCashPie.stkExFi) : '—'}
                    </span>
                  </span>
                </div>
                <div className="wl2-portfolio-risk-power-summary__item wl2-portfolio-risk-power-summary__item--maxdd">
                  <span className="wl2-portfolio-risk-power-summary__name">Max drawdown %</span>
                  <span className="wl2-portfolio-risk-power-summary__metric wl2-portfolio-risk-power-summary__metric--emph">
                    {staticMaxDdPctCap.toFixed(0)}%
                  </span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    Static risk budget:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {capital > 0 ? fmtUsd(staticRiskBudgetUsd) : '—'}
                    </span>
                  </span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    Max drawdown:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {portfolioDdFromHistory.usd != null ? fmtUsd(portfolioDdFromHistory.usd) : '—'}
                    </span>
                  </span>
                  <span className="wl2-portfolio-risk-power-summary__metric">
                    Per-trade loss:{' '}
                    <span className="wl2-portfolio-risk-power-summary__metric-value">
                      {capital > 0 ? fmtUsd(staticRiskUsdPerTrade) : '—'}
                    </span>
                  </span>
                </div>
              </div>
            ) : (
            <>
            <div id="wl2-portfolio-risk-power-body" className="wl2-portfolio-max-dd-row">
              <div className="wl2-range-field wl2-range-field--portfolio">
                <div className="wl2-range-field__head">
                  <div className="wl2-range-field__label-row">
                    <label className="wl2-range-field__label" htmlFor="wl-portfolio-max-dd-pct">
                      Max drawdown %
                    </label>
                    <InfoTooltip text={WL_HELP_MAX_DD_SCENARIO} />
                  </div>
                  <span className="wl2-range-field__readout" aria-live="polite">
                    {staticMaxDdPctCap}
                    <span className="wl2-range-field__readout-unit">%</span>
                  </span>
                </div>
                <input
                  id="wl-portfolio-max-dd-pct"
                  type="range"
                  className="wl2-range-elegant"
                  min={5}
                  max={50}
                  step={1}
                  value={staticMaxDdPctCap}
                  onChange={e =>
                    setStaticMaxDdPctCap(Math.max(5, Math.min(50, Number.parseInt(e.target.value, 10) || 20)))
                  }
                  aria-valuemin={5}
                  aria-valuemax={50}
                  aria-valuenow={staticMaxDdPctCap}
                  aria-label="Scenario max drawdown percent of net liquidation per account"
                  style={{
                    ['--wl-range-pct' as string]: `${((staticMaxDdPctCap - 5) / (50 - 5)) * 100}%`,
                  }}
                />
                <div className="wl2-range-field__scale" aria-hidden>
                  <span>5%</span>
                  <span>50%</span>
                </div>
                <div className="wl2-range-field__metrics-row">
                  <div className="wl2-range-field__metric-tile wl2-range-field__metric-tile--highlight">
                    <span className="wl2-range-field__metric-tile-label">Max drawdown (history)</span>
                    <span className="wl2-range-field__metric-tile-value">
                      {portfolioDdFromHistory.usd != null ? fmtUsd(portfolioDdFromHistory.usd) : '—'}
                    </span>
                    {portfolioDdFromHistory.pctOfNav != null ? (
                      <span className="wl2-range-field__metric-tile-sub">
                        {portfolioDdFromHistory.pctOfNav.toFixed(2)}% of NAV
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="wl2-range-field wl2-range-field--portfolio">
                <div className="wl2-range-field__head">
                  <div className="wl2-range-field__label-row">
                    <label className="wl2-range-field__label" htmlFor="wl-static-risk-pct">
                      Static Risk % (per trade)
                    </label>
                  </div>
                  <span className="wl2-range-field__readout" aria-live="polite">
                    {staticRiskPctPerTrade.toFixed(1)}
                    <span className="wl2-range-field__readout-unit">%</span>
                  </span>
                </div>
                <input
                  id="wl-static-risk-pct"
                  type="range"
                  className="wl2-range-elegant"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={staticRiskPctPerTrade}
                  onChange={e =>
                    setStaticRiskPctPerTrade(Math.max(0.1, Math.min(5, Number.parseFloat(e.target.value) || 1)))
                  }
                  aria-valuemin={0.1}
                  aria-valuemax={5}
                  aria-valuenow={staticRiskPctPerTrade}
                  aria-label="Static risk percent per trade"
                  style={{
                    ['--wl-range-pct' as string]: `${((staticRiskPctPerTrade - 0.1) / (5 - 0.1)) * 100}%`,
                  }}
                />
                <div className="wl2-range-field__scale" aria-hidden>
                  <span>0.1%</span>
                  <span>5.0%</span>
                </div>
                <div className="wl2-range-field__metrics-row wl2-range-field__metrics-row--single">
                  <div className="wl2-range-field__metric-tile wl2-range-field__metric-tile--highlight">
                    <span className="wl2-range-field__metric-tile-label">Per-trade fixed loss budget</span>
                    <span className="wl2-range-field__metric-tile-value">
                      {capital > 0 ? fmtUsd(staticRiskUsdPerTrade) : '—'}
                    </span>
                    <span className="wl2-range-field__metric-tile-sub">
                      Total capital × {staticRiskPctPerTrade.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>

              <div className="wl2-table-wrap wl2-sizing-dash__table-wrap">
              <table className="wl2-table wl2-table--dense wl2-portfolio-metric-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="wl2-td-num">Cash (IB)</th>
                    <th className="wl2-td-num">Cash-like</th>
                    <th className="wl2-td-num">Cash total</th>
                    <th className="wl2-td-num">Positions MV</th>
                    <th className="wl2-td-num">Net liq.</th>
                    <th className="wl2-td-num wl2-portfolio-metric-table__max-dd">Max DD @ {staticMaxDdPctCap}%</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>Host</strong>
                      {portfolioAccountTable.hostId ? (
                        <div className="wl2-portfolio-metric-table__sub">
                          <code className="wl2-code">{portfolioAccountTable.hostId}</code>
                        </div>
                      ) : (
                        <div className="wl2-portfolio-metric-table__sub">event_host / trading not set</div>
                      )}
                    </td>
                    {portfolioAccountTable.hostRow ? (
                      <>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.hostRow.ibCash)}</span>
                        </td>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.hostRow.cashLike)}</span>
                        </td>
                        <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.hostRow.cashTotal)}</td>
                        <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.hostRow.positionsMv)}</td>
                        <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.hostRow.netLiq)}</td>
                        <td className="wl2-td-num wl2-portfolio-metric-table__max-dd">
                          <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.hostRow.maxDdUsd)}</span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph wl2-portfolio-num--muted">—</span>
                        </td>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph wl2-portfolio-num--muted">—</span>
                        </td>
                        <td className="wl2-td-num">—</td>
                        <td className="wl2-td-num">—</td>
                        <td className="wl2-td-num">—</td>
                        <td className="wl2-td-num wl2-portfolio-metric-table__max-dd">
                          <span className="wl2-portfolio-num--emph wl2-portfolio-num--muted">—</span>
                        </td>
                      </>
                    )}
                  </tr>
                  <tr>
                    <td>
                      <strong>Secondary</strong>
                      {portfolioAccountTable.secondaryId ? (
                        <div className="wl2-portfolio-metric-table__sub">
                          <code className="wl2-code">{portfolioAccountTable.secondaryId}</code>
                        </div>
                      ) : (
                        <div className="wl2-portfolio-metric-table__sub">event_secondary not set (optional)</div>
                      )}
                    </td>
                    {portfolioAccountTable.secondaryRow ? (
                      <>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.secondaryRow.ibCash)}</span>
                        </td>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.secondaryRow.cashLike)}</span>
                        </td>
                        <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.secondaryRow.cashTotal)}</td>
                        <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.secondaryRow.positionsMv)}</td>
                        <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.secondaryRow.netLiq)}</td>
                        <td className="wl2-td-num wl2-portfolio-metric-table__max-dd">
                          <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.secondaryRow.maxDdUsd)}</span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph wl2-portfolio-num--muted">—</span>
                        </td>
                        <td className="wl2-td-num">
                          <span className="wl2-portfolio-num--emph wl2-portfolio-num--muted">—</span>
                        </td>
                        <td className="wl2-td-num">—</td>
                        <td className="wl2-td-num">—</td>
                        <td className="wl2-td-num">—</td>
                        <td className="wl2-td-num wl2-portfolio-metric-table__max-dd">
                          <span className="wl2-portfolio-num--emph wl2-portfolio-num--muted">—</span>
                        </td>
                      </>
                    )}
                  </tr>
                  <tr className="wl2-portfolio-metric-table__total">
                    <td>
                      <strong>Total</strong>
                      <div className="wl2-portfolio-metric-table__sub">All accounts in snapshot</div>
                    </td>
                    <td className="wl2-td-num">
                      <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.totalRow.ibCash)}</span>
                    </td>
                    <td className="wl2-td-num">
                      <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.totalRow.cashLike)}</span>
                    </td>
                    <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.totalRow.cashTotal)}</td>
                    <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.totalRow.positionsMv)}</td>
                    <td className="wl2-td-num">{fmtUsd(portfolioAccountTable.totalRow.netLiq)}</td>
                    <td className="wl2-td-num wl2-portfolio-metric-table__max-dd">
                      <span className="wl2-portfolio-num--emph">{fmtUsd(portfolioAccountTable.totalRow.maxDdUsd)}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
            </>
            )}

            {!portfolioRiskPowerCollapsed && (
            <div className="wl2-cash-pie-split-wrap">
              <div className="wl2-cash-pie-split-wrap__head">
                <h5 className="wl2-sizing-dash__subtitle wl2-sizing-dash__subtitle--sm wl2-sizing-dash__subtitle--pie">
                  Cash & ex‑FI stocks vs net liquidation
                </h5>
                <InfoTooltip text={WL_HELP_CASH_PIE} />
              </div>
              <div className="wl2-cash-pie-split">
                <div className="wl2-cash-pie-panel">
                  <h6 className="wl2-cash-pie-panel__title">Host</h6>
                  {hostCashPie ? (
                    <>
                      <div className="wl2-cash-pie-layout">
                        <div
                          className="wl2-cash-pie"
                          role="img"
                          aria-label={`Host: cash ${hostCashPie.cashPctOfNet.toFixed(1)} percent, STK ex-FI ${hostCashPie.stkPctOfNet.toFixed(1)} percent, other ${hostCashPie.otherPctOfNet.toFixed(1)} percent of net liquidation`}
                        >
                          <div
                            className="wl2-cash-pie__ring"
                            style={{
                              background: `conic-gradient(
                                color-mix(in srgb, var(--color-accent) 88%, #050a10) 0turn ${hostCashPie.cashTurnEnd}turn,
                                color-mix(in srgb, var(--wl2-pie-stk) 74%, var(--color-bg)) ${hostCashPie.cashTurnEnd}turn ${hostCashPie.stkTurnEnd}turn,
                                color-mix(in srgb, var(--color-border) 72%, var(--color-surface)) ${hostCashPie.stkTurnEnd}turn 1turn
                              )`,
                            }}
                          />
                          <div className="wl2-cash-pie__hole">
                            <span className="wl2-cash-pie__pct">{hostCashPie.cashPctOfNet.toFixed(1)}%</span>
                            <span className="wl2-cash-pie__pct wl2-cash-pie__pct--stk">{hostCashPie.stkPctOfNet.toFixed(1)}%</span>
                            <span className="wl2-cash-pie__label">cash · stk ex‑FI</span>
                          </div>
                        </div>
                        <div className="wl2-cash-pie-legend wl2-cash-pie-legend--paired" role="list">
                          <div className="wl2-cash-pie-legend__pair" role="listitem">
                            <div className="wl2-cash-pie-legend__pair-left">
                              <span className="wl2-cash-pie-dot wl2-cash-pie-dot--cash" aria-hidden />
                              <span className="wl2-cash-pie-legend__text">
                                <strong>Cash total</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {fmtUsd(hostCashPie.cash)}{' '}
                                  <span className="wl2-cash-pie-legend__pct">({hostCashPie.cashPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="wl2-cash-pie-legend__pair-right">
                              <div className="wl2-cash-pie-legend__text wl2-cash-pie-legend__text--tr">
                                <strong>Net liq.</strong>
                                <span className="wl2-cash-pie-legend__val">{fmtUsd(hostCashPie.net)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="wl2-cash-pie-legend__pair" role="listitem">
                            <div className="wl2-cash-pie-legend__pair-left">
                              <span className="wl2-cash-pie-dot wl2-cash-pie-dot--stk" aria-hidden />
                              <span className="wl2-cash-pie-legend__text">
                                <strong>STK ex‑FI</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {fmtUsd(hostCashPie.stkExFi)}{' '}
                                  <span className="wl2-cash-pie-legend__pct">({hostCashPie.stkPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="wl2-cash-pie-legend__pair-right">
                              <div className="wl2-cash-pie-legend__text wl2-cash-pie-legend__text--tr">
                                <strong>Ex‑FI net liq.</strong>
                                <span className="wl2-cash-pie-legend__val">{fmtUsd(hostCashPie.netLiqExFi)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="wl2-cash-pie-legend__pair" role="listitem">
                            <div className="wl2-cash-pie-legend__pair-left">
                              <span className="wl2-cash-pie-dot wl2-cash-pie-dot--rest" aria-hidden />
                              <span className="wl2-cash-pie-legend__text">
                                <strong>Other</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {fmtUsd(hostCashPie.other)}{' '}
                                  <span className="wl2-cash-pie-legend__pct">({hostCashPie.otherPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="wl2-cash-pie-legend__pair-right">
                              <div className="wl2-cash-pie-legend__text wl2-cash-pie-legend__text--tr">
                                <strong>Cash / ex‑FI</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {hostCashPie.cashPctExFi != null ? `${hostCashPie.cashPctExFi.toFixed(1)}%` : '—'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="wl2-cash-pie-panel__empty">
                      {portfolioCashRollup.hostReason === 'no_config'
                        ? 'Set event_host or trading in Settings → IB.'
                        : portfolioCashRollup.hostReason === 'no_account'
                          ? `Account ${portfolioCashRollup.hostId ?? '—'} is not in this snapshot.`
                          : '—'}
                    </p>
                  )}
                </div>
                <div className="wl2-cash-pie-panel">
                  <h6 className="wl2-cash-pie-panel__title">Secondary</h6>
                  {secondaryCashPie ? (
                    <>
                      <div className="wl2-cash-pie-layout">
                        <div
                          className="wl2-cash-pie"
                          role="img"
                          aria-label={`Secondary: cash ${secondaryCashPie.cashPctOfNet.toFixed(1)} percent, STK ex-FI ${secondaryCashPie.stkPctOfNet.toFixed(1)} percent, other ${secondaryCashPie.otherPctOfNet.toFixed(1)} percent of net liquidation`}
                        >
                          <div
                            className="wl2-cash-pie__ring"
                            style={{
                              background: `conic-gradient(
                                color-mix(in srgb, var(--color-accent) 88%, #050a10) 0turn ${secondaryCashPie.cashTurnEnd}turn,
                                color-mix(in srgb, var(--wl2-pie-stk) 74%, var(--color-bg)) ${secondaryCashPie.cashTurnEnd}turn ${secondaryCashPie.stkTurnEnd}turn,
                                color-mix(in srgb, var(--color-border) 72%, var(--color-surface)) ${secondaryCashPie.stkTurnEnd}turn 1turn
                              )`,
                            }}
                          />
                          <div className="wl2-cash-pie__hole">
                            <span className="wl2-cash-pie__pct">{secondaryCashPie.cashPctOfNet.toFixed(1)}%</span>
                            <span className="wl2-cash-pie__pct wl2-cash-pie__pct--stk">{secondaryCashPie.stkPctOfNet.toFixed(1)}%</span>
                            <span className="wl2-cash-pie__label">cash · stk ex‑FI</span>
                          </div>
                        </div>
                        <div className="wl2-cash-pie-legend wl2-cash-pie-legend--paired" role="list">
                          <div className="wl2-cash-pie-legend__pair" role="listitem">
                            <div className="wl2-cash-pie-legend__pair-left">
                              <span className="wl2-cash-pie-dot wl2-cash-pie-dot--cash" aria-hidden />
                              <span className="wl2-cash-pie-legend__text">
                                <strong>Cash total</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {fmtUsd(secondaryCashPie.cash)}{' '}
                                  <span className="wl2-cash-pie-legend__pct">({secondaryCashPie.cashPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="wl2-cash-pie-legend__pair-right">
                              <div className="wl2-cash-pie-legend__text wl2-cash-pie-legend__text--tr">
                                <strong>Net liq.</strong>
                                <span className="wl2-cash-pie-legend__val">{fmtUsd(secondaryCashPie.net)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="wl2-cash-pie-legend__pair" role="listitem">
                            <div className="wl2-cash-pie-legend__pair-left">
                              <span className="wl2-cash-pie-dot wl2-cash-pie-dot--stk" aria-hidden />
                              <span className="wl2-cash-pie-legend__text">
                                <strong>STK ex‑FI</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {fmtUsd(secondaryCashPie.stkExFi)}{' '}
                                  <span className="wl2-cash-pie-legend__pct">({secondaryCashPie.stkPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="wl2-cash-pie-legend__pair-right">
                              <div className="wl2-cash-pie-legend__text wl2-cash-pie-legend__text--tr">
                                <strong>Ex‑FI net liq.</strong>
                                <span className="wl2-cash-pie-legend__val">{fmtUsd(secondaryCashPie.netLiqExFi)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="wl2-cash-pie-legend__pair" role="listitem">
                            <div className="wl2-cash-pie-legend__pair-left">
                              <span className="wl2-cash-pie-dot wl2-cash-pie-dot--rest" aria-hidden />
                              <span className="wl2-cash-pie-legend__text">
                                <strong>Other</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {fmtUsd(secondaryCashPie.other)}{' '}
                                  <span className="wl2-cash-pie-legend__pct">({secondaryCashPie.otherPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="wl2-cash-pie-legend__pair-right">
                              <div className="wl2-cash-pie-legend__text wl2-cash-pie-legend__text--tr">
                                <strong>Cash / ex‑FI</strong>
                                <span className="wl2-cash-pie-legend__val">
                                  {secondaryCashPie.cashPctExFi != null
                                    ? `${secondaryCashPie.cashPctExFi.toFixed(1)}%`
                                    : '—'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="wl2-cash-pie-panel__empty">
                      {portfolioCashRollup.secondaryReason === 'no_config'
                        ? 'event_secondary is optional; not set.'
                        : portfolioCashRollup.secondaryReason === 'no_account'
                          ? `Account ${portfolioCashRollup.secondaryId ?? '—'} is not in this snapshot.`
                          : '—'}
                    </p>
                  )}
                </div>
              </div>
            </div>
            )}

          </section>

          <div className="wl2-sizing-sheet-order-row">
            <div className="wl2-sizing-sheet-order-row__sheet">
          <section className="wl2-sizing-dash wl2-sizing-dash--workflow-col">
            <div className="wl2-symbol-section" aria-labelledby="wl2-sizing-symbol-sheet-head">
            <h5 id="wl2-sizing-symbol-sheet-head" className="wl2-sizing-dash__subtitle wl2-sizing-dash__subtitle--workflow">
              Sizing symbol sheet
            </h5>
            <div className="wl2-table-wrap wl2-sizing-symbol-sheet-wrap">
              {sizingStockRows.length === 0 ? (
                <div className="wl2-empty">No Sizing symbols yet. Promote from Watching above.</div>
              ) : (
                <table className="wl2-table">
                  <thead>
                    <tr>
                      <th className="wl2-th--sym">Symbol</th>
                      <th className="wl2-th--quote">Last / B·A</th>
                      <th className="wl2-th--acts" />
                    </tr>
                  </thead>
                  <tbody>{renderStockRows(sizingStockRows, { showSizeBtn: true, hideCategory: true, hideOpt: true })}</tbody>
                </table>
              )}
            </div>

            {selectedSizingSymbol && !sizeComputeLoading && sizeAtrResult && (
              <section
                className="wl2-sizing-dash wl2-sizing-dash--nested wl2-order-section--danger"
                aria-labelledby="wl2-order-section-head"
              >
                <div className="wl2-order-risk-head">
                  <h5 id="wl2-order-section-head" className="wl2-sizing-dash__subtitle wl2-order-risk-head__title">
                    Order section
                  </h5>
                  <InfoTooltip text={WL_HELP_ORDER_SECTION} />
                </div>
                <div className="wl2-order-bid-symbol-row">
                  <span className="wl2-order-bid-symbol-row__label">Current bid</span>
                  <span className="wl2-order-bid-symbol-row__value">
                    {selectedSizingBid != null ? fmtUsd(selectedSizingBid) : '—'}
                  </span>
                  <span className="wl2-order-bid-symbol-row__sep" aria-hidden>
                    ,
                  </span>
                  <span className="wl2-order-bid-symbol-row__sym">{selectedSizingSymbol}</span>
                </div>
                <div className="wl2-order-compact-grid wl2-order-compact-grid--order-row2">
                  <label className="wl2-order-compact-field" htmlFor="wl-order-entry">
                    <span className="wl2-order-compact-field__label">ENTRY</span>
                    <input
                      id="wl-order-entry"
                      type="number"
                      min={0}
                      step="0.01"
                      value={orderEntryPrice}
                      onChange={e => setOrderEntryPrice(e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="wl2-order-compact-field" htmlFor="wl-order-exit">
                    <span className="wl2-order-compact-field__label">EXIT</span>
                    <input
                      id="wl-order-exit"
                      type="number"
                      min={0}
                      step="0.01"
                      value={orderExitPrice}
                      onChange={e => setOrderExitPrice(e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="wl2-order-compact-field" htmlFor="wl-order-shares">
                    <span className="wl2-order-compact-field__label">
                      AMT
                      <span className="wl2-order-compact-field__hint">step 100</span>
                    </span>
                    <input
                      id="wl-order-shares"
                      type="number"
                      min={0}
                      step={100}
                      value={orderShareAmt}
                      onChange={e => setOrderShareAmt(e.target.value)}
                      placeholder="100"
                      inputMode="numeric"
                    />
                  </label>
                </div>
              </section>
            )}

            {selectedSizingSymbol && !sizeComputeLoading && sizeAtrResult && (
              <section className="wl2-sizing-dash wl2-sizing-dash--nested" aria-labelledby="wl2-risk-verify-head">
                <div className="wl2-order-risk-head">
                  <h5 id="wl2-risk-verify-head" className="wl2-sizing-dash__subtitle wl2-order-risk-head__title">
                    Order risk verify
                  </h5>
                  <InfoTooltip text={WL_HELP_ORDER_RISK_VERIFY} />
                </div>
                <div className="wl2-order-atr-sheet wl2-order-risk-group">
                  <h6 className="wl2-order-atr-sheet__title">Risk sheet</h6>
                  <div className="wl2-order-sheet-two-col">
                    <div className="wl2-order-sheet-two-col__col">
                      <div className="wl2-sizing-dash__card wl2-sizing-dash__card--highlight">
                        <span className="wl2-sizing-dash__label">Distance</span>
                        <span className="wl2-sizing-dash__value">
                          {manualOrderAnalytics.distance != null ? (
                            <>
                              {fmtUsd(manualOrderAnalytics.distance)}
                              {manualOrderAnalytics.distancePctOfBid != null ? (
                                <span className="wl2-order-metric__suffix">
                                  {' '}
                                  ({(manualOrderAnalytics.distancePctOfBid * 100).toFixed(2)}%)
                                </span>
                              ) : null}
                            </>
                          ) : (
                            '—'
                          )}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card wl2-sizing-dash__card--highlight">
                        <span className="wl2-sizing-dash__label">Positional drawdown</span>
                        <span className="wl2-sizing-dash__value">
                          {manualOrderAnalytics.positionalDrawdownRatio != null
                            ? `${(manualOrderAnalytics.positionalDrawdownRatio * 100).toFixed(2)}% of entry`
                            : '—'}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card wl2-sizing-dash__card--highlight">
                        <span className="wl2-sizing-dash__label">Risk per share</span>
                        <span className="wl2-sizing-dash__value">
                          {manualOrderAnalytics.riskPerShare != null ? fmtUsd(manualOrderAnalytics.riskPerShare) : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="wl2-order-sheet-two-col__col">
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Order risk ($)</span>
                        <span className="wl2-sizing-dash__value">
                          {manualOrderAnalytics.orderRiskUsd != null ? fmtUsd(manualOrderAnalytics.orderRiskUsd) : '—'}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Risk % of NAV</span>
                        <span className="wl2-sizing-dash__value">
                          {manualOrderAnalytics.riskPct != null ? `${manualOrderAnalytics.riskPct.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="wl2-order-atr-sheet wl2-order-risk-group">
                  <h6 className="wl2-order-atr-sheet__title">Capital sheet</h6>
                  <div className="wl2-sizing-dash__cards wl2-sizing-dash__cards--tight wl2-order-two-col-cards">
                    <div className="wl2-sizing-dash__card">
                      <span className="wl2-sizing-dash__label">Investment</span>
                      <span className="wl2-sizing-dash__value">
                        {manualOrderAnalytics.investmentUsd != null ? fmtUsd(manualOrderAnalytics.investmentUsd) : '—'}
                      </span>
                    </div>
                    <div className="wl2-sizing-dash__card">
                      <span className="wl2-sizing-dash__label">Investment weight</span>
                      <span className="wl2-sizing-dash__value">
                        {manualOrderAnalytics.investmentWeightPct != null
                          ? `${manualOrderAnalytics.investmentWeightPct.toFixed(2)}% of NAV`
                          : '—'}
                      </span>
                    </div>
                    <div className="wl2-sizing-dash__card">
                      <span className="wl2-sizing-dash__label">CASH LEFT</span>
                      <span
                        className={`wl2-sizing-dash__value${
                          manualOrderAnalytics.cashLeftAfter != null && manualOrderAnalytics.cashLeftAfter < 0
                            ? ' wl2-sizing-dash__value--warn'
                            : ''
                        }`}
                      >
                        {manualOrderAnalytics.cashLeftAfter != null ? fmtUsd(manualOrderAnalytics.cashLeftAfter) : '—'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="wl2-order-atr-sheet" aria-labelledby="wl2-order-atr-sheet-head">
                  <h6 id="wl2-order-atr-sheet-head" className="wl2-order-atr-sheet__title">
                    ATR sheet
                  </h6>
                  <div className="wl2-sizing-dash__cards wl2-sizing-dash__cards--tight wl2-order-two-col-cards">
                    <div className="wl2-sizing-dash__card wl2-sizing-dash__card--highlight">
                      <span className="wl2-sizing-dash__label">ATR(14)</span>
                      <span className="wl2-sizing-dash__value">
                        {manualOrderAnalytics.atr14 != null ? fmtUsd(manualOrderAnalytics.atr14) : '—'}
                      </span>
                    </div>
                    <div className="wl2-sizing-dash__card wl2-sizing-dash__card--highlight">
                      <span className="wl2-sizing-dash__label">ATR % of entry</span>
                      <span className="wl2-sizing-dash__value">
                        {manualOrderAnalytics.atrPctPercent != null
                          ? `${manualOrderAnalytics.atrPctPercent.toFixed(2)}%`
                          : '—'}
                      </span>
                    </div>
                    <div className="wl2-sizing-dash__card wl2-sizing-dash__card--highlight">
                      <span className="wl2-sizing-dash__label">ATR risk</span>
                      <span className="wl2-sizing-dash__value">
                        {manualOrderAnalytics.atrRisk != null
                          ? `${manualOrderAnalytics.atrRisk.toFixed(2)} ATR`
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>
                {!manualOrderAnalytics.isComplete ? (
                  <p className="wl2-sizing-dash__footnote">
                    Enter Entry price, Exit price, and Share amt above to complete the risk check.
                  </p>
                ) : null}
              </section>
            )}
            </div>

          </section>
            </div>

            <div className="wl2-sizing-sheet-order-row__order">
          {/* ── Order sizing (selected symbol) ── */}
          {selectedSizingSymbol && (
            <div className="wl2-sizing-sheet-order-row__panel">
            <div className="wl2-sizing-panel">
              <div className="wl2-sizing-panel__head">
                <h4 className="wl2-sizing-panel__title">Order sizing — {selectedSizingSymbol}</h4>
                <button
                  type="button"
                  className="wl2-act-icon wl2-act-icon--rm"
                  onClick={() => {
                    sizingPanelDismissedRef.current = true
                    setSelectedSizingSymbol(null)
                    setSizeAtrResult(null)
                    setSizePosResult(null)
                    setSizeCurrentPrice(null)
                    setSizeComputeError(null)
                  }}
                  title="Close order sizing"
                  aria-label="Close order sizing"
                >
                  ✕
                </button>
              </div>

              <div className="wl2-sizing-panel__controls">
                <div className="wl2-sizing-panel__control wl2-sizing-panel__control--block">
                  <div className="wl2-range-field wl2-range-field--kelly-compact">
                    <div className="wl2-range-field__head">
                      <label className="wl2-range-field__label" htmlFor="wl-kelly-fraction">
                        Kelly fraction
                      </label>
                      <span className="wl2-range-field__readout wl2-range-field__readout--kelly" aria-live="polite">
                        {kellyFraction.toFixed(2)}
                      </span>
                    </div>
                    <input
                      id="wl-kelly-fraction"
                      type="range"
                      className="wl2-range-elegant"
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={kellyFraction}
                      onChange={e => setKellyFraction(parseFloat(e.target.value))}
                      aria-valuemin={0.05}
                      aria-valuemax={1}
                      aria-valuenow={Number(kellyFraction)}
                      aria-label="Kelly fraction"
                      style={{
                        ['--wl-range-pct' as string]: `${((kellyFraction - 0.05) / (1 - 0.05)) * 100}%`,
                      }}
                    />
                    <div className="wl2-range-field__scale" aria-hidden>
                      <span>0.05</span>
                      <span>1.00</span>
                    </div>
                    <div className="wl2-range-field__kelly-num">
                      <label className="wl2-range-field__kelly-num-label" htmlFor="wl-kelly-fraction-num">
                        Exact
                      </label>
                      <input
                        id="wl-kelly-fraction-num"
                        type="number"
                        className="wl2-range-field__kelly-num-input"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={kellyFraction}
                        onChange={e =>
                          setKellyFraction(Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 0.5)))
                        }
                        aria-label="Kelly fraction numeric"
                      />
                    </div>
                  </div>
                </div>
                <span className="wl2-sizing-panel__control">
                  <label htmlFor="wl-atr-mult" style={{ whiteSpace: 'nowrap' }}>ATR multiplier</label>
                  <input
                    id="wl-atr-mult"
                    type="number"
                    min={0.5}
                    max={5}
                    step={0.5}
                    value={sizeAtrMultiplier}
                    onChange={e => setSizeAtrMultiplier(parseFloat(e.target.value) || 2)}
                    style={{ width: '65px' }}
                  />
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleSizeCompute(selectedSizingSymbol)}
                  disabled={sizeComputeLoading}
                >
                  {sizeComputeLoading ? 'Computing…' : 'Recompute'}
                </button>
              </div>

              {sizeComputeError && (
                <p className="msg-error wl2-sizing-panel__alert" role="alert">
                  {sizeComputeError}
                </p>
              )}
              {sizeComputeLoading && <p className="section-hint">Fetching bars and quote…</p>}

              {!sizeComputeLoading && sizeAtrResult && (
                <>
                  <section className="wl2-sizing-dash wl2-sizing-dash--nested" aria-labelledby="wl2-order-sizing-head">
                    <h5 id="wl2-order-sizing-head" className="wl2-sizing-dash__subtitle">
                      Order sizing
                    </h5>
                    <p className="wl2-sizing-dash__hint" style={{ marginTop: 0 }}>
                      Auto sizing suggestion from ATR + Kelly. Portfolio <strong>Max drawdown %</strong> and <strong>static risk budget</strong> are set in <strong>Portfolio risk power</strong> (expand if collapsed); the ladder row <em>Portfolio max DD budget</em> uses the same percentage.
                    </p>
                    <div className="wl2-sizing-dash__cards wl2-sizing-dash__cards--tight">
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Intended shares</span>
                        <span className="wl2-sizing-dash__value">
                          {sizingOrderAnalytics.intendedShares > 0 ? sizingOrderAnalytics.intendedShares.toLocaleString() : '—'}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Intended risk %</span>
                        <span className="wl2-sizing-dash__value">
                          {sizingOrderAnalytics.intendedRiskPct != null ? `${sizingOrderAnalytics.intendedRiskPct.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Investment</span>
                        <span className="wl2-sizing-dash__value">
                          {sizingOrderAnalytics.investmentUsd != null ? fmtUsd(sizingOrderAnalytics.investmentUsd) : '—'}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Investment weight</span>
                        <span className="wl2-sizing-dash__value">
                          {sizingOrderAnalytics.investmentWeightPct != null
                            ? `${sizingOrderAnalytics.investmentWeightPct.toFixed(2)}% of NAV`
                            : '—'}
                        </span>
                      </div>
                      <div className="wl2-sizing-dash__card">
                        <span className="wl2-sizing-dash__label">Cash left (after notional)</span>
                        <span
                          className={`wl2-sizing-dash__value${
                            sizingOrderAnalytics.cashLeftAfter != null && sizingOrderAnalytics.cashLeftAfter < 0
                              ? ' wl2-sizing-dash__value--warn'
                              : ''
                          }`}
                        >
                          {sizingOrderAnalytics.cashLeftAfter != null ? fmtUsd(sizingOrderAnalytics.cashLeftAfter) : '—'}
                        </span>
                      </div>
                    </div>

                    <h6 className="wl2-sizing-dash__subtitle wl2-sizing-dash__subtitle--sm">Constraint ladder (max shares @ stop)</h6>
                    <div className="wl2-table-wrap wl2-sizing-dash__table-wrap">
                      <table className="wl2-table wl2-table--dense">
                        <thead>
                          <tr>
                            <th>Source</th>
                            <th>Max $ at risk</th>
                            <th>Max shares</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sizingOrderAnalytics.capRows.map(row => (
                            <tr key={row.key}>
                              <td>{row.label}</td>
                              <td>{row.maxRiskUsd != null ? fmtUsd(row.maxRiskUsd) : '—'}</td>
                              <td>{row.maxShares != null ? row.maxShares.toLocaleString() : '—'}</td>
                            </tr>
                          ))}
                          <tr>
                            <td>Cash merged (IB + cash-like, ÷ entry)</td>
                            <td>—</td>
                            <td>{sizingOrderAnalytics.cashCapShares != null ? sizingOrderAnalytics.cashCapShares.toLocaleString() : '—'}</td>
                          </tr>
                          <tr className="wl2-dash-row--focus">
                            <td>
                              <strong>Available (min)</strong>
                            </td>
                            <td>—</td>
                            <td>
                              <strong>
                                {sizingOrderAnalytics.availableMinShares != null
                                  ? sizingOrderAnalytics.availableMinShares.toLocaleString()
                                  : '—'}
                              </strong>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="wl2-sizing-dash__footnote">
                      Buying power (aggregate): {fmtUsd(portfolioCashRollup.totalBuyingPower)}. History losses use GET /performance summary (same window as Kelly).
                    </p>
                  </section>

                  <h5 className="wl2-sizing-dash__subtitle wl2-sizing-dash__subtitle--sm">Kelly &amp; ATR summary</h5>
                  <div className="risk-summary-cards">
                    <div className="risk-card">
                      <span className="risk-card-label">ATR(14)</span>
                      <span className="risk-card-value">{fmtUsd(sizeAtrResult.atr14)}</span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Current price</span>
                      <span className="risk-card-value">{sizeCurrentPrice != null ? fmtUsd(sizeCurrentPrice) : '—'}</span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Raw Kelly %</span>
                      <span className="risk-card-value">
                        {kellyMetrics.is_valid ? `${(kellyMetrics.kelly_pct * 100).toFixed(2)}%` : '—'}
                      </span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Eff. Kelly % ({kellyFraction.toFixed(2)}×)</span>
                      <span className="risk-card-value">
                        {kellyMetrics.is_valid ? `${(kellyMetrics.effective_kelly * 100).toFixed(2)}%` : '—'}
                      </span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Stop dist. ({sizeAtrMultiplier}× ATR)</span>
                      <span className="risk-card-value">{sizePosResult ? fmtUsd(sizePosResult.stop_distance) : '—'}</span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Shares</span>
                      <span className="risk-card-value">
                        {sizePosResult?.is_valid ? sizePosResult.shares.toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Dollar risk</span>
                      <span className="risk-card-value">
                        {sizePosResult?.is_valid ? fmtUsd(sizePosResult.dollar_risk) : '—'}
                      </span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Risk %</span>
                      <span className="risk-card-value">
                        {sizePosResult?.is_valid ? `${sizePosResult.risk_pct.toFixed(2)}%` : '—'}
                      </span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Stop loss (long)</span>
                      <span className="risk-card-value">
                        {sizePosResult?.is_valid ? fmtUsd(sizePosResult.stop_loss_long) : '—'}
                      </span>
                    </div>
                    <div className="risk-card">
                      <span className="risk-card-label">Stop loss (short)</span>
                      <span className="risk-card-value">
                        {sizePosResult?.is_valid ? fmtUsd(sizePosResult.stop_loss_short) : '—'}
                      </span>
                    </div>
                  </div>
                </>
              )}
              {!sizeComputeLoading && sizeAtrResult && sizePosResult && !sizePosResult.is_valid && (
                <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
                  Sizing unavailable: requires valid Kelly (win_rate &gt; 0 &amp; profit_factor &gt; 0), ATR &gt; 0, and capital &gt; 0.
                </p>
              )}
            </div>
            </div>
          )}
          </div>
          </div>

          <div className="wl2-sizing-sheet-block wl2-sizing-sheet-block--promote" aria-labelledby="wl2-sizing-workflow-head">
            <h4 id="wl2-sizing-workflow-head" className="wl2-sizing-dash__title">
              Sizing sheet
            </h4>

            <div className="wl2-sizing-promote wl2-sizing-promote--inline">
              <div className="wl2-promote-combobox wl2-promote-combobox--compact" ref={promoteComboboxRef}>
                <button
                  type="button"
                  className="wl2-promote-combobox__trigger"
                  id="wl2-promote-combobox-trigger"
                  aria-label="pick new symbol — choose a watchlist row to move to Sizing"
                  aria-expanded={promotePickerOpen}
                  aria-controls="wl2-promote-listbox"
                  aria-haspopup="listbox"
                  onClick={() => {
                    setPromotePickerOpen(o => {
                      const next = !o
                      if (!next) setPromoteFilter('')
                      return next
                    })
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Escape' && promotePickerOpen) {
                      e.preventDefault()
                      closePromotePicker()
                    }
                  }}
                >
                  <span
                    className={`wl2-promote-combobox__value${promoteSelectedItem ? '' : ' wl2-promote-combobox__value--placeholder'}`}
                    title={
                      promoteSelectedItem
                        ? watchlistItemLabel(promoteSelectedItem)
                        : 'pick new symbol'
                    }
                  >
                    {promoteSelectedItem
                      ? watchlistItemLabel(promoteSelectedItem)
                      : 'pick new symbol'}
                  </span>
                  <span className="wl2-promote-combobox__chev" aria-hidden>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
                {promotePickerOpen && (
                  <ul id="wl2-promote-listbox" role="listbox" className="wl2-promote-combobox__menu" aria-labelledby="wl2-promote-combobox-trigger">
                    <li className="wl2-promote-combobox__filter-li" role="presentation" onPointerDown={e => e.preventDefault()}>
                      <input
                        type="search"
                        className="wl2-promote-combobox__filter"
                        value={promoteFilter}
                        onChange={e => setPromoteFilter(e.target.value)}
                        placeholder="Filter symbols…"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Filter watchlist symbols"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            e.stopPropagation()
                            closePromotePicker()
                          }
                        }}
                      />
                    </li>
                    {promoteFilter.trim() === '' && stocksForPromoteToSizing.length > 0 && (
                      <li
                        role="option"
                        aria-selected={promoteContractKey.trim() === ''}
                        className={`wl2-promote-combobox__opt wl2-promote-combobox__opt--placeholder${promoteContractKey.trim() === '' ? ' wl2-promote-combobox__opt--active' : ''}`}
                        onPointerDown={e => e.preventDefault()}
                        onClick={() => {
                          setPromoteContractKey('')
                          closePromotePicker()
                        }}
                      >
                        pick new symbol
                      </li>
                    )}
                    {stocksForPromoteMenu.length === 0 ? (
                      <li className="wl2-promote-combobox__opt wl2-promote-combobox__opt--nomatch" role="presentation">
                        {promoteFilter.trim() ? 'No matches' : 'No symbols in your watchlist'}
                      </li>
                    ) : (
                      stocksForPromoteMenu.map(item => {
                        const key = item.contract_key.trim()
                        const sel = promoteContractKey.trim() === key
                        return (
                          <li
                            key={key}
                            role="option"
                            aria-selected={sel}
                            className={`wl2-promote-combobox__opt${sel ? ' wl2-promote-combobox__opt--active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => {
                              setPromoteContractKey(key)
                              closePromotePicker()
                            }}
                          >
                            {watchlistItemLabel(item)}
                          </li>
                        )
                      })
                    )}
                  </ul>
                )}
              </div>
              <button
                type="button"
                className="wl2-btn wl2-btn--primary wl2-btn--icon"
                disabled={!promoteContractKey.trim() || sizingCategoryId == null || addPending}
                onClick={() => void handlePromoteToSizing()}
                title="Move to Sizing"
                aria-label="Move to Sizing"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                  <path
                    d="M5 12h12M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            {sizingCategoryId == null && (
              <p className="wl2-tier-hint wl2-tier-hint--warn">The <strong>Sizing</strong> category is missing; you cannot promote rows yet.</p>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="wl2-tier-hint">
            <strong>Step 3.</strong> Rows on this list that match your current IB portfolio snapshot. The same symbol can still appear in Watching or Sizing when you keep it there.
          </p>
          {positionSubTab === 'stocks' && (
            <div className="wl2-table-wrap">
              {positionStockRows.length === 0 ? (
                <div className="wl2-empty">No held stocks from this list.</div>
              ) : (
                <table className="wl2-table">
                  <thead>
                    <tr>
                      <th className="wl2-th--sym">Symbol</th>
                      <th className="wl2-th--quote">Last / B·A</th>
                      <th className="wl2-th--opt" title="Show in Option Discovery">Opt</th>
                      <th className="wl2-th--cat">Category</th>
                      <th className="wl2-th--acts" />
                    </tr>
                  </thead>
                  <tbody>{renderStockRows(positionStockRows)}</tbody>
                </table>
              )}
            </div>
          )}
          {positionSubTab === 'options' && (
            <div className="wl2-table-wrap">
              {positionOptRows.length === 0 ? (
                <div className="wl2-empty">No held options from this list.</div>
              ) : (
                <table className="wl2-table">
                  <thead>
                    <tr>
                      <th className="wl2-th--sym">Symbol</th>
                      <th className="wl2-th--quote">Last / B·A</th>
                      <th className="wl2-th--exp">Expiry</th>
                      <th className="wl2-th--right">R</th>
                      <th className="wl2-th--strike">Strike</th>
                      <th className="wl2-th--cat">Category</th>
                      <th className="wl2-th--acts" />
                    </tr>
                  </thead>
                  <tbody>{renderOptionRows(positionOptRows)}</tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {primaryTab !== 'sizing' && barStatsAnalysisSection}

      {/* ── Add option modal ── */}
      {addOptionForSymbol != null && (
        <div
          className="wl2-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wl2-add-opt-title"
          onClick={e => e.target === e.currentTarget && closeAddOptionModal()}
        >
          <div className="wl2-modal" onClick={e => e.stopPropagation()}>
            <h4 id="wl2-add-opt-title" className="wl2-modal__title">
              Add option · <strong>{addOptionForSymbol}</strong>
            </h4>
            <div className="wl2-modal__fields">
              <label className="wl2-modal__field">
                <span className="wl2-modal__field-label">Expiry</span>
                <input
                  type="text"
                  placeholder="yyyy-mm-dd"
                  value={addOptExpiry}
                  onChange={e => setAddOptExpiry(e.target.value)}
                  className="wl2-modal__input"
                />
              </label>
              <label className="wl2-modal__field">
                <span className="wl2-modal__field-label">Right</span>
                <select
                  value={addOptRight}
                  onChange={e => setAddOptRight(e.target.value as 'CALL' | 'PUT')}
                  className="wl2-modal__input"
                >
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                </select>
              </label>
              <label className="wl2-modal__field">
                <span className="wl2-modal__field-label">Strike</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 120"
                  value={addOptStrike}
                  onChange={e => setAddOptStrike(e.target.value)}
                  className="wl2-modal__input"
                />
              </label>
            </div>
            <div className="wl2-modal__footer">
              <button type="button" className="wl2-btn wl2-btn--ghost" onClick={closeAddOptionModal}>Cancel</button>
              <button
                type="button"
                className="wl2-btn wl2-btn--primary"
                disabled={addPending || !addOptExpiry.trim() || !addOptStrike.trim()}
                onClick={() => submitAddOption()}
              >
                {addPending ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
