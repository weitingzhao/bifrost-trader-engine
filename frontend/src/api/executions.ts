import type {
  ControlResponse,
  Execution,
  ExecutionsResponse,
  ExecutionsResponseWithPairs,
  ExecutionsFreshnessResponse,
  ExecutionsFlexUploadResponse,
  PositionAttributionResponse,
} from '../types'
import { API } from './constants'

/** R-A2: API fetches executions from IB and writes to DB; no daemon. days: 1=today, 3=3d, 7=7d */
export async function postExecutionsFetch(days: 1 | 3 | 7 = 1): Promise<ControlResponse & { count?: number }> {
  const params = new URLSearchParams({ days: String(days) })
  const r = await fetch(`${API}/executions/fetch?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), count: j.count }
}

/** R-A2: Fetch executions via IB Flex Trades report and write to DB. Range from backend (Flex + Settings). */
export async function postExecutionsFetchFlex(
  body?: { from_date?: string; to_date?: string }
): Promise<
  ControlResponse & {
    count?: number
    raw_count?: number
    updated_accounts?: number
    range_mode?: string
    range_days?: number | null
    range_from?: string | null
    range_to?: string | null
    last_flex_date_after?: string | null
    data_from?: string | null
    data_to?: string | null
    by_account?: number
    by_account_counts?: number[]
    per_query?: Array<{
      role?: string
      query_id: string
      label?: string | null
      rows?: number
      data_from?: string | null
      data_to?: string | null
    }>
  }
> {
  const r = await fetch(`${API}/executions/fetch-flex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ...j,
    ok: r.ok && j.ok !== false,
    error: j.error || (r.ok ? undefined : r.statusText),
    count: j.count,
    updated_accounts: j.updated_accounts,
    raw_count: j.raw_count,
    range_mode: j.range_mode,
    range_days: j.range_days,
    range_from: j.range_from,
    range_to: j.range_to,
    last_flex_date_after: j.last_flex_date_after,
    data_from: j.data_from,
    data_to: j.data_to,
    by_account: j.by_account,
    by_account_counts: j.by_account_counts,
    per_query: j.per_query,
  }
}

/** GET /executions/position-attribution: Position×Instance net-estimated attribution. */
export async function fetchPositionAttribution(
  account_id?: string,
  sec_type?: string,
): Promise<PositionAttributionResponse> {
  const params = new URLSearchParams()
  if (account_id) params.set('account_id', account_id)
  if (sec_type) params.set('sec_type', sec_type)
  const r = await fetch(`${API}/executions/position-attribution?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** GET /executions/link-candidates: existing rows to attach strategy (no insert). */
export async function fetchExecutionLinkCandidates(params: {
  account_id: string
  contract_key?: string
  symbol?: string
  expiry?: string
  strike?: number
  option_right?: string
  limit?: number
}): Promise<{ executions: Execution[]; error?: string }> {
  const q = new URLSearchParams()
  q.set('account_id', params.account_id.trim())
  if (params.contract_key?.trim()) q.set('contract_key', params.contract_key.trim())
  if (params.symbol?.trim()) q.set('symbol', params.symbol.trim())
  if (params.expiry != null && String(params.expiry).trim() !== '') q.set('expiry', String(params.expiry).trim())
  if (params.strike != null && Number.isFinite(params.strike)) q.set('strike', String(params.strike))
  if (params.option_right?.trim()) q.set('option_right', params.option_right.trim().slice(0, 1))
  if (params.limit != null) q.set('limit', String(params.limit))
  const r = await fetch(`${API}/executions/link-candidates?${q}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { executions: [], error: (j as { error?: string }).error || r.statusText }
  }
  return { executions: (j as { executions?: Execution[] }).executions ?? [], error: (j as { error?: string }).error }
}

/** source_scope on_the_fly → GET /executions reads account_executions_fly (TWS rows not in final book; excludes BAG). */
export async function fetchExecutions(
  since_ts?: number,
  until_ts?: number,
  limit = 200,
  include_opt_pairs = false,
  strategy_opportunity_id?: number,
  strategy_instance_id?: number,
  source_scope?: 'performance_book' | 'on_the_fly',
): Promise<ExecutionsResponse | ExecutionsResponseWithPairs> {
  const params = new URLSearchParams()
  if (since_ts != null) params.set('since_ts', String(since_ts))
  if (until_ts != null) params.set('until_ts', String(until_ts))
  params.set('limit', String(limit))
  if (include_opt_pairs) params.set('include_opt_pairs', 'true')
  if (strategy_opportunity_id != null) params.set('strategy_opportunity_id', String(strategy_opportunity_id))
  if (strategy_instance_id != null) params.set('strategy_instance_id', String(strategy_instance_id))
  if (source_scope) params.set('source_scope', source_scope)
  const r = await fetch(`${API}/executions?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** GET /executions/freshness: latest exec_time per (account_id, source) from account_executions. */
export async function fetchExecutionsFreshness(): Promise<ExecutionsFreshnessResponse> {
  const r = await fetch(`${API}/executions/freshness`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** POST /executions/fetch-flex-upload: upsert executions from uploaded Flex Trades XML. */
export async function postExecutionsFetchFlexUpload(xml: string): Promise<ExecutionsFlexUploadResponse> {
  const r = await fetch(`${API}/executions/fetch-flex-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml }),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean((j as any).ok) && r.ok,
    error: (j as any).error,
    count: (j as any).count,
    updated_accounts: (j as any).updated_accounts,
    message: (j as any).message,
  }
}

/** R-A2: Add one execution manually (historical entry). */
export async function createExecution(body: Record<string, unknown>): Promise<{ ok: boolean; account_executions_id?: number; error?: string }> {
  const r = await fetch(`${API}/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as any).ok) && r.ok
  const detail = (j as any).detail
  const detailMsg =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail) && detail[0]?.msg
        ? detail[0].msg
        : undefined
  const statusMsg = `${r.status} ${r.statusText || ''}`.trim()
  const error = (j as any).error || detailMsg || (!r.ok ? statusMsg : undefined)
  return { ok, account_executions_id: (j as any).account_executions_id, error }
}

/** R-A2: Update one execution by account_executions_id (manual correction). */
export async function updateExecution(account_executions_id: number, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/executions/${account_executions_id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as any).ok) && r.ok
  const detail = (j as any).detail
  const detailMsg =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail) && detail[0]?.msg
        ? detail[0].msg
        : undefined
  const statusMsg = `${r.status} ${r.statusText || ''}`.trim()
  const error = (j as any).error || detailMsg || (!r.ok ? statusMsg : undefined)
  return { ok, error }
}

/** R-A2: Delete one execution by account_executions_id. */
export async function deleteExecution(account_executions_id: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/executions/${account_executions_id}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as any).ok) && r.ok
  const detail = (j as any).detail
  const detailMsg =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail) && detail[0]?.msg
        ? detail[0].msg
        : undefined
  const statusMsg = `${r.status} ${r.statusText || ''}`.trim()
  const error = (j as any).error || detailMsg || (!r.ok ? statusMsg : undefined)
  return { ok, error }
}
