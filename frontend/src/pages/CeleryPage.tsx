import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchBarsJobs, fetchMassiveJobsList, fetchCeleryLogs, subscribeCeleryLogs, clearCeleryLogs } from '../api'
import type { BarsJob, MassiveJobApiRow } from '../api'
import { barsJobResultTitle, formatBarsJobResult } from './data/barsJobFormat'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { fmtTs } from '../utils/format'
import { StatusCeleryPanel, StatusSseQueuesPanel } from './status/panels'
import { celeryMetricsFromStatus, useCeleryStopControl } from './status/celeryMetrics'

function fmtJobResult(j: MassiveJobApiRow): string {
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

export interface CeleryPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
  breadcrumbLabel?: string
}

export function CeleryPage({
  status,
  loadStatus,
  embeddedInSettings,
  breadcrumbLabel = 'Celery',
}: CeleryPageProps) {
  const j = status
  const metrics = celeryMetricsFromStatus(j)
  const { celeryCtrlMsg, onCeleryStop } = useCeleryStopControl(loadStatus)
  const celeryConsole = useLogConsole({
    fetchLogs: fetchCeleryLogs,
    subscribeLogs: subscribeCeleryLogs,
    clearLogs: clearCeleryLogs,
  })

  const [massiveJobs, setMassiveJobs] = useState<MassiveJobApiRow[]>([])
  const [massiveJobsLoading, setMassiveJobsLoading] = useState(false)
  const [massiveJobsError, setMassiveJobsError] = useState<string | null>(null)

  const [barsJobs, setBarsJobs] = useState<BarsJob[]>([])
  const [barsJobsLoading, setBarsJobsLoading] = useState(false)
  const [barsJobsError, setBarsJobsError] = useState<string | null>(null)

  const loadMassiveJobs = useCallback(async () => {
    setMassiveJobsLoading(true)
    setMassiveJobsError(null)
    try {
      const res = await fetchMassiveJobsList({ limit: 25 })
      if (!res.ok) {
        setMassiveJobsError(res.error ?? 'Failed to load jobs')
        setMassiveJobs([])
        return
      }
      setMassiveJobs(res.jobs)
    } catch (e) {
      setMassiveJobsError(e instanceof Error ? e.message : 'Failed to load jobs')
      setMassiveJobs([])
    } finally {
      setMassiveJobsLoading(false)
    }
  }, [])

  const loadBarsJobs = useCallback(async () => {
    setBarsJobsLoading(true)
    setBarsJobsError(null)
    try {
      const res = await fetchBarsJobs(15, 0, null)
      setBarsJobs(res.jobs ?? [])
      if (res.error) setBarsJobsError(res.error)
    } catch (e) {
      setBarsJobsError(e instanceof Error ? e.message : 'Failed to load jobs')
      setBarsJobs([])
    } finally {
      setBarsJobsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMassiveJobs()
    loadBarsJobs()
  }, [loadMassiveJobs, loadBarsJobs])

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'celery-page celery-page--embedded' : 'celery-page'}`}>
      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            {breadcrumbLabel}
            <InfoTooltip text="Celery worker health, worker log stream, SSE backlog for Celery logs, and links to queue-related jobs." />
          </h2>
          <p className="settings-page-subtitle">
            Health, stop worker, worker log, Celery log SSE backlog, and Massive / bars job shortcuts.
          </p>
        </div>
      </div>

      <div className="celery-page-grid settings-page-groups">
        <section className="replay-section celery-page-cell celery-page-cell--status" aria-labelledby="celery-status-head">
          <h3 id="celery-status-head" className="page-title-with-tooltip">
            Worker status
            <InfoTooltip text="Broker (Redis), worker processes, and optional IB connection used by the market worker." />
          </h3>
          <StatusCeleryPanel
            status={j}
            celeryLamp={metrics.celeryLamp}
            celeryBrokerConnected={metrics.celeryBrokerConnected}
            celeryWorkersAlive={metrics.celeryWorkersAlive}
            celeryLastTs={metrics.celeryLastTs}
            celeryWorkerIbConnected={metrics.celeryWorkerIbConnected}
            celeryWorkerIbClientId={metrics.celeryWorkerIbClientId}
            onCeleryStop={onCeleryStop}
            celeryCtrlMsg={celeryCtrlMsg}
          />
        </section>

        <div className="celery-page-cell celery-page-cell--sse">
          <StatusSseQueuesPanel categoryKeys={['celery_logs']} heading="Celery log SSE backlog" />
        </div>

        <section className="replay-section celery-page-cell celery-page-cell--log" aria-labelledby="celery-console-head">
          <h3 id="celery-console-head" className="page-title-with-tooltip">
            Worker log
            <InfoTooltip text="Real-time Celery worker log (Redis stream). Start worker: python scripts/run_celery.py" />
          </h3>
          <LogConsolePanel
            controller={celeryConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis/Celery broker may be down)."
            emptyText="No log lines yet. Start Worker: python scripts/run_celery.py"
            infoTooltipText="Real-time Worker log (Redis Stream). Run `python scripts/run_celery.py` to see output."
            resizeAriaLabel="Resize Celery console height"
            clearTitle="Clear displayed log and Redis stream; new lines will continue to appear when Worker runs"
          />
        </section>

        <section className="replay-section celery-page-cell celery-page-cell--massive" aria-labelledby="celery-massive-jobs-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <h3 id="celery-massive-jobs-head" className="page-title-with-tooltip" style={{ margin: 0 }}>
              Massive queue
              <InfoTooltip text="Latest Massive sync tasks (massive queue). Full controls live on Massive Option." />
            </h3>
            <a href="#feed-massive-option">Open Massive Option</a>
            <button type="button" className="btn btn-secondary btn-sm" disabled={massiveJobsLoading} onClick={() => loadMassiveJobs()}>
              {massiveJobsLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {massiveJobsError ? (
            <p className="status-page-msg err" role="alert">
              {massiveJobsError}
            </p>
          ) : null}
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
                {massiveJobs.length === 0 && !massiveJobsLoading ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="feed-massive-empty">No jobs yet.</div>
                    </td>
                  </tr>
                ) : (
                  massiveJobs.map((row) => (
                    <tr key={row.job_id}>
                      <td>
                        <span className="feed-massive-job-id">{row.job_id}</span>
                      </td>
                      <td>{row.kind ?? '—'}</td>
                      <td>
                        <span className={jobStatusBadgeClass(row.status)}>{row.status ?? '—'}</span>
                      </td>
                      <td>{row.created_ts != null ? fmtTs(row.created_ts) : '—'}</td>
                      <td style={{ maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fmtJobResult(row)}>
                        {fmtJobResult(row)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="replay-section celery-page-cell celery-page-cell--bars" aria-labelledby="celery-bars-jobs-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <h3 id="celery-bars-jobs-head" className="page-title-with-tooltip" style={{ margin: 0 }}>
              Bars backfill queue
              <InfoTooltip text="Recent bars backfill tasks (Celery). Manage and delete jobs on IB Stock → Data." />
            </h3>
            <a href="#feed-ib-stock">Open IB Stock → Data</a>
            <button type="button" className="btn btn-secondary btn-sm" disabled={barsJobsLoading} onClick={() => loadBarsJobs()}>
              {barsJobsLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          <p className="section-hint" style={{ marginBottom: '0.5rem' }}>
            Watchlist EOD dry-run preview and full job management: <a href="#feed-ib-stock">IB Stock → Data</a>.
          </p>
          {barsJobsError ? (
            <p className="status-page-msg err" role="alert">
              {barsJobsError}
            </p>
          ) : null}
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
                {barsJobs.length === 0 && !barsJobsLoading ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="feed-massive-empty">No recent jobs.</div>
                    </td>
                  </tr>
                ) : (
                  barsJobs.map((row) => (
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
        </section>

        <section className="replay-section celery-page-cell celery-page-cell--config" aria-labelledby="celery-config-head">
          <h3 id="celery-config-head" className="page-title-with-tooltip">
            Configure
            <InfoTooltip text="Celery worker_market client ID is stored in IB configuration (YAML-backed)." />
          </h3>
          <p className="section-hint" style={{ marginBottom: '0.5rem' }}>
            Set <strong>Celery worker_market</strong> client ID under{' '}
            <a href="#settings-ib-connection">Settings → IB Configure</a>{' '}
            (Client ID YAML group). Keep it distinct from daemon and monitor client IDs.
          </p>
        </section>
      </div>
    </div>
  )
}
