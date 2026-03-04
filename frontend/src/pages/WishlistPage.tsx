import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IbAccountSnapshot, IbPositionRow, RealtimeQuote, StatusResponse, WishlistItem } from '../types'
import type { BarStatsResponse } from '../types'
import { fetchWishlist, fetchBarStats, fetchQuotes, postBarsFetch, postWishlist, deleteWishlist } from '../api'

interface WishlistPageProps {
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
function wishlistItemLabel(item: WishlistItem): string {
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

export function WishlistPage({ status }: WishlistPageProps) {
  const [wishlistItems, setWishlistItems] = useState<WishlistItem[]>([])
  const [wishlistLoading, setWishlistLoading] = useState(false)
  const [wishlistError, setWishlistError] = useState<string | null>(null)
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

  const loadWishlist = useCallback(async () => {
    setWishlistLoading(true)
    setWishlistError(null)
    try {
      const res = await fetchWishlist()
      setWishlistItems(res.items || [])
    } catch (e) {
      setWishlistError(e instanceof Error ? e.message : '加载失败')
      setWishlistItems([])
    } finally {
      setWishlistLoading(false)
    }
  }, [])

  useEffect(() => {
    loadWishlist()
  }, [loadWishlist])

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

  const handleAddWishlist = useCallback(
    async (contract_key: string, source: string, symbol?: string, sec_type?: string, expiry?: string, strike?: number, option_right?: string) => {
      const key = contract_key.trim()
      if (!key) return
      setAddPending(true)
      setWishlistError(null)
      try {
        const res = await postWishlist({
          contract_key: key,
          symbol: symbol || undefined,
          sec_type: sec_type || undefined,
          expiry: expiry || undefined,
          strike,
          option_right: option_right || undefined,
          source,
        })
        if (res.ok) await loadWishlist()
        else setWishlistError(res.error || '添加失败')
      } catch (e) {
        setWishlistError(e instanceof Error ? e.message : '添加请求失败，请检查网络或 API')
      } finally {
        setAddPending(false)
      }
    },
    [loadWishlist],
  )

  const handleRemoveWishlist = useCallback(
    async (item: WishlistItem) => {
      setWishlistError(null)
      const res = item.id != null
        ? await deleteWishlist({ id: item.id })
        : await deleteWishlist({ contract_key: item.contract_key })
      if (res.ok) await loadWishlist()
      else setWishlistError(res.error || '删除失败')
    },
    [loadWishlist],
  )

  const wishlistContractKeys = useMemo(() => new Set(wishlistItems.map(w => w.contract_key)), [wishlistItems])

  /** 仅展示尚未在自选中的持仓，用于「从持仓添加」按钮列表 */
  const positionsNotInWishlist = useMemo(() => {
    return positions.filter(p => !wishlistContractKeys.has(positionToContractKey(p)))
  }, [positions, wishlistContractKeys])

  const wishlistStocks = useMemo(() => wishlistItems.filter(w => (w.sec_type || 'STK').toUpperCase() !== 'OPT'), [wishlistItems])
  const wishlistOptions = useMemo(() => wishlistItems.filter(w => (w.sec_type || '').toUpperCase() === 'OPT'), [wishlistItems])

  function openAddOptionModal(item: WishlistItem) {
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
    await handleAddWishlist(contract_key, 'manual', addOptionForSymbol, 'OPT', expiry, strikeNum, rightLetter)
    closeAddOptionModal()
  }

  /** 从 wishlist 项取 symbol（股票用，分析 Stock_xx 表） */
  function symbolFromItem(item: WishlistItem): string {
    if (item.symbol && String(item.symbol).trim()) return String(item.symbol).trim()
    const parts = (item.contract_key || '').split('|')
    return (parts[0] || '').trim()
  }

  async function handleAnalyze(item: WishlistItem) {
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
        label: '日线',
        duration: dayCount === 0 ? '1 Y' : '30 D',
        smart: dayCount > 0,
      },
      {
        period: '1 min',
        label: '1 分钟',
        duration: (minCounts['1 min'] ?? 0) === 0 ? '1 D' : '5 D',
        smart: (minCounts['1 min'] ?? 0) > 0,
      },
      {
        period: '5 mins',
        label: '5 分钟',
        duration: (minCounts['5 mins'] ?? 0) === 0 ? '1 D' : '5 D',
        smart: (minCounts['5 mins'] ?? 0) > 0,
      },
      {
        period: '1 hour',
        label: '1 小时',
        duration: (minCounts['1 hour'] ?? 0) === 0 ? '1 D' : '5 D',
        smart: (minCounts['1 hour'] ?? 0) > 0,
      },
    ]
    let lastError: string | null = null
    for (const { period, label, duration, smart } of steps) {
      setFetchMarketDataStep(`正在拉取 ${label}${duration === '1 Y' ? '（约 1 年）' : ''}…`)
      try {
        const res = await postBarsFetch(sym, period, duration, smart)
        if (res.error) {
          lastError = res.error
          setFetchMarketDataError(res.error)
          break
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : '拉取失败'
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

  function renderStockTable(items: WishlistItem[], emptyText: string) {
    if (items.length === 0) return <p className="replay-placeholder">{emptyText}</p>
    return (
      <table className="table-operations">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>当前价</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const sym = symbolFromItem(item)
            const q = quoteBySymbol[sym]
            return (
              <tr key={item.contract_key}>
                <td title={item.contract_key}>{wishlistItemLabel(item)}</td>
                <td>{q?.last != null && Number.isFinite(q.last) ? fmtUsdShort(q.last) : '—'}</td>
                <td>
                <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleAnalyze(item)}
                    disabled={analysisLoadingSymbol !== null}
                    aria-label={`分析 ${symbolFromItem(item) || wishlistItemLabel(item)} 在 Stock_xx 中的数据`}
                  >
                    {analysisLoadingSymbol === symbolFromItem(item) ? '分析中…' : '分析'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openAddOptionModal(item)}
                    aria-label="添加期权"
                  >
                    期权
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleRemoveWishlist(item)}
                    aria-label="从自选移除"
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

  function renderOptionsTable(items: WishlistItem[], emptyText: string) {
    if (items.length === 0) return <p className="replay-placeholder">{emptyText}</p>
    return (
      <table className="table-operations">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>当前价（标的）</th>
            <th>到期</th>
            <th>权利</th>
            <th>行权价</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const sym = symbolFromItem(item)
            const q = quoteBySymbol[sym]
            return (
              <tr key={item.contract_key}>
                <td title={item.contract_key}>{item.symbol || wishlistItemLabel(item)}</td>
                <td>{q?.last != null && Number.isFinite(q.last) ? fmtUsdShort(q.last) : '—'}</td>
                <td>{formatExpiry(item.expiry)}</td>
                <td>{formatOptionRight(item.option_right)}</td>
                <td>{item.strike != null ? formatStrike(item.strike) : '—'}</td>
                <td>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleRemoveWishlist(item)}
                  aria-label="从自选移除"
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
    <div className="card process-section wishlist-page">
      <h2>自选</h2>
      <p className="section-desc">
        自选标的列表（Wishlist），用于拉取报价与 K 线时的标的候选；可从当前持仓添加或输入 Symbol 添加。
      </p>

      <section className="replay-section" aria-labelledby="wishlist-head">
        <h3 id="wishlist-head">自选股</h3>
        <p className="section-hint">
          股票：输入 Symbol 添加。期权：在股票行的「期权」中填写到期日、权利、行权价。
        </p>
        {wishlistError && (
          <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
            {wishlistError}
          </div>
        )}
        <div className="replay-bar-symbol-row">
          <label htmlFor="wishlist-symbol" className="replay-bar-symbol-label">添加股票</label>
          <input
            id="wishlist-symbol"
            type="text"
            className="replay-bar-symbol-input"
            placeholder="Symbol，如 NVDA"
            value={addContractKey}
            onChange={e => setAddContractKey(e.target.value)}
            aria-label="输入 Symbol 添加股票"
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={addPending || !addContractKey.trim()}
            onClick={() => {
              const { contract_key, symbol, sec_type } = normalizeToContractKey(addContractKey)
              if (!contract_key) return
              handleAddWishlist(contract_key, 'manual', symbol, sec_type)
              setAddContractKey('')
            }}
          >
            {addPending ? '添加中…' : '添加'}
          </button>
        </div>
        {positionsNotInWishlist.length > 0 && (
          <div className="replay-bar-symbol-row" style={{ flexWrap: 'wrap', gap: '0.25rem' }}>
            <span className="replay-bar-symbol-label">从持仓添加：</span>
            {positionsNotInWishlist.map((p, idx) => {
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
                    handleAddWishlist(ck, 'position', p.symbol || undefined, p.secType || undefined, exp, p.strike, p.right)
                  }}
                  title={ck}
                >
                  {label || ck}
                </button>
              )
            })}
          </div>
        )}
        {wishlistLoading ? (
          <div className="replay-placeholder">加载自选列表…</div>
        ) : wishlistItems.length === 0 ? (
          <div className="replay-placeholder">暂无自选。请输入 Symbol 添加，或从持仓添加。</div>
        ) : (
          <>
            <h4 className="wishlist-subhead">股票</h4>
            {renderStockTable(wishlistStocks, '暂无自选股票。')}
            <h4 className="wishlist-subhead" style={{ marginTop: '1rem' }}>期权</h4>
            {renderOptionsTable(wishlistOptions, '暂无自选期权。')}
          </>
        )}
      </section>

      {analysisResult && (
        <section className="replay-section market-data-analysis" aria-labelledby="wishlist-analysis-head">
          <h3 id="wishlist-analysis-head">当前选中 Symbol 在 Stock_xx 表中的数据情况</h3>
          <p className="section-hint">标的 <strong>{analysisResult.symbol}</strong> 在数据库中的 K 线行数统计。</p>
          <div className="analysis-stats">
            <div className="analysis-stat-row">
              <span className="analysis-stat-label">stock_day（日线）</span>
              <span className="analysis-stat-value">{analysisResult.stats.stock_day}</span>
              <span className="analysis-stat-desc">{analysisResult.stats.stock_day === 0 ? '无数据' : '条'}</span>
            </div>
            <div className="analysis-stat-row">
              <span className="analysis-stat-label">stock_min（分钟/小时线）</span>
              <div className="analysis-stat-value">
                {analysisResult.stats.stock_min && Object.keys(analysisResult.stats.stock_min).length > 0 ? (
                  <ul className="analysis-period-list">
                    {Object.entries(analysisResult.stats.stock_min).map(([period, count]) => (
                      <li key={period}>{period}: {count} 条</li>
                    ))}
                  </ul>
                ) : (
                  <span>无数据</span>
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
              aria-label="智能拉取该标的 K 线（日线最多 1 年，分钟/小时线按需补全）"
            >
              {fetchMarketDataStep || '获取市场数据'}
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
          className="wishlist-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wishlist-add-option-title"
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
            className="wishlist-modal-content card"
            style={{ padding: '1.25rem', minWidth: '18rem', maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <h4 id="wishlist-add-option-title" style={{ marginTop: 0 }}>为 {addOptionForSymbol} 添加期权</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="replay-bar-symbol-row">
                <label className="replay-bar-symbol-label">到期日</label>
                <input
                  type="text"
                  placeholder="yyyy-mm-dd 或 YYYYMMDD"
                  value={addOptExpiry}
                  onChange={e => setAddOptExpiry(e.target.value)}
                  className="replay-bar-symbol-input"
                  aria-label="到期日"
                />
              </div>
              <div className="replay-bar-symbol-row">
                <label className="replay-bar-symbol-label">权利</label>
                <select
                  value={addOptRight}
                  onChange={e => setAddOptRight(e.target.value as 'CALL' | 'PUT')}
                  aria-label="权利"
                  style={{ padding: '0.25rem 0.5rem', flex: 1 }}
                >
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="replay-bar-symbol-row">
                <label className="replay-bar-symbol-label">行权价</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="如 120"
                  value={addOptStrike}
                  onChange={e => setAddOptStrike(e.target.value)}
                  className="replay-bar-symbol-input"
                  aria-label="行权价"
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeAddOptionModal}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={addPending || !addOptExpiry.trim() || !addOptStrike.trim()}
                  onClick={() => submitAddOption()}
                >
                  {addPending ? '添加中…' : '添加'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
