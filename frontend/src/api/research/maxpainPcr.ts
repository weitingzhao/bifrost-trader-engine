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

// ── Option Chain Expiry Summary ───────────────────────────────────────────────

export interface OptionChainExpiryRow {
  expiry: string
  expiry_label: string
  dte: number | null
  put_vol: number
  call_vol: number
  total_vol: number
  pc_vol_ratio: number | null
  put_oi: number
  call_oi: number
  total_oi: number
  pc_oi_ratio: number | null
}

export interface OptionChainExpirySummaryResponse {
  ok: boolean
  error?: string
  symbol?: string
  trade_date?: string | null
  count?: number
  rows: OptionChainExpiryRow[]
}

export async function fetchOptionChainExpirySummary(
  symbol: string,
): Promise<OptionChainExpirySummaryResponse> {
  const sym = (symbol || '').trim().toUpperCase()
  if (!sym) return { ok: false, error: 'symbol is required', rows: [] }
  try {
    const r = await fetch(
      `${researchApiUrl('/research/put-call-ratio/chain-summary')}?symbol=${encodeURIComponent(sym)}`,
    )
    const j = await r.json().catch(() => ({}))
    if (!j.ok) return { ok: false, error: j.error ?? 'Request failed', rows: [] }
    const raw = Array.isArray(j.rows) ? j.rows : []
    const rows: OptionChainExpiryRow[] = raw.map((row: Record<string, unknown>) => ({
      expiry: String(row.expiry ?? ''),
      expiry_label: String(row.expiry_label ?? ''),
      dte: row.dte != null ? Number(row.dte) : null,
      put_vol: Number(row.put_vol ?? 0),
      call_vol: Number(row.call_vol ?? 0),
      total_vol: Number(row.total_vol ?? 0),
      pc_vol_ratio: row.pc_vol_ratio != null ? Number(row.pc_vol_ratio) : null,
      put_oi: Number(row.put_oi ?? 0),
      call_oi: Number(row.call_oi ?? 0),
      total_oi: Number(row.total_oi ?? 0),
      pc_oi_ratio: row.pc_oi_ratio != null ? Number(row.pc_oi_ratio) : null,
    }))
    return { ok: true, symbol: sym, trade_date: j.trade_date ?? null, count: rows.length, rows }
  } catch {
    return { ok: false, error: 'Network error', rows: [] }
  }
}

// ── PCR Backfill Progress ─────────────────────────────────────────────────────

export interface PcrBackfillProgress {
  ok: boolean
  error?: string
  symbol?: string
  lookback_days?: number
  start_date?: string | null
  contracts_with_data: number
  total_contracts: number
  pct: number
  dates_with_data: number
  latest_date: string | null
  earliest_date: string | null
  pcr_dates_computed: number
}

export async function fetchPcrBackfillProgress(
  symbol: string,
  lookbackDays = 252,
): Promise<PcrBackfillProgress> {
  const sym = (symbol || '').trim().toUpperCase()
  const fallback: PcrBackfillProgress = {
    ok: false,
    contracts_with_data: 0,
    total_contracts: 0,
    pct: 0,
    dates_with_data: 0,
    latest_date: null,
    earliest_date: null,
    pcr_dates_computed: 0,
  }
  if (!sym) return { ...fallback, error: 'symbol is required' }
  try {
    const r = await fetch(
      `${researchApiUrl('/research/put-call-ratio/backfill-progress')}?symbol=${encodeURIComponent(sym)}&lookback_days=${lookbackDays}`,
    )
    const j = await r.json().catch(() => ({}))
    if (!j.ok) return { ...fallback, error: j.error ?? 'Request failed' }
    return {
      ok: true,
      symbol: j.symbol ?? sym,
      lookback_days: j.lookback_days ?? lookbackDays,
      start_date: j.start_date ?? null,
      contracts_with_data: Number(j.contracts_with_data ?? 0),
      total_contracts: Number(j.total_contracts ?? 0),
      pct: Number(j.pct ?? 0),
      dates_with_data: Number(j.dates_with_data ?? 0),
      latest_date: j.latest_date ?? null,
      earliest_date: j.earliest_date ?? null,
      pcr_dates_computed: Number(j.pcr_dates_computed ?? 0),
    }
  } catch {
    return { ...fallback, error: 'Network error' }
  }
}

// ── Put/Call Ratio ────────────────────────────────────────────────────────────

export interface PutCallRatioHistoryPoint {
  trade_date: string
  put_oi_total: number | null
  call_oi_total: number | null
  ratio_oi: number | null
  put_vol_total: number | null
  call_vol_total: number | null
  ratio_volume: number | null
  underlying_close: number | null
}

export interface PutCallRatioHistoryResponse {
  ok: boolean
  error?: string
  symbol?: string
  count?: number
  series: PutCallRatioHistoryPoint[]
}

export async function fetchPutCallRatioHistory(params: {
  symbol: string
  lookbackDays?: number
}): Promise<PutCallRatioHistoryResponse> {
  const sym = (params.symbol || '').trim().toUpperCase()
  if (!sym) return { ok: false, error: 'symbol is required', series: [] }
  const q = new URLSearchParams({ symbol: sym })
  if (params.lookbackDays != null && params.lookbackDays > 0) q.set('lookback_days', String(params.lookbackDays))
  try {
    const r = await fetch(`${researchApiUrl('/research/put-call-ratio/history')}?${q.toString()}`)
    const j = await r.json().catch(() => ({}))
    if (!j.ok) {
      return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed', series: [] }
    }
    const raw = Array.isArray(j.series) ? j.series : []
    const series: PutCallRatioHistoryPoint[] = raw.map((row: Record<string, unknown>) => ({
      trade_date: String(row.trade_date ?? ''),
      put_oi_total: row.put_oi_total != null ? Number(row.put_oi_total) : null,
      call_oi_total: row.call_oi_total != null ? Number(row.call_oi_total) : null,
      ratio_oi: row.ratio_oi != null && Number.isFinite(Number(row.ratio_oi)) ? Number(row.ratio_oi) : null,
      put_vol_total: row.put_vol_total != null ? Number(row.put_vol_total) : null,
      call_vol_total: row.call_vol_total != null ? Number(row.call_vol_total) : null,
      ratio_volume: row.ratio_volume != null && Number.isFinite(Number(row.ratio_volume)) ? Number(row.ratio_volume) : null,
      underlying_close: row.underlying_close != null && Number.isFinite(Number(row.underlying_close)) ? Number(row.underlying_close) : null,
    }))
    return { ok: true, symbol: sym, count: series.length, series }
  } catch {
    return { ok: false, error: 'Network error', series: [] }
  }
}
