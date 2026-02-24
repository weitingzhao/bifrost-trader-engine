/** IB connection config (from DB, daemon loads on start) */
export interface IbConfig {
  ib_host?: string
  ib_port_type?: 'tws_live' | 'tws_paper' | 'gateway'
}

/** One position row from IB (R-A1 multi-account) */
export interface IbPositionRow {
  account?: string
  symbol?: string
  secType?: string
  exchange?: string
  currency?: string
  position?: number
  avgCost?: number | null
  /** 期权到期 YYYYMM/YYYYMMDD (lastTradeDateOrContractMonth) */
  lastTradeDateOrContractMonth?: string
  expiry?: string
  strike?: number
  right?: string
}

/** One account in GET /status accounts (R-A1 multi-account) */
export interface IbAccountSnapshot {
  account_id?: string
  summary?: Record<string, string>
  positions?: IbPositionRow[]
}

/** Response from GET /status */
export interface StatusResponse {
  self_check?: string
  block_reasons?: string[]
  status_lamp?: 'green' | 'yellow' | 'red'
  trading_suspended?: boolean
  daemon_heartbeat?: DaemonHeartbeat | null
  daemon_self_check?: string
  daemon_lamp?: 'green' | 'yellow' | 'red'
  daemon_block_reasons?: string[]
  status?: StatusRow | null
  /** R-A1 multi-account: 与守护/对冲同级，交易账户与持仓基础数据 */
  accounts?: IbAccountSnapshot[] | null
  ib_config?: IbConfig | null
}

export interface DaemonHeartbeat {
  last_ts?: number | null
  hedge_running?: boolean
  daemon_alive?: boolean
  ib_connected?: boolean
  ib_client_id?: number | null
  next_retry_ts?: number | null
  seconds_until_retry?: number | null
  graceful_shutdown_at?: number | null
  /** Interval in seconds used by daemon (5–120); for countdown. */
  heartbeat_interval_sec?: number | null
}

export interface StatusRow {
  daemon_state?: string
  trading_state?: string
  symbol?: string
  spot?: number
  stock_position?: number
  daily_hedge_count?: number
  ts?: number
  /** R-A1: 主账户标识与摘要（连接后由守护进程写入） */
  account_id?: string | null
  account_net_liquidation?: number | null
  account_total_cash?: number | null
  account_buying_power?: number | null
  [key: string]: unknown
}

/** Response from GET /operations */
export interface OperationsResponse {
  operations: Operation[]
}

export interface Operation {
  ts: number
  type?: string
  side?: string
  quantity?: number
  price?: number
  state_reason?: string
}

/** Control API response */
export interface ControlResponse {
  ok?: boolean
  error?: string
  message?: string
}
