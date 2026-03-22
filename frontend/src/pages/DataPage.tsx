import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar, BarCoverageItem, BarsCoverageResponse, StatusResponse } from '../types'
import { fetchBars, fetchBarsCoverage, fetchBarsJobs, postBarsBackfill, postWatchlistEodRefresh, fetchWatchlistEodRefreshPreview, postIndicesRefresh, deleteBarsForSymbol, deleteBarsJob, deleteAllBarsJobs } from '../api'
import type { WatchlistEodRefreshPreviewItem, WatchlistEodRefreshPreviewResponse } from '../api'
import { fetchMarketTradingDay } from '../api'
import { fmtDurationSeconds, fmtTs } from '../utils/format'
import { ALL_BAR_PERIOD_VALUES, BAR_PERIODS } from './data/constants'
import { inspectBarsLimitForPeriod } from './data/dataCoverageUtils'
import { useBarCandidateSymbols } from './data/useBarCandidateSymbols'
import { DataCoveragePanel, DataBarsPreviewPanel, DataJobsPanel } from './data/panels'

interface DataPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  /** When set, first breadcrumb uses this label and click handler (e.g. Feed). Falls back to `onGoToScreener`. */
  onBreadcrumbParent?: () => void
  breadcrumbParentLabel?: string
  breadcrumbLabel?: string
  /** Wider layout tweaks when rendered under Settings main (narrower column vs full app tab). */
  embeddedInSettings?: boolean
}

/** Data page: backfill per symbol from coverage, inspect bars. */
export function DataPage({
  status,
  onGoToScreener,
  onBreadcrumbParent,
  breadcrumbParentLabel = 'Research',
  breadcrumbLabel = 'IB Stock',
  embeddedInSettings = false,
}: DataPageProps) {
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
  const [resetPeriods, setResetPeriods] = useState<string[]>(() => [...ALL_BAR_PERIOD_VALUES])
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
  const [pullSelectedPeriods, setPullSelectedPeriods] = useState<string[]>(() => [...ALL_BAR_PERIOD_VALUES])
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

  const handleOpenReset = useCallback((symbol: string, isIndex: boolean) => {
    setResetConfirmSymbol(symbol)
    setResetConfirmIsIndex(isIndex)
    setResetPeriods(isIndex ? ['1 D'] : [...ALL_BAR_PERIOD_VALUES])
  }, [])

  const handleOpenPull = useCallback((symbol: string, isIndex: boolean) => {
    setPullModalSymbol(symbol)
    setPullModalIsIndex(isIndex)
    setPullSelectedPeriods(isIndex ? ['1 D'] : [...ALL_BAR_PERIOD_VALUES])
    setPullRangeMode('max')
    setPullCustomDailyDays(30)
    setPullCustom1minHours(24)
    setPullCustom5minDays(7)
    setPullCustom1hourDays(7)
  }, [])

  const handleBarsJobsSort = useCallback((key: 'job_id' | 'status' | 'created_ts' | 'updated_ts') => {
    if (barsJobsSortKey === key) {
      setBarsJobsSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setBarsJobsSortKey(key)
      setBarsJobsSortDir(key === 'status' ? 'asc' : 'desc')
    }
  }, [barsJobsSortKey])

  const handleDeleteBarsJob = useCallback(
    async (jobId: string) => {
      setDeletingJobId(jobId)
      try {
        const res = await deleteBarsJob(jobId)
        if (res.ok) await loadBarsJobs()
      } finally {
        setDeletingJobId(null)
      }
    },
    [loadBarsJobs],
  )

  return (
    <div
      className={`card process-section market-data-page${embeddedInSettings ? ' market-data-page--settings-embed' : ''}`}
    >
      {(onGoToScreener || onBreadcrumbParent) && (
        <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={onBreadcrumbParent ?? onGoToScreener}
            aria-label={`Go to ${breadcrumbParentLabel}`}
          >
            {breadcrumbParentLabel}
          </button>
          {' / '}
          {breadcrumbLabel}
        </h2>
      )}
      <DataCoveragePanel
        coverage={coverage}
        coveragePolicy={coveragePolicy}
        coverageLoading={coverageLoading}
        coverageError={coverageError}
        deleteSymbolError={deleteSymbolError}
        deletingSymbol={deletingSymbol}
        backfillSymbol={backfillSymbol}
        backfillMessage={backfillMessage}
        isTradingDay={isTradingDay}
        status={status}
        coverageGroups={coverageGroups}
        indicesRefreshLoading={indicesRefreshLoading}
        indicesRefreshMessage={indicesRefreshMessage}
        watchlistRefreshMessage={watchlistRefreshMessage}
        watchlistPreviewLoading={watchlistPreviewLoading}
        watchlistRefreshRunning={watchlistRefreshRunning}
        backfillIsTest={backfillIsTest}
        needWatchlistDryRun={needWatchlistDryRun}
        backfillApiIntervalSec={backfillApiIntervalSec}
        onLoadCoverage={loadCoverage}
        onRefreshIndices={handleRefreshIndices}
        onWatchlistEodRefresh={handleWatchlistEodRefreshClick}
        onOpenReset={handleOpenReset}
        onOpenPull={handleOpenPull}
        onOpenBarsForSymbol={openBarsForSymbol}
        onBackfillIsTestChange={setBackfillIsTest}
        onNeedWatchlistDryRunChange={setNeedWatchlistDryRun}
        onBackfillApiIntervalSecChange={setBackfillApiIntervalSec}
      />

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
                  {BAR_PERIODS.map(({ value, label }) => (
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
                  onChange={e => setPullSelectedPeriods(e.target.checked ? [...ALL_BAR_PERIOD_VALUES] : [])}
                />
                <span>All</span>
              </label>
              {ALL_BAR_PERIOD_VALUES.map(period => (
                <label key={period} className="data-pull-range-period-check">
                  <input
                    type="checkbox"
                    checked={pullSelectedPeriods.includes(period)}
                    onChange={e => {
                      if (e.target.checked) setPullSelectedPeriods(p => [...p, period])
                      else setPullSelectedPeriods(p => p.filter(x => x !== period))
                    }}
                  />
                  <span>{BAR_PERIODS.find(p => p.value === period)?.label ?? period}</span>
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

      <DataBarsPreviewPanel
        barSymbol={barSymbol}
        barPeriod={barPeriod}
        bars={bars}
        barsLoading={barsLoading}
        barsTimeSort={barsTimeSort}
        chartBars={chartBars}
        tableBars={tableBars}
        onSymbolChange={setBarSymbol}
        onPeriodChange={setBarPeriod}
        onLoadBars={() => loadBarsFromApi(barSymbol.trim())}
        onBarsTimeSortToggle={() => setBarsTimeSort((s) => (s === 'desc' ? 'asc' : 'desc'))}
      />

      <DataJobsPanel
        sortedBarsJobs={sortedBarsJobs}
        barsJobsLoading={barsJobsLoading}
        barsJobsError={barsJobsError}
        barsJobsTotal={barsJobsTotal}
        barsJobsLimit={barsJobsLimit}
        barsJobsStatusSelected={barsJobsStatusSelected}
        barsJobsSortKey={barsJobsSortKey}
        barsJobsSortDir={barsJobsSortDir}
        deletingJobId={deletingJobId}
        onToggleStatus={toggleBarsJobsStatus}
        onDeleteAllClick={() => setConfirmDeleteAll(true)}
        onLimitChange={setBarsJobsLimit}
        onRefreshJobs={loadBarsJobs}
        onSort={handleBarsJobsSort}
        onDeleteJob={handleDeleteBarsJob}
      />

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

