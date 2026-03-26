/**
 * Ops control plane API — Celery worker status, commands, audit.
 *
 * Base URL resolved via `getOpsApiBase()` (same routing pattern as massive/docs).
 * All responses follow { ok, ...payload } convention.
 */

import { getOpsApiBase, joinServiceBase } from './constants'

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

function authHeaders(): Record<string, string> {
  const token = getOpsToken()
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
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

export type CommandAction = 'start' | 'stop' | 'restart'

export type CommandStatusValue =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'

export interface WorkerSummary {
  worker_id: string
  status: WorkerStatus
  queues: string[]
  concurrency: number
  active_tasks: number
  reserved_tasks: number
  last_heartbeat: number | null
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

export interface CommandRecord {
  command_id: string
  action: CommandAction
  target_type: string
  target_id: string
  status: CommandStatusValue
  reason: string | null
  idempotency_key: string | null
  operator: string | null
  created_at: number
  updated_at: number
  result: Record<string, unknown> | null
  error: string | null
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

export async function fetchOpsWorkers(): Promise<{
  ok: boolean
  workers: WorkerSummary[]
  broker: BrokerStatus
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers`, { headers: authHeaders() })
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

// ── Commands ─────────────────────────────────────────────────────────────────

export async function submitOpsCommand(params: {
  action: CommandAction
  target_id: string
  target_type?: string
  reason?: string
  idempotency_key?: string
}): Promise<{
  ok: boolean
  command?: CommandRecord
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/commands`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      action: params.action,
      target_type: params.target_type ?? 'worker',
      target_id: params.target_id,
      reason: params.reason,
      idempotency_key: params.idempotency_key,
    }),
  })
  return parseJsonResponse(r)
}

export async function fetchOpsCommand(commandId: string): Promise<{
  ok: boolean
  command?: CommandRecord
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/commands/${encodeURIComponent(commandId)}`, { headers: authHeaders() })
  return parseJsonResponse(r)
}

export async function fetchOpsCommands(limit = 50): Promise<{
  ok: boolean
  commands: CommandRecord[]
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/commands?limit=${limit}`, { headers: authHeaders() })
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

// ── Queue binding ─────────────────────────────────────────────────────────────

export async function updateWorkerQueues(
  workerId: string,
  params: { add?: string[]; remove?: string[] },
): Promise<{
  ok: boolean
  worker_id?: string
  added?: string[]
  removed?: string[]
  errors?: { queue: string; op: string; error: string }[]
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers/${encodeURIComponent(workerId)}/queues`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ add: params.add ?? [], remove: params.remove ?? [] }),
  })
  return parseJsonResponse(r)
}

// ── Worker scaling ────────────────────────────────────────────────────────────

export type ScaleAction = 'add' | 'remove'

export async function scaleWorker(params: {
  action: ScaleAction
  instance_id: string
  queues?: string[]
}): Promise<{
  ok: boolean
  action?: string
  unit?: string
  result?: Record<string, unknown>
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers/scale`, {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      action: params.action,
      instance_id: params.instance_id,
      queues: params.queues ?? ['celery'],
    }),
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

// ── Console SSE ──────────────────────────────────────────────────────────────

export function workerConsoleUrl(workerId: string, lines = 200): string {
  return `${opsBase()}/ops/console/worker/${encodeURIComponent(workerId)}?lines=${lines}`
}

export function brokerConsoleUrl(lines = 200): string {
  return `${opsBase()}/ops/console/broker?lines=${lines}`
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function fetchOpsHealth(): Promise<{
  status: string
  service: string
  ts: number
  config_profile?: string
  port?: number
  config_path?: string
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

// ── Polling helper ───────────────────────────────────────────────────────────

/**
 * Poll a command until terminal status or timeout.
 * Returns the final CommandRecord.
 */
export async function pollOpsCommand(
  commandId: string,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<CommandRecord> {
  const interval = opts?.intervalMs ?? 2000
  const timeout = opts?.timeoutMs ?? 60_000
  const start = Date.now()
  const terminal: CommandStatusValue[] = ['succeeded', 'failed', 'timeout']
  while (Date.now() - start < timeout) {
    const res = await fetchOpsCommand(commandId)
    if (res.command && terminal.includes(res.command.status)) {
      return res.command
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(`Polling command ${commandId} timed out after ${timeout}ms`)
}
