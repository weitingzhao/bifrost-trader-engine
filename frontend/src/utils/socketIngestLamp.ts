import type { MarketIngestServiceRow } from '../api/ops/ops'
import type { StatusResponse } from '../types'

export type IngestLamp = 'green' | 'yellow' | 'red' | 'gray'

export type AggregateIngestLamp = IngestLamp | 'none'

export type LocalControlAgentLamp = 'green' | 'yellow' | 'red'

/**
 * Ops-configured services included in the "Socket Services" Redis health aggregate (header ⋮ menu,
 * Settings → App → Socket, and Socket Services page title).
 * Excludes `trading_engine` (Daemon / strategy process) and `account_sync_daemon` (Account Sync on
 * Daemon — PostgreSQL heartbeat, not a quote/WS ingest row on this page).
 */
export function marketIngestServicesForSocketAggregate(
  services: MarketIngestServiceRow[],
): MarketIngestServiceRow[] {
  return services.filter((s) => s.id !== 'trading_engine' && s.id !== 'account_sync_daemon')
}

/**
 * JSON `connected` from Monitor may be boolean; some paths historically used 1/0 or strings.
 * Strict `=== true` misses numeric truthy and breaks Socket Services lamps.
 */
export function ingestRedisTruthyConnected(v: unknown): boolean {
  if (v === true) return true
  if (v === false || v === null || v === undefined) return false
  if (typeof v === 'number' && Number.isFinite(v)) return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === '1' || s === 'true' || s === 'yes'
  }
  return false
}

/** Yellow "waiting for IB" only when Redis health is actively updating (avoids stale service_alive default). */
const IB_OPERATOR_HEALTH_FRESH_MAX_S = 180

/** True when Monitor exposes IB probe fields and they indicate failure or staleness (zombie writer). */
export function ibSlotProbeUnhealthy(
  slot:
    | {
        ib_probe_stale?: boolean
        ib_probe_ok?: boolean
        last_ib_probe_at?: number | null
      }
    | null
    | undefined,
): boolean {
  if (!slot) return false
  if (slot.ib_probe_stale === true) return true
  if (
    typeof slot.last_ib_probe_at === 'number'
    && slot.last_ib_probe_at > 0
    && slot.ib_probe_ok === false
  ) {
    return true
  }
  return false
}

function ingestRedisExplicitlyOff(v: unknown): boolean {
  if (v === false || v === 0) return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === '0' || s === 'false' || s === 'no'
  }
  return false
}

/** Green = UDS responds; red = unreachable; yellow = probe pending / legacy health without agent_reachable. */
export function localControlAgentLamp(reachable: boolean | null | undefined): LocalControlAgentLamp {
  if (reachable === true) return 'green'
  if (reachable === false) return 'red'
  return 'yellow'
}

/** Green = active; red = inactive / failed / dead; yellow = transitional systemd states; gray = unknown / empty / unrecognized. */
export function ingestProcessLamp(active: string): IngestLamp {
  const a = (active || '').toLowerCase().trim()
  if (a === 'active') return 'green'
  if (a === 'inactive' || a === 'failed' || a === 'dead') return 'red'
  if (
    a === 'activating'
    || a === 'deactivating'
    || a === 'reloading'
    || a === 'maintenance'
    || a === 'refreshing'
  ) {
    return 'yellow'
  }
  if (a === 'unknown' || a === '') return 'gray'
  return 'gray'
}

/** Roll-up of ingest rows only. Do not pass agent status or merge with Local Control Agent. */
export function aggregateIngestServicesLamp(
  rows: { svc: MarketIngestServiceRow }[],
): { lamp: AggregateIngestLamp; title: string } {
  if (rows.length === 0) {
    return { lamp: 'none', title: 'No ingest services in Ops configuration.' }
  }
  const tiers = rows.map(r => ingestProcessLamp(r.svc.process_active))
  if (tiers.every(t => t === 'green')) {
    return { lamp: 'green', title: 'All ingest services are active.' }
  }
  if (tiers.every(t => t === 'red')) {
    return { lamp: 'red', title: 'All ingest services are inactive or failed.' }
  }
  if (tiers.every(t => t === 'gray')) {
    return {
      lamp: 'gray',
      title: 'Process state unknown for all ingest services (Ops could not resolve unit state).',
    }
  }
  if (tiers.every(t => t === 'yellow')) {
    return {
      lamp: 'yellow',
      title: 'All ingest services are in a transitional state (starting, stopping, reloading, etc.).',
    }
  }
  return {
    lamp: 'yellow',
    title:
      'Mixed or partial state: some services active, inactive, unknown, or transitional. See each row.',
  }
}

/**
 * Lamp from Redis-backed health in Monitor GET /status.
 * Same Redis is shared across Dev/Prod ingest when configured that way: if either stack runs a writer,
 * health updates — do not tie this lamp to systemd on the Ops host that served GET /ops/market-ingest/services.
 */
export function ingestRedisHealthLamp(
  serviceId: string,
  status: StatusResponse | null,
): { lamp: IngestLamp; title: string } {
  const id = serviceId === 'ib_market' ? 'ib_ingestor' : serviceId
  if (!status) {
    return { lamp: 'gray', title: 'Monitor GET /status not loaded yet.' }
  }
  if (id === 'massive_ws') {
    const m = status.socket?.massive
    if (m == null) {
      return { lamp: 'gray', title: 'Massive block missing from /status socket (Redis meta unavailable).' }
    }
    if (ingestRedisTruthyConnected(m.ws_connected)) {
      return {
        lamp: 'green',
        title: 'Massive WS ingest healthy (Redis bifrost:health:ws_massive_option, connected).',
      }
    }
    if (m.ws_connected === null || m.ws_connected === undefined) {
      return {
        lamp: 'gray',
        title: 'Massive WS not reported (no Redis URL or empty meta in /status).',
      }
    }
    return { lamp: 'red', title: 'Massive WS not connected (Redis bifrost:health:ws_massive_option).' }
  }
  if (id === 'ib_ingestor') {
    const ib = status.socket?.ib_ingestor
    if (ib == null) {
      return { lamp: 'gray', title: 'IB ingestor block missing from /status socket (Redis health unavailable).' }
    }
    if (ibSlotProbeUnhealthy(ib)) {
      return {
        lamp: 'red',
        title:
          'IB ingestor IB liveness probe stale or failed (Redis bifrost:health:ws_ib_ingestor ib_probe_*).',
      }
    }
    if (ingestRedisTruthyConnected(ib.connected)) {
      return {
        lamp: 'green',
        title: 'IB ingestor healthy (Redis bifrost:health:ws_ib_ingestor, connected).',
      }
    }
    return { lamp: 'red', title: 'IB ingestor not connected (Redis bifrost:health:ws_ib_ingestor).' }
  }
  if (id === 'ib_account_agent') {
    const aa = status.socket?.ib_account_agent
    if (aa == null) {
      return {
        lamp: 'gray',
        title: 'IB Account Agent block missing from /status socket (Redis health unavailable).',
      }
    }
    // Same roll-up pattern as `ib_operator`: host slot + explicit process-alive (Redis `host_alive`).
    const hostSlotUp =
      ingestRedisTruthyConnected(aa.connected)
      || ingestRedisTruthyConnected(aa.host?.connected)
    const procDead =
      ingestRedisExplicitlyOff(aa.service_alive) || ingestRedisExplicitlyOff(aa.operator_alive)
    const hasAliveField =
      (aa.service_alive !== undefined && aa.service_alive !== null)
      || (aa.operator_alive !== undefined && aa.operator_alive !== null)
    const serviceAlive = hasAliveField
      ? (ingestRedisTruthyConnected(aa.service_alive) || ingestRedisTruthyConnected(aa.operator_alive))
      : true
    const secConfigured = aa.secondary !== undefined && aa.secondary !== null
    const secUp = ingestRedisTruthyConnected(aa.secondary?.connected)
    const lastAge = aa.last_msg_age_s
    const healthFresh =
      lastAge != null
      && typeof lastAge === 'number'
      && Number.isFinite(lastAge)
      && lastAge <= IB_OPERATOR_HEALTH_FRESH_MAX_S
    const hostUp = hostSlotUp && !procDead
    if (ibSlotProbeUnhealthy(aa.host)) {
      return {
        lamp: 'red',
        title:
          'IB Account Agent Host IB probe stale or failed (Redis bifrost:health:ws_ib_account_agent host_ib_probe_*).',
      }
    }
    if (hostUp) {
      if (secConfigured && ibSlotProbeUnhealthy(aa.secondary)) {
        return {
          lamp: 'yellow',
          title:
            'IB Account Agent Secondary IB probe stale or failed (Redis bifrost:health:ws_ib_account_agent).',
        }
      }
      if (secConfigured && !secUp) {
        return {
          lamp: 'yellow',
          title:
            'IB Account Agent Host connected; Secondary not connected (Redis bifrost:health:ws_ib_account_agent).',
        }
      }
      return {
        lamp: 'green',
        title: 'IB Account Agent healthy (Host + Secondary if configured; Redis ws_ib_account_agent).',
      }
    }
    if (procDead) {
      return {
        lamp: 'red',
        title:
          'IB Account Agent process reports stopped (Redis host_alive / service_alive); Host slot not in service.',
      }
    }
    if (serviceAlive && !hostSlotUp && healthFresh) {
      return {
        lamp: 'yellow',
        title:
          'IB Account Agent process is running; IB Host not connected yet (Redis bifrost:health:ws_ib_account_agent). Green when Host connects.',
      }
    }
    if (serviceAlive && !hostSlotUp && !healthFresh) {
      return {
        lamp: 'red',
        title:
          'IB Account Agent Host not connected; Redis health is stale or missing timestamp (process may be stopped without shutdown, or not updating).',
      }
    }
    return {
      lamp: 'red',
      title: 'IB Account Agent Host not connected (Redis bifrost:health:ws_ib_account_agent).',
    }
  }
  if (id === 'ib_operator') {
    const mon = status.socket?.ib_operator
    if (mon == null) {
      return {
        lamp: 'gray',
        title: 'IB Operator health not in /status (socket.ib_operator missing; skip_monitor_ib or no Redis).',
      }
    }
    // Prefer top-level `connected`, fall back to `host.connected` (same roll-up as IB ingestor).
    const hostSlotUp =
      ingestRedisTruthyConnected(mon.connected) || ingestRedisTruthyConnected(mon.host?.connected)
    const procDead =
      ingestRedisExplicitlyOff(mon.service_alive) || ingestRedisExplicitlyOff(mon.operator_alive)
    const serviceAlive =
      ingestRedisTruthyConnected(mon.service_alive) || ingestRedisTruthyConnected(mon.operator_alive)
    const lastAge = mon.last_msg_age_s
    const healthFresh =
      lastAge != null
      && typeof lastAge === 'number'
      && Number.isFinite(lastAge)
      && lastAge <= IB_OPERATOR_HEALTH_FRESH_MAX_S
    const hostUp = hostSlotUp && !procDead
    if (ibSlotProbeUnhealthy(mon.host)) {
      return {
        lamp: 'red',
        title:
          'IB Operator Host IB probe stale or failed (Redis bifrost:health:ws_ib_operator host_ib_probe_*).',
      }
    }
    if (hostUp) {
      if (mon.secondary != null && ibSlotProbeUnhealthy(mon.secondary)) {
        return {
          lamp: 'yellow',
          title:
            'IB Operator Secondary IB probe stale or failed (Redis bifrost:health:ws_ib_operator).',
        }
      }
      return {
        lamp: 'green',
        title: 'IB Operator healthy (Redis bifrost:health:ws_ib_operator, same roll-up as IB ingestor).',
      }
    }
    if (procDead) {
      return {
        lamp: 'red',
        title:
          'IB Operator process reports stopped (Redis host_alive / service_alive); Host slot not in service.',
      }
    }
    if (serviceAlive && !hostSlotUp && healthFresh) {
      return {
        lamp: 'yellow',
        title:
          'IB Operator process is running; IB Host not connected yet (Redis bifrost:health:ws_ib_operator). Green when Host connects.',
      }
    }
    if (serviceAlive && !hostSlotUp && !healthFresh) {
      return {
        lamp: 'red',
        title:
          'IB Operator Host not connected; Redis health is stale or missing timestamp (process may be stopped without shutdown, or not updating).',
      }
    }
    return {
      lamp: 'red',
      title: 'IB Operator Host not connected (Redis bifrost:health:ws_ib_operator).',
    }
  }
  if (id === 'trading_engine') {
    const hb = status.daemon?.heartbeat
    if (hb == null) {
      return { lamp: 'gray', title: 'Strategy Trading Daemon heartbeat not in GET /status yet.' }
    }
    if (hb.daemon_alive === true) {
      return {
        lamp: 'green',
        title: 'Strategy Trading Daemon alive (Monitor GET /status daemon.heartbeat.daemon_alive).',
      }
    }
    if (hb.graceful_shutdown_at != null && Number.isFinite(hb.graceful_shutdown_at)) {
      return {
        lamp: 'yellow',
        title: 'Strategy Trading Daemon not running; graceful_shutdown_at set (SIGTERM or control stop).',
      }
    }
    return {
      lamp: 'red',
      title: 'Strategy Trading Daemon not running or heartbeat stale (check systemd / local process).',
    }
  }
  if (id === 'account_sync_daemon') {
    const asd = (status as { account_sync_daemon?: { heartbeat?: { daemon_alive?: boolean } } })
      .account_sync_daemon?.heartbeat
    if (asd == null) {
      return {
        lamp: 'gray',
        title: 'Account Sync Daemon block missing from GET /status (PostgreSQL heartbeat or Redis health).',
      }
    }
    if (asd.daemon_alive === true) {
      return {
        lamp: 'green',
        title: 'Account Sync Daemon alive (GET /status account_sync_daemon.heartbeat).',
      }
    }
    return {
      lamp: 'red',
      title: 'Account Sync Daemon not running or heartbeat stale (start systemd unit or run script).',
    }
  }
  return { lamp: 'gray', title: 'Unknown ingest service id for Redis health.' }
}

/** Roll-up of ingest rows using Redis health from Monitor /status (not local Ops systemd). */
export function aggregateIngestRedisHealthLamp(
  rows: { svc: MarketIngestServiceRow }[],
  status: StatusResponse | null,
): { lamp: AggregateIngestLamp; title: string } {
  if (rows.length === 0) {
    return { lamp: 'none', title: 'No ingest services in Ops configuration.' }
  }
  const tiers = rows.map(r => ingestRedisHealthLamp(r.svc.id, status).lamp)
  if (tiers.every(t => t === 'green')) {
    return {
      lamp: 'green',
      title: 'All ingest services report healthy Redis state (Monitor GET /status).',
    }
  }
  if (tiers.every(t => t === 'red')) {
    return {
      lamp: 'red',
      title: 'All ingest services report disconnected or unhealthy Redis state.',
    }
  }
  if (tiers.every(t => t === 'gray')) {
    return {
      lamp: 'gray',
      title: 'Redis health unknown for all ingest rows (/status missing or health not exposed).',
    }
  }
  if (tiers.every(t => t === 'yellow')) {
    return {
      lamp: 'yellow',
      title: 'All ingest services transitional (unexpected for Redis health mode).',
    }
  }
  return {
    lamp: 'yellow',
    title:
      'Mixed Redis health: some services healthy, disconnected, or unknown. See each row tooltip.',
  }
}

function minimalMarketIngestRowForId(id: string): MarketIngestServiceRow {
  return {
    id,
    label: '',
    systemd_unit: '',
    redis_meta_key: '',
    process_active: '',
  }
}

/** Canonical process ids on Settings → Daemon (Strategy Engine + Account Sync). */
export const DAEMON_PAGE_SERVICE_IDS = ['trading_engine', 'account_sync_daemon'] as const

/**
 * Worst-of roll-up for Daemon header when Ops service list is not loaded (e.g. App ⋮ menu).
 * Uses the same per-id rules as each row on the Daemon page (`ingestRedisHealthLamp`).
 */
export function aggregateDaemonProcessesHealthFromStatus(status: StatusResponse | null) {
  return aggregateIngestRedisHealthLamp(
    DAEMON_PAGE_SERVICE_IDS.map((id) => ({ svc: minimalMarketIngestRowForId(id) })),
    status,
  )
}
