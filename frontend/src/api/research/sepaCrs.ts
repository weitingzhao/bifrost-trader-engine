import { getResearchApiBaseForBrowser, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
}

export interface SepaCrsRequest {
  symbols: string[]
  as_of_date?: string
  source?: 'massive' | 'ib' | 'tv'
  lookback_days?: number
  min_crs?: number
}

export interface SepaCrsRow {
  symbol: string
  as_of_date?: string
  ret252: number | null
  crs_score: number | null
  insufficient_data: boolean
  pass: boolean
  rows_used: number
}

export interface SepaCrsResponse {
  ok: boolean
  error?: string
  as_of_date?: string
  source?: string
  crs_version?: string
  results: SepaCrsRow[]
  summary?: {
    total: number
    passed: number
    failed: number
    insufficient_data: number
    universe_size: number
  }
  warnings?: Record<string, string>
}

export async function runSepaCrs(request: SepaCrsRequest): Promise<SepaCrsResponse> {
  const url = researchApiUrl('/research/screening/sepa/crs')
  const body = {
    symbols: request.symbols ?? [],
    ...(request.as_of_date ? { as_of_date: request.as_of_date } : {}),
    ...(request.source ? { source: request.source } : {}),
    ...(request.lookback_days != null ? { lookback_days: request.lookback_days } : {}),
    ...(request.min_crs != null ? { min_crs: request.min_crs } : {}),
  }
  const r = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
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
    as_of_date: typeof j.as_of_date === 'string' ? j.as_of_date : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    crs_version: typeof j.crs_version === 'string' ? j.crs_version : undefined,
    results: Array.isArray(j.results) ? j.results : [],
    summary: j.summary && typeof j.summary === 'object'
      ? {
          total: Number(j.summary.total ?? 0),
          passed: Number(j.summary.passed ?? 0),
          failed: Number(j.summary.failed ?? 0),
          insufficient_data: Number(j.summary.insufficient_data ?? 0),
          universe_size: Number(j.summary.universe_size ?? 0),
        }
      : undefined,
    warnings: j.warnings && typeof j.warnings === 'object' ? j.warnings : undefined,
  }
}

