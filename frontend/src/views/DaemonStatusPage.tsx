import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { AggregatedLogConsolePanel } from '../components/AggregatedLogConsolePanel'
import {
  DAEMON_PAGE_LOG_SOURCE_DEFINITIONS,
  useDaemonPageUnifiedLogConsole,
} from '../components/useDaemonPageUnifiedLogConsole'
import { useDeferredStart } from '../hooks/useDeferredStart'
import { computeAccountSyncLamp } from '../utils/livePageLamps'
import { fmtTs, fmtUsd } from '../utils/format'
import {
  DAEMON_REASON_LABELS,
  DAEMON_SELF_CHECK_LABELS,
  DAEMON_STATE_LABELS,
  formatDaemonBlockReasonsCompact,
  STATUS_FIELDS,
} from './status/statusLabels'
import { useControlAction } from './status/useControlAction'
import { IbBrokerServiceLamp, StatusDaemonPanel, StatusStrategyPanel } from './status/panels'
import {
  accountSyncLampToBrokerRowLamp,
  computeAccountSyncIbGroupLamp,
  computeIbBrokerGroupLamp,
  ingestLampToBrokerRowLamp,
} from './status/daemonIbBrokerLamp'
import { ingestRedisHealthLamp } from '../utils/socketIngestLamp'
import { DaemonEngineOpsSection } from './DaemonEngineOpsSection'

/** Same stroke lamp as Strategy Trading Daemon Heartbeat / IB broker groups (StatusDaemonPanel). */
const ACCOUNT_SYNC_GROUP_LAMP_SVG = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 12h-4l-3 9L9 3 6 12H2" />
  </svg>
)

export interface DaemonStatusPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations?: Operation[]
  onNavigateToStrategy?: () => void
  onNavigateToSocket?: () => void
  embeddedInSettings?: boolean
}

export function DaemonStatusPage({
  status,
  loadStatus,
  operations = [],
  onNavigateToStrategy,
  onNavigateToSocket,
  embeddedInSettings,
}: DaemonStatusPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const deferredStart = useDeferredStart()
  const ctrlMsgClearRef = useRef<number | null>(null)
  const hedgeCtrlMsgClearRef = useRef<number | null>(null)
  const daemonUnifiedLogConsole = useDaemonPageUnifiedLogConsole({
    enabled: deferredStart,
    initialHeightPx: 280,
    initialMaxLines: 500,
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

  const asdHeart = (j as {
    account_sync_daemon?: {
      heartbeat?: {
        daemon_alive?: boolean
        last_ts?: number
        heartbeat_interval_sec?: number
        stream_lag?: number
        last_sync_version?: number
        accounts_synced?: number
        positions_synced?: number
        executions_synced?: number
        open_orders_synced?: number
      }
    }
  } | null)?.account_sync_daemon?.heartbeat
  const asIntervalSec =
    typeof asdHeart?.heartbeat_interval_sec === 'number' && Number.isFinite(asdHeart.heartbeat_interval_sec)
      ? Math.max(2, Math.min(120, asdHeart.heartbeat_interval_sec))
      : 5
  const secondsUntilNextAccountSyncHb =
    asdHeart?.daemon_alive && asdHeart?.last_ts != null
      ? Math.max(0, Math.ceil(asdHeart.last_ts + asIntervalSec - nowSec))
      : null

  useEffect(() => {
    const needTick = Boolean(hb?.daemon_alive) || Boolean(asdHeart?.daemon_alive)
    if (!needTick) return
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [hb?.daemon_alive, asdHeart?.daemon_alive])

  const suspended = j?.daemon?.trading?.trading_suspended === true
  let daemonLabel = 'Not running (or single-process mode)'
  let daemonHint = 'Run run_engine.py on the trading machine to see "Running" here'
  const autoSt = j?.daemon?.trading?.auto_status
  let hedgeLabel = (autoSt?.ts != null && nowSec - (autoSt.ts as number) < 90) ? 'Running (single-process)' : 'Not running'
  let hedgeHint = (autoSt?.ts != null && nowSec - (autoSt.ts as number) < 90)
    ? 'Single-process mode (run_engine.py); status written by hedge logic'
    : ''
  if (hb?.daemon_alive) {
    daemonLabel = 'Running'
    daemonHint = hb.last_ts != null ? `Last heartbeat: ${fmtTs(hb.last_ts)}` : ''
    hedgeLabel = hb.hedge_running ? 'Running' : 'Suspended (or not started)'
    hedgeHint = hb.hedge_running
      ? 'Single-process: daemon and hedge in same process'
      : 'Click "Resume" on monitor to resume'
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
  const hedgeBlockReasonsCompact = formatDaemonBlockReasonsCompact(j?.daemon?.block_reasons)

  /** One-word / token status for Trading Strategy compact strip. */
  let hedgeStatusCompact: string
  if (!j) {
    hedgeStatusCompact = '—'
  } else if (hb?.daemon_alive) {
    hedgeStatusCompact = hb.hedge_running ? 'Run' : 'Pause'
  } else if (hb) {
    hedgeStatusCompact = 'Down'
  } else {
    hedgeStatusCompact =
      autoSt?.ts != null && nowSec - (autoSt.ts as number) < 90 ? '1-proc' : 'Down'
  }

  const heartbeatGroupLamp = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const { lamp: ibGroupLamp, title: ibGroupTitle } = computeIbBrokerGroupLamp(j, hb)
  const tradingStrategyLamp: 'green' | 'yellow' | 'red' | 'none' =
    !hb || !hb.daemon_alive ? 'red' : suspended ? 'yellow' : 'green'
  const strategyGroupLamp: 'green' | 'yellow' | 'red' | 'none' = tradingStrategyLamp
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
        <DaemonEngineOpsSection status={j} loadStatus={loadStatus} />

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
            ibGroupTitle={ibGroupTitle}
            secondsUntilNextHeartbeat={secondsUntilNextHeartbeat}
            strategyPanel={(
              <StatusStrategyPanel
                compact
                status={j}
                hedgeLamp={tradingStrategyLamp}
                hedgeLabel={hedgeLabel}
                hedgeSelfCheckText={hedgeSelfCheckText}
                hedgeBlockReasons={hedgeBlockReasons}
                hedgeStatusCompact={hedgeStatusCompact}
                hedgeBlockReasonsCompact={hedgeBlockReasonsCompact}
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
            )}
            onNavigateToSocket={onNavigateToSocket}
            ctrlMsg={ctrlMsg}
          />
        </section>

        {(() => {
          const asdHb = asdHeart
          const asdL = computeAccountSyncLamp(status)
          const aaLamp = ingestRedisHealthLamp('ib_account_agent', status)
          const syncPathLamp = computeAccountSyncLamp(status)
          const { lamp: ibAccountGroupLamp, title: ibAccountGroupTitle } = computeAccountSyncIbGroupLamp(status)
          return (
            <section className="replay-section" aria-labelledby="daemon-account-sync-head">
              <div className="daemon-header" style={{ marginBottom: 'var(--space-3)' }}>
                <div className="daemon-header-main daemon-header-with-lamp">
                  <div>
                    <h3 id="daemon-account-sync-head" className="page-title-with-tooltip">
                      <span className={`title-inline-lamp lamp-icon ${asdL.lamp}`} title={asdL.title} aria-hidden>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
                      </span>
                      Account Sync Daemon
                      <InfoTooltip text="Independent process (not the Strategy Trading Daemon). Syncs IB Account Agent stream to PostgreSQL. Liveness: PostgreSQL account_sync_heartbeat.last_ts refreshed each loop (~35s stale threshold), same idea as Strategy Trading Daemon heartbeat." />
                    </h3>
                    <div>
                      <strong>
                        Status:{' '}
                        {asdHb
                          ? (asdHb.daemon_alive ? 'Running (OK)' : 'Not running (heartbeat stale)')
                          : status ? 'No heartbeat row' : 'Fetch failed'}
                      </strong>
                      {asdHb && !asdHb.daemon_alive && (
                        <p className="section-hint section-hint--retry" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
                          Last DB heartbeat is older than ~35s, or Redis health shows down. Start the process (Ops above or manual script), then check PostgreSQL connectivity and IB Account Agent stream.
                        </p>
                      )}
                      {!asdHb && status ? (
                        <p className="section-hint" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
                          Start Account Sync Daemon from Ops (authenticated) or run{' '}
                          <code style={{ fontSize: '0.85em' }}>python scripts/systemd/run_account_sync_daemon.py --config …</code>
                          . Ensure <code>account_sync_heartbeat</code> exists and Redis hash <code>bifrost:health:daemon_account_sync</code> updates when running.
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="daemon-groups daemon-groups-layout daemon-groups-account-sync-layout">
                <div className="daemon-group daemon-group-heartbeat">
                  <div className="daemon-group-header">
                    <span className={`title-inline-lamp lamp-icon ${asdL.lamp}`} title={asdL.title} aria-hidden>
                      {ACCOUNT_SYNC_GROUP_LAMP_SVG}
                    </span>
                    <span className="daemon-group-title">Heartbeat</span>
                  </div>
                  <div className="daemon-group-body">
                    {asdHb?.daemon_alive && asdHb.last_ts != null ? (
                      <>
                        <p className="section-hint">
                          Last heartbeat: <strong>{fmtTs(asdHb.last_ts)}</strong>
                        </p>
                        {secondsUntilNextAccountSyncHb != null && (
                          <p className="section-hint countdown-line account-sync-next-hb-countdown">
                            Next heartbeat:{' '}
                            <span className="countdown-num">{secondsUntilNextAccountSyncHb}</span> s
                            <span className="account-sync-hb-interval-hint"> (interval {asIntervalSec}s from DB)</span>
                          </p>
                        )}
                      </>
                    ) : asdHb?.last_ts != null ? (
                      <p className="section-hint">
                        Last heartbeat: <strong>{fmtTs(asdHb.last_ts)}</strong> (timed out; start Account Sync Daemon or check Redis/PostgreSQL)
                      </p>
                    ) : asdHb ? (
                      <p className="section-hint">Heartbeat present but no timestamp — check PostgreSQL <code>account_sync_heartbeat</code>.</p>
                    ) : (
                      <p className="section-hint">
                        No heartbeat in GET /status yet (PostgreSQL <code>account_sync_heartbeat</code> or Redis <code>bifrost:health:daemon_account_sync</code>).
                      </p>
                    )}
                    {asdHb?.daemon_alive === true && (
                      <p className="section-hint" style={{ opacity: 0.85, fontSize: '0.8rem', marginTop: '0.35rem' }}>
                        Monitor marks the daemon down if last update is older than ~35s (same freshness idea as Strategy Trading Daemon).
                      </p>
                    )}
                  </div>
                </div>
                <div className="daemon-group daemon-group-ib">
                  <div className="daemon-group-header">
                    <span className={`title-inline-lamp lamp-icon ${ibAccountGroupLamp}`} title={ibAccountGroupTitle} aria-hidden>
                      {ACCOUNT_SYNC_GROUP_LAMP_SVG}
                    </span>
                    <span className="daemon-group-title">IB account</span>
                  </div>
                  <div className="daemon-group-body">
                    <table className="ib-connection-table" aria-label="IB account sync path services">
                      <thead>
                        <tr>
                          <th scope="col" className="ib-connection-th">Service</th>
                          <th scope="col" className="ib-connection-th">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <th scope="row" className="ib-connection-row-label">IB Account Agent</th>
                          <td className="ib-connection-cell ib-connection-cell--lamp">
                            <IbBrokerServiceLamp
                              lamp={ingestLampToBrokerRowLamp(aaLamp.lamp)}
                              title={aaLamp.title}
                            />
                          </td>
                        </tr>
                        <tr>
                          <th scope="row" className="ib-connection-row-label">Sync</th>
                          <td className="ib-connection-cell ib-connection-cell--lamp">
                            <IbBrokerServiceLamp
                              lamp={accountSyncLampToBrokerRowLamp(syncPathLamp.lamp)}
                              title={syncPathLamp.title}
                            />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <a
                      href="#settings-ws-connector"
                      className="daemon-ib-broker-socket-link section-hint"
                      onClick={e => {
                        if (onNavigateToSocket) {
                          e.preventDefault()
                          onNavigateToSocket()
                        }
                      }}
                    >
                      Open Socket services…
                    </a>
                  </div>
                </div>
                <div className="daemon-group daemon-group-account-sync-sync">
                  <div className="daemon-group-header">
                    <span className="daemon-group-title">Sync details</span>
                  </div>
                  <div className="daemon-group-body">
                    {asdHb ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem 1rem', fontSize: '0.85rem', lineHeight: 1.5 }}>
                        <div><span style={{ opacity: 0.65 }}>Stream lag</span>{' '}{asdHb.stream_lag ?? '—'}</div>
                        <div><span style={{ opacity: 0.65 }}>Sync version</span>{' '}{asdHb.last_sync_version ?? '—'}</div>
                        <div><span style={{ opacity: 0.65 }}>Accounts</span>{' '}{asdHb.accounts_synced ?? '—'}</div>
                        <div><span style={{ opacity: 0.65 }}>Positions</span>{' '}{asdHb.positions_synced ?? '—'}</div>
                        <div><span style={{ opacity: 0.65 }}>Executions</span>{' '}{asdHb.executions_synced ?? '—'}</div>
                        <div><span style={{ opacity: 0.65 }}>Open orders</span>{' '}{asdHb.open_orders_synced ?? '—'}</div>
                      </div>
                    ) : (
                      <p className="section-hint">—</p>
                    )}
                  </div>
                </div>
              </div>

              <p className="massive-api-doc-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
                <strong>Start (manual):</strong>{' '}
                <code style={{ fontSize: '0.85em' }}>python scripts/systemd/run_account_sync_daemon.py --config config/config.dev.yaml</code>
                {' '}(dev){' '}
                <span style={{ opacity: 0.7 }}>|</span>{' '}
                <code style={{ fontSize: '0.85em' }}>python scripts/systemd/run_account_sync_daemon.py --config config/config.prod.yaml</code>
                {' '}(prod). Or use <strong>Ops</strong> on this page (market ingest → Account Sync Daemon) if your host runs systemd.
              </p>
            </section>
          )
        })()}

        <section className="replay-section" aria-labelledby="daemon-console-head">
          <h3 id="daemon-console-head" className="page-title-with-tooltip">
            Daemon logs
            <InfoTooltip text="Strategy Trading Daemon: Redis streams bifrost:console:{dev|prod}:daemon_trading (legacy merged). Account Sync: bifrost:console:account_sync_daemon. Same Sources filter pattern as Socket → Logs on Market ingest Ops." />
          </h3>
          <p className="massive-api-doc-hint" style={{ marginBottom: 'var(--space-3)' }}>
            Merged console from Strategy Trading Daemon and Account Sync Daemon. Toggle sources to filter; clear removes both Redis streams on the Monitor host (same idea as Socket service logs).
          </p>
          <AggregatedLogConsolePanel
            controller={daemonUnifiedLogConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down)."
            emptyText="No log lines yet. Start run_engine.py and/or run_account_sync_daemon.py to populate streams."
            infoTooltipText="Daemon logs: Strategy Trading (merged dev/prod daemon_trading streams) and Account Sync (bifrost:console:account_sync_daemon)."
            resizeAriaLabel="Resize daemon logs console height"
            clearTitle="Clear displayed log and both Redis streams"
            sourceDefinitions={[...DAEMON_PAGE_LOG_SOURCE_DEFINITIONS]}
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
