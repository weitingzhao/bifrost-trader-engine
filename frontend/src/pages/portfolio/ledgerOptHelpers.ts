import type { Execution, OptExecutionGroup } from '../../types'

export function getOptGroupKey(g: OptExecutionGroup): string {
  return `${g.contract_key}-${g.strike}-${g.expiry}`
}

export type InstanceConsistencyState = 'same' | 'mixed' | 'different' | 'none'

export function getInstanceConsistencyState(trades: Execution[]): InstanceConsistencyState {
  if (trades.length === 0) return 'none'
  const instanceIds = trades
    .map(t => t.strategy_instance_id)
    .filter((id): id is number => id != null && Number.isFinite(id))
  const hasAnyInstance = instanceIds.length > 0
  const allHaveInstance = trades.every(
    t => t.strategy_instance_id != null && Number.isFinite(t.strategy_instance_id),
  )
  if (!hasAnyInstance) return 'none'
  if (!allHaveInstance) return 'mixed'
  return new Set(instanceIds).size === 1 ? 'same' : 'different'
}

export function getAggregatedInstanceConsistencyState(trades: Execution[]): InstanceConsistencyState {
  if (trades.length === 0) return 'none'
  const byAccount = new Map<string, Execution[]>()
  for (const t of trades) {
    const accountId = (t.account_id ?? '').trim() || '__NO_ACCOUNT__'
    if (!byAccount.has(accountId)) byAccount.set(accountId, [])
    byAccount.get(accountId)!.push(t)
  }
  const states = Array.from(byAccount.values(), accountTrades =>
    getInstanceConsistencyState(accountTrades),
  )
  if (states.every(s => s === 'none')) return 'none'
  if (states.some(s => s === 'different')) return 'different'
  if (states.some(s => s === 'mixed')) return 'mixed'
  if (states.some(s => s === 'none')) return 'mixed'
  if (states.every(s => s === 'same')) return 'same'
  return 'none'
}
