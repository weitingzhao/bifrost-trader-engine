import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { InfoTooltip } from '../components/InfoTooltip'
import { OpsHostEnvPillBadge } from '../components/OpsHostEnvPillBadge'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import {
  fetchCeleryLogs,
  subscribeCeleryLogs,
  clearCeleryLogs,
} from '../api/monitor/logs'
import {
  fetchOpsWorkers,
  fetchOpsCapabilities,
  fetchQueueSummary,
  scaleWorker,
  fetchWorkerInstances,
  fetchWorkerProfiles,
  fetchBrokerStatusExtended,
  fetchOpsHealth,
  controlBroker,
  brokerConsoleUrl,
  getOpsToken,
  setOpsToken,
  type WorkerSummary,
  type BrokerStatus,
  type SystemdInstance,
  type ExtendedBrokerStatus,
  type BrokerAction,
  type OpsCapabilities,
  type WorkerProfileInfo,
  type QueueSummaryRow,
} from '../api/ops/ops'
import { CeleryJobQueuesSection } from './celery/CeleryJobQueuesSection'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import {
  computeCeleryRuntimeLamp,
  dedupedQueueSummaryTotals,
  supportedQueueNamesFromSummary,
} from '../utils/celeryRuntime'
import { opsHostEnvFromConfigProfile } from '../utils/opsHostEnvPill'

export interface CeleryControlPageProps {
  embeddedInSettings?: boolean
  /** Same lamp as Settings sidebar Celery link (App: ops poll + status fallback). */
  celeryLamp?: 'green' | 'yellow' | 'red' | 'none'
}

type LampColor = 'green' | 'yellow' | 'red' | 'none'

/** Per-queue consumer coverage (Celery inspect + broker). */
function queueCoverageLamp(
  queueName: string,
  brokerConnected: boolean | undefined,
  workerList: WorkerSummary[],
): { lamp: LampColor; title: string } {
  if (brokerConnected !== true) {
    return { lamp: 'red', title: 'Broker not connected' }
  }
  const covered = workerList.some(w => (w.queues ?? []).includes(queueName))
  if (covered) {
    return {
      lamp: 'green',
      title: `At least one worker consumes queue “${queueName}”`,
    }
  }
  return {
    lamp: 'yellow',
    title: `No worker in this snapshot consumes queue “${queueName}”`,
  }
}

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

function fmtQueueCell(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return String(n)
}

function formatQueueLabel(name: string): string {
  if (name === 'massive_stocks_high') return 'Massive stocks (high priority)'
  if (name === 'massive_stocks') return 'Massive stocks'
  if (name === 'massive_high') return 'Massive options (high priority)'
  if (name === 'massive') return 'Massive options'
  if (name === 'bars') return 'Bars (IB)'
  return name
}

/** Celery nodename is ``worker{id}@{hostname}`` — return host part for cross-machine hints. */
function workerHostFromWorkerId(workerId: string): string | null {
  const i = workerId.indexOf('@')
  if (i < 0 || i >= workerId.length - 1) return null
  return workerId.slice(i + 1).trim() || null
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
  const node = workerId.split('@')[0]?.trim() ?? ''
  if (node.startsWith('worker') && node.length > 'worker'.length) {
    return node.slice('worker'.length)
  }
  return null
}

/** Instance id from `bifrost-celery-worker@ID.service` (systemd may escape chars in ID). */
function instanceIdFromWorkerUnit(unit: string): string | null {
  const m = unit.trim().match(/^bifrost-celery-worker@(.+)\.service$/i)
  return m ? m[1] : null
}

type ConfirmDialogState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  /** Primary action label (destructive remove uses Confirm delete). */
  confirmLabel?: string
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  confirmLabel: undefined,
  action: null,
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

export function CeleryControlPage({ embeddedInSettings, celeryLamp = 'none' }: CeleryControlPageProps) {
  const [workers, setWorkers] = useState<WorkerSummary[]>([])
  const [broker, setBroker] = useState<BrokerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState>(INITIAL_CONFIRM)
  const [confirmVariant, setConfirmVariant] = useState<'default' | 'scale-remove'>('default')
  const [scaleRemoveForce, setScaleRemoveForce] = useState(false)
  const scaleRemoveForceRef = useRef(false)

  const resetConfirmDialog = useCallback(() => {
    setConfirmState(INITIAL_CONFIRM)
    setConfirmVariant('default')
  }, [])
  const [tick, setTick] = useState(0)

  const [queueSummary, setQueueSummary] = useState<QueueSummaryRow[]>([])
  const [queueSummaryDb, setQueueSummaryDb] = useState<boolean | null>(null)

  // Worker scaling
  const [instances, setInstances] = useState<SystemdInstance[]>([])
  const [workerProfiles, setWorkerProfiles] = useState<WorkerProfileInfo[]>([])
  const [scaleWorkerType, setScaleWorkerType] = useState('')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleMsg, setScaleMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [snapshotRefreshBusy, setSnapshotRefreshBusy] = useState(false)
  /** Ops GET /health — Dev/Prod label for workers and systemd instances on this Ops host. */
  const [opsConfigProfile, setOpsConfigProfile] = useState<string | null>(null)

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
            fetchOpsHealth().catch(() => null),
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
          const healthRes = settled[4].status === 'fulfilled' ? settled[4].value : null
          if (healthRes && typeof healthRes.config_profile === 'string' && healthRes.config_profile.trim()) {
            setOpsConfigProfile(healthRes.config_profile.trim())
          } else if (healthRes) {
            setOpsConfigProfile(null)
          }

          if (qRes.ok) {
            setQueueSummary(qRes.queues)
            setQueueSummaryDb(qRes.db_connected ?? null)
          } else {
            setQueueSummary([])
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

  useEffect(() => {
    loadCaps()
    loadAll()
    const t = setInterval(() => {
      loadAll()
    }, 5000)
    const capsTimer = setInterval(loadCaps, 30000)
    const tickTimer = setInterval(() => setTick(n => n + 1), 1000)
    return () => {
      clearInterval(t)
      clearInterval(capsTimer)
      clearInterval(tickTimer)
    }
  }, [loadAll, loadCaps])

  const handleLogin = useCallback(() => {
    setOpsToken(tokenInput.trim())
    setTokenInput('')
    setAuthPanelOpen(false)
    loadCaps()
    loadAll()
  }, [tokenInput, loadCaps, loadAll])

  const handleLogout = useCallback(() => {
    setOpsToken('')
    setAuthPanelOpen(false)
    loadCaps()
  }, [loadCaps])

  void tick

  // ── Scaling handlers ──────────────────────────────────────────────────
  const onScaleRemove = (instanceId: string) => {
    scaleRemoveForceRef.current = false
    setScaleRemoveForce(false)
    setConfirmVariant('scale-remove')
    setConfirmState({
      open: true,
      title: `Remove worker instance ${instanceId}?`,
      message: `This will stop bifrost-celery-worker@${instanceId}.service (graceful stop first). If the process is stuck, enable force kill below.`,
      confirming: false,
      confirmLabel: 'Confirm delete',
      action: async () => {
        const force = scaleRemoveForceRef.current
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        try {
          const res = await scaleWorker({
            action: 'remove',
            instance_id: instanceId,
            force,
          })
          setScaleMsg({
            text: res.ok
              ? `Instance ${instanceId} stopped (unit ${res.after_state ?? 'inactive'}).`
              : (res.error ?? 'Failed'),
            isErr: !res.ok,
          })
          await loadAll()
          if (res.ok) await refreshOpsWorkersSnapshot({ forceRefresh: true })
        } catch (e) {
          setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
        } finally {
          setScaleBusy(false)
          resetConfirmDialog()
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

  /** One new instance per configured profile (same as choosing each type and clicking Add). */
  const onScaleAddAll = async () => {
    if (workerProfiles.length === 0) {
      setScaleMsg({ text: 'No worker profiles configured', isErr: true })
      return
    }
    setScaleBusy(true)
    const okParts: string[] = []
    const errParts: string[] = []
    try {
      for (const p of workerProfiles) {
        const res = await scaleWorker({ action: 'add', worker_type: p.key })
        if (res.ok) {
          const iid = res.instance_id ?? res.unit ?? p.key
          okParts.push(`${p.key} → ${iid}`)
        } else {
          errParts.push(`${p.key}: ${res.error ?? 'Failed'}`)
        }
      }
      if (errParts.length === 0) {
        setScaleMsg({
          text: `Started ${okParts.length} instance(s). ${okParts.join('; ')}`,
          isErr: false,
        })
      } else {
        setScaleMsg({
          text: `${errParts.length} failed, ${okParts.length} ok. Errors: ${errParts.join(' | ')}`,
          isErr: true,
        })
      }
      await loadAll()
      if (errParts.length === 0) await refreshOpsWorkersSnapshot({ forceRefresh: true })
    } catch (e) {
      setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setScaleBusy(false)
    }
  }

  const onScaleRemoveAllClick = () => {
    const ids = [
      ...new Set(
        instances
          .map(inst => instanceIdFromWorkerUnit(inst.unit))
          .filter((x): x is string => x != null),
      ),
    ]
    if (ids.length === 0) {
      setScaleMsg({ text: 'No worker instances to remove', isErr: true })
      return
    }
    setConfirmVariant('default')
    setScaleRemoveForce(false)
    setConfirmState({
      open: true,
      title: 'Remove all worker instances?',
      message: `This will stop ${ids.length} unit(s) on this Ops control host: ${ids.join(', ')}. Workers on other machines using the same broker are not affected.`,
      confirming: false,
      confirmLabel: 'Confirm delete',
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        const errors: string[] = []
        try {
          for (const instanceId of ids) {
            const res = await scaleWorker({ action: 'remove', instance_id: instanceId })
            if (!res.ok) errors.push(`${instanceId}: ${res.error ?? 'Failed'}`)
          }
          await loadAll()
          await refreshOpsWorkersSnapshot({ forceRefresh: true })
          setScaleMsg({
            text:
              errors.length === 0
                ? `Stopped ${ids.length} instance(s).`
                : `Stopped with ${errors.length} error(s): ${errors.join('; ')}`,
            isErr: errors.length > 0,
          })
        } catch (e) {
          setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
        } finally {
          setScaleBusy(false)
          resetConfirmDialog()
        }
      },
    })
  }

  // ── Broker control handlers ───────────────────────────────────────────
  const onBrokerAction = async (action: BrokerAction) => {
    if (action === 'stop') {
      setConfirmState({
        open: true,
        title: 'Stop Redis broker?',
        message: 'Stopping the broker will disconnect all workers and halt task processing.',
        confirming: false,
        confirmLabel: undefined,
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
            resetConfirmDialog()
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

  useEffect(() => {
    const scrollCelery = () => {
      const h = window.location.hash.replace(/^#/, '')
      if (h !== 'settings-celery' && h !== 'settings-dashboard-celery') return
      requestAnimationFrame(() => {
        document.getElementById('settings-celery-control')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    scrollCelery()
    window.addEventListener('hashchange', scrollCelery)
    return () => window.removeEventListener('hashchange', scrollCelery)
  }, [loading])

  const brokerLamp: LampColor = broker?.connected ? 'green' : 'red'
  const supportedCeleryQueueNames = supportedQueueNamesFromSummary(queueSummary)
  const runtimeCeleryLamp: LampColor = computeCeleryRuntimeLamp(
    broker?.connected === true,
    workers,
    supportedCeleryQueueNames,
  )
  const queueSummaryDeduped =
    queueSummary.length > 0 ? dedupedQueueSummaryTotals(queueSummary) : null
  const opsHostEnvPill = useMemo(() => opsHostEnvFromConfigProfile(opsConfigProfile), [opsConfigProfile])
  const opsHostEnvPillTitle = useMemo(() => {
    const raw = opsConfigProfile?.trim() || 'unknown'
    return `Stack for this Ops host (${raw} from GET /ops/health config_profile). Same label on every row: workers and units are managed by this Ops instance.`
  }, [opsConfigProfile])
  const runtimeCeleryStatusText =
    runtimeCeleryLamp === 'green'
      ? 'All supported queues covered'
      : runtimeCeleryLamp === 'red'
        ? 'Broker not connected'
        : workers.length === 0
          ? 'Broker only — no inspect workers'
          : 'Workers do not cover every supported queue'
  const showInitialSkeleton = loading && workers.length === 0

  const confirmDialog =
    confirmState.open &&
    createPortal(
      <div
        className="data-reset-modal-overlay celery-control-confirm-overlay"
        onClick={() => !confirmState.confirming && resetConfirmDialog()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="celery-control-confirm-title"
      >
        <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
          <h3 id="celery-control-confirm-title">{confirmState.title}</h3>
          <p>{confirmState.message}</p>
          {confirmVariant === 'scale-remove' && (
            <label className="celery-control-force-remove">
              <input
                type="checkbox"
                checked={scaleRemoveForce}
                onChange={e => {
                  scaleRemoveForceRef.current = e.target.checked
                  setScaleRemoveForce(e.target.checked)
                }}
                disabled={confirmState.confirming}
              />
              <span>
                Force kill stuck worker (SIGKILL) if it is still active after graceful stop
              </span>
            </label>
          )}
          <div className="data-reset-modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => resetConfirmDialog()}
              disabled={confirmState.confirming}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-shutdown-all"
              onClick={() => void confirmState.action?.()}
              disabled={confirmState.confirming}
            >
              {confirmState.confirming ? 'Executing…' : (confirmState.confirmLabel ?? 'Confirm')}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )

  return (
    <div
      id="settings-celery-control"
      className={`settings-page-card ${embeddedInSettings ? 'dashboard-page dashboard-page--embedded' : 'dashboard-page'}`}
    >
      {confirmDialog}

      <div className="settings-page-header settings-page-header--celery">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            <span
              className={`title-inline-lamp lamp-icon ${celeryLamp === 'none' ? 'none' : celeryLamp}`}
              title="Celery workers (broker + inspect)"
              aria-hidden
            >
              <SettingsSidebarLampGlyph id="celery" />
            </span>
            Celery
            <InfoTooltip text="Queue summary, worker scaling, runtime snapshot, consoles, broker control, and job queues." />
          </h2>
          <p className="settings-page-subtitle">
            Queue summary, worker instances, runtime snapshot, console, Redis / broker control, and job queues.
          </p>
        </div>
        <div className="dashboard-auth-bar dashboard-auth-bar--celery-header">
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
              <span className="dashboard-auth-badge dashboard-auth-badge--warn">Token required for control</span>
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
            <div className="dashboard-auth-panel dashboard-auth-panel--celery-header">
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
      </div>

      {error ? (
        <div className="dashboard-inline-alert msg err" role="status">
          {error}. Keep previous data on screen; retrying in next poll cycle.
        </div>
      ) : null}
      <div className="dashboard-grid settings-page-groups">
          <div className="dashboard-celery-group">
          {/* ── Queue summary ──────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-queue-summary" aria-labelledby="dashboard-queue-summary-head">
            <h3 id="dashboard-queue-summary-head" className="page-title-with-tooltip">
              Queue summary
              <InfoTooltip text="Per queue: broker pending, active/reserved counts, and PostgreSQL job table totals where configured. Status = whether any worker consumes this queue on the current broker snapshot; Host = Ops stack (GET /ops/health)." />
            </h3>
            {queueSummaryDb === false && (
              <p className="dashboard-queue-summary-hint">PostgreSQL job totals unavailable (check ops config or DB).</p>
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
                      <th style={{ width: 36 }}>Status</th>
                      <th style={{ width: 88 }}>
                        Host
                        <InfoTooltip text="Ops API stack from GET /ops/health (config_profile): Dev or Prod for this session, same as Socket Services." />
                      </th>
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
                    {queueSummary.map(row => {
                      const qCov = queueCoverageLamp(row.name, broker?.connected, workers)
                      return (
                        <tr key={row.name}>
                          <td>
                            <span
                              className={`title-inline-lamp lamp-icon ${qCov.lamp}`}
                              title={qCov.title}
                              aria-label={qCov.title}
                              role="img"
                            >
                              <span aria-hidden>●</span>
                            </span>
                          </td>
                          <td title={opsHostEnvPillTitle}>
                            <OpsHostEnvPillBadge pill={opsHostEnvPill} className="dashboard-celery-env-pill" />
                          </td>
                          <td>
                            <code className="dashboard-queue-name">{formatQueueLabel(row.name)}</code>
                            {row.db_totals_shared ? (
                              <span
                                className="dashboard-queue-shared-mark"
                                title="Same job_massive_backfill row counts as other Massive-like queue rows"
                              >
                                {' '}
                                *
                              </span>
                            ) : null}
                          </td>
                          <td>{fmtQueueCell(row.pending_broker)}</td>
                          <td>{fmtQueueCell(row.running_celery)}</td>
                          <td>{fmtQueueCell(row.done_db)}</td>
                          <td>{fmtQueueCell(row.failed_db)}</td>
                        </tr>
                      )
                    })}
                    {queueSummaryDeduped ? (
                      <tr className="dashboard-queue-summary-totals-row">
                        <td>
                          <span
                            className={`title-inline-lamp lamp-icon ${runtimeCeleryLamp}`}
                            title={runtimeCeleryStatusText}
                            aria-label={runtimeCeleryStatusText}
                            role="img"
                          >
                            <span aria-hidden>●</span>
                          </span>
                        </td>
                        <td title={opsHostEnvPillTitle}>
                          <OpsHostEnvPillBadge pill={opsHostEnvPill} className="dashboard-celery-env-pill" />
                        </td>
                        <td>
                          <strong>Total</strong>
                          <InfoTooltip text="Bars plus all Massive-like broker columns summed; DB done/failed once from shared job_massive_backfill." />
                        </td>
                        <td>{fmtQueueCell(queueSummaryDeduped.pending_broker)}</td>
                        <td>{fmtQueueCell(queueSummaryDeduped.running_celery)}</td>
                        <td>{fmtQueueCell(queueSummaryDeduped.done_db)}</td>
                        <td>{fmtQueueCell(queueSummaryDeduped.failed_db)}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="dashboard-celery-instances-broker-row">
            {/* ── Worker Scaling ─────────────────────────────────── */}
            <section className="replay-section dashboard-section dashboard-scaling" aria-labelledby="dashboard-scale-head">
              <h3 id="dashboard-scale-head" className="page-title-with-tooltip">
                Worker Instances
                <InfoTooltip text="Add Instance adds one worker for the selected profile (each Massive-related profile binds to a single Celery queue — no multi-queue sharing). Add all profiles starts one instance per profile in config. Remove all instances stops every unit listed below on this Ops host (confirmation required). Row chip = Ops host profile (GET /ops/health). If Runtime Snapshot still shows a worker after remove, check hostname on the worker card — another machine may share the same broker." />
              </h3>
              {scaleMsg.text && (
                <span className={`settings-page-msg ${scaleMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{scaleMsg.text}</span>
              )}
              {instances.length > 0 && (
                <div className="dashboard-instances-list">
                  {instances.map(inst => (
                    <div key={inst.unit} className="dashboard-instance-row">
                      <span className={`dashboard-instance-lamp ${inst.active === 'active' ? 'green' : 'red'}`}>●</span>
                      <OpsHostEnvPillBadge
                        pill={opsHostEnvPill}
                        className="dashboard-celery-env-pill"
                        title={opsHostEnvPillTitle}
                      />
                      <span className="dashboard-instance-unit">{inst.unit}</span>
                      <span className="dashboard-instance-sub">{inst.sub}</span>
                      <button
                        type="button"
                        className="dashboard-svc-stop-btn"
                        onClick={() => {
                          const iid = instanceIdFromWorkerUnit(inst.unit)
                          if (iid) {
                            onScaleRemove(iid)
                          } else {
                            setScaleMsg({
                              text: `Cannot parse instance id from unit name: ${inst.unit}`,
                              isErr: true,
                            })
                          }
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
              <div className="dashboard-scale-bulk-row">
                <button
                  type="button"
                  className="btn btn-secondary dashboard-btn"
                  onClick={() => void onScaleAddAll()}
                  disabled={scaleBusy || workerProfiles.length === 0 || !canOperate}
                  title="Start one worker instance for each profile in config (ops.worker_profiles)"
                >
                  {scaleBusy ? 'Working…' : 'Add all profiles'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger dashboard-btn"
                  onClick={onScaleRemoveAllClick}
                  disabled={scaleBusy || instances.length === 0 || !canOperate}
                  title="Stop every listed worker unit on this host"
                >
                  Remove all instances
                </button>
              </div>
            </section>

            {/* ── Broker Control ─────────────────────────────────── */}
            <section
              className="replay-section dashboard-section dashboard-broker-ctrl dashboard-broker-ctrl--celery-column"
              aria-labelledby="dashboard-broker-ctrl-head"
            >
              <h3 id="dashboard-broker-ctrl-head" className="page-title-with-tooltip">
                Redis / Broker
                <InfoTooltip text="Live metrics (reachability, memory, clients, Celery-related keys) come from the configured Redis. Start, stop, and restart only apply when Redis is managed by systemd on the same host as Ops." />
              </h3>
              {brokerMsg.text && (
                <span className={`settings-page-msg ${brokerMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{brokerMsg.text}</span>
              )}
              {extBroker ? (
                <div className="dashboard-broker-ctrl-body">
                  <div className="dashboard-broker-ctrl-info dashboard-broker-ctrl-info--compact">
                    <span>Connected: <strong>{extBroker.connected ? 'Yes' : 'No'}</strong></span>
                    <span>Systemd: <strong>{extBroker.locally_managed ? 'Yes' : 'No'}</strong></span>
                    {extBroker.used_memory_human && <span>Mem: {extBroker.used_memory_human}</span>}
                    {extBroker.connected_clients != null && <span>Clients: {extBroker.connected_clients}</span>}
                    {extBroker.queues && Object.keys(extBroker.queues).length > 0 && (
                      <span className="dashboard-broker-ctrl-keys-line">
                        Keys:{' '}
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
                      Read-only: Redis not under local systemd.
                    </p>
                  )}
                </div>
              ) : (
                <div className="dashboard-empty">Loading broker status…</div>
              )}
            </section>
          </div>

          {/* ── Runtime Snapshot ──────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-snapshot" aria-labelledby="dashboard-snapshot-head">
            <h3 id="dashboard-snapshot-head" className="page-title-with-tooltip">
              Runtime Snapshot
              <InfoTooltip text="Broker from Redis; workers from Redis presence + Celery inspect. Worker Dev/Prod badge = that process BIFROST_CONFIG (config.dev.yaml vs config.prod.yaml) from the worker Redis heartbeat. Ops role in the header = this Ops API host only. Text after @ in the worker id is the machine hostname. Remove stops the unit on the Ops control host; another machine using the same broker can still show a worker with the same instance id until stopped there." />
            </h3>
            <div className="dashboard-snapshot-celery-lamp-row" role="status">
              <span className={`title-inline-lamp lamp-icon ${runtimeCeleryLamp}`} aria-hidden>●</span>
              <strong className="dashboard-snapshot-celery-lamp-title">Celery (aggregate)</strong>
              <span className={`dashboard-snapshot-celery-lamp-status dashboard-svc-status--${runtimeCeleryLamp}`}>
                {runtimeCeleryStatusText}
              </span>
              <InfoTooltip text="Red: broker unreachable. Yellow: broker OK but no workers, or workers’ queue list does not include every supported queue (bars, massive_stocks_high, massive_stocks, massive_high, massive). Green: at least one worker and their combined queues cover all supported queues." />
            </div>

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
                  const workerStackPill = opsHostEnvFromConfigProfile(w.worker_config_profile ?? null)
                  const wh = workerHostFromWorkerId(w.worker_id)
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
                        <div className="dashboard-worker-header-row1">
                          <div className="dashboard-worker-header-leading">
                            <span className={`title-inline-lamp lamp-icon ${lamp}`} aria-hidden>●</span>
                            <OpsHostEnvPillBadge
                              pill={workerStackPill}
                              className="dashboard-celery-env-pill"
                              title={
                                w.worker_config_profile
                                  ? `Worker stack: ${w.worker_config_profile} (from BIFROST_CONFIG on that process)`
                                  : 'Worker stack unknown — restart worker after upgrade to publish dev/prod via Redis heartbeat'
                              }
                            />
                          </div>
                          <div className="dashboard-worker-header-trailing">
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
                              title={
                                canOperate
                                  ? 'Remove: stops the systemd/subprocess unit on the Ops control host for this instance id. Another host on the same broker may keep a worker visible until stopped there.'
                                  : 'Requires operator role'
                              }
                              aria-label={`Remove ${w.worker_id}`}
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <div className="dashboard-worker-identity">
                          <div className="dashboard-worker-id-full" title={w.worker_id}>
                            {w.worker_id}
                          </div>
                          {wh ? (
                            <div className="dashboard-worker-host-line" title="Machine hostname from Celery nodename">
                              @{wh}
                            </div>
                          ) : null}
                        </div>
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



          <CeleryJobQueuesSection />

          </div>
        </div>
    </div>
  )
}
