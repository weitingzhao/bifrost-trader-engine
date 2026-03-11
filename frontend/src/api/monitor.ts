import type { ControlResponse } from '../types'
import { API } from './constants'

export async function postMonitorStop(): Promise<ControlResponse & { monitor_enabled?: boolean }> {
  const r = await fetch(`${API}/control/monitor_stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), monitor_enabled: j.monitor_enabled }
}

export async function postMonitorReleaseIb(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/monitor_release_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postCeleryStop(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/celery_stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
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
