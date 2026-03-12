import type { OpenOrder, OperationsResponse, StatusResponse } from '../types'
import { API } from './constants'

export async function fetchStatus(): Promise<StatusResponse | null> {
  const r = await fetch(`${API}/status`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** R-A5: GET /open-orders — current unfilled orders from DB (daemon event-driven write). */
export async function fetchOpenOrders(): Promise<{ open_orders: OpenOrder[] }> {
  const r = await fetch(`${API}/open-orders`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Health check: GET /health, 200 means process alive; returns ts as server response Unix seconds. */
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
