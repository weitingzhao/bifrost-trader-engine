import {
  getMassiveApiBase,
  joinServiceBase,
} from '../shared/apiRouting'

function massiveUrl(path: string): string {
  return joinServiceBase(getMassiveApiBase(), path)
}

type MassiveTickerProxyResponse = {
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

// ── Stock Fundamentals proxies ────────────────────────────────────────────

export interface StockFundamentalsOpts {
  timeframe?: string
  fiscal_year?: number
  fiscal_quarter?: number
  period_end?: string
  filing_date?: string
  limit?: number
  sort?: string
}

async function _fetchStockFundamentals(
  path: string,
  ticker: string,
  opts?: StockFundamentalsOpts,
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  q.set('ticker', ticker.trim().toUpperCase())
  if (opts?.timeframe) q.set('timeframe', opts.timeframe)
  if (opts?.fiscal_year != null) q.set('fiscal_year', String(opts.fiscal_year))
  if (opts?.fiscal_quarter != null) q.set('fiscal_quarter', String(opts.fiscal_quarter))
  if (opts?.period_end) q.set('period_end', opts.period_end)
  if (opts?.filing_date) q.set('filing_date', opts.filing_date)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  const r = await fetch(massiveUrl(`${path}?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

export function fetchMassiveStockIncomeStatements(ticker: string, opts?: StockFundamentalsOpts) {
  return _fetchStockFundamentals('/research/massive/stocks/fundamentals/income-statements', ticker, opts)
}
export function fetchMassiveStockBalanceSheets(ticker: string, opts?: StockFundamentalsOpts) {
  return _fetchStockFundamentals('/research/massive/stocks/fundamentals/balance-sheets', ticker, opts)
}
export function fetchMassiveStockCashFlowStatements(ticker: string, opts?: StockFundamentalsOpts) {
  return _fetchStockFundamentals('/research/massive/stocks/fundamentals/cash-flow-statements', ticker, opts)
}

export async function fetchMassiveStockRatios(
  ticker: string,
  opts?: { limit?: number; sort?: string },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  q.set('ticker', ticker.trim().toUpperCase())
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  const r = await fetch(massiveUrl(`/research/massive/stocks/fundamentals/ratios?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

export async function fetchMassiveStockShortInterest(
  ticker: string,
  opts?: { settlement_date?: string; limit?: number; sort?: string },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  q.set('ticker', ticker.trim().toUpperCase())
  if (opts?.settlement_date) q.set('settlement_date', opts.settlement_date)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  const r = await fetch(massiveUrl(`/research/massive/stocks/fundamentals/short-interest?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

export async function fetchMassiveStockShortVolume(
  ticker: string,
  opts?: { date?: string; limit?: number; sort?: string },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  q.set('ticker', ticker.trim().toUpperCase())
  if (opts?.date) q.set('date', opts.date)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  const r = await fetch(massiveUrl(`/research/massive/stocks/fundamentals/short-volume?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

export async function fetchMassiveStockFloat(
  ticker: string,
  opts?: { limit?: number; sort?: string },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  q.set('ticker', ticker.trim().toUpperCase())
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  const r = await fetch(massiveUrl(`/research/massive/stocks/fundamentals/float?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

export interface MassiveStockNewsOpts {
  ticker?: string
  published_utc_gte?: string
  published_utc_lte?: string
  limit?: number
  sort?: string
  order?: string
}

export async function fetchMassiveStockNews(opts?: MassiveStockNewsOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker.trim().toUpperCase())
  if (opts?.published_utc_gte) q.set('published_utc_gte', opts.published_utc_gte)
  if (opts?.published_utc_lte) q.set('published_utc_lte', opts.published_utc_lte)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  if (opts?.order) q.set('order', opts.order)
  const r = await fetch(massiveUrl(`/research/massive/stocks/news?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

// ── SEC Filings & Disclosures proxies ────────────────────────────────────────

interface FilingsDateRangeOpts {
  filing_date?: string
  filing_date_gt?: string
  filing_date_gte?: string
  filing_date_lt?: string
  filing_date_lte?: string
  limit?: number
  sort?: string
}

function _setFilingsDateRange(q: URLSearchParams, o: FilingsDateRangeOpts) {
  if (o.filing_date) q.set('filing_date', o.filing_date)
  if (o.filing_date_gt) q.set('filing_date_gt', o.filing_date_gt)
  if (o.filing_date_gte) q.set('filing_date_gte', o.filing_date_gte)
  if (o.filing_date_lt) q.set('filing_date_lt', o.filing_date_lt)
  if (o.filing_date_lte) q.set('filing_date_lte', o.filing_date_lte)
  if (o.limit != null) q.set('limit', String(o.limit))
  if (o.sort) q.set('sort', o.sort)
}

async function _fetchFilingsProxy(path: string, q: URLSearchParams): Promise<MassiveTickerProxyResponse> {
  const qs = q.toString()
  const r = await fetch(massiveUrl(`${path}${qs ? `?${qs}` : ''}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined }
}

export interface EdgarIndexOpts extends FilingsDateRangeOpts {
  ticker?: string
  cik?: string
  form_type?: string
}
export async function fetchMassiveEdgarIndex(opts?: EdgarIndexOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker.trim().toUpperCase())
  if (opts?.cik) q.set('cik', opts.cik)
  if (opts?.form_type) q.set('form_type', opts.form_type)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/edgar-index', q)
}

export interface TenKSectionsOpts extends FilingsDateRangeOpts {
  ticker?: string
  cik?: string
  section?: string
  period_end?: string
  period_end_gte?: string
  period_end_lte?: string
}
export async function fetchMassive10KSections(opts?: TenKSectionsOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker.trim().toUpperCase())
  if (opts?.cik) q.set('cik', opts.cik)
  if (opts?.section) q.set('section', opts.section)
  if (opts?.period_end) q.set('period_end', opts.period_end)
  if (opts?.period_end_gte) q.set('period_end_gte', opts.period_end_gte)
  if (opts?.period_end_lte) q.set('period_end_lte', opts.period_end_lte)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/10k-sections', q)
}

export interface EightKTextOpts extends FilingsDateRangeOpts {
  ticker?: string
  cik?: string
  form_type?: string
}
export async function fetchMassive8KText(opts?: EightKTextOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker.trim().toUpperCase())
  if (opts?.cik) q.set('cik', opts.cik)
  if (opts?.form_type) q.set('form_type', opts.form_type)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/8k-text', q)
}

export interface ThirteenFOpts extends FilingsDateRangeOpts {
  filer_cik?: string
}
export async function fetchMassive13FFilings(opts?: ThirteenFOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.filer_cik) q.set('filer_cik', opts.filer_cik)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/13f', q)
}

export interface RiskFactorsOpts extends FilingsDateRangeOpts {
  ticker?: string
  cik?: string
}
export async function fetchMassiveRiskFactors(opts?: RiskFactorsOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker.trim().toUpperCase())
  if (opts?.cik) q.set('cik', opts.cik)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/risk-factors', q)
}

export interface RiskCategoriesOpts {
  taxonomy?: number
  primary_category?: string
  secondary_category?: string
  tertiary_category?: string
  limit?: number
  sort?: string
}
export async function fetchMassiveRiskCategories(opts?: RiskCategoriesOpts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.taxonomy != null) q.set('taxonomy', String(opts.taxonomy))
  if (opts?.primary_category) q.set('primary_category', opts.primary_category)
  if (opts?.secondary_category) q.set('secondary_category', opts.secondary_category)
  if (opts?.tertiary_category) q.set('tertiary_category', opts.tertiary_category)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  return _fetchFilingsProxy('/research/massive/stocks/filings/risk-categories', q)
}

export interface Form3Opts extends FilingsDateRangeOpts {
  issuer_cik?: string
  owner_cik?: string
  tickers?: string
  form_type?: string
}
export async function fetchMassiveForm3(opts?: Form3Opts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.issuer_cik) q.set('issuer_cik', opts.issuer_cik)
  if (opts?.owner_cik) q.set('owner_cik', opts.owner_cik)
  if (opts?.tickers) q.set('tickers', opts.tickers.trim().toUpperCase())
  if (opts?.form_type) q.set('form_type', opts.form_type)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/form-3', q)
}

export interface Form4Opts extends FilingsDateRangeOpts {
  issuer_cik?: string
  owner_cik?: string
  tickers?: string
  form_type?: string
  transaction_code?: string
}
export async function fetchMassiveForm4(opts?: Form4Opts): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.issuer_cik) q.set('issuer_cik', opts.issuer_cik)
  if (opts?.owner_cik) q.set('owner_cik', opts.owner_cik)
  if (opts?.tickers) q.set('tickers', opts.tickers.trim().toUpperCase())
  if (opts?.form_type) q.set('form_type', opts.form_type)
  if (opts?.transaction_code) q.set('transaction_code', opts.transaction_code)
  if (opts) _setFilingsDateRange(q, opts)
  return _fetchFilingsProxy('/research/massive/stocks/filings/form-4', q)
}

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
