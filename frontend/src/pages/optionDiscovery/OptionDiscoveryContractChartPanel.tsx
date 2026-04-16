import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar } from '../../types'
import { fetchOptionBars, pollMassiveJobUntilDone, postMassiveSync } from '../../api'
import { BarsCandlestickChart, finiteVwap } from '../data/BarsCandlestickChart'
import { InfoTooltip } from '../../components/InfoTooltip'
import { OdChartExpandOnHover } from './OdChartExpandOnHover'
import { buildPolygonOptionsTicker } from '../../utils/polygonOptionsTicker'

const OPTION_BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 hour', label: '1 hour' },
  { value: '5 mins', label: '5 min' },
  { value: '1 min', label: '1 min' },
] as const

/** Option Discovery chart always reads Massive-backed rows in PostgreSQL (option_min / option_day). */
const BAR_SOURCE: 'massive' = 'massive'

/** Massive aggregates backfill: intraday job window (option_min). */
const AGG_LOOKBACK_MS_INTRADAY = 7 * 24 * 60 * 60 * 1000
/** Massive aggregates backfill: daily bars → option_day (plan default: ~2 years). */
const AGG_LOOKBACK_MS_DAILY = 730 * 24 * 60 * 60 * 1000

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
  /** K-line VWAP overlay; default on. */
  const [showVwap, setShowVwap] = useState(true)

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
            (period === '1 D'
              ? 'No bars in the database for this contract. Click Backfill from Massive to enqueue daily aggregates (option_day), or run the same job from Feed → Massive Option.'
              : 'No bars in the database for this contract. Click Backfill from Massive to enqueue aggregates (option_min), or run the same job from Feed → Massive Option.'),
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
    setSyncBusy(true)
    setSyncHint(null)
    setError(null)
    try {
      const optionsTicker = buildPolygonOptionsTicker(sym, exp, strike, optionRight)
      const endMs = Date.now()
      const isDaily = period === '1 D'
      const lookbackMs = isDaily ? AGG_LOOKBACK_MS_DAILY : AGG_LOOKBACK_MS_INTRADAY
      const startMs = endMs - lookbackMs
      let timespan = 'minute'
      let multiplier = 1
      if (isDaily) {
        timespan = 'day'
        multiplier = 1
      } else if (period === '1 hour') {
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
        setSyncHint(isDaily ? 'Daily backfill finished (option_day, ~2y window). Reloading bars from PostgreSQL.' : 'Backfill finished. Reloading bars from PostgreSQL.')
        await load()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setSyncBusy(false)
    }
  }, [symbol, expiration, strike, optionRight, period, load])

  const chartBars = useMemo(() => sortBarsAsc(bars), [bars])

  /** BarsCandlestickChart draws VWAP only when `vwap` is present on bars from GET /bars. */
  const chartHasVwap = useMemo(
    () => chartBars.some(b => finiteVwap(b.vwap) != null),
    [chartBars],
  )

  return (
    <div className="od-contract-chart">
      <div className="od-contract-chart-toolbar">
        <div className="od-contract-chart-period-cluster">
          <span className="od-contract-chart-toolbar-label">Period</span>
          <div className="od-contract-chart-periods" role="group" aria-label="Bar period">
            {OPTION_BAR_PERIODS.map(p => (
              <label key={p.value} className="od-contract-chart-period-item">
                <input
                  className="od-contract-chart-period-input"
                  type="radio"
                  name="od-opt-bar-period"
                  value={p.value}
                  checked={period === p.value}
                  onChange={() => setPeriod(p.value)}
                />
                <span className="od-contract-chart-period-item-text">{p.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="od-contract-chart-toolbar-right">
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
            disabled={loading || syncBusy}
            title={
              syncBusy
                ? 'Backfilling bars from Massive'
                : period === '1 D'
                ? 'Enqueue Celery job: Massive /v2/aggs (1 day) → option_day (~2 years lookback)'
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
            <InfoTooltip text="Reads OHLC from PostgreSQL (option_day for Daily, option_min for intraday). Backfill enqueues Massive /v2/aggs on the Celery queue: daily bars upsert option_day (~2y window); intraday upserts option_min (7 days). You can also use Feed → Massive Option → Aggregate Bars (OHLC)." />
          </span>
          <label
            className="od-contract-chart-vwap-toggle"
            title={
              chartBars.length > 0 && !chartHasVwap
                ? 'No VWAP in loaded bars'
                : 'Show or hide volume-weighted average price on the chart'
            }
          >
            <input
              type="checkbox"
              checked={showVwap}
              disabled={chartBars.length === 0 || !chartHasVwap}
              onChange={e => setShowVwap(e.target.checked)}
              aria-label="Show VWAP on chart"
            />
            <span>VWAP</span>
          </label>
        </div>
      </div>
      {syncHint && <p className="section-hint" role="status">{syncHint}</p>}
      {error && <p className="section-hint" role="status">{error}</p>}
      {chartBars.length > 0 && (
        <OdChartExpandOnHover
          title={`${symbol.trim().toUpperCase()} ${optionRight === 'C' ? 'Call' : 'Put'} ${strike.toFixed(2)} · ${period}`}
        >
          <div className="data-bars-chart-container" style={{ marginTop: '0.75rem' }}>
            <div className="data-bars-chart-header">
              <span className="data-bars-chart-title">
                {symbol.trim().toUpperCase()} {optionRight === 'C' ? 'Call' : 'Put'} {strike.toFixed(2)} · {period} · Massive (DB) · {chartBars.length} bars
              </span>
            </div>
            {!chartHasVwap && (
              <p className="od-chart-vwap-missing" role="alert">
                VWAP data missing: loaded bars do not include <code>vwap</code> from the Market API, so the chart cannot draw the VWAP line. OHLC and volume still use returned fields. Re-fetch bars after backfill, or verify GET /bars returns <code>vwap</code> for <code>asset=option</code>.
              </p>
            )}
            <BarsCandlestickChart
              bars={chartBars}
              period={period}
              showVwap={showVwap}
              enableTimeRangeBrush
            />
          </div>
        </OdChartExpandOnHover>
      )}
      {!loading && chartBars.length === 0 && !error && (
        <p className="section-hint" role="status">No bars returned.</p>
      )}
    </div>
  )
}
