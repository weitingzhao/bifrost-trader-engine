import { useEffect, useState, useCallback } from 'react'
import type { IbAccountSnapshot, StatusResponse, Operation } from './types'
import {
  fetchStatus,
  fetchOperations,
  postSuspend,
  postResume,
  postFlatten,
  postRetryIb,
  postRefreshAccounts,
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

type TabId = 'daemon' | 'hedge' | 'ib' | 'operations'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('daemon')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const [heartbeatIntervalInput, setHeartbeatIntervalInput] = useState<string>('10')
  const [ibHostInput, setIbHostInput] = useState<string>('127.0.0.1')
  const [ibPortTypeInput, setIbPortTypeInput] = useState<'tws_live' | 'tws_paper' | 'gateway'>('tws_paper')
  const [apiReachable, setApiReachable] = useState<boolean>(false)
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  /** IB 账户区块数据：仅在手点刷新或 1 小时自动刷新时更新，不随 5s 轮询更新 */
  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const j = await fetchStatus()
      setStatus(j)
      setApiReachable(true)
      if (j?.daemon_heartbeat?.heartbeat_interval_sec != null)
        setHeartbeatIntervalInput(String(j.daemon_heartbeat.heartbeat_interval_sec))
      if (j?.ib_config?.ib_host != null) setIbHostInput(j.ib_config.ib_host)
      if (j?.ib_config?.ib_port_type != null) setIbPortTypeInput(j.ib_config.ib_port_type)
      return j
    } catch {
      setStatus(null)
      setApiReachable(false)
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

  // IB 账户区块：首次有数据时写入 display；之后仅手点刷新或 1 小时自动刷新更新
  useEffect(() => {
    if (status?.accounts != null && accountsDisplay === null)
      setAccountsDisplay(status.accounts ? [...status.accounts] : [])
  }, [status?.accounts, accountsDisplay])

  const IB_ACCOUNTS_AUTO_REFRESH_MS = 60 * 60 * 1000 // 1 小时
  useEffect(() => {
    const t = setInterval(() => {
      loadStatus().then((j) => setAccountsDisplay(j?.accounts ? [...j.accounts] : []))
    }, IB_ACCOUNTS_AUTO_REFRESH_MS)
    return () => clearInterval(t)
  }, [loadStatus])

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

  const apiLamp = apiReachable ? 'green' : 'red'

  const tabList: { id: TabId; label: string; lamp?: 'green' | 'yellow' | 'red' | 'none' }[] = [
    { id: 'daemon', label: '守护程序', lamp: daemonLamp },
    { id: 'hedge', label: '对冲程序', lamp: hedgeLamp },
    { id: 'ib', label: 'IB 账户' },
    { id: 'operations', label: '近期操作' },
  ]

  return (
    <div className="app">
      <h1>Bifrost 自动交易监控</h1>
      <div className="api-status-bar">
        <div className={`lamp lamp-sm ${apiLamp}`} title="Trader API 是否可达" />
        <span className="api-status-label">Trader API: {apiReachable ? '正常' : '异常'}</span>
        <a href="/docs" target="_blank" rel="noopener noreferrer" className="api-docs-link">API 文档</a>
      </div>

      <nav className="app-tabs" aria-label="监控分区">
        {tabList.map(({ id, label, lamp }) => (
          <button
            key={id}
            type="button"
            className={`app-tab ${activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
            aria-current={activeTab === id ? 'page' : undefined}
          >
            {lamp != null && <span className={`lamp lamp-sm ${lamp}`} aria-hidden />}
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'daemon' && (
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
      )}

      {activeTab === 'ib' && (
      <div className="card process-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h2 style={{ margin: 0 }}>
            IB 账户{' '}
            <span className="section-desc">
              （多账户摘要与持仓，来自 DB；自动刷新每 1 小时）
            </span>
          </h2>
          <button
            type="button"
            className="btn-resume"
            disabled={ibAccountsRefreshing}
            onClick={async () => {
              setIbAccountsRefreshing(true)
              const requestedAt = Date.now() / 1000
              try {
                await postRefreshAccounts()
                const deadline = Date.now() + 30000
                while (Date.now() < deadline) {
                  const j = await loadStatus()
                  if (j?.accounts != null) setAccountsDisplay(j.accounts ? [...j.accounts] : [])
                  if (j?.accounts_fetched_at != null && j.accounts_fetched_at > requestedAt) break
                  await new Promise((r) => setTimeout(r, 2000))
                }
              } finally {
                setIbAccountsRefreshing(false)
              }
            }}
            title="请求守护进程从 IB 拉取账户与持仓并写入 DB，然后更新展示"
          >
            {ibAccountsRefreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
        {(() => {
          const fetchedAt = j?.accounts_fetched_at
          const hasAnyAccounts = Array.isArray(accountsDisplay ?? j?.accounts) && (accountsDisplay ?? j?.accounts)!.length > 0
          if (fetchedAt != null && Number.isFinite(fetchedAt)) {
            return (
              <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                数据来自 {new Date(fetchedAt * 1000).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })}
                ，已过 {(() => {
                  const sec = Math.floor(Date.now() / 1000 - fetchedAt)
                  if (sec < 60) return `${sec} 秒`
                  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`
                  return `${(sec / 3600).toFixed(1)} 小时`
                })()}
              </p>
            )
          }
          if (hasAnyAccounts) {
            return (
              <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                数据时间未知（点击「刷新」由守护进程从 IB 拉取并写库后此处会显示拉取时间）
              </p>
            )
          }
          return null
        })()}
        {(() => {
          const rawAccounts = (accountsDisplay ?? j?.accounts) as IbAccountSnapshot[] | undefined
          const hasAccounts = Array.isArray(rawAccounts) && rawAccounts.length > 0
          const fmtUsd = (n: number | null | undefined) =>
            n != null && Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'
          /** 到期日原始格式为 YYYYMM 或 YYYYMMDD，格式化为 YYYY-MM 或 YYYY-MM-DD */
          const fmtExpiry = (raw: string | undefined): string => {
            if (!raw || typeof raw !== 'string') return '—'
            const s = String(raw).trim().replace(/\D/g, '')
            if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
            if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
            return raw
          }
          if (!hasAccounts) {
            return (
              <p className="section-hint">
                无账户数据（IB 未连接或守护进程尚未写入；连接后按心跳拉取并写入 accounts / account_positions）
              </p>
            )
          }
          const getNetLiq = (a: IbAccountSnapshot) => {
            const v = a.summary?.NetLiquidation
            if (v == null) return 0
            const n = parseFloat(String(v))
            return Number.isFinite(n) ? n : 0
          }
          const accounts = [...rawAccounts!].sort((a, b) => getNetLiq(b) - getNetLiq(a))
          const selectedIndex = Math.min(ibAccountIndex, accounts.length - 1)
          const acc = accounts[selectedIndex]
          const aid = acc.account_id ?? `账户-${selectedIndex + 1}`
          const sum = acc.summary ?? {}
          const netLiq = sum.NetLiquidation != null ? parseFloat(String(sum.NetLiquidation)) : undefined
          const totalCash = sum.TotalCashValue != null ? parseFloat(String(sum.TotalCashValue)) : undefined
          const buyingPower = sum.BuyingPower != null ? parseFloat(String(sum.BuyingPower)) : undefined
          const positions = acc.positions ?? []
          const stockPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() !== 'OPT')
          const optionPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() === 'OPT')
          const spot =
            status?.status?.spot != null && Number.isFinite(Number(status.status.spot))
              ? Number(status.status.spot)
              : null
          const rightLabel = (r: string | undefined): string => {
            if (!r) return '—'
            const u = String(r).toUpperCase()
            if (u === 'C' || u === 'CALL') return 'Call'
            if (u === 'P' || u === 'PUT') return 'Put'
            return r
          }
          const optionIntrinsic = (isCall: boolean, k: number, s: number) =>
            isCall ? Math.max(0, s - k) : Math.max(0, k - s)
          const optionMoneyness = (isCall: boolean, k: number, s: number): string => {
            if (!Number.isFinite(k) || !Number.isFinite(s)) return '—'
            if (Math.abs(s - k) < 0.01) return 'ATM'
            if (isCall) return s > k ? 'ITM' : 'OTM'
            return s < k ? 'ITM' : 'OTM'
          }
          return (
            <div className="ib-accounts-wrap">
              {accounts.length > 1 && (
                <div className="ib-accounts-tabs">
                  {accounts.map((a, idx) => (
                    <button
                      key={a.account_id ?? idx}
                      type="button"
                      className={`ib-accounts-tab ${idx === selectedIndex ? 'active' : ''}`}
                      onClick={() => setIbAccountIndex(idx)}
                    >
                      {a.account_id ?? `账户-${idx + 1}`}
                      {(a.positions?.length ?? 0) > 0 && (
                        <span className="section-hint" style={{ marginLeft: '0.35rem', fontWeight: 'normal' }}>
                          ({a.positions!.length})
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="ib-accounts-content">
                <div className="ib-summary-row">
                  <div className="ib-summary-item">
                    <span className="label">账户</span>
                    <span className="value">{aid}</span>
                  </div>
                  {netLiq != null && Number.isFinite(netLiq) && (
                    <div className="ib-summary-item">
                      <span className="label">净资产</span>
                      <span className="value">{fmtUsd(netLiq)}</span>
                    </div>
                  )}
                  {totalCash != null && Number.isFinite(totalCash) && (
                    <div className="ib-summary-item">
                      <span className="label">总现金</span>
                      <span className="value">{fmtUsd(totalCash)}</span>
                    </div>
                  )}
                  {buyingPower != null && Number.isFinite(buyingPower) && (
                    <div className="ib-summary-item">
                      <span className="label">购买力</span>
                      <span className="value">{fmtUsd(buyingPower)}</span>
                    </div>
                  )}
                </div>

                {/* 股票持仓：数量即股数，总成本=数量×成本，浮动盈亏=（当前价-成本）×数量（仅对主标的 symbol 使用 spot） */}
                <div className="ib-positions-title">股票持仓</div>
                {stockPositions.length === 0 ? (
                  <p className="ib-positions-empty">无</p>
                ) : (
                  <>
                    <table className="ib-positions-table">
                      <thead>
                        <tr>
                          <th>标的</th>
                          <th>数量</th>
                          <th>成本</th>
                          <th>总成本</th>
                          <th>当前价</th>
                          <th>浮动盈亏</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stockPositions.map((pos, i) => {
                          const qty = pos.position != null ? Number(pos.position) : NaN
                          const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                          const totalCost = Number.isFinite(qty) && Number.isFinite(cost) ? qty * cost : null
                          const sym = (pos.symbol ?? '').toString().toUpperCase()
                          const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
                          const perPrice =
                            pos.price != null && Number.isFinite(Number(pos.price))
                              ? Number(pos.price)
                              : NaN
                          const showSpotForRow =
                            spot != null &&
                            Number.isFinite(spot) &&
                            sym !== '' &&
                            mainSym !== '' &&
                            sym === mainSym
                          const fallbackSpot = showSpotForRow ? spot : null
                          const currPrice =
                            Number.isFinite(perPrice) && perPrice > 0 ? perPrice : fallbackSpot
                          const pnl =
                            currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                              ? (currPrice - cost) * qty
                              : null
                          return (
                            <tr key={`stk-${pos.symbol}-${i}`} className="ib-pos-stock">
                              <td>{pos.symbol ?? '—'}</td>
                              <td>{pos.position != null ? pos.position : '—'}</td>
                              <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                              <td>{totalCost != null ? fmtUsd(totalCost) : '—'}</td>
                              <td>{currPrice != null ? fmtUsd(currPrice) : '—'}</td>
                              <td>{pnl != null ? fmtUsd(pnl) : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {(() => {
                      const sumTotal = stockPositions.reduce((acc, pos) => {
                        const qty = pos.position != null ? Number(pos.position) : NaN
                        const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                        if (Number.isFinite(qty) && Number.isFinite(cost)) return acc + qty * cost
                        return acc
                      }, 0)
                      if (!Number.isFinite(sumTotal)) return null
                      return (
                        <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                          股票总成本：{fmtUsd(sumTotal)}
                        </p>
                      )
                    })()}
                  </>
                )}

                {/* 期权持仓：数量负=卖空；权利金=-(数量×成本)，成本已含每手(100)，卖空为正(收入)、买入为负(支出) */}
                <div className="ib-positions-title" style={{ marginTop: '1rem' }}>期权持仓</div>
                {optionPositions.length === 0 ? (
                  <p className="ib-positions-empty">无</p>
                ) : (
                  <>
                    <table className="ib-positions-table">
                      <thead>
                        <tr>
                          <th>标的</th>
                          <th>权利</th>
                          <th>到期</th>
                          <th>Strike</th>
                          <th>数量</th>
                          <th>多/空</th>
                          <th>成本</th>
                          <th>权利金</th>
                          <th>内在价值</th>
                          <th>虚实</th>
                        </tr>
                      </thead>
                      <tbody>
                        {optionPositions.map((pos, i) => {
                          const expiryRaw = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
                          const strike = pos.strike != null ? Number(pos.strike) : NaN
                          const qty = pos.position != null ? Number(pos.position) : NaN
                          const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                          const right = (pos.right ?? '').toUpperCase()
                          const isCall = right === 'C' || right === 'CALL'
                          const premium = Number.isFinite(qty) && Number.isFinite(cost) ? -(qty * cost) : null
                          const intrinsic = spot != null && Number.isFinite(strike) ? optionIntrinsic(isCall, strike, spot) : null
                          const moneyness = spot != null && Number.isFinite(strike) ? optionMoneyness(isCall, strike, spot) : '—'
                          const sideLabel = Number.isFinite(qty) ? (qty > 0 ? '多' : qty < 0 ? '空' : '—') : '—'
                          return (
                            <tr key={`opt-${pos.symbol}-${i}`} className="ib-pos-opt">
                              <td>{pos.symbol ?? '—'}</td>
                              <td>{rightLabel(pos.right)}</td>
                              <td>{expiryRaw ? fmtExpiry(expiryRaw) : '—'}</td>
                              <td>{Number.isFinite(strike) ? fmtUsd(strike) : '—'}</td>
                              <td>{pos.position != null ? pos.position : '—'}</td>
                              <td>{sideLabel}</td>
                              <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                              <td>{premium != null ? fmtUsd(premium) : '—'}</td>
                              <td>{intrinsic != null ? fmtUsd(intrinsic) : '—'}</td>
                              <td>{moneyness}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {(() => {
                      const sumPremium = optionPositions.reduce((acc, pos) => {
                        const qty = pos.position != null ? Number(pos.position) : NaN
                        const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                        if (Number.isFinite(qty) && Number.isFinite(cost)) return acc - qty * cost
                        return acc
                      }, 0)
                      if (!Number.isFinite(sumPremium)) return null
                      return (
                        <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                          期权权利金合计：{fmtUsd(sumPremium)}
                          {spot != null && (
                            <span className="section-desc" style={{ marginLeft: '0.5rem' }}>
                              （标的现价 {fmtUsd(spot)}）
                            </span>
                          )}
                        </p>
                      )
                    })()}
                  </>
                )}
              </div>
            </div>
          )
        })()}
      </div>
      )}

      {activeTab === 'hedge' && (
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
              <span>{label}</span>{' '}
              <span className="status-summary-value">{value}</span>
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
      )}

      {activeTab === 'operations' && (
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
      )}
    </div>
  )
}
