import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { fetchPutCallRatioHistory } from '../../api'
import type { PutCallRatioHistoryPoint } from '../../api'
import { OdChartExpandOnHover } from './OdChartExpandOnHover'
import {
  OD_MAX_PAIN_AXIS_FONT,
  OD_MAX_PAIN_PAD_TREND,
  OD_MAX_PAIN_VIEWBOX_H,
  OD_MAX_PAIN_VIEWBOX_W,
} from './odChartConstants'

const AXIS_FILL = 'var(--od-max-pain-axis-fill, var(--color-text-muted))'
const W = OD_MAX_PAIN_VIEWBOX_W
const H = OD_MAX_PAIN_VIEWBOX_H
const PAD = OD_MAX_PAIN_PAD_TREND

const COLOR_OI_RATIO = 'var(--color-accent, #6ea8fe)'
const COLOR_VOL_RATIO = '#f59e0b'
const COLOR_PUT_OI = 'var(--color-lamp-red, #ef5350)'
const COLOR_CALL_OI = 'var(--color-lamp-green, #66bb6a)'
const COLOR_REF_LINE = 'rgba(255,255,255,0.25)'

function scaleLin(v: number, vmin: number, vmax: number, outMin: number, outMax: number): number {
  if (!Number.isFinite(v)) return (outMin + outMax) / 2
  if (vmax <= vmin) return outMin
  return outMin + ((v - vmin) / (vmax - vmin)) * (outMax - outMin)
}

function fmtK(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${v.toFixed(0)}`
}

function pickTicks(n: number, maxTicks = 7): number[] {
  if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i)
  const step = (n - 1) / (maxTicks - 1)
  return Array.from({ length: maxTicks }, (_, i) => Math.round(i * step))
}

function yTicks(yMin: number, yMax: number, count = 4): number[] {
  const step = (yMax - yMin) / count
  return Array.from({ length: count + 1 }, (_, i) => yMin + i * step)
}

// ── Chart 1: PCR ratio time-series ──────────────────────────────────────────

function PcrRatioChart({ points }: { points: PutCallRatioHistoryPoint[] }) {
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  const ratioOi = points.map(p => p.ratio_oi).filter((v): v is number => v != null)
  const ratioVol = points.map(p => p.ratio_volume).filter((v): v is number => v != null)
  const allRatios = [...ratioOi, ...ratioVol]
  if (allRatios.length === 0) return null

  const rawMin = Math.min(...allRatios)
  const rawMax = Math.max(...allRatios)
  // Y range: always include 1.0 (equilibrium), add 15% padding
  const yMin = Math.max(0, Math.min(rawMin, 1.0) - Math.max(0.05, (rawMax - rawMin) * 0.15))
  const yMax = Math.max(rawMax, 1.0) + Math.max(0.05, (rawMax - rawMin) * 0.15)

  const n = points.length
  const xOf = (i: number) => PAD.l + scaleLin(i, 0, n - 1, 0, innerW)
  const yOf = (v: number) => PAD.t + scaleLin(v, yMax, yMin, 0, innerH)

  // Y=1.0 reference line
  const refY = yOf(1.0)

  // OI ratio polyline
  const oiPts = points
    .map((p, i) => (p.ratio_oi != null ? `${xOf(i).toFixed(1)},${yOf(p.ratio_oi).toFixed(1)}` : null))
    .filter(Boolean)
  const oiPolyline = oiPts.join(' ')

  // Volume ratio polyline
  const volPts = points
    .map((p, i) => (p.ratio_volume != null ? `${xOf(i).toFixed(1)},${yOf(p.ratio_volume).toFixed(1)}` : null))
    .filter(Boolean)
  const volPolyline = volPts.join(' ')

  // Background fill: above/below 1.0 reference
  const areaAbove: string[] = []
  const areaBelow: string[] = []
  for (let i = 0; i < points.length; i++) {
    const v = points[i].ratio_oi
    if (v == null) continue
    const x = xOf(i).toFixed(1)
    const y = yOf(v).toFixed(1)
    if (v > 1.0) areaAbove.push(`${x},${y}`)
    else areaBelow.push(`${x},${y}`)
  }

  const xTickIdxs = pickTicks(n)
  const yTickVals = yTicks(yMin, yMax, 4)

  const gridLines: ReactElement[] = yTickVals.map((tv, i) => {
    const ty = yOf(tv)
    return (
      <g key={i}>
        <line x1={PAD.l} x2={PAD.l + innerW} y1={ty} y2={ty}
          stroke="var(--color-border-dim, rgba(255,255,255,0.08))" strokeWidth={0.5} />
        <text x={PAD.l - 6} y={ty + 3} textAnchor="end" fill={AXIS_FILL}
          fontSize={OD_MAX_PAIN_AXIS_FONT}>{tv.toFixed(2)}</text>
      </g>
    )
  })

  const xLabels: ReactElement[] = xTickIdxs.map(i => {
    const p = points[i]
    const label = (p?.trade_date ?? '').slice(5)
    return (
      <text key={i} x={xOf(i).toFixed(1)} y={PAD.t + innerH + 14}
        textAnchor="middle" fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT - 1}>{label}</text>
    )
  })

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${W} ${H}`} aria-label="Put/Call ratio time series">
      {/* Background zones */}
      <rect x={PAD.l} y={PAD.t} width={innerW} height={innerH} fill="var(--color-surface)" rx={4} />
      {/* Bear zone (ratio > 1): light red tint */}
      <rect x={PAD.l} y={PAD.t} width={innerW} height={Math.max(0, refY - PAD.t)}
        fill="var(--color-lamp-red, #ef5350)" opacity={0.04} />
      {/* Bull zone (ratio < 1): light green tint */}
      <rect x={PAD.l} y={refY} width={innerW} height={Math.max(0, PAD.t + innerH - refY)}
        fill="var(--color-lamp-green, #66bb6a)" opacity={0.04} />

      {/* Axes */}
      <line x1={PAD.l} x2={PAD.l + innerW} y1={PAD.t + innerH} y2={PAD.t + innerH}
        stroke="var(--color-border-strong)" strokeWidth={1} />
      <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + innerH}
        stroke="var(--color-border-strong)" strokeWidth={1} />

      {/* Grid + Y ticks */}
      {gridLines}

      {/* Y=1.0 reference */}
      <line x1={PAD.l} x2={PAD.l + innerW} y1={refY} y2={refY}
        stroke={COLOR_REF_LINE} strokeWidth={1} strokeDasharray="4 3" />
      <text x={PAD.l + innerW + 4} y={refY + 3} fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT - 1}>1.0</text>

      {/* OI ratio line */}
      {oiPolyline && (
        <polyline points={oiPolyline} fill="none" stroke={COLOR_OI_RATIO} strokeWidth={1.5} strokeLinejoin="round" />
      )}
      {/* Volume ratio line */}
      {volPolyline && (
        <polyline points={volPolyline} fill="none" stroke={COLOR_VOL_RATIO} strokeWidth={1.2}
          strokeDasharray="5 3" strokeLinejoin="round" />
      )}

      {/* X ticks */}
      {xLabels}

      {/* Axis titles */}
      <text x={PAD.l - 4} y={PAD.t - 8} fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT}>P/C Ratio</text>
      <text x={PAD.l + innerW / 2} y={H - 4} textAnchor="middle" fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT}>Date</text>
    </svg>
  )
}

// ── Chart 2: OI absolute quantity dual lines ─────────────────────────────────

function PcrOiAbsChart({ points }: { points: PutCallRatioHistoryPoint[] }) {
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  const hasData = points.some(p => p.put_oi_total != null || p.call_oi_total != null)
  if (!hasData) return null

  const allOi = points.flatMap(p => [p.put_oi_total, p.call_oi_total]).filter((v): v is number => v != null)
  const yMax = Math.max(...allOi, 1) * 1.1
  const n = points.length

  const xOf = (i: number) => PAD.l + scaleLin(i, 0, n - 1, 0, innerW)
  const yOf = (v: number) => PAD.t + scaleLin(v, yMax, 0, 0, innerH)

  const putPts = points.map((p, i) =>
    p.put_oi_total != null ? `${xOf(i).toFixed(1)},${yOf(p.put_oi_total).toFixed(1)}` : null
  ).filter(Boolean).join(' ')
  const callPts = points.map((p, i) =>
    p.call_oi_total != null ? `${xOf(i).toFixed(1)},${yOf(p.call_oi_total).toFixed(1)}` : null
  ).filter(Boolean).join(' ')

  const yTickVals = yTicks(0, yMax, 4)
  const xTickIdxs = pickTicks(n)

  return (
    <svg className="od-max-pain-svg od-chart-svg" viewBox={`0 0 ${W} ${H}`} aria-label="Put and Call OI over time">
      <rect x={PAD.l} y={PAD.t} width={innerW} height={innerH} fill="var(--color-surface)" rx={4} />
      <line x1={PAD.l} x2={PAD.l + innerW} y1={PAD.t + innerH} y2={PAD.t + innerH}
        stroke="var(--color-border-strong)" strokeWidth={1} />
      <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + innerH}
        stroke="var(--color-border-strong)" strokeWidth={1} />

      {yTickVals.map((tv, i) => {
        const ty = yOf(tv)
        return (
          <g key={i}>
            <line x1={PAD.l} x2={PAD.l + innerW} y1={ty} y2={ty}
              stroke="var(--color-border-dim, rgba(255,255,255,0.08))" strokeWidth={0.5} />
            <text x={PAD.l - 6} y={ty + 3} textAnchor="end" fill={AXIS_FILL}
              fontSize={OD_MAX_PAIN_AXIS_FONT}>{fmtK(tv)}</text>
          </g>
        )
      })}

      {putPts && (
        <polyline points={putPts} fill="none" stroke={COLOR_PUT_OI} strokeWidth={1.5} strokeLinejoin="round" />
      )}
      {callPts && (
        <polyline points={callPts} fill="none" stroke={COLOR_CALL_OI} strokeWidth={1.5} strokeLinejoin="round" />
      )}

      {xTickIdxs.map(i => (
        <text key={i} x={xOf(i).toFixed(1)} y={PAD.t + innerH + 14}
          textAnchor="middle" fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT - 1}>
          {(points[i]?.trade_date ?? '').slice(5)}
        </text>
      ))}

      <text x={PAD.l - 4} y={PAD.t - 8} fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT}>OI (contracts)</text>
      <text x={PAD.l + innerW / 2} y={H - 4} textAnchor="middle" fill={AXIS_FILL} fontSize={OD_MAX_PAIN_AXIS_FONT}>Date</text>
    </svg>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────────

function PcrLegend({ latestPoint }: { latestPoint: PutCallRatioHistoryPoint | null }) {
  const ratioOi = latestPoint?.ratio_oi
  const ratioVol = latestPoint?.ratio_volume
  return (
    <div className="mp-legend" role="presentation">
      <span className="mp-legend-item">
        <span className="mp-legend-swatch mp-legend-line" style={{ borderColor: COLOR_OI_RATIO }} />
        OI Ratio{ratioOi != null ? <strong style={{ marginLeft: 4 }}>{ratioOi.toFixed(3)}</strong> : null}
      </span>
      <span className="mp-legend-item">
        <span className="mp-legend-swatch mp-legend-line" style={{ borderColor: COLOR_VOL_RATIO, borderStyle: 'dashed' }} />
        Vol Ratio{ratioVol != null ? <strong style={{ marginLeft: 4 }}>{ratioVol.toFixed(3)}</strong> : null}
      </span>
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: COLOR_PUT_OI }} />
        Put OI
      </span>
      <span className="mp-legend-item">
        <span className="mp-legend-swatch" style={{ background: COLOR_CALL_OI }} />
        Call OI
      </span>
    </div>
  )
}

// ── Main panel export ─────────────────────────────────────────────────────────

export function OptionDiscoveryPutCallRatioPanel({ symbol }: { symbol: string }) {
  const [series, setSeries] = useState<PutCallRatioHistoryPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lookbackDays, setLookbackDays] = useState(90)

  const load = useCallback(async (sym: string, days: number) => {
    const s = sym.trim().toUpperCase()
    if (!s) return
    setLoading(true)
    setError(null)
    const res = await fetchPutCallRatioHistory({ symbol: s, lookbackDays: days })
    setLoading(false)
    if (!res.ok) {
      setError(res.error ?? 'Failed to load PCR data')
      setSeries([])
    } else {
      setSeries(res.series)
    }
  }, [])

  useEffect(() => {
    if (symbol.trim()) load(symbol, lookbackDays)
  }, [symbol, lookbackDays, load])

  const latestPoint = series.length > 0 ? series[series.length - 1] : null
  const hasSeries = series.length > 0
  const hasOiData = series.some(p => p.ratio_oi != null)

  return (
    <div className="od-max-pain-panel">
      <div className="od-max-pain-header">
        <h4 className="od-max-pain-title">Put/Call Ratio</h4>
        <span className={w9.sectionHint} style={{ marginLeft: '0.5rem', fontSize: '0.78rem' }}>
          OI-based &amp; Volume-based · all expirations combined
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>
            Lookback
          </label>
          <select
            value={lookbackDays}
            onChange={e => setLookbackDays(Number(e.target.value))}
            style={{ fontSize: '0.75rem', padding: '0.1rem 0.3rem', background: 'var(--color-surface-raised)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'inherit' }}
          >
            <option value={30}>30d</option>
            <option value={60}>60d</option>
            <option value={90}>90d</option>
            <option value={180}>180d</option>
          </select>
        </div>
      </div>

      {loading && <p className={w9.sectionHint} style={{ padding: '1rem 0' }}>Loading PCR data…</p>}
      {error && <p className={w9.sectionHint} style={{ color: 'var(--color-lamp-red)', padding: '0.5rem 0' }}>{error}</p>}

      {!loading && !error && !hasSeries && (
        <p className={w9.sectionHint} style={{ padding: '1rem 0' }}>
          No PCR data available. Run EOD pipeline or trigger{' '}
          <code style={{ fontSize: '0.75rem' }}>kind=report_option_put_call_ratio</code>.
        </p>
      )}

      {hasSeries && (
        <>
          <PcrLegend latestPoint={latestPoint} />

          {hasOiData && (
            <div className="od-max-pain-charts-row">
              <OdChartExpandOnHover title="P/C Ratio (OI + Vol)">
                <PcrRatioChart points={series} />
              </OdChartExpandOnHover>
              <OdChartExpandOnHover title="Put vs Call OI">
                <PcrOiAbsChart points={series} />
              </OdChartExpandOnHover>
            </div>
          )}
        </>
      )}
    </div>
  )
}
