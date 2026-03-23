import { useCallback, useEffect, useState } from 'react'
import {
  deleteAllBarsJobs,
  deleteAllMassiveJobs,
  fetchBarsJobs,
  fetchMassiveJobsList,
  trimBarsJobs,
  trimMassiveJobs,
} from '../../api'
import type { BarsJob, MassiveJobApiRow } from '../../api'
import { barsJobResultTitle, formatBarsJobResult } from '../data/barsJobFormat'
import { InfoTooltip } from '../../components/InfoTooltip'
import { fmtTs } from '../../utils/format'

type QueueTab = 'massive' | 'bars'
type StatusFilter = 'all' | 'pending' | 'running' | 'done' | 'failed'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
]

const LIMIT_OPTIONS = [10, 25, 50, 100] as const

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

export function CeleryJobQueuesSection() {
  const [tab, setTab] = useState<QueueTab>('massive')
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
    action: () => Promise<void>
  } | null>(null)

  const loadMassive = useCallback(async () => {
    setMassiveLoading(true)
    setMassiveError(null)
    try {
      const res = await fetchMassiveJobsList({
        limit,
        offset: 0,
        status: statusFilter === 'all' ? undefined : statusFilter,
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
  }, [limit, statusFilter])

  const loadBars = useCallback(async () => {
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

  useEffect(() => {
    if (tab === 'massive') void loadMassive()
    else void loadBars()
  }, [tab, loadMassive, loadBars])

  const refresh = () => {
    setActionMsg(null)
    if (tab === 'massive') void loadMassive()
    else void loadBars()
  }

  const openDeleteAll = () => {
    const scope =
      statusFilter === 'all'
        ? 'all jobs in this queue'
        : `all jobs with status “${statusFilter}”`
    setConfirm({
      title: tab === 'massive' ? 'Delete Massive queue jobs' : 'Delete bars backfill jobs',
      message: `This will permanently delete ${scope}. This cannot be undone.`,
      confirming: false,
      action: async () => {
        if (tab === 'massive') {
          const r = await deleteAllMassiveJobs(statusFilter === 'all' ? null : statusFilter)
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setActionMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
          await loadMassive()
        } else {
          const r = await deleteAllBarsJobs(statusFilter === 'all' ? null : statusFilter)
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setActionMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
          await loadBars()
        }
      },
    })
  }

  const openTrim = () => {
    const n = parseInt(keepLast, 10)
    if (!Number.isFinite(n) || n < 1 || n > 50000) {
      setActionMsg({ text: 'Enter a number between 1 and 50000 for “keep last”.', isErr: true })
      return
    }
    setConfirm({
      title: tab === 'massive' ? 'Trim Massive job table' : 'Trim bars backfill job table',
      message: `Keep only the newest ${n} job(s) by ID. Older rows will be deleted. This cannot be undone.`,
      confirming: false,
      action: async () => {
        if (tab === 'massive') {
          const r = await trimMassiveJobs(n)
          if (!r.ok) throw new Error(r.error ?? 'Trim failed')
          setActionMsg({ text: `Removed ${r.deleted} older job(s); kept ${n} newest.`, isErr: false })
          await loadMassive()
        } else {
          const r = await trimBarsJobs(n)
          if (!r.ok) throw new Error(r.error ?? 'Trim failed')
          setActionMsg({ text: `Removed ${r.deleted} older job(s); kept ${n} newest.`, isErr: false })
          await loadBars()
        }
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

  const loading = tab === 'massive' ? massiveLoading : barsLoading
  const err = tab === 'massive' ? massiveError : barsError

  return (
    <section className="replay-section celery-page-cell celery-page-cell--queues" aria-labelledby="celery-queues-head">
      <div className="celery-queues-header">
        <h3 id="celery-queues-head" className="page-title-with-tooltip" style={{ margin: 0 }}>
          Queues
          <InfoTooltip text="Massive sync jobs (queue: massive) and bars backfill jobs. Filter by status, delete in bulk, or trim to keep only the newest N rows." />
        </h3>
      </div>

      <div className="celery-queue-tabs" role="tablist" aria-label="Job queue type">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'massive'}
          className={`celery-queue-tab ${tab === 'massive' ? 'celery-queue-tab--active' : ''}`}
          onClick={() => {
            setTab('massive')
            setActionMsg(null)
          }}
        >
          Massive queue
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'bars'}
          className={`celery-queue-tab ${tab === 'bars' ? 'celery-queue-tab--active' : ''}`}
          onClick={() => {
            setTab('bars')
            setActionMsg(null)
          }}
        >
          Bars backfill queue
        </button>
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
          className="celery-queue-icon-btn celery-queue-icon-btn--delete"
          onClick={openDeleteAll}
          title="Delete all jobs matching the current status filter"
          aria-label="Delete all jobs matching the current status filter"
        >
          <CeleryQueueTrashIcon />
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
        {tab === 'massive' ? (
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

      {tab === 'massive' ? (
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
                {confirm.confirming ? '…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
