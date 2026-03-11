import type { ControlResponse } from '../types'
import { API } from './constants'

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

/** Write daemon_control release_ib; daemon releases IB on next heartbeat and enters WAITING_IB. */
export async function postReleaseIb(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/release_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRefreshAccounts(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/refresh_accounts`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRefreshReplay(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/refresh_replay`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Sync daemon real-time ticker subscriptions to Watchlist (add/remove, clear stale). */
export async function postRefreshTickerSubscriptions(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/refresh_ticker_subscriptions`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postStop(): Promise<ControlResponse> {
  const r = await fetch(`${API}/control/stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}
