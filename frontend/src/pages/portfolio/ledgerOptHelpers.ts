import type { Execution, OptExecutionGroup } from '../../types'

/** Instance id(s) attributed to this execution: multi-row splits or single-column strategy_instance_id. */
export function executionStrategyInstanceIds(ex: Execution): number[] {
  const allocs = ex.instance_allocations
  if (allocs && allocs.length > 0) {
    const out: number[] = []
    for (const a of allocs) {
      const id = a.strategy_instance_id
      if (id != null && Number.isFinite(Number(id))) {
        out.push(Number(id))
      }
    }
    return out
  }
  if (ex.strategy_instance_id != null && Number.isFinite(Number(ex.strategy_instance_id))) {
    return [Number(ex.strategy_instance_id)]
  }
  return []
}

/** Label for a specific instance on this execution (split row or single-column). */
export function executionInstanceLabel(ex: Execution, instanceId: number): string | null {
  const allocs = ex.instance_allocations
  if (allocs && allocs.length > 0) {
    const m = allocs.find(a => a.strategy_instance_id === instanceId)
    const fromAlloc = m?.strategy_instance_label?.trim()
    if (fromAlloc) return fromAlloc
  }
  const col = ex.strategy_instance_label?.trim()
  if (ex.strategy_instance_id === instanceId && col) return col
  return null
}

export function getOptGroupKey(g: OptExecutionGroup): string {
  return `${g.contract_key}-${g.strike}-${g.expiry}`
}

/** Closed-option group Contract column: instance icon color (all fills in the group). */
export type InstanceConsistencyState = 'none' | 'mixed' | 'same' | 'multiple'

/**
 * 1) No fill has instance → none (no icon).
 * 2) At least one fill lacks instance → mixed (yellow).
 * 3) Every fill has instance: one unique id → same (green); more than one unique id → multiple (purple).
 */
export function getInstanceConsistencyState(trades: Execution[]): InstanceConsistencyState {
  if (trades.length === 0) return 'none'
  const instanceIds: number[] = []
  for (const t of trades) {
    instanceIds.push(...executionStrategyInstanceIds(t))
  }
  if (instanceIds.length === 0) return 'none'
  const allHaveInstance = trades.every(t => executionStrategyInstanceIds(t).length > 0)
  if (!allHaveInstance) return 'mixed'
  return new Set(instanceIds).size === 1 ? 'same' : 'multiple'
}

export function isExecutionBuySide(ex: Execution): boolean {
  const s = (ex.side ?? '').toUpperCase()
  return s === 'BUY' || s === 'BOT' || s === 'B'
}

export function executionAbsQuantity(ex: Execution): number {
  return Math.abs(Number(ex.quantity) || 0)
}

/**
 * Same option contract group: find another fill on the opposite side with the same |quantity|
 * that already has strategy opportunity + instance (for one-click sync onto unlinked legs).
 */
export function findOppositeLegAttributionSource(trades: Execution[], ex: Execution): Execution | null {
  const exId = ex.account_executions_id
  const exBuy = isExecutionBuySide(ex)
  const exQty = executionAbsQuantity(ex)
  if (exQty <= 0) return null
  const exCk = (ex.contract_key ?? '').trim()

  for (const t of trades) {
    if (exId != null && t.account_executions_id != null && t.account_executions_id === exId) {
      continue
    }
    if (exId == null && t === ex) continue

    const tCk = (t.contract_key ?? '').trim()
    if (exCk && tCk && exCk !== tCk) continue

    if (isExecutionBuySide(t) === exBuy) continue
    if (executionAbsQuantity(t) !== exQty) continue

    const opp = t.strategy_opportunity_id
    const instIds = executionStrategyInstanceIds(t)
    if (instIds.length !== 1) continue
    const inst = instIds[0]
    if (opp == null || !Number.isFinite(Number(opp)) || !Number.isFinite(Number(inst))) {
      continue
    }
    return t
  }
  return null
}
