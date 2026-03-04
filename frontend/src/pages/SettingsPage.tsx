import { useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { postIbConfig, postSetHeartbeatInterval } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

export interface SettingsPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT_TYPE = 'tws_paper'
const DEFAULT_DAEMON = 1
const DEFAULT_LISTENER = 2
const DEFAULT_REFRESH_EXECUTIONS = 100
const DEFAULT_BARS_FETCH = 101
const DEFAULT_HEARTBEAT_SEC = 10

export function SettingsPage({ status, loadStatus }: SettingsPageProps) {
  const [msg, setMsg] = useState({ text: '', isErr: false })
  const [ibHost, setIbHost] = useState(DEFAULT_HOST)
  const [ibPortType, setIbPortType] = useState<'tws_live' | 'tws_paper' | 'gateway'>(DEFAULT_PORT_TYPE)
  const [clientIdDaemon, setClientIdDaemon] = useState(DEFAULT_DAEMON)
  const [clientIdListener, setClientIdListener] = useState(DEFAULT_LISTENER)
  const [clientIdAccount, setClientIdAccount] = useState(DEFAULT_REFRESH_EXECUTIONS)
  const [clientIdMarkets, setClientIdMarkets] = useState(DEFAULT_BARS_FETCH)
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState(DEFAULT_HEARTBEAT_SEC)
  const [ibConfigInitialized, setIbConfigInitialized] = useState(false)
  const [heartbeatInitialized, setHeartbeatInitialized] = useState(false)

  useEffect(() => {
    const c = status?.ib_config
    if (!c || ibConfigInitialized) return
    if (c.ib_host != null) setIbHost(c.ib_host)
    if (c.ib_port_type != null) setIbPortType(c.ib_port_type)
    if (c.ib_client_id_daemon != null) setClientIdDaemon(c.ib_client_id_daemon)
    if (c.ib_client_id_listener != null) setClientIdListener(c.ib_client_id_listener)
    if (c.ib_client_id_account != null) setClientIdAccount(c.ib_client_id_account)
    if (c.ib_client_id_markets != null) setClientIdMarkets(c.ib_client_id_markets)
    setIbConfigInitialized(true)
  }, [status?.ib_config, ibConfigInitialized])

  useEffect(() => {
    const sec = status?.daemon_heartbeat?.heartbeat_interval_sec
    if (heartbeatInitialized) return
    if (sec != null && Number.isFinite(sec)) {
      setHeartbeatIntervalSec(sec)
      setHeartbeatInitialized(true)
    }
  }, [status?.daemon_heartbeat?.heartbeat_interval_sec, heartbeatInitialized])

  const onSave = async () => {
    setMsg({ text: 'Saving…', isErr: false })
    const host = ibHost.trim() || DEFAULT_HOST
    const sec = Math.max(5, Math.min(120, Math.round(Number(heartbeatIntervalSec)) || DEFAULT_HEARTBEAT_SEC))
    const [resIb, resHb] = await Promise.all([
      postIbConfig(host, ibPortType, {
        ib_client_id_daemon: clientIdDaemon,
        ib_client_id_listener: clientIdListener,
        ib_client_id_account: clientIdAccount,
        ib_client_id_markets: clientIdMarkets,
      }),
      postSetHeartbeatInterval(sec),
    ])
    const ok = resIb.ok && resHb.ok
    const err = !resIb.ok ? resIb.error : !resHb.ok ? resHb.error : undefined
    setMsg({
      text: ok
        ? 'Settings saved. IB connection and client_id apply on next start/use; heartbeat interval on next heartbeat.'
        : err ?? 'Save failed',
      isErr: !ok,
    })
    if (ok) {
      setHeartbeatIntervalSec(sec)
      loadStatus()
    }
  }

  return (
    <div className="card process-section">
      <h2 className="settings-page-title">
        Settings
        <InfoTooltip text="Configure daemon-related parameters; written to DB and read by daemon on start or next heartbeat." />
      </h2>
      <div className="daemon-groups">
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Heartbeat interval</span>
            <InfoTooltip text="Daemon heartbeat write interval (seconds); takes effect on next heartbeat." />
          </div>
          <div className="daemon-group-body">
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>
                Interval (sec):
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={heartbeatIntervalSec}
                  onChange={(e) => setHeartbeatIntervalSec(parseInt(e.target.value, 10) || DEFAULT_HEARTBEAT_SEC)}
                  style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                />
              </label>
            </div>
          </div>
        </div>
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className="daemon-group-title">IB connection</span>
          </div>
          <div className="daemon-group-body">
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>
                IP/Host:
                <input
                  type="text"
                  value={ibHost}
                  onChange={(e) => setIbHost(e.target.value)}
                  placeholder="127.0.0.1"
                  style={{ width: '8rem', marginLeft: '0.25rem' }}
                />
              </label>
              <label>
                Port type:
                <select
                  value={ibPortType}
                  onChange={(e) => setIbPortType(e.target.value as 'tws_live' | 'tws_paper' | 'gateway')}
                  style={{ marginLeft: '0.25rem' }}
                >
                  <option value="tws_paper">TWS Paper (7497)</option>
                  <option value="tws_live">TWS Live (7496)</option>
                  <option value="gateway">Gateway (4002)</option>
                </select>
              </label>
            </div>
          </div>
        </div>
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className="daemon-group-title">IB Client ID</span>
            <InfoTooltip text="Per role; avoid conflict with other TWS connections. TWS allows multiple API connections with different client_id. Do not reuse with manual trading or other apps." />
          </div>
          <div className="daemon-group-body">
            <div className="daemon-groups" style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem' }}>
              <div>
                <div className="daemon-group-subtitle">Daemon (trading host)</div>
                <div className="controls" style={{ flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <label>
                    Trading:
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdDaemon}
                      onChange={(e) => setClientIdDaemon(parseInt(e.target.value, 10) || DEFAULT_DAEMON)}
                      style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                    />
                  </label>
                  <label>
                    Listener:
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdListener}
                      onChange={(e) => setClientIdListener(parseInt(e.target.value, 10) || DEFAULT_LISTENER)}
                      style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                    />
                  </label>
                </div>
              </div>
              <div>
                <div className="daemon-group-subtitle">Monitor (this API, direct to IB)</div>
                <div className="controls" style={{ flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <label>
                    Account:
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdAccount}
                      onChange={(e) => setClientIdAccount(parseInt(e.target.value, 10) || DEFAULT_REFRESH_EXECUTIONS)}
                      style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                    />
                  </label>
                  <label>
                    Market data:
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdMarkets}
                      onChange={(e) => setClientIdMarkets(parseInt(e.target.value, 10) || DEFAULT_BARS_FETCH)}
                      style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="controls" style={{ marginTop: '1rem' }}>
        <button type="button" className="btn-resume" onClick={onSave}>
          Save settings
        </button>
        {msg.text && (
          <span className={msg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginLeft: '0.5rem' }}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
