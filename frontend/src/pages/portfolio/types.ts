import type { Execution, IbPositionRow, OptExecutionGroup } from '../../types'

export type PortfolioView = 'overview' | 'open' | 'ledger' | 'performance' | 'accounts' | 'transfer'

export type LivePositionRow = IbPositionRow & {
  account_id: string
}

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
