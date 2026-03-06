import type { StatusResponse, OperationsResponse, ControlResponse, IbConfig, RiskSummaryResponse, ExecutionsResponse, BarsResponse, Bar, BarStatsResponse, BarsCoverageResponse, WatchlistItem, RealtimeQuote, QuotesResponse } from './types'

const API = '' // same origin; Vite proxy forwards /status, /operations, /control

export async function fetchStatus(): Promise<StatusResponse | null> {
  const r = await fetch(`${API}/status`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** 监控服务健康检查：GET /health，200 表示进程存活；返回 ts 为服务端响应时刻的 Unix 秒 */
export async function fetchHealth(): Promise<{ status: string; service: string; ts: number }> {
  const r = await fetch(`${API}/health`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchOperations(limit = 20): Promise<OperationsResponse> {
  const r = await fetch(`${API}/operations?limit=${limit}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function postSuspend(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/suspend`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postResume(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/resume`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postFlatten(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/flatten`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRetryIb(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/retry_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** 写入 daemon_control release_ib；Daemon 下次心跳时释放 IB 连接并进入 WAITING_IB。 */
export async function postReleaseIb(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/release_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRefreshAccounts(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/refresh_accounts`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRefreshReplay(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/refresh_replay`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** 让守护进程立即按 Watchlist 同步 Real-time ticker 订阅（多退少补，清除残留） */
export async function postRefreshTickerSubscriptions(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/refresh_ticker_subscriptions`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** R-A2: 直接由 API 连 IB 拉取执行记录并写库，无需 daemon。days: 1=当天, 3=最近3天, 7=最近7天 */
export async function postExecutionsFetch(days: 1 | 3 | 7 = 1): Promise<ControlResponse & { count?: number }> {
  const params = new URLSearchParams({ days: String(days) })
  const r = await fetch(`${API}/executions/fetch?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), count: j.count }
}

/** R-A3: 直接由 API 连 IB 拉取 K 线并写库，返回 bars（不经过 daemon）。smart_duration 为 true 时由服务端根据最新 K 线计算 duration。 */
export async function postBarsFetch(
  symbol: string,
  period = '1 D',
  duration = '30 D',
  smartDuration = false,
): Promise<{ ok: boolean; error?: string; bars?: Bar[]; count?: number }> {
  const params = new URLSearchParams({ symbol, period, duration })
  if (smartDuration) params.set('smart_duration', 'true')
  const r = await fetch(`${API}/bars/fetch?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    bars: j.bars ?? [],
    count: j.count ?? 0,
  }
}

/** R-A3 扩展：获取指定标的+周期的最新一根 K 线时间（用于智能拉取）。 */
export async function fetchBarsLatest(symbol: string, period = '1 D'): Promise<{ latest: number | null }> {
  const params = new URLSearchParams({ symbol, period })
  const r = await fetch(`${API}/bars/latest?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A3 扩展：补全历史 K 线（按时间范围从 IB 拉取并写库）。与 servers.bars_backfill / Celery bars worker 同逻辑。 */
export async function postBarsBackfill(
  symbol: string,
  period: string,
  options?: { years?: number; days?: number; override_days?: number; span_hours?: number; queue?: boolean; is_test?: boolean; api_interval_sec?: number },
): Promise<{ ok: boolean; error?: string; count?: number; message?: string; job_id?: string }> {
  const params = new URLSearchParams({ symbol: symbol.trim(), period })
  if (options?.years != null) params.set('years', String(options.years))
  if (options?.days != null) params.set('days', String(options.days))
  if (options?.override_days != null) params.set('override_days', String(options.override_days))
  if (options?.span_hours != null) params.set('span_hours', String(options.span_hours))
  if (options?.queue !== false) params.set('queue', '1')
  if (options?.is_test === true) params.set('is_test', '1')
  if (options?.api_interval_sec != null) params.set('api_interval_sec', String(options.api_interval_sec))
  const r = await fetch(`${API}/bars/backfill?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    count: j.count ?? 0,
    message: j.message,
    job_id: j.job_id,
  }
}

export interface BarsJob {
  job_id: string
  type: string
  symbol: string
  period: string
  status: 'pending' | 'running' | 'done' | 'failed'
  result?: { ok?: boolean; count?: number; message?: string; error?: string }
  created_ts?: number
  updated_ts?: number
}

export async function fetchBarsJob(jobId: string): Promise<{ ok: boolean; job?: BarsJob; error?: string }> {
  const r = await fetch(`${API}/bars/jobs/${encodeURIComponent(jobId)}`)
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, job: j.job, error: j.error }
}

/** List backfill jobs with pagination and optional status filter. */
export async function fetchBarsJobs(
  limit = 20,
  offset = 0,
  status?: string | null,
): Promise<{ jobs: BarsJob[]; total: number; error?: string }> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (status && status !== 'all') params.set('status', status)
  const r = await fetch(`${API}/bars/jobs?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  const j = await r.json().catch(() => ({}))
  return {
    jobs: j.jobs ?? [],
    total: typeof j.total === 'number' ? j.total : 0,
    error: typeof j.error === 'string' ? j.error : undefined,
  }
}

/** Delete one backfill job by id. */
export async function deleteBarsJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/bars/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Delete all backfill jobs, or only those with the given status (pending, running, done, failed). */
export async function deleteAllBarsJobs(status?: string | null): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  const r = await fetch(`${API}/bars/jobs?${params}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    deleted: typeof j.deleted === 'number' ? j.deleted : 0,
    error: j.error,
  }
}

/** R-A3 扩展：Watchlist 列表。 */
export async function fetchWatchlist(): Promise<{ items: WatchlistItem[] }> {
  const r = await fetch(`${API}/watchlist`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A3 扩展：添加/更新 Watchlist 项。 */
export async function postWatchlist(item: {
  contract_key: string
  symbol?: string
  sec_type?: string
  expiry?: string
  strike?: number
  option_right?: string
  display_label?: string
  source?: string
}): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/watchlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** R-A3 扩展：删除 Watchlist 项（传 contract_key 或 id 之一）。 */
export async function deleteWatchlist(by: { contract_key?: string; id?: number }): Promise<{ ok: boolean; error?: string }> {
  const params = new URLSearchParams()
  if (by.contract_key) params.set('contract_key', by.contract_key)
  if (by.id != null) params.set('id', String(by.id))
  const r = await fetch(`${API}/watchlist?${params}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** R-RM*: 从监控 API 获取实时行情（GET /quotes）。symbols 为空则使用服务端关注列表（持仓+watchlist）。 */
export async function fetchQuotes(symbols?: string[]): Promise<QuotesResponse> {
  const params = new URLSearchParams()
  if (symbols?.length) params.set('symbols', symbols.join(','))
  const r = await fetch(`${API}/quotes?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-RM*: SSE 订阅实时行情推送（GET /quotes/stream）。返回取消订阅的函数。服务端无 Redis 时连接会失败，可先 GET /quotes 或 /status 判断 redis_quotes_connected。 */
export function subscribeQuotes(onQuote: (q: RealtimeQuote) => void): () => void {
  const url = `${API || ''}/quotes/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const q = JSON.parse(e.data) as RealtimeQuote
      if (q && typeof q.symbol === 'string' && typeof q.ts === 'number') onQuote(q)
    } catch {
      // ignore parse error (e.g. keepalive comment)
    }
  }
  es.onerror = () => {
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function postStop(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postSetHeartbeatInterval(heartbeat_interval_sec: number): Promise<ControlResponse & { heartbeat_interval_sec?: number }> {
  const r = await fetch(`${API}/control/set_heartbeat_interval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ heartbeat_interval_sec }),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** 保存 IB 与 client_id 设置（POST /config/ib）。不传的 client_id 保持库中原值。 */
export async function postIbConfig(
  ib_host: string,
  ib_port_type: 'tws_live' | 'tws_paper' | 'gateway',
  clientIds?: {
    ib_client_id_daemon?: number
    ib_client_id_listener?: number
    ib_client_id_account?: number
    ib_client_id_markets?: number
    ib_client_id_worker_market?: number
  }
): Promise<ControlResponse & Partial<IbConfig>> {
  const body: Record<string, string | number> = { ib_host, ib_port_type }
  if (clientIds) {
    if (clientIds.ib_client_id_daemon != null) body.ib_client_id_daemon = clientIds.ib_client_id_daemon
    if (clientIds.ib_client_id_listener != null) body.ib_client_id_listener = clientIds.ib_client_id_listener
    if (clientIds.ib_client_id_account != null) body.ib_client_id_account = clientIds.ib_client_id_account
    if (clientIds.ib_client_id_markets != null) body.ib_client_id_markets = clientIds.ib_client_id_markets
    if (clientIds.ib_client_id_worker_market != null) body.ib_client_id_worker_market = clientIds.ib_client_id_worker_market
  }
  const r = await fetch(`${API}/config/ib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postMonitorStop(): Promise<ControlResponse & { monitor_enabled?: boolean }> {
  const r = await fetch(`${API}/control/monitor_stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), monitor_enabled: j.monitor_enabled }
}

/** Release Monitor IB connections (Account + Market client_id). Monitor process keeps running; use Connect to reconnect. */
export async function postMonitorReleaseIb(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/monitor_release_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Request Celery worker to exit (same as Monitor/Daemon Stop). Worker polls Redis and exits within a few seconds. */
export async function postCeleryStop(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/celery_stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Celery console: fetch last N lines from Redis stream (for initial display). Requires Celery broker (Redis). */
export async function fetchCeleryLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${API}/api/celery/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

/** Daemon console: fetch last N lines from Redis stream (for initial display). Requires Redis. */
export async function fetchDaemonLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${API}/api/daemon/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

/** Server console: fetch last N lines from Redis stream (for initial display). Requires Redis. */
export async function fetchServerLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${API}/api/server/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

/** Celery console: clear Redis stream (DELETE). After this, fetchCeleryLogs returns empty until Worker writes new lines. */
export async function clearCeleryLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/celery/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Daemon console: clear Redis stream (DELETE). After this, fetchDaemonLogs returns empty until daemon writes new lines. */
export async function clearDaemonLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/daemon/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Server console: clear Redis stream (DELETE). After this, fetchServerLogs returns empty until server writes new lines. */
export async function clearServerLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/server/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Celery console: trim Redis stream to at most max_lines (keep newest). Use when max lines limit is set or changed. */
export async function trimCeleryLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/celery/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Daemon console: trim Redis stream to at most max_lines (keep newest). Use when max lines limit is set or changed. */
export async function trimDaemonLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/daemon/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Server console: trim Redis stream to at most max_lines (keep newest). Use when max lines limit is set or changed. */
export async function trimServerLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/server/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

/** Celery console: SSE stream of new log lines. Returns unsubscribe function. Call fetchCeleryLogs first for history. */
export function subscribeCeleryLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${API || ''}/api/celery/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

/** Daemon console: SSE stream of new log lines. Returns unsubscribe function. Call fetchDaemonLogs first for history. */
export function subscribeDaemonLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${API || ''}/api/daemon/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

/** Server console: SSE stream of new log lines. Returns unsubscribe function. Call fetchServerLogs first for history. */
export function subscribeServerLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${API || ''}/api/server/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function postMonitorConnect(): Promise<
  ControlResponse & {
    account?: { requested?: boolean; success?: boolean; error?: string | null }
    market?: { requested?: boolean; success?: boolean; error?: string | null }
  }
> {
  const r = await fetch(`${API}/control/monitor_connect`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ...j,
    ok: r.ok && (j.ok !== false),
    error: j.error || (r.ok ? undefined : r.statusText),
    account: j.account,
    market: j.market,
  }
}

export async function fetchRiskSummary(): Promise<RiskSummaryResponse> {
  const r = await fetch(`${API}/risk_summary`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchExecutions(since_ts?: number, until_ts?: number, limit = 200): Promise<ExecutionsResponse> {
  const params = new URLSearchParams()
  if (since_ts != null) params.set('since_ts', String(since_ts))
  if (until_ts != null) params.set('until_ts', String(until_ts))
  params.set('limit', String(limit))
  const r = await fetch(`${API}/executions?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A2 扩展：手动添加一条执行记录（历史补录） */
export async function createExecution(body: Record<string, unknown>): Promise<{ ok: boolean; id?: number; error?: string }> {
  const r = await fetch(`${API}/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as any).ok) && r.ok
  const detail = (j as any).detail
  const detailMsg =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail) && detail[0]?.msg
        ? detail[0].msg
        : undefined
  const statusMsg = `${r.status} ${r.statusText || ''}`.trim()
  const error = (j as any).error || detailMsg || (!r.ok ? statusMsg : undefined)
  return { ok, id: (j as any).id, error }
}

/** R-A2 扩展：按 id 更新一条执行记录（手动修正） */
export async function updateExecution(id: number, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/executions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as any).ok) && r.ok
  const detail = (j as any).detail
  const detailMsg =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail) && detail[0]?.msg
        ? detail[0].msg
        : undefined
  const statusMsg = `${r.status} ${r.statusText || ''}`.trim()
  const error = (j as any).error || detailMsg || (!r.ok ? statusMsg : undefined)
  return { ok, error }
}

/** R-A2 扩展：按 id 删除一条执行记录（逐笔操作） */
export async function deleteExecution(id: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/executions/${id}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  const ok = Boolean((j as any).ok) && r.ok
  const detail = (j as any).detail
  const detailMsg =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail) && detail[0]?.msg
        ? detail[0].msg
        : undefined
  const statusMsg = `${r.status} ${r.statusText || ''}`.trim()
  const error = (j as any).error || detailMsg || (!r.ok ? statusMsg : undefined)
  return { ok, error }
}

export async function fetchBars(symbol?: string, period = '1 D', limit = 100): Promise<BarsResponse> {
  const params = new URLSearchParams()
  if (symbol) params.set('symbol', symbol)
  params.set('period', period)
  params.set('limit', String(limit))
  const r = await fetch(`${API}/bars?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** 获取指定标的在 stock_day / stock_min 中的行数（供市场数据页「分析」） */
export async function fetchBarStats(symbol: string): Promise<BarStatsResponse> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  const r = await fetch(`${API}/bars/stats?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** 获取 Watchlist 股票（或指定 symbols）在 stock_day / stock_min 的覆盖情况；不传 symbols 时使用服务端 Watchlist。 */
export async function fetchBarsCoverage(symbols?: string[]): Promise<BarsCoverageResponse> {
  const params = new URLSearchParams()
  if (symbols && symbols.length > 0) params.set('symbols', symbols.join(','))
  const r = await fetch(`${API}/bars/coverage?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** 获取各 symbol 在 stock_day 中「当日及之前最近一条」日线作为基准（用于 Daily % / Daily $）。
 * 无数据则无该 key。
 * - `is_today=true`: 用 instrument_prices.last 对比 `prev_close`
 * - `is_today=false`: 用 instrument_prices.last 对比 `close`
 */
export async function fetchBarsBenchmark(
  symbols: string[],
  date?: string,
): Promise<{
  benchmarks: Record<string, { bar_time: number; close: number; prev_close?: number | null; is_today?: boolean; is_stale?: boolean }>
}> {
  const list = symbols.filter(s => (s || '').trim()).map(s => s.trim())
  if (list.length === 0) return { benchmarks: {} }
  const params = new URLSearchParams({ symbols: list.join(',') })
  if (date && date.trim()) params.set('date', date.trim().slice(0, 10))
  const r = await fetch(`${API}/bars/benchmark?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Delete stock_day and/or stock_min rows for a symbol. periods: optional list (1 D, 1 min, 5 mins, 1 hour); omit to delete all. */
export async function deleteBarsForSymbol(
  symbol: string,
  periods?: string[],
): Promise<{ ok: boolean; error?: string; deleted_day?: number; deleted_min?: number; message?: string }> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  const url = `${API}/bars/symbol?${params}`
  const init: RequestInit = { method: 'DELETE' }
  if (periods && periods.length > 0) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({ periods })
  }
  const r = await fetch(url, init)
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    deleted_day: j.deleted_day,
    deleted_min: j.deleted_min,
    message: j.message,
  }
}
