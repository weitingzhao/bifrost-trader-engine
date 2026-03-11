import type { ControlResponse, IbConfig, FlexAccountItem } from '../types'
import { API } from './constants'

export async function postSetHeartbeatInterval(heartbeat_interval_sec: number): Promise<ControlResponse & { heartbeat_interval_sec?: number }> {
  const r = await fetch(`${API}/control/set_heartbeat_interval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ heartbeat_interval_sec }),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Save IB and client_id (POST /config/ib). Omitted fields unchanged. R-A4: ib_primary_account_id, ib2_* optional. */
export async function postIbConfig(
  ib_host: string,
  ib_port_type: 'tws_live' | 'tws_paper' | 'gateway',
  clientIds?: {
    ib_client_id_daemon?: number
    ib_client_id_listener?: number
    ib_client_id_account?: number
    ib_client_id_markets?: number
    ib_client_id_worker_market?: number
    ib_primary_account_id?: string | null
    ib2_host?: string | null
    ib2_port_type?: string | null
    ib2_client_id_listener?: number
    ib2_client_id_account?: number
  }
): Promise<ControlResponse & Partial<IbConfig>> {
  const body: Record<string, string | number | null> = { ib_host, ib_port_type }
  if (clientIds) {
    if (clientIds.ib_client_id_daemon != null) body.ib_client_id_daemon = clientIds.ib_client_id_daemon
    if (clientIds.ib_client_id_listener != null) body.ib_client_id_listener = clientIds.ib_client_id_listener
    if (clientIds.ib_client_id_account != null) body.ib_client_id_account = clientIds.ib_client_id_account
    if (clientIds.ib_client_id_markets != null) body.ib_client_id_markets = clientIds.ib_client_id_markets
    if (clientIds.ib_client_id_worker_market != null) body.ib_client_id_worker_market = clientIds.ib_client_id_worker_market
    if (clientIds.ib_primary_account_id !== undefined) body.ib_primary_account_id = clientIds.ib_primary_account_id
    if (clientIds.ib2_host !== undefined) body.ib2_host = clientIds.ib2_host
    if (clientIds.ib2_port_type !== undefined) body.ib2_port_type = clientIds.ib2_port_type
    if (clientIds.ib2_client_id_listener != null) body.ib2_client_id_listener = clientIds.ib2_client_id_listener
    if (clientIds.ib2_client_id_account != null) body.ib2_client_id_account = clientIds.ib2_client_id_account
  }
  const r = await fetch(`${API}/config/ib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Save Flex config: host_token, secondary_token to settings; accounts to flex_accounts; optional flex_default_range_days, flex_init_range_days. */
export async function postFlexConfig(
  hostToken?: string | null,
  secondaryToken?: string | null,
  accounts: FlexAccountItem[] = [],
  flexDefaultRangeDays?: number | null,
  flexInitRangeDays?: number | null
): Promise<ControlResponse & { accounts?: FlexAccountItem[]; host_token?: string; secondary_token?: string; flex_default_range_days?: number; flex_init_range_days?: number }> {
  const r = await fetch(`${API}/config/flex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host_token: hostToken ?? undefined,
      secondary_token: secondaryToken ?? undefined,
      accounts,
      flex_default_range_days: flexDefaultRangeDays != null && Number.isFinite(flexDefaultRangeDays) ? Math.max(1, Math.round(flexDefaultRangeDays)) : undefined,
      flex_init_range_days: flexInitRangeDays != null && Number.isFinite(flexInitRangeDays) ? Math.max(1, Math.round(flexInitRangeDays)) : undefined,
    }),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText), accounts: j.accounts, host_token: j.host_token, secondary_token: j.secondary_token, flex_default_range_days: j.flex_default_range_days, flex_init_range_days: j.flex_init_range_days }
}

/** GET /config/key-value: list by key or group_name. Match by group name only. */
export async function fetchKeyValueConfig(params?: { key?: string; group_name?: string }): Promise<{ ok: boolean; items: Array<{ key: string; value: string; description?: string | null; updated_at?: string; group_id?: number }>; error?: string }> {
  const p = params || {}
  const q = new URLSearchParams()
  if (p.key) q.set('key', p.key)
  if (p.group_name) q.set('group_name', p.group_name)
  const url = q.toString() ? `${API}/config/key-value?${q}` : `${API}/config/key-value`
  const r = await fetch(url)
  const j = await r.json().catch(() => ({ ok: false, items: [] }))
  return { ...j, ok: r.ok && j.ok !== false, items: j.items ?? [] }
}

export async function fetchKeyValueGroups(): Promise<{ ok: boolean; items: Array<{ id: number; name: string; description?: string | null; sort_order?: number; created_at?: string; updated_at?: string }>; error?: string }> {
  const r = await fetch(`${API}/config/key-value/groups`)
  const j = await r.json().catch(() => ({ ok: false, items: [] }))
  return { ...j, ok: r.ok && j.ok !== false, items: j.items ?? [] }
}

export async function postKeyValueGroup(body: { name: string; description?: string; sort_order?: number }): Promise<{ ok: boolean; id?: number; name?: string; error?: string }> {
  const r = await fetch(`${API}/config/key-value/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok && j.ok !== false, error: j.error }
}

export async function patchKeyValueGroup(groupName: string, body: { name?: string; description?: string; sort_order?: number }): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/config/key-value/groups/${encodeURIComponent(groupName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok && j.ok !== false, error: j.error }
}

export async function deleteKeyValueGroup(groupName: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/config/key-value/groups/${encodeURIComponent(groupName)}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok && j.ok !== false, error: j.error }
}

export async function postKeyValueConfig(body: { group_name?: string; key: string; value?: string; description?: string }): Promise<{ ok: boolean; key?: string; value?: string; error?: string }> {
  const r = await fetch(`${API}/config/key-value`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok && j.ok !== false, error: j.error }
}

export async function deleteKeyValueConfig(key: string, groupName?: string): Promise<{ ok: boolean; key?: string; error?: string }> {
  const q = new URLSearchParams({ key })
  if (groupName) q.set('group_name', groupName)
  const r = await fetch(`${API}/config/key-value?${q}`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok && j.ok !== false, error: j.error }
}

export interface MarketHolidayRow {
  exchange: string
  holiday_date: string
  label: string | null
}

export async function fetchMarketHolidays(year?: number, exchange?: string): Promise<MarketHolidayRow[]> {
  const params = new URLSearchParams()
  if (year != null) params.set('year', String(year))
  if (exchange && exchange.trim()) params.set('exchange', exchange.trim())
  const r = await fetch(`${API}/market/holidays?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function postMarketHoliday(payload: { date: string; label?: string; exchange?: string }): Promise<{ date: string; exchange: string; label: string | null }> {
  const r = await fetch(`${API}/market/holidays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: (payload.date || '').trim().slice(0, 10),
      label: payload.label != null ? String(payload.label).trim() || undefined : undefined,
      exchange: (payload.exchange || 'NYSE').trim() || undefined,
    }),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
  return r.json()
}

export async function deleteMarketHoliday(dateStr: string, exchange?: string): Promise<void> {
  const params = new URLSearchParams({ date: (dateStr || '').trim().slice(0, 10) })
  if (exchange && exchange.trim()) params.set('exchange', exchange.trim())
  const r = await fetch(`${API}/market/holidays?${params}`, { method: 'DELETE' })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
}
