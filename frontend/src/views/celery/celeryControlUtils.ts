import type { SystemdInstance, WorkerSummary, WorkerProfileInfo, RunMassiveJobMatrixRow } from '../../api/ops/ops'

export type LampColor = 'green' | 'yellow' | 'red' | 'none'

/** Bubble value: all profiles — show bulk actions (Add all / Reset all / Remove all), hide single Add Instance. */
export const SCALE_SELECTION_ALL = '__celery_scale_all__'

export function workerLamp(status: string): LampColor {
  if (status === 'running_healthy') return 'green'
  if (status === 'running_degraded' || status === 'starting' || status === 'stopping') return 'yellow'
  if (status === 'stopped' || status === 'failed') return 'red'
  return 'none'
}

export function workerStatusLabel(status: string): string {
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

export function fmtRelative(epochSec: number | null): string {
  if (epochSec == null) return '—'
  const delta = Date.now() / 1000 - epochSec
  if (delta < 0) return 'just now'
  if (delta < 60) return `${Math.floor(delta)}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

/** Celery nodename is ``worker{id}@{hostname}`` — return host part for cross-machine hints. */
export function workerHostFromWorkerId(workerId: string): string | null {
  const i = workerId.indexOf('@')
  if (i < 0 || i >= workerId.length - 1) return null
  return workerId.slice(i + 1).trim() || null
}

export function workerIdToInstanceId(workerId: string): string | null {
  const node = workerId.split('@')[0]?.trim() ?? ''
  if (node.startsWith('worker') && node.length > 'worker'.length) {
    return node.slice('worker'.length)
  }
  return null
}

/** Instance id from `bifrost-celery-worker@ID.service` (systemd may escape chars in ID). */
export function instanceIdFromWorkerUnit(unit: string): string | null {
  const m = unit.trim().match(/^bifrost-celery-worker@(.+)\.service$/i)
  return m ? m[1] : null
}

/** Ops allocates IDs as `{profile_key}-{seq}` (e.g. `stocks_ib-2`). */
export function parseCeleryWorkerInstanceId(instanceId: string): { profileKey: string; cycle: number } | null {
  const m = instanceId.trim().match(/^([a-zA-Z0-9_]+)-(\d+)$/)
  if (!m) return null
  return { profileKey: m[1], cycle: parseInt(m[2], 10) }
}

/** One entry per profile key (first wins) so Add all / bubbles cannot repeat the same worker_type. */
export function dedupeWorkerProfilesByKey(profiles: WorkerProfileInfo[]): WorkerProfileInfo[] {
  const seen = new Set<string>()
  const out: WorkerProfileInfo[] = []
  for (const p of profiles) {
    if (seen.has(p.key)) continue
    seen.add(p.key)
    out.push(p)
  }
  return out
}

export const PROFILE_MAX_WORKER_INSTANCES_CAP = 64

export function profileMaxInstances(p: WorkerProfileInfo): number {
  const raw = p.max_worker_instances
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.min(PROFILE_MAX_WORKER_INSTANCES_CAP, Math.floor(raw)))
  }
  return 1
}

export function countInstancesForProfile(insts: SystemdInstance[], profileKey: string): number {
  const seenInstanceIds = new Set<string>()
  let n = 0
  for (const inst of insts) {
    const iid = instanceIdFromWorkerUnit(inst.unit)
    if (!iid || seenInstanceIds.has(iid)) continue
    const parts = parseCeleryWorkerInstanceId(iid)
    if (parts?.profileKey !== profileKey) continue
    seenInstanceIds.add(iid)
    n += 1
  }
  return n
}

/** Dev/prod/unknown from worker Redis presence (``worker_config_profile``), matched by profile key in nodename instance id. */
export function countWorkerStackByProfileKey(
  workers: WorkerSummary[],
  profileKey: string,
): { dev: number; prod: number; unknown: number } {
  const z = { dev: 0, prod: 0, unknown: 0 }
  for (const w of workers) {
    const iid = workerIdToInstanceId(w.worker_id)
    if (!iid) continue
    const parts = parseCeleryWorkerInstanceId(iid)
    if (parts?.profileKey !== profileKey) continue
    const cp = (w.worker_config_profile ?? '').toLowerCase().trim()
    if (cp === 'dev') z.dev += 1
    else if (cp === 'prod') z.prod += 1
    else z.unknown += 1
  }
  return z
}

export function workerSituationRowDetailTitle(
  cur: number,
  maxN: number,
  atCap: boolean,
  stack: { dev: number; prod: number; unknown: number },
): string {
  const sys = atCap
    ? `Systemd units on this host for this profile: ${cur} (at or above max ${maxN}).`
    : `Systemd units on this host for this profile: ${cur} / max ${maxN}.`
  const unk =
    stack.unknown > 0
      ? ` Unknown (no dev/prod in Redis presence): ${stack.unknown}.`
      : ''
  return `${sys} Celery on broker — Dev ${stack.dev}, Prod ${stack.prod}.${unk}`
}

export function workerProfileForInstanceUnit(
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

export function instanceConsumesCeleryQueue(
  unit: string,
  celeryQueue: string,
  profiles: WorkerProfileInfo[],
): boolean {
  const p = workerProfileForInstanceUnit(unit, profiles)
  if (!p?.queues?.length) return false
  return p.queues.some(q => q === celeryQueue)
}

export type ConfirmDialogState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  /** Primary action label (destructive remove uses Confirm delete). */
  confirmLabel?: string
  action: (() => Promise<void>) | null
}

export const INITIAL_CONFIRM: ConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  confirmLabel: undefined,
  action: null,
}

export type QueueKindMatrixSortColumn =
  | 'kind'
  | 'task_name'
  | 'job_style'
  | 'mode'
  | 'broker_queue'

export function queueKindMatrixSortArrow(
  column: QueueKindMatrixSortColumn,
  sort: { column: QueueKindMatrixSortColumn; direction: 'asc' | 'desc' },
): string {
  return sort.column === column ? (sort.direction === 'asc' ? '↑' : '↓') : ''
}

export function matrixRowHasEffectItems(items?: string[]): boolean {
  return Array.isArray(items) && items.length > 0
}

export type MatrixModeColumnVisibility = { showMode: boolean; showModeSource: boolean }

export type MatrixEffectsSectionVisibility = {
  showFeedApi: boolean
  showDb: boolean
  showRedis: boolean
}

/** Mirrors ``matrix_row_task_name_and_job_style`` in run_massive_job_manifest.py when API omits or sends empty strings. */
export const MATRIX_BEAT_SCHEDULED_KIND_TO_TASK: Record<string, string> = {
  eod_pipeline: 'src.massive.tasks.beat_eod_pipeline',
  feed_stocks_corporate_action: 'src.massive.tasks.beat_corporate_watchlist',
  reconcile: 'src.massive.tasks.beat_reconcile',
  trim_jobs: 'src.massive.tasks.beat_trim_massive_jobs',
}
export const MATRIX_RUN_MASSIVE_JOB_TASK_NAME = 'src.massive.tasks.run_massive_job'

export function resolvedMatrixTaskName(row: RunMassiveJobMatrixRow): string {
  const raw = (row.task_name ?? '').trim()
  if (raw) return raw
  const k = (row.kind ?? '').trim().toLowerCase()
  return MATRIX_BEAT_SCHEDULED_KIND_TO_TASK[k] ?? MATRIX_RUN_MASSIVE_JOB_TASK_NAME
}

export function resolvedMatrixJobStyle(row: RunMassiveJobMatrixRow): 'scheduled' | 'on_demand' {
  const js = row.job_style
  if (js === 'scheduled' || js === 'on_demand') return js
  const k = (row.kind ?? '').trim().toLowerCase()
  return MATRIX_BEAT_SCHEDULED_KIND_TO_TASK[k] != null ? 'scheduled' : 'on_demand'
}

export function matrixRowMatchesTaskNameText(row: RunMassiveJobMatrixRow, needle: string): boolean {
  const q = needle.trim()
  if (!q) return true
  return resolvedMatrixTaskName(row).toLowerCase().includes(q.toLowerCase())
}

export function matrixRowJobStyleKey(row: RunMassiveJobMatrixRow): 'scheduled' | 'on_demand' {
  return resolvedMatrixJobStyle(row)
}

export function matrixRowMatchesJobStyleToggles(
  row: RunMassiveJobMatrixRow,
  includeScheduled: boolean,
  includeOnDemand: boolean,
): boolean {
  if (!includeScheduled && !includeOnDemand) return true
  const k = matrixRowJobStyleKey(row)
  if (k === 'scheduled') return includeScheduled
  return includeOnDemand
}

export function matrixJobStyleLabel(row: RunMassiveJobMatrixRow): string {
  return matrixRowJobStyleKey(row) === 'scheduled' ? 'Scheduled' : 'On-demand'
}

export function compareQueueKindMatrixRows(
  a: RunMassiveJobMatrixRow,
  b: RunMassiveJobMatrixRow,
  column: QueueKindMatrixSortColumn,
  direction: 'asc' | 'desc',
): number {
  const mult = direction === 'asc' ? 1 : -1
  const str = (row: RunMassiveJobMatrixRow): string => {
    switch (column) {
      case 'kind':
        return row.kind ?? ''
      case 'task_name':
        return resolvedMatrixTaskName(row)
      case 'job_style':
        return resolvedMatrixJobStyle(row)
      case 'mode':
        return `${row.mode ?? ''}\0${row.mode_source ?? ''}`
      case 'broker_queue':
        return `${row.broker_queue_standard ?? ''}\0${row.broker_queue_high ?? ''}`
      default:
        return ''
    }
  }
  return mult * str(a).localeCompare(str(b), undefined, { sensitivity: 'base', numeric: true })
}

export function matrixRowMatchesKindText(row: RunMassiveJobMatrixRow, needle: string): boolean {
  const q = needle.trim()
  if (!q) return true
  return row.kind.toLowerCase().includes(q.toLowerCase())
}

export function matrixRowMatchesModeSourceText(row: RunMassiveJobMatrixRow, needle: string): boolean {
  const q = needle.trim()
  if (!q) return true
  const lo = q.toLowerCase()
  const modeStr = row.mode != null ? String(row.mode) : ''
  const src = row.mode_source != null ? String(row.mode_source) : ''
  return (
    modeStr.toLowerCase().includes(lo) ||
    src.toLowerCase().includes(lo) ||
    `${modeStr} · ${src}`.toLowerCase().includes(lo)
  )
}
