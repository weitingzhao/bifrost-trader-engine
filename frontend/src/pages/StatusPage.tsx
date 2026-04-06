import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten, postReleaseIb, postStop, postMonitorStop, postMonitorReleaseIb, postMonitorConnect, fetchHealth, postReleaseTickerSubscriptions, fetchDaemonLogs, subscribeDaemonLogs, clearDaemonLogs, fetchServerLogs, subscribeServerLogs, clearServerLogs } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'
import { useCeleryWorkerConsoleBindings } from '../hooks/useCeleryWorkerConsoleBindings'
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
import { celeryMetricsFromStatus } from './status/celeryMetrics'

export type CeleryUiMode = 'full' | 'relocated'

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
  /** When set, scroll to this system section and add highlight (e.g. from header lamp link). */
  highlightSection?: 'daemon' | 'monitor' | 'celery'
  /** Settings embed: Celery UI lives under Feed → Celery; hide duplicate Celery column and console tab. */
  celeryUiMode?: CeleryUiMode
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
  highlightSection,
  celeryUiMode = 'full',
}: StatusPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
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
  const deferredStart = useDeferredStart()
  const systemTab = currentSection ?? internalSystemTab
  const setSystemTabSelected = onSectionChange ?? setInternalSystemTab
  const consoleTab = currentConsoleSection ?? internalConsoleTab
  const setConsoleTabSelected = onConsoleSectionChange ?? setInternalConsoleTab
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTickerMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const monitorCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const daemonConsole = useLogConsole({
    fetchLogs: fetchDaemonLogs,
    subscribeLogs: subscribeDaemonLogs,
    clearLogs: clearDaemonLogs,
    enabled: deferredStart && showConsoleSection && (consoleTab === 'daemon-console' || consoleTab === 'events'),
  })
  const serverConsole = useLogConsole({
    fetchLogs: fetchServerLogs,
    subscribeLogs: subscribeServerLogs,
    clearLogs: clearServerLogs,
    enabled: deferredStart && showConsoleSection && consoleTab === 'server-console',
  })
  const celeryWorkerBindings = useCeleryWorkerConsoleBindings(
    status,
    deferredStart && showConsoleSection && celeryUiMode !== 'relocated' && consoleTab === 'console',
  )
  const celeryConsole = useLogConsole({
    fetchLogs: celeryWorkerBindings.fetchLogs,
    subscribeLogs: celeryWorkerBindings.subscribeLogs,
    clearLogs: celeryWorkerBindings.clearLogs,
    enabled: celeryWorkerBindings.consoleEnabled,
  })

  useEffect(() => {
    if (!highlightSection) return
    const id = `system-section-${highlightSection}`
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [highlightSection])

  const runCtrlAction = useControlAction(setCtrlMsg, ctrlMsgClearRef, { onSuccess: loadStatus })
  const runHedgeAction = useControlAction(setHedgeCtrlMsg, hedgeCtrlMsgClearRef)
  const runMonitorAction = useControlAction(setMonitorCtrlMsg, monitorCtrlMsgClearRef, { onSuccess: loadStatus })
  /** Monitor Stop exits the server process shortly after 200; do not call loadStatus so the UI does not hang on a GET to a dead server. */
  const runMonitorStopAction = useControlAction(setMonitorCtrlMsg, monitorCtrlMsgClearRef, {})
  const j = status
  const hb = j?.daemon?.heartbeat
  const hbForCountdown = hb
  const intervalSec = hbForCountdown?.heartbeat_interval_sec ?? 10
  const nowSec = Date.now() / 1000
  void tick
  void healthTick
  const secondsUntilNextHeartbeat =
    hbForCountdown?.daemon_alive && hbForCountdown?.last_ts != null
      ? Math.max(0, Math.ceil(hbForCountdown.last_ts + intervalSec - nowSec))
      : null
  const suspended = j?.daemon?.trading?.trading_suspended === true
  const ibConnected = hb?.ib_connected === true
  const streamHostAccountId = (j?.config?.ib_client?.account?.event_host ?? '').toString().trim()
  const streamSecondaryAccountId = (j?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
  const openOrdersList = j?.portfolio?.open_orders ?? []
  const hostOpenOrderCount = streamHostAccountId
    ? openOrdersList.filter((o) => (o.account_id ?? '').toString().trim() === streamHostAccountId).length
    : openOrdersList.length
  const secondaryOpenOrderCount = streamSecondaryAccountId
    ? openOrdersList.filter((o) => (o.account_id ?? '').toString().trim() === streamSecondaryAccountId).length
    : 0

  useEffect(() => {
    return () => {
      if (ctrlMsgClearRef.current != null) clearTimeout(ctrlMsgClearRef.current)
      if (hedgeCtrlMsgClearRef.current != null) clearTimeout(hedgeCtrlMsgClearRef.current)
      if (syncTickerMsgClearRef.current != null) clearTimeout(syncTickerMsgClearRef.current)
      if (monitorCtrlMsgClearRef.current != null) clearTimeout(monitorCtrlMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!hbForCountdown?.daemon_alive) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [hbForCountdown?.daemon_alive])

  useEffect(() => {
    if (!deferredStart) return
    fetchHealth()
      .then(() => setLastHealthAt(Date.now() / 1000))
      .catch(() => setLastHealthAt(null))
  }, [deferredStart])

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

  useEffect(() => {
    if (celeryUiMode !== 'relocated') return
    if (consoleTab === 'console') setConsoleTabSelected('daemon-console')
  }, [celeryUiMode, consoleTab, setConsoleTabSelected])

  let daemonLabel = 'Not running (or single-process mode)'
  let daemonHint = 'Run run_engine.py on the trading machine to see "Running" here'
  const autoSt = j?.daemon?.trading?.auto_status
  let hedgeLabel = (autoSt?.ts != null && nowSec - (autoSt.ts as number) < 90) ? 'Running (single-process)' : 'Not running'
  let hedgeHint = (autoSt?.ts != null && nowSec - (autoSt.ts as number) < 90)
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

  const monitorEnabled = j?.monitor?.enabled !== false
  const monitorStatus = (j?.socket?.ib_operator as any) || {}
  const monitorOperator = monitorStatus.host as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorAccount2 = monitorStatus.secondary as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorHasError = Boolean(monitorOperator?.last_error || monitorAccount2?.last_error)
  const hasAccount2 = monitorAccount2 !== undefined
  const allMonitorClientsConnected = hasAccount2
    ? Boolean(monitorOperator?.connected && monitorAccount2?.connected)
    : Boolean(monitorOperator?.connected)
  const anyMonitorClientConnected = Boolean(monitorOperator?.connected || monitorAccount2?.connected)
  const monitorLamp =
    !monitorEnabled
      ? 'red'
      : monitorHasError
        ? 'yellow'
        : hasAccount2 && !allMonitorClientsConnected
          ? anyMonitorClientConnected ? 'yellow' : 'yellow'
          : monitorOperator?.connected && (!hasAccount2 || monitorAccount2?.connected)
            ? 'green'
            : 'yellow'
  const suspendedInReasons = j?.health?.block_reasons?.includes('trading_suspended') ?? false
  const daemonSelfCheckText =
    DAEMON_SELF_CHECK_LABELS[j?.daemon?.self_check ?? ''] ?? j?.daemon?.self_check ?? '--'
  const hedgeSelfCheckText =
    (j?.health?.self_check ?? '--') + (suspendedInReasons ? ' (hedge suspended)' : '')
  const daemonBlockReasons = (j?.daemon?.block_reasons ?? [])
    .map((r) => DAEMON_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'
  const hedgeBlockReasons = (j?.health?.block_reasons ?? [])
    .map((r) => HEDGE_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'

  const monitorSelfCheckText =
    MONITOR_SELF_CHECK_LABELS[j?.monitor?.self_check ?? ''] ?? j?.monitor?.self_check ?? '--'
  const monitorBlockReasons = (j?.monitor?.block_reasons ?? [])
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

  const {
    celeryBrokerConnected,
    celeryLastTs,
    celeryWorkerIbConnected,
    celeryWorkerIbClientId,
    celeryWorkersAlive,
    celeryLamp,
  } = celeryMetricsFromStatus(j)

  const healthElapsedSec = lastHealthAt != null ? Math.floor(Date.now() / 1000 - lastHealthAt) : null
  const healthCountdownSec =
    lastHealthAt != null ? Math.max(0, 60 - (healthElapsedSec! % 60)) : null
  const apiHealthLamp = lastHealthAt != null ? 'green' : 'red'

  const runStatusLabel = suspended ? 'Suspended (no new hedges)' : 'Running'
  const heartbeatGroupLamp = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  // Daemon IB Connection: green = both Listener Host and Secondary connected; yellow = at least one of (Host, Secondary, Trading) connected; red = neither listener connected.
  const listenerHost = hb?.listener_connected === true
  const listenerSecondary = hb?.listener_2_connected === true
  const ibGroupLamp: 'green' | 'yellow' | 'red' | 'none' =
    !hb?.daemon_alive
      ? 'none'
      : listenerHost && listenerSecondary
        ? 'green'
        : !listenerHost && !listenerSecondary
          ? 'red'
          : 'yellow'
  // Red: daemon heartbeat red (no hb or !daemon_alive). Yellow: daemon running but strategy suspended. Green: mock mode or live running.
  const tradingStrategyLamp: 'green' | 'yellow' | 'red' | 'none' =
    !hb || !hb.daemon_alive ? 'red' : suspended ? 'yellow' : 'green'
  const eventSubscribeLamp: 'green' | 'yellow' | 'red' =
    !hb?.daemon_alive
      ? 'red'
      : (() => {
          const tickerOk = hb.event_subscribe_ticker
          const positionsOk = hb.event_subscribe_positions
          const fillsOk = hb.event_subscribe_fills
          const commissionOk = hb.event_subscribe_commission
          const allOk = tickerOk && positionsOk && fillsOk && commissionOk
          const anyOk = tickerOk || positionsOk || fillsOk || commissionOk
          return allOk ? 'green' : anyOk ? 'yellow' : 'red'
        })()
  /** Event lamp: green when Trading Strategy running (green) and Event Subscribe green; red when Trading Strategy or Event Subscribe red; else yellow. */
  const strategyGroupLamp: 'green' | 'yellow' | 'red' | 'none' =
    tradingStrategyLamp === 'green' && eventSubscribeLamp === 'green'
      ? 'green'
      : tradingStrategyLamp === 'red' || eventSubscribeLamp === 'red'
        ? 'red'
        : 'yellow'

  /** Daemon status: all green → green; any yellow → yellow; all red (or any red when no yellow) → red. Treat 'none' as red. */
  const daemonLamp: 'green' | 'yellow' | 'red' | 'none' = (() => {
    const asRedYellowGreen = (v: string): 'green' | 'yellow' | 'red' => (v === 'none' ? 'red' : v as 'green' | 'yellow' | 'red')
    const h = asRedYellowGreen(heartbeatGroupLamp)
    const i = asRedYellowGreen(ibGroupLamp)
    const e = asRedYellowGreen(strategyGroupLamp)
    if (h === 'green' && i === 'green' && e === 'green') return 'green'
    if (h === 'yellow' || i === 'yellow' || e === 'yellow') return 'yellow'
    return 'red'
  })()

  /** System status (for "System Status" heading): same logic as header — red if any red; yellow if any yellow; green only when all green. */
  const systemLamp: 'green' | 'yellow' | 'red' | 'none' = (() => {
    const asRyg = (v: string): 'green' | 'yellow' | 'red' => (v === 'none' ? 'red' : v as 'green' | 'yellow' | 'red')
    const d = asRyg(daemonLamp)
    const m = asRyg(monitorLamp)
    const c = asRyg(celeryLamp)
    if (d === 'red' || m === 'red' || c === 'red') return 'red'
    if (d === 'yellow' || m === 'yellow' || c === 'yellow') return 'yellow'
    return d === 'green' && m === 'green' && c === 'green' ? 'green' : 'red'
  })()

  const s = j?.daemon?.trading?.auto_status ?? {}
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

  /** Stop Daemon, then management Server (monitor). */
  const doShutdownAll = async () => {
    setShutdownConfirmOpen(false)
    setShutdownAllLoading(true)
    const errors: string[] = []
    try {
      setShutdownAllMsg({ text: 'Stopping Daemon…', isErr: false })
      const r1 = await postStop()
      if (!r1.ok) errors.push(`Daemon: ${r1.error ?? r1.statusText ?? 'failed'}`)
      setShutdownAllMsg({ text: 'Stopping Server…', isErr: false })
      const r2 = await postMonitorStop()
      if (!r2.ok) errors.push(`Server: ${r2.error ?? r2.statusText ?? 'failed'}`)
      setShutdownAllMsg({
        text: errors.length === 0 ? 'All systems shut down.' : `Shut down requested; some failed: ${errors.join('; ')}`,
        isErr: errors.length > 0,
      })
      // Do not call loadStatus() after Server stop: the server process exits, so the request would hang.
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
              Daemon, then Server (management monitor) will be stopped in order. This cannot be undone.
            </p>
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShutdownConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="section-header-icon-btn" onClick={doShutdownAll} aria-label="Confirm shutdown">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                  <line x1="12" y1="2" x2="12" y2="12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <>
      {showSystemSection && (
      <div className="card process-section system-tabs-wrapper">
        <div className="status-section-heading-row">
          <h2 className="status-section-heading page-title-with-tooltip">
            <span className={`title-inline-lamp lamp-icon ${systemLamp}`} title="System status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </span>
            System Status
          </h2>
          <div className="status-section-actions">
            <button
              type="button"
              className="section-header-icon-btn"
              title="Stop Daemon, then Server (in order)"
              aria-label="Shutdown entire system"
              disabled={shutdownAllLoading}
              onClick={onShutdownAllClick}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
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
            <span className={`title-inline-lamp lamp-icon ${daemonLamp}`} title="Daemon status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
            </span>
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
            <span className={`title-inline-lamp lamp-icon ${monitorLamp}`} title="Server status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </span>
            <span>Server</span>
            {celeryUiMode !== 'relocated' ? (
              <>
                <span className="status-tab-sep" aria-hidden>/</span>
                <span className={`title-inline-lamp lamp-icon ${celeryLamp}`} title="Celery (bars worker) status" aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                </span>
                <span>Celery</span>
              </>
            ) : null}
          </button>
        </div>
        )}

        <div className={`system-tab-content ${showAllSystemSections ? 'system-stack' : ''}`}>
        {(showAllSystemSections || systemTab === 'daemon') && (
          <div
            id="system-section-daemon"
            className={`status-panel-section status-panel-section-daemon ${highlightSection === 'daemon' ? 'system-section-highlight' : ''}`}
          >
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
              ibConfig={j?.config?.ib_client}
              onStop={() => runCtrlAction(postStop, { loading: 'Requesting daemon stop…', success: 'Stop sent; daemon will exit and clear ib_client_id; next start uses client_id=1.' })}
              onReleaseIb={() => runCtrlAction(postReleaseIb, { loading: 'Requesting release IB…', success: 'Reset sent. Daemon will release both Trading and Listener IB connections on its next heartbeat, then enter WAITING_IB (daemon keeps running). Use «Retry IB connection» below to reconnect when ready.' })}
              ctrlMsg={ctrlMsg}
              className={showAllSystemSections ? 'system-stack-section' : undefined}
            />
          </div>
        )}

        {(showAllSystemSections || systemTab === 'monitor' || systemTab === 'celery') && (
          <div
            className={`status-management-celery-row ${celeryUiMode === 'relocated' ? 'status-management-celery-row--monitor-only' : ''}`}
            id="system-panel-monitor-celery"
            role="tabpanel"
            aria-labelledby="tab-monitor-celery"
          >
            <div
              id="system-section-monitor"
              className={`status-panel-section status-management-celery-col status-management-celery-col-management ${highlightSection === 'monitor' ? 'system-section-highlight' : ''}`}
            >
              <StatusMonitorPanel
                status={j}
                monitorLamp={monitorLamp}
                monitorEnabled={monitorEnabled}
                monitorSelfCheckText={monitorSelfCheckText}
                monitorBlockReasons={monitorBlockReasons}
                apiHealthLamp={apiHealthLamp}
                healthCountdownSec={healthCountdownSec}
                monitorIbGroupLamp={monitorIbGroupLamp}
                monitorOperator={monitorOperator}
                monitorAccount2={monitorAccount2}
                onMonitorStop={() => runMonitorStopAction(postMonitorStop, { loading: 'Stopping monitor service…', success: 'Monitor service stopped (no new IB requests). Server has exited; refresh the page after restarting it.' })}
                onMonitorConnect={() => runMonitorAction(postMonitorConnect, { loading: 'Establishing monitor IB connection…', success: 'Monitor IB connect requested (Operator + Secondary if configured); check status bar for result.' })}
                onMonitorReleaseIb={() => runMonitorAction(postMonitorReleaseIb, { loading: 'Releasing monitor IB connections…', success: 'Monitor IB connections released (Operator + Secondary if configured). Use Connect to reconnect.' })}
                monitorCtrlMsg={monitorCtrlMsg}
                className={showAllSystemSections ? 'system-stack-section' : undefined}
              />
            </div>
            {celeryUiMode !== 'relocated' ? (
              <div
                id="system-section-celery"
                className={`status-panel-section status-management-celery-col status-management-celery-col-celery ${highlightSection === 'celery' ? 'system-section-highlight' : ''}`}
              >
                <StatusCeleryPanel
                  status={j}
                  celeryLamp={celeryLamp}
                  celeryBrokerConnected={celeryBrokerConnected}
                  celeryWorkersAlive={celeryWorkersAlive}
                  celeryLastTs={celeryLastTs}
                  celeryWorkerIbConnected={celeryWorkerIbConnected}
                  celeryWorkerIbClientId={celeryWorkerIbClientId}
                  className={showAllSystemSections ? 'system-stack-section' : undefined}
                />
              </div>
            ) : null}
          </div>
        )}
        </div>
      </div>
      )}

      {/* Stream Event — Trading Strategy + Event Subscribe, same row style as Server/Celery (above Console) */}
      {showConsoleSection && (
      <div className="card process-section system-tabs-wrapper stream-event-card">
        <div className="status-section-heading-row">
          <h2 className="status-section-heading">Daemon Event</h2>
        </div>
        <div className="status-management-celery-row stream-event-row">
          <div className="status-panel-section status-management-celery-half stream-event-strategy-quarter">
            <StatusStrategyPanel
              compact
              status={j}
              hedgeLamp={tradingStrategyLamp}
              hedgeLabel={hedgeLabel}
              hedgeSelfCheckText={hedgeSelfCheckText}
              hedgeBlockReasons={hedgeBlockReasons}
              hedgeHint={hedgeHint}
              statusSummaryItems={statusSummaryItems}
              onFlatten={() => runHedgeAction(postFlatten, { loading: 'Requesting flatten…', success: 'Flatten sent; hedge process will consume and execute.' })}
              hedgeCtrlMsg={hedgeCtrlMsg}
              suspended={suspended}
              onSuspend={() => runCtrlAction(postSuspend, { loading: 'Setting suspend…', success: 'Suspend set; daemon will pause new hedges on next heartbeat.' })}
              onResume={() => runCtrlAction(postResume, { loading: 'Setting resume…', success: 'Resume set; daemon will resume hedging on next heartbeat.' })}
              activeStructureName={status?.strategy?.active?.structure?.name}
              activeGateSafetyName={status?.strategy?.active?.gate_safety?.name}
              onManage={onNavigateToStrategy}
            />
          </div>
          <div className="status-panel-section status-management-celery-half stream-event-subscribe-rest card-event-subscribe event-subscribe-section">
            <div className="event-subscribe-header-row">
              <h2 className="daemon-card-title page-title-with-tooltip" style={{ margin: 0 }}>
                <span className={`title-inline-lamp lamp-icon ${eventSubscribeLamp}`} title="Event Subscribe: green = all subscribed, yellow = some not, red = none or daemon down" aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                </span>
                Event Subscribe
                <InfoTooltip text="Daemon IB event subscription status and subscribed tickers (Watchlist STK + strategy symbol)." />
              </h2>
              <div className="event-subscribe-buttons">
                <button
                  type="button"
                  className="section-header-icon-btn"
                  title="Release all Real-time ticker subscriptions; daemon will restore on next heartbeat"
                  aria-label="Release ticker subscriptions"
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
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18.84 12.25l1.72-1.71h-.02a3 3 0 0 0-.12-4.26 3 3 0 0 0-4.24-.12l-1.72 1.71" />
                    <path d="M5.17 11.75l-1.71 1.71a3 3 0 0 0 .12 4.26 3 3 0 0 0 4.24.12l1.71-1.71" />
                    <path d="M8 2v4M2 8h4M16 20v-4M20 16h-4" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="event-subscribe-body">
            {(() => {
              const hasSecondary = !!(
                j?.config?.ib_client?.client?.secondary_host_ip ?? j?.config?.ib_client?.port?.listener_secondary != null
              )
              return (
            <table className="table-operations table-event-subscribe table-event-subscribe-horizontal">
              <thead>
                <tr>
                  <th className="event-subscribe-col-subscription">Subscription</th>
                  <th className="event-subscribe-col-account">Host account</th>
                  {hasSecondary && <th className="event-subscribe-col-account">Secondary account</th>}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="event-subscribe-col-subscription">Real-time ticker (Host only)</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <span className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Real-time ticker (Host only)" aria-hidden>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                      </span>
                      <span
                        className="event-subscribe-status-text"
                        title={hb?.daemon_alive && hb?.event_subscribe_ticker && (j?.live_ui?.subscribed_tickers?.length ?? 0) > 0
                          ? `Subscribed symbols: ${(j?.live_ui?.subscribed_tickers ?? []).join(', ')}`
                          : undefined}
                      >
                        {hb?.daemon_alive && hb?.event_subscribe_ticker
                          ? (
                              <>
                                <span className="countdown-num">{j?.live_ui?.subscribed_tickers?.length ?? 0}</span>
                                {' ticker'}{(j?.live_ui?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'}
                              </>
                            )
                          : hb?.daemon_alive
                            ? 'Not subscribed'
                            : '—'}
                      </span>
                    </div>
                  </td>
                  {hasSecondary && (
                    <td>
                      <span className="event-subscribe-status-text event-subscribe-no-need">No need</span>
                    </td>
                  )}
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Open orders</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <span
                        className={`title-inline-lamp lamp-icon ${!hb?.daemon_alive ? 'red' : hostOpenOrderCount > 0 ? 'green' : 'none'}`}
                        title={hb?.daemon_alive ? (hostOpenOrderCount > 0 ? 'Open orders (Host)' : 'No open orders (Host)') : 'Daemon down'}
                        aria-hidden
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                      </span>
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive
                          ? (
                              <>
                                <span className="countdown-num">{hostOpenOrderCount}</span>
                                {' open order'}{hostOpenOrderCount === 1 ? '' : 's'}
                              </>
                            )
                          : '—'}
                      </span>
                    </div>
                  </td>
                  {hasSecondary && (
                    <td>
                      <div className="event-subscribe-status-cell">
                        <span
                          className={`title-inline-lamp lamp-icon ${!hb?.daemon_alive ? 'red' : secondaryOpenOrderCount > 0 ? 'green' : 'none'}`}
                          title={hb?.daemon_alive ? (secondaryOpenOrderCount > 0 ? 'Open orders (Secondary)' : 'No open orders (Secondary)') : 'Daemon down'}
                          aria-hidden
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                        </span>
                        <span className="event-subscribe-status-text">
                          {hb?.daemon_alive
                            ? (
                                <>
                                  <span className="countdown-num">{secondaryOpenOrderCount}</span>
                                  {' open order'}{secondaryOpenOrderCount === 1 ? '' : 's'}
                                </>
                              )
                            : '—'}
                        </span>
                      </div>
                    </td>
                  )}
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Position updates</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <span className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.event_subscribe_positions ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Host position updates" aria-hidden>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                      </span>
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive && hb?.event_subscribe_positions ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                      </span>
                    </div>
                  </td>
                  {hasSecondary && (
                    <td>
                      <div className="event-subscribe-status-cell">
                        <span className={`title-inline-lamp lamp-icon ${hb?.listener_2_connected && hb?.event_subscribe_positions_ib2 ? 'green' : hb?.listener_2_connected ? 'red' : 'none'}`} title="Secondary position updates" aria-hidden>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                        </span>
                        <span className="event-subscribe-status-text">
                          {hb?.listener_2_connected && hb?.event_subscribe_positions_ib2 ? 'Subscribed' : hb?.listener_2_connected ? 'Not subscribed' : '—'}
                        </span>
                      </div>
                    </td>
                  )}
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Fill / execution report</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <span className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.event_subscribe_fills ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Host fill / execution" aria-hidden>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                      </span>
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive && hb?.event_subscribe_fills ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                      </span>
                    </div>
                  </td>
                  {hasSecondary && (
                    <td>
                      <div className="event-subscribe-status-cell">
                        <span className={`title-inline-lamp lamp-icon ${hb?.listener_2_connected && hb?.event_subscribe_fills_ib2 ? 'green' : hb?.listener_2_connected ? 'red' : 'none'}`} title="Secondary fill / execution" aria-hidden>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                        </span>
                        <span className="event-subscribe-status-text">
                          {hb?.listener_2_connected && hb?.event_subscribe_fills_ib2 ? 'Subscribed' : hb?.listener_2_connected ? 'Not subscribed' : '—'}
                        </span>
                      </div>
                    </td>
                  )}
                </tr>
                <tr>
                  <td className="event-subscribe-col-subscription">Commission report</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <span className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.event_subscribe_commission ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Host commission" aria-hidden>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                      </span>
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive && hb?.event_subscribe_commission ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                      </span>
                    </div>
                  </td>
                  {hasSecondary && (
                    <td>
                      <div className="event-subscribe-status-cell">
                        <span className={`title-inline-lamp lamp-icon ${hb?.listener_2_connected && hb?.event_subscribe_commission_ib2 ? 'green' : hb?.listener_2_connected ? 'red' : 'none'}`} title="Secondary commission" aria-hidden>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                        </span>
                        <span className="event-subscribe-status-text">
                          {hb?.listener_2_connected && hb?.event_subscribe_commission_ib2 ? 'Subscribed' : hb?.listener_2_connected ? 'Not subscribed' : '—'}
                        </span>
                      </div>
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
              )
            })()}
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
          {celeryUiMode !== 'relocated' ? (
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
          ) : null}
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
        {celeryUiMode !== 'relocated' && consoleTab === 'console' && (
          <div id="celery-section-panel-console" role="tabpanel" aria-labelledby="celery-tab-console"
            style={{ marginTop: 'var(--space-3)' }}
          >
            {celeryWorkerBindings.workerIds.length > 1 && (
              <div className="celery-worker-log-picker" style={{ marginBottom: '0.75rem' }}>
                <label htmlFor="status-page-worker-log-select" className="section-hint" style={{ marginRight: '0.5rem' }}>
                  Log for
                </label>
                <select
                  id="status-page-worker-log-select"
                  style={{ minWidth: '14rem', maxWidth: '100%' }}
                  value={celeryWorkerBindings.selectedWorkerId ?? ''}
                  onChange={e => celeryWorkerBindings.setSelectedWorkerId(e.target.value)}
                >
                  {celeryWorkerBindings.workerIds.map(id => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <LogConsolePanel
              controller={celeryConsole}
              loadingText="Connecting…"
              errorText="Unable to load (Redis/Celery broker may be down)."
              emptyText="No log lines yet. Start Worker: python scripts/run_celery.py"
              infoTooltipText="Per-worker Worker log (Redis Stream). Run `python scripts/run_celery.py` to see output."
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

