import { useMemo } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import { OpsHostEnvPillBadge } from '../../components/OpsHostEnvPillBadge'
import type { AggregatedJobQueueSummaryRow } from '../../api'
import type { QueueSummaryRow, WorkerSummary } from '../../api/ops/ops'
import type { OpsHostEnvPill } from '../../utils/opsHostEnvPill'
import { dedupedQueueSummaryTotals } from '../../utils/celeryRuntime'

type LampColor = 'green' | 'yellow' | 'red' | 'none'

/** Per-queue consumer coverage (Celery inspect + broker). */
function queueCoverageLamp(
  queueName: string,
  brokerConnected: boolean | undefined,
  workerList: WorkerSummary[],
): { lamp: LampColor; title: string } {
  if (brokerConnected !== true) {
    return { lamp: 'red', title: 'Broker not connected' }
  }
  const covered = workerList.some(w => (w.queues ?? []).includes(queueName))
  if (covered) {
    return {
      lamp: 'green',
      title: `At least one worker consumes queue “${queueName}”`,
    }
  }
  return {
    lamp: 'yellow',
    title: `No worker in this snapshot consumes queue “${queueName}”`,
  }
}

function fmtQueueCell(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return String(n)
}

const TOP_Q_ICON_PX = 15
const TOP_Q_ICON_STROKE = 1.5

function TopQueueClearDoneIcon({ size = TOP_Q_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={TOP_Q_ICON_STROKE}
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

function TopQueueResetFailedIcon({ size = TOP_Q_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={TOP_Q_ICON_STROKE}
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

function formatQueueLabel(name: string): string {
  if (name === 'massive_stocks_high') return 'Massive stocks (high priority)'
  if (name === 'massive_stocks') return 'Massive stocks'
  if (name === 'massive_high') return 'Massive options (high priority)'
  if (name === 'massive') return 'Massive options'
  if (name === 'bars') return 'Bars (IB)'
  return name
}

export interface CeleryTopQueueSummaryProps {
  queueSummary: QueueSummaryRow[]
  queueSummaryDb: boolean | null
  aggregatedRows: AggregatedJobQueueSummaryRow[]
  /** True while initial / polling load for queue + aggregated data */
  loading: boolean
  /** When set, action icons for this Celery queue name are disabled (request in flight). */
  actionBusyQueue: string | null
  workers: WorkerSummary[]
  brokerConnected: boolean | undefined
  opsHostEnvPill: OpsHostEnvPill
  opsHostEnvPillTitle: string
  runtimeCeleryLamp: LampColor
  runtimeCeleryStatusText: string
  onClearDone: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
  onResetFailed: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
}

/**
 * Merged broker snapshot (Redis LLEN, Celery active/reserved from Ops) + PostgreSQL job counts
 * per queue (GET /ops/jobs/queues/summary). Shown above all Celery main tabs.
 */
export function CeleryTopQueueSummary({
  queueSummary,
  queueSummaryDb,
  aggregatedRows,
  loading,
  actionBusyQueue,
  workers,
  brokerConnected,
  opsHostEnvPill,
  opsHostEnvPillTitle,
  runtimeCeleryLamp,
  runtimeCeleryStatusText,
  onClearDone,
  onResetFailed,
}: CeleryTopQueueSummaryProps) {
  const aggByQueue = useMemo(() => new Map(aggregatedRows.map(r => [r.celery_queue, r])), [aggregatedRows])

  const merged = useMemo(() => {
    const seen = new Set<string>()
    const out: { qs: QueueSummaryRow; agg: AggregatedJobQueueSummaryRow | undefined }[] = []
    for (const qs of queueSummary) {
      seen.add(qs.name)
      out.push({ qs, agg: aggByQueue.get(qs.name) })
    }
    for (const agg of aggregatedRows) {
      if (seen.has(agg.celery_queue)) continue
      seen.add(agg.celery_queue)
      out.push({
        qs: {
          name: agg.celery_queue,
          pending_broker: null,
          running_celery: null,
          done_db: null,
          failed_db: null,
        },
        agg,
      })
    }
    return out
  }, [queueSummary, aggregatedRows, aggByQueue])

  const totalsBroker = queueSummary.length > 0 ? dedupedQueueSummaryTotals(queueSummary) : null
  const totalsPg = useMemo(() => {
    const z = { pending: 0, running: 0, done: 0, failed: 0 }
    for (const r of aggregatedRows) {
      z.pending += r.counts.pending
      z.running += r.counts.running
      z.done += r.counts.done
      z.failed += r.counts.failed
    }
    return z
  }, [aggregatedRows])

  const noRows = merged.length === 0

  return (
    <section
      className="replay-section dashboard-section dashboard-queue-summary dashboard-celery-top-queue-summary"
      aria-labelledby="dashboard-celery-top-queue-summary-head"
    >
      <h3 id="dashboard-celery-top-queue-summary-head" className="page-title-with-tooltip">
        Queue summary
        <InfoTooltip text="Broker: Redis LLEN (pending messages) and Celery inspect counts (active + reserved for this routing key). PostgreSQL: job table rows by status per Celery queue (GET /ops/jobs/queues/summary). Extra Redis LIST keys appear as broker-only rows until listed in worker profiles." />
      </h3>
      {queueSummaryDb === false && (
        <p className="dashboard-queue-summary-hint">PostgreSQL job totals unavailable (check ops config or DB).</p>
      )}
      {noRows ? (
        <div className="dashboard-empty">
          {loading ? 'Loading queue summary…' : 'No queue summary from Ops API.'}
        </div>
      ) : (
        <div className="dashboard-queue-summary-table-wrap">
          <table className="table-operations dashboard-queue-summary-table dashboard-celery-top-queue-summary-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>Status</th>
                <th style={{ width: 88 }}>
                  Host
                  <InfoTooltip text="Ops API stack from GET /ops/health (config_profile): Dev or Prod for this session." />
                </th>
                <th>Queue</th>
                <th>
                  Redis
                  <InfoTooltip text="Messages waiting on the Redis broker (LLEN) for this list key." />
                </th>
                <th>
                  Celery
                  <InfoTooltip text="Celery tasks active or reserved for this queue (inspect aggregate from Ops)." />
                </th>
                <th>
                  Pending
                  <InfoTooltip text="PostgreSQL job rows with status pending for this queue slice." />
                </th>
                <th>
                  Running
                  <InfoTooltip text="PostgreSQL job rows with status running for this queue slice." />
                </th>
                <th>
                  Done
                  <InfoTooltip text="PostgreSQL job rows with status done for this queue slice." />
                </th>
                <th>
                  Failed
                  <InfoTooltip text="PostgreSQL job rows with status failed for this queue slice." />
                </th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {merged.map(({ qs, agg }) => {
                const qCov = queueCoverageLamp(qs.name, brokerConnected, workers)
                return (
                  <tr key={qs.name}>
                    <td>
                      <span
                        className={`title-inline-lamp lamp-icon ${qCov.lamp}`}
                        title={qCov.title}
                        aria-label={qCov.title}
                        role="img"
                      >
                        <span aria-hidden>●</span>
                      </span>
                    </td>
                    <td title={opsHostEnvPillTitle}>
                      <OpsHostEnvPillBadge pill={opsHostEnvPill} className="dashboard-celery-env-pill" />
                    </td>
                    <td>
                      <code className="dashboard-queue-name">{formatQueueLabel(qs.name)}</code>
                      {qs.db_totals_shared ? (
                        <span
                          className="dashboard-queue-shared-mark"
                          title="Broker/Celery inspect columns may mirror shared Massive aggregates from Ops; PostgreSQL columns are per-queue."
                        >
                          {' '}
                          *
                        </span>
                      ) : null}
                    </td>
                    <td>{loading ? '…' : fmtQueueCell(qs.pending_broker)}</td>
                    <td>{loading ? '…' : fmtQueueCell(qs.running_celery)}</td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--pending">
                      {loading ? '…' : agg ? fmtQueueCell(agg.counts.pending) : '—'}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--running">
                      {loading ? '…' : agg ? fmtQueueCell(agg.counts.running) : '—'}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--done">
                      {loading ? '…' : agg ? fmtQueueCell(agg.counts.done) : '—'}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--failed">
                      {loading ? '…' : agg ? fmtQueueCell(agg.counts.failed) : '—'}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-actions">
                      {agg ? (
                        <div className="dashboard-celery-top-queue-summary-action-icons">
                          <button
                            type="button"
                            className="celery-queue-icon-btn celery-queue-icon-btn--delete"
                            title="Delete all rows with status done for this queue (PostgreSQL)"
                            aria-label="Clear done jobs for this queue"
                            disabled={
                              loading ||
                              actionBusyQueue === agg.celery_queue ||
                              agg.counts.done === 0
                            }
                            onClick={() => void onClearDone(agg)}
                          >
                            <TopQueueClearDoneIcon />
                          </button>
                          <button
                            type="button"
                            className="celery-queue-icon-btn celery-queue-icon-btn--refresh"
                            title="Reset up to 500 oldest failed jobs to pending and re-queue Celery"
                            aria-label="Reset failed jobs for this queue"
                            disabled={
                              loading ||
                              actionBusyQueue === agg.celery_queue ||
                              agg.counts.failed === 0
                            }
                            onClick={() => void onResetFailed(agg)}
                          >
                            <TopQueueResetFailedIcon />
                          </button>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
              {merged.length > 0 ? (
                <tr className="dashboard-queue-summary-totals-row">
                  <td>
                    <span
                      className={`title-inline-lamp lamp-icon ${runtimeCeleryLamp}`}
                      title={runtimeCeleryStatusText}
                      aria-label={runtimeCeleryStatusText}
                      role="img"
                    >
                      <span aria-hidden>●</span>
                    </span>
                  </td>
                  <td title={opsHostEnvPillTitle}>
                    <OpsHostEnvPillBadge pill={opsHostEnvPill} className="dashboard-celery-env-pill" />
                  </td>
                  <td>
                    <strong>Total</strong>
                    <InfoTooltip text="Redis/Celery: same dedupe as before (bars + one Massive aggregate + extras). PostgreSQL: sum of per-queue job counts in the rows above." />
                  </td>
                  <td>{fmtQueueCell(totalsBroker?.pending_broker ?? null)}</td>
                  <td>{fmtQueueCell(totalsBroker?.running_celery ?? null)}</td>
                  <td>{fmtQueueCell(totalsPg.pending)}</td>
                  <td>{fmtQueueCell(totalsPg.running)}</td>
                  <td>{fmtQueueCell(totalsPg.done)}</td>
                  <td>{fmtQueueCell(totalsPg.failed)}</td>
                  <td>—</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
