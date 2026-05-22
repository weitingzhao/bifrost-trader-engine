import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
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
  postRetryFailedBarsJobs,
  postRetryFailedMassiveJobs,
} from '../api'
import type { AggregatedJobQueueSummaryRow } from '../api'
import {
  fetchOpsWorkers,
  fetchCeleryCapabilities,
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
  type RunMassiveJobMatrixRow,
  type CelerySupportedTaskRow,
  type CeleryBeatTaskRow,
} from '../api/ops/ops'
import { parseCeleryQueueFromHash } from '../utils/celeryQueueDeepLink'
import { CeleryJobQueuesSection, type CeleryJobQueuesSectionHandle } from './celery/CeleryJobQueuesSection'
import { CeleryTopQueueSummary } from './celery/CeleryTopQueueSummary'
import { CeleryBeatSchedulePanel } from './celery/CeleryBeatSchedulePanel'
import { fetchMassiveCeleryBeatSchedule } from '../api/research/research'
import type { MassiveCeleryBeatEntry } from '../api/research/research'
import { brokerQueueKeyTitle, formatQueueLabel, setBrokerQueueLabelsFromApi } from '../utils/celeryQueueLabels'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import { SettingsPageCard } from './settings/SettingsPageCard'
import {
  SettingsPageHeader,
  SettingsPageTitle,
  SettingsPageSubtitle,
} from './settings/SettingsPageHeader'
import { SettingsTitleLamp } from './settings/SettingsTitleLamp'
import { Button } from '@/components/ui/button'
import type { LampTone } from '@/components/shared/lamp-indicator'
import { computeCeleryRuntimeLamp, supportedQueueNamesFromSummary } from '../utils/celeryRuntime'
import { opsHostEnvFromConfigProfile } from '../utils/opsHostEnvPill'
import {
  type LampColor,
  SCALE_SELECTION_ALL,
  workerLamp,
  workerStatusLabel,
  fmtRelative,
  workerHostFromWorkerId,
  workerIdToInstanceId,
  instanceIdFromWorkerUnit,
  parseCeleryWorkerInstanceId,
  dedupeWorkerProfilesByKey,
  profileMaxInstances,
  countInstancesForProfile,
  countWorkerStackByProfileKey,
  workerSituationRowDetailTitle,
  workerProfileForInstanceUnit,
  instanceConsumesCeleryQueue,
  type ConfirmDialogState,
  INITIAL_CONFIRM,
  type QueueKindMatrixSortColumn,
  queueKindMatrixSortArrow,
  matrixRowHasEffectItems,
  type MatrixModeColumnVisibility,
  type MatrixEffectsSectionVisibility,
  resolvedMatrixTaskName,
  matrixRowMatchesTaskNameText,
  matrixRowMatchesJobStyleToggles,
  matrixJobStyleLabel,
  compareQueueKindMatrixRows,
  matrixRowMatchesKindText,
  matrixRowMatchesModeSourceText,
} from './celery/celeryControlUtils'
import {
  IcoWorkerScaleAddAll,
  IcoWorkerInstanceAdd,
  IcoWorkerScaleReset,
  IcoWorkerInstanceRecreate,
  IcoWorkerInstanceRemove,
  IcoWorkerScaleRemoveAll,
} from './celery/CeleryWorkerIconButtons'

export interface CeleryControlPageProps {
  embeddedInSettings?: boolean
  /** Same lamp as Settings sidebar Celery link (App: ops poll + status fallback). */
  celeryLamp?: 'green' | 'yellow' | 'red' | 'none'
}

/** Local 1s tick only — avoids re-rendering the entire Celery dashboard every second. */
const WorkerHeartbeatLine = memo(function WorkerHeartbeatLine({
  epochSec,
}: {
  epochSec: number | null
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  return <span>Heartbeat: {fmtRelative(epochSec)}</span>
})

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

function MatrixEffectsBullets({ items }: { items: string[] }) {
  return (
    <ul className="celery-matrix-effects-list">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  )
}

function MatrixModeCell({
  row,
  visibility,
}: {
  row: RunMassiveJobMatrixRow
  visibility: MatrixModeColumnVisibility
}) {
  const { showMode, showModeSource } = visibility
  if (!showMode && !showModeSource) {
    return <span className="celery-matrix-mode-cell--empty">—</span>
  }
  return (
    <div className="celery-matrix-mode-cell">
      {showMode && <div>{row.mode != null ? <code>{row.mode}</code> : '—'}</div>}
      {showModeSource && (
        <div className="celery-matrix-mode-cell__source">
          <code>{row.mode_source}</code>
        </div>
      )}
    </div>
  )
}

/** Feed API / DB / Redis in one table cell (stacked sections). Respects visibility; omits empty sections. */
function MatrixEffectsStacked({
  row,
  visibility,
}: {
  row: RunMassiveJobMatrixRow
  visibility: MatrixEffectsSectionVisibility
}) {
  const showFeed =
    visibility.showFeedApi && matrixRowHasEffectItems(row.feed_apis)
  const showDb = visibility.showDb && matrixRowHasEffectItems(row.db_tables)
  const showRedis = visibility.showRedis && matrixRowHasEffectItems(row.redis_nodes)

  if (!showFeed && !showDb && !showRedis) {
    return <span className="celery-matrix-effects-empty">—</span>
  }

  return (
    <div className="celery-matrix-effects-stacked">
      {showFeed && row.feed_apis && (
        <div className="celery-matrix-effects-section">
          <div className="celery-matrix-effects-section__head">
            <span className="celery-matrix-effects-section__label">Feed API</span>
            <InfoTooltip text="Massive / Polygon REST endpoints used in this job path (documented SSOT: src/massive/run_massive_job_matrix_effects.py)." />
          </div>
          <MatrixEffectsBullets items={row.feed_apis} />
        </div>
      )}
      {showDb && row.db_tables && (
        <div className="celery-matrix-effects-section">
          <div className="celery-matrix-effects-section__head">
            <span className="celery-matrix-effects-section__label">DB</span>
            <InfoTooltip text="PostgreSQL tables written, upserted, or refreshed by this path (excluding job_massive_backfill status rows unless that is the sole subject)." />
          </div>
          <MatrixEffectsBullets items={row.db_tables} />
        </div>
      )}
      {showRedis && row.redis_nodes && (
        <div className="celery-matrix-effects-section">
          <div className="celery-matrix-effects-section__head">
            <span className="celery-matrix-effects-section__label">Redis</span>
            <InfoTooltip text="Redis key patterns or logical nodes (massive:ingestor:cache:* namespace for reference cache). Em dash when this path does not touch Redis in run_massive_job." />
          </div>
          <MatrixEffectsBullets items={row.redis_nodes} />
        </div>
      )}
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

  const [queueSummary, setQueueSummary] = useState<QueueSummaryRow[]>([])
  const [queueSummaryDb, setQueueSummaryDb] = useState<boolean | null>(null)
  const [beatScheduleEntries, setBeatScheduleEntries] = useState<MassiveCeleryBeatEntry[]>([])
  const [beatScheduleTimezone, setBeatScheduleTimezone] = useState<string | null>(null)
  const [beatScheduleError, setBeatScheduleError] = useState<string | null>(null)
  const [aggregatedJobRows, setAggregatedJobRows] = useState<AggregatedJobQueueSummaryRow[]>([])
  /** While set, both action icon buttons are disabled for that Celery queue row. */
  const [topQueueActionBusy, setTopQueueActionBusy] = useState<string | null>(null)
  const [flashMsg, setFlashMsg] = useState<{ text: string; isErr: boolean } | null>(null)
  const jobListReloadRef = useRef<((clearedQueue?: string) => void) | null>(null)
  const jobQueuesNavRef = useRef<CeleryJobQueuesSectionHandle>(null)

  // Worker scaling
  const [instances, setInstances] = useState<SystemdInstance[]>([])
  const [workerProfiles, setWorkerProfiles] = useState<WorkerProfileInfo[]>([])
  const workerProfilesDistinct = useMemo(() => dedupeWorkerProfilesByKey(workerProfiles), [workerProfiles])
  const [scaleWorkerType, setScaleWorkerType] = useState(SCALE_SELECTION_ALL)
  /** Add Instance: single unit vs fill toward (max workers − Dev − Prod), capped by free slots on this Ops host. */
  const [scaleAddMaxMode, setScaleAddMaxMode] = useState(true)
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
    'queues_instances' | 'console_runtime' | 'support_tasks' | 'scheduled_jobs'
  >('queues_instances')
  const [runMassiveJobMatrix, setRunMassiveJobMatrix] = useState<RunMassiveJobMatrixRow[]>([])
  /** Celery Beat entry points from capabilities (includes tasks not listed in the run_massive_job matrix). */
  const [celeryBeatTasks, setCeleryBeatTasks] = useState<CeleryBeatTaskRow[]>([])
  /** Full Celery worker task registry from capabilities (same source as former Task registry table). */
  const [registeredCeleryTasks, setRegisteredCeleryTasks] = useState<CelerySupportedTaskRow[]>([])
  const [supportTasksLoading, setSupportTasksLoading] = useState(false)
  const [supportTasksError, setSupportTasksError] = useState<string | null>(null)
  /** Broker Redis key: filter Task registry + Queue kind matrix (from Queue summary filter icon). */
  const [supportTasksBrokerFilter, setSupportTasksBrokerFilter] = useState<string | null>(null)

  /** Queue kind matrix: Mode column bubble toggles (default: Mode on, Mode source off). */
  const [matrixModeColumnVisibility, setMatrixModeColumnVisibility] = useState<MatrixModeColumnVisibility>({
    showMode: true,
    showModeSource: false,
  })
  /** Queue kind matrix: which Effects subsections may appear (default: DB + Redis; empty data still hides a subsection). */
  const [matrixEffectsSectionVisibility, setMatrixEffectsSectionVisibility] =
    useState<MatrixEffectsSectionVisibility>({
      showFeedApi: false,
      showDb: true,
      showRedis: true,
    })
  /** Queue kind matrix: show Broker queue (S · H) column (default off). */
  const [matrixShowBrokerQueueColumn, setMatrixShowBrokerQueueColumn] = useState(false)
  /** Queue kind matrix: substring match on ``kind`` (empty = no filter). */
  const [matrixKindFilterText, setMatrixKindFilterText] = useState('')
  /** Queue kind matrix: substring match on mode and/or mode_source (empty = no filter). */
  const [matrixModeLineFilterText, setMatrixModeLineFilterText] = useState('')
  /** Queue kind matrix: substring match on Celery task name (empty = no filter). */
  const [matrixTaskNameFilterText, setMatrixTaskNameFilterText] = useState('')
  /** Include rows whose job_style is scheduled / on_demand (both true = no style filter). */
  const [matrixJobStyleIncludeScheduled, setMatrixJobStyleIncludeScheduled] = useState(true)
  const [matrixJobStyleIncludeOnDemand, setMatrixJobStyleIncludeOnDemand] = useState(true)

  const brokerFilteredQueueKindMatrixRows = useMemo(() => {
    if (!supportTasksBrokerFilter) return runMassiveJobMatrix
    const f = supportTasksBrokerFilter
    return runMassiveJobMatrix.filter(
      row => row.broker_queue_standard === f || row.broker_queue_high === f,
    )
  }, [runMassiveJobMatrix, supportTasksBrokerFilter])

  const filteredQueueKindMatrixRows = useMemo(() => {
    let rows = brokerFilteredQueueKindMatrixRows
    if (matrixKindFilterText.trim()) {
      rows = rows.filter(r => matrixRowMatchesKindText(r, matrixKindFilterText))
    }
    if (matrixModeLineFilterText.trim()) {
      rows = rows.filter(r => matrixRowMatchesModeSourceText(r, matrixModeLineFilterText))
    }
    if (matrixTaskNameFilterText.trim()) {
      rows = rows.filter(r => matrixRowMatchesTaskNameText(r, matrixTaskNameFilterText))
    }
    rows = rows.filter(r =>
      matrixRowMatchesJobStyleToggles(r, matrixJobStyleIncludeScheduled, matrixJobStyleIncludeOnDemand),
    )
    return rows
  }, [
    brokerFilteredQueueKindMatrixRows,
    matrixKindFilterText,
    matrixModeLineFilterText,
    matrixTaskNameFilterText,
    matrixJobStyleIncludeScheduled,
    matrixJobStyleIncludeOnDemand,
  ])

  const clearMatrixRowFilters = useCallback(() => {
    setMatrixKindFilterText('')
    setMatrixModeLineFilterText('')
    setMatrixTaskNameFilterText('')
  }, [])

  const sortedRegisteredCeleryTasks = useMemo(
    () => [...registeredCeleryTasks].sort((a, b) => a.name.localeCompare(b.name)),
    [registeredCeleryTasks],
  )

  const [queueKindMatrixSort, setQueueKindMatrixSort] = useState<{
    column: QueueKindMatrixSortColumn
    direction: 'asc' | 'desc'
  }>({ column: 'kind', direction: 'asc' })

  const toggleQueueKindMatrixSort = useCallback((column: QueueKindMatrixSortColumn) => {
    setQueueKindMatrixSort(prev =>
      prev.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    )
  }, [])

  const sortedQueueKindMatrixRows = useMemo(() => {
    const rows = [...filteredQueueKindMatrixRows]
    const { column, direction } = queueKindMatrixSort
    rows.sort((a, b) => compareQueueKindMatrixRows(a, b, column, direction))
    return rows
  }, [filteredQueueKindMatrixRows, queueKindMatrixSort])

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
            fetchMassiveCeleryBeatSchedule().catch(() => ({ ok: false as const, error: 'Request failed' })),
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
          const beatRes =
            settled[6].status === 'fulfilled'
              ? settled[6].value
              : { ok: false as const, error: 'Request failed' }
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
          if (beatRes.ok && Array.isArray(beatRes.entries)) {
            setBeatScheduleEntries(beatRes.entries)
            setBeatScheduleTimezone(
              typeof beatRes.timezone === 'string' && beatRes.timezone.trim()
                ? beatRes.timezone.trim()
                : 'UTC',
            )
            setBeatScheduleError(null)
          } else {
            setBeatScheduleEntries([])
            setBeatScheduleTimezone(null)
            setBeatScheduleError(
              !beatRes.ok && typeof (beatRes as { error?: string }).error === 'string'
                ? (beatRes as { error: string }).error
                : 'Failed to load Celery Beat schedule',
            )
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
            setWorkerProfiles(dedupeWorkerProfilesByKey(pRes.profiles))
            setScaleWorkerType(prev => {
              if (prev === SCALE_SELECTION_ALL) return prev
              if (prev && dedupeWorkerProfilesByKey(pRes.profiles).some(p => p.key === prev)) return prev
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
    return () => {
      clearInterval(t)
      clearInterval(capsTimer)
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
    const prof = workerProfilesDistinct.find(x => x.key === scaleWorkerType)
    const maxN = prof ? profileMaxInstances(prof) : 1
    const cur = countInstancesForProfile(instances, scaleWorkerType)
    const stack = countWorkerStackByProfileKey(workers, scaleWorkerType)

    if (!scaleAddMaxMode) {
      if (cur >= maxN) {
        setScaleMsg({
          text: `Already at configured maximum (${maxN}) for ${scaleWorkerType}`,
          isErr: true,
        })
        return
      }
      setScaleBusy(true)
      try {
        const res = await scaleWorker({ action: 'add', worker_type: scaleWorkerType })
        if (res.ok) {
          const iid = res.instance_id ?? res.unit ?? scaleWorkerType
          setScaleMsg({ text: `Instance ${iid} started (${scaleWorkerType})`, isErr: false })
          await loadAll()
          await refreshOpsWorkersSnapshot({ forceRefresh: true })
        } else {
          setScaleMsg({ text: res.error ?? 'Failed', isErr: true })
        }
      } catch (e) {
        setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
      } finally {
        setScaleBusy(false)
      }
      return
    }

    const fleetRemaining = Math.max(0, maxN - stack.dev - stack.prod)
    const hostRemaining = Math.max(0, maxN - cur)
    const n = Math.min(fleetRemaining, hostRemaining)
    if (n === 0) {
      if (fleetRemaining === 0 && hostRemaining > 0) {
        setScaleMsg({
          text: `No capacity left by Dev+Prod (${stack.dev}+${stack.prod}) vs max ${maxN} for ${scaleWorkerType}.`,
          isErr: true,
        })
      } else if (hostRemaining === 0) {
        setScaleMsg({
          text: `Already at configured maximum (${maxN}) on this host for ${scaleWorkerType}.`,
          isErr: true,
        })
      } else {
        setScaleMsg({
          text: `Nothing to add for ${scaleWorkerType}.`,
          isErr: true,
        })
      }
      return
    }

    setScaleBusy(true)
    const okParts: string[] = []
    try {
      for (let i = 0; i < n; i++) {
        const res = await scaleWorker({ action: 'add', worker_type: scaleWorkerType })
        if (!res.ok) {
          setScaleMsg({
            text:
              okParts.length > 0
                ? `Stopped after ${okParts.length} ok: ${res.error ?? 'Failed'}`
                : (res.error ?? 'Failed'),
            isErr: true,
          })
          await loadAll()
          await refreshOpsWorkersSnapshot({ forceRefresh: true })
          return
        }
        const iid = res.instance_id ?? res.unit ?? scaleWorkerType
        okParts.push(String(iid))
      }
      setScaleMsg({
        text: `Started ${okParts.length} instance(s) for ${scaleWorkerType} (max ${maxN} − Dev ${stack.dev} − Prod ${stack.prod}, capped by this host): ${okParts.join(', ')}`,
        isErr: false,
      })
      await loadAll()
      await refreshOpsWorkersSnapshot({ forceRefresh: true })
    } catch (e) {
      setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setScaleBusy(false)
    }
  }

  /** Add worker units until each profile reaches ``max_worker_instances`` (current counts from *instances*). */
  const scaleFillToConfiguredMaxLoop = useCallback(async () => {
    const okParts: string[] = []
    const errParts: string[] = []
    for (const p of workerProfilesDistinct) {
      const maxN = profileMaxInstances(p)
      const current = countInstancesForProfile(instances, p.key)
      const need = Math.max(0, maxN - current)
      for (let i = 0; i < need; i++) {
        const res = await scaleWorker({ action: 'add', worker_type: p.key })
        if (res.ok) {
          const iid = res.instance_id ?? res.unit ?? p.key
          okParts.push(`${p.key} → ${iid}`)
        } else {
          errParts.push(`${p.key}: ${res.error ?? 'Failed'}`)
          break
        }
      }
    }
    return { okParts, errParts }
  }, [workerProfilesDistinct, instances])

  /** One new instance per configured profile (same as choosing each type and clicking Add). */
  const onScaleAddAll = async () => {
    if (workerProfilesDistinct.length === 0) {
      setScaleMsg({ text: 'No worker profiles configured', isErr: true })
      return
    }
    setScaleBusy(true)
    try {
      const { okParts, errParts } = await scaleFillToConfiguredMaxLoop()
      if (errParts.length === 0) {
        setScaleMsg({
          text:
            okParts.length > 0
              ? `Started ${okParts.length} instance(s) (filled toward per-profile max). ${okParts.join('; ')}`
              : 'All profiles already at or above configured worker limits on this host.',
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
    if (ids.length === 0 && workerProfilesDistinct.length === 0) {
      setScaleMsg({ text: 'No instances to remove and no profiles to add', isErr: true })
      return
    }
    setConfirmVariant('default')
    setConfirmState({
      open: true,
      title: 'Reset worker instances?',
        message:
        ids.length > 0
          ? `This will force-remove ${ids.length} worker unit(s) on this Ops host (${ids.join(', ')}), then start workers up to each profile's max_worker_instances (see limits table). Force remove uses graceful stop first, then SIGKILL if a unit is still active. Workers on other machines using the same broker are not affected.`
          : 'There are no worker units to remove on this host. Workers will be started up to each profile max_worker_instances.',
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
          if (workerProfilesDistinct.length === 0) {
            setScaleMsg({
              text:
                ids.length > 0
                  ? `Stopped ${ids.length} instance(s). No worker profiles configured to start.`
                  : 'Nothing to start.',
              isErr: false,
            })
            return
          }
          const { okParts, errParts } = await scaleFillToConfiguredMaxLoop()
          await loadAll()
          if (errParts.length === 0) {
            setScaleMsg({
              text:
                okParts.length > 0
                  ? `Reset complete. Started ${okParts.length} instance(s) (per-profile max). ${okParts.join('; ')}`
                  : 'Reset complete. Nothing started (check max_worker_instances).',
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
        h === 'settings-celery-support-tasks' ||
        h === 'settings-celery-scheduled-jobs' ||
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

  /** Coalesce burst refreshes (toolbar + list + top summary) so enqueue spikes do not stack many loadAll calls. */
  const jobCountsDebounceRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (jobCountsDebounceRef.current) clearTimeout(jobCountsDebounceRef.current)
    },
    [],
  )
  const refreshAfterJobMutation = useCallback(() => {
    if (jobCountsDebounceRef.current) clearTimeout(jobCountsDebounceRef.current)
    jobCountsDebounceRef.current = window.setTimeout(() => {
      jobCountsDebounceRef.current = null
      void loadAll()
    }, 400)
  }, [loadAll])

  const navigateToJobQueueFromSummary = useCallback((celeryQueue: string) => {
    const q = String(celeryQueue).trim()
    setWorkerInstancesQueueFilter(q)
    setCelerySectionTab('queues_instances')
    queueMicrotask(() => {
      jobQueuesNavRef.current?.navigateToQueue(q)
      document.getElementById('celery-panel-queues-instances')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  /** Queue summary totals row: same as filter bar “Show all instances” (full list after UI restart had null filter). */
  const clearWorkerInstancesQueueFilterFromTotals = useCallback(() => {
    setWorkerInstancesQueueFilter(null)
    setCelerySectionTab('queues_instances')
    queueMicrotask(() => {
      document.getElementById('celery-panel-queues-instances')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  /** Queue summary filter icon: Support Tasks tab + broker-key filter; click same queue again to clear filter. */
  const openSupportTasksWithQueueFilter = useCallback((brokerKey: string) => {
    const q = String(brokerKey).trim()
    if (!q) return
    setSupportTasksBrokerFilter(prev => (prev === q ? null : q))
    setCelerySectionTab('support_tasks')
    const h = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : ''
    if (h !== 'settings-celery-support-tasks' && typeof window !== 'undefined') {
      window.location.hash = 'settings-celery-support-tasks'
    }
    queueMicrotask(() => {
      document.getElementById('celery-panel-support-tasks')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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

  const loadSupportTasks = useCallback(async () => {
    setSupportTasksLoading(true)
    setSupportTasksError(null)
    try {
      const res = await fetchCeleryCapabilities()
      if (!res.ok) {
        setBrokerQueueLabelsFromApi(null)
        setSupportTasksError(res.error ?? 'Failed to load Celery capabilities')
        setRunMassiveJobMatrix([])
        setCeleryBeatTasks([])
        setRegisteredCeleryTasks([])
        return
      }
      setBrokerQueueLabelsFromApi(res.broker_queue_labels)
      setRunMassiveJobMatrix(res.run_massive_job_matrix ?? [])
      setCeleryBeatTasks(res.beat_tasks ?? [])
      setRegisteredCeleryTasks(
        (res.registered_tasks ?? []).map(t => {
          const dq = t.task_route_default_queue ?? t.default_queue
          return { name: t.name, default_queue: dq, task_route_default_queue: dq }
        }),
      )
    } catch (e) {
      setBrokerQueueLabelsFromApi(null)
      setSupportTasksError(e instanceof Error ? e.message : 'Failed to load')
      setRunMassiveJobMatrix([])
      setCeleryBeatTasks([])
      setRegisteredCeleryTasks([])
    } finally {
      setSupportTasksLoading(false)
    }
  }, [])

  useEffect(() => {
    if (celerySectionTab !== 'support_tasks' && celerySectionTab !== 'scheduled_jobs') return
    void loadSupportTasks()
  }, [celerySectionTab, loadSupportTasks])

  /** Deep link: `#settings-celery-support-tasks` / `#settings-celery-scheduled-jobs` open the matching tab. */
  useEffect(() => {
    const applyCelerySubtabHash = () => {
      const h = window.location.hash.replace(/^#/, '')
      if (h === 'settings-celery-support-tasks') {
        setCelerySectionTab('support_tasks')
      } else if (h === 'settings-celery-scheduled-jobs') {
        setCelerySectionTab('scheduled_jobs')
      }
    }
    applyCelerySubtabHash()
    window.addEventListener('hashchange', applyCelerySubtabHash)
    return () => window.removeEventListener('hashchange', applyCelerySubtabHash)
  }, [])

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

  /** Same delete APIs and confirm copy as Queues toolbar (deleteAllMassiveJobs / deleteAllBarsJobs purge). */
  const openQueueSummaryBulkDelete = useCallback(
    (row: AggregatedJobQueueSummaryRow, kind: 'pending' | 'running' | 'done' | 'failed') => {
      setConfirmVariant('default')
      const bars = row.pipeline === 'stocks_ib'
      const q = row.celery_queue
      const titleByKind: Record<typeof kind, string> = {
        pending: bars ? 'Delete pending bars backfill jobs' : `Delete pending Massive jobs (queue "${q}")`,
        running: bars ? 'Delete running bars backfill jobs' : `Delete running Massive jobs (queue "${q}")`,
        done: bars ? 'Delete done bars backfill jobs' : `Delete done Massive jobs (queue "${q}")`,
        failed: bars ? 'Delete failed bars backfill jobs' : `Delete failed Massive jobs (queue "${q}")`,
      }
      const messageByKind: Record<typeof kind, string> = {
        pending:
          'This will permanently delete all rows with status pending in this queue slice. This cannot be undone.',
        running:
          'This will permanently delete all rows with status running in this queue slice. A worker may still be executing a task; this only removes PostgreSQL rows and cannot be undone.',
        done: 'This will permanently delete all rows with status done in this queue slice. This cannot be undone.',
        failed:
          'This will permanently delete all rows with status failed in this queue slice. This cannot be undone.',
      }
      setConfirmState({
        open: true,
        title: titleByKind[kind],
        message: messageByKind[kind],
        confirming: false,
        confirmLabel: 'Confirm delete',
        action: async () => {
          setConfirmState(prev => ({ ...prev, confirming: true }))
          setTopQueueActionBusy(q)
          try {
            if (row.pipeline === 'massive_async') {
              const r = await deleteAllMassiveJobs(kind, row.celery_queue)
              if (!r.ok) throw new Error(r.error ?? 'Delete failed')
              setFlashMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
            } else {
              const r = await deleteAllBarsJobs(kind)
              if (!r.ok) throw new Error(r.error ?? 'Delete failed')
              setFlashMsg({ text: `Deleted ${r.deleted} job(s).`, isErr: false })
            }
            await loadAll()
            jobListReloadRef.current?.(q)
          } catch (e) {
            setFlashMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
          } finally {
            setTopQueueActionBusy(null)
            resetConfirmDialog()
          }
        },
      })
    },
    [loadAll, resetConfirmDialog],
  )

  const openQueueSummaryResetFailed = useCallback(
    (row: AggregatedJobQueueSummaryRow) => {
      setConfirmVariant('default')
      const q = row.celery_queue
      setConfirmState({
        open: true,
        title: row.pipeline === 'stocks_ib' ? 'Retry failed bars jobs' : `Retry failed Massive jobs (queue "${q}")`,
        message:
          'Reset up to 500 oldest failed jobs to pending and re-queue Celery. Some rows may fail to enqueue.',
        confirming: false,
        confirmLabel: 'Confirm',
        action: async () => {
          setConfirmState(prev => ({ ...prev, confirming: true }))
          setTopQueueActionBusy(q)
          try {
            if (row.pipeline === 'massive_async') {
              const r = await postRetryFailedMassiveJobs(q, 500)
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
            jobListReloadRef.current?.(q)
          } catch (e) {
            setFlashMsg({ text: e instanceof Error ? e.message : 'Operation failed', isErr: true })
          } finally {
            setTopQueueActionBusy(null)
            resetConfirmDialog()
          }
        },
      })
    },
    [loadAll, resetConfirmDialog],
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
    return instances.filter(inst => instanceConsumesCeleryQueue(inst.unit, q, workerProfilesDistinct))
  }, [instances, workerInstancesQueueFilter, workerProfilesDistinct])

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
    <SettingsPageCard
      id="settings-celery-control"
      embedded={embeddedInSettings}
      className="dashboard-page"
    >
      {confirmDialog}

      <SettingsPageHeader
        celeryLayout
        actions={
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
              <Button type="button" size="sm" onClick={handleLogin} disabled={!tokenInput.trim()}>
                Connect
              </Button>
            </div>
          )}
        </div>
        }
      >
        <SettingsPageTitle>
          <SettingsTitleLamp lamp={celeryLamp as LampTone} title="Celery workers (broker + inspect)">
            <SettingsSidebarLampGlyph id="celery" />
          </SettingsTitleLamp>
          Celery
          <InfoTooltip text="Queue summary (above tabs): broker + PostgreSQL job counts for every queue; same on all tabs. Queues & Instances: PostgreSQL job queues plus systemd worker instances and Redis/broker. Console & Runtime: live consoles and Celery inspect snapshot." />
        </SettingsPageTitle>
        <SettingsPageSubtitle>
          Queue summary at the top applies to all tabs. Main sections: Queues & Instances (job tables + workers and
          broker), or Console & Runtime (streams and inspect snapshot).
        </SettingsPageSubtitle>
      </SettingsPageHeader>

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

      <div className="dashboard-celery-queue-and-beat">
        <CeleryTopQueueSummary
          queueSummary={queueSummary}
          queueSummaryDb={queueSummaryDb}
          aggregatedRows={aggregatedJobRows}
          loading={loading}
          actionBusyQueue={topQueueActionBusy}
          workers={workers}
          brokerConnected={broker?.connected}
          runtimeCeleryLamp={runtimeCeleryLamp}
          runtimeCeleryStatusText={runtimeCeleryStatusText}
          onOpenSupportTasksFilter={openSupportTasksWithQueueFilter}
          activeSupportTasksFilterKey={supportTasksBrokerFilter}
          onClearDone={row => openQueueSummaryBulkDelete(row, 'done')}
          onDeletePending={row => openQueueSummaryBulkDelete(row, 'pending')}
          onDeleteRunning={row => openQueueSummaryBulkDelete(row, 'running')}
          onDeleteFailed={row => openQueueSummaryBulkDelete(row, 'failed')}
          onResetFailed={openQueueSummaryResetFailed}
          onNavigateToJobQueue={navigateToJobQueueFromSummary}
          onNavigateToJobQueueStatus={navigateToJobQueueStatusFromSummary}
          onNavigateQueueCoverageConsole={navigateToConsoleForQueueCoverage}
          onNavigateAggregateCoverageConsole={navigateToBrokerConsoleFromQueueSummary}
          highlightQueueName={workerInstancesQueueFilter}
          onTotalsRowClearWorkerFilter={clearWorkerInstancesQueueFilterFromTotals}
        />
        <section
          className="replay-section dashboard-section dashboard-worker-instance-situation"
          aria-labelledby="dashboard-worker-instance-situation-head"
        >
          <h3 id="dashboard-worker-instance-situation-head" className="page-title-with-tooltip">
            Worker instance situation
            <InfoTooltip text="Per profile: max_worker_instances from ops.worker_profiles (GET /ops/workers/profiles). Dev and Prod columns count Celery workers on the broker whose nodename instance id matches the profile (GET /ops/workers), using worker_config_profile from Redis presence (BIFROST_CONFIG). Workers without dev/prod in presence are summarized in the row hover text. Add all / Reset use on-host systemd counts toward max. Edit config.yaml and reload Ops to change limits." />
          </h3>
          {workerProfilesDistinct.length > 0 ? (
            <div className="dashboard-worker-instance-limits" role="region" aria-label="Worker instance limits and stack on this host">
              <table className="table-operations dashboard-worker-instance-limits-table">
                <thead>
                  <tr>
                    <th scope="col">Profile</th>
                    <th
                      scope="col"
                      title="Target bifrost-celery-worker units for this profile on this Ops host (config max_worker_instances)."
                    >
                      Max workers
                    </th>
                    <th
                      scope="col"
                      className="dashboard-worker-limit-th-stack"
                      title="Celery workers for this profile (instance id in nodename) reporting dev stack (BIFROST_CONFIG via Redis presence)."
                    >
                      Dev
                    </th>
                    <th
                      scope="col"
                      className="dashboard-worker-limit-th-stack"
                      title="Celery workers for this profile (instance id in nodename) reporting prod stack (BIFROST_CONFIG via Redis presence)."
                    >
                      Prod
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {workerProfilesDistinct.map(p => {
                    const maxN = profileMaxInstances(p)
                    const cur = countInstancesForProfile(instances, p.key)
                    const stack = countWorkerStackByProfileKey(workers, p.key)
                    const atCap = cur >= maxN
                    const rowTitle = workerSituationRowDetailTitle(cur, maxN, atCap, stack)
                    return (
                      <tr
                        key={`lim-${p.key}`}
                        className={atCap ? 'dashboard-worker-limit-row--at-cap' : undefined}
                        title={rowTitle}
                      >
                        <td>
                          <span className="dashboard-worker-limit-label">{p.label}</span>
                          <code className="dashboard-worker-limit-key">{p.key}</code>
                        </td>
                        <td className="dashboard-worker-limit-num">{maxN}</td>
                        <td
                          className={`dashboard-worker-limit-num dashboard-worker-limit-stack-num ${
                            stack.dev > 0
                              ? 'dashboard-worker-limit-stack-num--dev-on'
                              : 'dashboard-worker-limit-stack-num--off'
                          }`}
                        >
                          {stack.dev}
                        </td>
                        <td
                          className={`dashboard-worker-limit-num dashboard-worker-limit-stack-num ${
                            stack.prod > 0
                              ? 'dashboard-worker-limit-stack-num--prod-on'
                              : 'dashboard-worker-limit-stack-num--off'
                          }`}
                        >
                          {stack.prod}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="dashboard-worker-limit-footnote">
                Limits are read from config (reload Ops after editing YAML). default_max_worker_instances applies when a profile omits max_worker_instances. On this Ops host: systemd instances {instances.length} total.
              </p>
            </div>
          ) : (
            <p className="dashboard-empty-inline">No profiles</p>
          )}
        </section>
      </div>

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
        <button
          type="button"
          role="tab"
          id="celery-tab-support-tasks"
          aria-selected={celerySectionTab === 'support_tasks'}
          aria-controls="celery-panel-support-tasks"
          tabIndex={celerySectionTab === 'support_tasks' ? 0 : -1}
          className={`dashboard-celery-main-tab ${celerySectionTab === 'support_tasks' ? 'dashboard-celery-main-tab--active' : ''}`}
          onClick={() => setCelerySectionTab('support_tasks')}
        >
          Support Tasks
        </button>
        <button
          type="button"
          role="tab"
          id="celery-tab-scheduled-jobs"
          aria-selected={celerySectionTab === 'scheduled_jobs'}
          aria-controls="celery-panel-scheduled-jobs"
          tabIndex={celerySectionTab === 'scheduled_jobs' ? 0 : -1}
          className={`dashboard-celery-main-tab ${celerySectionTab === 'scheduled_jobs' ? 'dashboard-celery-main-tab--active' : ''}`}
          onClick={() => setCelerySectionTab('scheduled_jobs')}
        >
          Scheduled Jobs
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
          <div className="dashboard-celery-worker-broker-split">
            <div className="dashboard-celery-worker-instances-main">
            {/* ── Worker Instances (7/12): running units + scale controls ─────────────────────────────────── */}
            <section className="replay-section dashboard-section dashboard-scaling" aria-labelledby="dashboard-scale-head">
              <h3 id="dashboard-scale-head" className="page-title-with-tooltip">
                Worker Instances
                <InfoTooltip text="Running systemd/Celery worker units on this Ops host. Instance IDs are profile_key-sequence (Cycle). Queue summary: click a queue cell to filter this list. Profile bubbles: Add Instance / ALL with Add all, Reset all, Remove all. Per row: Recreate / Remove. Limits and Dev/Prod stack counts are in Worker instance situation (next to Queue summary above). Host chip = Ops API environment (GET /ops/health), not broker queue scope." />
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
                        <th scope="col">Host</th>
                        <th
                          scope="col"
                          title="ops.worker_profiles key / systemd instance prefix (distinct from broker queue label)."
                        >
                          Profile
                        </th>
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
                          const profile = workerProfileForInstanceUnit(inst.unit, workerProfilesDistinct)
                          const iid = instanceIdFromWorkerUnit(inst.unit)
                          const idParts = iid ? parseCeleryWorkerInstanceId(iid) : null
                          const rawQueues = profile?.queues ?? []
                          const rawQueue = rawQueues[0] ?? null
                          const queueTitle =
                            rawQueues.length > 1 ? rawQueues.join(', ') : (rawQueue ?? inst.unit)
                          const queueDisplay = rawQueue ? formatQueueLabel(rawQueue) : '—'
                          const profileKeyDisplay = idParts?.profileKey ?? profile?.key ?? null
                          const cycleDisplay = idParts != null ? String(idParts.cycle) : '—'
                          const workerTypeKey = idParts?.profileKey ?? profile?.key ?? null
                          const rowLabel =
                            rawQueue && idParts != null
                              ? `${formatQueueLabel(rawQueue)} #${idParts.cycle}`
                              : (iid ?? inst.unit)
                          return (
                            <tr key={inst.unit} className="dashboard-worker-instances-row">
                              <td className="dashboard-worker-instances-td-host">
                                <OpsHostEnvPillBadge
                                  pill={opsHostEnvPill}
                                  className="dashboard-celery-env-pill"
                                  title={opsHostEnvPillTitle}
                                />
                              </td>
                              <td className="dashboard-worker-instances-td-profile">
                                <span
                                  className="dashboard-instance-profile-key"
                                  title={iid ?? inst.unit}
                                >
                                  {profileKeyDisplay ?? '—'}
                                </span>
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
                {workerProfilesDistinct.length === 0 ? (
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
                    {workerProfilesDistinct.map(p => {
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
                          title={`${p.key} — ${queuesHint}`}
                          onClick={() => setScaleWorkerType(p.key)}
                        >
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {scaleWorkerType !== SCALE_SELECTION_ALL && (
                  <>
                    <div
                      className="dashboard-scale-add-max-group"
                      role="group"
                      aria-labelledby="celery-add-instance-max-label"
                    >
                      <span className="dashboard-scale-remove-all-force-label" id="celery-add-instance-max-label">
                        Max
                      </span>
                      <div
                        className="replay-bubble-switch dashboard-celery-remove-all-force-switch"
                        role="group"
                        aria-label="Add instance count: one unit or fill remaining from max minus Dev and Prod"
                      >
                        <button
                          type="button"
                          className={`replay-bubble-switch-btn ${!scaleAddMaxMode ? 'active' : ''}`}
                          onClick={() => setScaleAddMaxMode(false)}
                          disabled={scaleBusy || !canOperate}
                          title="Add a single worker instance on this host (same as before)"
                        >
                          1
                        </button>
                        <button
                          type="button"
                          className={`replay-bubble-switch-btn ${scaleAddMaxMode ? 'active' : ''}`}
                          onClick={() => setScaleAddMaxMode(true)}
                          disabled={scaleBusy || !canOperate}
                          title="Add up to (max workers − Dev − Prod) instances in one action, limited by free slots on this Ops host"
                        >
                          Max
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="celery-queue-icon-btn celery-queue-icon-btn--scale-add-all celery-queue-icon-btn--with-label dashboard-scale-add-instance-btn"
                      onClick={onScaleAdd}
                      disabled={scaleBusy || !scaleWorkerType || !canOperate}
                      title={
                        scaleAddMaxMode
                          ? 'Add worker instances: up to remaining capacity from max workers minus Dev and Prod (capped by this host)'
                          : 'Add one worker instance for the selected profile'
                      }
                      aria-label={
                        scaleBusy
                          ? 'Working'
                          : scaleAddMaxMode
                            ? 'Add Instance: start workers up to remaining fleet capacity for the selected profile'
                            : 'Add Instance: start one worker for the selected profile'
                      }
                    >
                      <IcoWorkerInstanceAdd />
                      <span className="celery-queue-icon-btn__label">
                        {scaleBusy ? 'Working…' : 'Add Instance'}
                      </span>
                    </button>
                  </>
                )}
              </div>
              {scaleWorkerType === SCALE_SELECTION_ALL && workerProfilesDistinct.length > 0 && (
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
                    disabled={scaleBusy || workerProfilesDistinct.length === 0 || !canOperate}
                    title="Add all — for each profile, start worker units until on-host count reaches max_worker_instances (config)"
                    aria-label="Add all profiles: fill toward configured max_worker_instances per profile"
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
                        ? 'Reset all — remove all worker units on this host, then refill to max_worker_instances per profile'
                        : 'Reset all — start workers up to each profile max_worker_instances (none on this host yet)'
                    }
                    aria-label={
                      instances.length > 0
                        ? 'Reset all: remove all on this host then fill to configured max per profile'
                        : 'Reset all: start workers up to configured max per profile'
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
            </div>

            <div className="dashboard-celery-worker-broker-side">
            <CeleryBeatSchedulePanel
              entries={beatScheduleEntries}
              timezone={beatScheduleTimezone}
              loading={loading}
              error={beatScheduleError}
            />

            {/* ── Broker Control (side column, below Scheduled Celery Beat) ───────────────────────────────── */}
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
              <InfoTooltip text="Red: broker unreachable. Yellow: broker OK but no workers, or workers’ queue list does not include every supported queue (Stocks IB, Stocks Massive (H), Stocks Massive, Massive Options (H), Options Massive — Redis keys stocks_ib, stocks_massive_high, stocks_massive, options_massive_high, options_massive). Green: at least one worker and their combined queues cover all supported queues." />
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
                        <WorkerHeartbeatLine epochSec={w.last_heartbeat} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          </div>

          {/* ── Tab: Support Tasks (registered Celery task names) ── */}
          <div
            role="tabpanel"
            id="celery-panel-support-tasks"
            aria-labelledby="celery-tab-support-tasks"
            hidden={celerySectionTab !== 'support_tasks'}
            className="dashboard-celery-tab-panel"
          >
            <section className="replay-section dashboard-section" aria-labelledby="celery-support-tasks-head">
              <div className="celery-support-tasks-sheet">
                <div className="celery-support-tasks-sheet__head">
                  <div className="celery-support-tasks-sheet__head-lead">
                    <h3 id="celery-support-tasks-head" className="page-title-with-tooltip">
                      Support Tasks
                      <InfoTooltip text="GET /ops/celery/capabilities: Queue kind/mode matrix for run_massive_job and the full worker task registry below. Celery Beat task names are listed in the Scheduled Jobs tab. Use the filter icon in Queue summary to narrow the matrix by broker queue." />
                    </h3>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void loadSupportTasks()}
                    disabled={supportTasksLoading}
                  >
                    Refresh
                  </button>
                </div>

                {supportTasksBrokerFilter ? (
                  <div className="celery-support-tasks-filter-banner" role="status">
                    <span>
                      Filtered by <strong>{formatQueueLabel(supportTasksBrokerFilter)}</strong>
                      <span className="celery-support-tasks-filter-banner-key" title={brokerQueueKeyTitle(supportTasksBrokerFilter)}>
                        {' '}
                        ({supportTasksBrokerFilter})
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setSupportTasksBrokerFilter(null)}
                    >
                      Clear filter
                    </button>
                  </div>
                ) : null}

                {supportTasksLoading ? (
                  <div className="dashboard-empty" role="status">
                    Loading…
                  </div>
                ) : supportTasksError ? (
                  <div className="dashboard-inline-alert msg err" role="alert">
                    {supportTasksError}
                  </div>
                ) : (
                  <>
                    <div
                      className="celery-support-tasks-sheet__block"
                      aria-labelledby="celery-support-tasks-matrix-head"
                    >
                      <h4
                        id="celery-support-tasks-matrix-head"
                        className="celery-support-tasks-sheet__block-title page-title-with-tooltip"
                      >
                        Queue kind / mode
                        <InfoTooltip text="Documented Massive job kind and payload mode combinations (run_massive_job). Columns include Task name (Beat insert task for scheduled kinds, else src.massive.tasks.run_massive_job) and Job style. Control bar: Kind / Mode · source / Task name filters; Job style bubbles; Mode column visibility; Effects; Broker queue column. Queue summary filter still applies first. Routing uses celery_queue_for_massive_job(kind). Mode does not affect queue selection." />
                      </h4>
                      {runMassiveJobMatrix.length === 0 ? (
                        <div className="dashboard-empty" role="status">
                          No matrix data returned.
                        </div>
                      ) : (
                        <>
                          <div
                            className="celery-matrix-control-bar"
                            role="region"
                            aria-label="Matrix filters and column visibility"
                          >
                            <div className="celery-matrix-control-bar__match">
                              <label className="celery-matrix-text-match-field">
                                <span className="celery-matrix-text-match-field__label">Kind</span>
                                <input
                                  type="search"
                                  className="form-control form-control-sm celery-matrix-text-match-input"
                                  value={matrixKindFilterText}
                                  onChange={e => setMatrixKindFilterText(e.target.value)}
                                  placeholder="Filter kind…"
                                  autoComplete="off"
                                  spellCheck={false}
                                  aria-label="Filter matrix rows by job kind substring"
                                />
                              </label>
                              <label className="celery-matrix-text-match-field celery-matrix-text-match-field--grow">
                                <span className="celery-matrix-text-match-field__label">Mode · source</span>
                                <input
                                  type="search"
                                  className="form-control form-control-sm celery-matrix-text-match-input"
                                  value={matrixModeLineFilterText}
                                  onChange={e => setMatrixModeLineFilterText(e.target.value)}
                                  placeholder="Filter mode or source…"
                                  autoComplete="off"
                                  spellCheck={false}
                                  aria-label="Filter matrix rows by mode and mode source substring"
                                />
                              </label>
                              <label className="celery-matrix-text-match-field celery-matrix-text-match-field--grow">
                                <span className="celery-matrix-text-match-field__label">Task name</span>
                                <input
                                  type="search"
                                  className="form-control form-control-sm celery-matrix-text-match-input"
                                  value={matrixTaskNameFilterText}
                                  onChange={e => setMatrixTaskNameFilterText(e.target.value)}
                                  placeholder="Filter task name…"
                                  autoComplete="off"
                                  spellCheck={false}
                                  aria-label="Filter matrix rows by Celery task name substring"
                                />
                              </label>
                              {(matrixKindFilterText.trim() !== '' ||
                                matrixModeLineFilterText.trim() !== '' ||
                                matrixTaskNameFilterText.trim() !== '') && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm celery-matrix-clear-row-filters"
                                  onClick={clearMatrixRowFilters}
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                            <span className="celery-matrix-control-bar__divider" aria-hidden />
                            <div className="celery-matrix-filter-toolbar celery-matrix-control-segment">
                              <span className="celery-matrix-filter-toolbar__label">Job style</span>
                              <div
                                className="replay-bubble-switch instance-sheet-bubble-switch--wrap celery-matrix-bubble-row"
                                role="group"
                                aria-label="Filter rows by job style"
                              >
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixJobStyleIncludeScheduled ? 'active' : ''}`}
                                  aria-pressed={matrixJobStyleIncludeScheduled}
                                  onClick={() => setMatrixJobStyleIncludeScheduled(v => !v)}
                                >
                                  Scheduled
                                </button>
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixJobStyleIncludeOnDemand ? 'active' : ''}`}
                                  aria-pressed={matrixJobStyleIncludeOnDemand}
                                  onClick={() => setMatrixJobStyleIncludeOnDemand(v => !v)}
                                >
                                  On-demand
                                </button>
                              </div>
                            </div>
                            <span className="celery-matrix-control-bar__divider" aria-hidden />
                            <div className="celery-matrix-filter-toolbar celery-matrix-control-segment">
                              <span className="celery-matrix-filter-toolbar__label">Mode column</span>
                              <div
                                className="replay-bubble-switch instance-sheet-bubble-switch--wrap celery-matrix-bubble-row"
                                role="group"
                                aria-label="Mode column fields to show"
                              >
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixModeColumnVisibility.showMode ? 'active' : ''}`}
                                  aria-pressed={matrixModeColumnVisibility.showMode}
                                  onClick={() =>
                                    setMatrixModeColumnVisibility(v => ({ ...v, showMode: !v.showMode }))
                                  }
                                >
                                  Mode
                                </button>
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixModeColumnVisibility.showModeSource ? 'active' : ''}`}
                                  aria-pressed={matrixModeColumnVisibility.showModeSource}
                                  onClick={() =>
                                    setMatrixModeColumnVisibility(v => ({
                                      ...v,
                                      showModeSource: !v.showModeSource,
                                    }))
                                  }
                                >
                                  Mode source
                                </button>
                              </div>
                            </div>
                            <span className="celery-matrix-control-bar__divider" aria-hidden />
                            <div className="celery-matrix-filter-toolbar celery-matrix-control-segment">
                              <span className="celery-matrix-filter-toolbar__label">Effects</span>
                              <div
                                className="replay-bubble-switch instance-sheet-bubble-switch--wrap celery-matrix-bubble-row"
                                role="group"
                                aria-label="Effects subsections to show when data exists"
                              >
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixEffectsSectionVisibility.showFeedApi ? 'active' : ''}`}
                                  aria-pressed={matrixEffectsSectionVisibility.showFeedApi}
                                  onClick={() =>
                                    setMatrixEffectsSectionVisibility(v => ({
                                      ...v,
                                      showFeedApi: !v.showFeedApi,
                                    }))
                                  }
                                >
                                  Feed API
                                </button>
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixEffectsSectionVisibility.showDb ? 'active' : ''}`}
                                  aria-pressed={matrixEffectsSectionVisibility.showDb}
                                  onClick={() =>
                                    setMatrixEffectsSectionVisibility(v => ({
                                      ...v,
                                      showDb: !v.showDb,
                                    }))
                                  }
                                >
                                  DB
                                </button>
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixEffectsSectionVisibility.showRedis ? 'active' : ''}`}
                                  aria-pressed={matrixEffectsSectionVisibility.showRedis}
                                  onClick={() =>
                                    setMatrixEffectsSectionVisibility(v => ({
                                      ...v,
                                      showRedis: !v.showRedis,
                                    }))
                                  }
                                >
                                  Redis
                                </button>
                              </div>
                            </div>
                            <span className="celery-matrix-control-bar__divider" aria-hidden />
                            <div className="celery-matrix-filter-toolbar celery-matrix-control-segment celery-matrix-filter-toolbar--broker">
                              <span className="celery-matrix-filter-toolbar__label">Broker queue</span>
                              <div
                                className="replay-bubble-switch instance-sheet-bubble-switch--wrap celery-matrix-bubble-row"
                                role="group"
                                aria-label="Broker queue column visibility"
                              >
                                <button
                                  type="button"
                                  className={`replay-bubble-switch-btn ${matrixShowBrokerQueueColumn ? 'active' : ''}`}
                                  aria-pressed={matrixShowBrokerQueueColumn}
                                  title={
                                    matrixShowBrokerQueueColumn
                                      ? 'Hide Broker queue column'
                                      : 'Show Broker queue (S · H) column'
                                  }
                                  onClick={() => setMatrixShowBrokerQueueColumn(v => !v)}
                                >
                                  S · H
                                </button>
                              </div>
                            </div>
                          </div>
                          {filteredQueueKindMatrixRows.length === 0 ? (
                            <div className="dashboard-empty" role="status">
                              No matrix rows match the current filters.
                            </div>
                          ) : (
                        <div className="feed-massive-table-wrap">
                          <table className="data-table" aria-label="Queue kind and mode matrix">
                            <thead>
                              <tr>
                                <th scope="col">
                                  <button
                                    type="button"
                                    className="table-sort-header"
                                    onClick={() => toggleQueueKindMatrixSort('kind')}
                                    aria-sort={
                                      queueKindMatrixSort.column === 'kind'
                                        ? queueKindMatrixSort.direction === 'asc'
                                          ? 'ascending'
                                          : 'descending'
                                        : undefined
                                    }
                                  >
                                    Kind {queueKindMatrixSortArrow('kind', queueKindMatrixSort)}
                                  </button>
                                </th>
                                <th scope="col">
                                  <span className="celery-matrix-th-with-tooltip">
                                    <button
                                      type="button"
                                      className="table-sort-header"
                                      onClick={() => toggleQueueKindMatrixSort('task_name')}
                                      aria-sort={
                                        queueKindMatrixSort.column === 'task_name'
                                          ? queueKindMatrixSort.direction === 'asc'
                                            ? 'ascending'
                                            : 'descending'
                                          : undefined
                                      }
                                    >
                                      Task name {queueKindMatrixSortArrow('task_name', queueKindMatrixSort)}
                                    </button>
                                    <InfoTooltip text="Celery task symbol: for kinds also inserted by Celery Beat, the Beat task name (e.g. beat_eod_pipeline); otherwise the worker task src.massive.tasks.run_massive_job. Execution always goes through run_massive_job after the job row is queued." />
                                  </span>
                                </th>
                                <th scope="col">
                                  <span className="celery-matrix-th-with-tooltip">
                                    <button
                                      type="button"
                                      className="table-sort-header"
                                      onClick={() => toggleQueueKindMatrixSort('job_style')}
                                      aria-sort={
                                        queueKindMatrixSort.column === 'job_style'
                                          ? queueKindMatrixSort.direction === 'asc'
                                            ? 'ascending'
                                            : 'descending'
                                          : undefined
                                      }
                                    >
                                      Job style {queueKindMatrixSortArrow('job_style', queueKindMatrixSort)}
                                    </button>
                                    <InfoTooltip text="Matrix rows only cover run_massive_job kinds. Scheduled here means that kind is also inserted by a Celery Beat task (e.g. eod_pipeline, trim_jobs). Other Beat tasks (e.g. beat_refresh_expirations) appear in the Scheduled Jobs tab, not as matrix rows. On-demand: no Beat insert for this kind." />
                                  </span>
                                </th>
                                <th scope="col">
                                  <span className="celery-matrix-th-with-tooltip">
                                    <button
                                      type="button"
                                      className="table-sort-header"
                                      onClick={() => toggleQueueKindMatrixSort('mode')}
                                      aria-sort={
                                        queueKindMatrixSort.column === 'mode'
                                          ? queueKindMatrixSort.direction === 'asc'
                                            ? 'ascending'
                                            : 'descending'
                                          : undefined
                                      }
                                    >
                                      Mode &amp; source {queueKindMatrixSortArrow('mode', queueKindMatrixSort)}
                                    </button>
                                    <InfoTooltip text="Mode value and which field in the job payload JSON supplies it (payload.mode for most kinds; em dash when this kind has no mode dimension). Sort uses mode then source." />
                                  </span>
                                </th>
                                <th scope="col">
                                  <span className="celery-matrix-th-with-tooltip">
                                    Effects
                                    <InfoTooltip text="Subsections shown depend on the Effects bubbles and whether this row has data for Feed API, DB, or Redis." />
                                  </span>
                                </th>
                                {matrixShowBrokerQueueColumn ? (
                                  <th scope="col">
                                    <span className="celery-matrix-th-with-tooltip">
                                      <button
                                        type="button"
                                        className="table-sort-header"
                                        onClick={() => toggleQueueKindMatrixSort('broker_queue')}
                                        aria-sort={
                                          queueKindMatrixSort.column === 'broker_queue'
                                            ? queueKindMatrixSort.direction === 'asc'
                                              ? 'ascending'
                                              : 'descending'
                                            : undefined
                                        }
                                      >
                                        Broker queue (S · H){' '}
                                        {queueKindMatrixSortArrow('broker_queue', queueKindMatrixSort)}
                                      </button>
                                      <InfoTooltip text="Standard and high priority broker queues on one line (S then H), same display names as Queue summary. Hover each segment in the cell for its Redis list key (e.g. options_massive vs options_massive_high)." />
                                    </span>
                                  </th>
                                ) : null}
                              </tr>
                            </thead>
                            <tbody>
                              {sortedQueueKindMatrixRows.map((row, i) => (
                                <tr key={`${row.kind}-${row.mode ?? 'null'}-${i}`}>
                                  <td>
                                    <code>{row.kind}</code>
                                  </td>
                                  <td>
                                    <code className="celery-matrix-task-name-cell">{resolvedMatrixTaskName(row)}</code>
                                  </td>
                                  <td>{matrixJobStyleLabel(row)}</td>
                                  <td>
                                    <MatrixModeCell row={row} visibility={matrixModeColumnVisibility} />
                                  </td>
                                  <td>
                                    <MatrixEffectsStacked
                                      row={row}
                                      visibility={matrixEffectsSectionVisibility}
                                    />
                                  </td>
                                  {matrixShowBrokerQueueColumn ? (
                                    <td>
                                      <div
                                        className="celery-matrix-broker-cell"
                                        title={`Standard: ${row.broker_queue_standard} · High: ${row.broker_queue_high}`}
                                      >
                                        <abbr className="celery-matrix-broker-cell__tag" title="Standard priority">
                                          S
                                        </abbr>
                                        <span title={brokerQueueKeyTitle(row.broker_queue_standard)}>
                                          {formatQueueLabel(row.broker_queue_standard)}
                                        </span>
                                        <span className="celery-matrix-broker-cell__sep" aria-hidden>
                                          ·
                                        </span>
                                        <abbr className="celery-matrix-broker-cell__tag" title="High priority">
                                          H
                                        </abbr>
                                        <span title={brokerQueueKeyTitle(row.broker_queue_high)}>
                                          {formatQueueLabel(row.broker_queue_high)}
                                        </span>
                                      </div>
                                    </td>
                                  ) : null}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                          )}
                        </>
                      )}
                    </div>

                    {sortedRegisteredCeleryTasks.length > 0 ? (
                      <div
                        className="celery-support-tasks-sheet__block"
                        aria-labelledby="celery-support-tasks-registry-head"
                      >
                        <h4
                          id="celery-support-tasks-registry-head"
                          className="celery-support-tasks-sheet__block-title page-title-with-tooltip"
                        >
                          Registered Celery tasks
                          <InfoTooltip text="Full worker task registry from GET /ops/celery/capabilities (same list as the former Task registry sheet). Task route default queue is used when apply_async omits queue=." />
                        </h4>
                        <div className="feed-massive-table-wrap">
                          <table className="data-table" aria-label="Registered Celery tasks">
                            <thead>
                              <tr>
                                <th scope="col">Task name</th>
                                <th scope="col">Task route default queue</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortedRegisteredCeleryTasks.map(row => {
                                const dq = row.task_route_default_queue ?? row.default_queue ?? '—'
                                return (
                                <tr key={row.name}>
                                  <td>
                                    <code>{row.name}</code>
                                  </td>
                                  <td>
                                    {dq === '—' ? (
                                      '—'
                                    ) : (
                                      <span title={brokerQueueKeyTitle(dq)}>
                                        {formatQueueLabel(dq)}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </section>
          </div>

          {/* ── Tab: Scheduled Jobs (Celery Beat task names from capabilities) ── */}
          <div
            role="tabpanel"
            id="celery-panel-scheduled-jobs"
            aria-labelledby="celery-tab-scheduled-jobs"
            hidden={celerySectionTab !== 'scheduled_jobs'}
            className="dashboard-celery-tab-panel"
          >
            <section className="replay-section dashboard-section" aria-labelledby="celery-scheduled-jobs-head">
              <div className="celery-support-tasks-sheet">
                <div className="celery-support-tasks-sheet__head">
                  <div className="celery-support-tasks-sheet__head-lead">
                    <h3 id="celery-scheduled-jobs-head" className="page-title-with-tooltip">
                      Scheduled Jobs
                      <InfoTooltip text="Celery Beat task names from GET /ops/celery/capabilities (same source as the former Celery Beat block under Support Tasks). Most enqueue run_massive_job; beat_refresh_expirations runs in-process and does not correspond to a matrix row. UTC cron-style times are in Scheduled Celery Beat (Queues and Instances tab, above Redis/Broker)." />
                    </h3>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void loadSupportTasks()}
                    disabled={supportTasksLoading}
                  >
                    Refresh
                  </button>
                </div>

                {supportTasksLoading ? (
                  <div className="dashboard-empty" role="status">
                    Loading…
                  </div>
                ) : supportTasksError ? (
                  <div className="dashboard-inline-alert msg err" role="alert">
                    {supportTasksError}
                  </div>
                ) : celeryBeatTasks.length > 0 ? (
                  <div aria-labelledby="celery-scheduled-jobs-beat-head">
                    <h4
                      id="celery-scheduled-jobs-beat-head"
                      className="celery-support-tasks-sheet__block-title page-title-with-tooltip"
                    >
                      Celery Beat (scheduled)
                      <InfoTooltip text="Tasks invoked on a schedule by Celery Beat. Most enqueue run_massive_job; beat_refresh_expirations runs in-process and does not correspond to a matrix row." />
                    </h4>
                    <div className="feed-massive-table-wrap">
                      <table className="data-table" aria-label="Celery Beat scheduled tasks">
                        <thead>
                          <tr>
                            <th scope="col">Task name</th>
                            <th scope="col">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {celeryBeatTasks.map(b => (
                            <tr key={b.name}>
                              <td>
                                <code>{b.name}</code>
                              </td>
                              <td>{b.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="dashboard-empty" role="status">
                    No Celery Beat task rows returned from capabilities.
                  </div>
                )}
              </div>
            </section>
          </div>

          </div>
        </div>
    </SettingsPageCard>
  )
}
