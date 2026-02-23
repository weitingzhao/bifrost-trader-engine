import { useEffect, useState, useCallback } from 'react'
import type { StatusResponse, Operation } from './types'
import {
  fetchStatus,
  fetchOperations,
  postSuspend,
  postResume,
  postFlatten,
  postRetryIb,
  postSetHeartbeatInterval,
  postStop,
  postIbConfig,
} from './api'
import './App.css'

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

const HEDGE_REASON_LABELS: Record<string, string> = {
  trading_suspended: '对冲已挂起',
  no_status: '无状态数据',
  daemon_not_running: '守护进程未运行',
  data_stale: '数据滞后',
  trading_state_pause_cost: '交易状态: 暂停成本',
  trading_state_risk_halt: '交易状态: 风控暂停',
  trading_state_stale: '交易状态: 陈旧',
  trading_state_force_hedge: '交易状态: 强制对冲',
  status_read_error: '服务端读库失败（锁超时或连接异常，请稍后刷新）',
}

const DAEMON_REASON_LABELS: Record<string, string> = {
  no_heartbeat: '无心跳数据',
  daemon_not_running: '守护进程未运行',
  heartbeat_stale: '心跳未持续更新（超过 35 秒无写库，可能守护进程繁忙或异常）',
  ib_not_connected: 'IB 未连接',
  status_read_error: '服务端读库失败（锁超时或连接异常，请稍后刷新）',
}

const DAEMON_SELF_CHECK_LABELS: Record<string, string> = {
  ok: '正常',
  degraded: '降级',
  blocked: '异常',
}

const DAEMON_STATE_LABELS: Record<string, string> = {
  running: '运行中',
  running_suspended: '运行中（对冲已挂起）',
  connecting: '连接中',
  waiting_ib: '等待 IB 连接（自动重试）',
  connected: '已连接',
  stopping: '停止中',
  stopped: '已停止',
  idle: '空闲',
}

const STATUS_FIELDS: [string, string][] = [
  ['daemon_state', '守护进程状态'],
  ['trading_state', '交易状态'],
  ['symbol', '标的'],
  ['spot', '标的价格'],
  ['stock_position', '股票持仓'],
  ['daily_hedge_count', '当日对冲次数'],
  ['ts', '更新时间'],
]

function setMsg(
  setter: (v: { text: string; isErr: boolean }) => void,
  text: string,
  isErr: boolean
) {
  setter({ text, isErr })
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const [heartbeatIntervalInput, setHeartbeatIntervalInput] = useState<string>('10')
  const [ibHostInput, setIbHostInput] = useState<string>('127.0.0.1')
  const [ibPortTypeInput, setIbPortTypeInput] = useState<'tws_live' | 'tws_paper' | 'gateway'>('tws_paper')

  const loadStatus = useCallback(async () => {
    try {
      const j = await fetchStatus()
      setStatus(j)
      if (j?.daemon_heartbeat?.heartbeat_interval_sec != null)
        setHeartbeatIntervalInput(String(j.daemon_heartbeat.heartbeat_interval_sec))
      if (j?.ib_config?.ib_host != null) setIbHostInput(j.ib_config.ib_host)
      if (j?.ib_config?.ib_port_type != null) setIbPortTypeInput(j.ib_config.ib_port_type)
      return j
    } catch {
      setStatus(null)
      return null
    }
  }, [])

  const loadOperations = useCallback(async () => {
    try {
      const j = await fetchOperations(20)
      setOperations(j.operations || [])
    } catch {
      setOperations([])
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadOperations()
    const t1 = setInterval(loadStatus, 5000)
    const t2 = setInterval(loadOperations, 10000)
    return () => {
      clearInterval(t1)
      clearInterval(t2)
    }
  }, [loadStatus, loadOperations])

  // 心跳与 IB 重试倒计时：每秒更新
  const hbForCountdown = status?.daemon_heartbeat
  const intervalSec = hbForCountdown?.heartbeat_interval_sec ?? 10
  useEffect(() => {
    if (!hbForCountdown?.daemon_alive) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [hbForCountdown?.daemon_alive])

  const j = status
  const hb = j?.daemon_heartbeat
  const nowSec = Date.now() / 1000
  void tick
  const secondsUntilNextHeartbeat =
    hbForCountdown?.daemon_alive && hbForCountdown?.last_ts != null
      ? Math.max(0, Math.ceil(hbForCountdown.last_ts + intervalSec - nowSec))
      : null
  const hasRecentStatus =
    j?.status?.ts != null && nowSec - (j.status.ts as number) < 90
  const suspended = j?.trading_suspended === true
  const ibConnected = hb?.ib_connected === true
  // 仅当守护进程存活且 IB 未连接时显示「重试连接 IB」；已连接时隐藏按钮
  const showRetryIb = hb?.daemon_alive === true && !ibConnected

  let daemonLabel = '未运行（或单进程模式）'
  let daemonHint = '在交易机执行 run_engine.py 后此处会显示运行中'
  let hedgeLabel = hasRecentStatus ? '运行中（单进程）' : '未运行'
  let hedgeHint = hasRecentStatus
    ? '当前为单进程模式（run_engine.py），状态由对冲逻辑写入'
    : ''
  let daemonIbLine = ''

  if (hb?.daemon_alive) {
    daemonLabel = '运行中'
    daemonHint = hb.last_ts != null ? `最后心跳: ${fmtTs(hb.last_ts)}` : ''
    hedgeLabel = hb.hedge_running ? '运行中' : '已挂起（或未启动）'
    hedgeHint = hb.hedge_running
      ? '单进程：守护与对冲同进程'
      : '监控端可点击「恢复对冲」恢复对冲'
    daemonIbLine = `IB: ${ibConnected ? `已连接 (Client ID ${hb.ib_client_id ?? '?'})` : '未连接'}`
  } else if (hb) {
    daemonLabel = '未运行'
    if (hb.graceful_shutdown_at != null) {
      daemonHint = `已于 ${fmtTs(hb.graceful_shutdown_at)} 优雅停止（SIGTERM/Stop）`
    } else {
      daemonHint =
        hb.last_ts != null
          ? `最后心跳: ${fmtTs(hb.last_ts)}（已超时，可能被 kill -9 或崩溃）`
          : ''
    }
    hedgeLabel = '未运行'
    hedgeHint = '双进程模式下守护进程未运行则对冲程序不会运行'
  }

  const daemonLamp = (j?.daemon_lamp as 'green' | 'yellow' | 'red') || 'none'
  const hedgeLamp = (j?.status_lamp as 'green' | 'yellow' | 'red') || 'none'
  const suspendedInReasons =
    j?.block_reasons?.includes('trading_suspended') ?? false
  const daemonSelfCheckText =
    DAEMON_SELF_CHECK_LABELS[j?.daemon_self_check ?? ''] ?? j?.daemon_self_check ?? '--'
  const hedgeSelfCheckText =
    (j?.self_check ?? '--') + (suspendedInReasons ? '（对冲已挂起）' : '')
  const daemonBlockReasons = (j?.daemon_block_reasons ?? [])
    .map((r) => DAEMON_REASON_LABELS[r] ?? r)
    .join('；') || '无'
  const hedgeBlockReasons = (j?.block_reasons ?? [])
    .map((r) => HEDGE_REASON_LABELS[r] ?? r)
    .join('；') || '无'

  const runStatusLabel = suspended ? '已挂起（不执行新对冲）' : '运行中'

  const heartbeatGroupLamp = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const ibGroupLamp = !hb?.daemon_alive ? 'none' : ibConnected ? 'green' : 'red'
  const strategyGroupLamp = suspended ? 'red' : 'green'

  const s = j?.status ?? {}
  const statusSummaryItems = STATUS_FIELDS.map(([k, label]) => {
    let v: string | number | undefined = (s as Record<string, unknown>)[k] as string | number | undefined
    let out: string | number
    if (v != null)
      out =
        k === 'ts'
          ? fmtTs(v as number)
          : k === 'daemon_state'
            ? DAEMON_STATE_LABELS[String(v)] ?? v
            : String(v)
    else out = '--'
    return { label, value: out }
  })

  const onSuspend = async () => {
    setMsg(setCtrlMsg, '设置挂起中…', false)
    const res = await postSuspend()
    setMsg(
      setCtrlMsg,
      res.ok ? '已设置挂起，交易机下一心跳起暂停新对冲。' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
  }

  const onResume = async () => {
    setMsg(setCtrlMsg, '设置恢复中…', false)
    const res = await postResume()
    setMsg(
      setCtrlMsg,
      res.ok ? '已设置恢复，交易机下一心跳起恢复对冲。' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
  }

  const onRetryIb = async () => {
    setMsg(setCtrlMsg, '请求重试连接 IB…', false)
    const res = await postRetryIb()
    setMsg(
      setCtrlMsg,
      res.ok ? '已发送重试指令，守护进程将立即尝试连接 IB。' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
  }

  const onFlatten = async () => {
    setMsg(setHedgeCtrlMsg, '请求平敞口中…', false)
    const res = await postFlatten()
    setMsg(
      setHedgeCtrlMsg,
      res.ok ? '已发送平敞口指令，由对冲程序消费并执行。' : (res.error ?? ''),
      !res.ok
    )
  }

  const onStop = async () => {
    setMsg(setCtrlMsg, '正在请求停止守护程序…', false)
    const res = await postStop()
    setMsg(
      setCtrlMsg,
      res.ok ? '已发送停止指令，守护程序将安全退出并清空 ib_client_id，下次启动将使用 client_id=1。' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
  }

  const onSetHeartbeatInterval = async () => {
    const sec = parseInt(heartbeatIntervalInput, 10)
    if (Number.isNaN(sec) || sec < 5 || sec > 120) {
      setMsg(setCtrlMsg, '请输入 5–120 之间的整数', true)
      return
    }
    setMsg(setCtrlMsg, '设置心跳间隔中…', false)
    const res = await postSetHeartbeatInterval(sec)
    setMsg(
      setCtrlMsg,
      res.ok
        ? `心跳间隔已设为 ${res.heartbeat_interval_sec ?? sec} 秒，守护进程下一轮将生效。`
        : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) {
      setHeartbeatIntervalInput(String(res.heartbeat_interval_sec ?? sec))
      loadStatus()
    }
  }

  const onSaveIbConfig = async () => {
    const host = ibHostInput.trim() || '127.0.0.1'
    setMsg(setCtrlMsg, '保存 IB 连接配置中…', false)
    const res = await postIbConfig(host, ibPortTypeInput)
    setMsg(
      setCtrlMsg,
      res.ok ? 'IB 连接配置已保存，下次启动守护程序时生效。' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
  }

  return (
    <div className="app">
      <h1>Bifrost 自动交易监控</h1>

      <div className="card process-section">
        <h2>
          守护程序{' '}
          <span className="section-desc">
            （对冲可运行的前提；业务无关，有且仅有一个）
          </span>
        </h2>
        <div className="daemon-header">
          <div className="daemon-header-main">
            <div className="row" style={{ marginBottom: '0.35rem' }}>
              <div
                className={`lamp ${daemonLamp}`}
                title="守护程序状态灯"
              />
              <div>
                <strong>自检: {j ? daemonSelfCheckText : '获取失败'}</strong>
                <div className="block-reasons">{j ? daemonBlockReasons : ''}</div>
              </div>
            </div>
            <div className="daemon-header-meta">
              <span className="process-summary">状态: {daemonLabel}</span>
              <span className="daemon-start-hint" title="启动守护程序请在交易机执行该命令">启动: python scripts/run_engine.py config/config.yaml</span>
            </div>
          </div>
          <button
            type="button"
            className="btn-stop"
            title="向守护程序发送停止指令，守护程序将安全退出并清空 DB 中的 ib_client_id，下次启动使用 client_id=1"
            onClick={onStop}
          >
            停止守护
          </button>
        </div>

        <div className="daemon-groups">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${heartbeatGroupLamp}`} title="心跳状态" />
              <span className="daemon-group-title">心跳</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">{daemonHint || '—'}</p>
              {hb?.daemon_alive && secondsUntilNextHeartbeat != null && (
                <p className="section-hint countdown-line">
                  下次心跳: <span className="countdown-num">{secondsUntilNextHeartbeat}</span> 秒
                </p>
              )}
              {hb?.daemon_alive && (
                <div className="controls">
                  <span>
                    心跳间隔(秒):
                    <input
                      type="number"
                      min={5}
                      max={120}
                      value={heartbeatIntervalInput}
                      onChange={(e) => setHeartbeatIntervalInput(e.target.value)}
                      style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                    />
                    <button
                      type="button"
                      className="btn-resume"
                      title="守护进程下一心跳起使用新间隔"
                      onClick={onSetHeartbeatInterval}
                    >
                      设置
                    </button>
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${ibGroupLamp}`} title="IB 连接状态" />
              <span className="daemon-group-title">IB 连接</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">{daemonIbLine || '—'}</p>
              {hb?.daemon_alive && !ibConnected && (
                <p className="section-hint">会在下次心跳时，尝试重连。</p>
              )}
              <p className="section-hint">连接地址（守护程序下次启动时加载）：</p>
              <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                <label>
                  IP/主机:
                  <input
                    type="text"
                    value={ibHostInput}
                    onChange={(e) => setIbHostInput(e.target.value)}
                    placeholder="127.0.0.1"
                    style={{ width: '8rem', marginLeft: '0.25rem' }}
                  />
                </label>
                <label>
                  端口类型:
                  <select
                    value={ibPortTypeInput}
                    onChange={(e) => setIbPortTypeInput(e.target.value as 'tws_live' | 'tws_paper' | 'gateway')}
                    style={{ marginLeft: '0.25rem' }}
                  >
                    <option value="tws_live">TWS Live (7496)</option>
                    <option value="tws_paper">TWS Paper (7497)</option>
                    <option value="gateway">Gateway (4002)</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-resume"
                  title="保存到数据库，下次启动守护程序时生效"
                  onClick={onSaveIbConfig}
                >
                  保存
                </button>
              </div>
              <p className="section-hint" style={{ marginTop: '0.25rem' }}>生效需重启守护程序。</p>
              {showRetryIb && (
                <div className="controls">
                  <button
                    type="button"
                    className="btn-retry-ib"
                    title="通知守护程序立即尝试连接 IB"
                    onClick={onRetryIb}
                  >
                    重试连接 IB
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${strategyGroupLamp}`} title="交易策略状态" />
              <span className="daemon-group-title">交易策略</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                当前：<span>{runStatusLabel}</span>
                （由监控设置，交易机轮询 PostgreSQL 同步）
              </p>
              <div className="controls">
                <button
                  type="button"
                  className="btn-suspend"
                  disabled={suspended}
                  title={suspended ? '当前已挂起' : '由监控机设置，交易机下一心跳起暂停新对冲'}
                  onClick={onSuspend}
                >
                  挂起对冲
                </button>
                <button
                  type="button"
                  className="btn-resume"
                  disabled={!suspended}
                  title={!suspended ? '当前已运行' : '由监控机设置，交易机下一心跳起恢复对冲'}
                  onClick={onResume}
                >
                  恢复对冲
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={`msg ${ctrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
          {ctrlMsg.text}
        </div>
      </div>

      <div className="card process-section">
        <h2>
          对冲程序{' '}
          <span className="section-desc">
            （依赖守护程序运行；业务相关，未来可多策略）
          </span>
        </h2>
        <div className="row" style={{ marginBottom: '0.5rem' }}>
          <div className={`lamp ${hedgeLamp}`} title="对冲程序状态灯" />
          <div>
            <strong>自检: {j ? hedgeSelfCheckText : '获取失败'}</strong>
            <div className="block-reasons">{j ? hedgeBlockReasons : ''}</div>
          </div>
        </div>
        <div className="process-summary">状态: {hedgeLabel}</div>
        <p className="section-hint">{hedgeHint}</p>
        <div className="statusSummary" style={{ marginTop: '0.5rem' }}>
          {statusSummaryItems.map(({ label, value }) => (
            <div key={label}>
              <span>{label}</span> {value}
            </div>
          ))}
        </div>
        <div className="controls" style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            className="btn-flatten"
            title="由对冲程序消费并执行，平掉本策略对冲敞口"
            onClick={onFlatten}
          >
            一键平敞口
          </button>
        </div>
        <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'}`}>
          {hedgeCtrlMsg.text}
        </div>
      </div>

      <div className="card">
        <h2>近期操作</h2>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>方向</th>
              <th>数量</th>
              <th>价格</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {operations.length === 0 ? (
              <tr>
                <td colSpan={6}>无</td>
              </tr>
            ) : (
              operations.map((op, i) => (
                <tr key={`${op.ts}-${i}`}>
                  <td>{fmtTs(op.ts)}</td>
                  <td>{op.type ?? ''}</td>
                  <td>{op.side ?? ''}</td>
                  <td>{op.quantity ?? ''}</td>
                  <td>{op.price ?? ''}</td>
                  <td>{op.state_reason ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
