import type { MarketIngestServiceRow } from '../api/ops/ops'

export type IngestLamp = 'green' | 'yellow' | 'red'

export type AggregateIngestLamp = IngestLamp | 'none'

/** Green = active; red = inactive / failed / dead; yellow = transitional, unknown, or other. */
export function ingestProcessLamp(active: string): IngestLamp {
  const a = (active || '').toLowerCase().trim()
  if (a === 'active') return 'green'
  if (a === 'inactive' || a === 'failed' || a === 'dead') return 'red'
  return 'yellow'
}

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
  return {
    lamp: 'yellow',
    title: 'At least one service is not active, or a service is starting, stopping, or in an unknown state.',
  }
}
