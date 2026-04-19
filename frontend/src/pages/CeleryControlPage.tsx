import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DraggableModal } from '../components/DraggableModal'
import { InfoTooltip } from '../components/InfoTooltip'
import { OpsHostEnvPillBadge } from '../components/OpsHostEnvPillBadge'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import {
  fetchCeleryLogs,
  subscribeCeleryLogs,
  clearCeleryLogs,
} from '../api/monitor/logs'
import {
  deleteAllBarsJobs,
  deleteAllMassiveJobs,
  fetchAggregatedJobQueuesSummary,
  postBarsJobsClearDone,
  postMassiveJobsClearDone,
  postRetryFailedBarsJobs,
  postRetryFailedMassiveJobs,
} from '../api'
import type { AggregatedJobQueueSummaryRow } from '../api'
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
import { parseCeleryQueueFromHash } from '../utils/celeryQueueDeepLink'
import { CeleryJobQueuesSection, type CeleryJobQueuesSectionHandle } from './celery/CeleryJobQueuesSection'
import { CeleryTopQueueSummary, formatQueueLabel } from './celery/CeleryTopQueueSummary'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import { computeCeleryRuntimeLamp, supportedQueueNamesFromSummary } from '../utils/celeryRuntime'
import { opsHostEnvFromConfigProfile } from '../utils/opsHostEnvPill'

export interface CeleryControlPageProps {
  embeddedInSettings?: boolean
  /** Same lamp as Settings sidebar Celery link (App: ops poll + status fallback). */
  celeryLamp?: 'green' | 'yellow' | 'red' | 'none'
}

type LampColor = 'green' | 'yellow' | 'red' | 'none'

/** Bubble value: all profiles — show bulk actions (Add all / Reset all / Remove all), hide single Add Instance. */
const SCALE_SELECTION_ALL = '__celery_scale_all__'

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
      emptyText="No log lines yet. Start Worker: python scripts/systemd/run_celery.py"
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

/** Ops allocates IDs as `{profile_key}-{seq}` (e.g. `bars-2`). */
function parseCeleryWorkerInstanceId(instanceId: string): { profileKey: string; cycle: number } | null {
  const m = instanceId.trim().match(/^([a-zA-Z0-9_]+)-(\d+)$/)
  if (!m) return null
  return { profileKey: m[1], cycle: parseInt(m[2], 10) }
}

function workerProfileForInstanceUnit(
  unit: string,
  profiles: WorkerProfileInfo[],
): WorkerProfileInfo | undefined {
  const instanceId = instanceIdFromWorkerUnit(unit)
  if (!instanceId) return undefined
  const parts = parseCeleryWorkerInstanceId(instanceId)
  if (parts) {
    const p = profiles.find(x => x.key === parts.profileKey)
    if (p) return p
  }
  return profiles.find(p => p.key === instanceId)
}

function instanceConsumesCeleryQueue(
  unit: string,
  celeryQueue: string,
  profiles: WorkerProfileInfo[],
): boolean {
  const p = workerProfileForInstanceUnit(unit, profiles)
  if (!p?.queues?.length) return false
  return p.queues.some(q => q === celeryQueue)
}

function systemdInstanceStatusLabel(inst: SystemdInstance): string {
  const a = inst.active?.trim() ?? ''
  const s = inst.sub?.trim() ?? ''
  if (a && s) return `${a} (${s})`
  return a || s || '—'
}

function IcoWorkerScaleAddAll() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  )
}

/** Single instance add — one stack layer plus mark (distinct from Add all layers). */
function IcoWorkerInstanceAdd() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="2 17 12 22 22 17" />
      <line x1="12" y1="4" x2="12" y2="12" />
      <line x1="8" y1="8" x2="16" y2="8" />
    </svg>
  )
}

function IcoWorkerScaleReset() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  )
}

/** Per-row Recreate (same glyph as bulk Reset — force remove then add). */
function IcoWorkerInstanceRecreate() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  )
}

function IcoWorkerInstanceRemove() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

function IcoWorkerScaleRemoveAll() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
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
  const [scaleRemoveForce, setScaleRemoveForce] = useState(true)
  const scaleRemoveForceRef = useRef(true)
  /** Bulk "Remove all instances": pass force to each scale remove (SIGKILL after graceful stop). */
  const [scaleRemoveAllForce, setScaleRemoveAllForce] = useState(true)
  const scaleRemoveAllForceRef = useRef(true)

  const resetConfirmDialog = useCallback(() => {
    setConfirmState(INITIAL_CONFIRM)
    setConfirmVariant('default')
  }, [])
  const [tick, setTick] = useState(0)

  const [queueSummary, setQueueSummary] = useState<QueueSummaryRow[]>([])
  const [queueSummaryDb, setQueueSummaryDb] = useState<boolean | null>(null)
  const [aggregatedJobRows, setAggregatedJobRows] = useState<AggregatedJobQueueSummaryRow[]>([])
  /** While set, both action icon buttons are disabled for that Celery queue row. */
  const [topQueueActionBusy, setTopQueueActionBusy] = useState<string | null>(null)
  const [flashMsg, setFlashMsg] = useState<{ text: string; isErr: boolean } | null>(null)
  const jobListReloadRef = useRef<((clearedQueue?: string) => void) | null>(null)
  const jobQueuesNavRef = useRef<CeleryJobQueuesSectionHandle>(null)

  // Worker scaling
  const [instances, setInstances] = useState<SystemdInstance[]>([])
  const [workerProfiles, setWorkerProfiles] = useState<WorkerProfileInfo[]>([])
  const [scaleWorkerType, setScaleWorkerType] = useState(SCALE_SELECTION_ALL)
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

  /** Main sections: queues + instances (job DB + scaling + broker), or console + runtime snapshot. */
  const [celerySectionTab, setCelerySectionTab] = useState<
    'queues_instances' | 'console_runtime'
  >('queues_instances')
  /** Set when navigating from Queue summary — filter Worker Instances to profiles that consume this queue. */
  const [workerInstancesQueueFilter, setWorkerInstancesQueueFilter] = useState<string | null>(null)

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
            fetchAggregatedJobQueuesSummary().catch(() => ({
              ok: false as const,
              rows: [] as AggregatedJobQueueSummaryRow[],
            })),
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
          const aggRes =
            settled[5].status === 'fulfilled'
              ? settled[5].value
              : { ok: false as const, rows: [] as AggregatedJobQueueSummaryRow[] }
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
          if (aggRes.ok) {
            setAggregatedJobRows(aggRes.rows)
          } else {
            setAggregatedJobRows([])
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
            setScaleWorkerType(prev => {
              if (prev === SCALE_SELECTION_ALL) return prev
              if (prev && pRes.profiles.some(p => p.key === prev)) return prev
              return SCALE_SELECTION_ALL
            })
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
  /** Force-remove this unit, then add a new instance for the same worker profile key. */
  const onScaleRecreate = (instanceId: string, workerTypeKey: string) => {
    setConfirmVariant('default')
    setConfirmState({
      open: true,
      title: `Recreate worker instance ${instanceId}?`,
      message: `This will force-remove bifrost-celery-worker@${instanceId}.service on this Ops host, then start a new instance with worker type "${workerTypeKey}".`,
      confirming: false,
      confirmLabel: 'Confirm',
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        try {
          const rem = await scaleWorker({ action: 'remove', instance_id: instanceId, force: true })
          if (!rem.ok) {
            setScaleMsg({ text: rem.error ?? 'Remove failed', isErr: true })
            return
          }
          await loadAll()
          await refreshOpsWorkersSnapshot({ forceRefresh: true })
          const add = await scaleWorker({ action: 'add', worker_type: workerTypeKey })
          if (!add.ok) {
            setScaleMsg({
              text: `Instance removed, but add failed: ${add.error ?? 'Failed'}`,
              isErr: true,
            })
            await loadAll()
            await refreshOpsWorkersSnapshot({ forceRefresh: true })
            return
          }
          const iid = add.instance_id ?? add.unit ?? workerTypeKey
          setScaleMsg({
            text: `Recreated: new instance ${iid} (${workerTypeKey}).`,
            isErr: false,
          })
          await loadAll()
          await refreshOpsWorkersSnapshot({ forceRefresh: true })
        } catch (e) {
          setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
        } finally {
          setScaleBusy(false)
          resetConfirmDialog()
        }
      },
    })
  }

  const onScaleRemove = (instanceId: string) => {
    scaleRemoveForceRef.current = true
    setScaleRemoveForce(true)
    setConfirmVariant('scale-remove')
    setConfirmState({
      open: true,
      title: `Remove worker instance ${instanceId}?`,
      message: `This will stop bifrost-celery-worker@${instanceId}.service (graceful stop first). Force kill after graceful stop is on below; uncheck to only send graceful stop.`,
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
    if (!scaleWorkerType || scaleWorkerType === SCALE_SELECTION_ALL) {
      setScaleMsg({ text: 'Select a worker profile', isErr: true })
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

  /** One add call per profile; shared by Add all profiles and Reset. */
  const scaleAddAllProfilesLoop = useCallback(async () => {
    const okParts: string[] = []
    const errParts: string[] = []
    for (const p of workerProfiles) {
      const res = await scaleWorker({ action: 'add', worker_type: p.key })
      if (res.ok) {
        const iid = res.instance_id ?? res.unit ?? p.key
        okParts.push(`${p.key} → ${iid}`)
      } else {
        errParts.push(`${p.key}: ${res.error ?? 'Failed'}`)
      }
    }
    return { okParts, errParts }
  }, [workerProfiles])

  /** One new instance per configured profile (same as choosing each type and clicking Add). */
  const onScaleAddAll = async () => {
    if (workerProfiles.length === 0) {
      setScaleMsg({ text: 'No worker profiles configured', isErr: true })
      return
    }
    setScaleBusy(true)
    try {
      const { okParts, errParts } = await scaleAddAllProfilesLoop()
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
    const forceAll = scaleRemoveAllForceRef.current
    setConfirmVariant('default')
    setScaleRemoveForce(true)
    setConfirmState({
      open: true,
      title: 'Remove all worker instances?',
      message: forceAll
        ? `This will stop ${ids.length} unit(s) on this Ops control host: ${ids.join(', ')}. Force is on: each unit gets graceful stop first, then SIGKILL on this host if still active. Workers on other machines using the same broker are not affected.`
        : `This will stop ${ids.length} unit(s) on this Ops control host: ${ids.join(', ')}. Workers on other machines using the same broker are not affected.`,
      confirming: false,
      confirmLabel: 'Confirm delete',
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        const errors: string[] = []
        const force = scaleRemoveAllForceRef.current
        try {
          for (const instanceId of ids) {
            const res = await scaleWorker({ action: 'remove', instance_id: instanceId, force })
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

  /** Force-remove every instance on this host, then start one per profile (same as Remove all with Force on + Add all). */
  const onScaleResetClick = () => {
    const ids = [
      ...new Set(
        instances
          .map(inst => instanceIdFromWorkerUnit(inst.unit))
          .filter((x): x is string => x != null),
      ),
    ]
    if (ids.length === 0 && workerProfiles.length === 0) {
      setScaleMsg({ text: 'No instances to remove and no profiles to add', isErr: true })
      return
    }
    setConfirmVariant('default')
    setConfirmState({
      open: true,
      title: 'Reset worker instances?',
      message:
        ids.length > 0
          ? `This will force-remove ${ids.length} worker unit(s) on this Ops host (${ids.join(', ')}), then start one instance per configured profile. Force remove uses graceful stop first, then SIGKILL if a unit is still active. Workers on other machines using the same broker are not affected.`
          : 'There are no worker units to remove on this host. One instance will be started for each configured profile.',
      confirming: false,
      confirmLabel: 'Confirm',
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        const removeErrors: string[] = []
        try {
          const force = true
          for (const instanceId of ids) {
            const res = await scaleWorker({ action: 'remove', instance_id: instanceId, force })
            if (!res.ok) removeErrors.push(`${instanceId}: ${res.error ?? 'Failed'}`)
          }
          await loadAll()
          await refreshOpsWorkersSnapshot({ forceRefresh: true })
          if (removeErrors.length > 0) {
            setScaleMsg({
              text: `Reset: failed to remove some instance(s): ${removeErrors.join('; ')}. Add-all was skipped.`,
              isErr: true,
            })
            return
          }
          if (workerProfiles.length === 0) {
            setScaleMsg({
              text:
                ids.length > 0
                  ? `Stopped ${ids.length} instance(s). No worker profiles configured to start.`
                  : 'Nothing to start.',
              isErr: false,
            })
            return
          }
          const { okParts, errParts } = await scaleAddAllProfilesLoop()
          await loadAll()
          if (errParts.length === 0) {
            setScaleMsg({
              text: `Reset complete. Started ${okParts.length} instance(s). ${okParts.join('; ')}`,
              isErr: false,
            })
            await refreshOpsWorkersSnapshot({ forceRefresh: true })
          } else {
            setScaleMsg({
              text: `Removed all instances; ${errParts.length} add(s) failed: ${errParts.join(' | ')}. Started ${okParts.length}: ${okParts.join('; ')}`,
              isErr: true,
            })
          }
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
  /** Opens a console stream from Runtime Snapshot cards; switches to Console & Runtime tab and scrolls to Console. */
  const selectConsole = useCallback((target: ConsoleTarget) => {
    if (target === 'none') {
      setConsoleTarget('none')
      setConsoleUrl('')
      return
    }
    setCelerySectionTab('console_runtime')
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

  /** Queue summary Status lamp → Console & Runtime tab + Console (worker for queue, else broker). */
  const navigateToConsoleForQueueCoverage = useCallback(
    (celeryQueue: string) => {
      const q = String(celeryQueue).trim()
      const w = workers.find(x => (x.queues ?? []).includes(q))
      const target: 'broker' | string = w ? w.worker_id : 'broker'
      selectConsole(target)
      scrollConsoleIntoView()
    },
    [workers, selectConsole, scrollConsoleIntoView],
  )

  const navigateToBrokerConsoleFromQueueSummary = useCallback(() => {
    selectConsole('broker')
    scrollConsoleIntoView()
  }, [selectConsole, scrollConsoleIntoView])

  /** Toggle same target off (filter buttons only). */
  const openConsole = (target: ConsoleTarget) => {
    if (target === consoleTarget) {
      setConsoleTarget('none')
      setConsoleUrl('')
      return
    }
    if (target !== 'none') {
      setCelerySectionTab('console_runtime')
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
      const isCelery =
        h === 'settings-celery' ||
        h === 'settings-dashboard-celery' ||
        h.startsWith('settings-celery-queue-')
      if (!isCelery) return
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
  const captureJobListReload = useCallback((fn: (clearedQueue?: string) => void) => {
    jobListReloadRef.current = fn
  }, [])

  const refreshAfterJobMutation = useCallback(() => void loadAll(), [loadAll])

  const navigateToJobQueueFromSummary = useCallback((celeryQueue: string) => {
    const q = String(celeryQueue).trim()
    setWorkerInstancesQueueFilter(q)
    setCelerySectionTab('queues_instances')
    queueMicrotask(() => {
      jobQueuesNavRef.current?.navigateToQueue(q)
      document.getElementById('celery-panel-queues-instances')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  /** Deep link: `#settings-celery-queue-<name>` opens Queues & Instances tab and selects that Celery queue. */
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const applyQueueHash = () => {
      const q = parseCeleryQueueFromHash(window.location.hash)
      if (!q) return
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        navigateToJobQueueFromSummary(q)
      }, 100)
    }
    applyQueueHash()
    window.addEventListener('hashchange', applyQueueHash)
    return () => {
      window.removeEventListener('hashchange', applyQueueHash)
      if (t) clearTimeout(t)
    }
  }, [navigateToJobQueueFromSummary])

  const navigateToJobQueueStatusFromSummary = useCallback(
    (celeryQueue: string, status: 'pending' | 'running' | 'done' | 'failed') => {
      const q = String(celeryQueue).trim()
      setWorkerInstancesQueueFilter(q)
      setCelerySectionTab('queues_instances')
      queueMicrotask(() => {
        jobQueuesNavRef.current?.navigateToQueueWithStatus(q, status)
        document.getElementById('celery-panel-queues-instances')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    },
    [],
  )

  const executeClearDoneTop = useCallback(
    async (row: AggregatedJobQueueSummaryRow) => {
      const q = row.celery_queue
      setTopQueueActionBusy(q)
      try {
        if (row.pipeline === 'massive') {
          const r = await postMassiveJobsClearDone(row.celery_queue)
          if (!r.ok) throw new Error(r.error ?? 'Clear failed')
          setFlashMsg({ text: `Deleted ${r.deleted} done job(s).`, isErr: false })
        } else {
          const r = await postBarsJobsClearDone()
          if (!r.ok) throw new Error(r.error ?? 'Clear failed')
          setFlashMsg({ text: `Deleted ${r.deleted} done job(s).`, isErr: false })
        }
        await loadAll()
        jobListReloadRef.current?.(row.celery_queue)
      } catch (e) {
        setFlashMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
      } finally {
        setTopQueueActionBusy(null)
      }
    },
    [loadAll],
  )

  const executeDeleteFailedTop = useCallback(
    async (row: AggregatedJobQueueSummaryRow) => {
      const q = row.celery_queue
      setTopQueueActionBusy(q)
      try {
        if (row.pipeline === 'massive') {
          const r = await deleteAllMassiveJobs('failed', row.celery_queue)
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setFlashMsg({ text: `Deleted ${r.deleted} failed job(s).`, isErr: false })
        } else {
          const r = await deleteAllBarsJobs('failed')
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setFlashMsg({ text: `Deleted ${r.deleted} failed job(s).`, isErr: false })
        }
        await loadAll()
        jobListReloadRef.current?.(row.celery_queue)
      } catch (e) {
        setFlashMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
      } finally {
        setTopQueueActionBusy(null)
      }
    },
    [loadAll],
  )

  const executeDeletePendingTop = useCallback(
    async (row: AggregatedJobQueueSummaryRow) => {
      setTopQueueActionBusy(row.celery_queue)
      try {
        if (row.pipeline === 'massive') {
          const r = await deleteAllMassiveJobs('pending', row.celery_queue)
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setFlashMsg({ text: `Deleted ${r.deleted} pending job(s).`, isErr: false })
        } else {
          const r = await deleteAllBarsJobs('pending')
          if (!r.ok) throw new Error(r.error ?? 'Delete failed')
          setFlashMsg({ text: `Deleted ${r.deleted} pending job(s).`, isErr: false })
        }
        await loadAll()
        jobListReloadRef.current?.(row.celery_queue)
      } catch (e) {
        setFlashMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
      } finally {
        setTopQueueActionBusy(null)
      }
    },
    [loadAll],
  )

  const executeResetFailedTop = useCallback(
    async (row: AggregatedJobQueueSummaryRow) => {
      const q = row.celery_queue
      setTopQueueActionBusy(q)
      try {
        if (row.pipeline === 'massive') {
          const r = await postRetryFailedMassiveJobs(row.celery_queue, 500)
          if (!r.ok) throw new Error(r.error ?? 'Reset failed')
          setFlashMsg({
            text: `Reset ${r.reset ?? 0} job(s), enqueued ${r.enqueued ?? 0}.${r.enqueue_errors?.length ? ' Some enqueue errors.' : ''}`,
            isErr: Boolean(r.enqueue_errors?.length),
          })
        } else {
          const r = await postRetryFailedBarsJobs(500)
          if (!r.ok) throw new Error(r.error ?? 'Reset failed')
          setFlashMsg({
            text: `Reset ${r.reset ?? 0} job(s), enqueued ${r.enqueued ?? 0}.${r.enqueue_errors?.length ? ' Some enqueue errors.' : ''}`,
            isErr: Boolean(r.enqueue_errors?.length),
          })
        }
        await loadAll()
        jobListReloadRef.current?.(row.celery_queue)
      } catch (e) {
        setFlashMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
      } finally {
        setTopQueueActionBusy(null)
      }
    },
    [loadAll],
  )

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

  const filteredWorkerInstances = useMemo(() => {
    const q = workerInstancesQueueFilter?.trim()
    if (!q) return instances
    return instances.filter(inst => instanceConsumesCeleryQueue(inst.unit, q, workerProfiles))
  }, [instances, workerInstancesQueueFilter, workerProfiles])

  const confirmDialog = (
    <DraggableModal
      open={confirmState.open}
      onBackdropClick={() => {
        if (!confirmState.confirming) resetConfirmDialog()
      }}
      backdropLocked={confirmState.confirming}
      title={confirmState.title}
      titleId="celery-control-confirm-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
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
      }
    >
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
    </DraggableModal>
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
            <InfoTooltip text="Queue summary (above tabs): broker + PostgreSQL job counts for every queue; same on all tabs. Queues & Instances: PostgreSQL job queues plus systemd worker instances and Redis/broker. Console & Runtime: live consoles and Celery inspect snapshot." />
          </h2>
          <p className="settings-page-subtitle">
            Queue summary at the top applies to all tabs. Main sections: Queues & Instances (job tables + workers and
            broker), or Console & Runtime (streams and inspect snapshot).
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

      {flashMsg ? (
        <p
          className={`status-page-msg dashboard-celery-flash-msg ${flashMsg.isErr ? 'err' : 'ok'}`}
          role={flashMsg.isErr ? 'alert' : 'status'}
        >
          {flashMsg.text}
        </p>
      ) : null}

      <CeleryTopQueueSummary
        queueSummary={queueSummary}
        queueSummaryDb={queueSummaryDb}
        aggregatedRows={aggregatedJobRows}
        loading={loading}
        actionBusyQueue={topQueueActionBusy}
        workers={workers}
        brokerConnected={broker?.connected}
        opsHostEnvPill={opsHostEnvPill}
        opsHostEnvPillTitle={opsHostEnvPillTitle}
        runtimeCeleryLamp={runtimeCeleryLamp}
        runtimeCeleryStatusText={runtimeCeleryStatusText}
        onClearDone={executeClearDoneTop}
        onDeletePending={executeDeletePendingTop}
        onDeleteFailed={executeDeleteFailedTop}
        onResetFailed={executeResetFailedTop}
        onNavigateToJobQueue={navigateToJobQueueFromSummary}
        onNavigateToJobQueueStatus={navigateToJobQueueStatusFromSummary}
        onNavigateQueueCoverageConsole={navigateToConsoleForQueueCoverage}
        onNavigateAggregateCoverageConsole={navigateToBrokerConsoleFromQueueSummary}
        highlightQueueName={workerInstancesQueueFilter}
      />

      <div
        className="dashboard-celery-main-tabs"
        role="tablist"
        aria-label="Celery page sections"
      >
        <button
          type="button"
          role="tab"
          id="celery-tab-queues-instances"
          aria-selected={celerySectionTab === 'queues_instances'}
          tabIndex={celerySectionTab === 'queues_instances' ? 0 : -1}
          className={`dashboard-celery-main-tab ${celerySectionTab === 'queues_instances' ? 'dashboard-celery-main-tab--active' : ''}`}
          onClick={() => setCelerySectionTab('queues_instances')}
        >
          Queues &amp; Instances
        </button>
        <button
          type="button"
          role="tab"
          id="celery-tab-console-runtime"
          aria-selected={celerySectionTab === 'console_runtime'}
          tabIndex={celerySectionTab === 'console_runtime' ? 0 : -1}
          className={`dashboard-celery-main-tab ${celerySectionTab === 'console_runtime' ? 'dashboard-celery-main-tab--active' : ''}`}
          onClick={() => setCelerySectionTab('console_runtime')}
        >
          Console &amp; Runtime
        </button>
      </div>

      <div className="dashboard-grid settings-page-groups">
          <div className="dashboard-celery-group">
          {/* ── Tab: Queues & Instances (job DB + systemd workers + broker) ── */}
          <div
            role="tabpanel"
            id="celery-panel-queues-instances"
            aria-labelledby="celery-tab-queues-instances"
            hidden={celerySectionTab !== 'queues_instances'}
            className="dashboard-celery-tab-panel"
          >
            <CeleryJobQueuesSection
              ref={jobQueuesNavRef}
              onJobCountsChanged={refreshAfterJobMutation}
              onProvideJobListReload={captureJobListReload}
            />
          <div className="dashboard-celery-instances-broker-row">
            {/* ── Worker Scaling ─────────────────────────────────── */}
            <section className="replay-section dashboard-section dashboard-scaling" aria-labelledby="dashboard-scale-head">
              <h3 id="dashboard-scale-head" className="page-title-with-tooltip">
                Worker Instances
                <InfoTooltip text="Each profile consumes a single Celery queue; instance IDs are profile_key-sequence (Cycle). Queue summary: click a queue name or a Pending/Running/Done/Failed cell to jump here and filter rows to instances for that queue. Bubble ALL: Add all and Reset all are always available (with no instances, Reset confirms starting one worker per profile). Remove all appears only when at least one instance exists on this host. Pick a profile: Add Instance adds one worker for that profile. Per row: Recreate force-removes that unit then adds the same worker type again; Remove stops the unit (confirmation + optional Force). Row chip = Ops host profile (GET /ops/health)." />
              </h3>
              {scaleMsg.text && (
                <span className={`settings-page-msg ${scaleMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{scaleMsg.text}</span>
              )}
              {instances.length > 0 && workerInstancesQueueFilter != null && workerInstancesQueueFilter.trim() !== '' && (
                <div className="dashboard-worker-instances-filter-bar" role="status">
                  <span className="dashboard-worker-instances-filter-label">
                    Showing instances for queue{' '}
                    <strong>{formatQueueLabel(workerInstancesQueueFilter.trim())}</strong>
                    <code className="dashboard-worker-instances-filter-key">{workerInstancesQueueFilter.trim()}</code>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary dashboard-worker-instances-filter-clear"
                    onClick={() => setWorkerInstancesQueueFilter(null)}
                  >
                    Show all instances
                  </button>
                </div>
              )}
              {instances.length > 0 && (
                <div className="dashboard-instances-sheet-wrap">
                  <table
                    className="table-operations dashboard-worker-instances-table"
                    role="grid"
                    aria-label="Worker instances on this Ops host"
                  >
                    <thead>
                      <tr>
                        <th scope="col">Status</th>
                        <th scope="col">Host</th>
                        <th scope="col">Queue</th>
                        <th scope="col" title="Sequence number within the worker profile (e.g. bars-3 → 3).">
                          Cycle
                        </th>
                        <th scope="col" className="dashboard-worker-instances-th-action">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredWorkerInstances.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="dashboard-worker-instances-empty-filter">
                            {`No worker instance on this host for queue “${workerInstancesQueueFilter?.trim() ?? ''}”. Clear the filter or start an instance whose profile consumes this queue.`}
                          </td>
                        </tr>
                      ) : (
                        filteredWorkerInstances.map(inst => {
                          const profile = workerProfileForInstanceUnit(inst.unit, workerProfiles)
                          const statusOk = inst.active === 'active'
                          const iid = instanceIdFromWorkerUnit(inst.unit)
                          const idParts = iid ? parseCeleryWorkerInstanceId(iid) : null
                          const rawQueues = profile?.queues ?? []
                          const rawQueue = rawQueues[0] ?? null
                          const queueTitle =
                            rawQueues.length > 1 ? rawQueues.join(', ') : (rawQueue ?? inst.unit)
                          const queueDisplay = rawQueue ? formatQueueLabel(rawQueue) : '—'
                          const cycleDisplay = idParts != null ? String(idParts.cycle) : '—'
                          const workerTypeKey = idParts?.profileKey ?? profile?.key ?? null
                          const rowLabel =
                            rawQueue && idParts != null
                              ? `${formatQueueLabel(rawQueue)} #${idParts.cycle}`
                              : (iid ?? inst.unit)
                          return (
                            <tr key={inst.unit} className="dashboard-worker-instances-row">
                              <td className="dashboard-worker-instances-td-status">
                                <span className="dashboard-worker-instances-status-inner">
                                  <span
                                    className={`dashboard-instance-lamp ${statusOk ? 'green' : 'red'}`}
                                    title={systemdInstanceStatusLabel(inst)}
                                    aria-hidden
                                  >
                                    ●
                                  </span>
                                  <span className="dashboard-instance-status-text">
                                    {systemdInstanceStatusLabel(inst)}
                                  </span>
                                </span>
                              </td>
                              <td className="dashboard-worker-instances-td-host">
                                <OpsHostEnvPillBadge
                                  pill={opsHostEnvPill}
                                  className="dashboard-celery-env-pill"
                                  title={opsHostEnvPillTitle}
                                />
                              </td>
                              <td className="dashboard-worker-instances-td-queue">
                                <span className="dashboard-instance-queue-display" title={queueTitle}>
                                  {queueDisplay}
                                </span>
                              </td>
                              <td className="dashboard-worker-instances-td-cycle">
                                <span className="dashboard-instance-cycle-text" title={iid ?? inst.unit}>
                                  {cycleDisplay}
                                </span>
                              </td>
                              <td className="dashboard-worker-instances-td-action">
                                <div className="dashboard-worker-instances-action-buttons">
                                  <button
                                    type="button"
                                    className="celery-queue-icon-btn celery-queue-icon-btn--instance-recreate"
                                    onClick={() => {
                                      if (iid && workerTypeKey) {
                                        onScaleRecreate(iid, workerTypeKey)
                                      } else {
                                        setScaleMsg({
                                          text: `Cannot resolve worker profile for unit: ${inst.unit}`,
                                          isErr: true,
                                        })
                                      }
                                    }}
                                    disabled={scaleBusy || !canOperate}
                                    title={
                                      canOperate
                                        ? `Recreate: force-remove this unit, then add worker type ${workerTypeKey ?? '?'}`
                                        : 'Requires operator role'
                                    }
                                    aria-label={`Recreate worker instance ${rowLabel}`}
                                  >
                                    <IcoWorkerInstanceRecreate />
                                  </button>
                                  <button
                                    type="button"
                                    className="celery-queue-icon-btn celery-queue-icon-btn--instance-remove"
                                    onClick={() => {
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
                                    title={canOperate ? `Remove worker instance ${inst.unit}` : 'Requires operator role'}
                                    aria-label={`Remove worker instance ${rowLabel}`}
                                  >
                                    <IcoWorkerInstanceRemove />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="dashboard-scale-add-row">
                {workerProfiles.length === 0 ? (
                  <span className="dashboard-empty-inline">No profiles</span>
                ) : (
                  <div
                    className="replay-bubble-switch instance-sheet-bubble-switch--wrap dashboard-scale-add-profile-bubbles"
                    role="radiogroup"
                    aria-label="Worker profile or ALL"
                  >
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${scaleWorkerType === SCALE_SELECTION_ALL ? 'active' : ''}`}
                      role="radio"
                      aria-checked={scaleWorkerType === SCALE_SELECTION_ALL}
                      disabled={scaleBusy}
                      title="All profiles — Add all and Reset all below; Remove all only when instances exist on this host"
                      onClick={() => setScaleWorkerType(SCALE_SELECTION_ALL)}
                    >
                      ALL
                    </button>
                    {workerProfiles.map(p => {
                      const queuesHint = p.queues.length ? p.queues.join(', ') : '—'
                      const selected = scaleWorkerType === p.key
                      return (
                        <button
                          key={p.key}
                          type="button"
                          className={`replay-bubble-switch-btn ${selected ? 'active' : ''}`}
                          role="radio"
                          aria-checked={selected}
                          disabled={scaleBusy}
                          title={queuesHint}
                          onClick={() => setScaleWorkerType(p.key)}
                        >
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {scaleWorkerType !== SCALE_SELECTION_ALL && (
                  <button
                    type="button"
                    className="celery-queue-icon-btn celery-queue-icon-btn--scale-add-all celery-queue-icon-btn--with-label dashboard-scale-add-instance-btn"
                    onClick={onScaleAdd}
                    disabled={scaleBusy || !scaleWorkerType || !canOperate}
                    title="Add one worker instance for the selected profile"
                    aria-label={scaleBusy ? 'Working' : 'Add Instance: start one worker for the selected profile'}
                  >
                    <IcoWorkerInstanceAdd />
                    <span className="celery-queue-icon-btn__label">
                      {scaleBusy ? 'Working…' : 'Add Instance'}
                    </span>
                  </button>
                )}
              </div>
              {scaleWorkerType === SCALE_SELECTION_ALL && workerProfiles.length > 0 && (
              <div className="dashboard-scale-bulk-row">
                <div
                  className="dashboard-scale-bulk-icons"
                  role="group"
                  aria-label="Bulk worker instance actions"
                >
                  <button
                    type="button"
                    className="celery-queue-icon-btn celery-queue-icon-btn--scale-add-all celery-queue-icon-btn--with-label"
                    onClick={() => void onScaleAddAll()}
                    disabled={scaleBusy || workerProfiles.length === 0 || !canOperate}
                    title="Add all profiles — start one worker instance for each profile in config (ops.worker_profiles)"
                    aria-label="Add all profiles: start one instance per configured worker profile"
                  >
                    <IcoWorkerScaleAddAll />
                    <span className="celery-queue-icon-btn__label">Add all</span>
                  </button>
                  <button
                    type="button"
                    className="celery-queue-icon-btn celery-queue-icon-btn--scale-reset celery-queue-icon-btn--with-label"
                    onClick={onScaleResetClick}
                    disabled={scaleBusy || !canOperate}
                    title={
                      instances.length > 0
                        ? 'Reset all — force-remove all worker instances on this host, then add one per profile'
                        : 'Reset all — start one worker instance for each configured profile (none on this host yet)'
                    }
                    aria-label={
                      instances.length > 0
                        ? 'Reset all: force-remove all worker instances on this host, then add one instance per profile'
                        : 'Reset all: start one instance per configured profile'
                    }
                  >
                    <IcoWorkerScaleReset />
                    <span className="celery-queue-icon-btn__label">Reset all</span>
                  </button>
                </div>
                {instances.length > 0 && (
                  <div
                    className="dashboard-scale-remove-all-group"
                    role="group"
                    aria-label="Remove all worker instances"
                  >
                    <button
                      type="button"
                      className="celery-queue-icon-btn celery-queue-icon-btn--scale-remove-all celery-queue-icon-btn--with-label"
                      onClick={onScaleRemoveAllClick}
                      disabled={scaleBusy || !canOperate}
                      title="Remove all instances — stop every listed worker unit on this host (respects Force switch)"
                      aria-label="Remove all worker instances on this host"
                    >
                      <IcoWorkerScaleRemoveAll />
                      <span className="celery-queue-icon-btn__label">Remove all</span>
                    </button>
                    <span className="dashboard-scale-remove-all-force-label" id="celery-remove-all-force-label">
                      Force
                    </span>
                    <div
                      className="replay-bubble-switch dashboard-celery-remove-all-force-switch"
                      role="group"
                      aria-labelledby="celery-remove-all-force-label"
                    >
                      <button
                        type="button"
                        className={`replay-bubble-switch-btn ${!scaleRemoveAllForce ? 'active' : ''}`}
                        onClick={() => {
                          scaleRemoveAllForceRef.current = false
                          setScaleRemoveAllForce(false)
                        }}
                        disabled={scaleBusy || !canOperate}
                        title="Graceful stop only"
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        className={`replay-bubble-switch-btn ${scaleRemoveAllForce ? 'active' : ''}`}
                        onClick={() => {
                          scaleRemoveAllForceRef.current = true
                          setScaleRemoveAllForce(true)
                        }}
                        disabled={scaleBusy || !canOperate}
                        title="After graceful stop, SIGKILL if the unit is still active on this host (default)"
                      >
                        On
                      </button>
                    </div>
                  </div>
                )}
              </div>
              )}
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
          </div>

          {/* ── Tab: Console & Runtime ── */}
          <div
            role="tabpanel"
            id="celery-panel-console-runtime"
            aria-labelledby="celery-tab-console-runtime"
            hidden={celerySectionTab !== 'console_runtime'}
            className="dashboard-celery-tab-panel"
          >
          {/* ── Console ── */}
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

          {/* ── Runtime Snapshot (below Console) ── */}
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
                    No workers detected. Start a Celery worker: <code>python scripts/systemd/run_celery.py</code>
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
          </div>

          </div>
        </div>
    </div>
  )
}
