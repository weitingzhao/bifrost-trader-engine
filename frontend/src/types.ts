/** IB connection config (from DB, daemon loads on start). client_id_* 供不同用途使用，避免冲突。 */
export interface IbConfig {
  ib_host?: string
  ib_port_type?: 'tws_live' | 'tws_paper' | 'gateway'
  /** 守护进程连接 IB 使用的 Client ID（默认 1） */
  ib_client_id_daemon?: number
  /** 守护侧监听进程使用的 Client ID（预留，默认 2） */
  ib_client_id_listener?: number
  /** 监控端拉取账户信息/执行记录（POST /executions/fetch）使用的 Client ID（默认 4） */
  ib_client_id_account?: number
  /** 监控端拉取市场数据/K 线（POST /bars/fetch）使用的 Client ID（默认 10） */
  ib_client_id_markets?: number
  /** Celery worker（如 Bars 补全）连接 IB 使用的 Client ID（默认 500），worker_market，与 Daemon/Monitor 隔离 */
  ib_client_id_worker_market?: number
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
  /** 当前价（来自 instrument_prices.mid/last），用于逐行计算盈亏 */
  price?: number | null
  /** 当前持仓浮动盈亏（后端用 instrument_prices.last 与 position/avg_cost 计算） */
  unrealized_pnl?: number | null
  /** instrument_prices.updated_at 的 Unix 秒，用于 Last Update 显示 */
  price_updated_at?: number | null
  /** 合约唯一键 symbol|sec_type|expiry|strike|right（若后端返回） */
  contract_key?: string | null
  /** 持仓行最后更新时间（account_positions.updated_at，Unix 秒），供 Details TIME 列显示 */
  updated_at?: number | null
  /** 该持仓对应的 account_executions 最新一条的 exec_time（LEFT JOIN 按 account_id+contract_key，Unix 秒），供 Pool=On Details TIME 列优先使用 */
  exec_time?: number | null
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
  /** 系统状态 Tab 用：daemon / monitor / status 三者都绿才绿，否则取最差 */
  system_lamp?: 'green' | 'yellow' | 'red'
  daemon_block_reasons?: string[]
  status?: StatusRow | null
  /** R-A1 multi-account: 与守护/对冲同级，交易账户与持仓基础数据 */
  accounts?: IbAccountSnapshot[] | null
  /** 账户/持仓数据最后从 IB 拉取并写入 DB 的时间（Unix 秒），供监控页显示数据新鲜度 */
  accounts_fetched_at?: number | null
  ib_config?: IbConfig | null
  /** 监控端 IB 状态：AccountIbClient/MarketIbClient 的连接情况与错误信息 */
  monitor_ib_status?: {
    account?: { connected?: boolean; client_id?: number | null; last_error?: string | null }
    market?: { connected?: boolean; client_id?: number | null; last_error?: string | null }
  } | null
  /** 监控端是否启用（停止监控后需重新启动监控服务进程） */
  monitor_enabled?: boolean
  /** 监控服务健康：能拿到 /status 或 GET /health 200 即表示进程存活 */
  monitor_health?: string
  /** 监控服务自检结果与原因（与守护类似的红绿灯语义） */
  monitor_self_check?: string
  monitor_lamp?: 'green' | 'yellow' | 'red'
  monitor_block_reasons?: string[]
  /** 监控端是否能连接 Redis 并读取行情（R-RM*） */
  redis_quotes_connected?: boolean
  /** Celery broker (Redis) 是否可达，用于 System → Celery 状态 */
  celery_broker_connected?: boolean
  /** Worker 是否已连接 IB（与 Monitor/Daemon 同级，由 Worker 写入 Redis） */
  celery_worker_ib_connected?: boolean
  /** Worker 连接 IB 使用的 client_id（与 celery_worker_ib_connected 配套） */
  celery_worker_ib_client_id?: number | null
  /** bars_backfill_jobs 最近一次 updated_at（Unix 秒），用于判断 Worker 是否有近期活动 */
  celery_worker_last_updated_ts?: number | null
  /** 当前响应的 Celery Worker 名称列表（inspect ping），用于 Celery 下列出已运行 Worker */
  celery_workers?: string[]
  /** 当前守护进程订阅的 Real-time ticker 标的（Watchlist STK + strategy symbol），与 Event Subscribe 一致 */
  subscribed_tickers?: string[]
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
  /** 守护进程是否连接 Redis 并写入行情（R-RM*） */
  redis_quotes_connected?: boolean
  /** Daemon IB 事件订阅状态（System 页 Event Subscribe 区块） */
  event_subscribe_ticker?: boolean
  event_subscribe_positions?: boolean
  event_subscribe_fills?: boolean
  event_subscribe_commission?: boolean
  /** 守护进程第二条 IB 连接（settings.ib_client_id_listener），TWS 中会显示该 Client ID */
  listener_connected?: boolean
  listener_client_id?: number | null
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

/** Risk/post-mortem summary for 复盘与风控 page (GET /risk_summary) */
export interface RiskSummaryResponse {
  daily_hedge_count?: number | null
  daily_pnl?: number | null
  spot?: number | null
  symbol?: string | null
  operations_count_24h?: number
  block_reasons?: string[]
  ts?: number | null
}

/** Account execution/trade (R-A2). Full IB data. */
export interface Execution {
  id?: number
  account_id?: string
  exec_id?: string
  time?: number
  symbol?: string
  sec_type?: string
  side?: string
  quantity?: number
  price?: number
  commission?: number
  source?: string
  expiry?: string
  strike?: number
  option_right?: string
  exchange?: string
  order_id?: number
  cum_qty?: number
  realized_pnl?: number
  contract_key?: string
  currency?: string
  raw_extra?: Record<string, unknown>
}

/** 期权按 contract_key + strike 分组后的汇总（复盘业务逻辑：兑现/未兑现） */
export interface OptExecutionGroup {
  contract_key: string
  strike: number
  expiry: string
  /** 净持仓：买量 - 卖量；>0=买状态，=0=已兑现，<0=卖状态 */
  net_qty: number
  /** Buy 总手数（该组所有买 quantity 之和） */
  buy_volume: number
  /** Sell 总手数（该组所有卖 quantity 之和） */
  sell_volume: number
  /** 买均价（该组 Buy 的加权平均价，$/股） */
  buy_avg_price: number | null
  /** 卖均价（该组 Sell 的加权平均价，$/股） */
  sell_avg_price: number | null
  /** Buy 成本：sum(Size×@×100−Commission)，来自 account_execution_commissions */
  buy_cost: number
  /** Sell 权利金：sum(Size×@×100−Commission)，来自 account_execution_commissions */
  sell_premium: number
  /** 盈利：sell_premium - buy_cost，用状态区分颜色 */
  realized_pnl: number
  /** 已兑现 | 未兑现（用于字体颜色：已兑现绿，未兑现黄） */
  status: 'realized' | 'unrealized'
  trades: Execution[]
}

export interface ExecutionsResponse {
  executions: Execution[]
  message?: string
}

/** GET /performance: summary + calendar PnL (PERFORMANCE_PAGE_DESIGN). */
export interface PerformanceSummary {
  total_pnl?: number
  total_commission?: number
  net_pnl?: number
  trade_count?: number
  win_count?: number
  loss_count?: number
  win_rate?: number | null
  profit_factor?: number | null
  avg_win?: number | null
  avg_loss?: number | null
  max_win?: number | null
  max_loss?: number | null
  max_drawdown?: number | null
}

export interface PerformanceCalendarEntry {
  period_start_ts: number
  period_label: string
  pnl: number
  commission: number
  net_pnl: number
  trade_count: number
  win_rate?: number | null
}

export interface PerformanceResponse {
  summary: PerformanceSummary
  calendar: PerformanceCalendarEntry[]
  cumulative_curve: { ts: number; cumulative_net_pnl: number }[]
}

/** K-line/OHLC bar (R-A3). Stub until stage 3. */
export interface Bar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface BarsResponse {
  bars: Bar[]
  message?: string
}

/** 标的在 stock_day / stock_min 中的行数统计（GET /bars/stats） */
export interface BarStatsResponse {
  stock_day: number
  stock_min: Record<string, number>
  message?: string
}

/** Single-period coverage: count, min/max ts, optional target range and status (from server). */
export interface BarCoveragePeriod {
  count: number
  min_ts: number | null
  max_ts: number | null
  target_start_ts?: number
  target_end_ts?: number
  /** ok | gap_start | gap_end | gap | missing */
  status?: string
}

/** Per-symbol coverage in stock_day / stock_min (GET /bars/coverage). */
export interface BarCoverageItem {
  symbol: string
  stock_day: BarCoveragePeriod
  stock_min: Record<string, BarCoveragePeriod>
}

/** GET /bars/coverage response. */
export interface BarsCoverageResponse {
  coverage: BarCoverageItem[]
  /** Target range from config (history_backfill.stock). */
  policy?: {
    daily_years: number
    min_weeks: number
    '5min_months': number
    '1hour_months': number
  }
}

/** R-A3 扩展：Watchlist 项（自选/待操作标的）。 */
export interface WatchlistItem {
  id?: number
  contract_key: string
  symbol?: string | null
  sec_type?: string | null
  expiry?: string | null
  strike?: number | null
  option_right?: string | null
  display_label?: string | null
  source?: string | null
  created_at?: number | null
}

/** R-RM*: 实时行情（从 Redis 读取，守护进程写入）。 */
export interface RealtimeQuote {
  symbol: string
  bid?: number | null
  ask?: number | null
  last: number
  ts: number
  /** 可选：相对前价的涨跌，前端可算 */
  change?: number | null
}

export interface QuotesResponse {
  quotes: RealtimeQuote[]
  message?: string
}
