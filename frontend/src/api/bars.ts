import type { Bar, BarsResponse, BarStatsResponse, BarsCoverageResponse } from '../types'
import { API } from './constants'

/** R-A3: API fetches bars from IB and writes to DB (no daemon). smart_duration: server computes duration from latest bar. */
export async function postBarsFetch(
  symbol: string,
  period = '1 D',
  duration = '30 D',
  smartDuration = false,
): Promise<{ ok: boolean; error?: string; bars?: Bar[]; count?: number }> {
  const params = new URLSearchParams({ symbol, period, duration })
  if (smartDuration) params.set('smart_duration', 'true')
  const r = await fetch(`${API}/bars/fetch?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    bars: j.bars ?? [],
    count: j.count ?? 0,
  }
}

/** R-A3: Get latest bar time for symbol+period (for smart fetch). */
export async function fetchBarsLatest(symbol: string, period = '1 D'): Promise<{ latest: number | null }> {
  const params = new URLSearchParams({ symbol, period })
  const r = await fetch(`${API}/bars/latest?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A3: Backfill bars (time range from IB, write to DB). Same logic as bars_backfill / Celery worker. */
export async function postBarsBackfill(
  symbol: string,
  period: string,
  options?: { years?: number; days?: number; override_days?: number; span_hours?: number; queue?: boolean; is_test?: boolean; api_interval_sec?: number },
): Promise<{ ok: boolean; error?: string; count?: number; message?: string; job_id?: string }> {
  const params = new URLSearchParams({ symbol: symbol.trim(), period })
  if (options?.years != null) params.set('years', String(options.years))
  if (options?.days != null) params.set('days', String(options.days))
  if (options?.override_days != null) params.set('override_days', String(options.override_days))
  if (options?.span_hours != null) params.set('span_hours', String(options.span_hours))
  if (options?.queue !== false) params.set('queue', '1')
  if (options?.is_test === true) params.set('is_test', '1')
  if (options?.api_interval_sec != null) params.set('api_interval_sec', String(options.api_interval_sec))
  const r = await fetch(`${API}/bars/backfill?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    count: j.count ?? 0,
    message: j.message,
    job_id: j.job_id,
  }
}

export interface BarsJob {
  job_id: string
  type: string
  symbol: string
  period: string
  status: 'pending' | 'running' | 'done' | 'failed'
  result?: { ok?: boolean; count?: number; message?: string; error?: string }
  created_ts?: number
  updated_ts?: number
}

export async function fetchBarsJob(jobId: string): Promise<{ ok: boolean; job?: BarsJob; error?: string }> {
  const r = await fetch(`${API}/bars/jobs/${encodeURIComponent(jobId)}`)
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, job: j.job, error: j.error }
}

/** List backfill jobs with pagination and optional status filter. */
export async function fetchBarsJobs(
  limit = 20,
  offset = 0,
  status?: string | null,
): Promise<{ jobs: BarsJob[]; total: number; error?: string }> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (status && status !== 'all') params.set('status', status)
  const r = await fetch(`${API}/bars/jobs?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  const j = await r.json().catch(() => ({}))
  return {
    jobs: j.jobs ?? [],
    total: typeof j.total === 'number' ? j.total : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function deleteBarsJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/bars/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function deleteAllBarsJobs(status?: string | null): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  const r = await fetch(`${API}/bars/jobs?${params}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: j.error,
  }
}

export async function trimBarsJobs(keep: number): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const params = new URLSearchParams({ keep: String(keep) })
  const r = await fetch(`${API}/bars/jobs/trim?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchBars(symbol?: string, period = '1 D', limit = 100): Promise<BarsResponse> {
  const params = new URLSearchParams()
  if (symbol) params.set('symbol', symbol)
  params.set('period', period)
  params.set('limit', String(limit))
  const r = await fetch(`${API}/bars?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Bar row count in stock_day / stock_min for symbol (Data page analysis). */
export async function fetchBarStats(symbol: string): Promise<BarStatsResponse> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  const r = await fetch(`${API}/bars/stats?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** GET /market/trading-day: whether date (default today America/New_York) is US trading day. */
export async function fetchMarketTradingDay(dateStr?: string): Promise<{ date: string; is_trading_day: boolean }> {
  const params = new URLSearchParams()
  if (dateStr && dateStr.trim()) params.set('date', dateStr.trim().slice(0, 10))
  const r = await fetch(`${API}/market/trading-day?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Coverage of Watchlist (or given symbols) in stock_day / stock_min; no symbols = server Watchlist. */
export async function fetchBarsCoverage(symbols?: string[]): Promise<BarsCoverageResponse> {
  const params = new URLSearchParams()
  if (symbols && symbols.length > 0) params.set('symbols', symbols.join(','))
  const r = await fetch(`${API}/bars/coverage?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Refresh reference index daily bars from TradingView into stock_day. No args: all from config; symbol+days: single index. */
export async function postIndicesRefresh(options?: { symbol?: string; days?: number }): Promise<{
  ok: boolean
  updated: string[]
  errors: string[]
}> {
  const params = new URLSearchParams()
  if (options?.symbol != null && options.symbol.trim()) params.set('symbol', options.symbol.trim())
  if (options?.days != null && options.days > 0) params.set('days', String(options.days))
  const r = await fetch(`${API}/indices/refresh?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    updated: Array.isArray(j.updated) ? j.updated : [],
    errors: Array.isArray(j.errors) ? j.errors : [],
  }
}

/** Latest daily bar per symbol in stock_day for Daily % / Daily $ (prev_close/close, is_today). */
export async function fetchBarsBenchmark(
  symbols: string[],
  date?: string,
): Promise<{
  benchmarks: Record<string, { bar_time: number; close: number; prev_close?: number | null; is_today?: boolean; is_stale?: boolean }>
}> {
  const list = symbols.filter(s => (s || '').trim()).map(s => s.trim())
  if (list.length === 0) return { benchmarks: {} }
  const params = new URLSearchParams({ symbols: list.join(',') })
  if (date && date.trim()) params.set('date', date.trim().slice(0, 10))
  const r = await fetch(`${API}/bars/benchmark?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Delete stock_day and/or stock_min for symbol. periods: optional; omit to delete all. */
export async function deleteBarsForSymbol(
  symbol: string,
  periods?: string[],
): Promise<{ ok: boolean; error?: string; deleted_day?: number; deleted_min?: number; message?: string }> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  const url = `${API}/bars/symbol?${params}`
  const init: RequestInit = { method: 'DELETE' }
  if (periods && periods.length > 0) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({ periods })
  }
  const r = await fetch(url, init)
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    deleted_day: j.deleted_day,
    deleted_min: j.deleted_min,
    message: j.message,
  }
}
