import type { Execution, OptExecutionGroup } from '../../types'

/** Stable key for grouping ledger rows by strategy opportunity (null/invalid → unassigned). */
export function executionStrategyOpportunityKey(ex: Execution): number | 'none' {
  const oid = ex.strategy_opportunity_id
  if (oid != null && Number.isFinite(Number(oid))) return Number(oid)
  return 'none'
}

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
    if (out.length > 0) return out
  }
  if (ex.strategy_instance_id != null && Number.isFinite(Number(ex.strategy_instance_id))) {
    return [Number(ex.strategy_instance_id)]
  }
  return []
}

/**
 * Synthetic execution row for one strategy_instance: allocated signed qty and pro-rata PnL/commission
 * (same weighting as reader `weight_realized_for_strategy_instance` / account_execution_instance_allocation).
 * Use when building per-instance option contract groups (Trade ledger Instance tab).
 */
export function sliceExecutionForInstanceOptView(ex: Execution, instanceId: number): Execution | null {
  const allocs = ex.instance_allocations
  if (allocs && allocs.length > 0) {
    let denom = 0
    for (const a of allocs) {
      denom += Math.abs(Number(a.allocated_quantity) || 0)
    }
    if (denom <= 0) return null
    const mine = allocs.find(a => Number(a.strategy_instance_id) === instanceId)
    if (!mine) return null
    const allocQty = Number(mine.allocated_quantity)
    if (!Number.isFinite(allocQty)) return null
    const w = Math.abs(allocQty) / denom

    const rp = ex.realized_pnl
    const comm = ex.commission

    /** Prefer `strategy_opportunity_id` on the allocation row (JOIN from `strategy_instance`); parent row may be NULL per DATABASE §2.24.11d. */
    const allocOppRaw = mine.strategy_opportunity_id
    const resolvedOppId =
      allocOppRaw != null && Number.isFinite(Number(allocOppRaw))
        ? Number(allocOppRaw)
        : ex.strategy_opportunity_id != null && Number.isFinite(Number(ex.strategy_opportunity_id))
          ? Number(ex.strategy_opportunity_id)
          : null
    const parentOppNum =
      ex.strategy_opportunity_id != null && Number.isFinite(Number(ex.strategy_opportunity_id))
        ? Number(ex.strategy_opportunity_id)
        : null
    const resolvedOppName =
      resolvedOppId != null &&
      parentOppNum != null &&
      resolvedOppId === parentOppNum
        ? ex.strategy_opportunity_name?.trim() ?? null
        : null

    return {
      ...ex,
      quantity: allocQty,
      realized_pnl:
        rp != null && Number.isFinite(Number(rp)) ? Number(rp) * w : rp,
      commission:
        comm != null && Number.isFinite(Number(comm)) ? Number(comm) * w : comm,
      strategy_opportunity_id: resolvedOppId,
      strategy_opportunity_name: resolvedOppName,
      strategy_instance_id: instanceId,
      strategy_instance_label:
        (mine.strategy_instance_label?.trim() || ex.strategy_instance_label?.trim()) ?? null,
      instance_allocations: undefined,
    }
  }

  if (ex.strategy_instance_id === instanceId) return ex
  return null
}

/**
 * Whether this execution belongs under a Positions Instance row (same instance + opportunity when resolved).
 * Unassigned bucket (strategyInstanceId null): only fills with no instance attribution.
 */
export function executionMatchesInstanceGroup(
  ex: Execution,
  strategyInstanceId: number | null,
  strategyOpportunityId: number | null,
): boolean {
  if (strategyInstanceId == null) {
    return executionStrategyInstanceIds(ex).length === 0
  }
  const ids = executionStrategyInstanceIds(ex)
  if (!ids.includes(strategyInstanceId)) return false
  if (strategyOpportunityId == null) return true
  const sliced = sliceExecutionForInstanceOptView(ex, strategyInstanceId)
  const exOppRaw =
    sliced?.strategy_opportunity_id != null && Number.isFinite(Number(sliced.strategy_opportunity_id))
      ? Number(sliced.strategy_opportunity_id)
      : ex.strategy_opportunity_id != null && Number.isFinite(Number(ex.strategy_opportunity_id))
        ? Number(ex.strategy_opportunity_id)
        : null
  if (exOppRaw != null && exOppRaw !== strategyOpportunityId) return false
  return true
}

/**
 * After per-opportunity expansion, bucket rows by `strategy_instance_id`
 * (missing → `none` for “No instance” under that opportunity).
 */
export function groupExecutionsByStrategyInstanceId(
  trades: Execution[],
): Map<number | 'none', Execution[]> {
  const m = new Map<number | 'none', Execution[]>()
  for (const t of trades) {
    const sid = t.strategy_instance_id
    const key: number | 'none' =
      sid != null && Number.isFinite(Number(sid)) ? Number(sid) : 'none'
    const arr = m.get(key)
    if (arr) arr.push(t)
    else m.set(key, [t])
  }
  return m
}

/** Expand one execution into per-allocation instance rows (qty/PnL + opportunity id from allocation when set). */
export function expandExecutionRowsForStrategyOptView(ex: Execution): Execution[] {
  const ids = executionStrategyInstanceIds(ex)
  if (ids.length === 0) {
    return [ex]
  }
  const seen = new Set<number>()
  const out: Execution[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = sliceExecutionForInstanceOptView(ex, id)
    if (row) out.push(row)
  }
  return out
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
