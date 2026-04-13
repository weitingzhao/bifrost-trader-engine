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
import { splitCoverageByReferenceIndices } from '../data/coverageSymbolGroups'
import { useMassiveRefJobSession } from './MassiveRefJobSessionContext'
import {
  addCalendarDaysNy,
  nyCalendarDateIso,
  presetNyRegularSessionForDate,
  presetNyRegularSessionRange,
  presetRegularSessionDemo,
} from './customBarsTimePresets'

/** Default Custom Bars window: one regular session (09:30–16:00 ET) on 2024-06-03 — works with multiplier 1 × timespan minute. */
const STOCK_CUSTOM_BARS_DEFAULT_START_MS = 1717421400000
const STOCK_CUSTOM_BARS_DEFAULT_END_MS = 1717444800000

/** Matches POST /research/massive/sync validation for payload.symbols (stock_ohlc_sync custom_bars). */
const CUSTOM_BARS_SYMBOL_BATCH = 50

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
  const [presetBusy, setPresetBusy] = useState(false)
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

  const coverageGroups = useMemo(
    () => splitCoverageByReferenceIndices(coverage ?? [], status?.live_ui?.reference_indices),
    [coverage, status?.live_ui?.reference_indices],
  )

  const allCoverageSymbols = useMemo(() => {
    const rows = coverage ?? []
    return [...new Set(rows.map(r => (r.symbol || '').trim().toUpperCase()).filter(Boolean))]
  }, [coverage])

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

  const applyCustomBarsWindow = useCallback((startMs: number, endMs: number) => {
    setDbOhlcStartMs(String(startMs))
    setDbOhlcEndMs(String(endMs))
  }, [])

  const onPresetRegularDemo = useCallback(() => {
    const w = presetRegularSessionDemo()
    applyCustomBarsWindow(w.startMs, w.endMs)
    setOhlcMsg(null)
  }, [applyCustomBarsWindow])

  const onPresetLastTradingDay = useCallback(async () => {
    setPresetBusy(true)
    setOhlcMsg(null)
    try {
      const ymd = await findLastNyTradingDay()
      if (!ymd) {
        setOhlcMsg('Could not resolve a recent US trading day (check Market API /market/trading-day).')
        return
      }
      const w = presetNyRegularSessionForDate(ymd)
      if (!w) {
        setOhlcMsg('Could not compute regular session bounds for that date.')
        return
      }
      applyCustomBarsWindow(w.startMs, w.endMs)
    } finally {
      setPresetBusy(false)
    }
  }, [applyCustomBarsWindow])

  const onPresetLastFiveCalendarDaysEt = useCallback(() => {
    const endYmd = nyCalendarDateIso()
    const startYmd = addCalendarDaysNy(endYmd, -4)
    const w = presetNyRegularSessionRange(startYmd, endYmd)
    if (!w) {
      setOhlcMsg('Could not compute a 5-day ET window.')
      return
    }
    applyCustomBarsWindow(w.startMs, w.endMs)
    setOhlcMsg(null)
  }, [applyCustomBarsWindow])

  const enqueueCustomBarsRow = useCallback(
    async (symbol: string) => {
      const startMs = parseInt(dbOhlcStartMs.trim(), 10)
      const endMs = parseInt(dbOhlcEndMs.trim(), 10)
      const t = symbol.trim().toUpperCase()
      if (!t || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setOhlcMsg('Custom bars: ticker and Unix ms start/end are required.')
        return
      }
      await runOhlcEnqueue({
        mode: 'custom_bars',
        ticker: t,
        start_ms: startMs,
        end_ms: endMs,
        sync_all_periods: true,
      })
    },
    [dbOhlcStartMs, dbOhlcEndMs, runOhlcEnqueue],
  )

  /** One job per chunk (max 50 symbols); fills PostgreSQL from Massive for the active time window. */
  const enqueueCustomBarsAllSymbols = useCallback(async () => {
    if (allCoverageSymbols.length === 0) {
      setOhlcMsg('No symbols in coverage. Refresh coverage after configuring watchlist / indices.')
      return
    }
    const startMs = parseInt(dbOhlcStartMs.trim(), 10)
    const endMs = parseInt(dbOhlcEndMs.trim(), 10)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setOhlcMsg('Custom bars: Unix ms start/end are required.')
      return
    }
    const basePayload: Record<string, unknown> = {
      mode: 'custom_bars',
      start_ms: startMs,
      end_ms: endMs,
      sync_all_periods: true,
    }
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
        setOhlcMsg(
          `Enqueued ${jobs} stock_ohlc_sync job(s) for ${allCoverageSymbols.length} symbol(s) (watchlist + indices). Open Jobs for details.`,
        )
      }
    })
  }, [
    allCoverageSymbols,
    dbOhlcStartMs,
    dbOhlcEndMs,
    dbOhlcMult,
    dbOhlcTs,
    priorityHigh,
    refJobSession,
  ])

  const enqueueStockOhlcSync = useCallback(async () => {
    if (delayDbOhlcTab === 'custom_bars') {
      const startMs = parseInt(dbOhlcStartMs.trim(), 10)
      const endMs = parseInt(dbOhlcEndMs.trim(), 10)
      const t = dbOhlcTicker.trim().toUpperCase()
      if (!t || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setOhlcMsg('Custom bars: ticker and Unix ms start/end are required.')
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
  }, [
    delayDbOhlcTab,
    dbOhlcStartMs,
    dbOhlcEndMs,
    dbOhlcTicker,
    dbOhlcMult,
    dbOhlcTs,
    dbGdDate,
    dbOcTicker,
    dbOcDate,
    dbPrevTicker,
    runOhlcEnqueue,
  ])

  const ohlcHttpBusy = refJobSession.jobBusyKind === 'stock_ohlc_sync'
  const disabled = !configured || refJobSession.jobBusyKind != null

  const modeMeta = OHLC_MODES.find(m => m.id === delayDbOhlcTab)

  return (
    <div
      className="feed-massive-refdb-jobs"
      style={{ marginTop: 0, marginBottom: 0 }}
      role="region"
      aria-label="Stock OHLC PostgreSQL sync"
    >
      <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)', maxWidth: '42rem' }}>
        Celery job <code>stock_ohlc_sync</code> upserts into <code>stock_day</code> / <code>stock_min</code> (source &quot;massive&quot;). Modes align with Settings → Feed → Massive Stock → Aggregate Bars (OHLC). Enqueued jobs appear in the same <strong>Jobs</strong> sheet as ticker reference tasks.
      </p>
      <label className="feed-massive-field" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        <input
          type="checkbox"
          checked={priorityHigh}
          onChange={e => setPriorityHigh(e.target.checked)}
          disabled={disabled}
        />
        <span className="form-label" style={{ marginBottom: 0 }}>High priority queue (massive_stocks_high)</span>
      </label>

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
              <span><code className="ref-jobs-catalog-code">massive_stocks</code></span>
            </div>
          </div>

          <h4 className="ref-jobs-md-section-title">Enqueue</h4>

          {delayDbOhlcTab === 'custom_bars' ? (
            <div>
              <p className="ref-jobs-md-enqueue-hint" style={{ marginBottom: 'var(--space-2)' }}>
                Data source is <strong>Massive (delayed) → PostgreSQL</strong>, not IB Live bars in Redis. The table mirrors <strong>Stock Coverage (IB Live)</strong> (bars + range). Click a bars cell to open IB Live coverage for inspection. <strong>Sync</strong> / <strong>Sync all symbols</strong> enqueue one job that pulls <strong>all four periods</strong> for the active time window: Daily (1 D), 1 min, 5 mins, and 1 hour (Polygon/Massive v2 aggs). Reference indices use Yahoo-style symbols in the app (e.g. <code>^GSPC</code>); Massive requests use Polygon index tickers (<code>I:SPX</code> S&amp;P 500, <code>I:DJI</code> Dow, <code>I:COMP</code> Nasdaq Composite) while rows stay keyed by your configured symbol. Use <strong>Advanced</strong> below only for a single timespan + multiplier (no multi-period).
              </p>
              <div className="replay-toolbar" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', alignItems: 'center' }}>
                <span className="form-label" style={{ marginBottom: 0 }}>Time window</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={disabled || presetBusy}
                  onClick={() => onPresetRegularDemo()}
                >
                  Regular session (demo)
                </button>
                <InfoTooltip text="Same Unix window as Feed → Massive Stock → Custom Bars default: 2024-06-03, 09:30–16:00 America/New_York, 1×minute." />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={disabled || presetBusy}
                  onClick={() => void onPresetLastTradingDay()}
                >
                  {presetBusy ? '…' : 'Last US session (ET)'}
                </button>
                <InfoTooltip text="Uses GET /market/trading-day to find the latest US trading day (America/New_York calendar), then sets 09:30–16:00 ET that day." />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={disabled || presetBusy}
                  onClick={() => onPresetLastFiveCalendarDaysEt()}
                >
                  Last 5 calendar days (ET)
                </button>
                <InfoTooltip text="America/New_York: regular session from five calendar days ago 09:30 through today 16:00 (inclusive span). Not the same as five full trading sessions." />
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
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={disabled || ohlcHttpBusy || allCoverageSymbols.length === 0}
                  onClick={() => void enqueueCustomBarsAllSymbols()}
                  aria-label="Enqueue Massive custom bars for all watchlist symbols and reference indices"
                >
                  {ohlcHttpBusy ? '…' : 'Sync all symbols'}
                </button>
                <InfoTooltip text={`Enqueues one stock_ohlc_sync job per batch (up to ${CUSTOM_BARS_SYMBOL_BATCH} symbols) for every row below, using the active time window and timespan. Same coverage list as IB Live Stock Coverage.`} />
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

              <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)', fontSize: '0.9em' }}>
                Active window: <code>{dbOhlcStartMs}</code> → <code>{dbOhlcEndMs}</code>
                {' · '}
                <span className="form-label" style={{ marginBottom: 0 }}>Timespan</span>{' '}
                <input
                  className="form-input"
                  style={{ display: 'inline-block', width: '6rem', marginLeft: '0.25rem' }}
                  value={dbOhlcTs}
                  onChange={e => setDbOhlcTs(e.target.value)}
                  disabled={disabled}
                  placeholder="minute"
                  autoComplete="off"
                  aria-label="Aggregate timespan"
                />
                {' '}
                <span className="form-label" style={{ marginBottom: 0 }}>Multiplier</span>{' '}
                <input
                  className="form-input"
                  style={{ display: 'inline-block', width: '3.5rem', marginLeft: '0.25rem' }}
                  value={dbOhlcMult}
                  onChange={e => setDbOhlcMult(e.target.value)}
                  disabled={disabled}
                  placeholder="1"
                  autoComplete="off"
                  aria-label="Aggregate multiplier"
                />
              </p>

              {coverage && coverage.length === 0 && !coverageLoading ? (
                <p className="replay-placeholder" role="status">No coverage rows (empty watchlist / indices). Configure reference indices or add watchlist symbols, then refresh.</p>
              ) : null}

              {coverage && coverage.length > 0 ? (
                <div className="data-coverage-table-wrap" style={{ marginBottom: 'var(--space-3)' }}>
                  <table className="table-operations data-coverage-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th colSpan={2}>Daily</th>
                        <th colSpan={2}>1 min</th>
                        <th colSpan={2}>5 mins</th>
                        <th colSpan={2}>1 hour</th>
                        <th className="data-coverage-actions">Actions</th>
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
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverageGroups.map((group) => (
                        <Fragment key={group.label || 'all'}>
                          {group.label ? (
                            <tr className="data-coverage-group-header-row">
                              <th colSpan={10} className="data-coverage-group-header">
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
                            const isIndex = status?.live_ui?.reference_indices?.some((r) => r.symbol === row.symbol)
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
                                  {isIndex ? (() => {
                                    const ref = status?.live_ui?.reference_indices?.find((r) => r.symbol === row.symbol)
                                    const label = ref?.label || row.symbol
                                    return (
                                      <>
                                        <strong>{label}</strong>
                                        <span
                                          className="data-coverage-status"
                                          style={{
                                            marginLeft: '0.35rem',
                                            color: 'var(--color-text-muted)',
                                            fontWeight: 'normal',
                                            fontSize: '0.9em',
                                          }}
                                          title="Reference index symbol"
                                        >
                                          {row.symbol}
                                        </span>
                                      </>
                                    )
                                  })() : (
                                    <strong>{row.symbol}</strong>
                                  )}
                                </td>
                                <td className="data-coverage-bars" title={coverageCell(row.stock_day)}>
                                  {renderBarsCell(row.stock_day, dayStatus.needBackfill, '1 D', coverageCell(row.stock_day))}
                                </td>
                                <td className="data-coverage-range">{coverageRange(row.stock_day)}</td>
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
                                <td className="data-coverage-actions data-coverage-actions-nowrap">
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    disabled={disabled || ohlcHttpBusy}
                                    title="Enqueue Massive custom bars for this symbol (active time window)"
                                    aria-label={`Sync Massive custom bars for ${row.symbol}`}
                                    onClick={() => void enqueueCustomBarsRow(row.symbol)}
                                  >
                                    {ohlcHttpBusy ? '…' : 'Sync'}
                                  </button>
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
                  Custom-range aggregates for one ticker (Unix ms window, timespan, multiplier). Use when presets do not match your range.
                </p>
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
                          disabled={disabled}
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
                          disabled={disabled}
                          placeholder="1"
                          autoComplete="off"
                        />
                      </label>
                    </div>
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
