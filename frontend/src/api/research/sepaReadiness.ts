import { getResearchApiBaseForBrowser, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
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
  /** Present for SQL views; pulled from PostgreSQL via pg_get_viewdef. */
  view_query?: string
}

export interface SepaReadinessDataCatalog {
  raw_sources: SepaReadinessCatalogEntry[]
  computed_layers: SepaReadinessCatalogEntry[]
}

export interface SepaReadinessHolidaysSummary {
  total: number
  early_close_count: number
  massive_count: number
  seed_count: number
  manual_count: number
  earliest_date: string | null
  latest_date: string | null
  last_massive_sync: string | null
  by_exchange: Array<{ exchange: string; count: number }>
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
  holidays_summary?: SepaReadinessHolidaysSummary
  /** Rows in public.cache_stock_snapshot (Massive unified /v3/snapshot); null if table missing. */
  stock_unified_snapshot_row_count?: number | null
  stock_unified_snapshot_last_fetched_at?: string | null
  /** Step 2 breakdown: cache_stock_snapshot rows grouped by tickers.instrument_type. */
  stock_unified_snapshot_by_type?: SepaSnapshotByTypeRow[] | null
  /** Steps 4–7: distinct symbols per instrument_type (join tickers on symbol) with source=massive in each raw table. */
  fundamentals_symbol_count_by_type?: SepaFundamentalsSymbolCountByTypeRow[] | null
  /**
   * Step 3 stock_day gap count: vendor NY date from cache.last_minute_updated vs max(stock_day);
   * fallback to NOT price_ready when last_minute_updated is null. Null if query failed.
   */
  stock_day_vendor_fill_gap_count?: number | null
  /** Steps 4–9: per-table gap counts (null if table missing or query failed). */
  income_statements_gap_count?: number | null
  balance_sheets_gap_count?: number | null
  cash_flows_gap_count?: number | null
  ratios_gap_count?: number | null
  short_interest_gap_count?: number | null
  short_volume_gap_count?: number | null
}

export interface SepaSnapshotByTypeRow {
  /** tickers.instrument_type code (e.g. CS, ETF, WARRANT). '(unknown)' if NULL/empty. */
  code: string
  /** Human-readable description from public.ticker_types (asset_class=stocks, locale=us). */
  description: string | null
  /** Number of cache_stock_snapshot rows for this instrument_type. */
  snapshot_row_count: number
  /** Number of public.tickers rows (active US stocks) for this instrument_type. */
  universe_ticker_count: number
}

/** Distinct symbols with Massive rows in raw fundamentals tables, grouped by tickers.instrument_type. */
export interface SepaFundamentalsSymbolCountByTypeRow {
  code: string
  income_statement_symbols: number
  balance_sheet_symbols: number
  cash_flow_symbols: number
  ratio_symbols: number
}

export async function fetchSepaReadinessSummary(): Promise<SepaReadinessSummaryResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/summary')
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 45_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    return j as SepaReadinessSummaryResponse
  } catch (e) {
    const base = getResearchApiBaseForBrowser()
    const hint =
      base && typeof window !== 'undefined' && !base.includes(window.location.hostname)
        ? ' (API base host differs from the page; use same host as the UI or rely on dev proxy.)'
        : ''
    const msg = e instanceof Error ? e.message : 'Network error'
    return { ok: false, error: `${msg}${hint}` }
  }
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

export async function postSepaPriceGapBackfill(
  symbols?: string[],
): Promise<SepaPriceGapBackfillResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/backfill-price-gaps')
  const body =
    symbols && symbols.length > 0 ? JSON.stringify({ symbols }) : '{}'
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
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
  /** NY calendar date from cache_stock_snapshot.last_minute_updated (vendor latest bar day). */
  vendor_day?: string | null
  /** max(stock_day.bar_time) for source=massive (all history). */
  last_bar_max_date?: string | null
  /** Latest massive daily bar close (most recent bar_time). */
  last_stock_day_close?: number | null
  /** Unified snapshot session close (same symbol). */
  session_close?: number | null
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

export interface SepaSyncHolidaysResponse {
  ok: boolean
  error?: string
  seeded?: number
  fetched?: number
  inserted?: number
  updated?: number
  skipped?: number
  total_in_table?: number
  synced_at?: string
  massive_error?: string
}

export async function postSepaSyncHolidays(): Promise<SepaSyncHolidaysResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/sync-holidays')
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    30_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const baseMsg =
      typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status} ${r.statusText || ''}`)
    const hint =
      r.status === 404
        ? ` (endpoint not registered — restart Research API and verify it is running the latest code; tried ${url})`
        : ''
    return { ok: false, error: `${baseMsg}${hint}` }
  }
  return j as SepaSyncHolidaysResponse
}

export interface SepaFundamentalsBackfillResponse {
  ok: boolean
  error?: string
  gap_count?: number
  job_id?: string | null
  message?: string
}

export async function postSepaFundamentalsBackfill(opts?: {
  max_workers?: number
  rate_limit_rps?: number
  cache_ttl_sec?: number
  max_symbols?: number
}): Promise<SepaFundamentalsBackfillResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/backfill-fundamentals')
  const body = opts ? JSON.stringify(opts) : '{}'
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    60_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaFundamentalsBackfillResponse
}

export interface SepaStockUnifiedSnapshotResponse {
  ok: boolean
  error?: string
  symbols_total?: number
  chunks?: number
  rows_upserted?: number
  errors?: string[]
  elapsed_ms?: number
  message?: string
}

/** Batch GET /v3/snapshot (stocks) for universe; UPSERT cache_stock_snapshot. */
export async function postSepaStockUnifiedSnapshot(): Promise<SepaStockUnifiedSnapshotResponse> {
  const url = researchApiUrl('/research/screening/sepa/readiness/stock-unified-snapshot')
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    600_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaStockUnifiedSnapshotResponse
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

export interface SepaFinGapRow {
  symbol: string
  quarterly_rows?: number | null
  annual_rows?: number | null
  quarterly_max_period_end?: string | null
  annual_max_period_end?: string | null
  gap_reason?: string | null
}

export interface SepaFinancialsGapsResponse {
  ok: boolean
  error?: string
  gaps?: SepaFinGapRow[]
  total_gap_count?: number
  returned?: number
}

export interface SepaFinancialsBackfillResponse {
  ok: boolean
  error?: string
  gap_count?: number
  chunks?: number
  job_ids?: string[]
  kind?: string
  message?: string
  errors?: string[]
}

async function _getFinGaps(path: string): Promise<SepaFinancialsGapsResponse> {
  const url = researchApiUrl(path)
  const r = await fetchWithTimeout(url, { method: 'GET' }, 60_000)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaFinancialsGapsResponse
}

async function _postFinBackfill(path: string, body: Record<string, unknown>): Promise<SepaFinancialsBackfillResponse> {
  const url = researchApiUrl(path)
  const r = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    120_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    return { ok: false, error: msg }
  }
  return j as SepaFinancialsBackfillResponse
}

export const fetchSepaIncomeStatementsGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/screening/sepa/readiness/income-statements-gaps')
export const postSepaIncomeStatementsBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/screening/sepa/readiness/backfill-income-statements', symbols?.length ? { symbols } : {})

export const fetchSepaBalanceSheetsGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/screening/sepa/readiness/balance-sheets-gaps')
export const postSepaBalanceSheetsBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/screening/sepa/readiness/backfill-balance-sheets', symbols?.length ? { symbols } : {})

export const fetchSepaCashFlowsGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/screening/sepa/readiness/cash-flows-gaps')
export const postSepaCashFlowsBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/screening/sepa/readiness/backfill-cash-flows', symbols?.length ? { symbols } : {})

export const fetchSepaRatiosGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/screening/sepa/readiness/ratios-gaps')
export const postSepaRatiosBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/screening/sepa/readiness/backfill-ratios', symbols?.length ? { symbols } : {})

export const fetchSepaShortInterestGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/screening/sepa/readiness/short-interest-gaps')
export const postSepaShortInterestBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/screening/sepa/readiness/backfill-short-interest', symbols?.length ? { symbols } : {})

export const fetchSepaShortVolumeGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/screening/sepa/readiness/short-volume-gaps')
export const postSepaShortVolumeBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/screening/sepa/readiness/backfill-short-volume', symbols?.length ? { symbols } : {})
