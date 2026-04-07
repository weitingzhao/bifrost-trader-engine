import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import {
  postSuspend,
  postResume,
  postFlatten,
  postReleaseIb,
  postStop,
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
import { useControlAction } from './status/useControlAction'
import { StatusDaemonPanel, StatusStrategyPanel } from './status/panels'
import { computeEventSubscribeLamp } from './status/ibEventSubscribeLamp'

export interface DaemonStatusPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations?: Operation[]
  onNavigateToStrategy?: () => void
  embeddedInSettings?: boolean
}

export function DaemonStatusPage({
  status,
  loadStatus,
  operations = [],
  onNavigateToStrategy,
  embeddedInSettings,
}: DaemonStatusPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const deferredStart = useDeferredStart()
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const eventSubscribeLamp = computeEventSubscribeLamp(hb)
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

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'daemon-status-page daemon-status-page--embedded' : 'daemon-status-page'}`}>
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
              <InfoTooltip text="Trading strategy status. IB event subscription detail is under Settings → Subscribe (IB Event Subscribe)." />
            </h3>
          </div>
          <div className="status-management-celery-row status-management-celery-row--monitor-only">
            <div className="status-panel-section status-management-celery-half">
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
