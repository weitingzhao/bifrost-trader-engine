import type { RealtimeQuote, StatusResponse } from '../types'
import { ingestRedisHealthLamp, ingestRedisTruthyConnected } from './socketIngestLamp'

/** Quote age threshold for treating Market Streams as live (same as Live page). */
const RECENT_QUOTE_MAX_AGE_S = 60

/**
 * Max age (seconds) for Account Sync `last_ts` vs wall clock on the client.
 * Matches backend `get_status` heartbeat staleness (35s).
 */
export const ACCOUNT_SYNC_HEARTBEAT_MAX_AGE_S = 35

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

/** Live nav lamp: all sections with lamps must be OK (Market Streams + Open Orders). */
export function aggregateLiveNavLamp(streamsOk: boolean, openOrdersOk: boolean): 'green' | 'red' {
  return streamsOk && openOrdersOk ? 'green' : 'red'
}

/** Account Sync Daemon lamp: alive + stream lag check. */
export function computeAccountSyncLamp(
  status: StatusResponse | null | undefined,
): { lamp: 'green' | 'yellow' | 'red' | 'gray'; title: string } {
  if (!status) {
    return { lamp: 'gray', title: 'Monitor status not loaded.' }
  }
  const asd = (status as any)?.account_sync_daemon
  if (!asd || !asd.heartbeat) {
    return { lamp: 'gray', title: 'Account Sync Daemon not configured or heartbeat missing.' }
  }
  const hb = asd.heartbeat
  if (!hb.daemon_alive) {
    return { lamp: 'red', title: 'Account Sync Daemon not running or heartbeat stale.' }
  }
  if (typeof hb.stream_lag === 'number' && hb.stream_lag > 50) {
    return {
      lamp: 'yellow',
      title: `Account Sync Daemon running; stream lag high (${hb.stream_lag} pending).`,
    }
  }
  return { lamp: 'green', title: 'Account Sync Daemon healthy.' }
}

/**
 * Open Orders section lamp: `daemon_open_orders` is populated by **Account Sync Daemon** (IB stream → PostgreSQL).
 * Green when Account Sync is fully healthy (same as {@link computeAccountSyncLamp} green), and when
 * `heartbeat.last_ts` is present, it must be younger than {@link ACCOUNT_SYNC_HEARTBEAT_MAX_AGE_S} on the client
 * so the lamp can go red if status JSON is stale while the process has stopped.
 */
export function computeOpenOrdersSectionOk(
  status: StatusResponse | null | undefined,
  nowSec: number = Date.now() / 1000,
): boolean {
  const sync = computeAccountSyncLamp(status)
  if (sync.lamp !== 'green') return false
  const hb = (status as { account_sync_daemon?: { heartbeat?: { last_ts?: number | null } } })?.account_sync_daemon
    ?.heartbeat
  const lastTs = hb?.last_ts
  if (lastTs != null && Number.isFinite(Number(lastTs))) {
    if (nowSec - Number(lastTs) >= ACCOUNT_SYNC_HEARTBEAT_MAX_AGE_S) return false
  }
  return true
}

export type LiveNavLampResult = {
  lamp: 'green' | 'yellow' | 'red'
  title: string
}

/**
 * Live nav lamp: IB Broker Services health (ib_operator + ib_ingestor + ib_account_agent)
 * combined with strategy daemon liveness (legacy nav semantics; Open Orders DB sync is Account Sync Daemon).
 *
 * - green  = all IB services healthy AND daemon running
 * - yellow = IB services healthy but daemon down (market data OK; Open Orders unavailable),
 *            OR daemon up but IB partially degraded (gray/yellow, no hard red)
 * - red    = any IB service hard-down (red), OR status not loaded yet
 */
export function computeLiveNavLamp(
  status: StatusResponse | null | undefined,
  daemonAlive: boolean,
): LiveNavLampResult {
  if (!status) {
    return { lamp: 'red', title: 'Monitor status not loaded — cannot determine Live health.' }
  }

  const op = ingestRedisHealthLamp('ib_operator', status)
  const ing = ingestRedisHealthLamp('ib_ingestor', status)
  const aa = ingestRedisHealthLamp('ib_account_agent', status)
  const lamps = [op.lamp, ing.lamp, aa.lamp] as const

  const ibAllGreen = lamps.every((l) => l === 'green')
  const ibAnyRed = lamps.some((l) => l === 'red')

  const redParts: string[] = []
  if (op.lamp === 'red') redParts.push(`IB Operator: ${op.title}`)
  if (ing.lamp === 'red') redParts.push(`IB Ingestor: ${ing.title}`)
  if (aa.lamp === 'red') redParts.push(`Account Agent: ${aa.title}`)

  const degradedParts: string[] = []
  if (op.lamp !== 'green' && op.lamp !== 'red') degradedParts.push(`IB Operator: ${op.title}`)
  if (ing.lamp !== 'green' && ing.lamp !== 'red') degradedParts.push(`IB Ingestor: ${ing.title}`)
  if (aa.lamp !== 'green' && aa.lamp !== 'red') degradedParts.push(`Account Agent: ${aa.title}`)

  if (ibAnyRed) {
    const ibMsg = redParts.join(' · ')
    if (!daemonAlive) {
      return {
        lamp: 'red',
        title: `Daemon not running (Open Orders unavailable) · ${ibMsg}`,
      }
    }
    return { lamp: 'red', title: ibMsg }
  }

  if (!daemonAlive) {
    if (ibAllGreen) {
      return {
        lamp: 'yellow',
        title: 'IB services healthy · Daemon not running — Open Orders unavailable.',
      }
    }
    const msg = degradedParts.join(' · ')
    return {
      lamp: 'yellow',
      title: `Daemon not running (Open Orders unavailable) · IB degraded: ${msg}`,
    }
  }

  if (ibAllGreen) {
    return { lamp: 'green', title: 'IB Broker Services healthy · Daemon running.' }
  }

  const msg = degradedParts.join(' · ')
  return { lamp: 'yellow', title: msg || 'IB services degraded.' }
}
