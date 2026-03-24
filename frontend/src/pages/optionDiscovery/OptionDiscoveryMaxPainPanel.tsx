import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { fetchMaxPainCompute, fetchMaxPainComputeHistory } from '../../api'
import type { MaxPainComputeResponse, MaxPainHistoryPoint, MaxPainStrikePoint } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'

const DISCLAIMER =
  'Disclaimer: Max Pain is a theoretical reference metric based on end-of-day open interest data. It does not predict future price movement and should not be used as the sole basis for trading decisions. Open interest data is sourced from Massive (Polygon) with approximately 15-minute delay. Corporate actions (splits, special dividends) may affect strike prices and contract multipliers.'

function scaleLin(v: number, vmin: number, vmax: number, outMin: number, outMax: number): number {
  if (!Number.isFinite(v)) return (outMin + outMax) / 2
  if (vmax <= vmin) return (outMin + outMax) / 2
  return outMin + ((v - vmin) / (vmax - vmin)) * (outMax - outMin)
}

function PainByStrikeSvg({
  points,
  maxPainStrike,
  showPain,
}: {
  points: MaxPainStrikePoint[]
  maxPainStrike: number
  showPain: boolean
}) {
  const w = 560
  const h = 200
  const pad = { l: 44, r: 12, t: 12, b: 28 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  if (!showPain || points.length === 0) return null
  const strikes = points.map(p => p.strike)
  const pains = points.map(p => p.pain)
  const minS = Math.min(...strikes)
  const maxS = Math.max(...strikes)
  const minP = Math.min(...pains)
  const maxP = Math.max(...pains)
  const pts = points
    .map(p => {
      const x = pad.l + scaleLin(p.strike, minS, maxS, 0, innerW)
      const y = pad.t + innerH - scaleLin(p.pain, minP, maxP, 0, innerH)
      return `${x},${y}`
    })
    .join(' ')
  const mpX = pad.l + scaleLin(maxPainStrike, minS, maxS, 0, innerW)
  return (
    <svg className="od-max-pain-svg" viewBox={`0 0 ${w} ${h}`} aria-label="Pain by strike">
      <polyline fill="none" stroke="var(--color-accent, #6ea8fe)" strokeWidth="2" points={pts} />
      {Number.isFinite(mpX) ? (
        <line x1={mpX} x2={mpX} y1={pad.t} y2={pad.t + innerH} stroke="var(--color-lamp-green)" strokeWidth="1" strokeDasharray="4 3" />
      ) : null}
      <text x={pad.l} y={h - 6} fontSize="10" fill="var(--color-text-dim)">
        Strike
      </text>
      <text x={w - pad.r - 48} y={pad.t + 10} fontSize="10" fill="var(--color-text-dim)">
        Writer payout
      </text>
    </svg>
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
  const w = 560
  const h = 180
  const pad = { l: 44, r: 12, t: 8, b: 28 }
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
  const barW = Math.max(2, innerW / Math.max(n * 2, 8))
  return (
    <svg className="od-max-pain-svg" viewBox={`0 0 ${w} ${h}`} aria-label="Open interest by strike">
      {points.flatMap((p, i) => {
        const cx = pad.l + scaleLin(p.strike, minS, maxS, 0, innerW)
        const y0 = pad.t + innerH
        const out: ReactElement[] = []
        const half = barW * 0.45
        if (showCall && p.call_oi > 0) {
          const bh = scaleLin(p.call_oi, 0, maxOi, 0, innerH)
          out.push(
            <rect
              key={`c-${i}`}
              x={cx - barW}
              y={y0 - bh}
              width={half * 2}
              height={bh}
              fill="var(--color-lamp-green)"
              opacity={0.75}
            />,
          )
        }
        if (showPut && p.put_oi > 0) {
          const bh = scaleLin(p.put_oi, 0, maxOi, 0, innerH)
          out.push(
            <rect
              key={`p-${i}`}
              x={cx + 2}
              y={y0 - bh}
              width={half * 2}
              height={bh}
              fill="var(--color-lamp-red)"
              opacity={0.65}
            />,
          )
        }
        return out
      })}
      <text x={pad.l} y={h - 6} fontSize="10" fill="var(--color-text-dim)">
        Strike · Green=Call OI · Red=Put OI
      </text>
    </svg>
  )
}

function TrendSvg({ series }: { series: MaxPainHistoryPoint[] }) {
  const w = 560
  const h = 200
  const pad = { l: 44, r: 44, t: 12, b: 32 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  if (series.length < 2) {
    return <p className="section-hint">Not enough history for trend (need at least 2 days with OI).</p>
  }
  const mp = series.map(s => s.max_pain_strike)
  const closes = series.map(s => s.underlying_close).filter((x): x is number => x != null && Number.isFinite(x))
  const minMp = Math.min(...mp)
  const maxMp = Math.max(...mp)
  const hasClose = closes.length >= 2
  const minC = hasClose ? Math.min(...closes) : 0
  const maxC = hasClose ? Math.max(...closes) : 1
  const ptsMp = series
    .map((s, i) => {
      const x = pad.l + scaleLin(i, 0, series.length - 1, 0, innerW)
      const y = pad.t + innerH - scaleLin(s.max_pain_strike, minMp, maxMp, 0, innerH)
      return `${x},${y}`
    })
    .join(' ')
  const ptsC = hasClose
    ? series
        .map((s, i) => {
          if (s.underlying_close == null || !Number.isFinite(s.underlying_close)) return null
          const x = pad.l + scaleLin(i, 0, series.length - 1, 0, innerW)
          const y = pad.t + innerH - scaleLin(s.underlying_close, minC, maxC, 0, innerH)
          return `${x},${y}`
        })
        .filter(Boolean)
        .join(' ')
    : ''
  return (
    <svg className="od-max-pain-svg" viewBox={`0 0 ${w} ${h}`} aria-label="Max pain vs underlying trend">
      <polyline fill="none" stroke="var(--color-accent, #6ea8fe)" strokeWidth="2" points={ptsMp} />
      {ptsC ? (
        <polyline fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeDasharray="3 2" points={ptsC} />
      ) : null}
      <text x={pad.l} y={h - 8} fontSize="10" fill="var(--color-text-dim)">
        Time (oldest → newest)
      </text>
      <text x={w - pad.r - 52} y={pad.t + 10} fontSize="10" fill="var(--color-accent, #6ea8fe)">
        Max pain
      </text>
      {hasClose ? (
        <text x={w - pad.r - 52} y={pad.t + 22} fontSize="10" fill="var(--color-text-muted)">
          Underlying
        </text>
      ) : null}
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
  const [err, setErr] = useState<string | null>(null)
  const [showPain, setShowPain] = useState(true)
  const [showCallOi, setShowCallOi] = useState(false)
  const [showPutOi, setShowPutOi] = useState(false)
  const [showTrend, setShowTrend] = useState(true)

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

  useEffect(() => {
    void load()
  }, [load])

  const points = useMemo(() => live?.pain_by_strike ?? [], [live])

  if (!massiveConfigured) {
    return (
      <section className="replay-section od-max-pain-section" aria-label="Max Pain">
        <h3 className="od-max-pain-title">
          Max Pain Analysis
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
      <h3 id="od-max-pain-head" className="od-max-pain-title">
        Max Pain Analysis
        <InfoTooltip text="Based on end-of-day open interest from Massive (15 min delayed source). Computed live from PostgreSQL; not read from stored report rows." />
      </h3>
      <p className="section-hint od-max-pain-sub">
        Based on end-of-day open interest from Massive (15 min delayed source)
      </p>

      <div className="od-max-pain-toggles" role="group" aria-label="Chart layers">
        <label className="od-max-pain-toggle">
          <input type="checkbox" checked={showPain} onChange={e => setShowPain(e.target.checked)} />
          Pain by strike
        </label>
        <label className="od-max-pain-toggle">
          <input type="checkbox" checked={showCallOi} onChange={e => setShowCallOi(e.target.checked)} />
          Call OI bars
        </label>
        <label className="od-max-pain-toggle">
          <input type="checkbox" checked={showPutOi} onChange={e => setShowPutOi(e.target.checked)} />
          Put OI bars
        </label>
        <label className="od-max-pain-toggle">
          <input type="checkbox" checked={showTrend} onChange={e => setShowTrend(e.target.checked)} />
          Historical trend
        </label>
        <button type="button" className="button button-secondary button-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loading && !live ? <p className="section-hint">Loading Max Pain…</p> : null}
      {err ? (
        <p className="msg-error" role="alert">
          {err}
        </p>
      ) : null}

      {live?.ok && live.max_pain_strike != null ? (
        <div className="od-max-pain-card">
          <div className="od-max-pain-card-metric">
            <span className="od-max-pain-card-label">Max pain strike</span>
            <strong>{live.max_pain_strike.toFixed(2)}</strong>
          </div>
          <div className="od-max-pain-card-metric">
            <span className="od-max-pain-card-label">Underlying close</span>
            <strong>{live.underlying_close != null ? live.underlying_close.toFixed(2) : '—'}</strong>
          </div>
          <div className="od-max-pain-card-metric">
            <span className="od-max-pain-card-label">Distance</span>
            <strong>
              {live.distance_to_max_pain_pct != null ? `${(live.distance_to_max_pain_pct * 100).toFixed(2)}%` : '—'}
            </strong>
          </div>
          <div className="od-max-pain-card-metric">
            <span className="od-max-pain-card-label">Total OI</span>
            <strong>{live.total_oi != null ? live.total_oi.toLocaleString() : '—'}</strong>
          </div>
          <div className="od-max-pain-card-metric">
            <span className="od-max-pain-card-label">OI as-of</span>
            <strong>{live.trade_date ?? '—'}</strong>
          </div>
          {live.recent_corporate_action ? (
            <p className="od-max-pain-corp-warn" role="status">
              Recent corporate action in DB — verify strikes and multipliers.
            </p>
          ) : null}
        </div>
      ) : null}

      {live?.ok && points.length > 0 ? (
        <div className="od-max-pain-charts">
          {showPain ? (
            <div className="od-max-pain-chart-block">
              <h4 className="od-max-pain-chart-title">Pain by strike</h4>
              <PainByStrikeSvg points={points} maxPainStrike={live.max_pain_strike ?? 0} showPain={showPain} />
            </div>
          ) : null}
          {showCallOi || showPutOi ? (
            <div className="od-max-pain-chart-block">
              <h4 className="od-max-pain-chart-title">Open interest by strike</h4>
              <OiBarsSvg points={points} showCall={showCallOi} showPut={showPutOi} />
            </div>
          ) : null}
          {showTrend ? (
            <div className="od-max-pain-chart-block">
              <h4 className="od-max-pain-chart-title">Max Pain vs underlying (daily)</h4>
              <TrendSvg series={hist} />
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="od-max-pain-disclaimer">{DISCLAIMER}</p>
    </section>
  )
}
