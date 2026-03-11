import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten, postReleaseIb, postStop, postMonitorStop, postMonitorReleaseIb, postCeleryStop, postMonitorConnect, fetchHealth, postRefreshTickerSubscriptions, fetchCeleryLogs, subscribeCeleryLogs, clearCeleryLogs, fetchDaemonLogs, subscribeDaemonLogs, clearDaemonLogs, fetchServerLogs, subscribeServerLogs, clearServerLogs } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { fmtSince, fmtTs, fmtUsd } from '../utils/format'

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

export interface StatusPageProps {
  status: StatusResponse | null
  operations: Operation[]
  loadStatus: () => Promise<StatusResponse | null>
  /** Navigate to Settings tab (for "edit in Settings" entry) */
  onNavigateToSettings?: () => void
  currentSection?: OperationsSection
  onSectionChange?: (section: OperationsSection) => void
  showSectionTabs?: boolean
  currentConsoleSection?: ConsoleSection
  onConsoleSectionChange?: (section: ConsoleSection) => void
  showConsoleTabs?: boolean
  showAllSystemSections?: boolean
  showSystemSection?: boolean
  showConsoleSection?: boolean
  consoleCardTitle?: string
  consoleCardDescription?: string
}

export type OperationsSection = 'daemon' | 'monitor' | 'celery' | 'strategy'
export type ConsoleSection = 'daemon-console' | 'server-console' | 'console' | 'operations' | 'events'

export function StatusPage({
  status,
  operations,
  loadStatus,
  onNavigateToSettings: _onNavigateToSettings,
  currentSection,
  onSectionChange,
  showSectionTabs = true,
  currentConsoleSection,
  onConsoleSectionChange,
  showConsoleTabs = true,
  showAllSystemSections = false,
  showSystemSection = true,
  showConsoleSection = true,
  consoleCardTitle,
  consoleCardDescription,
}: StatusPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
  const [celeryCtrlMsg, setCeleryCtrlMsg] = useState({ text: '', isErr: false })
  const [syncTickerLoading, setSyncTickerLoading] = useState(false)
  const [syncTickerMsg, setSyncTickerMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null)
  const [healthTick, setHealthTick] = useState(0)
  const [internalSystemTab, setInternalSystemTab] = useState<OperationsSection>('daemon')
  const [internalConsoleTab, setInternalConsoleTab] = useState<ConsoleSection>('daemon-console')
  const [shutdownAllLoading, setShutdownAllLoading] = useState(false)
  const [shutdownAllMsg, setShutdownAllMsg] = useState({ text: '', isErr: false })
  const [shutdownConfirmOpen, setShutdownConfirmOpen] = useState(false)
  const systemTab = currentSection ?? internalSystemTab
  const setSystemTabSelected = onSectionChange ?? setInternalSystemTab
  const consoleTab = currentConsoleSection ?? internalConsoleTab
  const setConsoleTabSelected = onConsoleSectionChange ?? setInternalConsoleTab
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTickerMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const monitorCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const celeryCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const daemonConsole = useLogConsole({
    fetchLogs: fetchDaemonLogs,
    subscribeLogs: subscribeDaemonLogs,
    clearLogs: clearDaemonLogs,
  })
  const serverConsole = useLogConsole({
    fetchLogs: fetchServerLogs,
    subscribeLogs: subscribeServerLogs,
    clearLogs: clearServerLogs,
  })
  const celeryConsole = useLogConsole({
    fetchLogs: fetchCeleryLogs,
    subscribeLogs: subscribeCeleryLogs,
    clearLogs: clearCeleryLogs,
  })

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

  useEffect(() => {
    return () => {
      if (ctrlMsgClearRef.current != null) clearTimeout(ctrlMsgClearRef.current)
      if (hedgeCtrlMsgClearRef.current != null) clearTimeout(hedgeCtrlMsgClearRef.current)
      if (syncTickerMsgClearRef.current != null) clearTimeout(syncTickerMsgClearRef.current)
      if (monitorCtrlMsgClearRef.current != null) clearTimeout(monitorCtrlMsgClearRef.current)
      if (celeryCtrlMsgClearRef.current != null) clearTimeout(celeryCtrlMsgClearRef.current)
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
      : 'Click "Resume" on monitor to resume'
    daemonIbLine = `Trading Client: ${ibConnected ? `Connected @ ${hb.ib_client_id ?? '?'}` : 'Not connected'}`
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
  const hedgeLamp: 'green' | 'yellow' | 'red' | 'none' = 'green'
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

  const celeryBrokerConnected = j?.celery_broker_connected === true
  const celeryLastTs = j?.celery_worker_last_updated_ts
  const celeryWorkerIbConnected = j?.celery_worker_ib_connected === true
  const celeryWorkerIbClientId = j?.celery_worker_ib_client_id ?? null
  /** Same as Monitor polling: worker alive is determined only by Celery inspect ping in GET /status, not by recent job updates */
  const celeryWorkersAlive = (j?.celery_workers?.length ?? 0) > 0
  const celeryLamp =
    !celeryBrokerConnected ? 'red' : celeryWorkersAlive ? 'green' : 'yellow'

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

  const onReleaseIb = async () => {
    setMsg(setCtrlMsg, 'Requesting release IB…', false)
    const res = await postReleaseIb()
    setMsg(
      setCtrlMsg,
      res.ok
        ? 'Reset sent. Daemon will release both Trading and Listener IB connections on its next heartbeat, then enter WAITING_IB (daemon keeps running). Use «Retry IB connection» below to reconnect when ready.'
        : (res.error ?? ''),
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

  const onMonitorReleaseIb = async () => {
    setMsg(setMonitorCtrlMsg, 'Releasing monitor IB connections…', false)
    const res = await postMonitorReleaseIb()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? 'Monitor IB connections released (Account + Market client_id). Use Connect to reconnect.' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  const onCeleryStop = async () => {
    setMsg(setCeleryCtrlMsg, 'Requesting Celery worker stop…', false)
    const res = await postCeleryStop()
    setMsg(
      setCeleryCtrlMsg,
      res.ok ? 'Celery worker stop requested; process will exit within a few seconds.' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCeleryCtrlMsg, celeryCtrlMsgClearRef)
  }

  /** Shut down entire system: Celery first, then Daemon, then Management last (so others still receive messages). */
  const doShutdownAll = async () => {
    setShutdownConfirmOpen(false)
    setShutdownAllLoading(true)
    const errors: string[] = []
    try {
      setShutdownAllMsg({ text: 'Stopping Celery…', isErr: false })
      const r3 = await postCeleryStop()
      if (!r3.ok) errors.push(`Celery: ${r3.error ?? r3.statusText ?? 'failed'}`)
      setShutdownAllMsg({ text: 'Stopping Daemon…', isErr: false })
      const r1 = await postStop()
      if (!r1.ok) errors.push(`Daemon: ${r1.error ?? r1.statusText ?? 'failed'}`)
      setShutdownAllMsg({ text: 'Stopping Management…', isErr: false })
      const r2 = await postMonitorStop()
      if (!r2.ok) errors.push(`Management: ${r2.error ?? r2.statusText ?? 'failed'}`)
      setShutdownAllMsg({
        text: errors.length === 0 ? 'All systems shut down.' : `Shut down requested; some failed: ${errors.join('; ')}`,
        isErr: errors.length > 0,
      })
      await loadStatus()
    } finally {
      setShutdownAllLoading(false)
    }
  }

  const onShutdownAllClick = () => {
    setShutdownConfirmOpen(true)
  }

  return (
    <div className="status-page">
      <header className="status-page-header" aria-label="Status page header">
        <h1 className="status-page-title">System Status</h1>
        <div className="status-page-actions">
          <button
            type="button"
            className="btn-shutdown-all"
            title="Stop Celery, then Daemon, then Management (in order)"
            disabled={shutdownAllLoading}
            onClick={onShutdownAllClick}
          >
            {shutdownAllLoading ? 'Shutting down…' : 'Shutdown'}
          </button>
          {shutdownAllMsg.text ? (
            <span className={`status-page-msg ${shutdownAllMsg.isErr ? 'err' : 'ok'}`}>{shutdownAllMsg.text}</span>
          ) : null}
        </div>
      </header>

      {/* Shutdown confirmation modal — same style as Data page reset modal */}
      {shutdownConfirmOpen && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => setShutdownConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="shutdown-modal-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="shutdown-modal-title">Shutdown entire system?</h3>
            <p>
              Celery, then Daemon, then Management will be stopped in order. This cannot be undone.
            </p>
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShutdownConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-shutdown-all" onClick={doShutdownAll}>
                Shutdown
              </button>
            </div>
          </div>
        </div>
      )}

      <>
      {showSystemSection && (
      <div className="card process-section system-tabs-wrapper">
        {showSectionTabs && (
        <div className="system-tabs" role="tablist" aria-label="System sections">
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'daemon'}
            aria-controls="system-panel-daemon"
            id="tab-daemon"
            className={`system-tab ${systemTab === 'daemon' ? 'active' : ''}`}
            onClick={() => setSystemTabSelected('daemon')}
          >
            <span className={`lamp lamp-sm ${daemonLamp}`} title="Daemon status" aria-hidden />
            <span>Daemon</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'monitor'}
            aria-controls="system-panel-monitor"
            id="tab-monitor"
            className={`system-tab ${systemTab === 'monitor' ? 'active' : ''}`}
            onClick={() => setSystemTabSelected('monitor')}
          >
            <span className={`lamp lamp-sm ${monitorLamp}`} title="Management status" aria-hidden />
            <span>Management</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'celery'}
            aria-controls="system-panel-celery"
            id="tab-celery"
            className={`system-tab ${systemTab === 'celery' ? 'active' : ''}`}
            onClick={() => setSystemTabSelected('celery')}
          >
            <span className={`lamp lamp-sm ${celeryLamp}`} title="Celery (bars worker) status" aria-hidden />
            <span>Celery</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'strategy'}
            aria-controls="system-panel-strategy"
            id="tab-strategy"
            className={`system-tab ${systemTab === 'strategy' ? 'active' : ''}`}
            onClick={() => setSystemTabSelected('strategy')}
          >
            <span className={`lamp lamp-sm ${hedgeLamp}`} title="Trading strategy status" aria-hidden />
            <span>Trading Strategy</span>
          </button>
        </div>
        )}

        <div className={showAllSystemSections ? 'system-stack' : undefined}>
        {(showAllSystemSections || systemTab === 'daemon') && (
      <div id="system-panel-daemon" role="tabpanel" aria-labelledby="tab-daemon" className={`system-tab-panel ${showAllSystemSections ? 'system-stack-section' : ''}`}>
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
              <span className="daemon-group-title">Heartbeat</span>
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
              <span className="daemon-group-title">IB connection</span>
            </div>
            <div className="daemon-group-body">
              {ibConnected ? (
                <p className="section-hint countdown-line">
                  Trading Client: <span className="countdown-num">Connected @ {hb?.ib_client_id ?? '?'}</span>
                </p>
              ) : (
                <p className="section-hint">{daemonIbLine || '—'}</p>
              )}
              {j?.ib_config?.ib_client_id_listener != null && (
                <p className="section-hint countdown-line">
                  Listener Client: {hb?.listener_connected ? (
                    <span className="countdown-num">Connected @ {hb?.listener_client_id ?? j.ib_config.ib_client_id_listener}</span>
                  ) : (
                    <span>Not connected</span>
                  )}
                </p>
              )}
              {ibConnected && (
                <div className="controls">
                  <button
                    type="button"
                    className="btn-retry-ib"
                    title="Release IB connection on next daemon heartbeat (daemon will go to WAITING_IB and can retry later)"
                    onClick={onReleaseIb}
                  >
                    Reset
                  </button>
                </div>
              )}
              {hb?.daemon_alive && !ibConnected && (
                <p className="section-hint section-hint--retry">Will retry connection on next heartbeat.</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.redis_quotes_connected ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Daemon Redis status" />
              <span className="daemon-group-title">Database</span>
            </div>
            <div className="daemon-group-body">
              {!hb?.daemon_alive ? (
                <p className="section-hint">Redis: —</p>
              ) : hb.redis_quotes_connected ? (
                <p className="section-hint countdown-line">
                  Redis: <span className="countdown-num">Connected</span> <span>(writes quotes and publishes)</span>
                </p>
              ) : (
                <p className="section-hint">Redis: Not connected or not configured</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <span className="daemon-group-title">Event Subscribe</span>
              <InfoTooltip text="Daemon IB event subscription status: ticker (Watchlist STK), positions, fills, commission. Green = subscribed; red = not subscribed when daemon is running." />
            </div>
            <div className="daemon-group-body">
              <ul className="event-subscribe-list">
                <li className="event-subscribe-row">
                  <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Real-time ticker" aria-hidden />
                  <span>Real-time ticker</span>
                </li>
                <li className="event-subscribe-row">
                  <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_positions ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Position updates" aria-hidden />
                  <span>Position updates</span>
                </li>
                <li className="event-subscribe-row">
                  <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_fills ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Fill / execution report" aria-hidden />
                  <span>Fill / execution report</span>
                </li>
                <li className="event-subscribe-row">
                  <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_commission ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Commission report" aria-hidden />
                  <span>Commission report</span>
                </li>
              </ul>
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
                  Suspend
                </button>
                <button
                  type="button"
                  className="btn-resume"
                  disabled={!suspended}
                  title={!suspended ? 'Already running' : 'Set from monitor; daemon resumes hedging on next heartbeat'}
                  onClick={onResume}
                >
                  Resume
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
        )}

        {(showAllSystemSections || systemTab === 'monitor') && (
      <div id="system-panel-monitor" role="tabpanel" aria-labelledby="tab-monitor" className={`system-tab-panel ${showAllSystemSections ? 'system-stack-section' : ''}`}>
        <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${monitorLamp}`} title="Monitor status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Management</h2>
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
                <strong>
                  Status:{' '}
                  {j ? (
                    <>
                      {monitorEnabled ? <span className="countdown-num">Running</span> : 'Stopped'}{' '}
                      <span>({monitorSelfCheckText})</span>
                    </>
                  ) : (
                    'Fetch failed'
                  )}
                </strong>
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
                Account Client:{' '}
                {monitorAccount?.connected ? (
                  <span className="countdown-num">Connected @ {monitorAccount?.client_id ?? '—'}</span>
                ) : (
                  `Not connected${monitorAccount?.last_error ? ` (${monitorAccount.last_error})` : ''}`
                )}
              </p>
              <p className="section-hint countdown-line">
                Market Client:{' '}
                {monitorMarket?.connected ? (
                  <span className="countdown-num">Connected @ {monitorMarket?.client_id ?? '—'}</span>
                ) : (
                  `Not connected${monitorMarket?.last_error ? ` (${monitorMarket.last_error})` : ''}`
                )}
              </p>
              <div className="controls" style={{ marginTop: '0.25rem' }}>
                {(monitorAccount?.connected || monitorMarket?.connected) ? (
                  <button
                    type="button"
                    className="btn-retry-ib"
                    title="Release Monitor IB connections (Account + Market client_id). Monitor keeps running; use Connect to reconnect."
                    onClick={onMonitorReleaseIb}
                  >
                    Release
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-resume"
                    disabled={!monitorEnabled}
                    title={monitorEnabled ? 'Establish monitor IB connection (AccountIbClient + MarketIbClient)' : 'Monitor stopped; cannot connect'}
                    onClick={onMonitorConnect}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${j?.redis_quotes_connected ? 'green' : monitorEnabled ? 'red' : 'none'}`} title="Monitor Redis status" />
              <span className="daemon-group-title">Database</span>
            </div>
            <div className="daemon-group-body">
              {!monitorEnabled ? (
                <p className="section-hint">Redis: —</p>
              ) : j?.redis_quotes_connected ? (
                <p className="section-hint countdown-line">
                  Redis: <span className="countdown-num">Connected</span>{' '}
                  <InfoTooltip text="GET /quotes available" />
                </p>
              ) : (
                <p className="section-hint">Redis: Not connected or not configured</p>
              )}
            </div>
          </div>
        </div>
        {monitorCtrlMsg.text ? (
          <div className={`msg ${monitorCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {monitorCtrlMsg.text}
          </div>
        ) : null}
      </div>
        )}

        {(showAllSystemSections || systemTab === 'celery') && (
      <div id="system-panel-celery" role="tabpanel" aria-labelledby="tab-celery" className={`system-tab-panel ${showAllSystemSections ? 'system-stack-section' : ''}`}>
        <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${celeryLamp}`} title="Celery status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Celery</h2>
              <div>
                <strong>Status: {j ? (celeryBrokerConnected ? (celeryWorkersAlive ? 'Broker connected, worker(s) running (ping ok)' : 'Broker connected, no workers (start: python scripts/run_celery.py)') : 'Broker not connected') : 'Fetch failed'}</strong>
              </div>
            </div>
          </div>
          <div className="monitor-header-actions">
            <button
              type="button"
              className="btn-stop"
              title="Stop Celery worker process (same as Monitor/Daemon Stop); restart with: python scripts/run_celery.py"
              onClick={onCeleryStop}
            >
              Stop
            </button>
          </div>
        </div>
        <div className="daemon-groups">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${celeryBrokerConnected ? 'green' : 'red'}`} title="Celery broker (Redis) status" />
              <span className="daemon-group-title">Broker (Redis)</span>
              <InfoTooltip text="Celery broker and result backend. Same Redis as config.redis (db 1 for Celery). Required for queued bars backfill." />
            </div>
            <div className="daemon-group-body">
              {celeryBrokerConnected ? (
                <p className="section-hint countdown-line">
                  <span className="countdown-num">Connected</span> <span>(bars queue available)</span>
                </p>
              ) : (
                <p className="section-hint">Not connected or Redis not configured</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${(j?.celery_workers?.length ?? 0) > 0 ? 'green' : celeryBrokerConnected ? 'yellow' : 'none'}`} title="Celery workers responding to ping" />
              <span className="daemon-group-title">Celery Workers</span>
              <InfoTooltip text="Workers that responded to inspect ping. Worker connects to IB using Settings → Celery worker_market; connection is kept so backfill can use it. Use Stop above to terminate the worker." />
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                {(j?.celery_workers?.length ?? 0) > 0
                  ? (j?.celery_workers ?? []).join(', ')
                  : 'None (start worker: python scripts/run_celery.py)'}
              </p>
              <p className="section-hint countdown-line">
                Last job activity:{' '}
                {celeryLastTs != null && Number.isFinite(celeryLastTs)
                  ? `${fmtTs(celeryLastTs)} (${fmtSince(celeryLastTs)} ago)`
                  : 'No job activity yet'}
              </p>
              <p className="section-hint countdown-line">
                IB Client ID:{' '}
                {celeryWorkerIbConnected ? (
                  <span className="countdown-num">Connected @ {celeryWorkerIbClientId ?? '—'}</span>
                ) : (
                  <>
                    Not connected{' '}
                    <InfoTooltip text="IB connection is inside the Worker process. Start worker first: python scripts/run_celery.py (uses Settings → Celery worker_market)." />
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
        {celeryCtrlMsg.text ? (
          <div className={`msg ${celeryCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {celeryCtrlMsg.text}
          </div>
        ) : null}
      </div>
        )}

        {(showAllSystemSections || systemTab === 'strategy') && (
      <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className={`system-tab-panel ${showAllSystemSections ? 'system-stack-section' : ''}`}>
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
        )}
        </div>
      </div>
      )}

      {showConsoleSection && (
      <div className="card card-operations celery-console-card">
        {consoleCardTitle ? (
          <div className="console-card-header">
            <div>
              <h2 className="daemon-card-title">{consoleCardTitle}</h2>
              {consoleCardDescription ? (
                <p className="section-hint section-hint-tight">{consoleCardDescription}</p>
              ) : null}
            </div>
          </div>
        ) : null}
        {showConsoleTabs && (
        <div className="system-tabs" role="tablist" aria-label="Console section" style={{ marginBottom: 'var(--space-3)' }}>
          <button
            type="button"
            role="tab"
            aria-selected={consoleTab === 'daemon-console'}
            aria-controls="celery-section-panel-daemon-console"
            id="celery-tab-daemon-console"
            className={`system-tab ${consoleTab === 'daemon-console' ? 'active' : ''}`}
            onClick={() => setConsoleTabSelected('daemon-console')}
          >
            Daemon Console
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={consoleTab === 'server-console'}
            aria-controls="celery-section-panel-server-console"
            id="celery-tab-server-console"
            className={`system-tab ${consoleTab === 'server-console' ? 'active' : ''}`}
            onClick={() => setConsoleTabSelected('server-console')}
          >
            Server Console
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={consoleTab === 'console'}
            aria-controls="celery-section-panel-console"
            id="celery-tab-console"
            className={`system-tab ${consoleTab === 'console' ? 'active' : ''}`}
            onClick={() => setConsoleTabSelected('console')}
          >
            Celery Console
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={consoleTab === 'operations'}
            aria-controls="celery-section-panel-operations"
            id="celery-tab-operations"
            className={`system-tab ${consoleTab === 'operations' ? 'active' : ''}`}
            onClick={() => setConsoleTabSelected('operations')}
          >
            Recent operations
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={consoleTab === 'events'}
            aria-controls="celery-section-panel-events"
            id="celery-tab-events"
            className={`system-tab ${consoleTab === 'events' ? 'active' : ''}`}
            onClick={() => setConsoleTabSelected('events')}
          >
            Event Subscribe
          </button>
        </div>
        )}
        {consoleTab === 'daemon-console' && (
          <div id="celery-section-panel-daemon-console" role="tabpanel" aria-labelledby="celery-tab-daemon-console"
            style={{ marginTop: 'var(--space-3)' }}
          >
            <LogConsolePanel
              controller={daemonConsole}
              loadingText="Connecting…"
              errorText="Unable to load (Redis may be down)."
              emptyText="No log lines yet. Start daemon: python scripts/run_engine.py"
              infoTooltipText="Real-time daemon log (Redis Stream). Run `python scripts/run_engine.py` to see output."
              resizeAriaLabel="Resize daemon console height"
              clearTitle="Clear displayed log and Redis stream; new lines will continue to appear when daemon runs"
            />
          </div>
        )}
        {consoleTab === 'server-console' && (
          <div id="celery-section-panel-server-console" role="tabpanel" aria-labelledby="celery-tab-server-console"
            style={{ marginTop: 'var(--space-3)' }}
          >
            <LogConsolePanel
              controller={serverConsole}
              loadingText="Connecting…"
              errorText="Unable to load (Redis may be down)."
              emptyText="No log lines yet. Start server: python scripts/run_server.py"
              infoTooltipText="Real-time server log (Redis Stream). Run `python scripts/run_server.py` to see output."
              resizeAriaLabel="Resize server console height"
              clearTitle="Clear displayed log and Redis stream; new lines will continue to appear when server runs"
            />
          </div>
        )}
        {consoleTab === 'console' && (
          <div id="celery-section-panel-console" role="tabpanel" aria-labelledby="celery-tab-console"
            style={{ marginTop: 'var(--space-3)' }}
          >
            <LogConsolePanel
              controller={celeryConsole}
              loadingText="Connecting…"
              errorText="Unable to load (Redis/Celery broker may be down)."
              emptyText="No log lines yet. Start Worker: python scripts/run_celery.py"
              infoTooltipText="Real-time Worker log (Redis Stream). Run `python scripts/run_celery.py` to see output."
              resizeAriaLabel="Resize console height"
              clearTitle="Clear displayed log and Redis stream; new lines will continue to appear when Worker runs"
            />
          </div>
        )}
        {consoleTab === 'operations' && (
          <div id="celery-section-panel-operations" role="tabpanel" aria-labelledby="celery-tab-operations"
            style={{ marginTop: 'var(--space-3)' }}
          >
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
        )}
        {consoleTab === 'events' && (
          <div id="celery-section-panel-events" role="tabpanel" aria-labelledby="celery-tab-events"
            style={{ marginTop: 'var(--space-3)' }}
          >
            <div className="daemon-card-title page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
              Event Subscribe
              <InfoTooltip text="Daemon IB event subscription status and subscribed tickers (Watchlist STK + strategy symbol)." />
              {hb?.daemon_alive != null && hb?.daemon_alive && (
                <button
                  type="button"
                  className="btn-resume"
                  style={{ marginLeft: '0.5rem', verticalAlign: 'middle' }}
                  title="Sync Real-time ticker with Watchlist (subscribe/add, unsubscribe/remove); list updates on next heartbeat"
                  disabled={syncTickerLoading}
                  onClick={async () => {
                    setSyncTickerLoading(true)
                    try {
                      const res = await postRefreshTickerSubscriptions()
                      if (res.ok && typeof loadStatus === 'function') {
                        setMsg(setSyncTickerMsg, 'Synced', false)
                        scheduleMsgClear(setSyncTickerMsg, syncTickerMsgClearRef)
                        setTimeout(() => loadStatus(), 1500)
                      }
                      if (!res.ok && res.error) setMsg(setSyncTickerMsg, res.error, true)
                    } finally {
                      setSyncTickerLoading(false)
                    }
                  }}
                >
                  {syncTickerLoading ? 'Syncing…' : 'Sync'}
                </button>
              )}
            </div>
            <table className="table-operations">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Real-time ticker</td>
                  <td>
                    <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Real-time ticker" aria-hidden />
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive && hb?.event_subscribe_ticker
                        ? `Subscribed (${j?.subscribed_tickers?.length ?? 0} ticker${(j?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'} in monitoring)`
                        : hb?.daemon_alive
                          ? 'Not subscribed'
                          : '—'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Position updates</td>
                  <td>
                    <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_positions ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Position updates" aria-hidden />
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive && hb?.event_subscribe_positions ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Fill / execution report</td>
                  <td>
                    <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_fills ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Fill / execution report" aria-hidden />
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive && hb?.event_subscribe_fills ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Commission report</td>
                  <td>
                    <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_commission ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Commission report" aria-hidden />
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive && hb?.event_subscribe_commission ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            {syncTickerMsg.text ? (
              <div className={`msg ${syncTickerMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
                {syncTickerMsg.text}
              </div>
            ) : null}
            {hb?.daemon_alive && hb?.event_subscribe_ticker && (
              <div className="event-subscribe-tickers-block" style={{ marginTop: '1rem' }}>
                <h3 className="daemon-group-title" style={{ marginBottom: '0.5rem' }}>Real-time ticker — subscribed symbols</h3>
                <p className="section-hint" style={{ margin: 0, fontWeight: 600 }}>
                  {(j?.subscribed_tickers?.length ?? 0)} ticker{(j?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'} in monitoring
                </p>
                <p className="section-hint" style={{ margin: '0.25rem 0 0 0' }}>
                  {j?.subscribed_tickers?.length ? j.subscribed_tickers.join(', ') : '—'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </>
    </div>
  )
}
