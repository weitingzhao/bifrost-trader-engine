import { useId, useMemo } from 'react'
import type { RiskCalcContext, RiskProfile } from '../utils/riskProfile'
import { payoffOptionsAtPrice, payoffStockAtPrice } from '../utils/riskProfile'

function fmtAxisUsd(n: number): string {
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (a >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return Math.round(n).toString()
}

function fmtAxisPrice(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 100) return n.toFixed(0)
  return n.toFixed(2)
}

/** Pick a step size that yields ~targetCount ticks over [ymin, ymax] with nice round numbers. */
function niceYStep(ymin: number, ymax: number, targetCount: number): number {
  const span = Math.max(ymax - ymin, 1)
  let step = span / Math.max(targetCount - 1, 1)
  const exp = Math.floor(Math.log10(step))
  const base = step / Math.pow(10, exp)
  const niceBase = base <= 1.2 ? 1 : base <= 2.5 ? 2 : base <= 6 ? 5 : 10
  return niceBase * Math.pow(10, exp)
}

/** Build Y ticks: 0 included when in range; at most maxTicks to avoid crowded labels. */
function buildYTicks(
  yMin: number,
  yMax: number,
  maxTicks: number,
  _profile: { max_gain: number | null; max_loss: number | null },
): number[] {
  const include0 = 0 >= yMin && 0 <= yMax
  const step = niceYStep(yMin, yMax, maxTicks)
  if (step <= 0) return include0 ? [0] : []

  const raw: number[] = []
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    raw.push(Math.abs(v) < 1e-9 ? 0 : v)
  }
  if (include0 && !raw.some(t => Math.abs(t) < 1e-9)) {
    raw.push(0)
    raw.sort((a, b) => a - b)
  }
  const deduped = Array.from(
    new Set(raw.filter(t => t >= yMin && t <= yMax).map(t => (Math.abs(t) < 1e-9 ? 0 : t))),
  ).sort((a, b) => a - b)
  if (deduped.length <= maxTicks) return deduped
  const stepIdx = (deduped.length - 1) / (maxTicks - 1)
  return Array.from({ length: maxTicks }, (_, i) => {
    const idx = i === maxTicks - 1 ? deduped.length - 1 : Math.round(i * stepIdx)
    return deduped[idx]!
  }).sort((a, b) => a - b)
}

function segmentFills(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sx: (x: number) => number,
  sy: (y: number) => number,
): { green: string[]; red: string[] } {
  const green: string[] = []
  const red: string[] = []
  const trap = (xa: number, ya: number, xb: number, yb: number, above: boolean) => {
    const z0 = sy(0)
    const p = `M ${sx(xa)} ${z0} L ${sx(xa)} ${sy(ya)} L ${sx(xb)} ${sy(yb)} L ${sx(xb)} ${z0} Z`
    if (above) green.push(p)
    else red.push(p)
  }

  if (y0 >= 0 && y1 >= 0) {
    trap(x0, y0, x1, y1, true)
  } else if (y0 <= 0 && y1 <= 0) {
    trap(x0, y0, x1, y1, false)
  } else {
    const t = y0 / (y0 - y1)
    const xz = x0 + t * (x1 - x0)
    if (y0 >= 0) {
      trap(x0, y0, xz, 0, true)
      trap(xz, 0, x1, y1, false)
    } else {
      trap(x0, y0, xz, 0, false)
      trap(xz, 0, x1, y1, true)
    }
  }
  return { green, red }
}

export function RiskProfilePayoffChart({
  profile,
  ctx,
  variant = 'standalone',
}: {
  profile: RiskProfile
  ctx: RiskCalcContext
  variant?: 'compact' | 'standalone'
}) {
  const clipId = useId().replace(/:/g, '_')
  const compact = variant === 'compact'

  const { points, xMin, xMax, yMin, yMax, unlimitedTail } = useMemo(() => {
    const strikes = Array.from(new Set(ctx.positions.map(p => p.strike))).sort((a, b) => a - b)
    let x0 = 0
    let x1 = 0
    if (strikes.length > 0) {
      x0 = 0
      x1 = strikes[strikes.length - 1] * 2
      if (profile.risk_type === 'unlimited') {
        x1 = Math.max(x1, strikes[strikes.length - 1] * 2.35)
      }
    } else if (ctx.covered_shares > 0 && ctx.underlying_avg_cost != null) {
      const c = ctx.underlying_avg_cost
      x0 = Math.max(0, c * 0.35)
      x1 = c * 2.1
    } else {
      x0 = 0
      x1 = 100
    }
    if (x1 <= x0) x1 = x0 + 50

    const N = compact ? 140 : 180
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= N; i++) {
      const x = x0 + (i / N) * (x1 - x0)
      const opt = payoffOptionsAtPrice(ctx.positions, x)
      const stk = payoffStockAtPrice(ctx.covered_shares, ctx.underlying_avg_cost, x)
      pts.push({ x, y: opt + stk })
    }

    let ymin = Math.min(0, ...pts.map(p => p.y))
    let ymax = Math.max(0, ...pts.map(p => p.y))
    const padY = Math.max((ymax - ymin) * 0.08, 50)
    ymin -= padY
    ymax += padY
    if (ymin >= ymax) {
      ymin -= 100
      ymax += 100
    }

    return {
      points: pts,
      xMin: x0,
      xMax: x1,
      yMin: ymin,
      yMax: ymax,
      unlimitedTail: profile.risk_type === 'unlimited' && profile.max_loss == null,
    }
  }, [ctx, profile.risk_type, profile.max_loss, compact])

  const W = compact ? 276 : 340
  const H = compact ? 152 : 168
  const padL = compact ? 44 : 48
  const padR = compact ? 10 : 14
  const padT = compact ? 12 : 14
  const padB = compact ? 32 : 36
  const pw = W - padL - padR
  const ph = H - padT - padB

  const sx = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * pw
  const sy = (y: number) => padT + ((yMax - y) / (yMax - yMin)) * ph

  const lineD = useMemo(() => {
    if (points.length === 0) return ''
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x)} ${sy(p.y)}`).join(' ')
  }, [points, xMin, xMax, yMin, yMax, padL, padT, pw, ph])

  const { greenPaths, redPaths } = useMemo(() => {
    const green: string[] = []
    const red: string[] = []
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      const { green: g, red: r } = segmentFills(a.x, a.y, b.x, b.y, sx, sy)
      green.push(...g)
      red.push(...r)
    }
    return { greenPaths: green, redPaths: red }
  }, [points, xMin, xMax, yMin, yMax, padL, padT, pw, ph])

  const y0 = sy(0)
  const xAxisLogical = 0 >= yMin && 0 <= yMax

  const xTicks = useMemo(() => {
    const ticks: number[] = [xMin, xMax]
    const strikes = Array.from(new Set(ctx.positions.map(p => p.strike))).sort((a, b) => a - b)
    for (const k of strikes) {
      if (k > xMin && k < xMax) ticks.push(k)
    }
    const mid = (xMin + xMax) / 2
    if (!ticks.some(t => Math.abs(t - mid) < (xMax - xMin) * 0.08)) {
      ticks.push(mid)
    }
    return Array.from(new Set(ticks.map(t => Math.round(t * 100) / 100))).sort((a, b) => a - b)
  }, [xMin, xMax, ctx.positions])

  const maxYTicks = compact ? 5 : 6
  const yTicks = useMemo(
    () => buildYTicks(yMin, yMax, maxYTicks, profile),
    [yMin, yMax, maxYTicks, profile],
  )

  const rootClass =
    'risk-payoff-chart' +
    (compact ? ' risk-payoff-chart--compact' : '') +
    (!compact ? ' risk-payoff-chart--standalone' : '')

  const optionLegs = ctx.positions.length
  const coverageSh = ctx.covered_shares
  const opportunityDataLabel =
    optionLegs > 0 || coverageSh > 0
      ? `Options: ${optionLegs} leg${optionLegs !== 1 ? 's' : ''} · Coverage: ${coverageSh} sh`
      : null

  return (
    <div
      className={rootClass}
      onClick={e => e.stopPropagation()}
      role="img"
      aria-label="Payoff at expiration for this opportunity: profit and loss versus underlying price."
    >
      <div className="risk-payoff-chart-head">
        <span className="risk-payoff-chart-title">Payoff at expiration</span>
        {opportunityDataLabel ? (
          <span className="risk-payoff-chart-data" title="This opportunity’s option legs and underlying coverage">
            {opportunityDataLabel}
          </span>
        ) : null}
        {!compact ? (
          <span className="risk-payoff-chart-sub">Underlying (X) · P&amp;L (Y)</span>
        ) : (
          <span className="risk-payoff-chart-sub">X = spot · Y = $</span>
        )}
      </div>
      <svg
        className="risk-payoff-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={padL} y={padT} width={pw} height={ph} />
          </clipPath>
        </defs>

        <rect
          x={padL}
          y={padT}
          width={pw}
          height={ph}
          fill="var(--risk-payoff-plot-bg)"
          rx={4}
        />

        <g clipPath={`url(#${clipId})`}>
          {xAxisLogical ? (
            <line
              x1={padL}
              y1={y0}
              x2={padL + pw}
              y2={y0}
              stroke="var(--risk-payoff-zero)"
              strokeWidth={compact ? 1.1 : 1.25}
            />
          ) : null}
          {yTicks.map(t => {
            const yy = sy(t)
            if (yy < padT || yy > padT + ph) return null
            return (
              <line
                key={`h-${t}`}
                x1={padL}
                y1={yy}
                x2={padL + pw}
                y2={yy}
                stroke="var(--risk-payoff-grid)"
                strokeWidth={0.5}
              />
            )
          })}
          {xTicks.map(t => {
            const xx = sx(t)
            if (xx < padL || xx > padL + pw) return null
            return (
              <line
                key={`v-${t}`}
                x1={xx}
                y1={padT}
                x2={xx}
                y2={padT + ph}
                stroke="var(--risk-payoff-grid)"
                strokeWidth={0.5}
              />
            )
          })}

          {greenPaths.map((d, i) => (
            <path key={`g-${i}`} d={d} fill="var(--risk-payoff-profit-fill)" stroke="none" />
          ))}
          {redPaths.map((d, i) => (
            <path key={`r-${i}`} d={d} fill="var(--risk-payoff-loss-fill)" stroke="none" />
          ))}

          <path
            d={lineD}
            fill="none"
            stroke="var(--risk-payoff-line)"
            strokeWidth={compact ? 1.75 : 2}
            strokeLinejoin="round"
          />
        </g>

        <line
          x1={padL}
          y1={padT + ph}
          x2={padL + pw}
          y2={padT + ph}
          stroke="var(--risk-payoff-axis)"
          strokeWidth={1.5}
        />
        <line x1={padL} y1={padT} x2={padL} y2={padT + ph} stroke="var(--risk-payoff-axis)" strokeWidth={1.5} />

        {profile.breakeven_prices.map((be, i) => {
          if (be < xMin || be > xMax) return null
          const xx = sx(be)
          return (
            <line
              key={`be-${i}`}
              x1={xx}
              y1={padT}
              x2={xx}
              y2={padT + ph}
              stroke="var(--risk-payoff-breakeven)"
              strokeWidth={1.1}
              strokeDasharray="4 3"
            />
          )
        })}

        <text
          x={W / 2}
          y={H - 5}
          textAnchor="middle"
          className="risk-payoff-chart-axis-label"
        >
          {compact ? 'Underlying at expiry' : 'Underlying price at expiration'}
        </text>
        <text
          x={10}
          y={padT + ph / 2}
          textAnchor="middle"
          className="risk-payoff-chart-axis-label"
          transform={`rotate(-90, 10, ${padT + ph / 2})`}
        >
          P&amp;L ($)
        </text>

        {xTicks.map(t => {
          const xx = sx(t)
          if (xx < padL - 2 || xx > padL + pw + 2) return null
          return (
            <text
              key={`xl-${t}`}
              x={xx}
              y={H - 18}
              textAnchor="middle"
              className="risk-payoff-chart-tick"
            >
              {fmtAxisPrice(t)}
            </text>
          )
        })}

        {yTicks.map(t => {
          const yy = sy(t)
          return (
            <text
              key={`yl-${t}`}
              x={padL - 5}
              y={yy}
              textAnchor="end"
              dominantBaseline="middle"
              className="risk-payoff-chart-tick"
            >
              {Math.abs(t) < 1e-9 ? '0' : fmtAxisUsd(t)}
            </text>
          )
        })}
      </svg>
      <p className="risk-payoff-chart-caption">
        {compact
          ? 'This opportunity’s options + coverage at expiry. Green / red vs zero. Dashed ≈ breakeven.'
          : 'This opportunity’s options + underlying coverage at expiration (same as scenario grid). Green = profit vs zero; red = loss. Dashed ≈ breakeven.'}
        {unlimitedTail ? ' Naked short call: loss unbounded right of chart.' : ''}
      </p>
    </div>
  )
}
