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
  /** Source-void acknowledgment flags: true means user has acknowledged the source does not provide this data. */
  income_statements_source_void?: boolean
  balance_sheets_source_void?: boolean
  cash_flows_source_void?: boolean
  ratios_source_void?: boolean
  short_interest_source_void?: boolean
  short_volume_source_void?: boolean
  income_statements_void_reason?: string | null
  balance_sheets_void_reason?: string | null
  cash_flows_void_reason?: string | null
  ratios_void_reason?: string | null
  short_interest_void_reason?: string | null
  short_volume_void_reason?: string | null
  /** Gap count recorded at acknowledgment time; null when source_void is false. */
  income_statements_acked_gap_count?: number | null
  balance_sheets_acked_gap_count?: number | null
  cash_flows_acked_gap_count?: number | null
  ratios_acked_gap_count?: number | null
  short_interest_acked_gap_count?: number | null
  short_volume_acked_gap_count?: number | null
  /** Actionable gap count = max(0, total - acked); drives status color. */
  income_statements_actionable_gap_count?: number | null
  balance_sheets_actionable_gap_count?: number | null
  cash_flows_actionable_gap_count?: number | null
  ratios_actionable_gap_count?: number | null
  short_interest_actionable_gap_count?: number | null
  short_volume_actionable_gap_count?: number | null
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
  const url = researchApiUrl('/research/data/readiness/summary')
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
  const url = researchApiUrl('/research/data/readiness/backfill-grouped-history')
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
  const url = researchApiUrl('/research/data/readiness/backfill-price-gaps')
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
  const url = researchApiUrl('/research/data/readiness/price-gaps')
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
  const url = researchApiUrl('/research/data/readiness/sync-holidays')
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
  const url = researchApiUrl('/research/data/readiness/backfill-fundamentals')
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

export interface SepaTechnicalBackfillResponse {
  ok: boolean
  error?: string
  gap_count?: number
  message?: string
}

export async function postSepaTechnicalBackfill(opts?: {
  only_missing?: boolean
  max_symbols?: number
  min_crs?: number
  lookback_days?: number
}): Promise<SepaTechnicalBackfillResponse> {
  const url = researchApiUrl('/research/data/readiness/backfill-technical')
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
  return j as SepaTechnicalBackfillResponse
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
  const url = researchApiUrl('/research/data/readiness/stock-unified-snapshot')
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
  const url = researchApiUrl('/research/data/readiness/snapshot')
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
  _getFinGaps('/research/data/readiness/income-statements-gaps')
export const postSepaIncomeStatementsBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/data/readiness/backfill-income-statements', symbols?.length ? { symbols } : {})

export const fetchSepaBalanceSheetsGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/data/readiness/balance-sheets-gaps')
export const postSepaBalanceSheetsBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/data/readiness/backfill-balance-sheets', symbols?.length ? { symbols } : {})

export const fetchSepaCashFlowsGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/data/readiness/cash-flows-gaps')
export const postSepaCashFlowsBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/data/readiness/backfill-cash-flows', symbols?.length ? { symbols } : {})

export const fetchSepaRatiosGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/data/readiness/ratios-gaps')
export const postSepaRatiosBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/data/readiness/backfill-ratios', symbols?.length ? { symbols } : {})

export const fetchSepaShortInterestGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/data/readiness/short-interest-gaps')
export const postSepaShortInterestBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/data/readiness/backfill-short-interest', symbols?.length ? { symbols } : {})

export const fetchSepaShortVolumeGaps = (): Promise<SepaFinancialsGapsResponse> =>
  _getFinGaps('/research/data/readiness/short-volume-gaps')
export const postSepaShortVolumeBackfill = (symbols?: string[]): Promise<SepaFinancialsBackfillResponse> =>
  _postFinBackfill('/research/data/readiness/backfill-short-volume', symbols?.length ? { symbols } : {})

// ── Gap-ack (source void acknowledgment) ──────────────────────────────────────

export type SepaGapAckDataType =
  | 'income_statements'
  | 'balance_sheets'
  | 'cash_flows'
  | 'ratios'
  | 'short_interest'
  | 'short_volume'

export interface SepaGapAckRow {
  data_type: SepaGapAckDataType
  is_void: boolean
  acked_gap_count?: number | null
  void_reason?: string | null
  acked_at?: string | null
}

export interface SepaGapAckResponse {
  ok: boolean
  error?: string
  acks?: SepaGapAckRow[]
}

export interface SepaGapAckSetResponse {
  ok: boolean
  error?: string
  data_type?: string
  is_void?: boolean
  acked_gap_count?: number
}

// ── Stage 4 Evaluation ──────────────────────────────────────────────────────

export interface SepaConditionStat {
  id: string
  label: string
  pass: number
  fail: number
  no_data: number
  total: number
}

export interface FundPassCountBucket {
  /** Number of SEPA conditions passed (0–8). */
  conditions_passed: number
  /** Symbols in this bucket (insufficient_data excluded). */
  symbol_count: number
}

export interface SepaCriteriaStats {
  ok: boolean
  error?: string
  universe_count: number
  fundamental: {
    cached_count: number
    fund_pass_count: number
    no_data_count: number
    conditions: SepaConditionStat[]
    /** Distribution: how many symbols passed exactly N out of 8 conditions. Ordered 8→0. */
    pass_count_distribution?: FundPassCountBucket[]
  }
  technical: {
    total_in_snapshot: number
    price_ready_count: number
    fund_cached_count: number
    both_ready: number
    bars_ge_252: number
    bars_ge_240: number
    bars_ge_200: number
    bars_lt_200: number
    no_bars: number
    failure_reasons: Array<{ notes: string | null; cnt: number }>
    /** Cached technical_eval rows for today (universe scope). */
    tech_cached_count: number
    /** Count of symbols with technical_pass = true (all 11 conditions). */
    tech_pass_count: number
    /** Count of symbols whose technical_eval is flagged insufficient_data. */
    tech_insufficient_count: number
    /** Per-condition pass/fail counts, one entry per known condition id. */
    conditions: TechConditionStat[]
  }
  computed_at: string
}

export interface TechConditionStat {
  id: string
  label: string
  pass: number
  fail: number
}

export interface SepaDataInventoryStats {
  ok: boolean
  error?: string
  universe_count: number
  /** table name → column name → count of universe symbols with non-null value */
  tables: Record<string, Record<string, number>>
}

export async function fetchSepaCriteriaStats(): Promise<SepaCriteriaStats> {
  const url = researchApiUrl('/research/data/readiness/criteria-stats')
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 60_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg, universe_count: 0, fundamental: { cached_count: 0, fund_pass_count: 0, no_data_count: 0, conditions: [] }, technical: { total_in_snapshot: 0, price_ready_count: 0, fund_cached_count: 0, both_ready: 0, bars_ge_252: 0, bars_ge_240: 0, bars_ge_200: 0, bars_lt_200: 0, no_bars: 0, failure_reasons: [], tech_cached_count: 0, tech_pass_count: 0, tech_insufficient_count: 0, conditions: [] }, computed_at: '' }
    }
    return j as SepaCriteriaStats
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error', universe_count: 0, fundamental: { cached_count: 0, fund_pass_count: 0, no_data_count: 0, conditions: [] }, technical: { total_in_snapshot: 0, price_ready_count: 0, fund_cached_count: 0, both_ready: 0, bars_ge_252: 0, bars_ge_240: 0, bars_ge_200: 0, bars_lt_200: 0, no_bars: 0, failure_reasons: [], tech_cached_count: 0, tech_pass_count: 0, tech_insufficient_count: 0, conditions: [] }, computed_at: '' }
  }
}

export interface FundDistSymbolRow {
  symbol: string
  pass_count: number
  /** IDs of the conditions that passed, e.g. ["eps_q2q_ge_25pct", "rev_q2q_ge_25pct"] */
  passed_conditions: string[]
}

export interface FundDistSymbolsResponse {
  ok: boolean
  error?: string
  conditions_passed: number
  count: number
  symbols: FundDistSymbolRow[]
}

export async function fetchFundamentalDistributionSymbols(
  conditionsPassed: number,
): Promise<FundDistSymbolsResponse> {
  const url = researchApiUrl(
    `/research/data/readiness/fundamental-distribution/symbols?conditions_passed=${conditionsPassed}`,
  )
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 20_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg, conditions_passed: conditionsPassed, count: 0, symbols: [] }
    }
    return j as FundDistSymbolsResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error', conditions_passed: conditionsPassed, count: 0, symbols: [] }
  }
}

/** Universe symbols whose today's SEPA snapshot passes EVERY condition in `include` (AND semantic). */
export interface FundamentalFilterResponse {
  ok: boolean
  error?: string
  include?: string[]
  count?: number
  symbols?: FundDistSymbolRow[]
  limit?: number
}

export interface TechFilterSymbolRow {
  symbol: string
  /** Number of technical conditions passed (0–11). */
  pass_count: number
  /** IDs of the technical conditions that passed. */
  passed_conditions: string[]
}

export interface TechnicalFilterResponse {
  ok: boolean
  error?: string
  include?: string[]
  count?: number
  symbols?: TechFilterSymbolRow[]
  limit?: number
}

/**
 * Per-symbol readiness snapshot row returned by `/research/data/readiness/symbols-snapshot`.
 * Mirrors columns from `public.stock_readiness_daily` plus a derived `passed_conditions`.
 */
export interface ReadinessSnapshotRow {
  symbol: string
  found: boolean
  as_of_date?: string | null
  included_in_universe?: boolean
  price_ready?: boolean
  bar_count_lookback?: number
  first_bar_date?: string | null
  last_bar_date?: string | null
  income_stmt_ready?: boolean
  income_stmt_q_count?: number
  income_stmt_a_count?: number
  balance_sheet_present?: boolean
  cash_flow_present?: boolean
  ratios_present?: boolean
  short_interest_present?: boolean
  short_volume_present?: boolean
  fundamental_pass?: boolean
  fundamental_pass_count?: number
  fundamental_insufficient?: boolean
  passed_conditions?: string[]
  technical_pass?: boolean
  technical_pass_count?: number
  technical_insufficient?: boolean
  passed_tech_conditions?: string[]
}

export interface SymbolsReadinessSnapshotResponse {
  ok: boolean
  error?: string
  as_of_date?: string | null
  count?: number
  symbols?: ReadinessSnapshotRow[]
}

export async function fetchSymbolsReadinessSnapshot(
  symbols: string[],
): Promise<SymbolsReadinessSnapshotResponse> {
  const clean = (symbols || []).map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (clean.length === 0) {
    return { ok: true, as_of_date: null, count: 0, symbols: [] }
  }
  // Backend caps to 500 — match that here defensively.
  const sliced = clean.slice(0, 500)
  const qs = new URLSearchParams({ symbols: sliced.join(',') })
  const url = researchApiUrl(`/research/data/readiness/symbols-snapshot?${qs.toString()}`)
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 20_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    return j as SymbolsReadinessSnapshotResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

export async function fetchFundamentalFilter(opts: {
  include: string[]
  limit?: number
}): Promise<FundamentalFilterResponse> {
  const include = (opts.include || []).map((s) => s.trim()).filter(Boolean)
  if (include.length === 0) {
    return { ok: true, include: [], count: 0, symbols: [], limit: opts.limit ?? 500 }
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000))
  const qs = new URLSearchParams({ include: include.join(','), limit: String(limit) })
  const url = researchApiUrl(`/research/data/readiness/fundamental-filter?${qs.toString()}`)
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 20_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    return j as FundamentalFilterResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

export async function fetchTechnicalFilter(opts: {
  include: string[]
  limit?: number
}): Promise<TechnicalFilterResponse> {
  const include = (opts.include || []).map((s) => s.trim()).filter(Boolean)
  if (include.length === 0) {
    return { ok: true, include: [], count: 0, symbols: [], limit: opts.limit ?? 500 }
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000))
  const qs = new URLSearchParams({ include: include.join(','), limit: String(limit) })
  const url = researchApiUrl(`/research/data/readiness/technical-filter?${qs.toString()}`)
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 20_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    return j as TechnicalFilterResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

// ── Per-symbol fundamental conditions (today's snapshot) ────────────────────

export interface SymbolFundamentalConditionRow {
  id: string
  pass: boolean
  actual: number | string | null
  threshold: number | string | null
  reason: string | null
}

export interface SymbolFundamentalConditionsResponse {
  ok: boolean
  error?: string
  symbol?: string
  found?: boolean
  as_of_date?: string
  pass_count?: number
  fundamental_pass?: boolean
  insufficient_data?: boolean
  conditions?: SymbolFundamentalConditionRow[]
}

export async function fetchSymbolFundamentalConditions(
  symbol: string,
): Promise<SymbolFundamentalConditionsResponse> {
  const sym = (symbol || '').trim().toUpperCase()
  if (!sym) return { ok: false, error: 'symbol is required' }
  const url = researchApiUrl(
    `/research/data/readiness/fundamental-conditions?symbol=${encodeURIComponent(sym)}`,
  )
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 15_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    return j as SymbolFundamentalConditionsResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

export async function fetchSepaDataInventory(): Promise<SepaDataInventoryStats> {
  const url = researchApiUrl('/research/data/readiness/data-inventory')
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 60_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg, universe_count: 0, tables: {} }
    }
    return j as SepaDataInventoryStats
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error', universe_count: 0, tables: {} }
  }
}

export async function postSepaGapAck(
  dataType: SepaGapAckDataType,
  isVoid: boolean,
  gapCount: number,
  voidReason?: string,
): Promise<SepaGapAckSetResponse> {
  const url = researchApiUrl('/research/data/readiness/gap-ack')
  const body: Record<string, unknown> = { data_type: dataType, is_void: isVoid, gap_count: gapCount }
  if (voidReason) body.void_reason = voidReason
  try {
    const r = await fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      15_000,
    )
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    return j as SepaGapAckSetResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

// ── Symbol Fundamental Raw Data ───────────────────────────────────────────────

export interface FundRawQuarterRow {
  fiscal_year: number
  fiscal_quarter: number
  eps: number | null
  revenues: number | null
}

export interface FundRawAnnualRow {
  fiscal_year: number
  eps: number | null
  revenues: number | null
}

export interface SymbolFundRawDataResponse {
  ok: boolean
  error?: string
  symbol?: string
  quarterly: FundRawQuarterRow[]
  annual: FundRawAnnualRow[]
  metrics: Record<string, number | null>
}

export async function fetchSymbolFundRawData(symbol: string): Promise<SymbolFundRawDataResponse> {
  const sym = (symbol || '').trim().toUpperCase()
  const empty: SymbolFundRawDataResponse = { ok: false, quarterly: [], annual: [], metrics: {} }
  if (!sym) return { ...empty, error: 'symbol is required' }
  const url = researchApiUrl(
    `/research/data/readiness/symbol-fundamental-raw-data?symbol=${encodeURIComponent(sym)}`,
  )
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 15_000)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ...empty, error: j?.error ?? `HTTP ${r.status}` }
    return j as SymbolFundRawDataResponse
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : 'Network error' }
  }
}
