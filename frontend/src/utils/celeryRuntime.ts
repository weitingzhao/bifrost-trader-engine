/**
 * Celery runtime lamp + queue totals — aligned with Dashboard Runtime Snapshot / Ops API.
 * Supported queue names mirror backend.ops.services.worker_state.SUPPORTED_CELERY_QUEUES.
 * Options: massive / massive_high. Stock reference: massive_stocks / massive_stocks_high.
 */

import type { QueueSummaryRow, WorkerSummary } from '../api/ops/ops'

export const SUPPORTED_CELERY_QUEUE_NAMES = [
  'bars',
  'massive_stocks_high',
  'massive_stocks',
  'massive_high',
  'massive',
] as const

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

const MASSIVE_LIKE_QUEUE_NAMES = [
  'massive',
  'massive_high',
  'massive_stocks',
  'massive_stocks_high',
] as const

/**
 * Bars + all Massive-like broker stats; DB done/failed from one Massive row (shared job table — see Ops note).
 */
export function dedupedQueueSummaryTotals(rows: QueueSummaryRow[]): {
  pending_broker: number | null
  running_celery: number | null
  done_db: number | null
  failed_db: number | null
} {
  const bars = rows.find(r => r.name === 'bars')
  const massivePrimary =
    rows.find(r => r.name === 'massive') ??
    rows.find(r => MASSIVE_LIKE_QUEUE_NAMES.includes(r.name as (typeof MASSIVE_LIKE_QUEUE_NAMES)[number]))
  const massiveLikeRows = MASSIVE_LIKE_QUEUE_NAMES.map(n => rows.find(r => r.name === n)).filter(
    (x): x is QueueSummaryRow => x != null,
  )
  const out = {
    pending_broker: null as number | null,
    running_celery: null as number | null,
    done_db: null as number | null,
    failed_db: null as number | null,
  }
  let pb = 0
  let pbHas = false
  let rc = 0
  let rcHas = false
  for (const row of [bars, ...massiveLikeRows]) {
    if (!row) continue
    const p = row.pending_broker
    if (p != null && Number.isFinite(p)) {
      pb += p
      pbHas = true
    }
    const r = row.running_celery
    if (r != null && Number.isFinite(r)) {
      rc += r
      rcHas = true
    }
  }
  out.pending_broker = pbHas ? pb : null
  out.running_celery = rcHas ? rc : null
  if (massivePrimary) {
    const d = massivePrimary.done_db
    const f = massivePrimary.failed_db
    out.done_db = d != null && Number.isFinite(d) ? d : null
    out.failed_db = f != null && Number.isFinite(f) ? f : null
  }
  return out
}

/** Header/sidebar badge: same as Queue summary → Pending column Total (deduped bars + massive once). */
export function celeryQueuePendingBadgeTotal(rows: QueueSummaryRow[]): number | null {
  const t = dedupedQueueSummaryTotals(rows)
  return t.pending_broker
}
