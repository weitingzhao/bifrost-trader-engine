import { useMemo } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import { OpsHostEnvPillBadge } from '../../components/OpsHostEnvPillBadge'
import type { AggregatedJobQueueSummaryRow } from '../../api'
import type { QueueSummaryRow, WorkerSummary } from '../../api/ops/ops'
import type { OpsHostEnvPill } from '../../utils/opsHostEnvPill'
import { dedupedQueueSummaryTotals } from '../../utils/celeryRuntime'
import { brokerQueueKeyTitle, formatQueueLabel } from '../../utils/celeryQueueLabels'

export { formatQueueLabel } from '../../utils/celeryQueueLabels'

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
  const label = formatQueueLabel(queueName)
  if (covered) {
    return {
      lamp: 'green',
      title: `At least one worker consumes “${label}” (${queueName})`,
    }
  }
  return {
    lamp: 'yellow',
    title: `No worker in this snapshot consumes “${label}” (${queueName})`,
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

/** Matches job queues toolbar — circle + X (purge failed rows, not retry). */
function TopQueueDeleteFailedIcon({ size = TOP_Q_ICON_PX }: { size?: number }) {
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
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  )
}

/** Clock in circle — delete all pending rows (distinct from running bars icon). */
function TopQueueDeletePendingIcon({ size = TOP_Q_ICON_PX }: { size?: number }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
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
  /** Permanently delete all pending rows for this queue slice (PostgreSQL). */
  onDeletePending: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
  /** Permanently delete all failed rows for this queue slice (PostgreSQL). */
  onDeleteFailed: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
  onResetFailed: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
  /** Switch to Queues & Instances tab and select the profile tab for this Celery queue name. */
  onNavigateToJobQueue?: (celeryQueue: string) => void
  /** Same tab + set status filter to Pending / Running / Done / Failed. */
  onNavigateToJobQueueStatus?: (
    celeryQueue: string,
    status: 'pending' | 'running' | 'done' | 'failed',
  ) => void
  /** Status lamp: Console & Runtime tab → Console (worker for this queue, else broker). */
  onNavigateQueueCoverageConsole?: (celeryQueue: string) => void
  /** Totals row Status lamp: same tab → Broker console (aggregate). */
  onNavigateAggregateCoverageConsole?: () => void
  /** When set, highlights the data row for this Celery queue name (Worker Instances filter). */
  highlightQueueName?: string | null
  /** Open Support Tasks tab and filter Task registry + Queue kind matrix by this broker queue key. */
  onOpenSupportTasksFilter?: (brokerQueueKey: string) => void
  /** Broker key when Support Tasks filter is active (highlights matching Queue summary filter icon). */
  activeSupportTasksFilterKey?: string | null
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
  onDeletePending,
  onDeleteFailed,
  onResetFailed,
  onNavigateToJobQueue,
  onNavigateToJobQueueStatus,
  onNavigateQueueCoverageConsole,
  onNavigateAggregateCoverageConsole,
  highlightQueueName = null,
  onOpenSupportTasksFilter,
  activeSupportTasksFilterKey = null,
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
        <InfoTooltip text="Broker: Redis LLEN (pending messages) and Celery inspect counts (active + reserved for this routing key). PostgreSQL: job table rows by status per Celery queue (GET /ops/jobs/queues/summary). Extra Redis LIST keys appear as broker-only rows until listed in worker profiles. Click a queue name to open the Queues & Instances tab for that queue and filter Worker Instances to profiles that consume this queue. Click Pending / Running / Done / Failed to open the job list with that status filter (same instance filter). Alt+click the same cell to open the Console & Runtime tab → Console for that queue (worker if any consumes it, else broker). Click the Status lamp for the same Console shortcut." />
      </h3>
      <p className="dashboard-empty-hint" style={{ marginTop: '0.25rem', marginBottom: 'var(--space-2)' }}>
        Queue column shows the same display names as Support Tasks (e.g. Massive options). Hover a cell for the Redis list key. Use the filter icon beside a queue name to open Support Tasks and filter Task registry and Queue kind / mode by that queue; click the same icon again to clear the filter.
      </p>
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
                <th style={{ width: 36 }}>
                  Status
                  <InfoTooltip text="Queue consumer coverage (Celery inspect). Click a row lamp to open the Console & Runtime tab → Console for that queue (worker that consumes it, else broker). Click the totals lamp for the broker console." />
                </th>
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
                  <InfoTooltip text="PostgreSQL job rows with status pending for this queue slice. Click: job list filter. Alt+click: Console & Runtime tab → Console for this queue." />
                </th>
                <th>
                  Running
                  <InfoTooltip text="PostgreSQL job rows with status running for this queue slice. Click: job list filter. Alt+click: Console & Runtime tab → Console for this queue." />
                </th>
                <th>
                  Done
                  <InfoTooltip text="PostgreSQL job rows with status done for this queue slice. Click: job list filter. Alt+click: Console & Runtime tab → Console for this queue." />
                </th>
                <th>
                  Failed
                  <InfoTooltip text="PostgreSQL job rows with status failed for this queue slice. Click: job list filter. Alt+click: Console & Runtime tab → Console for this queue." />
                </th>
                <th scope="col">
                  Actions
                  <InfoTooltip text="Delete pending (clock): remove pending rows. Clear done (trash): delete done rows. Delete failed (circle with X): permanently remove failed rows. Reset failed (arrows): re-queue failed jobs as pending." />
                </th>
              </tr>
            </thead>
            <tbody>
              {merged.map(({ qs, agg }) => {
                const qCov = queueCoverageLamp(qs.name, brokerConnected, workers)
                return (
                  <tr
                    key={qs.name}
                    className={
                      highlightQueueName != null && highlightQueueName === qs.name
                        ? 'dashboard-queue-summary-row--worker-filter'
                        : undefined
                    }
                  >
                    <td>
                      {onNavigateQueueCoverageConsole ? (
                        <button
                          type="button"
                          className={`dashboard-queue-summary-status-console-nav title-inline-lamp lamp-icon ${qCov.lamp}`}
                          title={`${qCov.title} — Open Console & Runtime tab → Console for this queue`}
                          aria-label={`Open console for queue ${qs.name}: ${qCov.title}`}
                          onClick={() => onNavigateQueueCoverageConsole(qs.name)}
                        >
                          <span aria-hidden>●</span>
                        </button>
                      ) : (
                        <span
                          className={`title-inline-lamp lamp-icon ${qCov.lamp}`}
                          title={qCov.title}
                          aria-label={qCov.title}
                          role="img"
                        >
                          <span aria-hidden>●</span>
                        </span>
                      )}
                    </td>
                    <td title={opsHostEnvPillTitle}>
                      <OpsHostEnvPillBadge pill={opsHostEnvPill} className="dashboard-celery-env-pill" />
                    </td>
                    <td>
                      <span className="dashboard-queue-summary-queue-cell">
                        {onNavigateToJobQueue ? (
                          <button
                            type="button"
                            className="dashboard-queue-summary-queue-nav"
                            title="Open Queues & Instances tab for this queue"
                            aria-label={`Open Queues & Instances tab for queue ${qs.name}`}
                            onClick={() => onNavigateToJobQueue(qs.name)}
                          >
                            <code className="dashboard-queue-name" title={brokerQueueKeyTitle(qs.name)}>
                              {formatQueueLabel(qs.name)}
                            </code>
                            {qs.db_totals_shared ? (
                              <span
                                className="dashboard-queue-shared-mark"
                                title="Broker/Celery inspect columns may mirror shared Massive aggregates from Ops; PostgreSQL columns are per-queue."
                              >
                                {' '}
                                *
                              </span>
                            ) : null}
                          </button>
                        ) : (
                          <>
                            <code className="dashboard-queue-name" title={brokerQueueKeyTitle(qs.name)}>
                              {formatQueueLabel(qs.name)}
                            </code>
                            {qs.db_totals_shared ? (
                              <span
                                className="dashboard-queue-shared-mark"
                                title="Broker/Celery inspect columns may mirror shared Massive aggregates from Ops; PostgreSQL columns are per-queue."
                              >
                                {' '}
                                *
                              </span>
                            ) : null}
                          </>
                        )}
                        {onOpenSupportTasksFilter ? (
                          <button
                            type="button"
                            className={
                              activeSupportTasksFilterKey === qs.name
                                ? 'dashboard-queue-summary-support-filter dashboard-queue-summary-support-filter--active'
                                : 'dashboard-queue-summary-support-filter'
                            }
                            title="Open Support Tasks and filter by this queue; click again to clear filter"
                            aria-label={`Filter Support Tasks by ${formatQueueLabel(qs.name)}; click again to clear`}
                            onClick={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              onOpenSupportTasksFilter(qs.name)
                            }}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width={14}
                              height={14}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                            </svg>
                          </button>
                        ) : null}
                      </span>
                    </td>
                    <td>{loading ? '…' : fmtQueueCell(qs.pending_broker)}</td>
                    <td>{loading ? '…' : fmtQueueCell(qs.running_celery)}</td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--pending">
                      {loading ? (
                        '…'
                      ) : agg && onNavigateToJobQueueStatus ? (
                        <button
                          type="button"
                          className="dashboard-queue-summary-pg-nav"
                          title="Open Queues & Instances: Pending filter (Alt+click: Console for this queue)"
                          aria-label="Open Queues & Instances with Pending status filter"
                          onClick={e => {
                            if (e.altKey && onNavigateQueueCoverageConsole) {
                              e.preventDefault()
                              onNavigateQueueCoverageConsole(agg.celery_queue)
                              return
                            }
                            onNavigateToJobQueueStatus(agg.celery_queue, 'pending')
                          }}
                        >
                          {fmtQueueCell(agg.counts.pending)}
                        </button>
                      ) : (
                        (agg ? fmtQueueCell(agg.counts.pending) : '—')
                      )}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--running">
                      {loading ? (
                        '…'
                      ) : agg && onNavigateToJobQueueStatus ? (
                        <button
                          type="button"
                          className="dashboard-queue-summary-pg-nav"
                          title="Open Queues & Instances: Running filter (Alt+click: Console for this queue)"
                          aria-label="Open Queues & Instances with Running status filter"
                          onClick={e => {
                            if (e.altKey && onNavigateQueueCoverageConsole) {
                              e.preventDefault()
                              onNavigateQueueCoverageConsole(agg.celery_queue)
                              return
                            }
                            onNavigateToJobQueueStatus(agg.celery_queue, 'running')
                          }}
                        >
                          {fmtQueueCell(agg.counts.running)}
                        </button>
                      ) : (
                        (agg ? fmtQueueCell(agg.counts.running) : '—')
                      )}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--done">
                      {loading ? (
                        '…'
                      ) : agg && onNavigateToJobQueueStatus ? (
                        <button
                          type="button"
                          className="dashboard-queue-summary-pg-nav"
                          title="Open Queues & Instances: Done filter (Alt+click: Console for this queue)"
                          aria-label="Open Queues & Instances with Done status filter"
                          onClick={e => {
                            if (e.altKey && onNavigateQueueCoverageConsole) {
                              e.preventDefault()
                              onNavigateQueueCoverageConsole(agg.celery_queue)
                              return
                            }
                            onNavigateToJobQueueStatus(agg.celery_queue, 'done')
                          }}
                        >
                          {fmtQueueCell(agg.counts.done)}
                        </button>
                      ) : (
                        (agg ? fmtQueueCell(agg.counts.done) : '—')
                      )}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-pg dashboard-celery-top-queue-summary-pg--failed">
                      {loading ? (
                        '…'
                      ) : agg && onNavigateToJobQueueStatus ? (
                        <button
                          type="button"
                          className="dashboard-queue-summary-pg-nav"
                          title="Open Queues & Instances: Failed filter (Alt+click: Console for this queue)"
                          aria-label="Open Queues & Instances with Failed status filter"
                          onClick={e => {
                            if (e.altKey && onNavigateQueueCoverageConsole) {
                              e.preventDefault()
                              onNavigateQueueCoverageConsole(agg.celery_queue)
                              return
                            }
                            onNavigateToJobQueueStatus(agg.celery_queue, 'failed')
                          }}
                        >
                          {fmtQueueCell(agg.counts.failed)}
                        </button>
                      ) : (
                        (agg ? fmtQueueCell(agg.counts.failed) : '—')
                      )}
                    </td>
                    <td className="dashboard-celery-top-queue-summary-actions">
                      {agg ? (
                        <div className="dashboard-celery-top-queue-summary-action-icons">
                          <button
                            type="button"
                            className="celery-queue-icon-btn celery-queue-icon-btn--delete-pending"
                            title="Permanently delete all rows with status pending for this queue (PostgreSQL)"
                            aria-label="Delete pending jobs for this queue"
                            disabled={
                              loading ||
                              actionBusyQueue === agg.celery_queue ||
                              agg.counts.pending === 0
                            }
                            onClick={() => void onDeletePending(agg)}
                          >
                            <TopQueueDeletePendingIcon />
                          </button>
                          <button
                            type="button"
                            className="celery-queue-icon-btn celery-queue-icon-btn--delete-done"
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
                            className="celery-queue-icon-btn celery-queue-icon-btn--delete-failed"
                            title="Permanently delete all rows with status failed for this queue (PostgreSQL)"
                            aria-label="Delete failed jobs for this queue"
                            disabled={
                              loading ||
                              actionBusyQueue === agg.celery_queue ||
                              agg.counts.failed === 0
                            }
                            onClick={() => void onDeleteFailed(agg)}
                          >
                            <TopQueueDeleteFailedIcon />
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
                    {onNavigateAggregateCoverageConsole ? (
                      <button
                        type="button"
                        className={`dashboard-queue-summary-status-console-nav title-inline-lamp lamp-icon ${runtimeCeleryLamp}`}
                        title={`${runtimeCeleryStatusText} — Open Console & Runtime tab → Broker console`}
                        aria-label={`Open broker console: ${runtimeCeleryStatusText}`}
                        onClick={() => onNavigateAggregateCoverageConsole()}
                      >
                        <span aria-hidden>●</span>
                      </button>
                    ) : (
                      <span
                        className={`title-inline-lamp lamp-icon ${runtimeCeleryLamp}`}
                        title={runtimeCeleryStatusText}
                        aria-label={runtimeCeleryStatusText}
                        role="img"
                      >
                        <span aria-hidden>●</span>
                      </span>
                    )}
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
