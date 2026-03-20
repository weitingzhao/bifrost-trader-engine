/** IB connection config. Client IDs come from server config.yaml (read-only in UI). Non-ID fields (host, account IDs, flex) from DB. See ARCHITECTURE.md §2.1. */
export interface IbConfig {
  ib_host?: string
  ib_port_type?: 'tws_live' | 'tws_paper' | 'gateway'
  /** Daemon: Trading (default 1) */
  ib_client_id_daemon?: number
  /** Daemon: Listener (default 2) */
  ib_client_id_listener?: number
  /** Monitor: Account (default 4) */
  ib_client_id_account?: number
  /** Monitor: Market data (default 10); Host only */
  ib_client_id_markets?: number
  /** Celery: Market Data / worker_market (default 500) */
  ib_client_id_worker_market?: number
  /** Host 账户 account_id（多账户时用于对冲与行情），R-A4 */
  ib_host_account_id?: string | null
  /** Live 页 Market Streams Host 账户 ID（Event Account），用于按账户分类/筛选 */
  stream_host_account_id?: string | null
  /** Live 页 Market Streams Secondary 账户 ID */
  stream_secondary_account_id?: string | null
  /** 第二 IB 主机（不同 TWS 机器，手动交易账户），空则未配置 */
  ib2_host?: string | null
  /** Default Flex Query range in days (e.g. 30). Stored in settings.flex_default_range_days. */
  flex_default_range_days?: number | null
  /** Init Flex Query range in days (e.g. 360) for initial/full pull. Stored in settings.flex_init_range_days. */
  flex_init_range_days?: number | null
  ib2_port_type?: string | null
  /** Second IB: Listener (default 3) */
  ib2_client_id_listener?: number
  /** Second IB: Account (default 102); no market data column */
  ib2_client_id_account?: number
}

/** One Flex row: same label/purpose for both; query_host_id (Host IB), query_secondary_id (Second IB, optional). Tokens in settings. */
export interface FlexAccountItem {
  query_host_id: string
  query_secondary_id?: string | null
  query_label?: string | null
  purpose?: string | null
}

/** GET /status flex_config: tokens in settings, rows from settings_ib_flex. */
export interface FlexConfig {
  host_token?: string | null
  secondary_token?: string | null
  rows?: FlexAccountItem[]
}

/** Strategy link derived from account_executions (one position may belong to multiple strategies). */
export interface StrategyLink {
  strategy_opportunity_id?: number
  strategy_instance_id?: number
  strategy_opportunity_name?: string
  strategy_instance_label?: string
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
  /** 当前价（来自 contract_quote_live.mid/last），用于逐行计算盈亏 */
  price?: number | null
  /** 当前持仓浮动盈亏（后端用 contract_quote_live.last 与 position/avg_cost 计算） */
  unrealized_pnl?: number | null
  /** contract_quote_live.updated_at 的 Unix 秒，用于 Last Update 显示 */
  price_updated_at?: number | null
  /** 当 price 来自 stock_day fallback 时，前一根日线 close，用于 Daily % / Daily $ 计算 */
  daily_prev_close?: number | null
  /** 合约唯一键 symbol|sec_type|expiry|strike|right（若后端返回） */
  contract_key?: string | null
  /** 持仓行最后更新时间（account_positions.updated_at，Unix 秒），供 Details TIME 列显示 */
  updated_at?: number | null
  /** 该持仓对应的 account_executions 最新一条的 exec_time（LEFT JOIN 按 account_id+contract_key，Unix 秒），供 Details TIME 列：无 trade_date 时使用 */
  exec_time?: number | null
  /** 该持仓对应的 account_executions 最新一条的 trade_date（YYYY-MM-DD），Details TIME 列优先使用 */
  trade_date?: string | null
  /** 持仓分类（STK）：position_categories 的 id，用于按分类跟踪回报 */
  category_id?: number | null
  /** 持仓分类名称（STK），如 Dividend、Short-term */
  category?: string | null
  /** Strategy links derived from account_executions (one position may map to multiple strategies). */
  strategy_links?: StrategyLink[]
  /** Whether this symbol has tradeable options (from watchlist.optionable). */
  optionable?: boolean | null
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
  /** Flex config: tokens in settings (ib_flex_host_token, ib_flex_secondary_token), rows in settings_ib_flex. Configure in Settings → IB Connection → Flex. */
  flex_config?: FlexConfig | null
  /** 监控端 IB 状态：Account (Host), Account (Secondary), Market (Host) 连接情况与错误信息 */
  monitor_ib_status?: {
    account?: { connected?: boolean; client_id?: number | null; last_error?: string | null }
    account2?: { connected?: boolean; client_id?: number | null; last_error?: string | null }
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
  /** job_bars_backfill 最近一次 updated_at（Unix 秒），用于判断 Worker 是否有近期活动 */
  celery_worker_last_updated_ts?: number | null
  /** 当前响应的 Celery Worker 名称列表（inspect ping），用于 Celery 下列出已运行 Worker */
  celery_workers?: string[]
  /** 当前守护进程订阅的 Real-time ticker 标的（Watchlist STK + strategy symbol），与 Event Subscribe 一致 */
  subscribed_tickers?: string[]
  /** US market indices for watchlist comparison (e.g. S&P 500, Dow, Nasdaq). Used for benchmark row and /bars/benchmark. */
  reference_indices?: { symbol: string; label?: string }[]
  /** R-A5: current open/unfilled orders from daemon (symbol, action, status, filled, remaining, limit_price). */
  open_orders?: OpenOrder[]
  /** Phase A: current active strategy structure id (settings); daemon uses on next start. */
  active_strategy_structure_id?: number | null
  /** Phase A: current active gate safety set id (settings); daemon uses on next start. */
  active_gate_safety_strategy_id?: number | null
  /** Current active strategy allocation id (settings); for monitoring/execution scope. */
  active_strategy_allocation_id?: number | null
  /** Phase A: name of active structure for display. */
  active_strategy_structure_name?: string | null
  /** Phase A: name of active gate safety set for display. */
  active_gate_safety_strategy_name?: string | null
  /** Name of active strategy allocation for display. */
  active_strategy_allocation_name?: string | null
}

/** R-A5: one row from daemon_open_orders (GET /status or GET /open-orders). */
export interface OpenOrder {
  order_id?: number | null
  perm_id?: number | null
  account_id?: string | null
  symbol?: string | null
  sec_type?: string | null
  action?: string | null
  total_quantity?: number | null
  filled?: number | null
  remaining?: number | null
  limit_price?: number | null
  status?: string | null
  contract_key?: string | null
  updated_ts?: number | null
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
  /** Daemon second IB connection (YAML client_id.listener); shown as this Client ID in TWS */
  listener_connected?: boolean
  listener_client_id?: number | null
  /** Listener on Secondary TWS (YAML ib.secondary → ib2_host / ib2_client_id_listener) */
  listener_2_connected?: boolean
  listener_2_client_id?: number | null
  /** Secondary IB event subscribe: positions, fills, commission (no ticker). */
  event_subscribe_positions_ib2?: boolean
  event_subscribe_fills_ib2?: boolean
  event_subscribe_commission_ib2?: boolean
  /** Mock hedging mode: treat as live for Status lamp (green when running). */
  mock_hedging?: boolean
  /** Last control message (e.g. init_ticker error: clear subscriptions first). Cleared on success. */
  last_control_message?: string | null
}

/** Current status row from daemon_auto_status_current (GET /status). PK: daemon_auto_status_current_id. */
export interface StatusRow {
  daemon_auto_status_current_id?: number
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

/** Response from GET /operations (rows from daemon_auto_operations). */
export interface OperationsResponse {
  operations: Operation[]
}

/** Single row from daemon_auto_operations. PK: daemon_auto_operations_id. */
export interface Operation {
  daemon_auto_operations_id?: number
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
  statusText?: string
}

/** Risk/post-mortem summary for replay & risk page (GET /risk_summary) */
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
  account_executions_id?: number
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
  /** Set when GET /executions?include_opt_pairs=true: ids of the other leg(s) in C↔P pairs. */
  paired_execution_ids?: number[]
  /** Trade date (Flex tradeDate / execution date), YYYY-MM-DD. */
  trade_date?: string | null
  /** Report date (Flex), YYYY-MM-DD. */
  report_date?: string | null
  /** Settle date target, YYYY-MM-DD. */
  settle_date_target?: string | null
  /** Transaction type (e.g. from Flex). */
  transaction_type?: string | null
  /** Taxes amount. */
  taxes?: number | null
  /** Net cash. */
  net_cash?: number | null
  /** Row created_at (Unix seconds); use for Time column when exec_time is updated over time. */
  created_at?: number | null
  /** Strategy opportunity ID (trade attribution, SI.2). */
  strategy_opportunity_id?: number | null
  /** Strategy instance ID (trade attribution, SI.2). */
  strategy_instance_id?: number | null
  /** Strategy opportunity name (from backend JOIN). */
  strategy_opportunity_name?: string | null
  /** Strategy instance label (from backend JOIN). */
  strategy_instance_label?: string | null
  /** Strategy instance opened_at (Unix seconds, from backend JOIN). */
  strategy_instance_opened_at_epoch?: number | null
}

/** One row from GET /executions/position-attribution: one (position, instance); open_qty_est = sum of signed exec qty for that instance (final-only or TWS-only per position, see reader). */
export interface PositionInstanceAttribution {
  account_id: string
  contract_key: string
  symbol: string
  sec_type: string
  expiry: string
  strike: number | null
  option_right: string
  position_qty: number
  avg_cost: number | null
  price_mid: number | null
  price_last: number | null
  strategy_instance_id: number | null
  strategy_instance_label: string | null
  strategy_opportunity_id: number | null
  strategy_opportunity_name: string | null
  strategy_instance_opened_at_epoch: number | null
  structure_type: string | null
  scope_type: string | null
  strategy_structure_id: number | null
  open_qty_est: number
  attribution_ratio: number
  unrealized_pnl_est: number | null
  source_exec_count: number
  is_mixed: boolean
  has_unassigned: boolean
  method: string
}

export interface PositionAttributionResponse {
  attributions: PositionInstanceAttribution[]
}

/** Per-underlying option summary by contract_key + strike (realized vs open P&L logic) */
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

/** One row of execution freshness per (account_id, source) from account_executions. */
export interface ExecutionFreshnessItem {
  account_id: string
  source: string | null
  /** Latest exec_time for this (account_id, source), Unix seconds (NULL if unknown). */
  latest_exec_ts: number | null
  /** Days difference between now() and latest_exec_ts (float, may be fractional). */
  days_since_latest: number | null
}

/** GET /executions/freshness response. */
export interface ExecutionsFreshnessResponse {
  items: ExecutionFreshnessItem[]
}

/** Response when GET /executions?include_opt_pairs=true: executions with paired_execution_ids and opt_pairs list from backend. */
export interface ExecutionsResponseWithPairs extends ExecutionsResponse {
  opt_pairs: BackendOptPair[]
}

/** Response from POST /executions/fetch-flex-upload. */
export interface ExecutionsFlexUploadResponse {
  ok: boolean
  error?: string
  count?: number
  updated_accounts?: number
  message?: string
}

/** One C↔P pair from backend (include_opt_pairs). */
export interface BackendOptPair {
  leg_c_execution_id: number
  leg_p_execution_id: number
  symbol: string
  expiry: string
  strike: string
  account_id: string
  quantity: number
  c_side: string
  c_price: number
  p_side: string
  p_price: number
  commission: number
  net_pnl: number
}

/** Strategy instance (one open per opportunity/account). SI.2. */
export interface StrategyInstance {
  strategy_instance_id: number
  strategy_opportunity_id: number
  account_id: string
  opened_at: string
  opened_at_epoch?: number
  label?: string | null
  notes?: string | null
  created_at?: string
  created_at_epoch?: number
  updated_at?: string
  strategy_opportunity_name?: string | null
  /** Number of executions attributed to this instance (from list API). */
  executions_count?: number
  /** Strategy structure used by the opportunity (from detail/list API). */
  strategy_structure_id?: number | null
  strategy_structure_name?: string | null
}

/** One row from account_transactions (Flex cash transactions). GET /transactions, GET /performance.transactions */
export interface AccountTransaction {
  account_transactions_id?: number
  account_id: string
  ts: number
  amount: number
  type: string
  currency?: string | null
  description?: string | null
  created_at?: number
}

/** GET /performance: summary + calendar PnL (PERFORMANCE_PAGE_DESIGN). */
export interface PerformanceSummary {
  total_pnl?: number
  total_realized_pnl?: number
  total_unrealized_pnl?: number
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
  return_pct?: number | null
}

export interface PerformanceCalendarEntry {
  period_start_ts: number
  period_label: string
  pnl: number
  commission: number
  net_pnl: number
  trade_count: number
  win_rate?: number | null
  return_pct?: number | null
}

/** One paired C↔P (same symbol, expiry, strike, account_id; option_right opposite) contributing to Option Realized for a day. */
export interface OptRealizedPair {
  symbol: string
  expiry: string
  strike: string
  account_id?: string
  right_c: string
  right_p: string
  quantity: number
  c_side: string
  c_price: number
  p_side: string
  p_price: number
  commission: number
  net_pnl: number
}

/** Per-period per sec_type (OPT/STK) for calendar-by-type view. OPT entries may include pairs (same-day BUY+SELL). */
export interface PerformanceCalendarEntryBySecType extends PerformanceCalendarEntry {
  sec_type: string
  pairs?: OptRealizedPair[]
}

export interface PerformanceResponse {
  transaction?: { net_cash_flow?: number; start_equity?: number | null; capital_base?: number | null }
  transactions?: AccountTransaction[]
  summary: PerformanceSummary
  calendar: PerformanceCalendarEntry[]
  calendar_by_sec_type?: PerformanceCalendarEntryBySecType[]
  cumulative_curve?: { ts: number; cumulative_net_pnl: number }[]
  realized_by_account?: { account_id: string; total_pnl: number; commission: number; net_pnl: number; trade_count: number; return_pct?: number }[]
  realized_by_sec_type?: { sec_type: string; total_pnl: number; commission: number; net_pnl: number; trade_count: number; return_pct?: number }[]
  realized_by_strategy_opportunity?: { strategy_opportunity_id: number; total_pnl: number; commission: number; net_pnl: number; trade_count: number; return_pct?: number }[]
  realized_by_strategy_instance?: { strategy_instance_id: number; total_pnl: number; commission: number; net_pnl: number; trade_count: number; return_pct?: number }[]
  unrealized?: { total_pnl: number; return_pct?: number | null; current_equity?: number | null }
  unrealized_by_account?: { account_id: string; total_pnl: number }[]
  unrealized_by_sec_type?: { sec_type: string; total_pnl: number }[]
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

/** R-A3 扩展：Watchlist 项（自选/待操作标的）。主键为 contract_key。 */
export interface WatchlistItem {
  contract_key: string
  symbol?: string | null
  sec_type?: string | null
  expiry?: string | null
  strike?: number | null
  option_right?: string | null
  display_label?: string | null
  source?: string | null
  /** Position category (same as Accounts); id from position_categories */
  category_id?: number | null
  /** Category name (e.g. Dividend, Short-term) */
  category?: string | null
  /** Show in Option Discovery (has tradeable options); maintained via Option? toggle on Watchlist page */
  optionable?: boolean | null
  created_at?: number | null
}

/** R-RM*: 实时行情（STK 从 Redis，OPT 从 contract_quote_live）。OPT 项带 contract_key。 */
export interface RealtimeQuote {
  symbol: string
  bid?: number | null
  ask?: number | null
  last?: number | null
  ts: number
  /** 可选：相对前价的涨跌，前端可算 */
  change?: number | null
  /** OPT 报价：合约键，用于 Watchlist OPT 行匹配 */
  contract_key?: string | null
  sec_type?: string | null
  expiry?: string | null
  strike?: number | null
  option_right?: string | null
  mid?: number | null
}

export interface QuotesResponse {
  quotes: RealtimeQuote[]
  message?: string
}

/** Position category for STK tagging (e.g. Dividend, Short-term). */
export interface PositionCategory {
  id: number
  name: string
  description?: string | null
  sort_order?: number | null
  created_at?: number | null
  updated_at?: number | null
}

export interface PositionCategoriesResponse {
  items: PositionCategory[]
}
