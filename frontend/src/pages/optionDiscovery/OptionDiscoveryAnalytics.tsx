import { useMemo } from 'react'
import type { OptionSnapshotRow } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import { OD_CHART_AXIS_FONT } from './odChartConstants'

function scaleLin(v: number, vmin: number, vmax: number, outMin: number, outMax: number): number {
  if (!Number.isFinite(v)) return (outMin + outMax) / 2
  if (vmax <= vmin) return (outMin + outMax) / 2
  return outMin + ((v - vmin) / (vmax - vmin)) * (outMax - outMin)
}

function pickXTickIndices(n: number, maxTicks: number): number[] {
  if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i)
  const step = (n - 1) / (maxTicks - 1)
  return Array.from({ length: maxTicks }, (_, i) => Math.round(i * step))
}

function fmtIv(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

function fmtOiCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

// ---------------------------------------------------------------------------
// IV Smile Chart
// ---------------------------------------------------------------------------

interface IvPoint { strike: number; iv: number }

export function IvSmileChart({
  rows,
  underlying,
  side = 'both',
}: {
  rows: OptionSnapshotRow[]
  underlying: number | null
  side?: 'call' | 'put' | 'both'
}) {
  const { callPts, putPts } = useMemo(() => {
    const c: IvPoint[] = []
    const p: IvPoint[] = []
    for (const r of rows) {
      if (r.iv == null || !Number.isFinite(r.iv)) continue
      const right = (r.right || '').trim().toUpperCase()
      if (right === 'C' || right === 'CALL') c.push({ strike: r.strike, iv: r.iv })
      else if (right === 'P' || right === 'PUT') p.push({ strike: r.strike, iv: r.iv })
    }
    c.sort((a, b) => a.strike - b.strike)
    p.sort((a, b) => a.strike - b.strike)
    return { callPts: c, putPts: p }
  }, [rows])

  const showCall = side === 'call' || side === 'both'
  const showPut = side === 'put' || side === 'both'
  const activePts = [...(showCall ? callPts : []), ...(showPut ? putPts : [])]

  if (activePts.length < 2) {
    return <p className="section-hint">Not enough IV data for smile chart.</p>
  }

  const w = 640
  const h = 240
  const pad = { l: 52, r: 24, t: 20, b: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b

  const allStrikes = [...new Set(activePts.map(p => p.strike))].sort((a, b) => a - b)
  const allIvs = activePts.map(p => p.iv)
  const minS = Math.min(...allStrikes)
  const maxS = Math.max(...allStrikes)
  const minIv = Math.min(...allIvs)
  const maxIv = Math.max(...allIvs)
  const ivPad = (maxIv - minIv) * 0.08 || 0.01
  const ivLo = Math.max(0, minIv - ivPad)
  const ivHi = maxIv + ivPad

  const xFor = (s: number) => pad.l + scaleLin(s, minS, maxS, 0, innerW)
  const yFor = (iv: number) => pad.t + innerH - scaleLin(iv, ivLo, ivHi, 0, innerH)

  const makePoly = (pts: IvPoint[]) =>
    pts.map(p => `${xFor(p.strike)},${yFor(p.iv)}`).join(' ')

  const ucInRange = underlying != null && Number.isFinite(underlying) && underlying >= minS && underlying <= maxS
  const ucX = ucInRange ? xFor(underlying!) : null

  const yTicks = 4
  const yStep = (ivHi - ivLo) / yTicks
  const xTickIdxs = pickXTickIndices(allStrikes.length, 8)

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
      aria-label="IV smile chart showing implied volatility by strike for calls and puts">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />

      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = ivLo + yStep * i
        const y = yFor(val)
        return (
          <g key={i}>
            {i > 0 && <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
              stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="3 3" />}
            <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
              fill="var(--color-text-dim)">{fmtIv(val)}</text>
          </g>
        )
      })}

      {showCall && callPts.length >= 2 && (
        <polyline fill="none" stroke="var(--color-lamp-green, #66bb6a)" strokeWidth="2"
          points={makePoly(callPts)} />
      )}
      {showPut && putPts.length >= 2 && (
        <polyline fill="none" stroke="var(--color-lamp-red, #ef5350)" strokeWidth="2"
          points={makePoly(putPts)} />
      )}

      {showCall && callPts.map((p, i) => (
        <circle key={`c-${i}`} cx={xFor(p.strike)} cy={yFor(p.iv)} r={2.5}
          fill="var(--color-lamp-green, #66bb6a)" />
      ))}
      {showPut && putPts.map((p, i) => (
        <circle key={`p-${i}`} cx={xFor(p.strike)} cy={yFor(p.iv)} r={2.5}
          fill="var(--color-lamp-red, #ef5350)" />
      ))}

      {ucX != null && (
        <line x1={ucX} x2={ucX} y1={pad.t} y2={pad.t + innerH}
          stroke="var(--color-text-main, #e0e0e0)" strokeWidth={1.2} strokeDasharray="2 2" />
      )}

      {xTickIdxs.map(i => {
        const s = allStrikes[i]
        if (s == null) return null
        return (
          <text key={i} x={xFor(s)} y={h - 8} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
            fill="var(--color-text-dim)">{s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}</text>
        )
      })}

      <text x={pad.l - 4} y={pad.t - 6} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
        fill="var(--color-text-dim)">IV</text>
      <text x={pad.l + innerW / 2} y={h - 0} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
        fill="var(--color-text-dim)">Strike</text>
    </svg>
  )
}

export function IvSmileLegend({ side = 'both', underlying }: { side?: 'call' | 'put' | 'both'; underlying: number | null }) {
  return (
    <div className="mp-legend" role="presentation">
      {(side === 'call' || side === 'both') && (
        <span className="mp-legend-item">
          <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-green, #66bb6a)' }} />
          Call IV
        </span>
      )}
      {(side === 'put' || side === 'both') && (
        <span className="mp-legend-item">
          <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-red, #ef5350)' }} />
          Put IV
        </span>
      )}
      {underlying != null && Number.isFinite(underlying) && (
        <span className="mp-legend-item">
          <span className="mp-legend-swatch mp-legend-line" style={{ borderColor: 'var(--color-text-main, #e0e0e0)' }} />
          Spot {underlying.toFixed(2)}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OI Profile Chart
// ---------------------------------------------------------------------------

interface OiStrike { strike: number; callOi: number; putOi: number }

export function OiProfileChart({ rows, underlying }: {
  rows: OptionSnapshotRow[]
  underlying: number | null
}) {
  const data = useMemo(() => {
    const map = new Map<number, OiStrike>()
    for (const r of rows) {
      const oi = r.open_interest
      if (oi == null || !Number.isFinite(oi) || oi <= 0) continue
      const right = (r.right || '').trim().toUpperCase()
      const existing = map.get(r.strike) ?? { strike: r.strike, callOi: 0, putOi: 0 }
      if (right === 'C' || right === 'CALL') existing.callOi += oi
      else if (right === 'P' || right === 'PUT') existing.putOi += oi
      map.set(r.strike, existing)
    }
    return [...map.values()].sort((a, b) => a.strike - b.strike)
  }, [rows])

  if (data.length < 2) {
    return <p className="section-hint">Not enough OI data for profile chart.</p>
  }

  const w = 640
  const h = 220
  const pad = { l: 52, r: 24, t: 16, b: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b

  const strikes = data.map(d => d.strike)
  const minS = Math.min(...strikes)
  const maxS = Math.max(...strikes)
  const maxOi = Math.max(1, ...data.map(d => d.callOi + d.putOi))

  const n = data.length
  const gap = Math.max(1, innerW * 0.12 / Math.max(n, 1))
  const barW = Math.max(2, (innerW - gap * (n - 1)) / n)
  const halfBar = barW / 2

  const xFor = (s: number) => pad.l + scaleLin(s, minS, maxS, halfBar, innerW - halfBar)

  const ucInRange = underlying != null && Number.isFinite(underlying) && underlying >= minS && underlying <= maxS
  const ucX = ucInRange ? xFor(underlying!) : null

  const yTicks = 3
  const yStep = maxOi / yTicks
  const xTickIdxs = pickXTickIndices(n, 8)

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
      aria-label="Open interest distribution by strike showing Call and Put OI as stacked bars">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />

      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = yStep * i
        const y = pad.t + innerH - scaleLin(val, 0, maxOi, 0, innerH)
        return (
          <g key={i}>
            {i > 0 && <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
              stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="3 3" />}
            <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
              fill="var(--color-text-dim)">{fmtOiCompact(val)}</text>
          </g>
        )
      })}

      {data.map((d, i) => {
        const cx = xFor(d.strike)
        const y0 = pad.t + innerH
        const putH = scaleLin(d.putOi, 0, maxOi, 0, innerH)
        const callH = scaleLin(d.callOi, 0, maxOi, 0, innerH)
        return (
          <g key={i}>
            <rect x={cx - halfBar} y={y0 - putH} width={barW} height={Math.max(putH, 0.5)}
              fill="var(--color-lamp-red, #ef5350)" opacity={0.72} rx={1} />
            <rect x={cx - halfBar} y={y0 - putH - callH} width={barW} height={Math.max(callH, 0.5)}
              fill="var(--color-lamp-green, #66bb6a)" opacity={0.72} rx={1} />
          </g>
        )
      })}

      {ucX != null && (
        <line x1={ucX} x2={ucX} y1={pad.t - 2} y2={pad.t + innerH + 2}
          stroke="var(--color-text-main, #e0e0e0)" strokeWidth={1.2} strokeDasharray="2 2" />
      )}

      {xTickIdxs.map(i => {
        const d = data[i]
        if (!d) return null
        return (
          <text key={i} x={xFor(d.strike)} y={h - 8} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
            fill="var(--color-text-dim)">{d.strike % 1 === 0 ? d.strike.toFixed(0) : d.strike.toFixed(1)}</text>
        )
      })}

      <text x={pad.l - 4} y={pad.t - 2} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
        fill="var(--color-text-dim)">Open Interest</text>
      <text x={pad.l + innerW / 2} y={h - 0} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
        fill="var(--color-text-dim)">Strike</text>
    </svg>
  )
}

export function OiProfileLegend({ underlying }: { underlying: number | null }) {
  return (
    <div className="mp-legend" role="presentation">
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-green, #66bb6a)' }} />
        Call OI
      </span>
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-red, #ef5350)' }} />
        Put OI
      </span>
      {underlying != null && Number.isFinite(underlying) && (
        <span className="mp-legend-item">
          <span className="mp-legend-swatch mp-legend-line" style={{ borderColor: 'var(--color-text-main, #e0e0e0)' }} />
          Spot {underlying.toFixed(2)}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skew Summary
// ---------------------------------------------------------------------------

export function SkewSummary({ rows, underlying }: {
  rows: OptionSnapshotRow[]
  underlying: number | null
}) {
  const result = useMemo(() => {
    if (underlying == null || !Number.isFinite(underlying) || underlying <= 0) return null
    const otmPuts = rows
      .filter(r => (r.right || '').toUpperCase() === 'P' && r.strike < underlying && r.iv != null && Number.isFinite(r.iv!))
      .sort((a, b) => b.strike - a.strike)
      .slice(0, 4)
    const otmCalls = rows
      .filter(r => (r.right || '').toUpperCase() === 'C' && r.strike > underlying && r.iv != null && Number.isFinite(r.iv!))
      .sort((a, b) => a.strike - b.strike)
      .slice(0, 4)
    if (otmPuts.length === 0 || otmCalls.length === 0) return null
    const putIvAvg = otmPuts.reduce((s, r) => s + r.iv!, 0) / otmPuts.length
    const callIvAvg = otmCalls.reduce((s, r) => s + r.iv!, 0) / otmCalls.length
    const spread = putIvAvg - callIvAvg
    const ratio = callIvAvg > 1e-8 ? putIvAvg / callIvAvg : null
    return { putIvAvg, callIvAvg, spread, ratio, putCount: otmPuts.length, callCount: otmCalls.length }
  }, [rows, underlying])

  if (!result) {
    return (
      <div className="od-analytics-skew">
        <span className="od-analytics-skew-label">Put–Call IV Skew</span>
        <span className="od-analytics-skew-val">—</span>
        <span className="od-analytics-skew-hint">Need spot and OTM contracts with IV.</span>
      </div>
    )
  }

  const skewSign = result.spread > 0 ? 'put-heavy' : result.spread < -0.005 ? 'call-heavy' : 'neutral'

  return (
    <div className="od-analytics-skew">
      <span className="od-analytics-skew-label">
        Put–Call IV Skew
        <InfoTooltip text="Approx. difference between average OTM Put IV and OTM Call IV (nearest 4 strikes each side). Positive = put skew (downside premium)." />
      </span>
      <span className={`od-analytics-skew-val od-analytics-skew-val--${skewSign}`}>
        {result.spread >= 0 ? '+' : ''}{(result.spread * 100).toFixed(2)} pts
      </span>
      <span className="od-analytics-skew-detail">
        Put IV avg {fmtIv(result.putIvAvg)} ({result.putCount}) · Call IV avg {fmtIv(result.callIvAvg)} ({result.callCount})
        {result.ratio != null && ` · P/C ratio ${result.ratio.toFixed(2)}`}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// IV Term Structure Chart (Phase 2)
// ---------------------------------------------------------------------------

export interface IvTermPoint {
  expiration: string
  dte_days: number
  atm_iv: number | null
  iv_call?: number | null
  iv_put?: number | null
  strike?: number
}

export function IvTermStructureChart({ points }: { points: IvTermPoint[] }) {
  const valid = useMemo(() =>
    points.filter(p => p.atm_iv != null && Number.isFinite(p.atm_iv!) && p.dte_days >= 0)
      .sort((a, b) => a.dte_days - b.dte_days),
    [points],
  )

  if (valid.length < 2) {
    return <p className="section-hint">Not enough term structure data (need at least 2 expirations with ATM IV).</p>
  }

  const w = 640
  const h = 220
  const pad = { l: 52, r: 24, t: 20, b: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b

  const dtes = valid.map(p => p.dte_days)
  const ivs = valid.map(p => p.atm_iv!)
  const minD = Math.min(...dtes)
  const maxD = Math.max(...dtes)
  const minIv = Math.min(...ivs)
  const maxIv = Math.max(...ivs)
  const ivPad = (maxIv - minIv) * 0.1 || 0.01
  const ivLo = Math.max(0, minIv - ivPad)
  const ivHi = maxIv + ivPad

  const xFor = (d: number) => pad.l + scaleLin(d, minD, maxD, 0, innerW)
  const yFor = (iv: number) => pad.t + innerH - scaleLin(iv, ivLo, ivHi, 0, innerH)

  const pts = valid.map(p => `${xFor(p.dte_days)},${yFor(p.atm_iv!)}`).join(' ')

  const yTicks = 4
  const yStep = (ivHi - ivLo) / yTicks

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
      aria-label="IV term structure showing ATM implied volatility across expiration dates">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />

      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = ivLo + yStep * i
        const y = yFor(val)
        return (
          <g key={i}>
            {i > 0 && <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
              stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="3 3" />}
            <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
              fill="var(--color-text-dim)">{fmtIv(val)}</text>
          </g>
        )
      })}

      <polyline fill="none" stroke="var(--color-accent, #6ea8fe)" strokeWidth="2" points={pts} />
      {valid.map((p, i) => (
        <circle key={i} cx={xFor(p.dte_days)} cy={yFor(p.atm_iv!)} r={3}
          fill="var(--color-accent, #6ea8fe)" />
      ))}

      {valid.map((p, i) => (
        <text key={`l-${i}`} x={xFor(p.dte_days)} y={h - 6} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
          fill="var(--color-text-dim)">{p.dte_days}d</text>
      ))}

      <text x={pad.l - 4} y={pad.t - 6} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
        fill="var(--color-text-dim)">ATM IV</text>
      <text x={pad.l + innerW / 2} y={h - 0} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
        fill="var(--color-text-dim)">Days to Expiration</text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Combined analytics panel — vertical stack (no tabs)
// ---------------------------------------------------------------------------

export function OptionDiscoveryAnalyticsPanel({
  rows,
  underlying,
  termPoints,
  termLoading,
  onLoadTerm,
}: {
  rows: OptionSnapshotRow[]
  underlying: number | null
  termPoints?: IvTermPoint[]
  termLoading?: boolean
  onLoadTerm?: () => void
}) {
  const hasIv = rows.some(r => r.iv != null && Number.isFinite(r.iv!))
  const hasOi = rows.some(r => r.open_interest != null && Number.isFinite(r.open_interest!) && r.open_interest! > 0)

  if (!hasIv && !hasOi) return null

  return (
    <section className="replay-section od-analytics-section" aria-label="Option analytics">
      <h3 className="od-analytics-title">
        Option Analytics
        <InfoTooltip text="Derived from current-expiry snapshot data (Massive, ~15 min delayed). IV Smile and OI by strike for loaded contracts." />
      </h3>
      <p className="section-hint" style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>
        Scoped to the selected strike window.
      </p>

      <div className="od-charts-grid">
        {hasIv && (
          <div className="mp-chart-pane">
            <h4 className="mp-chart-subtitle">IV Smile</h4>
            <IvSmileLegend underlying={underlying} />
            <IvSmileChart rows={rows} underlying={underlying} />
            <SkewSummary rows={rows} underlying={underlying} />
          </div>
        )}

        {hasOi && (
          <div className="mp-chart-pane">
            <h4 className="mp-chart-subtitle">Open Interest Profile</h4>
            <OiProfileLegend underlying={underlying} />
            <OiProfileChart rows={rows} underlying={underlying} />
          </div>
        )}

        <div className="mp-chart-pane od-chart-pane-span2">
          <h4 className="mp-chart-subtitle">IV Term Structure</h4>
          {termPoints && termPoints.length >= 2 ? (
            <IvTermStructureChart points={termPoints} />
          ) : (
            <div className="od-analytics-term-prompt">
              {termLoading ? (
                <p className="section-hint">Loading term structure…</p>
              ) : (
                <>
                  <p className="section-hint">
                    IV term structure compares ATM implied volatility across multiple expiration dates.
                  </p>
                  {onLoadTerm && (
                    <button type="button" className="button button-secondary button-sm"
                      disabled={termLoading} onClick={onLoadTerm}>
                      Load IV term structure
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

