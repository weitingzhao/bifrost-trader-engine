import type { ReactNode } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type {
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
  fetchPerformance,
  fetchPositionCategories,
  fetchQuotes,
  fetchWatchlist,
  postPositionCategory,
  postWatchlist,
  deleteWatchlist,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { RightInspectorDrawer } from '../components/RightInspectorDrawer'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { AppSelect } from '../components/AppSelect'
import { StockBarStatsPanel } from '../components/StockBarStatsPanel'
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

interface WatchlistPageProps {
  status: StatusResponse | null
  /** Breadcrumb: Research home (same pattern as other Research pages). */
  onBreadcrumbResearch?: () => void
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
  if (!q) return <span className="text-muted-foreground">—</span>
  const last = q.last != null && Number.isFinite(q.last) ? q.last : null
  const bid = q.bid != null && Number.isFinite(q.bid) ? q.bid : null
  const ask = q.ask != null && Number.isFinite(q.ask) ? q.ask : null
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="font-semibold tabular-nums">{last != null ? fmtUsd(last) : '—'}</span>
      {(bid != null || ask != null) && (
        <span className="text-[0.72rem] text-muted-foreground">
          {bid != null && (
            <span className={`tabular-nums${last != null && bid < last ? ' pnl-negative' : last != null && bid > last ? ' pnl-positive' : ''}`}>
              {bid.toFixed(2)}
            </span>
          )}
          <span className="text-muted-foreground">/</span>
          {ask != null && (
            <span className={`tabular-nums${last != null && ask > last ? ' pnl-negative' : last != null && ask < last ? ' pnl-positive' : ''}`}>
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
  /** Right drawer: bar stats + K-line (shared with Positions stock inspector content). */
  const [barStatsInspector, setBarStatsInspector] = useState<string | null>(null)
  const [barStatsLoadingSymbol, setBarStatsLoadingSymbol] = useState<string | null>(null)
  const onBarStatsLoading = useCallback((sym: string, loading: boolean) => {
    setBarStatsLoadingSymbol(loading ? sym : null)
  }, [])
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

  function handleAnalyze(item: WatchlistItem) {
    const sym = symbolFromItem(item)
    if (!sym) return
    setBarStatsInspector(sym.trim().toUpperCase())
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

  useEffect(() => {
    setBarStatsInspector(null)
  }, [primaryTab])

  const renderStockRows = (items: WatchlistItem[], opts?: { showSizeBtn?: boolean; hideCategory?: boolean; hideOpt?: boolean }) =>
    items.map((item) => {
      const sym = symbolFromItem(item)
      const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[sym]
      const held = hasPosition(item)
      const optOn = item.optionable === true
      const symU = sym.trim().toUpperCase()
      const selU = (selectedSizingSymbol ?? '').trim().toUpperCase()
      const isSelected = Boolean(symU && selU === symU)
      const trClass = [opts?.showSizeBtn && isSelected ? 'bg-primary/10' : '', !optOn ? 'opacity-55' : '']
        .filter(Boolean)
        .join(' ') || undefined
      return (
        <tr key={item.contract_key} className={trClass}>
          <td className="min-w-[6rem]" title={item.contract_key}>
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit hover:text-primary"
                onClick={() => {
                  handleAnalyze(item)
                  if (opts?.showSizeBtn && sym) void handleSizeCompute(sym)
                }}
                disabled={
                  barStatsLoadingSymbol !== null
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
                <span className="font-semibold tracking-wide">{watchlistItemLabel(item)}</span>
                {(barStatsLoadingSymbol === symU
                  || (Boolean(opts?.showSizeBtn) && isSelected && sizeComputeLoading))
                  ? <span className="text-muted-foreground" aria-hidden> ⏳</span>
                  : null}
              </button>
              {held && <span className="rounded px-1 py-px text-[0.6rem] font-bold uppercase bg-amber-500/15 text-amber-600" title="Holding">H</span>}
            </span>
          </td>
          <td className="min-w-[7rem] tabular-nums">{renderQuoteCell(q)}</td>
          {!opts?.hideOpt ? (
            <td className="w-12 text-center">
              <button
                type="button"
                className={`cursor-pointer rounded-full border border-border px-2 py-0.5 text-[0.65rem] font-semibold text-muted-foreground${optOn ? ' border-primary bg-primary/15 text-primary' : ''}`}
                onClick={() => handleOptionableToggle(item)}
                aria-label={`Option? for ${watchlistItemLabel(item)}`}
                title={optOn ? 'Included in Option Discovery' : 'Not in Option Discovery'}
              >
                {optOn ? 'ON' : 'OFF'}
              </button>
            </td>
          ) : null}
          {!opts?.hideCategory ? (
            <td className="w-28">
              <AppSelect
                className="max-w-full rounded border border-border bg-background px-1 py-0.5 text-[0.72rem]"
                value={String(item.category_id ?? '')}
                onChange={v => handleWatchlistCategoryChange(item, v ? Number(v) : null)}
                aria-label={`Category for ${watchlistItemLabel(item)}`}
                options={[
                  { value: '', label: '—' },
                  ...positionCategories.map(c => ({ value: String(c.id), label: c.name })),
                ]}
              />
            </td>
          ) : null}
          <td className="w-16 whitespace-nowrap">
            <span className="inline-flex gap-0.5">
              <button
                type="button"
                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => openAddOptionModal(item)}
                title="Add option contract"
                aria-label="Add option"
              >
                ＋
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground text-destructive hover:bg-destructive/10 hover:text-destructive"
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
          <td className="min-w-[6rem]" title={item.contract_key}>
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit hover:text-primary"
                onClick={() => handleAnalyze(item)}
                disabled={barStatsLoadingSymbol !== null}
                title="Bar stats for underlying (PostgreSQL stock_day / stock_min)"
                aria-label={`Bar stats for underlying ${und}`}
              >
                <span className="font-semibold tracking-wide">{item.symbol || watchlistItemLabel(item)}</span>
                {barStatsLoadingSymbol === und.trim().toUpperCase() ? <span className="text-muted-foreground" aria-hidden> ⏳</span> : null}
              </button>
              {held && <span className="rounded px-1 py-px text-[0.6rem] font-bold uppercase bg-amber-500/15 text-amber-600" title="Holding">H</span>}
            </span>
          </td>
          <td className="min-w-[7rem] tabular-nums">{renderQuoteCell(q)}</td>
          <td className="w-24 tabular-nums text-muted-foreground">{formatExpiry(item.expiry)}</td>
          <td className="w-10 text-center">
            <span className={`inline-flex rounded px-1.5 py-px text-[0.65rem] font-bold${(item.option_right || '').toUpperCase() === 'C' || (item.option_right || '').toUpperCase() === 'CALL' ? ' bg-emerald-500/15 text-emerald-600' : ' bg-rose-500/15 text-rose-600'}`}>
              {formatOptionRight(item.option_right)}
            </span>
          </td>
          <td className="w-20 text-right tabular-nums">{item.strike != null ? formatStrike(item.strike) : '—'}</td>
          <td className="w-28">
            <AppSelect
              className="max-w-full rounded border border-border bg-background px-1 py-0.5 text-[0.72rem]"
              value={String(item.category_id ?? '')}
              onChange={v => handleWatchlistCategoryChange(item, v ? Number(v) : null)}
              aria-label={`Category for ${item.symbol || watchlistItemLabel(item)}`}
              options={[
                { value: '', label: '—' },
                ...positionCategories.map(c => ({ value: String(c.id), label: c.name })),
              ]}
            />
          </td>
          <td className="w-16 whitespace-nowrap">
            <button
              type="button"
              className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground text-destructive hover:bg-destructive/10 hover:text-destructive"
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

  return (
    <PageSection className="watchlist-page w-full max-w-none">
      {/* ── Header bar ── */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="research-page-head">
          <SectionPageTitle
            menu="Research"
            pageTitle="Stock Screener"
            onMenuClick={onBreadcrumbResearch}
            menuNavigateAriaLabel="Research home"
            infoText="Stock screener workflow: Watching (ideas) → Sizing (pre-trade sizing) → Positions (live IB holdings). Categories Watching / Sizing match Portfolio → Accounts. Quotes use IB / Redis. Bar-chart OHLC in the analysis panel is read from PostgreSQL (Massive or IB sources); use Fetch from Massive to enqueue Massive custom_bars sync."
            style={{ margin: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem' }}
          >
            <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[0.7rem] font-semibold text-primary">{watchlistItems.length}</span>
          </SectionPageTitle>
          <div className="flex items-center gap-1.5">
          {(primaryTab === 'watching' || primaryTab === 'positions') && positionsNotInWatchlist.length > 0 && (
            <button
              type="button"
              className="cursor-pointer rounded-md border border-transparent px-2.5 py-1 text-[0.85rem] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 h-8 px-2.5 text-[0.8rem]"
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
                className="h-8 w-full min-w-0 max-w-56 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-primary"
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
                className="cursor-pointer rounded-md border border-transparent px-2.5 py-1 text-[0.85rem] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed border-primary bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex h-8 w-8 items-center justify-center p-0 text-lg leading-none"
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
        <div className="mb-1 py-1 text-[0.78rem] text-destructive" role="alert">{watchlistError}</div>
      )}

      {/* ── Position picker ── */}
      {showPositionPicker && positionsNotInWatchlist.length > 0 && (primaryTab === 'watching' || primaryTab === 'positions') && (
        <div className="mb-2 flex flex-wrap gap-1 py-1">
          {positionsNotInWatchlist.map((p, idx) => {
            const ck = positionToContractKey(p)
            const label = p.symbol || ck.split('|')[0]
            return (
              <button
                key={ck + String(idx)}
                type="button"
                className="cursor-pointer rounded-full border border-border bg-background px-2 py-0.5 text-[0.72rem] font-medium text-muted-foreground hover:border-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
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
        <div className="mb-4 flex flex-wrap items-stretch gap-2" role="tablist" aria-label="Position workflow steps">
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === 'watching'}
            aria-current={primaryTab === 'watching' ? 'step' : undefined}
            className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:bg-muted/50${primaryTab === 'watching' ? ' border-primary bg-primary/10 text-foreground' : ''}${primaryTab === 'sizing' || primaryTab === 'positions' ? ' border-primary/50 text-foreground' : ''}`}
            onClick={() => { setPrimaryTab('watching'); setShowPositionPicker(false) }}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.72rem] font-bold" aria-hidden>1</span>
            <span className="flex min-w-0 flex-col gap-0.5 text-left">
              <span className="text-[0.85rem] font-semibold">Watching</span>
              <span className="text-[0.72rem] text-muted-foreground">Screen names &amp; ideas</span>
            </span>
            <span className="ml-auto rounded-full bg-muted px-2 py-0.5 font-mono text-[0.65rem] font-semibold text-muted-foreground">{watchingTabCount}</span>
          </button>
          <span
            className={`hidden h-px w-4 shrink-0 bg-border sm:block${primaryTab === 'sizing' || primaryTab === 'positions' ? ' bg-primary' : ''}`}
            aria-hidden
          />
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === 'sizing'}
            aria-current={primaryTab === 'sizing' ? 'step' : undefined}
            className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:bg-muted/50 ${primaryTab === 'sizing' ? ' border-primary bg-primary/10 text-foreground' : ''}${primaryTab === 'positions' ? ' border-primary/50 text-foreground' : ''}`}
            onClick={() => { setPrimaryTab('sizing'); setShowPositionPicker(false); setPromoteContractKey('') }}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.72rem] font-bold" aria-hidden>2</span>
            <span className="flex min-w-0 flex-col gap-0.5 text-left">
              <span className="text-[0.85rem] font-semibold">Sizing</span>
              <span className="text-[0.72rem] text-muted-foreground">Size before you trade</span>
            </span>
            <span className="ml-auto rounded-full bg-muted px-2 py-0.5 font-mono text-[0.65rem] font-semibold text-muted-foreground">{sizingTabCount}</span>
          </button>
          <span
            className={`hidden h-px w-4 shrink-0 bg-border sm:block${primaryTab === 'positions' ? ' bg-primary' : ''}`}
            aria-hidden
          />
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === 'positions'}
            aria-current={primaryTab === 'positions' ? 'step' : undefined}
            className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:bg-muted/50${primaryTab === 'positions' ? ' border-primary bg-primary/10 text-foreground' : ''}`}
            onClick={() => { setPrimaryTab('positions'); setPromoteContractKey('') }}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.72rem] font-bold" aria-hidden>3</span>
            <span className="flex min-w-0 flex-col gap-0.5 text-left">
              <span className="text-[0.85rem] font-semibold">Positions</span>
              <span className="text-[0.72rem] text-muted-foreground">Live IB holdings</span>
            </span>
            <span className="ml-auto rounded-full bg-muted px-2 py-0.5 font-mono text-[0.65rem] font-semibold text-muted-foreground">{positionsTabCount}</span>
          </button>
        </div>
      )}

      {!watchlistLoading && primaryTab === 'positions' && (
        <div className="-mt-1 mb-3 flex flex-wrap items-center gap-3 pl-2">
          <span className="text-[0.72rem] font-semibold uppercase tracking-wide text-muted-foreground">Step 3 — instrument type</span>
          <nav className="-mt-1 mb-3 flex gap-0 border-b border-border pl-2" aria-label="Positions instrument type">
            <button
              type="button"
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 border-0 border-b-2 border-transparent bg-transparent px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground',
                positionSubTab === 'stocks' && 'border-b-primary text-foreground',
              )}
              onClick={() => setPositionSubTab('stocks')}
            >
              Stocks
              <span className={cn(
                'rounded-lg bg-muted px-1.5 font-mono text-[0.65rem] font-semibold leading-normal text-muted-foreground',
                positionSubTab === 'stocks' && 'bg-primary text-primary-foreground',
              )}>{positionStockRows.length}</span>
            </button>
            <button
              type="button"
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 border-0 border-b-2 border-transparent bg-transparent px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground',
                positionSubTab === 'options' && 'border-b-primary text-foreground',
              )}
              onClick={() => setPositionSubTab('options')}
            >
              Options
              <span className={cn(
                'rounded-lg bg-muted px-1.5 font-mono text-[0.65rem] font-semibold leading-normal text-muted-foreground',
                positionSubTab === 'options' && 'bg-primary text-primary-foreground',
              )}>{positionOptRows.length}</span>
            </button>
          </nav>
        </div>
      )}

      {/* ── Main content ── */}
      {watchlistLoading ? (
        <div className="py-4 text-center text-[0.82rem] text-muted-foreground">Loading…</div>
      ) : primaryTab === 'watching' ? (
        <>
          <p className="mb-3 text-[0.8rem] leading-snug text-muted-foreground">
            <strong>Step 1.</strong> Tickers you add in the header are stored with category <strong>Watching</strong> (same names as Portfolio → Accounts). Symbols may appear here even if you already hold them. Option legs in Watching / uncategorized are in the second table below.
          </p>
          {watchingCategoryId == null && (
            <p className="mb-3 text-[0.8rem] leading-snug text-muted-foreground text-amber-500">
              The <strong>Watching</strong> category is missing or still being created. If this persists, add <strong>Watching</strong> and <strong>Sizing</strong> under Portfolio → Accounts.
            </p>
          )}
          {watchlistItems.length === 0 && watchingStockRows.length === 0 && watchingOptionRows.length === 0 ? (
            <div className="py-4 text-center text-[0.82rem] text-muted-foreground">No symbols yet. Type a ticker in the header to start in Watching.</div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border">
                {watchingStockRows.length === 0 && otherCategoryStockRows.length === 0 ? (
                  <div className="py-4 text-center text-[0.82rem] text-muted-foreground">No stock rows in Watching / uncategorized.</div>
                ) : (
                  <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                    <thead>
                      <tr>
                        <th className="min-w-[6rem]">Symbol</th>
                        <th className="min-w-[7rem]">Last / B·A</th>
                        <th className="w-12 text-center" title="Show in Option Discovery">Opt</th>
                        <th className="w-28">Category</th>
                        <th className="w-16" />
                      </tr>
                    </thead>
                    <tbody>
                      {renderStockRows(watchingStockRows)}
                    </tbody>
                    {otherCategoryStockRows.length > 0 && (
                      <tbody>
                        <tr className="bg-muted/40">
                          <td colSpan={5}>
                            <span className="text-[0.72rem] font-semibold uppercase tracking-wide text-muted-foreground">Other portfolio categories</span>
                            <span className="ml-2 font-mono text-[0.65rem] text-muted-foreground">{otherCategoryStockRows.length}</span>
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
                  <p className="mb-3 text-[0.8rem] leading-snug text-muted-foreground" style={{ marginTop: 'var(--space-4)' }}>Options on the list (Watching / uncategorized)</p>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                      <thead>
                        <tr>
                          <th className="min-w-[6rem]">Symbol</th>
                          <th className="min-w-[7rem]">Last / B·A</th>
                          <th className="w-24">Expiry</th>
                          <th className="w-10 text-center">R</th>
                          <th className="w-20 text-right">Strike</th>
                          <th className="w-28">Category</th>
                          <th className="w-16" />
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
          <p className="mb-3 text-[0.8rem] leading-snug text-muted-foreground">
            <strong>Step 2.</strong> The table lists stocks tagged <strong>Sizing</strong>. Pick any stock symbol from your watchlist below, then <strong>Move to Sizing</strong>.
          </p>

          <section
            className="mb-4 rounded-[10px] border border-border bg-muted/30 p-3"
            aria-labelledby="mb-2"
          >
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <h4 id="mb-2" className="mb-1 text-[0.95rem] font-semibold tracking-tight text-foreground m-0 shrink-0">
                Portfolio risk power
              </h4>
              <InfoTooltip text={WL_HELP_PORTFOLIO_TABLE} />
              <button
                type="button"
                className="section-header-icon-btn ml-auto"
                onClick={() => setPortfolioRiskPowerCollapsed(v => !v)}
                aria-expanded={!portfolioRiskPowerCollapsed}
                aria-controls="min-w-0"
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
              <div id="min-w-0" className="mb-2 flex flex-nowrap flex-wrap items-center gap-3 rounded-lg border border-border/85 bg-muted/30 px-2.5 py-2" role="status" aria-live="polite">
                <div className="flex min-w-0 flex-nowrap items-baseline gap-2 whitespace-nowrap">
                  <span className="text-[0.67rem] font-semibold uppercase tracking-wide text-muted-foreground">Host</span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    Cash:{' '}
                    <span className="font-bold text-primary/90">
                      {hostCashPie ? fmtUsd(hostCashPie.cash) : '—'}
                    </span>
                  </span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    STK:{' '}
                    <span className="font-bold text-primary/90">
                      {hostCashPie ? fmtUsd(hostCashPie.stkExFi) : '—'}
                    </span>
                  </span>
                </div>
                <div className="flex min-w-0 flex-nowrap items-baseline gap-2 whitespace-nowrap">
                  <span className="text-[0.67rem] font-semibold uppercase tracking-wide text-muted-foreground">Secondary</span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    Cash:{' '}
                    <span className="font-bold text-primary/90">
                      {secondaryCashPie ? fmtUsd(secondaryCashPie.cash) : '—'}
                    </span>
                  </span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    STK:{' '}
                    <span className="font-bold text-primary/90">
                      {secondaryCashPie ? fmtUsd(secondaryCashPie.stkExFi) : '—'}
                    </span>
                  </span>
                </div>
                <div className="flex min-w-0 flex-nowrap items-baseline gap-2 whitespace-nowrap ml-auto">
                  <span className="text-[0.67rem] font-semibold uppercase tracking-wide text-muted-foreground">Max drawdown %</span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap text-[0.88rem] font-bold text-primary">
                    {staticMaxDdPctCap.toFixed(0)}%
                  </span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    Static risk budget:{' '}
                    <span className="font-bold text-primary/90">
                      {capital > 0 ? fmtUsd(staticRiskBudgetUsd) : '—'}
                    </span>
                  </span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    Max drawdown:{' '}
                    <span className="font-bold text-primary/90">
                      {portfolioDdFromHistory.usd != null ? fmtUsd(portfolioDdFromHistory.usd) : '—'}
                    </span>
                  </span>
                  <span className="text-[0.78rem] tabular-nums text-foreground whitespace-nowrap">
                    Per-trade loss:{' '}
                    <span className="font-bold text-primary/90">
                      {capital > 0 ? fmtUsd(staticRiskUsdPerTrade) : '—'}
                    </span>
                  </span>
                </div>
              </div>
            ) : (
            <>
            <div id="min-w-0" className="mb-2 grid grid-cols-[minmax(11rem,2fr)_minmax(11rem,2fr)_minmax(0,8fr)] items-start gap-3">
              <div className="mb-2 max-w-md min-w-0 mb-0 max-w-none min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <label className="text-[0.72rem] font-semibold text-muted-foreground" htmlFor="wl-portfolio-max-dd-pct">
                      Max drawdown %
                    </label>
                    <InfoTooltip text={WL_HELP_MAX_DD_SCENARIO} />
                  </div>
                  <span className="text-[0.82rem] font-semibold tabular-nums text-foreground" aria-live="polite">
                    {staticMaxDdPctCap}
                    <span className="text-muted-foreground">%</span>
                  </span>
                </div>
                <input
                  id="wl-portfolio-max-dd-pct"
                  type="range"
                  className="min-w-0"
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
                <div className="mt-1" aria-hidden>
                  <span>5%</span>
                  <span>50%</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 border-primary/40 bg-primary/5">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">Max drawdown (history)</span>
                    <span className="text-[0.82rem] font-semibold tabular-nums">
                      {portfolioDdFromHistory.usd != null ? fmtUsd(portfolioDdFromHistory.usd) : '—'}
                    </span>
                    {portfolioDdFromHistory.pctOfNav != null ? (
                      <span className="text-[0.65rem] text-muted-foreground">
                        {portfolioDdFromHistory.pctOfNav.toFixed(2)}% of NAV
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="mb-2 max-w-md min-w-0 mb-0 max-w-none min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <label className="text-[0.72rem] font-semibold text-muted-foreground" htmlFor="wl-static-risk-pct">
                      Static Risk % (per trade)
                    </label>
                  </div>
                  <span className="text-[0.82rem] font-semibold tabular-nums text-foreground" aria-live="polite">
                    {staticRiskPctPerTrade.toFixed(1)}
                    <span className="text-muted-foreground">%</span>
                  </span>
                </div>
                <input
                  id="wl-static-risk-pct"
                  type="range"
                  className="min-w-0"
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
                <div className="mt-1" aria-hidden>
                  <span>0.1%</span>
                  <span>5.0%</span>
                </div>
                <div className="grid grid-cols-2 gap-2 grid-cols-1">
                  <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 border-primary/40 bg-primary/5">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">Per-trade fixed loss budget</span>
                    <span className="text-[0.82rem] font-semibold tabular-nums">
                      {capital > 0 ? fmtUsd(staticRiskUsdPerTrade) : '—'}
                    </span>
                    <span className="text-[0.65rem] text-muted-foreground">
                      Total capital × {staticRiskPctPerTrade.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-border mt-2 min-w-0">
              <table className="w-full border-collapse text-xs [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="text-right tabular-nums">Cash (IB)</th>
                    <th className="text-right tabular-nums">Cash-like</th>
                    <th className="text-right tabular-nums">Cash total</th>
                    <th className="text-right tabular-nums">Positions MV</th>
                    <th className="text-right tabular-nums">Net liq.</th>
                    <th className="text-right tabular-nums">Max DD @ {staticMaxDdPctCap}%</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>Host</strong>
                      {portfolioAccountTable.hostId ? (
                        <div className="text-muted-foreground">
                          <code className="font-mono text-xs">{portfolioAccountTable.hostId}</code>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">event_host / trading not set</div>
                      )}
                    </td>
                    {portfolioAccountTable.hostRow ? (
                      <>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.hostRow.ibCash)}</span>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.hostRow.cashLike)}</span>
                        </td>
                        <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.hostRow.cashTotal)}</td>
                        <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.hostRow.positionsMv)}</td>
                        <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.hostRow.netLiq)}</td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.hostRow.maxDdUsd)}</span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary text-muted-foreground">—</span>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary text-muted-foreground">—</span>
                        </td>
                        <td className="text-right tabular-nums">—</td>
                        <td className="text-right tabular-nums">—</td>
                        <td className="text-right tabular-nums">—</td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary text-muted-foreground">—</span>
                        </td>
                      </>
                    )}
                  </tr>
                  <tr>
                    <td>
                      <strong>Secondary</strong>
                      {portfolioAccountTable.secondaryId ? (
                        <div className="text-muted-foreground">
                          <code className="font-mono text-xs">{portfolioAccountTable.secondaryId}</code>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">event_secondary not set (optional)</div>
                      )}
                    </td>
                    {portfolioAccountTable.secondaryRow ? (
                      <>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.secondaryRow.ibCash)}</span>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.secondaryRow.cashLike)}</span>
                        </td>
                        <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.secondaryRow.cashTotal)}</td>
                        <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.secondaryRow.positionsMv)}</td>
                        <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.secondaryRow.netLiq)}</td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.secondaryRow.maxDdUsd)}</span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary text-muted-foreground">—</span>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary text-muted-foreground">—</span>
                        </td>
                        <td className="text-right tabular-nums">—</td>
                        <td className="text-right tabular-nums">—</td>
                        <td className="text-right tabular-nums">—</td>
                        <td className="text-right tabular-nums">
                          <span className="font-bold text-primary text-muted-foreground">—</span>
                        </td>
                      </>
                    )}
                  </tr>
                  <tr className="font-semibold">
                    <td>
                      <strong>Total</strong>
                      <div className="text-muted-foreground">All accounts in snapshot</div>
                    </td>
                    <td className="text-right tabular-nums">
                      <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.totalRow.ibCash)}</span>
                    </td>
                    <td className="text-right tabular-nums">
                      <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.totalRow.cashLike)}</span>
                    </td>
                    <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.totalRow.cashTotal)}</td>
                    <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.totalRow.positionsMv)}</td>
                    <td className="text-right tabular-nums">{fmtUsd(portfolioAccountTable.totalRow.netLiq)}</td>
                    <td className="text-right tabular-nums">
                      <span className="font-bold text-primary">{fmtUsd(portfolioAccountTable.totalRow.maxDdUsd)}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
            </>
            )}

            {!portfolioRiskPowerCollapsed && (
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h5 className="mb-2 text-[0.88rem] font-semibold text-foreground mt-3 text-[0.82rem] font-semibold text-muted-foreground mb-0 shrink-0">
                  Cash & ex‑FI stocks vs net liquidation
                </h5>
                <InfoTooltip text={WL_HELP_CASH_PIE} />
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <div className="min-w-0">
                  <h6 className="mb-1 text-[0.72rem] font-semibold uppercase tracking-wide text-muted-foreground">Host</h6>
                  {hostCashPie ? (
                    <>
                      <div className="grid grid-cols-[auto_1fr] items-center gap-3">
                        <div
                          className="relative inline-flex items-center justify-center"
                          role="img"
                          aria-label={`Host: cash ${hostCashPie.cashPctOfNet.toFixed(1)} percent, STK ex-FI ${hostCashPie.stkPctOfNet.toFixed(1)} percent, other ${hostCashPie.otherPctOfNet.toFixed(1)} percent of net liquidation`}
                        >
                          <div
                            className="relative h-24 w-24 shrink-0 rounded-full"
                            style={{
                              background: `conic-gradient(
                                color-mix(in srgb, var(--color-accent) 88%, #050a10) 0turn ${hostCashPie.cashTurnEnd}turn,
                                color-mix(in srgb, var(--text-emerald-500) 74%, var(--color-bg)) ${hostCashPie.cashTurnEnd}turn ${hostCashPie.stkTurnEnd}turn,
                                color-mix(in srgb, var(--color-border) 72%, var(--color-surface)) ${hostCashPie.stkTurnEnd}turn 1turn
                              )`,
                            }}
                          />
                          <div className="absolute inset-[22%] rounded-full bg-background">
                            <span className="text-[0.72rem] font-semibold tabular-nums">{hostCashPie.cashPctOfNet.toFixed(1)}%</span>
                            <span className="text-[0.72rem] font-semibold tabular-nums text-emerald-500">{hostCashPie.stkPctOfNet.toFixed(1)}%</span>
                            <span className="text-[0.65rem] text-muted-foreground">cash · stk ex‑FI</span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-0.5 text-xs flex flex-col gap-1" role="list">
                          <div className="flex items-baseline justify-between gap-2" role="listitem">
                            <div className="min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden />
                              <span className="text-[0.72rem] text-muted-foreground">
                                <strong>Cash total</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {fmtUsd(hostCashPie.cash)}{' '}
                                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">({hostCashPie.cashPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="text-right">
                              <div className="text-[0.72rem] text-muted-foreground text-right">
                                <strong>Net liq.</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">{fmtUsd(hostCashPie.net)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-baseline justify-between gap-2" role="listitem">
                            <div className="min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                              <span className="text-[0.72rem] text-muted-foreground">
                                <strong>STK ex‑FI</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {fmtUsd(hostCashPie.stkExFi)}{' '}
                                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">({hostCashPie.stkPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="text-right">
                              <div className="text-[0.72rem] text-muted-foreground text-right">
                                <strong>Ex‑FI net liq.</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">{fmtUsd(hostCashPie.netLiqExFi)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-baseline justify-between gap-2" role="listitem">
                            <div className="min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
                              <span className="text-[0.72rem] text-muted-foreground">
                                <strong>Other</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {fmtUsd(hostCashPie.other)}{' '}
                                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">({hostCashPie.otherPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="text-right">
                              <div className="text-[0.72rem] text-muted-foreground text-right">
                                <strong>Cash / ex‑FI</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {hostCashPie.cashPctExFi != null ? `${hostCashPie.cashPctExFi.toFixed(1)}%` : '—'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-[0.78rem] italic text-muted-foreground">
                      {portfolioCashRollup.hostReason === 'no_config'
                        ? 'Set event_host or trading in Settings → IB.'
                        : portfolioCashRollup.hostReason === 'no_account'
                          ? `Account ${portfolioCashRollup.hostId ?? '—'} is not in this snapshot.`
                          : '—'}
                    </p>
                  )}
                </div>
                <div className="min-w-0">
                  <h6 className="mb-1 text-[0.72rem] font-semibold uppercase tracking-wide text-muted-foreground">Secondary</h6>
                  {secondaryCashPie ? (
                    <>
                      <div className="grid grid-cols-[auto_1fr] items-center gap-3">
                        <div
                          className="relative inline-flex items-center justify-center"
                          role="img"
                          aria-label={`Secondary: cash ${secondaryCashPie.cashPctOfNet.toFixed(1)} percent, STK ex-FI ${secondaryCashPie.stkPctOfNet.toFixed(1)} percent, other ${secondaryCashPie.otherPctOfNet.toFixed(1)} percent of net liquidation`}
                        >
                          <div
                            className="relative h-24 w-24 shrink-0 rounded-full"
                            style={{
                              background: `conic-gradient(
                                color-mix(in srgb, var(--color-accent) 88%, #050a10) 0turn ${secondaryCashPie.cashTurnEnd}turn,
                                color-mix(in srgb, var(--text-emerald-500) 74%, var(--color-bg)) ${secondaryCashPie.cashTurnEnd}turn ${secondaryCashPie.stkTurnEnd}turn,
                                color-mix(in srgb, var(--color-border) 72%, var(--color-surface)) ${secondaryCashPie.stkTurnEnd}turn 1turn
                              )`,
                            }}
                          />
                          <div className="absolute inset-[22%] rounded-full bg-background">
                            <span className="text-[0.72rem] font-semibold tabular-nums">{secondaryCashPie.cashPctOfNet.toFixed(1)}%</span>
                            <span className="text-[0.72rem] font-semibold tabular-nums text-emerald-500">{secondaryCashPie.stkPctOfNet.toFixed(1)}%</span>
                            <span className="text-[0.65rem] text-muted-foreground">cash · stk ex‑FI</span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-0.5 text-xs flex flex-col gap-1" role="list">
                          <div className="flex items-baseline justify-between gap-2" role="listitem">
                            <div className="min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden />
                              <span className="text-[0.72rem] text-muted-foreground">
                                <strong>Cash total</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {fmtUsd(secondaryCashPie.cash)}{' '}
                                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">({secondaryCashPie.cashPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="text-right">
                              <div className="text-[0.72rem] text-muted-foreground text-right">
                                <strong>Net liq.</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">{fmtUsd(secondaryCashPie.net)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-baseline justify-between gap-2" role="listitem">
                            <div className="min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                              <span className="text-[0.72rem] text-muted-foreground">
                                <strong>STK ex‑FI</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {fmtUsd(secondaryCashPie.stkExFi)}{' '}
                                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">({secondaryCashPie.stkPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="text-right">
                              <div className="text-[0.72rem] text-muted-foreground text-right">
                                <strong>Ex‑FI net liq.</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">{fmtUsd(secondaryCashPie.netLiqExFi)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-baseline justify-between gap-2" role="listitem">
                            <div className="min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
                              <span className="text-[0.72rem] text-muted-foreground">
                                <strong>Other</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
                                  {fmtUsd(secondaryCashPie.other)}{' '}
                                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">({secondaryCashPie.otherPctOfNet.toFixed(1)}%)</span>
                                </span>
                              </span>
                            </div>
                            <div className="text-right">
                              <div className="text-[0.72rem] text-muted-foreground text-right">
                                <strong>Cash / ex‑FI</strong>
                                <span className="text-[0.78rem] font-semibold tabular-nums">
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
                    <p className="text-[0.78rem] italic text-muted-foreground">
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

          <div className="mb-4 grid grid-cols-[minmax(0,3fr)_minmax(0,9fr)] items-start gap-3 max-[960px]:grid-cols-1">
            <div className="min-w-0">
          <section className="mb-4 rounded-[10px] border border-border bg-muted/30 p-3 mb-0 min-w-0">
            <div className="min-w-0" aria-labelledby="mb-2">
            <h5 id="mb-2" className="mb-2 text-[0.88rem] font-semibold text-foreground mt-3">
              Sizing symbol sheet
            </h5>
            <div className="overflow-x-auto rounded-lg border border-border min-w-0">
              {sizingStockRows.length === 0 ? (
                <div className="py-4 text-center text-[0.82rem] text-muted-foreground">No Sizing symbols yet. Promote from Watching above.</div>
              ) : (
                <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                  <thead>
                    <tr>
                      <th className="min-w-[6rem]">Symbol</th>
                      <th className="min-w-[7rem]">Last / B·A</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>{renderStockRows(sizingStockRows, { showSizeBtn: true, hideCategory: true, hideOpt: true })}</tbody>
                </table>
              )}
            </div>

            {selectedSizingSymbol && !sizeComputeLoading && sizeAtrResult && (
              <section
                className="mb-4 rounded-[10px] border border-border bg-muted/30 p-3 mb-0 mt-3 bg-background/70 p-3 border-destructive/40 bg-destructive/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--destructive)_22%,transparent)]"
                aria-labelledby="mb-2"
              >
                <div className="mb-2">
                  <h5 id="mb-2" className="mb-2 text-[0.88rem] font-semibold text-foreground text-[0.82rem] font-semibold text-destructive">
                    Order section
                  </h5>
                  <InfoTooltip text={WL_HELP_ORDER_SECTION} />
                </div>
                <div className="mb-2 flex min-w-0 flex-nowrap items-baseline gap-x-1.5 gap-y-1 overflow-x-auto whitespace-nowrap rounded-md border border-destructive/20 bg-muted/40 px-2 py-1.5">
                  <span className="shrink-0 text-[0.64rem] font-semibold uppercase tracking-wide text-muted-foreground">Current bid</span>
                  <span className="shrink-0 text-[0.95rem] font-semibold tabular-nums text-foreground">
                    {selectedSizingBid != null ? fmtUsd(selectedSizingBid) : '—'}
                  </span>
                  <span className="shrink-0 text-[0.75rem] font-medium text-muted-foreground" aria-hidden>
                    ,
                  </span>
                  <span className="shrink-0 text-[0.82rem] font-bold tabular-nums tracking-wide text-foreground">{selectedSizingSymbol}</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)] items-end gap-x-1.5 gap-y-1 grid-cols-3">
                  <label className="flex min-w-0 flex-col gap-0.5" htmlFor="wl-order-entry">
                    <span className="text-[0.64rem] font-semibold uppercase tracking-wide text-muted-foreground">ENTRY</span>
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
                  <label className="flex min-w-0 flex-col gap-0.5" htmlFor="wl-order-exit">
                    <span className="text-[0.64rem] font-semibold uppercase tracking-wide text-muted-foreground">EXIT</span>
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
                  <label className="flex min-w-0 flex-col gap-0.5" htmlFor="wl-order-shares">
                    <span className="text-[0.64rem] font-semibold uppercase tracking-wide text-muted-foreground">
                      AMT
                      <span className="text-[0.65rem] text-muted-foreground">step 100</span>
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
              <section className="mb-4 rounded-[10px] border border-border bg-muted/30 p-3 mb-0 mt-3 bg-background/70 p-3" aria-labelledby="mb-2">
                <div className="mb-2">
                  <h5 id="mb-2" className="mb-2 text-[0.88rem] font-semibold text-foreground text-[0.82rem] font-semibold text-destructive">
                    Order risk verify
                  </h5>
                  <InfoTooltip text={WL_HELP_ORDER_RISK_VERIFY} />
                </div>
                <div className="min-w-0 min-w-0">
                  <h6 className="text-[0.82rem] font-semibold">Risk sheet</h6>
                  <div className="grid grid-cols-2 gap-3 max-[960px]:grid-cols-1">
                    <div className="min-w-0">
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2 border-primary/40 bg-primary/5">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Distance</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {manualOrderAnalytics.distance != null ? (
                            <>
                              {fmtUsd(manualOrderAnalytics.distance)}
                              {manualOrderAnalytics.distancePctOfBid != null ? (
                                <span className="text-muted-foreground">
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
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2 border-primary/40 bg-primary/5">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Positional drawdown</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {manualOrderAnalytics.positionalDrawdownRatio != null
                            ? `${(manualOrderAnalytics.positionalDrawdownRatio * 100).toFixed(2)}% of entry`
                            : '—'}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2 border-primary/40 bg-primary/5">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Risk per share</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {manualOrderAnalytics.riskPerShare != null ? fmtUsd(manualOrderAnalytics.riskPerShare) : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Order risk ($)</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {manualOrderAnalytics.orderRiskUsd != null ? fmtUsd(manualOrderAnalytics.orderRiskUsd) : '—'}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Risk % of NAV</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {manualOrderAnalytics.riskPct != null ? `${manualOrderAnalytics.riskPct.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="min-w-0 min-w-0">
                  <h6 className="text-[0.82rem] font-semibold">Capital sheet</h6>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2 grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] grid grid-cols-2 gap-2 max-[960px]:grid-cols-1">
                    <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Investment</span>
                      <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                        {manualOrderAnalytics.investmentUsd != null ? fmtUsd(manualOrderAnalytics.investmentUsd) : '—'}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Investment weight</span>
                      <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                        {manualOrderAnalytics.investmentWeightPct != null
                          ? `${manualOrderAnalytics.investmentWeightPct.toFixed(2)}% of NAV`
                          : '—'}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">CASH LEFT</span>
                      <span
                        className={`block text-[0.88rem] font-semibold tabular-nums text-foreground${ manualOrderAnalytics.cashLeftAfter != null && manualOrderAnalytics.cashLeftAfter < 0 ? ' text-amber-500' : '' }`}
                      >
                        {manualOrderAnalytics.cashLeftAfter != null ? fmtUsd(manualOrderAnalytics.cashLeftAfter) : '—'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="min-w-0" aria-labelledby="mb-2 flex items-center gap-2">
                  <h6 id="mb-2 flex items-center gap-2" className="text-[0.82rem] font-semibold">
                    ATR sheet
                  </h6>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2 grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] grid grid-cols-2 gap-2 max-[960px]:grid-cols-1">
                    <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2 border-primary/40 bg-primary/5">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">ATR(14)</span>
                      <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                        {manualOrderAnalytics.atr14 != null ? fmtUsd(manualOrderAnalytics.atr14) : '—'}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2 border-primary/40 bg-primary/5">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">ATR % of entry</span>
                      <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                        {manualOrderAnalytics.atrPctPercent != null
                          ? `${manualOrderAnalytics.atrPctPercent.toFixed(2)}%`
                          : '—'}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2 border-primary/40 bg-primary/5">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">ATR risk</span>
                      <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                        {manualOrderAnalytics.atrRisk != null
                          ? `${manualOrderAnalytics.atrRisk.toFixed(2)} ATR`
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>
                {!manualOrderAnalytics.isComplete ? (
                  <p className="mt-2 text-[0.72rem] text-muted-foreground">
                    Enter Entry price, Exit price, and Share amt above to complete the risk check.
                  </p>
                ) : null}
              </section>
            )}
            </div>

          </section>
            </div>

            <div className="min-w-0">
          {/* ── Order sizing (selected symbol) ── */}
          {selectedSizingSymbol && (
            <div className="min-w-0 w-full">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h4 className="text-[0.82rem] font-semibold text-foreground">Order sizing — {selectedSizingSymbol}</h4>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground text-destructive hover:bg-destructive/10 hover:text-destructive"
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

              <div className="flex flex-wrap gap-2">
                <div className="min-w-0 block w-full">
                  <div className="mb-2 max-w-md min-w-0 max-w-none">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <label className="text-[0.72rem] font-semibold text-muted-foreground" htmlFor="wl-kelly-fraction">
                        Kelly fraction
                      </label>
                      <span className="text-[0.82rem] font-semibold tabular-nums text-foreground text-primary" aria-live="polite">
                        {kellyFraction.toFixed(2)}
                      </span>
                    </div>
                    <input
                      id="wl-kelly-fraction"
                      type="range"
                      className="min-w-0"
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
                    <div className="mt-1" aria-hidden>
                      <span>0.05</span>
                      <span>1.00</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <label className="text-[0.65rem] text-muted-foreground" htmlFor="wl-kelly-fraction-num">
                        Exact
                      </label>
                      <input
                        id="wl-kelly-fraction-num"
                        type="number"
                        className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-sm tabular-nums"
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
                <span className="min-w-0">
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
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleSizeCompute(selectedSizingSymbol)}
                  disabled={sizeComputeLoading}
                >
                  {sizeComputeLoading ? 'Computing…' : 'Recompute'}
                </Button>
              </div>

              {sizeComputeError && (
                <p className={cn(w9.msgError, 'mb-2', 'text-[0.75rem]', 'text-amber-500')} role="alert">
                  {sizeComputeError}
                </p>
              )}
              {sizeComputeLoading && <p className={w9.sectionHint}>Fetching bars and quote…</p>}

              {!sizeComputeLoading && sizeAtrResult && (
                <>
                  <section className="mb-4 rounded-[10px] border border-border bg-muted/30 p-3 mb-0 mt-3 bg-background/70 p-3" aria-labelledby="mb-2">
                    <h5 id="mb-2" className="mb-2 text-[0.88rem] font-semibold text-foreground">
                      Order sizing
                    </h5>
                    <p className="mb-2 text-[0.75rem] leading-snug text-muted-foreground" style={{ marginTop: 0 }}>
                      Auto sizing suggestion from ATR + Kelly. Portfolio <strong>Max drawdown %</strong> and <strong>static risk budget</strong> are set in <strong>Portfolio risk power</strong> (expand if collapsed); the ladder row <em>Portfolio max DD budget</em> uses the same percentage.
                    </p>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2 grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]">
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Intended shares</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {sizingOrderAnalytics.intendedShares > 0 ? sizingOrderAnalytics.intendedShares.toLocaleString() : '—'}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Intended risk %</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {sizingOrderAnalytics.intendedRiskPct != null ? `${sizingOrderAnalytics.intendedRiskPct.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Investment</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {sizingOrderAnalytics.investmentUsd != null ? fmtUsd(sizingOrderAnalytics.investmentUsd) : '—'}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Investment weight</span>
                        <span className="block text-[0.88rem] font-semibold tabular-nums text-foreground">
                          {sizingOrderAnalytics.investmentWeightPct != null
                            ? `${sizingOrderAnalytics.investmentWeightPct.toFixed(2)}% of NAV`
                            : '—'}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/85 bg-muted/40 px-3 py-2">
                        <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Cash left (after notional)</span>
                        <span
                          className={`block text-[0.88rem] font-semibold tabular-nums text-foreground${ sizingOrderAnalytics.cashLeftAfter != null && sizingOrderAnalytics.cashLeftAfter < 0 ? ' text-amber-500' : '' }`}
                        >
                          {sizingOrderAnalytics.cashLeftAfter != null ? fmtUsd(sizingOrderAnalytics.cashLeftAfter) : '—'}
                        </span>
                      </div>
                    </div>

                    <h6 className="mb-2 text-[0.88rem] font-semibold text-foreground mt-3 text-[0.82rem] font-semibold text-muted-foreground">Constraint ladder (max shares @ stop)</h6>
                    <div className="overflow-x-auto rounded-lg border border-border mt-2 min-w-0">
                      <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground text-xs [&_td]:py-1 [&_th]:py-1.5">
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
                          <tr className="bg-primary/5">
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
                    <p className="mt-2 text-[0.72rem] text-muted-foreground">
                      Buying power (aggregate): {fmtUsd(portfolioCashRollup.totalBuyingPower)}. History losses use GET /performance summary (same window as Kelly).
                    </p>
                  </section>

                  <h5 className="mb-2 text-[0.88rem] font-semibold text-foreground mt-3 text-[0.82rem] font-semibold text-muted-foreground">Kelly &amp; ATR summary</h5>
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
                <p className={w9.sectionHint} style={{ marginTop: 'var(--space-2)' }}>
                  Sizing unavailable: requires valid Kelly (win_rate &gt; 0 &amp; profit_factor &gt; 0), ATR &gt; 0, and capital &gt; 0.
                </p>
              )}
            </div>
            </div>
          )}
          </div>
          </div>

          <div className="mt-1 min-w-0 border-t border-border/90 pt-2 mt-0 border-t border-border/90 pt-3" aria-labelledby="mb-2">
            <h4 id="mb-2" className="mb-1 text-[0.95rem] font-semibold tracking-tight text-foreground">
              Sizing sheet
            </h4>

            <div className="mt-2 inline-flex">
              <div className="relative min-w-[10rem] max-w-[12rem]" ref={promoteComboboxRef}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                  id="relative min-w-0"
                  aria-label="pick new symbol — choose a watchlist row to move to Sizing"
                  aria-expanded={promotePickerOpen}
                  aria-controls="max-h-40 overflow-auto"
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
                    className={`truncate${promoteSelectedItem ? '' : ' text-muted-foreground'}`}
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
                  <span className="text-muted-foreground" aria-hidden>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
                {promotePickerOpen && (
                  <ul id="max-h-40 overflow-auto" role="listbox" className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-popover py-1 shadow-md" aria-labelledby="relative min-w-0">
                    <li className="list-none" role="presentation" onPointerDown={e => e.preventDefault()}>
                      <input
                        type="search"
                        className="w-full border-0 border-b border-border bg-transparent px-2 py-1.5 text-sm outline-none"
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
                        className={`cursor-pointer px-2 py-1 text-sm hover:bg-muted text-muted-foreground italic${promoteContractKey.trim() === '' ? ' bg-primary/15 text-foreground' : ''}`}
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
                      <li className="cursor-pointer px-2 py-1 text-sm hover:bg-muted text-muted-foreground italic" role="presentation">
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
                            className={`cursor-pointer px-2 py-1 text-sm hover:bg-muted${sel ? ' bg-primary/15 text-foreground' : ''}`}
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
                className="cursor-pointer rounded-md border border-transparent px-2.5 py-1 text-[0.85rem] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed border-primary bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex h-9 w-9 min-w-9 items-center justify-center p-0"
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
              <p className="mb-3 text-[0.8rem] leading-snug text-muted-foreground text-amber-500">The <strong>Sizing</strong> category is missing; you cannot promote rows yet.</p>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-[0.8rem] leading-snug text-muted-foreground">
            <strong>Step 3.</strong> Rows on this list that match your current IB portfolio snapshot. The same symbol can still appear in Watching or Sizing when you keep it there.
          </p>
          {positionSubTab === 'stocks' && (
            <div className="overflow-x-auto rounded-lg border border-border">
              {positionStockRows.length === 0 ? (
                <div className="py-4 text-center text-[0.82rem] text-muted-foreground">No held stocks from this list.</div>
              ) : (
                <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                  <thead>
                    <tr>
                      <th className="min-w-[6rem]">Symbol</th>
                      <th className="min-w-[7rem]">Last / B·A</th>
                      <th className="w-12 text-center" title="Show in Option Discovery">Opt</th>
                      <th className="w-28">Category</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>{renderStockRows(positionStockRows)}</tbody>
                </table>
              )}
            </div>
          )}
          {positionSubTab === 'options' && (
            <div className="overflow-x-auto rounded-lg border border-border">
              {positionOptRows.length === 0 ? (
                <div className="py-4 text-center text-[0.82rem] text-muted-foreground">No held options from this list.</div>
              ) : (
                <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                  <thead>
                    <tr>
                      <th className="min-w-[6rem]">Symbol</th>
                      <th className="min-w-[7rem]">Last / B·A</th>
                      <th className="w-24">Expiry</th>
                      <th className="w-10 text-center">R</th>
                      <th className="w-20 text-right">Strike</th>
                      <th className="w-28">Category</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>{renderOptionRows(positionOptRows)}</tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      <RightInspectorDrawer open={barStatsInspector != null} ariaLabel="Stock bar stats and chart">
        {barStatsInspector != null && (
          <StockBarStatsPanel
            symbol={barStatsInspector}
            onClose={() => setBarStatsInspector(null)}
            onBarStatsLoading={onBarStatsLoading}
          />
        )}
      </RightInspectorDrawer>

      {/* ── Add option modal ── */}
      {addOptionForSymbol != null && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mb-2 text-sm font-semibold"
          onClick={e => e.target === e.currentTarget && closeAddOptionModal()}
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h4 id="mb-2 text-sm font-semibold" className="mb-3 text-base font-semibold text-foreground">
              Add option · <strong>{addOptionForSymbol}</strong>
            </h4>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[0.72rem] font-semibold text-muted-foreground">Expiry</span>
                <input
                  type="text"
                  placeholder="yyyy-mm-dd"
                  value={addOptExpiry}
                  onChange={e => setAddOptExpiry(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.72rem] font-semibold text-muted-foreground">Right</span>
                <AppSelect
                  value={addOptRight}
                  onChange={v => setAddOptRight(v as 'CALL' | 'PUT')}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  options={[
                    { value: 'CALL', label: 'CALL' },
                    { value: 'PUT', label: 'PUT' },
                  ]}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.72rem] font-semibold text-muted-foreground">Strike</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 120"
                  value={addOptStrike}
                  onChange={e => setAddOptStrike(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="cursor-pointer rounded-md border border-transparent px-2.5 py-1 text-[0.85rem] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" onClick={closeAddOptionModal}>Cancel</button>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-transparent px-2.5 py-1 text-[0.85rem] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed border-primary bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                disabled={addPending || !addOptExpiry.trim() || !addOptStrike.trim()}
                onClick={() => submitAddOption()}
              >
                {addPending ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageSection>
  )
}
