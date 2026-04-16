import { getResearchApiBase, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBase(), path)
}

export interface ScreenerFilters {
  structure_type: string
  symbols: string[]
  dte_min: number | null
  dte_max: number | null
  max_prob_itm: number | null
  min_annualized_return: number | null
  max_spread_pct: number | null
  include_earnings_span: boolean
  min_premium: number | null
  source: string
}

export interface ScreenerContractRow {
  symbol: string
  spot: number
  expiration: string
  strike: number
  right: string
  dte: number
  score: number
  rating: 'A' | 'B' | 'C' | 'D'
  risk: 'low' | 'medium' | 'high'
  iv: number | null
  premium: number
  prob_itm: number
  safety_margin: number
  annualized: number | null
  apr_pct: number | null
  margin: number
  bid: number | null
  ask: number | null
  mid: number
  spread_pct: number
  open_interest: number | null
  delta: number | null
  iv_percentile: number | null
  long_strike: number | null
}

export interface ScreenerSymbolGroup {
  symbol: string
  spot: number
  best_score: number
  avg_iv: number | null
  contract_count: number
  contracts: ScreenerContractRow[]
}

export interface ScreenerResponse {
  ok: boolean
  error?: string
  structure_type: string
  groups: ScreenerSymbolGroup[]
  total_contracts: number
  symbols_scanned: string[]
  symbols_failed: string[]
  warnings: Record<string, string>
  scan_ts: string
}

export async function runScreener(filters: ScreenerFilters): Promise<ScreenerResponse> {
  const url = researchApiUrl('/research/screener')
  const r = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters),
    },
    60_000,
  )
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error(
      (j as { detail?: string }).detail ??
        (j as { error?: string }).error ??
        r.statusText,
    )
  }
  return r.json() as Promise<ScreenerResponse>
}
