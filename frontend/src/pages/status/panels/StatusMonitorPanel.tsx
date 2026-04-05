import type { StatusResponse } from '../../../types'
import { InfoTooltip } from '../../../components/InfoTooltip'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

interface MonitorClient {
  connected?: boolean
  client_id?: number
  last_error?: string
}

export interface StatusMonitorPanelProps {
  status: StatusResponse | null
  monitorLamp: Lamp
  monitorEnabled: boolean
  monitorSelfCheckText: string
  monitorBlockReasons: string
  apiHealthLamp: Lamp
  healthCountdownSec: number | null
  monitorIbGroupLamp: Lamp
  monitorOperator: MonitorClient | undefined
  monitorAccount2: MonitorClient | undefined
  onMonitorStop: () => void
  onMonitorConnect: () => void
  onMonitorReleaseIb: () => void
  monitorCtrlMsg: { text: string; isErr: boolean }
  className?: string
}

export function StatusMonitorPanel({
  status: j,
  monitorLamp,
  monitorEnabled,
  monitorSelfCheckText,
  monitorBlockReasons,
  apiHealthLamp,
  healthCountdownSec,
  monitorIbGroupLamp,
  monitorOperator,
  monitorAccount2,
  onMonitorStop,
  onMonitorConnect,
  onMonitorReleaseIb,
  monitorCtrlMsg,
  className,
}: StatusMonitorPanelProps) {
  return (
    <div id="system-panel-monitor" role="tabpanel" aria-labelledby="tab-monitor" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className="daemon-header-main daemon-header-with-lamp">
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              <span className={`title-inline-lamp lamp-icon ${monitorLamp}`} title="Monitor status lamp" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </span>
              Server
            </h2>
            <div>
              <strong>Status: {j ? (monitorEnabled ? 'Running (OK)' : `Stopped (${monitorSelfCheckText})`) : 'Fetch failed'}</strong>
              {j && monitorBlockReasons && monitorBlockReasons !== 'None' ? ` Block reasons: ${monitorBlockReasons}` : ''}
            </div>
          </div>
        </div>
        <div className="monitor-header-actions">
          <button
            type="button"
            className="section-header-icon-btn"
            disabled={!monitorEnabled}
            title={monitorEnabled ? 'Stop monitor IB interaction and disconnect' : 'Already stopped'}
            aria-label="Stop Server"
            onClick={onMonitorStop}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="daemon-groups monitor-api-ib-row">
        <div className="monitor-api-ib-col monitor-api-ib-col-api">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <span className={`title-inline-lamp lamp-icon ${apiHealthLamp}`} title="API service (green if /health reachable, else red)" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
              </span>
              <span className="daemon-group-title">API service</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                <strong>
                  Status:{' '}
                  {j ? (
                    <>
{monitorEnabled ? <span className="countdown-num">Running (OK)</span> : <>Stopped <span>({monitorSelfCheckText})</span></>}
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
              {/* Database/Redis status under API service */}
              {!monitorEnabled ? (
                <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>Redis: —</p>
              ) : j?.redis_quotes_connected ? (
                <p className="section-hint countdown-line" style={{ marginTop: 'var(--space-2)' }}>
                  Redis: <span className="countdown-num">Connected</span>{' '}
                  <InfoTooltip text="GET /quotes available" />
                </p>
              ) : (
                <p className="section-hint" style={{ marginTop: 'var(--space-2)' }}>Redis: Not connected or not configured</p>
              )}
            </div>
          </div>
        </div>
        <div className="monitor-api-ib-col monitor-api-ib-col-ib">
          <div className="daemon-group">
            <div className="daemon-group-header daemon-group-header-with-action">
              <div className="daemon-group-header-left">
                <span className={`title-inline-lamp lamp-icon ${monitorIbGroupLamp}`} title="Monitor IB connection status" aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </span>
                <span className="daemon-group-title">IB connection</span>
              </div>
              {(monitorOperator?.connected || monitorAccount2?.connected) ? (
                <button
                  type="button"
                  className="section-header-icon-btn"
                  title="Release Monitor IB connections (Operator + Secondary account if configured). Monitor keeps running; use Connect to reconnect."
                  aria-label="Release IB connections"
                  onClick={onMonitorReleaseIb}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18.84 12.25l1.72-1.71h-.02a3 3 0 0 0-.12-4.26 3 3 0 0 0-4.24-.12l-1.72 1.71" />
                    <path d="M5.17 11.75l-1.71 1.71a3 3 0 0 0 .12 4.26 3 3 0 0 0 4.24.12l1.71-1.71" />
                    <path d="M8 2v4M2 8h4M16 20v-4M20 16h-4" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-resume"
                  disabled={!monitorEnabled}
                  title={monitorEnabled ? 'Establish monitor IB connection (Operator + Secondary account if configured)' : 'Monitor stopped; cannot connect'}
                  onClick={onMonitorConnect}
                >
                  Connect
                </button>
              )}
            </div>
            <div className="daemon-group-body">
              <table className="ib-connection-table" aria-label="IB connection status by Host and type">
                <thead>
                  <tr>
                    <th scope="col" className="ib-connection-th-corner" />
                    <th scope="col" className="ib-connection-th">IB client</th>
                    <th scope="col" className="ib-connection-th">Market</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="ib-connection-row-label">Host</th>
                    <td className="ib-connection-cell">
                      {monitorOperator?.connected ? (
                        <span className="countdown-num">Operator @ {monitorOperator?.client_id ?? '—'}</span>
                      ) : (
                        `Not connected${monitorOperator?.last_error ? ` (${monitorOperator.last_error})` : ''}`
                      )}
                    </td>
                    <td className="ib-connection-cell">—</td>
                  </tr>
                  <tr>
                    <th scope="row" className="ib-connection-row-label" title="Secondary (Second User)">
                      Sec
                    </th>
                    <td className="ib-connection-cell">
                      {monitorAccount2 === undefined ? (
                        'Not configured'
                      ) : monitorAccount2?.connected ? (
                        <span className="countdown-num">Connected @ {monitorAccount2?.client_id ?? '—'}</span>
                      ) : (
                        `Not connected${monitorAccount2?.last_error ? ` (${monitorAccount2.last_error})` : ''}`
                      )}
                    </td>
                    <td className="ib-connection-cell">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {monitorCtrlMsg.text ? (
        <div className={`msg ${monitorCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
          {monitorCtrlMsg.text}
        </div>
      ) : null}
    </div>
  )
}
