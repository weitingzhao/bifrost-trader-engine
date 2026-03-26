import type { OpenOrder, OperationsResponse, StatusResponse } from '../types'
import { apiBase } from './constants'
import { fetchWithTimeout } from './fetchTimeout'

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

/** Health check: GET /health, 200 means process alive; returns ts as server response Unix seconds. */
export async function fetchHealth(options?: { timeoutMs?: number }): Promise<{
  status: string
  service: string
  ts: number
  /** Present when server was started with config.dev.yaml or config.prod.yaml (merged overlay file name). */
  config_profile?: 'dev' | 'prod'
  /** From YAML frontend.public_origin (e.g. Prod canonical URL); optional. */
  frontend_public_origin?: string
  /** From YAML frontend.dev_path — base URL for API Health Development column. */
  frontend_dev_path?: string
  /** From YAML frontend.prod_path — base URL for API Health Production column. */
  frontend_prod_path?: string
  /** From YAML server.port — main bifrost FastAPI listen port (API Health Development split probes). */
  server_port?: number
  /** From YAML server.massive_port — Massive FastAPI port. */
  massive_port?: number
  /** From YAML server.docs_port — merged Docs FastAPI port. */
  docs_port?: number
  /** From YAML utilized.services — which sidecar stack each service uses (e.g. dev vs prod). */
  utilized_services?: Array<{ service: string; env: string }>
}> {
  const url = `${apiBase()}/health`
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchOperations(limit = 20): Promise<OperationsResponse> {
  const r = await fetch(`${apiBase()}/operations?limit=${limit}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}
