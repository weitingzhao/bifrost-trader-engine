import { fmtMvAbbrev } from './positionUtils'
import { w9 } from '@/styles/wave9Classes'
import type { DonutSegment } from './positionUtils'

export function PositionDonutChart({
  title,
  segments,
  activeLabel,
  onSegmentClick,
  interactive = true,
  showLegend = true,
  embedded = false,
  showActiveChip = true,
  showTitle = true,
  chartCenter,
  centerValueMode = 'usd',
}: {
  title: string
  segments: DonutSegment[]
  activeLabel: string | null
  onSegmentClick: (label: string | null) => void
  interactive?: boolean
  showLegend?: boolean
  embedded?: boolean
  showActiveChip?: boolean
  showTitle?: boolean
  /** When set, ring center shows these lines instead of total / active slice. */
  chartCenter?: { main: string; sub: string; valueClass?: string } | null
  /** When no chartCenter: show ring total / selection as % or abbreviated $ (Option charts follow % / $ toggle). */
  centerValueMode?: 'pct' | 'usd'
}) {
  const active = segments.filter(s => s.value > 0)
  const total  = active.reduce((acc, s) => acc + s.value, 0)
  const cx = 66, cy = 66, rMid = 46, ringStroke = 14
  const circ = 2 * Math.PI * rMid

  let ringOff = 0
  const arcs =
    total > 0
      ? active.map(seg => {
          const arcLen = (seg.value / total) * circ
          const dashoffset = -ringOff
          ringOff += arcLen
          return { ...seg, arcLen, dashoffset, pct: (seg.value / total) * 100 }
        })
      : []

  const activeSegValue = activeLabel ? (active.find(s => s.label === activeLabel)?.value ?? null) : null
  const centerSubDefault =
    activeLabel != null
      ? activeLabel.length > 10
        ? activeLabel.slice(0, 9) + '…'
        : activeLabel
      : 'Total'
  const centerMain =
    chartCenter != null
      ? chartCenter.main
      : centerValueMode === 'pct'
        ? total > 0
          ? activeSegValue != null
            ? `${((activeSegValue / total) * 100).toFixed(1)}%`
            : '100.0%'
          : '—'
        : activeSegValue != null
          ? fmtMvAbbrev(activeSegValue)
          : total > 0
            ? fmtMvAbbrev(total)
            : '—'
  const centerSub = chartCenter != null ? chartCenter.sub : centerSubDefault
  const centerMainClass =
    chartCenter?.valueClass ?? 'coverage-asset-pie-center-val coverage-asset-pie-center-val--basis'

  return (
    <div
      className={embedded ? 'pos-comp-embedded-donut' : 'coverage-asset-pie-section'}
      style={embedded ? { flex: '1 1 190px', minWidth: '180px' } : { flex: '1 1 270px', maxWidth: '480px' }}
    >
      {showTitle ? (
        <div className={w9.coverageAssetPieHeader}>
          <span className={w9.coverageAssetPieTitle}>{title}</span>
          {activeLabel && showActiveChip && (
          <button
            type="button"
            style={{
              marginLeft: 'auto', padding: '0.12rem 0.45rem',
              border: '1px solid var(--color-border)', borderRadius: '999px',
              background: 'transparent', color: 'var(--color-text-muted)',
              fontSize: '0.68rem', cursor: 'pointer', lineHeight: 1.4,
            }}
            onClick={() => onSegmentClick(null)}
            title="Clear filter"
          >
            {activeLabel} ×
          </button>
        )}
        </div>
      ) : null}
      {active.length === 0 ? (
        <p className={w9.sectionHint} style={{ margin: 0 }}>No position data</p>
      ) : (
        <div className={w9.coverageAssetPieBody}>
          <div className={w9.coverageAssetPieChartBlock}>
            <svg
              width={embedded ? 128 : 132} height={embedded ? 128 : 132} viewBox="0 0 132 132"
              className={w9.coverageAssetPieSvg}
              role="img"
              aria-label={`${title} ring chart`}
            >
              <circle cx={cx} cy={cy} r={rMid} fill="none" className="coverage-asset-pie-ring-track" strokeWidth={ringStroke} />
              {arcs.map(arc => {
                const isActive = arc.label === activeLabel
                const isDimmed = activeLabel != null && !isActive
                return (
                  <circle
                    key={`ring-${arc.label}`}
                    cx={cx} cy={cy} r={rMid}
                    fill="none"
                    stroke={arc.color}
                    strokeWidth={isActive ? ringStroke + 4 : ringStroke}
                    strokeLinecap="butt"
                    transform={`rotate(-90 ${cx} ${cy})`}
                    style={{
                      cursor: interactive ? 'pointer' : 'default',
                      opacity: isDimmed ? 0.22 : 1,
                      strokeDasharray: `${arc.arcLen} ${circ}`,
                      strokeDashoffset: arc.dashoffset,
                      transition:
                        'stroke-dasharray 0.36s cubic-bezier(0.4, 0, 0.2, 1), stroke-dashoffset 0.36s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.18s ease, stroke-width 0.18s ease',
                    }}
                    onClick={() => interactive && onSegmentClick(isActive ? null : arc.label)}
                  />
                )
              })}
              <text
                x={cx}
                y={cy - 4}
                className={centerMainClass}
                textAnchor="middle"
                dominantBaseline="auto"
                style={embedded ? { fontSize: '0.98rem' } : undefined}
              >
                {centerMain}
              </text>
              <text
                x={cx}
                y={cy + 11}
                className={w9.coverageAssetPieCenterSub}
                textAnchor="middle"
                dominantBaseline="auto"
                style={embedded ? { fontSize: '0.74rem' } : undefined}
              >
                {centerSub}
              </text>
            </svg>
          </div>
          {showLegend && (
            <div className={w9.coverageAssetPieLegend}>
              {arcs.map((arc, i) => {
                const isActive = arc.label === activeLabel
                const isDimmed = activeLabel != null && !isActive
                return (
                  <div
                    key={i}
                    className={w9.coverageAssetPieLegendItem}
                    style={{
                      cursor: interactive ? 'pointer' : 'default',
                      opacity: isDimmed ? 0.38 : 1,
                      borderRadius: 4,
                      padding: '0.08rem 0.3rem',
                      background: isActive ? `color-mix(in oklab, ${arc.color} 14%, transparent)` : 'transparent',
                      transition: 'opacity 0.18s, background 0.15s',
                    }}
                    onClick={() => interactive && onSegmentClick(isActive ? null : arc.label)}
                    title={interactive ? `Click to filter: ${arc.label}` : arc.label}
                  >
                    <span className={w9.coverageAssetPieDot} style={{ background: arc.color }} />
                    <span className={w9.coverageAssetPieLegendLabel}>{arc.label}</span>
                    <span className={w9.coverageAssetPieLegendPct}>{arc.pct.toFixed(1)}%</span>
                    <span className={w9.coverageAssetPieLegendValue}>{fmtMvAbbrev(arc.value)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
