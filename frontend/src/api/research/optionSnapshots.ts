import {
  getMassiveApiBase,
  getResearchApiBaseForBrowser,
  joinServiceBase,
} from '../shared/apiRouting'

function massiveUrl(path: string): string {
  return joinServiceBase(getMassiveApiBase(), path)
}

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
}

/** Per-page Massive REST debug for option-expirations (redacted URLs; full response JSON). */
export interface MassiveOptionExpirationsDebug {
  pages: Array<{
    page_index: number
    request: { method: string; url: string }
    response_status: number
    response: Record<string, unknown>
  }>
  contract_samples: Record<string, unknown>[]
  contract_samples_truncated?: boolean
}

/** R-OD1: Option expirations and strikes (IB and/or Massive REST). Includes last_price from stock_day when available. */
export async function fetchOptionExpirations(
  symbol: string,
  provider: 'auto' | 'ib' | 'massive' = 'auto',
  options?: { debug?: boolean; expiration?: string },
): Promise<{
  symbol: string
  expirations: string[]
  strikes?: number[]
  last_price?: number
  error?: string
  provider?: string
  massive_debug?: MassiveOptionExpirationsDebug
}> {
  const s = (symbol || '').trim()
  if (!s) return { symbol: '', expirations: [], error: 'symbol is required' }
  const dbg = options?.debug ? '&debug=1' : ''
  const exp = options?.expiration ? `&expiration=${encodeURIComponent(options.expiration)}` : ''
  const r = await fetch(
    `${researchApiUrl('/research/option-expirations')}?symbol=${encodeURIComponent(s)}&provider=${encodeURIComponent(provider)}${dbg}${exp}`,
  )
  const j = await r.json().catch(() => ({}))
  const strikes: number[] | undefined = Array.isArray(j.strikes)
    ? (j.strikes.filter((x: unknown) => typeof x === 'number' && Number.isFinite(x)) as number[])
    : undefined
  const last_price =
    j.last_price != null && Number.isFinite(Number(j.last_price)) ? Number(j.last_price) : undefined
  const md = j.massive_debug
  const massive_debug =
    md && typeof md === 'object' && Array.isArray((md as MassiveOptionExpirationsDebug).pages)
      ? (md as MassiveOptionExpirationsDebug)
      : undefined
  return {
    symbol: j.symbol ?? s,
    expirations: Array.isArray(j.expirations) ? j.expirations : [],
    ...(strikes !== undefined ? { strikes } : {}),
    ...(last_price !== undefined ? { last_price } : {}),
    error: j.error,
    provider: typeof j.provider === 'string' ? j.provider : undefined,
    ...(massive_debug ? { massive_debug } : {}),
  }
}

export interface OptionSnapshotRow {
  strike: number
  right: string
  /** Latest snapshot row timestamp from PostgreSQL (ISO 8601) */
  snapshot_ts?: string | null
  /** Display premium: Massive PG uses day_close-derived mark; IB path may use NBBO/last */
  mark?: number | null
  /** IB live path only */
  bid?: number | null
  ask?: number | null
  last?: number | null
  mid?: number | null
  iv?: number | null
  delta?: number | null
  gamma?: number | null
  theta?: number | null
  vega?: number | null
  open_interest?: number | null
  /** Massive `underlying_asset.ticker` when present */
  underlying_ticker?: string | null
  /** Massive chain snapshot `day` bar (delayed tier / no live quote) */
  day_open?: number | null
  day_high?: number | null
  day_low?: number | null
  day_close?: number | null
  day_previous_close?: number | null
  day_change?: number | null
  day_change_percent?: number | null
  day_volume?: number | null
  day_vwap?: number | null
  day_last_updated?: string | null
  /** NY session calendar date for `day_last_updated` (YYYY-MM-DD) */
  day_last_updated_day?: string | null
}

/** OD.3: Option snapshot (bid/ask/last/mid) for symbol + expiration with optional strikes (IB live). */
export async function fetchOptionSnapshot(
  symbol: string,
  expiration: string,
  strikes?: number[],
): Promise<{
  symbol: string
  expiration: string
  underlying_price?: number
  rows: OptionSnapshotRow[]
  error?: string
}> {
  const s = (symbol || '').trim()
  const e = (expiration || '').trim()
  if (!s || !e) {
    return { symbol: s, expiration: e, rows: [], error: 'symbol and expiration are required' }
  }
  const body = { symbol: s, expiration: e, ...(strikes != null ? { strikes } : {}) }
  const r = await fetch(researchApiUrl('/research/option-snapshot'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const rows: OptionSnapshotRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        strike: Number(row.strike),
        right: String(row.right ?? ''),
        bid: row.bid != null && Number.isFinite(Number(row.bid)) ? Number(row.bid) : null,
        ask: row.ask != null && Number.isFinite(Number(row.ask)) ? Number(row.ask) : null,
        last: row.last != null && Number.isFinite(Number(row.last)) ? Number(row.last) : null,
        mid: row.mid != null && Number.isFinite(Number(row.mid)) ? Number(row.mid) : null,
      }))
    : []
  return {
    symbol: j.symbol ?? s,
    expiration: j.expiration ?? e,
    ...(j.underlying_price != null && Number.isFinite(Number(j.underlying_price))
      ? { underlying_price: Number(j.underlying_price) }
      : {}),
    rows,
    error: j.error,
  }
}

export interface OptionSnapshotsPgResult {
  symbol: string
  expiration: string
  underlying_price?: number
  rows: OptionSnapshotRow[]
  error?: string
  warning?: string
}

/** Latest option_snapshots from PostgreSQL (after Massive sync). */
export async function fetchOptionSnapshotsPg(
  symbol: string,
  expiration: string,
  strikesCsv?: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<OptionSnapshotsPgResult> {
  const s = (symbol || '').trim()
  const e = (expiration || '').trim()
  const q = new URLSearchParams({ symbol: s, expiration: e, source })
  if (strikesCsv && strikesCsv.trim()) q.set('strikes', strikesCsv.trim())
  const r = await fetch(`${researchApiUrl('/research/option-snapshots')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  const rows: OptionSnapshotRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        strike: Number(row.strike),
        right: String(row.right ?? ''),
        snapshot_ts: typeof row.snapshot_ts === 'string' ? row.snapshot_ts : null,
        mark: row.mark != null && Number.isFinite(Number(row.mark)) ? Number(row.mark) : null,
        iv: row.iv != null && Number.isFinite(Number(row.iv)) ? Number(row.iv) : null,
        delta: row.delta != null && Number.isFinite(Number(row.delta)) ? Number(row.delta) : null,
        gamma: row.gamma != null && Number.isFinite(Number(row.gamma)) ? Number(row.gamma) : null,
        theta: row.theta != null && Number.isFinite(Number(row.theta)) ? Number(row.theta) : null,
        vega: row.vega != null && Number.isFinite(Number(row.vega)) ? Number(row.vega) : null,
        open_interest:
          row.open_interest != null && Number.isFinite(Number(row.open_interest))
            ? Number(row.open_interest)
            : null,
        underlying_ticker: typeof row.underlying_ticker === 'string' ? row.underlying_ticker : null,
        day_open: row.day_open != null && Number.isFinite(Number(row.day_open)) ? Number(row.day_open) : null,
        day_high: row.day_high != null && Number.isFinite(Number(row.day_high)) ? Number(row.day_high) : null,
        day_low: row.day_low != null && Number.isFinite(Number(row.day_low)) ? Number(row.day_low) : null,
        day_close: row.day_close != null && Number.isFinite(Number(row.day_close)) ? Number(row.day_close) : null,
        day_previous_close:
          row.day_previous_close != null && Number.isFinite(Number(row.day_previous_close))
            ? Number(row.day_previous_close)
            : null,
        day_change:
          row.day_change != null && Number.isFinite(Number(row.day_change)) ? Number(row.day_change) : null,
        day_change_percent:
          row.day_change_percent != null && Number.isFinite(Number(row.day_change_percent))
            ? Number(row.day_change_percent)
            : null,
        day_volume:
          row.day_volume != null && Number.isFinite(Number(row.day_volume)) ? Number(row.day_volume) : null,
        day_vwap: row.day_vwap != null && Number.isFinite(Number(row.day_vwap)) ? Number(row.day_vwap) : null,
        day_last_updated: typeof row.day_last_updated === 'string' ? row.day_last_updated : null,
        day_last_updated_day:
          typeof row.day_last_updated_day === 'string' ? row.day_last_updated_day : null,
      }))
    : []
  return {
    symbol: j.symbol ?? s,
    expiration: j.expiration ?? e,
    ...(j.underlying_price != null && Number.isFinite(Number(j.underlying_price))
      ? { underlying_price: Number(j.underlying_price) }
      : {}),
    rows,
    error: typeof j.error === 'string' ? j.error : undefined,
    warning: typeof j.warning === 'string' ? j.warning : undefined,
  }
}

export interface CorporateActionRow {
  symbol: string
  action_type: string
  ex_date: string | null
  record_date: string | null
  payment_date: string | null
  ratio_from: number | null
  ratio_to: number | null
  amount: number | null
  description: string | null
  source: string | null
}

/** GET /research/option-oi — daily OI rows when table is populated. */
export async function fetchResearchOptionOi(
  symbol: string,
  options?: { limit?: number },
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const s = (symbol || '').trim()
  if (!s) return { rows: [], error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (options?.limit != null) q.set('limit', String(options.limit))
  const r = await fetch(`${researchApiUrl('/research/option-oi')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  const rows = Array.isArray(j.rows) ? j.rows : []
  return { rows, error: typeof j.error === 'string' ? j.error : undefined }
}

/** GET /research/option-trades — 403 when trades disabled by tier/config. */
export async function fetchResearchOptionTrades(
  symbol: string,
  options?: { limit?: number },
): Promise<{
  ok: boolean
  status: number
  trades: Record<string, unknown>[]
  message?: string
  error?: string
}> {
  const s = (symbol || '').trim()
  if (!s) return { ok: false, status: 0, trades: [], error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (options?.limit != null) q.set('limit', String(options.limit))
  const r = await fetch(`${researchApiUrl('/research/option-trades')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  const trades = Array.isArray(j.trades) ? j.trades : []
  return {
    ok: Boolean(j.ok) && r.ok,
    status: r.status,
    trades,
    message: typeof j.message === 'string' ? j.message : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchCorporateActions(
  symbol: string,
  options?: { action_type?: string; limit?: number },
): Promise<{ ok: boolean; rows: CorporateActionRow[]; error?: string }> {
  const q = new URLSearchParams({ symbol: (symbol || '').trim() })
  if (options?.action_type) q.set('action_type', options.action_type)
  if (options?.limit != null) q.set('limit', String(options.limit))
  const r = await fetch(massiveUrl(`/research/massive/corporate-actions?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (!j.ok) return { ok: false, rows: [], error: typeof j.error === 'string' ? j.error : 'Request failed' }
  const rows: CorporateActionRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        symbol: String(row.symbol ?? ''),
        action_type: String(row.action_type ?? ''),
        ex_date: typeof row.ex_date === 'string' ? row.ex_date : null,
        record_date: typeof row.record_date === 'string' ? row.record_date : null,
        payment_date: typeof row.payment_date === 'string' ? row.payment_date : null,
        ratio_from: row.ratio_from != null ? Number(row.ratio_from) : null,
        ratio_to: row.ratio_to != null ? Number(row.ratio_to) : null,
        amount: row.amount != null ? Number(row.amount) : null,
        description: typeof row.description === 'string' ? row.description : null,
        source: typeof row.source === 'string' ? row.source : null,
      }))
    : []
  return { ok: true, rows }
}

// ── P1: Liquidity Summary ──

export interface LiquiditySummaryResponse {
  ok: boolean
  symbol?: string
  expiration?: string
  strike?: number
  right?: string
  source?: string
  spread_pct?: number | null
  spread_percentile?: number | null
  oi?: number | null
  oi_percentile?: number | null
  contracts_compared?: number
  snapshot_ts?: string | null
  error?: string
}

export async function fetchLiquiditySummary(
  symbol: string,
  expiration: string,
  strike: number,
  right: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<LiquiditySummaryResponse> {
  const q = new URLSearchParams({
    symbol: (symbol || '').trim(),
    expiration: (expiration || '').trim(),
    strike: String(strike),
    right: (right || '').trim(),
    source,
  })
  const r = await fetch(`${researchApiUrl('/research/option-contract/liquidity-summary')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    symbol: j.symbol,
    expiration: j.expiration,
    strike: j.strike,
    right: j.right,
    source: j.source,
    spread_pct: j.spread_pct ?? null,
    spread_percentile: j.spread_percentile ?? null,
    oi: j.oi ?? null,
    oi_percentile: j.oi_percentile ?? null,
    contracts_compared: j.contracts_compared,
    snapshot_ts: j.snapshot_ts ?? null,
    error: j.error,
  }
}

// ── P2: Relative Value ──

export interface RelativeValueResponse {
  ok: boolean
  label?: string | null
  iv_zscore?: number | null
  this_iv?: number | null
  avg_iv?: number | null
  std_iv?: number | null
  contracts_compared?: number
  iv_curve?: { strike: number; iv: number }[]
  error?: string
}

export async function fetchRelativeValue(
  symbol: string,
  expiration: string,
  strike: number,
  right: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<RelativeValueResponse> {
  const q = new URLSearchParams({
    symbol: (symbol || '').trim(),
    expiration: (expiration || '').trim(),
    strike: String(strike),
    right: (right || '').trim(),
    source,
  })
  const r = await fetch(`${researchApiUrl('/research/option-contract/relative-value')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    label: j.label ?? null,
    iv_zscore: j.iv_zscore ?? null,
    this_iv: j.this_iv ?? null,
    avg_iv: j.avg_iv ?? null,
    std_iv: j.std_iv ?? null,
    contracts_compared: j.contracts_compared,
    iv_curve: Array.isArray(j.iv_curve) ? j.iv_curve : undefined,
    error: j.error,
  }
}
