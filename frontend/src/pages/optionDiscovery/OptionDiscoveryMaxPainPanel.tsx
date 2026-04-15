import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { fetchMaxPainCompute, fetchMaxPainComputeHistory, pollMassiveJobUntilDone, postMassiveSync } from '../../api'
import type { MaxPainComputeResponse, MaxPainHistoryPoint, MaxPainStrikePoint } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  OD_MAX_PAIN_AXIS_FONT,
  OD_MAX_PAIN_PAD_LIABILITY_OI,
  OD_MAX_PAIN_PAD_TREND,
  OD_MAX_PAIN_VIEWBOX_H,
  OD_MAX_PAIN_VIEWBOX_W,
} from './odChartConstants'

const AXIS_FILL = 'var(--od-max-pain-axis-fill, var(--color-text-muted))'

/** X-axis tick row (below plot, above axis title) */
function mpPainXTickY(viewH: number) {
  return viewH - 38
}

/** Bottom axis title row (“Strike”, etc.) */
function mpPainXTitleY(viewH: number) {
  return viewH - 11
}

const DISCLAIMER =
  'Disclaimer: Max Pain is a theoretical reference metric based on end-of-day open interest data. It does not predict future price movement and should not be used as the sole basis for trading decisions. Open interest data is sourced from Massive (Polygon) with approximately 15-minute delay. Corporate actions (splits, special dividends) may affect strike prices and contract multipliers.'

function scaleLin(v: number, vmin: number, vmax: number, outMin: number, outMax: number): number {
  if (!Number.isFinite(v)) return (outMin + outMax) / 2
  if (vmax <= vmin) return (outMin + outMax) / 2
  return outMin + ((v - vmin) / (vmax - vmin)) * (outMax - outMin)
}

function fmtDollarCompact(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}k`
  return `$${v.toFixed(0)}`
}

function pickXTickIndices(n: number, maxTicks: number): number[] {
  if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i)
  const step = (n - 1) / (maxTicks - 1)
  return Array.from({ length: maxTicks }, (_, i) => Math.round(i * step))
}

/** OptionCharts-style stacked bar chart: Call liability (green) + Put liability (red) per strike. */
function LiabilityByStrikeSvg({
  points,
  maxPainStrike,
  underlyingClose,
}: {
  points: MaxPainStrikePoint[]
  maxPainStrike: number
  underlyingClose: number | null
}) {
  const w = OD_MAX_PAIN_VIEWBOX_W
  const h = OD_MAX_PAIN_VIEWBOX_H
  const pad = OD_MAX_PAIN_PAD_LIABILITY_OI
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  if (points.length === 0) return null

  const strikes = points.map(p => p.strike)
  const minS = Math.min(...strikes)
  const maxS = Math.max(...strikes)
  const maxPain = Math.max(1, ...points.map(p => p.pain))

  const n = points.length
  const gap = Math.max(1, innerW * 0.12 / Math.max(n, 1))
  const barW = Math.max(2, (innerW - gap * (n - 1)) / n)
  const halfBar = barW / 2

  const xForStrike = (s: number) => pad.l + scaleLin(s, minS, maxS, halfBar, innerW - halfBar)

  const yTicks = 4
  const yStep = maxPain / yTicks
  const gridLines: ReactElement[] = []
  const yLabels: ReactElement[] = []
  for (let i = 0; i <= yTicks; i++) {
    const val = yStep * i
    const y = pad.t + innerH - scaleLin(val, 0, maxPain, 0, innerH)
    if (i > 0) {
      gridLines.push(
        <line key={`g-${i}`} x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
          stroke="var(--od-max-pain-grid-stroke, var(--color-border-strong))" strokeWidth={0.5} strokeDasharray="3 3" />,
      )
    }
    yLabels.push(
      <text
        key={`yl-${i}`}
        x={pad.l - 10}
        y={y + 4}
        textAnchor="end"
        fontSize={OD_MAX_PAIN_AXIS_FONT}
        fill={AXIS_FILL}
        dominantBaseline="middle"
      >
        {fmtDollarCompact(val)}
      </text>,
    )
  }

  const xTickIdxs = pickXTickIndices(n, 8)

  const mpX = xForStrike(maxPainStrike)
  const ucInRange = underlyingClose != null && Number.isFinite(underlyingClose) &&
    underlyingClose >= minS && underlyingClose <= maxS
  const ucX = ucInRange ? xForStrike(underlyingClose!) : null

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
      aria-label="Seller liability by strike — stacked Call (green) and Put (red) with Max Pain and spot price markers">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />

      {gridLines}
      {yLabels}

      <line x1={pad.l} x2={pad.l + innerW} y1={pad.t + innerH} y2={pad.t + innerH}
        stroke="var(--od-max-pain-axis-line, var(--color-border-strong))" strokeWidth={1} />
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + innerH}
        stroke="var(--od-max-pain-axis-line, var(--color-border-strong))" strokeWidth={1} />

      {points.map((p, i) => {
        const cx = xForStrike(p.strike)
        const y0 = pad.t + innerH
        const putH = scaleLin(p.pain_put, 0, maxPain, 0, innerH)
        const callH = scaleLin(p.pain_call, 0, maxPain, 0, innerH)
        const isMin = p.strike === maxPainStrike
        return (
          <g key={i}>
            <rect x={cx - halfBar} y={y0 - putH} width={barW} height={Math.max(putH, 0.5)}
              fill={isMin ? '#ef5350' : 'var(--color-lamp-red, #ef5350)'} opacity={isMin ? 1 : 0.72} rx={1} />
            <rect x={cx - halfBar} y={y0 - putH - callH} width={barW} height={Math.max(callH, 0.5)}
              fill={isMin ? '#66bb6a' : 'var(--color-lamp-green, #66bb6a)'} opacity={isMin ? 1 : 0.72} rx={1} />
          </g>
        )
      })}

      {Number.isFinite(mpX) && (
        <line x1={mpX} x2={mpX} y1={pad.t} y2={pad.t + innerH}
          stroke="var(--color-accent, #6ea8fe)" strokeWidth={1.5} strokeDasharray="5 3" />
      )}
      {ucX != null && (
        <line x1={ucX} x2={ucX} y1={pad.t} y2={pad.t + innerH}
          stroke="var(--color-text-main, #e0e0e0)" strokeWidth={1.2} strokeDasharray="2 2" />
      )}

      {xTickIdxs.map(i => {
        const p = points[i]
        if (!p) return null
        const x = xForStrike(p.strike)
        return (
          <text
            key={`xt-${i}`}
            x={x}
            y={mpPainXTickY(h)}
            textAnchor="middle"
            fontSize={OD_MAX_PAIN_AXIS_FONT}
            fill={AXIS_FILL}
            dominantBaseline="middle"
          >
            {p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(1)}
          </text>
        )
      })}

      <text
        x={22}
        y={pad.t + innerH / 2}
        fontSize={OD_MAX_PAIN_AXIS_FONT}
        fill={AXIS_FILL}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`rotate(-90 22 ${pad.t + innerH / 2})`}
      >
        Seller liability ($)
      </text>

      <text
        x={pad.l + innerW / 2}
        y={mpPainXTitleY(h)}
        textAnchor="middle"
        fontSize={OD_MAX_PAIN_AXIS_FONT}
        fill={AXIS_FILL}
        dominantBaseline="middle"
      >
        Strike
      </text>
    </svg>
  )
}

function LiabilityLegend({ underlyingClose, maxPainStrike }: {
  underlyingClose: number | null
  maxPainStrike: number
}) {
  return (
    <div className="mp-legend" role="presentation">
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-green, #66bb6a)' }} />
        Call liability
      </span>
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-red, #ef5350)' }} />
        Put liability
      </span>
      <span className="mp-legend-item mp-legend-item-max-pain">
        <span className="mp-legend-swatch mp-legend-line" style={{ borderColor: 'var(--color-accent, #6ea8fe)' }} />
        Max Pain <strong className="mp-legend-max-pain-value">{maxPainStrike.toFixed(2)}</strong>
      </span>
      {underlyingClose != null && Number.isFinite(underlyingClose) && (
        <span className="mp-legend-item">
          <span className="mp-legend-swatch mp-legend-line" style={{ borderColor: 'var(--color-text-main, #e0e0e0)' }} />
          Spot {underlyingClose.toFixed(2)}
        </span>
      )}
    </div>
  )
}

function OiBarsSvg({
  points,
  showCall,
  showPut,
}: {
  points: MaxPainStrikePoint[]
  showCall: boolean
  showPut: boolean
}) {
  const w = OD_MAX_PAIN_VIEWBOX_W
  const h = OD_MAX_PAIN_VIEWBOX_H
  const pad = OD_MAX_PAIN_PAD_LIABILITY_OI
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  if ((!showCall && !showPut) || points.length === 0) return null
  const strikes = points.map(p => p.strike)
  const minS = Math.min(...strikes)
  const maxS = Math.max(...strikes)
  const maxOi = Math.max(
    1,
    ...points.map(p => (showCall ? p.call_oi : 0) + (showPut ? p.put_oi : 0)),
  )
  const n = points.length
  const gap = Math.max(1, innerW * 0.12 / Math.max(n, 1))
  const barW = Math.max(2, (innerW - gap * (n - 1)) / n)
  const halfBar = barW / 2
  const xForStrike = (s: number) => pad.l + scaleLin(s, minS, maxS, halfBar, innerW - halfBar)
  const xTickIdxs = pickXTickIndices(n, 8)
  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`} aria-label="Open interest by strike">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />
      <line x1={pad.l} x2={pad.l + innerW} y1={pad.t + innerH} y2={pad.t + innerH}
        stroke="var(--od-max-pain-axis-line, var(--color-border-strong))" strokeWidth={1} />
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + innerH}
        stroke="var(--od-max-pain-axis-line, var(--color-border-strong))" strokeWidth={1} />
      {points.flatMap((p, i) => {
        const cx = xForStrike(p.strike)
        const y0 = pad.t + innerH
        const out: ReactElement[] = []
        if (showPut && p.put_oi > 0) {
          const bh = scaleLin(p.put_oi, 0, maxOi, 0, innerH)
          out.push(
            <rect key={`p-${i}`} x={cx - halfBar} y={y0 - bh} width={barW} height={bh}
              fill="var(--color-lamp-red)" opacity={0.65} rx={1} />,
          )
        }
        if (showCall && p.call_oi > 0) {
          const putH = showPut ? scaleLin(p.put_oi, 0, maxOi, 0, innerH) : 0
          const bh = scaleLin(p.call_oi, 0, maxOi, 0, innerH)
          out.push(
            <rect key={`c-${i}`} x={cx - halfBar} y={y0 - putH - bh} width={barW} height={bh}
              fill="var(--color-lamp-green)" opacity={0.75} rx={1} />,
          )
        }
        return out
      })}
      {xTickIdxs.map(i => {
        const p = points[i]
        if (!p) return null
        const x = xForStrike(p.strike)
        return (
          <text
            key={`xt-${i}`}
            x={x}
            y={mpPainXTickY(h)}
            textAnchor="middle"
            fontSize={OD_MAX_PAIN_AXIS_FONT}
            fill={AXIS_FILL}
            dominantBaseline="middle"
          >
            {p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(1)}
          </text>
        )
      })}
      <text
        x={pad.l + innerW / 2}
        y={mpPainXTitleY(h)}
        textAnchor="middle"
        fontSize={OD_MAX_PAIN_AXIS_FONT}
        fill={AXIS_FILL}
        dominantBaseline="middle"
      >
        Strike
      </text>
      <text
        x={22}
        y={pad.t + innerH / 2}
        fontSize={OD_MAX_PAIN_AXIS_FONT}
        fill={AXIS_FILL}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`rotate(-90 22 ${pad.t + innerH / 2})`}
      >
        Open Interest
      </text>
    </svg>
  )
}

function TrendSvg({ series }: { series: MaxPainHistoryPoint[] }) {
  const w = OD_MAX_PAIN_VIEWBOX_W
  const h = OD_MAX_PAIN_VIEWBOX_H
  const pad = OD_MAX_PAIN_PAD_TREND
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  if (series.length < 2) {
    return <p className="section-hint">Not enough history for trend (need at least 2 days with OI).</p>
  }
  const mp = series.map(s => s.max_pain_strike)
  const closes = series.map(s => s.underlying_close).filter((x): x is number => x != null && Number.isFinite(x))
  const allVals = [...mp, ...closes]
  const minY = Math.min(...allVals)
  const maxY = Math.max(...allVals)
  const hasClose = closes.length >= 2
  const ptsMp = series
    .map((s, i) => {
      const x = pad.l + scaleLin(i, 0, series.length - 1, 0, innerW)
      const y = pad.t + innerH - scaleLin(s.max_pain_strike, minY, maxY, 0, innerH)
      return `${x},${y}`
    })
    .join(' ')
  const ptsC = hasClose
    ? series
        .map((s, i) => {
          if (s.underlying_close == null || !Number.isFinite(s.underlying_close)) return null
          const x = pad.l + scaleLin(i, 0, series.length - 1, 0, innerW)
          const y = pad.t + innerH - scaleLin(s.underlying_close, minY, maxY, 0, innerH)
          return `${x},${y}`
        })
        .filter(Boolean)
        .join(' ')
    : ''

  const xTickIdxs = pickXTickIndices(series.length, 6)
  const yTicks = 4
  const yStep = (maxY - minY) / yTicks || 1

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`} aria-label="Max pain vs underlying price trend over time">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />
      <line x1={pad.l} x2={pad.l + innerW} y1={pad.t + innerH} y2={pad.t + innerH}
        stroke="var(--od-max-pain-axis-line, var(--color-border-strong))" strokeWidth={1} />
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + innerH}
        stroke="var(--od-max-pain-axis-line, var(--color-border-strong))" strokeWidth={1} />

      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = minY + yStep * i
        const y = pad.t + innerH - scaleLin(val, minY, maxY, 0, innerH)
        return (
          <g key={i}>
            {i > 0 && <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
              stroke="var(--od-max-pain-grid-stroke, var(--color-border-strong))" strokeWidth={0.5} strokeDasharray="3 3" />}
            <text
              x={pad.l - 10}
              y={y + 4}
              textAnchor="end"
              fontSize={OD_MAX_PAIN_AXIS_FONT}
              fill={AXIS_FILL}
              dominantBaseline="middle"
            >
              {val.toFixed(1)}
            </text>
          </g>
        )
      })}

      <polyline fill="none" stroke="var(--color-accent, #6ea8fe)" strokeWidth="2" points={ptsMp} />
      {ptsC && (
        <polyline fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeDasharray="3 2" points={ptsC} />
      )}

      {xTickIdxs.map(i => {
        const s = series[i]
        if (!s) return null
        const x = pad.l + scaleLin(i, 0, series.length - 1, 0, innerW)
        const label = s.trade_date.slice(5)
        return (
          <text
            key={i}
            x={x}
            y={mpPainXTickY(h)}
            textAnchor="middle"
            fontSize={OD_MAX_PAIN_AXIS_FONT}
            fill={AXIS_FILL}
            dominantBaseline="middle"
          >
            {label}
          </text>
        )
      })}

      <text x={w - 14} y={22} textAnchor="end" fontSize={OD_MAX_PAIN_AXIS_FONT}>
        <tspan fill="var(--color-accent, #6ea8fe)">Max Pain</tspan>
        {hasClose ? (
          <>
            <tspan fill="var(--color-text-muted)"> · </tspan>
            <tspan fill="var(--color-text-muted)">Underlying</tspan>
          </>
        ) : null}
      </text>

      <text
        x={22}
        y={pad.t + innerH / 2}
        fontSize={OD_MAX_PAIN_AXIS_FONT}
        fill={AXIS_FILL}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`rotate(-90 22 ${pad.t + innerH / 2})`}
      >
        Price
      </text>
    </svg>
  )
}

export function OptionDiscoveryMaxPainPanel({
  symbol,
  expiration,
  massiveConfigured,
}: {
  symbol: string
  expiration: string
  massiveConfigured: boolean
}) {
  const [live, setLive] = useState<MaxPainComputeResponse | null>(null)
  const [hist, setHist] = useState<MaxPainHistoryPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [trendCollapsed, setTrendCollapsed] = useState(false)
  const [oiBackfillLoading, setOiBackfillLoading] = useState(false)
  const [oiBackfillMsg, setOiBackfillMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)


  const canLoad = massiveConfigured && symbol.trim() !== '' && expiration.trim() !== ''

  const load = useCallback(async () => {
    if (!canLoad) {
      setLive(null)
      setHist([])
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const [c, h] = await Promise.all([
        fetchMaxPainCompute({ symbol, expiry: expiration }),
        fetchMaxPainComputeHistory({ symbol, expiry: expiration, lookbackDays: 90 }),
      ])
      if (!c.ok) {
        setLive(null)
        setErr(c.error ?? 'Max Pain compute failed')
      } else {
        setLive({ ...c, ok: true })
        setErr(null)
      }
      setHist(h.ok ? h.series : [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load Max Pain')
      setLive(null)
      setHist([])
    } finally {
      setLoading(false)
    }
  }, [canLoad, symbol, expiration])

  const backfillOiForSymbol = useCallback(async () => {
    const sym = symbol.trim().toUpperCase()
    if (!massiveConfigured || !sym) return
    setOiBackfillLoading(true)
    setOiBackfillMsg('Backfilling daily OI…')
    setErr(null)
    try {
      const sync = await postMassiveSync('oi', {
        mode: 'watchlist_eod',
        symbols: [sym],
      })
      if (!sync.ok || !sync.job_id) {
        setErr(sync.error ?? sync.message ?? 'Failed to enqueue OI backfill')
        setOiBackfillMsg(null)
        return
      }
      const polled = await pollMassiveJobUntilDone(sync.job_id, { maxAttempts: 180, intervalMs: 1000 })
      if (!polled.ok) {
        setErr(polled.error ?? 'OI backfill job failed')
        setOiBackfillMsg(null)
        return
      }
      setOiBackfillMsg('OI backfill done. Refreshing Max Pain…')
      await load()
      setOiBackfillMsg(
        'OI backfill finished. Historical Trend needs at least 2 distinct trade dates with OI for this expiry.',
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to backfill OI')
      setOiBackfillMsg(null)
    } finally {
      setOiBackfillLoading(false)
    }
  }, [symbol, massiveConfigured, load])

  useEffect(() => {
    void load()
  }, [load])

  const points = useMemo(() => live?.pain_by_strike ?? [], [live])

  if (!massiveConfigured) {
    return (
      <section className="replay-section od-max-pain-section" aria-label="Max Pain">
        <h3 className="od-max-pain-title">
          Max Pain Analysis
          {expiration.trim() ? (
            <span className="od-max-pain-title-exp" aria-label={`Expiration ${expiration}`}>
              · {expiration}
            </span>
          ) : null}
          <InfoTooltip text="Requires Massive API key and EOD open interest in PostgreSQL." />
        </h3>
        <p className="section-hint">Configure Massive under Settings → Feed → Massive Option to enable Max Pain.</p>
      </section>
    )
  }

  if (!symbol.trim() || !expiration.trim()) {
    return null
  }

  return (
    <section className="replay-section od-max-pain-section" aria-labelledby="od-max-pain-head">
      <div className="mp-header-row">
        <h3 id="od-max-pain-head" className="od-max-pain-title">
          Max Pain Analysis
          {expiration.trim() ? (
            <span className="od-max-pain-title-exp" aria-label={`Expiration ${expiration}`}>
              · {expiration}
            </span>
          ) : null}
          <InfoTooltip text="Based on end-of-day open interest from Massive (15 min delayed source). Computed live from PostgreSQL; not read from stored report rows." />
        </h3>
        <div className="od-max-pain-header-actions">
          <button
            type="button"
            className="section-header-icon-btn od-max-pain-refresh-icon-btn"
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? 'Expand Max Pain Analysis' : 'Collapse Max Pain Analysis'}
            aria-label={collapsed ? 'Expand Max Pain Analysis' : 'Collapse Max Pain Analysis'}
            aria-expanded={!collapsed}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={collapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'} />
            </svg>
          </button>
          <button
            type="button"
            className="section-header-icon-btn od-max-pain-refresh-icon-btn"
            onClick={() => void backfillOiForSymbol()}
            disabled={loading || oiBackfillLoading}
            title={
              oiBackfillLoading
                ? 'Backfilling OI history for this symbol'
                : 'Backfill OI history for this symbol and refresh trend'
            }
            aria-label={
              oiBackfillLoading
                ? 'Backfilling OI history for this symbol'
                : 'Backfill OI history for this symbol and refresh trend'
            }
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7 7h10" />
              <path d="M7 12h10" />
              <path d="M7 17h6" />
              <path d="M16 14l3 3-3 3" />
            </svg>
          </button>
          <button
            type="button"
            className="section-header-icon-btn od-max-pain-refresh-icon-btn"
            onClick={() => void load()}
            disabled={loading || oiBackfillLoading}
            title={loading ? 'Loading max pain' : 'Refresh max pain'}
            aria-label={loading ? 'Loading max pain' : 'Refresh max pain'}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {oiBackfillMsg ? <p className="section-hint" role="status">{oiBackfillMsg}</p> : null}
          {loading && !live ? <p className="section-hint">Loading Max Pain…</p> : null}
          {err ? <p className="msg-error" role="alert">{err}</p> : null}
          {live?.ok && live.oi_basis === 'chain_snapshot' ? (
            <p className="section-hint" role="status">
              Open interest is taken from the latest chain snapshots in PostgreSQL (same data as loaded quotes). EOD
              daily OI was not available for this expiry; run watchlist EOD OI sync for classic end-of-day OI.
            </p>
          ) : null}

          {live?.ok && points.length > 0 && (
            <div className="od-max-pain-layout">
              <div className="od-max-pain-metrics-bar">
                <div className="od-max-pain-metrics-inner" role="group" aria-label="Max Pain summary">
                  <div className="od-max-pain-metric-cell">
                    <span className="od-max-pain-card-label">Max Pain</span>
                    <strong>{live.max_pain_strike != null ? live.max_pain_strike.toFixed(2) : '—'}</strong>
                  </div>
                  <div className="od-max-pain-metric-cell">
                    <span className="od-max-pain-card-label">Spot</span>
                    <strong>{live.underlying_close != null ? live.underlying_close.toFixed(2) : '—'}</strong>
                  </div>
                  <div className="od-max-pain-metric-cell">
                    <span className="od-max-pain-card-label">Distance</span>
                    <strong>
                      {live.distance_to_max_pain_pct != null ? `${(live.distance_to_max_pain_pct * 100).toFixed(2)}%` : '—'}
                    </strong>
                  </div>
                  <div className="od-max-pain-metric-cell">
                    <span className="od-max-pain-card-label">Total OI</span>
                    <strong>{live.total_oi != null ? live.total_oi.toLocaleString() : '—'}</strong>
                  </div>
                  <div className="od-max-pain-metric-cell">
                    <span className="od-max-pain-card-label">OI as-of</span>
                    <strong>{live.trade_date ?? '—'}</strong>
                  </div>
                </div>
                {live.recent_corporate_action && (
                  <p className="od-max-pain-corp-warn od-max-pain-corp-warn--below-metrics" role="status">
                    Recent corporate action — verify strikes and multipliers.
                  </p>
                )}
              </div>

              <div className="od-max-pain-charts-scroll">
                <div className="od-max-pain-charts-row">
                  <div className="mp-chart-pane od-max-pain-chart-cell">
                    <h4 className="mp-chart-subtitle mp-chart-subtitle--pane">Seller Liability by Strike</h4>
                    <LiabilityLegend underlyingClose={live.underlying_close ?? null} maxPainStrike={live.max_pain_strike ?? 0} />
                    <LiabilityByStrikeSvg points={points} maxPainStrike={live.max_pain_strike ?? 0}
                      underlyingClose={live.underlying_close ?? null} />
                  </div>

                  <div className="mp-chart-pane od-max-pain-chart-cell">
                    <h4 className="mp-chart-subtitle mp-chart-subtitle--pane">Open Interest by Strike</h4>
                    <OiBarsSvg points={points} showCall showPut />
                  </div>

                  <div className="mp-chart-pane od-max-pain-chart-cell od-max-pain-trend-pane" aria-label="Max Pain and underlying trend">
                    <div className="mp-chart-pane-head">
                      <h4 className="mp-chart-subtitle mp-chart-subtitle--pane">Max Pain · Underlying</h4>
                      <button
                        type="button"
                        className="section-header-icon-btn od-max-pain-refresh-icon-btn"
                        onClick={() => setTrendCollapsed(v => !v)}
                        title={trendCollapsed ? 'Expand chart' : 'Collapse chart'}
                        aria-label={trendCollapsed ? 'Expand Max Pain vs underlying chart' : 'Collapse Max Pain vs underlying chart'}
                        aria-expanded={!trendCollapsed}
                        aria-controls="od-max-pain-trend-chart"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d={trendCollapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'} />
                        </svg>
                      </button>
                    </div>
                    {!trendCollapsed && (
                      <div id="od-max-pain-trend-chart">
                        <TrendSvg series={hist} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <details className="od-max-pain-disclaimer-details">
            <summary className="od-max-pain-disclaimer-summary">Disclaimer</summary>
            <p className="od-max-pain-disclaimer-body">{DISCLAIMER}</p>
          </details>
        </>
      )}
    </section>
  )
}
