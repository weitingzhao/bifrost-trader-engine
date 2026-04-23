import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IbAccountSnapshot, IbPositionRow, PositionCategory, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
import type { BarStatsResponse } from '../types'
import { fetchWatchlist, fetchBarStats, fetchQuotes, postBarsFetch, postWatchlist, deleteWatchlist, fetchPositionCategories, postPositionCategory } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtUsd } from '../utils/format'

interface WatchlistPageProps {
  status: StatusResponse | null
  /** “Research” breadcrumb → Risk Model (same as other Research pages). */
  onBreadcrumbResearch?: () => void
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
  const [realtimeQuotes, setRealtimeQuotes] = useState<RealtimeQuote[]>([])
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  const [showPositionPicker, setShowPositionPicker] = useState(false)
  const [primaryTab, setPrimaryTab] = useState<'watching' | 'sizing' | 'positions'>('watching')
  const [positionSubTab, setPositionSubTab] = useState<'stocks' | 'options'>('stocks')
  const [promoteContractKey, setPromoteContractKey] = useState('')
  const [promotePickerOpen, setPromotePickerOpen] = useState(false)
  const promoteComboboxRef = useRef<HTMLDivElement>(null)
  const watchlistCategoryEnsureAttempted = useRef(false)

  const positions = useMemo(() => {
    return (status?.portfolio?.accounts || []).flatMap((acc: IbAccountSnapshot) => (acc.positions || []))
  }, [status?.portfolio?.accounts])

  const contractKeysWithPosition = useMemo(
    () => new Set(positions.map(p => positionToContractKey(p))),
    [positions],
  )

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

  /** Stocks: Watching + uncategorized, excluding sizing-only rows and anything with an open position (positions tab owns those). */
  const watchingStockRows = useMemo(() => {
    return allStocks.filter((s) => {
      if (hasPosition(s)) return false
      if (matchesSizing(s)) return false
      if (matchesWatching(s)) return true
      if (isUncategorizedStock(s)) return true
      return false
    })
  }, [allStocks, hasPosition, matchesSizing, matchesWatching])

  /** Stocks on other position-categories (not Watching/Sizing), no holding — shown under Watching for reassignment. */
  const otherCategoryStockRows = useMemo(() => {
    return allStocks.filter((s) => {
      if (hasPosition(s)) return false
      if (matchesWatching(s) || matchesSizing(s)) return false
      if (isUncategorizedStock(s)) return false
      return true
    })
  }, [allStocks, hasPosition, matchesSizing, matchesWatching])

  const sizingStockRows = useMemo(
    () => allStocks.filter(s => !hasPosition(s) && matchesSizing(s)),
    [allStocks, hasPosition, matchesSizing],
  )

  const positionStockRows = useMemo(() => allStocks.filter(hasPosition), [allStocks, hasPosition])
  const positionOptRows = useMemo(() => watchlistOptions.filter(hasPosition), [watchlistOptions, hasPosition])

  /** Option contracts on watchlist without a position — still editable under Watching. */
  const optionsNotHeldRows = useMemo(() => watchlistOptions.filter(o => !hasPosition(o)), [watchlistOptions, hasPosition])

  /** STK rows classified as Watching, no position — eligible to move to Sizing. */
  const watchingOnlyForPromote = useMemo(
    () => allStocks.filter(s => !hasPosition(s) && matchesWatching(s)),
    [allStocks, hasPosition, matchesWatching],
  )

  const watchingTabCount = watchingStockRows.length + optionsNotHeldRows.length
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

  async function handleFetchMarketData() {
    if (!analysisResult) return
    const sym = analysisResult.symbol
    const { stock_day: dayCount, stock_min: minCounts = {} } = analysisResult.stats
    setFetchMarketDataError(null)
    const steps: { period: string; label: string; duration: string; smart: boolean }[] = [
      { period: '1 D', label: 'Daily', duration: dayCount === 0 ? '1 Y' : '30 D', smart: dayCount > 0 },
      { period: '1 min', label: '1 min', duration: (minCounts['1 min'] ?? 0) === 0 ? '1 D' : '5 D', smart: (minCounts['1 min'] ?? 0) > 0 },
      { period: '5 mins', label: '5 min', duration: (minCounts['5 mins'] ?? 0) === 0 ? '1 D' : '5 D', smart: (minCounts['5 mins'] ?? 0) > 0 },
      { period: '1 hour', label: '1 hour', duration: (minCounts['1 hour'] ?? 0) === 0 ? '1 D' : '5 D', smart: (minCounts['1 hour'] ?? 0) > 0 },
    ]
    let lastError: string | null = null
    for (const { period, label, duration, smart } of steps) {
      setFetchMarketDataStep(`${label}${duration === '1 Y' ? ' (~1 year)' : ''}…`)
      try {
        const res = await postBarsFetch(sym, period, duration, smart)
        if (res.error) { lastError = res.error; setFetchMarketDataError(res.error); break }
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'Fetch failed'
        setFetchMarketDataError(lastError)
        break
      }
    }
    setFetchMarketDataStep(null)
    if (!lastError) {
      try {
        const stats = await fetchBarStats(sym)
        setAnalysisResult({ symbol: sym, stats })
      } catch { /* keep existing */ }
    }
  }

  const renderStockRows = (items: WatchlistItem[]) =>
    items.map((item) => {
      const sym = symbolFromItem(item)
      const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[sym]
      const held = hasPosition(item)
      const optOn = item.optionable === true
      return (
        <tr key={item.contract_key} className={!optOn ? 'wl2-row--dim' : undefined}>
          <td className="wl2-td--sym" title={item.contract_key}>
            <span className="wl2-sym">{watchlistItemLabel(item)}</span>
            {held && <span className="wl2-badge wl2-badge--hold" title="Holding">H</span>}
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
                onClick={() => handleAnalyze(item)}
                disabled={analysisLoadingSymbol !== null}
                title="Bar stats"
                aria-label={`Analyze ${sym}`}
              >
                {analysisLoadingSymbol === sym ? '⏳' : '📊'}
              </button>
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
      const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[symbolFromItem(item)]
      const held = hasPosition(item)
      return (
        <tr key={item.contract_key}>
          <td className="wl2-td--sym" title={item.contract_key}>
            <span className="wl2-sym">{item.symbol || watchlistItemLabel(item)}</span>
            {held && <span className="wl2-badge wl2-badge--hold" title="Holding">H</span>}
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
            <InfoTooltip text="Stock screener workflow: Watching (ideas) → Sizing (pre-trade sizing) → Positions (live IB holdings). Categories Watching / Sizing match Portfolio → Accounts. Quotes and ingest use IB / Redis." />
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
            className={`wl2-step${primaryTab === 'sizing' ? ' wl2-step--active' : ''}${primaryTab === 'positions' ? ' wl2-step--done' : ''}`}
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
            <strong>Step 1.</strong> Tickers you add in the header are stored with category <strong>Watching</strong> (same names as Portfolio → Accounts). Option legs on the list without an open IB position are in the second table below.
          </p>
          {watchingCategoryId == null && (
            <p className="wl2-tier-hint wl2-tier-hint--warn">
              The <strong>Watching</strong> category is missing or still being created. If this persists, add <strong>Watching</strong> and <strong>Sizing</strong> under Portfolio → Accounts.
            </p>
          )}
          {watchlistItems.length === 0 && watchingStockRows.length === 0 && optionsNotHeldRows.length === 0 ? (
            <div className="wl2-empty">No symbols yet. Type a ticker in the header to start in Watching.</div>
          ) : (
            <>
              <div className="wl2-table-wrap">
                {watchingStockRows.length === 0 && otherCategoryStockRows.length === 0 ? (
                  <div className="wl2-empty">No non-held stock rows in Watching / uncategorized.</div>
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
                            <span className="wl2-group-label">Other portfolio categories (no open position)</span>
                            <span className="wl2-group-count">{otherCategoryStockRows.length}</span>
                          </td>
                        </tr>
                        {renderStockRows(otherCategoryStockRows)}
                      </tbody>
                    )}
                  </table>
                )}
              </div>
              {optionsNotHeldRows.length > 0 && (
                <>
                  <p className="wl2-tier-hint" style={{ marginTop: 'var(--space-4)' }}>Options on the list (no matching open position)</p>
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
                      <tbody>{renderOptionRows(optionsNotHeldRows)}</tbody>
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
                <tbody>{renderStockRows(sizingStockRows)}</tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="wl2-tier-hint">
            <strong>Step 3.</strong> Rows matched to your current IB portfolio snapshot. Once held, names leave Watching / Sizing for this view.
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
              {fetchMarketDataStep || 'Fetch data'}
            </button>
            <button type="button" className="wl2-act-icon" onClick={() => setAnalysisResult(null)} title="Close">✕</button>
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
