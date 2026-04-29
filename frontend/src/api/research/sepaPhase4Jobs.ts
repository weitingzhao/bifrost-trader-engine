import { getResearchApiBase, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBase(), path)
}

export interface SepaPhase4SubmitRequest {
  symbols: string[]
  source?: string
  lookback_days?: number
  volume_threshold?: number
  strict_sma200_rising?: boolean
  min_crs?: number
  max_workers?: number
  max_retries?: number
  rate_limit_rps?: number
  retry_base_sec?: number
  cache_ttl_sec?: number
  use_parallel?: boolean
}

export interface SepaPhase4JobSummary {
  total_symbols: number
  phase1_passed: number
  crs_passed: number
  final_passed: number
  fundamentals_evaluated: number
  cache_hit_redis: number
  cache_hit_postgres: number
  fundamentals_external_calls: number
  retry_count: number
  failed_symbols: number
  duration_sec: number
  version: string
}

export interface SepaPhase4JobStatusResponse {
  ok: boolean
  error?: string
  job_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'
  progress?: { current: number; total: number; stage: string; pct: number }
  summary?: Partial<SepaPhase4JobSummary>
  errors?: string[]
}

export interface SepaPhase4JobRow {
  symbol: string
  technical_pass: boolean
  crs_score: number | null
  crs_pass: boolean
  fundamental_pass: boolean
  final_pass: boolean
  phase1?: unknown
  crs?: unknown
  fundamentals?: unknown
}

export interface SepaPhase4JobResultResponse {
  ok: boolean
  error?: string
  job_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'
  summary?: Partial<SepaPhase4JobSummary>
  rows: SepaPhase4JobRow[]
  total_rows: number
  offset: number
  limit: number
  version?: string
}

export interface SepaPhase4JobListItem {
  job_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'
  created_at?: string
  updated_at?: string
  started_at?: string | null
  finished_at?: string | null
  progress?: { current: number; total: number; stage: string; pct: number }
  summary?: Partial<SepaPhase4JobSummary>
  errors?: string[]
}

export interface SepaPhase4JobsListResponse {
  ok: boolean
  error?: string
  jobs: SepaPhase4JobListItem[]
  limit: number
  offset: number
  filters?: {
    status?: string | null
    created_from?: string | null
    created_to?: string | null
  }
}

export async function submitSepaPhase4Job(request: SepaPhase4SubmitRequest): Promise<{ ok: boolean; job_id?: string; error?: string }> {
  const r = await fetchWithTimeout(
    researchApiUrl('/research/screening/sepa/phase4/jobs'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    60_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    throw new Error(msg)
  }
  return { ok: Boolean(j.ok), job_id: typeof j.job_id === 'string' ? j.job_id : undefined, error: typeof j.error === 'string' ? j.error : undefined }
}

export async function fetchSepaPhase4Job(jobId: string): Promise<SepaPhase4JobStatusResponse> {
  const r = await fetchWithTimeout(researchApiUrl(`/research/screening/sepa/phase4/jobs/${encodeURIComponent(jobId)}`), {}, 30_000)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    throw new Error(msg)
  }
  return {
    ok: Boolean(j.ok),
    error: typeof j.error === 'string' ? j.error : undefined,
    job_id: String(j.job_id || jobId),
    status: j.status || 'failed',
    progress: j.progress,
    summary: j.summary,
    errors: Array.isArray(j.errors) ? j.errors.map(String) : [],
  }
}

export async function fetchSepaPhase4JobResult(jobId: string, offset = 0, limit = 500): Promise<SepaPhase4JobResultResponse> {
  const r = await fetchWithTimeout(
    researchApiUrl(`/research/screening/sepa/phase4/jobs/${encodeURIComponent(jobId)}/result?offset=${offset}&limit=${limit}`),
    {},
    60_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    throw new Error(msg)
  }
  return {
    ok: Boolean(j.ok),
    error: typeof j.error === 'string' ? j.error : undefined,
    job_id: String(j.job_id || jobId),
    status: j.status || 'failed',
    summary: j.summary,
    rows: Array.isArray(j.rows) ? j.rows : [],
    total_rows: Number(j.total_rows ?? 0),
    offset: Number(j.offset ?? 0),
    limit: Number(j.limit ?? 0),
    version: typeof j.version === 'string' ? j.version : undefined,
  }
}

export async function fetchSepaPhase4Jobs(params?: {
  status?: string
  created_from?: string
  created_to?: string
  limit?: number
  offset?: number
}): Promise<SepaPhase4JobsListResponse> {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.created_from) qs.set('created_from', params.created_from)
  if (params?.created_to) qs.set('created_to', params.created_to)
  qs.set('limit', String(params?.limit ?? 50))
  qs.set('offset', String(params?.offset ?? 0))
  const r = await fetchWithTimeout(
    researchApiUrl(`/research/screening/sepa/phase4/jobs?${qs.toString()}`),
    {},
    30_000,
  )
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = typeof j?.detail === 'string' ? j.detail : (j?.error ?? `HTTP ${r.status}`)
    throw new Error(msg)
  }
  return {
    ok: Boolean(j.ok),
    error: typeof j.error === 'string' ? j.error : undefined,
    jobs: Array.isArray(j.jobs) ? j.jobs : [],
    limit: Number(j.limit ?? 50),
    offset: Number(j.offset ?? 0),
    filters: j.filters && typeof j.filters === 'object' ? j.filters : undefined,
  }
}

