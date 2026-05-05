import { getResearchApiBaseForBrowser, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'
import type { SepaConditionResult } from './sepa'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
}

export interface SepaFundamentalsRequest {
  symbols: string[]
  as_of_date?: string
  eps_q2q_threshold?: number
  rev_q2q_threshold?: number
  eps_3y_threshold?: number
  rev_3y_threshold?: number
  throttle_sec?: number
}

export interface SepaFundamentalsRow {
  symbol: string
  fundamental_pass: boolean
  insufficient_data: boolean
  not_comparable: boolean
  conditions: SepaConditionResult[]
  pass_count: number
  fail_count: number
  metrics?: Record<string, number | null>
  issues?: string[]
}

export interface SepaFundamentalsResponse {
  ok: boolean
  error?: string
  as_of_date?: string
  results: SepaFundamentalsRow[]
  summary?: {
    total: number
    passed: number
    failed: number
    insufficient_data: number
  }
  warnings?: Record<string, string>
  rule_version?: string
}

export async function runSepaFundamentals(request: SepaFundamentalsRequest): Promise<SepaFundamentalsResponse> {
  const url = researchApiUrl('/research/screening/sepa/fundamentals')
  const body = {
    symbols: request.symbols ?? [],
    ...(request.as_of_date ? { as_of_date: request.as_of_date } : {}),
    ...(request.eps_q2q_threshold != null ? { eps_q2q_threshold: request.eps_q2q_threshold } : {}),
    ...(request.rev_q2q_threshold != null ? { rev_q2q_threshold: request.rev_q2q_threshold } : {}),
    ...(request.eps_3y_threshold != null ? { eps_3y_threshold: request.eps_3y_threshold } : {}),
    ...(request.rev_3y_threshold != null ? { rev_3y_threshold: request.rev_3y_threshold } : {}),
    ...(request.throttle_sec != null ? { throttle_sec: request.throttle_sec } : {}),
  }
  const r = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    90_000,
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

