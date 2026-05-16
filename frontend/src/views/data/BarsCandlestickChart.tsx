import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Bar } from '../../types'
import { fmtTs, fmtTsForPeriod, fmtUsd } from '../../utils/format'
import {
  bollingerSeries,
  macdSeries,
  normalizeBarForChart,
  pivotLevelsFromHlc,
  rsiSeries,
  swingHighLow,
} from './barsChartMath'

export interface BarsCandlestickChartProps {
  bars: Bar[]
  period?: string
  /** When true, draw VWAP line when bar data includes vwap (or server synthetic). */
  showVwap?: boolean
  enableTimeRangeBrush?: boolean
  /** Volume panel below price (default true when any bar has volume). */
  showVolume?: boolean
  showMacd?: boolean
  showBollinger?: boolean
  showRsi?: boolean
  /** Pivot (prev bar H/L/C) + 20-bar swing high/low as horizontal lines. */
  showSr?: boolean
}

/** API may send vwap as string; Number.isFinite rejects strings. */
export function finiteVwap(raw: unknown): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

const VWAP_STROKE = '#0ea5e9'
const BB_UPPER = '#a78bfa'
const BB_MID = '#94a3b8'
const BB_LOWER = '#a78bfa'
const MACD_LINE = '#38bdf8'
const MACD_SIG = '#f97316'
const RSI_STROKE = '#e879f9'
const SR_PIVOT = '#facc15'
const SR_SWING = '#22d3ee'

const CHART_WIDTH = 800
const PADDING_LEFT = 56
const PADDING_RIGHT = 16

function xForFullIndex(
  fullIdx: number,
  fullCount: number,
  innerWidth: number,
  paddingLeft: number,
): number {
  if (fullCount <= 1) return paddingLeft + innerWidth / 2
  return paddingLeft + (fullIdx / (fullCount - 1)) * innerWidth
}

function svgClientXToSvgX(svgEl: SVGSVGElement, clientX: number, viewBoxWidth: number): number {
  const rect = svgEl.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return ((clientX - rect.left) / rect.width) * viewBoxWidth
}

export function BarsCandlestickChart({
  bars: rawBars,
  period = '1 D',
  showVwap = true,
  enableTimeRangeBrush = false,
  showVolume = true,
  showMacd = false,
  showBollinger = false,
  showRsi = false,
  showSr = false,
}: BarsCandlestickChartProps) {
  const fullBars = useMemo(
    () => (rawBars || []).map(normalizeBarForChart).filter((x): x is Bar => x != null),
    [rawBars],
  )

  const svgRef = useRef<SVGSVGElement>(null)
  const [viewRange, setViewRange] = useState<{ startIdx: number; endIdx: number } | null>(null)
  const [drag, setDrag] = useState<{ anchorIdx: number; x0: number; x1: number } | null>(null)

  useEffect(() => {
    setViewRange(null)
  }, [fullBars])

  const fullCount = fullBars.length
  const view = useMemo(() => {
    if (fullCount === 0) return { startIdx: 0, endIdx: -1 }
    if (viewRange == null) {
      return { startIdx: 0, endIdx: fullCount - 1 }
    }
    const a = Math.max(0, Math.min(fullCount - 1, Math.min(viewRange.startIdx, viewRange.endIdx)))
    const b = Math.max(0, Math.min(fullCount - 1, Math.max(viewRange.startIdx, viewRange.endIdx)))
    return { startIdx: Math.min(a, b), endIdx: Math.max(a, b) }
  }, [fullCount, viewRange])

  const bars = useMemo(() => {
    if (fullCount === 0) return []
    return fullBars.slice(view.startIdx, view.endIdx + 1)
  }, [fullBars, fullCount, view.startIdx, view.endIdx])

  const isFiltered = viewRange != null && (view.startIdx > 0 || view.endIdx < fullCount - 1)

  const closesAll = useMemo(() => fullBars.map(b => b.close), [fullBars])
  const rsiAll = useMemo(() => (showRsi && fullBars.length > 0 ? rsiSeries(closesAll, 14) : []), [closesAll, fullBars.length, showRsi])
  const macdAll = useMemo(() => (showMacd && fullBars.length > 0 ? macdSeries(closesAll) : []), [closesAll, fullBars.length, showMacd])
  const bbAll = useMemo(
    () => (showBollinger && fullBars.length > 0 ? bollingerSeries(closesAll, 20, 2) : []),
    [closesAll, fullBars.length, showBollinger],
  )

  const pivotLevels = useMemo(() => {
    if (!showSr || fullBars.length < 2) return null
    const ref = fullBars[fullBars.length - 2]
    return pivotLevelsFromHlc(ref.high, ref.low, ref.close)
  }, [fullBars, showSr])

  const swing = useMemo(() => {
    if (!showSr || fullBars.length < 3) return null
    const hs = fullBars.map(b => b.high)
    const ls = fullBars.map(b => b.low)
    return swingHighLow(hs, ls, 20)
  }, [fullBars, showSr])

  const width = CHART_WIDTH
  const priceHeight = 200
  const volumeHeight = 72
  const macdHeight = 78
  const rsiHeight = 58
  const gap = 8
  const paddingLeft = PADDING_LEFT
  const paddingRight = PADDING_RIGHT
  const paddingTop = 12
  const paddingBottom = 28

  const priceStats = useMemo(() => {
    const pricePoints: number[] = []
    for (const b of bars) {
      if (Number.isFinite(b.high)) pricePoints.push(b.high)
      if (Number.isFinite(b.low)) pricePoints.push(b.low)
      if (showBollinger) {
        for (let li = 0; li < bars.length; li++) {
          const g = view.startIdx + li
          const pt = bbAll[g]
          if (pt?.upper != null) pricePoints.push(pt.upper)
          if (pt?.lower != null) pricePoints.push(pt.lower)
        }
      }
      if (showVwap) {
        const vw = finiteVwap(b.vwap)
        if (vw != null) pricePoints.push(vw)
      }
    }
    if (showSr && pivotLevels) {
      pricePoints.push(pivotLevels.p, pivotLevels.r1, pivotLevels.s1, pivotLevels.r2, pivotLevels.s2)
    }
    if (showSr && swing) {
      pricePoints.push(swing.resistance, swing.support)
    }
    if (pricePoints.length === 0) return null
    const minPrice = Math.min(...pricePoints)
    const maxPrice = Math.max(...pricePoints)
    const priceRange = maxPrice - minPrice || 1
    const hasVolume = bars.some(b => b.volume != null && Number.isFinite(b.volume))
    const volumes = bars.map(b => (b.volume != null && Number.isFinite(b.volume) ? Number(b.volume) : 0))
    const maxVolume = hasVolume ? Math.max(...volumes, 1) : 1
    return { minPrice, maxPrice, priceRange, hasVolume, volumes, maxVolume }
  }, [bars, showVwap, showBollinger, bbAll, view.startIdx, showSr, pivotLevels, swing])

  const showVolPanel = showVolume && (priceStats?.hasVolume ?? false)
  const innerWidth = width - paddingLeft - paddingRight
  const innerPriceHeight = priceHeight
  const innerVolumeHeight = volumeHeight
  const innerMacdHeight = showMacd ? macdHeight : 0
  const innerRsiHeight = showRsi ? rsiHeight : 0

  const volumeTop = paddingTop + priceHeight + gap
  const volumeBottom = volumeTop + innerVolumeHeight

  let stackBottom = paddingTop + innerPriceHeight
  if (showVolPanel) stackBottom = volumeBottom
  const macdTop = showMacd ? stackBottom + gap : 0
  if (showMacd) stackBottom = macdTop + innerMacdHeight
  const rsiTop = showRsi ? stackBottom + gap : 0
  if (showRsi) stackBottom = rsiTop + innerRsiHeight
  const height = stackBottom + paddingBottom

  const xTickIndices = useMemo(() => {
    const n = bars.length
    if (n <= 1) return [0]
    const count = Math.min(6, n)
    const step = (n - 1) / (count - 1)
    return Array.from({ length: count }, (_, i) => Math.round(i * step))
  }, [bars.length])

  const svgXToFullIdx = useCallback(
    (svgX: number) => {
      const left = paddingLeft
      const right = paddingLeft + innerWidth
      if (svgX < left) return 0
      if (svgX > right) return fullCount - 1
      if (fullCount <= 1) return 0
      const t = (svgX - left) / innerWidth
      return Math.max(0, Math.min(fullCount - 1, Math.round(t * (fullCount - 1))))
    },
    [fullCount, innerWidth, paddingLeft],
  )

  const onBrushPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enableTimeRangeBrush || !svgRef.current) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const x = svgClientXToSvgX(svgRef.current, e.clientX, width)
      const anchorIdx = svgXToFullIdx(x)
      setDrag({ anchorIdx, x0: x, x1: x })
    },
    [enableTimeRangeBrush, svgXToFullIdx, width],
  )

  const onBrushPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!svgRef.current) return
      const x = svgClientXToSvgX(svgRef.current, e.clientX, width)
      setDrag(d => (d ? { ...d, x1: x } : null))
    },
    [width],
  )

  const onBrushPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!enableTimeRangeBrush || !svgRef.current) return
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const x = svgClientXToSvgX(svgRef.current, e.clientX, width)
      const endIdx = svgXToFullIdx(x)
      setDrag(prev => {
        if (!prev) return null
        const a = Math.min(prev.anchorIdx, endIdx)
        const b = Math.max(prev.anchorIdx, endIdx)
        setViewRange({ startIdx: a, endIdx: b })
        return null
      })
    },
    [enableTimeRangeBrush, svgXToFullIdx, width],
  )

  const onBrushPointerCancel = useCallback(() => {
    setDrag(null)
  }, [])

  const vwapLineEls = useMemo(() => {
    if (!showVwap || !priceStats) return [] as ReactElement[]
    const { minPrice, priceRange } = priceStats
    const xForIndex = (i: number) =>
      xForFullIndex(view.startIdx + i, fullCount, innerWidth, paddingLeft)
    const yAt = (p: number) => paddingTop + innerPriceHeight * (1 - (p - minPrice) / priceRange)
    const els: ReactElement[] = []
    if (bars.length === 1) {
      const v = finiteVwap(bars[0].vwap)
      if (v != null) {
        els.push(
          <circle
            key="vwap-dot-0"
            cx={xForIndex(0)}
            cy={yAt(v)}
            r={4}
            fill={VWAP_STROKE}
            fillOpacity={0.95}
            stroke={VWAP_STROKE}
            strokeWidth={1}
            vectorEffect="nonScalingStroke"
            pointerEvents="none"
          />,
        )
      }
      return els
    }
    for (let i = 0; i < bars.length - 1; i++) {
      const v0 = finiteVwap(bars[i].vwap)
      const v1 = finiteVwap(bars[i + 1].vwap)
      if (v0 == null || v1 == null) continue
      els.push(
        <line
          key={`vwap-${i}`}
          x1={xForIndex(i)}
          y1={yAt(v0)}
          x2={xForIndex(i + 1)}
          y2={yAt(v1)}
          stroke={VWAP_STROKE}
          strokeWidth={2}
          strokeOpacity={1}
          strokeLinecap="round"
          vectorEffect="nonScalingStroke"
          pointerEvents="none"
        />,
      )
    }
    return els
  }, [
    bars,
    fullCount,
    innerWidth,
    paddingLeft,
    innerPriceHeight,
    paddingTop,
    priceStats,
    showVwap,
    view.startIdx,
  ])

  const bollingerEls = useMemo(() => {
    if (!showBollinger || !priceStats || bars.length === 0) return [] as ReactElement[]
    const { minPrice, priceRange } = priceStats
    const yAt = (p: number) => paddingTop + innerPriceHeight * (1 - (p - minPrice) / priceRange)
    const xForIndex = (i: number) =>
      xForFullIndex(view.startIdx + i, fullCount, innerWidth, paddingLeft)
    const mkPoly = (key: string, stroke: string, pick: (g: number) => number | null) => {
      const pts: string[] = []
      for (let i = 0; i < bars.length; i++) {
        const g = view.startIdx + i
        const v = pick(g)
        if (v == null || !Number.isFinite(v)) continue
        pts.push(`${xForIndex(i)},${yAt(v)}`)
      }
      if (pts.length < 2) return null
      return (
        <polyline
          key={key}
          fill="none"
          stroke={stroke}
          strokeWidth={key.includes('mid') ? 1.25 : 1}
          strokeDasharray={key.includes('mid') ? '4 3' : undefined}
          points={pts.join(' ')}
          vectorEffect="nonScalingStroke"
          pointerEvents="none"
          opacity={0.95}
        />
      )
    }
    return [
      mkPoly('bb-up', BB_UPPER, g => bbAll[g]?.upper ?? null),
      mkPoly('bb-mid', BB_MID, g => bbAll[g]?.mid ?? null),
      mkPoly('bb-lo', BB_LOWER, g => bbAll[g]?.lower ?? null),
    ].filter(Boolean) as ReactElement[]
  }, [bars, bbAll, fullCount, innerWidth, paddingLeft, innerPriceHeight, paddingTop, priceStats, showBollinger, view.startIdx])

  const srLineEls = useMemo(() => {
    if (!showSr || !priceStats) return [] as ReactElement[]
    const { minPrice, priceRange } = priceStats
    const yAt = (p: number) => paddingTop + innerPriceHeight * (1 - (p - minPrice) / priceRange)
    const x1 = paddingLeft
    const x2 = paddingLeft + innerWidth
    const els: ReactElement[] = []
    const addH = (key: string, p: number, stroke: string, dash: string | undefined, label: string) => {
      if (!Number.isFinite(p)) return
      const y = yAt(p)
      els.push(
        <line
          key={key}
          x1={x1}
          y1={y}
          x2={x2}
          y2={y}
          stroke={stroke}
          strokeWidth={1}
          strokeDasharray={dash}
          vectorEffect="nonScalingStroke"
          pointerEvents="none"
        />,
      )
      els.push(
        <text key={`${key}-lbl`} x={x2 - 4} y={y - 2} textAnchor="end" fontSize="9" fill={stroke}>
          {label}
        </text>,
      )
    }
    if (pivotLevels) {
      addH('sr-p', pivotLevels.p, SR_PIVOT, '4 2', 'P')
      addH('sr-r1', pivotLevels.r1, SR_PIVOT, '2 2', 'R1')
      addH('sr-s1', pivotLevels.s1, SR_PIVOT, '2 2', 'S1')
      addH('sr-r2', pivotLevels.r2, SR_PIVOT, '6 3', 'R2')
      addH('sr-s2', pivotLevels.s2, SR_PIVOT, '6 3', 'S2')
    }
    if (swing) {
      addH('sr-rsw', swing.resistance, SR_SWING, undefined, 'RH')
      addH('sr-ssw', swing.support, SR_SWING, undefined, 'RL')
    }
    return els
  }, [innerWidth, paddingLeft, paddingTop, innerPriceHeight, pivotLevels, priceStats, showSr, swing])

  const dragPreviewEl = useMemo(() => {
    if (!drag) return null
    const x1 = Math.min(drag.x0, drag.x1)
    const x2 = Math.max(drag.x0, drag.x1)
    return (
      <rect
        x={x1}
        y={paddingTop}
        width={Math.max(1, x2 - x1)}
        height={(showVolPanel ? volumeBottom : paddingTop + innerPriceHeight) - paddingTop}
        fill="rgba(14, 165, 233, 0.18)"
        stroke="rgba(14, 165, 233, 0.55)"
        strokeWidth={1}
        pointerEvents="none"
      />
    )
  }, [drag, paddingTop, innerPriceHeight, showVolPanel, volumeBottom])

  const macdPanelEls = useMemo(() => {
    if (!showMacd || !priceStats || bars.length === 0 || macdTop <= 0 || innerMacdHeight <= 0) return [] as ReactElement[]
    const xs = (i: number) => xForFullIndex(view.startIdx + i, fullCount, innerWidth, paddingLeft)
    let mn = Infinity
    let mx = -Infinity
    for (let i = 0; i < bars.length; i++) {
      const g = view.startIdx + i
      const pt = macdAll[g]
      if (!pt) continue
      for (const v of [pt.macd, pt.signal, pt.hist]) {
        if (v != null && Number.isFinite(v)) {
          mn = Math.min(mn, v)
          mx = Math.max(mx, v)
        }
      }
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
      mn = -1
      mx = 1
    }
    const pad = (mx - mn) * 0.08 || 0.01
    mn -= pad
    mx += pad
    const rng = mx - mn || 1
    const yM = (v: number) => macdTop + innerMacdHeight * (1 - (v - mn) / rng)
    const els: ReactElement[] = []
    els.push(
      <rect
        key="macd-bg"
        x={paddingLeft}
        y={macdTop}
        width={innerWidth}
        height={innerMacdHeight}
        fill="var(--color-surface)"
        stroke="var(--color-border)"
        strokeWidth={1}
        rx={6}
      />,
    )
    els.push(
      <line
        key="macd-zero"
        x1={paddingLeft}
        x2={paddingLeft + innerWidth}
        y1={yM(0)}
        y2={yM(0)}
        stroke="var(--color-border-strong)"
        strokeDasharray="3 3"
        strokeWidth={0.75}
      />,
    )
    for (let i = 0; i < bars.length; i++) {
      const g = view.startIdx + i
      const pt = macdAll[g]
      if (pt?.hist == null || !Number.isFinite(pt.hist)) continue
      const x = xs(i)
      const xn = i + 1 < bars.length ? xs(i + 1) : x
      const w = Math.max(1, Math.abs(xn - x) * 0.55)
      const y0 = yM(0)
      const y1 = yM(pt.hist)
      const top = Math.min(y0, y1)
      const h = Math.max(1, Math.abs(y1 - y0))
      els.push(
        <rect
          key={`macd-hist-${g}`}
          x={x - w / 2}
          y={top}
          width={w}
          height={h}
          fill={pt.hist >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)'}
        />,
      )
    }
    const linePts = (pick: (p: NonNullable<(typeof macdAll)[0]>) => number | null) => {
      const pts: string[] = []
      for (let i = 0; i < bars.length; i++) {
        const g = view.startIdx + i
        const pt = macdAll[g]
        if (!pt) continue
        const v = pick(pt)
        if (v == null || !Number.isFinite(v)) continue
        pts.push(`${xs(i)},${yM(v)}`)
      }
      return pts
    }
    const mPts = linePts(pt => pt.macd)
    const sPts = linePts(pt => pt.signal)
    if (mPts.length >= 2) {
      els.push(
        <polyline key="macd-m" fill="none" stroke={MACD_LINE} strokeWidth={1.5} points={mPts.join(' ')} vectorEffect="nonScalingStroke" />,
      )
    }
    if (sPts.length >= 2) {
      els.push(
        <polyline key="macd-s" fill="none" stroke={MACD_SIG} strokeWidth={1.25} points={sPts.join(' ')} vectorEffect="nonScalingStroke" />,
      )
    }
    els.push(
      <text key="macd-lbl" x={paddingLeft + 4} y={macdTop + 12} fontSize="10" fill="var(--color-text-muted)">
        MACD
      </text>,
    )
    return els
  }, [
    bars.length,
    fullCount,
    innerWidth,
    innerMacdHeight,
    macdAll,
    macdTop,
    paddingLeft,
    priceStats,
    showMacd,
    view.startIdx,
  ])

  const rsiPanelEls = useMemo(() => {
    if (!showRsi || rsiTop <= 0 || bars.length === 0) return [] as ReactElement[]
    const xs = (i: number) => xForFullIndex(view.startIdx + i, fullCount, innerWidth, paddingLeft)
    const yR = (rv: number) => rsiTop + innerRsiHeight * (1 - rv / 100)
    const els: ReactElement[] = []
    els.push(
      <rect
        key="rsi-bg"
        x={paddingLeft}
        y={rsiTop}
        width={innerWidth}
        height={innerRsiHeight}
        fill="var(--color-surface)"
        stroke="var(--color-border)"
        strokeWidth={1}
        rx={6}
      />,
    )
    for (const lvl of [30, 50, 70]) {
      els.push(
        <line
          key={`rsi-${lvl}`}
          x1={paddingLeft}
          x2={paddingLeft + innerWidth}
          y1={yR(lvl)}
          y2={yR(lvl)}
          stroke={lvl === 50 ? 'var(--color-border)' : 'var(--color-border-strong)'}
          strokeDasharray={lvl === 50 ? '2 4' : '3 3'}
          strokeWidth={0.6}
        />,
      )
    }
    const pts: string[] = []
    for (let i = 0; i < bars.length; i++) {
      const g = view.startIdx + i
      const rv = rsiAll[g]
      if (rv == null || !Number.isFinite(rv)) continue
      pts.push(`${xs(i)},${yR(rv)}`)
    }
    if (pts.length >= 2) {
      els.push(
        <polyline key="rsi-line" fill="none" stroke={RSI_STROKE} strokeWidth={1.5} points={pts.join(' ')} vectorEffect="nonScalingStroke" />,
      )
    }
    els.push(
      <text key="rsi-lbl" x={paddingLeft + 4} y={rsiTop + 12} fontSize="10" fill="var(--color-text-muted)">
        RSI(14)
      </text>,
    )
    return els
  }, [bars.length, fullCount, innerRsiHeight, innerWidth, paddingLeft, rsiAll, rsiTop, showRsi, view.startIdx])

  if (fullCount === 0) {
    return (
      <div className="data-bars-chart">
        <p className="section-hint" style={{ margin: 0 }}>No bar rows to chart.</p>
      </div>
    )
  }

  if (!priceStats) {
    return (
      <div className="data-bars-chart">
        <p className="section-hint" style={{ margin: 0 }}>Unable to derive price scale (check OHLC values).</p>
      </div>
    )
  }

  const { minPrice, maxPrice, priceRange, hasVolume, volumes, maxVolume } = priceStats

  const xForLocalIndex = (localI: number) =>
    xForFullIndex(view.startIdx + localI, fullCount, innerWidth, paddingLeft)
  const xForIndex = (i: number) => xForLocalIndex(i)

  const visibleCount = bars.length
  const xStep =
    visibleCount > 1 ? xForLocalIndex(1) - xForLocalIndex(0) : innerWidth

  const yForPrice = (p: number) =>
    paddingTop + innerPriceHeight * (1 - (p - minPrice) / priceRange)

  const yForVolume = (v: number) =>
    volumeBottom - (v / maxVolume) * innerVolumeHeight

  const topLabel = maxPrice
  const midLabel = minPrice + priceRange / 2
  const bottomLabel = minPrice
  const candleWidthFactor =
    period === '1 min' ? 0.2
      : period === '5 mins' ? 0.26
        : period === '1 hour' ? 0.38
          : 0.6
  const candleWidthMin =
    period === '1 min' ? 1.1
      : period === '5 mins' ? 1.4
        : period === '1 hour' ? 2
          : 3
  const candleWidthMax =
    period === '1 min' ? 5
      : period === '5 mins' ? 6.5
        : period === '1 hour' ? 10
          : 18
  const volumeBarWidthFactor =
    period === '1 min' ? 0.16
      : period === '5 mins' ? 0.2
        : period === '1 hour' ? 0.32
          : 0.5
  const volumeBarWidthMin =
    period === '1 min' ? 0.7
      : period === '5 mins' ? 0.9
        : period === '1 hour' ? 1.2
          : 1.5
  const volumeBarWidthMax =
    period === '1 min' ? 4
      : period === '5 mins' ? 5
        : period === '1 hour' ? 8
          : 12

  const lastBar = bars[bars.length - 1]
  const lastVwap = lastBar ? finiteVwap(lastBar.vwap) : null

  const firstFull = fullBars[view.startIdx]
  const lastFull = fullBars[view.endIdx]

  const brushBottom = (showVolPanel ? volumeBottom : paddingTop + innerPriceHeight)

  return (
    <div className="data-bars-chart">
      {enableTimeRangeBrush && fullCount > 1 && (
        <p className="data-bars-chart-brush-hint">
          Drag on the chart to select a time range. Double-click the chart to reset.
        </p>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="data-bars-chart-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label="Candlestick preview for loaded bars"
        onDoubleClick={() => {
          if (enableTimeRangeBrush) setViewRange(null)
        }}
      >
        <defs>
          <linearGradient id="data-bars-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-surface-elevated)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--color-surface)" stopOpacity="0.9" />
          </linearGradient>
        </defs>

        <rect
          x={paddingLeft}
          y={paddingTop}
          width={innerWidth}
          height={innerPriceHeight}
          fill="url(#data-bars-bg)"
          stroke="var(--color-border)"
          strokeWidth={1}
          rx={8}
        />

        {[topLabel, midLabel, bottomLabel].map((p, idx) => {
          const y = yForPrice(p)
          return (
            <g key={idx}>
              <line
                x1={paddingLeft}
                x2={paddingLeft + innerWidth}
                y1={y}
                y2={y}
                stroke={idx === 1 ? 'var(--color-border-strong)' : 'var(--color-border)'}
                strokeDasharray={idx === 1 ? '3 3' : '2 4'}
                strokeWidth={0.5}
              />
              <text
                x={paddingLeft - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--color-text-muted)"
              >
                {fmtUsd(p)}
              </text>
            </g>
          )
        })}

        {srLineEls}
        {bollingerEls}

        {bars.map((b, i) => {
          const x = xForIndex(i)
          const highY = yForPrice(b.high)
          const lowY = yForPrice(b.low)
          const openY = yForPrice(b.open)
          const closeY = yForPrice(b.close)
          const isUp = b.close >= b.open
          const color = isUp ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)'
          const bodyTop = Math.min(openY, closeY)
          const bodyHeight = Math.max(Math.abs(closeY - openY), 2)
          const candleWidth = Math.max(
            candleWidthMin,
            Math.abs(xStep) > 0 ? Math.min(candleWidthMax, Math.abs(xStep) * candleWidthFactor) : 8,
          )

          return (
            <g key={`${view.startIdx + i}-${b.time}`}>
              <line
                x1={x}
                x2={x}
                y1={highY}
                y2={lowY}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={x - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                rx={1.5}
              />
            </g>
          )
        })}

        {vwapLineEls}

        {lastBar && bars.length > 1 && (
          <text
            x={paddingLeft + innerWidth}
            y={height - 6}
            textAnchor="end"
            fontSize="10"
            fill="var(--color-text-muted)"
          >
            {fmtTs(lastBar.time)}
          </text>
        )}

        {showVolPanel && (
          <>
            <rect
              x={paddingLeft}
              y={volumeTop}
              width={innerWidth}
              height={innerVolumeHeight}
              fill="var(--color-surface)"
              stroke="var(--color-border)"
              strokeWidth={1}
              rx={6}
            />
            {hasVolume &&
              bars.map((b, i) => {
                const v = volumes[i]
                if (v <= 0) return null
                const x = xForIndex(i)
                const isUp = b.close >= b.open
                const color = isUp ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)'
                const barW = Math.max(
                  volumeBarWidthMin,
                  Math.abs(xStep) > 0 ? Math.min(volumeBarWidthMax, Math.abs(xStep) * volumeBarWidthFactor) : 5,
                )
                const y = yForVolume(v)
                const h = volumeBottom - y
                return (
                  <rect
                    key={`vol-${view.startIdx + i}`}
                    x={x - barW / 2}
                    y={y}
                    width={barW}
                    height={Math.max(h, 1)}
                    fill={color}
                    fillOpacity={0.7}
                    rx={1}
                  />
                )
              })}
          </>
        )}

        {macdPanelEls}
        {rsiPanelEls}

        {xTickIndices.map((i) => {
          const bar = bars[i]
          if (!bar) return null
          const x = xForIndex(i)
          const isFirst = i === 0
          const isLast = i === bars.length - 1
          let anchor: 'start' | 'middle' | 'end' = 'middle'
          if (isFirst) anchor = 'start'
          else if (isLast) anchor = 'end'
          return (
            <text
              key={i}
              x={x}
              y={height - 6}
              textAnchor={anchor}
              fontSize="10"
              fill="var(--color-text-muted)"
            >
              {fmtTsForPeriod(bar.time, period)}
            </text>
          )
        })}

        {enableTimeRangeBrush && fullCount > 1 && (
          <rect
            x={paddingLeft}
            y={paddingTop}
            width={innerWidth}
            height={brushBottom - paddingTop}
            fill="transparent"
            stroke="none"
            style={{ cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={onBrushPointerDown}
            onPointerMove={onBrushPointerMove}
            onPointerUp={onBrushPointerUp}
            onPointerCancel={onBrushPointerCancel}
          />
        )}

        {dragPreviewEl}
      </svg>

      {lastBar && (
        <div className="data-bars-chart-legend">
          <span className="data-bars-chart-legend-time">{fmtTsForPeriod(lastBar.time, period)}</span>
          <span>O {fmtUsd(lastBar.open)}</span>
          <span>H {fmtUsd(lastBar.high)}</span>
          <span>L {fmtUsd(lastBar.low)}</span>
          <span>C {fmtUsd(lastBar.close)}</span>
          {lastBar.volume != null && (
            <span>V {Number(lastBar.volume).toLocaleString()}</span>
          )}
          {showVwap && lastVwap != null && <span>VWAP {fmtUsd(lastVwap)}</span>}
        </div>
      )}

      {enableTimeRangeBrush && isFiltered && firstFull && lastFull && (
        <div className="data-bars-chart-range-bar">
          <span>
            Range: {fmtTsForPeriod(firstFull.time, period)} — {fmtTsForPeriod(lastFull.time, period)} ·{' '}
            {bars.length} of {fullCount} bars
          </span>
          <button
            type="button"
            className="data-bars-chart-range-reset"
            onClick={() => setViewRange(null)}
          >
            Reset range
          </button>
        </div>
      )}
    </div>
  )
}
