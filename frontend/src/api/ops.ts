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
  const r = await fetch(`${opsBase()}/ops/workers`)
  return r.json()
}

export async function fetchOpsWorkerDetail(workerId: string): Promise<{
  ok: boolean
  worker?: WorkerDetail
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/workers/${encodeURIComponent(workerId)}`)
  return r.json()
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: params.action,
      target_type: params.target_type ?? 'worker',
      target_id: params.target_id,
      reason: params.reason,
      idempotency_key: params.idempotency_key,
    }),
  })
  return r.json()
}

export async function fetchOpsCommand(commandId: string): Promise<{
  ok: boolean
  command?: CommandRecord
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/commands/${encodeURIComponent(commandId)}`)
  return r.json()
}

export async function fetchOpsCommands(limit = 50): Promise<{
  ok: boolean
  commands: CommandRecord[]
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/commands?limit=${limit}`)
  return r.json()
}

// ── Audit ────────────────────────────────────────────────────────────────────

export async function fetchOpsAudit(limit = 100): Promise<{
  ok: boolean
  entries: AuditEntry[]
  count: number
  error?: string
}> {
  const r = await fetch(`${opsBase()}/ops/audit?limit=${limit}`)
  return r.json()
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
  const r = await fetch(`${opsBase()}/ops/health`)
  return r.json()
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
    return r.json()
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
