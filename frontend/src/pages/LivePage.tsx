import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { OpenOrder, PositionCategory, RealtimeQuote, StatusResponse } from '../types'
import { fetchBarsBenchmark, fetchMarketStreamsSymbolOrder, fetchOpenOrders, fetchPositionCategories, fetchQuotes, fetchWatchlist, patchPositionCategory, postRefreshTickerSubscriptions, putMarketStreamsSymbolOrder, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtTs, fmtUsd, fmtUsdRound0 } from '../utils/format'
import { computeDailyChange, type DailyBenchmark } from './accounts/accountsUtils'

const SYMBOL_ORDER_STORAGE_KEY = 'market_streams_symbol_order'

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

export interface LivePageProps {
  status: StatusResponse | null
}

export function LivePage({ status }: LivePageProps) {
  const j = status
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  const [watchlistSymbolSet, setWatchlistSymbolSet] = useState<Set<string>>(new Set())
  const [, setFreshnessTick] = useState(0)
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  /** Custom category order (names). Empty = use default from API + data. */
  const [categoryOrder, setCategoryOrder] = useState<string[]>([])
  /** Symbol order per category (from DB; fallback localStorage). */
  const [symbolOrderByCategory, setSymbolOrderByCategory] = useState<Record<string, string[]>>(loadSymbolOrderFromStorage)
  const [categoryOrderSaving, setCategoryOrderSaving] = useState(false)
  const [streamSyncFeedback, setStreamSyncFeedback] = useState<string | null>(null)
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
        for (const w of res.items ?? []) {
          const sym = (w.symbol ?? '').trim()
          const st = (w.sec_type ?? '').toString().toUpperCase()
          if (sym && (st === 'STK' || !st)) set.add(sym.toUpperCase())
        }
        setWatchlistSymbolSet(set)
      })
      .catch(() => {
        if (!cancelled) setWatchlistSymbolSet(new Set())
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
    const list = j?.open_orders ?? []
    setOpenOrders(list)
  }, [j?.open_orders])
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

  const accountsList = j?.accounts ?? []
  // Primary/Secondary account IDs from Settings → Account → Event Account (stream_primary_account_id, stream_secondary_account_id).
  // No hardcoded account IDs: read from status.ib_config (backend reads from DB settings), then match against accountsList[].account_id.
  const ibConfig = j?.ib_config as { stream_primary_account_id?: string; stream_secondary_account_id?: string } | undefined
  const streamPrimaryId = (ibConfig?.stream_primary_account_id ?? '').trim() || null
  const streamSecondaryId = (ibConfig?.stream_secondary_account_id ?? '').trim() || null
  const hasStreamAccounts = streamPrimaryId != null || streamSecondaryId != null

  const streamPositionSymbols = useMemo(() => {
    const primary: string[] = []
    const secondary: string[] = []
    const norm = (id: string | null) => (id ?? '').trim().toLowerCase() || ''
    const wantPrimary = norm(streamPrimaryId)
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
        if (wantPrimary && accIdNorm === wantPrimary && !primary.includes(sym)) primary.push(sym)
        if (wantSecondary && accIdNorm === wantSecondary && !secondary.includes(sym)) secondary.push(sym)
      }
    }
    return { primary, secondary }
  }, [accountsList, streamPrimaryId, streamSecondaryId])

  // Market Streams symbol list: show symbol if it appears in ANY of Wishlist, Primary, or Secondary.
  const watchlistSymbols = useMemo(
    () =>
      [
        ...new Set([
          ...(j?.subscribed_tickers ?? []),
          ...streamPositionSymbols.primary,
          ...streamPositionSymbols.secondary,
          ...Object.keys(quotesMap),
        ]),
      ].sort(),
    [j?.subscribed_tickers, streamPositionSymbols.primary, streamPositionSymbols.secondary, quotesMap],
  )
  const benchmarkSymbols = useMemo(
    () =>
      [...new Set([...watchlistSymbols, ...(j?.reference_indices?.map((r: { symbol: string }) => r.symbol) ?? [])])].sort(),
    [watchlistSymbols, j?.reference_indices],
  )

  useEffect(() => {
    if (benchmarkSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((r) => {
        if (!cancelled) setBenchmarks(r.benchmarks ?? {})
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkSymbols.join(',')])

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap((prev) => {
            const next = { ...prev }
            res.quotes!.forEach((q) => {
              next[q.symbol] = q
            })
            return next
          })
        }
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      setQuotesMap((prev) => ({ ...prev, [q.symbol]: q }))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const hb = j?.daemon_heartbeat
  const marketStreamsOk =
    j?.redis_quotes_connected === true && hb?.daemon_alive === true && hb?.event_subscribe_ticker === true

  const subscribedSet = useMemo(
    () =>
      new Set(
        (j?.subscribed_tickers ?? [])
          .map((s: string) => (s && typeof s === 'string' ? s.trim().toUpperCase() : ''))
          .filter(Boolean)
      ),
    [j?.subscribed_tickers]
  )
  const norm = (id: string | null) => (id ?? '').trim().toLowerCase() || ''
  const wantPrimary = norm(streamPrimaryId)
  const wantSecondary = norm(streamSecondaryId)
  const wishlistSet = watchlistSymbolSet.size > 0 ? watchlistSymbolSet : subscribedSet
  const watchlistRows = watchlistSymbols.map((symbol) => {
    let qty = 0
    let totalCost = 0
    let hasCost = false
    let primaryQty = 0
    let primaryTotalCost = 0
    let primaryHasCost = false
    let secondaryQty = 0
    let secondaryTotalCost = 0
    let secondaryHasCost = false
    let positionCategory = 'Uncategorized'
    const accountIdsWithSymbol: string[] = []
    for (const acc of accountsList) {
      const accId = (acc?.account_id ?? (acc as { account?: string }).account ?? '').toString().trim()
      const accIdNorm = norm(accId)
      const isAccPrimary = wantPrimary && accIdNorm === wantPrimary
      const isAccSecondary = wantSecondary && accIdNorm === wantSecondary
      const positions = acc?.positions ?? []
      for (const p of positions) {
        const sym = (p.symbol ?? '').trim()
        const secType = (p.secType ?? '').toString().toUpperCase()
        const posQty = typeof p.position === 'number' ? p.position : 0
        if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
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
        if (isAccPrimary) {
          primaryQty += posQty
          if (avg != null) {
            primaryTotalCost += avg * posQty
            primaryHasCost = true
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
    let streamCategory: 'primary' | 'secondary' | 'both' | null = null
    if (hasStreamAccounts && accountIdsWithSymbol.length > 0) {
      const isPrimary = wantPrimary ? accountIdsWithSymbol.some((id) => norm(id) === wantPrimary) : false
      const isSecondary = wantSecondary ? accountIdsWithSymbol.some((id) => norm(id) === wantSecondary) : false
      if (isPrimary && isSecondary) streamCategory = 'both'
      else if (isPrimary) streamCategory = 'primary'
      else if (isSecondary) streamCategory = 'secondary'
    }
    const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
    const primaryAvgCost = primaryHasCost && primaryQty !== 0 ? primaryTotalCost / primaryQty : null
    const secondaryAvgCost = secondaryHasCost && secondaryQty !== 0 ? secondaryTotalCost / secondaryQty : null
    const quote = quotesMap[symbol]
    const bench = benchmarks[symbol]
    const { changePct, pnlVsBench } = computeDailyChange(
      bench,
      quote?.last ?? null,
      qty ?? 0,
    )
    const pnlCost =
      quote && avgCost != null && Number.isFinite(quote.last) && qty != null && Number.isFinite(qty) && qty !== 0
        ? (quote.last - avgCost) * qty
        : null
    const primaryPnlCost =
      quote && primaryAvgCost != null && Number.isFinite(quote.last) && primaryQty !== 0
        ? (quote.last - primaryAvgCost) * primaryQty
        : null
    const secondaryPnlCost =
      quote && secondaryAvgCost != null && Number.isFinite(quote.last) && secondaryQty !== 0
        ? (quote.last - secondaryAvgCost) * secondaryQty
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
      primaryQty: primaryQty || null,
      primaryAvgCost,
      primaryPnlCost,
      secondaryQty: secondaryQty || null,
      secondaryAvgCost,
      secondaryPnlCost,
    }
  })

  const [streamCategoryFilter, setStreamCategoryFilter] = useState<'all' | 'primary' | 'secondary' | 'wishlist'>('all')
  const [positionCategoryFilter, setPositionCategoryFilter] = useState<string>('all')
  const filteredByAccount = useMemo(() => {
    if (!hasStreamAccounts) return watchlistRows
    if (streamCategoryFilter === 'all') return watchlistRows
    if (streamCategoryFilter === 'wishlist') return watchlistRows.filter((row) => row.isInWatchlist === true)
    if (streamCategoryFilter === 'primary')
      return watchlistRows.filter((row) => row.streamCategory === 'primary' || row.streamCategory === 'both')
    if (streamCategoryFilter === 'secondary')
      return watchlistRows.filter((row) => row.streamCategory === 'secondary' || row.streamCategory === 'both')
    return watchlistRows.filter((row) => row.streamCategory === streamCategoryFilter)
  }, [watchlistRows, hasStreamAccounts, streamCategoryFilter])
  const filteredRows = useMemo(() => {
    if (positionCategoryFilter === 'all') return filteredByAccount
    return filteredByAccount.filter((row) => row.category === positionCategoryFilter)
  }, [filteredByAccount, positionCategoryFilter])

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

  return (
    <div className="app-page-stack">
      <div className="card card-operations realtime-quotes-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${marketStreamsOk ? 'green' : 'red'}`} title="Market streams: green when daemon alive, subscribed to ticker, and monitor reads Redis" aria-hidden />
          </div>
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              Market Streams
              <InfoTooltip
                text={
                  marketStreamsOk
                    ? `Ticker data from daemon subscription, pushed via Redis. Symbols: Watchlist ∪ Primary & Secondary account positions (Settings → Account). Daemon alive, Event subscription active. ${watchlistSymbols.length} symbol(s); prices & PnL update when stream arrives.`
                    : 'Ticker data from daemon subscription, pushed via Redis. Symbols: Watchlist ∪ Primary & Secondary account positions. Requires daemon running (green), Redis, and daemon Event subscription. If daemon is red, streams are offline.'
                }
              />
            </h2>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-small btn-size-default"
              onClick={async () => {
                setStreamSyncFeedback('Syncing…')
                try {
                  const res = await postRefreshTickerSubscriptions()
                  setStreamSyncFeedback(res.ok ? 'Sync requested' : res.error || 'Failed')
                } catch {
                  setStreamSyncFeedback('Failed')
                }
                setTimeout(() => setStreamSyncFeedback(null), 4000)
              }}
              title="Sync Event subscription with current Wishlist and Position symbols: unsubscribe symbols no longer in either."
            >
              Refresh
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
                {(['all', 'primary', 'secondary', 'wishlist'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`replay-filter-pill ${streamCategoryFilter === value ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter(value)}
                    aria-pressed={streamCategoryFilter === value}
                  >
                    {value === 'all' ? 'All' : value === 'primary' ? 'Primary' : value === 'secondary' ? 'Secondary' : 'Wishlist'}
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
              <col style={{ width: '4.75rem' }} />
              <col style={{ width: '5.5rem' }} />
              <col style={{ width: '4.75rem' }} />
              <col style={{ width: '6rem' }} />
              <col style={{ width: '8rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Symbol</th>
                {hasStreamAccounts && (
                  <>
                    <th colSpan={3} scope="colgroup" className="realtime-quote-colgroup">
                      Primary
                    </th>
                    <th colSpan={3} scope="colgroup" className="realtime-quote-colgroup">
                      Secondary
                    </th>
                  </>
                )}
                <th>Qty</th>
                <th>Cost</th>
                <th>Daily %</th>
                <th>Daily $</th>
                <th>SINCE %</th>
                <th>SINCE $</th>
                <th title="Last price; Bid and Ask shown as spread vs Last (green if above Last, red if below)">Last (Bid / Ask)</th>
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
                  <th aria-hidden colSpan={7} />
                </tr>
              )}
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={hasStreamAccounts ? 14 : 8}>
                    {watchlistRows.length === 0
                      ? 'No symbols (add symbols in Watchlist, or ensure Event Account (Primary/Secondary) have positions, or daemon is running)'
                      : 'No rows match the selected filters.'}
                  </td>
                </tr>
              ) : (
                categoryOrderFiltered.map((cat) => (
                  <Fragment key={cat}>
                    <tr className="ib-stock-group-header">
                      <td colSpan={hasStreamAccounts ? 14 : 8}>{cat}</td>
                    </tr>
                    {(sortedRowsByCategory[cat] ?? rowsByCategory[cat]).map((row) => {
                      const {
                        symbol,
                        quote: q,
                        qty,
                        avgCost,
                        changePct,
                        pnlVsBench,
                        pnlCost,
                        primaryQty,
                        primaryAvgCost,
                        primaryPnlCost,
                        secondaryQty,
                        secondaryAvgCost,
                        secondaryPnlCost,
                      } = row
                      const symbolFreshness = getQuoteFreshness(q?.ts)
                      return (
                        <tr
                          key={row.symbol}
                          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                          onDrop={(e) => {
                            e.preventDefault()
                            try {
                              const raw = e.dataTransfer.getData('application/x-market-streams-symbol')
                              if (!raw) return
                              const { category: fromCat, symbol: fromSymbol } = JSON.parse(raw) as { category: string; symbol: string }
                              if (fromCat === cat && fromSymbol !== row.symbol) applySymbolReorder(cat, fromSymbol, row.symbol)
                            } catch {
                              /* ignore */
                            }
                          }}
                        >
                      <td
                        className={symbolFreshness ? `realtime-quote-symbol realtime-quote-symbol-${symbolFreshness}` : 'realtime-quote-symbol'}
                        title={[
                          q?.ts != null ? `Last update ${symbolFreshness === 'fresh' ? '<3s ago' : symbolFreshness === 'stale' ? '3–10s ago' : '>10s ago'}` : null,
                          getDailyRefTooltip(benchmarks[symbol], q?.last),
                        ]
                          .filter(Boolean)
                          .join('\n') || undefined}
                      >
                        <span
                          className="realtime-quote-drag-handle"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/x-market-streams-symbol', JSON.stringify({ category: cat, symbol: row.symbol }))
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          title="Drag to reorder symbol"
                          aria-hidden
                        >
                          ⋮⋮
                        </span>
                        <strong>{symbol}</strong>
                      </td>
                      {hasStreamAccounts && (
                        <>
                          <td className="realtime-quote-num">{primaryQty != null && Number.isFinite(primaryQty) ? primaryQty : '—'}</td>
                          <td className="realtime-quote-num">{primaryAvgCost != null && Number.isFinite(primaryAvgCost) ? fmtUsd(primaryAvgCost) : '—'}</td>
                          <td className="realtime-quote-num">
                            {primaryPnlCost != null && Number.isFinite(primaryPnlCost) ? (
                              <span className={primaryPnlCost > 0 ? 'pnl-positive' : primaryPnlCost < 0 ? 'pnl-negative' : ''}>
                                {fmtUsdRound0(primaryPnlCost)}
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
                      <td className="realtime-quote-num">
                        {changePct != null && Number.isFinite(changePct) ? (
                          <span className={changePct > 0 ? 'pnl-positive' : changePct < 0 ? 'pnl-negative' : ''}>
                            {Math.abs(changePct).toFixed(2)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num">
                        {pnlVsBench != null && Number.isFinite(pnlVsBench) ? (
                          <span className={pnlVsBench > 0 ? 'pnl-positive' : pnlVsBench < 0 ? 'pnl-negative' : ''}>
                            {fmtUsd(Math.abs(pnlVsBench))}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num">
                        {(() => {
                          if (avgCost == null || !Number.isFinite(avgCost) || avgCost <= 0 || !q?.last || !Number.isFinite(q.last)) return '—'
                          const sincePct = ((q.last - avgCost) / avgCost) * 100
                          return (
                            <span className={sincePct > 0 ? 'pnl-positive' : sincePct < 0 ? 'pnl-negative' : ''}>
                              {Math.abs(sincePct).toFixed(2)}%
                            </span>
                          )
                        })()}
                      </td>
                      <td className="realtime-quote-num">
                        {pnlCost != null && Number.isFinite(pnlCost) ? (
                          <span className={pnlCost > 0 ? 'pnl-positive' : pnlCost < 0 ? 'pnl-negative' : ''}>
                            {fmtUsdRound0(pnlCost)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num realtime-quote-last-bid-ask">
                        {q ? (() => {
                          const last = q.last != null && Number.isFinite(q.last) ? q.last : null
                          const bid = q.bid != null && Number.isFinite(q.bid) ? q.bid : null
                          const ask = q.ask != null && Number.isFinite(q.ask) ? q.ask : null
                          const bidDiff = last != null && bid != null ? bid - last : null
                          const askDiff = last != null && ask != null ? ask - last : null
                          return (
                            <>
                              {last != null ? fmtUsd(last) : '—'}
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
                    </tr>
                      )
                    })}
                  </Fragment>
                ))
              )}
              {filteredRows.length > 0 && (() => {
                const primaryCostSum = filteredRows.reduce((a, r) => {
                  const q = r.primaryQty != null && Number.isFinite(r.primaryQty) ? r.primaryQty : 0
                  const c = r.primaryAvgCost != null && Number.isFinite(r.primaryAvgCost) ? r.primaryAvgCost : 0
                  return a + q * c
                }, 0)
                const primaryPnlSum = filteredRows.reduce((a, r) => a + (r.primaryPnlCost != null && Number.isFinite(r.primaryPnlCost) ? r.primaryPnlCost : 0), 0)
                const secondaryCostSum = filteredRows.reduce((a, r) => {
                  const q = r.secondaryQty != null && Number.isFinite(r.secondaryQty) ? r.secondaryQty : 0
                  const c = r.secondaryAvgCost != null && Number.isFinite(r.secondaryAvgCost) ? r.secondaryAvgCost : 0
                  return a + q * c
                }, 0)
                const secondaryPnlSum = filteredRows.reduce((a, r) => a + (r.secondaryPnlCost != null && Number.isFinite(r.secondaryPnlCost) ? r.secondaryPnlCost : 0), 0)
                const totalQty = filteredRows.reduce((a, r) => a + (r.qty != null && Number.isFinite(r.qty) ? r.qty : 0), 0)
                const totalCost = filteredRows.reduce((a, r) => {
                  const q = r.qty != null && Number.isFinite(r.qty) ? r.qty : 0
                  const c = r.avgCost != null && Number.isFinite(r.avgCost) ? r.avgCost : 0
                  return a + q * c
                }, 0)
                const totalCostPnl = filteredRows.reduce((a, r) => a + (r.pnlCost != null && Number.isFinite(r.pnlCost) ? r.pnlCost : 0), 0)
                const totalDailyDollar = filteredRows.reduce((a, r) => a + (r.pnlVsBench != null && Number.isFinite(r.pnlVsBench) ? r.pnlVsBench : 0), 0)
                const sumLastQty = filteredRows.reduce((a, r) => {
                  const q = r.qty != null && Number.isFinite(r.qty) ? r.qty : 0
                  const last = r.quote?.last != null && Number.isFinite(r.quote.last) ? r.quote.last : 0
                  return a + last * q
                }, 0)
                const totalDailyDenom = sumLastQty - totalDailyDollar
                const totalDailyPct = totalDailyDenom > 0 && Number.isFinite(totalDailyDollar) ? (totalDailyDollar / totalDailyDenom) * 100 : null
                const totalPct = totalCost > 0 && Number.isFinite(totalCostPnl) ? (totalCostPnl / totalCost) * 100 : null
                return (
                  <tr className="realtime-quotes-sum-row">
                    <td><strong>Total</strong></td>
                    {hasStreamAccounts && (
                      <>
                        <td className="realtime-quote-num">—</td>
                        <td className="realtime-quote-num">{primaryCostSum !== 0 ? fmtUsd(primaryCostSum) : '—'}</td>
                        <td className="realtime-quote-num">
                          <span className={primaryPnlSum > 0 ? 'pnl-positive' : primaryPnlSum < 0 ? 'pnl-negative' : ''}>
                            {primaryPnlSum !== 0 ? fmtUsdRound0(primaryPnlSum) : '—'}
                          </span>
                        </td>
                        <td className="realtime-quote-num">—</td>
                        <td className="realtime-quote-num">{secondaryCostSum !== 0 ? fmtUsd(secondaryCostSum) : '—'}</td>
                        <td className="realtime-quote-num">
                          <span className={secondaryPnlSum > 0 ? 'pnl-positive' : secondaryPnlSum < 0 ? 'pnl-negative' : ''}>
                            {secondaryPnlSum !== 0 ? fmtUsdRound0(secondaryPnlSum) : '—'}
                          </span>
                        </td>
                      </>
                    )}
                    <td className="realtime-quote-num">{totalQty !== 0 ? totalQty : '—'}</td>
                    <td className="realtime-quote-num">{totalCost !== 0 ? fmtUsd(totalCost) : '—'}</td>
                    <td className="realtime-quote-num">
                      {totalDailyPct != null && Number.isFinite(totalDailyPct) ? (
                        <span className={totalDailyPct > 0 ? 'pnl-positive' : totalDailyPct < 0 ? 'pnl-negative' : ''}>
                          {Math.abs(totalDailyPct).toFixed(2)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="realtime-quote-num">
                      <span className={totalDailyDollar > 0 ? 'pnl-positive' : totalDailyDollar < 0 ? 'pnl-negative' : ''}>
                        {totalDailyDollar !== 0 ? fmtUsdRound0(totalDailyDollar) : '—'}
                      </span>
                    </td>
                    <td className="realtime-quote-num">
                      {totalPct != null && Number.isFinite(totalPct) ? (
                        <span className={totalPct > 0 ? 'pnl-positive' : totalPct < 0 ? 'pnl-negative' : ''}>
                          {Math.abs(totalPct).toFixed(2)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="realtime-quote-num">
                      <span className={totalCostPnl > 0 ? 'pnl-positive' : totalCostPnl < 0 ? 'pnl-negative' : ''}>
                        {totalCostPnl !== 0 ? fmtUsdRound0(totalCostPnl) : '—'}
                      </span>
                    </td>
                    <td className="realtime-quote-num">—</td>
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
            const totalDailyDollar = filteredRows.reduce((acc, row) => {
              const v = row.pnlVsBench
              return acc + (v != null && Number.isFinite(v) ? v : 0)
            }, 0)
            const sumLastQty = filteredRows.reduce((acc, row) => {
              const qty = row.qty != null && Number.isFinite(row.qty) ? row.qty : 0
              const last = row.quote?.last != null && Number.isFinite(row.quote.last) ? row.quote.last : 0
              return acc + last * qty
            }, 0)
            const totalDailyDenom = sumLastQty - totalDailyDollar
            const totalDailyPct =
              totalDailyDenom > 0 && Number.isFinite(totalDailyDollar)
                ? (totalDailyDollar / totalDailyDenom) * 100
                : null
            return (
              <p className="replay-sync-hint watchlist-summary-row" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                <span className="watchlist-summary-segment">
                  Total $:{' '}
                  <span
                    className="watchlist-summary-value"
                    style={{ color: totalCostPnl >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}
                  >
                    {fmtUsdRound0(totalCostPnl)}
                  </span>
                </span>
                {totalPct != null && Number.isFinite(totalPct) && (
                  <span className="watchlist-summary-segment">
                    Total %:{' '}
                    <span
                      className="watchlist-summary-value watchlist-summary-value-pct"
                      style={{ color: totalPct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}
                    >
                      {totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}%
                    </span>
                  </span>
                )}
                {(Number.isFinite(totalDailyDollar) || (totalDailyPct != null && Number.isFinite(totalDailyPct))) && (
                  <>
                    <span className="watchlist-summary-segment">
                      Daily $:{' '}
                      <span
                        className="watchlist-summary-value"
                        style={{
                          color: totalDailyDollar >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                        }}
                      >
                        {fmtUsdRound0(totalDailyDollar)}
                      </span>
                    </span>
                    {totalDailyPct != null && Number.isFinite(totalDailyPct) && (
                      <span className="watchlist-summary-segment">
                        Daily %:{' '}
                        <span
                          className="watchlist-summary-value watchlist-summary-value-pct"
                          style={{
                            color:
                              totalDailyPct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                          }}
                        >
                          {totalDailyPct >= 0 ? '+' : ''}{totalDailyPct.toFixed(2)}%
                        </span>
                      </span>
                    )}
                  </>
                )}
              </p>
            )
          })()}
      </div>

      <div className="card card-operations open-orders-live-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <div className="lamp-wrap-span">
            <div
              className={`lamp lamp-sm ${(j?.daemon_heartbeat?.daemon_alive && j?.daemon_heartbeat?.ib_connected) ? 'green' : 'red'}`}
              title="Open orders: green when daemon is connected to IB (event-driven write to DB); data polled from DB."
              aria-hidden
            />
          </div>
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              Open Orders
              <InfoTooltip text="Unfilled orders from daemon (event-driven). Daemon writes to DB on orderStatus/openOrder events; this page polls GET /open-orders and also receives open_orders via GET /status. Updates every few seconds." />
            </h2>
          </div>
          {openOrdersUpdatedAt != null && (
            <span className="section-hint" style={{ marginLeft: 'auto' }}>Last updated: {fmtTs(openOrdersUpdatedAt)}</span>
          )}
        </div>
        <div className="open-orders-table-wrap">
          {openOrders.length === 0 ? (
            <p className="section-hint">No open orders</p>
          ) : (
            <table className="open-orders-table table-operations" role="grid" aria-label="Open orders">
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col">Side</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Limit</th>
                  <th scope="col">Status</th>
                  <th scope="col">Filled / Remaining</th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((o, i) => (
                  <tr key={o.order_id ?? o.perm_id ?? i}>
                    <td>{o.symbol ?? '—'}</td>
                    <td>{o.action ?? '—'}</td>
                    <td>{o.total_quantity != null ? Number(o.total_quantity) : '—'}</td>
                    <td>{o.limit_price != null ? fmtUsd(Number(o.limit_price)) : '—'}</td>
                    <td>{o.status ?? '—'}</td>
                    <td>{o.filled != null && o.remaining != null ? `${o.filled} / ${o.remaining}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
