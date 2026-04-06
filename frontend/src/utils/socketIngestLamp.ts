import type { MarketIngestServiceRow } from '../api/ops/ops'
import type { StatusResponse } from '../types'

export type IngestLamp = 'green' | 'yellow' | 'red' | 'gray'

export type AggregateIngestLamp = IngestLamp | 'none'

export type LocalControlAgentLamp = 'green' | 'yellow' | 'red'

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
    if (m.ws_connected === true) {
      return {
        lamp: 'green',
        title: 'Massive WS ingest healthy (Redis massive:meta:status, connected).',
      }
    }
    if (m.ws_connected === null || m.ws_connected === undefined) {
      return {
        lamp: 'gray',
        title: 'Massive WS not reported (no Redis URL or empty meta in /status).',
      }
    }
    return { lamp: 'red', title: 'Massive WS not connected (Redis massive:meta:status).' }
  }
  if (id === 'ib_ingestor') {
    const ib = status.socket?.ib_ingestor
    if (ib == null) {
      return { lamp: 'gray', title: 'IB ingestor block missing from /status socket (Redis health unavailable).' }
    }
    if (ib.connected === true) {
      return {
        lamp: 'green',
        title: 'IB ingestor healthy (Redis ib:ingester:meta:health, connected).',
      }
    }
    return { lamp: 'red', title: 'IB ingestor not connected (Redis ib:ingester:meta:health).' }
  }
  if (id === 'ib_operator') {
    const mon = status.socket?.ib_operator
    if (mon == null) {
      return {
        lamp: 'gray',
        title: 'IB Operator health not in /status (socket.ib_operator missing; skip_monitor_ib or no Redis).',
      }
    }
    const op = mon.host
    if (op?.connected === true) {
      return {
        lamp: 'green',
        title: 'IB Operator healthy (Redis ib:operator:meta:health, host slot).',
      }
    }
    return { lamp: 'red', title: 'IB Operator not connected (Redis host slot).' }
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
