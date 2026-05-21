import {
  getMassiveApiBase,
  getResearchApiBaseForBrowser,
  joinServiceBase,
} from '../shared/apiRouting'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
}

// suppress unused import
void getMassiveApiBase

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

// ---------------------------------------------------------------------------
// IV & Greeks
// ---------------------------------------------------------------------------

export interface GreeksRow {
  expiry: string
  strike: number
  right: string
  market_price: number
  stock_price: number
  t_years: number
  t_days: number
  iv: number | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
}

export interface GreeksResponse {
  ok: boolean
  symbol: string
  trade_date: string
  stock_price: number | null
  risk_free_rate: number
  count: number
  rows: GreeksRow[]
  error?: string
}

export async function fetchGreeks(params: {
  symbol: string
  trade_date: string
  risk_free_rate?: number
  expiry?: string
  right?: string
  limit?: number
}): Promise<GreeksResponse> {
  const s = (params.symbol || '').trim().toUpperCase()
  if (!s) {
    return { ok: false, symbol: '', trade_date: params.trade_date, stock_price: null, risk_free_rate: params.risk_free_rate ?? 0.045, count: 0, rows: [], error: 'symbol is required' }
  }
  try {
    const qs = new URLSearchParams({ symbol: s, trade_date: params.trade_date })
    if (params.risk_free_rate != null) qs.set('risk_free_rate', String(params.risk_free_rate))
    if (params.expiry) qs.set('expiry', params.expiry)
    if (params.right) qs.set('right', params.right)
    if (params.limit != null) qs.set('limit', String(params.limit))
    const r = await fetch(researchApiUrl(`/research/greeks?${qs.toString()}`))
    const j = await r.json().catch(() => ({}))
    return {
      ok: Boolean(j.ok),
      symbol: j.symbol ?? s,
      trade_date: j.trade_date ?? params.trade_date,
      stock_price: j.stock_price ?? null,
      risk_free_rate: j.risk_free_rate ?? (params.risk_free_rate ?? 0.045),
      count: j.count ?? 0,
      rows: Array.isArray(j.rows) ? (j.rows as GreeksRow[]) : [],
      error: j.error != null ? String(j.error) : undefined,
    }
  } catch (e) {
    return {
      ok: false, symbol: s, trade_date: params.trade_date, stock_price: null,
      risk_free_rate: params.risk_free_rate ?? 0.045, count: 0, rows: [],
      error: e instanceof Error ? e.message : 'fetch failed',
    }
  }
}

export interface GreeksAvailableDatesResponse {
  ok: boolean
  symbol: string
  dates: string[]
  error?: string
}

export async function fetchGreeksAvailableDates(symbol: string): Promise<GreeksAvailableDatesResponse> {
  const s = (symbol || '').trim().toUpperCase()
  if (!s) return { ok: false, symbol: '', dates: [], error: 'symbol is required' }
  try {
    const r = await fetch(researchApiUrl(`/research/greeks/available-dates?symbol=${encodeURIComponent(s)}`))
    const j = await r.json().catch(() => ({}))
    return {
      ok: Boolean(j.ok),
      symbol: j.symbol ?? s,
      dates: Array.isArray(j.dates) ? (j.dates as string[]) : [],
      error: j.error != null ? String(j.error) : undefined,
    }
  } catch (e) {
    return { ok: false, symbol: s, dates: [], error: e instanceof Error ? e.message : 'fetch failed' }
  }
}
