import { useMemo } from 'react'
import type { Bar } from '../../types'
import { fmtTs, fmtTsForPeriod, fmtUsd } from '../../utils/format'

export interface BarsCandlestickChartProps {
  bars: Bar[]
  period?: string
}

export function BarsCandlestickChart({ bars, period = '1 D' }: BarsCandlestickChartProps) {
  if (!bars || bars.length === 0) return null

  const width = 800
  const priceHeight = 200
  const volumeHeight = 72
  const gap = 8
  const paddingLeft = 56
  const paddingRight = 16
  const paddingTop = 12
  const paddingBottom = 28
  const height = paddingTop + priceHeight + gap + volumeHeight + paddingBottom
  const innerWidth = width - paddingLeft - paddingRight
  const innerPriceHeight = priceHeight - 0
  const innerVolumeHeight = volumeHeight - 0
  const volumeTop = paddingTop + priceHeight + gap
  const volumeBottom = volumeTop + innerVolumeHeight

  const pricePoints: number[] = []
  for (const b of bars) {
    if (Number.isFinite(b.high)) pricePoints.push(b.high)
    if (Number.isFinite(b.low)) pricePoints.push(b.low)
  }
  if (pricePoints.length === 0) return null

  const minPrice = Math.min(...pricePoints)
  const maxPrice = Math.max(...pricePoints)
  const priceRange = maxPrice - minPrice || 1

  const hasVolume = bars.some(b => b.volume != null && Number.isFinite(b.volume))
  const volumes = bars.map(b => (b.volume != null && Number.isFinite(b.volume) ? Number(b.volume) : 0))
  const maxVolume = hasVolume ? Math.max(...volumes, 1) : 1

  const xStep = bars.length > 1 ? innerWidth / (bars.length - 1) : 0
  const xForIndex = (i: number) =>
    paddingLeft + (bars.length === 1 ? innerWidth / 2 : i * xStep)

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

  const xTickIndices = useMemo(() => {
    const n = bars.length
    if (n <= 1) return [0]
    const count = Math.min(6, n)
    const step = (n - 1) / (count - 1)
    return Array.from({ length: count }, (_, i) => Math.round(i * step))
  }, [bars.length])

  return (
    <div className="data-bars-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="data-bars-chart-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label="Candlestick preview for loaded bars"
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
          const candleWidth = Math.max(candleWidthMin, xStep > 0 ? Math.min(candleWidthMax, xStep * candleWidthFactor) : 8)

          return (
            <g key={i}>
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
        {hasVolume && bars.map((b, i) => {
          const v = volumes[i]
          if (v <= 0) return null
          const x = xForIndex(i)
          const isUp = b.close >= b.open
          const color = isUp ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)'
          const barW = Math.max(volumeBarWidthMin, xStep > 0 ? Math.min(volumeBarWidthMax, xStep * volumeBarWidthFactor) : 5)
          const y = yForVolume(v)
          const h = volumeBottom - y
          return (
            <rect
              key={i}
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
        </div>
      )}
    </div>
  )
}
