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
  monitorAccount: MonitorClient | undefined
  monitorAccount2: MonitorClient | undefined
  monitorMarket: MonitorClient | undefined
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
  monitorAccount,
  monitorAccount2,
  monitorMarket,
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
        <div className="daemon-group">
          <div className="daemon-group-header daemon-group-header-with-action">
            <div className="daemon-group-header-left">
              <div className={`lamp lamp-sm ${monitorIbGroupLamp}`} title="Monitor IB connection status" />
              <span className="daemon-group-title">IB connection</span>
            </div>
            {(monitorAccount?.connected || monitorAccount2?.connected || monitorMarket?.connected) ? (
              <button
                type="button"
                className="btn-retry-ib"
                title="Release Monitor IB connections (Account + Account2 + Market). Monitor keeps running; use Connect to reconnect."
                onClick={onMonitorReleaseIb}
              >
                Release
              </button>
            ) : (
              <button
                type="button"
                className="btn-resume"
                disabled={!monitorEnabled}
                title={monitorEnabled ? 'Establish monitor IB connection (Account + Account2 + Market)' : 'Monitor stopped; cannot connect'}
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
                  <th scope="col" className="ib-connection-th">Account</th>
                  <th scope="col" className="ib-connection-th">Market</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="ib-connection-row-label">Host</th>
                  <td className="ib-connection-cell">
                    {monitorAccount?.connected ? (
                      <span className="countdown-num">Connected @ {monitorAccount?.client_id ?? '—'}</span>
                    ) : (
                      `Not connected${monitorAccount?.last_error ? ` (${monitorAccount.last_error})` : ''}`
                    )}
                  </td>
                  <td className="ib-connection-cell">
                    {monitorMarket?.connected ? (
                      <span className="countdown-num">Connected @ {monitorMarket?.client_id ?? '—'}</span>
                    ) : (
                      `Not connected${monitorMarket?.last_error ? ` (${monitorMarket.last_error})` : ''}`
                    )}
                  </td>
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
      {monitorCtrlMsg.text ? (
        <div className={`msg ${monitorCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
          {monitorCtrlMsg.text}
        </div>
      ) : null}
    </div>
  )
}
