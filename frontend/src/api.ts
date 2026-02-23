import type { StatusResponse, OperationsResponse, ControlResponse, IbConfig } from './types'

const API = '' // same origin; Vite proxy forwards /status, /operations, /control

export async function fetchStatus(): Promise<StatusResponse | null> {
  const r = await fetch(`${API}/status`)
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

export async function postIbConfig(ib_host: string, ib_port_type: 'tws_live' | 'tws_paper' | 'gateway'): Promise<ControlResponse & Partial<IbConfig>> {
  const r = await fetch(`${API}/config/ib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ib_host: ib_host.trim(), ib_port_type }),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}
