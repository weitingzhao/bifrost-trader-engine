import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bar, BarStatsResponse } from '../types'
import { fetchBarStats, fetchBars, postMassiveSync } from '../api'
import { BarsCandlestickChart } from '../pages/data/BarsCandlestickChart'
import { inspectBarsLimitForPeriod } from '../pages/data/dataCoverageUtils'
import { findLastNyTradingDayForBarsSync } from '../pages/data/findLastNyTradingDay'
import {
  nyCalendarDateIso,
  presetNyRegularSessionForDate,
} from '../pages/massive/customBarsTimePresets'

export function StockBarStatsPanel({
  symbol,
  embedded = false,
  onClose,
  onBarStatsLoading,
}: {
  symbol: string
  embedded?: boolean
  onClose?: () => void
  onBarStatsLoading?: (sym: string, loading: boolean) => void
}) {
  const symU = (symbol || '').trim().toUpperCase()

  const [stats, setStats] = useState<BarStatsResponse | null>(null)
  const [fetchMarketDataStep, setFetchMarketDataStep] = useState<string | null>(null)
  const [fetchMarketDataError, setFetchMarketDataError] = useState<string | null>(null)
  const [chartPeriod, setChartPeriod] = useState<'1 D' | '1 min'>('1 D')
  const [chartBars, setChartBars] = useState<Bar[]>([])
  const [chartLoading, setChartLoading] = useState(false)
  const [chartError, setChartError] = useState<string | null>(null)
  const [chartInfo, setChartInfo] = useState<string | null>(null)
  const [chartShowVolume, setChartShowVolume] = useState(true)
  const [chartShowVwap, setChartShowVwap] = useState(false)
  const [chartShowMacd, setChartShowMacd] = useState(true)
  const [chartShowBb, setChartShowBb] = useState(true)
  const [chartShowRsi, setChartShowRsi] = useState(true)
  const [chartShowSr, setChartShowSr] = useState(false)

  const onBarStatsLoadingRef = useRef(onBarStatsLoading)
  onBarStatsLoadingRef.current = onBarStatsLoading
  const chartPeriodRef = useRef(chartPeriod)
  chartPeriodRef.current = chartPeriod

  const loadChartFromDb = useCallback(async (sym: string, period: '1 D' | '1 min') => {
    setChartLoading(true)
    setChartError(null)
    try {
      const res = await fetchBars(sym, period, inspectBarsLimitForPeriod(period))
      const rows = res.bars ?? []
      setChartBars(rows)
      if (rows.length === 0) {
        const hint =
          (typeof res.message === 'string' && res.message.trim()) ||
          `No ${period} bars in PostgreSQL for ${sym}. Use Fetch from Massive, wait for the Celery job to finish, then Reload chart.`
        setChartInfo(hint)
      } else {
        setChartInfo(null)
      }
    } catch (e) {
      setChartBars([])
      setChartError(e instanceof Error ? e.message : 'Load chart failed')
    } finally {
      setChartLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!symU) {
      setStats(null)
      return
    }
    let cancelled = false
    onBarStatsLoadingRef.current?.(symU, true)
    setChartPeriod('1 D')
    setChartBars([])
    setChartError(null)
    setChartInfo(null)
    setFetchMarketDataError(null)
    ;(async () => {
      try {
        const s = await fetchBarStats(symU)
        if (!cancelled) setStats(s)
      } catch {
        if (!cancelled) setStats({ stock_day: 0, stock_min: {} })
      } finally {
        if (!cancelled) onBarStatsLoadingRef.current?.(symU, false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [symU])

  useEffect(() => {
    if (!symU) return
    void loadChartFromDb(symU, chartPeriod)
  }, [symU, chartPeriod, loadChartFromDb])

  const chartBarsSorted = useMemo(() => {
    if (chartBars.length === 0) return []
    return [...chartBars].filter(b => b.time != null).sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  }, [chartBars])

  async function handleFetchMarketData() {
    if (!symU) return
    setFetchMarketDataError(null)
    setChartInfo(null)

    const steps: { label: string; run: () => Promise<{ ok: boolean; error?: string }> }[] = [
      {
        label: 'Enqueue daily OHLC (Massive → PostgreSQL)…',
        run: async () => {
          const res = await postMassiveSync('feed_stocks_aggregate', {
            mode: 'custom_bars',
            sync_all_periods: true,
            custom_bars_period_group: 'daily',
            custom_bars_sync_mode: 'daily_smart',
            start_ms: 0,
            end_ms: 0,
            ticker: symU,
          })
          return { ok: res.ok, error: res.error ?? res.message }
        },
      },
      {
        label: 'Enqueue intraday OHLC 1m / 5m / 1h (Massive → PostgreSQL)…',
        run: async () => {
          const ymd = (await findLastNyTradingDayForBarsSync()) ?? nyCalendarDateIso()
          const w = presetNyRegularSessionForDate(ymd)
          if (!w) {
            return { ok: false, error: 'Could not resolve a NY regular-session window for Massive intraday sync.' }
          }
          const res = await postMassiveSync('feed_stocks_aggregate', {
            mode: 'custom_bars',
            start_ms: w.startMs,
            end_ms: w.endMs,
            sync_all_periods: true,
            custom_bars_period_group: 'intraday',
            custom_bars_sync_mode: 'window',
            ticker: symU,
          })
          return { ok: res.ok, error: res.error ?? res.message }
        },
      },
    ]

    let lastError: string | null = null
    for (const { label, run } of steps) {
      setFetchMarketDataStep(label)
      try {
        const out = await run()
        if (!out.ok) {
          lastError = out.error || 'Massive sync enqueue failed'
          setFetchMarketDataError(lastError)
          break
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'Request failed'
        setFetchMarketDataError(lastError)
        break
      }
    }
    setFetchMarketDataStep(null)
    if (!lastError) {
      setChartInfo(
        'Massive stock OHLC jobs were enqueued (daily + last NY session intraday). '
          + 'Celery writes to stock_day / stock_min; wait for jobs to finish, then use Reload chart.',
      )
      try {
        const s = await fetchBarStats(symU)
        setStats(s)
        void loadChartFromDb(symU, chartPeriodRef.current)
      } catch {
        /* keep existing stats */
      }
    }
  }

  if (!symU) return null

  const headerRow = embedded ? (
    <div className="wl2-analysis__header riv-stock-bar-stats__header--embedded">
      <h3 className="wl2-analysis__title" id="riv-stock-bar-stats-head">
        Bar data
        <span className="wl2-analysis__sub">{symU}</span>
      </h3>
      <button
        type="button"
        className="wl2-btn wl2-btn--primary"
        disabled={!!fetchMarketDataStep}
        onClick={() => void handleFetchMarketData()}
      >
        {fetchMarketDataStep || 'Fetch from Massive'}
      </button>
    </div>
  ) : (
    <div className="wl2-analysis__header">
      <h3 className="wl2-analysis__title" id="riv-stock-bar-stats-head">
        {symU}
        <span className="wl2-analysis__sub">bar stats</span>
      </h3>
      <button
        type="button"
        className="wl2-btn wl2-btn--primary"
        disabled={!!fetchMarketDataStep}
        onClick={() => void handleFetchMarketData()}
      >
        {fetchMarketDataStep || 'Fetch from Massive'}
      </button>
      {onClose != null ? (
        <button type="button" className="wl2-act-icon" onClick={onClose} title="Close" aria-label="Close bar stats">
          ✕
        </button>
      ) : null}
    </div>
  )

  return (
    <section
      className={`wl2-analysis riv-stock-bar-stats${embedded ? ' riv-stock-bar-stats--embedded' : ''}`}
      aria-labelledby="riv-stock-bar-stats-head"
      style={embedded ? { minWidth: 0 } : undefined}
    >
      {headerRow}
      {fetchMarketDataError && <span className="wl2-error wl2-error--inline">{fetchMarketDataError}</span>}
      {stats != null && (
        <div className="wl2-analysis__grid">
          <div className="wl2-analysis__kpi">
            <span className="wl2-analysis__kpi-label">stock_day</span>
            <span className="wl2-analysis__kpi-val">{stats.stock_day.toLocaleString()}</span>
          </div>
          {stats.stock_min &&
            Object.entries(stats.stock_min).map(([period, count]) => (
              <div className="wl2-analysis__kpi" key={period}>
                <span className="wl2-analysis__kpi-label">{period}</span>
                <span className="wl2-analysis__kpi-val">{(count as number).toLocaleString()}</span>
              </div>
            ))}
        </div>
      )}

      <div className="wl2-analysis__chart-toolbar">
        <div className="wl2-analysis__chart-tabs" role="tablist" aria-label="K-line from database">
          <button
            type="button"
            role="tab"
            aria-selected={chartPeriod === '1 D'}
            className={`wl2-analysis__chart-tab${chartPeriod === '1 D' ? ' wl2-analysis__chart-tab--active' : ''}`}
            onClick={() => setChartPeriod('1 D')}
          >
            Daily
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={chartPeriod === '1 min'}
            className={`wl2-analysis__chart-tab${chartPeriod === '1 min' ? ' wl2-analysis__chart-tab--active' : ''}`}
            onClick={() => setChartPeriod('1 min')}
          >
            1 min
          </button>
        </div>
        <button
          type="button"
          className="wl2-btn wl2-btn--ghost wl2-analysis__chart-reload"
          disabled={chartLoading || !!fetchMarketDataStep}
          onClick={() => void loadChartFromDb(symU, chartPeriod)}
        >
          {chartLoading ? 'Loading…' : 'Reload chart'}
        </button>
      </div>
      <div className="wl2-analysis__chart-toggles" aria-label="Chart layers">
        <label className="wl2-analysis__toggle">
          <input type="checkbox" checked={chartShowVolume} onChange={e => setChartShowVolume(e.target.checked)} />
          Volume
        </label>
        <label className="wl2-analysis__toggle">
          <input type="checkbox" checked={chartShowVwap} onChange={e => setChartShowVwap(e.target.checked)} />
          VWAP
        </label>
        <label className="wl2-analysis__toggle">
          <input type="checkbox" checked={chartShowMacd} onChange={e => setChartShowMacd(e.target.checked)} />
          MACD
        </label>
        <label className="wl2-analysis__toggle">
          <input type="checkbox" checked={chartShowBb} onChange={e => setChartShowBb(e.target.checked)} />
          Bollinger
        </label>
        <label className="wl2-analysis__toggle">
          <input type="checkbox" checked={chartShowRsi} onChange={e => setChartShowRsi(e.target.checked)} />
          RSI
        </label>
        <label className="wl2-analysis__toggle">
          <input type="checkbox" checked={chartShowSr} onChange={e => setChartShowSr(e.target.checked)} />
          S/R
        </label>
      </div>
      <p className="wl2-analysis__chart-hint section-hint">
        Candles are read from PostgreSQL <code>stock_day</code> / <code>stock_min</code> via <code>GET /bars</code> (Massive and other sources may be present).{' '}
        <strong>Fetch from Massive</strong> enqueues Celery <code>feed_stocks_aggregate</code> jobs (daily + intraday); after they complete, use <strong>Reload chart</strong> or switch Daily / 1 min.
      </p>
      {chartError && (
        <p className="msg-error" role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {chartError}
        </p>
      )}
      {chartInfo && !chartError && (
        <p className="section-hint" role="status" style={{ marginTop: 'var(--space-2)' }}>
          {chartInfo}
        </p>
      )}
      {chartLoading && chartBarsSorted.length === 0 && (
        <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
          Loading chart from database…
        </p>
      )}
      {chartBarsSorted.length > 0 ? (
        <div className="wl2-analysis__chart-wrap" style={{ minWidth: 0, overflowX: 'auto' }}>
          <BarsCandlestickChart
            bars={chartBarsSorted}
            period={chartPeriod}
            showVolume={chartShowVolume}
            showVwap={chartShowVwap}
            showMacd={chartShowMacd}
            showBollinger={chartShowBb}
            showRsi={chartShowRsi}
            showSr={chartShowSr}
          />
        </div>
      ) : (
        !chartLoading &&
        !chartInfo && (
          <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>
            No bars in the database for this symbol and period. Use <strong>Fetch from Massive</strong>, wait for jobs to finish, then reload the chart.
          </p>
        )
      )}
    </section>
  )
}
