import type { MassiveJobApiRow, TickerReferenceJobKind } from '../../api'

export const MAX_REF_JOBS_TRACKED = 20

export type RefJobTrackItem = {
  jobId: string
  kind: TickerReferenceJobKind
  deduplicated?: boolean
  status: string
  job?: MassiveJobApiRow
  streamError?: string
  enqueuedAt: number
}

export function refJobKindShortLabel(kind: TickerReferenceJobKind): string {
  switch (kind) {
    case 'ticker_reference_universe':
    case 'stock_reference_universe':
      return 'Universe'
    case 'ticker_reference_overview':
    case 'stock_reference_overview':
      return 'Overview'
    case 'ticker_reference_related':
    case 'stock_reference_related':
      return 'Related'
    case 'ticker_reference_instrument_types':
    case 'stock_reference_instrument_types':
      return 'Instrument types'
    default:
      return kind
  }
}

export function summarizeRefJobResult(job: MassiveJobApiRow | undefined): string {
  const r = job?.result as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return '—'
  if (typeof r.error === 'string') return r.error
  const summary = r.summary as Record<string, unknown> | undefined
  if (summary && typeof summary === 'object') {
    if (summary.rows_upserted != null) return `rows upserted ${String(summary.rows_upserted)}`
    if (summary.pages != null) return `pages ${String(summary.pages)}`
  }
  if (r.total != null) return `rows ${String(r.total)}`
  if (r.rows_written != null) return `rows ${String(r.rows_written)}`
  if (r.rows_upserted != null) return `rows upserted ${String(r.rows_upserted)}`
  if (r.message != null) return String(r.message)
  try {
    return JSON.stringify(r)
  } catch {
    return '—'
  }
}

export function isRefJobTerminal(item: RefJobTrackItem): boolean {
  if (item.streamError) return true
  const s = (item.status || '').toLowerCase()
  return s === 'done' || s === 'failed'
}

export function countActiveRefJobs(items: RefJobTrackItem[]): number {
  return items.filter(i => !isRefJobTerminal(i)).length
}
