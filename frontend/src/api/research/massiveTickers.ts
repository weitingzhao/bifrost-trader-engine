import {
  getMassiveApiBase,
  joinServiceBase,
} from '../shared/apiRouting'

function massiveUrl(path: string): string {
  return joinServiceBase(getMassiveApiBase(), path)
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

/** Paged tickers with no ``ticker_overview`` row (same scope as overview job "missing" mode). */
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
