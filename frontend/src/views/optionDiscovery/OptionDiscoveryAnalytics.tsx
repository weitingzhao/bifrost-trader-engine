import { useMemo, useState } from 'react'
import type { IvVolatilityConePoint, OptionSnapshotRow } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import { OdChartExpandOnHover } from './OdChartExpandOnHover'
import {
  OD_ANALYTICS_AXIS_TICK_FILL,
  OD_ANALYTICS_AXIS_TITLE_FILL,
  OD_CHART_AXIS_FONT,
  OD_CHART_AXIS_FONT_IV_TERM,
  OD_IV_TERM_PAD,
  OD_IV_TERM_VIEWBOX_H,
  OD_IV_TERM_VIEWBOX_W,
  OD_IV_TERM_Y_AXIS_TITLE_Y,
  odIvTermXAxisTitleY,
  odIvTermXTickY,
} from './odChartConstants'

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
              fill={OD_ANALYTICS_AXIS_TICK_FILL}>{fmtIv(val)}</text>
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
            fill={OD_ANALYTICS_AXIS_TICK_FILL}>{s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}</text>
        )
      })}

      <text x={pad.l - 4} y={pad.t - 6} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
        fill={OD_ANALYTICS_AXIS_TITLE_FILL}>IV</text>
      <text x={pad.l + innerW / 2} y={h - 0} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
        fill={OD_ANALYTICS_AXIS_TITLE_FILL}>Strike</text>
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
  const h = 240
  const pad = { l: 52, r: 24, t: 20, b: 40 }
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
              fill={OD_ANALYTICS_AXIS_TICK_FILL}>{fmtOiCompact(val)}</text>
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
            fill={OD_ANALYTICS_AXIS_TICK_FILL}>{d.strike % 1 === 0 ? d.strike.toFixed(0) : d.strike.toFixed(1)}</text>
        )
      })}

      <text x={pad.l - 4} y={pad.t - 2} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
        fill={OD_ANALYTICS_AXIS_TITLE_FILL}>Open Interest</text>
      <text x={pad.l + innerW / 2} y={h - 0} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
        fill={OD_ANALYTICS_AXIS_TITLE_FILL}>Strike</text>
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

/** US equity options: contracts × 100 shares */
const OPTION_SHARES_PER_CONTRACT = 100

function fmtGexAxis(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return v.toFixed(0)
}

// ---------------------------------------------------------------------------
// Gamma exposure (dealer-style magnitude) — γ × OI × 100 per strike
// ---------------------------------------------------------------------------

interface GexStrike { strike: number; callGex: number; putGex: number }

export function GammaExposureChart({ rows, underlying }: {
  rows: OptionSnapshotRow[]
  underlying: number | null
}) {
  const data = useMemo(() => {
    const map = new Map<number, GexStrike>()
    for (const r of rows) {
      const oi = r.open_interest
      const g = r.gamma
      if (oi == null || !Number.isFinite(oi) || oi <= 0) continue
      if (g == null || !Number.isFinite(g)) continue
      const contrib = g * oi * OPTION_SHARES_PER_CONTRACT
      const right = (r.right || '').trim().toUpperCase()
      const existing = map.get(r.strike) ?? { strike: r.strike, callGex: 0, putGex: 0 }
      if (right === 'C' || right === 'CALL') existing.callGex += contrib
      else if (right === 'P' || right === 'PUT') existing.putGex += contrib
      map.set(r.strike, existing)
    }
    return [...map.values()].sort((a, b) => a.strike - b.strike)
  }, [rows])

  if (data.length < 1) {
    return <p className="section-hint">Not enough gamma and OI data for exposure chart.</p>
  }

  const w = 640
  const h = 240
  const pad = { l: 56, r: 24, t: 20, b: 40 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b

  const strikes = data.map(d => d.strike)
  const minS = Math.min(...strikes)
  const maxS = Math.max(...strikes)
  const maxStack = Math.max(
    1e-9,
    ...data.map(d => Math.abs(d.callGex) + Math.abs(d.putGex)),
  )

  const n = data.length
  const gap = Math.max(1, innerW * 0.12 / Math.max(n, 1))
  const barW = Math.max(2, (innerW - gap * (n - 1)) / n)
  const halfBar = barW / 2

  const xFor = (s: number) => pad.l + scaleLin(s, minS, maxS, halfBar, innerW - halfBar)

  const ucInRange = underlying != null && Number.isFinite(underlying) && underlying >= minS && underlying <= maxS
  const ucX = ucInRange ? xFor(underlying!) : null

  const yTicks = 3
  const yStep = maxStack / yTicks
  const xTickIdxs = pickXTickIndices(n, 8)

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
      aria-label="Gamma exposure by strike: call and put gamma times open interest times 100 shares per contract">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />

      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = yStep * i
        const y = pad.t + innerH - scaleLin(val, 0, maxStack, 0, innerH)
        return (
          <g key={i}>
            {i > 0 && <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
              stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="3 3" />}
            <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
              fill={OD_ANALYTICS_AXIS_TICK_FILL}>{fmtGexAxis(val)}</text>
          </g>
        )
      })}

      {data.map((d, i) => {
        const cx = xFor(d.strike)
        const y0 = pad.t + innerH
        const putH = scaleLin(Math.abs(d.putGex), 0, maxStack, 0, innerH)
        const callH = scaleLin(Math.abs(d.callGex), 0, maxStack, 0, innerH)
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
            fill={OD_ANALYTICS_AXIS_TICK_FILL}>{d.strike % 1 === 0 ? d.strike.toFixed(0) : d.strike.toFixed(1)}</text>
        )
      })}

      <text x={pad.l - 4} y={pad.t - 2} textAnchor="end" fontSize={OD_CHART_AXIS_FONT}
        fill={OD_ANALYTICS_AXIS_TITLE_FILL}>G×OI×100</text>
      <text x={pad.l + innerW / 2} y={h - 0} textAnchor="middle" fontSize={OD_CHART_AXIS_FONT}
        fill={OD_ANALYTICS_AXIS_TITLE_FILL}>Strike</text>
    </svg>
  )
}

export function GammaExposureLegend({ underlying }: { underlying: number | null }) {
  return (
    <div className="mp-legend" role="presentation">
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-green, #66bb6a)' }} />
        Call G×OI×100
      </span>
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: 'var(--color-lamp-red, #ef5350)' }} />
        Put G×OI×100
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

  const w = OD_IV_TERM_VIEWBOX_W
  const h = OD_IV_TERM_VIEWBOX_H
  const axisFs = OD_CHART_AXIS_FONT_IV_TERM
  const pad = OD_IV_TERM_PAD
  const xTickY = odIvTermXTickY(h)
  const xTitleY = odIvTermXAxisTitleY(h)
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
  /** Plot axes: use main text for titles; payoff tick color reads better on dark plot surfaces than --color-text-muted */
  const axisFill = 'var(--color-text-main)'
  const axisTickFill = 'var(--risk-payoff-tick)'

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
            <text x={pad.l - 8} y={y + 4} textAnchor="end" fontSize={axisFs} fontWeight={500}
              fill={axisTickFill}>{fmtIv(val)}</text>
          </g>
        )
      })}

      <polyline fill="none" stroke="var(--color-accent, #6ea8fe)" strokeWidth="2" points={pts} />
      {valid.map((p, i) => (
        <circle key={i} cx={xFor(p.dte_days)} cy={yFor(p.atm_iv!)} r={3}
          fill="var(--color-accent, #6ea8fe)" />
      ))}

      {valid.map((p, i) => (
        <text key={`l-${i}`} x={xFor(p.dte_days)} y={xTickY} textAnchor="middle" fontSize={axisFs} fontWeight={500}
          fill={axisTickFill}>{p.dte_days}d</text>
      ))}

      <text x={pad.l - 4} y={OD_IV_TERM_Y_AXIS_TITLE_Y} textAnchor="end" fontSize={axisFs} fontWeight={600}
        fill={axisFill}>ATM IV</text>
      <text x={pad.l + innerW / 2} y={xTitleY} textAnchor="middle" fontSize={axisFs} fontWeight={600}
        fill={axisFill}>Days to Expiration</text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// IV Volatility Cone (historical ATM IV bands per calendar expiration)
// ---------------------------------------------------------------------------

export type IvVolConePoint = IvVolatilityConePoint

export function IvVolConeChart({ points }: { points: IvVolConePoint[] }) {
  const valid = useMemo(() =>
    points
      .filter(p => p.dte_days >= 0)
      .sort((a, b) => a.dte_days - b.dte_days),
    [points],
  )

  const hasLine = valid.some(p => p.atm_iv != null && Number.isFinite(p.atm_iv))
  const hasBand = valid.some(
    p => p.iv_p10 != null && p.iv_p90 != null && Number.isFinite(p.iv_p10) && Number.isFinite(p.iv_p90),
  )

  if (valid.length < 2 || (!hasLine && !hasBand)) {
    return (
      <p className="section-hint">
        Not enough IV cone data (need at least 2 expirations with ATM IV and historical samples in PostgreSQL).
      </p>
    )
  }

  const w = OD_IV_TERM_VIEWBOX_W
  const h = OD_IV_TERM_VIEWBOX_H
  const axisFs = OD_CHART_AXIS_FONT_IV_TERM
  const pad = OD_IV_TERM_PAD
  const xTickY = odIvTermXTickY(h)
  const xTitleY = odIvTermXAxisTitleY(h)
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b

  const dtes = valid.map(p => p.dte_days)
  const minD = Math.min(...dtes)
  const maxD = Math.max(...dtes)

  const ivVals: number[] = []
  for (const p of valid) {
    if (p.atm_iv != null && Number.isFinite(p.atm_iv)) ivVals.push(p.atm_iv)
    if (p.iv_p10 != null && Number.isFinite(p.iv_p10)) ivVals.push(p.iv_p10)
    if (p.iv_p90 != null && Number.isFinite(p.iv_p90)) ivVals.push(p.iv_p90)
    if (p.iv_min != null && Number.isFinite(p.iv_min)) ivVals.push(p.iv_min)
    if (p.iv_max != null && Number.isFinite(p.iv_max)) ivVals.push(p.iv_max)
  }
  if (ivVals.length === 0) {
    return <p className="section-hint">Not enough IV cone data.</p>
  }
  const minIv = Math.min(...ivVals)
  const maxIv = Math.max(...ivVals)
  const ivPad = (maxIv - minIv) * 0.1 || 0.01
  const ivLo = Math.max(0, minIv - ivPad)
  const ivHi = maxIv + ivPad

  const xFor = (d: number) => pad.l + scaleLin(d, minD, maxD, 0, innerW)
  const yFor = (iv: number) => pad.t + innerH - scaleLin(iv, ivLo, ivHi, 0, innerH)

  const linePts = valid
    .filter(p => p.atm_iv != null && Number.isFinite(p.atm_iv))
    .map(p => `${xFor(p.dte_days)},${yFor(p.atm_iv!)}`)
    .join(' ')

  const barW = Math.min(14, innerW / Math.max(valid.length * 2, 6))

  const yTicks = 4
  const yStep = (ivHi - ivLo) / yTicks
  /** Plot axes: use main text for titles; payoff tick color reads better on dark plot surfaces than --color-text-muted */
  const axisFill = 'var(--color-text-main)'
  const axisTickFill = 'var(--risk-payoff-tick)'

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
      aria-label="IV volatility cone: historical ATM IV p10–p90 band per expiration vs days to expiration; current ATM IV overlaid">
      <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
        fill="var(--color-surface)" rx={4} />

      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = ivLo + yStep * i
        const y = yFor(val)
        return (
          <g key={i}>
            {i > 0 && <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
              stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="3 3" />}
            <text x={pad.l - 8} y={y + 4} textAnchor="end" fontSize={axisFs} fontWeight={500}
              fill={axisTickFill}>{fmtIv(val)}</text>
          </g>
        )
      })}

      {valid.map((p, i) => {
        if (
          p.iv_p10 == null || p.iv_p90 == null
          || !Number.isFinite(p.iv_p10) || !Number.isFinite(p.iv_p90)
        ) {
          return null
        }
        const x = xFor(p.dte_days)
        const y1 = yFor(p.iv_p90)
        const y2 = yFor(p.iv_p10)
        const top = Math.min(y1, y2)
        const hbar = Math.abs(y2 - y1)
        return (
          <rect
            key={`band-${i}`}
            x={x - barW / 2}
            y={top}
            width={barW}
            height={Math.max(hbar, 1)}
            fill="var(--color-accent, #6ea8fe)"
            opacity={0.22}
            rx={2}
          />
        )
      })}

      {linePts && (
        <polyline fill="none" stroke="var(--color-warning, #e8a849)" strokeWidth={2} points={linePts} />
      )}
      {valid.map((p, i) => (
        p.atm_iv != null && Number.isFinite(p.atm_iv)
          ? (
              <circle key={`dot-${i}`} cx={xFor(p.dte_days)} cy={yFor(p.atm_iv)} r={3}
                fill="var(--color-warning, #e8a849)" />
            )
          : null
      ))}

      {valid.map((p, i) => (
        <text key={`l-${i}`} x={xFor(p.dte_days)} y={xTickY} textAnchor="middle" fontSize={axisFs} fontWeight={500}
          fill={axisTickFill}>{p.dte_days}d</text>
      ))}

      <text x={pad.l - 4} y={OD_IV_TERM_Y_AXIS_TITLE_Y} textAnchor="end" fontSize={axisFs} fontWeight={600}
        fill={axisFill}>ATM IV</text>
      <text x={pad.l + innerW / 2} y={xTitleY} textAnchor="middle" fontSize={axisFs} fontWeight={600}
        fill={axisFill}>Days to Expiration</text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// IV Parametric historical cone (mean ± sample σ, min/max, current Call/Put)
// ---------------------------------------------------------------------------

function polyIvCone(
  rows: IvVolatilityConePoint[],
  pick: (p: IvVolatilityConePoint) => number | null | undefined,
  xFor: (d: number) => number,
  yFor: (iv: number) => number,
): string {
  return rows
    .filter(p => {
      const v = pick(p)
      return v != null && Number.isFinite(v)
    })
    .map(p => {
      const v = pick(p)!
      return `${xFor(p.dte_days)},${yFor(v)}`
    })
    .join(' ')
}

/** SVG polyline needs ≥2 points to draw a visible segment */
function polylinePointCount(pointsAttr: string): number {
  const t = pointsAttr.trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

function extentParametricCone(rows: IvVolatilityConePoint[]): { lo: number; hi: number } | null {
  let lo = Infinity
  let hi = -Infinity
  const bump = (v: number | null | undefined) => {
    if (v != null && Number.isFinite(v)) {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  }
  for (const p of rows) {
    bump(p.iv_hist_min)
    bump(p.iv_hist_max)
    bump(p.iv_hist_mean)
    bump(p.iv_hist_plus_1sd)
    bump(p.iv_hist_minus_1sd)
    bump(p.iv_hist_plus_2sd)
    bump(p.iv_hist_minus_2sd)
    bump(p.iv_call)
    bump(p.iv_put)
    bump(p.atm_iv)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  return { lo, hi }
}

export function IvParametricConeChart({ points }: { points: IvVolatilityConePoint[] }) {
  const valid = useMemo(
    () =>
      points
        .filter(p => p.dte_days >= 0)
        .sort((a, b) => a.dte_days - b.dte_days),
    [points],
  )

  const hasHist = useMemo(
    () =>
      valid.some(
        p =>
          (p.iv_hist_mean != null && Number.isFinite(p.iv_hist_mean))
          || (p.iv_hist_min != null && Number.isFinite(p.iv_hist_min)),
      ),
    [valid],
  )
  const hasCp = useMemo(
    () =>
      valid.some(
        p =>
          (p.iv_call != null && Number.isFinite(p.iv_call))
          || (p.iv_put != null && Number.isFinite(p.iv_put)),
      ),
    [valid],
  )

  if (valid.length < 2) {
    return (
      <p className="section-hint">
        Not enough data for parametric chart (need at least 2 expirations with DTE ≥ 0).
      </p>
    )
  }

  if (!hasHist && !hasCp) {
    return (
      <p className="section-hint">
        No historical ATM IV samples or latest Call/Put IV for this selection — load cone data with daily snapshots.
      </p>
    )
  }

  const ext0 = extentParametricCone(valid)
  if (ext0 == null) {
    return <p className="section-hint">Not enough numeric IV values to plot.</p>
  }

  const w = OD_IV_TERM_VIEWBOX_W
  const h = OD_IV_TERM_VIEWBOX_H
  const axisFs = OD_CHART_AXIS_FONT_IV_TERM
  const pad = OD_IV_TERM_PAD
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const xTickY = odIvTermXTickY(h)
  const xTitleY = odIvTermXAxisTitleY(h)

  const dtes = valid.map(p => p.dte_days)
  const minD = Math.min(...dtes)
  const maxD = Math.max(...dtes)
  const ivPad = (ext0.hi - ext0.lo) * 0.1 || 0.01
  const ivLo = Math.max(0, ext0.lo - ivPad)
  const ivHi = ext0.hi + ivPad

  const xFor = (d: number) => pad.l + scaleLin(d, minD, maxD, 0, innerW)
  const yFor = (iv: number) => pad.t + innerH - scaleLin(iv, ivLo, ivHi, 0, innerH)

  const linePts = (fn: (p: IvVolatilityConePoint) => number | null | undefined) =>
    polyIvCone(valid, fn, xFor, yFor)
  const ptsMin = linePts(p => p.iv_hist_min)
  const ptsMax = linePts(p => p.iv_hist_max)
  const ptsM2l = linePts(p => p.iv_hist_minus_2sd)
  const ptsM2u = linePts(p => p.iv_hist_plus_2sd)
  const ptsM1l = linePts(p => p.iv_hist_minus_1sd)
  const ptsM1u = linePts(p => p.iv_hist_plus_1sd)
  const ptsMean = linePts(p => p.iv_hist_mean)

  const histSeriesAttrs = [ptsMin, ptsMax, ptsM2l, ptsM2u, ptsM1l, ptsM1u, ptsMean]
  const anyHistLineDrawable = histSeriesAttrs.some(s => polylinePointCount(s) >= 2)
  const showParametricBandError =
    (hasCp && !hasHist)
    || (hasHist && !anyHistLineDrawable)
  const parametricErrorLine1 =
    hasCp && !hasHist
      ? 'Error: Historical band data (min / max / mean / SD) missing.'
      : 'Error: Fewer than two expirations have band values — lines need ≥2 points.'
  const parametricErrorLine2 =
    hasCp && !hasHist
      ? 'Call/Put markers use latest snapshots; backfill daily ATM IV for parametric series.'
      : 'Add snapshots or pick expirations with complete iv_hist_* from the API.'

  const yTicks = 4
  const yStep = (ivHi - ivLo) / yTicks
  const axisFill = 'var(--color-text-main)'
  const axisTickFill = 'var(--risk-payoff-tick)'

  const jitter = 5

  return (
    <>
      <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${w} ${h}`}
        aria-label="Parametric IV cone: historical daily ATM IV mean, standard deviation bands, min and max, with latest Call and Put IV markers">
        <rect x={pad.l} y={pad.t} width={innerW} height={innerH}
          fill="var(--color-surface)" rx={4} />

        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const val = ivLo + yStep * i
          const y = yFor(val)
          return (
            <g key={i}>
              {i > 0 && (
                <line x1={pad.l} x2={pad.l + innerW} y1={y} y2={y}
                  stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="3 3" />
              )}
              <text x={pad.l - 8} y={y + 4} textAnchor="end" fontSize={axisFs} fontWeight={500}
                fill={axisTickFill}>{fmtIv(val)}</text>
            </g>
          )
        })}

        {hasHist && (
          <>
            {polylinePointCount(ptsMin) >= 2 && (
              <polyline fill="none" stroke="var(--color-text-muted)" strokeWidth={1.2} strokeDasharray="4 3"
                points={ptsMin} />
            )}
            {polylinePointCount(ptsMax) >= 2 && (
              <polyline fill="none" stroke="var(--color-text-muted)" strokeWidth={1.2} strokeDasharray="4 3"
                points={ptsMax} />
            )}
            {polylinePointCount(ptsM2l) >= 2 && (
              <polyline fill="none" stroke="#64748b" strokeWidth={1} strokeDasharray="2 4" points={ptsM2l} />
            )}
            {polylinePointCount(ptsM2u) >= 2 && (
              <polyline fill="none" stroke="#64748b" strokeWidth={1} strokeDasharray="2 4" points={ptsM2u} />
            )}
            {polylinePointCount(ptsM1l) >= 2 && (
              <polyline fill="none" stroke="var(--color-link, #7dd3fc)" strokeWidth={1.2} strokeDasharray="5 3"
                points={ptsM1l} />
            )}
            {polylinePointCount(ptsM1u) >= 2 && (
              <polyline fill="none" stroke="var(--color-link, #7dd3fc)" strokeWidth={1.2} strokeDasharray="5 3"
                points={ptsM1u} />
            )}
            {polylinePointCount(ptsMean) >= 2 && (
              <polyline fill="none" stroke="var(--color-accent, #a3e635)" strokeWidth={2} points={ptsMean} />
            )}
          </>
        )}

        {hasCp && valid.map((p, i) => {
          const yc = p.iv_call != null && Number.isFinite(p.iv_call) ? yFor(p.iv_call) : null
          const yp = p.iv_put != null && Number.isFinite(p.iv_put) ? yFor(p.iv_put) : null
          const xc = xFor(p.dte_days)
          return (
            <g key={`cp-${i}`}>
              {yc != null && (
                <circle cx={xc - jitter} cy={yc} r={3.5}
                  fill="var(--color-accent, #6ea8fe)" stroke="var(--color-border)" strokeWidth={0.5} />
              )}
              {yp != null && (
                <circle cx={xc + jitter} cy={yp} r={3.5}
                  fill="var(--color-warning, #e8a849)" stroke="var(--color-border)" strokeWidth={0.5} />
              )}
            </g>
          )
        })}

        {valid.map((p, i) => (
          <text key={`l-${i}`} x={xFor(p.dte_days)} y={xTickY} textAnchor="middle" fontSize={axisFs} fontWeight={500}
            fill={axisTickFill}>{p.dte_days}d</text>
        ))}

        <text x={pad.l - 4} y={OD_IV_TERM_Y_AXIS_TITLE_Y} textAnchor="end" fontSize={axisFs} fontWeight={600}
          fill={axisFill}>ATM IV</text>
        <text x={pad.l + innerW / 2} y={xTitleY} textAnchor="middle" fontSize={axisFs} fontWeight={600}
          fill={axisFill}>Days to Expiration</text>

        {showParametricBandError && (
          <g className="od-iv-param-band-error" role="alert" pointerEvents="none">
            <rect
              x={pad.l + 6}
              y={pad.t + 6}
              width={innerW - 12}
              height={40}
              rx={5}
              fill="color-mix(in srgb, var(--color-danger, #dc2626) 16%, transparent)"
              stroke="var(--color-danger, #dc2626)"
              strokeWidth={1.2}
            />
            <text
              fontSize={10}
              fontWeight={700}
              fill="var(--color-danger, #ef4444)"
              textAnchor="middle"
            >
              <tspan x={pad.l + innerW / 2} y={pad.t + 22}>
                {parametricErrorLine1}
              </tspan>
              <tspan x={pad.l + innerW / 2} y={pad.t + 35}>
                {parametricErrorLine2}
              </tspan>
            </text>
          </g>
        )}
      </svg>
      <div className="od-iv-param-legend" aria-label="Chart legend">
        <span className="od-iv-param-legend-item"><span className="od-iv-param-swatch od-iv-param-swatch--minmax" />Min / Max</span>
        <span className="od-iv-param-legend-item"><span className="od-iv-param-swatch od-iv-param-swatch--sd2" />Mean ±2 SD</span>
        <span className="od-iv-param-legend-item"><span className="od-iv-param-swatch od-iv-param-swatch--sd1" />Mean ±1 SD</span>
        <span className="od-iv-param-legend-item"><span className="od-iv-param-swatch od-iv-param-swatch--mean" />Mean</span>
        <span className="od-iv-param-legend-item"><span className="od-iv-param-swatch od-iv-param-swatch--call" />Call (latest)</span>
        <span className="od-iv-param-legend-item"><span className="od-iv-param-swatch od-iv-param-swatch--put" />Put (latest)</span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Combined analytics panel — vertical stack (no tabs)
// ---------------------------------------------------------------------------

export function OptionDiscoveryAnalyticsPanel({
  rows,
  underlying,
}: {
  rows: OptionSnapshotRow[]
  underlying: number | null
}) {
  const [ivCollapsed, setIvCollapsed] = useState(false)
  const [oiCollapsed, setOiCollapsed] = useState(false)
  const [gexCollapsed, setGexCollapsed] = useState(false)

  const hasIv = rows.some(r => r.iv != null && Number.isFinite(r.iv!))
  const hasOi = rows.some(r => r.open_interest != null && Number.isFinite(r.open_interest!) && r.open_interest! > 0)
  const hasGex = rows.some(
    r =>
      r.gamma != null
      && Number.isFinite(r.gamma)
      && r.open_interest != null
      && Number.isFinite(r.open_interest)
      && r.open_interest > 0,
  )

  if (!hasIv && !hasOi && !hasGex) return null

  const chartCount = [hasIv, hasOi, hasGex].filter(Boolean).length

  return (
    <section className="replay-section od-analytics-section" aria-label="Option analytics">
      <h3 className="od-analytics-title">
        Option Analytics
        <InfoTooltip text="Derived from current-expiry snapshot data (Massive, ~15 min delayed). IV Smile and OI by strike for loaded contracts. Scoped to the selected strike window." />
      </h3>

      <div className="od-analytics-charts-scroll">
        <div className="od-analytics-charts-row" data-chart-count={chartCount}>
        {hasIv && (
          <div className="mp-chart-pane od-analytics-chart-cell">
            <div className="od-analytics-chart-head">
              <h4 className="mp-chart-subtitle">IV Smile</h4>
              <button
                type="button"
                className="section-header-icon-btn od-analytics-chart-toggle-btn"
                onClick={() => setIvCollapsed(v => !v)}
                title={ivCollapsed ? 'Expand IV Smile' : 'Collapse IV Smile'}
                aria-label={ivCollapsed ? 'Expand IV Smile' : 'Collapse IV Smile'}
                aria-expanded={!ivCollapsed}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={ivCollapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'} />
                </svg>
              </button>
            </div>
            {!ivCollapsed && (
              <OdChartExpandOnHover title="IV Smile">
                <>
                  <IvSmileLegend underlying={underlying} />
                  <IvSmileChart rows={rows} underlying={underlying} />
                  <SkewSummary rows={rows} underlying={underlying} />
                </>
              </OdChartExpandOnHover>
            )}
          </div>
        )}

        {hasOi && (
          <div className="mp-chart-pane od-analytics-chart-cell">
            <div className="od-analytics-chart-head">
              <h4 className="mp-chart-subtitle">Open Interest Profile</h4>
              <button
                type="button"
                className="section-header-icon-btn od-analytics-chart-toggle-btn"
                onClick={() => setOiCollapsed(v => !v)}
                title={oiCollapsed ? 'Expand Open Interest Profile' : 'Collapse Open Interest Profile'}
                aria-label={oiCollapsed ? 'Expand Open Interest Profile' : 'Collapse Open Interest Profile'}
                aria-expanded={!oiCollapsed}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={oiCollapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'} />
                </svg>
              </button>
            </div>
            {!oiCollapsed && (
              <OdChartExpandOnHover title="Open Interest Profile">
                <>
                  <OiProfileLegend underlying={underlying} />
                  <OiProfileChart rows={rows} underlying={underlying} />
                </>
              </OdChartExpandOnHover>
            )}
          </div>
        )}

        {hasGex && (
          <div className="mp-chart-pane od-analytics-chart-cell">
            <div className="od-analytics-chart-head">
              <h4 className="mp-chart-subtitle">
                Gamma exposure (dealer-style)
                <InfoTooltip text="Stacked |gamma × open interest × 100| per strike (US equity contract size). Magnitude only; not a forecast of dealer hedging flow. Delayed snapshot data." />
              </h4>
              <button
                type="button"
                className="section-header-icon-btn od-analytics-chart-toggle-btn"
                onClick={() => setGexCollapsed(v => !v)}
                title={gexCollapsed ? 'Expand Gamma exposure' : 'Collapse Gamma exposure'}
                aria-label={gexCollapsed ? 'Expand Gamma exposure' : 'Collapse Gamma exposure'}
                aria-expanded={!gexCollapsed}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={gexCollapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'} />
                </svg>
              </button>
            </div>
            {!gexCollapsed && (
              <OdChartExpandOnHover title="Gamma exposure (dealer-style)">
                <>
                  <GammaExposureLegend underlying={underlying} />
                  <GammaExposureChart rows={rows} underlying={underlying} />
                  <p className="section-hint od-gex-disclaimer">
                    Approximate notional gamma exposure (gamma × OI × 100). For illustration only; not a hedge-flow forecast.
                  </p>
                </>
              </OdChartExpandOnHover>
            )}
          </div>
        )}
        </div>
      </div>
    </section>
  )
}

