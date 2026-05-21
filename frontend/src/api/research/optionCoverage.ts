import {
  getMassiveApiBase,
  joinServiceBase,
} from '../shared/apiRouting'

function massiveUrl(path: string): string {
  return joinServiceBase(getMassiveApiBase(), path)
}

/** GET /research/massive/watchlist-db-coverage — per-symbol rows for optionable STK watchlist (max 80). */
export interface WatchlistDbCoverageOptionContracts {
  has_data: boolean
  /** Row count in option_contracts for this symbol; null when has_data is false. */
  row_count: number | null
  /** Max(created_at) ISO; age since the most recent newly inserted contract row. */
  newest_created_at: string | null
  age_seconds: number | null
  /** ISO timestamp of last option_contracts sync run (from job_ticker_reference_state). */
  last_check_at: string | null
  last_check_age_seconds: number | null
  ticker_pct: number | null
  identity_pct: number | null
  /** L1: share of rows with non-empty exercise_style (often filled after chain snapshot, not reference-only). */
  exercise_style_pct: number | null
  /** L1: share of rows with shares_per_contract set. */
  shares_per_contract_pct: number | null
  /**
   * Average fill % across nullable data columns only (exercise_style + shares_per_contract) —
   * not ticker/identity. Same as (es_non_null + spc_non_null) / (2 * row_count) * 100.
   */
  optional_data_fill_avg_pct: number | null
  /** Rows where exercise_style IS NULL (SQL NULL only). 0 when has_data is false. */
  exercise_style_null_row_count: number
  /** Rows where shares_per_contract IS NULL. 0 when has_data is false. */
  shares_per_contract_null_row_count: number
  /**
   * Total SQL NULL "cells" for monitored nullable columns: exercise_style_null_row_count +
   * shares_per_contract_null_row_count (same row can contribute 2). 0 when has_data is false.
   */
  column_gap_count: number
  mapping_mismatch_count: number | null
  distinct_expirations: number | null
  distinct_strikes: number | null
  /** Same as newest_created_at; kept for backward compatibility. */
  contracts_last_at: string | null
}

/** Per-symbol rollup for option_day / option_min (Massive source). */
export interface WatchlistDbCoverageOptionBars {
  has_data: boolean
  row_count: number | null
  last_bar_time: string | null
  last_created_at: string | null
  ohlc_complete_pct: number | null
  volume_pct: number | null
  vwap_pct: number | null
  /** avg(volume_pct, vwap_pct) — second completeness segment. */
  optional_avg_pct: number | null
  distinct_expirations: number | null
  distinct_contracts: number | null
}

export interface WatchlistDbCoverageSnapshotsWithUd {
  has_data: boolean
  row_count: number | null
  last_snapshot_ts: string | null
  last_created_at: string | null
}

export interface WatchlistDbCoverageExpirationCache {
  has_data: boolean
  row_count: number | null
  last_updated_at: string | null
}

export interface WatchlistDbCoverageOiDaily {
  has_data: boolean
  row_count: number | null
  last_trade_date: string | null
  last_created_at: string | null
}

export interface WatchlistDbCoverageReportDaily {
  has_data: boolean
  row_count: number | null
  last_trade_date: string | null
  last_created_at: string | null
}

/** Per-symbol rollup for option_snapshots (Massive source, latest row per contract_key). */
export interface WatchlistDbCoverageOptionSnapshots {
  has_data: boolean
  /** Distinct contract_key count (latest snapshot per key). */
  row_count: number | null
  /** Max(snapshot_ts) ISO. */
  snapshots_last_ts: string | null
  age_seconds: number | null
  iv_pct: number | null
  full_greeks_pct: number | null
  open_interest_pct: number | null
  /** Average of full_greeks_pct and open_interest_pct (matrix second segment). */
  optional_data_fill_avg_pct: number | null
  /** Latest rows older than 24h (same rule as Feed Massive Option stale hint). */
  stale_snapshot_rows: number | null
}

/** Massive stock daily bars (watchlist row). */
export interface WatchlistDbCoverageStockDay {
  has_data: boolean
  stock_day_last_bar: string | null
  stock_day_last_created_at: string | null
  row_count?: number | null
  ohlc_complete_pct?: number | null
  volume_pct?: number | null
  vwap_pct?: number | null
  optional_avg_pct?: number | null
  distinct_bar_dates?: number | null
}

/** Massive stock minute bars (watchlist row). */
export interface WatchlistDbCoverageStockMin {
  has_data: boolean
  row_count?: number | null
  last_bar_time?: string | null
  last_created_at?: string | null
  ohlc_complete_pct?: number | null
  volume_pct?: number | null
  vwap_pct?: number | null
  optional_avg_pct?: number | null
  distinct_periods?: number | null
}

/** Row in ``tickers`` (reference universe). */
export interface WatchlistDbCoverageTickers {
  has_data: boolean
  tickers_id?: number | null
  tickers_updated_at?: string | null
  last_updated_utc?: string | null
}

/** Row in ``ticker_overview`` (1:1 with tickers when synced). DDL has ``overview_updated_at`` only. */
export interface WatchlistDbCoverageTickerOverview {
  has_data: boolean
  overview_updated_at?: string | null
}

/** Global ``ticker_types`` dictionary (same values on every symbol row). */
export interface WatchlistDbCoverageTickerTypes {
  has_data: boolean
  dictionary_row_count?: number | null
  dictionary_last_created_at?: string | null
}

export interface WatchlistDbCoverageSymbolRow {
  symbol: string
  option_contracts: WatchlistDbCoverageOptionContracts
  option_snapshots: WatchlistDbCoverageOptionSnapshots
  report_option_atm_iv_daily: {
    has_data: boolean
    atm_iv_last_trade_date: string | null
    atm_iv_last_created_at: string | null
  }
  stock_day: WatchlistDbCoverageStockDay
  /** Present when API supports extended option coverage (same deploy as Data Overview matrix). */
  option_day?: WatchlistDbCoverageOptionBars
  option_min?: WatchlistDbCoverageOptionBars
  option_snapshots_with_underlying_day?: WatchlistDbCoverageSnapshotsWithUd
  option_expiration_cache?: WatchlistDbCoverageExpirationCache
  /** Distinct from legacy summary-only placeholder rows; per-symbol OI rollup. */
  option_open_interest_daily?: WatchlistDbCoverageOiDaily
  report_option_max_pain_daily?: WatchlistDbCoverageReportDaily
  stock_min?: WatchlistDbCoverageStockMin
  tickers?: WatchlistDbCoverageTickers
  ticker_overview?: WatchlistDbCoverageTickerOverview
  /** Instrument-type dictionary; identical across symbols (whole-table rollup). */
  ticker_types?: WatchlistDbCoverageTickerTypes
}

export interface WatchlistDbCoverageResponse {
  ok: boolean
  error?: string
  generated_at?: string
  universe?: string
  symbols_count?: number
  symbols?: WatchlistDbCoverageSymbolRow[]
  message?: string
  /** When set, per-table metrics use Massive source where applicable. */
  source_scope?: string
}

export async function fetchWatchlistDbCoverage(): Promise<WatchlistDbCoverageResponse> {
  const r = await fetch(massiveUrl('/research/massive/watchlist-db-coverage'))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as WatchlistDbCoverageResponse
}

/** GET /research/massive/option-contracts-reference-gap — PG vs Massive reference list per expiry (paginated). */
export interface OptionContractsReferenceGapExpiryRow {
  expiry: string
  /** PG rows whose contract_key appears in the Massive reference list for this expiry (comparable scope). */
  pg_count: number
  /** All PG rows for this expiry (includes rows not returned by the reference API for this expiry). */
  pg_count_all?: number
  /** pg_count_all − pg_count — excluded from gap math (outside API reference universe). */
  pg_rows_outside_reference?: number
  massive_count: number
  gap: number
  truncated?: boolean
  /**
   * Missing contracts whose latest option_snapshots_latest.open_interest > 0.
   * These are actionable gaps — the system should have bar data but doesn't.
   * Only populated for bars gap results (option_day / option_min).
   */
  real_gap?: number
  /**
   * Missing contracts with OI = 0 or no snapshot at all.
   * Typically illiquid / never-traded contracts — expected absence, not a system error.
   * Only populated for bars gap results (option_day / option_min).
   */
  illiquid?: number
}

export interface OptionContractsReferenceGapResult {
  ok: boolean
  symbol?: string
  error?: string
  has_rows?: boolean
  message?: string
  db_row_count?: number
  /** Distinct expiries in PostgreSQL for this symbol (not capped by max_expiries scan). */
  distinct_expiry_total?: number
  /** Distinct expiries included in this Compare run (≤ max_expiries). */
  expiries_scanned?: number
  max_expiries_used?: number
  max_pages_per_expiry_used?: number
  pg_total?: number
  massive_total?: number | null
  gap?: number | null
  coverage_pct?: number | null
  compared_at?: string
  expiries?: OptionContractsReferenceGapExpiryRow[]
  truncated?: boolean
  expiries_truncated?: boolean
}

export type OptionContractsReferenceGapRequestOptions = {
  max_expiries?: number
  max_pages_per_expiry?: number
}

export async function fetchOptionContractsReferenceGap(
  symbol: string,
  options?: OptionContractsReferenceGapRequestOptions,
): Promise<OptionContractsReferenceGapResult> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (options?.max_expiries != null) q.set('max_expiries', String(options.max_expiries))
  if (options?.max_pages_per_expiry != null) {
    q.set('max_pages_per_expiry', String(options.max_pages_per_expiry))
  }
  const r = await fetch(massiveUrl(`/research/massive/option-contracts-reference-gap?${q}`))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as OptionContractsReferenceGapResult
}

export interface OptionContractsReferenceGapBatchResponse {
  ok: boolean
  error?: string
  results?: Record<string, OptionContractsReferenceGapResult>
}

/** POST /research/massive/option-contracts-reference-gap/batch — max 10 symbols per request. */
export async function postOptionContractsReferenceGapBatch(
  symbols: string[],
  options?: OptionContractsReferenceGapRequestOptions,
): Promise<OptionContractsReferenceGapBatchResponse> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const body: Record<string, unknown> = { symbols: uniq }
  if (options?.max_expiries != null) body.max_expiries = options.max_expiries
  if (options?.max_pages_per_expiry != null) body.max_pages_per_expiry = options.max_pages_per_expiry
  const r = await fetch(massiveUrl('/research/massive/option-contracts-reference-gap/batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as OptionContractsReferenceGapBatchResponse
}

/** GET /research/massive/option-snapshots-contracts-gap — PG vs Massive GET /v3/snapshot/options/{underlying} (per expiry, vs option_contracts). */
export type OptionSnapshotsContractsGapResult = OptionContractsReferenceGapResult

export async function fetchOptionSnapshotsContractsGap(
  symbol: string,
): Promise<OptionSnapshotsContractsGapResult> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, error: 'symbol is required' }
  const r = await fetch(
    massiveUrl(`/research/massive/option-snapshots-contracts-gap?symbol=${encodeURIComponent(s)}`),
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as OptionSnapshotsContractsGapResult
}

export interface OptionSnapshotsContractsGapBatchResponse {
  ok: boolean
  error?: string
  results?: Record<string, OptionSnapshotsContractsGapResult>
}

/** POST /research/massive/option-snapshots-contracts-gap/batch — max 10 symbols. */
export async function postOptionSnapshotsContractsGapBatch(
  symbols: string[],
): Promise<OptionSnapshotsContractsGapBatchResponse> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const r = await fetch(massiveUrl('/research/massive/option-snapshots-contracts-gap/batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: uniq }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as OptionSnapshotsContractsGapBatchResponse
}

/** GET /research/massive/option-bars-contracts-gap — option_day/option_min vs option_contracts (local). */
export type OptionBarsContractsGapResult = OptionContractsReferenceGapResult

export async function fetchOptionBarsContractsGap(
  symbol: string,
  table: 'option_day' | 'option_min',
  period?: string,
): Promise<OptionBarsContractsGapResult> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s, table })
  if (period) q.set('period', period)
  const r = await fetch(massiveUrl(`/research/massive/option-bars-contracts-gap?${q}`))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
  }
  return j as OptionBarsContractsGapResult
}

export interface OptionBarsContractsGapBatchResponse {
  ok: boolean
  error?: string
  results?: Record<string, OptionBarsContractsGapResult>
}

/** POST /research/massive/option-bars-contracts-gap/batch — max 10 symbols, no external API. */
export async function postOptionBarsContractsGapBatch(
  symbols: string[],
  table: 'option_day' | 'option_min',
  period?: string,
): Promise<OptionBarsContractsGapBatchResponse> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const r = await fetch(massiveUrl('/research/massive/option-bars-contracts-gap/batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: uniq, table, ...(period ? { period } : {}) }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
  }
  return j as OptionBarsContractsGapBatchResponse
}

/** POST /research/massive/option-min-fill-eligibility — row/column fill flags per symbol (local PG). */
export interface OptionMinFillEligibilityRow {
  needs_row_fill: boolean
  needs_column_fill: boolean
  gap?: number | null
  coverage_pct?: number | null
}

export async function postOptionMinFillEligibility(
  symbols: string[],
  period: string,
  lookbackDays?: number,
): Promise<{
  ok: boolean
  error?: string
  period?: string
  lookback_days?: number
  results?: Record<string, OptionMinFillEligibilityRow>
}> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const body: Record<string, unknown> = { symbols: uniq, period: (period || '').trim() }
  if (lookbackDays != null && lookbackDays > 0) body.lookback_days = lookbackDays
  const r = await fetch(massiveUrl('/research/massive/option-min-fill-eligibility'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
  }
  return j as {
    ok: boolean
    error?: string
    period?: string
    lookback_days?: number
    results?: Record<string, OptionMinFillEligibilityRow>
  }
}

/** POST /research/massive/option-day-fill-eligibility — option_day row/column fill flags per symbol (local PG). */
export interface OptionDayFillEligibilityRow {
  needs_row_fill: boolean
  needs_column_fill: boolean
  gap?: number | null
  coverage_pct?: number | null
}

export async function postOptionDayFillEligibility(
  symbols: string[],
  columnLookbackDays?: number,
): Promise<{
  ok: boolean
  error?: string
  column_lookback_days?: number
  results?: Record<string, OptionDayFillEligibilityRow>
}> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const body: Record<string, unknown> = { symbols: uniq }
  if (columnLookbackDays != null && columnLookbackDays > 0) body.column_lookback_days = columnLookbackDays
  const r = await fetch(massiveUrl('/research/massive/option-day-fill-eligibility'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
  }
  return j as {
    ok: boolean
    error?: string
    column_lookback_days?: number
    results?: Record<string, OptionDayFillEligibilityRow>
  }
}

/** GET /research/massive/bar-quality-detail — per-day / per-expiry / per-period breakdown. */
export interface BarQualityDailyRow {
  bar_day: string
  contract_count: number
  ohlc_pct: number | null
  volume_pct: number | null
  vwap_pct: number | null
}

export interface BarQualityExpiryRow {
  expiry: string
  dte: number | null
  contract_count: number
  ohlc_pct: number | null
  volume_pct: number | null
  vwap_pct: number | null
}

export interface BarQualityPeriodRow {
  period: string
  row_count: number
  last_bar_time: string | null
  ohlc_pct: number | null
  volume_pct: number | null
  vwap_pct: number | null
}

export interface BarQualityDetailResponse {
  ok: boolean
  symbol: string
  table: string
  latest_date: string | null
  daily: BarQualityDailyRow[]
  expiries: BarQualityExpiryRow[]
  periods: BarQualityPeriodRow[]
  error?: string
}

export async function fetchBarQualityDetail(
  symbol: string,
  table: 'option_day' | 'option_min',
  period?: string,
  days?: number,
): Promise<BarQualityDetailResponse> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, symbol: '', table, latest_date: null, daily: [], expiries: [], periods: [], error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s, table })
  if (period) q.set('period', period)
  if (days) q.set('days', String(days))
  const r = await fetch(massiveUrl(`/research/massive/bar-quality-detail?${q}`))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, symbol: s, table, latest_date: null, daily: [], expiries: [], periods: [],
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
  }
  return j as BarQualityDetailResponse
}

/** GET /research/massive/option-contracts-reference-column-parity — L2 ref-owned columns vs PG. */
export interface OptionContractsReferenceColumnParityResult {
  ok: boolean
  symbol?: string
  error?: string
  has_rows?: boolean
  message?: string
  db_row_count?: number
  compared_at?: string
  api_rows_compared?: number
  pg_rows_missing?: number
  value_mismatch_rows?: number
  field_mismatches?: Record<string, number>
  truncated?: boolean
  expiries_truncated?: boolean
  sample_mismatches?: Array<{
    kind: string
    contract_key: string
    detail: string
    fields: string[]
  }>
}

export async function fetchOptionContractsReferenceColumnParity(
  symbol: string,
): Promise<OptionContractsReferenceColumnParityResult> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, error: 'symbol is required' }
  const r = await fetch(
    massiveUrl(`/research/massive/option-contracts-reference-column-parity?symbol=${encodeURIComponent(s)}`),
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as OptionContractsReferenceColumnParityResult
}

export interface OptionContractsReferenceColumnParityBatchResponse {
  ok: boolean
  error?: string
  results?: Record<string, OptionContractsReferenceColumnParityResult>
}

/** POST /research/massive/option-contracts-reference-column-parity/batch — max 10 symbols. */
export async function postOptionContractsReferenceColumnParityBatch(
  symbols: string[],
): Promise<OptionContractsReferenceColumnParityBatchResponse> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const r = await fetch(massiveUrl('/research/massive/option-contracts-reference-column-parity/batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: uniq }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as OptionContractsReferenceColumnParityBatchResponse
}

export interface GreeksCoverageResponse {
  ok: boolean
  symbol?: string
  expiration?: string
  source?: string
  total?: number
  coverage?: {
    with_iv?: number
    iv_pct?: number
    with_delta?: number
    with_gamma?: number
    with_theta?: number
    with_vega?: number
    with_full_greeks?: number
    full_greeks_pct?: number
    with_oi?: number
  }
  freshness?: {
    oldest_ts?: string | null
    newest_ts?: string | null
    stale_rows?: number
  }
  error?: string
}

export async function fetchGreeksCoverage(
  symbol: string,
  expiration?: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<GreeksCoverageResponse> {
  const s = (symbol || '').trim()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s, source })
  if (expiration?.trim()) q.set('expiration', expiration.trim())
  const r = await fetch(massiveUrl(`/research/massive/greeks-coverage?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    symbol: typeof j.symbol === 'string' ? j.symbol : undefined,
    expiration: typeof j.expiration === 'string' ? j.expiration : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    total: typeof j.total === 'number' ? j.total : undefined,
    coverage: typeof j.coverage === 'object' && j.coverage != null ? j.coverage : undefined,
    freshness: typeof j.freshness === 'object' && j.freshness != null ? j.freshness : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export interface ContractsCoverageResponse {
  ok: boolean
  symbol?: string
  expiration?: string
  total?: number
  coverage?: {
    with_massive_ticker?: number
    ticker_pct?: number
    with_complete_identity?: number
    identity_pct?: number
    mapping_mismatch?: number
    with_exercise_style?: number
    exercise_style_pct?: number
    with_shares_per_contract?: number
    shares_per_contract_pct?: number
    optional_data_fill_avg_pct?: number
    distinct_expirations?: number
    distinct_strikes?: number
  }
  freshness?: {
    oldest_ts?: string | null
    newest_ts?: string | null
    stale_rows?: number
  }
  error?: string
}

export async function fetchContractsCoverage(
  symbol: string,
  expiration?: string,
): Promise<ContractsCoverageResponse> {
  const s = (symbol || '').trim()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (expiration?.trim()) q.set('expiration', expiration.trim())
  const r = await fetch(massiveUrl(`/research/massive/contracts-coverage?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    symbol: typeof j.symbol === 'string' ? j.symbol : undefined,
    expiration: typeof j.expiration === 'string' ? j.expiration : undefined,
    total: typeof j.total === 'number' ? j.total : undefined,
    coverage: typeof j.coverage === 'object' && j.coverage != null ? j.coverage : undefined,
    freshness: typeof j.freshness === 'object' && j.freshness != null ? j.freshness : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

// ── Snapshot quality detail ────────────────────────────────────────────────

export interface SnapshotQualityDailyRow {
  snap_day: string
  contract_count: number
  iv_pct: number | null
  full_greeks_pct: number | null
  oi_pct: number | null
  day_price_pct: number | null
}

export interface SnapshotQualityExpiryRow {
  expiry: string
  dte: number | null
  contract_count: number
  iv_pct: number | null
  full_greeks_pct: number | null
  oi_pct: number | null
  day_price_pct: number | null
}

export interface SnapshotQualityDetailResponse {
  ok: boolean
  symbol: string
  source: string
  latest_date: string | null
  daily: SnapshotQualityDailyRow[]
  expiries: SnapshotQualityExpiryRow[]
  error?: string
}

export async function fetchSnapshotQualityDetail(
  symbol: string,
  source = 'massive',
  days = 30,
): Promise<SnapshotQualityDetailResponse> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) {
    return { ok: false, symbol: '', source, latest_date: null, daily: [], expiries: [], error: 'symbol is required' }
  }
  try {
    const r = await fetch(
      massiveUrl(
        `/research/massive/snapshot-quality-detail?symbol=${encodeURIComponent(s)}&source=${encodeURIComponent(source)}&days=${days}`,
      ),
    )
    const j = await r.json().catch(() => ({}))
    return {
      ok: Boolean(j.ok),
      symbol: j.symbol ?? s,
      source: j.source ?? source,
      latest_date: j.latest_date ?? null,
      daily: Array.isArray(j.daily) ? (j.daily as SnapshotQualityDailyRow[]) : [],
      expiries: Array.isArray(j.expiries) ? (j.expiries as SnapshotQualityExpiryRow[]) : [],
      error: j.error != null ? String(j.error) : undefined,
    }
  } catch (e) {
    return {
      ok: false, symbol: s, source, latest_date: null, daily: [], expiries: [],
      error: e instanceof Error ? e.message : 'fetch failed',
    }
  }
}

// ── stock_day gap / quality ────────────────────────────────────────────────────

export interface StockDayMissingYearRow {
  year: number
  count: number
  first_missing: string | null
  last_missing: string | null
}

export interface StockDayGapResult {
  ok: boolean
  symbol?: string
  error?: string
  has_rows?: boolean
  /** NYSE trading-day count in the lookback window through cap_date (weekends + holidays excluded). */
  ref_total?: number
  /** Distinct bar_time count for this symbol. */
  covered_total?: number
  /** ref_total - covered_total */
  gap?: number
  coverage_pct?: number
  missing_by_year?: StockDayMissingYearRow[]
  compared_at?: string
  message?: string
  /** YYYY-MM-DD ceiling applied to ref/covered CTEs (matches the fill's safe end date). */
  cap_date?: string | null
  /**
   * True when cap_date < today (NYSE session still open at check time).
   * Today's bar is excluded from the gap count to prevent phantom gaps —
   * re-run Check after 4:20 PM ET to include today.
   */
  today_pending?: boolean
}

export interface StockDayGapBatchResponse {
  ok: boolean
  results?: Record<string, StockDayGapResult>
  error?: string
}

export interface StockDayQualityDailyRow {
  /** YYYY-MM-DD */
  bar_date: string
  ohlc_pct: number | null
  volume_pct: number | null
  vwap_pct: number | null
}

export interface StockDayQualityDetailResponse {
  ok: boolean
  symbol: string
  latest_date: string | null
  daily: StockDayQualityDailyRow[]
  error?: string
}

/** GET /research/massive/stock-day-gap */
export async function fetchStockDayGap(
  symbol: string,
  years = 10,
): Promise<StockDayGapResult> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s, years: String(years) })
  try {
    const r = await fetch(massiveUrl(`/research/massive/stock-day-gap?${q}`))
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
    return j as StockDayGapResult
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' }
  }
}

/** POST /research/massive/stock-day-gap/batch — max 20 symbols */
export async function postStockDayGapBatch(
  symbols: string[],
  years = 10,
): Promise<StockDayGapBatchResponse> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  try {
    const r = await fetch(massiveUrl('/research/massive/stock-day-gap/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: uniq, years }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
    return j as StockDayGapBatchResponse
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' }
  }
}

/** GET /research/massive/stock-day-quality-detail */
export async function fetchStockDayQualityDetail(
  symbol: string,
  days = 90,
): Promise<StockDayQualityDetailResponse> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, symbol: '', latest_date: null, daily: [], error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s, days: String(days) })
  try {
    const r = await fetch(massiveUrl(`/research/massive/stock-day-quality-detail?${q}`))
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      return { ok: false, symbol: s, latest_date: null, daily: [],
        error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` }
    }
    return j as StockDayQualityDetailResponse
  } catch (e) {
    return { ok: false, symbol: s, latest_date: null, daily: [], error: e instanceof Error ? e.message : 'fetch failed' }
  }
}
