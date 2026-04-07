import type { ControlResponse } from '../../types'
import { apiBase } from '../shared/constants'

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

export async function postMonitorConnect(): Promise<
  ControlResponse & {
    host?: { requested?: boolean; success?: boolean; error?: string | null }
    secondary?: { requested?: boolean; success?: boolean; error?: string | null }
  }
> {
  const r = await fetch(`${apiBase()}/control/monitor_connect`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ...j,
    ok: r.ok && (j.ok !== false),
    error: j.error || (r.ok ? undefined : r.statusText),
    host: j.host,
    secondary: j.secondary,
  }
}
