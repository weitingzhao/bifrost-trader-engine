/**
 * Celery broker queue: Redis LIST key (celery -Q) ↔ human label used across Settings → Celery.
 * Keys must stay stable for workers; labels are the mental model in the UI (e.g. Massive options).
 */

/** Redis broker list key for the default Massive options pipeline (straddles / options jobs). */
export const BROKER_QUEUE_MASSIVE_OPTIONS = 'massive' as const
/** High-priority Massive options queue. */
export const BROKER_QUEUE_MASSIVE_OPTIONS_HIGH = 'massive_high' as const
/** Massive stocks / reference pipeline. */
export const BROKER_QUEUE_MASSIVE_STOCKS = 'massive_stocks' as const
export const BROKER_QUEUE_MASSIVE_STOCKS_HIGH = 'massive_stocks_high' as const
export const BROKER_QUEUE_BARS = 'bars' as const

/** Human-readable label for a broker queue key (Queue summary, Support Tasks, worker badges). */
export function formatQueueLabel(brokerKey: string): string {
  const k = (brokerKey || '').trim()
  if (k === BROKER_QUEUE_MASSIVE_STOCKS_HIGH) return 'Massive stocks (high priority)'
  if (k === BROKER_QUEUE_MASSIVE_STOCKS) return 'Massive stocks'
  if (k === BROKER_QUEUE_MASSIVE_OPTIONS_HIGH) return 'Massive options (high priority)'
  if (k === BROKER_QUEUE_MASSIVE_OPTIONS) return 'Massive options'
  if (k === BROKER_QUEUE_BARS) return 'Bars (IB)'
  return k
}

/** Tooltip: show Redis key for operators while visible text stays the label. */
export function brokerQueueKeyTitle(brokerKey: string): string {
  return `Redis list key: ${brokerKey}`
}
