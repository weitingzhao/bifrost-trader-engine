import { useCallback, useEffect, useMemo, useState, Fragment } from 'react'
import type { Bar, BarCoverageItem, BarsCoverageResponse, StatusResponse } from '../types'
import { fetchBars, fetchBarsCoverage, fetchBarsJobs, postBarsBackfill, postWatchlistEodRefresh, fetchWatchlistEodRefreshPreview, postIndicesRefresh, deleteBarsForSymbol, deleteBarsJob, deleteAllBarsJobs } from '../api'
import type { WatchlistEodRefreshPreviewItem, WatchlistEodRefreshPreviewResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fetchMarketTradingDay } from '../api'
import { fmtDurationSeconds, fmtTs, fmtUsd } from '../utils/format'
import { BAR_PERIODS } from './data/constants'
import { coverageCell, coverageCompact, coverageRange, coverageStatusDisplay, inspectBarsLimitForPeriod } from './data/dataCoverageUtils'
import { BarsCandlestickChart } from './data/BarsCandlestickChart'
import { useBarCandidateSymbols } from './data/useBarCandidateSymbols'

interface DataPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

/** Data page: backfill per symbol from coverage, inspect bars. */
export function DataPage({ status, onGoToScreener, breadcrumbLabel = 'Data' }: DataPageProps) {
  const [bars, setBars] = useState<Bar[]>([])
  const [barsLoading, setBarsLoading] = useState(false)
  const [barSymbol, setBarSymbol] = useState('')
  const [barPeriod, setBarPeriod] = useState<string>('1 D')
  /** Bars (inspect) table: sort by time 'asc' = oldest first, 'desc' = newest first */
  const [barsTimeSort, setBarsTimeSort] = useState<'asc' | 'desc'>('desc')

  const [coverage, setCoverage] = useState<BarCoverageItem[] | null>(null)
  const [coveragePolicy, setCoveragePolicy] = useState<BarsCoverageResponse['policy'] | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [deletingSymbol, setDeletingSymbol] = useState<string | null>(null)
  const [deleteSymbolError, setDeleteSymbolError] = useState<string | null>(null)
  /** Reset confirmation modal: symbol to reset, or null when closed */
  const [resetConfirmSymbol, setResetConfirmSymbol] = useState<string | null>(null)
  /** True when Reset was opened from an Index row (daily only); false for Watchlist (multi-period). */
  const [resetConfirmIsIndex, setResetConfirmIsIndex] = useState(false)
  /** Periods to clear when Reset (1 D, 1 min, 5 mins, 1 hour); multi-select checkboxes; ignored when resetConfirmIsIndex */
  const [resetPeriods, setResetPeriods] = useState<string[]>(['1 D', '1 min', '5 mins', '1 hour'])
  /** Backfill options: fake IB call (skip IB fetch), default off; API interval between requests (sec), default 10 */
  const [backfillIsTest, setBackfillIsTest] = useState(false)
  const [backfillApiIntervalSec, setBackfillApiIntervalSec] = useState(10)
  /** Symbol for which we just enqueued backfill; show "Queued N jobs" and clear after a few seconds */
  const [backfillSymbol, setBackfillSymbol] = useState<string | null>(null)
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null)
  const [needWatchlistDryRun, setNeedWatchlistDryRun] = useState(false)
  const [watchlistPreviewLoading, setWatchlistPreviewLoading] = useState(false)
  const [watchlistRefreshRunning, setWatchlistRefreshRunning] = useState(false)
  const [watchlistRefreshMessage, setWatchlistRefreshMessage] = useState<string | null>(null)
  const [indicesRefreshLoading, setIndicesRefreshLoading] = useState(false)
  const [indicesRefreshMessage, setIndicesRefreshMessage] = useState<string | null>(null)
  /** Pull range modal: when set, show modal to choose Max / Min / Custom before queuing */
  const [pullModalSymbol, setPullModalSymbol] = useState<string | null>(null)
  /** True when Pull modal was opened from an Index row (TradingView daily only); false for Watchlist (IB, all periods). */
  const [pullModalIsIndex, setPullModalIsIndex] = useState(false)
  /** Selected periods to pull in the modal (multi-select; init from periods needing backfill when opening) */
  const [pullSelectedPeriods, setPullSelectedPeriods] = useState<string[]>(['1 D', '1 min', '5 mins', '1 hour'])
  const [pullRangeMode, setPullRangeMode] = useState<'max' | 'min' | 'custom' | null>('max')
  const [watchlistRefreshPreview, setWatchlistRefreshPreview] = useState<WatchlistEodRefreshPreviewResponse | null>(null)
  /** Custom span per period: Daily/5min/1h use days; 1 min uses hours */
  const [pullCustomDailyDays, setPullCustomDailyDays] = useState(30)
  const [pullCustom1minHours, setPullCustom1minHours] = useState(24)
  const [pullCustom5minDays, setPullCustom5minDays] = useState(7)
  const [pullCustom1hourDays, setPullCustom1hourDays] = useState(7)
  const [barsJobs, setBarsJobs] = useState<Array<{ job_id: string; symbol: string; period: string; status: string; result?: { count?: number; message?: string; error?: string }; created_ts?: number; updated_ts?: number }>>([])
  const [barsJobsLoading, setBarsJobsLoading] = useState(false)
  const [barsJobsError, setBarsJobsError] = useState<string | null>(null)
  const [barsJobsTotal, setBarsJobsTotal] = useState(0)
  const [barsJobsLimit, setBarsJobsLimit] = useState(5)
  /** Selected statuses for filter and delete; default only done so Delete all only removes done jobs unless user adds more. */
  const [barsJobsStatusSelected, setBarsJobsStatusSelected] = useState<Set<string>>(new Set(['done']))
  const [barsJobsSortKey, setBarsJobsSortKey] = useState<'job_id' | 'status' | 'created_ts' | 'updated_ts'>('updated_ts')
  const [barsJobsSortDir, setBarsJobsSortDir] = useState<'asc' | 'desc'>('desc')
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  /** Whether today (America/New_York) is a US market trading day; from GET /market/trading-day. null = not yet loaded. */
  const [isTradingDay, setIsTradingDay] = useState<boolean | null>(null)

  const candidateSymbols = useBarCandidateSymbols(status)

  useEffect(() => {
    fetchMarketTradingDay()
      .then((r) => setIsTradingDay(r.is_trading_day))
      .catch(() => setIsTradingDay(true))
  }, [])

  const sortedBars = useMemo(() => {
    if (bars.length === 0) return []
    const order = barsTimeSort === 'desc' ? -1 : 1
    return [...bars].sort((a, b) => order * (a.time - b.time))
  }, [bars, barsTimeSort])

  const sortedBarsJobs = useMemo(() => {
    if (barsJobs.length === 0) return []
    const key = barsJobsSortKey
    const dir = barsJobsSortDir === 'asc' ? 1 : -1
    return [...barsJobs].sort((a, b) => {
      let va: number | string
      let vb: number | string
      if (key === 'job_id') {
        va = parseInt(a.job_id, 10) || 0
        vb = parseInt(b.job_id, 10) || 0
        return dir * ((va as number) - (vb as number))
      }
      if (key === 'status') {
        va = (a.status || '').toLowerCase()
        vb = (b.status || '').toLowerCase()
        return dir * (va < vb ? -1 : va > vb ? 1 : 0)
      }
      if (key === 'created_ts') {
        va = a.created_ts ?? 0
        vb = b.created_ts ?? 0
        return dir * ((va as number) - (vb as number))
      }
      // updated_ts
      va = a.updated_ts ?? 0
      vb = b.updated_ts ?? 0
      return dir * ((va as number) - (vb as number))
    })
  }, [barsJobs, barsJobsSortKey, barsJobsSortDir])
  const chartBars = useMemo(() => {
    if (bars.length === 0) return []
    return [...bars]
      .filter(b => b.time != null)
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  }, [bars])
  const tableBars = useMemo(() => {
    if (sortedBars.length === 0) return []
    return sortedBars.slice(0, 5)
  }, [sortedBars])

  /** Data coverage rows: always grouped as Indices then Watchlist */
  const coverageGroups = useMemo((): { label: string; rows: BarCoverageItem[] }[] => {
    if (!coverage || coverage.length === 0) return []
    const refSymbols = new Set((status?.reference_indices ?? []).map((r) => r.symbol))
    const indices = coverage.filter((r) => refSymbols.has(r.symbol))
    const watchlist = coverage.filter((r) => !refSymbols.has(r.symbol))
    const out: { label: string; rows: BarCoverageItem[] }[] = []
    if (indices.length > 0) out.push({ label: 'Indices', rows: indices })
    if (watchlist.length > 0) out.push({ label: 'Watchlist', rows: watchlist })
    return out.length > 0 ? out : [{ label: '', rows: coverage }]
  }, [coverage, status?.reference_indices])

  useEffect(() => {
    if (candidateSymbols.length > 0 && !barSymbol.trim()) setBarSymbol(candidateSymbols[0])
  }, [candidateSymbols.join(','), barSymbol])

  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true)
    setCoverageError(null)
    setDeleteSymbolError(null)
    try {
      const res = await fetchBarsCoverage()
      setCoverage(res.coverage || [])
      setCoveragePolicy(res.policy ?? null)
    } catch (e) {
      setCoverageError(e instanceof Error ? e.message : 'Load failed')
      setCoverage([])
    } finally {
      setCoverageLoading(false)
    }
  }, [])

  const loadBarsJobs = useCallback(async () => {
    setBarsJobsLoading(true)
    setBarsJobsError(null)
    try {
      const selected = barsJobsStatusSelected
      const limit = Math.max(1, Math.min(500, barsJobsLimit || 50))
      const statusParam = selected.size === 0 ? undefined : selected.size === 1 ? [...selected][0] : undefined
      const res = await fetchBarsJobs(limit, 0, statusParam)
      let jobs = Array.isArray(res.jobs) ? res.jobs : []
      let total = typeof res.total === 'number' ? res.total : 0
      if (selected.size > 1) {
        jobs = jobs.filter(j => selected.has(j.status))
        total = jobs.length
      }
      setBarsJobs(jobs)
      setBarsJobsTotal(total)
      setBarsJobsError(res.error ?? null)
    } catch (e) {
      setBarsJobs([])
      setBarsJobsTotal(0)
      setBarsJobsError(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setBarsJobsLoading(false)
    }
  }, [barsJobsLimit, barsJobsStatusSelected])

  const toggleBarsJobsStatus = useCallback((status: string) => {
    setBarsJobsStatusSelected(prev => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }, [])

  useEffect(() => {
    loadCoverage()
  }, [loadCoverage])

  useEffect(() => {
    loadBarsJobs()
  }, [loadBarsJobs])

  const openWatchlistEodRefreshPreview = useCallback(async () => {
    setWatchlistPreviewLoading(true)
    setWatchlistRefreshMessage(null)
    try {
      const res = await fetchWatchlistEodRefreshPreview({
        override_days: 1,
        api_interval_sec: backfillApiIntervalSec,
      })
      if (!res.ok) {
        setWatchlistRefreshMessage(res.error || 'Dry run failed')
        return
      }
      setWatchlistRefreshPreview(res)
    } catch (e) {
      setWatchlistRefreshMessage(e instanceof Error ? e.message : 'Dry run failed')
    } finally {
      setWatchlistPreviewLoading(false)
    }
  }, [backfillApiIntervalSec])

  const confirmWatchlistEodRefresh = useCallback(async () => {
    setWatchlistRefreshRunning(true)
    setWatchlistRefreshMessage(null)
    try {
      const res = await postWatchlistEodRefresh({
        override_days: 1,
        is_test: backfillIsTest,
        api_interval_sec: backfillApiIntervalSec,
      })
      if (!res.ok) {
        setWatchlistRefreshMessage(res.error || 'EOD refresh failed')
        return
      }
      setWatchlistRefreshMessage(
        res.message || `Queued ${res.queued_count ?? 0} EOD refresh job(s) for ${res.symbols_count ?? 0} symbol(s).`,
      )
      setWatchlistRefreshPreview(null)
      if ((res.queued_count ?? 0) > 0) {
        await loadBarsJobs()
        await loadCoverage()
      }
    } catch (e) {
      setWatchlistRefreshMessage(e instanceof Error ? e.message : 'EOD refresh failed')
    } finally {
      setWatchlistRefreshRunning(false)
    }
  }, [backfillApiIntervalSec, backfillIsTest, loadBarsJobs, loadCoverage])

  const handleRefreshIndices = useCallback(async () => {
    setIndicesRefreshLoading(true)
    setIndicesRefreshMessage(null)
    try {
      const res = await postIndicesRefresh()
      if (res.ok) {
        setIndicesRefreshMessage(
          res.updated.length > 0
            ? `Refreshed ${res.updated.length} index(s): ${res.updated.join(', ')}.`
            : 'No reference indices in config.',
        )
        await loadCoverage()
      } else {
        setIndicesRefreshMessage(res.errors?.length ? res.errors.join('; ') : 'Refresh failed.')
      }
    } catch (e) {
      setIndicesRefreshMessage(e instanceof Error ? e.message : 'Refresh failed.')
    } finally {
      setIndicesRefreshLoading(false)
    }
  }, [loadCoverage])

  const handleWatchlistEodRefreshClick = useCallback(async () => {
    if (needWatchlistDryRun) {
      await openWatchlistEodRefreshPreview()
      return
    }
    await confirmWatchlistEodRefresh()
  }, [confirmWatchlistEodRefresh, needWatchlistDryRun, openWatchlistEodRefreshPreview])

  const loadBarsFromApi = useCallback(async (symbol: string) => {
    if (!symbol.trim()) return
    setBarsLoading(true)
    try {
      const res = await fetchBars(symbol, barPeriod, inspectBarsLimitForPeriod(barPeriod))
      setBars(res.bars || [])
    } catch {
      setBars([])
    } finally {
      setBarsLoading(false)
    }
  }, [barPeriod])

  /** Click a Bars cell in Data Coverage: load period-specific default window in Bars (inspect). */
  const openBarsForSymbol = useCallback(async (symbol: string, period: string) => {
    if (!symbol.trim()) return
    setBarSymbol(symbol.trim().toUpperCase())
    setBarPeriod(period)
    setBarsLoading(true)
    try {
      const res = await fetchBars(symbol.trim(), period, inspectBarsLimitForPeriod(period))
      setBars(res.bars || [])
    } catch {
      setBars([])
    } finally {
      setBarsLoading(false)
    }
  }, [])

  return (
    <div className="card process-section market-data-page">
      {onGoToScreener && (
        <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={onGoToScreener}
            aria-label="Go to Screener"
          >
            Research
          </button>
          {' / '}
          {breadcrumbLabel}
        </h2>
      )}
      <section className="replay-section" aria-labelledby="data-coverage-head">
        <h3 id="data-coverage-head" className="page-title-with-tooltip">
          Coverage
          <InfoTooltip text={coveragePolicy
            ? `Coverage of Watchlist stocks in stock_day / stock_min by period (count and date range). Target range (current config): Daily ${coveragePolicy.daily_years}y, 1 min ${coveragePolicy.min_weeks}w, 5min ${coveragePolicy['5min_months']}mo, 1h ${coveragePolicy['1hour_months']}mo. Need backfill if status is not OK. Empty when no Watchlist stocks.`
            : 'Coverage of Watchlist stocks in stock_day / stock_min by period (count and date range). Target range from config: Daily 10y, 1 min 1w, 5min 1mo, 1h 3mo. Need backfill if status is not OK. Empty when no Watchlist stocks.'} />
        </h3>
        <div className="replay-toolbar data-backfill-options" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
          <label className="data-toggle-switch-wrap" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <span className="toggle-switch" role="switch" aria-checked={backfillIsTest} tabIndex={0} onClick={() => setBackfillIsTest(!backfillIsTest)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setBackfillIsTest(!backfillIsTest) } }}>
              <span className="toggle-switch-track" />
              <span className={backfillIsTest ? 'toggle-switch-thumb on' : 'toggle-switch-thumb'} />
            </span>
            <span>fake IB call</span>
            <InfoTooltip text="When on, pull will not call IB (test mode: only log planned requests). Default off." />
          </label>
          <label className="data-toggle-switch-wrap" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <span className="toggle-switch" role="switch" aria-checked={needWatchlistDryRun} tabIndex={0} onClick={() => setNeedWatchlistDryRun(!needWatchlistDryRun)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setNeedWatchlistDryRun(!needWatchlistDryRun) } }}>
              <span className="toggle-switch-track" />
              <span className={needWatchlistDryRun ? 'toggle-switch-thumb on' : 'toggle-switch-thumb'} />
            </span>
            <span>Dry run</span>
            <InfoTooltip text="Default off. When off, clicking EOD Pull queues worker jobs immediately. When on, click first opens the dry-run preview; only the modal confirmation will queue jobs." />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span>API interval (sec):</span>
            <input
              type="number"
              min={0}
              max={300}
              value={backfillApiIntervalSec}
              onChange={e => setBackfillApiIntervalSec(Math.max(0, Math.min(300, parseInt(e.target.value, 10) || 0)))}
              style={{ width: '4rem' }}
              aria-label="Seconds between each IB API request"
            />
            <InfoTooltip text="Wait this many seconds between each IB history request (chunk). Default 10." />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={coverageLoading}
              onClick={() => loadCoverage()}
              aria-label="Refresh coverage"
            >
              {coverageLoading ? '…' : 'Refresh'}
            </button>
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={watchlistPreviewLoading || watchlistRefreshRunning}
            onClick={() => { void handleWatchlistEodRefreshClick() }}
            aria-label={needWatchlistDryRun ? 'Dry run end-of-day pull for all Watchlist symbols' : 'Queue end-of-day pull for all Watchlist symbols'}
            title={needWatchlistDryRun
              ? 'Dry run first: preview overwritten records, gap range, and IB request parameters before queueing worker jobs'
              : 'Queue worker jobs immediately for all Watchlist stocks without opening dry-run preview'}
          >
            {watchlistPreviewLoading ? 'Dry run…' : watchlistRefreshRunning ? 'Queuing…' : 'EOD Pull'}
          </button>
          <InfoTooltip text={needWatchlistDryRun
            ? 'Dry run is enabled. Clicking the button opens the preview first; only modal confirmation will queue jobs. EOD Pull runs once after market close: fills end gap and overrides latest bars with final close (override_days=1). Dry run is off by default.'
            : 'Dry run is disabled. Clicking the button queues jobs immediately. EOD Pull runs once after market close: fills end gap and overrides latest bars with final close (override_days=1). A message like “Queued 48 EOD refresh job(s) for 12 watchlist symbol(s). override_days=1” means 48 worker jobs were enqueued (e.g. 4 periods × 12 symbols); only the latest bar per symbol/period is overwritten with end-of-day data.'} />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={indicesRefreshLoading || (status?.reference_indices?.length ?? 0) === 0}
            onClick={() => { void handleRefreshIndices() }}
            aria-label="Refresh reference indices"
            title="Pull daily bars for reference indices from TradingView into stock_day."
          >
            {indicesRefreshLoading ? 'Refreshing…' : 'Refresh indices'}
          </button>
          <InfoTooltip text="Refresh reference indices (^GSPC, ^DJI, ^IXIC) from TradingView. Daily only." />
        </div>
        {indicesRefreshMessage && (
          <div className="replay-placeholder" role="status" style={{ marginBottom: '0.5rem' }}>
            {indicesRefreshMessage}
          </div>
        )}
        {watchlistRefreshMessage && (
          <div className="replay-placeholder" role="status" style={{ marginBottom: '0.5rem' }}>
            {watchlistRefreshMessage}
          </div>
        )}
        {coverageError && (
          <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
            {coverageError}
          </div>
        )}
        {deleteSymbolError && (
          <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
            {deleteSymbolError}
          </div>
        )}
        {coverage && coverage.length === 0 && !coverageLoading && (
          <div className="replay-placeholder">No stocks in Watchlist and no reference indices configured. Add stocks on the Watchlist tab or configure reference_indices, then refresh.</div>
        )}
        {coverage && coverage.length > 0 && (
          <>
            <div className="data-coverage-table-wrap">
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
                const isIndex = status?.reference_indices?.some((r) => r.symbol === row.symbol)
                const dayStatus = coverageStatusDisplay(row.stock_day.status)
                const min1Status = coverageStatusDisplay(row.stock_min['1 min']?.status)
                const min5Status = coverageStatusDisplay(row.stock_min['5 mins']?.status)
                const min1hStatus = coverageStatusDisplay(row.stock_min['1 hour']?.status)
                const isDeleting = deletingSymbol === row.symbol
                const periodsNeedingBackfill: string[] = []
                if (dayStatus.needBackfill) periodsNeedingBackfill.push('1 D')
                if (min1Status.needBackfill) periodsNeedingBackfill.push('1 min')
                if (min5Status.needBackfill) periodsNeedingBackfill.push('5 mins')
                if (min1hStatus.needBackfill) periodsNeedingBackfill.push('1 hour')
                const isBackfilling = backfillSymbol === row.symbol
                const canBackfill = periodsNeedingBackfill.length > 0 && !isBackfilling && !isDeleting && !isIndex
                const renderBarsCell = (p: { count: number; min_ts: number | null; max_ts: number | null }, needPull: boolean, period: string, titleStr: string) => (
                  <button
                    type="button"
                    className="data-coverage-bars-btn"
                    onClick={() => openBarsForSymbol(row.symbol, period)}
                    title={titleStr}
                    aria-label={`Show bars ${row.symbol} ${period}`}
                  >
                    {coverageCompact(p, needPull, isTradingDay)}
                  </button>
                )
                return (
                  <tr key={row.symbol}>
                    <td>
                      {isIndex ? (() => {
                        const ref = status?.reference_indices?.find((r) => r.symbol === row.symbol)
                        const label = ref?.label || row.symbol
                        return (
                          <>
                            <strong>{label}</strong>
                            <span className="data-coverage-status" style={{ marginLeft: '0.35rem', color: 'var(--color-text-muted)', fontWeight: 'normal', fontSize: '0.9em' }} title="Reference index symbol">{row.symbol}</span>
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
                    <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 min'] || { count: 0, min_ts: null, max_ts: null })}>
                      {renderBarsCell(row.stock_min['1 min'] || { count: 0, min_ts: null, max_ts: null }, min1Status.needBackfill, '1 min', coverageCell(row.stock_min['1 min'] || { count: 0, min_ts: null, max_ts: null }))}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_min['1 min'] || { count: 0, min_ts: null, max_ts: null })}</td>
                    <td className="data-coverage-bars" title={coverageCell(row.stock_min['5 mins'] || { count: 0, min_ts: null, max_ts: null })}>
                      {renderBarsCell(row.stock_min['5 mins'] || { count: 0, min_ts: null, max_ts: null }, min5Status.needBackfill, '5 mins', coverageCell(row.stock_min['5 mins'] || { count: 0, min_ts: null, max_ts: null }))}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_min['5 mins'] || { count: 0, min_ts: null, max_ts: null })}</td>
                    <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 hour'] || { count: 0, min_ts: null, max_ts: null })}>
                      {renderBarsCell(row.stock_min['1 hour'] || { count: 0, min_ts: null, max_ts: null }, min1hStatus.needBackfill, '1 hour', coverageCell(row.stock_min['1 hour'] || { count: 0, min_ts: null, max_ts: null }))}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_min['1 hour'] || { count: 0, min_ts: null, max_ts: null })}</td>
                    <td className="data-coverage-actions data-coverage-actions-nowrap">
                      {isIndex ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-reset btn-sm"
                            disabled={isDeleting}
                            onClick={() => {
                              setResetConfirmSymbol(row.symbol)
                              setResetConfirmIsIndex(true)
                              setResetPeriods(['1 D'])
                            }}
                            title="Reset daily bars for this index"
                            aria-label={`Reset ${row.symbol}`}
                          >
                            {isDeleting ? '…' : 'Reset'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={indicesRefreshLoading || (backfillSymbol === row.symbol)}
                            title="Pull daily bars for this index from TradingView (same range modal as Watchlist)"
                            aria-label={`Pull ${row.symbol}`}
                            onClick={() => {
                              setPullModalSymbol(row.symbol)
                              setPullModalIsIndex(true)
                              setPullSelectedPeriods(['1 D'])
                              setPullRangeMode('max')
                              setPullCustomDailyDays(30)
                              setPullCustom1minHours(24)
                              setPullCustom5minDays(7)
                              setPullCustom1hourDays(7)
                            }}
                          >
                            {backfillSymbol === row.symbol ? (backfillMessage || 'Pulling…') : 'Pull'}
                          </button>
                        </>
                      ) : (
                        <>
                      <button
                        type="button"
                        className="btn btn-reset btn-sm"
                        disabled={isDeleting}
                        onClick={() => {
                          setResetConfirmSymbol(row.symbol)
                          setResetConfirmIsIndex(false)
                          setResetPeriods(['1 D', '1 min', '5 mins', '1 hour'])
                        }}
                        title="Reset all bars for this symbol (stock_day + stock_min); then you can Pull from scratch"
                        aria-label={`Reset data for ${row.symbol}`}
                      >
                        {isDeleting ? '…' : 'Reset'}
                      </button>
                      {periodsNeedingBackfill.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!canBackfill}
                          title={`Queue pull for ${periodsNeedingBackfill.join(', ')}`}
                          aria-label={`Pull ${row.symbol}`}
                          onClick={() => {
                            setPullModalSymbol(row.symbol)
                            setPullModalIsIndex(false)
                            setPullSelectedPeriods(['1 D', '1 min', '5 mins', '1 hour'])
                            setPullRangeMode('max')
                            setPullCustomDailyDays(30)
                            setPullCustom1minHours(24)
                            setPullCustom5minDays(7)
                            setPullCustom1hourDays(7)
                          }}
                        >
                          {isBackfilling ? (backfillMessage || 'Queuing…') : 'Pull'}
                        </button>
                      )}
                        </>
                      )}
                    </td>
                  </tr>
                )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
            </div>
          </>
        )}
      </section>

      {watchlistRefreshPreview && (
        <div className="data-reset-modal-overlay" onClick={() => { if (!watchlistRefreshRunning) setWatchlistRefreshPreview(null) }} role="dialog" aria-modal="true" aria-labelledby="eod-dry-run-title">
          <div
            className="data-reset-modal"
            style={{ maxWidth: 'min(1100px, 92vw)', width: '92vw', maxHeight: '85vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="eod-dry-run-title">Dry run: EOD Pull</h3>
            <p>Review overwrite records, gap range, and IB request chunks before queueing worker jobs.</p>
            <div className="replay-placeholder" role="status" style={{ marginBottom: '0.75rem' }}>
              {(watchlistRefreshPreview.message || 'Dry run ready') +
                ` Symbols: ${watchlistRefreshPreview.symbols_count ?? 0}, jobs if confirmed: ${watchlistRefreshPreview.queued_jobs_if_confirmed ?? 0}, override_days: ${watchlistRefreshPreview.override_days ?? 1}, API interval: ${watchlistRefreshPreview.api_interval_sec ?? backfillApiIntervalSec}s, mode: ${backfillIsTest ? 'test' : 'live'}.`}
            </div>
            {watchlistRefreshPreview.ready_to_enqueue === false && (
              <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.75rem' }}>
                Monitor is currently stopped, so this preview cannot be confirmed into worker jobs until monitor is available again.
              </div>
            )}
            {(watchlistRefreshPreview.failures || []).length > 0 && (
              <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.75rem' }}>
                Preview failures: {(watchlistRefreshPreview.failures || []).map(f => `${f.symbol} ${f.period}: ${f.error}`).join(' | ')}
              </div>
            )}
            {(watchlistRefreshPreview.items || []).length === 0 ? (
              <div className="replay-placeholder">No preview items.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {(watchlistRefreshPreview.items || []).map((item: WatchlistEodRefreshPreviewItem, index) => (
                  <details key={`${item.symbol}-${item.period}-${index}`} style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0.75rem', background: 'var(--color-surface)' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                      {item.symbol} · {item.period} · overwrite {(item.override_records?.count ?? 0).toLocaleString()} · IB chunks {(item.ib_request_plan?.length ?? 0).toLocaleString()}
                    </summary>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))', gap: '0.5rem', marginTop: '0.75rem' }}>
                      <div><strong>Latest stored:</strong> {fmtTs(item.latest_ts)}</div>
                      <div><strong>Fetch window:</strong> {fmtTs(item.fetch_start_ts)} ~ {fmtTs(item.fetch_end_ts)}</div>
                      <div><strong>Gap to fill:</strong> {item.gap_to_fill?.has_gap ? `${fmtTs(item.gap_to_fill?.start_ts)} ~ ${fmtTs(item.gap_to_fill?.end_ts)}` : '—'}</div>
                      <div><strong>Gap span:</strong> {fmtDurationSeconds(item.gap_to_fill?.span_seconds)}</div>
                    </div>
                    <div style={{ marginTop: '0.75rem' }}>
                      <strong>Records expected to be overwritten</strong>
                      {item.override_records && item.override_records.count > 0 ? (
                        <div style={{ marginTop: '0.4rem', maxHeight: '10rem', overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '0.5rem', background: 'var(--color-bg)' }}>
                          {item.override_records.times.map((ts, tsIndex) => (
                            <div key={`${item.symbol}-${item.period}-override-${tsIndex}`}>{fmtTs(ts)}</div>
                          ))}
                        </div>
                      ) : (
                        <div className="replay-sync-hint" style={{ marginTop: '0.4rem' }}>No existing bars in the override window.</div>
                      )}
                    </div>
                    <div style={{ marginTop: '0.75rem' }}>
                      <strong>IB request plan</strong>
                      {item.ib_request_plan && item.ib_request_plan.length > 0 ? (
                        <div style={{ overflowX: 'auto', marginTop: '0.4rem' }}>
                          <table className="table-operations">
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>barSizeSetting</th>
                                <th>durationStr</th>
                                <th>endDateTime</th>
                                <th>Segment</th>
                              </tr>
                            </thead>
                            <tbody>
                              {item.ib_request_plan.map((req, reqIndex) => (
                                <tr key={`${item.symbol}-${item.period}-req-${reqIndex}`}>
                                  <td>{reqIndex + 1}</td>
                                  <td>{req.barSizeSetting}</td>
                                  <td>{req.durationStr}</td>
                                  <td>{req.endDateTime}</td>
                                  <td>{fmtTs(req.seg_start_ts)} ~ {fmtTs(req.seg_end_ts)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="replay-sync-hint" style={{ marginTop: '0.4rem' }}>No IB request would be needed for this item.</div>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
            <div className="data-reset-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={watchlistRefreshRunning}
                onClick={() => setWatchlistRefreshPreview(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={watchlistRefreshRunning || watchlistRefreshPreview.ready_to_enqueue === false || (watchlistRefreshPreview.items || []).length === 0}
                onClick={() => { void confirmWatchlistEodRefresh() }}
              >
                {watchlistRefreshRunning ? 'Queuing…' : 'Confirm and Queue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirmation modal */}
      {resetConfirmSymbol && (
        <div className="data-reset-modal-overlay" onClick={() => { setResetConfirmSymbol(null); setResetConfirmIsIndex(false) }} role="dialog" aria-modal="true" aria-labelledby="reset-modal-title">
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="reset-modal-title">{resetConfirmIsIndex ? 'Reset index data' : 'Reset data'}</h3>
            {resetConfirmIsIndex ? (
              <p>Clear daily bars for this index only (cannot be undone).</p>
            ) : (
              <>
                <p>Select periods to clear (cannot be undone):</p>
                <div className="data-reset-periods">
                  {[
                    { value: '1 D', label: 'Daily' },
                    { value: '1 min', label: '1 Min' },
                    { value: '5 mins', label: '5 Mins' },
                    { value: '1 hour', label: '1 Hour' },
                  ].map(({ value, label }) => (
                    <label key={value} className="data-reset-period-check">
                      <input
                        type="checkbox"
                        checked={resetPeriods.includes(value)}
                        onChange={e => {
                          if (e.target.checked) setResetPeriods(p => [...p, value])
                          else setResetPeriods(p => p.filter(x => x !== value))
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setResetConfirmSymbol(null); setResetConfirmIsIndex(false) }}>No</button>
              <button
                type="button"
                className="btn btn-reset"
                disabled={!resetConfirmIsIndex && resetPeriods.length === 0}
                title={!resetConfirmIsIndex && resetPeriods.length === 0 ? 'Select at least one period' : undefined}
                onClick={async () => {
                  const sym = resetConfirmSymbol
                  const periods = resetConfirmIsIndex ? ['1 D'] : [...resetPeriods]
                  setResetConfirmSymbol(null)
                  setResetConfirmIsIndex(false)
                  if (!sym || periods.length === 0) return
                  setDeleteSymbolError(null)
                  setDeletingSymbol(sym)
                  try {
                    const res = await deleteBarsForSymbol(sym, periods)
                    if (res.ok) await loadCoverage()
                    else setDeleteSymbolError(res.error || 'Delete failed')
                  } catch (e) {
                    setDeleteSymbolError(e instanceof Error ? e.message : 'Delete failed')
                  } finally {
                    setDeletingSymbol(null)
                  }
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pull time range modal */}
      {pullModalSymbol && (
        <div className="data-reset-modal-overlay" onClick={() => { setPullModalSymbol(null); setPullModalIsIndex(false) }} role="dialog" aria-modal="true" aria-labelledby="pull-range-modal-title">
          <div className="data-reset-modal data-pull-range-modal" onClick={e => e.stopPropagation()}>
            <h3 id="pull-range-modal-title">{pullModalIsIndex ? 'Pull index (TradingView)' : 'Time range for backfill'}</h3>
            <p className="data-pull-range-desc">
              {pullModalIsIndex
                ? `Choose how many days to fetch for ${pullModalSymbol}. Index data is Daily only from TradingView.`
                : `Choose how much history to fetch for ${pullModalSymbol}.`}
            </p>
            {pullModalIsIndex && (
              <p className="replay-sync-hint" style={{ marginBottom: '0.75rem' }}>Same range options as Watchlist; only Daily period is used for indices.</p>
            )}
            <div className="data-pull-range-options">
              <label className="data-pull-range-option">
                <input
                  type="radio"
                  name="pullRange"
                  checked={pullRangeMode === 'max'}
                  onChange={() => setPullRangeMode('max')}
                />
                <span><strong>Maximum</strong> — use history_backfill config (daily_years, min_weeks, etc.)</span>
              </label>
              <label className="data-pull-range-option">
                <input
                  type="radio"
                  name="pullRange"
                  checked={pullRangeMode === 'min'}
                  onChange={() => setPullRangeMode('min')}
                />
                <span><strong>Minimum</strong> — Daily 30 days; 1 min 1 hour; 5 mins 1 day; 1 hour 1 week</span>
              </label>
              <label className="data-pull-range-option">
                <input
                  type="radio"
                  name="pullRange"
                  checked={pullRangeMode === 'custom'}
                  onChange={() => setPullRangeMode('custom')}
                />
                <span><strong>Custom</strong> — set your own span</span>
              </label>
            </div>
            {pullRangeMode === 'custom' && (
              <div className="data-pull-range-custom">
                <label className="data-pull-range-custom-row">
                  <span>Daily (days):</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={pullCustomDailyDays}
                    onChange={e => setPullCustomDailyDays(Math.max(1, Number(e.target.value) || 1))}
                  />
                </label>
                {!pullModalIsIndex && (
                  <>
                <label className="data-pull-range-custom-row">
                  <span>1 min (hours):</span>
                  <input
                    type="number"
                    min={1}
                    max={24 * 365}
                    value={pullCustom1minHours}
                    onChange={e => setPullCustom1minHours(Math.max(1, Number(e.target.value) || 1))}
                  />
                </label>
                <label className="data-pull-range-custom-row">
                  <span>5 mins (days):</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={pullCustom5minDays}
                    onChange={e => setPullCustom5minDays(Math.max(1, Number(e.target.value) || 1))}
                  />
                </label>
                <label className="data-pull-range-custom-row">
                  <span>1 hour (days):</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={pullCustom1hourDays}
                    onChange={e => setPullCustom1hourDays(Math.max(1, Number(e.target.value) || 1))}
                  />
                </label>
                  </>
                )}
              </div>
            )}
            {!pullModalIsIndex && (
            <div className="data-pull-range-periods">
              <span className="data-pull-range-periods-label">Periods to pull:</span>
              <label className="data-pull-range-period-check">
                <input
                  type="checkbox"
                  checked={pullSelectedPeriods.length === 4}
                  onChange={e => setPullSelectedPeriods(e.target.checked ? ['1 D', '1 min', '5 mins', '1 hour'] : [])}
                />
                <span>All</span>
              </label>
              {(['1 D', '1 min', '5 mins', '1 hour'] as const).map(period => (
                <label key={period} className="data-pull-range-period-check">
                  <input
                    type="checkbox"
                    checked={pullSelectedPeriods.includes(period)}
                    onChange={e => {
                      if (e.target.checked) setPullSelectedPeriods(p => [...p, period])
                      else setPullSelectedPeriods(p => p.filter(x => x !== period))
                    }}
                  />
                  <span>{period === '1 D' ? 'Daily' : period === '1 min' ? '1 Min' : period === '5 mins' ? '5 mins' : '1 hour'}</span>
                </label>
              ))}
            </div>
            )}
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setPullModalSymbol(null); setPullModalIsIndex(false) }}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pullRangeMode === null || (!pullModalIsIndex && pullSelectedPeriods.length === 0)}
                onClick={async () => {
                  if (!pullModalSymbol || pullRangeMode === null) return
                  if (pullModalIsIndex) {
                    const sym = pullModalSymbol
                    const days = pullRangeMode === 'max' ? 365 : pullRangeMode === 'min' ? 30 : pullCustomDailyDays
                    setPullModalSymbol(null)
                    setPullModalIsIndex(false)
                    setBackfillSymbol(sym)
                    setBackfillMessage(null)
                    try {
                      const res = await postIndicesRefresh({ symbol: sym, days })
                      if (res.ok && res.updated.length > 0) {
                        setBackfillMessage(`Pulled ${res.updated.length} index: ${res.updated.join(', ')}.`)
                        loadCoverage()
                      } else {
                        setBackfillMessage(res.errors?.length ? res.errors.join('; ') : 'Pull failed')
                      }
                    } catch (e) {
                      setBackfillMessage(e instanceof Error ? e.message : 'Request failed')
                    } finally {
                      setTimeout(() => { setBackfillSymbol(null); setBackfillMessage(null) }, 4000)
                    }
                    return
                  }
                  if (pullSelectedPeriods.length === 0) return
                  const sym = pullModalSymbol
                  const periods = [...pullSelectedPeriods]
                  const getOptions = (period: string) => {
                    const base = { queue: true as const, is_test: backfillIsTest, api_interval_sec: backfillApiIntervalSec }
                    if (pullRangeMode === 'max') return base
                    if (pullRangeMode === 'min') {
                      if (period === '1 D') return { ...base, days: 30 }
                      if (period === '1 min') return { ...base, span_hours: 1 }
                      if (period === '5 mins') return { ...base, days: 1 }
                      if (period === '1 hour') return { ...base, days: 7 }
                      return base
                    }
                    if (pullRangeMode === 'custom') {
                      if (period === '1 D') return { ...base, days: pullCustomDailyDays }
                      if (period === '1 min') return { ...base, span_hours: pullCustom1minHours }
                      if (period === '5 mins') return { ...base, days: pullCustom5minDays }
                      if (period === '1 hour') return { ...base, days: pullCustom1hourDays }
                      return base
                    }
                    return base
                  }
                  setPullModalSymbol(null)
                  setPullModalIsIndex(false)
                  setBackfillSymbol(sym)
                  setBackfillMessage(null)
                  try {
                    const results = await Promise.all(
                      periods.map(period => postBarsBackfill(sym, period, getOptions(period))),
                    )
                    const ok = results.filter(r => r.ok).length
                    const err = results.find(r => !r.ok && r.error)
                    let msg: string
                    if (ok > 0 && err) msg = `Queued ${ok} job(s). Some failed: ${err.error}`
                    else if (ok > 0) msg = `Queued ${ok} job(s).`
                    else if (err) msg = err.error || 'Pull failed'
                    else msg = 'No jobs queued'
                    setBackfillMessage(msg)
                    if (ok > 0) loadCoverage()
                    if (ok > 0) loadBarsJobs()
                  } catch (e) {
                    setBackfillMessage(e instanceof Error ? e.message : 'Request failed')
                  } finally {
                    setTimeout(() => {
                      setBackfillSymbol(null)
                      setBackfillMessage(null)
                    }, 4000)
                  }
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="replay-section" aria-labelledby="data-bars-head">
        <h3 id="data-bars-head" className="page-title-with-tooltip">
          Preview
          <InfoTooltip text="Load bars from DB for a symbol and period. Backfill is triggered per symbol in the coverage table above (uses config default ranges)." />
        </h3>
        <div className="replay-bar-symbol-row" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
          <label htmlFor="data-bar-symbol" className="replay-bar-symbol-label">Symbol</label>
          <input
            id="data-bar-symbol"
            type="text"
            className="replay-bar-symbol-input"
            placeholder="Symbol, e.g. NVDA"
            value={barSymbol}
            onChange={e => setBarSymbol((e.target.value || '').trim().toUpperCase())}
            aria-label="Symbol for bars"
          />
          <span className="replay-bar-symbol-label">Period</span>
          <div className="replay-bar-period-radios" role="group" aria-label="Bar period">
            {BAR_PERIODS.map(p => (
              <label key={p.value} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', marginRight: '1rem' }}>
                <input
                  type="radio"
                  name="bar-period"
                  value={p.value}
                  checked={barPeriod === p.value}
                  onChange={() => setBarPeriod(p.value)}
                  aria-label={p.label}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={barsLoading || !barSymbol.trim()}
            onClick={() => loadBarsFromApi(barSymbol.trim())}
            aria-label="Load bars"
          >
            {barsLoading ? 'Loading…' : 'Load'}
          </button>
        </div>
        <p className="replay-sync-hint" style={{ marginTop: '0.5rem', fontSize: '0.9em' }}>
          Backfill runs in Celery Worker (config default ranges per period). See System → Recent operations for job status.
        </p>
        {bars.length > 0 && (
          <div className="data-bars-chart-container">
            <div className="data-bars-chart-header">
              <span className="data-bars-chart-title">
                {barSymbol || '—'} {barPeriod} · {chartBars.length} bars
              </span>
            </div>
            <BarsCandlestickChart bars={chartBars} period={barPeriod} />
          </div>
        )}
        {bars.length === 0 ? (
          <div className="replay-placeholder">No bars. Enter symbol, click Load, or run Backfill for a symbol above.</div>
        ) : (
          <table className="table-operations">
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className="table-sort-header"
                    onClick={() => setBarsTimeSort(s => s === 'desc' ? 'asc' : 'desc')}
                    aria-sort={barsTimeSort === 'desc' ? 'descending' : 'ascending'}
                    aria-label={`Sort by time ${barsTimeSort === 'desc' ? '(newest first), click for oldest first' : '(oldest first), click for newest first'}`}
                  >
                    Time {barsTimeSort === 'desc' ? '↓' : '↑'}
                  </button>
                </th>
                <th>Open</th>
                <th>High</th>
                <th>Low</th>
                <th>Close</th>
                <th>Vol</th>
              </tr>
            </thead>
            <tbody>
              {tableBars.map((b, i) => (
                <tr key={i}>
                  <td>{b.time != null ? fmtTs(b.time) : '—'}</td>
                  <td>{fmtUsd(b.open)}</td>
                  <td>{fmtUsd(b.high)}</td>
                  <td>{fmtUsd(b.low)}</td>
                  <td>{fmtUsd(b.close)}</td>
                  <td>{b.volume != null ? Number(b.volume).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="replay-section" aria-labelledby="data-jobs-head">
        <h3 id="data-jobs-head" className="page-title-with-tooltip">
          Celery jobs
          <InfoTooltip text="Recent bars backfill tasks sent to Celery. Each row = one period (1 D, 1 min, 5 mins, 1 hour). Check here to see if 1 hour or other periods were queued and their status." />
        </h3>
        <div className="replay-toolbar data-jobs-toolbar" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <div className="data-jobs-status-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className="data-jobs-status-label">Status:</span>
            {(['pending', 'running', 'done', 'failed'] as const).map(s => (
              <label key={s} className="data-jobs-status-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={barsJobsStatusSelected.has(s)}
                  onChange={() => toggleBarsJobsStatus(s)}
                  aria-label={`Filter and delete ${s} jobs`}
                />
                <span>{s === 'done' ? 'Done' : s === 'failed' ? 'Failed' : s === 'pending' ? 'Pending' : 'Running'}</span>
              </label>
            ))}
            <button
              type="button"
              className="btn btn-reset btn-sm"
              disabled={barsJobsTotal === 0 || barsJobsLoading || barsJobsStatusSelected.size === 0}
              onClick={() => setConfirmDeleteAll(true)}
              aria-label="Delete jobs with selected status(es)"
            >
              Delete all
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span>Least:</span>
            <select
              value={barsJobsLimit}
              onChange={e => setBarsJobsLimit(Number(e.target.value))}
              aria-label="Number of jobs to show"
              style={{ minWidth: '5rem' }}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={barsJobsLoading}
            onClick={() => loadBarsJobs()}
            aria-label="Refresh backfill jobs"
          >
            {barsJobsLoading ? '…' : 'Refresh'}
          </button>
          <span className="replay-sync-hint" style={{ marginLeft: 'auto' }}>
            {barsJobsTotal > 0 ? `${barsJobs.length} shown (${barsJobsTotal} total)` : '0 jobs'}
          </span>
        </div>
        {barsJobsError && (
          <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
            {barsJobsError}
          </div>
        )}
        <p className="replay-sync-hint" style={{ marginBottom: '0.5rem', fontSize: '0.9em' }}>
          Jobs are created when you click Pull above (one per period: 1 D, 1 min, 5 mins, 1 hour). Pending → Worker picks up → running → done/failed.
        </p>
        {barsJobs.length === 0 && !barsJobsLoading ? (
          <div className="replay-placeholder">No pull jobs yet. Run Pull for a symbol above.</div>
        ) : (
          <table className="table-operations">
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className="table-sort-header"
                    onClick={() => {
                      if (barsJobsSortKey === 'job_id') setBarsJobsSortDir(d => d === 'asc' ? 'desc' : 'asc')
                      else { setBarsJobsSortKey('job_id'); setBarsJobsSortDir('desc') }
                    }}
                    aria-sort={barsJobsSortKey === 'job_id' ? (barsJobsSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    Job ID {barsJobsSortKey === 'job_id' ? (barsJobsSortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th>Symbol</th>
                <th>Period</th>
                <th>
                  <button
                    type="button"
                    className="table-sort-header"
                    onClick={() => {
                      if (barsJobsSortKey === 'status') setBarsJobsSortDir(d => d === 'asc' ? 'desc' : 'asc')
                      else { setBarsJobsSortKey('status'); setBarsJobsSortDir('asc') }
                    }}
                    aria-sort={barsJobsSortKey === 'status' ? (barsJobsSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    Status {barsJobsSortKey === 'status' ? (barsJobsSortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th>Result</th>
                <th>
                  <button
                    type="button"
                    className="table-sort-header"
                    onClick={() => {
                      if (barsJobsSortKey === 'created_ts') setBarsJobsSortDir(d => d === 'asc' ? 'desc' : 'asc')
                      else { setBarsJobsSortKey('created_ts'); setBarsJobsSortDir('desc') }
                    }}
                    aria-sort={barsJobsSortKey === 'created_ts' ? (barsJobsSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    Created {barsJobsSortKey === 'created_ts' ? (barsJobsSortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="table-sort-header"
                    onClick={() => {
                      if (barsJobsSortKey === 'updated_ts') setBarsJobsSortDir(d => d === 'asc' ? 'desc' : 'asc')
                      else { setBarsJobsSortKey('updated_ts'); setBarsJobsSortDir('desc') }
                    }}
                    aria-sort={barsJobsSortKey === 'updated_ts' ? (barsJobsSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    Updated {barsJobsSortKey === 'updated_ts' ? (barsJobsSortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedBarsJobs.map((j) => (
                <tr key={j.job_id}>
                  <td><code style={{ fontSize: '0.85em' }}>{j.job_id}</code></td>
                  <td><strong>{j.symbol}</strong></td>
                  <td>{j.period}</td>
                  <td>
                    <span className={`status-badge status-${j.status}`}>
                      {j.status}
                    </span>
                  </td>
                  <td title={j.result?.error || j.result?.message}>
                    {j.status === 'done' && j.result?.count != null ? `${j.result.count} bars` : null}
                    {j.status === 'failed' && j.result?.error ? j.result.error.slice(0, 40) + (j.result.error.length > 40 ? '…' : '') : null}
                    {j.status === 'done' && j.result?.message && j.result?.count == null ? j.result.message.slice(0, 30) + '…' : null}
                    {!j.result && j.status !== 'pending' && j.status !== 'running' ? '—' : null}
                  </td>
                  <td>{j.created_ts != null ? fmtTs(j.created_ts) : '—'}</td>
                  <td>{j.updated_ts != null ? fmtTs(j.updated_ts) : '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-reset btn-sm"
                      disabled={deletingJobId !== null}
                      aria-label={`Delete job ${j.job_id}`}
                      onClick={async () => {
                        setDeletingJobId(j.job_id)
                        try {
                          const res = await deleteBarsJob(j.job_id)
                          if (res.ok) await loadBarsJobs()
                        } finally {
                          setDeletingJobId(null)
                        }
                      }}
                    >
                      {deletingJobId === j.job_id ? '…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Delete all backfill jobs confirmation */}
      {confirmDeleteAll && (
        <div className="data-reset-modal-overlay" onClick={() => setConfirmDeleteAll(false)} role="dialog" aria-modal="true" aria-labelledby="delete-all-jobs-title">
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="delete-all-jobs-title">Delete jobs by status?</h3>
            <p>
              This will remove jobs with selected status: {barsJobsStatusSelected.size === 0 ? 'none selected' : [...barsJobsStatusSelected].sort().join(', ')}. Cannot be undone.
            </p>
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-reset"
                disabled={barsJobsStatusSelected.size === 0}
                onClick={async () => {
                  setConfirmDeleteAll(false)
                  let deleted = 0
                  for (const s of barsJobsStatusSelected) {
                    const res = await deleteAllBarsJobs(s)
                    if (res.ok) deleted += res.deleted ?? 0
                  }
                  if (deleted > 0) await loadBarsJobs()
                }}
              >
                Delete all
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

