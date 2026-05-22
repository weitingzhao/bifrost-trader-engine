import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bar, BarStatsResponse } from '../types'
import { fetchBarStats, fetchBars, postMassiveSync } from '../api'
import { BarsCandlestickChart } from '../views/data/BarsCandlestickChart'
import { inspectBarsLimitForPeriod } from '../views/data/dataCoverageUtils'
import { findLastNyTradingDayForBarsSync } from '../views/data/findLastNyTradingDay'
import {
  nyCalendarDateIso,
  presetNyRegularSessionForDate,
} from '../views/massive/customBarsTimePresets'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const chartTabClass = (active: boolean) =>
  cn(
    'cursor-pointer rounded-md border-0 bg-transparent px-3 py-1.5 text-[0.78rem] font-semibold text-muted-foreground transition-colors',
    'hover:bg-white/5 hover:text-foreground',
    active && 'bg-primary/15 text-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]',
  )

const layerToggleClass =
  'inline-flex cursor-pointer select-none items-center gap-1 text-[0.62rem] font-semibold text-muted-foreground'

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

  const renderKpiPills = () =>
    stats != null ? (
      <div className="flex flex-1 flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted/30 px-1.5 py-px text-[0.62rem] whitespace-nowrap">
          <span className="font-mono text-muted-foreground">Daily</span>
          <span className="font-mono font-semibold text-foreground">{stats.stock_day.toLocaleString()}</span>
        </span>
        {stats.stock_min && Object.entries(stats.stock_min).map(([period, count]) => (
          <span
            key={period}
            className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted/30 px-1.5 py-px text-[0.62rem] whitespace-nowrap"
          >
            <span className="font-mono text-muted-foreground">{period}</span>
            <span className="font-mono font-semibold text-foreground">{(count as number).toLocaleString()}</span>
          </span>
        ))}
      </div>
    ) : null

  const renderChartControls = () => (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <div
        className="inline-flex gap-0.5 rounded-lg border border-border bg-background p-0.5"
        role="tablist"
        aria-label="Period"
      >
        <button type="button" role="tab" aria-selected={chartPeriod === '1 D'}
          className={chartTabClass(chartPeriod === '1 D')}
          onClick={() => setChartPeriod('1 D')}>Daily</button>
        <button type="button" role="tab" aria-selected={chartPeriod === '1 min'}
          className={chartTabClass(chartPeriod === '1 min')}
          onClick={() => setChartPeriod('1 min')}>1 min</button>
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-1.5" aria-label="Chart layers">
        {[
          { label: 'Vol', state: chartShowVolume, set: setChartShowVolume },
          { label: 'VWAP', state: chartShowVwap, set: setChartShowVwap },
          { label: 'MACD', state: chartShowMacd, set: setChartShowMacd },
          { label: 'BB', state: chartShowBb, set: setChartShowBb },
          { label: 'RSI', state: chartShowRsi, set: setChartShowRsi },
          { label: 'S/R', state: chartShowSr, set: setChartShowSr },
        ].map(({ label, state, set }) => (
          <label key={label} className={layerToggleClass}>
            <input type="checkbox" checked={state} onChange={e => set(e.target.checked)} className="accent-primary" />
            {label}
          </label>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-[22px] shrink-0 px-1.5 py-0 text-[0.78rem] leading-none"
        disabled={chartLoading || !!fetchMarketDataStep}
        onClick={() => void loadChartFromDb(symU, chartPeriod)}
      >
        {chartLoading ? '…' : '↻'}
      </Button>
    </div>
  )

  const renderChartBody = () => (
    <>
      {chartError && (
        <p className="msg-error mt-2" role="alert">{chartError}</p>
      )}
      {chartInfo && !chartError && (
        <p className="section-hint mt-2" role="status">{chartInfo}</p>
      )}
      {chartLoading && chartBarsSorted.length === 0 && (
        <p className="section-hint mt-2">Loading chart from database…</p>
      )}
      {chartBarsSorted.length > 0 ? (
        <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-border bg-background p-2">
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
          <p className="section-hint mt-2">
            No bars in the database for this symbol and period. Use <strong>Fetch from Massive</strong>, wait for jobs to finish, then reload the chart.
          </p>
        )
      )}
    </>
  )

  if (!symU) return null

  if (embedded) {
    return (
      <section
        className="min-w-0 border-t border-border p-3"
        aria-labelledby="stock-bar-stats-head"
      >
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          <span
            className="shrink-0 border-l-2 border-primary pl-1.5 text-[0.68rem] font-bold tracking-wider text-muted-foreground uppercase whitespace-nowrap"
            id="stock-bar-stats-head"
          >
            Bar Data
          </span>
          {renderKpiPills()}
          <Button
            type="button"
            size="sm"
            className="h-[22px] shrink-0 px-2 py-0.5 text-[0.65rem] whitespace-nowrap"
            disabled={!!fetchMarketDataStep}
            onClick={() => void handleFetchMarketData()}
            title={fetchMarketDataStep ?? 'Fetch daily + intraday OHLC from Massive'}
          >
            {fetchMarketDataStep ? '…' : 'Fetch'}
          </Button>
        </div>

        {fetchMarketDataError && (
          <span className="text-[0.72rem] text-destructive">{fetchMarketDataError}</span>
        )}

        {renderChartControls()}
        {renderChartBody()}
      </section>
    )
  }

  return (
    <section
      className="mt-3 rounded-lg border border-border bg-muted/30 p-2 px-3"
      aria-labelledby="stock-bar-stats-head"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <span
          className="shrink-0 border-l-2 border-primary pl-1.5 text-[0.68rem] font-bold tracking-wider text-muted-foreground uppercase whitespace-nowrap"
          id="stock-bar-stats-head"
        >
          Bar Data · {symU}
        </span>
        {renderKpiPills()}
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          className="h-[22px] shrink-0 px-2 py-0.5 text-[0.65rem] whitespace-nowrap"
          disabled={!!fetchMarketDataStep}
          onClick={() => void handleFetchMarketData()}
          title={fetchMarketDataStep ?? 'Fetch daily + intraday OHLC from Massive'}
        >
          {fetchMarketDataStep ? '…' : 'Fetch'}
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close">✕</Button>
        )}
      </div>

      {fetchMarketDataError && (
        <p className="msg-error mt-2" role="alert">{fetchMarketDataError}</p>
      )}

      {renderChartControls()}
      {renderChartBody()}
    </section>
  )
}
