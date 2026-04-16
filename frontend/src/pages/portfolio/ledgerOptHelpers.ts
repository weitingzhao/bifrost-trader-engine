import type { Execution, OptExecutionGroup, OptionStockLinkRow, OptionStockLinkSummary } from '../../types'

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

    const taxes = ex.taxes
    const netCash = ex.net_cash

    return {
      ...ex,
      quantity: allocQty,
      realized_pnl:
        rp != null && Number.isFinite(Number(rp)) ? Number(rp) * w : rp,
      commission:
        comm != null && Number.isFinite(Number(comm)) ? Number(comm) * w : comm,
      taxes:
        taxes != null && Number.isFinite(Number(taxes)) ? Number(taxes) * w : taxes,
      net_cash:
        netCash != null && Number.isFinite(Number(netCash)) ? Number(netCash) * w : netCash,
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

/** Sum of |allocated_quantity| across instance_allocations; used for split ratio display. */
export function getInstanceAllocationSplitMeta(
  ex: Execution,
  strategyInstanceId: number,
): { allocatedAbs: number; totalAbs: number } | null {
  const allocs = ex.instance_allocations
  if (!allocs?.length) return null
  let totalAbs = 0
  for (const a of allocs) {
    totalAbs += Math.abs(Number(a.allocated_quantity) || 0)
  }
  if (totalAbs <= 0) return null
  const mine = allocs.find(a => Number(a.strategy_instance_id) === strategyInstanceId)
  if (!mine) return null
  const allocatedAbs = Math.abs(Number(mine.allocated_quantity) || 0)
  return { allocatedAbs, totalAbs }
}

/** Short "allocated/total" label for split rows (abs quantities). */
export function formatInstanceAllocationRatioShort(allocatedAbs: number, totalAbs: number): string {
  const fmt = (n: number) =>
    Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, '')
  return `${fmt(allocatedAbs)}/${fmt(totalAbs)}`
}

/**
 * Tooltip + ratio label when this execution row uses account_execution_instance_allocation
 * (for UI next to Executions Final).
 */
export function describeInstanceAllocationSplitForDisplay(
  ex: Execution,
  strategyInstanceId: number,
): { ratioLabel: string; tooltip: string } | null {
  const meta = getInstanceAllocationSplitMeta(ex, strategyInstanceId)
  if (!meta) return null
  return {
    ratioLabel: formatInstanceAllocationRatioShort(meta.allocatedAbs, meta.totalAbs),
    tooltip: `Split via instance allocation (account_execution_instance_allocation). This instance share: |${meta.allocatedAbs}| of |${meta.totalAbs}| by abs allocated quantity.`,
  }
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
/** Sibling fills on the same option contract that already have instance attribution (for Assign strategy shortcut). */
export interface PeerInstancePick {
  strategy_opportunity_id: number
  strategy_instance_id: number
  label: string
}

/**
 * Unique (opportunity, instance) pairs from other executions in the same contract group — excludes `currentAccountExecutionsId`.
 */
export function collectPeerInstancePicks(
  sameContractTrades: Execution[],
  currentAccountExecutionsId: number,
): PeerInstancePick[] {
  const seen = new Set<string>()
  const out: PeerInstancePick[] = []
  for (const peer of sameContractTrades) {
    const pid = peer.account_executions_id
    if (pid != null && pid === currentAccountExecutionsId) continue
    const iids = executionStrategyInstanceIds(peer)
    for (const iid of iids) {
      const sliced = sliceExecutionForInstanceOptView(peer, iid)
      const oppRaw = sliced?.strategy_opportunity_id ?? peer.strategy_opportunity_id
      if (oppRaw == null || !Number.isFinite(Number(oppRaw))) continue
      const oppId = Number(oppRaw)
      const key = `${oppId}::${iid}`
      if (seen.has(key)) continue
      seen.add(key)
      const oppName =
        (sliced?.strategy_opportunity_name?.trim() ||
          peer.strategy_opportunity_name?.trim() ||
          '') || `Opportunity #${oppId}`
      const instLab =
        (sliced?.strategy_instance_label?.trim() || peer.strategy_instance_label?.trim() || '') || ''
      const label = instLab ? `${oppName} · ${instLab} (#${iid})` : `${oppName} · #${iid}`
      out.push({ strategy_opportunity_id: oppId, strategy_instance_id: iid, label })
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

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

/** Sum of stock slippage vs close (signed qty × (price − close)) for one OPT execution id. */
export function stockSlippageTotalForOptionExecution(
  optionAccountExecutionsId: number | null | undefined,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): number {
  if (optionAccountExecutionsId == null || !linkByOptionId) return 0
  const t = linkByOptionId[optionAccountExecutionsId]?.slippage_total
  return t != null && Number.isFinite(t) ? t : 0
}

/**
 * Options detail table (per fill): premium cash flow for this row plus linked-stock slippage when
 * this option execution has stock links (or non-zero slippage from the bulk query).
 * When not combined, matches legacy display (non-buy uses abs on the option-only cash flow).
 */
export function ledgerOptDetailRowPnl(
  ex: Execution,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): { displayPnl: number; hasCombinedStock: boolean; stockAdj: number } {
  const s = (ex.side ?? '').toUpperCase()
  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
  const isSell = !isBuy
  const q = Number(ex.quantity) || 0
  const p = Number(ex.price) || 0
  const c = Number(ex.commission) || 0
  const value = q * p * 100 - c
  const optionEconomic = isBuy ? -value : value
  const oid = ex.account_executions_id
  const stockAdj = stockSlippageTotalForOptionExecution(oid, linkByOptionId)
  const linkCount =
    oid != null && linkByOptionId ? (linkByOptionId[oid]?.links?.length ?? 0) : 0
  const hasCombinedStock =
    oid != null && linkByOptionId != null && (linkCount > 0 || stockAdj !== 0)
  let displayPnl: number
  if (hasCombinedStock) {
    displayPnl = optionEconomic + stockAdj
  } else {
    const pnl = optionEconomic
    displayPnl = isSell ? Math.abs(pnl) : pnl
  }
  return { displayPnl, hasCombinedStock, stockAdj }
}

/**
 * Same as {@link ledgerOptDetailRowPnl} but scales option cash flow and stock slippage by `ratio` (e.g. matched qty / full |qty| on Performance realized execution rows).
 */
export function scaledLedgerOptDetailRowPnl(
  ex: Execution,
  ratio: number,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): { displayPnl: number; hasCombinedStock: boolean } {
  if (ratio <= 0 || !Number.isFinite(ratio)) return { displayPnl: 0, hasCombinedStock: false }
  const s = (ex.side ?? '').toUpperCase()
  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
  const isSell = !isBuy
  const q = Number(ex.quantity) || 0
  const p = Number(ex.price) || 0
  const c = Number(ex.commission) || 0
  const value = q * p * 100 - c
  const optionEconomic = isBuy ? -value : value
  const oid = ex.account_executions_id
  const slipFull = stockSlippageTotalForOptionExecution(oid, linkByOptionId)
  const linkCount = oid != null && linkByOptionId ? (linkByOptionId[oid]?.links?.length ?? 0) : 0
  const hasCombinedStock =
    oid != null && linkByOptionId != null && (linkCount > 0 || slipFull !== 0)
  if (hasCombinedStock) {
    return { displayPnl: optionEconomic * ratio + slipFull * ratio, hasCombinedStock: true }
  }
  const pnl = optionEconomic * ratio
  const displayPnl = isSell ? Math.abs(pnl) : pnl
  return { displayPnl, hasCombinedStock: false }
}

/**
 * Performance calendar day-detail: final Realized PnL = FIFO **Match** option total (`pairNetSum`, same as Match rows)
 * plus prorated linked-stock slippage on each fill’s matched quantity (Trade Ledger slippage layer).
 * Keeps option economics anchored to FIFO pairs; stock is additive. If no fill has matched qty (e.g. synthetic pairs
 * without leg ids), returns `pairNetSum` and stock add is zero.
 */
export function realizedPnlFifoMatchPlusStock(
  pairNetSum: number,
  sortedExecs: Execution[],
  matchedQtyById: Map<number, number>,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): number {
  let stockAdj = 0
  let anyMatched = false
  for (const e of sortedExecs) {
    const id = e.account_executions_id
    if (id == null) continue
    const eq = Math.abs(Number(e.quantity) || 0)
    if (eq <= 1e-9) continue
    const mq = matchedQtyById.get(id) ?? 0
    if (mq <= 1e-9) continue
    anyMatched = true
    const r = mq / eq
    stockAdj += stockSlippageTotalForOptionExecution(id, linkByOptionId) * r
  }
  if (!anyMatched) return pairNetSum
  return pairNetSum + stockAdj
}

/**
 * Closed-option group PnL: premium-based realized_pnl plus stock-leg slippage vs Flex close
 * for each distinct option fill in the group (one sum per account_executions_id).
 */
export function adjustedRealizedPnlForOptGroup(
  g: OptExecutionGroup,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): number {
  const base = Number(g.realized_pnl) || 0
  if (!linkByOptionId) return base
  let adj = 0
  const seen = new Set<number>()
  for (const ex of g.trades ?? []) {
    const oid = ex.account_executions_id
    if (oid == null || seen.has(oid)) continue
    seen.add(oid)
    adj += stockSlippageTotalForOptionExecution(oid, linkByOptionId)
  }
  return base + adj
}

export function collectLinkIdsForOptGroup(
  g: OptExecutionGroup,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): number[] {
  const ids = new Set<number>()
  if (!linkByOptionId) return []
  const seen = new Set<number>()
  for (const ex of g.trades ?? []) {
    const oid = ex.account_executions_id
    if (oid == null || seen.has(oid)) continue
    seen.add(oid)
    for (const row of linkByOptionId[oid]?.links ?? []) {
      if (row.link_id != null && Number.isFinite(Number(row.link_id))) ids.add(Number(row.link_id))
    }
  }
  return Array.from(ids).sort((a, b) => a - b)
}

/** Deduped link rows for readonly modal (same link_id appears once). */
/** Per-option-fill linked stock rows (for Details Contract column). */
export function getOptionStockLinkDetailForExecution(
  ex: Execution,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): { linkIds: number[]; links: OptionStockLinkRow[]; slippageTotal: number | null } {
  const oid = ex.account_executions_id
  if (oid == null || !linkByOptionId) return { linkIds: [], links: [], slippageTotal: null }
  const s = linkByOptionId[oid]
  const links = s?.links ?? []
  if (links.length === 0) return { linkIds: [], links: [], slippageTotal: null }
  const linkIds = links
    .map(r => r.link_id)
    .filter((id): id is number => id != null && Number.isFinite(Number(id)))
    .sort((a, b) => a - b)
  return {
    linkIds,
    links,
    slippageTotal: s?.slippage_total ?? null,
  }
}

export function flattenLinksForOptGroup(
  g: OptExecutionGroup,
  linkByOptionId: Record<number, OptionStockLinkSummary> | undefined,
): OptionStockLinkRow[] {
  const byId = new Map<number, OptionStockLinkRow>()
  if (!linkByOptionId) return []
  const seen = new Set<number>()
  for (const ex of g.trades ?? []) {
    const oid = ex.account_executions_id
    if (oid == null || seen.has(oid)) continue
    seen.add(oid)
    for (const row of linkByOptionId[oid]?.links ?? []) {
      const lid = row.link_id
      if (lid != null && !byId.has(lid)) byId.set(lid, row)
    }
  }
  return Array.from(byId.values()).sort((a, b) => (a.link_id ?? 0) - (b.link_id ?? 0))
}
