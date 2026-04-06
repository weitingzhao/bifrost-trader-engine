import { useCallback, useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import {
  postSuspend,
  postResume,
  postFlatten,
  postReleaseIb,
  postStop,
  postReleaseTickerSubscriptions,
  fetchDaemonLogs,
  subscribeDaemonLogs,
  clearDaemonLogs,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'
import { fmtTs, fmtUsd } from '../utils/format'
import {
  DAEMON_REASON_LABELS,
  DAEMON_SELF_CHECK_LABELS,
  DAEMON_STATE_LABELS,
  STATUS_FIELDS,
} from './status/statusLabels'
import { scheduleMsgClear, setMsg } from './status/messageUtils'
import { useControlAction } from './status/useControlAction'
import { StatusDaemonPanel, StatusStrategyPanel } from './status/panels'

export interface DaemonStatusPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations?: Operation[]
  onNavigateToStrategy?: () => void
  embeddedInSettings?: boolean
  breadcrumbLabel?: string
}

export function DaemonStatusPage({
  status,
  loadStatus,
  operations = [],
  onNavigateToStrategy,
  embeddedInSettings,
  breadcrumbLabel = 'Daemon',
}: DaemonStatusPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [releaseTickerLoading, setReleaseTickerLoading] = useState(false)
  const [syncTickerMsg, setSyncTickerMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const deferredStart = useDeferredStart()
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTickerMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const daemonConsole = useLogConsole({
    fetchLogs: fetchDaemonLogs,
    subscribeLogs: subscribeDaemonLogs,
    clearLogs: clearDaemonLogs,
    enabled: deferredStart,
  })

  const runCtrlAction = useControlAction(setCtrlMsg, ctrlMsgClearRef, { onSuccess: loadStatus })
  const runHedgeAction = useControlAction(setHedgeCtrlMsg, hedgeCtrlMsgClearRef)

  useEffect(() => {
    return () => {
      if (ctrlMsgClearRef.current != null) clearTimeout(ctrlMsgClearRef.current)
      if (hedgeCtrlMsgClearRef.current != null) clearTimeout(hedgeCtrlMsgClearRef.current)
      if (syncTickerMsgClearRef.current != null) clearTimeout(syncTickerMsgClearRef.current)
    }
  }, [])

  const j = status
  const hb = j?.daemon?.heartbeat
  const intervalSec = hb?.heartbeat_interval_sec ?? 10
  const nowSec = Date.now() / 1000
  void tick

  const secondsUntilNextHeartbeat =
    hb?.daemon_alive && hb?.last_ts != null
      ? Math.max(0, Math.ceil(hb.last_ts + intervalSec - nowSec))
      : null

  useEffect(() => {
    if (!hb?.daemon_alive) return
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [hb?.daemon_alive])

  const suspended = j?.daemon?.trading?.trading_suspended === true
  const ibConnected = hb?.ib_connected === true
  const streamHostAccountId = (j?.config?.ib_client?.account?.event_host ?? '').toString().trim()
  const streamSecondaryAccountId = (j?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
  const openOrdersList = j?.portfolio?.open_orders ?? []
  const hostOpenOrderCount = streamHostAccountId
    ? openOrdersList.filter(o => (o.account_id ?? '').toString().trim() === streamHostAccountId).length
    : openOrdersList.length
  const secondaryOpenOrderCount = streamSecondaryAccountId
    ? openOrdersList.filter(o => (o.account_id ?? '').toString().trim() === streamSecondaryAccountId).length
    : 0

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

  const suspendedInReasons = j?.daemon?.block_reasons?.includes('trading_suspended') ?? false
  const daemonSelfCheckText =
    DAEMON_SELF_CHECK_LABELS[j?.daemon?.self_check ?? ''] ?? j?.daemon?.self_check ?? '--'
  const hedgeSelfCheckText =
    daemonSelfCheckText + (suspendedInReasons ? ' (hedge suspended)' : '')
  const daemonBlockReasons = (j?.daemon?.block_reasons ?? [])
    .map(r => DAEMON_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'
  const hedgeBlockReasons = (j?.daemon?.block_reasons ?? [])
    .map(r => DAEMON_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'

  const runStatusLabel = suspended ? 'Suspended (no new hedges)' : 'Running'
  const heartbeatGroupLamp = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
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
  const tradingStrategyLamp: 'green' | 'yellow' | 'red' | 'none' =
    !hb || !hb.daemon_alive ? 'red' : suspended ? 'yellow' : 'green'
  const eventSubscribeLamp: 'green' | 'yellow' | 'red' =
    !hb?.daemon_alive
      ? 'red'
      : (() => {
          const allOk = hb.event_subscribe_ticker && hb.event_subscribe_positions && hb.event_subscribe_fills && hb.event_subscribe_commission
          const anyOk = hb.event_subscribe_ticker || hb.event_subscribe_positions || hb.event_subscribe_fills || hb.event_subscribe_commission
          return allOk ? 'green' : anyOk ? 'yellow' : 'red'
        })()
  const strategyGroupLamp: 'green' | 'yellow' | 'red' | 'none' =
    tradingStrategyLamp === 'green' && eventSubscribeLamp === 'green'
      ? 'green'
      : tradingStrategyLamp === 'red' || eventSubscribeLamp === 'red'
        ? 'red'
        : 'yellow'
  const daemonLamp: 'green' | 'yellow' | 'red' | 'none' = (() => {
    const asRyg = (v: string): 'green' | 'yellow' | 'red' => (v === 'none' ? 'red' : v as 'green' | 'yellow' | 'red')
    const h = asRyg(heartbeatGroupLamp)
    const i = asRyg(ibGroupLamp)
    const e = asRyg(strategyGroupLamp)
    if (h === 'green' && i === 'green' && e === 'green') return 'green'
    if (h === 'yellow' || i === 'yellow' || e === 'yellow') return 'yellow'
    return 'red'
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

  const onReleaseTickers = useCallback(async () => {
    setReleaseTickerLoading(true)
    try {
      const res = await postReleaseTickerSubscriptions()
      if (res.ok) {
        setMsg(setSyncTickerMsg, 'Released; restoring on next heartbeat', false)
        scheduleMsgClear(setSyncTickerMsg, syncTickerMsgClearRef)
        setTimeout(() => loadStatus(), 1500)
      }
      if (!res.ok && res.error) setMsg(setSyncTickerMsg, res.error, true)
    } finally {
      setReleaseTickerLoading(false)
    }
  }, [loadStatus])

  const hasSecondary = !!(
    j?.config?.ib_client?.client?.secondary_host_ip ?? j?.config?.ib_client?.port?.listener_secondary != null
  )

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'daemon-status-page daemon-status-page--embedded' : 'daemon-status-page'}`}>
      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            {breadcrumbLabel}
            <InfoTooltip text="Daemon process status, IB connections, trading strategy, event subscriptions, and daemon log console." />
          </h2>
          <p className="settings-page-subtitle">
            Heartbeat, IB connections, trading strategy, event subscriptions, and daemon console.
          </p>
        </div>
      </div>

      <div className="daemon-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="daemon-panel-head">
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
            onReleaseIb={() => runCtrlAction(postReleaseIb, { loading: 'Requesting release IB…', success: 'Reset sent. Daemon will release both Trading and Listener IB connections on its next heartbeat, then enter WAITING_IB.' })}
            ctrlMsg={ctrlMsg}
          />
        </section>

        <section className="replay-section" aria-label="Daemon Event">
          <div className="status-section-heading-row" style={{ marginBottom: 'var(--space-3)' }}>
            <h3 className="page-title-with-tooltip">
              Daemon Event
              <InfoTooltip text="Trading strategy status and IB event subscriptions (tickers, positions, fills, commissions)." />
            </h3>
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
                  <span className={`title-inline-lamp lamp-icon ${eventSubscribeLamp}`} title="Event Subscribe" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                  </span>
                  Event Subscribe
                  <InfoTooltip text="Daemon IB event subscription status and subscribed tickers." />
                </h2>
                <div className="event-subscribe-buttons">
                  <button
                    type="button"
                    className="section-header-icon-btn"
                    title="Release all ticker subscriptions; daemon restores on next heartbeat"
                    aria-label="Release ticker subscriptions"
                    disabled={releaseTickerLoading || !hb?.daemon_alive}
                    onClick={onReleaseTickers}
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
                          <span className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} aria-hidden>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                          </span>
                          <span className="event-subscribe-status-text"
                            title={hb?.daemon_alive && hb?.event_subscribe_ticker && (j?.live_ui?.subscribed_tickers?.length ?? 0) > 0
                              ? `Subscribed symbols: ${(j?.live_ui?.subscribed_tickers ?? []).join(', ')}` : undefined}
                          >
                            {hb?.daemon_alive && hb?.event_subscribe_ticker
                              ? <><span className="countdown-num">{j?.live_ui?.subscribed_tickers?.length ?? 0}</span>{' ticker'}{(j?.live_ui?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'}</>
                              : hb?.daemon_alive ? 'Not subscribed' : '—'}
                          </span>
                        </div>
                      </td>
                      {hasSecondary && <td><span className="event-subscribe-status-text event-subscribe-no-need">No need</span></td>}
                    </tr>
                    <tr>
                      <td className="event-subscribe-col-subscription">Open orders</td>
                      <td>
                        <div className="event-subscribe-status-cell">
                          <span className={`title-inline-lamp lamp-icon ${!hb?.daemon_alive ? 'red' : hostOpenOrderCount > 0 ? 'green' : 'none'}`} aria-hidden>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                          </span>
                          <span className="event-subscribe-status-text">
                            {hb?.daemon_alive ? <><span className="countdown-num">{hostOpenOrderCount}</span>{' open order'}{hostOpenOrderCount === 1 ? '' : 's'}</> : '—'}
                          </span>
                        </div>
                      </td>
                      {hasSecondary && (
                        <td>
                          <div className="event-subscribe-status-cell">
                            <span className={`title-inline-lamp lamp-icon ${!hb?.daemon_alive ? 'red' : secondaryOpenOrderCount > 0 ? 'green' : 'none'}`} aria-hidden>
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                            </span>
                            <span className="event-subscribe-status-text">
                              {hb?.daemon_alive ? <><span className="countdown-num">{secondaryOpenOrderCount}</span>{' open order'}{secondaryOpenOrderCount === 1 ? '' : 's'}</> : '—'}
                            </span>
                          </div>
                        </td>
                      )}
                    </tr>
                    {(['positions', 'fills', 'commission'] as const).map(kind => {
                      const labels: Record<string, string> = { positions: 'Position updates', fills: 'Fill / execution report', commission: 'Commission report' }
                      const hostKey = `event_subscribe_${kind}` as keyof typeof hb
                      const secKey = `event_subscribe_${kind}_ib2` as keyof typeof hb
                      return (
                        <tr key={kind}>
                          <td className="event-subscribe-col-subscription">{labels[kind]}</td>
                          <td>
                            <div className="event-subscribe-status-cell">
                              <span className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.[hostKey] ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} aria-hidden>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                              </span>
                              <span className="event-subscribe-status-text">
                                {hb?.daemon_alive && hb?.[hostKey] ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                              </span>
                            </div>
                          </td>
                          {hasSecondary && (
                            <td>
                              <div className="event-subscribe-status-cell">
                                <span className={`title-inline-lamp lamp-icon ${hb?.listener_2_connected && hb?.[secKey] ? 'green' : hb?.listener_2_connected ? 'red' : 'none'}`} aria-hidden>
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                                </span>
                                <span className="event-subscribe-status-text">
                                  {hb?.listener_2_connected && hb?.[secKey] ? 'Subscribed' : hb?.listener_2_connected ? 'Not subscribed' : '—'}
                                </span>
                              </div>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {syncTickerMsg.text ? (
                  <div className={`msg ${syncTickerMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>{syncTickerMsg.text}</div>
                ) : null}
                {hb?.last_control_message ? (
                  <div className="msg err" style={{ marginTop: '0.5rem' }} role="alert">{hb.last_control_message}</div>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="daemon-console-head">
          <h3 id="daemon-console-head" className="page-title-with-tooltip">
            Daemon log
            <InfoTooltip text="Real-time daemon log (Redis stream). Start daemon: python scripts/run_engine.py" />
          </h3>
          <LogConsolePanel
            controller={daemonConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down)."
            emptyText="No log lines yet. Start daemon: python scripts/run_engine.py"
            infoTooltipText="Real-time daemon log (Redis Stream)."
            resizeAriaLabel="Resize daemon console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </section>

        <section className="replay-section" aria-labelledby="daemon-ops-head">
          <h3 id="daemon-ops-head" className="page-title-with-tooltip">
            Recent operations
            <InfoTooltip text="Recent automated trading operations executed by the daemon." />
          </h3>
          <div className="table-scroll-x">
            <table className="table-operations">
              <thead>
                <tr>
                  <th>Time</th><th>Type</th><th>Side</th><th>Qty</th><th>Price</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {operations.length === 0 ? (
                  <tr><td colSpan={6}>None</td></tr>
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
        </section>
      </div>
    </div>
  )
}
