import type { DaemonHeartbeat, IbConfig, StatusResponse } from '../../../types'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { fmtTs } from '../../../utils/format'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

export interface StatusDaemonPanelProps {
  status: StatusResponse | null
  hb: DaemonHeartbeat | null | undefined
  daemonLabel: string
  daemonHint: string
  daemonSelfCheckText: string
  daemonBlockReasons: string
  daemonLamp: Lamp
  heartbeatGroupLamp: Lamp
  ibGroupLamp: Lamp
  strategyGroupLamp: Lamp
  secondsUntilNextHeartbeat: number | null
  runStatusLabel: string
  suspended: boolean
  ibConnected: boolean
  daemonIbLine: string
  ibConfig: IbConfig | null | undefined
  onStop: () => void
  onSuspend: () => void
  onResume: () => void
  onReleaseIb: () => void
  ctrlMsg: { text: string; isErr: boolean }
  className?: string
}

export function StatusDaemonPanel({
  status: j,
  hb,
  daemonLabel,
  daemonHint,
  daemonSelfCheckText,
  daemonBlockReasons,
  daemonLamp,
  heartbeatGroupLamp,
  ibGroupLamp,
  strategyGroupLamp,
  secondsUntilNextHeartbeat,
  runStatusLabel,
  suspended,
  ibConnected,
  daemonIbLine,
  ibConfig,
  onStop,
  onSuspend,
  onResume,
  onReleaseIb,
  ctrlMsg,
  className,
}: StatusDaemonPanelProps) {
  return (
    <div id="system-panel-daemon" role="tabpanel" aria-labelledby="tab-daemon" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className="daemon-header-main daemon-header-with-lamp">
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${daemonLamp}`} title="Daemon status lamp" />
          </div>
          <div>
            <h2 className="daemon-card-title">Daemon</h2>
            <div>
              <strong>Status: {j ? (daemonLabel === 'Running' ? 'Running (OK)' : `${daemonLabel} (${daemonSelfCheckText})`) : 'Fetch failed'}</strong>
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
            {/* Database/Redis under Heartbeat to save space */}
            {!hb?.daemon_alive ? (
              <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>Redis: —</p>
            ) : hb.redis_quotes_connected ? (
              <p className="section-hint countdown-line" style={{ marginTop: 'var(--space-2)' }}>
                Redis: <span className="countdown-num">Connected</span>
              </p>
            ) : (
              <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>Redis: Not connected or not configured</p>
            )}
          </div>
        </div>
        <div className="daemon-group">
          <div className="daemon-group-header daemon-group-header-with-action">
            <div className="daemon-group-header-left">
              <div className={`lamp lamp-sm ${ibGroupLamp}`} title="IB connection status" />
              <span className="daemon-group-title">IB connection</span>
            </div>
            {ibConnected && (
              <button
                type="button"
                className="btn-retry-ib"
                title="Release IB connection on next daemon heartbeat (daemon will go to WAITING_IB and can retry later)"
                onClick={onReleaseIb}
              >
                Reset
              </button>
            )}
          </div>
          <div className="daemon-group-body">
            {ibConnected ? (
              <p className="section-hint countdown-line">
                Trading: <span className="countdown-num">Connected @ {hb?.ib_client_id ?? '?'}</span>
              </p>
            ) : (
              <p className="section-hint">{daemonIbLine || '—'}</p>
            )}
            {ibConfig?.ib_client_id_listener != null && (
              <p className="section-hint countdown-line">
                Listener: {hb?.listener_connected ? (
                  <span className="countdown-num">Connected @ {hb?.listener_client_id ?? ibConfig.ib_client_id_listener}</span>
                ) : (
                  <span>Not connected</span>
                )}
              </p>
            )}
            {(ibConfig?.ib2_host ?? ibConfig?.ib2_client_id_listener != null) && (
              <p className="section-hint countdown-line">
                Listener: {hb?.listener_2_connected ? (
                  <span className="countdown-num">Connected @ {hb?.listener_2_client_id ?? ibConfig?.ib2_client_id_listener ?? '?'}</span>
                ) : (
                  <span>Not connected</span>
                )}
              </p>
            )}
            {hb?.daemon_alive && !ibConnected && (
              <p className="section-hint section-hint--retry">Will retry connection on next heartbeat.</p>
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
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Open Orders</span>
            <InfoTooltip text="Current unfilled orders from daemon (event-driven). Refreshed with status poll." />
          </div>
          <div className="daemon-group-body">
            <p className="section-hint countdown-line">
              Open orders: <span className="countdown-num">{j?.open_orders?.length ?? 0}</span>
            </p>
          </div>
        </div>
      </div>

      {ctrlMsg.text ? (
        <div className={`msg ${ctrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
          {ctrlMsg.text}
        </div>
      ) : null}
    </div>
  )
}
