import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bar, BarStatsResponse, IbAccountSnapshot, IbPositionRow, PerformanceSummary, PositionCategory, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
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
import { fmtUsd, fmtUsd0 } from '../utils/format'
import { computeAtr, computeKelly, computePositionSize } from '../api/research/risk'
import type { AtrResult, KellyMetrics, PositionSizeResult } from '../api/research/risk'
import { getNetLiq } from './accounts/accountsUtils'
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
  const promoteComboboxRef = useRef<HTMLDivElement>(null)
  const watchlistCategoryEnsureAttempted = useRef(false)

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

  const quoteByContractKey = useMemo(
    () => Object.fromEntries(
      realtimeQuotes
        .filter((q): q is RealtimeQuote & { contract_key: string } => Boolean(q.contract_key))
        .map(q => [q.contract_key, q]),
    ),
    [realtimeQuotes],
  )

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

  /** STK rows in Watching — eligible to move to Sizing (includes symbols you already hold). */
  const watchingOnlyForPromote = useMemo(
    () => allStocks.filter(s => matchesWatching(s)),
    [allStocks, matchesWatching],
  )

  const watchingTabCount = watchingStockRows.length + watchingOptionRows.length
  const sizingTabCount = sizingStockRows.length
  const positionsTabCount = positionStockRows.length + positionOptRows.length

  const handlePromoteToSizing = useCallback(async () => {
    const ck = promoteContractKey.trim()
    if (!ck || sizingCategoryId == null) return
    const item = watchingOnlyForPromote.find(i => i.contract_key.trim() === ck)
    if (!item) return
    await handleWatchlistCategoryChange(item, sizingCategoryId)
    setPromoteContractKey('')
    setPromotePickerOpen(false)
  }, [promoteContractKey, sizingCategoryId, watchingOnlyForPromote, handleWatchlistCategoryChange])

  const promoteSelectedItem = useMemo(
    () => watchingOnlyForPromote.find(i => i.contract_key.trim() === promoteContractKey.trim()),
    [watchingOnlyForPromote, promoteContractKey],
  )

  useEffect(() => {
    if (!promotePickerOpen) return
    function onPointerDown(ev: PointerEvent) {
      const root = promoteComboboxRef.current
      if (root && !root.contains(ev.target as Node)) setPromotePickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [promotePickerOpen])

  useEffect(() => {
    setPromotePickerOpen(false)
  }, [primaryTab])

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

  const renderStockRows = (items: WatchlistItem[], opts?: { showSizeBtn?: boolean }) =>
    items.map((item) => {
      const sym = symbolFromItem(item)
      const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[sym]
      const held = hasPosition(item)
      const optOn = item.optionable === true
      const isSelected = selectedSizingSymbol === sym
      return (
        <tr key={item.contract_key} className={!optOn ? 'wl2-row--dim' : undefined}>
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

  return (
    <div className="card process-section watchlist-page stock-screener-page wl2">
      {/* ── Header bar ── */}
      <header className="wl2-header">
        <div className="research-page-head">
          <h2 className="page-title-with-tooltip" style={{ margin: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem' }}>
            {onBreadcrumbResearch ? (
              <>
                <button
                  type="button"
                  className="page-title-breadcrumb-link"
                  onClick={onBreadcrumbResearch}
                  aria-label="Research home"
                >
                  Research
                </button>
                {' / Stock Screener'}
              </>
            ) : (
              <>Stock Screener</>
            )}
            <InfoTooltip text="Stock screener workflow: Watching (ideas) → Sizing (pre-trade sizing) → Positions (live IB holdings). Categories Watching / Sizing match Portfolio → Accounts. Quotes use IB / Redis. Bar-chart OHLC in the analysis panel is read from PostgreSQL (Massive or IB sources); use Fetch from Massive to enqueue Massive custom_bars sync." />
            <span className="wl2-header__count">{watchlistItems.length}</span>
          </h2>
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
            <strong>Step 2.</strong> The table lists stocks tagged <strong>Sizing</strong>. Promote only from Watching: pick a symbol, then <strong>Move to Sizing</strong>.
          </p>
          <div className="wl2-sizing-promote">
            <div className="wl2-promote-combobox" ref={promoteComboboxRef}>
              <button
                type="button"
                className="wl2-promote-combobox__trigger"
                id="wl2-promote-combobox-trigger"
                aria-label="Pick a Watching symbol to move to Sizing"
                aria-expanded={promotePickerOpen}
                aria-controls="wl2-promote-listbox"
                aria-haspopup="listbox"
                onClick={() => setPromotePickerOpen(o => !o)}
                onKeyDown={e => {
                  if (e.key === 'Escape' && promotePickerOpen) {
                    e.preventDefault()
                    setPromotePickerOpen(false)
                  }
                }}
              >
                <span
                  className={`wl2-promote-combobox__value${promoteSelectedItem ? '' : ' wl2-promote-combobox__value--placeholder'}`}
                  title={
                    promoteSelectedItem
                      ? watchlistItemLabel(promoteSelectedItem)
                      : 'Choose a Watching symbol…'
                  }
                >
                  {promoteSelectedItem
                    ? watchlistItemLabel(promoteSelectedItem)
                    : 'Choose a Watching symbol…'}
                </span>
                <span className="wl2-promote-combobox__chev" aria-hidden>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
              {promotePickerOpen && (
                <ul id="wl2-promote-listbox" role="listbox" className="wl2-promote-combobox__menu" aria-labelledby="wl2-promote-combobox-trigger">
                  <li
                    role="option"
                    aria-selected={promoteContractKey.trim() === ''}
                    className={`wl2-promote-combobox__opt wl2-promote-combobox__opt--placeholder${promoteContractKey.trim() === '' ? ' wl2-promote-combobox__opt--active' : ''}`}
                    onPointerDown={e => e.preventDefault()}
                    onClick={() => {
                      setPromoteContractKey('')
                      setPromotePickerOpen(false)
                    }}
                  >
                    Choose a Watching symbol…
                  </li>
                  {watchingOnlyForPromote.map(item => {
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
                          setPromotePickerOpen(false)
                        }}
                      >
                        {watchlistItemLabel(item)}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="wl2-btn wl2-btn--primary"
              disabled={!promoteContractKey.trim() || sizingCategoryId == null || addPending}
              onClick={() => void handlePromoteToSizing()}
            >
              Move to Sizing
            </button>
          </div>
          {sizingCategoryId == null && (
            <p className="wl2-tier-hint wl2-tier-hint--warn">The <strong>Sizing</strong> category is missing; you cannot promote rows yet.</p>
          )}
          <div className="wl2-table-wrap">
            {sizingStockRows.length === 0 ? (
              <div className="wl2-empty">No Sizing symbols yet. Promote from Watching above.</div>
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
                <tbody>{renderStockRows(sizingStockRows, { showSizeBtn: true })}</tbody>
              </table>
            )}
          </div>

          {/* ── Position Sizing Analysis Panel ── */}
          {selectedSizingSymbol && (
            <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-3)', border: '1px solid var(--color-border)', borderRadius: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0 }}>Position Sizing — {selectedSizingSymbol}</h4>
                <button
                  type="button"
                  className="wl2-act-icon wl2-act-icon--rm"
                  onClick={() => {
                    setSelectedSizingSymbol(null)
                    setSizeAtrResult(null)
                    setSizePosResult(null)
                    setSizeCurrentPrice(null)
                    setSizeComputeError(null)
                  }}
                  title="Close panel"
                  aria-label="Close sizing panel"
                >
                  ✕
                </button>
              </div>

              {/* Controls */}
              <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <label htmlFor="wl-kelly-fraction" style={{ whiteSpace: 'nowrap' }}>
                    Kelly fraction: <strong>{kellyFraction.toFixed(2)}</strong>
                  </label>
                  <input
                    id="wl-kelly-fraction"
                    type="range"
                    min={0.05}
                    max={1.0}
                    step={0.05}
                    value={kellyFraction}
                    onChange={e => setKellyFraction(parseFloat(e.target.value))}
                    style={{ width: '150px' }}
                  />
                  <input
                    type="number"
                    min={0.05}
                    max={1.0}
                    step={0.05}
                    value={kellyFraction}
                    onChange={e => setKellyFraction(Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 0.5)))}
                    style={{ width: '65px' }}
                    aria-label="Kelly fraction"
                  />
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
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
                <p className="msg-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
                  {sizeComputeError}
                </p>
              )}
              {sizeComputeLoading && <p className="section-hint">Fetching bars and quote…</p>}

              {!sizeComputeLoading && sizeAtrResult && (
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
                    <span className="risk-card-label">Capital</span>
                    <span className="risk-card-value">{capital > 0 ? fmtUsd0(capital) : '—'}</span>
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
              )}
              {!sizeComputeLoading && sizeAtrResult && sizePosResult && !sizePosResult.is_valid && (
                <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
                  Sizing unavailable: requires valid Kelly (win_rate &gt; 0 &amp; profit_factor &gt; 0), ATR &gt; 0, and capital &gt; 0.
                </p>
              )}
            </div>
          )}
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

      {/* ── Analysis panel ── */}
      {analysisResult && (
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
      )}

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
