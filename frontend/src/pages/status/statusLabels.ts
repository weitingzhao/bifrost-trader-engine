/** Legacy: health roll-up reasons (GET /status health.block_reasons). Prefer HEALTH_REASON_LABELS. */
export const HEDGE_REASON_LABELS: Record<string, string> = {
  trading_suspended: 'Hedge suspended',
  no_status: 'No status data',
  daemon_not_running: 'Daemon not running',
  data_stale: 'Data stale',
  trading_state_pause_cost: 'Trading state: Pause cost',
  trading_state_risk_halt: 'Trading state: Risk halt',
  trading_state_stale: 'Trading state: Stale',
  trading_state_force_hedge: 'Trading state: Force hedge',
  status_read_error: 'Server read error (lock timeout or connection issue; please refresh later)',
  socket_massive_disconnected: 'Massive WebSocket disconnected (configured but not connected)',
  socket_ib_ingestor_disconnected: 'IB ingestor not connected (Redis meta)',
  market_quotes_redis_unavailable: 'Quotes Redis reader unavailable (Monitor)',
  celery_broker_down: 'Celery broker not connected',
  celery_no_workers: 'No Celery workers responding',
}

/** GET /status health.block_reasons — roll-up across daemon, socket, Celery, monitor. */
export const HEALTH_REASON_LABELS: Record<string, string> = {
  ...HEDGE_REASON_LABELS,
  monitor_stopped: 'Monitor service stopped',
  monitor_ib_error: 'Monitor IB connection error (operator or secondary account)',
}

/** GET /status daemon.block_reasons — heartbeat + auto-trading row (FSM, lag, trading_state). */
export const DAEMON_REASON_LABELS: Record<string, string> = {
  no_heartbeat: 'No heartbeat data',
  daemon_not_running: 'Daemon not running',
  heartbeat_stale: 'Heartbeat not updating (no DB write for >35s; daemon may be busy or stuck)',
  ib_not_connected: 'IB not connected',
  status_read_error: 'Server read error (lock timeout or connection issue; please refresh later)',
  trading_suspended: 'Hedge suspended',
  no_status: 'No status data',
  data_stale: 'Data stale',
  trading_state_pause_cost: 'Trading state: Pause cost',
  trading_state_risk_halt: 'Trading state: Risk halt',
  trading_state_stale: 'Trading state: Stale',
  trading_state_force_hedge: 'Trading state: Force hedge',
}

/** Short tokens for Trading Strategy compact row (space-saving). */
export const DAEMON_BLOCK_REASONS_COMPACT: Record<string, string> = {
  no_heartbeat: 'no HB',
  daemon_not_running: 'no daemon',
  heartbeat_stale: 'HB stale',
  ib_not_connected: 'no IB',
  status_read_error: 'read err',
  trading_suspended: 'suspended',
  no_status: 'no status',
  data_stale: 'stale',
  trading_state_pause_cost: 'pause $',
  trading_state_risk_halt: 'risk halt',
  trading_state_stale: 'stale T',
  trading_state_force_hedge: 'force H',
}

/** Compact status line for embedded Trading Strategy (Daemon card). */
export function formatDaemonBlockReasonsCompact(blockKeys: string[] | undefined | null): string {
  if (!blockKeys?.length) return ''
  return blockKeys
    .map(k => DAEMON_BLOCK_REASONS_COMPACT[k] ?? k.replace(/_/g, ' '))
    .slice(0, 4)
    .join(' · ')
}

/** Short labels for strategy metrics row (compact panel only). */
export const STRATEGY_METRIC_LABEL_COMPACT: Record<string, string> = {
  'Daemon state': 'D.state',
  'Trading state': 'State',
  Symbol: 'Sym',
  'Spot price': 'Spot',
  'Stock position': 'Pos',
  'Daily hedge count': 'Hedges',
  'Updated at': 'At',
}

export const DAEMON_SELF_CHECK_LABELS: Record<string, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  blocked: 'Blocked',
}

export const MONITOR_SELF_CHECK_LABELS: Record<string, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  blocked: 'Blocked',
}

export const MONITOR_REASON_LABELS: Record<string, string> = {
  monitor_stopped: 'Monitor service stopped',
  monitor_ib_error: 'Monitor IB connection error (operator or secondary account)',
}

export const DAEMON_STATE_LABELS: Record<string, string> = {
  running: 'Running',
  running_suspended: 'Running (hedge suspended)',
  connecting: 'Connecting',
  waiting_ib: 'Waiting (legacy state)',
  connected: 'Connected',
  stopping: 'Stopping',
  stopped: 'Stopped',
  idle: 'Idle',
}

export const STATUS_FIELDS: [string, string][] = [
  ['daemon_state', 'Daemon state'],
  ['trading_state', 'Trading state'],
  ['symbol', 'Symbol'],
  ['spot', 'Spot price'],
  ['stock_position', 'Stock position'],
  ['daily_hedge_count', 'Daily hedge count'],
  ['ts', 'Updated at'],
]
