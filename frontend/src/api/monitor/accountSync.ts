import type { ControlResponse } from '../../types'
import { apiBase } from '../shared/constants'

export async function postAccountSyncSuspend(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/account-sync/control/suspend`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postAccountSyncResume(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/account-sync/control/resume`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postAccountSyncStop(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/account-sync/control/stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postAccountSyncForceSync(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/account-sync/control/force-sync`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postAccountSyncSetHeartbeatInterval(
  heartbeat_interval_sec: number,
): Promise<ControlResponse & { heartbeat_interval_sec?: number }> {
  const r = await fetch(`${apiBase()}/account-sync/control/set_heartbeat_interval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ heartbeat_interval_sec }),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}
