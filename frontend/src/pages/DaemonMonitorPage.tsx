import { useEffect, useRef, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten, postRetryIb, postStop, postMonitorStop, postMonitorConnect, fetchHealth } from '../api'

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
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

const MONITOR_SELF_CHECK_LABELS: Record<string, string> = {
  ok: '正常',
  degraded: '降级',
  blocked: '异常',
}

const MONITOR_REASON_LABELS: Record<string, string> = {
  monitor_stopped: '监控服务已停止',
  monitor_ib_error: '监控端 IB 连接异常（账户或行情）',
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

const MSG_AUTO_CLEAR_MS = 5000

function scheduleMsgClear(
  setter: (v: { text: string; isErr: boolean }) => void,
  timeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  delayMs: number = MSG_AUTO_CLEAR_MS
) {
  if (timeoutRef.current != null) clearTimeout(timeoutRef.current)
  timeoutRef.current = setTimeout(() => {
    setter({ text: '', isErr: false })
    timeoutRef.current = null
  }, delayMs)
}

export interface DaemonMonitorPageProps {
  status: StatusResponse | null
  operations: Operation[]
  loadStatus: () => Promise<StatusResponse | null>
  /** 切换到「设置」标签页（用于“在设置页修改”入口） */
  onNavigateToSettings?: () => void
}

export function DaemonMonitorPage({ status, operations, loadStatus, onNavigateToSettings }: DaemonMonitorPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null)
  const [healthTick, setHealthTick] = useState(0)
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const monitorCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const j = status
  const hb = j?.daemon_heartbeat
  const hbForCountdown = hb
  const intervalSec = hbForCountdown?.heartbeat_interval_sec ?? 10
  const nowSec = Date.now() / 1000
  void tick
  void healthTick
  const secondsUntilNextHeartbeat =
    hbForCountdown?.daemon_alive && hbForCountdown?.last_ts != null
      ? Math.max(0, Math.ceil(hbForCountdown.last_ts + intervalSec - nowSec))
      : null
  const suspended = j?.trading_suspended === true
  const ibConnected = hb?.ib_connected === true
  const showRetryIb = hb?.daemon_alive === true && !ibConnected

  useEffect(() => {
    return () => {
      if (ctrlMsgClearRef.current != null) clearTimeout(ctrlMsgClearRef.current)
      if (hedgeCtrlMsgClearRef.current != null) clearTimeout(hedgeCtrlMsgClearRef.current)
      if (monitorCtrlMsgClearRef.current != null) clearTimeout(monitorCtrlMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!hbForCountdown?.daemon_alive) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [hbForCountdown?.daemon_alive])

  useEffect(() => {
    fetchHealth()
      .then(() => setLastHealthAt(Date.now() / 1000))
      .catch(() => setLastHealthAt(null))
  }, [])

  useEffect(() => {
    if (lastHealthAt == null) return
    const id = setInterval(() => {
      const now = Date.now() / 1000
      setHealthTick((n) => n + 1)
      if (now - lastHealthAt >= 60) {
        fetchHealth()
          .then(() => setLastHealthAt(Date.now() / 1000))
          .catch(() => setLastHealthAt(null))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [lastHealthAt])

  let daemonLabel = '未运行（或单进程模式）'
  let daemonHint = '在交易机执行 run_engine.py 后此处会显示运行中'
  let hedgeLabel = (j?.status?.ts != null && nowSec - (j.status.ts as number) < 90) ? '运行中（单进程）' : '未运行'
  let hedgeHint = (j?.status?.ts != null && nowSec - (j.status.ts as number) < 90)
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
  const monitorEnabled = j?.monitor_enabled !== false
  const monitorStatus = (j?.monitor_ib_status as any) || {}
  const monitorAccount = monitorStatus.account as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorMarket = monitorStatus.market as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorHasError = Boolean(monitorAccount?.last_error || monitorMarket?.last_error)
  const monitorLamp =
    !monitorEnabled
      ? 'red'
      : monitorHasError
        ? 'yellow'
        : monitorAccount && !monitorAccount.connected
          ? 'yellow'
          : (monitorAccount?.connected || monitorMarket?.connected)
            ? 'green'
            : 'yellow'
  const suspendedInReasons = j?.block_reasons?.includes('trading_suspended') ?? false
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

  const monitorSelfCheckText =
    MONITOR_SELF_CHECK_LABELS[j?.monitor_self_check ?? ''] ?? j?.monitor_self_check ?? '--'
  const monitorBlockReasons = (j?.monitor_block_reasons ?? [])
    .map((r) => MONITOR_REASON_LABELS[r] ?? r)
    .join('；') || '无'

  const monitorIbGroupLamp =
    !monitorEnabled ? 'none' : (monitorAccount?.connected && monitorMarket?.connected) ? 'green' : (monitorAccount?.connected || monitorMarket?.connected) ? 'yellow' : 'red'

  const healthElapsedSec = lastHealthAt != null ? Math.floor(Date.now() / 1000 - lastHealthAt) : null
  const healthCountdownSec =
    lastHealthAt != null ? Math.max(0, 60 - (healthElapsedSec! % 60)) : null
  const apiHealthLamp = lastHealthAt != null ? 'green' : 'red'

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
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
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
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
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
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onFlatten = async () => {
    setMsg(setHedgeCtrlMsg, '请求平敞口中…', false)
    const res = await postFlatten()
    setMsg(
      setHedgeCtrlMsg,
      res.ok ? '已发送平敞口指令，由对冲程序消费并执行。' : (res.error ?? ''),
      !res.ok
    )
    scheduleMsgClear(setHedgeCtrlMsg, hedgeCtrlMsgClearRef)
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
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onMonitorStop = async () => {
    setMsg(setMonitorCtrlMsg, '正在停止监控服务…', false)
    const res = await postMonitorStop()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? '监控服务已停止（不再向 IB 发起新请求）。' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  const onMonitorConnect = async () => {
    setMsg(setMonitorCtrlMsg, '正在建立监控端 IB 连接…', false)
    const res = await postMonitorConnect()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? '已请求连接监控端 IB（账户 + 行情），稍后在状态栏查看连接结果。' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  return (
    <>
      <div className="card process-section">
        <h2>守护程序状态</h2>
        <div className="daemon-header">
          <div className="daemon-header-main">
            <div className="row" style={{ marginBottom: '0.35rem' }}>
              <div className={`lamp ${daemonLamp}`} title="守护程序状态灯" />
              <div>
                <strong>自检: {j ? daemonSelfCheckText : '获取失败'}</strong>
                <div className="block-reasons">{j ? daemonBlockReasons : ''}</div>
                <span className="process-summary">状态: {daemonLabel}</span>
              </div>
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
              <span className="daemon-group-title">
                {onNavigateToSettings ? (
                  <button type="button" className="link-button" onClick={onNavigateToSettings} style={{ fontSize: 'inherit', fontWeight: 'inherit' }}>
                    心跳
                  </button>
                ) : (
                  '心跳'
                )}
              </span>
            </div>
            <div className="daemon-group-body">
              {hb?.daemon_alive && hb.last_ts != null ? (
                <p className="section-hint">最后心跳: <strong>{fmtTs(hb.last_ts)}</strong></p>
              ) : hb?.graceful_shutdown_at != null ? (
                <p className="section-hint">已于 <strong>{fmtTs(hb.graceful_shutdown_at)}</strong> 优雅停止（SIGTERM/Stop）</p>
              ) : hb?.last_ts != null ? (
                <p className="section-hint">最后心跳: <strong>{fmtTs(hb.last_ts)}</strong>（已超时，可能被 kill -9 或崩溃）</p>
              ) : (
                <p className="section-hint">{daemonHint || '—'}</p>
              )}
              {hb?.daemon_alive && secondsUntilNextHeartbeat != null && (
                <p className="section-hint countdown-line">
                  下次心跳: <span className="countdown-num">{secondsUntilNextHeartbeat}</span> 秒
                </p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${ibGroupLamp}`} title="IB 连接状态" />
              <span className="daemon-group-title">
                {onNavigateToSettings ? (
                  <button type="button" className="link-button" onClick={onNavigateToSettings} style={{ fontSize: 'inherit', fontWeight: 'inherit' }}>
                    IB 连接
                  </button>
                ) : (
                  'IB 连接'
                )}
              </span>
            </div>
            <div className="daemon-group-body">
              {ibConnected ? (
                <p className="section-hint countdown-line">
                  IB: <span className="countdown-num">已连接</span> (Client ID {hb?.ib_client_id ?? '?'})
                </p>
              ) : (
                <p className="section-hint">{daemonIbLine || '—'}</p>
              )}
              {hb?.daemon_alive && !ibConnected && (
                <p className="section-hint">会在下次心跳时，尝试重连。</p>
              )}
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
              <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.redis_quotes_connected ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="守护程序 Redis 状态" />
              <span className="daemon-group-title">数据库</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Redis: {!hb?.daemon_alive ? '—' : hb.redis_quotes_connected ? '已连接（写行情并发布联动）' : '未连接或未配置'}
              </p>
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

        {ctrlMsg.text ? (
          <div className={`msg ${ctrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {ctrlMsg.text}
          </div>
        ) : null}
      </div>

      <div className="card process-section">
        <h2>监控服务状态</h2>
        <div className="daemon-header">
          <div className="daemon-header-main">
            <div className="row" style={{ marginBottom: '0.35rem' }}>
              <div className={`lamp ${monitorLamp}`} title="监控服务状态灯" />
              <div>
                <strong>自检: {j ? monitorSelfCheckText : '获取失败'}</strong>
                <div className="block-reasons">{j ? monitorBlockReasons : '无'}</div>
                <span className="process-summary">当前：{monitorEnabled ? '运行中' : '已停止'}</span>
              </div>
            </div>
          </div>
          <div className="monitor-header-actions">
            <button
              type="button"
              className="btn-stop"
              disabled={!monitorEnabled}
              title={monitorEnabled ? '停止监控端与 IB 的交互，并断开长连接' : '当前已停止'}
              onClick={onMonitorStop}
            >
              停止监控
            </button>
          </div>
        </div>

        <div className="daemon-groups">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${apiHealthLamp}`} title="API 服务（Health 可访问为绿，否则红）" />
              <span className="daemon-group-title">API 服务</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                <strong>自检: {j ? monitorSelfCheckText : '获取失败'}</strong>
              </p>
              <div className="block-reasons">{j ? monitorBlockReasons : '—'}</div>
              <p className="section-hint">
                当前：<strong>{monitorEnabled ? '运行中' : '已停止'}</strong>
              </p>
              {healthCountdownSec != null ? (
                <p className="section-hint countdown-line">
                  下次健康检查: <span className="countdown-num">{healthCountdownSec}</span> 秒
                </p>
              ) : (
                <p className="section-hint">健康检查：—</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${monitorIbGroupLamp}`} title="监控端 IB 连接状态" />
              <span className="daemon-group-title">IB 连接</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint countdown-line">
                账户 IB 连接（AccountIbClient）：
                {monitorAccount?.connected ? (
                  <>
                    <span className="countdown-num">已连接</span>
                    {' '}(
                    Client ID <span className="countdown-num">{monitorAccount?.client_id ?? '—'}</span>
                    )
                  </>
                ) : (
                  '未连接'
                )}
              </p>
              <p className="section-hint countdown-line">
                行情 IB 连接（MarketIbClient）：
                {monitorMarket?.connected ? (
                  <>
                    <span className="countdown-num">已连接</span>
                    {' '}(
                    Client ID <span className="countdown-num">{monitorMarket?.client_id ?? '—'}</span>
                    )
                  </>
                ) : (
                  '未连接'
                )}
              </p>
              {monitorAccount?.last_error && (
                <p className="section-hint">账户客户端错误: {monitorAccount.last_error}</p>
              )}
              {monitorMarket?.last_error && (
                <p className="section-hint">行情客户端错误: {monitorMarket.last_error}</p>
              )}
              <div className="controls" style={{ marginTop: '0.25rem' }}>
                <button
                  type="button"
                  className="btn-resume"
                  disabled={!monitorEnabled}
                  title={monitorEnabled ? '显式建立监控端与 IB 的长连接（AccountIbClient + MarketIbClient）' : '监控已停止，无法连接'}
                  onClick={onMonitorConnect}
                >
                  打开 IB 账户连接
                </button>
              </div>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${j?.redis_quotes_connected ? 'green' : monitorEnabled ? 'red' : 'none'}`} title="监控端 Redis 状态" />
              <span className="daemon-group-title">数据库</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Redis: {!monitorEnabled ? '—' : j?.redis_quotes_connected ? '已连接（可读 GET /quotes）' : '未连接或未配置'}
              </p>
            </div>
          </div>
        </div>
        {monitorCtrlMsg.text ? (
          <div className={`msg ${monitorCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {monitorCtrlMsg.text}
          </div>
        ) : null}
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
        {hedgeCtrlMsg.text ? (
          <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'}`}>
            {hedgeCtrlMsg.text}
          </div>
        ) : null}
      </div>

      <div className="card card-operations">
        <h2>近期操作</h2>
        <table className="table-operations">
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
                  <td>{fmtUsd(op.price)}</td>
                  <td>{op.state_reason ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
