import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import {
  fetchCeleryLogs,
  subscribeCeleryLogs,
  clearCeleryLogs,
} from '../api/monitor/logs'
import { postStop } from '../api/monitor/control'
import { postMonitorStop, postCeleryStop } from '../api/monitor/monitor'
import {
  fetchOpsWorkers,
  fetchOpsAudit,
  fetchOpsCapabilities,
  fetchQueueSummary,
  scaleWorker,
  fetchWorkerInstances,
  fetchWorkerProfiles,
  fetchBrokerStatusExtended,
  controlBroker,
  brokerConsoleUrl,
  getOpsToken,
  setOpsToken,
  type WorkerSummary,
  type BrokerStatus,
  type AuditEntry,
  type SystemdInstance,
  type ExtendedBrokerStatus,
  type BrokerAction,
  type OpsCapabilities,
  type WorkerProfileInfo,
  type QueueSummaryRow,
} from '../api/ops/ops'
import { CeleryJobQueuesSection } from './celery/CeleryJobQueuesSection'

export interface DashboardPageProps {
  status?: StatusResponse | null
  loadStatus?: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
}

type LampColor = 'green' | 'yellow' | 'red' | 'none'

function workerLamp(status: string): LampColor {
  if (status === 'running_healthy') return 'green'
  if (status === 'running_degraded' || status === 'starting' || status === 'stopping') return 'yellow'
  if (status === 'stopped' || status === 'failed') return 'red'
  return 'none'
}

function workerStatusLabel(status: string): string {
  const map: Record<string, string> = {
    running_healthy: 'Healthy',
    running_degraded: 'Degraded',
    starting: 'Starting',
    stopping: 'Stopping',
    stopped: 'Stopped',
    failed: 'Failed',
    unknown: 'Unknown',
  }
  return map[status] ?? status
}

function fmtRelative(epochSec: number | null): string {
  if (epochSec == null) return '—'
  const delta = Date.now() / 1000 - epochSec
  if (delta < 0) return 'just now'
  if (delta < 60) return `${Math.floor(delta)}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

function fmtTimestamp(epochSec: number): string {
  try {
    return new Date(epochSec * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(epochSec)
  }
}

function fmtQueueCell(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return String(n)
}

function formatQueueLabel(name: string): string {
  if (name === 'massive_high') return 'Massive (high)'
  if (name === 'massive') return 'Massive'
  if (name === 'bars') return 'Bars (IB)'
  return name
}

/** Worker console: per-worker Redis stream via Ops `/ops/console/worker/{nodename}` (SSE). */
function DashboardWorkerRedisConsole({ workerId }: { workerId: string }) {
  const fetchLogs = useCallback(
    (tail?: number) => fetchCeleryLogs(workerId, tail ?? 50),
    [workerId],
  )
  const subscribeLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) =>
      subscribeCeleryLogs(onLine, onError, workerId),
    [workerId],
  )
  const clearLogs = useCallback(() => clearCeleryLogs(workerId), [workerId])
  const ctrl = useLogConsole({
    fetchLogs,
    subscribeLogs,
    clearLogs,
    initialMaxLines: 500,
    enabled: true,
  })
  return (
    <LogConsolePanel
      controller={ctrl}
      loadingText="Connecting…"
      errorText="Unable to load (Redis/Celery broker may be down)."
      emptyText="No log lines yet. Start Worker: python scripts/run_celery.py"
      infoTooltipText="Per-worker Redis console stream for this nodename (Ops GET /ops/celery/logs, SSE /ops/console/worker/…)."
      resizeAriaLabel="Resize worker console height"
      clearTitle="Clear displayed log and this worker's Redis stream; new lines continue when Worker runs"
    />
  )
}

function workerIdToInstanceId(workerId: string): string | null {
  const [node] = workerId.split('@', 1)
  if (node && node.startsWith('worker') && node.length > 'worker'.length) {
    return node.slice('worker'.length)
  }
  return null
}

type ConfirmDialogState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  action: null,
}

const AUDIT_PAGE_SIZES = [5, 10, 20, 50] as const
type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number]

// ── Audit helpers ────────────────────────────────────────────────────────────

function auditOutcomeBadge(outcome: string): { label: string; className: string } {
  switch (outcome) {
    case 'success': return { label: 'Success', className: 'dashboard-audit-badge--success' }
    case 'submitted': return { label: 'Submitted', className: 'dashboard-audit-badge--submitted' }
    case 'denied': return { label: 'Denied', className: 'dashboard-audit-badge--denied' }
    case 'rejected': return { label: 'Rejected', className: 'dashboard-audit-badge--rejected' }
    case 'failed': return { label: 'Failed', className: 'dashboard-audit-badge--failed' }
    case 'partial': return { label: 'Partial', className: 'dashboard-audit-badge--partial' }
    default: return { label: outcome, className: '' }
  }
}

// \u2500\u2500 Log Console (SSE) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function LogConsole({ url, maxLines = 500 }: { url: string; maxLines?: number }) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [paused, setPaused] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  /**
   * EventSource cannot send Authorization; Vite proxy often buffers or drops SSE.
   * Use fetch() + ReadableStream. Prefer `token` query param (no custom headers → simpler CORS / PNA).
   */
  useEffect(() => {
    if (!url) return
    const ac = new AbortController()
    let cancelled = false
    setLines([])
    setStreamError(null)
    setConnected(false)
    void (async () => {
      try {
        let tokenInUrl = false
        try {
          const u = new URL(url, window.location.origin)
          tokenInUrl = u.searchParams.has('token') || u.searchParams.has('access_token')
        } catch {
          tokenInUrl = false
        }
        const token = getOpsToken()
        const headers: Record<string, string> = { Accept: 'text/event-stream' }
        if (token && !tokenInUrl) headers.Authorization = `Bearer ${token}`
        const crossOrigin = /^https?:\/\//i.test(url)
        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: ac.signal,
          credentials: crossOrigin ? 'omit' : 'same-origin',
          cache: 'no-store',
        })
        if (!res.ok) {
          const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
          throw new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`)
        }
        const body = res.body
        if (!body) throw new Error('No response body')
        setConnected(true)
        const reader = body.getReader()
        const dec = new TextDecoder()
        let buffer = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += dec.decode(value, { stream: true })
          let sep: number
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            for (const rawLine of block.split('\n')) {
              const line = rawLine.replace(/\r$/, '')
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).replace(/^\s/, '')
              if (cancelled || ac.signal.aborted) break
              setLines(prev => {
                const next = [...prev, data]
                return next.length > maxLines ? next.slice(next.length - maxLines) : next
              })
            }
          }
        }
        if (!cancelled) setConnected(false)
      } catch (e) {
        if (cancelled || ac.signal.aborted) return
        if (e instanceof Error && e.name === 'AbortError') return
        setConnected(false)
        setStreamError(e instanceof Error ? e.message : 'Stream failed')
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [url, maxLines])

  useEffect(() => {
    if (!paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, paused])

  return (
    <div className="dashboard-console">
      <div className="dashboard-console-toolbar">
        <span className={`dashboard-console-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'Live' : 'Disconnected'}
        </span>
        <span className="dashboard-console-line-count">{lines.length} lines</span>
        <button
          type="button"
          className={`dashboard-console-btn ${paused ? 'active' : ''}`}
          onClick={() => setPaused(p => !p)}
          title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="dashboard-console-btn"
          onClick={() => { setLines([]); setStreamError(null) }}
          title="Clear console"
        >
          Clear
        </button>
      </div>
      {streamError ? (
        <div className="dashboard-console-stream-error" role="alert">
          {streamError}
        </div>
      ) : null}
      <pre className="dashboard-console-output">
        {lines.length === 0 && !streamError ? (
          <span className="dashboard-console-placeholder">Waiting for log output…</span>
        ) : lines.length === 0 && streamError ? (
          <span className="dashboard-console-placeholder">No log lines received.</span>
        ) : (
          lines.map((l, i) => <span key={i} className="dashboard-console-line">{l}{'\n'}</span>)
        )}
        <div ref={bottomRef} />
      </pre>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

type ServiceId = 'daemon' | 'server' | 'celery'

interface ServiceAction {
  id: ServiceId
  label: string
  stopFn: () => Promise<{ ok?: boolean; error?: string }>
}

const SERVICE_ACTIONS: ServiceAction[] = [
  { id: 'celery', label: 'Celery', stopFn: postCeleryStop },
  { id: 'daemon', label: 'Daemon', stopFn: postStop },
  { id: 'server', label: 'Server', stopFn: postMonitorStop },
]

export function DashboardPage({ status, loadStatus, embeddedInSettings }: DashboardPageProps) {
  const [workers, setWorkers] = useState<WorkerSummary[]>([])
  const [broker, setBroker] = useState<BrokerStatus | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [auditError, setAuditError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState>(INITIAL_CONFIRM)
  const [tick, setTick] = useState(0)
  const [auditFilter, setAuditFilter] = useState<'all' | 'success' | 'submitted' | 'denied' | 'rejected' | 'failed'>('all')
  const [auditPage, setAuditPage] = useState(1)
  const [auditPageSize, setAuditPageSize] = useState<AuditPageSize>(10)
  const [svcStopBusy, setSvcStopBusy] = useState<ServiceId | 'all' | null>(null)
  const [svcMsg, setSvcMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const svcMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [queueSummary, setQueueSummary] = useState<QueueSummaryRow[]>([])
  const [queueSummaryNote, setQueueSummaryNote] = useState<string | null>(null)
  const [queueSummaryDb, setQueueSummaryDb] = useState<boolean | null>(null)

  // Worker scaling
  const [instances, setInstances] = useState<SystemdInstance[]>([])
  const [workerProfiles, setWorkerProfiles] = useState<WorkerProfileInfo[]>([])
  const [scaleWorkerType, setScaleWorkerType] = useState('')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleMsg, setScaleMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [snapshotRefreshBusy, setSnapshotRefreshBusy] = useState(false)

  // Broker control
  const [extBroker, setExtBroker] = useState<ExtendedBrokerStatus | null>(null)
  const [brokerBusy, setBrokerBusy] = useState(false)
  const [brokerMsg, setBrokerMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })

  // Console panel
  type ConsoleTarget = 'none' | 'broker' | string
  const [consoleTarget, setConsoleTarget] = useState<ConsoleTarget>('none')
  const [consoleUrl, setConsoleUrl] = useState('')

  // Auth / capabilities
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)

  /** Coalesce concurrent /ops/workers (Celery inspect) calls — 5s poll + void refresh must not stack. */
  const workersRefreshPromiseRef = useRef<Promise<void> | null>(null)
  /** When Phase 1 is slow, 5s interval must not stack duplicate summary/instances/ops calls. */
  const loadAllPromiseRef = useRef<Promise<void> | null>(null)
  const consoleSectionRef = useRef<HTMLElement | null>(null)

  const canOperate = caps?.capabilities.can_operate ?? false
  const canAdmin = caps?.capabilities.can_admin ?? false
  const isAuthenticated = caps?.identity.authenticated ?? false
  const authRequired = caps?.auth_required ?? false
  const currentRole = caps?.identity.role ?? 'viewer'

  const loadCaps = useCallback(async () => {
    try {
      const res = await fetchOpsCapabilities()
      if (res.ok) setCaps(res)
    } catch { /* ignore */ }
  }, [])

  const refreshOpsWorkersSnapshot = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (workersRefreshPromiseRef.current) {
      return workersRefreshPromiseRef.current
    }
    const run = (async () => {
      try {
        const wRes = await fetchOpsWorkers({ forceRefresh: opts?.forceRefresh })
        if (wRes.ok) {
          setWorkers(wRes.workers)
          setBroker(wRes.broker)
          setExtBroker(prev => ({
            ...wRes.broker,
            locally_managed: prev?.locally_managed ?? false,
          }))
        }
      } catch {
        /* workers snapshot optional */
      }
    })()
    const tracked = run.finally(() => {
      workersRefreshPromiseRef.current = null
    })
    workersRefreshPromiseRef.current = tracked
    return tracked
  }, [])

  const onBrokerSnapshotRefresh = useCallback(async () => {
    setSnapshotRefreshBusy(true)
    try {
      await refreshOpsWorkersSnapshot({ forceRefresh: true })
    } finally {
      setSnapshotRefreshBusy(false)
    }
  }, [refreshOpsWorkersSnapshot])

  /** Phase 1: queues, instances, broker extension, profiles. Phase 2: /ops/workers (Celery inspect, slow). */
  const loadAll = useCallback(
    async (opts?: { awaitWorkers?: boolean }) => {
      if (loadAllPromiseRef.current) {
        return loadAllPromiseRef.current
      }
      const awaitWorkers = opts?.awaitWorkers === true
      const run = (async () => {
        try {
          // Phase 1: fast endpoints only — /ops/workers can take wall_sec (Celery inspect); do not block first paint.
          const settled = await Promise.allSettled([
            fetchQueueSummary().catch(() => ({ ok: false as const, queues: [] as QueueSummaryRow[] })),
            fetchWorkerInstances().catch(() => ({ ok: false, instances: [] as SystemdInstance[], count: 0 })),
            fetchBrokerStatusExtended().catch(() => null),
            fetchWorkerProfiles().catch(() => ({ ok: false, profiles: [] as WorkerProfileInfo[], count: 0 })),
          ])
          const qRes =
            settled[0].status === 'fulfilled'
              ? settled[0].value
              : { ok: false as const, queues: [] as QueueSummaryRow[] }
          const iRes =
            settled[1].status === 'fulfilled'
              ? settled[1].value
              : { ok: false, instances: [] as SystemdInstance[], count: 0 }
          const bRes = settled[2].status === 'fulfilled' ? settled[2].value : null
          const pRes =
            settled[3].status === 'fulfilled'
              ? settled[3].value
              : { ok: false, profiles: [] as WorkerProfileInfo[], count: 0 }

          if (qRes.ok) {
            setQueueSummary(qRes.queues)
            setQueueSummaryNote(qRes.massive_db_note ?? null)
            setQueueSummaryDb(qRes.db_connected ?? null)
          } else {
            setQueueSummary([])
            setQueueSummaryNote(null)
            setQueueSummaryDb(null)
          }
          if (iRes.ok) setInstances(iRes.instances)
          if (bRes?.ok && bRes.broker) {
            setExtBroker(bRes.broker)
            const eb = bRes.broker
            setBroker({
              connected: eb.connected,
              url_masked: eb.url_masked,
              used_memory_human: eb.used_memory_human,
              connected_clients: eb.connected_clients,
              queues: eb.queues,
            })
          } else {
            setExtBroker(null)
          }
          if (pRes.ok && pRes.profiles.length > 0) {
            setWorkerProfiles(pRes.profiles)
            setScaleWorkerType(prev => prev || pRes.profiles[0].key)
          }
          setError(null)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to load dashboard data')
        } finally {
          setLoading(false)
        }

        if (awaitWorkers) {
          await refreshOpsWorkersSnapshot()
        } else {
          void refreshOpsWorkersSnapshot()
        }
      })()
      const tracked = run.finally(() => {
        loadAllPromiseRef.current = null
      })
      loadAllPromiseRef.current = tracked
      return tracked
    },
    [refreshOpsWorkersSnapshot],
  )

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetchOpsAudit(500)
      if (res.ok) {
        setAuditEntries(res.entries)
        setAuditError(null)
      } else {
        setAuditError(res.error ?? 'Failed to load audit')
        setAuditEntries([])
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Audit unavailable'
      if (msg.includes('403') || msg.includes('Insufficient')) {
        setAuditError('Requires admin role to view audit log.')
      } else {
        setAuditError(msg)
      }
      setAuditEntries([])
    }
  }, [])

  useEffect(() => {
    loadCaps()
    loadAll()
    loadAudit()
    const t = setInterval(() => {
      loadAll()
      loadAudit()
    }, 5000)
    const capsTimer = setInterval(loadCaps, 30000)
    const tickTimer = setInterval(() => setTick(n => n + 1), 1000)
    return () => {
      clearInterval(t)
      clearInterval(capsTimer)
      clearInterval(tickTimer)
    }
  }, [loadAll, loadAudit, loadCaps])

  const handleLogin = useCallback(() => {
    setOpsToken(tokenInput.trim())
    setTokenInput('')
    setAuthPanelOpen(false)
    loadCaps()
    loadAll()
    loadAudit()
  }, [tokenInput, loadCaps, loadAll, loadAudit])

  const handleLogout = useCallback(() => {
    setOpsToken('')
    setAuthPanelOpen(false)
    loadCaps()
  }, [loadCaps])

  void tick

  useEffect(() => {
    return () => {
      if (svcMsgTimerRef.current) clearTimeout(svcMsgTimerRef.current)
    }
  }, [])

  const showSvcMsg = (text: string, isErr: boolean, autoHideMs = 5000) => {
    setSvcMsg({ text, isErr })
    if (svcMsgTimerRef.current) clearTimeout(svcMsgTimerRef.current)
    svcMsgTimerRef.current = setTimeout(() => setSvcMsg({ text: '', isErr: false }), autoHideMs)
  }

  const stopService = async (svc: ServiceAction) => {
    setSvcStopBusy(svc.id)
    showSvcMsg(`Stopping ${svc.label}…`, false, 15000)
    try {
      const res = await svc.stopFn()
      if (res.ok !== false) {
        showSvcMsg(`${svc.label} stop sent.`, false)
      } else {
        showSvcMsg(`${svc.label}: ${res.error ?? 'failed'}`, true)
      }
      if (loadStatus) setTimeout(() => loadStatus(), 1500)
    } catch (e) {
      showSvcMsg(e instanceof Error ? e.message : 'Stop failed', true)
    } finally {
      setSvcStopBusy(null)
    }
  }

  const shutdownAll = async () => {
    setSvcStopBusy('all')
    const errors: string[] = []
    for (const svc of SERVICE_ACTIONS) {
      showSvcMsg(`Stopping ${svc.label}…`, false, 30000)
      try {
        const res = await svc.stopFn()
        if (res.ok === false) errors.push(`${svc.label}: ${res.error ?? 'failed'}`)
      } catch (e) {
        errors.push(`${svc.label}: ${e instanceof Error ? e.message : 'error'}`)
      }
    }
    showSvcMsg(
      errors.length === 0
        ? 'All services stopped.'
        : `Shutdown completed with errors: ${errors.join('; ')}`,
      errors.length > 0,
    )
    setSvcStopBusy(null)
    if (loadStatus) setTimeout(() => loadStatus(), 2000)
  }

  const onStopServiceClick = (svc: ServiceAction) => {
    setConfirmState({
      open: true,
      title: `Stop ${svc.label}?`,
      message: svc.id === 'server'
        ? `This will stop the ${svc.label} process. The UI will become unresponsive until it restarts.`
        : `This will stop the ${svc.label} process.`,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        await stopService(svc)
        setConfirmState(INITIAL_CONFIRM)
      },
    })
  }

  const onShutdownAllClick = () => {
    setConfirmState({
      open: true,
      title: 'Shutdown entire system?',
      message: 'Celery, then Daemon, then Server will be stopped in order. This cannot be undone.',
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        await shutdownAll()
        setConfirmState(INITIAL_CONFIRM)
      },
    })
  }

  // ── Scaling handlers ──────────────────────────────────────────────────
  const onScaleRemove = async (instanceId: string) => {
    setConfirmState({
      open: true,
      title: `Remove worker instance ${instanceId}?`,
      message: `This will stop bifrost-celery-worker@${instanceId}.service via systemd.`,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        try {
          const res = await scaleWorker({ action: 'remove', instance_id: instanceId })
          setScaleMsg({ text: res.ok ? `Instance ${instanceId} removed` : (res.error ?? 'Failed'), isErr: !res.ok })
          await loadAll()
          if (res.ok) await refreshOpsWorkersSnapshot({ forceRefresh: true })
        } catch (e) {
          setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
        } finally {
          setScaleBusy(false)
          setConfirmState(INITIAL_CONFIRM)
        }
      },
    })
  }

  const onScaleAdd = async () => {
    if (!scaleWorkerType) {
      setScaleMsg({ text: 'Select a worker type', isErr: true })
      return
    }
    setScaleBusy(true)
    try {
      const res = await scaleWorker({ action: 'add', worker_type: scaleWorkerType })
      if (res.ok) {
        const iid = res.instance_id ?? res.unit ?? scaleWorkerType
        setScaleMsg({ text: `Instance ${iid} started (${scaleWorkerType})`, isErr: false })
        await loadAll()
      } else {
        setScaleMsg({ text: res.error ?? 'Failed', isErr: true })
      }
    } catch (e) {
      setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setScaleBusy(false)
    }
  }

  // ── Broker control handlers ───────────────────────────────────────────
  const onBrokerAction = async (action: BrokerAction) => {
    if (action === 'stop') {
      setConfirmState({
        open: true,
        title: 'Stop Redis broker?',
        message: 'Stopping the broker will disconnect all workers and halt task processing.',
        confirming: false,
        action: async () => {
          setConfirmState(prev => ({ ...prev, confirming: true }))
          setBrokerBusy(true)
          try {
            const res = await controlBroker(action)
            setBrokerMsg({ text: res.ok ? 'Broker stopped' : (res.error ?? 'Failed'), isErr: !res.ok })
            await loadAll()
          } catch (e) {
            setBrokerMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
          } finally {
            setBrokerBusy(false)
            setConfirmState(INITIAL_CONFIRM)
          }
        },
      })
      return
    }
    setBrokerBusy(true)
    try {
      const res = await controlBroker(action)
      setBrokerMsg({ text: res.ok ? `Broker ${action} sent` : (res.error ?? 'Failed'), isErr: !res.ok })
      await loadAll()
    } catch (e) {
      setBrokerMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setBrokerBusy(false)
    }
  }

  // ── Console handlers ──────────────────────────────────────────────────
  /** Opens a console stream (used by Runtime Snapshot cards; does not toggle off). */
  const selectConsole = useCallback((target: ConsoleTarget) => {
    if (target === 'none') {
      setConsoleTarget('none')
      setConsoleUrl('')
      return
    }
    setConsoleTarget(target)
    if (target === 'broker') {
      setConsoleUrl(brokerConsoleUrl())
    } else {
      setConsoleUrl('')
    }
  }, [])

  const scrollConsoleIntoView = useCallback(() => {
    requestAnimationFrame(() => {
      consoleSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  /** Toggle same target off (filter buttons only). */
  const openConsole = (target: ConsoleTarget) => {
    if (target === consoleTarget) {
      setConsoleTarget('none')
      setConsoleUrl('')
      return
    }
    setConsoleTarget(target)
    if (target === 'broker') {
      setConsoleUrl(brokerConsoleUrl())
    } else if (target !== 'none') {
      setConsoleUrl('')
    }
  }

  useEffect(() => {
    if (consoleTarget === 'none' || consoleTarget === 'broker') return
    const stillExists = workers.some(w => w.worker_id === consoleTarget)
    if (!stillExists) {
      setConsoleTarget('none')
      setConsoleUrl('')
    }
  }, [workers, consoleTarget])

  const hb = status?.daemon_heartbeat
  const daemonLamp: LampColor = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const serverLamp: LampColor = status?.monitor_lamp ? (status.monitor_lamp as LampColor) : 'red'
  const celeryStatusLamp: LampColor =
    status?.celery_broker_connected && (status?.celery_workers?.length ?? 0) > 0 ? 'green' : 'red'

  const brokerLamp: LampColor = broker?.connected ? 'green' : 'red'
  const overallLamp: LampColor = (() => {
    if (!broker?.connected) return 'red'
    if (workers.length === 0) return 'red'
    const hasRed = workers.some(w => workerLamp(w.status) === 'red')
    const hasYellow = workers.some(w => workerLamp(w.status) === 'yellow')
    if (hasRed) return 'red'
    if (hasYellow) return 'yellow'
    return 'green'
  })()

  const filteredAudit = auditEntries.filter(e => {
    if (auditFilter === 'all') return true
    return e.outcome === auditFilter
  })

  useEffect(() => {
    setAuditPage(1)
  }, [auditFilter])

  useEffect(() => {
    const n = filteredAudit.length
    const maxPage = Math.max(1, Math.ceil(n / auditPageSize) || 1)
    if (auditPage > maxPage) setAuditPage(maxPage)
  }, [auditPage, auditPageSize, filteredAudit.length])

  const auditTotalFiltered = filteredAudit.length
  const auditTotalPages = Math.max(1, Math.ceil(auditTotalFiltered / auditPageSize) || 1)
  const auditRangeStart = auditTotalFiltered === 0 ? 0 : (auditPage - 1) * auditPageSize + 1
  const auditRangeEnd = Math.min(auditPage * auditPageSize, auditTotalFiltered)
  const paginatedAudit = filteredAudit.slice(
    (auditPage - 1) * auditPageSize,
    (auditPage - 1) * auditPageSize + auditPageSize,
  )

  const hasAuditPermission = auditError == null || (!auditError.includes('admin') && !auditError.includes('403'))
  const showInitialSkeleton = loading && workers.length === 0

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'dashboard-page dashboard-page--embedded' : 'dashboard-page'}`}>
      {/* Confirm dialog */}
      {confirmState.open && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => !confirmState.confirming && setConfirmState(INITIAL_CONFIRM)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dashboard-confirm-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="dashboard-confirm-title">{confirmState.title}</h3>
            <p>{confirmState.message}</p>
            <div className="data-reset-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmState(INITIAL_CONFIRM)}
                disabled={confirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-shutdown-all"
                onClick={() => confirmState.action?.()}
                disabled={confirmState.confirming}
              >
                {confirmState.confirming ? 'Executing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            <span className={`title-inline-lamp lamp-icon ${overallLamp}`} title="Dashboard overall status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            Dashboard
            <InfoTooltip text="Celery worker control plane. Services, runtime snapshot, worker instances, and audit trail." />
          </h2>
          <p className="settings-page-subtitle">
            Services, runtime snapshot, worker instances, and audit trail.
          </p>
        </div>
      </div>

      {/* ── Auth bar ── */}
      <div className="dashboard-auth-bar">
        <div className="dashboard-auth-info">
          <span className={`dashboard-auth-role dashboard-auth-role--${currentRole}`}>
            {currentRole.toUpperCase()}
          </span>
          {caps?.identity.name && caps.identity.name !== 'anonymous' && (
            <span className="dashboard-auth-name">{caps.identity.name}</span>
          )}
          {isAuthenticated && (
            <span className="dashboard-auth-badge">Authenticated</span>
          )}
          {authRequired && !isAuthenticated && (
            <span className="dashboard-auth-badge dashboard-auth-badge--warn">Token required for control actions</span>
          )}
        </div>
        <div className="dashboard-auth-actions">
          {isAuthenticated ? (
            <button type="button" className="dashboard-console-btn" onClick={handleLogout}>
              Sign out
            </button>
          ) : (
            <button
              type="button"
              className="dashboard-console-btn"
              onClick={() => setAuthPanelOpen(!authPanelOpen)}
            >
              Authenticate
            </button>
          )}
        </div>
        {authPanelOpen && !isAuthenticated && (
          <div className="dashboard-auth-panel">
            <input
              type="password"
              className="dashboard-ctrl-input"
              placeholder="Ops API token…"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && tokenInput.trim()) handleLogin() }}
              autoFocus
            />
            <button
              type="button"
              className="btn-resume dashboard-btn dashboard-btn--start"
              onClick={handleLogin}
              disabled={!tokenInput.trim()}
            >
              Connect
            </button>
          </div>
        )}
      </div>

      {error ? (
        <div className="dashboard-inline-alert msg err" role="status">
          {error}. Keep previous data on screen; retrying in next poll cycle.
        </div>
      ) : null}
      <div className="dashboard-grid settings-page-groups">
          {/* ── Services Overview ──────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-services" aria-labelledby="dashboard-svc-head">
            <div className="dashboard-section-header-row">
              <h3 id="dashboard-svc-head" className="page-title-with-tooltip">
                Services
                <InfoTooltip text="Unified view of all Bifrost services. Stop individual services or shut down the entire system in order (Celery → Daemon → Server)." />
              </h3>
              <div className="dashboard-svc-actions-row">
                {svcMsg.text && (
                  <span className={`settings-page-msg ${svcMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{svcMsg.text}</span>
                )}
                <button
                  type="button"
                  className="btn-shutdown-all dashboard-btn dashboard-shutdown-all-btn"
                  onClick={onShutdownAllClick}
                  disabled={!!svcStopBusy}
                  title="Shutdown entire system (Celery → Daemon → Server)"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                    <line x1="12" y1="2" x2="12" y2="12" />
                  </svg>
                  {svcStopBusy === 'all' ? 'Shutting down…' : 'Shutdown All'}
                </button>
              </div>
            </div>
            <div className="dashboard-svc-grid">
              {/* Daemon */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${daemonLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
                  </span>
                  <strong>Daemon</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${daemonLamp}`}>
                    {hb?.daemon_alive ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  {hb?.daemon_alive && hb?.last_ts != null && <span>Heartbeat: {fmtRelative(hb.last_ts)}</span>}
                  {hb?.ib_connected != null && <span>IB: {hb.ib_connected ? 'Connected' : 'Disconnected'}</span>}
                  {status?.trading_suspended != null && <span>Trading: {status.trading_suspended ? 'Suspended' : 'Active'}</span>}
                </div>
                <button
                  type="button"
                  className="dashboard-svc-stop-btn"
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[1])}
                  disabled={!!svcStopBusy}
                  title="Stop daemon process"
                >
                  {svcStopBusy === 'daemon' ? 'Stopping…' : 'Stop'}
                </button>
              </div>

              {/* Server */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${serverLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                      <circle cx="6" cy="6" r="1" fill="currentColor" strokeWidth="0" />
                      <circle cx="6" cy="18" r="1" fill="currentColor" strokeWidth="0" />
                    </svg>
                  </span>
                  <strong>Server</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${serverLamp}`}>
                    {serverLamp === 'green' ? 'Running' : serverLamp === 'yellow' ? 'Degraded' : 'Down'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  {status?.monitor_enabled != null && <span>Monitor: {status.monitor_enabled ? 'Enabled' : 'Disabled'}</span>}
                </div>
                <button
                  type="button"
                  className="dashboard-svc-stop-btn"
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[2])}
                  disabled={!!svcStopBusy}
                  title="Stop server process"
                >
                  {svcStopBusy === 'server' ? 'Stopping…' : 'Stop'}
                </button>
              </div>

              {/* Celery */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${celeryStatusLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                  </span>
                  <strong>Celery</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${celeryStatusLamp}`}>
                    {celeryStatusLamp === 'green' ? 'Running' : 'Down'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  <span>Broker: {status?.celery_broker_connected ? 'Connected' : 'Disconnected'}</span>
                  <span>Workers: {status?.celery_workers?.length ?? 0}</span>
                </div>
                <button
                  type="button"
                  className="dashboard-svc-stop-btn"
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[0])}
                  disabled={!!svcStopBusy}
                  title="Stop Celery worker"
                >
                  {svcStopBusy === 'celery' ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            </div>
          </section>

          {/* ── Celery (runtime, queues, instances, console, broker) ── */}
          <div
            className="dashboard-celery-group"
            aria-labelledby="dashboard-celery-head"
          >
            <h2 id="dashboard-celery-head" className="dashboard-celery-group-title">
              Celery
            </h2>

          {/* ── Console Monitor ────────────────────────────────── */}
          <section
            ref={consoleSectionRef}
            id="dashboard-console-section"
            className={`replay-section dashboard-section dashboard-console-section${consoleTarget !== 'none' && (consoleTarget === 'broker' ? !!consoleUrl : true) ? ' dashboard-console-section--active' : ''}`}
            aria-labelledby="dashboard-console-head"
          >
            <h3 id="dashboard-console-head" className="page-title-with-tooltip">
              Console
              <InfoTooltip text="Broker: Ops SSE (journald or tail of BIFROST_BROKER_CONSOLE_LOG on macOS). Worker: per-worker Redis stream via Ops /ops/console/worker (tail/clear: /ops/celery/logs)." />
            </h3>
            <div className="dashboard-console-selector">
              <button
                type="button"
                className={`dashboard-filter-btn ${consoleTarget === 'broker' ? 'active' : ''}`}
                onClick={() => openConsole('broker')}
              >
                Broker (Redis)
              </button>
              {workers.map(w => (
                <button
                  key={w.worker_id}
                  type="button"
                  className={`dashboard-filter-btn ${consoleTarget === w.worker_id ? 'active' : ''}`}
                  onClick={() => openConsole(w.worker_id)}
                >
                  {w.worker_id}
                </button>
              ))}
            </div>
            {consoleTarget === 'broker' && consoleUrl ? (
              <LogConsole url={consoleUrl} />
            ) : consoleTarget !== 'none' && consoleTarget !== 'broker' ? (
              <DashboardWorkerRedisConsole key={consoleTarget} workerId={consoleTarget} />
            ) : (
              <div className="dashboard-empty">Select a target above to open a live console stream.</div>
            )}
          </section>

          {/* ── Runtime Snapshot ──────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-snapshot" aria-labelledby="dashboard-snapshot-head">
            <h3 id="dashboard-snapshot-head" className="page-title-with-tooltip">
              Runtime Snapshot
              <InfoTooltip text="Broker from Redis; workers from Celery inspect (who responds on the broker). Worker Instances below lists OS processes — not the same data source." />
            </h3>

            {/* Broker */}
            <div
              className={`dashboard-broker-card${consoleTarget === 'broker' ? ' dashboard-broker-card--console-active' : ''}`}
              title="Open broker console stream"
              onClick={() => {
                selectConsole('broker')
                scrollConsoleIntoView()
              }}
            >
              <div className="dashboard-broker-header">
                <span className={`title-inline-lamp lamp-icon ${brokerLamp}`} aria-hidden>●</span>
                <strong>Broker</strong>
                <span className="dashboard-broker-status">
                  {broker?.connected ? 'Connected' : 'Disconnected'}
                </span>
                <button
                  type="button"
                  className={`celery-queue-icon-btn celery-queue-icon-btn--refresh dashboard-broker-snapshot-refresh${snapshotRefreshBusy ? ' celery-queue-icon-btn--refreshing' : ''}`}
                  disabled={snapshotRefreshBusy}
                  onClick={(e) => {
                    e.stopPropagation()
                    void onBrokerSnapshotRefresh()
                  }}
                  title="Refresh worker list (Redis presence)"
                  aria-label="Refresh worker list from Redis"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M23 4v6h-6" />
                    <path d="M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </button>
              </div>
              {broker && (
                <div className="dashboard-broker-details">
                  <span title="Masked broker URL">{broker.url_masked}</span>
                  {broker.used_memory_human && <span>Memory: {broker.used_memory_human}</span>}
                  {broker.connected_clients != null && <span>Clients: {broker.connected_clients}</span>}
                  {broker.queues && Object.keys(broker.queues).length > 0 && (
                    <span>
                      Queues:{' '}
                      {Object.entries(broker.queues)
                        .map(([q, n]) => `${q}(${n})`)
                        .join(', ')}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Workers */}
            {showInitialSkeleton ? (
              <div className="dashboard-empty">Loading broker and worker snapshot…</div>
            ) : workers.length === 0 ? (
              <div className="dashboard-empty">
                {instances.length > 0 ? (
                  <p className="dashboard-empty-hint">
                    Worker Instances lists matching OS processes (e.g. <code>run_celery.py</code>). Runtime Snapshot
                    only shows workers returned by <strong>Celery inspect</strong> on the configured broker. If you
                    just added an instance, wait a few seconds for the next poll; if this stays empty, check the
                    worker terminal for errors and that it uses the same Redis as Ops.
                  </p>
                ) : (
                  <>
                    No workers detected. Start a Celery worker: <code>python scripts/run_celery.py</code>
                  </>
                )}
              </div>
            ) : (
              <div className="dashboard-workers-grid">
                {workers.map(w => {
                  const lamp = workerLamp(w.status)
                  return (
                    <div
                      key={w.worker_id}
                      className={`dashboard-worker-card${consoleTarget === w.worker_id ? ' dashboard-worker-card--selected' : ''}`}
                      title={`Open console for ${w.worker_id}`}
                      onClick={() => {
                        selectConsole(w.worker_id)
                        scrollConsoleIntoView()
                      }}
                    >
                      <div className="dashboard-worker-header">
                        <span className={`title-inline-lamp lamp-icon ${lamp}`} aria-hidden>●</span>
                        <span className="dashboard-worker-id" title={w.worker_id}>{w.worker_id}</span>
                        <span className={`dashboard-worker-status dashboard-worker-status--${lamp}`}>
                          {workerStatusLabel(w.status)}
                        </span>
                        <button
                          type="button"
                          className="dashboard-worker-remove-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            const instanceId = workerIdToInstanceId(w.worker_id)
                            if (!instanceId) {
                              setScaleMsg({ text: `Cannot infer instance ID from ${w.worker_id}`, isErr: true })
                              return
                            }
                            onScaleRemove(instanceId)
                          }}
                          disabled={scaleBusy || !canOperate}
                          title={canOperate ? 'Remove this worker instance' : 'Requires operator role'}
                          aria-label={`Remove ${w.worker_id}`}
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                      <div className="dashboard-worker-meta">
                        <span>Queues: {w.queues.length > 0 ? w.queues.join(', ') : '—'}</span>
                        <span>Concurrency: {w.concurrency}</span>
                        <span>Active: {w.active_tasks} / Reserved: {w.reserved_tasks}</span>
                        <span>Heartbeat: {fmtRelative(w.last_heartbeat)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* ── Queue summary ──────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-queue-summary" aria-labelledby="dashboard-queue-summary-head">
            <h3 id="dashboard-queue-summary-head" className="page-title-with-tooltip">
              Queue summary
              <InfoTooltip text="Supported Celery queues: pending messages on the Redis broker, tasks currently executing on workers (routing key), and Done/Failed counts from PostgreSQL job tables (job_bars_backfill, job_massive_backfill)." />
            </h3>
            {queueSummaryDb === false && (
              <p className="dashboard-queue-summary-hint">PostgreSQL job totals unavailable (check ops config or DB).</p>
            )}
            {queueSummaryNote && (
              <p className="dashboard-queue-summary-note">{queueSummaryNote}</p>
            )}
            {queueSummary.length === 0 ? (
              <div className="dashboard-empty">
                {loading ? 'Loading queue summary…' : 'No queue summary from Ops API.'}
              </div>
            ) : (
              <div className="dashboard-queue-summary-table-wrap">
                <table className="table-operations dashboard-queue-summary-table">
                  <thead>
                    <tr>
                      <th>Queue</th>
                      <th>
                        Pending
                        <InfoTooltip text="Messages waiting on the Redis broker (LLEN)." />
                      </th>
                      <th>
                        Running
                        <InfoTooltip text="Celery tasks currently active or reserved for this queue (delivery routing key)." />
                      </th>
                      <th>
                        Done
                        <InfoTooltip text="Rows with status done in the job table for this pipeline." />
                      </th>
                      <th>
                        Failed
                        <InfoTooltip text="Rows with status failed in the job table for this pipeline." />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {queueSummary.map(row => (
                      <tr key={row.name}>
                        <td>
                          <code className="dashboard-queue-name">{formatQueueLabel(row.name)}</code>
                          {row.db_totals_shared ? (
                            <span className="dashboard-queue-shared-mark" title="DB totals shared (see note above)"> *</span>
                          ) : null}
                        </td>
                        <td>{fmtQueueCell(row.pending_broker)}</td>
                        <td>{fmtQueueCell(row.running_celery)}</td>
                        <td>{fmtQueueCell(row.done_db)}</td>
                        <td>{fmtQueueCell(row.failed_db)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Worker Scaling ─────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-scaling" aria-labelledby="dashboard-scale-head">
            <h3 id="dashboard-scale-head" className="page-title-with-tooltip">
              Worker Instances
              <InfoTooltip text="Select a worker type and click Add — the system assigns a unique instance ID automatically." />
            </h3>
            {scaleMsg.text && (
              <span className={`settings-page-msg ${scaleMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{scaleMsg.text}</span>
            )}
            {instances.length > 0 && (
              <div className="dashboard-instances-list">
                {instances.map(inst => (
                  <div key={inst.unit} className="dashboard-instance-row">
                    <span className={`dashboard-instance-lamp ${inst.active === 'active' ? 'green' : 'red'}`}>●</span>
                    <span className="dashboard-instance-unit">{inst.unit}</span>
                    <span className="dashboard-instance-sub">{inst.sub}</span>
                    <button
                      type="button"
                      className="dashboard-svc-stop-btn"
                      onClick={() => {
                        const match = inst.unit.match(/@([^.]+)\.service/)
                        if (match) onScaleRemove(match[1])
                      }}
                      disabled={scaleBusy || !canOperate}
                      title={canOperate ? `Stop and remove ${inst.unit}` : 'Requires operator role'}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="dashboard-scale-add-row">
              <select
                className="dashboard-ctrl-input"
                value={scaleWorkerType}
                onChange={e => setScaleWorkerType(e.target.value)}
                disabled={scaleBusy || workerProfiles.length === 0}
              >
                {workerProfiles.length === 0 && <option value="">No profiles</option>}
                {workerProfiles.map(p => (
                  <option key={p.key} value={p.key}>
                    {p.label} ({p.queues.join(', ')})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-resume dashboard-btn dashboard-btn--start"
                onClick={onScaleAdd}
                disabled={scaleBusy || !scaleWorkerType || !canOperate}
              >
                {scaleBusy ? 'Working…' : 'Add Instance'}
              </button>
            </div>
          </section>

          {/* ── Broker Control ─────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-broker-ctrl" aria-labelledby="dashboard-broker-ctrl-head">
            <h3 id="dashboard-broker-ctrl-head" className="page-title-with-tooltip">
              Redis / Broker
              <InfoTooltip text="Live metrics (reachability, memory, clients, Celery-related keys) come from the configured Redis. Start, stop, and restart only apply when Redis is managed by systemd on the same host as Ops." />
            </h3>
            {brokerMsg.text && (
              <span className={`settings-page-msg ${brokerMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{brokerMsg.text}</span>
            )}
            {extBroker ? (
              <div className="dashboard-broker-ctrl-body">
                <div className="dashboard-broker-ctrl-info">
                  <span>Connected: <strong>{extBroker.connected ? 'Yes' : 'No'}</strong></span>
                  <span>Systemd on this host: <strong>{extBroker.locally_managed ? 'Yes' : 'No'}</strong></span>
                  {extBroker.used_memory_human && <span>Memory: {extBroker.used_memory_human}</span>}
                  {extBroker.connected_clients != null && <span>Clients: {extBroker.connected_clients}</span>}
                  {extBroker.queues && Object.keys(extBroker.queues).length > 0 && (
                    <span>
                      Celery keys:{' '}
                      {Object.entries(extBroker.queues)
                        .map(([q, n]) => `${q}(${n})`)
                        .join(', ')}
                    </span>
                  )}
                </div>
                {extBroker.locally_managed ? (
                  <div className="dashboard-broker-ctrl-actions">
                    <button
                      type="button"
                      className="btn-resume dashboard-btn dashboard-btn--start"
                      onClick={() => onBrokerAction('start')}
                      disabled={brokerBusy || !canAdmin}
                    >
                      Start
                    </button>
                    <button
                      type="button"
                      className="btn-resume dashboard-btn dashboard-btn--restart"
                      onClick={() => onBrokerAction('restart')}
                      disabled={brokerBusy || !canAdmin}
                    >
                      Restart
                    </button>
                    <button
                      type="button"
                      className="btn-shutdown-all dashboard-btn dashboard-btn--stop"
                      onClick={() => onBrokerAction('stop')}
                      disabled={brokerBusy || !canAdmin}
                    >
                      Stop
                    </button>
                  </div>
                ) : (
                  <p className="dashboard-broker-ctrl-readonly">
                    Broker is reachable from Ops using the configured Redis URL (read-only view). Start/stop/restart via systemd are not available unless Redis runs on this machine under systemd.
                  </p>
                )}
              </div>
            ) : (
              <div className="dashboard-empty">Loading broker status…</div>
            )}
          </section>

          <CeleryJobQueuesSection />

          </div>

          {/* ── Audit Trail ──────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-audit" aria-labelledby="dashboard-audit-head">
            <div className="dashboard-section-header-row">
              <h3 id="dashboard-audit-head" className="page-title-with-tooltip">
                Audit Trail
                <InfoTooltip text="Audit log of all control-plane actions. Requires admin role. Records operator, IP, action, and outcome." />
              </h3>
              {hasAuditPermission && (
                <div className="dashboard-filter-row">
                  {(['all', 'success', 'submitted', 'denied', 'rejected', 'failed'] as const).map(f => (
                    <button
                      key={f}
                      type="button"
                      className={`dashboard-filter-btn ${auditFilter === f ? 'active' : ''}`}
                      onClick={() => setAuditFilter(f)}
                    >
                      {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {showInitialSkeleton && !auditError ? (
              <div className="dashboard-empty">Loading audit trail…</div>
            ) : auditError ? (
              <div className="dashboard-audit-permission-notice">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{auditError}</span>
              </div>
            ) : filteredAudit.length === 0 ? (
              <div className="dashboard-empty">
                {auditEntries.length === 0
                  ? 'No audit entries yet.'
                  : 'No entries match the current filter.'}
              </div>
            ) : (
              <>
                <div className="dashboard-audit-pagination-bar" role="navigation" aria-label="Audit log pagination">
                  <label className="dashboard-audit-page-size">
                    <span className="dashboard-audit-page-size-label">Rows per page</span>
                    <select
                      className="dashboard-ctrl-input dashboard-audit-page-size-select"
                      value={auditPageSize}
                      onChange={e => {
                        const v = Number(e.target.value) as AuditPageSize
                        setAuditPageSize(v)
                        setAuditPage(1)
                      }}
                      aria-label="Rows per page"
                    >
                      {AUDIT_PAGE_SIZES.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <span className="dashboard-audit-page-info">
                    {auditTotalFiltered === 0
                      ? '0 entries'
                      : `Showing ${auditRangeStart}–${auditRangeEnd} of ${auditTotalFiltered}`}
                  </span>
                  <div className="dashboard-audit-page-nav">
                    <button
                      type="button"
                      className="dashboard-console-btn"
                      disabled={auditPage <= 1}
                      onClick={() => setAuditPage(p => Math.max(1, p - 1))}
                      aria-label="Previous page"
                    >
                      Previous
                    </button>
                    <span className="dashboard-audit-page-of" aria-live="polite">
                      Page {auditTotalFiltered === 0 ? 0 : auditPage} of {auditTotalFiltered === 0 ? 0 : auditTotalPages}
                    </span>
                    <button
                      type="button"
                      className="dashboard-console-btn"
                      disabled={auditPage >= auditTotalPages || auditTotalFiltered === 0}
                      onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
                      aria-label="Next page"
                    >
                      Next
                    </button>
                  </div>
                </div>
                <div className="dashboard-cmd-table-wrap">
                  <table className="table-operations dashboard-audit-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Operator</th>
                        <th>Action</th>
                        <th>Target</th>
                        <th>Outcome</th>
                        <th>Source IP</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedAudit.map((entry, i) => {
                        const badge = auditOutcomeBadge(entry.outcome)
                        return (
                          <tr key={`${entry.timestamp}-${auditPage}-${i}`}>
                            <td>{fmtTimestamp(entry.timestamp)}</td>
                            <td>{entry.operator}</td>
                            <td>{entry.action}</td>
                            <td title={entry.target}>{entry.target}</td>
                            <td><span className={`dashboard-audit-badge ${badge.className}`}>{badge.label}</span></td>
                            <td>{entry.source_ip ?? '—'}</td>
                            <td className="dashboard-audit-detail-cell" title={entry.detail ?? ''}>{entry.detail || '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
    </div>
  )
}
