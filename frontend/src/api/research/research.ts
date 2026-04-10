import { getMassiveApiBase, getDocsApiBase, getOpsApiBase, getResearchApiBase, joinServiceBase } from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'
import type { JobQueueStatusCounts } from '../ops/bars'
import { opsAuthHeaders, opsControlFailureMessage, type OpsCapabilities } from '../ops/ops'

function massiveUrl(path: string): string {
  return joinServiceBase(getMassiveApiBase(), path)
}

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBase(), path)
}
function docsUrl(path: string): string {
  return joinServiceBase(getDocsApiBase(), path)
}

function opsMassiveJobsUrl(path: string): string {
  if (path.startsWith('?')) {
    return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${path}`)
  }
  const p = path.startsWith('/') ? path : `/${path}`
  return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${p}`)
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
  bid: number | null
  ask: number | null
  last: number | null
  mid: number | null
  iv?: number | null
  delta?: number | null
  gamma?: number | null
  theta?: number | null
  vega?: number | null
  open_interest?: number | null
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

export interface MassiveApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  /** Listening port of the Massive FastAPI process (from YAML `server.massive_port`). */
  port?: number
  /** Resolved absolute path of the loaded config file (startup). */
  config_path?: string | null
}

export async function fetchMassiveApiHealth(options?: { timeoutMs?: number }): Promise<MassiveApiHealthResponse> {
  const url = massiveUrl('/research/massive/health')
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(`Massive API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-massive',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

/** Health from GET /health on the Docs FastAPI process (same payload as /research/docs/health). */
export interface DocsApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  /** Listening port of the Docs FastAPI process (from YAML `server.docs_port`). */
  port?: number
  config_path?: string | null
  /** Upstream URLs used to build merged OpenAPI. */
  main_url: string
  massive_url: string
  research_url: string
}

export async function fetchDocsApiHealth(): Promise<DocsApiHealthResponse> {
  const r = await fetch(docsUrl('/health'))
  if (!r.ok) throw new Error(`Docs API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-docs',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
    main_url: typeof j.main_url === 'string' ? j.main_url : '',
    massive_url: typeof j.massive_url === 'string' ? j.massive_url : '',
    research_url: typeof j.research_url === 'string' ? j.research_url : '',
  }
}

/** Same shape as GET /ops/auth/capabilities (shared ops.auth tokens). */
export async function fetchDocsCapabilities(): Promise<OpsCapabilities> {
  const r = await fetch(docsUrl('/research/docs/auth/capabilities'), { headers: opsAuthHeaders() })
  const text = await r.text()
  try {
    return JSON.parse(text) as OpsCapabilities
  } catch {
    throw new Error(
      `Docs API returned non-JSON response (HTTP ${r.status}${text ? `, body: ${text.slice(0, 120)}` : ''}).`,
    )
  }
}

/** Absolute origin (no trailing slash) or empty string for same-origin as the UI. */
export type ApiOriginBase = string

function joinApiOrigin(origin: ApiOriginBase, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const o = origin.replace(/\/$/, '')
  return o ? `${o}${p}` : p
}

/** GET /health on bifrost-server at the given origin (CORS must allow this UI origin when cross-origin). */
export async function fetchHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<{
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod'
}> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-server',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile,
  }
}

export async function fetchMassiveApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<MassiveApiHealthResponse> {
  const url = joinApiOrigin(origin, '/research/massive/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Massive API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-massive',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export interface ResearchApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  port?: number
  config_path?: string | null
}

export async function fetchResearchApiHealth(options?: { timeoutMs?: number }): Promise<ResearchApiHealthResponse> {
  const url = researchApiUrl('/health')
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(`Research API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-research',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export async function fetchResearchApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<ResearchApiHealthResponse> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Research API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-research',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export async function fetchDocsApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<DocsApiHealthResponse> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Docs API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-docs',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
    main_url: typeof j.main_url === 'string' ? j.main_url : '',
    massive_url: typeof j.massive_url === 'string' ? j.massive_url : '',
    research_url: typeof j.research_url === 'string' ? j.research_url : '',
  }
}

export async function postDocsShutdown(): Promise<{ ok: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch(docsUrl('/research/docs/shutdown'), {
      method: 'POST',
      headers: opsAuthHeaders(),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let data: { ok?: boolean; error?: string } = {}
  try {
    const text = await r.text()
    data = text ? (JSON.parse(text) as { ok?: boolean; error?: string }) : {}
  } catch (e) {
    if (!r.ok) {
      return { ok: false, error: `Request failed (HTTP ${r.status})` }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    return { ok: false, error: opsControlFailureMessage(data, r) }
  }
  return { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : undefined }
}

export async function postMassiveShutdown(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/shutdown'), { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    error: j.error || (r.ok ? undefined : r.statusText || 'Request failed'),
  }
}

export interface MassiveStatusResponse {
  configured: boolean
  tier: string
  delay_notice: string
  trades_enabled: boolean
}

export async function fetchMassiveStatus(): Promise<MassiveStatusResponse> {
  const r = await fetch(massiveUrl('/research/massive/status'))
  const j = await r.json().catch(() => ({}))
  return {
    configured: Boolean(j.configured),
    tier: typeof j.tier === 'string' ? j.tier : 'starter',
    delay_notice: typeof j.delay_notice === 'string' ? j.delay_notice : '',
    trades_enabled: Boolean(j.trades_enabled),
  }
}

/** Per-dimension block from GET /research/massive/daily-checklist */
export interface MassiveDailyDimBlock {
  status?: string
  rows?: number
  last_ts?: string
  trade_date?: string
  last_trade_date?: string | null
  last_sync?: string
  connected?: boolean
  last_msg_age_s?: number | null
}

export type MassiveDailyChecklistDims = {
  'daily-snapshot'?: MassiveDailyDimBlock
  'daily-oi'?: MassiveDailyDimBlock
  'daily-max-pain'?: MassiveDailyDimBlock
  'daily-corporate'?: MassiveDailyDimBlock
  'daily-ws-alive'?: MassiveDailyDimBlock
}

export async function fetchMassiveDailyChecklist(params: {
  symbols: string[]
  tradeDate?: string
}): Promise<{
  ok: boolean
  trade_date?: string
  symbols?: Record<string, MassiveDailyChecklistDims>
  error?: string
}> {
  const syms = [...new Set((params.symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(
    0,
    80,
  )
  if (syms.length === 0) {
    return { ok: false, error: 'symbols is required' }
  }
  const q = new URLSearchParams({ symbols: syms.join(',') })
  const td = (params.tradeDate || '').trim()
  if (td) q.set('trade_date', td)
  const r = await fetch(massiveUrl(`/research/massive/daily-checklist?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  const symMap = j.symbols && typeof j.symbols === 'object' ? (j.symbols as Record<string, MassiveDailyChecklistDims>) : {}
  return {
    ok: true,
    trade_date: typeof j.trade_date === 'string' ? j.trade_date : undefined,
    symbols: symMap,
  }
}

/** Live Max Pain from EOD OI (GET /research/max-pain/compute) — not persisted. */
export interface MaxPainStrikePoint {
  strike: number
  pain: number
  pain_call: number
  pain_put: number
  call_oi: number
  put_oi: number
}

export interface MaxPainComputeResponse {
  ok: boolean
  error?: string
  symbol?: string
  expiry?: string
  trade_date?: string
  max_pain_strike?: number
  min_pain_value?: number
  total_oi?: number
  underlying_close?: number | null
  distance_to_max_pain_pct?: number | null
  pain_by_strike?: MaxPainStrikePoint[]
  recent_corporate_action?: boolean
}

export async function fetchMaxPainCompute(params: {
  symbol: string
  expiry: string
  tradeDate?: string
}): Promise<MaxPainComputeResponse> {
  const sym = (params.symbol || '').trim().toUpperCase()
  const exp = (params.expiry || '').trim()
  if (!sym || !exp) return { ok: false, error: 'symbol and expiry are required' }
  const q = new URLSearchParams({ symbol: sym, expiry: exp })
  const td = (params.tradeDate || '').trim()
  if (td) q.set('trade_date', td)
  const r = await fetch(`${researchApiUrl('/research/max-pain/compute')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  const pts = Array.isArray(j.pain_by_strike) ? j.pain_by_strike : []
  return {
    ok: true,
    symbol: typeof j.symbol === 'string' ? j.symbol : sym,
    expiry: typeof j.expiry === 'string' ? j.expiry : undefined,
    trade_date: typeof j.trade_date === 'string' ? j.trade_date : undefined,
    max_pain_strike: typeof j.max_pain_strike === 'number' ? j.max_pain_strike : undefined,
    min_pain_value: typeof j.min_pain_value === 'number' ? j.min_pain_value : undefined,
    total_oi: typeof j.total_oi === 'number' ? j.total_oi : undefined,
    underlying_close: j.underlying_close != null && Number.isFinite(Number(j.underlying_close)) ? Number(j.underlying_close) : null,
    distance_to_max_pain_pct:
      j.distance_to_max_pain_pct != null && Number.isFinite(Number(j.distance_to_max_pain_pct))
        ? Number(j.distance_to_max_pain_pct)
        : null,
    pain_by_strike: pts.map((p: Record<string, unknown>) => ({
      strike: Number(p.strike),
      pain: Number(p.pain),
      pain_call: Number(p.pain_call ?? 0),
      pain_put: Number(p.pain_put ?? 0),
      call_oi: Number(p.call_oi ?? 0),
      put_oi: Number(p.put_oi ?? 0),
    })),
    recent_corporate_action: Boolean(j.recent_corporate_action),
  }
}

export interface MaxPainHistoryPoint {
  trade_date: string
  max_pain_strike: number
  total_oi: number
  underlying_close?: number | null
}

export async function fetchMaxPainComputeHistory(params: {
  symbol: string
  expiry: string
  lookbackDays?: number
}): Promise<{ ok: boolean; error?: string; expiry?: string; series: MaxPainHistoryPoint[] }> {
  const sym = (params.symbol || '').trim().toUpperCase()
  const exp = (params.expiry || '').trim()
  if (!sym || !exp) return { ok: false, error: 'symbol and expiry are required', series: [] }
  const q = new URLSearchParams({ symbol: sym, expiry: exp })
  if (params.lookbackDays != null && params.lookbackDays > 0) q.set('lookback_days', String(params.lookbackDays))
  const r = await fetch(`${researchApiUrl('/research/max-pain/compute/history')}?${q.toString()}`)
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed', series: [] }
  }
  const raw = Array.isArray(j.series) ? j.series : []
  const series: MaxPainHistoryPoint[] = raw.map((row: Record<string, unknown>) => ({
    trade_date: String(row.trade_date ?? ''),
    max_pain_strike: Number(row.max_pain_strike),
    total_oi: Number(row.total_oi ?? 0),
    underlying_close:
      row.underlying_close != null && Number.isFinite(Number(row.underlying_close))
        ? Number(row.underlying_close)
        : null,
  }))
  return { ok: true, expiry: typeof j.expiry === 'string' ? j.expiry : undefined, series }
}

export async function postMassiveSync(
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; job_id?: string; error?: string; message?: string }> {
  const r = await fetch(massiveUrl('/research/massive/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, payload }),
  })
  const j = await r.json().catch(() => ({}))
  if (r.status === 403) {
    return { ok: false, message: typeof j.message === 'string' ? j.message : 'Forbidden' }
  }
  return {
    ok: Boolean(j.ok),
    job_id: typeof j.job_id === 'string' ? j.job_id : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
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

export async function fetchMassiveJobsList(options?: {
  limit?: number
  offset?: number
  status?: string
  kind?: string
  /** Broker queue slice (massive, massive_high, massive_stocks, massive_stocks_high). */
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
        bid: row.bid != null && Number.isFinite(Number(row.bid)) ? Number(row.bid) : null,
        ask: row.ask != null && Number.isFinite(Number(row.ask)) ? Number(row.ask) : null,
        last: row.last != null && Number.isFinite(Number(row.last)) ? Number(row.last) : null,
        mid: row.mid != null && Number.isFinite(Number(row.mid)) ? Number(row.mid) : null,
        iv: row.iv != null && Number.isFinite(Number(row.iv)) ? Number(row.iv) : null,
        delta: row.delta != null && Number.isFinite(Number(row.delta)) ? Number(row.delta) : null,
        gamma: row.gamma != null && Number.isFinite(Number(row.gamma)) ? Number(row.gamma) : null,
        theta: row.theta != null && Number.isFinite(Number(row.theta)) ? Number(row.theta) : null,
        vega: row.vega != null && Number.isFinite(Number(row.vega)) ? Number(row.vega) : null,
        open_interest:
          row.open_interest != null && Number.isFinite(Number(row.open_interest))
            ? Number(row.open_interest)
            : null,
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

export interface GreeksCoverageResponse {
  ok: boolean
  symbol?: string
  expiration?: string
  source?: string
  total?: number
  coverage?: {
    with_iv?: number
    iv_pct?: number
    with_delta?: number
    with_gamma?: number
    with_theta?: number
    with_vega?: number
    with_full_greeks?: number
    full_greeks_pct?: number
    with_oi?: number
  }
  freshness?: {
    oldest_ts?: string | null
    newest_ts?: string | null
    stale_rows?: number
  }
  error?: string
}

export async function fetchGreeksCoverage(
  symbol: string,
  expiration?: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<GreeksCoverageResponse> {
  const s = (symbol || '').trim()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s, source })
  if (expiration?.trim()) q.set('expiration', expiration.trim())
  const r = await fetch(massiveUrl(`/research/massive/greeks-coverage?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    symbol: typeof j.symbol === 'string' ? j.symbol : undefined,
    expiration: typeof j.expiration === 'string' ? j.expiration : undefined,
    source: typeof j.source === 'string' ? j.source : undefined,
    total: typeof j.total === 'number' ? j.total : undefined,
    coverage: typeof j.coverage === 'object' && j.coverage != null ? j.coverage : undefined,
    freshness: typeof j.freshness === 'object' && j.freshness != null ? j.freshness : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export interface ContractsCoverageResponse {
  ok: boolean
  symbol?: string
  expiration?: string
  total?: number
  coverage?: {
    with_massive_ticker?: number
    ticker_pct?: number
    with_complete_identity?: number
    identity_pct?: number
    mapping_mismatch?: number
    distinct_expirations?: number
    distinct_strikes?: number
  }
  freshness?: {
    oldest_ts?: string | null
    newest_ts?: string | null
    stale_rows?: number
  }
  error?: string
}

export async function fetchContractsCoverage(
  symbol: string,
  expiration?: string,
): Promise<ContractsCoverageResponse> {
  const s = (symbol || '').trim()
  if (!s) return { ok: false, error: 'symbol is required' }
  const q = new URLSearchParams({ symbol: s })
  if (expiration?.trim()) q.set('expiration', expiration.trim())
  const r = await fetch(massiveUrl(`/research/massive/contracts-coverage?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    symbol: typeof j.symbol === 'string' ? j.symbol : undefined,
    expiration: typeof j.expiration === 'string' ? j.expiration : undefined,
    total: typeof j.total === 'number' ? j.total : undefined,
    coverage: typeof j.coverage === 'object' && j.coverage != null ? j.coverage : undefined,
    freshness: typeof j.freshness === 'object' && j.freshness != null ? j.freshness : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchMassiveMarketConditions(opts?: {
  asset_class?: string
  data_type?: string
  limit?: number
}): Promise<{ ok: boolean; results: Record<string, unknown>[]; count?: number; error?: string }> {
  const q = new URLSearchParams()
  if (opts?.asset_class) q.set('asset_class', opts.asset_class)
  if (opts?.data_type) q.set('data_type', opts.data_type)
  if (opts?.limit) q.set('limit', String(opts.limit))
  const r = await fetch(massiveUrl(`/research/massive/market-ops/conditions?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return { ok: Boolean(j.ok), results: Array.isArray(j.results) ? j.results : [], count: j.count, error: j.error }
}

export async function fetchMassiveMarketExchanges(opts?: {
  asset_class?: string
  locale?: string
}): Promise<{ ok: boolean; results: Record<string, unknown>[]; count?: number; error?: string }> {
  const q = new URLSearchParams()
  if (opts?.asset_class) q.set('asset_class', opts.asset_class)
  if (opts?.locale) q.set('locale', opts.locale)
  const r = await fetch(massiveUrl(`/research/massive/market-ops/exchanges?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return { ok: Boolean(j.ok), results: Array.isArray(j.results) ? j.results : [], count: j.count, error: j.error }
}

export interface MassiveMarketHolidaysResponse {
  ok: boolean
  massive_holidays: Record<string, unknown>[]
  massive_count?: number
  local_holidays: Record<string, unknown>[]
  local_count?: number
  comparison?: {
    in_massive_only: string[]
    in_local_only: string[]
    in_both: string[]
  }
  error?: string
}

export async function fetchMassiveMarketHolidays(): Promise<MassiveMarketHolidaysResponse> {
  const r = await fetch(massiveUrl('/research/massive/market-ops/holidays'))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    massive_holidays: Array.isArray(j.massive_holidays) ? j.massive_holidays : [],
    massive_count: j.massive_count,
    local_holidays: Array.isArray(j.local_holidays) ? j.local_holidays : [],
    local_count: j.local_count,
    comparison: j.comparison,
    error: j.error,
  }
}

export async function fetchMassiveMarketStatus(): Promise<{ ok: boolean; status?: Record<string, unknown>; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/market-ops/status'))
  const j = await r.json().catch(() => ({}))
  return { ok: Boolean(j.ok), status: j.status, error: j.error }
}

export type MassiveTickerProxyResponse = {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

/** Massive FastAPI returns { ok, error }; nginx/connection failures may omit ok or return FastAPI { detail }. */
function parseMassiveTickerProxyResponse(
  j: Record<string, unknown>,
  r: Response,
): Pick<MassiveTickerProxyResponse, 'ok' | 'error'> {
  if (typeof j.error === 'string' && j.error.trim()) {
    return { ok: false, error: j.error }
  }
  if (j.error != null) {
    return {
      ok: false,
      error: typeof j.error === 'object' ? JSON.stringify(j.error) : String(j.error),
    }
  }
  const detail = j.detail
  if (typeof detail === 'string' && detail.trim()) {
    return { ok: false, error: detail }
  }
  if (Array.isArray(detail)) {
    const parts = detail.map((x: unknown) =>
      x && typeof x === 'object' && 'msg' in x ? String((x as { msg: unknown }).msg) : JSON.stringify(x),
    )
    return { ok: false, error: parts.join('; ') }
  }
  if (detail != null && typeof detail === 'object') {
    return { ok: false, error: JSON.stringify(detail) }
  }
  if (!r.ok) {
    if (r.status === 502 || r.status === 503 || r.status === 504) {
      return {
        ok: false,
        error: `Massive API unreachable (HTTP ${r.status}). Start the Massive server (e.g. python scripts/run_server_massive.py) on server.massive_port from your config.`,
      }
    }
    return { ok: false, error: `HTTP ${r.status}` }
  }
  if (j.ok === true) {
    return { ok: true, error: undefined }
  }
  if (j.ok === false) {
    return { ok: false, error: 'Request failed' }
  }
  return { ok: false, error: 'Empty or unrecognized response from Massive API' }
}

/** GET /v3/reference/tickers (via Massive server proxy). */
export async function fetchMassiveReferenceTickers(opts?: {
  ticker?: string
  type?: string
  market?: string
  exchange?: string
  search?: string
  active?: boolean
  date?: string
  limit?: number
  sort?: string
  order?: string
  cursor?: string
}): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.ticker) q.set('ticker', opts.ticker)
  if (opts?.type) q.set('type', opts.type)
  if (opts?.market) q.set('market', opts.market)
  if (opts?.exchange) q.set('exchange', opts.exchange)
  if (opts?.search) q.set('search', opts.search)
  if (opts?.active !== undefined) q.set('active', String(opts.active))
  if (opts?.date) q.set('date', opts.date)
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  if (opts?.sort) q.set('sort', opts.sort)
  if (opts?.order) q.set('order', opts.order)
  if (opts?.cursor) q.set('cursor', opts.cursor)
  const r = await fetch(massiveUrl(`/research/massive/tickers?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** GET /v3/reference/tickers/{ticker} (proxy). */
export async function fetchMassiveTickerDetail(
  ticker: string,
  opts?: { date?: string },
): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.date) q.set('date', opts.date)
  const qs = q.toString()
  const path = `/research/massive/tickers/${encodeURIComponent(ticker)}${qs ? `?${qs}` : ''}`
  const r = await fetch(massiveUrl(path))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** GET /v3/reference/tickers/types (proxy). */
export async function fetchMassiveTickerTypes(opts?: {
  asset_class?: string
  locale?: string
}): Promise<MassiveTickerProxyResponse> {
  const q = new URLSearchParams()
  if (opts?.asset_class) q.set('asset_class', opts.asset_class)
  if (opts?.locale) q.set('locale', opts.locale)
  const r = await fetch(massiveUrl(`/research/massive/tickers/types?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** GET /v1/related-companies/{ticker} (proxy). */
export async function fetchMassiveRelatedCompanies(ticker: string): Promise<MassiveTickerProxyResponse> {
  const r = await fetch(massiveUrl(`/research/massive/related-companies/${encodeURIComponent(ticker)}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseMassiveTickerProxyResponse(j, r)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  return {
    ok: true,
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** PostgreSQL-backed ticker reference: search autocomplete. */
export interface TickerReferenceSearchRow {
  tickers_id: number
  ticker: string
  symbol: string
  name: string | null
  exchange: string | null
  primary_exchange: string | null
  instrument_type: string | null
  active: boolean | null
}

/** @deprecated use TickerReferenceSearchRow */
export type StockReferenceSearchRow = TickerReferenceSearchRow

export async function fetchTickerReferenceSearch(opts: {
  q: string
  limit?: number
}): Promise<{
  ok: boolean
  results?: TickerReferenceSearchRow[]
  cached?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  q.set('q', opts.q)
  if (opts.limit != null) q.set('limit', String(opts.limit))
  const r = await fetch(massiveUrl(`/research/massive/reference/tickers/search?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    cached: Boolean(j.cached),
    results: (j.results as TickerReferenceSearchRow[]) ?? [],
  }
}

/** @deprecated use fetchTickerReferenceSearch */
export const fetchStockReferenceSearch = fetchTickerReferenceSearch

export async function fetchTickerReferenceDetail(symbol: string): Promise<{
  ok: boolean
  ticker?: Record<string, unknown>
  cached?: boolean
  error?: string
}> {
  const r = await fetch(
    massiveUrl(`/research/massive/reference/tickers/${encodeURIComponent(symbol.trim())}`),
  )
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    cached: Boolean(j.cached),
    ticker: typeof j.ticker === 'object' && j.ticker != null ? (j.ticker as Record<string, unknown>) : undefined,
  }
}

/** @deprecated use fetchTickerReferenceDetail */
export async function fetchStockReferenceDetail(symbol: string): Promise<{
  ok: boolean
  stock?: Record<string, unknown>
  cached?: boolean
  error?: string
}> {
  const r = await fetchTickerReferenceDetail(symbol)
  return { ...r, stock: r.ticker }
}

export async function fetchTickerReferenceRelated(symbol: string): Promise<{
  ok: boolean
  data?: Record<string, unknown>
  cached?: boolean
  error?: string
}> {
  const r = await fetch(
    massiveUrl(`/research/massive/reference/tickers/${encodeURIComponent(symbol.trim())}/related`),
  )
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    cached: Boolean(j.cached),
    data: typeof j.data === 'object' && j.data != null ? (j.data as Record<string, unknown>) : undefined,
  }
}

/** @deprecated use fetchTickerReferenceRelated */
export const fetchStockReferenceRelated = fetchTickerReferenceRelated

/** Instrument types from ``ticker_instrument_types`` (synced via jobs). */
export async function fetchTickerReferenceInstrumentTypes(opts?: {
  asset_class?: string
  locale?: string
}): Promise<{
  ok: boolean
  results?: Record<string, unknown>[]
  cached?: boolean
  error?: string
}> {
  const q = new URLSearchParams()
  q.set('asset_class', opts?.asset_class ?? '*')
  q.set('locale', opts?.locale ?? '*')
  const r = await fetch(massiveUrl(`/research/massive/instrument-types?${q.toString()}`))
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  const rows = j.results
  return {
    ok: true,
    cached: Boolean(j.cached),
    results: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
  }
}

/** @deprecated use fetchTickerReferenceInstrumentTypes */
export const fetchStockReferenceInstrumentTypes = fetchTickerReferenceInstrumentTypes

export type TickerReferenceJobKind =
  | 'ticker_reference_universe'
  | 'ticker_reference_overview'
  | 'ticker_reference_related'
  | 'ticker_reference_instrument_types'
  | 'stock_reference_universe'
  | 'stock_reference_overview'
  | 'stock_reference_related'
  | 'stock_reference_instrument_types'

/** @deprecated use TickerReferenceJobKind */
export type StockReferenceJobKind = TickerReferenceJobKind

export async function postTickerReferenceJob(body: {
  kind: TickerReferenceJobKind
  payload?: Record<string, unknown>
  priority?: string
}): Promise<{ ok: boolean; job_id?: string; deduplicated?: boolean; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/jobs/ticker-reference'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!j.ok) {
    return { ok: false, error: String(j.error ?? r.statusText) }
  }
  return {
    ok: true,
    job_id: j.job_id != null ? String(j.job_id) : undefined,
    deduplicated: Boolean(j.deduplicated),
  }
}

/** @deprecated use postTickerReferenceJob */
export const postStockReferenceJob = postTickerReferenceJob

export interface TechnicalIndicatorParams {
  ticker: string
  indicator: 'sma' | 'ema' | 'rsi' | 'macd'
  timespan?: string
  window?: number
  series_type?: string
  adjusted?: boolean
  order?: string
  limit?: number
  short_window?: number
  long_window?: number
  signal_window?: number
}

export interface TechnicalIndicatorResponse {
  ok: boolean
  indicator?: string
  ticker?: string
  count?: number
  results?: {
    values?: Record<string, unknown>[]
    underlying?: Record<string, unknown>
    [key: string]: unknown
  }
  error?: string
}

export async function fetchTechnicalIndicator(
  params: TechnicalIndicatorParams,
): Promise<TechnicalIndicatorResponse> {
  const { ticker, indicator, ...rest } = params
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  const r = await fetch(
    massiveUrl(`/research/massive/technical-indicators/${indicator}/${encodeURIComponent(ticker)}?${q.toString()}`),
  )
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    indicator: j.indicator,
    ticker: j.ticker,
    count: j.count,
    results: j.results,
    error: j.error,
  }
}

// ── Trades & Quotes (read-only REST) ──

export async function fetchMassiveLastTrade(
  optionsTicker: string,
): Promise<{ ok: boolean; results?: Record<string, unknown>; error?: string }> {
  const ot = (optionsTicker || '').trim()
  if (!ot) return { ok: false, error: 'options_ticker is required' }
  const r = await fetch(massiveUrl(`/research/massive/trades-quotes/last-trade/${encodeURIComponent(ot)}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    results: j.results,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchMassiveHistQuotes(
  optionsTicker: string,
  options?: {
    timestamp_gte?: string
    timestamp_lte?: string
    limit?: number
    sort?: string
  },
): Promise<{ ok: boolean; results?: Record<string, unknown>[]; count?: number; error?: string }> {
  const ot = (optionsTicker || '').trim()
  if (!ot) return { ok: false, error: 'options_ticker is required' }
  const q = new URLSearchParams()
  if (options?.timestamp_gte) q.set('timestamp_gte', options.timestamp_gte)
  if (options?.timestamp_lte) q.set('timestamp_lte', options.timestamp_lte)
  if (options?.limit) q.set('limit', String(options.limit))
  if (options?.sort) q.set('order', options.sort)
  const r = await fetch(massiveUrl(`/research/massive/trades-quotes/quotes/${encodeURIComponent(ot)}?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  return {
    ok: Boolean(j.ok),
    results: Array.isArray(j.results) ? j.results : undefined,
    count: typeof j.count === 'number' ? j.count : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

export async function fetchMassiveHistTrades(
  optionsTicker: string,
  options?: {
    timestamp_gte?: string
    timestamp_lte?: string
    limit?: number
    sort?: string
  },
): Promise<{ ok: boolean; results?: Record<string, unknown>[]; count?: number; error?: string }> {
  const ot = (optionsTicker || '').trim()
  if (!ot) return { ok: false, error: 'options_ticker is required' }
  const q = new URLSearchParams()
  if (options?.timestamp_gte) q.set('timestamp_gte', options.timestamp_gte)
  if (options?.timestamp_lte) q.set('timestamp_lte', options.timestamp_lte)
  if (options?.limit) q.set('limit', String(options.limit))
  if (options?.sort) q.set('order', options.sort)
  const r = await fetch(massiveUrl(`/research/massive/trades-quotes/trades/${encodeURIComponent(ot)}?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (r.status === 403) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Developer tier required' }
  }
  return {
    ok: Boolean(j.ok),
    results: Array.isArray(j.results) ? j.results : undefined,
    count: typeof j.count === 'number' ? j.count : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
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

export interface IvTermStructurePoint {
  expiration: string
  dte_days: number
  atm_iv: number | null
  iv_call?: number | null
  iv_put?: number | null
  strike?: number
}

export interface IvTermStructureResponse {
  ok: boolean
  symbol: string
  underlying_price?: number
  points: IvTermStructurePoint[]
  error?: string
}

export async function fetchIvTermStructure(
  symbol: string,
  expirations: string[],
  source: string = 'massive',
): Promise<IvTermStructureResponse> {
  const params = new URLSearchParams({
    symbol,
    expirations: expirations.join(','),
    source,
  })
  const r = await fetch(`${researchApiUrl('/research/iv-term-structure')}?${params}`)
  const j = await r.json().catch(() => ({}))
  const pts: IvTermStructurePoint[] = Array.isArray(j.points)
    ? j.points.map((p: Record<string, unknown>) => ({
        expiration: String(p.expiration ?? ''),
        dte_days: Number(p.dte_days ?? 0),
        atm_iv: p.atm_iv != null ? Number(p.atm_iv) : null,
        iv_call: p.iv_call != null ? Number(p.iv_call) : null,
        iv_put: p.iv_put != null ? Number(p.iv_put) : null,
        strike: p.strike != null ? Number(p.strike) : undefined,
      }))
    : []
  const errMsg = (() => {
    if (j.error != null && String(j.error).trim() !== '') return String(j.error)
    const d = j.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg)
    if (!r.ok) return `HTTP ${r.status}`
    return undefined
  })()
  return {
    ok: Boolean(j.ok) && r.ok,
    symbol: j.symbol ?? symbol,
    underlying_price: j.underlying_price != null ? Number(j.underlying_price) : undefined,
    points: pts,
    error: errMsg,
  }
}
