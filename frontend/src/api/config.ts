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

/** Save account/stream IDs (POST /config/ib). IB host, port, client IDs come from server config.yaml only. */
export async function postIbConfig(accounts: {
  ib_host_account_id?: string | null
  stream_host_account_id?: string | null
  stream_secondary_account_id?: string | null
}): Promise<ControlResponse & Partial<IbConfig>> {
  const r = await fetch(`${API}/config/ib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(accounts),
  })
  const j = await r.json().catch(() => ({}))
  return { ...j, ok: r.ok, error: j.error || (r.ok ? undefined : r.statusText) }
}

/** Save Flex config: host_token, secondary_token to settings; rows to settings_ib_flex; optional flex_default_range_days, flex_init_range_days. */
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
