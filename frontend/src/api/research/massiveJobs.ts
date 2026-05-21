import {
  getMassiveApiBase,
  getOpsApiBase,
  joinServiceBase,
} from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'
import type { JobQueueStatusCounts } from '../ops/bars'
import { opsAuthHeaders, opsControlFailureMessage } from '../ops/ops'

function massiveUrl(path: string): string {
  return joinServiceBase(getMassiveApiBase(), path)
}

function opsMassiveJobsUrl(path: string): string {
  if (path.startsWith('?')) {
    return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${path}`)
  }
  const p = path.startsWith('/') ? path : `/${path}`
  return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${p}`)
}

// suppress unused import warning
void fetchWithTimeout
void opsControlFailureMessage

export async function postMassiveSync(
  kind: string,
  payload: Record<string, unknown>,
  options?: { priority?: 'high'; signal?: AbortSignal },
): Promise<{
  ok: boolean
  job_id?: string
  job_ids?: string[]
  fan_out?: boolean
  chunks?: number
  targets_total?: number
  error?: string
  message?: string
  deduplicated?: boolean
}> {
  const r = await fetch(massiveUrl('/research/massive/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      payload,
      ...(options?.priority === 'high' ? { priority: 'high' } : {}),
    }),
    signal: options?.signal,
  })
  const j = await r.json().catch(() => ({}))
  if (r.status === 403) {
    return { ok: false, message: typeof j.message === 'string' ? j.message : 'Forbidden' }
  }
  const rawIds = j.job_ids
  const job_ids =
    Array.isArray(rawIds) && rawIds.length > 0
      ? rawIds.map((x: unknown) => String(x)).filter(Boolean)
      : undefined
  return {
    ok: Boolean(j.ok),
    job_id: typeof j.job_id === 'string' ? j.job_id : undefined,
    job_ids,
    fan_out: typeof j.fan_out === 'boolean' ? j.fan_out : undefined,
    chunks: typeof j.chunks === 'number' ? j.chunks : undefined,
    targets_total: typeof j.targets_total === 'number' ? j.targets_total : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
    message: typeof j.message === 'string' ? j.message : undefined,
    deduplicated: typeof j.deduplicated === 'boolean' ? j.deduplicated : undefined,
  }
}

export async function postMassiveApiCoverageSync(): Promise<{
  ok: boolean
  error?: string
  source?: string
  target?: string
  size_bytes?: number
}> {
  const r = await fetch(massiveUrl('/research/massive/api-coverage/sync'), {
    method: 'POST',
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok) && r.ok,
    error: typeof j.error === 'string' ? j.error : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    target: typeof j.target === 'string' ? j.target : undefined,
    size_bytes: Number.isFinite(Number(j.size_bytes)) ? Number(j.size_bytes) : undefined,
  }
}

export async function postMassiveStocksApiCoverageSync(): Promise<{
  ok: boolean
  error?: string
  source?: string
  target?: string
  size_bytes?: number
}> {
  const r = await fetch(massiveUrl('/research/massive/stocks-api-coverage/sync'), {
    method: 'POST',
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok) && r.ok,
    error: typeof j.error === 'string' ? j.error : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    target: typeof j.target === 'string' ? j.target : undefined,
    size_bytes: Number.isFinite(Number(j.size_bytes)) ? Number(j.size_bytes) : undefined,
  }
}

export interface MassiveJobApiRow {
  job_id: string
  type?: string
  kind?: string
  /** Human-readable intent derived server-side from kind + payload (no full payload in API). */
  goal?: string
  status?: string
  result?: unknown
  created_ts?: number
  updated_ts?: number
}

export async function fetchMassiveJobsSummary(celeryQueue: string): Promise<{
  ok: boolean
  counts: JobQueueStatusCounts
  error?: string
}> {
  const q = new URLSearchParams()
  if (celeryQueue.trim()) q.set('celery_queue', celeryQueue.trim())
  const r = await fetch(opsMassiveJobsUrl(`/summary?${q.toString()}`), { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  const c = j.counts as Record<string, unknown> | undefined
  const counts: JobQueueStatusCounts = {
    pending: typeof c?.pending === 'number' ? c.pending : 0,
    running: typeof c?.running === 'number' ? c.running : 0,
    done: typeof c?.done === 'number' ? c.done : 0,
    failed: typeof c?.failed === 'number' ? c.failed : 0,
  }
  return {
    ok: r.ok && j.ok !== false,
    counts,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function postMassiveJobsClearDone(celeryQueue: string): Promise<{
  ok: boolean
  deleted: number
  error?: string
}> {
  const q = new URLSearchParams()
  if (celeryQueue.trim()) q.set('celery_queue', celeryQueue.trim())
  const qs = q.toString()
  const r = await fetch(opsMassiveJobsUrl(`/clear-done${qs ? `?${qs}` : ''}`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function postRetryFailedMassiveJobs(
  celeryQueue: string,
  limit = 200,
): Promise<{
  ok: boolean
  error?: string
  reset?: number
  enqueued?: number
  enqueue_errors?: { job_id: string; error: string }[]
}> {
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(2000, limit))) })
  if (celeryQueue.trim()) params.set('celery_queue', celeryQueue.trim())
  const r = await fetch(opsMassiveJobsUrl(`/retry-failed?${params}`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok === true,
    error: typeof j.error === 'string' ? j.error : undefined,
    reset: typeof j.reset === 'number' ? j.reset : undefined,
    enqueued: typeof j.enqueued === 'number' ? j.enqueued : undefined,
    enqueue_errors: Array.isArray(j.enqueue_errors) ? j.enqueue_errors : undefined,
  }
}

/** Reset one failed Massive job to pending and re-queue Celery (requires Ops operator token). */
export async function postRetryMassiveJob(jobId: string): Promise<{
  ok: boolean
  error?: string
  job?: MassiveJobApiRow
}> {
  const r = await fetch(opsMassiveJobsUrl(`/${encodeURIComponent(jobId)}/retry`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  const raw = j.job as Record<string, unknown> | undefined
  let job: MassiveJobApiRow | undefined
  if (raw && typeof raw === 'object') {
    job = {
      job_id: String(raw.job_id ?? ''),
      type: typeof raw.type === 'string' ? raw.type : undefined,
      kind: typeof raw.kind === 'string' ? raw.kind : undefined,
      goal: typeof raw.goal === 'string' ? raw.goal : undefined,
      status: typeof raw.status === 'string' ? raw.status : undefined,
      result: raw.result,
      created_ts: typeof raw.created_ts === 'number' ? raw.created_ts : undefined,
      updated_ts: typeof raw.updated_ts === 'number' ? raw.updated_ts : undefined,
    }
  }
  return {
    ok: r.ok && j.ok === true,
    error: typeof j.error === 'string' ? j.error : undefined,
    job,
  }
}

export async function fetchMassiveJobsList(options?: {
  limit?: number
  offset?: number
  status?: string
  kind?: string
  /** Broker queue slice (options_massive, options_massive_high, stocks_massive, stocks_massive_high). */
  celery_queue?: string
}): Promise<{ ok: boolean; jobs: MassiveJobApiRow[]; error?: string }> {
  const q = new URLSearchParams()
  if (options?.limit != null) q.set('limit', String(options.limit))
  if (options?.offset != null) q.set('offset', String(options.offset))
  if (options?.status?.trim()) q.set('status', options.status.trim())
  if (options?.kind?.trim()) q.set('kind', options.kind.trim())
  if (options?.celery_queue?.trim()) q.set('celery_queue', options.celery_queue.trim())
  const r = await fetch(opsMassiveJobsUrl(`?${q.toString()}`), { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return {
      ok: false,
      jobs: [],
      error: typeof j.error === 'string' ? j.error : 'Request failed',
    }
  }
  const raw = Array.isArray(j.jobs) ? j.jobs : []
  const jobs: MassiveJobApiRow[] = raw.map((row: Record<string, unknown>) => ({
    job_id: String(row.job_id ?? ''),
    type: typeof row.type === 'string' ? row.type : undefined,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    goal: typeof row.goal === 'string' ? row.goal : undefined,
    status: typeof row.status === 'string' ? row.status : undefined,
    result: row.result,
    created_ts: typeof row.created_ts === 'number' ? row.created_ts : undefined,
    updated_ts: typeof row.updated_ts === 'number' ? row.updated_ts : undefined,
  }))
  return { ok: true, jobs }
}

export async function deleteMassiveJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(opsMassiveJobsUrl(`/${encodeURIComponent(jobId)}`), {
    method: 'DELETE',
    headers: opsAuthHeaders(),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: typeof j.error === 'string' ? j.error : undefined }
}

export async function deleteAllMassiveJobs(
  status?: string | null,
  celeryQueue?: string | null,
): Promise<{
  ok: boolean
  deleted: number
  error?: string
}> {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  if (celeryQueue?.trim()) params.set('celery_queue', celeryQueue.trim())
  const qs = params.toString()
  const r = await fetch(opsMassiveJobsUrl(`/purge${qs ? `?${qs}` : ''}`), {
    method: 'POST',
    headers: opsAuthHeaders(),
  })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; deleted?: number; error?: string; detail?: string }
  const err =
    typeof j.error === 'string'
      ? j.error
      : typeof j.detail === 'string'
        ? j.detail
        : undefined
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: err,
  }
}

export async function trimMassiveJobs(
  keep: number,
  celeryQueue?: string | null,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const params = new URLSearchParams({ keep: String(keep) })
  if (celeryQueue?.trim()) params.set('celery_queue', celeryQueue.trim())
  const r = await fetch(opsMassiveJobsUrl(`/trim?${params}`), { method: 'POST', headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

/** SSE until job reaches done/failed or stream errors. */
export function subscribeMassiveJobEvents(
  jobId: string,
  onEvent: (data: { ok: boolean; job?: MassiveJobApiRow; error?: string }) => void,
  options?: { timeoutSec?: number },
): { close: () => void } {
  const qs = new URLSearchParams()
  if (options?.timeoutSec != null) qs.set('timeout_sec', String(options.timeoutSec))
  const url = massiveUrl(`/research/massive/jobs/${encodeURIComponent(jobId)}/events?${qs.toString()}`)
  const es = new EventSource(url)
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as { ok: boolean; job?: MassiveJobApiRow; error?: string }
      onEvent(data)
      const st = data.job?.status
      if (data.ok === false || st === 'done' || st === 'failed') {
        es.close()
      }
    } catch {
      onEvent({ ok: false, error: 'Invalid SSE payload' })
      es.close()
    }
  }
  es.onerror = () => {
    onEvent({ ok: false, error: 'SSE connection error' })
    es.close()
  }
  return { close: () => es.close() }
}

export async function fetchMassiveJob(jobId: string): Promise<{
  ok: boolean
  error?: string
  job?: {
    job_id: string
    kind?: string
    status?: string
    result?: unknown
    created_ts?: number
    updated_ts?: number
  }
}> {
  const r = await fetch(opsMassiveJobsUrl(`/${encodeURIComponent(jobId)}`), { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Unknown error' }
  }
  const job = j.job as Record<string, unknown> | undefined
  if (!job) return { ok: true }
  return {
    ok: true,
    job: {
      job_id: String(job.job_id ?? ''),
      kind: typeof job.kind === 'string' ? job.kind : undefined,
      status: typeof job.status === 'string' ? job.status : undefined,
      result: job.result,
      created_ts: typeof job.created_ts === 'number' ? job.created_ts : undefined,
      updated_ts: typeof job.updated_ts === 'number' ? job.updated_ts : undefined,
    },
  }
}

export async function pollMassiveJobUntilDone(
  jobId: string,
  options?: { maxAttempts?: number; intervalMs?: number },
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const maxAttempts = options?.maxAttempts ?? 90
  const intervalMs = options?.intervalMs ?? 1000
  for (let i = 0; i < maxAttempts; i += 1) {
    const res = await fetchMassiveJob(jobId)
    if (!res.ok) {
      return { ok: false, error: res.error ?? 'Job poll failed' }
    }
    const st = res.job?.status
    if (st === 'done') return { ok: true, status: st }
    if (st === 'failed') {
      const result = res.job?.result as { error?: string } | undefined
      return { ok: false, status: st, error: result?.error ?? 'Job failed' }
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, intervalMs)
    })
  }
  return { ok: false, error: 'Job poll timed out' }
}
