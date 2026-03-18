import type { Execution, IbPositionRow, OptExecutionGroup } from '../../types'
import type { RiskProfile } from '../../utils/riskProfile'

export type PortfolioView = 'overview' | 'open' | 'ledger' | 'performance' | 'accounts' | 'transfer'

export type LivePositionRow = IbPositionRow & {
  account_id: string
}

export type OpenOptionPosition = {
  kind: 'live' | 'offtrack'
  contract_key: string
  strike: number
  expiry: string
  qty: number
  avg_cost: number | null
  mark_price: number | null
  unrealized_pnl: number
  pool_label: 'On' | 'Off'
  account_id: string
  position?: LivePositionRow
  trades?: Execution[]
}

export type InstancePositionGroup = {
  strategy_instance_id: number | null
  strategy_instance_label: string | null
  strategy_opportunity_name: string | null
  strategy_instance_opened_at_epoch: number | null
  positions: OpenOptionPosition[]
  total_unrealized_pnl: number
}

/** Per-instance underlying stock coverage derived from structure legs + option positions (same account as those options). */
export type InstanceStockCoverage = {
  symbol: string
  /** IB account_id for the option legs that create this requirement; stock hedge must be in this account. */
  account_id: string
  required_shares: number
  direction: 'long' | 'short'
}

/** Per-(symbol, account) stock coverage summary across instances. */
export type StockCoverageItem = {
  symbol: string
  account_id: string
  required_shares: number
  held_shares: number
  surplus_or_gap: number
  instances_needing: number
  /** Opportunities currently backed by this stock symbol. */
  backing_opportunities?: string[]
  /** Count of backing instances/opps using watchlist scope. */
  watchlist_scope_instances?: number
  /** true=option supported, false=not supported, null=unknown/mixed across accounts. */
  optionable_supported?: boolean | null
  /** Weighted average cost per share (abs-qty weighted). */
  avg_cost_per_share?: number | null
  /** Weighted live last price per share (abs-qty weighted). */
  live_last_price?: number | null
  /** Total cost basis (abs qty * avgCost). */
  cost_basis_total?: number | null
  /** Daily PnL aggregated from live last vs daily_prev_close. */
  daily_pnl?: number | null
  daily_pct?: number | null
  /** Total unrealized PnL and pct (vs cost basis). */
  total_pnl?: number | null
  total_pct?: number | null
}

/** Combined option + stock coverage per strategy instance (Positions Instance tab). */
export type InstanceAllGroup = {
  strategy_instance_id: number | null
  strategy_instance_label: string | null
  strategy_opportunity_name: string | null
  strategy_opportunity_id: number | null
  strategy_instance_opened_at_epoch: number | null
  options: OpenOptionPosition[]
  stock_coverage: InstanceStockCoverage[]
  /** Sum of option unrealized PnL for this instance (execution-based where available). */
  options_unrealized_pnl: number
  /** From strategy_structure via opportunity → structure chain. E.g. covered_call, iron_condor. */
  structure_type: string | null
  /** From strategy_opportunity.scope_type. E.g. watchlist_stk, explicit_symbols. */
  scope_type: string | null
  /** Expiration payoff risk profile computed from option positions + coverage. */
  risk_profile: RiskProfile | null
}

/** @deprecated kept for transition; use InstancePositionGroup */
export type OpenOptionGroup = {
  kind: 'live' | 'offtrack'
  contract_key: string
  strike: number
  expiry: string
  net_qty: number
  avg_cost: number | null
  mark_price: number | null
  unrealized_pnl: number | null
  account_count: number
  pool_label: 'On' | 'Off'
  buy_volume: number
  sell_volume: number
  buy_avg_price: number | null
  sell_avg_price: number | null
  buy_cost: number
  sell_premium: number
  positions?: LivePositionRow[]
  trades?: Execution[]
}

export type { Execution, OptExecutionGroup }
