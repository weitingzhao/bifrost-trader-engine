import type { OpenOrder, OperationsResponse, StatusResponse } from '../../types'
import { opsAuthHeaders, opsControlFailureMessage, type OpsCapabilities } from '../ops/ops'
import { apiBase } from '../shared/constants'
import { fetchWithTimeout } from '../shared/fetchTimeout'

/** GET /health JSON body (shared by single-flight dedupe). */
export type MonitorHealthPayload = {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod'
  frontend_public_origin?: string
  frontend_dev_path?: string
  frontend_prod_path?: string
  monitor_port?: number
  massive_port?: number
  docs_port?: number
  ops_port?: number
  trading_port?: number
  strategy_port?: number
  portfolio_port?: number
  market_port?: number
  research_port?: number
  utilized_services?: Array<{ service: string; env: string }>
}

let healthInFlight: Promise<MonitorHealthPayload> | null = null

async function fetchHealthInner(options?: { timeoutMs?: number }): Promise<MonitorHealthPayload> {
  const url = `${apiBase()}/health`
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(r.statusText)
  return r.json() as Promise<MonitorHealthPayload>
}

export async function fetchStatus(): Promise<StatusResponse | null> {
  const r = await fetch(`${apiBase()}/status`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A5: GET /open-orders — current unfilled orders from DB (daemon event-driven write). */
export async function fetchOpenOrders(): Promise<{ open_orders: OpenOrder[] }> {
  const r = await fetch(`${apiBase()}/open-orders`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/**
 * Health check: GET /health, 200 means process alive; returns ts as server response Unix seconds.
 * Concurrent callers share one in-flight request to avoid a burst of parallel /health calls
 * (Vite proxy + 8s timeout) aborting each other with "signal is aborted without reason".
 */
export async function fetchHealth(options?: { timeoutMs?: number }): Promise<MonitorHealthPayload> {
  if (healthInFlight) {
    return healthInFlight
  }
  healthInFlight = fetchHealthInner(options).finally(() => {
    healthInFlight = null
  })
  return healthInFlight
}

export async function fetchOperations(limit = 20): Promise<OperationsResponse> {
  const r = await fetch(`${apiBase()}/operations?limit=${limit}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Same shape as GET /ops/auth/capabilities (shared ops.auth tokens). */
export async function fetchMonitorCapabilities(): Promise<OpsCapabilities> {
  const r = await fetch(`${apiBase()}/api/server/auth/capabilities`, { headers: opsAuthHeaders() })
  const text = await r.text()
  try {
    return JSON.parse(text) as OpsCapabilities
  } catch {
    throw new Error(
      `Monitor API returned non-JSON response (HTTP ${r.status}${text ? `, body: ${text.slice(0, 120)}` : ''}).`,
    )
  }
}

/** Terminate the Monitor (bifrost-server) process. Requires operator role. */
export async function postMonitorShutdown(): Promise<{ ok: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch(`${apiBase()}/api/server/shutdown`, {
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
