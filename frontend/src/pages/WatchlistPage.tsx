import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IbAccountSnapshot, IbPositionRow, PositionCategory, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
import type { BarStatsResponse } from '../types'
import { fetchWatchlist, fetchBarStats, fetchQuotes, postBarsFetch, postWatchlist, deleteWatchlist, fetchPositionCategories } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtUsd } from '../utils/format'

interface WatchlistPageProps {
  status: StatusResponse | null
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

export function WatchlistPage({ status }: WatchlistPageProps) {
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
  const [activeSection, setActiveSection] = useState<'stocks' | 'options'>('stocks')

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
    async (contract_key: string, source: string, symbol?: string, sec_type?: string, expiry?: string, strike?: number, option_right?: string) => {
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

  const stockByCategory = useMemo(() => {
    const map: Record<string, WatchlistItem[]> = {}
    for (const item of allStocks) {
      const k = (item.category && String(item.category).trim()) || 'Uncategorized'
      if (!map[k]) map[k] = []
      map[k].push(item)
    }
    return map
  }, [allStocks])

  const optionByCategory = useMemo(() => {
    const map: Record<string, WatchlistItem[]> = {}
    for (const item of watchlistOptions) {
      const k = (item.category && String(item.category).trim()) || 'Uncategorized'
      if (!map[k]) map[k] = []
      map[k].push(item)
    }
    return map
  }, [watchlistOptions])

  const stockCategoryOrder = useMemo(() => {
    const arr = Object.keys(stockByCategory)
    arr.sort((a, b) => {
      if (a === 'Uncategorized') return -1
      if (b === 'Uncategorized') return 1
      return a.localeCompare(b)
    })
    return arr
  }, [stockByCategory])

  const optionCategoryOrder = useMemo(() => {
    const arr = Object.keys(optionByCategory)
    arr.sort((a, b) => {
      if (a === 'Uncategorized') return -1
      if (b === 'Uncategorized') return 1
      return a.localeCompare(b)
    })
    return arr
  }, [optionByCategory])

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

  const stockCount = allStocks.length
  const optionCount = watchlistOptions.length

  return (
    <div className="wl2">
      {/* ── Header bar ── */}
      <header className="wl2-header">
        <div className="wl2-header__left">
          <h2 className="wl2-header__title">Watchlist</h2>
          <InfoTooltip text="Symbols here are monitored for quotes, bars, and Market API focus lists. Live ticks come from IB Ingestor (Redis)." />
          <span className="wl2-header__count">{watchlistItems.length}</span>
        </div>
        <div className="wl2-header__add">
          <input
            type="text"
            className="wl2-header__input"
            placeholder="Add symbol…"
            value={addContractKey}
            onChange={e => setAddContractKey(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && addContractKey.trim()) {
                const { contract_key, symbol, sec_type } = normalizeToContractKey(addContractKey)
                if (contract_key) { handleAddWatchlist(contract_key, 'manual', symbol, sec_type); setAddContractKey('') }
              }
            }}
            aria-label="Enter Symbol to add stock"
          />
          <button
            type="button"
            className="wl2-btn wl2-btn--primary wl2-header__add-btn"
            disabled={addPending || !addContractKey.trim()}
            onClick={() => {
              const { contract_key, symbol, sec_type } = normalizeToContractKey(addContractKey)
              if (!contract_key) return
              handleAddWatchlist(contract_key, 'manual', symbol, sec_type)
              setAddContractKey('')
            }}
          >
            {addPending ? '…' : '+'}
          </button>
          {positionsNotInWatchlist.length > 0 && (
            <button
              type="button"
              className="wl2-btn wl2-btn--ghost wl2-header__pos-btn"
              onClick={() => setShowPositionPicker(v => !v)}
              title="Add from positions"
            >
              Pos ({positionsNotInWatchlist.length})
            </button>
          )}
        </div>
      </header>

      {watchlistError && (
        <div className="wl2-error" role="alert">{watchlistError}</div>
      )}

      {/* ── Position picker ── */}
      {showPositionPicker && positionsNotInWatchlist.length > 0 && (
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
                  handleAddWatchlist(ck, 'position', p.symbol || undefined, p.secType || undefined, exp, p.strike, p.right)
                }}
                title={ck}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Tab bar ── */}
      {!watchlistLoading && watchlistItems.length > 0 && (
        <nav className="wl2-tabs" aria-label="Watchlist sections">
          <button
            type="button"
            className={`wl2-tabs__btn${activeSection === 'stocks' ? ' wl2-tabs__btn--active' : ''}`}
            onClick={() => setActiveSection('stocks')}
          >
            Stocks
            <span className="wl2-tabs__badge">{stockCount}</span>
          </button>
          <button
            type="button"
            className={`wl2-tabs__btn${activeSection === 'options' ? ' wl2-tabs__btn--active' : ''}`}
            onClick={() => setActiveSection('options')}
          >
            Options
            <span className="wl2-tabs__badge">{optionCount}</span>
          </button>
        </nav>
      )}

      {/* ── Main content ── */}
      {watchlistLoading ? (
        <div className="wl2-empty">Loading…</div>
      ) : watchlistItems.length === 0 ? (
        <div className="wl2-empty">No items. Enter a symbol above to start.</div>
      ) : (
        <>
          {/* ── Stocks table ── */}
          {activeSection === 'stocks' && (
            <div className="wl2-table-wrap">
              {allStocks.length === 0 ? (
                <div className="wl2-empty">No stocks in watchlist.</div>
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
                  {stockCategoryOrder.map(catLabel => {
                    const items = stockByCategory[catLabel] ?? []
                    if (items.length === 0) return null
                    return (
                      <tbody key={catLabel}>
                        {stockCategoryOrder.length > 1 && (
                          <tr className="wl2-group-row">
                            <td colSpan={5}>
                              <span className="wl2-group-label">{catLabel}</span>
                              <span className="wl2-group-count">{items.length}</span>
                            </td>
                          </tr>
                        )}
                        {items.map(item => {
                          const sym = symbolFromItem(item)
                          const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[sym]
                          const hasHolding = contractKeysWithPosition.has(item.contract_key.trim())
                          const optOn = item.optionable === true
                          return (
                            <tr key={item.contract_key} className={!optOn ? 'wl2-row--dim' : undefined}>
                              <td className="wl2-td--sym" title={item.contract_key}>
                                <span className="wl2-sym">{watchlistItemLabel(item)}</span>
                                {hasHolding && <span className="wl2-badge wl2-badge--hold" title="Holding">H</span>}
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
                        })}
                      </tbody>
                    )
                  })}
                </table>
              )}
            </div>
          )}

          {/* ── Options table ── */}
          {activeSection === 'options' && (
            <div className="wl2-table-wrap">
              {watchlistOptions.length === 0 ? (
                <div className="wl2-empty">No options in watchlist.</div>
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
                  {optionCategoryOrder.map(catLabel => {
                    const items = optionByCategory[catLabel] ?? []
                    if (items.length === 0) return null
                    return (
                      <tbody key={`opt-${catLabel}`}>
                        {optionCategoryOrder.length > 1 && (
                          <tr className="wl2-group-row">
                            <td colSpan={7}>
                              <span className="wl2-group-label">{catLabel}</span>
                              <span className="wl2-group-count">{items.length}</span>
                            </td>
                          </tr>
                        )}
                        {items.map(item => {
                          const q = quoteByContractKey[item.contract_key] ?? quoteBySymbol[symbolFromItem(item)]
                          const hasHolding = contractKeysWithPosition.has(item.contract_key.trim())
                          return (
                            <tr key={item.contract_key}>
                              <td className="wl2-td--sym" title={item.contract_key}>
                                <span className="wl2-sym">{item.symbol || watchlistItemLabel(item)}</span>
                                {hasHolding && <span className="wl2-badge wl2-badge--hold" title="Holding">H</span>}
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
                        })}
                      </tbody>
                    )
                  })}
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
