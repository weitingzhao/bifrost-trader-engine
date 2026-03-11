import type { WatchlistItem } from '../types'
import { API } from './constants'

export async function postWatchlistEodRefresh(
  options?: { override_days?: number; is_test?: boolean; api_interval_sec?: number },
): Promise<{ ok: boolean; error?: string; message?: string; queued_count?: number; failed_count?: number; symbols_count?: number }> {
  const params = new URLSearchParams()
  if (options?.override_days != null) params.set('override_days', String(options.override_days))
  if (options?.is_test === true) params.set('is_test', '1')
  if (options?.api_interval_sec != null) params.set('api_interval_sec', String(options.api_interval_sec))
  const r = await fetch(`${API}/bars/watchlist/eod-refresh?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    message: j.message,
    queued_count: j.queued_count ?? 0,
    failed_count: j.failed_count ?? 0,
    symbols_count: j.symbols_count ?? 0,
  }
}

export interface WatchlistEodRefreshPreviewItem {
  symbol: string
  period: string
  mode?: string
  latest_ts?: number | null
  fetch_start_ts: number
  fetch_end_ts: number
  override_days?: number | null
  api_interval_sec?: number
  override_records?: {
    count: number
    times: number[]
    first_ts?: number | null
    last_ts?: number | null
  }
  gap_to_fill?: {
    start_ts: number
    end_ts: number
    has_gap: boolean
    span_seconds: number
  }
  ib_request_plan?: Array<{
    symbol: string
    period: string
    barSizeSetting: string
    durationStr: string
    endDateTime: string
    seg_start_ts: number
    seg_end_ts: number
  }>
}

export interface WatchlistEodRefreshPreviewResponse {
  ok: boolean
  error?: string
  message?: string
  preview_only?: boolean
  ready_to_enqueue?: boolean
  symbols_count?: number
  queued_jobs_if_confirmed?: number
  override_days?: number
  api_interval_sec?: number
  periods?: string[]
  symbols?: string[]
  items?: WatchlistEodRefreshPreviewItem[]
  total_override_records?: number
  total_request_chunks?: number
  failed_count?: number
  failures?: Array<{ symbol: string; period: string; error: string }>
}

export async function fetchWatchlistEodRefreshPreview(
  options?: { override_days?: number; api_interval_sec?: number },
): Promise<WatchlistEodRefreshPreviewResponse> {
  const params = new URLSearchParams()
  if (options?.override_days != null) params.set('override_days', String(options.override_days))
  if (options?.api_interval_sec != null) params.set('api_interval_sec', String(options.api_interval_sec))
  const r = await fetch(`${API}/bars/watchlist/eod-refresh/preview?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    message: j.message,
    preview_only: j.preview_only,
    ready_to_enqueue: j.ready_to_enqueue,
    symbols_count: j.symbols_count ?? 0,
    queued_jobs_if_confirmed: j.queued_jobs_if_confirmed ?? 0,
    override_days: j.override_days,
    api_interval_sec: j.api_interval_sec,
    periods: j.periods ?? [],
    symbols: j.symbols ?? [],
    items: j.items ?? [],
    total_override_records: j.total_override_records ?? 0,
    total_request_chunks: j.total_request_chunks ?? 0,
    failed_count: j.failed_count ?? 0,
    failures: j.failures ?? [],
  }
}

/** R-A3: Watchlist list. */
export async function fetchWatchlist(): Promise<{ items: WatchlistItem[] }> {
  const r = await fetch(`${API}/watchlist`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A3: Add/update Watchlist item. */
export async function postWatchlist(item: {
  contract_key: string
  symbol?: string
  sec_type?: string
  expiry?: string
  strike?: number
  option_right?: string
  display_label?: string
  source?: string
}): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/watchlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** R-A3: Delete Watchlist item by contract_key or id. */
export async function deleteWatchlist(by: { contract_key?: string; id?: number }): Promise<{ ok: boolean; error?: string }> {
  const params = new URLSearchParams()
  if (by.contract_key) params.set('contract_key', by.contract_key)
  if (by.id != null) params.set('id', String(by.id))
  const r = await fetch(`${API}/watchlist?${params}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}
