import type { MarketIngestServiceRow } from '../api/ops/ops'

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
