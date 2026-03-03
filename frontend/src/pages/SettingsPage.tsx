import { useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { postIbConfig, postSetHeartbeatInterval } from '../api'

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
    setMsg({ text: '保存中…', isErr: false })
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
        ? '设置已保存。IB 连接与 client_id 下次启动/使用时生效；心跳间隔下一心跳起生效。'
        : err ?? '保存失败',
      isErr: !ok,
    })
    if (ok) {
      setHeartbeatIntervalSec(sec)
      loadStatus()
    }
  }

  return (
    <div className="card process-section">
      <h2>设置</h2>
      <p className="section-hint">
        统一配置守护程序相关参数，写入数据库；守护进程启动或下一心跳时读取并生效。
      </p>
      <div className="daemon-groups">
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className="daemon-group-title">心跳间隔</span>
          </div>
          <div className="daemon-group-body">
            <p className="section-hint">守护进程心跳写库间隔（秒），下一心跳起生效。</p>
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>
                间隔(秒):
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
            <span className="daemon-group-title">IB 连接</span>
          </div>
          <div className="daemon-group-body">
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>
                IP/主机:
                <input
                  type="text"
                  value={ibHost}
                  onChange={(e) => setIbHost(e.target.value)}
                  placeholder="127.0.0.1"
                  style={{ width: '8rem', marginLeft: '0.25rem' }}
                />
              </label>
              <label>
                端口类型:
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
            <span className="daemon-group-title">IB Client ID（按用途区分，避免与 TWS 其他连接冲突）</span>
          </div>
          <div className="daemon-group-body">
            <p className="section-hint">同一 TWS 允许多个 API 连接，用不同 client_id 区分。请勿与手动交易或其它程序重复。</p>
            <div className="daemon-groups" style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem' }}>
              <div>
                <div className="daemon-group-subtitle">守护组（交易主机）</div>
                <div className="controls" style={{ flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <label>
                    交易进程:
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
                    监听进程:
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
                <div className="daemon-group-subtitle">监控组（本机 API 直连 IB）</div>
                <div className="controls" style={{ flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <label>
                    账户信息:
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
                    市场数据:
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
          保存设置
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
