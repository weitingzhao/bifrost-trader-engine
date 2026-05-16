import { useEffect, useRef, useState } from 'react'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { fetchGreeks, fetchGreeksAvailableDates } from '../api/research/research'
import type { GreeksRow, GreeksResponse } from '../api/research/research'
import { bsComputeDetail } from '../utils/bsCalc'
import type { BSDetail } from '../utils/bsCalc'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OptionGreeksPageProps {
  /** “Research” breadcrumb → Risk Model. */
  onBreadcrumbResearch?: () => void
  breadcrumbLabel?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtIV(iv: number | null): string {
  if (iv == null) return '—'
  return (iv * 100).toFixed(1) + '%'
}

function fmtGreek(v: number | null, decimals = 4): string {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

function ivClass(iv: number | null): string {
  if (iv == null) return ''
  if (iv < 0.3) return 'greeks-table__iv--low'
  if (iv < 0.8) return 'greeks-table__iv--mid'
  return 'greeks-table__iv--high'
}

function deltaClass(delta: number | null): string {
  if (delta == null) return ''
  const abs = Math.abs(delta)
  if (abs >= 0.4 && abs <= 0.6) return 'greeks-table__delta--atm'
  return ''
}

// Group rows by expiry
function groupByExpiry(rows: GreeksRow[]): Map<string, GreeksRow[]> {
  const map = new Map<string, GreeksRow[]>()
  for (const row of rows) {
    const arr = map.get(row.expiry) ?? []
    arr.push(row)
    map.set(row.expiry, arr)
  }
  return map
}

// ---------------------------------------------------------------------------
// GreeksCalcTooltip
// ---------------------------------------------------------------------------

function fmt4(v: number | null): string {
  return v == null ? '—' : v.toFixed(4)
}

function fmt6(v: number | null): string {
  return v == null ? '—' : v.toFixed(6)
}

function GreeksCalcTooltip({
  row,
  pos,
  riskFreeRate,
}: {
  row: GreeksRow
  pos: { x: number; y: number }
  riskFreeRate: number
}) {
  const detail: BSDetail = bsComputeDetail({
    marketPrice: row.market_price,
    S: row.stock_price,
    K: row.strike,
    tYears: row.t_years,
    r: riskFreeRate,
    right: row.right,
  })

  const { inputs, iv, converged, iterCount, sqrtT, lnSK, d1Numerator, d1Denominator, d1, d2, Nd1, nd1 } = detail

  // Position: offset from cursor so it doesn't cover the row
  const style: React.CSSProperties = {
    left: pos.x + 20,
    top: pos.y - 8,
  }

  return (
    <div className="greeks-calc-tooltip" style={style}>
      <div className="greeks-calc-tooltip__section">
        <div className="greeks-calc-tooltip__heading">输入参数</div>
        <div className="greeks-calc-tooltip__kv">
          <span>S (标的价)</span><span>${inputs.S.toFixed(2)}</span>
          <span>K (行权价)</span><span>${inputs.K.toFixed(2)}</span>
          <span>T</span><span>{inputs.tDays} 天 = {inputs.tYears.toFixed(4)} 年</span>
          <span>r</span><span>{(inputs.r * 100).toFixed(2)}%</span>
          <span>方向</span><span>{inputs.right.toUpperCase() === 'C' ? 'Call' : 'Put'}</span>
          <span>市场价</span><span>${inputs.marketPrice.toFixed(4)}</span>
        </div>
      </div>

      <div className="greeks-calc-tooltip__section">
        <div className="greeks-calc-tooltip__heading">IV (Newton-Raphson)</div>
        {iv != null ? (
          <div className="greeks-calc-tooltip__mono">
            初始 σ = 0.300 → {iterCount} 次迭代 → IV = <strong>{(iv * 100).toFixed(2)}%</strong>
            {!converged && <span className="greeks-calc-tooltip__warn"> (未精确收敛)</span>}
          </div>
        ) : (
          <div className="greeks-calc-tooltip__mono greeks-calc-tooltip__warn">IV 求解失败（深度 ITM/OTM 或价格异常）</div>
        )}
      </div>

      {iv != null && d1 != null && d2 != null && (
        <>
          <div className="greeks-calc-tooltip__section">
            <div className="greeks-calc-tooltip__heading">Black-Scholes d₁ / d₂</div>
            <div className="greeks-calc-tooltip__mono">
              d₁ = [ln(S/K) + (r + σ²/2)·T] / (σ√T)<br />
              {'   '}ln(S/K) = {lnSK != null ? lnSK.toFixed(5) : '—'}<br />
              {'   '}(r + σ²/2)·T = {d1Numerator != null && lnSK != null ? (d1Numerator - lnSK).toFixed(5) : '—'}<br />
              {'   '}σ√T = {d1Denominator != null ? d1Denominator.toFixed(5) : '—'}{'  '}(σ={fmt4(iv)}, √T={sqrtT != null ? sqrtT.toFixed(5) : '—'})<br />
              {'   '}d₁ = {fmt6(d1Numerator)} / {fmt6(d1Denominator)} = <strong>{fmt4(d1)}</strong><br />
              {'   '}d₂ = {fmt4(d1)} − {sqrtT != null ? (iv * sqrtT).toFixed(4) : '—'} = <strong>{fmt4(d2)}</strong>
            </div>
          </div>

          <div className="greeks-calc-tooltip__section">
            <div className="greeks-calc-tooltip__heading">Greeks</div>
            <div className="greeks-calc-tooltip__kv">
              <span>Δ</span>
              <span>
                {inputs.right.toUpperCase() === 'C'
                  ? `N(d₁) = N(${fmt4(d1)}) = ${fmt4(Nd1)}`
                  : `N(d₁)−1 = ${fmt4(Nd1)}−1 = ${fmt4(detail.delta)}`}
              </span>
              <span>Γ</span>
              <span>n(d₁)/(S·σ·√T) = {fmt4(nd1)}/({inputs.S.toFixed(2)}·{fmt4(iv)}·{sqrtT != null ? sqrtT.toFixed(4) : '—'}) = {fmt4(detail.gamma)}</span>
              <span>Θ/日</span>
              <span>{fmt4(detail.thetaPerDay)} $/day</span>
              <span>ν/1%</span>
              <span>S·n(d₁)·√T×0.01 = {inputs.S.toFixed(2)}·{fmt4(nd1)}·{sqrtT != null ? sqrtT.toFixed(4) : '—'}×0.01 = {fmt4(detail.vegaPer1Pct)}</span>
            </div>
          </div>

          {detail.bsModelPrice != null && (
            <div className="greeks-calc-tooltip__section greeks-calc-tooltip__section--footer">
              BS 理论价 = {detail.bsModelPrice.toFixed(4)}{'  '}
              误差 = {Math.abs(detail.bsModelPrice - inputs.marketPrice).toFixed(4)}
              {' '}({inputs.marketPrice > 0 ? ((Math.abs(detail.bsModelPrice - inputs.marketPrice) / inputs.marketPrice) * 100).toFixed(2) : '—'}%)
            </div>
          )}
        </>
      )}

      {/* Comparison with server-computed values */}
      {iv != null && (row.iv != null || row.delta != null) && (
        <div className="greeks-calc-tooltip__section greeks-calc-tooltip__section--compare">
          <div className="greeks-calc-tooltip__heading">与服务端对比</div>
          <div className="greeks-calc-tooltip__kv greeks-calc-tooltip__kv--compare">
            <span></span><span className="greeks-calc-tooltip__col-label">服务端</span><span className="greeks-calc-tooltip__col-label">本地</span>
            {row.iv != null && <><span>IV</span><span>{fmtIV(row.iv)}</span><span>{fmtIV(iv)}</span></>}
            {row.delta != null && <><span>Δ</span><span>{fmtGreek(row.delta, 4)}</span><span>{fmtGreek(detail.delta, 4)}</span></>}
            {row.gamma != null && <><span>Γ</span><span>{fmtGreek(row.gamma, 4)}</span><span>{fmtGreek(detail.gamma, 4)}</span></>}
            {row.theta != null && <><span>Θ/日</span><span>{fmtGreek(row.theta, 4)}</span><span>{fmtGreek(detail.thetaPerDay, 4)}</span></>}
            {row.vega != null && <><span>ν/1%</span><span>{fmtGreek(row.vega, 4)}</span><span>{fmtGreek(detail.vegaPer1Pct, 4)}</span></>}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface GreeksTableGroupProps {
  expiry: string
  rows: GreeksRow[]
  dte: number
  riskFreeRate: number
  onRowHover: (row: GreeksRow | null, e: React.MouseEvent | null) => void
}

function GreeksTableGroup({ expiry, rows, dte, riskFreeRate: _riskFreeRate, onRowHover }: GreeksTableGroupProps) {
  return (
    <tbody>
      <tr className="greeks-table__expiry-header">
        <td colSpan={10}>
          <strong>{expiry}</strong>
          <span className="greeks-table__dte-badge">{dte}d</span>
        </td>
      </tr>
      {rows.map((row, i) => (
        <tr
          key={`${row.expiry}-${row.strike}-${row.right}-${i}`}
          className={`greeks-table__row greeks-table__row--${row.right.toLowerCase()}`}
          onMouseEnter={e => onRowHover(row, e)}
          onMouseMove={e => onRowHover(row, e)}
          onMouseLeave={() => onRowHover(null, null)}
        >
          <td />
          <td />
          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.strike.toFixed(1)}</td>
          <td>
            <span className={`greeks-table__right-badge greeks-table__right-badge--${row.right.toLowerCase()}`}>
              {row.right}
            </span>
          </td>
          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.market_price.toFixed(2)}</td>
          <td>
            <span className={ivClass(row.iv)} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtIV(row.iv)}
            </span>
          </td>
          <td>
            <span className={deltaClass(row.delta)} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtGreek(row.delta, 3)}
            </span>
          </td>
          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtGreek(row.gamma, 4)}</td>
          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtGreek(row.theta, 4)}</td>
          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtGreek(row.vega, 4)}</td>
        </tr>
      ))}
    </tbody>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function OptionGreeksPage({ onBreadcrumbResearch, breadcrumbLabel = 'IV & Greeks' }: OptionGreeksPageProps) {
  const [symbol, setSymbol] = useState('NVDA')
  const [symbolInput, setSymbolInput] = useState('NVDA')
  const [tradeDate, setTradeDate] = useState('')
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [riskFreeRate, setRiskFreeRate] = useState(0.045)
  const [rightFilter, setRightFilter] = useState<'ALL' | 'C' | 'P'>('ALL')
  const [result, setResult] = useState<GreeksResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [datesLoading, setDatesLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Tooltip state
  const [hoveredRow, setHoveredRow] = useState<GreeksRow | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const tooltipTimerRef = useRef<number | null>(null)

  function handleRowHover(row: GreeksRow | null, e: React.MouseEvent | null) {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    if (row == null || e == null) {
      tooltipTimerRef.current = window.setTimeout(() => setHoveredRow(null), 80)
      return
    }
    setTooltipPos({ x: e.clientX, y: e.clientY })
    setHoveredRow(row)
  }

  // Load available dates when symbol changes
  useEffect(() => {
    if (!symbol) return
    setDatesLoading(true)
    setAvailableDates([])
    setTradeDate('')
    fetchGreeksAvailableDates(symbol).then(res => {
      setDatesLoading(false)
      if (res.ok && res.dates.length > 0) {
        setAvailableDates(res.dates)
        setTradeDate(res.dates[0])
      }
    }).catch(() => setDatesLoading(false))
  }, [symbol])

  function handleLoad() {
    if (!symbol || !tradeDate) return
    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    setResult(null)

    const params: Parameters<typeof fetchGreeks>[0] = {
      symbol,
      trade_date: tradeDate,
      risk_free_rate: riskFreeRate,
      limit: 1000,
    }
    if (rightFilter !== 'ALL') params.right = rightFilter

    fetchGreeks(params).then(res => {
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? 'Request failed')
        return
      }
      setResult(res)
    }).catch(e => {
      setLoading(false)
      setError(e instanceof Error ? e.message : 'fetch failed')
    })
  }

  function handleSymbolSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = symbolInput.trim().toUpperCase()
    if (s && s !== symbol) setSymbol(s)
  }

  // Build grouped data
  const grouped = result ? groupByExpiry(result.rows) : new Map<string, GreeksRow[]>()
  const today = tradeDate ? new Date(tradeDate) : new Date()

  return (
    <div className="card process-section option-greeks-page">
      <div className="research-page-head">
        <SectionPageTitle
          menu="Research"
          pageTitle={breadcrumbLabel}
          onMenuClick={onBreadcrumbResearch}
          menuNavigateAriaLabel="Research home"
          infoText="Historical option greeks from the research API: pick symbol and trade date, then fetch chain rows."
          style={{ margin: 0 }}
        />
      </div>

      {/* Controls */}
      <div className="option-greeks-page__controls card">
        <div className="option-greeks-page__controls-inner">
          {/* Symbol */}
          <form onSubmit={handleSymbolSubmit} style={{ display: 'contents' }}>
            <div className="option-greeks-page__field">
              <label className="option-greeks-page__label" htmlFor="greeks-symbol">Symbol</label>
              <input
                id="greeks-symbol"
                className="option-greeks-page__input"
                type="text"
                value={symbolInput}
                onChange={e => setSymbolInput(e.target.value.toUpperCase())}
                onBlur={handleSymbolSubmit}
                placeholder="NVDA"
                style={{ width: 90, textTransform: 'uppercase' }}
              />
            </div>
          </form>

          {/* Date */}
          <div className="option-greeks-page__field">
            <label className="option-greeks-page__label" htmlFor="greeks-date">
              Trade Date {datesLoading && <span className="option-greeks-page__loading-dots">…</span>}
            </label>
            <select
              id="greeks-date"
              className="option-greeks-page__select"
              value={tradeDate}
              onChange={e => setTradeDate(e.target.value)}
              disabled={availableDates.length === 0}
            >
              {availableDates.length === 0 && <option value="">— no data —</option>}
              {availableDates.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          {/* Risk-free rate */}
          <div className="option-greeks-page__field">
            <label className="option-greeks-page__label" htmlFor="greeks-rfr">Risk-free Rate</label>
            <input
              id="greeks-rfr"
              className="option-greeks-page__input"
              type="number"
              value={riskFreeRate}
              onChange={e => setRiskFreeRate(Number(e.target.value))}
              min={0.001}
              max={0.2}
              step={0.001}
              style={{ width: 80 }}
            />
          </div>

          {/* C/P filter */}
          <div className="option-greeks-page__field">
            <label className="option-greeks-page__label">C / P</label>
            <div className="option-greeks-page__toggle-group">
              {(['ALL', 'C', 'P'] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  className={`option-greeks-page__toggle${rightFilter === v ? ' option-greeks-page__toggle--active' : ''}`}
                  onClick={() => setRightFilter(v)}
                >
                  {v === 'ALL' ? 'All' : v}
                </button>
              ))}
            </div>
          </div>

          {/* Load */}
          <button
            type="button"
            className="option-greeks-page__load-btn btn btn-primary"
            onClick={handleLoad}
            disabled={loading || !symbol || !tradeDate}
          >
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>
      </div>

      {/* Info bar */}
      {result && (
        <div className="option-greeks-page__info-bar">
          <span className="option-greeks-page__info-item">
            <span className="option-greeks-page__info-label">Symbol</span>
            <strong>{result.symbol}</strong>
          </span>
          <span className="option-greeks-page__info-item">
            <span className="option-greeks-page__info-label">Trade Date</span>
            <strong>{result.trade_date}</strong>
          </span>
          {result.stock_price != null && (
            <span className="option-greeks-page__info-item">
              <span className="option-greeks-page__info-label">Stock Price</span>
              <strong>${result.stock_price.toFixed(2)}</strong>
            </span>
          )}
          <span className="option-greeks-page__info-item">
            <span className="option-greeks-page__info-label">r</span>
            <strong>{(result.risk_free_rate * 100).toFixed(2)}%</strong>
          </span>
          <span className="option-greeks-page__info-item">
            <span className="option-greeks-page__info-label">Contracts</span>
            <strong>{result.count.toLocaleString()}</strong>
          </span>
          <span className="option-greeks-page__info-approx">
            Black-Scholes (European approximation for American options) · Hover row for BS detail
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="option-greeks-page__error">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="option-greeks-page__loading">
          <span>Computing IV & Greeks…</span>
        </div>
      )}

      {/* Main table */}
      {result && result.rows.length > 0 && (
        <div className="option-greeks-page__table-wrap feed-massive-table-wrap">
          <table className="data-table greeks-table">
            <thead>
              <tr>
                <th scope="col">Expiry</th>
                <th scope="col">DTE</th>
                <th scope="col">Strike</th>
                <th scope="col">C/P</th>
                <th scope="col">Mkt Price</th>
                <th scope="col">IV</th>
                <th scope="col">Delta</th>
                <th scope="col">Gamma</th>
                <th scope="col">Theta/d</th>
                <th scope="col">Vega/1%</th>
              </tr>
            </thead>
            {Array.from(grouped.entries()).map(([expiry, rows]) => {
              const dte = Math.round((new Date(expiry).getTime() - today.getTime()) / 86400000)
              return (
                <GreeksTableGroup
                  key={expiry}
                  expiry={expiry}
                  rows={rows}
                  dte={Math.max(0, dte)}
                  riskFreeRate={riskFreeRate}
                  onRowHover={handleRowHover}
                />
              )
            })}
          </table>
        </div>
      )}

      {/* Empty state */}
      {result && result.rows.length === 0 && !loading && (
        <div className="option-greeks-page__empty">
          No option data found for {result.symbol} on {result.trade_date}.
        </div>
      )}

      {/* Hover tooltip — portal to body coordinates */}
      {hoveredRow && (
        <GreeksCalcTooltip
          row={hoveredRow}
          pos={tooltipPos}
          riskFreeRate={riskFreeRate}
        />
      )}
    </div>
  )
}
