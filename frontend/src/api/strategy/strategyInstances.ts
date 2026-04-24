import type { StrategyInstance } from '../../types'
import { getStrategyApiBase, joinServiceBase } from '../shared/apiRouting'

function apiBase(): string {
  return getStrategyApiBase()
}

function strategyUrl(path: string): string {
  return joinServiceBase(apiBase(), path)
}

export interface StrategyInstancesParams {
  account_id?: string
  strategy_opportunity_id?: number
  /** One or more instance IDs; serialized as comma-separated query value. */
  strategy_instance_ids?: number[]
  opened_at_from?: number
  opened_at_until?: number
}

export async function fetchStrategyInstances(
  params?: StrategyInstancesParams
): Promise<{ items: StrategyInstance[] }> {
  const search = new URLSearchParams()
  if (params?.account_id) search.set('account_id', params.account_id)
  if (params?.strategy_opportunity_id != null) search.set('strategy_opportunity_id', String(params.strategy_opportunity_id))
  if (params?.strategy_instance_ids != null && params.strategy_instance_ids.length > 0) {
    search.set('strategy_instance_ids', params.strategy_instance_ids.join(','))
  }
  if (params?.opened_at_from != null) search.set('opened_at_from', String(params.opened_at_from))
  if (params?.opened_at_until != null) search.set('opened_at_until', String(params.opened_at_until))
  const q = search.toString()
  const r = await fetch(strategyUrl(`/strategies/instances${q ? `?${q}` : ''}`))
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchStrategyInstance(id: number): Promise<StrategyInstance> {
  const r = await fetch(strategyUrl(`/strategies/instances/${id}`))
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
  const r = await fetch(strategyUrl('/strategies/instances'), {
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
  payload: { label?: string; notes?: string; created_at?: string; opened_at?: string }
): Promise<void> {
  const r = await fetch(strategyUrl(`/strategies/instances/${strategy_instance_id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(r.statusText)
}

export async function deleteStrategyInstance(strategy_instance_id: number): Promise<void> {
  const r = await fetch(strategyUrl(`/strategies/instances/${strategy_instance_id}`), {
    method: 'DELETE',
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error((j as { detail?: string }).detail || r.statusText)
  }
}

export interface WinRateStructureRow {
  structure_name: string
  total_instances: number
  profit_trades: number
  loss_trades: number
  total_profit: number | null
  /** Sum of each instance's worst losing trade (performance summary max_loss), same scope as structure / all. */
  total_loss: number | null
  /** Win Rate UI: underlying cost on net-PnL-positive instances (strike×|qty|×100, sell OPT). */
  profit_investment: number | null
  /** Win Rate UI: underlying cost on net-PnL ≤ 0 instances. */
  loss_investment: number | null
  /** Win Rate UI: profit_investment + loss_investment. */
  total_investment: number | null
  profit_avg_pct: number | null
  loss_avg_pct: number | null
  single_max_loss_pct: number | null
  profit_avg_usd: number | null
  loss_avg_usd: number | null
}

export interface WinRateResponse {
  structures: WinRateStructureRow[]
  /** Aggregate over every instance (same shape as one structure row); for All structures card. */
  totals_all?: WinRateStructureRow | null
}

export async function fetchStrategyWinRate(params?: {
  since_ts?: number
  until_ts?: number
}): Promise<WinRateResponse> {
  const p = new URLSearchParams()
  if (params?.since_ts != null) p.set('since_ts', String(params.since_ts))
  if (params?.until_ts != null) p.set('until_ts', String(params.until_ts))
  const query = p.toString()
  const r = await fetch(strategyUrl(`/strategies/win-rate${query ? `?${query}` : ''}`))
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}
