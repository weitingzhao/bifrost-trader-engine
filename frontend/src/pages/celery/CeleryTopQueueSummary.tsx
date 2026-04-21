import { useMemo, useState } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import type { AggregatedJobQueueSummaryRow } from '../../api'
import type { QueueSummaryRow, WorkerSummary } from '../../api/ops/ops'
import { dedupedQueueSummaryTotals } from '../../utils/celeryRuntime'
import { brokerQueueKeyTitle, formatQueueLabel } from '../../utils/celeryQueueLabels'
import {
  CeleryQueueDeleteFailedIcon,
  CeleryQueueDeletePendingIcon,
  CeleryQueueDeleteRunningIcon,
  CeleryQueueRefreshIcon,
  CeleryQueueTrashIcon,
} from './celeryBulkDeleteIcons'

export { formatQueueLabel } from '../../utils/celeryQueueLabels'

type LampColor = 'green' | 'yellow' | 'red' | 'none'

function queueSummaryDisplayName(qs: QueueSummaryRow): string {
  const d = qs.display_name?.trim()
  if (d) return d
  return formatQueueLabel(qs.name)
}

/** Per-queue consumer coverage (Celery inspect + broker). */
function queueCoverageLamp(
  queueName: string,
  brokerConnected: boolean | undefined,
  workerList: WorkerSummary[],
  displayLabel?: string,
): { lamp: LampColor; title: string } {
  if (brokerConnected !== true) {
    return { lamp: 'red', title: 'Broker not connected' }
  }
  const covered = workerList.some(w => (w.queues ?? []).includes(queueName))
  const label = (displayLabel && displayLabel.trim()) || formatQueueLabel(queueName)
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

/** Which PG column the user last clicked — drives the single visible action button (default: pending delete). */
type QueueActionMode = 'pending' | 'running' | 'done' | 'failed'

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
  runtimeCeleryLamp: LampColor
  runtimeCeleryStatusText: string
  onClearDone: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
  /** Permanently delete all pending rows for this queue slice (PostgreSQL). */
  onDeletePending: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
  /** Permanently delete all running rows for this queue slice (same as Queues toolbar). */
  onDeleteRunning: (row: AggregatedJobQueueSummaryRow) => void | Promise<void>
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
  /** Totals row: clear Worker Instances queue filter and show all systemd units (same as filter bar “Show all”). */
  onTotalsRowClearWorkerFilter?: () => void
  /** Open Support Tasks tab and filter Task registry + Queue kind matrix by this broker queue key. */
  onOpenSupportTasksFilter?: (brokerQueueKey: string) => void
  /** Broker key when Support Tasks filter is active (highlights matching Queue summary filter icon). */
  activeSupportTasksFilterKey?: string | null
}

/**
 * Merged broker snapshot (Redis LLEN, Celery active/reserved from Ops) + PostgreSQL job counts
 * per queue (GET /ops/jobs/queues/summary). Shown above all Celery main tabs.
 * St. column: per-queue consumer lamp only (broker-wide; not Dev/Prod). R/C = Redis/Celery counts. PG columns P/R/D/F.
 * Actions: one icon by default (delete pending); click a PG count to switch action.
 */
export function CeleryTopQueueSummary({
  queueSummary,
  queueSummaryDb,
  aggregatedRows,
  loading,
  actionBusyQueue,
  workers,
  brokerConnected,
  runtimeCeleryLamp,
  runtimeCeleryStatusText,
  onClearDone,
  onDeletePending,
  onDeleteRunning,
  onDeleteFailed,
  onResetFailed,
  onNavigateToJobQueue,
  onNavigateToJobQueueStatus,
  onNavigateQueueCoverageConsole,
  onNavigateAggregateCoverageConsole,
  highlightQueueName = null,
  onTotalsRowClearWorkerFilter,
  onOpenSupportTasksFilter,
  activeSupportTasksFilterKey = null,
}: CeleryTopQueueSummaryProps) {
  const [actionModeByQueue, setActionModeByQueue] = useState<Record<string, QueueActionMode>>({})

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
        <InfoTooltip text="R/C = Redis LLEN / Celery inspect (active + reserved). P/R/D/F = PostgreSQL job rows. If PostgreSQL P is non-zero but Redis R is 0, tasks may not be on the broker (stuck rows, deduplicated enqueue, or wrong Redis). St. = consumer status (lamp yellow if no worker in this snapshot consumes that queue). Dev vs Prod worker counts: Worker instance situation next to this table. Click a queue name or PG cell filters Worker Instances; click Total to show all instances. Default action: delete pending. Click a PG count to switch the action icon." />
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
                <th
                  className="dashboard-queue-summary-th-coverage"
                  title="Consumer status — whether any worker in the current snapshot consumes this queue (click lamp for console)"
                >
                  St.
                </th>
                <th scope="col">Queue</th>
                <th scope="col" className="dashboard-queue-summary-th-rc" title="Redis LLEN / Celery inspect (active + reserved)">
                  R/C
                </th>
                <th scope="col" className="dashboard-queue-summary-th-pg" title="PostgreSQL pending">
                  P
                </th>
                <th scope="col" className="dashboard-queue-summary-th-pg" title="PostgreSQL running">
                  R
                </th>
                <th scope="col" className="dashboard-queue-summary-th-pg" title="PostgreSQL done">
                  D
                </th>
                <th scope="col" className="dashboard-queue-summary-th-pg" title="PostgreSQL failed">
                  F
                </th>
                <th scope="col" title="One action at a time; click P/R/D/F to switch">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {merged.map(({ qs, agg }) => {
                const qCov = queueCoverageLamp(qs.name, brokerConnected, workers, qs.display_name)
                return (
                  <tr
                    key={qs.name}
                    className={
                      highlightQueueName != null && highlightQueueName === qs.name
                        ? 'dashboard-queue-summary-row--worker-filter'
                        : undefined
                    }
                  >
                    <td className="dashboard-queue-summary-coverage-cell">
                      <div className="dashboard-queue-summary-coverage-inner">
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
                      </div>
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
                              {queueSummaryDisplayName(qs)}
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
                              {queueSummaryDisplayName(qs)}
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
                            aria-label={`Filter Support Tasks by ${queueSummaryDisplayName(qs)}; click again to clear`}
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
                    <td
                      className="dashboard-queue-summary-rc-cell"
                      title="Redis (broker LLEN) / Celery (inspect active + reserved)"
                    >
                      {loading
                        ? '…'
                        : `${fmtQueueCell(qs.pending_broker)}/${fmtQueueCell(qs.running_celery)}`}
                    </td>
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
                            setActionModeByQueue(prev => ({ ...prev, [agg.celery_queue]: 'pending' }))
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
                            setActionModeByQueue(prev => ({ ...prev, [agg.celery_queue]: 'running' }))
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
                            setActionModeByQueue(prev => ({ ...prev, [agg.celery_queue]: 'done' }))
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
                            setActionModeByQueue(prev => ({ ...prev, [agg.celery_queue]: 'failed' }))
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
                      {agg ? (() => {
                        const qKey = agg.celery_queue
                        const mode: QueueActionMode = actionModeByQueue[qKey] ?? 'pending'
                        const busy = loading || actionBusyQueue === qKey
                        if (mode === 'running') {
                          return (
                            <div className="dashboard-celery-top-queue-summary-action-icons">
                              <button
                                type="button"
                                className="celery-queue-icon-btn celery-queue-icon-btn--delete-running"
                                title="Delete all jobs with status running in this queue slice"
                                aria-label="Delete all jobs with status running in this queue slice"
                                disabled={busy}
                                onClick={() => void onDeleteRunning(agg)}
                              >
                                <CeleryQueueDeleteRunningIcon />
                              </button>
                            </div>
                          )
                        }
                        if (mode === 'done') {
                          return (
                            <div className="dashboard-celery-top-queue-summary-action-icons">
                              <button
                                type="button"
                                className="celery-queue-icon-btn celery-queue-icon-btn--delete-done"
                                title="Delete all jobs with status done in this queue slice"
                                aria-label="Delete all jobs with status done in this queue slice"
                                disabled={busy}
                                onClick={() => void onClearDone(agg)}
                              >
                                <CeleryQueueTrashIcon />
                              </button>
                            </div>
                          )
                        }
                        if (mode === 'failed') {
                          return (
                            <div className="dashboard-celery-top-queue-summary-action-icons">
                              <button
                                type="button"
                                className="celery-queue-icon-btn celery-queue-icon-btn--delete-failed"
                                title="Delete all jobs with status failed in this queue slice"
                                aria-label="Delete all jobs with status failed in this queue slice"
                                disabled={busy}
                                onClick={() => void onDeleteFailed(agg)}
                              >
                                <CeleryQueueDeleteFailedIcon />
                              </button>
                              <button
                                type="button"
                                className="celery-queue-icon-btn celery-queue-icon-btn--refresh"
                                title="Reset up to 500 oldest failed jobs to pending and re-queue Celery"
                                aria-label="Reset failed jobs for this queue"
                                disabled={busy}
                                onClick={() => void onResetFailed(agg)}
                              >
                                <CeleryQueueRefreshIcon />
                              </button>
                            </div>
                          )
                        }
                        return (
                          <div className="dashboard-celery-top-queue-summary-action-icons">
                            <button
                              type="button"
                              className="celery-queue-icon-btn celery-queue-icon-btn--delete-pending"
                              title="Delete all jobs with status pending in this queue slice"
                              aria-label="Delete all jobs with status pending in this queue slice"
                              disabled={busy}
                              onClick={() => void onDeletePending(agg)}
                            >
                              <CeleryQueueDeletePendingIcon />
                            </button>
                          </div>
                        )
                      })() : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
              {merged.length > 0 ? (
                <tr className="dashboard-queue-summary-totals-row">
                  <td className="dashboard-queue-summary-coverage-cell">
                    <div className="dashboard-queue-summary-coverage-inner">
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
                    </div>
                  </td>
                  <td>
                    {onTotalsRowClearWorkerFilter ? (
                      <button
                        type="button"
                        className="dashboard-queue-summary-totals-queue-clear"
                        title="Show all worker instances (clear queue filter)"
                        aria-label="Show all worker instances, clear queue filter"
                        onClick={() => onTotalsRowClearWorkerFilter()}
                      >
                        <strong>Total</strong>
                      </button>
                    ) : (
                      <strong>Total</strong>
                    )}
                  </td>
                  <td className="dashboard-queue-summary-rc-cell" title="Redis / Celery (deduped totals)">
                    {`${fmtQueueCell(totalsBroker?.pending_broker ?? null)}/${fmtQueueCell(totalsBroker?.running_celery ?? null)}`}
                  </td>
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
