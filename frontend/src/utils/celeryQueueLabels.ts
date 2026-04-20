/**
 * Celery broker queue: Redis LIST key (celery -Q) ↔ human label used across Settings → Celery.
 * Keys must stay stable for workers; authoritative labels come from GET /ops/celery/capabilities
 * (``broker_queue_labels`` from ``ops.celery.broker_queue_display_names`` in config.yaml).
 */

/** IB historical bars backfill (job_bars_backfill). */
export const BROKER_QUEUE_STOCKS_IB = 'stocks_ib' as const
/** Default Massive/Polygon options pipeline. */
export const BROKER_QUEUE_OPTIONS_MASSIVE = 'options_massive' as const
/** High-priority Massive options queue. */
export const BROKER_QUEUE_OPTIONS_MASSIVE_HIGH = 'options_massive_high' as const
/** Massive stocks / reference pipeline. */
export const BROKER_QUEUE_STOCKS_MASSIVE = 'stocks_massive' as const
export const BROKER_QUEUE_STOCKS_MASSIVE_HIGH = 'stocks_massive_high' as const

/** Set by Settings → Celery after GET /ops/celery/capabilities (``broker_queue_labels``). */
let brokerQueueLabelsFromApi: Record<string, string> | null = null

/** Call when Celery capabilities load so labels match config without redeploying the SPA. */
export function setBrokerQueueLabelsFromApi(labels: Record<string, string> | undefined | null): void {
  if (labels && typeof labels === 'object' && Object.keys(labels).length > 0) {
    brokerQueueLabelsFromApi = { ...labels }
  } else {
    brokerQueueLabelsFromApi = null
  }
}

/** Human-readable label for a broker queue key (Queue summary, Support Tasks, worker badges). */
export function formatQueueLabel(brokerKey: string): string {
  const k = (brokerKey || '').trim()
  const fromApi = brokerQueueLabelsFromApi?.[k]
  if (fromApi) return fromApi
  if (k === BROKER_QUEUE_STOCKS_IB) return 'Stocks IB'
  if (k === BROKER_QUEUE_OPTIONS_MASSIVE) return 'Options Massive'
  if (k === BROKER_QUEUE_OPTIONS_MASSIVE_HIGH) return 'Massive Options (H)'
  if (k === BROKER_QUEUE_STOCKS_MASSIVE) return 'Stocks Massive'
  if (k === BROKER_QUEUE_STOCKS_MASSIVE_HIGH) return 'Stocks Massive (H)'
  return k
}

/** Tooltip: show Redis key for operators while visible text stays the label. */
export function brokerQueueKeyTitle(brokerKey: string): string {
  return `Redis list key: ${brokerKey}`
}
