import type { Execution, IbPositionRow, OptExecutionGroup } from '../../types'

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

/** Combined option + stock positions per strategy instance (Positions Instance tab). */
export type InstanceAllGroup = {
  strategy_instance_id: number | null
  strategy_instance_label: string | null
  strategy_opportunity_name: string | null
  strategy_instance_opened_at_epoch: number | null
  options: OpenOptionPosition[]
  stocks: LivePositionRow[]
  total_unrealized_pnl: number
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
