/**
 * Celery runtime lamp + queue totals — aligned with Dashboard Runtime Snapshot / Ops API.
 * Supported queue names mirror backend.ops.services.worker_state.SUPPORTED_CELERY_QUEUES.
 */

import type { QueueSummaryRow, WorkerSummary } from '../api/ops/ops'

export const SUPPORTED_CELERY_QUEUE_NAMES = ['bars', 'massive_high', 'massive'] as const

export type CeleryRuntimeLamp = 'green' | 'yellow' | 'red' | 'none'

/** Queue names Ops reports in /ops/queues/summary, or defaults when the list is empty. */
export function supportedQueueNamesFromSummary(rows: QueueSummaryRow[]): string[] {
  if (rows.length > 0) return rows.map(r => r.name)
  return [...SUPPORTED_CELERY_QUEUE_NAMES]
}

export function workersCoverAllQueues(
  workers: Pick<WorkerSummary, 'queues'>[],
  required: string[],
): boolean {
  if (required.length === 0) return true
  const covered = new Set<string>()
  for (const w of workers) {
    for (const q of w.queues ?? []) {
      if (q) covered.add(q)
    }
  }
  return required.every(q => covered.has(q))
}

/**
 * Red: broker not connected.
 * Yellow: broker OK but no workers, or workers do not collectively subscribe to all supported queues.
 * Green: broker OK, at least one worker, and union of worker target queues covers every supported queue.
 */
export function computeCeleryRuntimeLamp(
  brokerConnected: boolean,
  workers: Pick<WorkerSummary, 'queues'>[],
  supportedQueueNames: string[],
): CeleryRuntimeLamp {
  if (!brokerConnected) return 'red'
  if (workers.length === 0) return 'yellow'
  if (!workersCoverAllQueues(workers, supportedQueueNames)) return 'yellow'
  return 'green'
}

/**
 * Bars + one Massive row only — massive_high shares the same DB totals as massive (see Ops note).
 */
export function dedupedQueueSummaryTotals(rows: QueueSummaryRow[]): {
  pending_broker: number | null
  running_celery: number | null
  done_db: number | null
  failed_db: number | null
} {
  const bars = rows.find(r => r.name === 'bars')
  const massive = rows.find(r => r.name === 'massive')
  const fields = ['pending_broker', 'running_celery', 'done_db', 'failed_db'] as const
  const out = {
    pending_broker: null as number | null,
    running_celery: null as number | null,
    done_db: null as number | null,
    failed_db: null as number | null,
  }
  for (const f of fields) {
    let sum = 0
    let has = false
    for (const row of [bars, massive]) {
      if (!row) continue
      const v = row[f]
      if (v != null && Number.isFinite(v)) {
        sum += v
        has = true
      }
    }
    out[f] = has ? sum : null
  }
  return out
}

/** Header/sidebar badge: same as Queue summary → Pending column Total (deduped bars + massive once). */
export function celeryQueuePendingBadgeTotal(rows: QueueSummaryRow[]): number | null {
  const t = dedupedQueueSummaryTotals(rows)
  return t.pending_broker
}
