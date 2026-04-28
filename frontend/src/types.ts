/** Host / Secondary IP and TCP ports (Settings → IB Connection, read-only from YAML). */
export interface IbClientNetwork {
  host_ip?: string
  host_port_type?: 'tws_live' | 'tws_paper' | 'gateway'
  host_port?: number | null
  secondary_host_ip?: string | null
  secondary_port_type?: 'tws_live' | 'tws_paper' | 'gateway' | string | null
  secondary_port?: number | null
}

/** IB API client_id slots from YAML (Settings → IB Connection, read-only). JSON key `port`. */
export interface IbClientPort {
  trading?: number
  listener_host?: number
  listener_secondary?: number
  operator_host?: number
  operator_secondary?: number
  ingestor?: number
  account_agent?: number
  /** Second IB / TWS when `ib2_host` is set (YAML `ib2_client_id_account_agent`). */
  account_agent_secondary?: number
  market_data_worker?: number
}

/** Trading / event stream account IDs from DB settings (editable on Settings page). */
export interface IbClientAccount {
  trading?: string | null
  event_host?: string | null
  event_secondary?: string | null
}

/**
 * GET /status `config.ib_client` and POST /config/ib response body (minus `ok`).
 * YAML + DB merge is built server-side; network fields read-only from YAML.
 */
export interface IbClient {
  client?: IbClientNetwork
  port?: IbClientPort
  account?: IbClientAccount
  timeout_sec?: number
}

/** One Flex row: same label/purpose for both; query_host_id (Host IB), query_secondary_id (Second IB, optional). Tokens in settings. */
export interface FlexAccountItem {
  query_host_id: string
  query_secondary_id?: string | null
  query_label?: string | null
  purpose?: string | null
}

/** Flex tokens and query rows (e.g. POST /config/flex response shape). */
export interface FlexConfig {
  host_token?: string | null
  secondary_token?: string | null
  rows?: FlexAccountItem[]
}

/** GET /status `config.ib_flex`: default/init range days + same token/rows as FlexConfig. */
export interface StatusIbFlex extends FlexConfig {
  default_range_days?: number | null
  init_range_days?: number | null
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
  /**
   * Mark / last for display and PnL. STK: live mid/last when quote is fresh (NBBO + updated_at);
   * otherwise `public.stock_day` close (see backend `get_accounts_from_tables` / `get_stock_day_fallback_price`).
   */
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

export type StatusLamp = 'green' | 'yellow' | 'red'

/** GET /status health: server roll-up (daemon + socket/quotes + Celery + monitor lamps). */
export interface StatusHealth {
  self_check?: string
  block_reasons?: string[]
  status_lamp?: StatusLamp
}

export interface StatusLamps {
  /** Mirrors health.status_lamp — system roll-up computed on Monitor. */
  system_lamp?: StatusLamp
}

/** Auto-trading row + suspend flag (former `engine` + `health.trading_suspended`). */
export interface StatusDaemonTrading {
  auto_status?: StatusRow | null
  trading_suspended?: boolean
}

export interface StatusDaemon {
  heartbeat?: DaemonHeartbeat | null
  self_check?: string
  lamp?: StatusLamp
  block_reasons?: string[]
  trading?: StatusDaemonTrading
}

/** One IB Operator TWS slot in Redis health (`GET /status` `socket.ib_operator`). */
export interface SocketIbOperatorSlot {
  connected?: boolean
  client_id?: number | null
  last_error?: string | null
  reconnects?: number
  last_ib_probe_at?: number | null
  ib_probe_interval_sec?: number | null
  ib_probe_ok?: boolean
  next_ib_probe_in_s?: number | null
  ib_probe_stale?: boolean
}

/** GET /status `socket.ib_operator` — Host + optional Secondary operator RPC connections. */
export interface SocketIbOperator {
  /** From Redis `host_alive` / health `service_alive`: false after graceful operator shutdown. */
  service_alive?: boolean
  /** Legacy alias for `service_alive` (same Redis field family). */
  operator_alive?: boolean
  /** Same meaning as `socket.ib_ingestor.connected`: Host (primary) cmd RPC slot. */
  connected?: boolean
  /** Cmd RPC messages processed (like `ib_ingestor.msg_count`). */
  msg_count?: number | null
  last_msg_age_s?: number | null
  /** Host slot IB reconnect counter (like `ib_ingestor.reconnects`). */
  reconnects?: number | null
  host?: SocketIbOperatorSlot
  secondary?: SocketIbOperatorSlot
  account?: SocketIbOperatorSlot
  market?: SocketIbOperatorSlot
  /** Main-thread service heartbeat (cmd RPC process); same semantics as ingestor / account agent. */
  service_heartbeat_interval_sec?: number | null
  last_service_heartbeat_at?: number | null
  next_service_heartbeat_in_s?: number | null
  /** Which IB client slot is attempting reconnect during the current heartbeat tick (from Redis). */
  service_heartbeat_reconnect_in_progress?: string | null
}

export interface StatusMonitor {
  enabled?: boolean
  health?: string
  self_check?: string
  lamp?: StatusLamp
  block_reasons?: string[]
}

export interface StatusPortfolio {
  accounts?: IbAccountSnapshot[] | null
  accounts_fetched_at?: number | null
  open_orders?: OpenOrder[]
}

/** GET /status `config.redis` — quote notify channel (Monitor reads from app config). */
export interface StatusConfigRedis {
  subscribe_channel?: string | null
}

export interface StatusConfig {
  ib_client?: IbClient | null
  ib_flex?: StatusIbFlex | null
  redis?: StatusConfigRedis | null
}

export interface StrategyActiveRef {
  id?: number | null
  name?: string | null
}

export interface StatusStrategyActive {
  structure?: StrategyActiveRef
  gate_safety?: StrategyActiveRef
  allocation?: StrategyActiveRef
}

/** GET /status `strategy`: extend with more keys later; active = current daemon selection. */
export interface StatusStrategy {
  active?: StatusStrategyActive
}

/** Monitor Redis reader for quotes API / SSE (not daemon heartbeat redis_quotes_connected). */
export interface StatusMarketData {
  quotes_redis_reader_ok?: boolean
}

/** GET /status `socket.massive` — Massive WS ingest Redis meta + config hints. */
export interface StatusSocketMassive {
  configured?: boolean
  tier?: string
  pending_jobs?: number
  ws_connected?: boolean
  last_msg_age_s?: number | null
  ws_reconnects?: number
  last_snapshot_age_s?: number | null
}

/** GET /status `socket.ib_ingestor` — IB market ingest Redis health. */
export interface StatusSocketIbIngestor {
  connected?: boolean
  last_msg_age_s?: number | null
  reconnects?: number | null
  msg_count?: number | null
  client_id?: number | null
  /** IB liveness probe (new writers); absent on legacy processes. */
  last_ib_probe_at?: number | null
  ib_probe_interval_sec?: number | null
  ib_probe_ok?: boolean
  next_ib_probe_in_s?: number | null
  ib_probe_stale?: boolean
  /** Main-thread service heartbeat: process alive + one reconnect attempt per tick when needed. */
  service_heartbeat_interval_sec?: number | null
  last_service_heartbeat_at?: number | null
  next_service_heartbeat_in_s?: number | null
  /** Which IB client slot is attempting reconnect during the current heartbeat tick (from Redis). */
  service_heartbeat_reconnect_in_progress?: string | null
}

/** GET /status `socket.ib_account_agent` — Host + optional Secondary (same slot shape as IB Operator). */
export interface StatusSocketIbAccountAgent {
  /** Roll-up: Host IB API connected (Redis `host_connected` / `connected`). */
  connected?: boolean
  /** From Redis `host_alive`; false after graceful stop / Ops clear (same lamp semantics as `socket.ib_operator`). */
  service_alive?: boolean
  /** Alias of `service_alive` for shared ingest lamp helpers. */
  operator_alive?: boolean
  last_msg_age_s?: number | null
  reconnects?: number | null
  msg_count?: number | null
  /** Same as `host.client_id` when present. */
  client_id?: number | null
  host?: SocketIbOperatorSlot | null
  secondary?: SocketIbOperatorSlot | null
  service_heartbeat_interval_sec?: number | null
  last_service_heartbeat_at?: number | null
  next_service_heartbeat_in_s?: number | null
  /** Which IB client slot(s) are attempting reconnect during the current heartbeat tick (from Redis). */
  service_heartbeat_reconnect_in_progress?: string | null
}

/**
 * GET /status `socket` — aligns with Settings sidebar "Socket" (ingest + IB Operator Redis health).
 * Formerly `feeds`; IB Operator health is `ib_operator` (moved from `monitor.ib_status`).
 */
export interface StatusSocket {
  massive?: StatusSocketMassive | null
  ib_ingestor?: StatusSocketIbIngestor | null
  /** IB Account Agent — account-domain events to Redis (GET /status socket.ib_account_agent). */
  ib_account_agent?: StatusSocketIbAccountAgent | null
  ib_operator?: SocketIbOperator | null
}

export interface StatusCelery {
  broker_connected?: boolean
  workers?: string[]
  worker_ib_connected?: boolean
  worker_ib_client_id?: number | null
  worker_last_updated_ts?: number | null
}

export interface StatusLiveUi {
  subscribed_tickers?: string[]
  reference_indices?: { symbol: string; label?: string; polygon_ticker?: string }[]
}

export type SystemMessageLevel = 'info' | 'success' | 'warning' | 'error'
export type SystemMessageTopic = 'ib.connection' | string
export type SystemMessageStatus = 'unknown' | 'connected' | 'reconnecting' | 'disconnected' | string

export interface SystemMessage {
  message_id: string
  topic: SystemMessageTopic
  level: SystemMessageLevel
  service?: string
  slot?: string
  client_id?: number | null
  account?: string | null
  status_from?: SystemMessageStatus
  status_to?: SystemMessageStatus
  title: string
  message: string
  reason?: string | null
  occurred_at: number
}

export interface SystemMessagesResponse {
  messages: SystemMessage[]
}

/** GET /status nested JSON (status_schema_version 8–9). */
export interface StatusResponse {
  status_schema_version?: 8 | 9
  health?: StatusHealth
  lamps?: StatusLamps
  daemon?: StatusDaemon
  monitor?: StatusMonitor
  portfolio?: StatusPortfolio
  config?: StatusConfig
  strategy?: StatusStrategy
  market_data?: StatusMarketData
  socket?: StatusSocket
  celery?: StatusCelery
  live_ui?: StatusLiveUi
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
  /** Daemon Redis quotes reader connected (reads ingestor tick keys; column name unchanged). */
  redis_quotes_connected?: boolean
  /** Mock hedging mode: treat as live for Status lamp (green when running). */
  mock_hedging?: boolean
  /** Last control message (e.g. init_ticker error: clear subscriptions first). Cleared on success. */
  last_control_message?: string | null
}

/** Current status row from daemon_auto_status_current (GET /status `daemon.trading.auto_status`). PK: daemon_auto_status_current_id. */
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

/** POST /executions/fetch (TWS via IB Operator) */
export interface ExecutionsFetchTwsResponse extends ControlResponse {
  count?: number
  days?: number
  fetched_primary?: number
  fetched_secondary?: number
  fetched_total?: number
  tws_raw_inserted?: number
  tws_raw_skipped_duplicate?: number
  tws_raw_missing_table?: boolean
  secondary_error?: string
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

/** Per-instance quantity split for one execution row (account_execution_instance_allocation). */
export interface ExecutionInstanceAllocation {
  strategy_instance_id: number
  allocated_quantity: number
  strategy_opportunity_id?: number | null
  strategy_instance_label?: string | null
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
  /** Flex reference close price when present (e.g. stock-link candidates). */
  close_price?: number | null
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
  /** When set, quantity is split across multiple strategy instances (see DATABASE §2.24.11d). */
  instance_allocations?: ExecutionInstanceAllocation[] | null
}

/** Aggregated link rows + total slippage vs close for one option execution id. */
export interface OptionStockLinkSummary {
  links: OptionStockLinkRow[]
  slippage_total: number | null
}

/** One row from GET /executions/option-stock-links (joined stock leg + slippage vs close). */
export interface OptionStockLinkRow {
  link_id: number
  option_account_executions_id: number
  stock_account_executions_id: number
  role?: string | null
  note?: string | null
  created_at_epoch?: number | null
  stock_symbol?: string | null
  stock_side?: string | null
  stock_quantity?: number | null
  stock_price?: number | null
  stock_close_price?: number | null
  stock_trade_date?: string | null
  stock_exec_id?: string | null
  slippage_vs_close?: number | null
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
  /** Volume-weighted average price (optional; e.g. Massive aggregates `vw`). */
  vwap?: number | null
}

export interface BarsResponse {
  bars: Bar[]
  /** Present when the server has no rows or a soft validation message. */
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
  /** stock_day only: trading calendar YYYY-MM-DD from PostgreSQL `date` (use for display; avoids TZ shift from epoch). */
  min_day?: string | null
  max_day?: string | null
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
