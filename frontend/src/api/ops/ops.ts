/**
 * Ops control plane API — Celery worker status, commands, audit.
 *
 * Base URL resolved via `getOpsApiBase()` (same routing pattern as massive/docs).
 * All responses follow { ok, ...payload } convention.
 */

import { getOpsApiBase, joinServiceBase } from '../shared/constants'

function opsBase(): string {
  return getOpsApiBase()
}

const OPS_TOKEN_KEY = 'bifrost_ops_token'

export function getOpsToken(): string {
  return sessionStorage.getItem(OPS_TOKEN_KEY) ?? ''
}

export function setOpsToken(token: string): void {
  if (token) {
    sessionStorage.setItem(OPS_TOKEN_KEY, token)
  } else {
    sessionStorage.removeItem(OPS_TOKEN_KEY)
  }
}

/** Bearer token for Ops API (same as other Dashboard / control-plane calls). */
export function opsAuthHeaders(): Record<string, string> {
  const token = getOpsToken()
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

function authHeaders(): Record<string, string> {
  return opsAuthHeaders()
}

function jsonAuthHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', ...authHeaders() }
}

async function parseJsonResponse<T>(r: Response): Promise<T> {
  const text = await r.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim()
    throw new Error(
      `Ops API returned non-JSON response (HTTP ${r.status}${snippet ? `, body: ${snippet}` : ''}).`,
    )
  }
}

/** FastAPI may use `detail` (string or validation array); our routers use `error`. */
export function opsControlFailureMessage(data: unknown, r: Response): string {
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (typeof o.error === 'string' && o.error.trim()) return o.error.trim()
    if (typeof o.detail === 'string' && o.detail.trim()) return o.detail.trim()
    if (Array.isArray(o.detail)) {
      const parts = o.detail
        .map(item => {
          if (item && typeof item === 'object' && 'msg' in item) {
            return String((item as { msg?: string }).msg ?? '').trim()
          }
          return ''
        })
        .filter(Boolean)
      if (parts.length) return parts.join('; ')
    }
  }
  if (!r.ok) {
    return `Request failed (HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''})`
  }
  return 'Control request failed'
}

// ── Auth / capabilities ──────────────────────────────────────────────────────

export interface OpsCapabilities {
  ok: boolean
  identity: { name: string; role: string; authenticated: boolean }
  capabilities: { can_view: boolean; can_operate: boolean; can_admin: boolean }
  auth_required: boolean
}

export async function fetchOpsCapabilities(): Promise<OpsCapabilities> {
  const r = await fetch(`${opsBase()}/ops/auth/capabilities`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

/** Terminate the Ops FastAPI process (same idea as POST /research/massive/shutdown). Requires operator role. */
export async function postOpsShutdown(): Promise<{ ok: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch(`${opsBase()}/ops/shutdown`, {
      method: 'POST',
      headers: authHeaders(),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let data: { ok?: boolean; error?: string } = {}
  try {
    data = await parseJsonResponse(r)
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

export type ApiOriginBase = '' | string

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkerStatus =
  | 'running_healthy'
  | 'running_degraded'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'unknown'

export interface WorkerSummary {
  worker_id: string
  status: WorkerStatus
  queues: string[]
  concurrency: number
  active_tasks: number
  reserved_tasks: number
  last_heartbeat: number | null
  /** dev|prod from worker BIFROST_CONFIG (Redis presence); not the Ops API host. */
  worker_config_profile?: string | null
}

export interface WorkerDetail extends WorkerSummary {
  pool_type: string | null
  prefetch_count: number | null
  active_task_list: Record<string, unknown>[]
  reserved_task_list: Record<string, unknown>[]
  stats: Record<string, unknown>
}

export interface BrokerStatus {
  connected: boolean
  url_masked: string
  used_memory_human?: string
  connected_clients?: number
  queues?: Record<string, number>
}

export interface AuditEntry {
  timestamp: number
  operator: string
  source_ip: string | null
  action: string
  target: string
  command_id: string | null
  outcome: string
  detail: string | null
}

// ── Workers ──────────────────────────────────────────────────────────────────

/** `forceRefresh` re-scans Redis presence keys on the server only; does not run Celery inspect. */
export async function fetchOpsWorkers(opts?: { forceRefresh?: boolean }): Promise<{
  ok: boolean
  workers: WorkerSummary[]
  broker: BrokerStatus
  count: number
  error?: string
}> {
  const q = opts?.forceRefresh ? '?force_refresh=true' : ''
  const r = await fetch(`${opsBase()}/ops/workers${q}`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

export async function fetchOpsWorkerDetail(workerId: string): Promise<{
  ok: boolean
  worker?: WorkerDetail
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers/${encodeURIComponent(workerId)}`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

// ── Audit ────────────────────────────────────────────────────────────────────

export async function fetchOpsAudit(limit = 100): Promise<{
  ok: boolean
  entries: AuditEntry[]
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/audit?limit=${limit}`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

// ── Queue summary (read-only) ───────────────────────────────────────────────

export interface QueueSummaryRow {
  name: string
  pending_broker: number
  running_celery: number
  done_db: number | null
  failed_db: number | null
  db_totals_shared?: boolean
}

export async function fetchQueueSummary(): Promise<{
  ok: boolean
  queues: QueueSummaryRow[]
  db_connected?: boolean
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/queues/summary`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

// ── Worker profiles ───────────────────────────────────────────────────────────

export interface WorkerProfileInfo {
  key: string
  label: string
  queues: string[]
}

export async function fetchWorkerProfiles(): Promise<{
  ok: boolean
  profiles: WorkerProfileInfo[]
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers/profiles`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

// ── Worker scaling ────────────────────────────────────────────────────────────

export type ScaleAction = 'add' | 'remove'

export interface ScaleResult {
  ok: boolean
  action?: string
  unit?: string
  instance_id?: string
  worker_type?: string
  result?: Record<string, unknown>
  error?: string
  /** systemd / subprocess view after remove (e.g. inactive). */
  after_state?: string
  /** Present when remove used ``force`` and SIGKILL ran on this host. */
  force_result?: Record<string, unknown>
}

export async function scaleWorker(params: {
  action: ScaleAction
  instance_id?: string
  worker_type?: string
  /** Remove only: SIGKILL local unit/process if still active after graceful stop. */
  force?: boolean
}): Promise<ScaleResult> {
  const body: Record<string, unknown> = { action: params.action }
  if (params.instance_id) body.instance_id = params.instance_id
  if (params.worker_type) body.worker_type = params.worker_type
  if (params.force === true) body.force = true
  const r = await fetch(`${opsBase()}/ops/workers/scale`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  })
  return parseJsonResponse(r)
}

export interface SystemdInstance {
  unit: string
  load: string
  active: string
  sub: string
  description: string
}

export async function fetchWorkerInstances(): Promise<{
  ok: boolean
  instances: SystemdInstance[]
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers/instances`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

// ── Broker control ────────────────────────────────────────────────────────────

export type BrokerAction = 'start' | 'stop' | 'restart'

export interface ExtendedBrokerStatus extends BrokerStatus {
  locally_managed: boolean
}

export async function fetchBrokerStatusExtended(): Promise<{
  ok: boolean
  broker: ExtendedBrokerStatus
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/broker/status`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

export async function controlBroker(action: BrokerAction): Promise<{
  ok: boolean
  action?: string
  result?: Record<string, unknown>
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/broker/control`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ action }),
  })
  return parseJsonResponse(r)
}

// ── Socket / market ingest services (Ops API; Settings → Socket) ─

/** Market ingest only (includes ``reset`` for IB client release + restart). */
export type MarketIngestAction = 'start' | 'stop' | 'restart' | 'reset'

export interface MarketIngestServiceRow {
  id: string
  label: string
  systemd_unit: string
  redis_meta_key: string
  process_active: string
  /** dev|prod from Redis hash field bifrost_ops_control_env (Ops start/stop); null if unclaimed. */
  redis_control_env?: string | null
  /** Hostname from bifrost_ops_control_host at last Ops start; null if missing. */
  redis_control_host?: string | null
}

export async function fetchMarketIngestServices(): Promise<{
  ok: boolean
  services: MarketIngestServiceRow[]
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/market-ingest/services`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

export async function controlMarketIngest(
  serviceId: string,
  action: MarketIngestAction,
): Promise<{
  ok: boolean
  service_id?: string
  action?: string
  result?: Record<string, unknown>
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/market-ingest/control`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ service_id: serviceId, action }),
  })
  const data = await parseJsonResponse<{
    ok?: boolean
    error?: string
    detail?: unknown
    service_id?: string
    action?: string
    result?: Record<string, unknown>
  }>(r)
  if (data.ok === true) {
    return data as {
      ok: boolean
      service_id?: string
      action?: string
      result?: Record<string, unknown>
      error?: string
    }
  }
  throw new Error(opsControlFailureMessage(data, r))
}

// ── Console SSE ──────────────────────────────────────────────────────────────

function consoleStreamQuery(lines: number): URLSearchParams {
  const q = new URLSearchParams()
  q.set('lines', String(lines))
  const token = getOpsToken()
  if (token) q.set('token', token)
  return q
}

/**
 * SSE console URL. Uses relative `/ops/...` when ops base is empty (Vite proxy, same origin).
 * Token is passed as `token` query param so the browser need not send `Authorization` on GET (CORS + Private Network Access).
 */
export function workerConsoleUrl(workerId: string, lines = 200): string {
  const path = `/ops/console/worker/${encodeURIComponent(workerId)}?${consoleStreamQuery(lines)}`
  return joinServiceBase(opsBase(), path)
}

export function brokerConsoleUrl(lines = 200): string {
  const path = `/ops/console/broker?${consoleStreamQuery(lines)}`
  return joinServiceBase(opsBase(), path)
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function fetchOpsHealth(): Promise<{
  status: string
  service: string
  ts: number
  config_profile?: string
  port?: number
  config_path?: string
  executor_mode?: string
  local_control?: string
  /** True when local_control=subprocess and Ops can start/stop ingest via run_*.py (Mac dev). */
  market_ingest_script_control?: boolean
  /** Present when executor_mode is agent: UDS path. */
  agent_socket?: string
  /** Present when executor_mode is agent: whether the Local Control Agent answered a probe. */
  agent_reachable?: boolean
  agent_error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/health`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

export async function fetchOpsHealthAtOrigin(
  origin: ApiOriginBase,
  opts?: { timeoutMs?: number },
): Promise<{
  status: string
  service: string
  ts: number
  config_profile?: string
  port?: number
  config_path?: string
}> {
  const url = joinServiceBase(origin, '/ops/health')
  const ac = new AbortController()
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? 5000)
  const tid = window.setTimeout(() => ac.abort(), timeoutMs)
  try {
    const credentials: RequestCredentials = origin ? 'omit' : 'same-origin'
    const r = await fetch(url, { signal: ac.signal, credentials })
    if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`)
    return parseJsonResponse(r)
  } finally {
    window.clearTimeout(tid)
  }
}
