import type { DaemonHeartbeat, IbConfig, StatusResponse } from '../../../types'
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
  suspended: _suspended,
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
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              <span className={`title-inline-lamp lamp-icon ${daemonLamp}`} title="Daemon status lamp" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
              </span>
              Daemon
            </h2>
            <div>
              <strong>Status: {j ? (daemonLabel === 'Running' ? 'Running (OK)' : `${daemonLabel} (${daemonSelfCheckText})`) : 'Fetch failed'}</strong>
              {j && daemonBlockReasons && daemonBlockReasons !== 'None' ? ` Block reasons: ${daemonBlockReasons}` : ''}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="section-header-icon-btn"
          title="Send stop to daemon; daemon exits and clears ib_client_id in DB; next start uses client_id=1"
          aria-label="Stop Daemon"
          onClick={onStop}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="daemon-groups daemon-groups-layout">
          <div className="daemon-group daemon-group-heartbeat">
          <div className="daemon-group-header">
            <span className={`title-inline-lamp lamp-icon ${heartbeatGroupLamp}`} title="Heartbeat status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
            </span>
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
              <span className={`title-inline-lamp lamp-icon ${ibGroupLamp}`} title="IB connection status" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </span>
              <span className="daemon-group-title">IB connection</span>
            </div>
            <button
              type="button"
              className="section-header-icon-btn"
              title={anyIbConnection && hb?.daemon_alive
                ? 'Release IB connection on next daemon heartbeat (daemon will go to WAITING_IB and can retry later)'
                : 'Reset is available when daemon is running and at least one of Trading or Listener (Host/Secondary) is connected'}
              aria-label="Reset IB connection"
              disabled={!anyIbConnection || !hb?.daemon_alive}
              onClick={onReleaseIb}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
              </svg>
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
            <span className={`title-inline-lamp lamp-icon ${strategyGroupLamp}`} title="Event: green when Trading Strategy running and Event Subscribe green; red when suspended or Event Subscribe red" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
            </span>
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
