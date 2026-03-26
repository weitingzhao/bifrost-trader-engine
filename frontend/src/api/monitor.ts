import type { ControlResponse } from '../types'
import { apiBase } from './constants'

export interface SseQueueCategory {
  connection_count: number
  maxsize: number
  depths: number[]
  total_queued: number
  max_depth: number
}

export interface SseQueueMetrics {
  ts: number
  quotes: SseQueueCategory
  daemon_logs: SseQueueCategory
  server_logs: SseQueueCategory
  celery_logs: SseQueueCategory
  massive_logs?: SseQueueCategory
  docs_logs?: SseQueueCategory
}

export async function fetchSseQueueMetrics(): Promise<SseQueueMetrics> {
  const r = await fetch(`${apiBase()}/api/monitor/sse-queue-metrics`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

const MONITOR_STOP_FETCH_TIMEOUT_MS = 15000

export async function postMonitorStop(): Promise<ControlResponse & { monitor_enabled?: boolean }> {
  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), MONITOR_STOP_FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(`${apiBase()}/control/monitor_stop`, { method: 'POST', signal: ac.signal })
    const j = await r.json().catch(() => ({}))
    return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), monitor_enabled: j.monitor_enabled }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    const isAbort = err.includes('abort') || (e instanceof Error && e.name === 'AbortError')
    return {
      ok: false,
      error: isAbort ? 'Request timed out. Server may have stopped; refresh the page.' : err,
      monitor_enabled: false,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function postMonitorReleaseIb(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/monitor_release_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postCeleryStop(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/celery_stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postMonitorConnect(): Promise<
  ControlResponse & {
    account?: { requested?: boolean; success?: boolean; error?: string | null }
    market?: { requested?: boolean; success?: boolean; error?: string | null }
  }
> {
  const r = await fetch(`${apiBase()}/control/monitor_connect`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ...j,
    ok: r.ok && (j.ok !== false),
    error: j.error || (r.ok ? undefined : r.statusText),
    account: j.account,
    market: j.market,
  }
}
