import type { RiskSummaryResponse, PerformanceResponse, AccountTransaction } from '../types'
import { API } from './constants'

export async function fetchRiskSummary(): Promise<RiskSummaryResponse> {
  const r = await fetch(`${API}/risk_summary`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchPerformance(params?: {
  since_ts?: number
  until_ts?: number
  account_id?: string
  granularity?: 'day' | 'week' | 'month'
  strategy_opportunity_id?: number
  strategy_instance_id?: number
  /** Instance Detail: one aggregate query instead of full calendar curve */
  summary_only?: boolean
}): Promise<PerformanceResponse> {
  const search = new URLSearchParams()
  if (params?.since_ts != null) search.set('since_ts', String(params.since_ts))
  if (params?.until_ts != null) search.set('until_ts', String(params.until_ts))
  if (params?.account_id) search.set('account_id', params.account_id)
  if (params?.granularity) search.set('granularity', params.granularity)
  if (params?.strategy_opportunity_id != null) search.set('strategy_opportunity_id', String(params.strategy_opportunity_id))
  if (params?.strategy_instance_id != null) search.set('strategy_instance_id', String(params.strategy_instance_id))
  if (params?.summary_only) search.set('summary_only', 'true')
  const r = await fetch(`${API}/performance?${search}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** GET /transactions: list account_transactions (Flex cash) for Transfer & Pay. */
export async function getTransactions(params?: {
  since_ts?: number
  until_ts?: number
  account_id?: string
  limit?: number
}): Promise<{ transactions: AccountTransaction[] }> {
  const search = new URLSearchParams()
  if (params?.since_ts != null) search.set('since_ts', String(params.since_ts))
  if (params?.until_ts != null) search.set('until_ts', String(params.until_ts))
  if (params?.account_id) search.set('account_id', params.account_id)
  if (params?.limit != null) search.set('limit', String(params.limit))
  const r = await fetch(`${API}/transactions?${search}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** POST /transactions/fetch: fetch cash transactions from IB Flex and upsert. Optional body: { from_date?, to_date? } yyyyMMdd, max 366 days. */
export async function postTransactionsFetch(body?: { from_date?: string; to_date?: string }): Promise<{ ok: boolean; count?: number; message?: string; error?: string; by_account?: number }> {
  const r = await fetch(`${API}/transactions/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as { ok?: boolean }).ok)
  const errMsg = (j as { error?: string }).error
  return {
    ok,
    count: (j as { count?: number }).count,
    message: (j as { message?: string }).message,
    error: errMsg ?? (!ok && !r.ok ? r.statusText || 'Server error' : undefined),
    by_account: (j as { by_account?: number }).by_account,
  }
}
