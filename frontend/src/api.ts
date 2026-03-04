import type { StatusResponse, OperationsResponse, ControlResponse, IbConfig, RiskSummaryResponse, ExecutionsResponse, BarsResponse, Bar } from './types'

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

/** R-A2: 直接由 API 连 IB 拉取执行记录并写库，无需 daemon。days: 1=当天, 3=最近3天, 7=最近7天 */
export async function postExecutionsFetch(days: 1 | 3 | 7 = 1): Promise<ControlResponse & { count?: number }> {
  const params = new URLSearchParams({ days: String(days) })
  const r = await fetch(`${API}/executions/fetch?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), count: j.count }
}

/** R-A3: 直接由 API 连 IB 拉取 K 线并写库，返回 bars（不经过 daemon） */
export async function postBarsFetch(
  symbol: string,
  period = '1 D',
  duration = '30 D',
): Promise<{ ok: boolean; error?: string; bars?: Bar[]; count?: number }> {
  const params = new URLSearchParams({ symbol, period, duration })
  const r = await fetch(`${API}/bars/fetch?${params}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: j.ok === true,
    error: j.error,
    bars: j.bars ?? [],
    count: j.count ?? 0,
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
  }
): Promise<ControlResponse & Partial<IbConfig>> {
  const body: Record<string, string | number> = { ib_host, ib_port_type }
  if (clientIds) {
    if (clientIds.ib_client_id_daemon != null) body.ib_client_id_daemon = clientIds.ib_client_id_daemon
    if (clientIds.ib_client_id_listener != null) body.ib_client_id_listener = clientIds.ib_client_id_listener
    if (clientIds.ib_client_id_account != null) body.ib_client_id_account = clientIds.ib_client_id_account
    if (clientIds.ib_client_id_markets != null) body.ib_client_id_markets = clientIds.ib_client_id_markets
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
