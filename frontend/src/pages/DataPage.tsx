import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar, BarCoverageItem, BarsCoverageResponse, IbAccountSnapshot, StatusResponse } from '../types'
import { fetchBars, fetchBarsCoverage, fetchBarsJobs, postBarsBackfill, deleteBarsForSymbol, deleteBarsJob, deleteAllBarsJobs } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

const BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 min', label: '1 min' },
  { value: '5 mins', label: '5 min' },
  { value: '1 hour', label: '1 hour' },
] as const

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function coverageCell(p: { count: number; min_ts: number | null; max_ts: number | null }): string {
  if (p.count === 0) return '—'
  const range = p.min_ts != null && p.max_ts != null ? `${fmtDate(p.min_ts)} ~ ${fmtDate(p.max_ts)}` : ''
  return range ? `${p.count} bars (${range})` : `${p.count} bars`
}

function coverageRange(p: { count: number; min_ts: number | null; max_ts: number | null }): string {
  if (p.count === 0 || (p.min_ts == null && p.max_ts == null)) return '—'
  if (p.min_ts != null && p.max_ts != null) return `${fmtDate(p.min_ts)} ~ ${fmtDate(p.max_ts)}`
  if (p.min_ts != null) return fmtDate(p.min_ts) + ' ~ —'
  return '— ~ ' + fmtDate(p.max_ts!)
}

/** Status label and style for need-backfill indicator. */
function coverageStatusDisplay(status: string | undefined): { label: string; needBackfill: boolean; severity: 'ok' | 'gap' | 'missing' } {
  switch (status) {
    case 'ok':
      return { label: 'OK', needBackfill: false, severity: 'ok' }
    case 'missing':
      return { label: 'Missing', needBackfill: true, severity: 'missing' }
    case 'gap_start':
      return { label: 'Gap (start)', needBackfill: true, severity: 'gap' }
    case 'gap_end':
      return { label: 'Gap (end)', needBackfill: true, severity: 'gap' }
    case 'gap':
      return { label: 'Gap', needBackfill: true, severity: 'gap' }
    default:
      return { label: '', needBackfill: false, severity: 'ok' }
  }
}

function statusColor(severity: 'ok' | 'gap' | 'missing'): string {
  if (severity === 'missing') return 'var(--danger, #c00)'
  if (severity === 'gap') return 'var(--warning, #b8860b)'
  return 'var(--success, green)'
}

interface DataPageProps {
  status: StatusResponse | null
}

/** Bar candidate symbols from positions (Wishlist can be merged later). */
function useBarCandidateSymbols(status: StatusResponse | null): string[] {
  return useMemo(() => {
    const fromAccounts = (status?.accounts || []).flatMap((acc: IbAccountSnapshot) =>
      (acc.positions || []).map(p => p.symbol).filter((s): s is string => Boolean(s?.trim())),
    )
    return [...new Set(fromAccounts)].sort()
  }, [status?.accounts])
}

/** Data page: backfill per symbol from coverage, inspect bars. */
export function DataPage({ status }: DataPageProps) {
  const [bars, setBars] = useState<Bar[]>([])
  const [barsLoading, setBarsLoading] = useState(false)
  const [barSymbol, setBarSymbol] = useState('')
  const [barPeriod, setBarPeriod] = useState<string>('1 D')
  /** Bars (inspect) table: sort by time 'asc' = oldest first, 'desc' = newest first */
  const [barsTimeSort, setBarsTimeSort] = useState<'asc' | 'desc'>('desc')
  /** Bars (inspect): show top N lines, 5–500; also used as fetch limit */
  const [barsTopN, setBarsTopN] = useState(5)

  const [coverage, setCoverage] = useState<BarCoverageItem[] | null>(null)
  const [coveragePolicy, setCoveragePolicy] = useState<BarsCoverageResponse['policy'] | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [deletingSymbol, setDeletingSymbol] = useState<string | null>(null)
  const [deleteSymbolError, setDeleteSymbolError] = useState<string | null>(null)
  /** Reset confirmation modal: symbol to reset, or null when closed */
  const [resetConfirmSymbol, setResetConfirmSymbol] = useState<string | null>(null)
  /** Periods to clear when Reset (1 D, 1 min, 5 mins, 1 hour); multi-select checkboxes */
  const [resetPeriods, setResetPeriods] = useState<string[]>(['1 D', '1 min', '5 mins', '1 hour'])
  /** Backfill options: Is test (skip IB fetch), default off; API interval between requests (sec), default 10 */
  const [backfillIsTest, setBackfillIsTest] = useState(false)
  const [backfillApiIntervalSec, setBackfillApiIntervalSec] = useState(10)
  /** Symbol for which we just enqueued backfill; show "Queued N jobs" and clear after a few seconds */
  const [backfillSymbol, setBackfillSymbol] = useState<string | null>(null)
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null)
  /** Pull range modal: when set, show modal to choose Max / Min / Custom before queuing */
  const [pullModalSymbol, setPullModalSymbol] = useState<string | null>(null)
  /** Selected periods to pull in the modal (multi-select; init from periods needing backfill when opening) */
  const [pullSelectedPeriods, setPullSelectedPeriods] = useState<string[]>(['1 D', '1 min', '5 mins', '1 hour'])
  const [pullRangeMode, setPullRangeMode] = useState<'max' | 'min' | 'custom' | null>('max')
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
  const [barsJobsStatusFilter, setBarsJobsStatusFilter] = useState<string>('all')
  const [barsJobsSortKey, setBarsJobsSortKey] = useState<'job_id' | 'status' | 'created_ts' | 'updated_ts'>('updated_ts')
  const [barsJobsSortDir, setBarsJobsSortDir] = useState<'asc' | 'desc'>('desc')
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)

  const candidateSymbols = useBarCandidateSymbols(status)

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
      const statusParam = barsJobsStatusFilter === 'all' ? undefined : barsJobsStatusFilter
      const limit = Math.max(1, Math.min(500, barsJobsLimit || 50))
      const res = await fetchBarsJobs(limit, 0, statusParam)
      setBarsJobs(Array.isArray(res.jobs) ? res.jobs : [])
      setBarsJobsTotal(typeof res.total === 'number' ? res.total : 0)
      setBarsJobsError(res.error ?? null)
    } catch (e) {
      setBarsJobs([])
      setBarsJobsTotal(0)
      setBarsJobsError(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setBarsJobsLoading(false)
    }
  }, [barsJobsLimit, barsJobsStatusFilter])

  useEffect(() => {
    loadCoverage()
  }, [loadCoverage])

  useEffect(() => {
    loadBarsJobs()
  }, [loadBarsJobs])

  const loadBarsFromApi = useCallback(async (symbol: string) => {
    if (!symbol.trim()) return
    setBarsLoading(true)
    try {
      const res = await fetchBars(symbol, barPeriod, Math.min(500, Math.max(5, barsTopN)))
      setBars(res.bars || [])
    } catch {
      setBars([])
    } finally {
      setBarsLoading(false)
    }
  }, [barPeriod, barsTopN])

  /** Click a Bars cell in Data Coverage: load that symbol+period in Bars (inspect) with top 5. */
  const openBarsForSymbol = useCallback(async (symbol: string, period: string) => {
    if (!symbol.trim()) return
    setBarSymbol(symbol.trim().toUpperCase())
    setBarPeriod(period)
    setBarsTopN(5)
    setBarsLoading(true)
    try {
      const res = await fetchBars(symbol.trim(), period, 5)
      setBars(res.bars || [])
    } catch {
      setBars([])
    } finally {
      setBarsLoading(false)
    }
  }, [])

  return (
    <div className="card process-section market-data-page">
      <section className="replay-section" aria-labelledby="data-coverage-head">
        <h3 id="data-coverage-head" className="page-title-with-tooltip">
          Data coverage (wishlist)
          <InfoTooltip text="Coverage of Wishlist stocks in stock_day / stock_min by period (count and date range). Empty when no Wishlist stocks." />
        </h3>
        <div className="replay-toolbar data-backfill-options" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
          <label className="data-toggle-switch-wrap" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <span className="toggle-switch" role="switch" aria-checked={backfillIsTest} tabIndex={0} onClick={() => setBackfillIsTest(!backfillIsTest)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setBackfillIsTest(!backfillIsTest) } }}>
              <span className="toggle-switch-track" />
              <span className={backfillIsTest ? 'toggle-switch-thumb on' : 'toggle-switch-thumb'} />
            </span>
            <span>Is test</span>
            <InfoTooltip text="When on, pull will not call IB (test mode: only log planned requests). Default off." />
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
        </div>
        {coveragePolicy && (
          <p className="replay-sync-hint" style={{ marginBottom: '0.5rem' }}>
            Target range: Daily {coveragePolicy.daily_years}y, 1 min {coveragePolicy.min_weeks}w, 5min {coveragePolicy['5min_months']}mo, 1h {coveragePolicy['1hour_months']}mo (from config). Need backfill if status is not OK.
          </p>
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
          <div className="replay-placeholder">No stocks in Wishlist or not loaded yet. Add stocks on the Wishlist tab and refresh.</div>
        )}
        {coverage && coverage.length > 0 && (
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
              {coverage.map((row) => {
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
                const canBackfill = periodsNeedingBackfill.length > 0 && !isBackfilling && !isDeleting
                const renderBarsCell = (p: { count: number; min_ts: number | null; max_ts: number | null }, label: string, severity: 'ok' | 'gap' | 'missing', period: string) => (
                  <button
                    type="button"
                    className="data-coverage-bars-btn"
                    onClick={() => openBarsForSymbol(row.symbol, period)}
                    title={`Show top 5 bars for ${row.symbol} (${period}) in Bars section`}
                    aria-label={`Show bars ${row.symbol} ${period}`}
                  >
                    {p.count === 0 ? '—' : `${p.count} bars`}
                    {label !== '' && label !== 'OK' && (
                      <span className="data-coverage-status" style={{ color: statusColor(severity) }}>[{label}]</span>
                    )}
                  </button>
                )
                return (
                  <tr key={row.symbol}>
                    <td><strong>{row.symbol}</strong></td>
                    <td className="data-coverage-bars" title={coverageCell(row.stock_day)}>
                      {renderBarsCell(row.stock_day, dayStatus.label, dayStatus.severity, '1 D')}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_day)}</td>
                    <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 min'])}>
                      {renderBarsCell(row.stock_min['1 min'] || { count: 0, min_ts: null, max_ts: null }, min1Status.label, min1Status.severity, '1 min')}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_min['1 min'] || { count: 0, min_ts: null, max_ts: null })}</td>
                    <td className="data-coverage-bars" title={coverageCell(row.stock_min['5 mins'])}>
                      {renderBarsCell(row.stock_min['5 mins'] || { count: 0, min_ts: null, max_ts: null }, min5Status.label, min5Status.severity, '5 mins')}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_min['5 mins'] || { count: 0, min_ts: null, max_ts: null })}</td>
                    <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 hour'])}>
                      {renderBarsCell(row.stock_min['1 hour'] || { count: 0, min_ts: null, max_ts: null }, min1hStatus.label, min1hStatus.severity, '1 hour')}
                    </td>
                    <td className="data-coverage-range">{coverageRange(row.stock_min['1 hour'] || { count: 0, min_ts: null, max_ts: null })}</td>
                    <td className="data-coverage-actions data-coverage-actions-nowrap">
                      <button
                        type="button"
                        className="btn btn-reset btn-sm"
                        disabled={isDeleting}
                        onClick={() => {
                          setResetConfirmSymbol(row.symbol)
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
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Reset confirmation modal */}
      {resetConfirmSymbol && (
        <div className="data-reset-modal-overlay" onClick={() => setResetConfirmSymbol(null)} role="dialog" aria-modal="true" aria-labelledby="reset-modal-title">
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="reset-modal-title">Reset data</h3>
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
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setResetConfirmSymbol(null)}>No</button>
              <button
                type="button"
                className="btn btn-reset"
                disabled={resetPeriods.length === 0}
                title={resetPeriods.length === 0 ? 'Select at least one period' : undefined}
                onClick={async () => {
                  const sym = resetConfirmSymbol
                  const periods = [...resetPeriods]
                  setResetConfirmSymbol(null)
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
        <div className="data-reset-modal-overlay" onClick={() => setPullModalSymbol(null)} role="dialog" aria-modal="true" aria-labelledby="pull-range-modal-title">
          <div className="data-reset-modal data-pull-range-modal" onClick={e => e.stopPropagation()}>
            <h3 id="pull-range-modal-title">Time range for backfill</h3>
            <p className="data-pull-range-desc">Choose how much history to fetch for {pullModalSymbol}.</p>
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
              </div>
            )}
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
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPullModalSymbol(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pullRangeMode === null || pullSelectedPeriods.length === 0}
                onClick={async () => {
                  if (!pullModalSymbol || pullSelectedPeriods.length === 0 || pullRangeMode === null) return
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
          Bars (inspect)
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
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <span>Top</span>
            <input
              type="number"
              min={5}
              max={500}
              value={barsTopN}
              onChange={e => setBarsTopN(Math.min(500, Math.max(5, parseInt(e.target.value, 10) || 5)))}
              style={{ width: '4rem' }}
              aria-label="Number of bar rows to show (5–500)"
            />
          </label>
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
              {sortedBars.slice(0, barsTopN).map((b, i) => (
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
          Market data (jobs)
          <InfoTooltip text="Recent bars backfill tasks sent to Celery. Each row = one period (1 D, 1 min, 5 mins, 1 hour). Check here to see if 1 hour or other periods were queued and their status." />
        </h3>
        <div className="replay-toolbar" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span>Status:</span>
            <select
              value={barsJobsStatusFilter}
              onChange={e => setBarsJobsStatusFilter(e.target.value)}
              aria-label="Filter by status"
              style={{ minWidth: '6rem' }}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
            </select>
          </label>
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
          <button
            type="button"
            className="btn btn-reset btn-sm"
            disabled={barsJobsTotal === 0 || barsJobsLoading}
            onClick={() => setConfirmDeleteAll(true)}
            aria-label="Delete all backfill jobs"
          >
            Delete all
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
            <h3 id="delete-all-jobs-title">Delete all backfill jobs?</h3>
            <p>This will remove all jobs from the list{barsJobsStatusFilter !== 'all' ? ` with status &quot;${barsJobsStatusFilter}&quot;` : ''}. Cannot be undone.</p>
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-reset"
                onClick={async () => {
                  setConfirmDeleteAll(false)
                  const statusParam = barsJobsStatusFilter === 'all' ? undefined : barsJobsStatusFilter
                  const res = await deleteAllBarsJobs(statusParam)
                  if (res.ok) await loadBarsJobs()
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

