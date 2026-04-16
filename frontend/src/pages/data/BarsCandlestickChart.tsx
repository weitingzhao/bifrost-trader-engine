import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Bar } from '../../types'
import { fmtTs, fmtTsForPeriod, fmtUsd } from '../../utils/format'

export interface BarsCandlestickChartProps {
  bars: Bar[]
  period?: string
  /** When true (default), draw VWAP line/dot and legend when bar data includes vwap. */
  showVwap?: boolean
  /** Drag on the chart to select start/end bar index (Option Discovery). */
  enableTimeRangeBrush?: boolean
}

/** API may send vwap as string; Number.isFinite rejects strings. */
export function finiteVwap(raw: unknown): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

const VWAP_STROKE = '#0ea5e9'

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
  bars: fullBars,
  period = '1 D',
  showVwap = true,
  enableTimeRangeBrush = false,
}: BarsCandlestickChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  /** Inclusive indices into fullBars; null = full range */
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

  const width = CHART_WIDTH
  const priceHeight = 200
  const volumeHeight = 72
  const gap = 8
  const paddingLeft = PADDING_LEFT
  const paddingRight = PADDING_RIGHT
  const paddingTop = 12
  const paddingBottom = 28
  const height = paddingTop + priceHeight + gap + volumeHeight + paddingBottom
  const innerWidth = width - paddingLeft - paddingRight
  const innerPriceHeight = priceHeight - 0
  const innerVolumeHeight = volumeHeight - 0
  const volumeTop = paddingTop + priceHeight + gap
  const volumeBottom = volumeTop + innerVolumeHeight
  const plotBottom = volumeBottom

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

  const priceStats = useMemo(() => {
    const pricePoints: number[] = []
    for (const b of bars) {
      if (Number.isFinite(b.high)) pricePoints.push(b.high)
      if (Number.isFinite(b.low)) pricePoints.push(b.low)
      if (showVwap) {
        const vw = finiteVwap(b.vwap)
        if (vw != null) pricePoints.push(vw)
      }
    }
    if (pricePoints.length === 0) return null
    const minPrice = Math.min(...pricePoints)
    const maxPrice = Math.max(...pricePoints)
    const priceRange = maxPrice - minPrice || 1
    const hasVolume = bars.some(b => b.volume != null && Number.isFinite(b.volume))
    const volumes = bars.map(b => (b.volume != null && Number.isFinite(b.volume) ? Number(b.volume) : 0))
    const maxVolume = hasVolume ? Math.max(...volumes, 1) : 1
    return { minPrice, maxPrice, priceRange, hasVolume, volumes, maxVolume }
  }, [bars, showVwap])

  const xTickIndices = useMemo(() => {
    const n = bars.length
    if (n <= 1) return [0]
    const count = Math.min(6, n)
    const step = (n - 1) / (count - 1)
    return Array.from({ length: count }, (_, i) => Math.round(i * step))
  }, [bars.length])

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

  const dragPreviewEl = useMemo(() => {
    if (!drag) return null
    const x1 = Math.min(drag.x0, drag.x1)
    const x2 = Math.max(drag.x0, drag.x1)
    return (
      <rect
        x={x1}
        y={paddingTop}
        width={Math.max(1, x2 - x1)}
        height={plotBottom - paddingTop}
        fill="rgba(14, 165, 233, 0.18)"
        stroke="rgba(14, 165, 233, 0.55)"
        strokeWidth={1}
        pointerEvents="none"
      />
    )
  }, [drag, paddingTop, plotBottom])

  if (!priceStats) return null

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
  const lastVwap = finiteVwap(lastBar.vwap)

  const firstFull = fullBars[view.startIdx]
  const lastFull = fullBars[view.endIdx]

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
            height={plotBottom - paddingTop}
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
