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
  onReleaseIb,
  ctrlMsg,
  className,
}: StatusDaemonPanelProps) {
  const anyIbConnection = Boolean(ibConnected || hb?.listener_connected || hb?.listener_2_connected)
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

      <div className="daemon-groups daemon-groups-layout">
        <div className="daemon-group daemon-group-heartbeat">
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
        <div className="daemon-group daemon-group-ib">
          <div className="daemon-group-header daemon-group-header-with-action">
            <div className="daemon-group-header-left">
              <div className={`lamp lamp-sm ${ibGroupLamp}`} title="IB connection status" />
              <span className="daemon-group-title">IB connection</span>
            </div>
            <button
              type="button"
              className="btn-retry-ib"
              title={anyIbConnection && hb?.daemon_alive
                ? 'Release IB connection on next daemon heartbeat (daemon will go to WAITING_IB and can retry later)'
                : 'Reset is available when daemon is running and at least one of Trading or Listener (Host/Secondary) is connected'}
              disabled={!anyIbConnection || !hb?.daemon_alive}
              onClick={onReleaseIb}
            >
              Reset
            </button>
          </div>
          <div className="daemon-group-body">
            <table className="ib-connection-table" aria-label="Daemon IB connection status by Host and type">
              <thead>
                <tr>
                  <th scope="col" className="ib-connection-th-corner" />
                  <th scope="col" className="ib-connection-th">Host</th>
                  <th scope="col" className="ib-connection-th">Secondary</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="ib-connection-row-label">Trading</th>
                  <td className="ib-connection-cell">
                    {!hb?.daemon_alive ? (
                      '—'
                    ) : ibConnected ? (
                      <span className="countdown-num">Connected @ {hb?.ib_client_id ?? '?'}</span>
                    ) : (
                      daemonIbLine || '—'
                    )}
                  </td>
                  <td className="ib-connection-cell">Not supported</td>
                </tr>
                <tr>
                  <th scope="row" className="ib-connection-row-label">Listener</th>
                  <td className="ib-connection-cell">
                    {!hb?.daemon_alive ? (
                      '—'
                    ) : ibConfig?.ib_client_id_listener == null ? (
                      '—'
                    ) : hb?.listener_connected ? (
                      <span className="countdown-num">Connected @ {hb?.listener_client_id ?? ibConfig.ib_client_id_listener}</span>
                    ) : (
                      'Not connected'
                    )}
                  </td>
                  <td className="ib-connection-cell">
                    {!hb?.daemon_alive ? (
                      '—'
                    ) : (ibConfig?.ib2_host ?? ibConfig?.ib2_client_id_listener != null) ? (
                      hb?.listener_2_connected ? (
                        <span className="countdown-num">Connected @ {hb?.listener_2_client_id ?? ibConfig?.ib2_client_id_listener ?? '?'}</span>
                      ) : (
                        'Not connected'
                      )
                    ) : (
                      'Not configured'
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            {hb?.daemon_alive && !ibConnected && (
              <p className="section-hint section-hint--retry" style={{ marginTop: 'var(--space-2)' }}>Will retry connection on next heartbeat.</p>
            )}
          </div>
        </div>
        <div className="daemon-group daemon-group-event">
          <div className="daemon-group-header">
            <div className={`lamp lamp-sm ${strategyGroupLamp}`} title="Event: green when Trading Strategy running and Event Subscribe green; red when suspended or Event Subscribe red" />
            <span className="daemon-group-title">Event</span>
          </div>
          <div className="daemon-group-body">
            <p className="section-hint">
              Current: <span>{runStatusLabel}</span>
              (set by monitor; daemon syncs via PostgreSQL)
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
