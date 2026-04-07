import type { MarketIngestServiceRow } from '../api/ops/ops'
import type { StatusResponse } from '../types'

export type IngestLamp = 'green' | 'yellow' | 'red' | 'gray'

export type AggregateIngestLamp = IngestLamp | 'none'

export type LocalControlAgentLamp = 'green' | 'yellow' | 'red'

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
 * Lamp from Redis-backed health in Monitor GET /status (same view for Dev and Prod stacks).
 * Green when the ingest writer reports healthy in Redis; red when explicitly unhealthy; gray when unknown.
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
    if (ingestRedisTruthyConnected(aa.connected)) {
      return {
        lamp: 'green',
        title: 'IB Account Agent healthy (Redis bifrost:health:ws_ib_account_agent, connected).',
      }
    }
    return { lamp: 'red', title: 'IB Account Agent not connected (Redis bifrost:health:ws_ib_account_agent).' }
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
    if (hostUp) {
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
