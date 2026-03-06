import { useEffect, useRef, useState } from 'react'
import type { Operation, RealtimeQuote, StatusResponse } from '../types'
import { postSuspend, postResume, postFlatten, postReleaseIb, postStop, postMonitorStop, postMonitorReleaseIb, postCeleryStop, postCeleryConnect, postMonitorConnect, fetchHealth, postRefreshTickerSubscriptions, fetchQuotes, subscribeQuotes, fetchCeleryLogs, subscribeCeleryLogs, clearCeleryLogs, trimCeleryLogs } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

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

/** 根据 ts (Unix 秒) 与当前时间差显示：秒 → 分钟 → 小时 → 天 */
function fmtSince(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const nowSec = Date.now() / 1000
  const elapsed = Math.max(0, Math.floor(nowSec - ts))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`
  return `${Math.floor(elapsed / 86400)}d`
}

const HEDGE_REASON_LABELS: Record<string, string> = {
  trading_suspended: 'Hedge suspended',
  no_status: 'No status data',
  daemon_not_running: 'Daemon not running',
  data_stale: 'Data stale',
  trading_state_pause_cost: 'Trading state: Pause cost',
  trading_state_risk_halt: 'Trading state: Risk halt',
  trading_state_stale: 'Trading state: Stale',
  trading_state_force_hedge: 'Trading state: Force hedge',
  status_read_error: 'Server read error (lock timeout or connection issue; please refresh later)',
}

const DAEMON_REASON_LABELS: Record<string, string> = {
  no_heartbeat: 'No heartbeat data',
  daemon_not_running: 'Daemon not running',
  heartbeat_stale: 'Heartbeat not updating (no DB write for >35s; daemon may be busy or stuck)',
  ib_not_connected: 'IB not connected',
  status_read_error: 'Server read error (lock timeout or connection issue; please refresh later)',
}

const DAEMON_SELF_CHECK_LABELS: Record<string, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  blocked: 'Blocked',
}

const MONITOR_SELF_CHECK_LABELS: Record<string, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  blocked: 'Blocked',
}

const MONITOR_REASON_LABELS: Record<string, string> = {
  monitor_stopped: 'Monitor service stopped',
  monitor_ib_error: 'Monitor IB connection error (account or market)',
}

const DAEMON_STATE_LABELS: Record<string, string> = {
  running: 'Running',
  running_suspended: 'Running (hedge suspended)',
  connecting: 'Connecting',
  waiting_ib: 'Waiting for IB (auto-retry)',
  connected: 'Connected',
  stopping: 'Stopping',
  stopped: 'Stopped',
  idle: 'Idle',
}

const STATUS_FIELDS: [string, string][] = [
  ['daemon_state', 'Daemon state'],
  ['trading_state', 'Trading state'],
  ['symbol', 'Symbol'],
  ['spot', 'Spot price'],
  ['stock_position', 'Stock position'],
  ['daily_hedge_count', 'Daily hedge count'],
  ['ts', 'Updated at'],
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
  /** Navigate to Settings tab (for "edit in Settings" entry) */
  onNavigateToSettings?: () => void
}

export function DaemonMonitorPage({ status, operations, loadStatus, onNavigateToSettings: _onNavigateToSettings }: DaemonMonitorPageProps) {
  const [ctrlMsg, setCtrlMsg] = useState({ text: '', isErr: false })
  const [hedgeCtrlMsg, setHedgeCtrlMsg] = useState({ text: '', isErr: false })
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
  const [celeryCtrlMsg, setCeleryCtrlMsg] = useState({ text: '', isErr: false })
  const [syncTickerLoading, setSyncTickerLoading] = useState(false)
  const [syncTickerMsg, setSyncTickerMsg] = useState({ text: '', isErr: false })
  const [tick, setTick] = useState(0)
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null)
  const [healthTick, setHealthTick] = useState(0)
  const [systemTab, setSystemTab] = useState<'daemon' | 'monitor' | 'celery' | 'strategy'>('daemon')
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [quoteTick, setQuoteTick] = useState(0)
  const [celeryConsoleLines, setCeleryConsoleLines] = useState<string[]>([])
  const [celeryConsoleStatus, setCeleryConsoleStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [celeryConsoleHeightPx, setCeleryConsoleHeightPx] = useState(260)
  const [celeryConsoleMaxLines, setCeleryConsoleMaxLines] = useState(500)
  const celeryConsoleMaxLinesRef = useRef(500)
  const ctrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hedgeCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTickerMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const monitorCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const celeryCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const celeryConsoleRef = useRef<HTMLPreElement | null>(null)

  const j = status
  const hb = j?.daemon_heartbeat
  const hbForCountdown = hb
  const quotesCount = Object.keys(quotesMap).length
  const intervalSec = hbForCountdown?.heartbeat_interval_sec ?? 10
  const nowSec = Date.now() / 1000
  void tick
  void healthTick
  void quoteTick
  const secondsUntilNextHeartbeat =
    hbForCountdown?.daemon_alive && hbForCountdown?.last_ts != null
      ? Math.max(0, Math.ceil(hbForCountdown.last_ts + intervalSec - nowSec))
      : null
  const suspended = j?.trading_suspended === true
  const ibConnected = hb?.ib_connected === true

  useEffect(() => {
    return () => {
      if (ctrlMsgClearRef.current != null) clearTimeout(ctrlMsgClearRef.current)
      if (hedgeCtrlMsgClearRef.current != null) clearTimeout(hedgeCtrlMsgClearRef.current)
      if (syncTickerMsgClearRef.current != null) clearTimeout(syncTickerMsgClearRef.current)
      if (monitorCtrlMsgClearRef.current != null) clearTimeout(monitorCtrlMsgClearRef.current)
      if (celeryCtrlMsgClearRef.current != null) clearTimeout(celeryCtrlMsgClearRef.current)
    }
  }, [])

  // 实时行情：初始拉取 + SSE 订阅（监听 Redis 推送）
  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap((prev) => {
            const next = { ...prev }
            res.quotes!.forEach((q) => {
              next[q.symbol] = q
            })
            return next
          })
        }
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      setQuotesMap((prev) => ({ ...prev, [q.symbol]: q }))
    })
    return () => {
      cancelled = true
      unsub()
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

  // Refresh "Since" column every second when we have quotes
  useEffect(() => {
    const count = Object.keys(quotesMap).length
    if (count === 0) return
    const id = setInterval(() => setQuoteTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [quotesCount])

  useEffect(() => {
    celeryConsoleMaxLinesRef.current = celeryConsoleMaxLines
  }, [celeryConsoleMaxLines])

  // Celery Console: fetch initial lines + SSE stream (Redis Stream, Scheme B); trim to max lines
  useEffect(() => {
    let unsub: (() => void) | null = null
    const maxLines = celeryConsoleMaxLinesRef.current
    setCeleryConsoleStatus('connecting')
    fetchCeleryLogs(maxLines)
      .then((res) => {
        const lines = res.lines ?? []
        const trimmed = lines.length > maxLines ? lines.slice(-maxLines) : lines
        setCeleryConsoleLines(trimmed)
        setCeleryConsoleStatus(res.error ? 'error' : 'connected')
        if (lines.length > maxLines) {
          trimCeleryLogs(maxLines).catch(() => {})
        }
        if (!res.error) {
          unsub = subscribeCeleryLogs(
            (line) => {
              const limit = celeryConsoleMaxLinesRef.current
              setCeleryConsoleLines((prev) => [...prev, line].slice(-limit))
            },
            () => setCeleryConsoleStatus('error'),
          )
        }
      })
      .catch(() => setCeleryConsoleStatus('error'))
    return () => {
      if (unsub) unsub()
    }
  }, [])

  // Auto-scroll Celery console to bottom when new lines arrive
  useEffect(() => {
    const el = celeryConsoleRef.current
    const container = el?.parentElement
    if (container) container.scrollTop = container.scrollHeight
  }, [celeryConsoleLines.length])

  const onCeleryConsoleResizeStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const startY = e.clientY
    const startHeight = celeryConsoleHeightPx
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(600, Math.max(120, startHeight + (ev.clientY - startY)))
      setCeleryConsoleHeightPx(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  let daemonLabel = 'Not running (or single-process mode)'
  let daemonHint = 'Run run_engine.py on the trading machine to see "Running" here'
  let hedgeLabel = (j?.status?.ts != null && nowSec - (j.status.ts as number) < 90) ? 'Running (single-process)' : 'Not running'
  let hedgeHint = (j?.status?.ts != null && nowSec - (j.status.ts as number) < 90)
    ? 'Single-process mode (run_engine.py); status written by hedge logic'
    : ''
  let daemonIbLine = ''

  if (hb?.daemon_alive) {
    daemonLabel = 'Running'
    daemonHint = hb.last_ts != null ? `Last heartbeat: ${fmtTs(hb.last_ts)}` : ''
    hedgeLabel = hb.hedge_running ? 'Running' : 'Suspended (or not started)'
    hedgeHint = hb.hedge_running
      ? 'Single-process: daemon and hedge in same process'
      : 'Click "Resume" on monitor to resume'
    daemonIbLine = `Trading Client: ${ibConnected ? `Connected @ ${hb.ib_client_id ?? '?'}` : 'Not connected'}`
  } else if (hb) {
    daemonLabel = 'Not running'
    if (hb.graceful_shutdown_at != null) {
      daemonHint = `Gracefully stopped at ${fmtTs(hb.graceful_shutdown_at)} (SIGTERM/Stop)`
    } else {
      daemonHint =
        hb.last_ts != null
          ? `Last heartbeat: ${fmtTs(hb.last_ts)} (timed out; may have been kill -9 or crash)`
          : ''
    }
    hedgeLabel = 'Not running'
    hedgeHint = 'In dual-process mode, hedge does not run when daemon is down'
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
    (j?.self_check ?? '--') + (suspendedInReasons ? ' (hedge suspended)' : '')
  const daemonBlockReasons = (j?.daemon_block_reasons ?? [])
    .map((r) => DAEMON_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'
  const hedgeBlockReasons = (j?.block_reasons ?? [])
    .map((r) => HEDGE_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'

  const monitorSelfCheckText =
    MONITOR_SELF_CHECK_LABELS[j?.monitor_self_check ?? ''] ?? j?.monitor_self_check ?? '--'
  const monitorBlockReasons = (j?.monitor_block_reasons ?? [])
    .map((r) => MONITOR_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'

  const monitorIbGroupLamp =
    !monitorEnabled ? 'none' : (monitorAccount?.connected && monitorMarket?.connected) ? 'green' : (monitorAccount?.connected || monitorMarket?.connected) ? 'yellow' : 'red'

  const celeryBrokerConnected = j?.celery_broker_connected === true
  const celeryLastTs = j?.celery_worker_last_updated_ts
  const celeryWorkerIbConnected = j?.celery_worker_ib_connected === true
  const celeryWorkerIbClientId = j?.celery_worker_ib_client_id ?? null
  /** 与 Monitor 的轮询方式一致：仅以 GET /status 时对 Celery 的 inspect ping 结果判断 Worker 是否存活，不依赖“近期 job 更新” */
  const celeryWorkersAlive = (j?.celery_workers?.length ?? 0) > 0
  const nowSecForCelery = Date.now() / 1000
  const celeryWorkerRecent = celeryLastTs != null && Number.isFinite(celeryLastTs) && (nowSecForCelery - celeryLastTs) < 600
  const celeryLamp =
    !celeryBrokerConnected ? 'red' : celeryWorkersAlive ? 'green' : 'yellow'

  const healthElapsedSec = lastHealthAt != null ? Math.floor(Date.now() / 1000 - lastHealthAt) : null
  const healthCountdownSec =
    lastHealthAt != null ? Math.max(0, 60 - (healthElapsedSec! % 60)) : null
  const apiHealthLamp = lastHealthAt != null ? 'green' : 'red'

  const runStatusLabel = suspended ? 'Suspended (no new hedges)' : 'Running'
  const heartbeatGroupLamp = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const ibGroupLamp = !hb?.daemon_alive ? 'none' : ibConnected ? 'green' : 'red'
  const strategyGroupLamp = suspended ? 'red' : 'green'

  const s = j?.status ?? {}
  /** Symbols to show: from status (Wishlist STK + strategy symbol) first; merge with any symbols that have quote data. */
  const watchlistSymbols = [...new Set([...(j?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort()
  /** Aggregate current stock positions per symbol for Watchlist (qty, cost, pnl). */
  const accountsList = j?.accounts ?? []
  const watchlistRows = watchlistSymbols.map((symbol) => {
    let qty = 0
    let totalCost = 0
    let hasCost = false
    for (const acc of accountsList) {
      const positions = acc?.positions ?? []
      for (const p of positions) {
        const sym = (p.symbol || '').trim()
        const secType = (p.secType || '').toString().toUpperCase()
        const posQty = typeof p.position === 'number' ? p.position : 0
        if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
        qty += posQty
        if (p.avgCost != null && Number.isFinite(p.avgCost as number)) {
          totalCost += (p.avgCost as number) * posQty
          hasCost = true
        }
      }
    }
    const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
    const quote = quotesMap[symbol]
    let pnl: number | null = null
    if (quote && avgCost != null && Number.isFinite(quote.last) && qty !== 0) {
      pnl = (quote.last - avgCost) * qty
    }
    return { symbol, quote, qty: qty || null, avgCost, pnl }
  })
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
    setMsg(setCtrlMsg, 'Setting suspend…', false)
    const res = await postSuspend()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Suspend set; daemon will pause new hedges on next heartbeat.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onResume = async () => {
    setMsg(setCtrlMsg, 'Setting resume…', false)
    const res = await postResume()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Resume set; daemon will resume hedging on next heartbeat.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onReleaseIb = async () => {
    setMsg(setCtrlMsg, 'Requesting release IB…', false)
    const res = await postReleaseIb()
    setMsg(
      setCtrlMsg,
      res.ok
        ? 'Reset sent. Daemon will release both Trading and Listener IB connections on its next heartbeat, then enter WAITING_IB (daemon keeps running). Use «Retry IB connection» below to reconnect when ready.'
        : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onFlatten = async () => {
    setMsg(setHedgeCtrlMsg, 'Requesting flatten…', false)
    const res = await postFlatten()
    setMsg(
      setHedgeCtrlMsg,
      res.ok ? 'Flatten sent; hedge process will consume and execute.' : (res.error ?? ''),
      !res.ok
    )
    scheduleMsgClear(setHedgeCtrlMsg, hedgeCtrlMsgClearRef)
  }

  const onStop = async () => {
    setMsg(setCtrlMsg, 'Requesting daemon stop…', false)
    const res = await postStop()
    setMsg(
      setCtrlMsg,
      res.ok ? 'Stop sent; daemon will exit and clear ib_client_id; next start uses client_id=1.' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCtrlMsg, ctrlMsgClearRef)
  }

  const onMonitorStop = async () => {
    setMsg(setMonitorCtrlMsg, 'Stopping monitor service…', false)
    const res = await postMonitorStop()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? 'Monitor service stopped (no new IB requests).' : (res.error ?? ''),
      !res.ok
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  const onMonitorConnect = async () => {
    setMsg(setMonitorCtrlMsg, 'Establishing monitor IB connection…', false)
    const res = await postMonitorConnect()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? 'Monitor IB connect requested (account + market); check status bar for result.' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  const onMonitorReleaseIb = async () => {
    setMsg(setMonitorCtrlMsg, 'Releasing monitor IB connections…', false)
    const res = await postMonitorReleaseIb()
    setMsg(
      setMonitorCtrlMsg,
      res.ok ? 'Monitor IB connections released (Account + Market client_id). Use Connect to reconnect.' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setMonitorCtrlMsg, monitorCtrlMsgClearRef)
  }

  const onCeleryStop = async () => {
    setMsg(setCeleryCtrlMsg, 'Requesting Celery worker stop…', false)
    const res = await postCeleryStop()
    setMsg(
      setCeleryCtrlMsg,
      res.ok ? 'Celery worker stop requested; process will exit within a few seconds.' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) loadStatus()
    scheduleMsgClear(setCeleryCtrlMsg, celeryCtrlMsgClearRef)
  }

  const onCeleryConnect = async () => {
    setMsg(setCeleryCtrlMsg, 'Requesting Worker IB connection…', false)
    const res = await postCeleryConnect()
    setMsg(
      setCeleryCtrlMsg,
      res.ok ? 'Worker connect requested; status will update in a few seconds. (Ensure Celery worker is running: python scripts/run_celery.py)' : (res.error ?? ''),
      !res.ok,
    )
    if (res.ok) {
      loadStatus()
      // Poll status every 2s for 12s so UI updates when Worker connects (worker polls every 5s)
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        loadStatus()
        if (i === 2) scheduleMsgClear(setCeleryCtrlMsg, celeryCtrlMsgClearRef)
      }
    } else {
      scheduleMsgClear(setCeleryCtrlMsg, celeryCtrlMsgClearRef)
    }
  }

  return (
    <>
      <div className="card process-section system-tabs-wrapper">
        <div className="system-tabs" role="tablist" aria-label="System sections">
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'daemon'}
            aria-controls="system-panel-daemon"
            id="tab-daemon"
            className={`system-tab ${systemTab === 'daemon' ? 'active' : ''}`}
            onClick={() => setSystemTab('daemon')}
          >
            <span className={`lamp lamp-sm ${daemonLamp}`} title="Daemon status" aria-hidden />
            <span>Daemon</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'monitor'}
            aria-controls="system-panel-monitor"
            id="tab-monitor"
            className={`system-tab ${systemTab === 'monitor' ? 'active' : ''}`}
            onClick={() => setSystemTab('monitor')}
          >
            <span className={`lamp lamp-sm ${monitorLamp}`} title="Monitor status" aria-hidden />
            <span>Monitor</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'celery'}
            aria-controls="system-panel-celery"
            id="tab-celery"
            className={`system-tab ${systemTab === 'celery' ? 'active' : ''}`}
            onClick={() => setSystemTab('celery')}
          >
            <span className={`lamp lamp-sm ${celeryLamp}`} title="Celery (bars worker) status" aria-hidden />
            <span>Celery</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={systemTab === 'strategy'}
            aria-controls="system-panel-strategy"
            id="tab-strategy"
            className={`system-tab ${systemTab === 'strategy' ? 'active' : ''}`}
            onClick={() => setSystemTab('strategy')}
          >
            <span className={`lamp lamp-sm ${hedgeLamp}`} title="Trading strategy status" aria-hidden />
            <span>Trading Strategy</span>
          </button>
        </div>

        {systemTab === 'daemon' && (
      <div id="system-panel-daemon" role="tabpanel" aria-labelledby="tab-daemon" className="system-tab-panel">
      <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${daemonLamp}`} title="Daemon status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Daemon</h2>
              <div>
                <strong>Status: {j ? `${daemonLabel} (${daemonSelfCheckText})` : 'Fetch failed'}</strong>
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
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${ibGroupLamp}`} title="IB connection status" />
              <span className="daemon-group-title">IB connection</span>
            </div>
            <div className="daemon-group-body">
              {ibConnected ? (
                <p className="section-hint countdown-line">
                  Trading Client: <span className="countdown-num">Connected @ {hb?.ib_client_id ?? '?'}</span>
                </p>
              ) : (
                <p className="section-hint">{daemonIbLine || '—'}</p>
              )}
              {j?.ib_config?.ib_client_id_listener != null && (
                <p className="section-hint countdown-line">
                  Listener Client: {hb?.listener_connected ? (
                    <span className="countdown-num">Connected @ {hb?.listener_client_id ?? j.ib_config.ib_client_id_listener}</span>
                  ) : (
                    <span>Not connected</span>
                  )}
                </p>
              )}
              {ibConnected && (
                <div className="controls">
                  <button
                    type="button"
                    className="btn-retry-ib"
                    title="Release IB connection on next daemon heartbeat (daemon will go to WAITING_IB and can retry later)"
                    onClick={onReleaseIb}
                  >
                    Reset
                  </button>
                </div>
              )}
              {hb?.daemon_alive && !ibConnected && (
                <p className="section-hint section-hint--retry">Will retry connection on next heartbeat.</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.redis_quotes_connected ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Daemon Redis status" />
              <span className="daemon-group-title">Database</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Redis: {!hb?.daemon_alive ? '—' : hb.redis_quotes_connected ? 'Connected (writes quotes and publishes)' : 'Not connected or not configured'}
              </p>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <span className="daemon-group-title">Event Subscribe</span>
              <InfoTooltip text="Daemon IB event subscription status: ticker (Wishlist STK), positions, fills, commission. Green = subscribed; red = not subscribed when daemon is running." />
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
        </div>

        {ctrlMsg.text ? (
          <div className={`msg ${ctrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {ctrlMsg.text}
          </div>
        ) : null}
      </div>
        )}

        {systemTab === 'monitor' && (
      <div id="system-panel-monitor" role="tabpanel" aria-labelledby="tab-monitor" className="system-tab-panel">
        <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${monitorLamp}`} title="Monitor status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Monitor</h2>
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
                <strong>Status: {j ? `${monitorEnabled ? 'Running' : 'Stopped'} (${monitorSelfCheckText})` : 'Fetch failed'}</strong>
                {j && monitorBlockReasons && monitorBlockReasons !== 'None' ? ` Block reasons: ${monitorBlockReasons}` : ''}
              </p>
              {healthCountdownSec != null ? (
                <p className="section-hint countdown-line">
                  Next health check: <span className="countdown-num">{healthCountdownSec}</span> s
                </p>
              ) : (
                <p className="section-hint">Health check: —</p>
              )}
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${monitorIbGroupLamp}`} title="Monitor IB connection status" />
              <span className="daemon-group-title">IB connection</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint countdown-line">
                Account Client:{' '}
                {monitorAccount?.connected ? (
                  <span className="countdown-num">Connected @ {monitorAccount?.client_id ?? '—'}</span>
                ) : (
                  'Not connected'
                )}
              </p>
              <p className="section-hint countdown-line">
                Market Client:{' '}
                {monitorMarket?.connected ? (
                  <span className="countdown-num">Connected @ {monitorMarket?.client_id ?? '—'}</span>
                ) : (
                  'Not connected'
                )}
              </p>
              {monitorAccount?.last_error && (
                <p className="section-hint">Account client error: {monitorAccount.last_error}</p>
              )}
              {monitorMarket?.last_error && (
                <p className="section-hint">Market client error: {monitorMarket.last_error}</p>
              )}
              <div className="controls" style={{ marginTop: '0.25rem' }}>
                {(monitorAccount?.connected || monitorMarket?.connected) ? (
                  <button
                    type="button"
                    className="btn-retry-ib"
                    title="Release Monitor IB connections (Account + Market client_id). Monitor keeps running; use Connect to reconnect."
                    onClick={onMonitorReleaseIb}
                  >
                    Release
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-resume"
                    disabled={!monitorEnabled}
                    title={monitorEnabled ? 'Establish monitor IB connection (AccountIbClient + MarketIbClient)' : 'Monitor stopped; cannot connect'}
                    onClick={onMonitorConnect}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${j?.redis_quotes_connected ? 'green' : monitorEnabled ? 'red' : 'none'}`} title="Monitor Redis status" />
              <span className="daemon-group-title">Database</span>
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                Redis: {!monitorEnabled ? '—' : j?.redis_quotes_connected ? 'Connected (GET /quotes available)' : 'Not connected or not configured'}
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
        )}

        {systemTab === 'celery' && (
      <div id="system-panel-celery" role="tabpanel" aria-labelledby="tab-celery" className="system-tab-panel">
        <div className="daemon-header">
          <div className="daemon-header-main daemon-header-with-lamp">
            <div className="lamp-wrap-span">
              <div className={`lamp lamp-sm ${celeryLamp}`} title="Celery status lamp" />
            </div>
            <div>
              <h2 className="daemon-card-title">Celery</h2>
              <div>
                <strong>Status: {j ? (celeryBrokerConnected ? (celeryWorkersAlive ? 'Broker connected, worker(s) running (ping ok)' : 'Broker connected, no workers (start: python scripts/run_celery.py)') : 'Broker not connected') : 'Fetch failed'}</strong>
              </div>
            </div>
          </div>
          <div className="monitor-header-actions">
            <button
              type="button"
              className="btn-stop"
              title="Stop Celery worker process (same as Monitor/Daemon Stop); restart with: python scripts/run_celery.py"
              onClick={onCeleryStop}
            >
              Stop
            </button>
          </div>
        </div>
        <div className="daemon-groups">
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${celeryBrokerConnected ? 'green' : 'red'}`} title="Celery broker (Redis) status" />
              <span className="daemon-group-title">Broker (Redis)</span>
              <InfoTooltip text="Celery broker and result backend. Same Redis as config.redis (db 1 for Celery). Required for queued bars backfill. Worker (Bars Backfill) status is shown in Recent operations." />
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                {celeryBrokerConnected ? 'Connected (bars queue available)' : 'Not connected or Redis not configured'}
              </p>
            </div>
          </div>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${(j?.celery_workers?.length ?? 0) > 0 ? 'green' : celeryBrokerConnected ? 'yellow' : 'none'}`} title="Celery workers responding to ping" />
              <span className="daemon-group-title">Celery Workers</span>
              <InfoTooltip text="Workers that responded to inspect ping. Worker connects to IB using Settings → Celery worker_market; connection is kept so backfill can use it. Use Stop above to terminate the worker." />
            </div>
            <div className="daemon-group-body">
              <p className="section-hint">
                {(j?.celery_workers?.length ?? 0) > 0
                  ? (j?.celery_workers ?? []).join(', ')
                  : 'None (start worker: python scripts/run_celery.py)'}
              </p>
              <p className="section-hint countdown-line">
                IB Client ID:{' '}
                {celeryWorkerIbConnected ? (
                  <span className="countdown-num">Connected @ {celeryWorkerIbClientId ?? '—'}</span>
                ) : (
                  <>
                    Not connected{' '}
                    <InfoTooltip text="IB connection is inside the Worker process. Start worker first: python scripts/run_celery.py (uses Settings → Celery worker_market)." />
                  </>
                )}
              </p>
              <div className="controls" style={{ marginTop: '0.25rem' }}>
                <button
                  type="button"
                  className="btn-resume"
                  disabled={celeryWorkerIbConnected || (j?.celery_workers?.length ?? 0) === 0}
                  title={
                    (j?.celery_workers?.length ?? 0) === 0
                      ? 'Start worker first (python scripts/run_celery.py); IB connection runs inside the worker process'
                      : celeryWorkerIbConnected
                        ? 'Already connected'
                        : 'Request Worker to connect to IB (Settings → Celery worker_market)'
                  }
                  onClick={onCeleryConnect}
                >
                  Connect
                </button>
              </div>
            </div>
          </div>
        </div>
        {celeryCtrlMsg.text ? (
          <div className={`msg ${celeryCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {celeryCtrlMsg.text}
          </div>
        ) : null}
      </div>
        )}

        {systemTab === 'strategy' && (
      <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className="system-tab-panel">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${hedgeLamp}`} title="Trading strategy status lamp" />
          </div>
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              Trading Strategy
              <InfoTooltip text="Depends on daemon; business logic; may support multiple strategies later." />
            </h2>
            <div>
              <strong>Status: {j ? `${hedgeLabel} (${hedgeSelfCheckText})` : 'Fetch failed'}</strong>
              {j && hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` Block reasons: ${hedgeBlockReasons}` : ''}
            </div>
          </div>
        </div>
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
            title="Hedge process consumes and executes; flattens strategy hedge exposure"
            onClick={onFlatten}
          >
            Flatten exposure
          </button>
        </div>
        {hedgeCtrlMsg.text ? (
          <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'}`}>
            {hedgeCtrlMsg.text}
          </div>
        ) : null}
      </div>
        )}
      </div>

      <div className="card card-operations realtime-quotes-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${j?.redis_quotes_connected ? 'green' : 'none'}`} title="Watchlist (Redis)" aria-hidden />
          </div>
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              Watchlist
              <InfoTooltip text="Ticker data from daemon subscription, pushed via Redis to monitor. Symbols: Wishlist STK + strategy symbol. Requires Redis and daemon Event subscription." />
            </h2>
            <p className="section-hint" style={{ margin: 0 }}>
              {j?.redis_quotes_connected
                ? `SSE connected, ${watchlistSymbols.length} symbol(s) (prices & PnL update when stream arrives)`
                : 'Redis not connected or monitor not subscribed; check config and daemon Event subscription.'}
            </p>
          </div>
        </div>
        <div className="realtime-quotes-table-wrap">
          <table className="table-operations realtime-quotes-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Qty</th>
                <th>Cost</th>
                <th>PnL</th>
                <th>Last</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {watchlistRows.length === 0 ? (
                <tr>
                  <td colSpan={8}>No symbols in watchlist (add symbols in Wishlist or ensure daemon is running)</td>
                </tr>
              ) : (
                watchlistRows.map((row) => {
                  const { symbol, quote: q, qty, avgCost, pnl } = row
                  return (
                    <tr key={symbol}>
                      <td><strong>{symbol}</strong></td>
                      <td className="realtime-quote-num">{qty != null && Number.isFinite(qty) ? qty : '—'}</td>
                      <td className="realtime-quote-num">{avgCost != null && Number.isFinite(avgCost) ? fmtUsd(avgCost) : '—'}</td>
                      <td className="realtime-quote-num">
                        {pnl != null && Number.isFinite(pnl) ? (
                          <span className={pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : ''}>
                            {fmtUsd(pnl)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num">{q ? fmtUsd(q.last) : '—'}</td>
                      <td className="realtime-quote-num">{q ? fmtUsd(q.bid ?? null) : '—'}</td>
                      <td className="realtime-quote-num">{q ? fmtUsd(q.ask ?? null) : '—'}</td>
                      <td className="realtime-quote-since">{q ? fmtSince(q.ts) : '—'}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-operations card-event-subscribe">
        <h2 className="daemon-card-title page-title-with-tooltip">
          Event Subscribe
          <InfoTooltip text="Daemon IB event subscription status and subscribed tickers (Wishlist STK + strategy symbol)." />
          {hb?.daemon_alive != null && hb?.daemon_alive && (
            <button
              type="button"
              className="btn-resume"
              style={{ marginLeft: '0.5rem', verticalAlign: 'middle' }}
              title="Sync Real-time ticker with Wishlist (subscribe/add, unsubscribe/remove); list updates on next heartbeat"
              disabled={syncTickerLoading}
              onClick={async () => {
                setSyncTickerLoading(true)
                try {
                  const res = await postRefreshTickerSubscriptions()
                  if (res.ok && typeof loadStatus === 'function') {
                    setMsg(setSyncTickerMsg, 'Synced', false)
                    scheduleMsgClear(setSyncTickerMsg, syncTickerMsgClearRef)
                    setTimeout(() => loadStatus(), 1500)
                  }
                  if (!res.ok && res.error) setMsg(setSyncTickerMsg, res.error, true)
                } finally {
                  setSyncTickerLoading(false)
                }
              }}
            >
              {syncTickerLoading ? 'Syncing…' : 'Sync'}
            </button>
          )}
        </h2>
        <table className="table-operations">
          <thead>
            <tr>
              <th>Subscription</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Real-time ticker</td>
              <td>
                <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Real-time ticker" aria-hidden />
                <span className="event-subscribe-status-text">
                  {hb?.daemon_alive && hb?.event_subscribe_ticker
                    ? `Subscribed (${j?.subscribed_tickers?.length ?? 0} ticker${(j?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'} in monitoring)`
                    : hb?.daemon_alive
                      ? 'Not subscribed'
                      : '—'}
                </span>
              </td>
            </tr>
            <tr>
              <td>Position updates</td>
              <td>
                <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_positions ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Position updates" aria-hidden />
                <span className="event-subscribe-status-text">
                  {hb?.daemon_alive && hb?.event_subscribe_positions ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                </span>
              </td>
            </tr>
            <tr>
              <td>Fill / execution report</td>
              <td>
                <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_fills ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Fill / execution report" aria-hidden />
                <span className="event-subscribe-status-text">
                  {hb?.daemon_alive && hb?.event_subscribe_fills ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                </span>
              </td>
            </tr>
            <tr>
              <td>Commission report</td>
              <td>
                <div className={`lamp lamp-sm ${hb?.daemon_alive && hb?.event_subscribe_commission ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`} title="Commission report" aria-hidden />
                <span className="event-subscribe-status-text">
                  {hb?.daemon_alive && hb?.event_subscribe_commission ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        {syncTickerMsg.text ? (
          <div className={`msg ${syncTickerMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {syncTickerMsg.text}
          </div>
        ) : null}
        {hb?.daemon_alive && hb?.event_subscribe_ticker && (
          <div className="event-subscribe-tickers-block" style={{ marginTop: '1rem' }}>
            <h3 className="daemon-group-title" style={{ marginBottom: '0.5rem' }}>Real-time ticker — subscribed symbols</h3>
            <p className="section-hint" style={{ margin: 0, fontWeight: 600 }}>
              {(j?.subscribed_tickers?.length ?? 0)} ticker{(j?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'} in monitoring
            </p>
            <p className="section-hint" style={{ margin: '0.25rem 0 0 0' }}>
              {j?.subscribed_tickers?.length ? j.subscribed_tickers.join(', ') : '—'}
            </p>
          </div>
        )}
      </div>

      <div className="card card-operations celery-console-card">
        <div className="celery-console-header">
          <h2>Celery Console</h2>
          <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexShrink: 0 }}>
            <label className="celery-console-max-lines-label" title="Keep at most this many lines; older lines are removed from display and Redis">
              Max lines:
              <select
                className="celery-console-max-lines-select"
                value={celeryConsoleMaxLines}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n) || n < 1) return
                  setCeleryConsoleMaxLines(n)
                  setCeleryConsoleLines((prev) => prev.slice(-n))
                  trimCeleryLogs(n).catch(() => {})
                }}
                aria-label="Max lines to keep"
              >
                {[500, 1000, 2000, 5000].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-celery-console-clear"
              onClick={() => {
                const pre = celeryConsoleRef.current
                if (!pre) return
                const range = document.createRange()
                range.selectNodeContents(pre)
                const sel = window.getSelection()
                if (sel) {
                  sel.removeAllRanges()
                  sel.addRange(range)
                }
              }}
              title="Select all log text for copying"
            >
              Select All
            </button>
            <button
              type="button"
              className="btn-celery-console-clear"
              onClick={async () => {
                await clearCeleryLogs()
                setCeleryConsoleLines([])
              }}
              title="Clear displayed log and Redis stream; new lines will continue to appear when Worker runs"
            >
              Clear
            </button>
          </div>
        </div>
        <p className="section-desc section-hint">
          Real-time Worker log (Redis Stream). Run <code>python scripts/run_celery.py</code> to see output.
        </p>
        <div className="celery-console-wrap">
          <div
            className="celery-console-terminal"
            role="log"
            aria-live="polite"
            style={{ height: celeryConsoleHeightPx, minHeight: 120, maxHeight: 600 }}
          >
            <pre ref={celeryConsoleRef}>
              {celeryConsoleStatus === 'connecting' && celeryConsoleLines.length === 0
                ? 'Connecting…'
                : celeryConsoleStatus === 'error'
                  ? 'Unable to load (Redis/Celery broker may be down).'
                  : celeryConsoleLines.length === 0
                    ? 'No log lines yet. Start Worker: python scripts/run_celery.py'
                    : celeryConsoleLines.join('\n')}
            </pre>
          </div>
          <div
            className="celery-console-resize-handle"
            role="separator"
            aria-label="Resize console height"
            onMouseDown={onCeleryConsoleResizeStart}
            title="Drag to resize height"
          />
          {celeryConsoleStatus !== 'idle' && celeryConsoleStatus !== 'connecting' && (
            <p className="section-hint celery-console-status-line">
              <span style={{ color: celeryConsoleStatus === 'connected' ? 'var(--color-lamp-green)' : 'var(--color-lamp-red)', fontWeight: 600 }}>
                {celeryConsoleStatus === 'connected' ? '● Live' : '● Disconnected'}
              </span>
            </p>
          )}
        </div>
      </div>

      <div className="card card-operations">
        <h2>Recent operations</h2>
        <div className="daemon-groups" style={{ marginBottom: '1rem' }}>
          <div className="daemon-group">
            <div className="daemon-group-header">
              <div className={`lamp lamp-sm ${celeryWorkersAlive ? (celeryWorkerRecent || celeryWorkerIbConnected ? 'green' : 'yellow') : celeryBrokerConnected ? 'yellow' : 'none'}`} title="Worker (bars backfill): alive = ping responded; green = recent job or IB connected" />
              <span className="daemon-group-title">Worker (Bars Backfill)</span>
              <InfoTooltip text="Task runner for bars backfill. Run: python scripts/run_celery.py. Worker maintains IB connection (Settings → Celery worker_market)." />
            </div>
            <div className="daemon-group-body">
              <p className="section-hint countdown-line">
                Broker (Redis):{' '}
                {celeryBrokerConnected ? (
                  <span className="countdown-num">Connected</span>
                ) : (
                  'Not connected'
                )}
              </p>
              <p className="section-hint countdown-line">
                Last job activity:{' '}
                {celeryLastTs != null && Number.isFinite(celeryLastTs)
                  ? `${fmtTs(celeryLastTs)} (${fmtSince(celeryLastTs)} ago)`
                  : 'No job activity yet'}
              </p>
              <p className="section-hint countdown-line">
                IB Client ID:{' '}
                {celeryWorkerIbConnected ? (
                  <span className="countdown-num">Connected @ {celeryWorkerIbClientId ?? '—'}</span>
                ) : (
                  'Not connected'
                )}
              </p>
            </div>
          </div>
        </div>
        <table className="table-operations">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {operations.length === 0 ? (
              <tr>
                <td colSpan={6}>None</td>
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

      {/* IB Pacing：历史数据用量与边界，显示在 Recent operations 下方 */}
      <div className="card card-operations" style={{ marginTop: '1rem' }}>
        <h2>IB Pacing (Market Data Usage)</h2>
        <div className="daemon-groups" style={{ marginBottom: '0.5rem' }}>
          {j?.ib_pacing_usage ? (
            <>
              <div className="daemon-group">
                <div className="daemon-group-header">
                  <div
                    className={`lamp lamp-sm ${j.ib_pacing_usage.usage?.throttled ? 'yellow' : 'green'}`}
                    title={j.ib_pacing_usage.usage?.throttled ? 'Currently throttled' : 'Within limits'}
                  />
                  <span className="daemon-group-title">10‑minute window</span>
                  <InfoTooltip text="IB historical data: requests in the last 10 minutes vs configured limit. Throttled when limit reached; Worker/API will wait before next request." />
                </div>
                <div className="daemon-group-body">
                  <p className="section-hint countdown-line">
                    Requests (last 10 min):{' '}
                    <strong>
                      {j.ib_pacing_usage.usage?.requests_last_10min ?? '—'} / {j.ib_pacing_usage.config?.max_requests_per_10min ?? 60}
                    </strong>
                  </p>
                  {j.ib_pacing_usage.usage?.throttled && (
                    <p className="section-hint countdown-line">
                      Throttled: {j.ib_pacing_usage.usage?.throttle_reason ?? 'limit reached'}
                      {j.ib_pacing_usage.usage?.next_request_allowed_ts != null && Number.isFinite(j.ib_pacing_usage.usage.next_request_allowed_ts) && (
                        <> — Next request in <strong>{Math.max(0, Math.ceil((j.ib_pacing_usage.usage.next_request_allowed_ts as number) - Date.now() / 1000))}s</strong></>
                      )}
                    </p>
                  )}
                  <p className="section-hint countdown-line">
                    Same-request cooldown: <strong>{j.ib_pacing_usage.config?.min_interval_identical_sec ?? 15}s</strong>
                  </p>
                </div>
              </div>
              {j.ib_pacing_usage.last_by_key && Object.keys(j.ib_pacing_usage.last_by_key).length > 0 && (
                <div className="daemon-group" style={{ marginTop: '0.5rem' }}>
                  <div className="daemon-group-header">
                    <span className="daemon-group-title">Recent keys (symbol|period|duration)</span>
                  </div>
                  <div className="daemon-group-body">
                    <p className="section-hint" style={{ margin: 0, fontSize: '0.85rem' }}>
                      {Object.entries(j.ib_pacing_usage.last_by_key)
                        .slice(0, 5)
                        .map(([key, ts]) => `${key} @ ${fmtTs(ts)}`)
                        .join(' · ')}
                    </p>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="section-hint" style={{ margin: 0 }}>
              Not available (pacing not configured or Redis unavailable). See docs/plans/ib-pacing-implementation-plan.md.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
