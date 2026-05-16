import { useEffect, useMemo, useState } from 'react'
import { fetchBarsBenchmark, fetchPutCallRatioHistory } from '../api'
import type { PutCallRatioHistoryPoint } from '../api'
import {
  fetchSymbolFundamentalConditions,
  fetchSymbolTechnicalConditions,
  fetchSymbolFundRawData,
  fetchSymbolStatements,
  fetchTickerOverview,
  type SymbolFundamentalConditionsResponse,
  type SymbolFundamentalConditionRow,
  type SymbolTechnicalConditionsResponse,
  type SymbolTechnicalConditionRow,
  type FundRawQuarterRow,
  type FundRawAnnualRow,
  type SymbolFundRawDataResponse,
  type SymbolStatementsResponse,
  type TickerOverviewResponse,
} from '../api/research/dataReadiness'
import type { LivePositionRow } from '../views/portfolio/types'
import { fmtPctCompact, fmtUsd } from '../utils/format'
import { StockBarStatsPanel } from './StockBarStatsPanel'
import '../styles/stock-inspector.css'

/** Render a tiny inline bar that encodes relative magnitude for a table cell. */
function MiniBar({ value, min, max }: { value: number | null | undefined; min: number; max: number }) {
  if (value == null || !Number.isFinite(value) || max === min) return null
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
  const color = value >= 0 ? 'rgba(74,222,128,0.28)' : 'rgba(248,113,113,0.28)'
  return <div className="sip-mini-bar" style={{ width: `${pct}%`, background: color }} />
}

function colRange(vals: (number | null | undefined)[]): [number, number] {
  const ns = vals.filter((v): v is number => v != null && Number.isFinite(v as number))
  if (ns.length === 0) return [0, 0]
  return [Math.min(...ns), Math.max(...ns)]
}

// ── Inline SVG chart helpers (no external dependencies) ──────────────────

function fmtMini(v: number): string {
  const abs = Math.abs(v), sign = v < 0 ? '-' : ''
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(0)}M`
  if (abs >= 1e3)  return `${sign}${(abs / 1e3).toFixed(0)}K`
  return `${sign}${abs.toFixed(1)}`
}

interface ChartSeries {
  key: string
  color: string
  negColor?: string    // colour for negative values; falls back to color
  values: (number | null)[]
}

/**
 * Grouped bar chart.
 * vw: coordinate-space width (matches typical rendered px so font sizes are predictable).
 *     Use ~500 for half-width columns, ~960 for full-width.
 */
function SvgBarChart({ labels, series, h = 110, vw = 500 }: {
  labels: string[]; series: ChartSeries[]; h?: number; vw?: number
}) {
  const n = labels.length
  if (n === 0 || series.length === 0) return null
  const allVals = series.flatMap(s => s.values.filter((v): v is number => v != null && Number.isFinite(v)))
  if (allVals.length === 0) return null

  const vMin = Math.min(0, ...allVals)
  const vMax = Math.max(0, ...allVals)
  const range = vMax - vMin || 1

  const VW = vw, PL = 46, PR = 6, PT = 10, PB = 22
  const cW = VW - PL - PR, cH = h - PT - PB
  const zY = PT + (vMax / range) * cH
  const ns = series.length
  const gW = cW / n
  const bW = Math.max(3, (gW * 0.74) / ns)

  const ticks = [vMin, vMin + range * 0.5, vMax]

  return (
    <svg viewBox={`0 0 ${VW} ${h}`} width="100%" height={h} style={{ display: 'block' }}>
      {ticks.map((tv, ti) => {
        const ty = PT + ((vMax - tv) / range) * cH
        return (
          <g key={ti}>
            <line x1={PL} y1={ty} x2={VW - PR} y2={ty} stroke="rgba(148,163,184,0.12)" strokeWidth={0.7} />
            <text x={PL - 4} y={ty + 4} textAnchor="end" fontSize={9} fill="rgba(148,163,184,0.65)">{fmtMini(tv)}</text>
          </g>
        )
      })}
      <line x1={PL} y1={zY} x2={VW - PR} y2={zY} stroke="rgba(148,163,184,0.35)" strokeWidth={1} />
      {labels.map((lbl, gi) => {
        const gX = PL + gi * gW + gW * 0.12
        return (
          <g key={gi}>
            {series.map((s, si) => {
              const v = s.values[gi]
              if (v == null || !Number.isFinite(v)) return null
              const bH = Math.max(1, Math.abs((v / range) * cH))
              const bY = v >= 0 ? zY - bH : zY
              const fill = v < 0 && s.negColor ? s.negColor : s.color
              return (
                <rect key={si} x={gX + si * (bW + 2)} y={bY} width={bW} height={bH}
                  fill={fill} rx={1.5} opacity={0.9}>
                  <title>{s.key}: {fmtMini(v)}</title>
                </rect>
              )
            })}
            <text x={gX + ns * (bW + 2) / 2} y={h - 4} textAnchor="middle" fontSize={8}
              fill="rgba(148,163,184,0.65)">{lbl}</text>
          </g>
        )
      })}
    </svg>
  )
}

/** Area / line chart for a single time-series metric. */
function SvgAreaChart({ labels, values, color, areaColor, h = 88, vw = 500 }: {
  labels: string[]; values: (number | null)[];
  color: string; areaColor: string; h?: number; vw?: number
}) {
  const pts = values
    .map((v, i) => (v != null && Number.isFinite(v) ? { i, v } : null))
    .filter(Boolean) as { i: number; v: number }[]
  if (pts.length < 2) return null

  const VW = vw, PL = 46, PR = 6, PT = 10, PB = 22
  const cW = VW - PL - PR, cH = h - PT - PB
  const vMin = Math.min(...pts.map(p => p.v))
  const vMax = Math.max(...pts.map(p => p.v))
  const range = vMax - vMin || 1
  const n = values.length

  const xOf = (i: number) => PL + (i / Math.max(n - 1, 1)) * cW
  const yOf = (v: number) => PT + (1 - (v - vMin) / range) * cH

  const linePts = pts.map(p => `${xOf(p.i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ')
  const areaPath =
    `M${xOf(pts[0].i).toFixed(1)},${(PT + cH).toFixed(1)} ` +
    pts.map(p => `L${xOf(p.i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ') +
    ` L${xOf(pts[pts.length - 1].i).toFixed(1)},${(PT + cH).toFixed(1)} Z`

  const step = Math.max(1, Math.ceil(n / 6))

  return (
    <svg viewBox={`0 0 ${VW} ${h}`} width="100%" height={h} style={{ display: 'block' }}>
      {[0, 0.5, 1].map((t, ti) => {
        const tv = vMin + t * range
        const ty = PT + (1 - t) * cH
        return (
          <g key={ti}>
            <line x1={PL} y1={ty} x2={VW - PR} y2={ty} stroke="rgba(148,163,184,0.12)" strokeWidth={0.7} />
            <text x={PL - 4} y={ty + 4} textAnchor="end" fontSize={9} fill="rgba(148,163,184,0.65)">{fmtMini(tv)}</text>
          </g>
        )
      })}
      <path d={areaPath} fill={areaColor} />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      {pts
        .filter(p => p.i % step === 0 || p.i === n - 1)
        .map(p => (
          <text key={p.i} x={xOf(p.i)} y={h - 4} textAnchor="middle" fontSize={8}
            fill="rgba(148,163,184,0.65)">{labels[p.i]}</text>
        ))}
    </svg>
  )
}

/**
 * Compact P/C Ratio time-series chart for the stock sidebar.
 * Renders OI Ratio (solid) and Vol Ratio (dashed) lines with a 1.0 reference
 * line plus light red/green tinted zones. Matches Balance Sheet chart dims
 * (h=110, vw=500) so it slots into .sip-stmt-chart-col cleanly.
 */
function SvgPcrRatioChart({ points, h = 130, vw = 500 }: {
  points: PutCallRatioHistoryPoint[]; h?: number; vw?: number
}) {
  const n = points.length
  if (n < 2) return null

  const oi = points.map(p => p.ratio_oi).filter((v): v is number => v != null && Number.isFinite(v))
  const vol = points.map(p => p.ratio_volume).filter((v): v is number => v != null && Number.isFinite(v))
  const all = [...oi, ...vol]
  if (all.length === 0) return null

  const rawMin = Math.min(...all)
  const rawMax = Math.max(...all)
  const pad = Math.max(0.05, (rawMax - rawMin) * 0.15)
  const yMin = Math.max(0, Math.min(rawMin, 1.0) - pad)
  const yMax = Math.max(rawMax, 1.0) + pad

  const PL = 32, PR = 8, PT = 8, PB = 18
  const cW = vw - PL - PR, cH = h - PT - PB
  const xOf = (i: number) => PL + (i / Math.max(n - 1, 1)) * cW
  const yOf = (v: number) => PT + ((yMax - v) / (yMax - yMin || 1)) * cH
  const refY = yOf(1.0)

  const oiPolyline = points
    .map((p, i) => (p.ratio_oi != null ? `${xOf(i).toFixed(1)},${yOf(p.ratio_oi).toFixed(1)}` : null))
    .filter(Boolean).join(' ')
  const volPolyline = points
    .map((p, i) => (p.ratio_volume != null ? `${xOf(i).toFixed(1)},${yOf(p.ratio_volume).toFixed(1)}` : null))
    .filter(Boolean).join(' ')

  const yTicks = [yMin, (yMin + yMax) / 2, yMax]
  const labelStep = Math.max(1, Math.ceil(n / 6))

  return (
    <svg viewBox={`0 0 ${vw} ${h}`} width="100%" height={h} style={{ display: 'block' }}>
      {/* zones */}
      <rect x={PL} y={PT} width={cW} height={Math.max(0, refY - PT)}
        fill="var(--color-lamp-red, #ef5350)" opacity={0.06} />
      <rect x={PL} y={refY} width={cW} height={Math.max(0, PT + cH - refY)}
        fill="var(--color-lamp-green, #66bb6a)" opacity={0.06} />
      {/* y grid + ticks */}
      {yTicks.map((tv, ti) => {
        const ty = yOf(tv)
        return (
          <g key={ti}>
            <line x1={PL} y1={ty} x2={vw - PR} y2={ty}
              stroke="rgba(148,163,184,0.12)" strokeWidth={0.7} />
            <text x={PL - 4} y={ty + 3} textAnchor="end" fontSize={9}
              fill="rgba(148,163,184,0.65)">{tv.toFixed(2)}</text>
          </g>
        )
      })}
      {/* 1.0 reference */}
      <line x1={PL} x2={vw - PR} y1={refY} y2={refY}
        stroke="rgba(255,255,255,0.28)" strokeWidth={1} strokeDasharray="4 3" />
      <text x={vw - PR + 2} y={refY + 3} fontSize={8.5}
        fill="rgba(148,163,184,0.7)">1.0</text>
      {/* lines */}
      {volPolyline && (
        <polyline points={volPolyline} fill="none" stroke="#f59e0b"
          strokeWidth={1.2} strokeDasharray="5 3" strokeLinejoin="round" />
      )}
      {oiPolyline && (
        <polyline points={oiPolyline} fill="none"
          stroke="var(--color-accent, #a3e635)" strokeWidth={1.6} strokeLinejoin="round" />
      )}
      {/* x labels */}
      {points.map((p, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return null
        return (
          <text key={i} x={xOf(i)} y={h - 4} textAnchor="middle" fontSize={8}
            fill="rgba(148,163,184,0.65)">{(p.trade_date ?? '').slice(5)}</text>
        )
      })}
    </svg>
  )
}

/**
 * Compact Put vs Call OI absolute-volume chart for the stock sidebar.
 * Two-line area chart in contract units. Same dims as SvgPcrRatioChart so it
 * slots into the second Balance-Sheet-style block consistently.
 */
function SvgPcrOiChart({ points, h = 130, vw = 500 }: {
  points: PutCallRatioHistoryPoint[]; h?: number; vw?: number
}) {
  const n = points.length
  if (n < 2) return null
  const all = points.flatMap(p => [p.put_oi_total, p.call_oi_total])
    .filter((v): v is number => v != null && Number.isFinite(v))
  if (all.length === 0) return null

  const yMax = Math.max(...all, 1) * 1.08
  const PL = 38, PR = 8, PT = 8, PB = 18
  const cW = vw - PL - PR, cH = h - PT - PB
  const xOf = (i: number) => PL + (i / Math.max(n - 1, 1)) * cW
  const yOf = (v: number) => PT + ((yMax - v) / (yMax || 1)) * cH

  const putPts = points.map((p, i) => p.put_oi_total != null
    ? `${xOf(i).toFixed(1)},${yOf(p.put_oi_total).toFixed(1)}` : null).filter(Boolean).join(' ')
  const callPts = points.map((p, i) => p.call_oi_total != null
    ? `${xOf(i).toFixed(1)},${yOf(p.call_oi_total).toFixed(1)}` : null).filter(Boolean).join(' ')

  const yTicks = [0, yMax / 2, yMax]
  const labelStep = Math.max(1, Math.ceil(n / 6))

  return (
    <svg viewBox={`0 0 ${vw} ${h}`} width="100%" height={h} style={{ display: 'block' }}>
      {yTicks.map((tv, ti) => {
        const ty = yOf(tv)
        return (
          <g key={ti}>
            <line x1={PL} y1={ty} x2={vw - PR} y2={ty}
              stroke="rgba(148,163,184,0.12)" strokeWidth={0.7} />
            <text x={PL - 4} y={ty + 3} textAnchor="end" fontSize={9}
              fill="rgba(148,163,184,0.65)">{fmtMini(tv)}</text>
          </g>
        )
      })}
      {putPts && (
        <polyline points={putPts} fill="none"
          stroke="var(--color-lamp-red, #ef5350)" strokeWidth={1.5} strokeLinejoin="round" />
      )}
      {callPts && (
        <polyline points={callPts} fill="none"
          stroke="var(--color-lamp-green, #66bb6a)" strokeWidth={1.5} strokeLinejoin="round" />
      )}
      {points.map((p, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return null
        return (
          <text key={i} x={xOf(i)} y={h - 4} textAnchor="middle" fontSize={8}
            fill="rgba(148,163,184,0.65)">{(p.trade_date ?? '').slice(5)}</text>
        )
      })}
    </svg>
  )
}

function fmtMarketValue(position: LivePositionRow): string {
  const q = Number(position.position)
  const px = position.price != null ? Number(position.price) : NaN
  if (!Number.isFinite(q) || !Number.isFinite(px)) return '—'
  return fmtUsd(q * px)
}

/** Display order + labels for the 8 SEPA fundamental conditions. */
const SEPA_COND_ORDER: { id: string; label: string }[] = [
  { id: 'eps_q2q_ge_25pct', label: 'EPS QoQ ≥ 25%' },
  { id: 'rev_q2q_ge_25pct', label: 'Revenue QoQ ≥ 25%' },
  { id: 'eps_acc_2q',       label: 'EPS Accelerating (2Q)' },
  { id: 'rev_acc_2q',       label: 'Revenue Accelerating (2Q)' },
  { id: 'eps_3y_ge_15pct',  label: 'EPS 3-Year CAGR ≥ 15%' },
  { id: 'rev_3y_ge_15pct',  label: 'Revenue 3-Year CAGR ≥ 15%' },
  { id: 'eps_acc_fy',       label: 'EPS Accelerating (FY)' },
  { id: 'rev_acc_fy',       label: 'Revenue Accelerating (FY)' },
]

const FUND_EXT_GROUP_META: { key: string; label: string }[] = [
  { key: 'quality',       label: 'Quality' },
  { key: 'balance',       label: 'Balance Sheet' },
  { key: 'cashflow',      label: 'Cash Flow' },
  { key: 'valuation',     label: 'Valuation' },
  { key: 'profitability', label: 'Profitability' },
  { key: 'efficiency',    label: 'Efficiency' },
  { key: 'sentiment',     label: 'Sentiment' },
]

/** Display order + labels for the 11 SEPA technical conditions. */
const TECH_COND_ORDER: { id: string; label: string }[] = [
  { id: 'avg_volume_50_gt_threshold', label: 'Avg Volume 50D > 100K' },
  { id: 'crs_ge_70',                  label: 'CRS ≥ 70' },
  { id: 'close_ge_low52_x_1_3',       label: 'Close ≥ Low52W × 1.3' },
  { id: 'close_ge_high52_x_0_75',     label: 'Close ≥ High52W × 0.75' },
  { id: 'sma50_gt_sma150',            label: 'SMA50 > SMA150' },
  { id: 'sma50_gt_sma200',            label: 'SMA50 > SMA200' },
  { id: 'sma150_gt_sma200',           label: 'SMA150 > SMA200' },
  { id: 'sma200_rising_1m',           label: 'SMA200 Rising (1M)' },
  { id: 'price_gt_sma50',             label: 'Price > SMA50' },
  { id: 'price_gt_sma150',            label: 'Price > SMA150' },
  { id: 'price_gt_sma200',            label: 'Price > SMA200' },
]

/** Optional pre-loaded fundamental snapshot passed by the caller (e.g. from a distribution chip). */
export interface FundamentalSeed {
  passCount: number
  /** IDs of conditions known to have passed; remaining are rendered as failed until full fetch resolves. */
  passedConditions?: string[]
  insufficientData?: boolean
}

export function StockInspectorPanel({
  symbol,
  accountId,
  position,
  fundamentalSeed,
  onClose,
}: {
  symbol: string
  accountId?: string
  position?: LivePositionRow
  fundamentalSeed?: FundamentalSeed
  onClose: () => void
}) {
  const symU = (symbol || '').trim().toUpperCase()
  const qty = position ? Number(position.position) : NaN
  const lastPrice =
    position && position.price != null && Number.isFinite(Number(position.price))
      ? Number(position.price)
      : null
  const avgCost =
    position && position.avgCost != null && Number.isFinite(Number(position.avgCost))
      ? Number(position.avgCost)
      : null
  const prevClose =
    position && position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
      ? Number(position.daily_prev_close)
      : null
  const pnl =
    position && position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
      ? Number(position.unrealized_pnl)
      : null
  const sincePct =
    pnl != null && avgCost != null && avgCost !== 0 && Number.isFinite(qty)
      ? (pnl / Math.abs(avgCost * qty)) * 100
      : null
  const dailyPnl =
    lastPrice != null && prevClose != null && Number.isFinite(qty) ? (lastPrice - prevClose) * qty : null
  const dailyPct =
    dailyPnl != null && prevClose != null && prevClose !== 0
      ? ((lastPrice! - prevClose) / prevClose) * 100
      : null

  const [benchClose, setBenchClose] = useState<number | null>(null)
  const [benchLoading, setBenchLoading] = useState(false)

  useEffect(() => {
    if (!symU || !position) return
    let cancelled = false
    setBenchLoading(true)
    fetchBarsBenchmark([symU])
      .then(({ benchmarks }) => {
        if (cancelled) return
        const b = benchmarks[symU]
        const c = b?.close != null && Number.isFinite(b.close) ? b.close : null
        setBenchClose(c)
      })
      .catch(() => {
        if (!cancelled) setBenchClose(null)
      })
      .finally(() => {
        if (!cancelled) setBenchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symU, position])

  // ── SEPA fundamental conditions (today's snapshot) ───────────────────────
  const [fund, setFund] = useState<SymbolFundamentalConditionsResponse | null>(null)
  const [fundLoading, setFundLoading] = useState(false)
  const [fundError, setFundError] = useState<string | null>(null)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setFundLoading(true)
    setFundError(null)
    fetchSymbolFundamentalConditions(symU)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setFundError(res.error ?? 'Failed')
          setFund(null)
        } else {
          setFund(res)
        }
      })
      .catch((e) => {
        if (!cancelled) setFundError(e instanceof Error ? e.message : 'Network error')
      })
      .finally(() => {
        if (!cancelled) setFundLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symU])

  /**
   * Resolved condition list, indexed by canonical 8-entry order:
   *  1) Prefer full API result (with actual/threshold/reason).
   *  2) Otherwise fall back to the caller-supplied seed (just pass/fail derived from `passedConditions`).
   *  3) Otherwise show empty placeholder rows (during initial loading or "not found").
   */
  const displayConditions = useMemo(() => {
    const apiByid = new Map<string, SymbolFundamentalConditionRow>()
    if (fund?.conditions) {
      for (const c of fund.conditions) apiByid.set(c.id, c)
    }
    const seedSet = new Set(fundamentalSeed?.passedConditions ?? [])
    return SEPA_COND_ORDER.map(({ id, label }) => {
      const api = apiByid.get(id)
      if (api) return { id, label, pass: api.pass, actual: api.actual, threshold: api.threshold, reason: api.reason, source: 'api' as const }
      if (fundamentalSeed) return { id, label, pass: seedSet.has(id), actual: null, threshold: null, reason: null, source: 'seed' as const }
      return { id, label, pass: false, actual: null, threshold: null, reason: null, source: 'placeholder' as const }
    })
  }, [fund, fundamentalSeed])

  const resolvedPassCount = fund?.pass_count ?? fundamentalSeed?.passCount ?? null
  const resolvedInsufficient = fund?.insufficient_data ?? fundamentalSeed?.insufficientData ?? false
  const overallPass = fund?.fundamental_pass ?? (resolvedPassCount === 8 ? true : null)
  const hasAnyFundData = fund?.found === true || fundamentalSeed != null

  // ── Raw income statement data ─────────────────────────────────────────────
  const [rawData, setRawData] = useState<SymbolFundRawDataResponse | null>(null)
  const [rawLoading, setRawLoading] = useState(false)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setRawLoading(true)
    fetchSymbolFundRawData(symU)
      .then((res) => { if (!cancelled) setRawData(res.ok ? res : null) })
      .catch(() => { if (!cancelled) setRawData(null) })
      .finally(() => { if (!cancelled) setRawLoading(false) })
    return () => { cancelled = true }
  }, [symU])

  // Which condition row the user last clicked (drives data table highlights)
  const [activeCond, setActiveCond] = useState<string | null>(null)

  /** Row-key helpers */
  const qKey = (r: FundRawQuarterRow) => `${r.fiscal_year}-Q${r.fiscal_quarter}`
  const aKey = (r: FundRawAnnualRow) => `${r.fiscal_year}`

  /** Derive which table-rows / column to highlight for the active condition. */
  const highlight = useMemo((): {
    qKeys: Set<string>
    aKeys: Set<string>
    col: 'eps' | 'revenues' | null
  } => {
    const qKeys = new Set<string>()
    const aKeys = new Set<string>()
    if (!activeCond || !rawData) return { qKeys, aKeys, col: null }
    const qRows = rawData.quarterly
    const aRows = rawData.annual

    switch (activeCond) {
      case 'eps_q2q_ge_25pct': {
        if (qRows[0]) {
          qKeys.add(qKey(qRows[0]))
          const prior = qRows.find(r => r.fiscal_year === qRows[0].fiscal_year - 1 && r.fiscal_quarter === qRows[0].fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        }
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_q2q_ge_25pct': {
        if (qRows[0]) {
          qKeys.add(qKey(qRows[0]))
          const prior = qRows.find(r => r.fiscal_year === qRows[0].fiscal_year - 1 && r.fiscal_quarter === qRows[0].fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        }
        return { qKeys, aKeys, col: 'revenues' }
      }
      case 'eps_acc_2q': {
        qRows.slice(0, 3).forEach(r => {
          qKeys.add(qKey(r))
          const prior = qRows.find(p => p.fiscal_year === r.fiscal_year - 1 && p.fiscal_quarter === r.fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        })
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_acc_2q': {
        qRows.slice(0, 3).forEach(r => {
          qKeys.add(qKey(r))
          const prior = qRows.find(p => p.fiscal_year === r.fiscal_year - 1 && p.fiscal_quarter === r.fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        })
        return { qKeys, aKeys, col: 'revenues' }
      }
      case 'eps_3y_ge_15pct': {
        if (aRows[0]) aKeys.add(aKey(aRows[0]))
        if (aRows[3]) aKeys.add(aKey(aRows[3]))
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_3y_ge_15pct': {
        if (aRows[0]) aKeys.add(aKey(aRows[0]))
        if (aRows[3]) aKeys.add(aKey(aRows[3]))
        return { qKeys, aKeys, col: 'revenues' }
      }
      case 'eps_acc_fy': {
        aRows.slice(0, 3).forEach(r => aKeys.add(aKey(r)))
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_acc_fy': {
        aRows.slice(0, 3).forEach(r => aKeys.add(aKey(r)))
        return { qKeys, aKeys, col: 'revenues' }
      }
      default:
        return { qKeys, aKeys, col: null }
    }
  }, [activeCond, rawData])

  // ── SEPA technical conditions (today's snapshot) ─────────────────────────
  const [tech, setTech] = useState<SymbolTechnicalConditionsResponse | null>(null)
  const [techLoading, setTechLoading] = useState(false)
  const [techError, setTechError] = useState<string | null>(null)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setTechLoading(true)
    setTechError(null)
    fetchSymbolTechnicalConditions(symU)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setTechError(res.error ?? 'Failed')
          setTech(null)
        } else {
          setTech(res)
        }
      })
      .catch((e) => { if (!cancelled) setTechError(e instanceof Error ? e.message : 'Network error') })
      .finally(() => { if (!cancelled) setTechLoading(false) })
    return () => { cancelled = true }
  }, [symU])

  const techPassCount = tech?.pass_count ?? null
  const techInsufficient = tech?.insufficient_data ?? false
  const techOverallPass = tech?.technical_pass ?? null
  const hasAnyTechData = tech?.found === true

  const displayTechConditions = useMemo(() => {
    const apiById = new Map<string, SymbolTechnicalConditionRow>()
    if (tech?.conditions) {
      for (const c of tech.conditions) apiById.set(c.id, c)
    }
    return TECH_COND_ORDER.map(({ id, label }) => {
      const api = apiById.get(id)
      if (api) return { id, label, pass: api.pass, actual: api.actual, threshold: api.threshold, reason: api.reason, source: 'api' as const }
      return { id, label, pass: false, actual: null, threshold: null, reason: null, source: 'placeholder' as const }
    })
  }, [tech])

  // ── Ticker overview (tickers + ticker_overview + related_tickers) ───────────
  const [overview, setOverview] = useState<TickerOverviewResponse | null>(null)
  const [descExpanded, setDescExpanded] = useState(false)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setOverview(null)
    setDescExpanded(false)
    fetchTickerOverview(symU)
      .then((res) => { if (!cancelled) setOverview(res) })
      .catch(() => { /* silently ignore */ })
    return () => { cancelled = true }
  }, [symU])

  // ── Statements data (balance sheet, cash flow, ratios, short data) ──────────
  // Put/Call Ratio
  const [pcrSeries, setPcrSeries] = useState<PutCallRatioHistoryPoint[]>([])
  const [pcrLoading, setPcrLoading] = useState(false)
  const [pcrExpanded, setPcrExpanded] = useState(true)

  useEffect(() => {
    if (!symU || !pcrExpanded) return
    let cancelled = false
    setPcrLoading(true)
    fetchPutCallRatioHistory({ symbol: symU, lookbackDays: 60 })
      .then((res) => { if (!cancelled) setPcrSeries(res.ok ? res.series : []) })
      .catch(() => { if (!cancelled) setPcrSeries([]) })
      .finally(() => { if (!cancelled) setPcrLoading(false) })
    return () => { cancelled = true }
  }, [symU, pcrExpanded])

  const [stmts, setStmts] = useState<SymbolStatementsResponse | null>(null)
  const [stmtsLoading, setStmtsLoading] = useState(false)
  const [stmtsExpanded, setStmtsExpanded] = useState(true)

  useEffect(() => {
    if (!symU || !stmtsExpanded) return
    if (stmts?.symbol === symU) return
    let cancelled = false
    setStmtsLoading(true)
    fetchSymbolStatements(symU)
      .then((res) => { if (!cancelled) setStmts(res.ok ? res : null) })
      .catch(() => { if (!cancelled) setStmts(null) })
      .finally(() => { if (!cancelled) setStmtsLoading(false) })
    return () => { cancelled = true }
  }, [symU, stmtsExpanded, stmts?.symbol])

  function fmtVal(v: number | string | null | undefined): string {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '—'
      // Heuristic: fractions (|v| <= 5) likely % values
      if (Math.abs(v) <= 5) return `${(v * 100).toFixed(2)}%`
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }
    return String(v)
  }

  /** Format large monetary values as $XB / $XM / $XK */
  function fmtM(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—'
    const abs = Math.abs(v)
    const sign = v < 0 ? '-' : ''
    if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
    return `${sign}$${abs.toFixed(0)}`
  }

  function cfCls(v: number | null | undefined): string {
    if (v == null) return ''
    return v >= 0 ? 'sip-stmts-pos' : 'sip-stmts-neg'
  }

  function fmtRatio(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—'
    return v.toFixed(1)
  }

  function fmtPct2(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—'
    return `${(v * 100).toFixed(1)}%`
  }

  function passBadgeTone(n: number | null): string {
    if (n == null) return 'sip-pass-badge--unknown'
    if (n === 8) return 'sip-pass-badge--full'
    if (n >= 4) return 'sip-pass-badge--partial'
    return 'sip-pass-badge--poor'
  }

  function fmtEps(v: number | null): string {
    if (v == null) return '—'
    return `$${v.toFixed(2)}`
  }

  function fmtRev(v: number | null): string {
    if (v == null) return '—'
    const abs = Math.abs(v)
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
    return `$${v.toFixed(0)}`
  }

  return (
    <div className="riv-stock-inspector" aria-label="Stock position detail">
      <div className="od-detail-header riv-stock-inspector-header">
        <h3 className="od-detail-title">
          {symU}
          {accountId && <span className="od-detail-expiry"> · {accountId}</span>}
          {resolvedPassCount != null && (
            <span className={`sip-pass-badge ${passBadgeTone(resolvedPassCount)}`}>
              F {resolvedPassCount}/8
            </span>
          )}
          {techPassCount != null && (
            <span className={`sip-pass-badge ${techPassCount === 11 ? 'sip-pass-badge--full' : techPassCount >= 7 ? 'sip-pass-badge--partial' : 'sip-pass-badge--poor'}`}>
              T {techPassCount}/11
            </span>
          )}
        </h3>
        <button type="button" className="od-detail-close" onClick={onClose} aria-label="Close stock inspector">
          ✕
        </button>
      </div>

      <div className="od-contract-detail-stack">

        {/* Ticker Overview — company name, sector/industry, market cap, description, related */}
        {overview?.found && (
          <section className="sip-overview-section">
            {/* Row 1: meta chips */}
            <div className="sip-overview-meta-row">
              {overview.name && (
                <span className="sip-overview-name">{overview.name}</span>
              )}
              {overview.sector && <span className="sip-overview-chip sip-overview-chip--sector">{overview.sector}</span>}
              {overview.industry && overview.industry !== overview.sector && (
                <span className="sip-overview-chip">{overview.industry}</span>
              )}
              {(overview.primary_exchange || overview.exchange) && (
                <span className="sip-overview-chip sip-overview-chip--exch">{overview.primary_exchange || overview.exchange}</span>
              )}
              {overview.market_cap != null && (
                <span className="sip-overview-chip sip-overview-chip--num" title="Market Cap">
                  {overview.market_cap >= 1e12
                    ? `$${(overview.market_cap / 1e12).toFixed(2)}T`
                    : overview.market_cap >= 1e9
                    ? `$${(overview.market_cap / 1e9).toFixed(1)}B`
                    : `$${(overview.market_cap / 1e6).toFixed(0)}M`}
                </span>
              )}
              {overview.total_employees != null && (
                <span className="sip-overview-chip sip-overview-chip--num" title="Employees">
                  {overview.total_employees >= 1000
                    ? `${(overview.total_employees / 1000).toFixed(0)}K emp`
                    : `${overview.total_employees} emp`}
                </span>
              )}
              {overview.list_date && (
                <span className="sip-overview-chip sip-overview-chip--dim" title="IPO / List Date">
                  est. {overview.list_date.slice(0, 4)}
                </span>
              )}
              {overview.homepage_url && (
                <a
                  className="sip-overview-chip sip-overview-chip--link"
                  href={overview.homepage_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={overview.homepage_url}
                >
                  ↗
                </a>
              )}
            </div>

            {/* Row 2: description */}
            {overview.description && (
              <div className="sip-overview-desc-wrap">
                <p
                  className={`sip-overview-desc${descExpanded ? ' sip-overview-desc--expanded' : ''}`}
                  onClick={() => setDescExpanded((v) => !v)}
                  title={descExpanded ? 'Click to collapse' : 'Click to expand'}
                >
                  {overview.description}
                </p>
              </div>
            )}

            {/* Row 3: related tickers — always rendered */}
            <div className="sip-overview-related">
              <span className="sip-overview-related-label">Related</span>
              {overview.related_tickers && overview.related_tickers.length > 0
                ? overview.related_tickers.map((s) => (
                    <span key={s} className="sip-overview-related-chip">{s}</span>
                  ))
                : <span className="sip-overview-related-none">No related tickers on record</span>
              }
            </div>
          </section>
        )}

        {position && (
          <section className="od-detail-section" aria-labelledby="riv-stock-sec-position">
            <h4 id="riv-stock-sec-position" className="od-detail-section-title">
              Position
            </h4>
            <div className="od-kv-grid">
              <span className="od-kv-k">Side</span>
              <span className="od-kv-v">{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</span>
              <span className="od-kv-k">Qty</span>
              <span className="od-kv-v">{Number.isFinite(qty) ? String(qty) : '—'}</span>
              <span className="od-kv-k">Avg cost</span>
              <span className="od-kv-v">{fmtUsd(position.avgCost)}</span>
              <span className="od-kv-k">Last</span>
              <span className="od-kv-v">{fmtUsd(position.price)}</span>
              <span className="od-kv-k">Market value</span>
              <span className="od-kv-v">{fmtMarketValue(position)}</span>
              <span className="od-kv-k">Daily $</span>
              <span className={`od-kv-v ${(dailyPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {dailyPnl != null ? fmtUsd(dailyPnl) : '—'}
              </span>
              <span className="od-kv-k">Daily %</span>
              <span className={`od-kv-v ${(dailyPct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {dailyPct != null ? fmtPctCompact(dailyPct) : '—'}
              </span>
              <span className="od-kv-k">Since $</span>
              <span className={`od-kv-v ${(pnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {pnl != null ? fmtUsd(pnl) : '—'}
              </span>
              <span className="od-kv-k">Since %</span>
              <span className={`od-kv-v ${(sincePct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {sincePct != null ? fmtPctCompact(sincePct) : '—'}
              </span>
            </div>
          </section>
        )}

        {position && (
          <section className="od-detail-section" aria-labelledby="riv-stock-sec-benchmark">
            <h4 id="riv-stock-sec-benchmark" className="od-detail-section-title">
              Daily benchmark
            </h4>
            {benchLoading && <p className="section-hint">Loading stock_day close…</p>}
            {!benchLoading && benchClose != null && (
              <div className="od-kv-grid">
                <span className="od-kv-k">stock_day close</span>
                <span className="od-kv-v">{fmtUsd(benchClose)}</span>
              </div>
            )}
            {!benchLoading && benchClose == null && <p className="section-hint">No benchmark bar for this symbol.</p>}
          </section>
        )}

        {/* SEPA Fundamental + Technical — side by side two-column grid */}
        <div className="sip-conditions-grid">

        {/* SEPA Fundamental Conditions */}
        <section className="od-detail-section sip-fund-section" aria-labelledby="riv-stock-sec-fund">
          <h4 id="riv-stock-sec-fund" className="od-detail-section-title sip-fund-title">
            <span>SEPA Fundamental Conditions</span>
            {fund?.as_of_date && (
              <span className="sip-fund-asof" title="as_of_date">
                {fund.as_of_date}
              </span>
            )}
          </h4>

          {fundLoading && !fund && !fundamentalSeed && (
            <p className="section-hint sip-fund-hint">Loading conditions…</p>
          )}

          {fundError && !hasAnyFundData && (
            <p className="section-hint sip-fund-hint sip-fund-hint--err">{fundError}</p>
          )}

          {!fundLoading && !fundError && !hasAnyFundData && (
            <p className="section-hint sip-fund-hint">
              No fundamentals snapshot recorded for this symbol yet.
            </p>
          )}

          {hasAnyFundData && (
            <>
              {resolvedInsufficient && (
                <p className="sip-fund-callout sip-fund-callout--warn">
                  Insufficient data: not all required statements are available.
                </p>
              )}

              {rawData && (
                <p className="sip-raw-hint">Click a condition to highlight the source data below</p>
              )}

              <ul className="sip-cond-list">
                {displayConditions.map((c) => {
                  const isActive = activeCond === c.id
                  return (
                    <li
                      key={c.id}
                      className={`sip-cond-row sip-cond-row--${c.pass ? 'pass' : 'fail'}${isActive ? ' sip-cond-row--active' : ''}${rawData ? ' sip-cond-row--clickable' : ''}`}
                      onClick={() => setActiveCond(isActive ? null : c.id)}
                      role={rawData ? 'button' : undefined}
                      tabIndex={rawData ? 0 : undefined}
                      onKeyDown={rawData ? (e) => { if (e.key === 'Enter' || e.key === ' ') setActiveCond(isActive ? null : c.id) } : undefined}
                      title={rawData ? (isActive ? 'Click to deselect' : 'Click to highlight source data') : undefined}
                    >
                      <span className={`sip-cond-icon sip-cond-icon--${c.pass ? 'pass' : 'fail'}`} aria-hidden>
                        {c.pass ? '✓' : '✕'}
                      </span>
                      <span className="sip-cond-label">{c.label}</span>
                      {c.source === 'api' && (c.actual != null || c.threshold != null) ? (
                        <span className="sip-cond-metric" title={c.reason ?? undefined}>
                          <span className="sip-cond-actual">{fmtVal(c.actual)}</span>
                          <span className="sip-cond-vs"> / </span>
                          <span className="sip-cond-threshold">{fmtVal(c.threshold)}</span>
                        </span>
                      ) : (
                        <span className={`sip-cond-pill ${c.pass ? 'sip-cond-pill--pass' : 'sip-cond-pill--fail'}`}>
                          {c.pass ? 'PASS' : 'FAIL'}
                        </span>
                      )}
                      {rawData && <span className="sip-cond-chevron">{isActive ? '▴' : '▾'}</span>}
                    </li>
                  )
                })}
              </ul>

              {overallPass != null && (
                <div className={`sip-fund-summary ${overallPass ? 'sip-fund-summary--ok' : 'sip-fund-summary--warn'}`}>
                  <span className="sip-fund-summary-label">Overall</span>
                  <span className="sip-fund-summary-value">
                    {overallPass ? 'PASS (8/8)' : `${resolvedPassCount ?? 0} / 8`}
                  </span>
                </div>
              )}

              {/* Extension fundamental groups (quality, balance, cashflow, etc.) */}
              {fund?.groups && (() => {
                const groups = fund.groups!
                const extConds = (fund.conditions ?? []).filter(c => c.group && c.group !== 'sepa_core')
                if (extConds.length === 0) return null
                return (
                  <div className="sip-ext-groups">
                    {FUND_EXT_GROUP_META.map(({ key, label }) => {
                      const gs = groups[key]
                      if (!gs) return null
                      const groupConds = extConds.filter(c => c.group === key)
                      if (groupConds.length === 0) return null
                      return (
                        <details key={key} className="sip-ext-group">
                          <summary className="sip-ext-group-header">
                            <span className="sip-ext-group-label">{label}</span>
                            <span className={`sip-ext-group-badge ${gs.pass ? 'sip-ext-group-badge--pass' : gs.insufficient ? 'sip-ext-group-badge--insuf' : 'sip-ext-group-badge--fail'}`}>
                              {gs.pass_count}/{gs.total}
                            </span>
                          </summary>
                          <ul className="sip-cond-list sip-cond-list--ext">
                            {groupConds.map((c) => (
                              <li key={c.id} className={`sip-cond-row sip-cond-row--${c.pass ? 'pass' : 'fail'}`}>
                                <span className={`sip-cond-icon sip-cond-icon--${c.pass ? 'pass' : 'fail'}`} aria-hidden>
                                  {c.pass ? '✓' : '✕'}
                                </span>
                                <span className="sip-cond-label">{c.id.replace(/_/g, ' ')}</span>
                                {c.actual != null || c.threshold != null ? (
                                  <span className="sip-cond-metric" title={c.reason ?? undefined}>
                                    <span className="sip-cond-actual">{fmtVal(c.actual)}</span>
                                    <span className="sip-cond-vs"> / </span>
                                    <span className="sip-cond-threshold">{fmtVal(c.threshold)}</span>
                                  </span>
                                ) : (
                                  <span className={`sip-cond-pill ${c.pass ? 'sip-cond-pill--pass' : 'sip-cond-pill--fail'}`}>
                                    {c.pass ? 'PASS' : 'FAIL'}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )
                    })}
                  </div>
                )
              })()}
            </>
          )}
        </section>

        {/* SEPA Technical Conditions */}
        <section className="od-detail-section sip-fund-section" aria-labelledby="riv-stock-sec-tech">
          <h4 id="riv-stock-sec-tech" className="od-detail-section-title sip-fund-title">
            <span>SEPA Technical Conditions</span>
            {tech?.as_of_date && (
              <span className="sip-fund-asof" title="as_of_date">{tech.as_of_date}</span>
            )}
          </h4>

          {techLoading && !tech && (
            <p className="section-hint sip-fund-hint">Loading conditions…</p>
          )}
          {techError && !hasAnyTechData && (
            <p className="section-hint sip-fund-hint sip-fund-hint--err">{techError}</p>
          )}
          {!techLoading && !techError && !hasAnyTechData && (
            <p className="section-hint sip-fund-hint">
              No technical snapshot recorded for this symbol yet. Run the technical backfill.
            </p>
          )}

          {hasAnyTechData && (
            <>
              {techInsufficient && (
                <p className="sip-fund-callout sip-fund-callout--warn">
                  Insufficient data: fewer than 252 bars available.
                </p>
              )}
              <ul className="sip-cond-list">
                {displayTechConditions.map((c) => (
                  <li
                    key={c.id}
                    className={`sip-cond-row sip-cond-row--${c.pass ? 'pass' : 'fail'}`}
                  >
                    <span className={`sip-cond-icon sip-cond-icon--${c.pass ? 'pass' : 'fail'}`} aria-hidden>
                      {c.pass ? '✓' : '✕'}
                    </span>
                    <span className="sip-cond-label">{c.label}</span>
                    {c.source === 'api' && (c.actual != null || c.threshold != null) ? (
                      <span className="sip-cond-metric" title={c.reason ?? undefined}>
                        <span className="sip-cond-actual">
                          {c.actual != null
                            ? (Math.abs(Number(c.actual)) < 1e4 ? Number(c.actual).toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(c.actual).toLocaleString())
                            : '—'}
                        </span>
                        {c.threshold != null && (
                          <>
                            <span className="sip-cond-vs"> / </span>
                            <span className="sip-cond-threshold">
                              {Number(c.threshold).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className={`sip-cond-pill ${c.pass ? 'sip-cond-pill--pass' : 'sip-cond-pill--fail'}`}>
                        {c.pass ? 'PASS' : 'FAIL'}
                      </span>
                    )}
                    <span />
                  </li>
                ))}
              </ul>
              {techOverallPass != null && (
                <div className={`sip-fund-summary ${techOverallPass ? 'sip-fund-summary--ok' : 'sip-fund-summary--warn'}`}>
                  <span className="sip-fund-summary-label">Overall</span>
                  <span className="sip-fund-summary-value">
                    {techOverallPass ? 'PASS (11/11)' : `${techPassCount ?? 0} / 11`}
                  </span>
                </div>
              )}

              {/* ── Tier 2: Momentum ── */}
              {tech?.tiers?.momentum && tech.tiers.momentum.indicators.length > 0 && (
                <details className="sip-tier-details">
                  <summary className="sip-tier-summary">
                    <span>Momentum</span>
                    <span className="sip-tier-score">{tech.tiers.momentum.score} / {tech.tiers.momentum.max}</span>
                  </summary>
                  <ul className="sip-cond-list sip-tier-list">
                    {tech.tiers.momentum.indicators.map((ind) => (
                      <li key={ind.id} className={`sip-cond-row sip-cond-row--${ind.pass ? 'pass' : 'fail'}`}>
                        <span className={`sip-cond-icon sip-cond-icon--${ind.pass ? 'pass' : 'fail'}`} aria-hidden>
                          {ind.pass ? '✓' : '✕'}
                        </span>
                        <span className="sip-cond-label">{ind.id.replace(/_/g, ' ')}</span>
                        <span className="sip-cond-metric" title={ind.reason ?? undefined}>
                          {ind.actual != null ? (typeof ind.actual === 'number' ? ind.actual.toFixed(3) : String(ind.actual)) : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* ── Tier 3: Structure & Patterns ── */}
              {tech?.tiers?.structure && (tech.tiers.structure.diagnostics.length > 0 || tech.tiers.structure.patterns.length > 0) && (
                <details className="sip-tier-details">
                  <summary className="sip-tier-summary">
                    <span>Structure & Patterns</span>
                    <span className="sip-tier-badge">
                      {tech.tiers.structure.diagnostics.filter((d) => d.active).length} active
                    </span>
                  </summary>
                  <ul className="sip-cond-list sip-tier-list">
                    {tech.tiers.structure.diagnostics.map((d) => (
                      <li key={d.id} className={`sip-cond-row sip-cond-row--${d.active ? 'pass' : 'fail'}`}>
                        <span className={`sip-cond-icon sip-cond-icon--${d.active ? 'pass' : 'fail'}`} aria-hidden>
                          {d.active ? '●' : '○'}
                        </span>
                        <span className="sip-cond-label">{d.id.replace(/_/g, ' ')}</span>
                        <span className="sip-cond-metric">
                          {d.value != null ? (typeof d.value === 'number' ? d.value.toFixed(3) : String(d.value)) : '—'}
                        </span>
                      </li>
                    ))}
                    {tech.tiers.structure.patterns.map((p) => (
                      <li key={p.id} className="sip-cond-row sip-cond-row--neutral">
                        <span className="sip-cond-icon" aria-hidden>◆</span>
                        <span className="sip-cond-label">{p.id.replace(/_/g, ' ')}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* ── Tier 4: Sentiment ── */}
              {tech?.tiers?.sentiment?.indicators && tech.tiers.sentiment.indicators.length > 0 && (
                <details className="sip-tier-details">
                  <summary className="sip-tier-summary">
                    <span>Sentiment (Short)</span>
                    {tech.tiers.sentiment.short.staleness_days != null && (
                      <span className="sip-tier-badge">{tech.tiers.sentiment.short.staleness_days}d stale</span>
                    )}
                  </summary>
                  <ul className="sip-cond-list sip-tier-list">
                    {tech.tiers.sentiment.indicators.map((ind) => (
                      <li key={ind.id} className={`sip-cond-row sip-cond-row--${ind.pass ? 'pass' : 'fail'}`}>
                        <span className={`sip-cond-icon sip-cond-icon--${ind.pass ? 'pass' : 'fail'}`} aria-hidden>
                          {ind.pass ? '✓' : '✕'}
                        </span>
                        <span className="sip-cond-label">{ind.id.replace(/_/g, ' ')}</span>
                        <span className="sip-cond-metric" title={ind.reason ?? undefined}>
                          {ind.actual != null ? String(ind.actual) : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {tech.tiers.sentiment.short.days_to_cover != null && (
                    <div className="sip-tier-metric-row">
                      <span>Days to Cover</span>
                      <span>{tech.tiers.sentiment.short.days_to_cover}</span>
                    </div>
                  )}
                  {tech.tiers.sentiment.short.sv_ratio_avg_4w != null && (
                    <div className="sip-tier-metric-row">
                      <span>Short Vol Ratio (4W Avg)</span>
                      <span>{(tech.tiers.sentiment.short.sv_ratio_avg_4w * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </details>
              )}
            </>
          )}
        </section>

        </div>{/* end sip-conditions-grid */}

        {/* Raw income statement data — highlighted by active condition */}
        {(rawData || rawLoading) && (
          <section className="od-detail-section sip-raw-section" aria-labelledby="riv-stock-sec-raw">
            <h4 id="riv-stock-sec-raw" className="od-detail-section-title sip-raw-title">
              Source Data
              {activeCond && highlight.col && (
                <span className="sip-raw-active-label">
                  {' '}— {activeCond.replace(/_/g, ' ')}
                  <span className={`sip-raw-col-badge sip-raw-col-badge--${highlight.col}`}>
                    {highlight.col === 'eps' ? 'EPS' : 'Revenue'}
                  </span>
                </span>
              )}
            </h4>

            {rawLoading && <p className="section-hint">Loading source data…</p>}

            {rawData && rawData.quarterly.length > 0 && (() => {
              const [minQEps, maxQEps] = colRange(rawData.quarterly.map(r => r.eps))
              const [minQRev, maxQRev] = colRange(rawData.quarterly.map(r => r.revenues))
              return (
                <>
                  <div className="sip-raw-table-label">Quarterly</div>
                  <table className="sip-raw-table">
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th className={highlight.col === 'eps' ? 'sip-raw-th--active' : ''}>EPS</th>
                        <th className={highlight.col === 'revenues' ? 'sip-raw-th--active' : ''}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawData.quarterly.map((r) => {
                        const k = qKey(r)
                        const rowHit = highlight.qKeys.has(k)
                        return (
                          <tr key={k} className={rowHit ? 'sip-raw-row--hit' : ''}>
                            <td className="sip-raw-period">Q{r.fiscal_quarter}-{r.fiscal_year}</td>
                            <td className={`sip-mini-bar-cell${rowHit && highlight.col === 'eps' ? ' sip-raw-cell--highlight' : ''}`}>
                              {fmtEps(r.eps)}<MiniBar value={r.eps} min={minQEps} max={maxQEps} />
                            </td>
                            <td className={`sip-mini-bar-cell${rowHit && highlight.col === 'revenues' ? ' sip-raw-cell--highlight' : ''}`}>
                              {fmtRev(r.revenues)}<MiniBar value={r.revenues} min={minQRev} max={maxQRev} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </>
              )
            })()}

            {rawData && rawData.annual.length > 0 && (() => {
              const [minAEps, maxAEps] = colRange(rawData.annual.map(r => r.eps))
              const [minARev, maxARev] = colRange(rawData.annual.map(r => r.revenues))
              return (
                <>
                  <div className="sip-raw-table-label" style={{ marginTop: 12 }}>Annual</div>
                  <table className="sip-raw-table">
                    <thead>
                      <tr>
                        <th>Year</th>
                        <th className={highlight.col === 'eps' ? 'sip-raw-th--active' : ''}>EPS</th>
                        <th className={highlight.col === 'revenues' ? 'sip-raw-th--active' : ''}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawData.annual.map((r) => {
                        const k = aKey(r)
                        const rowHit = highlight.aKeys.has(k)
                        return (
                          <tr key={k} className={rowHit ? 'sip-raw-row--hit' : ''}>
                            <td className="sip-raw-period">FY{r.fiscal_year}</td>
                            <td className={`sip-mini-bar-cell${rowHit && highlight.col === 'eps' ? ' sip-raw-cell--highlight' : ''}`}>
                              {fmtEps(r.eps)}<MiniBar value={r.eps} min={minAEps} max={maxAEps} />
                            </td>
                            <td className={`sip-mini-bar-cell${rowHit && highlight.col === 'revenues' ? ' sip-raw-cell--highlight' : ''}`}>
                              {fmtRev(r.revenues)}<MiniBar value={r.revenues} min={minARev} max={maxARev} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </>
              )
            })()}

            {rawData && rawData.quarterly.length === 0 && rawData.annual.length === 0 && (
              <p className="section-hint">No income statement data found for this symbol.</p>
            )}
          </section>
        )}

        {/* Bar Stats — price action, chart, massive sync (symbol-only dependency) */}
        {symU && <StockBarStatsPanel symbol={symU} embedded />}

        {/* Put/Call Ratio section */}
        {symU && (
          <section className="od-detail-section sip-stmts-section" aria-labelledby="riv-stock-sec-pcr">
            <h4
              id="riv-stock-sec-pcr"
              className="od-detail-section-title sip-stmts-toggle"
              onClick={() => setPcrExpanded((v) => !v)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPcrExpanded((v) => !v) }}
              title={pcrExpanded ? 'Collapse Put/Call Ratio' : 'Expand Put/Call Ratio'}
            >
              <span>Put/Call Ratio</span>
              <span className="sip-stmts-toggle-arrow">{pcrExpanded ? '▴' : '▾'}</span>
            </h4>

            {pcrExpanded && (
              <>
                {pcrLoading && <p className="section-hint">Loading PCR data…</p>}
                {!pcrLoading && pcrSeries.length === 0 && (
                  <p className="section-hint">No PCR data. Run EOD pipeline from Stock Data Readiness.</p>
                )}
                {!pcrLoading && pcrSeries.length > 0 && (() => {
                  const latest = pcrSeries[pcrSeries.length - 1]
                  const prev5 = pcrSeries.slice(-6, -1)
                  const validPrev5 = prev5.filter(p => p.ratio_oi != null)
                  const avg5Oi = validPrev5.length > 0
                    ? validPrev5.reduce((s, p) => s + p.ratio_oi!, 0) / validPrev5.length
                    : null
                  const fmtR = (v: number | null) => v != null ? v.toFixed(3) : '—'
                  const fmtKi = (v: number | null) => {
                    if (v == null) return '—'
                    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
                    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}k`
                    return `${v.toFixed(0)}`
                  }
                  // Newest-first rows (cap at 12 for compact display, mirroring Balance Sheet)
                  const tableRows = [...pcrSeries].reverse().slice(0, 12)

                  return (
                    <div className="sip-pcr-block">
                      {/* Headline metrics — kept compact above the blocks */}
                      <div className="sip-pcr-metrics">
                        <div className="sip-pcr-metric">
                          <span className="sip-pcr-label">OI Ratio</span>
                          <span className={`sip-pcr-value ${latest.ratio_oi != null && latest.ratio_oi > 1 ? 'sip-pcr-value--bearish' : 'sip-pcr-value--bullish'}`}>
                            {fmtR(latest.ratio_oi)}
                          </span>
                        </div>
                        <div className="sip-pcr-metric">
                          <span className="sip-pcr-label">Vol Ratio</span>
                          <span className={`sip-pcr-value ${latest.ratio_volume != null && latest.ratio_volume > 1 ? 'sip-pcr-value--bearish' : 'sip-pcr-value--bullish'}`}>
                            {fmtR(latest.ratio_volume)}
                          </span>
                        </div>
                        <div className="sip-pcr-metric">
                          <span className="sip-pcr-label">5d Avg OI</span>
                          <span className="sip-pcr-value">{avg5Oi != null ? avg5Oi.toFixed(3) : '—'}</span>
                        </div>
                        <div className="sip-pcr-metric">
                          <span className="sip-pcr-label">Latest</span>
                          <span className="sip-pcr-value sip-pcr-value--neutral">{latest.trade_date.slice(5)}</span>
                        </div>
                      </div>

                      {/* Block 1: P/C Ratio Trend — chart left | table right */}
                      <div className="sip-stmts-block">
                        <div className="sip-stmt-block-head">
                          <span className="sip-stmts-block-title">P/C Ratio Trend</span>
                          <div className="sip-chart-legend">
                            <span className="sip-legend-dot" style={{ background: 'var(--color-accent, #a3e635)' }} />OI Ratio
                            <span className="sip-legend-dot" style={{ background: '#f59e0b' }} />Vol Ratio
                            <span className="sip-legend-dot sip-legend-dot--ref" />1.0 ref
                          </div>
                        </div>
                        <div className="sip-stmt-chart-table">
                          <div className="sip-stmt-chart-col">
                            <SvgPcrRatioChart points={pcrSeries} />
                          </div>
                          <div className="sip-stmt-table-col">
                            <table className="sip-raw-table sip-stmt-compact-table">
                              <thead>
                                <tr><th>Date</th><th>OI Rt</th><th>Vol Rt</th></tr>
                              </thead>
                              <tbody>
                                {tableRows.map((r) => (
                                  <tr key={r.trade_date}>
                                    <td className="sip-raw-period">{r.trade_date.slice(5)}</td>
                                    <td className={r.ratio_oi != null && r.ratio_oi > 1 ? 'sip-pcr-cell--bearish' : 'sip-pcr-cell--bullish'}>
                                      {fmtR(r.ratio_oi)}
                                    </td>
                                    <td className={r.ratio_volume != null && r.ratio_volume > 1 ? 'sip-pcr-cell--bearish' : 'sip-pcr-cell--bullish'}>
                                      {fmtR(r.ratio_volume)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>

                      {/* Block 2: Open Interest — chart left | table right */}
                      <div className="sip-stmts-block">
                        <div className="sip-stmt-block-head">
                          <span className="sip-stmts-block-title">Open Interest</span>
                          <div className="sip-chart-legend">
                            <span className="sip-legend-dot" style={{ background: 'var(--color-lamp-red, #ef5350)' }} />Put OI
                            <span className="sip-legend-dot" style={{ background: 'var(--color-lamp-green, #66bb6a)' }} />Call OI
                          </div>
                        </div>
                        <div className="sip-stmt-chart-table">
                          <div className="sip-stmt-chart-col">
                            <SvgPcrOiChart points={pcrSeries} />
                          </div>
                          <div className="sip-stmt-table-col">
                            <table className="sip-raw-table sip-stmt-compact-table">
                              <thead>
                                <tr><th>Date</th><th>Put OI</th><th>Call OI</th></tr>
                              </thead>
                              <tbody>
                                {tableRows.map((r) => (
                                  <tr key={r.trade_date}>
                                    <td className="sip-raw-period">{r.trade_date.slice(5)}</td>
                                    <td style={{ color: 'var(--color-lamp-red, #ef5350)' }}>{fmtKi(r.put_oi_total)}</td>
                                    <td style={{ color: 'var(--color-lamp-green, #66bb6a)' }}>{fmtKi(r.call_oi_total)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>

                      <p className="section-hint sip-pcr-hint">
                        OI ratio &gt; 1 = more puts (bearish lean) · {pcrSeries.length}d history
                      </p>
                    </div>
                  )
                })()}
              </>
            )}
          </section>
        )}

        {/* Statements section (balance sheet, cash flow, ratios, short interest/volume) */}
        <section className="od-detail-section sip-stmts-section" aria-labelledby="riv-stock-sec-stmts">
          <h4
            id="riv-stock-sec-stmts"
            className="od-detail-section-title sip-stmts-toggle"
            onClick={() => setStmtsExpanded((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setStmtsExpanded((v) => !v) }}
            title={stmtsExpanded ? 'Collapse statements' : 'Load statements data'}
          >
            <span>Statements</span>
            <span className="sip-stmts-toggle-arrow">{stmtsExpanded ? '▴' : '▾'}</span>
          </h4>

          {stmtsExpanded && (
            <>
              {stmtsLoading && <p className="section-hint">Loading…</p>}

              {/* Balance Sheet — chart left | key-column table right */}
              {stmts && stmts.balance_sheets.length > 0 && (() => {
                const bs = [...stmts.balance_sheets].reverse()
                const lbls = bs.map(r => `Q${r.fiscal_quarter}'${String(r.fiscal_year).slice(2)}`)
                return (
                  <div className="sip-stmts-block">
                    <div className="sip-stmt-block-head">
                      <span className="sip-stmts-block-title">Balance Sheet</span>
                      <div className="sip-chart-legend">
                        <span className="sip-legend-dot" style={{ background: 'rgba(74,222,128,0.85)' }} />Cash
                        <span className="sip-legend-dot" style={{ background: 'rgba(56,189,248,0.85)' }} />Equity
                        <span className="sip-legend-dot" style={{ background: 'rgba(248,113,113,0.75)' }} />LT Debt
                      </div>
                    </div>
                    <div className="sip-stmt-chart-table">
                      <div className="sip-stmt-chart-col">
                        <SvgBarChart labels={lbls} h={110} vw={500} series={[
                          { key: 'Cash',    color: 'rgba(74,222,128,0.82)',  values: bs.map(r => r.cash_and_equivalents) },
                          { key: 'Equity',  color: 'rgba(56,189,248,0.82)',  values: bs.map(r => r.total_equity) },
                          { key: 'LT Debt', color: 'rgba(248,113,113,0.72)', values: bs.map(r => r.long_term_debt_and_capital_lease_obligations) },
                        ]} />
                      </div>
                      <div className="sip-stmt-table-col">
                        <table className="sip-raw-table sip-stmt-compact-table">
                          <thead>
                            <tr><th>Period</th><th>Cash</th><th>Equity</th><th>LT Debt</th><th>Retained</th></tr>
                          </thead>
                          <tbody>
                            {stmts.balance_sheets.map((r) => (
                              <tr key={r.period_end}>
                                <td className="sip-raw-period">Q{r.fiscal_quarter}'{String(r.fiscal_year).slice(2)}</td>
                                <td>{fmtM(r.cash_and_equivalents)}</td>
                                <td>{fmtM(r.total_equity)}</td>
                                <td>{fmtM(r.long_term_debt_and_capital_lease_obligations)}</td>
                                <td className={r.retained_earnings_deficit != null && r.retained_earnings_deficit < 0 ? 'sip-stmts-neg' : ''}>
                                  {fmtM(r.retained_earnings_deficit)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Cash Flow — chart left | compact table right */}
              {stmts && stmts.cash_flows.length > 0 && (() => {
                const cf = [...stmts.cash_flows].reverse()
                const lbls = cf.map(r => `Q${r.fiscal_quarter}'${String(r.fiscal_year).slice(2)}`)
                const allCf = stmts.cash_flows
                const [minNI, maxNI] = colRange(allCf.map(r => r.net_income))
                const [minOp, maxOp] = colRange(allCf.map(r => r.net_cash_from_operating_activities))
                return (
                  <div className="sip-stmts-block">
                    <div className="sip-stmt-block-head">
                      <span className="sip-stmts-block-title">Cash Flow</span>
                      <div className="sip-chart-legend">
                        <span className="sip-legend-dot" style={{ background: 'rgba(74,222,128,0.85)' }} />Net Inc
                        <span className="sip-legend-dot" style={{ background: 'rgba(99,179,237,0.85)' }} />Op CF
                      </div>
                    </div>
                    <div className="sip-stmt-chart-table">
                      <div className="sip-stmt-chart-col">
                        <SvgBarChart labels={lbls} h={110} vw={500} series={[
                          { key: 'Net Income', color: 'rgba(74,222,128,0.82)', negColor: 'rgba(248,113,113,0.75)', values: cf.map(r => r.net_income) },
                          { key: 'Op CF',      color: 'rgba(99,179,237,0.82)', negColor: 'rgba(248,113,113,0.65)',  values: cf.map(r => r.net_cash_from_operating_activities) },
                        ]} />
                      </div>
                      <div className="sip-stmt-table-col">
                        <table className="sip-raw-table sip-stmt-compact-table">
                          <thead>
                            <tr><th>Period</th><th>Net Inc</th><th>Op CF</th><th>Inv CF</th><th>Capex</th></tr>
                          </thead>
                          <tbody>
                            {allCf.map((r) => (
                              <tr key={r.period_end}>
                                <td className="sip-raw-period">Q{r.fiscal_quarter}'{String(r.fiscal_year).slice(2)}</td>
                                <td className={`sip-mini-bar-cell ${cfCls(r.net_income)}`}>
                                  {fmtM(r.net_income)}<MiniBar value={r.net_income} min={minNI} max={maxNI} />
                                </td>
                                <td className={`sip-mini-bar-cell ${cfCls(r.net_cash_from_operating_activities)}`}>
                                  {fmtM(r.net_cash_from_operating_activities)}<MiniBar value={r.net_cash_from_operating_activities} min={minOp} max={maxOp} />
                                </td>
                                <td className={cfCls(r.net_cash_from_investing_activities)}>{fmtM(r.net_cash_from_investing_activities)}</td>
                                <td>{fmtM(r.purchase_of_property_plant_and_equipment)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Ratios */}
              {stmts && stmts.ratios.length > 0 && (
                <div className="sip-stmts-block">
                  <div className="sip-stmts-block-title">Ratios (TTM)</div>
                  <div className="sip-stmts-scroll">
                    <table className="sip-raw-table sip-stmts-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>P/E</th>
                          <th>P/S</th>
                          <th>P/B</th>
                          <th>D/E</th>
                          <th>ROE</th>
                          <th>ROA</th>
                          <th>EPS</th>
                          <th>Mkt Cap</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stmts.ratios.map((r) => (
                          <tr key={r.date}>
                            <td className="sip-raw-period">{r.date}</td>
                            <td>{fmtRatio(r.price_to_earnings)}</td>
                            <td>{fmtRatio(r.price_to_sales)}</td>
                            <td>{fmtRatio(r.price_to_book)}</td>
                            <td>{fmtRatio(r.debt_to_equity)}</td>
                            <td>{fmtPct2(r.return_on_equity)}</td>
                            <td>{fmtPct2(r.return_on_assets)}</td>
                            <td>{r.earnings_per_share != null ? `$${r.earnings_per_share.toFixed(2)}` : '—'}</td>
                            <td>{fmtM(r.market_cap)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Short Interest — chart left (shares short bar) | compact table right */}
              {stmts && stmts.short_interest.length > 0 && (() => {
                const si = [...stmts.short_interest].reverse()
                const lbls = si.map(r => r.settlement_date.slice(5).replace('-', '/'))
                return (
                  <div className="sip-stmts-block">
                    <div className="sip-stmt-block-head">
                      <span className="sip-stmts-block-title">Short Interest</span>
                      <div className="sip-chart-legend">
                        <span className="sip-legend-dot" style={{ background: 'rgba(248,113,113,0.8)' }} />Shares Short
                        <span className="sip-legend-dot" style={{ background: 'rgba(251,191,36,0.8)' }} />Days-to-Cover
                      </div>
                    </div>
                    <div className="sip-stmt-chart-table">
                      <div className="sip-stmt-chart-col">
                        <SvgBarChart labels={lbls} h={110} vw={500} series={[
                          { key: 'Short Interest', color: 'rgba(248,113,113,0.75)', values: si.map(r => r.short_interest) },
                        ]} />
                        <SvgAreaChart labels={lbls} values={si.map(r => r.days_to_cover)}
                          color="rgba(251,191,36,0.9)" areaColor="rgba(251,191,36,0.1)" h={60} vw={500} />
                      </div>
                      <div className="sip-stmt-table-col">
                        <table className="sip-raw-table sip-stmt-compact-table">
                          <thead>
                            <tr><th>Settlement</th><th>Short Int</th><th>Avg Vol</th><th>Days</th></tr>
                          </thead>
                          <tbody>
                            {stmts.short_interest.map((r) => (
                              <tr key={r.settlement_date}>
                                <td className="sip-raw-period">{r.settlement_date.slice(5)}</td>
                                <td>{fmtM(r.short_interest)}</td>
                                <td>{fmtM(r.avg_daily_volume)}</td>
                                <td>{r.days_to_cover != null ? r.days_to_cover.toFixed(1) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Short Volume — area chart (short ratio %) left | compact table right */}
              {stmts && stmts.short_volume.length > 0 && (() => {
                const sv = [...stmts.short_volume].reverse()
                const lbls = sv.map(r => r.trade_date.slice(5).replace('-', '/'))
                return (
                  <div className="sip-stmts-block">
                    <div className="sip-stmt-block-head">
                      <span className="sip-stmts-block-title">Short Volume</span>
                      <div className="sip-chart-legend">
                        <span className="sip-legend-dot" style={{ background: 'rgba(239,68,68,0.8)' }} />Short Vol Ratio (%)
                      </div>
                    </div>
                    <div className="sip-stmt-chart-table">
                      <div className="sip-stmt-chart-col">
                        <SvgAreaChart
                          labels={lbls}
                          values={sv.map(r => r.short_volume_ratio != null ? r.short_volume_ratio * 100 : null)}
                          color="rgba(239,68,68,0.9)"
                          areaColor="rgba(239,68,68,0.12)"
                          h={110} vw={500}
                        />
                      </div>
                      <div className="sip-stmt-table-col">
                        <table className="sip-raw-table sip-stmt-compact-table">
                          <thead>
                            <tr><th>Date</th><th>Short Vol</th><th>Ratio</th><th>Total</th></tr>
                          </thead>
                          <tbody>
                            {stmts.short_volume.map((r) => (
                              <tr key={r.trade_date}>
                                <td className="sip-raw-period">{r.trade_date.slice(5)}</td>
                                <td>{fmtM(r.short_volume)}</td>
                                <td>{r.short_volume_ratio != null ? `${(r.short_volume_ratio * 100).toFixed(1)}%` : '—'}</td>
                                <td>{fmtM(r.total_volume)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {stmts && !stmtsLoading &&
                stmts.balance_sheets.length === 0 &&
                stmts.cash_flows.length === 0 &&
                stmts.ratios.length === 0 &&
                stmts.short_interest.length === 0 &&
                stmts.short_volume.length === 0 && (
                  <p className="section-hint">No statements data found for this symbol.</p>
                )}
            </>
          )}
        </section>

      </div>
    </div>
  )
}
