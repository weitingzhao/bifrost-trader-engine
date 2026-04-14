import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { postMassiveSync, fetchMarketTradingDay } from '../../api'
import type { BarCoverageItem, StatusResponse } from '../../types'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  coverageCell,
  coverageCompact,
  coverageRange,
  coverageStatusDisplay,
} from '../data/dataCoverageUtils'
import { ReferenceIndexCoverageSymbolCell } from '../data/ReferenceIndexCoverageSymbolCell'
import { normCoverageSymbol, splitCoverageByReferenceIndices } from '../data/coverageSymbolGroups'
import { useMassiveRefJobSession } from './MassiveRefJobSessionContext'
import {
  addCalendarDaysNy,
  nyCalendarDateIso,
  presetNyRegularSessionForDate,
} from './customBarsTimePresets'

/** Fallback until the latest US regular session window is resolved (see intraday init effect). */
const STOCK_CUSTOM_BARS_DEFAULT_START_MS = 1717421400000
const STOCK_CUSTOM_BARS_DEFAULT_END_MS = 1717444800000

/** Matches POST /research/massive/sync validation for payload.symbols (stock_ohlc_sync custom_bars). */
const CUSTOM_BARS_SYMBOL_BATCH = 50

/** Backend: sync_all_periods with custom_bars_period_group — daily (1 D) vs intraday (1m, 5m, 1h). */
type CustomBarsPeriodGroup = 'daily' | 'intraday'

type CustomBarsSyncMode = 'window' | 'daily_smart'

function buildCustomBarsMultiPayload(
  startMs: number,
  endMs: number,
  group: CustomBarsPeriodGroup,
  extra: Record<string, unknown> = {},
  dailySyncMode: CustomBarsSyncMode = 'window',
): Record<string, unknown> {
  if (group === 'daily' && dailySyncMode === 'daily_smart') {
    // end_ms > 0 caps the NY calendar end date on the server; 0 = use today (see stock_ohlc_daily_smart).
    const cap = Number.isFinite(endMs) && endMs > 0 ? endMs : 0
    return {
      mode: 'custom_bars',
      sync_all_periods: true,
      custom_bars_period_group: 'daily',
      custom_bars_sync_mode: 'daily_smart',
      start_ms: 0,
      end_ms: cap,
      ...extra,
    }
  }
  return {
    mode: 'custom_bars',
    start_ms: startMs,
    end_ms: endMs,
    sync_all_periods: true,
    custom_bars_period_group: group,
    custom_bars_sync_mode: 'window',
    ...extra,
  }
}

function chunkStrings(list: string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const OHLC_MODES = [
  { id: 'custom_bars' as const, navLabel: 'Custom Bars', panelTitle: 'Custom Bars' },
  { id: 'daily_market_summary' as const, navLabel: 'Daily Market', panelTitle: 'Daily Market Summary' },
  { id: 'daily_ticker_summary' as const, navLabel: 'Daily Ticker', panelTitle: 'Daily Ticker Summary' },
  { id: 'previous_day_bar' as const, navLabel: 'Previous Day', panelTitle: 'Previous Day Bar' },
]

async function findLastNyTradingDay(): Promise<string | null> {
  let ymd = nyCalendarDateIso()
  for (let i = 0; i < 15; i++) {
    const r = await fetchMarketTradingDay(ymd)
    if (r.is_trading_day) return ymd
    ymd = addCalendarDaysNy(ymd, -1)
  }
  return null
}

export interface MassiveStockOhlcDbEnqueueBlockProps {
  configured: boolean
  status: StatusResponse | null
  coverage: BarCoverageItem[] | null
  coverageLoading: boolean
  coverageError: string | null
  onRefreshCoverage: () => void
  /** From GET /research/massive/status — empty-DB daily_smart window in calendar years */
  dailyFullBackfillYears: number
}

/**
 * Stock OHLC → PostgreSQL (Celery stock_ohlc_sync). Same session Jobs sheet + SSE as ticker reference enqueue.
 */
export function MassiveStockOhlcDbEnqueueBlock({
  configured,
  status,
  coverage,
  coverageLoading,
  coverageError,
  onRefreshCoverage,
  dailyFullBackfillYears,
}: MassiveStockOhlcDbEnqueueBlockProps) {
  const refJobSession = useMassiveRefJobSession()
  const [priorityHigh, setPriorityHigh] = useState(false)
  const [delayDbOhlcTab, setDelayDbOhlcTab] = useState<(typeof OHLC_MODES)[number]['id']>('custom_bars')
  const [ohlcMsg, setOhlcMsg] = useState<string | null>(null)

  const [dbOhlcTicker, setDbOhlcTicker] = useState('AAPL')
  const [dbOhlcStartMs, setDbOhlcStartMs] = useState(String(STOCK_CUSTOM_BARS_DEFAULT_START_MS))
  const [dbOhlcEndMs, setDbOhlcEndMs] = useState(String(STOCK_CUSTOM_BARS_DEFAULT_END_MS))
  const [dbOhlcTs, setDbOhlcTs] = useState('minute')
  const [dbOhlcMult, setDbOhlcMult] = useState('1')
  /** When false, Advanced multi-period enqueue uses separate Daily vs Intraday actions (not one combined job). */
  const [customBarsSingleTimespanOnly, setCustomBarsSingleTimespanOnly] = useState(false)
  const [dbGdDate, setDbGdDate] = useState('2024-06-03')
  const [dbOcTicker, setDbOcTicker] = useState('AAPL')
  const [dbOcDate, setDbOcDate] = useState('2024-06-03')
  const [dbPrevTicker, setDbPrevTicker] = useState('AAPL')
  const [isTradingDay, setIsTradingDay] = useState<boolean | null>(null)

  useEffect(() => {
    fetchMarketTradingDay()
      .then(r => setIsTradingDay(r.is_trading_day))
      .catch(() => setIsTradingDay(true))
  }, [])

  /** Intraday sync uses a fixed policy: latest resolved US regular session (09:30–16:00 ET), not user “test” presets. */
  useEffect(() => {
    if (!configured) return
    let cancelled = false
    void (async () => {
      const ymd = (await findLastNyTradingDay()) ?? nyCalendarDateIso()
      const w = presetNyRegularSessionForDate(ymd)
      if (cancelled || !w) return
      setDbOhlcStartMs(String(w.startMs))
      setDbOhlcEndMs(String(w.endMs))
    })()
    return () => {
      cancelled = true
    }
  }, [configured])

  const coverageGroups = useMemo(
    () => splitCoverageByReferenceIndices(coverage ?? [], status?.live_ui?.reference_indices),
    [coverage, status?.live_ui?.reference_indices],
  )

  const hasCustomBarsTableRows = useMemo(
    () => coverageGroups.some((g) => g.rows.length > 0),
    [coverageGroups],
  )

  /** Avoid flashing the indices placeholder table while the first coverage request is in flight. */
  const showCustomBarsTable =
    hasCustomBarsTableRows && (!coverageLoading || coverage != null)

  const allCoverageSymbols = useMemo(() => {
    const rows = coverage ?? []
    const fromCov = [...new Set(rows.map((r) => (r.symbol || '').trim().toUpperCase()).filter(Boolean))]
    const refSyms = (status?.live_ui?.reference_indices ?? [])
      .map((r) => (r.symbol || '').trim().toUpperCase())
      .filter(Boolean)
    return [...new Set([...refSyms, ...fromCov])]
  }, [coverage, status?.live_ui?.reference_indices])

  const backfillYears =
    Number.isFinite(dailyFullBackfillYears) && dailyFullBackfillYears > 0
      ? dailyFullBackfillYears
      : 5

  const runOhlcEnqueue = useCallback(
    async (payload: Record<string, unknown>) => {
      setOhlcMsg(null)
      await refJobSession.withStockOhlcHttp(async () => {
        try {
          const res = await postMassiveSync(
            'stock_ohlc_sync',
            payload,
            priorityHigh ? { priority: 'high' } : undefined,
          )
          if (!res.ok) {
            setOhlcMsg(res.error ?? res.message ?? 'Enqueue failed')
            return
          }
          if (!res.job_id) {
            setOhlcMsg('Enqueue accepted but no job id returned.')
            return
          }
          refJobSession.trackStockOhlcSyncJob({
            job_id: res.job_id,
            deduplicated: res.deduplicated,
          })
          const tag = res.deduplicated ? `${res.job_id} (deduplicated)` : res.job_id
          setOhlcMsg(`Enqueued stock_ohlc_sync: job ${tag}. Open Jobs for details.`)
        } catch (e: unknown) {
          setOhlcMsg(e instanceof Error ? e.message : 'Enqueue failed')
        }
      })
    },
    [priorityHigh, refJobSession],
  )

  const enqueueCustomBarsRow = useCallback(
    async (symbol: string, group: CustomBarsPeriodGroup) => {
      const startMs = parseInt(dbOhlcStartMs.trim(), 10)
      const endMs = parseInt(dbOhlcEndMs.trim(), 10)
      const t = symbol.trim().toUpperCase()
      if (!t) {
        setOhlcMsg('Custom bars: ticker is required.')
        return
      }
      if (group === 'daily') {
        await runOhlcEnqueue(
          buildCustomBarsMultiPayload(0, 0, 'daily', { ticker: t }, 'daily_smart'),
        )
        return
      }
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setOhlcMsg('Custom bars: Unix ms start/end are required for intraday.')
        return
      }
      await runOhlcEnqueue(
        buildCustomBarsMultiPayload(startMs, endMs, 'intraday', { ticker: t }, 'window'),
      )
    },
    [dbOhlcStartMs, dbOhlcEndMs, runOhlcEnqueue],
  )

  /** One job per chunk (max 50 symbols); fills PostgreSQL from Massive for the active time window. */
  const enqueueCustomBarsAllSymbols = useCallback(async (group: CustomBarsPeriodGroup) => {
    if (allCoverageSymbols.length === 0) {
      setOhlcMsg('No symbols in coverage. Refresh coverage after configuring watchlist / indices.')
      return
    }
    const startMs = parseInt(dbOhlcStartMs.trim(), 10)
    const endMs = parseInt(dbOhlcEndMs.trim(), 10)
    if (group === 'intraday' && (!Number.isFinite(startMs) || !Number.isFinite(endMs))) {
      setOhlcMsg('Custom bars: Unix ms start/end are required for intraday.')
      return
    }
    const basePayload: Record<string, unknown> =
      group === 'daily'
        ? buildCustomBarsMultiPayload(0, 0, 'daily', {}, 'daily_smart')
        : buildCustomBarsMultiPayload(startMs, endMs, 'intraday', {}, 'window')
    setOhlcMsg(null)
    await refJobSession.withStockOhlcHttp(async () => {
      const chunks = chunkStrings(allCoverageSymbols, CUSTOM_BARS_SYMBOL_BATCH)
      const errors: string[] = []
      let jobs = 0
      try {
        for (let i = 0; i < chunks.length; i++) {
          const res = await postMassiveSync(
            'stock_ohlc_sync',
            { ...basePayload, symbols: chunks[i] },
            priorityHigh ? { priority: 'high' } : undefined,
          )
          if (!res.ok) {
            errors.push(`Batch ${i + 1}/${chunks.length}: ${res.error ?? res.message ?? 'Enqueue failed'}`)
            continue
          }
          if (!res.job_id) {
            errors.push(`Batch ${i + 1}/${chunks.length}: no job id`)
            continue
          }
          refJobSession.trackStockOhlcSyncJob({
            job_id: res.job_id,
            deduplicated: res.deduplicated,
          })
          jobs += 1
        }
      } catch (e: unknown) {
        setOhlcMsg(e instanceof Error ? e.message : 'Enqueue failed')
        return
      }
      if (errors.length > 0 && jobs === 0) {
        setOhlcMsg(`${errors.join(' ')}`)
      } else if (errors.length > 0) {
        setOhlcMsg(`${errors.join(' ')} (${jobs} job(s) enqueued). Open Jobs for details.`)
      } else {
        const scope =
          group === 'daily'
            ? `daily smart (~${backfillYears}y full if empty, else gap-fill)`
            : 'intraday (1m / 5m / 1h)'
        setOhlcMsg(
          `Enqueued ${jobs} stock_ohlc_sync job(s) (${scope}) for ${allCoverageSymbols.length} symbol(s). Open Jobs for details.`,
        )
      }
    })
  }, [allCoverageSymbols, backfillYears, dbOhlcStartMs, dbOhlcEndMs, priorityHigh, refJobSession])

  const enqueueStockOhlcSyncAdvanced = useCallback(
    async (group: CustomBarsPeriodGroup, dailyMode: 'daily_smart' | 'window' = 'daily_smart') => {
      if (delayDbOhlcTab !== 'custom_bars') return
      const startMs = parseInt(dbOhlcStartMs.trim(), 10)
      const endMs = parseInt(dbOhlcEndMs.trim(), 10)
      const t = dbOhlcTicker.trim().toUpperCase()
      if (!t) {
        setOhlcMsg('Custom bars: ticker is required.')
        return
      }
      if (customBarsSingleTimespanOnly) {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          setOhlcMsg('Custom bars: Unix ms start/end are required.')
          return
        }
        await runOhlcEnqueue({
          mode: 'custom_bars',
          ticker: t,
          multiplier: parseInt(dbOhlcMult.trim(), 10) || 1,
          timespan: dbOhlcTs.trim() || 'minute',
          start_ms: startMs,
          end_ms: endMs,
          sync_all_periods: false,
        })
        return
      }
      if (group === 'daily' && dailyMode === 'daily_smart') {
        await runOhlcEnqueue(
          buildCustomBarsMultiPayload(0, 0, 'daily', { ticker: t }, 'daily_smart'),
        )
        return
      }
      if (group === 'daily' && dailyMode === 'window') {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          setOhlcMsg('Custom bars: Unix ms start/end are required for manual daily window.')
          return
        }
        await runOhlcEnqueue(
          buildCustomBarsMultiPayload(startMs, endMs, 'daily', { ticker: t }, 'window'),
        )
        return
      }
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setOhlcMsg('Custom bars: Unix ms start/end are required for intraday.')
        return
      }
      await runOhlcEnqueue(
        buildCustomBarsMultiPayload(startMs, endMs, 'intraday', { ticker: t }, 'window'),
      )
    },
    [
      delayDbOhlcTab,
      dbOhlcStartMs,
      dbOhlcEndMs,
      dbOhlcTicker,
      customBarsSingleTimespanOnly,
      dbOhlcMult,
      dbOhlcTs,
      runOhlcEnqueue,
    ],
  )

  const enqueueStockOhlcSync = useCallback(async () => {
    if (delayDbOhlcTab === 'daily_market_summary') {
      const d = dbGdDate.trim()
      if (!d) {
        setOhlcMsg('Date (YYYY-MM-DD) is required.')
        return
      }
      await runOhlcEnqueue({ mode: 'daily_market_summary', date: d })
      return
    }
    if (delayDbOhlcTab === 'daily_ticker_summary') {
      const t = dbOcTicker.trim().toUpperCase()
      const d = dbOcDate.trim()
      if (!t || !d) {
        setOhlcMsg('Ticker and date are required.')
        return
      }
      await runOhlcEnqueue({ mode: 'daily_ticker_summary', ticker: t, date: d })
      return
    }
    const t = dbPrevTicker.trim().toUpperCase()
    if (!t) {
      setOhlcMsg('Ticker is required.')
      return
    }
    await runOhlcEnqueue({ mode: 'previous_day_bar', ticker: t })
  }, [delayDbOhlcTab, dbGdDate, dbOcTicker, dbOcDate, dbPrevTicker, runOhlcEnqueue])

  const ohlcHttpBusy = refJobSession.jobBusyKind === 'stock_ohlc_sync'
  const disabled = !configured || refJobSession.jobBusyKind != null

  const modeMeta = OHLC_MODES.find(m => m.id === delayDbOhlcTab)
  const queueCode = priorityHigh ? 'massive_stocks_high' : 'massive_stocks'

  return (
    <div
      className="feed-massive-refdb-jobs"
      style={{ marginTop: 0, marginBottom: 0 }}
      role="region"
      aria-label="Stock OHLC PostgreSQL sync"
    >
      <div className="massive-delay-ohlc-queue-topline">
        <p className="feed-massive-agg-sub-doc massive-delay-ohlc-queue-topline-doc">
          Celery job <code>stock_ohlc_sync</code> upserts into <code>stock_day</code> / <code>stock_min</code> (source &quot;massive&quot;). Modes align with Settings → Feed → Massive Stock → Aggregate Bars (OHLC). Enqueued jobs appear in the same <strong>Jobs</strong> sheet as ticker reference tasks.
        </p>
        <div className="massive-delay-ohlc-queue-switch-wrap">
          <span className="form-label massive-delay-ohlc-queue-label" id="massive-delay-ohlc-queue-label">
            Queue
          </span>
          <div
            className="replay-bubble-switch massive-delay-ohlc-queue-bubbles"
            role="group"
            aria-labelledby="massive-delay-ohlc-queue-label"
          >
            <button
              type="button"
              className={`replay-bubble-switch-btn${!priorityHigh ? ' active' : ''}`}
              disabled={disabled}
              onClick={() => setPriorityHigh(false)}
              aria-pressed={!priorityHigh}
            >
              Standard
            </button>
            <button
              type="button"
              className={`replay-bubble-switch-btn${priorityHigh ? ' active' : ''}`}
              disabled={disabled}
              onClick={() => setPriorityHigh(true)}
              aria-pressed={priorityHigh}
            >
              High
            </button>
          </div>
          <InfoTooltip text="Standard uses Celery queue massive_stocks. High uses massive_stocks_high for stock_ohlc_sync." />
        </div>
      </div>

      <div className="ref-jobs-md ref-jobs-md--tabs">
        <ul className="ref-jobs-md-nav" role="tablist" aria-label="Stock OHLC sync mode">
          {OHLC_MODES.map(m => {
            const selected = delayDbOhlcTab === m.id
            return (
              <li key={m.id} className="ref-jobs-md-nav-item">
                <button
                  type="button"
                  role="tab"
                  id={`ohlc-db-tab-${m.id}`}
                  aria-selected={selected}
                  aria-controls="ohlc-db-detail-panel"
                  tabIndex={selected ? 0 : -1}
                  className="ref-jobs-md-tab"
                  disabled={disabled}
                  onClick={() => setDelayDbOhlcTab(m.id)}
                >
                  {m.navLabel}
                </button>
              </li>
            )
          })}
        </ul>

        <div
          className="ref-jobs-md-panel"
          id="ohlc-db-detail-panel"
          role="tabpanel"
          aria-labelledby={`ohlc-db-tab-${delayDbOhlcTab}`}
        >
          <div className="ref-jobs-md-meta">
            <div className="ref-jobs-md-meta-row">
              <span className="ref-jobs-md-meta-label">Job</span>
              <span><strong>stock_ohlc_sync</strong></span>
            </div>
            <div className="ref-jobs-md-meta-row">
              <span className="ref-jobs-md-meta-label">Mode</span>
              <span>{modeMeta?.panelTitle ?? '—'}</span>
            </div>
            <div className="ref-jobs-md-meta-row">
              <span className="ref-jobs-md-meta-label">Queue</span>
              <span><code className="ref-jobs-catalog-code">{queueCode}</code></span>
            </div>
          </div>

          <h4 className="ref-jobs-md-section-title">Enqueue</h4>

          {delayDbOhlcTab === 'custom_bars' ? (
            <div>
              <p className="ref-jobs-md-enqueue-hint" style={{ marginBottom: 'var(--space-2)' }}>
                <strong>Massive (delayed) → PostgreSQL</strong> — not IB Live in Redis. Rows align with <strong>Stock Coverage (IB Live)</strong>; click <strong>Bars</strong> to open IB Live.
              </p>
              <p className="ref-jobs-md-enqueue-hint" style={{ marginBottom: 'var(--space-2)' }}>
                <strong>Daily:</strong> through NY <strong>today</strong>; ~<strong>{backfillYears}y</strong> when empty (<code>massive.daily_full_backfill_years</code>), else gap-fill + <strong>2</strong> US trading-day overlap. <strong>Intraday:</strong> latest regular session (09:30–16:00 ET), 1m / 5m / 1h. <strong>Advanced:</strong> manual daily or intraday overrides (Start/End ms); <em>Single timespan only</em> = one multiplier × timespan.
              </p>
              <p className="ref-jobs-md-enqueue-hint" style={{ marginBottom: 'var(--space-2)' }}>
                Indices: config maps symbols to Polygon tickers (e.g. <code>^GSPC</code> → <code>SPY</code>, <code>^DJI</code> → <code>DIA</code>, <code>^VIX</code> → <code>VIXY</code> on Stocks Basic; <code>I:VIX</code> needs Indices).
              </p>
              <div
                className="replay-toolbar massive-delay-custom-bars-toolbar"
                style={{ flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', alignItems: 'center' }}
              >
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={disabled || coverageLoading}
                  onClick={() => void onRefreshCoverage()}
                  aria-label="Refresh bars coverage"
                >
                  {coverageLoading ? '…' : 'Refresh coverage'}
                </button>
                <InfoTooltip text="Same GET /bars/coverage list as Data Coverage → Stock → IB Live. Used for grouping and display only." />
                <span className="massive-delay-custom-bars-sync-all-group">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={disabled || ohlcHttpBusy || allCoverageSymbols.length === 0}
                    onClick={() => void enqueueCustomBarsAllSymbols('daily')}
                    aria-label="Enqueue Massive daily smart sync for all coverage symbols"
                  >
                    {ohlcHttpBusy ? '…' : 'Sync all (daily, smart)'}
                  </button>
                  <InfoTooltip text={`Daily smart: through NY today, ~${backfillYears}y back if empty, else gap-fill + 2-session overlap. One job per batch (up to ${CUSTOM_BARS_SYMBOL_BATCH} symbols).`} />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={disabled || ohlcHttpBusy || allCoverageSymbols.length === 0}
                    onClick={() => void enqueueCustomBarsAllSymbols('intraday')}
                    aria-label="Enqueue Massive intraday (1m, 5m, 1h) custom bars for all coverage symbols"
                  >
                    {ohlcHttpBusy ? '…' : 'Sync all (intraday)'}
                  </button>
                  <InfoTooltip text="1m, 5m, 1h for the latest resolved US regular session (09:30–16:00 ET). One job per batch; same window as table Intraday Sync." />
                </span>
              </div>

              {coverageError ? (
                <p className="status-page-msg err" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
                  {coverageError}
                </p>
              ) : null}

              {coverageLoading && coverage == null ? (
                <p className="replay-placeholder" role="status" style={{ marginBottom: 'var(--space-2)' }}>
                  Loading coverage…
                </p>
              ) : null}

              {!coverageLoading && !hasCustomBarsTableRows ? (
                <p className="replay-placeholder" role="status">No coverage rows (empty watchlist / indices). Configure reference indices or add watchlist symbols, then refresh.</p>
              ) : null}

              {showCustomBarsTable ? (
                <div className="data-coverage-table-wrap" style={{ marginBottom: 'var(--space-3)' }}>
                  <table className="table-operations data-coverage-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th colSpan={2}>Daily</th>
                        <th colSpan={2}>1 min</th>
                        <th colSpan={2}>5 mins</th>
                        <th colSpan={2}>1 hour</th>
                        <th colSpan={2} className="data-coverage-actions data-coverage-actions-sync-split">
                          PostgreSQL sync
                        </th>
                      </tr>
                      <tr>
                        <th></th>
                        <th className="data-coverage-bars">Bars</th>
                        <th className="data-coverage-range">Range</th>
                        <th className="data-coverage-bars">Bars</th>
                        <th className="data-coverage-range">Range</th>
                        <th className="data-coverage-bars">Bars</th>
                        <th className="data-coverage-range">Range</th>
                        <th className="data-coverage-bars">Bars</th>
                        <th className="data-coverage-range">Range</th>
                        <th className="data-coverage-actions-sub">1 D</th>
                        <th className="data-coverage-actions-sub">Intraday</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverageGroups.map((group) => (
                        <Fragment key={group.label || 'all'}>
                          {group.label ? (
                            <tr className="data-coverage-group-header-row">
                              <th colSpan={11} className="data-coverage-group-header">
                                {group.label}
                              </th>
                            </tr>
                          ) : null}
                          {group.rows.map((row) => {
                            const emptyPeriod = { count: 0, min_ts: null, max_ts: null }
                            const dayStatus = coverageStatusDisplay(row.stock_day.status)
                            const min1Status = coverageStatusDisplay(row.stock_min['1 min']?.status)
                            const min5Status = coverageStatusDisplay(row.stock_min['5 mins']?.status)
                            const min1hStatus = coverageStatusDisplay(row.stock_min['1 hour']?.status)
                            const isIndex = status?.live_ui?.reference_indices?.some(
                              (r) => normCoverageSymbol(r.symbol) === normCoverageSymbol(row.symbol),
                            )
                            const renderBarsCell = (
                              p: { count: number; min_ts: number | null; max_ts: number | null },
                              needPull: boolean,
                              period: string,
                              titleStr: string,
                            ) => (
                              <button
                                type="button"
                                className="data-coverage-bars-btn"
                                onClick={() => {
                                  window.location.hash = '#coverage-stock'
                                }}
                                title={`${titleStr} — Open Stock Coverage (IB Live) to inspect stored bars`}
                                aria-label={`Inspect bars ${row.symbol} ${period} on Stock Coverage`}
                              >
                                {coverageCompact(p, needPull, isTradingDay)}
                              </button>
                            )
                            return (
                              <tr key={row.symbol}>
                                <td>
                                  {isIndex ? (
                                    <ReferenceIndexCoverageSymbolCell
                                      symbol={row.symbol}
                                      reference={status?.live_ui?.reference_indices?.find(
                                        (r) =>
                                          r.symbol.trim().toUpperCase() === row.symbol.trim().toUpperCase(),
                                      )}
                                    />
                                  ) : (
                                    <strong>{row.symbol}</strong>
                                  )}
                                </td>
                                <td className="data-coverage-bars" title={coverageCell(row.stock_day, { dailySessionDates: true })}>
                                  {renderBarsCell(row.stock_day, dayStatus.needBackfill, '1 D', coverageCell(row.stock_day, { dailySessionDates: true }))}
                                </td>
                                <td className="data-coverage-range">{coverageRange(row.stock_day, { dailySessionDates: true })}</td>
                                <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 min'] || emptyPeriod)}>
                                  {renderBarsCell(
                                    row.stock_min['1 min'] || emptyPeriod,
                                    min1Status.needBackfill,
                                    '1 min',
                                    coverageCell(row.stock_min['1 min'] || emptyPeriod),
                                  )}
                                </td>
                                <td className="data-coverage-range">{coverageRange(row.stock_min['1 min'] || emptyPeriod)}</td>
                                <td className="data-coverage-bars" title={coverageCell(row.stock_min['5 mins'] || emptyPeriod)}>
                                  {renderBarsCell(
                                    row.stock_min['5 mins'] || emptyPeriod,
                                    min5Status.needBackfill,
                                    '5 mins',
                                    coverageCell(row.stock_min['5 mins'] || emptyPeriod),
                                  )}
                                </td>
                                <td className="data-coverage-range">{coverageRange(row.stock_min['5 mins'] || emptyPeriod)}</td>
                                <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 hour'] || emptyPeriod)}>
                                  {renderBarsCell(
                                    row.stock_min['1 hour'] || emptyPeriod,
                                    min1hStatus.needBackfill,
                                    '1 hour',
                                    coverageCell(row.stock_min['1 hour'] || emptyPeriod),
                                  )}
                                </td>
                                <td className="data-coverage-range">{coverageRange(row.stock_min['1 hour'] || emptyPeriod)}</td>
                                <td
                                  colSpan={2}
                                  className="data-coverage-actions data-coverage-sync-cells-pair"
                                >
                                  <div className="data-coverage-sync-pair-row">
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      disabled={disabled || ohlcHttpBusy}
                                      title="Daily smart: through NY today; gap-fill or full window when empty (see server backfill years)"
                                      aria-label={`Sync Massive daily smart for ${row.symbol}`}
                                      onClick={() => void enqueueCustomBarsRow(row.symbol, 'daily')}
                                    >
                                      {ohlcHttpBusy ? '…' : 'Sync'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      disabled={disabled || ohlcHttpBusy}
                                      title="Intraday: latest US regular session window (1m, 5m, 1h); override in Advanced"
                                      aria-label={`Sync Massive intraday custom bars for ${row.symbol}`}
                                      onClick={() => void enqueueCustomBarsRow(row.symbol, 'intraday')}
                                    >
                                      {ohlcHttpBusy ? '…' : 'Sync'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <details className="replay-section" style={{ marginTop: 'var(--space-3)' }}>
                <summary className="form-label" style={{ cursor: 'pointer', marginBottom: 'var(--space-2)' }}>
                  Advanced — manual ticker and Unix ms
                </summary>
                <p className="ref-jobs-md-enqueue-hint">
                  One ticker. <strong>Daily smart</strong> matches the table 1 D column. <strong>Daily (manual window)</strong> uses Start/End ms for 1 D only. <strong>Intraday</strong> uses Start/End ms for 1m / 5m / 1h (defaults to the latest US regular session; edit below to override). <em>Single timespan only</em> fetches exactly one multiplier × timespan.
                </p>
                <label className="feed-massive-field" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                  <input
                    type="checkbox"
                    checked={customBarsSingleTimespanOnly}
                    onChange={e => setCustomBarsSingleTimespanOnly(e.target.checked)}
                    disabled={disabled}
                  />
                  <span className="form-label" style={{ marginBottom: 0 }}>Single timespan only (one multiplier × timespan, no multi-period)</span>
                </label>
                <div className="ref-jobs-md-enqueue-row" style={{ alignItems: 'flex-start', marginTop: 'var(--space-2)' }}>
                  <div className="ref-jobs-md-enqueue-fields">
                    <label className="feed-massive-field" style={{ display: 'block' }}>
                      <span className="form-label">Stock ticker</span>
                      <input
                        className="form-input"
                        value={dbOhlcTicker}
                        onChange={e => setDbOhlcTicker(e.target.value)}
                        disabled={disabled}
                        placeholder="AAPL"
                        autoComplete="off"
                      />
                    </label>
                    <div className="feed-massive-form-grid feed-massive-form-grid--wide" style={{ marginTop: 'var(--space-2)' }}>
                      <label className="feed-massive-field">
                        <span className="form-label">Start (Unix ms)</span>
                        <input
                          className="form-input"
                          value={dbOhlcStartMs}
                          onChange={e => setDbOhlcStartMs(e.target.value)}
                          disabled={disabled}
                          placeholder={`e.g. ${STOCK_CUSTOM_BARS_DEFAULT_START_MS}`}
                          autoComplete="off"
                        />
                      </label>
                      <label className="feed-massive-field">
                        <span className="form-label">End (Unix ms)</span>
                        <input
                          className="form-input"
                          value={dbOhlcEndMs}
                          onChange={e => setDbOhlcEndMs(e.target.value)}
                          disabled={disabled}
                          placeholder={`e.g. ${STOCK_CUSTOM_BARS_DEFAULT_END_MS}`}
                          autoComplete="off"
                        />
                      </label>
                      <label className="feed-massive-field">
                        <span className="form-label">Timespan</span>
                        <input
                          className="form-input"
                          value={dbOhlcTs}
                          onChange={e => setDbOhlcTs(e.target.value)}
                          disabled={disabled || !customBarsSingleTimespanOnly}
                          placeholder="minute"
                          autoComplete="off"
                        />
                      </label>
                      <label className="feed-massive-field">
                        <span className="form-label">Multiplier</span>
                        <input
                          className="form-input"
                          value={dbOhlcMult}
                          onChange={e => setDbOhlcMult(e.target.value)}
                          disabled={disabled || !customBarsSingleTimespanOnly}
                          placeholder="1"
                          autoComplete="off"
                        />
                      </label>
                    </div>
                  </div>
                  <div className="ref-jobs-md-enqueue-actions ref-jobs-md-enqueue-actions--stack">
                    {customBarsSingleTimespanOnly ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={disabled}
                        onClick={() => void enqueueStockOhlcSyncAdvanced('daily')}
                      >
                        {ohlcHttpBusy ? 'Enqueueing…' : 'Enqueue sync'}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={disabled}
                          onClick={() => void enqueueStockOhlcSyncAdvanced('daily', 'daily_smart')}
                        >
                          {ohlcHttpBusy ? 'Enqueueing…' : 'Enqueue daily (smart)'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={disabled}
                          onClick={() => void enqueueStockOhlcSyncAdvanced('daily', 'window')}
                        >
                          {ohlcHttpBusy ? 'Enqueueing…' : 'Enqueue daily (manual window)'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={disabled}
                          onClick={() => void enqueueStockOhlcSyncAdvanced('intraday')}
                        >
                          {ohlcHttpBusy ? 'Enqueueing…' : 'Enqueue intraday (1m · 5m · 1h)'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <div className="ref-jobs-md-enqueue-row" style={{ alignItems: 'flex-start' }}>
              <div className="ref-jobs-md-enqueue-fields">
                {delayDbOhlcTab === 'daily_market_summary' ? (
                  <div>
                    <p className="ref-jobs-md-enqueue-hint">
                      One trading day, all U.S. stocks — large payload.
                    </p>
                    <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-2)' }}>
                      <span className="form-label">Date (YYYY-MM-DD)</span>
                      <input
                        className="form-input"
                        value={dbGdDate}
                        onChange={e => setDbGdDate(e.target.value)}
                        disabled={disabled}
                        placeholder="2024-06-03"
                        autoComplete="off"
                        style={{ maxWidth: '14rem' }}
                      />
                    </label>
                  </div>
                ) : null}

                {delayDbOhlcTab === 'daily_ticker_summary' ? (
                  <div>
                    <p className="ref-jobs-md-enqueue-hint">
                      Open / close and OHLC for one ticker on one date.
                    </p>
                    <div className="feed-massive-form-grid" style={{ marginTop: 'var(--space-2)' }}>
                      <label className="feed-massive-field">
                        <span className="form-label">Stock ticker</span>
                        <input
                          className="form-input"
                          value={dbOcTicker}
                          onChange={e => setDbOcTicker(e.target.value)}
                          disabled={disabled}
                          placeholder="AAPL"
                          autoComplete="off"
                        />
                      </label>
                      <label className="feed-massive-field">
                        <span className="form-label">Date (YYYY-MM-DD)</span>
                        <input
                          className="form-input"
                          value={dbOcDate}
                          onChange={e => setDbOcDate(e.target.value)}
                          disabled={disabled}
                          placeholder="2024-06-03"
                          autoComplete="off"
                        />
                      </label>
                    </div>
                  </div>
                ) : null}

                {delayDbOhlcTab === 'previous_day_bar' ? (
                  <div>
                    <p className="ref-jobs-md-enqueue-hint">
                      Previous trading session OHLC for one ticker (no calendar math client-side).
                    </p>
                    <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-2)' }}>
                      <span className="form-label">Stock ticker</span>
                      <input
                        className="form-input"
                        value={dbPrevTicker}
                        onChange={e => setDbPrevTicker(e.target.value)}
                        disabled={disabled}
                        placeholder="AAPL"
                        autoComplete="off"
                        style={{ maxWidth: '14rem' }}
                      />
                    </label>
                  </div>
                ) : null}
              </div>

              <div className="ref-jobs-md-enqueue-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabled}
                  onClick={() => void enqueueStockOhlcSync()}
                >
                  {ohlcHttpBusy ? 'Enqueueing…' : 'Enqueue sync'}
                </button>
              </div>
            </div>
          )}

          {ohlcMsg ? (
            <p className="feed-massive-api-coverage-sync-msg" style={{ marginTop: 'var(--space-3)' }}>
              {ohlcMsg}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
