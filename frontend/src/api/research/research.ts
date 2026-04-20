import { getMassiveApiBase, getDocsApiBase, getOpsApiBase, getResearchApiBase, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'
import type { JobQueueStatusCounts } from '../ops/bars'
import { opsAuthHeaders, opsControlFailureMessage, type OpsCapabilities } from '../ops/ops'

/**
 * Massive REST + PostgreSQL reference routes live on the Massive FastAPI process.
 * In Vite dev, GET /health often resolves this base to ``http://127.0.0.1:<massive_port>`` while the UI is
 * ``http://localhost:5173`` — a cross-origin fetch hits CORS and surfaces as "Failed to fetch".
 * The dev server proxies ``/research/massive`` (see vite.config.ts); use a same-origin path so the proxy applies.
 */
function massiveUrl(path: string): string {
  const base = getMassiveApiBase()
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const b = base.replace(/\/$/, '')
    if (!b) {
      return normalizedPath
    }
    try {
      const apiOrigin = new URL(b).origin
      if (apiOrigin !== window.location.origin) {
        return normalizedPath
      }
    } catch {
      /* fall through */
    }
  }
  return joinServiceBase(base, path)
}

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBase(), path)
}
function docsUrl(path: string): string {
  return joinServiceBase(getDocsApiBase(), path)
}

function opsMassiveJobsUrl(path: string): string {
  if (path.startsWith('?')) {
    return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${path}`)
  }
  const p = path.startsWith('/') ? path : `/${path}`
  return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${p}`)
}

/** Per-page Massive REST debug for option-expirations (redacted URLs; full response JSON). */
export interface MassiveOptionExpirationsDebug {
  pages: Array<{
    page_index: number
    request: { method: string; url: string }
    response_status: number
    response: Record<string, unknown>
  }>
  contract_samples: Record<string, unknown>[]
  contract_samples_truncated?: boolean
}

/** R-OD1: Option expirations and strikes (IB and/or Massive REST). Includes last_price from stock_day when available. */
export async function fetchOptionExpirations(
  symbol: string,
  provider: 'auto' | 'ib' | 'massive' = 'auto',
  options?: { debug?: boolean; expiration?: string },
): Promise<{
  symbol: string
  expirations: string[]
  strikes?: number[]
  last_price?: number
  error?: string
  provider?: string
  massive_debug?: MassiveOptionExpirationsDebug
}> {
  const s = (symbol || '').trim()
  if (!s) return { symbol: '', expirations: [], error: 'symbol is required' }
  const dbg = options?.debug ? '&debug=1' : ''
  const exp = options?.expiration ? `&expiration=${encodeURIComponent(options.expiration)}` : ''
  const r = await fetch(
    `${researchApiUrl('/research/option-expirations')}?symbol=${encodeURIComponent(s)}&provider=${encodeURIComponent(provider)}${dbg}${exp}`,
  )
  const j = await r.json().catch(() => ({}))
  const strikes: number[] | undefined = Array.isArray(j.strikes)
    ? (j.strikes.filter((x: unknown) => typeof x === 'number' && Number.isFinite(x)) as number[])
    : undefined
  const last_price =
    j.last_price != null && Number.isFinite(Number(j.last_price)) ? Number(j.last_price) : undefined
  const md = j.massive_debug
  const massive_debug =
    md && typeof md === 'object' && Array.isArray((md as MassiveOptionExpirationsDebug).pages)
      ? (md as MassiveOptionExpirationsDebug)
      : undefined
  return {
    symbol: j.symbol ?? s,
    expirations: Array.isArray(j.expirations) ? j.expirations : [],
    ...(strikes !== undefined ? { strikes } : {}),
    ...(last_price !== undefined ? { last_price } : {}),
    error: j.error,
    provider: typeof j.provider === 'string' ? j.provider : undefined,
    ...(massive_debug ? { massive_debug } : {}),
  }
}

export interface OptionSnapshotRow {
  strike: number
  right: string
  /** Latest snapshot row timestamp from PostgreSQL (ISO 8601) */
  snapshot_ts?: string | null
  /** Display premium: Massive PG uses day_close-derived mark; IB path may use NBBO/last */
  mark?: number | null
  /** IB live path only */
  bid?: number | null
  ask?: number | null
  last?: number | null
  mid?: number | null
  iv?: number | null
  delta?: number | null
  gamma?: number | null
  theta?: number | null
  vega?: number | null
  open_interest?: number | null
  /** Massive `underlying_asset.ticker` when present */
  underlying_ticker?: string | null
  /** Massive chain snapshot `day` bar (delayed tier / no live quote) */
  day_open?: number | null
  day_high?: number | null
  day_low?: number | null
  day_close?: number | null
  day_previous_close?: number | null
  day_change?: number | null
  day_change_percent?: number | null
  day_volume?: number | null
  day_vwap?: number | null
  day_last_updated?: string | null
  /** NY session calendar date for `day_last_updated` (YYYY-MM-DD) */
  day_last_updated_day?: string | null
}

/** OD.3: Option snapshot (bid/ask/last/mid) for symbol + expiration with optional strikes (IB live). */
export async function fetchOptionSnapshot(
  symbol: string,
  expiration: string,
  strikes?: number[],
): Promise<{
  symbol: string
  expiration: string
  underlying_price?: number
  rows: OptionSnapshotRow[]
  error?: string
}> {
  const s = (symbol || '').trim()
  const e = (expiration || '').trim()
  if (!s || !e) {
    return { symbol: s, expiration: e, rows: [], error: 'symbol and expiration are required' }
  }
  const body = { symbol: s, expiration: e, ...(strikes != null ? { strikes } : {}) }
  const r = await fetch(researchApiUrl('/research/option-snapshot'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const rows: OptionSnapshotRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        strike: Number(row.strike),
        right: String(row.right ?? ''),
        bid: row.bid != null && Number.isFinite(Number(row.bid)) ? Number(row.bid) : null,
        ask: row.ask != null && Number.isFinite(Number(row.ask)) ? Number(row.ask) : null,
        last: row.last != null && Number.isFinite(Number(row.last)) ? Number(row.last) : null,
        mid: row.mid != null && Number.isFinite(Number(row.mid)) ? Number(row.mid) : null,
      }))
    : []
  return {
    symbol: j.symbol ?? s,
    expiration: j.expiration ?? e,
    ...(j.underlying_price != null && Number.isFinite(Number(j.underlying_price))
      ? { underlying_price: Number(j.underlying_price) }
      : {}),
    rows,
    error: j.error,
  }
}

export interface MassiveApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  /** Listening port of the Massive FastAPI process (from YAML `server.massive_port`). */
  port?: number
  /** Resolved absolute path of the loaded config file (startup). */
  config_path?: string | null
}

export async function fetchMassiveApiHealth(options?: { timeoutMs?: number }): Promise<MassiveApiHealthResponse> {
  const url = massiveUrl('/research/massive/health')
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(`Massive API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-massive',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

/** Health from GET /health on the Docs FastAPI process (same payload as /research/docs/health). */
export interface DocsApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  /** Listening port of the Docs FastAPI process (from YAML `server.docs_port`). */
  port?: number
  config_path?: string | null
  /** Upstream URLs used to build merged OpenAPI. */
  main_url: string
  massive_url: string
  research_url: string
}

export async function fetchDocsApiHealth(): Promise<DocsApiHealthResponse> {
  const r = await fetch(docsUrl('/health'))
  if (!r.ok) throw new Error(`Docs API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-docs',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
    main_url: typeof j.main_url === 'string' ? j.main_url : '',
    massive_url: typeof j.massive_url === 'string' ? j.massive_url : '',
    research_url: typeof j.research_url === 'string' ? j.research_url : '',
  }
}

/** Same shape as GET /ops/auth/capabilities (shared ops.auth tokens). */
export async function fetchDocsCapabilities(): Promise<OpsCapabilities> {
  const r = await fetch(docsUrl('/research/docs/auth/capabilities'), { headers: opsAuthHeaders() })
  const text = await r.text()
  try {
    return JSON.parse(text) as OpsCapabilities
  } catch {
    throw new Error(
      `Docs API returned non-JSON response (HTTP ${r.status}${text ? `, body: ${text.slice(0, 120)}` : ''}).`,
    )
  }
}

/** Absolute origin (no trailing slash) or empty string for same-origin as the UI. */
export type ApiOriginBase = string

function joinApiOrigin(origin: ApiOriginBase, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const o = origin.replace(/\/$/, '')
  return o ? `${o}${p}` : p
}

/** GET /health on bifrost-server at the given origin (CORS must allow this UI origin when cross-origin). */
export async function fetchHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<{
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod'
}> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-server',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile,
  }
}

export async function fetchMassiveApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<MassiveApiHealthResponse> {
  const url = joinApiOrigin(origin, '/research/massive/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Massive API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-massive',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export interface ResearchApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  port?: number
  config_path?: string | null
}

export async function fetchResearchApiHealth(options?: { timeoutMs?: number }): Promise<ResearchApiHealthResponse> {
  const url = researchApiUrl('/health')
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(`Research API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-research',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export async function fetchResearchApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<ResearchApiHealthResponse> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Research API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-research',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export async function fetchDocsApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<DocsApiHealthResponse> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Docs API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-docs',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
    main_url: typeof j.main_url === 'string' ? j.main_url : '',
    massive_url: typeof j.massive_url === 'string' ? j.massive_url : '',
    research_url: typeof j.research_url === 'string' ? j.research_url : '',
  }
}

export async function postDocsShutdown(): Promise<{ ok: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch(docsUrl('/research/docs/shutdown'), {
      method: 'POST',
      headers: opsAuthHeaders(),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let data: { ok?: boolean; error?: string } = {}
  try {
    const text = await r.text()
    data = text ? (JSON.parse(text) as { ok?: boolean; error?: string }) : {}
  } catch (e) {
    if (!r.ok) {
      return { ok: false, error: `Request failed (HTTP ${r.status})` }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    return { ok: false, error: opsControlFailureMessage(data, r) }
  }
  return { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : undefined }
}

export async function postMassiveShutdown(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/shutdown'), { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    error: j.error || (r.ok ? undefined : r.statusText || 'Request failed'),
  }
}

export interface MassiveStatusResponse {
  configured: boolean
  tier: string
  delay_notice: string
  trades_enabled: boolean
  /** Empty-DB daily_smart backfill window (years), from server massive config */
  daily_full_backfill_years: number
}

export async function fetchMassiveStatus(): Promise<MassiveStatusResponse> {
  const r = await fetch(massiveUrl('/research/massive/status'))
  const j = await r.json().catch(() => ({}))
  const years = Number(j.daily_full_backfill_years)
  return {
    configured: Boolean(j.configured),
    tier: typeof j.tier === 'string' ? j.tier : 'starter',
    delay_notice: typeof j.delay_notice === 'string' ? j.delay_notice : '',
    trades_enabled: Boolean(j.trades_enabled),
    daily_full_backfill_years: Number.isFinite(years) && years > 0 ? years : 5,
  }
}

/** Per-dimension block from GET /research/massive/daily-checklist */
export interface MassiveDailyDimBlock {
  status?: string
  rows?: number
  last_ts?: string
  trade_date?: string
  last_trade_date?: string | null
  last_sync?: string
  connected?: boolean
  last_msg_age_s?: number | null
}

export type MassiveDailyChecklistDims = {
  'daily-snapshot'?: MassiveDailyDimBlock
  'daily-oi'?: MassiveDailyDimBlock
  'daily-max-pain'?: MassiveDailyDimBlock
  'daily-corporate'?: MassiveDailyDimBlock
  'daily-ws-alive'?: MassiveDailyDimBlock
}

export async function fetchMassiveDailyChecklist(params: {
  symbols: string[]
  tradeDate?: string
}): Promise<{
  ok: boolean
  trade_date?: string
  symbols?: Record<string, MassiveDailyChecklistDims>
  error?: string
}> {
  const syms = [...new Set((params.symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(
    0,
    80,
  )
  if (syms.length === 0) {
    return { ok: false, error: 'symbols is required' }
  }
  const q = new URLSearchParams({ symbols: syms.join(',') })
  const td = (params.tradeDate || '').trim()
  if (td) q.set('trade_date', td)
  const r = await fetch(massiveUrl(`/research/massive/daily-checklist?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  const symMap = j.symbols && typeof j.symbols === 'object' ? (j.symbols as Record<string, MassiveDailyChecklistDims>) : {}
  return {
    ok: true,
    trade_date: typeof j.trade_date === 'string' ? j.trade_date : undefined,
    symbols: symMap,
  }
}

/** Row from GET /research/massive/db-coverage-summary */
export interface DbCoverageSummaryRow {
  id: string
  table_name: string
  dataset_label: string
  domain: string
  drill_down_hash: string
  distinct_symbols: number | null
  newest_activity: string | null
  newest_trade_date?: string | null
  error?: string | null
}

export interface DbCoverageSummaryResponse {
  ok: boolean
  error?: string
  generated_at?: string
  tables?: DbCoverageSummaryRow[]
  /** When set, row counts use Massive source filters (see API docs). */
  source_scope?: string
}

/** GET /research/massive/celery-beat-schedule — Massive Celery Beat entries (UTC). */
export interface MassiveCeleryBeatEntry {
  name: string
  task: string
  label: string
  crontab: Record<string, string | number>
}

export interface MassiveCeleryBeatScheduleResponse {
  ok: boolean
  timezone?: string
  entries?: MassiveCeleryBeatEntry[]
  error?: string
}

export async function fetchMassiveCeleryBeatSchedule(): Promise<MassiveCeleryBeatScheduleResponse> {
  const r = await fetch(massiveUrl('/research/massive/celery-beat-schedule'))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  if (j.ok === false) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  return j as MassiveCeleryBeatScheduleResponse
}

export async function fetchDbCoverageSummary(): Promise<DbCoverageSummaryResponse> {
  const r = await fetch(massiveUrl('/research/massive/db-coverage-summary'))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as DbCoverageSummaryResponse
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

export interface WatchlistDbCoverageSymbolRow {
  symbol: string
  option_contracts: WatchlistDbCoverageOptionContracts
  option_snapshots: WatchlistDbCoverageOptionSnapshots
  report_option_atm_iv_daily: {
    has_data: boolean
    atm_iv_last_trade_date: string | null
    atm_iv_last_created_at: string | null
  }
  stock_day: {
    has_data: boolean
    stock_day_last_bar: string | null
    stock_day_last_created_at: string | null
  }
  /** Present when API supports extended option coverage (same deploy as Data Overview matrix). */
  option_day?: WatchlistDbCoverageOptionBars
  option_min?: WatchlistDbCoverageOptionBars
  option_snapshots_with_underlying_day?: WatchlistDbCoverageSnapshotsWithUd
  option_expiration_cache?: WatchlistDbCoverageExpirationCache
  /** Distinct from legacy summary-only placeholder rows; per-symbol OI rollup. */
  option_open_interest_daily?: WatchlistDbCoverageOiDaily
  report_option_max_pain_daily?: WatchlistDbCoverageReportDaily
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
}

export interface OptionContractsReferenceGapResult {
  ok: boolean
  symbol?: string
  error?: string
  has_rows?: boolean
  message?: string
  db_row_count?: number
  pg_total?: number
  massive_total?: number | null
  gap?: number | null
  coverage_pct?: number | null
  compared_at?: string
  expiries?: OptionContractsReferenceGapExpiryRow[]
  truncated?: boolean
  expiries_truncated?: boolean
}

export async function fetchOptionContractsReferenceGap(
  symbol: string,
): Promise<OptionContractsReferenceGapResult> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, error: 'symbol is required' }
  const r = await fetch(
    massiveUrl(`/research/massive/option-contracts-reference-gap?symbol=${encodeURIComponent(s)}`),
  )
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
): Promise<OptionContractsReferenceGapBatchResponse> {
  const uniq = [...new Set(symbols.map(x => (x || '').trim().toUpperCase()).filter(Boolean))]
  if (uniq.length === 0) return { ok: false, error: 'symbols is required' }
  const r = await fetch(massiveUrl('/research/massive/option-contracts-reference-gap/batch'), {
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

/** Live Max Pain from EOD OI (GET /research/max-pain/compute) — not persisted. */
export interface MaxPainStrikePoint {
  strike: number
  pain: number
  pain_call: number
  pain_put: number
  call_oi: number
  put_oi: number
}

export interface MaxPainComputeResponse {
  ok: boolean
  error?: string
  symbol?: string
  expiry?: string
  trade_date?: string
  max_pain_strike?: number
  min_pain_value?: number
  total_oi?: number
  underlying_close?: number | null
  distance_to_max_pain_pct?: number | null
  pain_by_strike?: MaxPainStrikePoint[]
  recent_corporate_action?: boolean
  /** eod_open_interest_daily | chain_snapshot — OI source for the curve */
  oi_basis?: string
}

export async function fetchMaxPainCompute(params: {
  symbol: string
  expiry: string
  tradeDate?: string
}): Promise<MaxPainComputeResponse> {
  const sym = (params.symbol || '').trim().toUpperCase()
  const exp = (params.expiry || '').trim()
  if (!sym || !exp) return { ok: false, error: 'symbol and expiry are required' }
  const q = new URLSearchParams({ symbol: sym, expiry: exp })
  const td = (params.tradeDate || '').trim()
  if (td) q.set('trade_date', td)
  const r = await fetch(`${researchApiUrl('/research/max-pain/compute')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  const pts = Array.isArray(j.pain_by_strike) ? j.pain_by_strike : []
  return {
    ok: true,
    symbol: typeof j.symbol === 'string' ? j.symbol : sym,
    expiry: typeof j.expiry === 'string' ? j.expiry : undefined,
    trade_date: typeof j.trade_date === 'string' ? j.trade_date : undefined,
    max_pain_strike: typeof j.max_pain_strike === 'number' ? j.max_pain_strike : undefined,
    min_pain_value: typeof j.min_pain_value === 'number' ? j.min_pain_value : undefined,
    total_oi: typeof j.total_oi === 'number' ? j.total_oi : undefined,
    underlying_close: j.underlying_close != null && Number.isFinite(Number(j.underlying_close)) ? Number(j.underlying_close) : null,
    distance_to_max_pain_pct:
      j.distance_to_max_pain_pct != null && Number.isFinite(Number(j.distance_to_max_pain_pct))
        ? Number(j.distance_to_max_pain_pct)
        : null,
    pain_by_strike: pts.map((p: Record<string, unknown>) => ({
      strike: Number(p.strike),
      pain: Number(p.pain),
      pain_call: Number(p.pain_call ?? 0),
      pain_put: Number(p.pain_put ?? 0),
      call_oi: Number(p.call_oi ?? 0),
      put_oi: Number(p.put_oi ?? 0),
    })),
    recent_corporate_action: Boolean(j.recent_corporate_action),
    oi_basis: typeof j.oi_basis === 'string' ? j.oi_basis : undefined,
  }
}

export interface MaxPainHistoryPoint {
  trade_date: string
  max_pain_strike: number
  total_oi: number
  underlying_close?: number | null
}

export async function fetchMaxPainComputeHistory(params: {
  symbol: string
  expiry: string
  lookbackDays?: number
}): Promise<{ ok: boolean; error?: string; expiry?: string; series: MaxPainHistoryPoint[] }> {
  const sym = (params.symbol || '').trim().toUpperCase()
  const exp = (params.expiry || '').trim()
  if (!sym || !exp) return { ok: false, error: 'symbol and expiry are required', series: [] }
  const q = new URLSearchParams({ symbol: sym, expiry: exp })
  if (params.lookbackDays != null && params.lookbackDays > 0) q.set('lookback_days', String(params.lookbackDays))
  const r = await fetch(`${researchApiUrl('/research/max-pain/compute/history')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed', series: [] }
  }
  const raw = Array.isArray(j.series) ? j.series : []
  const series: MaxPainHistoryPoint[] = raw.map((row: Record<string, unknown>) => ({
    trade_date: String(row.trade_date ?? ''),
    max_pain_strike: Number(row.max_pain_strike),
    total_oi: Number(row.total_oi ?? 0),
    underlying_close:
      row.underlying_close != null && Number.isFinite(Number(row.underlying_close))
        ? Number(row.underlying_close)
        : null,
  }))
  return { ok: true, expiry: typeof j.expiry === 'string' ? j.expiry : undefined, series }
}

export async function postMassiveSync(
  kind: string,
  payload: Record<string, unknown>,
  options?: { priority?: 'high' },
): Promise<{ ok: boolean; job_id?: string; error?: string; message?: string; deduplicated?: boolean }> {
  const r = await fetch(massiveUrl('/research/massive/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      payload,
      ...(options?.priority === 'high' ? { priority: 'high' } : {}),
    }),
  })
  const j = await r.json().catch(() => ({}))
  if (r.status === 403) {
    return { ok: false, message: typeof j.message === 'string' ? j.message : 'Forbidden' }
  }
  return {
    ok: Boolean(j.ok),
    job_id: typeof j.job_id === 'string' ? j.job_id : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
    deduplicated: typeof j.deduplicated === 'boolean' ? j.deduplicated : undefined,
  }
}

export async function postMassiveApiCoverageSync(): Promise<{
  ok: boolean
  error?: string
  source?: string
  target?: string
  size_bytes?: number
}> {
  const r = await fetch(massiveUrl('/research/massive/api-coverage/sync'), {
    method: 'POST',
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok) && r.ok,
    error: typeof j.error === 'string' ? j.error : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    target: typeof j.target === 'string' ? j.target : undefined,
    size_bytes: Number.isFinite(Number(j.size_bytes)) ? Number(j.size_bytes) : undefined,
  }
}

export async function postMassiveStocksApiCoverageSync(): Promise<{
  ok: boolean
  error?: string
  source?: string
  target?: string
  size_bytes?: number
}> {
  const r = await fetch(massiveUrl('/research/massive/stocks-api-coverage/sync'), {
    method: 'POST',
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok) && r.ok,
    error: typeof j.error === 'string' ? j.error : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    target: typeof j.target === 'string' ? j.target : undefined,
    size_bytes: Number.isFinite(Number(j.size_bytes)) ? Number(j.size_bytes) : undefined,
  }
}

export interface MassiveJobApiRow {
  job_id: string
  type?: string
  kind?: string
  status?: string
  result?: unknown
  created_ts?: number
  updated_ts?: number
}

export async function fetchMassiveJobsSummary(celeryQueue: string): Promise<{
  ok: boolean
  counts: JobQueueStatusCounts
  error?: string
}> {
  const q = new URLSearchParams()
  if (celeryQueue.trim()) q.set('celery_queue', celeryQueue.trim())
  const r = await fetch(opsMassiveJobsUrl(`/summary?${q.toString()}`), { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  const c = j.counts as Record<string, unknown> | undefined
  const counts: JobQueueStatusCounts = {
    pending: typeof c?.pending === 'number' ? c.pending : 0,
    running: typeof c?.running === 'number' ? c.running : 0,
    done: typeof c?.done === 'number' ? c.done : 0,
    failed: typeof c?.failed === 'number' ? c.failed : 0,
  }
  return {
    ok: r.ok && j.ok !== false,
    counts,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function postMassiveJobsClearDone(celeryQueue: string): Promise<{
  ok: boolean
  deleted: number
  error?: string
}> {
  const q = new URLSearchParams()
  if (celeryQueue.trim()) q.set('celery_queue', celeryQueue.trim())
  const qs = q.toString()
  const r = await fetch(opsMassiveJobsUrl(`/clear-done${qs ? `?${qs}` : ''}`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function postRetryFailedMassiveJobs(
  celeryQueue: string,
  limit = 200,
): Promise<{
  ok: boolean
  error?: string
  reset?: number
  enqueued?: number
  enqueue_errors?: { job_id: string; error: string }[]
}> {
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(2000, limit))) })
  if (celeryQueue.trim()) params.set('celery_queue', celeryQueue.trim())
  const r = await fetch(opsMassiveJobsUrl(`/retry-failed?${params}`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok === true,
    error: typeof j.error === 'string' ? j.error : undefined,
    reset: typeof j.reset === 'number' ? j.reset : undefined,
    enqueued: typeof j.enqueued === 'number' ? j.enqueued : undefined,
    enqueue_errors: Array.isArray(j.enqueue_errors) ? j.enqueue_errors : undefined,
  }
}

export async function fetchMassiveJobsList(options?: {
  limit?: number
  offset?: number
  status?: string
  kind?: string
  /** Broker queue slice (massive, massive_high, massive_stocks, massive_stocks_high). */
  celery_queue?: string
}): Promise<{ ok: boolean; jobs: MassiveJobApiRow[]; error?: string }> {
  const q = new URLSearchParams()
  if (options?.limit != null) q.set('limit', String(options.limit))
  if (options?.offset != null) q.set('offset', String(options.offset))
  if (options?.status?.trim()) q.set('status', options.status.trim())
  if (options?.kind?.trim()) q.set('kind', options.kind.trim())
  if (options?.celery_queue?.trim()) q.set('celery_queue', options.celery_queue.trim())
  const r = await fetch(opsMassiveJobsUrl(`?${q.toString()}`), { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return {
      ok: false,
      jobs: [],
      error: typeof j.error === 'string' ? j.error : 'Request failed',
    }
  }
  const raw = Array.isArray(j.jobs) ? j.jobs : []
  const jobs: MassiveJobApiRow[] = raw.map((row: Record<string, unknown>) => ({
    job_id: String(row.job_id ?? ''),
    type: typeof row.type === 'string' ? row.type : undefined,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    status: typeof row.status === 'string' ? row.status : undefined,
    result: row.result,
    created_ts: typeof row.created_ts === 'number' ? row.created_ts : undefined,
    updated_ts: typeof row.updated_ts === 'number' ? row.updated_ts : undefined,
  }))
  return { ok: true, jobs }
}

export async function deleteMassiveJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(opsMassiveJobsUrl(`/${encodeURIComponent(jobId)}`), {
    method: 'DELETE',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: typeof j.error === 'string' ? j.error : undefined }
}

export async function deleteAllMassiveJobs(
  status?: string | null,
  celeryQueue?: string | null,
): Promise<{
  ok: boolean
  deleted: number
  error?: string
}> {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  if (celeryQueue?.trim()) params.set('celery_queue', celeryQueue.trim())
  const qs = params.toString()
  const r = await fetch(opsMassiveJobsUrl(`/purge${qs ? `?${qs}` : ''}`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; deleted?: number; error?: string; detail?: string }
  const err =
    typeof j.error === 'string'
      ? j.error
      : typeof j.detail === 'string'
        ? j.detail
        : undefined
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: err,
  }
}

export async function trimMassiveJobs(
  keep: number,
  celeryQueue?: string | null,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const params = new URLSearchParams({ keep: String(keep) })
  if (celeryQueue?.trim()) params.set('celery_queue', celeryQueue.trim())
  const r = await fetch(opsMassiveJobsUrl(`/trim?${params}`), { method: 'POST', headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

/** SSE until job reaches done/failed or stream errors. */
export function subscribeMassiveJobEvents(
  jobId: string,
  onEvent: (data: { ok: boolean; job?: MassiveJobApiRow; error?: string }) => void,
  options?: { timeoutSec?: number },
): { close: () => void } {
  const qs = new URLSearchParams()
  if (options?.timeoutSec != null) qs.set('timeout_sec', String(options.timeoutSec))
  const url = massiveUrl(`/research/massive/jobs/${encodeURIComponent(jobId)}/events?${qs.toString()}`)
  const es = new EventSource(url)
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as { ok: boolean; job?: MassiveJobApiRow; error?: string }
      onEvent(data)
      const st = data.job?.status
      if (data.ok === false || st === 'done' || st === 'failed') {
        es.close()
      }
    } catch {
      onEvent({ ok: false, error: 'Invalid SSE payload' })
      es.close()
    }
  }
  es.onerror = () => {
    onEvent({ ok: false, error: 'SSE connection error' })
    es.close()
  }
  return { close: () => es.close() }
}

export async function fetchMassiveJob(jobId: string): Promise<{
  ok: boolean
  error?: string
  job?: {
    job_id: string
    kind?: string
    status?: string
    result?: unknown
    created_ts?: number
    updated_ts?: number
  }
}> {
  const r = await fetch(opsMassiveJobsUrl(`/${encodeURIComponent(jobId)}`), { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Unknown error' }
  }
  const job = j.job as Record<string, unknown> | undefined
  if (!job) return { ok: true }
  return {
    ok: true,
    job: {
      job_id: String(job.job_id ?? ''),
      kind: typeof job.kind === 'string' ? job.kind : undefined,
      status: typeof job.status === 'string' ? job.status : undefined,
      result: job.result,
      created_ts: typeof job.created_ts === 'number' ? job.created_ts : undefined,
      updated_ts: typeof job.updated_ts === 'number' ? job.updated_ts : undefined,
    },
  }
}

export interface OptionSnapshotsPgResult {
  symbol: string
  expiration: string
  underlying_price?: number
  rows: OptionSnapshotRow[]
  error?: string
  warning?: string
}

/** Latest option_snapshots from PostgreSQL (after Massive sync). */
export async function fetchOptionSnapshotsPg(
  symbol: string,
  expiration: string,
  strikesCsv?: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<OptionSnapshotsPgResult> {
  const s = (symbol || '').trim()
  const e = (expiration || '').trim()
  const q = new URLSearchParams({ symbol: s, expiration: e, source })
  if (strikesCsv && strikesCsv.trim()) q.set('strikes', strikesCsv.trim())
  const r = await fetch(`${researchApiUrl('/research/option-snapshots')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  const rows: OptionSnapshotRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        strike: Number(row.strike),
        right: String(row.right ?? ''),
        snapshot_ts: typeof row.snapshot_ts === 'string' ? row.snapshot_ts : null,
        mark: row.mark != null && Number.isFinite(Number(row.mark)) ? Number(row.mark) : null,
        iv: row.iv != null && Number.isFinite(Number(row.iv)) ? Number(row.iv) : null,
        delta: row.delta != null && Number.isFinite(Number(row.delta)) ? Number(row.delta) : null,
        gamma: row.gamma != null && Number.isFinite(Number(row.gamma)) ? Number(row.gamma) : null,
        theta: row.theta != null && Number.isFinite(Number(row.theta)) ? Number(row.theta) : null,
        vega: row.vega != null && Number.isFinite(Number(row.vega)) ? Number(row.vega) : null,
        open_interest:
          row.open_interest != null && Number.isFinite(Number(row.open_interest))
            ? Number(row.open_interest)
            : null,
        underlying_ticker: typeof row.underlying_ticker === 'string' ? row.underlying_ticker : null,
        day_open: row.day_open != null && Number.isFinite(Number(row.day_open)) ? Number(row.day_open) : null,
        day_high: row.day_high != null && Number.isFinite(Number(row.day_high)) ? Number(row.day_high) : null,
        day_low: row.day_low != null && Number.isFinite(Number(row.day_low)) ? Number(row.day_low) : null,
        day_close: row.day_close != null && Number.isFinite(Number(row.day_close)) ? Number(row.day_close) : null,
        day_previous_close:
          row.day_previous_close != null && Number.isFinite(Number(row.day_previous_close))
            ? Number(row.day_previous_close)
            : null,
        day_change:
          row.day_change != null && Number.isFinite(Number(row.day_change)) ? Number(row.day_change) : null,
        day_change_percent:
          row.day_change_percent != null && Number.isFinite(Number(row.day_change_percent))
            ? Number(row.day_change_percent)
            : null,
        day_volume:
          row.day_volume != null && Number.isFinite(Number(row.day_volume)) ? Number(row.day_volume) : null,
        day_vwap: row.day_vwap != null && Number.isFinite(Number(row.day_vwap)) ? Number(row.day_vwap) : null,
        day_last_updated: typeof row.day_last_updated === 'string' ? row.day_last_updated : null,
        day_last_updated_day:
          typeof row.day_last_updated_day === 'string' ? row.day_last_updated_day : null,
      }))
    : []
  return {
    symbol: j.symbol ?? s,
    expiration: j.expiration ?? e,
    ...(j.underlying_price != null && Number.isFinite(Number(j.underlying_price))
      ? { underlying_price: Number(j.underlying_price) }
      : {}),
    rows,
    error: typeof j.error === 'string' ? j.error : undefined,
    warning: typeof j.warning === 'string' ? j.warning : undefined,
  }
}

export interface CorporateActionRow {
  symbol: string
  action_type: string
  ex_date: string | null
  record_date: string | null
  payment_date: string | null
  ratio_from: number | null
  ratio_to: number | null
  amount: number | null
  description: string | null
  source: string | null
}

/** GET /research/option-oi — daily OI rows when table is populated. */
export async function fetchResearchOptionOi(
  symbol: string,
  options?: { limit?: number },
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const s = (symbol || '').trim()
  if (!s) return { rows: [], error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (options?.limit != null) q.set('limit', String(options.limit))
  const r = await fetch(`${researchApiUrl('/research/option-oi')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  const rows = Array.isArray(j.rows) ? j.rows : []
  return { rows, error: typeof j.error === 'string' ? j.error : undefined }
}

/** GET /research/option-trades — 403 when trades disabled by tier/config. */
export async function fetchResearchOptionTrades(
  symbol: string,
  options?: { limit?: number },
): Promise<{
  ok: boolean
  status: number
  trades: Record<string, unknown>[]
  message?: string
  error?: string
}> {
  const s = (symbol || '').trim()
  if (!s) return { ok: false, status: 0, trades: [], error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (options?.limit != null) q.set('limit', String(options.limit))
  const r = await fetch(`${researchApiUrl('/research/option-trades')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  const trades = Array.isArray(j.trades) ? j.trades : []
  return {
    ok: Boolean(j.ok) && r.ok,
    status: r.status,
    trades,
    message: typeof j.message === 'string' ? j.message : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchCorporateActions(
  symbol: string,
  options?: { action_type?: string; limit?: number },
): Promise<{ ok: boolean; rows: CorporateActionRow[]; error?: string }> {
  const q = new URLSearchParams({ symbol: (symbol || '').trim() })
  if (options?.action_type) q.set('action_type', options.action_type)
  if (options?.limit != null) q.set('limit', String(options.limit))
  const r = await fetch(massiveUrl(`/research/massive/corporate-actions?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (!j.ok) return { ok: false, rows: [], error: typeof j.error === 'string' ? j.error : 'Request failed' }
  const rows: CorporateActionRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        symbol: String(row.symbol ?? ''),
        action_type: String(row.action_type ?? ''),
        ex_date: typeof row.ex_date === 'string' ? row.ex_date : null,
        record_date: typeof row.record_date === 'string' ? row.record_date : null,
        payment_date: typeof row.payment_date === 'string' ? row.payment_date : null,
        ratio_from: row.ratio_from != null ? Number(row.ratio_from) : null,
        ratio_to: row.ratio_to != null ? Number(row.ratio_to) : null,
        amount: row.amount != null ? Number(row.amount) : null,
        description: typeof row.description === 'string' ? row.description : null,
        source: typeof row.source === 'string' ? row.source : null,
      }))
    : []
  return { ok: true, rows }
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

export async function fetchMassiveMarketConditions(opts?: {
  asset_class?: string
  data_type?: string
  limit?: number
}): Promise<{ ok: boolean; results: Record<string, unknown>[]; count?: number; error?: string }> {
  const q = new URLSearchParams()
  if (opts?.asset_class) q.set('asset_class', opts.asset_class)
  if (opts?.data_type) q.set('data_type', opts.data_type)
  if (opts?.limit) q.set('limit', String(opts.limit))
  const r = await fetch(massiveUrl(`/research/massive/market-ops/conditions?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return { ok: Boolean(j.ok), results: Array.isArray(j.results) ? j.results : [], count: j.count, error: j.error }
}

export async function fetchMassiveMarketExchanges(opts?: {
  asset_class?: string
  locale?: string
}): Promise<{ ok: boolean; results: Record<string, unknown>[]; count?: number; error?: string }> {
  const q = new URLSearchParams()
  if (opts?.asset_class) q.set('asset_class', opts.asset_class)
  if (opts?.locale) q.set('locale', opts.locale)
  const r = await fetch(massiveUrl(`/research/massive/market-ops/exchanges?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return { ok: Boolean(j.ok), results: Array.isArray(j.results) ? j.results : [], count: j.count, error: j.error }
}

export interface MassiveMarketHolidaysResponse {
  ok: boolean
  massive_holidays: Record<string, unknown>[]
  massive_count?: number
  local_holidays: Record<string, unknown>[]
  local_count?: number
  comparison?: {
    in_massive_only: string[]
    in_local_only: string[]
    in_both: string[]
  }
  error?: string
}

export async function fetchMassiveMarketHolidays(): Promise<MassiveMarketHolidaysResponse> {
  const r = await fetch(massiveUrl('/research/massive/market-ops/holidays'))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    massive_holidays: Array.isArray(j.massive_holidays) ? j.massive_holidays : [],
    massive_count: j.massive_count,
    local_holidays: Array.isArray(j.local_holidays) ? j.local_holidays : [],
    local_count: j.local_count,
    comparison: j.comparison,
    error: j.error,
  }
}

export async function fetchMassiveMarketStatus(): Promise<{ ok: boolean; status?: Record<string, unknown>; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/market-ops/status'))
  const j = await r.json().catch(() => ({}))
  return { ok: Boolean(j.ok), status: j.status, error: j.error }
}

export type MassiveTickerProxyResponse = {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

/** Massive FastAPI returns { ok, error }; nginx/connection failures may omit ok or return FastAPI { detail }. */
function parseMassiveTickerProxyResponse(
  j: Record<string, unknown>,
  r: Response,
): Pick<MassiveTickerProxyResponse, 'ok' | 'error'> {
  if (typeof j.error === 'string' && j.error.trim()) {
    return { ok: false, error: j.error }
  }
  if (j.error != null) {
    return {
      ok: false,
      error: typeof j.error === 'object' ? JSON.stringify(j.error) : String(j.error),
    }
  }
  const detail = j.detail
  if (typeof detail === 'string' && detail.trim()) {
    return { ok: false, error: detail }
  }
  if (Array.isArray(detail)) {
    const parts = detail.map((x: unknown) =>
      x && typeof x === 'object' && 'msg' in x ? String((x as { msg: unknown }).msg) : JSON.stringify(x),
    )
    return { ok: false, error: parts.join('; ') }
  }
  if (detail != null && typeof detail === 'object') {
    return { ok: false, error: JSON.stringify(detail) }
  }
  if (!r.ok) {
    if (r.status === 502 || r.status === 503 || r.status === 504) {
      return {
        ok: false,
        error: `Massive API unreachable (HTTP ${r.status}). Start the Massive server (e.g. python scripts/run_server_massive.py) on server.massive_port from your config.`,
      }
    }
    return { ok: false, error: `HTTP ${r.status}` }
  }
  if (j.ok === true) {
    return { ok: true, error: undefined }
  }
  if (j.ok === false) {
    return { ok: false, error: 'Request failed' }
  }
  return { ok: false, error: 'Empty or unrecognized response from Massive API' }
}

/** GET /v3/reference/tickers (via Massive server proxy). */
export async function fetchMassiveReferenceTickers(opts?: {
  ticker?: string
  type?: string
  market?: string
  exchange?: string
  search?: string
  active?: boolean
  date?: string
  limit?: number
  sort?: string
  order?: string
  cursor?: string
}): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker)
  if (opts?.type) q.set('type', opts.type)
  if (opts?.market) q.set('market', opts.market)
  if (opts?.exchange) q.set('exchange', opts.exchange)
  if (opts?.search) q.set('search', opts.search)
  if (opts?.active !== undefined) q.set('active', String(opts.active))
  if (opts?.date) q.set('date', opts.date)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  if (opts?.order) q.set('order', opts.order)
  if (opts?.cursor) q.set('cursor', opts.cursor)
  const r = await fetch(massiveUrl(`/research/massive/tickers?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** GET /v3/reference/tickers/{ticker} (proxy). */
export async function fetchMassiveTickerDetail(
  ticker: string,
  opts?: { date?: string },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.date) q.set('date', opts.date)
  const qs = q.toString()
  const path = `/research/massive/tickers/${encodeURIComponent(ticker)}${qs ? `?${qs}` : ''}`
  const r = await fetch(massiveUrl(path))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** GET /v3/reference/tickers/types (proxy). */
export async function fetchMassiveTickerTypes(opts?: {
  asset_class?: string
  locale?: string
}): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.asset_class) q.set('asset_class', opts.asset_class)
  if (opts?.locale) q.set('locale', opts.locale)
  const r = await fetch(massiveUrl(`/research/massive/tickers/types?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** GET /v1/related-companies/{ticker} (proxy). */
export async function fetchMassiveRelatedCompanies(ticker: string): Promise<MassiveTickerProxyResponse> {
  const r = await fetch(massiveUrl(`/research/massive/related-companies/${encodeURIComponent(ticker)}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** Stock OHLC aggregates (GET proxies under ``/research/massive/stocks/bars/``). */
export async function fetchMassiveStockBarsRange(opts: {
  ticker: string
  multiplier?: number
  timespan?: string
  start_ms: number
  end_ms: number
}): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  q.set('ticker', opts.ticker.trim())
  q.set('multiplier', String(opts.multiplier ?? 1))
  q.set('timespan', (opts.timespan ?? 'minute').trim() || 'minute')
  q.set('start_ms', String(opts.start_ms))
  q.set('end_ms', String(opts.end_ms))
  const r = await fetch(massiveUrl(`/research/massive/stocks/bars/range?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

export async function fetchMassiveStockGroupedDaily(
  date: string,
  opts?: { adjusted?: boolean },
): Promise<MassiveTickerProxyResponse> {
  const d = date.trim()
  const q = new URLSearchParams()
  if (opts?.adjusted === false) q.set('adjusted', 'false')
  const qs = q.toString()
  const r = await fetch(
    massiveUrl(`/research/massive/stocks/bars/grouped-daily/${encodeURIComponent(d)}${qs ? `?${qs}` : ''}`),
  )
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

export async function fetchMassiveStockOpenClose(
  ticker: string,
  date: string,
  opts?: { adjusted?: boolean },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.adjusted === false) q.set('adjusted', 'false')
  const qs = q.toString()
  const path = `/research/massive/stocks/bars/open-close/${encodeURIComponent(ticker.trim())}/${encodeURIComponent(date.trim())}${qs ? `?${qs}` : ''}`
  const r = await fetch(massiveUrl(path))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

export async function fetchMassiveStockPrev(
  ticker: string,
  opts?: { adjusted?: boolean },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.adjusted === false) q.set('adjusted', 'false')
  const qs = q.toString()
  const path = `/research/massive/stocks/bars/prev/${encodeURIComponent(ticker.trim())}${qs ? `?${qs}` : ''}`
  const r = await fetch(massiveUrl(path))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** PostgreSQL-backed ticker reference: search autocomplete. */
export interface TickerReferenceSearchRow {
  tickers_id: number
  ticker: string
  symbol: string
  name: string | null
  exchange: string | null
  primary_exchange: string | null
  instrument_type: string | null
  active: boolean | null
}

/** @deprecated use TickerReferenceSearchRow */
export type StockReferenceSearchRow = TickerReferenceSearchRow

export async function fetchTickerReferenceSearch(opts: {
  q: string
  limit?: number
}): Promise<{
  ok: boolean
  results?: TickerReferenceSearchRow[]
  cached?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  q.set('q', opts.q)
  if (opts.limit != null) q.set('limit', String(opts.limit))
  try {
    const r = await fetch(massiveUrl(`/research/massive/reference/tickers/search?${q.toString()}`))
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    return {
      ok: true,
      cached: Boolean(j.cached),
      results: (j.results as TickerReferenceSearchRow[]) ?? [],
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** @deprecated use fetchTickerReferenceSearch */
export const fetchStockReferenceSearch = fetchTickerReferenceSearch

/** GET ``/research/massive/reference/tickers/overview-coverage`` — universe vs ``ticker_overview`` row counts. */
export async function fetchTickerReferenceOverviewCoverage(): Promise<{
  ok: boolean
  total_tickers?: number
  missing?: number
  filled?: number
  error?: string
}> {
  try {
    const r = await fetch(massiveUrl('/research/massive/reference/tickers/overview-coverage'))
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    return {
      ok: true,
      total_tickers: typeof j.total_tickers === 'number' ? j.total_tickers : Number(j.total_tickers),
      missing: typeof j.missing === 'number' ? j.missing : Number(j.missing),
      filled: typeof j.filled === 'number' ? j.filled : Number(j.filled),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** ``GET /research/massive/reference/tickers/universe-count`` — row count for ``tickers`` (universe sync). */
export async function fetchTickerReferenceUniverseCount(): Promise<{
  ok: boolean
  total_tickers?: number
  error?: string
}> {
  try {
    const r = await fetch(massiveUrl('/research/massive/reference/tickers/universe-count'))
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    const n = j.total_tickers
    return {
      ok: true,
      total_tickers: typeof n === 'number' ? n : Number(n),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** ``GET /research/massive/reference/ticker-types/count`` — row count for ``ticker_types``. */
export async function fetchTickerReferenceTickerTypesRowCount(): Promise<{
  ok: boolean
  total_ticker_types?: number
  error?: string
}> {
  try {
    const r = await fetch(massiveUrl('/research/massive/reference/ticker-types/count'))
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    const n = j.total_ticker_types
    return {
      ok: true,
      total_ticker_types: typeof n === 'number' ? n : Number(n),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** Paged tickers with no ``ticker_overview`` row (same scope as overview job “missing” mode). */
export async function fetchTickerReferenceMissingOverview(opts: {
  limit?: number
  offset?: number
}): Promise<{
  ok: boolean
  tickers?: string[]
  limit?: number
  offset?: number
  total_missing?: number
  has_more?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  if (opts.limit != null) q.set('limit', String(opts.limit))
  if (opts.offset != null) q.set('offset', String(opts.offset))
  try {
    const r = await fetch(
      massiveUrl(`/research/massive/reference/tickers/missing-overview?${q.toString()}`),
    )
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    const tickers = j.tickers
    return {
      ok: true,
      tickers: Array.isArray(tickers) ? (tickers as string[]) : [],
      limit: typeof j.limit === 'number' ? j.limit : Number(j.limit),
      offset: typeof j.offset === 'number' ? j.offset : Number(j.offset),
      total_missing:
        typeof j.total_missing === 'number' ? j.total_missing : Number(j.total_missing),
      has_more: Boolean(j.has_more),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** GET ``/research/massive/reference/tickers/related-coverage`` — ``tickers`` vs ``ticker_related_tickers`` counts. */
export async function fetchTickerReferenceRelatedCoverage(): Promise<{
  ok: boolean
  total_tickers?: number
  missing?: number
  filled?: number
  error?: string
}> {
  try {
    const r = await fetch(massiveUrl('/research/massive/reference/tickers/related-coverage'))
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    return {
      ok: true,
      total_tickers: typeof j.total_tickers === 'number' ? j.total_tickers : Number(j.total_tickers),
      missing: typeof j.missing === 'number' ? j.missing : Number(j.missing),
      filled: typeof j.filled === 'number' ? j.filled : Number(j.filled),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** Paged tickers with no rows in ``ticker_related_tickers`` for ``from_tickers_id``. */
export async function fetchTickerReferenceMissingRelated(opts: {
  limit?: number
  offset?: number
}): Promise<{
  ok: boolean
  tickers?: string[]
  limit?: number
  offset?: number
  total_missing?: number
  has_more?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  if (opts.limit != null) q.set('limit', String(opts.limit))
  if (opts.offset != null) q.set('offset', String(opts.offset))
  try {
    const r = await fetch(
      massiveUrl(`/research/massive/reference/tickers/missing-related?${q.toString()}`),
    )
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    const tickers = j.tickers
    return {
      ok: true,
      tickers: Array.isArray(tickers) ? (tickers as string[]) : [],
      limit: typeof j.limit === 'number' ? j.limit : Number(j.limit),
      offset: typeof j.offset === 'number' ? j.offset : Number(j.offset),
      total_missing:
        typeof j.total_missing === 'number' ? j.total_missing : Number(j.total_missing),
      has_more: Boolean(j.has_more),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

/** Paged tickers that have at least one related peer row. */
export async function fetchTickerReferenceFilledRelated(opts: {
  limit?: number
  offset?: number
}): Promise<{
  ok: boolean
  tickers?: string[]
  limit?: number
  offset?: number
  total_filled?: number
  has_more?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  if (opts.limit != null) q.set('limit', String(opts.limit))
  if (opts.offset != null) q.set('offset', String(opts.offset))
  try {
    const r = await fetch(
      massiveUrl(`/research/massive/reference/tickers/filled-related?${q.toString()}`),
    )
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!j.ok) {
      return { ok: false, error: String(j.error ?? r.statusText) }
    }
    const tickers = j.tickers
    return {
      ok: true,
      tickers: Array.isArray(tickers) ? (tickers as string[]) : [],
      limit: typeof j.limit === 'number' ? j.limit : Number(j.limit),
      offset: typeof j.offset === 'number' ? j.offset : Number(j.offset),
      total_filled:
        typeof j.total_filled === 'number' ? j.total_filled : Number(j.total_filled),
      has_more: Boolean(j.has_more),
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
}

export async function fetchTickerReferenceDetail(symbol: string): Promise<{
  ok: boolean
  ticker?: Record<string, unknown>
  cached?: boolean
  error?: string
}> {
  const r = await fetch(
    massiveUrl(`/research/massive/reference/tickers/${encodeURIComponent(symbol.trim())}`),
  )
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    cached: Boolean(j.cached),
    ticker: typeof j.ticker === 'object' && j.ticker != null ? (j.ticker as Record<string, unknown>) : undefined,
  }
}

/** @deprecated use fetchTickerReferenceDetail */
export async function fetchStockReferenceDetail(symbol: string): Promise<{
  ok: boolean
  stock?: Record<string, unknown>
  cached?: boolean
  error?: string
}> {
  const r = await fetchTickerReferenceDetail(symbol)
  return { ...r, stock: r.ticker }
}

export async function fetchTickerReferenceRelated(symbol: string): Promise<{
  ok: boolean
  data?: Record<string, unknown>
  cached?: boolean
  error?: string
}> {
  const r = await fetch(
    massiveUrl(`/research/massive/reference/tickers/${encodeURIComponent(symbol.trim())}/related`),
  )
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    cached: Boolean(j.cached),
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** @deprecated use fetchTickerReferenceRelated */
export const fetchStockReferenceRelated = fetchTickerReferenceRelated

/** Rows from ``ticker_types`` (synced via Celery ``feed_stocks_tickers_types``). */
export async function fetchTickerTypesFromDb(opts?: {
  asset_class?: string
  locale?: string
}): Promise<{
  ok: boolean
  results?: Record<string, unknown>[]
  cached?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  q.set('asset_class', opts?.asset_class ?? '*')
  q.set('locale', opts?.locale ?? '*')
  const r = await fetch(massiveUrl(`/research/massive/reference/ticker-types?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  const rows = j.results
  return {
    ok: true,
    cached: Boolean(j.cached),
    results: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
  }
}

/** @deprecated use fetchTickerTypesFromDb */
export const fetchTickerReferenceInstrumentTypes = fetchTickerTypesFromDb

/** @deprecated use fetchTickerTypesFromDb */
export const fetchStockReferenceInstrumentTypes = fetchTickerTypesFromDb

export type TickerReferenceJobKind =
  | 'feed_stocks_tickers_reference_universe'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_reference_universe for new work. */
  | 'ticker_reference_universe'
  | 'feed_stocks_tickers_overview'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_overview for new work. */
  | 'ticker_reference_overview'
  | 'feed_stocks_tickers_related'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_related for new work. */
  | 'ticker_reference_related'
  | 'feed_stocks_tickers_types'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_types for new work. */
  | 'ticker_reference_ticker_types'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_types for new work. */
  | 'ticker_reference_instrument_types'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_reference_universe for new work. */
  | 'stock_reference_universe'
  | 'stock_reference_overview'
  | 'stock_reference_related'
  /** @deprecated Historical job rows only; prefer feed_stocks_tickers_types for new work. */
  | 'stock_reference_instrument_types'

/** @deprecated use TickerReferenceJobKind */
export type StockReferenceJobKind = TickerReferenceJobKind

export async function postTickerReferenceJob(body: {
  kind: TickerReferenceJobKind
  payload?: Record<string, unknown>
  priority?: string
}): Promise<{ ok: boolean; job_id?: string; deduplicated?: boolean; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/jobs/ticker-reference'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    job_id: j.job_id != null ? String(j.job_id) : undefined,
    deduplicated: Boolean(j.deduplicated),
  }
}

/** @deprecated use postTickerReferenceJob */
export const postStockReferenceJob = postTickerReferenceJob

export interface TechnicalIndicatorParams {
  ticker: string
  indicator: 'sma' | 'ema' | 'rsi' | 'macd'
  timespan?: string
  window?: number
  series_type?: string
  adjusted?: boolean
  order?: string
  limit?: number
  short_window?: number
  long_window?: number
  signal_window?: number
}

export interface TechnicalIndicatorResponse {
  ok: boolean
  indicator?: string
  ticker?: string
  count?: number
  results?: {
    values?: Record<string, unknown>[]
    underlying?: Record<string, unknown>
    [key: string]: unknown
  }
  error?: string
}

export async function fetchTechnicalIndicator(
  params: TechnicalIndicatorParams,
): Promise<TechnicalIndicatorResponse> {
  const { ticker, indicator, ...rest } = params
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  const r = await fetch(
    massiveUrl(`/research/massive/technical-indicators/${indicator}/${encodeURIComponent(ticker)}?${q.toString()}`),
  )
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    indicator: j.indicator,
    ticker: j.ticker,
    count: j.count,
    results: j.results,
    error: j.error,
  }
}

// ── Trades & Quotes (read-only REST) ──

export async function fetchMassiveLastTrade(
  optionsTicker: string,
): Promise<{ ok: boolean; results?: Record<string, unknown>; error?: string }> {
  const ot = (optionsTicker || '').trim()
  if (!ot) return { ok: false, error: 'options_ticker is required' }
  const r = await fetch(massiveUrl(`/research/massive/trades-quotes/last-trade/${encodeURIComponent(ot)}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    results: j.results,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchMassiveHistQuotes(
  optionsTicker: string,
  options?: {
    timestamp_gte?: string
    timestamp_lte?: string
    limit?: number
    sort?: string
  },
): Promise<{ ok: boolean; results?: Record<string, unknown>[]; count?: number; error?: string }> {
  const ot = (optionsTicker || '').trim()
  if (!ot) return { ok: false, error: 'options_ticker is required' }
  const q = new URLSearchParams()
  if (options?.timestamp_gte) q.set('timestamp_gte', options.timestamp_gte)
  if (options?.timestamp_lte) q.set('timestamp_lte', options.timestamp_lte)
  if (options?.limit) q.set('limit', String(options.limit))
  if (options?.sort) q.set('order', options.sort)
  const r = await fetch(massiveUrl(`/research/massive/trades-quotes/quotes/${encodeURIComponent(ot)}?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    results: Array.isArray(j.results) ? j.results : undefined,
    count: typeof j.count === 'number' ? j.count : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchMassiveHistTrades(
  optionsTicker: string,
  options?: {
    timestamp_gte?: string
    timestamp_lte?: string
    limit?: number
    sort?: string
  },
): Promise<{ ok: boolean; results?: Record<string, unknown>[]; count?: number; error?: string }> {
  const ot = (optionsTicker || '').trim()
  if (!ot) return { ok: false, error: 'options_ticker is required' }
  const q = new URLSearchParams()
  if (options?.timestamp_gte) q.set('timestamp_gte', options.timestamp_gte)
  if (options?.timestamp_lte) q.set('timestamp_lte', options.timestamp_lte)
  if (options?.limit) q.set('limit', String(options.limit))
  if (options?.sort) q.set('order', options.sort)
  const r = await fetch(massiveUrl(`/research/massive/trades-quotes/trades/${encodeURIComponent(ot)}?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (r.status === 403) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Developer tier required' }
  }
  return {
    ok: Boolean(j.ok),
    results: Array.isArray(j.results) ? j.results : undefined,
    count: typeof j.count === 'number' ? j.count : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function pollMassiveJobUntilDone(
  jobId: string,
  options?: { maxAttempts?: number; intervalMs?: number },
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const maxAttempts = options?.maxAttempts ?? 90
  const intervalMs = options?.intervalMs ?? 1000
  for (let i = 0; i < maxAttempts; i += 1) {
    const res = await fetchMassiveJob(jobId)
    if (!res.ok) {
      return { ok: false, error: res.error ?? 'Job poll failed' }
    }
    const st = res.job?.status
    if (st === 'done') return { ok: true, status: st }
    if (st === 'failed') {
      const result = res.job?.result as { error?: string } | undefined
      return { ok: false, status: st, error: result?.error ?? 'Job failed' }
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, intervalMs)
    })
  }
  return { ok: false, error: 'Job poll timed out' }
}

// ── P1: Liquidity Summary ──

export interface LiquiditySummaryResponse {
  ok: boolean
  symbol?: string
  expiration?: string
  strike?: number
  right?: string
  source?: string
  spread_pct?: number | null
  spread_percentile?: number | null
  oi?: number | null
  oi_percentile?: number | null
  contracts_compared?: number
  snapshot_ts?: string | null
  error?: string
}

export async function fetchLiquiditySummary(
  symbol: string,
  expiration: string,
  strike: number,
  right: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<LiquiditySummaryResponse> {
  const q = new URLSearchParams({
    symbol: (symbol || '').trim(),
    expiration: (expiration || '').trim(),
    strike: String(strike),
    right: (right || '').trim(),
    source,
  })
  const r = await fetch(`${researchApiUrl('/research/option-contract/liquidity-summary')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    symbol: j.symbol,
    expiration: j.expiration,
    strike: j.strike,
    right: j.right,
    source: j.source,
    spread_pct: j.spread_pct ?? null,
    spread_percentile: j.spread_percentile ?? null,
    oi: j.oi ?? null,
    oi_percentile: j.oi_percentile ?? null,
    contracts_compared: j.contracts_compared,
    snapshot_ts: j.snapshot_ts ?? null,
    error: j.error,
  }
}

// ── P2: Relative Value ──

export interface RelativeValueResponse {
  ok: boolean
  label?: string | null
  iv_zscore?: number | null
  this_iv?: number | null
  avg_iv?: number | null
  std_iv?: number | null
  contracts_compared?: number
  iv_curve?: { strike: number; iv: number }[]
  error?: string
}

export async function fetchRelativeValue(
  symbol: string,
  expiration: string,
  strike: number,
  right: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<RelativeValueResponse> {
  const q = new URLSearchParams({
    symbol: (symbol || '').trim(),
    expiration: (expiration || '').trim(),
    strike: String(strike),
    right: (right || '').trim(),
    source,
  })
  const r = await fetch(`${researchApiUrl('/research/option-contract/relative-value')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    label: j.label ?? null,
    iv_zscore: j.iv_zscore ?? null,
    this_iv: j.this_iv ?? null,
    avg_iv: j.avg_iv ?? null,
    std_iv: j.std_iv ?? null,
    contracts_compared: j.contracts_compared,
    iv_curve: Array.isArray(j.iv_curve) ? j.iv_curve : undefined,
    error: j.error,
  }
}

export interface IvTermStructurePoint {
  expiration: string
  dte_days: number
  atm_iv: number | null
  iv_call?: number | null
  iv_put?: number | null
  strike?: number
}

export interface IvTermStructureResponse {
  ok: boolean
  symbol: string
  underlying_price?: number
  points: IvTermStructurePoint[]
  error?: string
}

export async function fetchIvTermStructure(
  symbol: string,
  expirations: string[],
  source: string = 'massive',
): Promise<IvTermStructureResponse> {
  const params = new URLSearchParams({
    symbol,
    expirations: expirations.join(','),
    source,
  })
  const r = await fetch(`${researchApiUrl('/research/iv-term-structure')}?${params}`)
  const j = await r.json().catch(() => ({}))
  const pts: IvTermStructurePoint[] = Array.isArray(j.points)
    ? j.points.map((p: Record<string, unknown>) => ({
        expiration: String(p.expiration ?? ''),
        dte_days: Number(p.dte_days ?? 0),
        atm_iv: p.atm_iv != null ? Number(p.atm_iv) : null,
        iv_call: p.iv_call != null ? Number(p.iv_call) : null,
        iv_put: p.iv_put != null ? Number(p.iv_put) : null,
        strike: p.strike != null ? Number(p.strike) : undefined,
      }))
    : []
  const errMsg = (() => {
    if (j.error != null && String(j.error).trim() !== '') return String(j.error)
    const d = j.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg)
    if (!r.ok) return `HTTP ${r.status}`
    return undefined
  })()
  return {
    ok: Boolean(j.ok) && r.ok,
    symbol: j.symbol ?? symbol,
    underlying_price: j.underlying_price != null ? Number(j.underlying_price) : undefined,
    points: pts,
    error: errMsg,
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface IvVolatilityConePoint {
  expiration: string
  dte_days: number
  atm_iv: number | null
  iv_call?: number | null
  iv_put?: number | null
  strike?: number | null
  iv_p10: number | null
  iv_p50: number | null
  iv_p90: number | null
  iv_min: number | null
  iv_max: number | null
  sample_days: number
  /** Historical daily ATM IV — sample mean */
  iv_hist_mean?: number | null
  iv_hist_stdev?: number | null
  iv_hist_min?: number | null
  iv_hist_max?: number | null
  iv_hist_plus_1sd?: number | null
  iv_hist_minus_1sd?: number | null
  iv_hist_plus_2sd?: number | null
  iv_hist_minus_2sd?: number | null
}

export interface IvVolatilityConeResponse {
  ok: boolean
  symbol: string
  underlying_price?: number
  lookback_days?: number
  /** True when all expirations used pre-aggregated report_option_atm_iv_daily for cone bands */
  rollup_used?: boolean
  points: IvVolatilityConePoint[]
  warning?: string
  error?: string
}

export async function fetchIvVolatilityCone(
  symbol: string,
  expirations: string[],
  source: string = 'massive',
  lookbackDays: number = 90,
): Promise<IvVolatilityConeResponse> {
  const params = new URLSearchParams({
    symbol,
    expirations: expirations.join(','),
    source,
    lookback_days: String(lookbackDays),
  })
  const r = await fetch(`${researchApiUrl('/research/iv-volatility-cone')}?${params}`)
  const j = await r.json().catch(() => ({}))
  const pts: IvVolatilityConePoint[] = Array.isArray(j.points)
    ? j.points.map((p: Record<string, unknown>) => ({
        expiration: String(p.expiration ?? ''),
        dte_days: Number(p.dte_days ?? 0),
        atm_iv: p.atm_iv != null ? Number(p.atm_iv) : null,
        iv_call: numOrNull(p.iv_call),
        iv_put: numOrNull(p.iv_put),
        strike: numOrNull(p.strike),
        iv_p10: p.iv_p10 != null ? Number(p.iv_p10) : null,
        iv_p50: p.iv_p50 != null ? Number(p.iv_p50) : null,
        iv_p90: p.iv_p90 != null ? Number(p.iv_p90) : null,
        iv_min: p.iv_min != null ? Number(p.iv_min) : null,
        iv_max: p.iv_max != null ? Number(p.iv_max) : null,
        sample_days: Number(p.sample_days ?? 0),
        iv_hist_mean: numOrNull(p.iv_hist_mean),
        iv_hist_stdev: numOrNull(p.iv_hist_stdev),
        iv_hist_min: numOrNull(p.iv_hist_min),
        iv_hist_max: numOrNull(p.iv_hist_max),
        iv_hist_plus_1sd: numOrNull(p.iv_hist_plus_1sd),
        iv_hist_minus_1sd: numOrNull(p.iv_hist_minus_1sd),
        iv_hist_plus_2sd: numOrNull(p.iv_hist_plus_2sd),
        iv_hist_minus_2sd: numOrNull(p.iv_hist_minus_2sd),
      }))
    : []
  const errMsg = (() => {
    if (j.error != null && String(j.error).trim() !== '') return String(j.error)
    const d = j.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg)
    if (!r.ok) return `HTTP ${r.status}`
    return undefined
  })()
  return {
    ok: Boolean(j.ok) && r.ok,
    symbol: j.symbol ?? symbol,
    underlying_price: j.underlying_price != null ? Number(j.underlying_price) : undefined,
    lookback_days: j.lookback_days != null ? Number(j.lookback_days) : undefined,
    rollup_used: typeof j.rollup_used === 'boolean' ? j.rollup_used : undefined,
    points: pts,
    warning: j.warning != null ? String(j.warning) : undefined,
    error: errMsg,
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
