/**
 * Celery runtime lamp + queue totals — aligned with Dashboard Runtime Snapshot / Ops API.
 * Supported queue names mirror backend ``SUPPORTED_CELERY_QUEUES`` / ``CANONICAL_BROKER_QUEUE_NAMES``.
 * UI labels: ``frontend/src/utils/celeryQueueLabels.ts`` (e.g. Massive options = broker key options_massive).
 */

import type { QueueSummaryRow, WorkerSummary } from '../api/ops/ops'
import {
  BROKER_QUEUE_STOCKS_IB,
  BROKER_QUEUE_OPTIONS_MASSIVE,
  BROKER_QUEUE_OPTIONS_MASSIVE_HIGH,
  BROKER_QUEUE_STOCKS_MASSIVE,
  BROKER_QUEUE_STOCKS_MASSIVE_HIGH,
} from './celeryQueueLabels'

export const SUPPORTED_CELERY_QUEUE_NAMES = [
  BROKER_QUEUE_STOCKS_IB,
  BROKER_QUEUE_STOCKS_MASSIVE_HIGH,
  BROKER_QUEUE_STOCKS_MASSIVE,
  BROKER_QUEUE_OPTIONS_MASSIVE_HIGH,
  BROKER_QUEUE_OPTIONS_MASSIVE,
] as const

export type CeleryRuntimeLamp = 'green' | 'yellow' | 'red' | 'none'

/**
 * Queues the runtime lamp treats as required (canonical app queues).
 * Excludes Redis-discovered extras so stray broker lists do not force yellow.
 */
export function supportedQueueNamesFromSummary(_rows: QueueSummaryRow[]): string[] {
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
  BROKER_QUEUE_OPTIONS_MASSIVE,
  BROKER_QUEUE_OPTIONS_MASSIVE_HIGH,
  BROKER_QUEUE_STOCKS_MASSIVE,
  BROKER_QUEUE_STOCKS_MASSIVE_HIGH,
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
  const bars = rows.find(r => r.name === BROKER_QUEUE_STOCKS_IB)
  const massivePrimary =
    rows.find(r => r.name === BROKER_QUEUE_OPTIONS_MASSIVE) ??
    rows.find(r => MASSIVE_LIKE_QUEUE_NAMES.includes(r.name as (typeof MASSIVE_LIKE_QUEUE_NAMES)[number]))
  const out = {
    pending_broker: null as number | null,
    running_celery: null as number | null,
    done_db: null as number | null,
    failed_db: null as number | null,
  }
  let pb = 0
  let pbHas = false
  for (const row of rows) {
    const p = row.pending_broker
    if (p != null && Number.isFinite(p)) {
      pb += p
      pbHas = true
    }
  }
  out.pending_broker = pbHas ? pb : null

  let rc = 0
  let rcHas = false
  const br = bars?.running_celery
  if (br != null && Number.isFinite(br)) {
    rc += br
    rcHas = true
  }
  const massiveRun =
    rows.find(r => r.name === BROKER_QUEUE_OPTIONS_MASSIVE)?.running_celery ??
    MASSIVE_LIKE_QUEUE_NAMES.map(n => rows.find(r => r.name === n)?.running_celery).find(
      x => x != null && Number.isFinite(x as number),
    )
  if (massiveRun != null && Number.isFinite(massiveRun)) {
    rc += massiveRun
    rcHas = true
  }
  for (const row of rows) {
    if (
      row.name === BROKER_QUEUE_STOCKS_IB ||
      MASSIVE_LIKE_QUEUE_NAMES.includes(row.name as (typeof MASSIVE_LIKE_QUEUE_NAMES)[number])
    ) {
      continue
    }
    const x = row.running_celery
    if (x != null && Number.isFinite(x)) {
      rc += x
      rcHas = true
    }
  }
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
