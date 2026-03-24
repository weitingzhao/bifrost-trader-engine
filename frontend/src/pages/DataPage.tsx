import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar, StatusResponse } from '../types'
import { fetchBars, fetchBarsJobs, deleteBarsJob, deleteAllBarsJobs } from '../api'
import { inspectBarsLimitForPeriod } from './data/dataCoverageUtils'
import { useBarCandidateSymbols } from './data/useBarCandidateSymbols'
import { DataBarsPreviewPanel, DataJobsPanel } from './data/panels'

interface DataPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  onBreadcrumbParent?: () => void
  breadcrumbParentLabel?: string
  breadcrumbLabel?: string
  embeddedInSettings?: boolean
}

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
  const [barsTimeSort, setBarsTimeSort] = useState<'asc' | 'desc'>('desc')

  const [barsJobs, setBarsJobs] = useState<Array<{ job_id: string; symbol: string; period: string; status: string; result?: { count?: number; message?: string; error?: string }; created_ts?: number; updated_ts?: number }>>([])
  const [barsJobsLoading, setBarsJobsLoading] = useState(false)
  const [barsJobsError, setBarsJobsError] = useState<string | null>(null)
  const [barsJobsTotal, setBarsJobsTotal] = useState(0)
  const [barsJobsLimit, setBarsJobsLimit] = useState(5)
  const [barsJobsStatusSelected, setBarsJobsStatusSelected] = useState<Set<string>>(new Set(['done']))
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
      if (key === 'job_id') { va = parseInt(a.job_id, 10) || 0; vb = parseInt(b.job_id, 10) || 0; return dir * ((va as number) - (vb as number)) }
      if (key === 'status') { va = (a.status || '').toLowerCase(); vb = (b.status || '').toLowerCase(); return dir * (va < vb ? -1 : va > vb ? 1 : 0) }
      if (key === 'created_ts') { va = a.created_ts ?? 0; vb = b.created_ts ?? 0; return dir * ((va as number) - (vb as number)) }
      va = a.updated_ts ?? 0; vb = b.updated_ts ?? 0; return dir * ((va as number) - (vb as number))
    })
  }, [barsJobs, barsJobsSortKey, barsJobsSortDir])

  const chartBars = useMemo(() => {
    if (bars.length === 0) return []
    return [...bars].filter(b => b.time != null).sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  }, [bars])

  const tableBars = useMemo(() => {
    if (sortedBars.length === 0) return []
    return sortedBars.slice(0, 5)
  }, [sortedBars])

  useEffect(() => {
    if (candidateSymbols.length > 0 && !barSymbol.trim()) setBarSymbol(candidateSymbols[0])
  }, [candidateSymbols.join(','), barSymbol])

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
      if (selected.size > 1) { jobs = jobs.filter(j => selected.has(j.status)); total = jobs.length }
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
      if (next.has(status)) next.delete(status); else next.add(status)
      return next
    })
  }, [])

  useEffect(() => { loadBarsJobs() }, [loadBarsJobs])

  const loadBarsFromApi = useCallback(async (symbol: string) => {
    if (!symbol.trim()) return
    setBarsLoading(true)
    try {
      const res = await fetchBars(symbol, barPeriod, inspectBarsLimitForPeriod(barPeriod))
      setBars(res.bars || [])
    } catch { setBars([]) } finally { setBarsLoading(false) }
  }, [barPeriod])

  const handleBarsJobsSort = useCallback((key: 'job_id' | 'status' | 'created_ts' | 'updated_ts') => {
    if (barsJobsSortKey === key) setBarsJobsSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setBarsJobsSortKey(key); setBarsJobsSortDir(key === 'status' ? 'asc' : 'desc') }
  }, [barsJobsSortKey])

  const handleDeleteBarsJob = useCallback(async (jobId: string) => {
    setDeletingJobId(jobId)
    try { const res = await deleteBarsJob(jobId); if (res.ok) await loadBarsJobs() }
    finally { setDeletingJobId(null) }
  }, [loadBarsJobs])

  return (
    <div className={`card process-section market-data-page${embeddedInSettings ? ' market-data-page--settings-embed' : ''}`}>
      {(onGoToScreener || onBreadcrumbParent) && (
        <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          <button type="button" className="page-title-breadcrumb-link" onClick={onBreadcrumbParent ?? onGoToScreener} aria-label={`Go to ${breadcrumbParentLabel}`}>
            {breadcrumbParentLabel}
          </button>
          {' / '}
          {breadcrumbLabel}
        </h2>
      )}

      <h4 className="feed-massive-section-header" id="feed-ib-section-inspect">Inspect</h4>

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

      <h4 className="feed-massive-section-header" id="feed-ib-section-backfill">Backfill</h4>

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

      {confirmDeleteAll && (
        <div className="data-reset-modal-overlay" onClick={() => setConfirmDeleteAll(false)} role="dialog" aria-modal="true" aria-labelledby="delete-all-jobs-title">
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="delete-all-jobs-title">Delete jobs by status?</h3>
            <p>This will remove jobs with selected status: {barsJobsStatusSelected.size === 0 ? 'none selected' : [...barsJobsStatusSelected].sort().join(', ')}. Cannot be undone.</p>
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
              <button type="button" className="btn btn-reset" disabled={barsJobsStatusSelected.size === 0} onClick={async () => {
                setConfirmDeleteAll(false)
                let deleted = 0
                for (const s of barsJobsStatusSelected) { const res = await deleteAllBarsJobs(s); if (res.ok) deleted += res.deleted ?? 0 }
                if (deleted > 0) await loadBarsJobs()
              }}>Delete all</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
