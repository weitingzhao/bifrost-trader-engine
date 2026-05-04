import { getResearchApiBase, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBase(), path)
}

export interface SepaReadinessNotesRow {
  notes: string
  count: number
}

/** Static catalog from GET summary: raw tables vs derived views (supported data points per source). */
export interface SepaReadinessCatalogEntry {
  id: string
  object: string
  role: string
  typical_ingest?: string
  depends_on?: string[]
  data_points: string[]
}

export interface SepaReadinessDataCatalog {
  raw_sources: SepaReadinessCatalogEntry[]
  computed_layers: SepaReadinessCatalogEntry[]
}

export interface SepaReadinessSummaryResponse {
  ok: boolean
  error?: string
  data_catalog?: SepaReadinessDataCatalog
  universe_count?: number
  tickers_active_count?: number
  tickers_last_synced_at?: string | null
  price_readiness_live?: {
    total_symbols: number
    price_ready: number
  }
  fund_cache_view_exists?: boolean
  fund_cache_valid_count?: number | null
  snapshot_populated?: boolean
  snapshot_today?: {
    rows_total: number
    included_in_universe: number
    price_ready: number
  }
  notes_breakdown?: SepaReadinessNotesRow[]
}

export async function fetchSepaReadinessSummary(): Promise<SepaReadinessSummaryResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/summary')
  const r = await fetchWithTimeout(url, { method: 'GET' }, 45_000)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaReadinessSummaryResponse
}

export interface SepaGroupedHistoryBackfillResponse {
  ok: boolean
  error?: string
  dates_queued?: number
  checked_dates?: number
  days_back?: number
  job_ids?: string[]
  message?: string
  errors?: string[]
}

export async function postSepaGroupedHistoryBackfill(
  daysBack = 420,
): Promise<SepaGroupedHistoryBackfillResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/backfill-grouped-history')
  const r = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days_back: daysBack }),
    },
    120_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaGroupedHistoryBackfillResponse
}

export interface SepaPriceGapBackfillResponse {
  ok: boolean
  error?: string
  gap_count?: number
  chunks?: number
  job_ids?: string[]
  message?: string
  errors?: string[]
}

export async function postSepaPriceGapBackfill(): Promise<SepaPriceGapBackfillResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/backfill-price-gaps')
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    60_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaPriceGapBackfillResponse
}

export interface SepaPriceGapItem {
  symbol: string
  bar_rows: number
  first_bar_date: string | null
  last_bar_date: string | null
  null_close_rows: number
  null_volume_rows: number
  reason: string
}

export interface SepaPriceGapsResponse {
  ok: boolean
  error?: string
  total_gap_count?: number
  returned?: number
  items?: SepaPriceGapItem[]
}

export async function fetchSepaPriceGaps(): Promise<SepaPriceGapsResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/price-gaps')
  const r = await fetchWithTimeout(url, { method: 'GET' }, 60_000)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaPriceGapsResponse
}

export async function postSepaReadinessSnapshot(): Promise<{
  ok: boolean
  error?: string
  rows_affected?: number
  elapsed_ms?: number
}> {
  const url = researchApiUrl('/research/screening/sepa/readiness/snapshot')
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    180_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return {
    ok: Boolean(j.ok),
    error: typeof j.error === 'string' ? j.error : undefined,
    rows_affected: typeof j.rows_affected === 'number' ? j.rows_affected : undefined,
    elapsed_ms: typeof j.elapsed_ms === 'number' ? j.elapsed_ms : undefined,
  }
}
