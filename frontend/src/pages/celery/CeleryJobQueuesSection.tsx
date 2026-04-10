import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  deleteAllBarsJobs,
  deleteAllMassiveJobs,
  fetchBarsJobs,
  fetchMassiveJobsList,
  trimBarsJobs,
  trimMassiveJobs,
} from '../../api'
import { fetchWorkerProfiles } from '../../api/ops/ops'
import type { WorkerProfileInfo } from '../../api/ops/ops'
import type { BarsJob, MassiveJobApiRow } from '../../api'
import { barsJobResultTitle, formatBarsJobResult } from '../data/barsJobFormat'
import { InfoTooltip } from '../../components/InfoTooltip'
import { fmtTs } from '../../utils/format'

type StatusFilter = 'all' | 'pending' | 'running' | 'done' | 'failed'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
]

const LIMIT_OPTIONS = [10, 25, 50, 100] as const

/** One tab per worker profile queue (from GET /ops/workers/profiles, fallback matches config.worker_profiles). */
export interface JobQueueTab {
  id: string
  label: string
  celeryQueue: string
  pipeline: 'bars' | 'massive'
}

const FALLBACK_JOB_QUEUE_TABS: JobQueueTab[] = [
  { id: 'ib', label: 'IB', celeryQueue: 'bars', pipeline: 'bars' },
  { id: 'massive', label: 'Massive options', celeryQueue: 'massive', pipeline: 'massive' },
  { id: 'massive_high', label: 'Massive options (high priority)', celeryQueue: 'massive_high', pipeline: 'massive' },
  { id: 'massive_stocks', label: 'Massive stocks', celeryQueue: 'massive_stocks', pipeline: 'massive' },
  { id: 'massive_stocks_high', label: 'Massive stocks (high priority)', celeryQueue: 'massive_stocks_high', pipeline: 'massive' },
]

function tabsFromProfiles(profiles: WorkerProfileInfo[]): JobQueueTab[] {
  const out: JobQueueTab[] = []
  const seenQueues = new Set<string>()
  for (const p of profiles) {
    const qs = (p.queues ?? []).map(q => String(q).trim()).filter(Boolean)
    if (qs.length === 0) continue
    for (const q of qs) {
      if (seenQueues.has(q)) continue
      seenQueues.add(q)
      const id = qs.length > 1 ? `${p.key}__${q}` : p.key
      out.push({
        id,
        label: qs.length > 1 ? `${p.label} (${q})` : p.label,
        celeryQueue: q,
        pipeline: q === 'bars' ? 'bars' : 'massive',
      })
    }
  }
  return out
}

/** Toolbar icon size — compact for a lighter look */
const CELERY_QUEUE_ICON_PX = 15
const CELERY_QUEUE_ICON_STROKE = 1.5

function CeleryQueueTrashIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

/** Distinct from trash — circle + X (failed rows purge). */
function CeleryQueueDeleteFailedIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  )
}

function CeleryQueueRefreshIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

function CeleryQueueTrimIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" x2="8.12" y1="4" y2="15.88" />
      <line x1="14.47" x2="20" y1="14.48" y2="20" />
      <line x1="8.12" x2="12" y1="8.12" y2="12" />
    </svg>
  )
}

function fmtMassiveJobResult(j: MassiveJobApiRow): string {
  const r = j.result as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return '—'
  const err = r.error
  if (typeof err === 'string') return err
  if (r.rows_written != null) return `rows ${String(r.rows_written)}`
  if (r.rows_upserted != null) return `upserted ${String(r.rows_upserted)}`
  if (r.bars_upserted != null) return `bars ${String(r.bars_upserted)}`
  if (r.message != null) return String(r.message)
  return '—'
}

function jobStatusBadgeClass(st: string | undefined): string {
  const s = (st || '').toLowerCase()
  if (s === 'done') return 'feed-massive-badge feed-massive-badge--done'
  if (s === 'failed') return 'feed-massive-badge feed-massive-badge--fail'
  if (s === 'running') return 'feed-massive-badge feed-massive-badge--run'
  return 'feed-massive-badge feed-massive-badge--pending'
}

export interface CeleryJobQueuesSectionProps {
  /** After delete/trim/refresh — parent refreshes broker + aggregated job counts (e.g. loadAll). */
  onJobCountsChanged?: () => void | Promise<void>
  /** Register a callback so the parent can reload this tab’s job list after top-level Clear done / Reset failed. */
  onProvideJobListReload?: (fn: (clearedQueue?: string) => void) => void
}

export type CeleryJobQueuesSectionHandle = {
  navigateToQueue: (celeryQueue: string) => void
  navigateToQueueWithStatus: (
    celeryQueue: string,
    status: 'pending' | 'running' | 'done' | 'failed',
  ) => void
}

export const CeleryJobQueuesSection = forwardRef<CeleryJobQueuesSectionHandle, CeleryJobQueuesSectionProps>(
  function CeleryJobQueuesSection(props, ref) {
  const { onJobCountsChanged, onProvideJobListReload } = props
  const [queueTabs, setQueueTabs] = useState<JobQueueTab[]>(FALLBACK_JOB_QUEUE_TABS)
  const queueTabsRef = useRef(queueTabs)
  queueTabsRef.current = queueTabs
  const [activeTabId, setActiveTabId] = useState<string>(FALLBACK_JOB_QUEUE_TABS[0].id)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [limit, setLimit] = useState<number>(25)
  const [keepLast, setKeepLast] = useState<string>('100')

  const [massiveJobs, setMassiveJobs] = useState<MassiveJobApiRow[]>([])
  const [massiveLoading, setMassiveLoading] = useState(false)
  const [massiveError, setMassiveError] = useState<string | null>(null)

  const [barsJobs, setBarsJobs] = useState<BarsJob[]>([])
  const [barsLoading, setBarsLoading] = useState(false)
  const [barsError, setBarsError] = useState<string | null>(null)

  const [actionMsg, setActionMsg] = useState<{ text: string; isErr: boolean } | null>(null)

  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    confirming: boolean
    confirmLabel?: string
    action: () => Promise<void>
  } | null>(null)

  useImperativeHandle(ref, () => ({
    navigateToQueue: (celeryQueue: string) => {
      const q = String(celeryQueue).trim()
      const tab = queueTabsRef.current.find(t => t.celeryQueue === q)
      if (tab) setActiveTabId(tab.id)
    },
    navigateToQueueWithStatus: (celeryQueue: string, status) => {
      const q = String(celeryQueue).trim()
      const tab = queueTabsRef.current.find(t => t.celeryQueue === q)
      if (tab) {
        setActiveTabId(tab.id)
        setStatusFilter(status)
      }
    },
  }))

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWorkerProfiles()
        if (res.ok && res.profiles?.length) {
          const t = tabsFromProfiles(res.profiles)
          if (t.length > 0) {
            setQueueTabs(t)
            setActiveTabId(prev => (t.some(x => x.id === prev) ? prev : t[0].id))
          }
        }
      } catch {
        /* keep FALLBACK_JOB_QUEUE_TABS */
      }
    })()
  }, [])

  const activeTab = queueTabs.find(t => t.id === activeTabId) ?? queueTabs[0]
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const loadMassiveQueue = useCallback(
    async (celeryQueue: string) => {
      setMassiveLoading(true)
      setMassiveError(null)
      try {
        const res = await fetchMassiveJobsList({
          limit,
          offset: 0,
          status: statusFilter === 'all' ? undefined : statusFilter,
          celery_queue: celeryQueue,
        })
        if (!res.ok) {
          setMassiveError(res.error ?? 'Failed to load jobs')
          setMassiveJobs([])
          return
        }
        setMassiveJobs(res.jobs)
      } catch (e) {
        setMassiveError(e instanceof Error ? e.message : 'Failed to load jobs')
        setMassiveJobs([])
      } finally {
        setMassiveLoading(false)
      }
    },
    [limit, statusFilter],
  )

  const loadBarsQueue = useCallback(async () => {
    setBarsLoading(true)
    setBarsError(null)
    try {
      const statusParam = statusFilter === 'all' ? null : statusFilter
      const res = await fetchBarsJobs(limit, 0, statusParam)
      setBarsJobs(res.jobs ?? [])
      if (res.error) setBarsError(res.error)
    } catch (e) {
      setBarsError(e instanceof Error ? e.message : 'Failed to load jobs')
      setBarsJobs([])
    } finally {
      setBarsLoading(false)
    }
  }, [limit, statusFilter])

  const reloadListForTopAction = useCallback((clearedQueue?: string) => {
    const t = activeTabRef.current
    if (clearedQueue != null && t && t.celeryQueue !== clearedQueue) return
    if (!t) return
    if (t.pipeline === 'massive') void loadMassiveQueue(t.celeryQueue)
    else void loadBarsQueue()
  }, [loadMassiveQueue, loadBarsQueue])

  useEffect(() => {
    onProvideJobListReload?.(reloadListForTopAction)
  }, [onProvideJobListReload, reloadListForTopAction])

  useEffect(() => {
    const tab = queueTabs.find(t => t.id === activeTabId)
    if (!tab) return
    if (tab.pipeline === 'massive') {
      void loadMassiveQueue(tab.celeryQueue)
    } else {
      void loadBarsQueue()
    }
  }, [activeTabId, queueTabs, loadMassiveQueue, loadBarsQueue])

  const refresh = () => {
    setActionMsg(null)
    if (!activeTab) return
    void onJobCountsChanged?.()
    if (activeTab.pipeline === 'massive') void loadMassiveQueue(activeTab.celeryQueue)
    else void loadBarsQueue()
  }

  const openDeleteDone = () => {
    if (!activeTab) return
    setConfirm({
      title:
        activeTab.pipeline === 'bars'
          ? 'Delete done bars backfill jobs'
          : `Delete done Massive jobs (queue “${activeTab.celeryQueue}”)`,
      message:
        'This will permanently delete all rows with status done in this queue slice. This cannot be undone.',
      confirming: false,
      action: async () => {
        if (activeTab.pipeline === 'massive') {
          const r = await deleteAllMassiveJobs('done', activeTab.celeryQueue)
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setActionMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
          await loadMassiveQueue(activeTab.celeryQueue)
        } else {
          const r = await deleteAllBarsJobs('done')
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setActionMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
          await loadBarsQueue()
        }
        void onJobCountsChanged?.()
      },
    })
  }

  const openDeleteFailed = () => {
    if (!activeTab) return
    setConfirm({
      title:
        activeTab.pipeline === 'bars'
          ? 'Delete failed bars backfill jobs'
          : `Delete failed Massive jobs (queue “${activeTab.celeryQueue}”)`,
      message:
        'This will permanently delete all rows with status failed in this queue slice. This cannot be undone.',
      confirming: false,
      action: async () => {
        if (activeTab.pipeline === 'massive') {
          const r = await deleteAllMassiveJobs('failed', activeTab.celeryQueue)
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setActionMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
          await loadMassiveQueue(activeTab.celeryQueue)
        } else {
          const r = await deleteAllBarsJobs('failed')
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setActionMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
          await loadBarsQueue()
        }
        void onJobCountsChanged?.()
      },
    })
  }

  const openTrim = () => {
    if (!activeTab) return
    const n = parseInt(keepLast, 10)
    if (!Number.isFinite(n) || n < 1 || n > 50000) {
      setActionMsg({ text: 'Enter a number between 1 and 50000 for “keep last”.', isErr: true })
      return
    }
    setConfirm({
      title:
        activeTab.pipeline === 'bars'
          ? 'Trim bars backfill job table'
          : `Trim Massive jobs (queue “${activeTab.celeryQueue}”)`,
      message: `Keep only the newest ${n} job(s) by ID in this queue slice. Older rows will be deleted. This cannot be undone.`,
      confirming: false,
      action: async () => {
        if (activeTab.pipeline === 'massive') {
          const r = await trimMassiveJobs(n, activeTab.celeryQueue)
          if (!r.ok) throw new Error(r.error ?? 'Trim failed')
          setActionMsg({ text: `Removed ${r.deleted} older job(s); kept ${n} newest.`, isErr: false })
          await loadMassiveQueue(activeTab.celeryQueue)
        } else {
          const r = await trimBarsJobs(n)
          if (!r.ok) throw new Error(r.error ?? 'Trim failed')
          setActionMsg({ text: `Removed ${r.deleted} older job(s); kept ${n} newest.`, isErr: false })
          await loadBarsQueue()
        }
        void onJobCountsChanged?.()
      },
    })
  }

  const runConfirm = async () => {
    if (!confirm) return
    const { action } = confirm
    setConfirm(c => (c ? { ...c, confirming: true } : null))
    try {
      await action()
      setConfirm(null)
    } catch (e) {
      setActionMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
      setConfirm(null)
    }
  }

  const loading = activeTab?.pipeline === 'massive' ? massiveLoading : barsLoading
  const err = activeTab?.pipeline === 'massive' ? massiveError : barsError

  return (
    <section className="replay-section dashboard-section dashboard-celery-queues" aria-labelledby="celery-queues-head">
      <div className="celery-queues-header">
        <h3 id="celery-queues-head" className="page-title-with-tooltip" style={{ margin: 0 }}>
          Queues
          <InfoTooltip text="Queue summary (above main tabs) shows all queues. Tabs follow ops.worker_profiles (GET /ops/workers/profiles). Each tab lists PostgreSQL jobs for that Celery queue: bars → job_bars_backfill; Massive* → job_massive_backfill filtered by routing. Delete done (trash icon) and Delete failed (circle with X) remove only those statuses in the active queue slice; trim applies to row age by ID." />
        </h3>
      </div>

      <div className="celery-queue-tabs celery-queue-tabs--profiles" role="tablist" aria-label="Job queue by worker profile">
        {queueTabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTabId === t.id}
            className={`celery-queue-tab ${activeTabId === t.id ? 'celery-queue-tab--active' : ''}`}
            title={`Celery queue: ${t.celeryQueue}`}
            onClick={() => {
              setActiveTabId(t.id)
              setActionMsg(null)
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="celery-queue-toolbar">
        <div className="celery-queue-field celery-queue-field--status">
          <span className="celery-queue-field-label" id="celery-queue-status-label">
            Status
          </span>
          <div
            className="celery-status-bubbles"
            role="radiogroup"
            aria-labelledby="celery-queue-status-label"
          >
            {STATUS_OPTIONS.map(o => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={statusFilter === o.value}
                className={`celery-status-bubble ${statusFilter === o.value ? 'celery-status-bubble--active' : ''}`}
                onClick={() => setStatusFilter(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="celery-queue-field celery-queue-field--limit">
          <span className="celery-queue-field-label" id="celery-queue-limit-label">
            Last
          </span>
          <div
            className="celery-status-bubbles"
            role="radiogroup"
            aria-labelledby="celery-queue-limit-label"
          >
            {LIMIT_OPTIONS.map(n => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={limit === n}
                className={`celery-status-bubble ${limit === n ? 'celery-status-bubble--active' : ''}`}
                onClick={() => setLimit(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={`celery-queue-icon-btn celery-queue-icon-btn--refresh${loading ? ' celery-queue-icon-btn--refreshing' : ''}`}
          disabled={loading}
          onClick={refresh}
          title="Refresh job list"
          aria-label="Refresh job list"
        >
          <CeleryQueueRefreshIcon />
        </button>
        <div className="celery-queue-toolbar-spacer" />
        <button
          type="button"
          className="celery-queue-icon-btn celery-queue-icon-btn--delete-done"
          onClick={openDeleteDone}
          title="Delete all jobs with status done in this queue slice"
          aria-label="Delete all jobs with status done in this queue slice"
        >
          <CeleryQueueTrashIcon />
        </button>
        <button
          type="button"
          className="celery-queue-icon-btn celery-queue-icon-btn--delete-failed"
          onClick={openDeleteFailed}
          title="Delete all jobs with status failed in this queue slice"
          aria-label="Delete all jobs with status failed in this queue slice"
        >
          <CeleryQueueDeleteFailedIcon />
        </button>
        <div className="celery-queue-keep-group">
          <label className="celery-queue-field celery-queue-field--inline">
            <span className="celery-queue-field-label">Keep last</span>
            <input
              type="number"
              className="celery-queue-keep-input"
              min={1}
              max={50000}
              value={keepLast}
              onChange={e => setKeepLast(e.target.value)}
              aria-label="Keep last N jobs when trimming"
            />
          </label>
          <button
            type="button"
            className="celery-queue-icon-btn celery-queue-icon-btn--trim"
            onClick={openTrim}
            title="Trim job table: keep only the newest N rows by ID"
            aria-label="Trim job table: keep only the newest N rows by ID"
          >
            <CeleryQueueTrimIcon />
          </button>
        </div>
      </div>

      <p className="section-hint celery-queue-hint">
        <code className="dashboard-queue-name">{activeTab?.celeryQueue ?? '—'}</code>
        {' — '}
        {activeTab?.pipeline === 'massive' ? (
          <>
            Full Massive controls: <a href="#feed-massive-option">Massive Option</a>.
          </>
        ) : (
          <>
            Full bars job UI: <a href="#feed-ib-stock">IB Stock → Data</a>.
          </>
        )}
      </p>

      {actionMsg ? (
        <p className={`status-page-msg ${actionMsg.isErr ? 'err' : 'ok'}`} role={actionMsg.isErr ? 'alert' : 'status'}>
          {actionMsg.text}
        </p>
      ) : null}

      {err ? (
        <p className="status-page-msg err" role="alert">
          {err}
        </p>
      ) : null}

      {activeTab?.pipeline === 'massive' ? (
        <div className="feed-massive-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {massiveJobs.length === 0 && !massiveLoading ? (
                <tr>
                  <td colSpan={5}>
                    <div className="feed-massive-empty">No jobs match the filter.</div>
                  </td>
                </tr>
              ) : (
                massiveJobs.map(row => (
                  <tr key={row.job_id}>
                    <td>
                      <span className="feed-massive-job-id">{row.job_id}</span>
                    </td>
                    <td>{row.kind ?? '—'}</td>
                    <td>
                      <span className={jobStatusBadgeClass(row.status)}>{row.status ?? '—'}</span>
                    </td>
                    <td>{row.created_ts != null ? fmtTs(row.created_ts) : '—'}</td>
                    <td
                      style={{ maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={fmtMassiveJobResult(row)}
                    >
                      {fmtMassiveJobResult(row)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="feed-massive-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Job ID</th>
                <th scope="col">Symbol</th>
                <th scope="col">Period</th>
                <th scope="col">Status</th>
                <th scope="col">Result</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {barsJobs.length === 0 && !barsLoading ? (
                <tr>
                  <td colSpan={6}>
                    <div className="feed-massive-empty">No jobs match the filter.</div>
                  </td>
                </tr>
              ) : (
                barsJobs.map(row => (
                  <tr key={row.job_id}>
                    <td>
                      <span className="feed-massive-job-id">{row.job_id}</span>
                    </td>
                    <td>{row.symbol}</td>
                    <td>{row.period}</td>
                    <td>
                      <span className={jobStatusBadgeClass(row.status)}>{row.status}</span>
                    </td>
                    <td
                      style={{ maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={barsJobResultTitle(row)}
                    >
                      {formatBarsJobResult(row) || '—'}
                    </td>
                    <td>{row.updated_ts != null ? fmtTs(row.updated_ts) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {confirm ? (
        <div className="celery-queue-confirm-overlay" role="presentation">
          <div className="celery-queue-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="celery-queue-confirm-title">
            <h4 id="celery-queue-confirm-title" className="celery-queue-confirm-title">
              {confirm.title}
            </h4>
            <p className="celery-queue-confirm-message">{confirm.message}</p>
            <div className="celery-queue-confirm-actions">
              <button type="button" className="btn btn-secondary" disabled={confirm.confirming} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={confirm.confirming} onClick={() => void runConfirm()}>
                {confirm.confirming ? '…' : (confirm.confirmLabel ?? 'Confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
})

CeleryJobQueuesSection.displayName = 'CeleryJobQueuesSection'
