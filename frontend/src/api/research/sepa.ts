import { getResearchApiBaseForBrowser, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
}

export interface SepaPhase1Request {
  symbols: string[]
  as_of_date?: string
  volume_threshold?: number
  strict_sma200_rising?: boolean
  source?: string
  lookback_days?: number
}

export interface SepaConditionResult {
  id: string
  pass: boolean
  actual: number | null
  threshold: number | null
  reason: string
}

export interface SepaPhase1SymbolResult {
  symbol: string
  as_of_date?: string
  technical_pass: boolean
  insufficient_data: boolean
  error?: string
  pass_count?: number
  fail_count?: number
  metrics?: Record<string, number | null>
  conditions: SepaConditionResult[]
}

export interface SepaPhase1Response {
  ok: boolean
  error?: string
  as_of_date?: string
  source?: string
  results: SepaPhase1SymbolResult[]
  summary?: {
    total: number
    passed: number
    failed: number
    insufficient_data: number
  }
  warnings?: Record<string, string>
  rule_version?: string
}

export async function runSepaPhase1(request: SepaPhase1Request): Promise<SepaPhase1Response> {
  const url = researchApiUrl('/research/screening/sepa/phase1')
  const body = {
    symbols: request.symbols ?? [],
    ...(request.as_of_date ? { as_of_date: request.as_of_date } : {}),
    ...(request.volume_threshold != null ? { volume_threshold: request.volume_threshold } : {}),
    ...(request.strict_sma200_rising != null ? { strict_sma200_rising: request.strict_sma200_rising } : {}),
    ...(request.source ? { source: request.source } : {}),
    ...(request.lookback_days != null ? { lookback_days: request.lookback_days } : {}),
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
    results: Array.isArray(j.results) ? j.results : [],
    summary: j.summary && typeof j.summary === 'object'
      ? {
          total: Number(j.summary.total ?? 0),
          passed: Number(j.summary.passed ?? 0),
          failed: Number(j.summary.failed ?? 0),
          insufficient_data: Number(j.summary.insufficient_data ?? 0),
        }
      : undefined,
    warnings: j.warnings && typeof j.warnings === 'object' ? j.warnings : undefined,
    rule_version: typeof j.rule_version === 'string' ? j.rule_version : undefined,
  }
}

