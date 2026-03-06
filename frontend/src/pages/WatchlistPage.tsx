import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IbAccountSnapshot, IbPositionRow, RealtimeQuote, StatusResponse, WatchlistItem } from '../types'
import type { BarStatsResponse } from '../types'
import { fetchWatchlist, fetchBarStats, fetchQuotes, postBarsFetch, postWatchlist, deleteWatchlist } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

interface WatchlistPageProps {
  status: StatusResponse | null
}

/** 将用户输入规范为 contract_key（与 account_positions 一致）。纯 symbol 如 NVDA → NVDA|STK||| */
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

/** 自选股单项显示名 */
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

/** 到期日格式化为 yyyy-mm-dd（支持 YYYYMMDD 或 YYYYMM） */
function formatExpiry(expiry: string | null | undefined): string {
  if (expiry == null || expiry === '') return '—'
  const s = String(expiry).trim()
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return s
}

/** 用户输入的到期日规范为 YYYYMMDD（支持 yyyy-mm-dd 或 8/6 位数字） */
function normalizeExpiryInput(input: string): string {
  const s = input.trim().replace(/-/g, '')
  if (/^\d{8}$/.test(s)) return s
  if (/^\d{6}$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return input.trim().replace(/-/g, '')
  return input.trim()
}

/** 权利 C -> CALL, P -> PUT */
function formatOptionRight(right: string | null | undefined): string {
  if (right == null || right === '') return '—'
  const r = String(right).trim().toUpperCase()
  if (r === 'C') return 'CALL'
  if (r === 'P') return 'PUT'
  return right
}

/** 行权价显示为美元 */
function formatStrike(strike: number | null | undefined): string {
  if (strike == null) return '—'
  const n = Number(strike)
  if (Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(n)
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

  const positions = useMemo(() => {
    return (status?.accounts || []).flatMap((acc: IbAccountSnapshot) => (acc.positions || []))
  }, [status?.accounts])

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

  useEffect(() => {
    loadWatchlist()
  }, [loadWatchlist])

  /** R-RM*: 轮询实时行情（用于当前价列）；4 秒 */
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
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const quoteBySymbol = useMemo(
    () => Object.fromEntries(realtimeQuotes.map(q => [q.symbol, q])),
    [realtimeQuotes],
  )

  function fmtUsdShort(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  }

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
        setWatchlistError(e instanceof Error ? e.message : 'Add request failed; check network or API')
      } finally {
        setAddPending(false)
      }
    },
    [loadWatchlist],
  )

  const handleRemoveWatchlist = useCallback(
    async (item: WatchlistItem) => {
      setWatchlistError(null)
      const res = item.id != null
        ? await deleteWatchlist({ id: item.id })
        : await deleteWatchlist({ contract_key: item.contract_key })
      if (res.ok) await loadWatchlist()
      else setWatchlistError(res.error || 'Remove failed')
    },
    [loadWatchlist],
  )

  const watchlistContractKeys = useMemo(() => new Set(watchlistItems.map(w => w.contract_key)), [watchlistItems])

  /** 仅展示尚未在自选中的持仓，用于「从持仓添加」按钮列表；只列 STK（股票） */
  const positionsNotInWatchlist = useMemo(() => {
    return positions.filter(p => {
      const st = (p.secType ?? '').toString().trim().toUpperCase()
      if (st !== 'STK' && st !== '') return false
      return !watchlistContractKeys.has(positionToContractKey(p))
    })
  }, [positions, watchlistContractKeys])

  const watchlistStocks = useMemo(() => watchlistItems.filter(w => (w.sec_type || 'STK').toUpperCase() !== 'OPT'), [watchlistItems])
  const watchlistOptions = useMemo(() => watchlistItems.filter(w => (w.sec_type || '').toUpperCase() === 'OPT'), [watchlistItems])

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

  /** 从 watchlist 项取 symbol（股票用，分析 Stock_xx 表） */
  function symbolFromItem(item: WatchlistItem): string {
    if (item.symbol && String(item.symbol).trim()) return String(item.symbol).trim()
    const parts = (item.contract_key || '').split('|')
    return (parts[0] || '').trim()
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

  /** 智能拉取市场数据：首次拉取用 IB 允许的最大单次范围（日线 1 Y，分钟/小时 1 D），之后按最新 K 线距今天数补全。 */
  async function handleFetchMarketData() {
    if (!analysisResult) return
    const sym = analysisResult.symbol
    const { stock_day: dayCount, stock_min: minCounts = {} } = analysisResult.stats
    setFetchMarketDataError(null)
    const steps: { period: string; label: string; duration: string; smart: boolean }[] = [
      {
        period: '1 D',
        label: 'Daily',
        duration: dayCount === 0 ? '1 Y' : '30 D',
        smart: dayCount > 0,
      },
      {
        period: '1 min',
        label: '1 min',
        duration: (minCounts['1 min'] ?? 0) === 0 ? '1 D' : '5 D',
        smart: (minCounts['1 min'] ?? 0) > 0,
      },
      {
        period: '5 mins',
        label: '5 min',
        duration: (minCounts['5 mins'] ?? 0) === 0 ? '1 D' : '5 D',
        smart: (minCounts['5 mins'] ?? 0) > 0,
      },
      {
        period: '1 hour',
        label: '1 hour',
        duration: (minCounts['1 hour'] ?? 0) === 0 ? '1 D' : '5 D',
        smart: (minCounts['1 hour'] ?? 0) > 0,
      },
    ]
    let lastError: string | null = null
    for (const { period, label, duration, smart } of steps) {
      setFetchMarketDataStep(`Fetching ${label}${duration === '1 Y' ? ' (~1 year)' : ''}…`)
      try {
        const res = await postBarsFetch(sym, period, duration, smart)
        if (res.error) {
          lastError = res.error
          setFetchMarketDataError(res.error)
          break
        }
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
      } catch {
        // 保持原 analysisResult
      }
    }
  }

  function renderStockTable(items: WatchlistItem[], emptyText: string) {
    if (items.length === 0) return <p className="replay-placeholder">{emptyText}</p>
    return (
      <table className="table-operations">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Price</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const sym = symbolFromItem(item)
            const q = quoteBySymbol[sym]
            return (
              <tr key={item.contract_key}>
                <td title={item.contract_key}>{watchlistItemLabel(item)}</td>
                <td>{q?.last != null && Number.isFinite(q.last) ? fmtUsdShort(q.last) : '—'}</td>
                <td>
                <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleAnalyze(item)}
                    disabled={analysisLoadingSymbol !== null}
                    aria-label={`Analyze ${symbolFromItem(item) || watchlistItemLabel(item)} in Stock_xx`}
                  >
                    {analysisLoadingSymbol === symbolFromItem(item) ? 'Analyzing…' : 'Analyze'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openAddOptionModal(item)}
                    aria-label="Add option"
                  >
                    Options
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleRemoveWatchlist(item)}
                    aria-label="Remove from watchlist"
                  >
                    X
                  </button>
                </span>
              </td>
            </tr>
          )
          })}
        </tbody>
      </table>
    )
  }

  function renderOptionsTable(items: WatchlistItem[], emptyText: string) {
    if (items.length === 0) return <p className="replay-placeholder">{emptyText}</p>
    return (
      <table className="table-operations">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Price (underlying)</th>
            <th>Expiry</th>
            <th>Right</th>
            <th>Strike</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const sym = symbolFromItem(item)
            const q = quoteBySymbol[sym]
            return (
              <tr key={item.contract_key}>
                <td title={item.contract_key}>{item.symbol || watchlistItemLabel(item)}</td>
                <td>{q?.last != null && Number.isFinite(q.last) ? fmtUsdShort(q.last) : '—'}</td>
                <td>{formatExpiry(item.expiry)}</td>
                <td>{formatOptionRight(item.option_right)}</td>
                <td>{item.strike != null ? formatStrike(item.strike) : '—'}</td>
                <td>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleRemoveWatchlist(item)}
                  aria-label="Remove from watchlist"
                >
                  X
                </button>
              </td>
            </tr>
          )
          })}
        </tbody>
      </table>
    )
  }

  return (
    <div className="card process-section watchlist-page">
      <h2 className="page-title-with-tooltip">
        Watchlist
        <InfoTooltip text="Watchlist for quotes and bars; add from positions or enter Symbol." />
      </h2>

      <section className="replay-section" aria-labelledby="watchlist-head">
        <h3 id="watchlist-head" className="page-title-with-tooltip">
          Stocks & options
          <InfoTooltip text="Stocks: enter Symbol to add. Options: use 'Options' on a stock row and fill expiry, right, strike." />
        </h3>
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: '0.75rem' }}>
          Stocks in this list are subscribed by the daemon as <strong>Real-time ticker</strong> (see System → Event Subscribe). Add a symbol below to include it in monitoring. The daemon syncs this list on every heartbeat; no restart is needed when you add or remove symbols.
        </p>
        {watchlistError && (
          <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
            {watchlistError}
          </div>
        )}
        <div className="replay-bar-symbol-row">
          <label htmlFor="watchlist-symbol" className="replay-bar-symbol-label">Add stock (→ Real-time ticker)</label>
          <input
            id="watchlist-symbol"
            type="text"
            className="replay-bar-symbol-input"
            placeholder="Symbol, e.g. NVDA"
            value={addContractKey}
            onChange={e => setAddContractKey(e.target.value)}
            aria-label="Enter Symbol to add stock"
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={addPending || !addContractKey.trim()}
            onClick={() => {
              const { contract_key, symbol, sec_type } = normalizeToContractKey(addContractKey)
              if (!contract_key) return
              handleAddWatchlist(contract_key, 'manual', symbol, sec_type)
              setAddContractKey('')
            }}
          >
            {addPending ? 'Adding…' : 'Add'}
          </button>
        </div>
        {positionsNotInWatchlist.length > 0 && (
          <div className="replay-bar-symbol-row" style={{ flexWrap: 'wrap', gap: '0.25rem' }}>
            <span className="replay-bar-symbol-label">Add from positions:</span>
            {positionsNotInWatchlist.map((p, idx) => {
              const ck = positionToContractKey(p)
              const label = (p.symbol || '')
                + (p.secType === 'OPT' && (p.expiry || p.lastTradeDateOrContractMonth) ? ` ${p.expiry || p.lastTradeDateOrContractMonth} ${p.right || ''} ${p.strike ?? ''}` : '')
              return (
                <button
                  key={ck + String(idx)}
                  type="button"
                  className="btn btn-secondary"
                  disabled={addPending}
                  onClick={() => {
                    const exp = (p.expiry ?? p.lastTradeDateOrContractMonth) as string | undefined
                    handleAddWatchlist(ck, 'position', p.symbol || undefined, p.secType || undefined, exp, p.strike, p.right)
                  }}
                  title={ck}
                >
                  {label || ck}
                </button>
              )
            })}
          </div>
        )}
        {watchlistLoading ? (
          <div className="replay-placeholder">Loading watchlist…</div>
        ) : watchlistItems.length === 0 ? (
          <div className="replay-placeholder">No items. Enter Symbol to add or add from positions.</div>
        ) : (
          <>
            <h4 className="watchlist-subhead">Stocks</h4>
            {renderStockTable(watchlistStocks, 'No stocks in watchlist.')}
            <h4 className="watchlist-subhead" style={{ marginTop: '1rem' }}>Options</h4>
            {renderOptionsTable(watchlistOptions, 'No options in watchlist.')}
          </>
        )}
      </section>

      {analysisResult && (
        <section className="replay-section market-data-analysis" aria-labelledby="watchlist-analysis-head">
          <h3 id="watchlist-analysis-head" className="page-title-with-tooltip">
            Bar stats for {analysisResult.symbol} in Stock_xx
            <InfoTooltip text="K-line row counts for this symbol in DB." />
          </h3>
          <div className="analysis-stats">
            <div className="analysis-stat-row">
              <span className="analysis-stat-label">stock_day (daily)</span>
              <span className="analysis-stat-value">{analysisResult.stats.stock_day}</span>
              <span className="analysis-stat-desc">{analysisResult.stats.stock_day === 0 ? 'No data' : 'rows'}</span>
            </div>
            <div className="analysis-stat-row">
              <span className="analysis-stat-label">stock_min (min/hour)</span>
              <div className="analysis-stat-value">
                {analysisResult.stats.stock_min && Object.keys(analysisResult.stats.stock_min).length > 0 ? (
                  <ul className="analysis-period-list">
                    {Object.entries(analysisResult.stats.stock_min).map(([period, count]) => (
                      <li key={period}>{period}: {count} rows</li>
                    ))}
                  </ul>
                ) : (
                  <span>No data</span>
                )}
              </div>
            </div>
          </div>
          <div className="analysis-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!fetchMarketDataStep}
              onClick={() => handleFetchMarketData()}
              aria-label="Smart fetch bars for this symbol (daily up to 1Y, min/hour as needed)"
            >
              {fetchMarketDataStep || 'Get market data'}
            </button>
            {fetchMarketDataError && (
              <span className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginLeft: '0.5rem' }}>
                {fetchMarketDataError}
              </span>
            )}
          </div>
        </section>
      )}

      {addOptionForSymbol != null && (
        <div
          className="watchlist-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="watchlist-add-option-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={e => e.target === e.currentTarget && closeAddOptionModal()}
        >
          <div
            className="watchlist-modal-content card"
            style={{ padding: '1.25rem', minWidth: '18rem', maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <h4 id="watchlist-add-option-title" style={{ marginTop: 0 }}>Add option for {addOptionForSymbol}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="replay-bar-symbol-row">
                <label className="replay-bar-symbol-label">Expiry</label>
                <input
                  type="text"
                  placeholder="yyyy-mm-dd or YYYYMMDD"
                  value={addOptExpiry}
                  onChange={e => setAddOptExpiry(e.target.value)}
                  className="replay-bar-symbol-input"
                  aria-label="Expiry"
                />
              </div>
              <div className="replay-bar-symbol-row">
                <label className="replay-bar-symbol-label">Right</label>
                <select
                  value={addOptRight}
                  onChange={e => setAddOptRight(e.target.value as 'CALL' | 'PUT')}
                  aria-label="Right"
                  style={{ padding: '0.25rem 0.5rem', flex: 1 }}
                >
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="replay-bar-symbol-row">
                <label className="replay-bar-symbol-label">Strike</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 120"
                  value={addOptStrike}
                  onChange={e => setAddOptStrike(e.target.value)}
                  className="replay-bar-symbol-input"
                  aria-label="Strike"
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeAddOptionModal}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={addPending || !addOptExpiry.trim() || !addOptStrike.trim()}
                  onClick={() => submitAddOption()}
                >
                  {addPending ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
