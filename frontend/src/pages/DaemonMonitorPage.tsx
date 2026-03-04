import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten, postRetryIb, postStop, postMonitorStop, postMonitorConnect, fetchHealth } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

const HEDGE_REASON_LABELS: Record<string, string> = {
  trading_suspended: 'Hedge suspended',
  no_status: 'No status data',
  daemon_not_running: 'Daemon not running',
  data_stale: 'Data stale',
  trading_state_pause_cost: 'Trading state: Pause cost',
  trading_state_risk_halt: 'Trading state: Risk halt',
  trading_state_stale: 'Trading state: Stale',
  trading_state_force_hedge: 'Trading state: Force hedge',
  status_read_error: 'Server read error (lock timeout or connection issue; please refresh later)',
}

const DAEMON_REASON_LABELS: Record<string, string> = {
  no_heartbeat: 'No heartbeat data',
  daemon_not_running: 'Daemon not running',
  heartbeat_stale: 'Heartbeat not updating (no DB write for >35s; daemon may be busy or stuck)',
  ib_not_connected: 'IB not connected',
  status_read_error: 'Server read error (lock timeout or connection issue; please refresh later)',
}

const DAEMON_SELF_CHECK_LABELS: Record<string, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  blocked: 'Blocked',
}

const MONITOR_SELF_CHECK_LABELS: Record<string, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  blocked: 'Blocked',
}

const MONITOR_REASON_LABELS: Record<string, string> = {
  monitor_stopped: 'Monitor service stopped',
  monitor_ib_error: 'Monitor IB connection error (account or market)',
}

const DAEMON_STATE_LABELS: Record<string, string> = {
  running: 'Running',
  running_suspended: 'Running (hedge suspended)',
  connecting: 'Connecting',
  waiting_ib: 'Waiting for IB (auto-retry)',
  connected: 'Connected',
  stopping: 'Stopping',
  stopped: 'Stopped',
  idle: 'Idle',
}

const STATUS_FIELDS: [string, string][] = [
  ['daemon_state', 'Daemon state'],
  ['trading_state', 'Trading state'],
  ['symbol', 'Symbol'],
  ['spot', 'Spot price'],
  ['stock_position', 'Stock position'],
  ['daily_hedge_count', 'Daily hedge count'],
  ['ts', 'Updated at'],
]

function setMsg(
  setter: (v: { text: string; isErr: boolean }) => void,
  text: string,
  isErr: boolean
) {
  setter({ text, isErr })
}

const MSG_AUTO_CLEAR_MS = 5000

function scheduleMsgClear(
  setter: (v: { text: string; isErr: boolean }) => void,
  timeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  delayMs: number = MSG_AUTO_CLEAR_MS
) {
  if (timeoutRef.current != null) clearTimeout(timeoutRef.current)
  timeoutRef.current = setTimeout(() => {
    setter({ text: '', isErr: false })
    timeoutRef.current = null
  }, delayMs)
}

export interface DaemonMonitorPageProps {
  status: StatusResponse | null
  operations: Operation[]
  loadStatus: () => Promise<StatusResponse | null>
  /** Navigate to Settings tab (for "edit in Settings" entry) */
  onNavigateToSettings?: () => void
}

export function DaemonMonitorPage({ status, operations, loadStatus, onNavigateToSettings }: DaemonMonitorPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null)
  const [healthTick, setHealthTick] = useState(0)
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const monitorCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const j = status
  const hb = j?.daemon_heartbeat
  const hbForCountdown = hb
  const intervalSec = hbForCountdown?.heartbeat_interval_sec ?? 10
  const nowSec = Date.now() / 1000
  void tick
  void healthTick
  const secondsUntilNextHeartbeat =
    hbForCountdown?.daemon_alive && hbForCountdown?.last_ts != null
      ? Math.max(0, Math.ceil(hbForCountdown.last_ts + intervalSec - nowSec))
      : null
  const suspended = j?.trading_suspended === true
  const ibConnected = hb?.ib_connected === true
  const showRetryIb = hb?.daemon_alive === true && !ibConnected

  useEffect(() => {
    return () => {
      if (ctrlMsgClearRef.current != null) clearTimeout(ctrlMsgClearRef.current)
      if (hedgeCtrlMsgClearRef.current != null) clearTimeout(hedgeCtrlMsgClearRef.current)
      if (monitorCtrlMsgClearRef.current != null) clearTimeout(monitorCtrlMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!hbForCountdown?.daemon_alive) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [hbForCountdown?.daemon_alive])

  useEffect(() => {
    fetchHealth()
      .then(() => setLastHealthAt(Date.now() / 1000))
      .catch(() => setLastHealthAt(null))
  }, [])

  useEffect(() => {
    if (lastHealthAt == null) return
    const id = setInterval(() => {
      const now = Date.now() / 1000
      setHealthTick((n) => n + 1)
      if (now - lastHealthAt >= 60) {
        fetchHealth()
          .then(() => setLastHealthAt(Date.now() / 1000))
          .catch(() => setLastHealthAt(null))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [lastHealthAt])

  let daemonLabel = 'Not running (or single-process mode)'
  let daemonHint = 'Run run_engine.py on the trading machine to see "Running" here'
  let hedgeLabel = (j?.status?.ts != null && nowSec - (j.status.ts as number) < 90) ? 'Running (single-process)' : 'Not running'
  let hedgeHint = (j?.status?.ts != null && nowSec - (j.status.ts as number) < 90)
    ? 'Single-process mode (run_engine.py); status written by hedge logic'
    : ''
  let daemonIbLine = ''

  if (hb?.daemon_alive) {
    daemonLabel = 'Running'
    daemonHint = hb.last_ts != null ? `Last heartbeat: ${fmtTs(hb.last_ts)}` : ''
    hedgeLabel = hb.hedge_running ? 'Running' : 'Suspended (or not started)'
    hedgeHint = hb.hedge_running
      ? 'Single-process: daemon and hedge in same process'
      : 'Click "Resume hedge" on monitor to resume'
    daemonIbLine = `IB: ${ibConnected ? `Connected (Client ID ${hb.ib_client_id ?? '?'})` : 'Not connected'}`
  } else if (hb) {
    daemonLabel = 'Not running'
    if (hb.graceful_shutdown_at != null) {
      daemonHint = `Gracefully stopped at ${fmtTs(hb.graceful_shutdown_at)} (SIGTERM/Stop)`
    } else {
      daemonHint =
        hb.last_ts != null
          ? `Last heartbeat: ${fmtTs(hb.last_ts)} (timed out; may have been kill -9 or crash)`
          : ''
    }
    hedgeLabel = 'Not running'
    hedgeHint = 'In dual-process mode, hedge does not run when daemon is down'
  }

  const daemonLamp = (j?.daemon_lamp as 'green' | 'yellow' | 'red') || 'none'
  const hedgeLamp = (j?.status_lamp as 'green' | 'yellow' | 'red') || 'none'
  const monitorEnabled = j?.monitor_enabled !== false
  const monitorStatus = (j?.monitor_ib_status as any) || {}
  const monitorAccount = monitorStatus.account as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorMarket = monitorStatus.market as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorHasError = Boolean(monitorAccount?.last_error || monitorMarket?.last_error)
  const monitorLamp =
    !monitorEnabled
      ? 'red'
      : monitorHasError
        ? 'yellow'
        : monitorAccount && !monitorAccount.connected
          ? 'yellow'
          : (monitorAccount?.connected || monitorMarket?.connected)
            ? 'green'
            : 'yellow'
  const suspendedInReasons = j?.block_reasons?.includes('trading_suspended') ?? false
  const daemonSelfCheckText =
    DAEMON_SELF_CHECK_LABELS[j?.daemon_self_check ?? ''] ?? j?.daemon_self_check ?? '--'
  const hedgeSelfCheckText =
    (j?.self_check ?? '--') + (suspendedInReasons ? ' (hedge suspended)' : '')
  const daemonBlockReasons = (j?.daemon_block_reasons ?? [])
    .map((r) => DAEMON_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'
  const hedgeBlockReasons = (j?.block_reasons ?? [])
    .map((r) => HEDGE_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'

  const monitorSelfCheckText =
    MONITOR_SELF_CHECK_LABELS[j?.monitor_self_check ?? ''] ?? j?.monitor_self_check ?? '--'
  const monitorBlockReasons = (j?.monitor_block_reasons ?? [])
    .map((r) => MONITOR_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'

  const monitorIbGroupLamp =
    !monitorEnabled ? 'none' : (monitorAccount?.connected && monitorMarket?.connected) ? 'green' : (monitorAccount?.connected || monitorMarket?.connected) ? 'yellow' : 'red'

  const healthElapsedSec = lastHealthAt != null ? Math.floor(Date.now() / 1000 - lastHealthAt) : null
  const healthCountdownSec =
    lastHealthAt != null ? Math.max(0, 60 - (healthElapsedSec! % 60)) : null
  const apiHealthLamp = lastHealthAt != null ? 'green' : 'red'

  const runStatusLabel = suspended ? 'Suspended (no new hedges)' : 'Running'
  const heartbeatGroupLamp = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const ibGroupLamp = !hb?.daemon_alive ? 'none' : ibConnected ? 'green' : 'red'
  const strategyGroupLamp = suspended ? 'red' : 'green'

  const s = j?.status ?? {}
  const statusSummaryItems = STATUS_FIELDS.map(([k, label]) => {
    let v: string | number | undefined = (s as Record<string, unknown>)[k] as string | number | undefined
    let out: string | number
    if (v != null)
      out =
        k === 'ts'
          ? fmtTs(v as number)
          : k === 'daemon_state'
            ? DAEMON_STATE_LABELS[String(v)] ?? v
            : String(v)
    else out = '--'
    return { label, value: out }
  })

  const onSuspend = async () => {
    setMsg(setCtrlMsg, 'Setting suspend…', false)
    const res = await postSuspend()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Suspend set; daemon will pause new hedges on next heartbeat.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onResume = async () => {
    setMsg(setCtrlMsg, 'Setting resume…', false)
    const res = await postResume()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Resume set; daemon will resume hedging on next heartbeat.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onRetryIb = async () => {
    setMsg(setCtrlMsg, 'Requesting IB reconnect…', false)
    const res = await postRetryIb()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Retry sent; daemon will try to connect to IB immediately.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onFlatten = async () => {
    setMsg(setHedgeCtrlMsg, 'Requesting flatten…', false)
    const res = await postFlatten()
    setMsg(
      setHedgeCtrlMsg,
      res.ok ? 'Flatten sent; hedge process will consume and execute.' : (res.error ?? ''),
      !res.ok
    )
    scheduleMsgClear(setHedgeCtrlMsg, hedgeCtrlMsgClearRef)
  }

  const onStop = async () => {
    setMsg(setCtrlMsg, 'Requesting daemon stop…', false)
    const res = await postStop()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Stop sent; daemon will exit and clear ib_client_id; next start uses client_id=1.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onMonitorStop = async () => {
    setMsg(setMonitorCtrlMsg, 'Stopping monitor service…', false)
    const res = await postMonitorStop()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? 'Monitor service stopped (no new IB requests).' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  const onMonitorConnect = async () => {
    setMsg(setMonitorCtrlMsg, 'Establishing monitor IB connection…', false)
    const res = await postMonitorConnect()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? 'Monitor IB connect requested (account + market); check status bar for result.' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  return (
    <>
      <div className="card process-section">
        <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${daemonLamp}`} title="Daemon status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Daemon</h2>
              <div>
                <strong>Status: {j ? `${daemonLabel} (${daemonSelfCheckText})` : 'Fetch failed'}</strong>
                {j && daemonBlockReasons && daemonBlockReasons !== 'None' ? ` Block reasons: ${daemonBlockReasons}` : ''}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn-stop"
            title="Send stop to daemon; daemon exits and clears ib_client_id in DB; next start uses client_id=1"
            onClick={onStop}
          >
            Stop
          </button>
        </div>

        <div className="daemon-groups">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${heartbeatGroupLamp}`} title="Heartbeat status" />
              <span className="daemon-group-title">
                {onNavigateToSettings ? (
                  <button type="button" className="link-button" onClick={onNavigateToSettings} style={{ fontSize: 'inherit', fontWeight: 'inherit' }}>
                    Heartbeat
                  </button>
                ) : (
                  'Heartbeat'
                )}
              </span>
            </div>
            <div className="daemon-group-body">
              {hb?.daemon_alive && hb.last_ts != null ? (
                <p className="section-hint">Last heartbeat: <strong>{fmtTs(hb.last_ts)}</strong></p>
              ) : hb?.graceful_shutdown_at != null ? (
                <p className="section-hint">Gracefully stopped at <strong>{fmtTs(hb.graceful_shutdown_at)}</strong> (SIGTERM/Stop)</p>
              ) : hb?.last_ts != null ? (
                <p className="section-hint">Last heartbeat: <strong>{fmtTs(hb.last_ts)}</strong> (timed out; may have been kill -9 or crash)</p>
              ) : (
                <p className="section-hint">{daemonHint || '—'}</p>
              )}
              {hb?.daemon_alive && secondsUntilNextHeartbeat != null && (
                <p className="section-hint countdown-line">
                  Next heartbeat: <span className="countdown-num">{secondsUntilNextHeartbeat}</span> s
                </p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${ibGroupLamp}`} title="IB connection status" />
              <span className="daemon-group-title">
                {onNavigateToSettings ? (
                  <button type="button" className="link-button" onClick={onNavigateToSettings} style={{ fontSize: 'inherit', fontWeight: 'inherit' }}>
                    IB connection
                  </button>
                ) : (
                  'IB connection'
                )}
              </span>
            </div>
            <div className="daemon-group-body">
              {ibConnected ? (
                <p className="section-hint countdown-line">
                  IB: <span className="countdown-num">Connected</span> (Client ID {hb?.ib_client_id ?? '?'})
                </p>
              ) : (
                <p className="section-hint">{daemonIbLine || '—'}</p>
              )}
              {hb?.daemon_alive && !ibConnected && (
                <p className="section-hint">Will retry connection on next heartbeat.</p>
              )}
              {showRetryIb && (
                <div className="controls">
                  <button
                    type="button"
                    className="btn-retry-ib"
                    title="Notify daemon to try connecting to IB immediately"
                    onClick={onRetryIb}
                  >
                    Retry IB connection
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.redis_quotes_connected ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Daemon Redis status" />
              <span className="daemon-group-title">Database</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Redis: {!hb?.daemon_alive ? '—' : hb.redis_quotes_connected ? 'Connected (writes quotes and publishes)' : 'Not connected or not configured'}
              </p>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${strategyGroupLamp}`} title="Trading strategy status" />
              <span className="daemon-group-title">Trading strategy</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Current: <span>{runStatusLabel}</span>
                (set by monitor; daemon syncs via PostgreSQL)
              </p>
              <div className="controls">
                <button
                  type="button"
                  className="btn-suspend"
                  disabled={suspended}
                  title={suspended ? 'Already suspended' : 'Set from monitor; daemon pauses new hedges on next heartbeat'}
                  onClick={onSuspend}
                >
                  Suspend hedge
                </button>
                <button
                  type="button"
                  className="btn-resume"
                  disabled={!suspended}
                  title={!suspended ? 'Already running' : 'Set from monitor; daemon resumes hedging on next heartbeat'}
                  onClick={onResume}
                >
                  Resume hedge
                </button>
              </div>
            </div>
          </div>
        </div>

        {ctrlMsg.text ? (
          <div className={`msg ${ctrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {ctrlMsg.text}
          </div>
        ) : null}
      </div>

      <div className="card process-section">
        <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${monitorLamp}`} title="Monitor status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Monitor</h2>
              <div>
                <strong>Status: {j ? `${monitorEnabled ? 'Running' : 'Stopped'} (${monitorSelfCheckText})` : 'Fetch failed'}</strong>
                {j && monitorBlockReasons && monitorBlockReasons !== 'None' ? ` Block reasons: ${monitorBlockReasons}` : ''}
              </div>
            </div>
          </div>
          <div className="monitor-header-actions">
            <button
              type="button"
              className="btn-stop"
              disabled={!monitorEnabled}
              title={monitorEnabled ? 'Stop monitor IB interaction and disconnect' : 'Already stopped'}
              onClick={onMonitorStop}
            >
              Stop
            </button>
          </div>
        </div>

        <div className="daemon-groups">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${apiHealthLamp}`} title="API service (green if /health reachable, else red)" />
              <span className="daemon-group-title">API service</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                <strong>Status: {j ? `${monitorEnabled ? 'Running' : 'Stopped'} (${monitorSelfCheckText})` : 'Fetch failed'}</strong>
                {j && monitorBlockReasons && monitorBlockReasons !== 'None' ? ` Block reasons: ${monitorBlockReasons}` : ''}
              </p>
              {healthCountdownSec != null ? (
                <p className="section-hint countdown-line">
                  Next health check: <span className="countdown-num">{healthCountdownSec}</span> s
                </p>
              ) : (
                <p className="section-hint">Health check: —</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${monitorIbGroupLamp}`} title="Monitor IB connection status" />
              <span className="daemon-group-title">IB connection</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint countdown-line">
                Account IB (AccountIbClient):
                {monitorAccount?.connected ? (
                  <>
                    <span className="countdown-num">Connected</span>
                    {' '}(
                    Client ID <span className="countdown-num">{monitorAccount?.client_id ?? '—'}</span>
                    )
                  </>
                ) : (
                  'Not connected'
                )}
              </p>
              <p className="section-hint countdown-line">
                Market IB (MarketIbClient):
                {monitorMarket?.connected ? (
                  <>
                    <span className="countdown-num">Connected</span>
                    {' '}(
                    Client ID <span className="countdown-num">{monitorMarket?.client_id ?? '—'}</span>
                    )
                  </>
                ) : (
                  'Not connected'
                )}
              </p>
              {monitorAccount?.last_error && (
                <p className="section-hint">Account client error: {monitorAccount.last_error}</p>
              )}
              {monitorMarket?.last_error && (
                <p className="section-hint">Market client error: {monitorMarket.last_error}</p>
              )}
              <div className="controls" style={{ marginTop: '0.25rem' }}>
                <button
                  type="button"
                  className="btn-resume"
                  disabled={!monitorEnabled}
                  title={monitorEnabled ? 'Establish monitor IB connection (AccountIbClient + MarketIbClient)' : 'Monitor stopped; cannot connect'}
                  onClick={onMonitorConnect}
                >
                  Connect IB account
                </button>
              </div>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${j?.redis_quotes_connected ? 'green' : monitorEnabled ? 'red' : 'none'}`} title="Monitor Redis status" />
              <span className="daemon-group-title">Database</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Redis: {!monitorEnabled ? '—' : j?.redis_quotes_connected ? 'Connected (GET /quotes available)' : 'Not connected or not configured'}
              </p>
            </div>
          </div>
        </div>
        {monitorCtrlMsg.text ? (
          <div className={`msg ${monitorCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {monitorCtrlMsg.text}
          </div>
        ) : null}
      </div>

      <div className="card process-section">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${hedgeLamp}`} title="Trading strategy status lamp" />
          </div>
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              Trading Strategy
              <InfoTooltip text="Depends on daemon; business logic; may support multiple strategies later." />
            </h2>
            <div>
              <strong>Status: {j ? `${hedgeLabel} (${hedgeSelfCheckText})` : 'Fetch failed'}</strong>
              {j && hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` Block reasons: ${hedgeBlockReasons}` : ''}
            </div>
          </div>
        </div>
        <p className="section-hint">{hedgeHint}</p>
        <div className="statusSummary" style={{ marginTop: '0.5rem' }}>
          {statusSummaryItems.map(({ label, value }) => (
            <div key={label}>
              <span>{label}</span>{' '}
              <span className="status-summary-value">{value}</span>
            </div>
          ))}
        </div>
        <div className="controls" style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            className="btn-flatten"
            title="Hedge process consumes and executes; flattens strategy hedge exposure"
            onClick={onFlatten}
          >
            Flatten exposure
          </button>
        </div>
        {hedgeCtrlMsg.text ? (
          <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'}`}>
            {hedgeCtrlMsg.text}
          </div>
        ) : null}
      </div>

      <div className="card card-operations">
        <h2>Recent operations</h2>
        <table className="table-operations">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {operations.length === 0 ? (
              <tr>
                <td colSpan={6}>None</td>
              </tr>
            ) : (
              operations.map((op, i) => (
                <tr key={`${op.ts}-${i}`}>
                  <td>{fmtTs(op.ts)}</td>
                  <td>{op.type ?? ''}</td>
                  <td>{op.side ?? ''}</td>
                  <td>{op.quantity ?? ''}</td>
                  <td>{fmtUsd(op.price)}</td>
                  <td>{op.state_reason ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
