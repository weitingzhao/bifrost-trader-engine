import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { OpenOrder, PositionCategory, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
import { fetchBarsBenchmark, fetchMarketStreamsSymbolOrder, fetchOpenOrders, fetchPositionCategories, fetchQuotes, fetchWatchlist, patchPositionCategory, postReleaseTickerSubscriptions, putMarketStreamsSymbolOrder, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtSince, fmtTs, fmtUsd, fmtUsdRound0, parseOptionContractKey } from '../utils/format'
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
}

export function LivePage({ status, onNavigateToStrategy }: LivePageProps) {
  const j = status
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [quotesByContractKey, setQuotesByContractKey] = useState<Record<string, RealtimeQuote>>({})
  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  const [watchlistSymbolSet, setWatchlistSymbolSet] = useState<Set<string>>(new Set())
  const [watchlistOptionItems, setWatchlistOptionItems] = useState<WatchlistItem[]>([])
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
  // Host/Secondary account IDs from Settings → Account → Event Account (stream_host_account_id, stream_secondary_account_id).
  // No hardcoded account IDs: read from status.ib_config (backend reads from DB settings), then match against accountsList[].account_id.
  const ibConfig = j?.ib_config as { stream_host_account_id?: string; stream_secondary_account_id?: string } | undefined
  const streamHostId = (ibConfig?.stream_host_account_id ?? '').trim() || null
  const streamSecondaryId = (ibConfig?.stream_secondary_account_id ?? '').trim() || null
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
          ...(j?.subscribed_tickers ?? []),
          ...streamPositionSymbols.host,
          ...streamPositionSymbols.secondary,
          ...Object.keys(quotesMap),
        ]),
      ].sort(),
    [j?.subscribed_tickers, streamPositionSymbols.host, streamPositionSymbols.secondary, quotesMap],
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

  const mergeQuotes = useCallback((quotes: RealtimeQuote[]) => {
    const nextMap: Record<string, RealtimeQuote> = {}
    const nextByCk: Record<string, RealtimeQuote> = {}
    for (const q of quotes) {
      if (q.contract_key) {
        nextByCk[q.contract_key] = q
      } else if (q.symbol) {
        nextMap[q.symbol] = q
      }
    }
    setQuotesMap((prev) => ({ ...prev, ...nextMap }))
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
      setQuotesMap((prev) => ({ ...prev, [q.symbol]: q }))
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
  const wantHost = norm(streamHostId)
  const wantSecondary = norm(streamSecondaryId)
  const wishlistSet = watchlistSymbolSet.size > 0 ? watchlistSymbolSet : subscribedSet
  const watchlistRows = watchlistSymbols.map((symbol) => {
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
    const quote = quotesMap[symbol]
    const bench = benchmarks[symbol]
    const { changePct, pnlVsBench } = computeDailyChange(
      bench,
      quote?.last ?? null,
      qty ?? 0,
    )
    const lastVal = quote?.last != null && Number.isFinite(quote.last) ? quote.last : null
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
      <div className="card card-operations strategy-active-live-card strategy-section">
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
            <strong>Structure:</strong> {j?.active_strategy_structure_name ?? '—'}
            {j?.active_strategy_structure_id != null && ` (${j.active_strategy_structure_id})`}
          </div>
          <div>
            <strong>Gate safety:</strong> {j?.active_gate_safety_strategy_name ?? '—'}
            {j?.active_gate_safety_strategy_id != null && ` (${j.active_gate_safety_strategy_id})`}
          </div>
          <div>
            <strong>Allocation:</strong> {j?.active_strategy_allocation_name ?? '—'}
            {j?.active_strategy_allocation_id != null && ` (${j.active_strategy_allocation_id})`}
          </div>
        </div>
        <p className="section-hint">Daemon uses these on next start.</p>
      </div>

      <div className="card card-operations realtime-quotes-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <h2 className="daemon-card-title page-title-with-tooltip">
            <span
              className={`title-inline-lamp lamp-icon ${marketStreamsOk ? 'green' : 'red'}`}
              title="Market streams: green when daemon alive, subscribed to ticker, and monitor reads Redis"
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
                  ? `Ticker data from daemon subscription, pushed via Redis. Symbols: Watchlist ∪ Host & Secondary account positions (Settings → Account). Daemon alive, Event subscription active. ${watchlistSymbols.length} symbol(s); prices & PnL update when stream arrives.`
                  : 'Ticker data from daemon subscription, pushed via Redis. Symbols: Watchlist ∪ Host & Secondary account positions. Requires daemon running (green), Redis, and daemon Event subscription. If daemon is red, streams are offline.'
              }
            />
          </h2>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              className="section-header-icon-btn"
              onClick={async () => {
                setStreamSyncFeedback('Releasing…')
                try {
                  const res = await postReleaseTickerSubscriptions()
                  setStreamSyncFeedback(res.ok ? 'Released; daemon will restore on next heartbeat' : res.error || 'Failed')
                } catch {
                  setStreamSyncFeedback('Failed')
                }
                setTimeout(() => setStreamSyncFeedback(null), 4000)
              }}
              title="Release all Real-time ticker subscriptions (same as Status → Event Subscribe → Release). Daemon will restore subscriptions on next heartbeat."
              aria-label="Refresh / Release ticker subscriptions"
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
              <col style={{ width: '4.25rem' }} />
              <col style={{ width: '5.25rem' }} />
              <col style={{ width: '4.25rem' }} />
              <col style={{ width: '5.5rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Symbol</th>
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
                <th>Daily %</th>
                <th>Daily $</th>
                <th>SINCE %</th>
                <th>SINCE $</th>
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
                      ? 'No symbols (add symbols in Watchlist, or ensure Event Account (Host/Secondary) have positions, or daemon is running)'
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
                        hostQty,
                        hostAvgCost,
                        hostPnlCost,
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
                          const last = q.last != null && Number.isFinite(q.last) ? q.last : null
                          const bid = q.bid != null && Number.isFinite(q.bid) ? q.bid : null
                          const ask = q.ask != null && Number.isFinite(q.ask) ? q.ask : null
                          const bidDiff = last != null && bid != null ? bid - last : null
                          const askDiff = last != null && ask != null ? ask - last : null
                          const bench = benchmarks[symbol]
                          const prevClose = bench && (bench.prev_close != null && Number.isFinite(bench.prev_close))
                            ? bench.prev_close
                            : (bench && Number.isFinite(bench.close) ? bench.close : null)
                          const lastVsPrev = last != null && prevClose != null && prevClose > 0
                            ? (last > prevClose ? 'pnl-positive' : last < prevClose ? 'pnl-negative' : '')
                            : ''
                          return (
                            <>
                              {last != null ? (
                                <span className={lastVsPrev}>{fmtUsd(last)}</span>
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
                    </tr>
                      )
                    })}
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

      {watchlistOptionItems.length > 0 && (
        <div className="card card-operations watchlist-options-live-card" style={{ marginTop: 'var(--space-3)' }}>
          <h2 className="daemon-card-title" style={{ marginBottom: '0.5rem' }}>
            Watchlist Options
            <InfoTooltip text="Option contracts from Watchlist; quotes from daemon (contract_quote_live). Updates every few seconds." />
          </h2>
          <div className="realtime-quotes-table-wrap">
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
          </div>
        </div>
      )}

      <div className="card card-operations open-orders-live-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <h2 className="daemon-card-title page-title-with-tooltip">
            <span
              className={`title-inline-lamp lamp-icon ${(j?.daemon_heartbeat?.daemon_alive && j?.daemon_heartbeat?.ib_connected) ? 'green' : 'red'}`}
              title="Open orders: green when daemon is connected to IB (event-driven write to DB); data polled from DB."
              aria-hidden
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
              </svg>
            </span>
            Open Orders
            <InfoTooltip text="Unfilled orders from daemon (event-driven). Daemon writes to DB on orderStatus/openOrder events; this page polls GET /open-orders and also receives open_orders via GET /status. Data source: PostgreSQL table daemon_open_orders. Account ID is the IB account that placed each order. Updates every few seconds." />
          </h2>
          {openOrdersUpdatedAt != null && (
            <span className="section-hint" style={{ marginLeft: 'auto' }}>Last updated: {fmtTs(openOrdersUpdatedAt)}</span>
          )}
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
    </div>
  )
}
