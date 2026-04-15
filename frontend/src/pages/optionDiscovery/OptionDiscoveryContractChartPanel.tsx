import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar } from '../../types'
import { fetchOptionBars, pollMassiveJobUntilDone, postMassiveSync } from '../../api'
import { BarsCandlestickChart } from '../data/BarsCandlestickChart'
import { InfoTooltip } from '../../components/InfoTooltip'
import { buildPolygonOptionsTicker } from '../../utils/polygonOptionsTicker'

const OPTION_BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 hour', label: '1 hour' },
  { value: '5 mins', label: '5 min' },
  { value: '1 min', label: '1 min' },
] as const

/** Option Discovery chart always reads Massive-backed rows in PostgreSQL (option_min / option_day). */
const BAR_SOURCE: 'massive' = 'massive'

function sortBarsAsc(bars: Bar[]): Bar[] {
  return [...bars].sort((a, b) => a.time - b.time)
}

export function OptionDiscoveryContractChartPanel({
  symbol,
  expiration,
  strike,
  optionRight,
}: {
  symbol: string
  expiration: string
  strike: number
  optionRight: 'C' | 'P'
}) {
  const [period, setPeriod] = useState<string>('1 min')
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncHint, setSyncHint] = useState<string | null>(null)

  const load = useCallback(async () => {
    const sym = symbol.trim().toUpperCase()
    const exp = expiration.trim()
    if (!sym || !exp || !Number.isFinite(strike)) {
      setBars([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetchOptionBars({
        symbol: sym,
        expiry: exp,
        strike,
        option_right: optionRight,
        period,
        limit: 200,
        source: BAR_SOURCE,
      })
      const raw = res.bars ?? []
      setBars(raw)
      if (raw.length === 0) {
        const msg = (res.message || '').trim()
        setError(
          msg ||
            'No bars in the database for this contract. Click Backfill from Massive to enqueue aggregates (option_min), or run the same job from Feed → Massive Option.',
        )
      }
    } catch (e) {
      setBars([])
      setError(e instanceof Error ? e.message : 'Failed to load option bars')
    } finally {
      setLoading(false)
    }
  }, [symbol, expiration, strike, optionRight, period])

  useEffect(() => {
    void load()
  }, [load])

  const runMassiveAggregatesBackfill = useCallback(async () => {
    const sym = symbol.trim().toUpperCase()
    const exp = expiration.trim()
    if (!sym || !exp || !Number.isFinite(strike)) return
    if (period === '1 D') {
      setSyncHint(
        'Daily bars are read from option_day. The Massive aggregates job only writes intraday rows to option_min. Use IB bars elsewhere or open/close on the Massive Option feed page.',
      )
      return
    }
    setSyncBusy(true)
    setSyncHint(null)
    setError(null)
    try {
      const optionsTicker = buildPolygonOptionsTicker(sym, exp, strike, optionRight)
      const endMs = Date.now()
      const lookbackMs = 7 * 24 * 60 * 60 * 1000
      const startMs = endMs - lookbackMs
      let timespan = 'minute'
      let multiplier = 1
      if (period === '1 hour') {
        timespan = 'hour'
        multiplier = 1
      } else {
        timespan = 'minute'
        multiplier = 1
      }
      const res = await postMassiveSync('aggregates', {
        options_ticker: optionsTicker,
        symbol: sym,
        expiry: exp,
        strike,
        option_right: optionRight,
        timespan,
        multiplier,
        start_ms: startMs,
        end_ms: endMs,
      })
      if (!res.ok || !res.job_id) {
        setError(res.error ?? res.message ?? 'Failed to enqueue Massive aggregates job')
        return
      }
      const polled = await pollMassiveJobUntilDone(res.job_id, { maxAttempts: 120, intervalMs: 1000 })
      if (!polled.ok) {
        setError(polled.error ?? 'Massive job failed')
        return
      }
      if (period === '5 mins') {
        setSyncHint('Backfill wrote 1-minute bars. Chart period set to 1 min to match.')
        setPeriod('1 min')
      } else {
        setSyncHint('Backfill finished. Reloading bars from PostgreSQL.')
        await load()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setSyncBusy(false)
    }
  }, [symbol, expiration, strike, optionRight, period, load])

  const chartBars = useMemo(() => sortBarsAsc(bars), [bars])

  return (
    <div className="od-contract-chart">
      <div className="od-contract-chart-toolbar">
        <span className="od-contract-chart-toolbar-label">Period</span>
        <div className="od-contract-chart-periods" role="group" aria-label="Bar period">
          {OPTION_BAR_PERIODS.map(p => (
            <label key={p.value} className="od-contract-chart-period-item">
              <input
                type="radio"
                name="od-opt-bar-period"
                value={p.value}
                checked={period === p.value}
                onChange={() => setPeriod(p.value)}
              />
              {p.label}
            </label>
          ))}
        </div>
        <button
          type="button"
          className="section-header-icon-btn od-contract-chart-icon-btn"
          disabled={loading || syncBusy}
          onClick={() => void load()}
          title={loading ? 'Loading bars' : 'Reload bars'}
          aria-label={loading ? 'Loading bars' : 'Reload bars'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 21h5v-5" />
          </svg>
        </button>
        <button
          type="button"
          className="section-header-icon-btn od-contract-chart-icon-btn"
          disabled={loading || syncBusy || period === '1 D'}
          title={
            syncBusy
              ? 'Backfilling bars from Massive'
              : period === '1 D'
              ? 'Daily bars are not filled by REST aggregates; use another pipeline for option_day.'
              : 'Enqueue Celery job: Massive /v2/aggs → option_min (last 7 days)'
          }
          aria-label={syncBusy ? 'Backfilling bars from Massive' : 'Backfill bars from Massive'}
          onClick={() => void runMassiveAggregatesBackfill()}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 7h10" />
            <path d="M7 12h10" />
            <path d="M7 17h6" />
            <path d="M16 14l3 3-3 3" />
          </svg>
        </button>
        <span className="page-title-with-tooltip" style={{ marginLeft: '0.25rem' }}>
          <InfoTooltip text="Reads OHLC from PostgreSQL (option_day for Daily, option_min for intraday). Backfill enqueues aggregates on the massive Celery queue. You can also use Feed → Massive Option → Aggregate Bars (OHLC)." />
        </span>
      </div>
      {syncHint && <p className="section-hint" role="status">{syncHint}</p>}
      {error && <p className="section-hint" role="status">{error}</p>}
      {chartBars.length > 0 && (
        <div className="data-bars-chart-container" style={{ marginTop: '0.75rem' }}>
          <div className="data-bars-chart-header">
            <span className="data-bars-chart-title">
              {symbol.trim().toUpperCase()} {optionRight === 'C' ? 'Call' : 'Put'} {strike.toFixed(2)} · {period} · Massive (DB) · {chartBars.length} bars
            </span>
          </div>
          <BarsCandlestickChart bars={chartBars} period={period} />
        </div>
      )}
      {!loading && chartBars.length === 0 && !error && (
        <p className="section-hint" role="status">No bars returned.</p>
      )}
    </div>
  )
}
