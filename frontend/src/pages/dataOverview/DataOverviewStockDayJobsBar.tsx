import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchStockDayQualityDetail,
  postMassiveSync,
  postStockDayGapBatch,
  subscribeMassiveJobEvents,
  type MassiveJobApiRow,
  type StockDayGapResult,
  type StockDayMissingYearRow,
  type WatchlistDbCoverageSymbolRow,
} from '../../api'
import { formatRefJobIdShort, summarizeRefJobResult } from '../massive/stockReferenceJobHelpers'

const MAX_TRACKED = 128
const MAX_CONCURRENT_JOB_SSE = 8
const STOCK_DAY_COLUMN_HEALTH_PCT = 97

// ── Types ─────────────────────────────────────────────────────────────────────

type StockJobTrackItem = {
  trackKey: string
  jobId?: string
  kindLabel: string
  deduplicated?: boolean
  status: string
  job?: MassiveJobApiRow
  streamError?: string
  enqueuedAt: number
  activitySummary?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trimJobs(items: StockJobTrackItem[]): StockJobTrackItem[] {
  if (items.length <= MAX_TRACKED) return items
  const sorted = [...items].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  while (sorted.length > MAX_TRACKED) sorted.shift()
  return sorted
}

function statusTone(status: string, streamErr?: string): 'ok' | 'err' | 'run' {
  if (streamErr) return 'err'
  const s = (status || '').toLowerCase()
  if (s === 'failed') return 'err'
  if (s === 'done') return 'ok'
  return 'run'
}

function formatEnqueueTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
  } catch {
    return '—'
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, ms) })
}

const ico = 'data-overview-ctl__ico'

function IcoSelectAll({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  )
}

function IcoClearPool({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

function IcoRefCheck({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function IcoFillGap({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17V3" />
      <path d="m6 11 6 6 6-6" />
      <path d="M19 21H5" />
    </svg>
  )
}

// ── All-Gaps Sheet ─────────────────────────────────────────────────────────────

interface AllGapsSheetProps {
  open: boolean
  onClose: () => void
  gapBySymbol: Record<string, StockDayGapResult>
  poolSymbols: string[]
  onOpenQualitySheet?: (symbol: string) => void
}

function AllGapsSheet({ open, onClose, gapBySymbol, poolSymbols, onOpenQualitySheet }: AllGapsSheetProps) {
  const asideRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  const checkedSymbols = poolSymbols.filter(s => gapBySymbol[s]?.ok && gapBySymbol[s]?.compared_at)
  const withGap = poolSymbols.filter(s => (gapBySymbol[s]?.gap ?? 0) > 0)
  const notChecked = poolSymbols.filter(s => !gapBySymbol[s])

  function MissingYearTable({ rows }: { rows: StockDayMissingYearRow[] }) {
    if (rows.length === 0) return null
    return (
      <table className="data-table" style={{ fontSize: 'var(--text-caption)', marginTop: 'var(--space-1)' }}>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">Missing days</th>
            <th scope="col">First</th>
            <th scope="col">Last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.year}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.year}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.count.toLocaleString()}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.first_missing ?? '—'}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.last_missing ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet data-overview-gap-explain-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-day-all-gaps-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="stock-day-all-gaps-title" className="ref-jobs-sheet-title">
            stock_day — All gaps by symbol
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="ref-jobs-sheet-body">
          {checkedSymbols.length > 0 ? (
            <div className="feed-massive-table-wrap" style={{ marginBottom: 'var(--space-4)' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col">Gap (days)</th>
                    <th scope="col">Cov%</th>
                    <th scope="col">Covered</th>
                    <th scope="col">Ref</th>
                    <th scope="col">Checked at</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {checkedSymbols.map(sym => {
                    const g = gapBySymbol[sym]!
                    const hasGap = (g.gap ?? 0) > 0
                    return (
                      <tr key={sym}>
                        <td><strong>{sym}</strong></td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          <span className={hasGap ? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--bad' : ''}>
                            {g.gap != null ? (hasGap ? `+${g.gap.toLocaleString()}` : g.gap.toLocaleString()) : '—'}
                          </span>
                          {g.today_pending && (
                            <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginLeft: 4 }} title="Today excluded — market open. Re-check after 4:20 PM ET.">
                              (today⌛)
                            </span>
                          )}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {g.coverage_pct != null ? (
                            <span className={
                              g.coverage_pct >= 97
                                ? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--ok'
                                : g.coverage_pct >= 85
                                  ? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--warn'
                                  : 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--bad'
                            }>
                              {g.coverage_pct}%
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{g.covered_total?.toLocaleString() ?? '—'}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{g.ref_total?.toLocaleString() ?? '—'}</td>
                        <td style={{ fontSize: 'var(--text-caption)', fontVariantNumeric: 'tabular-nums' }}>{g.compared_at?.slice(0, 16) ?? '—'}</td>
                        <td>
                          {onOpenQualitySheet && (
                            <button
                              type="button"
                              className="data-overview-wl-matrix__sym-detail-btn"
                              onClick={() => onOpenQualitySheet(sym)}
                              title={`Open daily bar quality for ${sym}`}
                              aria-label={`Bar quality detail for ${sym}`}
                            >↗</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="data-overview-gap-sheet__muted">No symbols checked yet. Run Check first.</p>
          )}

          {withGap.length > 0 && (
            <>
              <h4 style={{ fontSize: 'var(--text-body)', marginBottom: 'var(--space-2)' }}>Missing days by year</h4>
              {withGap.map(sym => {
                const g = gapBySymbol[sym]!
                return (
                  <details key={sym} style={{ marginBottom: 'var(--space-3)' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 'var(--text-body)', marginBottom: 'var(--space-1)' }}>
                      <strong>{sym}</strong>
                      {' — '}<span style={{ color: 'var(--color-danger)' }}>{g.gap?.toLocaleString()} missing days</span>
                    </summary>
                    <MissingYearTable rows={g.missing_by_year ?? []} />
                  </details>
                )
              })}
            </>
          )}

          {notChecked.length > 0 && (
            <p className="data-overview-gap-sheet__muted" style={{ marginTop: 'var(--space-2)' }}>
              {notChecked.length} symbol(s) not yet checked: {notChecked.join(', ')}
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}

// ── Jobs Sheet ─────────────────────────────────────────────────────────────────

interface JobsSheetProps {
  open: boolean
  onClose: () => void
  items: StockJobTrackItem[]
  onClearCompleted: () => void
  onClearAll: () => void
  onRefreshCoverage?: () => void | Promise<void>
  maxTracked: number
  sessionEnqueueTotal: number
}

function StockDayJobsSheet({ open, onClose, items, onClearCompleted, onClearAll, onRefreshCoverage, maxTracked, sessionEnqueueTotal }: JobsSheetProps) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => { if (open) return; setRefreshBusy(false) }, [open])

  const handleRefresh = useCallback(async () => {
    if (!onRefreshCoverage || refreshBusy) return
    setRefreshBusy(true)
    try { await Promise.resolve(onRefreshCoverage()) } finally { setRefreshBusy(false) }
  }, [onRefreshCoverage, refreshBusy])

  if (!open) return null

  const sorted = [...items].sort((a, b) => b.enqueuedAt - a.enqueuedAt)
  const hasCompleted = items.some(x => {
    const s = (x.status || '').toLowerCase()
    return s === 'done' || s === 'failed' || x.streamError
  })
  const activeN = items.filter(x => {
    const s = (x.status || '').toLowerCase()
    return s !== 'done' && s !== 'failed' && !x.streamError
  }).length

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet ref-jobs-sheet--wide data-overview-option-jobs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-day-jobs-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="stock-day-jobs-title" className="ref-jobs-sheet-title">stock_day coverage jobs</h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <p className="ref-jobs-sheet-meta">
          Session-only tracking for stock_day jobs enqueued from Data Overview. Jobs update via stream; use Refresh coverage to reload the watchlist matrix after jobs finish. Only the last {maxTracked} tracked rows are shown.
        </p>
        {sessionEnqueueTotal > 0 && (
          <p className="ref-jobs-sheet-meta ref-jobs-sheet-meta--sub" role="status">
            Session enqueues (successful): <strong>{sessionEnqueueTotal}</strong>
          </p>
        )}
        <div className="ref-jobs-sheet-toolbar">
          {onRefreshCoverage && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleRefresh()} disabled={refreshBusy}>
              {refreshBusy ? 'Refreshing…' : 'Refresh coverage'}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearCompleted} disabled={!hasCompleted}>Clear completed</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearAll} disabled={items.length === 0}>Clear all</button>
        </div>
        <div className="ref-jobs-sheet-table-wrap">
          {sorted.length === 0 ? (
            <p className="ref-jobs-sheet-empty">Enqueue a job to see status here.</p>
          ) : (
            <table className="ref-jobs-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Dedup</th>
                  <th scope="col">Job ID</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(item => {
                  const tone = statusTone(item.status, item.streamError)
                  const statusLabel = item.streamError ? 'failed' : item.status
                  const jid = item.jobId ?? ''
                  return (
                    <tr key={item.trackKey} className="ref-jobs-table-row">
                      <td className="ref-jobs-table-time">{formatEnqueueTime(item.enqueuedAt)}</td>
                      <td className="ref-jobs-table-kind">{item.kindLabel}</td>
                      <td>
                        <span className={`ref-jobs-sheet-status ref-jobs-sheet-status--${tone}`}>{statusLabel}</span>
                        {item.streamError && <p className="ref-jobs-table-stream-err" role="alert">{item.streamError}</p>}
                      </td>
                      <td className="ref-jobs-table-dedup">{item.deduplicated ? 'Yes' : '—'}</td>
                      <td className="ref-jobs-table-id-cell">
                        <code className="ref-jobs-table-job-id" title={jid || undefined}>{jid ? formatRefJobIdShort(jid) : '—'}</code>
                        <button type="button" className="btn btn-secondary btn-sm ref-jobs-table-copy" disabled={!jid}
                          onClick={() => { if (!jid) return; void navigator.clipboard?.writeText(jid).catch(() => {}) }}>
                          Copy
                        </button>
                      </td>
                      <td className="ref-jobs-table-summary">{item.activitySummary ?? summarizeRefJobResult(item.job)}</td>
                      <td className="ref-jobs-table-details-cell">
                        {item.job?.result != null ? (
                          <details className="feed-massive-details-debug ref-jobs-sheet-details">
                            <summary>JSON</summary>
                            <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '10rem' }}>
                              {typeof item.job.result === 'string' ? item.job.result : JSON.stringify(item.job.result, null, 2)}
                            </pre>
                          </details>
                        ) : <span className="ref-jobs-table-dash">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="ref-jobs-sheet-footer">
          <p className="ref-jobs-sheet-footer-hint">
            {activeN > 0 ? `${activeN} active` : 'No active jobs'}
            {' · '}
            <button type="button" className="ref-jobs-sheet-link" onClick={() => { window.location.hash = '#settings-celery' }}>
              Open Celery job details
            </button>
          </p>
        </div>
      </aside>
    </div>
  )
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface DataOverviewStockDayJobsBarProps {
  wlRows: WatchlistDbCoverageSymbolRow[]
  comparePool: string[]
  onToggleComparePool?: (symbol: string) => void
  onSelectAllComparePool: () => void
  onClearComparePool: () => void
  onWatchlistRefreshRequested?: () => void | Promise<void>
  onOpenQualitySheet?: (symbol: string) => void
  onGapResultsUpdate?: (results: Record<string, StockDayGapResult>) => void
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function DataOverviewStockDayJobsBar({
  wlRows,
  comparePool,
  onToggleComparePool: _onToggleComparePool,
  onSelectAllComparePool,
  onClearComparePool,
  onWatchlistRefreshRequested,
  onOpenQualitySheet,
  onGapResultsUpdate,
}: DataOverviewStockDayJobsBarProps) {
  // ── Job tracking ──────────────────────────────────────────────────────────
  const [items, setItems] = useState<StockJobTrackItem[]>([])
  const [sessionEnqueueTotal, setSessionEnqueueTotal] = useState(0)
  const [jobsSheetOpen, setJobsSheetOpen] = useState(false)
  const [enqueueErr, setEnqueueErr] = useState<string | null>(null)

  // ── Gap check ─────────────────────────────────────────────────────────────
  const [gapBySymbol, setGapBySymbol] = useState<Record<string, StockDayGapResult>>({})
  const [gapLoading, setGapLoading] = useState(false)
  const [gapError, setGapError] = useState<string | null>(null)

  // ── Fill batch state ───────────────────────────────────────────────────────
  const [fillBatch, setFillBatch] = useState<'row' | 'column' | null>(null)

  // ── Sheet state ───────────────────────────────────────────────────────────
  const [allGapsOpen, setAllGapsOpen] = useState(false)

  // ── SSE ───────────────────────────────────────────────────────────────────
  const sseClosersRef = useRef<Map<string, () => void>>(new Map())
  const jobSseQueueRef = useRef<string[]>([])
  const queuedJobStreamsRef = useRef<Set<string>>(new Set())
  const activeJobSseRef = useRef(0)
  const pendingJobUiRef = useRef<Map<string, { status?: string; job?: MassiveJobApiRow; streamError?: string }>>( new Map())
  const flushJobUiRafRef = useRef<number | null>(null)
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    sseClosersRef.current.forEach(c => c())
    sseClosersRef.current.clear()
    jobSseQueueRef.current = []
    queuedJobStreamsRef.current.clear()
    activeJobSseRef.current = 0
    pendingJobUiRef.current.clear()
    if (flushJobUiRafRef.current != null) { cancelAnimationFrame(flushJobUiRafRef.current); flushJobUiRafRef.current = null }
    if (refreshDebounceRef.current) { clearTimeout(refreshDebounceRef.current); refreshDebounceRef.current = null }
  }, [])

  const scheduleWatchlistRefresh = useCallback(() => {
    if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current)
    refreshDebounceRef.current = window.setTimeout(() => {
      onWatchlistRefreshRequested?.()
      refreshDebounceRef.current = null
    }, 1200)
  }, [onWatchlistRefreshRequested])

  const scheduleJobUiFlush = useCallback(() => {
    if (flushJobUiRafRef.current != null) return
    flushJobUiRafRef.current = requestAnimationFrame(() => {
      flushJobUiRafRef.current = null
      const batch = pendingJobUiRef.current
      if (batch.size === 0) return
      pendingJobUiRef.current = new Map()
      setItems(prev => prev.map(row => {
        const id = row.jobId
        if (!id) return row
        const p = batch.get(id)
        if (!p) return row
        return {
          ...row,
          ...(p.streamError !== undefined ? { streamError: p.streamError } : {}),
          ...(p.status !== undefined ? { status: p.status } : {}),
          ...(p.job !== undefined ? { job: p.job } : {}),
        }
      }))
    })
  }, [])

  const openJobStreamNow = useCallback((jid: string) => {
    activeJobSseRef.current += 1
    const sub = subscribeMassiveJobEvents(jid, data => {
      if (!data.ok) {
        if (!sseClosersRef.current.has(jid)) return
        const cur = pendingJobUiRef.current.get(jid) ?? {}
        pendingJobUiRef.current.set(jid, { ...cur, streamError: data.error ?? 'Job stream error', status: 'failed' })
        scheduleJobUiFlush()
        sseClosersRef.current.delete(jid)
        activeJobSseRef.current = Math.max(0, activeJobSseRef.current - 1)
        while (activeJobSseRef.current < MAX_CONCURRENT_JOB_SSE && jobSseQueueRef.current.length > 0) {
          const next = jobSseQueueRef.current.shift()
          if (!next) break
          queuedJobStreamsRef.current.delete(next)
          openJobStreamNow(next)
        }
        return
      }
      const j = data.job
      const st = (j?.status ?? '').trim() || 'running'
      const stLower = st.toLowerCase()
      const cur = pendingJobUiRef.current.get(jid) ?? {}
      pendingJobUiRef.current.set(jid, { ...cur, status: st, job: j })
      scheduleJobUiFlush()
      if (stLower === 'done' || stLower === 'failed') {
        if (!sseClosersRef.current.has(jid)) return
        sseClosersRef.current.delete(jid)
        if (stLower === 'done') scheduleWatchlistRefresh()
        activeJobSseRef.current = Math.max(0, activeJobSseRef.current - 1)
        while (activeJobSseRef.current < MAX_CONCURRENT_JOB_SSE && jobSseQueueRef.current.length > 0) {
          const next = jobSseQueueRef.current.shift()
          if (!next) break
          queuedJobStreamsRef.current.delete(next)
          openJobStreamNow(next)
        }
      }
    }, { timeoutSec: 86400 })
    sseClosersRef.current.set(jid, sub.close)
  }, [scheduleJobUiFlush, scheduleWatchlistRefresh])

  const startJobStream = useCallback((jid: string) => {
    if (sseClosersRef.current.has(jid) || queuedJobStreamsRef.current.has(jid)) return
    if (activeJobSseRef.current >= MAX_CONCURRENT_JOB_SSE) {
      queuedJobStreamsRef.current.add(jid)
      jobSseQueueRef.current.push(jid)
      return
    }
    openJobStreamNow(jid)
  }, [openJobStreamNow])


  const clearCompleted = useCallback(() => {
    setItems(prev => prev.filter(x => {
      const s = (x.status || '').toLowerCase()
      return s !== 'done' && s !== 'failed' && !x.streamError
    }))
  }, [])

  const clearAll = useCallback(() => { setItems([]) }, [])

  // ── Derived ───────────────────────────────────────────────────────────────
  const poolUpper = comparePool.map(s => s.trim().toUpperCase()).filter(Boolean)
  const wlSymbolsUpper = wlRows.map(r => r.symbol.trim().toUpperCase()).filter(Boolean)

  const activeCount = items.filter(x => {
    const s = (x.status || '').toLowerCase()
    return s !== 'done' && s !== 'failed' && !x.streamError
  }).length

  const showSelectAllButton = poolUpper.length < wlSymbolsUpper.length
  const showClearButton = poolUpper.length > 0

  const canCheck = poolUpper.length > 0 && !gapLoading && fillBatch == null

  // Row fill: pooled symbols with gap > 0 after Check
  const rowFillTargets = poolUpper.filter(sym => {
    const g = gapBySymbol[sym]
    return g?.ok && g.compared_at && (g.gap ?? 0) > 0
  })

  // Column fill: pooled symbols where watchlist metrics below threshold
  const colFillTargets = poolUpper.filter(sym => {
    const row = wlRows.find(r => r.symbol.trim().toUpperCase() === sym)
    const sd = row?.stock_day
    if (!sd?.has_data) return false
    return (sd.ohlc_complete_pct ?? 100) < STOCK_DAY_COLUMN_HEALTH_PCT ||
           (sd.optional_avg_pct ?? 100) < STOCK_DAY_COLUMN_HEALTH_PCT
  })

  const canFillRow = rowFillTargets.length > 0 && fillBatch == null
  const canFillColumn = colFillTargets.length > 0 && fillBatch == null

  // Gap rollup for summary strip
  const checkedSymbols = poolUpper.filter(s => gapBySymbol[s]?.ok && gapBySymbol[s]?.compared_at)
  const anyTodayPending = checkedSymbols.some(s => gapBySymbol[s]?.today_pending)
  const gapRollup = checkedSymbols.length > 0 ? (() => {
    let totalCovered = 0, totalRef = 0, totalGap = 0, n = 0
    for (const s of checkedSymbols) {
      const g = gapBySymbol[s]!
      totalCovered += g.covered_total ?? 0
      totalRef += g.ref_total ?? 0
      totalGap += g.gap ?? 0
      n++
    }
    const covPct = totalRef > 0 ? Math.round(1000 * totalCovered / totalRef) / 10 : 100
    const lastAt = gapBySymbol[checkedSymbols[checkedSymbols.length - 1]!]?.compared_at
    return { n, totalCovered, totalRef, totalGap, covPct, comparedAt: lastAt?.slice(0, 16) ?? '' }
  })() : null

  const fillRowGapButtonTitle = rowFillTargets.length === 0
    ? 'Run Check on the pool first. Fill row gap enqueues only pool symbols with a confirmed non-zero gap.'
    : `Fill missing days for: ${rowFillTargets.join(', ')}`

  const fillColDataButtonTitle = colFillTargets.length === 0
    ? 'No pool symbols with column quality below 97%.'
    : `Re-fetch recent bars for: ${colFillTargets.join(', ')}`

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCheck = useCallback(async () => {
    if (!canCheck) return
    setEnqueueErr(null)
    setGapError(null)
    setGapLoading(true)
    try {
      const resp = await postStockDayGapBatch(poolUpper, 10)
      if (!resp.ok) {
        setGapError(resp.error ?? 'Check failed')
        return
      }
      const newGap = { ...gapBySymbol }
      for (const [sym, result] of Object.entries(resp.results ?? {})) {
        newGap[sym.trim().toUpperCase()] = result
      }
      setGapBySymbol(newGap)
      onGapResultsUpdate?.(newGap)
    } catch (e) {
      setGapError(e instanceof Error ? e.message : 'Check failed')
    } finally {
      setGapLoading(false)
    }
  }, [canCheck, poolUpper, gapBySymbol, onGapResultsUpdate])

  const handleFillRowGap = useCallback(async () => {
    setEnqueueErr(null)
    if (rowFillTargets.length === 0) {
      setEnqueueErr('Run Check on the pool first. Fill row gap only enqueues symbols with a confirmed non-zero gap.')
      return
    }
    setFillBatch('row')
    const batchId = Date.now()
    try {
      setItems(prev => trimJobs([...prev, ...rowFillTargets.map((sym, i) => ({
        trackKey: `fill-row-${batchId}-${sym}`,
        kindLabel: `Fill row gap · ${sym}`,
        status: 'Enqueueing…',
        enqueuedAt: batchId + i,
      }))]))
      setJobsSheetOpen(true)
      let nOk = 0
      for (let i = 0; i < rowFillTargets.length; i++) {
        const sym = rowFillTargets[i]!
        const tk = `fill-row-${batchId}-${sym}`
        // Use backend daily_smart so stock_day gap fill gets both:
        // 1) historical overlap before the earliest missing day, and
        // 2) safe handling for the latest session (avoid relying on an open day's partial bar).
        // missing_by_year is sorted DESC by year, so the last entry is the oldest year.
        const g = gapBySymbol[sym]
        const missingYears = g?.missing_by_year ?? []
        const oldestEntry = missingYears.length > 0 ? missingYears[missingYears.length - 1] : null
        const syncPayload: Record<string, unknown> = {
          mode: 'custom_bars',
          sync_all_periods: true,
          custom_bars_period_group: 'daily',
          custom_bars_sync_mode: 'daily_smart',
          ticker: sym,
          ...(oldestEntry?.first_missing ? { gap_start_date: oldestEntry.first_missing } : {}),
        }
        const res = await postMassiveSync('feed_stocks_aggregate', syncPayload)
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev => prev.map(row => row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row))
          break
        }
        const jid = res.job_id ?? res.job_ids?.[0]
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev => prev.map(row => row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row))
          break
        }
        const dedup = Boolean(res.deduplicated)
        setItems(prev => prev.map(row => row.trackKey === tk ? { ...row, jobId: jid, deduplicated: dedup, status: dedup ? 'deduplicated (waiting)' : 'enqueued' } : row))
        startJobStream(jid)
        nOk++
        if (i < rowFillTargets.length - 1) await delayMs(75)
      }
      if (nOk > 0) { setSessionEnqueueTotal(c => c + nOk); scheduleWatchlistRefresh() }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setFillBatch(null)
    }
  }, [rowFillTargets, scheduleWatchlistRefresh, startJobStream])

  const handleFillColumnData = useCallback(async () => {
    setEnqueueErr(null)
    if (colFillTargets.length === 0) {
      setEnqueueErr('No pool symbols with column quality below 97%.')
      return
    }
    setFillBatch('column')
    const batchId = Date.now()
    try {
      setItems(prev => trimJobs([...prev, ...colFillTargets.map((sym, i) => ({
        trackKey: `fill-col-${batchId}-${sym}`,
        kindLabel: `Fill column data · ${sym}`,
        status: 'Enqueueing…',
        enqueuedAt: batchId + i,
      }))]))
      setJobsSheetOpen(true)
      let nOk = 0
      for (let i = 0; i < colFillTargets.length; i++) {
        const sym = colFillTargets[i]!
        const tk = `fill-col-${batchId}-${sym}`
        let startMs = Date.now() - 30 * 86_400_000
        try {
          const qd = await fetchStockDayQualityDetail(sym, 90)
          const badDays = qd.daily.filter(r => (r.ohlc_pct ?? 100) < 97 || (r.volume_pct ?? 100) < 97)
          if (badDays.length > 0) startMs = new Date(badDays[badDays.length - 1]!.bar_date).getTime()
        } catch { /* use default */ }
        const res = await postMassiveSync('feed_stocks_aggregate', {
          mode: 'custom_bars',
          ticker: sym,
          timespan: 'day',
          multiplier: 1,
          start_ms: startMs,
          end_ms: Date.now(),
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev => prev.map(row => row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row))
          break
        }
        const jid = res.job_id ?? res.job_ids?.[0]
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev => prev.map(row => row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row))
          break
        }
        const dedup = Boolean(res.deduplicated)
        setItems(prev => prev.map(row => row.trackKey === tk ? { ...row, jobId: jid, deduplicated: dedup, status: dedup ? 'deduplicated (waiting)' : 'enqueued' } : row))
        startJobStream(jid)
        nOk++
        if (i < colFillTargets.length - 1) await delayMs(75)
      }
      if (nOk > 0) { setSessionEnqueueTotal(c => c + nOk); scheduleWatchlistRefresh() }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setFillBatch(null)
    }
  }, [colFillTargets, scheduleWatchlistRefresh, startJobStream])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="data-overview-option-jobs-bar">
      <section className="data-overview-contracts-panel" aria-label="stock_day gap pool and actions">
        <div className="data-overview-contracts-panel__toolbar">
          <div className="data-overview-contracts-panel__toolbar-left">
            {activeCount > 0 && (
              <span className="ref-jobs-active-pill" aria-live="polite">{activeCount} active</span>
            )}
            {gapLoading && (
              <button type="button" className="data-overview-check-run-pill" onClick={() => setJobsSheetOpen(true)} title="Checking stock_day gaps…">
                Checking gaps…
              </button>
            )}
            <div className="data-overview-contracts-panel__pool" aria-label="Compare pool">
              <div className="data-overview-contracts-panel__group-head">
                <span className="data-overview-contracts-panel__group-kicker">Pool</span>
                <span className="data-overview-contracts-panel__group-count" title="Symbols in pool">{poolUpper.length}</span>
              </div>
              <div className="data-overview-contracts-panel__group-actions">
                {showSelectAllButton && (
                  <button type="button" className="data-overview-ctl data-overview-ctl--plain" title="Add every watchlist symbol to the pool." onClick={onSelectAllComparePool}>
                    <IcoSelectAll className={ico} />
                    <span>Select all</span>
                  </button>
                )}
                {showClearButton && (
                  <button type="button" className="data-overview-ctl data-overview-ctl--plain" title="Remove all symbols from the pool." onClick={onClearComparePool}>
                    <IcoClearPool className={ico} />
                    <span>Clear</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="data-overview-contracts-panel__toolbar-right" aria-label="stock_day gap">
            <button type="button" className="data-overview-ctl data-overview-ctl--plain"
              title="How Gap and Cov% are defined for stock_day: Gap = weekdays (minus reference_us_holidays NYSE) through cap date, minus this symbol's covered bar_time dates."
              onClick={() => setAllGapsOpen(true)}
              disabled={checkedSymbols.length === 0}
            >
              <span>All gaps</span>
            </button>

            <button
              type="button"
              className="data-overview-ctl data-overview-ctl--check"
              disabled={!canCheck}
              title="Compare stock_day bar_time coverage against weekdays minus PostgreSQL reference_us_holidays (exchange=NYSE); purely local — no vendor API."
              onClick={() => void handleCheck()}
            >
              <IcoRefCheck className={ico} />
              <span>{gapLoading ? 'Checking…' : 'Check'}</span>
            </button>

            <button
              type="button"
              className="data-overview-ctl data-overview-ctl--fill"
              disabled={!canFillRow}
              title={fillRowGapButtonTitle}
              onClick={() => void handleFillRowGap()}
              aria-label="Fill row gap"
            >
              <IcoFillGap className={ico} />
              <span>{fillBatch === 'row' ? 'Filling…' : 'Fill row gap'}</span>
            </button>

            <button
              type="button"
              className="data-overview-ctl data-overview-ctl--fill data-overview-ctl--fill-column"
              disabled={!canFillColumn}
              title={fillColDataButtonTitle}
              onClick={() => void handleFillColumnData()}
              aria-label="Fill column data"
            >
              <IcoFillGap className={ico} />
              <span>{fillBatch === 'column' ? 'Filling…' : 'Fill column data'}</span>
            </button>

            <button
              type="button"
              className="data-overview-ctl data-overview-ctl--plain"
              onClick={() => setJobsSheetOpen(true)}
              title="Open stock_day coverage jobs sheet"
            >
              <span>Jobs {items.length > 0 ? `(${items.length})` : ''}</span>
            </button>
          </div>
        </div>

        {/* Summary strip */}
        <div className="data-overview-contracts-panel__summary" aria-live="polite">
          {gapRollup && gapRollup.n >= 2 ? (
            <span className="data-overview-ref-strip__meta">
              <strong>{gapRollup.n} symbols</strong>
              {' · '}Covered {gapRollup.totalCovered.toLocaleString()}
              {' · '}Ref {gapRollup.totalRef.toLocaleString()}
              {' · '}Gap{' '}
              <span className={gapRollup.totalGap > 0 ? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn' : ''}>
                {gapRollup.totalGap > 0 ? `+${gapRollup.totalGap.toLocaleString()}` : gapRollup.totalGap.toLocaleString()}
              </span>
              {' · '}
              <span className={gapRollup.covPct >= 97 ? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--ok' : 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn'}>
                {gapRollup.covPct}%
              </span>
              {gapRollup.comparedAt && (
                <span className="data-overview-ref-strip__time" title="compared_at (UTC)">{' · '}{gapRollup.comparedAt}</span>
              )}
              {anyTodayPending && (
                <span className="data-overview-ref-strip__time" title="Today's bar is excluded from the gap count — NYSE session still open. Re-run Check after 4:20 PM ET to include today.">
                  {' · '}today excluded (market open)
                </span>
              )}
            </span>
          ) : checkedSymbols.length === 1 ? (() => {
            const sym = checkedSymbols[0]!
            const g = gapBySymbol[sym]!
            return (
              <span className="data-overview-ref-strip__meta">
                <strong>{sym}</strong>
                {' · '}Covered {g.covered_total?.toLocaleString() ?? '—'}
                {' · '}Ref {g.ref_total?.toLocaleString() ?? '—'}
                {' · '}Gap{' '}
                <span className={(g.gap ?? 0) > 0 ? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn' : ''}>
                  {g.gap != null ? ((g.gap > 0 ? '+' : '') + g.gap.toLocaleString()) : '—'}
                </span>
                {g.coverage_pct != null && (
                  <>{' · '}<span className={g.coverage_pct >= 97 ? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--ok' : 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn'}>{g.coverage_pct}%</span></>
                )}
                {g.compared_at && <span className="data-overview-ref-strip__time">{' · '}{g.compared_at.slice(0, 16)}</span>}
                {g.today_pending && (
                  <span className="data-overview-ref-strip__time" title="Today's bar is excluded from the gap count — NYSE session still open. Re-run Check after 4:20 PM ET to include today.">
                    {' · '}today excluded (market open)
                  </span>
                )}
              </span>
            )
          })() : poolUpper.length > 0 ? (
            <span className="data-overview-ref-strip__meta data-overview-ref-strip__meta--muted">
              Run <strong>Check</strong> for Covered / Ref / Gap.
            </span>
          ) : (
            <span className="data-overview-ref-strip__meta data-overview-ref-strip__meta--muted">—</span>
          )}
        </div>

        {/* Guide text */}
        <details className="data-overview-contracts-panel__conclusion">
          <summary className="data-overview-contracts-panel__conclusion-sum">Pool &amp; stock_day Check</summary>
          <div className="data-overview-contracts-panel__conclusion-body">
            <p className="data-overview-contracts-panel__guide-text">
              <span className="data-overview-contracts-panel__em">Pool:</span> click a <strong>Symbol</strong> in the matrix below, <strong>Select all</strong>, or <strong>Clear</strong>.{' '}
              <span className="data-overview-contracts-panel__em">Check</span> compares each symbol's <code>stock_day</code> bar dates against weekdays in the lookback window minus <code>public.reference_us_holidays</code> rows with <code>exchange = 'NYSE'</code> (and weekends), through the same safe end date as daily gap-fill — purely local, no vendor API call.{' '}
              Gap = expected trading days − covered days for this symbol.{' '}
              <span className="data-overview-contracts-panel__em">Fill row gap</span> is available only after Check and enqueues <code>feed_stocks_aggregate</code> daily_smart for pooled symbols with Gap &gt; 0:
              it starts from the earliest missing day with overlap and uses a safer final-day policy so the latest completed session can overwrite partial daily bars.{' '}
              <span className="data-overview-contracts-panel__em">Fill column data</span> re-fetches recent bars for symbols whose OHLC / optional metrics are below 97%. Click <strong>↗</strong> on a symbol for daily OHLC / volume / VWAP quality breakdown.
            </p>
          </div>
        </details>

        {gapError && (
          <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>{gapError}</p>
        )}
      </section>

      {enqueueErr && (
        <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>{enqueueErr}</p>
      )}

      <AllGapsSheet
        open={allGapsOpen}
        onClose={() => setAllGapsOpen(false)}
        gapBySymbol={gapBySymbol}
        poolSymbols={poolUpper}
        onOpenQualitySheet={onOpenQualitySheet}
      />

      <StockDayJobsSheet
        open={jobsSheetOpen}
        onClose={() => setJobsSheetOpen(false)}
        items={items}
        onClearCompleted={clearCompleted}
        onClearAll={clearAll}
        onRefreshCoverage={onWatchlistRefreshRequested}
        maxTracked={MAX_TRACKED}
        sessionEnqueueTotal={sessionEnqueueTotal}
      />
    </div>
  )
}
