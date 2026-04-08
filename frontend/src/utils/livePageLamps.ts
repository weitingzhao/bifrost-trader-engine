import type { RealtimeQuote, StatusResponse } from '../types'
import { ingestRedisTruthyConnected } from './socketIngestLamp'

/** Quote age threshold for treating Market Streams as live (same as Live page). */
const RECENT_QUOTE_MAX_AGE_S = 60

/** Open Orders section: green after a successful GET /open-orders within this window. */
export const OPEN_ORDERS_POLL_FRESH_MAX_S = 30

/**
 * Market Streams section: green when Monitor reports Redis quotes reader + IB ingestor OK,
 * or when we have at least one quote updated within RECENT_QUOTE_MAX_AGE_S.
 */
export function computeMarketStreamsOk(
  status: StatusResponse | null | undefined,
  quotesMap: Record<string, RealtimeQuote>,
): boolean {
  const j = status
  const now = Date.now() / 1000
  const hasRecentQuotes = Object.values(quotesMap).some(
    (q) => q.ts != null && now - q.ts < RECENT_QUOTE_MAX_AGE_S,
  )
  return (
    (j?.market_data?.quotes_redis_reader_ok === true &&
      ingestRedisTruthyConnected(j?.socket?.ib_ingestor?.connected)) ||
    hasRecentQuotes
  )
}

/** Open Orders section: true when last successful DB poll timestamp (unix s) is within OPEN_ORDERS_POLL_FRESH_MAX_S. */
export function computeOpenOrdersSectionOk(openOrdersPollAtUnixSec: number | null): boolean {
  if (openOrdersPollAtUnixSec == null) return false
  return Date.now() / 1000 - openOrdersPollAtUnixSec < OPEN_ORDERS_POLL_FRESH_MAX_S
}

/** Live nav lamp: all sections with lamps must be OK (Market Streams + Open Orders). */
export function aggregateLiveNavLamp(streamsOk: boolean, openOrdersOk: boolean): 'green' | 'red' {
  return streamsOk && openOrdersOk ? 'green' : 'red'
}
