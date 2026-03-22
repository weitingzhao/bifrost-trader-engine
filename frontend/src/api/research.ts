import { API } from './constants'

/** R-OD1: Option expirations and strikes (IB and/or Massive REST). Includes last_price from stock_day when available. */
export async function fetchOptionExpirations(
  symbol: string,
  provider: 'auto' | 'ib' | 'massive' = 'auto',
): Promise<{
  symbol: string
  expirations: string[]
  strikes?: number[]
  last_price?: number
  error?: string
  provider?: string
}> {
  const s = (symbol || '').trim()
  if (!s) return { symbol: '', expirations: [], error: 'symbol is required' }
  const r = await fetch(
    `${API}/research/option-expirations?symbol=${encodeURIComponent(s)}&provider=${encodeURIComponent(provider)}`,
  )
  const j = await r.json().catch(() => ({}))
  const strikes: number[] | undefined = Array.isArray(j.strikes)
    ? (j.strikes.filter((x: unknown) => typeof x === 'number' && Number.isFinite(x)) as number[])
    : undefined
  const last_price =
    j.last_price != null && Number.isFinite(Number(j.last_price)) ? Number(j.last_price) : undefined
  return {
    symbol: j.symbol ?? s,
    expirations: Array.isArray(j.expirations) ? j.expirations : [],
    ...(strikes !== undefined ? { strikes } : {}),
    ...(last_price !== undefined ? { last_price } : {}),
    error: j.error,
    provider: typeof j.provider === 'string' ? j.provider : undefined,
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
  const r = await fetch(`${API}/research/option-snapshot`, {
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

export interface MassiveStatusResponse {
  configured: boolean
  tier: string
  delay_notice: string
  trades_enabled: boolean
}

export async function fetchMassiveStatus(): Promise<MassiveStatusResponse> {
  const r = await fetch(`${API}/research/massive/status`)
  const j = await r.json().catch(() => ({}))
  return {
    configured: Boolean(j.configured),
    tier: typeof j.tier === 'string' ? j.tier : 'starter',
    delay_notice: typeof j.delay_notice === 'string' ? j.delay_notice : '',
    trades_enabled: Boolean(j.trades_enabled),
  }
}

export async function postMassiveSync(
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; job_id?: string; error?: string; message?: string }> {
  const r = await fetch(`${API}/research/massive/sync`, {
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

export interface MassiveJobApiRow {
  job_id: string
  type?: string
  kind?: string
  status?: string
  result?: unknown
  created_ts?: number
  updated_ts?: number
}

export async function fetchMassiveJobsList(options?: {
  limit?: number
  offset?: number
  status?: string
  kind?: string
}): Promise<{ ok: boolean; jobs: MassiveJobApiRow[]; error?: string }> {
  const q = new URLSearchParams()
  if (options?.limit != null) q.set('limit', String(options.limit))
  if (options?.offset != null) q.set('offset', String(options.offset))
  if (options?.status?.trim()) q.set('status', options.status.trim())
  if (options?.kind?.trim()) q.set('kind', options.kind.trim())
  const r = await fetch(`${API}/research/massive/jobs?${q.toString()}`)
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

/** SSE until job reaches done/failed or stream errors. */
export function subscribeMassiveJobEvents(
  jobId: string,
  onEvent: (data: { ok: boolean; job?: MassiveJobApiRow; error?: string }) => void,
  options?: { timeoutSec?: number },
): { close: () => void } {
  const qs = new URLSearchParams()
  if (options?.timeoutSec != null) qs.set('timeout_sec', String(options.timeoutSec))
  const url = `${API}/research/massive/jobs/${encodeURIComponent(jobId)}/events?${qs.toString()}`
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
  const r = await fetch(`${API}/research/massive/jobs/${encodeURIComponent(jobId)}`)
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

/** Latest option_snapshots from PostgreSQL (after Massive sync). */
export async function fetchOptionSnapshotsPg(
  symbol: string,
  expiration: string,
  strikesCsv?: string,
  source: 'massive' | 'ib' = 'massive',
): Promise<{
  symbol: string
  expiration: string
  underlying_price?: number
  rows: OptionSnapshotRow[]
  error?: string
}> {
  const s = (symbol || '').trim()
  const e = (expiration || '').trim()
  const q = new URLSearchParams({ symbol: s, expiration: e, source })
  if (strikesCsv && strikesCsv.trim()) q.set('strikes', strikesCsv.trim())
  const r = await fetch(`${API}/research/option-snapshots?${q.toString()}`)
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
    error: j.error,
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
  const r = await fetch(`${API}/research/option-oi?${q.toString()}`)
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
  const r = await fetch(`${API}/research/option-trades?${q.toString()}`)
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
  const r = await fetch(`${API}/research/massive/corporate-actions?${q.toString()}`)
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
