import type { StrategyInstance } from '../types'
import { API } from './constants'

export interface StrategyInstancesParams {
  account_id?: string
  strategy_opportunity_id?: number
}

export async function fetchStrategyInstances(
  params?: StrategyInstancesParams
): Promise<{ items: StrategyInstance[] }> {
  const search = new URLSearchParams()
  if (params?.account_id) search.set('account_id', params.account_id)
  if (params?.strategy_opportunity_id != null) search.set('strategy_opportunity_id', String(params.strategy_opportunity_id))
  const q = search.toString()
  const r = await fetch(`${API}/strategies/instances${q ? `?${q}` : ''}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchStrategyInstance(id: number): Promise<StrategyInstance> {
  const r = await fetch(`${API}/strategies/instances/${id}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export interface CreateStrategyInstancePayload {
  strategy_opportunity_id: number
  account_id: string
  opened_at: string
  label?: string
  notes?: string
}

export async function createStrategyInstance(
  payload: CreateStrategyInstancePayload
): Promise<{ strategy_instance_id: number }> {
  const r = await fetch(`${API}/strategies/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error((j as { detail?: string }).detail || r.statusText)
  }
  return r.json()
}

export async function updateStrategyInstance(
  strategy_instance_id: number,
  payload: { label?: string; notes?: string }
): Promise<void> {
  const r = await fetch(`${API}/strategies/instances/${strategy_instance_id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(r.statusText)
}
