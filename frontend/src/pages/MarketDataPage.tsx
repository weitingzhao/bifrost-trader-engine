import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar, IbAccountSnapshot, RealtimeQuote, StatusResponse } from '../types'
import { fetchBars, fetchQuotes, postBarsFetch } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

const BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 min', label: '1 min' },
  { value: '5 mins', label: '5 min' },
  { value: '1 hour', label: '1 hour' },
] as const

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

interface MarketDataPageProps {
  status: StatusResponse | null
}

/** 从持仓汇总可拉取 K 线的标的候选（后续可合并 Wishlist） */
function useBarCandidateSymbols(status: StatusResponse | null): string[] {
  return useMemo(() => {
    const fromAccounts = (status?.accounts || []).flatMap((acc: IbAccountSnapshot) =>
      (acc.positions || []).map(p => p.symbol).filter((s): s is string => Boolean(s?.trim())),
    )
    return [...new Set(fromAccounts)].sort()
  }, [status?.accounts])
}

export function MarketDataPage({ status }: MarketDataPageProps) {
  const [bars, setBars] = useState<Bar[]>([])
  const [barsSyncing, setBarsSyncing] = useState(false)
  const [barsLoading, setBarsLoading] = useState(false)
  const [barSymbol, setBarSymbol] = useState('')
  const [barPeriod, setBarPeriod] = useState<string>('1 D')
  const [smartDuration, setSmartDuration] = useState(true)
  const [quotes, setQuotes] = useState<RealtimeQuote[]>([])
  const [quotesMessage, setQuotesMessage] = useState<string | null>(null)

  const candidateSymbols = useBarCandidateSymbols(status)

  /** R-RM*: 轮询实时行情（无 symbols 时使用服务端关注列表）；4 秒周期 */
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetchQuotes()
        if (cancelled) return
        setQuotes(res.quotes || [])
        setQuotesMessage(res.message || null)
      } catch {
        if (!cancelled) {
          setQuotes([])
          setQuotesMessage('Realtime quotes unavailable')
        }
      }
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const loadBarsFromApi = useCallback(async (symbol: string) => {
    if (!symbol.trim()) return
    setBarsLoading(true)
    try {
      const res = await fetchBars(symbol, barPeriod, 100)
      setBars(res.bars || [])
    } catch {
      setBars([])
    } finally {
      setBarsLoading(false)
    }
  }, [barPeriod])

  useEffect(() => {
    if (candidateSymbols.length > 0 && !barSymbol.trim()) setBarSymbol(candidateSymbols[0])
  }, [candidateSymbols.join(','), barSymbol])

  const defaultDuration = barPeriod === '1 D' ? '30 D' : '5 D'

  return (
    <div className="card process-section market-data-page">
      <h2 className="page-title-with-tooltip">
        Market data
        <InfoTooltip text="Manage bars and market data: fetch by symbol and write to DB (stock_day / stock_min) for replay and risk." />
      </h2>

      {quotes.length > 0 && (
        <section className="replay-section realtime-quotes-wall" aria-labelledby="realtime-quotes-head">
          <h3 id="realtime-quotes-head">Realtime quotes</h3>
          {quotesMessage && <p className="section-hint">{quotesMessage}</p>}
          <div className="quotes-ticker" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.5rem' }}>
            {quotes.map(q => (
              <div
                key={q.symbol}
                className="quote-card"
                style={{
                  padding: '0.5rem 0.75rem',
                  border: '1px solid var(--border, #ddd)',
                  borderRadius: '6px',
                  minWidth: '7rem',
                }}
              >
                <span className="quote-symbol" style={{ fontWeight: 600 }}>{q.symbol}</span>
                <span className="quote-last" style={{ marginLeft: '0.5rem' }}>
                  {q.last != null && Number.isFinite(q.last) ? fmtUsd(q.last) : '—'}
                </span>
                {(q.bid != null || q.ask != null) && (
                  <div className="quote-bidask" style={{ fontSize: '0.85rem', color: 'var(--muted, #666)' }}>
                    {q.bid != null ? fmtUsd(q.bid) : '—'} / {q.ask != null ? fmtUsd(q.ask) : '—'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="replay-section" aria-labelledby="bars-head">
        <h3 id="bars-head" className="page-title-with-tooltip">
          Bars
          <InfoTooltip text="Fetch by symbol and period for replay. Enter symbol or pick from current positions." />
        </h3>
        <div className="replay-bar-symbol-row">
          <label htmlFor="market-bar-symbol" className="replay-bar-symbol-label">Symbol</label>
          <input
            id="market-bar-symbol"
            type="text"
            className="replay-bar-symbol-input"
            placeholder="Symbol, e.g. NVDA"
            value={barSymbol}
            onChange={e => setBarSymbol((e.target.value || '').trim().toUpperCase())}
            aria-label="Symbol for bars"
          />
          {candidateSymbols.length > 0 && (
            <span className="replay-sync-hint">From positions: {candidateSymbols.join(', ')}</span>
          )}
        </div>
        <div className="replay-bar-symbol-row">
          <label className="replay-bar-symbol-label">Period</label>
          <select
            value={barPeriod}
            onChange={e => setBarPeriod(e.target.value)}
            aria-label="Bar period"
          >
            {BAR_PERIODS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <label className="replay-sync-hint" style={{ marginLeft: '1rem' }}>
            <input
              type="checkbox"
              checked={smartDuration}
              onChange={e => setSmartDuration(e.target.checked)}
              aria-label="Smart fetch"
            />
            Smart fetch (fill only missing range from latest bar)
          </label>
        </div>
        <div className="replay-toolbar">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={barsSyncing || barsLoading || !(barSymbol.trim() || candidateSymbols[0])}
            onClick={async () => {
              const symbol = barSymbol.trim() || candidateSymbols[0] || ''
              if (!symbol) return
              setBarsSyncing(true)
              const res = await postBarsFetch(symbol, barPeriod, defaultDuration, smartDuration)
              setBarsSyncing(false)
              if (res.ok && res.bars) setBars(res.bars)
              else if (res.ok) await loadBarsFromApi(symbol)
            }}
            aria-label="Fetch bars from IB and refresh list"
          >
            {barsSyncing ? 'Fetching…' : 'Fetch bars'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={barsLoading || !barSymbol.trim()}
            onClick={() => loadBarsFromApi(barSymbol.trim())}
            aria-label="Load bars from DB"
          >
            {barsLoading ? 'Loading…' : 'Load from DB'}
          </button>
          {barsSyncing && (
            <span className="replay-sync-hint">Fetching bars from IB…</span>
          )}
        </div>
        {bars.length === 0 ? (
          <div className="replay-placeholder">No bars. Enter symbol and click "Fetch bars" or "Load from DB".</div>
        ) : (
          <table className="table-operations">
            <thead>
              <tr>
                <th>Time</th>
                <th>Open</th>
                <th>High</th>
                <th>Low</th>
                <th>Close</th>
                <th>Vol</th>
              </tr>
            </thead>
            <tbody>
              {bars.slice(0, 50).map((b, i) => (
                <tr key={i}>
                  <td>{b.time != null ? fmtTs(b.time) : '—'}</td>
                  <td>{fmtUsd(b.open)}</td>
                  <td>{fmtUsd(b.high)}</td>
                  <td>{fmtUsd(b.low)}</td>
                  <td>{fmtUsd(b.close)}</td>
                  <td>{b.volume != null ? Number(b.volume).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
