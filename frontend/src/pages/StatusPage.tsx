import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten, postReleaseIb, postStop, postMonitorStop, postMonitorReleaseIb, postCeleryStop, postMonitorConnect, fetchHealth, postReleaseTickerSubscriptions, fetchCeleryLogs, subscribeCeleryLogs, clearCeleryLogs, fetchDaemonLogs, subscribeDaemonLogs, clearDaemonLogs, fetchServerLogs, subscribeServerLogs, clearServerLogs } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { fmtTs, fmtUsd } from '../utils/format'
import {
  DAEMON_REASON_LABELS,
  DAEMON_SELF_CHECK_LABELS,
  DAEMON_STATE_LABELS,
  HEDGE_REASON_LABELS,
  MONITOR_REASON_LABELS,
  MONITOR_SELF_CHECK_LABELS,
  STATUS_FIELDS,
} from './status/statusLabels'
import { scheduleMsgClear, setMsg } from './status/messageUtils'
import { useControlAction } from './status/useControlAction'
import { StatusDaemonPanel, StatusMonitorPanel, StatusCeleryPanel, StatusStrategyPanel } from './status/panels'

export interface StatusPageProps {
  status: StatusResponse | null
  operations: Operation[]
  loadStatus: () => Promise<StatusResponse | null>
  /** Navigate to Settings tab (for "edit in Settings" entry) */
  onNavigateToSettings?: () => void
  /** Navigate to Research → Strategy (Manage) */
  onNavigateToStrategy?: () => void
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
  onNavigateToStrategy,
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
}: StatusPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
  const [celeryCtrlMsg, setCeleryCtrlMsg] = useState({ text: '', isErr: false })
  const [releaseTickerLoading, setReleaseTickerLoading] = useState(false)
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

  const runCtrlAction = useControlAction(setCtrlMsg, ctrlMsgClearRef, { onSuccess: loadStatus })
  const runHedgeAction = useControlAction(setHedgeCtrlMsg, hedgeCtrlMsgClearRef)
  const runMonitorAction = useControlAction(setMonitorCtrlMsg, monitorCtrlMsgClearRef, { onSuccess: loadStatus })
  /** Monitor Stop exits the server process shortly after 200; do not call loadStatus so the UI does not hang on a GET to a dead server. */
  const runMonitorStopAction = useControlAction(setMonitorCtrlMsg, monitorCtrlMsgClearRef, {})
  const runCeleryAction = useControlAction(setCeleryCtrlMsg, celeryCtrlMsgClearRef, { onSuccess: loadStatus })

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
  const monitorAccount2 = monitorStatus.account2 as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorMarket = monitorStatus.market as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorHasError = Boolean(monitorAccount?.last_error || monitorAccount2?.last_error || monitorMarket?.last_error)
  const hasAccount2 = monitorAccount2 !== undefined
  const allMonitorClientsConnected = hasAccount2
    ? Boolean(monitorAccount?.connected && monitorAccount2?.connected && monitorMarket?.connected)
    : Boolean(monitorAccount?.connected && monitorMarket?.connected)
  const anyMonitorClientConnected = Boolean(monitorAccount?.connected || monitorAccount2?.connected || monitorMarket?.connected)
  const monitorLamp =
    !monitorEnabled
      ? 'red'
      : monitorHasError
        ? 'yellow'
        : hasAccount2 && !allMonitorClientsConnected
          ? anyMonitorClientConnected ? 'yellow' : 'yellow'
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
    !monitorEnabled
      ? 'none'
      : allMonitorClientsConnected
        ? 'green'
        : anyMonitorClientConnected
          ? 'yellow'
          : 'red'

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
          : k === 'spot' && typeof v === 'number'
            ? fmtUsd(v)
            : k === 'daemon_state'
              ? DAEMON_STATE_LABELS[String(v)] ?? v
              : String(v)
    else out = '--'
    return { label, value: out }
  })

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
      // Do not call loadStatus() after Management stop: the server process exits, so the request would hang.
    } finally {
      setShutdownAllLoading(false)
    }
  }

  const onShutdownAllClick = () => {
    setShutdownConfirmOpen(true)
  }

  return (
    <div className="status-page">
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
        <div className="status-section-heading-row">
          <h2 className="status-section-heading">Status</h2>
          <div className="status-section-actions">
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
        </div>
        {showSectionTabs && (
        <div className="system-tabs system-tabs-one-row" role="tablist" aria-label="System sections">
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
            aria-selected={systemTab === 'monitor' || systemTab === 'celery'}
            aria-controls="system-panel-monitor-celery"
            id="tab-monitor-celery"
            className={`system-tab ${systemTab === 'monitor' || systemTab === 'celery' ? 'active' : ''}`}
            onClick={() => setSystemTabSelected('monitor')}
          >
            <span className={`lamp lamp-sm ${monitorLamp}`} title="Management status" aria-hidden />
            <span>Management</span>
            <span className="status-tab-sep" aria-hidden>/</span>
            <span className={`lamp lamp-sm ${celeryLamp}`} title="Celery (bars worker) status" aria-hidden />
            <span>Celery</span>
          </button>
        </div>
        )}

        <div className={`system-tab-content ${showAllSystemSections ? 'system-stack' : ''}`}>
        {(showAllSystemSections || systemTab === 'daemon') && (
          <div className="status-panel-section status-panel-section-daemon">
            <StatusDaemonPanel
              status={j}
              hb={hb}
              daemonLabel={daemonLabel}
              daemonHint={daemonHint}
              daemonSelfCheckText={daemonSelfCheckText}
              daemonBlockReasons={daemonBlockReasons}
              daemonLamp={daemonLamp}
              heartbeatGroupLamp={heartbeatGroupLamp}
              ibGroupLamp={ibGroupLamp}
              strategyGroupLamp={strategyGroupLamp}
              secondsUntilNextHeartbeat={secondsUntilNextHeartbeat}
              runStatusLabel={runStatusLabel}
              suspended={suspended}
              ibConnected={ibConnected}
              daemonIbLine={daemonIbLine}
              ibConfig={j?.ib_config}
              onStop={() => runCtrlAction(postStop, { loading: 'Requesting daemon stop…', success: 'Stop sent; daemon will exit and clear ib_client_id; next start uses client_id=1.' })}
              onSuspend={() => runCtrlAction(postSuspend, { loading: 'Setting suspend…', success: 'Suspend set; daemon will pause new hedges on next heartbeat.' })}
              onResume={() => runCtrlAction(postResume, { loading: 'Setting resume…', success: 'Resume set; daemon will resume hedging on next heartbeat.' })}
              onReleaseIb={() => runCtrlAction(postReleaseIb, { loading: 'Requesting release IB…', success: 'Reset sent. Daemon will release both Trading and Listener IB connections on its next heartbeat, then enter WAITING_IB (daemon keeps running). Use «Retry IB connection» below to reconnect when ready.' })}
              ctrlMsg={ctrlMsg}
              className={showAllSystemSections ? 'system-stack-section' : undefined}
            />
          </div>
        )}

        {(showAllSystemSections || systemTab === 'monitor' || systemTab === 'celery') && (
          <div className="status-management-celery-row" id="system-panel-monitor-celery" role="tabpanel" aria-labelledby="tab-monitor-celery">
            <div className="status-panel-section status-management-celery-half">
              <StatusMonitorPanel
                status={j}
                monitorLamp={monitorLamp}
                monitorEnabled={monitorEnabled}
                monitorSelfCheckText={monitorSelfCheckText}
                monitorBlockReasons={monitorBlockReasons}
                apiHealthLamp={apiHealthLamp}
                healthCountdownSec={healthCountdownSec}
                monitorIbGroupLamp={monitorIbGroupLamp}
                monitorAccount={monitorAccount}
                monitorAccount2={monitorAccount2}
                monitorMarket={monitorMarket}
                onMonitorStop={() => runMonitorStopAction(postMonitorStop, { loading: 'Stopping monitor service…', success: 'Monitor service stopped (no new IB requests). Server has exited; refresh the page after restarting it.' })}
                onMonitorConnect={() => runMonitorAction(postMonitorConnect, { loading: 'Establishing monitor IB connection…', success: 'Monitor IB connect requested (Account + Account2 + Market); check status bar for result.' })}
                onMonitorReleaseIb={() => runMonitorAction(postMonitorReleaseIb, { loading: 'Releasing monitor IB connections…', success: 'Monitor IB connections released (Account + Account2 + Market). Use Connect to reconnect.' })}
                monitorCtrlMsg={monitorCtrlMsg}
                className={showAllSystemSections ? 'system-stack-section' : undefined}
              />
            </div>
            <div className="status-panel-section status-management-celery-half">
              <StatusCeleryPanel
                status={j}
                celeryLamp={celeryLamp}
                celeryBrokerConnected={celeryBrokerConnected}
                celeryWorkersAlive={celeryWorkersAlive}
                celeryLastTs={celeryLastTs}
                celeryWorkerIbConnected={celeryWorkerIbConnected}
                celeryWorkerIbClientId={celeryWorkerIbClientId}
                onCeleryStop={() => runCeleryAction(postCeleryStop, { loading: 'Requesting Celery worker stop…', success: 'Celery worker stop requested; process will exit within a few seconds.' })}
                celeryCtrlMsg={celeryCtrlMsg}
                className={showAllSystemSections ? 'system-stack-section' : undefined}
              />
            </div>
          </div>
        )}
        </div>
      </div>
      )}

      {/* Stream Event — Trading Strategy + Event Subscribe, same row style as Management/Celery (above Console) */}
      {showConsoleSection && (
      <div className="card process-section system-tabs-wrapper stream-event-card">
        <div className="status-section-heading-row">
          <h2 className="status-section-heading">Event</h2>
        </div>
        <div className="status-management-celery-row stream-event-row">
          <div className="status-panel-section status-management-celery-half stream-event-strategy-quarter">
            <StatusStrategyPanel
              compact
              status={j}
              hedgeLamp={hedgeLamp}
              hedgeLabel={hedgeLabel}
              hedgeSelfCheckText={hedgeSelfCheckText}
              hedgeBlockReasons={hedgeBlockReasons}
              hedgeHint={hedgeHint}
              statusSummaryItems={statusSummaryItems}
              onFlatten={() => runHedgeAction(postFlatten, { loading: 'Requesting flatten…', success: 'Flatten sent; hedge process will consume and execute.' })}
              hedgeCtrlMsg={hedgeCtrlMsg}
              activeStructureName={status?.active_strategy_structure_name}
              activeGateSafetyName={status?.active_gate_safety_strategy_name}
              onManage={onNavigateToStrategy}
            />
          </div>
          <div className="status-panel-section status-management-celery-half stream-event-subscribe-rest card-event-subscribe event-subscribe-section">
            <div className="event-subscribe-header-row">
              <div className="daemon-header-with-lamp" style={{ marginBottom: 0 }}>
                <div className="lamp-wrap-span">
                  <div className={`lamp lamp-sm ${(() => {
                    if (!hb?.daemon_alive) return 'red'
                    const tickerOk = hb.event_subscribe_ticker
                    const positionsOk = hb.event_subscribe_positions
                    const fillsOk = hb.event_subscribe_fills
                    const commissionOk = hb.event_subscribe_commission
                    const allOk = tickerOk && positionsOk && fillsOk && commissionOk
                    const anyOk = tickerOk || positionsOk || fillsOk || commissionOk
                    return allOk ? 'green' : anyOk ? 'yellow' : 'red'
                  })()}`} title="Event Subscribe: green = all subscribed, yellow = some not, red = none or daemon down" aria-hidden />
                </div>
                <h2 className="daemon-card-title page-title-with-tooltip" style={{ margin: 0 }}>
                  Event Subscribe
                  <InfoTooltip text="Daemon IB event subscription status and subscribed tickers (Watchlist STK + strategy symbol)." />
                </h2>
                {hb?.daemon_alive && hb?.event_subscribe_ticker && (j?.subscribed_tickers?.length ?? 0) >= 0 && (
                  <span className="event-subscribe-ticker-count" aria-label="Subscribed ticker count">
                    {j?.subscribed_tickers?.length ?? 0} ticker{(j?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="event-subscribe-buttons">
                <button
                  type="button"
                  className="btn-resume"
                  title="Release all Real-time ticker subscriptions; daemon will restore on next heartbeat"
                  disabled={releaseTickerLoading || !hb?.daemon_alive}
                  onClick={async () => {
                    setReleaseTickerLoading(true)
                    try {
                      const res = await postReleaseTickerSubscriptions()
                      if (res.ok && typeof loadStatus === 'function') {
                        setMsg(setSyncTickerMsg, 'Released; restoring on next heartbeat', false)
                        scheduleMsgClear(setSyncTickerMsg, syncTickerMsgClearRef)
                        setTimeout(() => loadStatus(), 1500)
                      }
                      if (!res.ok && res.error) setMsg(setSyncTickerMsg, res.error, true)
                    } finally {
                      setReleaseTickerLoading(false)
                    }
                  }}
                >
                  {releaseTickerLoading ? 'Releasing…' : 'Release'}
                </button>
              </div>
            </div>
            <div className="event-subscribe-body">
            <table className="table-operations table-event-subscribe">
              <thead>
                <tr>
                  <th className="event-subscribe-col-subscription">Subscription</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="event-subscribe-col-subscription">Real-time ticker</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Real-time ticker" aria-hidden />
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive && hb?.event_subscribe_ticker
                          ? `${j?.subscribed_tickers?.length ?? 0} ticker${(j?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'}`
                          : hb?.daemon_alive
                            ? 'Not subscribed'
                            : '—'}
                      </span>
                      {hb?.daemon_alive && hb?.event_subscribe_ticker && (j?.subscribed_tickers?.length ?? 0) > 0 && (
                        <div className="dashboard-streams-marquee event-subscribe-ticker-marquee">
                          <div className="dashboard-streams-track event-subscribe-track">
                            {(() => {
                              const tickers = j?.subscribed_tickers ?? []
                              const short = tickers.length > 8 ? tickers.slice(0, 8) : tickers
                              return [...short, ...short].map((sym, idx) => (
                                <span key={`${sym}-${idx}`} className="dashboard-streams-item">{sym}</span>
                              ))
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Position updates</td>
                  <td>
                    <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_positions ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Position updates" aria-hidden />
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive && hb?.event_subscribe_positions ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Fill / execution report</td>
                  <td>
                    <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_fills ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Fill / execution report" aria-hidden />
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive && hb?.event_subscribe_fills ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Commission report</td>
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
            {hb?.last_control_message ? (
              <div className="msg err" style={{ marginTop: '0.5rem' }} role="alert">
                {hb.last_control_message}
              </div>
            ) : null}
            </div>
          </div>
        </div>
      </div>
      )}

      {showConsoleSection && (
      <div className="card card-operations celery-console-card">
        {consoleCardTitle ? (
          <div className="console-card-header">
            <div>
              <h2 className="daemon-card-title">{consoleCardTitle}</h2>
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
        </div>
        )}
        {(consoleTab === 'daemon-console' || consoleTab === 'events') && (
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
                    <tr key={op.daemon_auto_operations_id ?? `op-${op.ts}-${i}`}>
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
      </div>
      )}
    </>
    </div>
  )
}

