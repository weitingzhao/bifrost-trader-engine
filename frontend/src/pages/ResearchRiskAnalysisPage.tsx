import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PerformanceSummary, RiskSummaryResponse, StatusResponse, WatchlistItem } from '../types'
import { fetchBars, fetchPerformance, fetchQuotes, fetchRiskSummary, fetchWatchlist } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtUsd, fmtUsd0 } from '../utils/format'
import { computeAtr, computeKelly, computePositionSize } from '../api/research/risk'
import type { AtrResult, KellyMetrics, PositionSizeResult } from '../api/research/risk'
import { getNetLiq } from './accounts/accountsUtils'

interface ResearchRiskAnalysisPageProps {
  onGoToScreener?: () => void
  breadcrumbLabel?: string
  status?: StatusResponse | null
}

export function ResearchRiskAnalysisPage({
  onGoToScreener,
  breadcrumbLabel = 'Risk & Position Sizer',
  status,
}: ResearchRiskAnalysisPageProps = {}) {
  const [riskSummary, setRiskSummary] = useState<RiskSummaryResponse | null>(null)
  const [riskLoading, setRiskLoading] = useState(false)

  const [perfSummary, setPerfSummary] = useState<PerformanceSummary | null>(null)
  const [perfLoading, setPerfLoading] = useState(false)
  const [perfError, setPerfError] = useState<string | null>(null)

  const [kellyFraction, setKellyFraction] = useState<number>(0.5)

  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
  const [selectedSymbol, setSelectedSymbol] = useState<string>('')
  const [customSymbol, setCustomSymbol] = useState<string>('')
  const [atrMultiplier, setAtrMultiplier] = useState<number>(2)
  const [barsLoading, setBarsLoading] = useState(false)
  const [barsError, setBarsError] = useState<string | null>(null)
  const [currentPrice, setCurrentPrice] = useState<number | null>(null)
  const [atrResult, setAtrResult] = useState<AtrResult | null>(null)
  const [posResult, setPosResult] = useState<PositionSizeResult | null>(null)

  const capital = useMemo<number>(() => {
    const accounts = status?.portfolio?.accounts ?? []
    return accounts.reduce((sum, a) => sum + getNetLiq(a), 0)
  }, [status?.portfolio?.accounts])

  const kellyMetrics = useMemo<KellyMetrics>(() => {
    if (!perfSummary) return { kelly_pct: 0, effective_kelly: 0, is_valid: false }
    return computeKelly(perfSummary.win_rate, perfSummary.profit_factor, kellyFraction)
  }, [perfSummary, kellyFraction])

  const loadRisk = useCallback(async () => {
    setRiskLoading(true)
    try {
      const res = await fetchRiskSummary()
      setRiskSummary(res)
    } catch {
      setRiskSummary(null)
    } finally {
      setRiskLoading(false)
    }
  }, [])

  const loadPerformance = useCallback(async () => {
    setPerfLoading(true)
    setPerfError(null)
    try {
      const res = await fetchPerformance()
      setPerfSummary(res.summary)
    } catch (e) {
      setPerfError(e instanceof Error ? e.message : 'Failed to load performance data')
    } finally {
      setPerfLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRisk()
    void loadPerformance()
    fetchWatchlist()
      .then(r => {
        const stks = r.items.filter(i => (i.sec_type ?? 'STK') === 'STK')
        setWatchlistItems(stks)
        if (stks.length > 0) setSelectedSymbol(stks[0].symbol ?? '')
      })
      .catch(() => {})
    const t = setInterval(() => void loadRisk(), 30000)
    return () => clearInterval(t)
  }, [loadRisk, loadPerformance])

  const handleCompute = useCallback(async () => {
    const sym = (customSymbol.trim() || selectedSymbol).toUpperCase()
    if (!sym) return
    setBarsLoading(true)
    setBarsError(null)
    setAtrResult(null)
    setPosResult(null)
    setCurrentPrice(null)
    try {
      const [barsRes, quotesRes] = await Promise.all([fetchBars(sym, '1 D', 20), fetchQuotes([sym])])
      const bars = barsRes.bars ?? []
      if (bars.length < 2) {
        setBarsError(`Insufficient bar data for ${sym} (${bars.length} bars returned, need ≥ 2)`)
        return
      }
      const atr = computeAtr(bars)
      setAtrResult(atr)
      const quote = quotesRes.quotes.find(q => q.symbol.toUpperCase() === sym)
      const price = quote?.last ?? quote?.mid ?? bars[bars.length - 1]?.close ?? null
      setCurrentPrice(price)
      if (price != null) {
        setPosResult(computePositionSize(capital, price, atr, kellyMetrics, atrMultiplier))
      }
    } catch (e) {
      setBarsError(e instanceof Error ? e.message : `Failed to fetch data for ${sym}`)
    } finally {
      setBarsLoading(false)
    }
  }, [customSymbol, selectedSymbol, capital, kellyMetrics, atrMultiplier])

  return (
    <div className="card process-section">
      <div className="research-page-head">
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          {onGoToScreener ? (
            <>
              <button
                type="button"
                className="page-title-breadcrumb-link"
                onClick={onGoToScreener}
                aria-label="Research home"
              >
                Research
              </button>
              {' / '}
              {breadcrumbLabel}
              {' '}
            </>
          ) : (
            <>Risk &amp; Position Sizer{' '}</>
          )}
          <InfoTooltip text="Portfolio risk diagnostics (Kelly criterion from trade history) and ATR-based per-symbol position sizing." />
        </h2>
      </div>
      <p className="section-hint">
        Section 1 shows portfolio risk metrics from your trade history. Section 2 sizes a position using
        ATR(14) stop loss and your Kelly-derived capital allocation.
      </p>

      {/* ── Section 1: Portfolio Risk Diagnostics ── */}
      <section className="replay-section" aria-labelledby="risk-diag-head">
        <h3 id="risk-diag-head">Portfolio Risk Diagnostics</h3>

        {riskLoading && !riskSummary && <p className="section-hint">Loading risk summary…</p>}
        {riskSummary ? (
          <div className="risk-summary-cards">
            <div className="risk-card">
              <span className="risk-card-label">Daily hedge count</span>
              <span className="risk-card-value">{riskSummary.daily_hedge_count ?? '—'}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Daily PnL</span>
              <span className="risk-card-value">{fmtUsd(riskSummary.daily_pnl)}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Spot</span>
              <span className="risk-card-value">{fmtUsd(riskSummary.spot)}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Ops (24h)</span>
              <span className="risk-card-value">{riskSummary.operations_count_24h ?? 0}</span>
            </div>
          </div>
        ) : !riskLoading ? (
          <p className="section-hint">Unable to load risk summary (check API and DB).</p>
        ) : null}

        {/* Performance metrics */}
        <div style={{ marginTop: 'var(--space-4)' }}>
          {perfLoading && <p className="section-hint">Loading performance…</p>}
          {perfError && (
            <p className="msg-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
              {perfError}
            </p>
          )}
          {perfSummary && (
            <div className="risk-summary-cards">
              <div className="risk-card">
                <span className="risk-card-label">Win rate</span>
                <span className="risk-card-value">
                  {perfSummary.win_rate != null ? `${(perfSummary.win_rate * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Profit factor</span>
                <span className="risk-card-value">{perfSummary.profit_factor?.toFixed(2) ?? '—'}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Max drawdown</span>
                <span className="risk-card-value">{fmtUsd(perfSummary.max_drawdown)}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Trade count</span>
                <span className="risk-card-value">{perfSummary.trade_count ?? '—'}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Avg win</span>
                <span className="risk-card-value">{fmtUsd(perfSummary.avg_win)}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Avg loss</span>
                <span className="risk-card-value">{fmtUsd(perfSummary.avg_loss)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Kelly fraction controls */}
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div
            className="gates-form-row"
            style={{ alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}
          >
            <label htmlFor="risk-kelly-fraction" style={{ minWidth: 'max-content' }}>
              Kelly fraction:{' '}
              <strong>{kellyFraction.toFixed(2)}</strong>
            </label>
            <input
              id="risk-kelly-fraction"
              type="range"
              min={0.05}
              max={1.0}
              step={0.05}
              value={kellyFraction}
              onChange={e => setKellyFraction(parseFloat(e.target.value))}
              style={{ width: '180px' }}
            />
            <input
              type="number"
              min={0.05}
              max={1.0}
              step={0.05}
              value={kellyFraction}
              onChange={e =>
                setKellyFraction(Math.max(0.05, Math.min(1, parseFloat(e.target.value) || 0.5)))
              }
              style={{ width: '70px' }}
              aria-label="Kelly fraction numeric"
            />
          </div>

          <div className="risk-summary-cards" style={{ marginTop: 'var(--space-2)' }}>
            <div className="risk-card">
              <span className="risk-card-label">Raw Kelly %</span>
              <span className="risk-card-value">
                {kellyMetrics.is_valid ? `${(kellyMetrics.kelly_pct * 100).toFixed(2)}%` : '—'}
              </span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Effective Kelly %</span>
              <span className="risk-card-value">
                {kellyMetrics.is_valid ? `${(kellyMetrics.effective_kelly * 100).toFixed(2)}%` : '—'}
              </span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Capital (net liq)</span>
              <span className="risk-card-value">{capital > 0 ? fmtUsd0(capital) : '—'}</span>
            </div>
          </div>
          {!kellyMetrics.is_valid && perfSummary && (
            <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
              Kelly unavailable: requires win_rate ≥ 0 and profit_factor &gt; 0.
            </p>
          )}
          {capital === 0 && (
            <p className="section-hint" style={{ marginTop: 'var(--space-1)' }}>
              Capital unavailable — check IB connection.
            </p>
          )}
        </div>

        <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void loadPerformance()}
            disabled={perfLoading}
          >
            {perfLoading ? 'Loading…' : 'Refresh performance'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void loadRisk()}
            disabled={riskLoading}
          >
            {riskLoading ? 'Loading…' : 'Refresh risk summary'}
          </button>
        </div>
      </section>

      {/* ── Section 2: Per-Symbol Position Sizer ── */}
      <section
        className="replay-section"
        aria-labelledby="risk-sizer-head"
        style={{ marginTop: 'var(--space-6)' }}
      >
        <h3 id="risk-sizer-head">Per-Symbol Position Sizer</h3>
        <p className="section-hint">
          Fetches 20 daily bars, computes ATR(14), and sizes the position using the Kelly criterion above.
          Stop loss = ATR multiplier × ATR(14).
        </p>

        <div className="gates-form">
          <div className="gates-form-group">
            <div
              className="gates-form-row"
              style={{ flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}
            >
              <label htmlFor="risk-symbol-select">Symbol</label>
              <select
                id="risk-symbol-select"
                value={selectedSymbol}
                onChange={e => {
                  setSelectedSymbol(e.target.value)
                  setCustomSymbol('')
                }}
              >
                <option value="">— Select —</option>
                {watchlistItems.map(item => (
                  <option key={item.contract_key} value={item.symbol ?? ''}>
                    {item.symbol}
                  </option>
                ))}
              </select>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>
                or
              </span>
              <input
                type="text"
                placeholder="Custom (e.g. AAPL)"
                value={customSymbol}
                onChange={e => {
                  setCustomSymbol(e.target.value.toUpperCase())
                  setSelectedSymbol('')
                }}
                style={{ width: '140px' }}
                aria-label="Custom symbol"
              />
              <label htmlFor="risk-atr-mult">ATR multiplier</label>
              <input
                id="risk-atr-mult"
                type="number"
                min={0.5}
                max={5}
                step={0.5}
                value={atrMultiplier}
                onChange={e => setAtrMultiplier(parseFloat(e.target.value) || 2)}
                style={{ width: '70px' }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleCompute()}
                disabled={barsLoading || (!selectedSymbol && !customSymbol.trim())}
              >
                {barsLoading ? 'Computing…' : 'Compute'}
              </button>
            </div>
          </div>
        </div>

        {barsError && (
          <p className="msg-error" role="alert" style={{ marginTop: 'var(--space-2)' }}>
            {barsError}
          </p>
        )}

        {atrResult && posResult && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <div className="risk-summary-cards">
              <div className="risk-card">
                <span className="risk-card-label">ATR(14)</span>
                <span className="risk-card-value">{fmtUsd(atrResult.atr14)}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Current price</span>
                <span className="risk-card-value">
                  {currentPrice != null ? fmtUsd(currentPrice) : '—'}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Stop distance ({atrMultiplier}× ATR)</span>
                <span className="risk-card-value">{fmtUsd(posResult.stop_distance)}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Shares</span>
                <span className="risk-card-value">
                  {posResult.is_valid ? posResult.shares.toLocaleString() : '—'}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Dollar risk</span>
                <span className="risk-card-value">
                  {posResult.is_valid ? fmtUsd(posResult.dollar_risk) : '—'}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Risk %</span>
                <span className="risk-card-value">
                  {posResult.is_valid ? `${posResult.risk_pct.toFixed(2)}%` : '—'}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Stop loss (long)</span>
                <span className="risk-card-value">
                  {posResult.is_valid ? fmtUsd(posResult.stop_loss_long) : '—'}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Stop loss (short)</span>
                <span className="risk-card-value">
                  {posResult.is_valid ? fmtUsd(posResult.stop_loss_short) : '—'}
                </span>
              </div>
            </div>
            {!posResult.is_valid && (
              <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
                Position sizing unavailable: requires valid Kelly, ATR &gt; 0, and capital &gt; 0.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
