import type { ControlResponse } from '../types'
import { apiBase } from './constants'

export async function postSuspend(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/suspend`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postResume(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/resume`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postFlatten(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/flatten`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRetryIb(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/retry_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Write daemon_control release_ib; daemon releases IB on next heartbeat and enters WAITING_IB. */
export async function postReleaseIb(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/release_ib`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRefreshAccounts(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/refresh_accounts`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postRefreshReplay(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/refresh_replay`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Sync = Release then Init: daemon unsubscribes all tickers then subscribes to watchlist + positions. */
export async function postRefreshTickerSubscriptions(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/refresh_ticker_subscriptions`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Release: daemon unsubscribes all Real-time ticker subscriptions. */
export async function postReleaseTickerSubscriptions(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/release_ticker_subscriptions`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Init: daemon subscribes to watchlist + all positions if none subscribed; else sets last_control_message error. */
export async function postInitTickerSubscriptions(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/init_ticker_subscriptions`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

export async function postStop(): Promise<ControlResponse> {
  const r = await fetch(`${apiBase()}/control/stop`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}
