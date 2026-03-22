import { InfoTooltip } from '../../../components/InfoTooltip'
import { fmtTs } from '../../../utils/format'
import { barsJobResultTitle, formatBarsJobResult } from '../barsJobFormat'

export interface BarsJobRow {
  job_id: string
  symbol: string
  period: string
  status: string
  result?: { count?: number; message?: string; error?: string }
  created_ts?: number
  updated_ts?: number
}

const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const
type JobSortKey = 'job_id' | 'status' | 'created_ts' | 'updated_ts'

export interface DataJobsPanelProps {
  sortedBarsJobs: BarsJobRow[]
  barsJobsLoading: boolean
  barsJobsError: string | null
  barsJobsTotal: number
  barsJobsLimit: number
  barsJobsStatusSelected: Set<string>
  barsJobsSortKey: JobSortKey
  barsJobsSortDir: 'asc' | 'desc'
  deletingJobId: string | null
  onToggleStatus: (status: string) => void
  onDeleteAllClick: () => void
  onLimitChange: (limit: number) => void
  onRefreshJobs: () => void
  onSort: (key: JobSortKey) => void
  onDeleteJob: (jobId: string) => void
}

export function DataJobsPanel({
  sortedBarsJobs,
  barsJobsLoading,
  barsJobsError,
  barsJobsTotal,
  barsJobsLimit,
  barsJobsStatusSelected,
  barsJobsSortKey,
  barsJobsSortDir,
  deletingJobId,
  onToggleStatus,
  onDeleteAllClick,
  onLimitChange,
  onRefreshJobs,
  onSort,
  onDeleteJob,
}: DataJobsPanelProps) {
  const statusLabel = (s: string) => (s === 'done' ? 'Done' : s === 'failed' ? 'Failed' : s === 'pending' ? 'Pending' : 'Running')

  return (
    <section className="replay-section" aria-labelledby="data-jobs-head">
      <h3 id="data-jobs-head" className="page-title-with-tooltip">
        Celery jobs
        <InfoTooltip text="Recent bars backfill tasks sent to Celery. Each row = one period (1 D, 1 min, 5 mins, 1 hour). Check here to see if 1 hour or other periods were queued and their status." />
      </h3>
      <div className="replay-toolbar data-jobs-toolbar" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <div className="data-jobs-status-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span className="data-jobs-status-label">Status:</span>
          {JOB_STATUSES.map((s) => (
            <label key={s} className="data-jobs-status-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={barsJobsStatusSelected.has(s)} onChange={() => onToggleStatus(s)} aria-label={`Filter and delete ${s} jobs`} />
              <span>{statusLabel(s)}</span>
            </label>
          ))}
          <button
            type="button"
            className="btn btn-reset btn-sm"
            disabled={barsJobsTotal === 0 || barsJobsLoading || barsJobsStatusSelected.size === 0}
            onClick={onDeleteAllClick}
            aria-label="Delete jobs with selected status(es)"
          >
            Delete all
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span>Least:</span>
          <select value={barsJobsLimit} onChange={(e) => onLimitChange(Number(e.target.value))} aria-label="Number of jobs to show" style={{ minWidth: '5rem' }}>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
        </label>
        <button type="button" className="btn btn-secondary btn-sm" disabled={barsJobsLoading} onClick={() => onRefreshJobs()} aria-label="Refresh backfill jobs">
          {barsJobsLoading ? '…' : 'Refresh'}
        </button>
        <span className="replay-sync-hint" style={{ marginLeft: 'auto' }}>
          {barsJobsTotal > 0 ? `${sortedBarsJobs.length} shown (${barsJobsTotal} total)` : '0 jobs'}
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
      {sortedBarsJobs.length === 0 && !barsJobsLoading ? (
        <div className="replay-placeholder">No pull jobs yet. Run Pull for a symbol above.</div>
      ) : (
        <div className="data-table-scroll-wrap">
          <table className="table-operations">
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  className="table-sort-header"
                  onClick={() => onSort('job_id')}
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
                  onClick={() => onSort('status')}
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
                  onClick={() => onSort('created_ts')}
                  aria-sort={barsJobsSortKey === 'created_ts' ? (barsJobsSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  Created {barsJobsSortKey === 'created_ts' ? (barsJobsSortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="table-sort-header"
                  onClick={() => onSort('updated_ts')}
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
                <td>
                  <code style={{ fontSize: '0.85em' }}>{j.job_id}</code>
                </td>
                <td>
                  <strong>{j.symbol}</strong>
                </td>
                <td>{j.period}</td>
                <td>
                  <span className={`status-badge status-${j.status}`}>{j.status}</span>
                </td>
                <td title={barsJobResultTitle(j)}>
                  {formatBarsJobResult(j)}
                </td>
                <td>{j.created_ts != null ? fmtTs(j.created_ts) : '—'}</td>
                <td>{j.updated_ts != null ? fmtTs(j.updated_ts) : '—'}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-reset btn-sm"
                    disabled={deletingJobId !== null}
                    aria-label={`Delete job ${j.job_id}`}
                    onClick={() => onDeleteJob(j.job_id)}
                  >
                    {deletingJobId === j.job_id ? '…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
