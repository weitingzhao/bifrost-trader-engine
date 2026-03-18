import type { PositionCategoriesResponse } from '../types'
import { API } from './constants'

export async function fetchPositionCategories(): Promise<PositionCategoriesResponse> {
  const r = await fetch(`${API}/position-categories`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function postPositionCategory(item: { name: string; description?: string; sort_order?: number }): Promise<{ ok: boolean; id?: number; error?: string }> {
  const res = await fetch(`${API}/position-categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, id: j.id, error: j.error }
}

/** PATCH category (name/description/sort_order). Not exported from api/index; use when adding edit-category UI. */
export async function patchPositionCategory(id: number, item: { name?: string; description?: string; sort_order?: number }): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API}/position-categories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

export async function deletePositionCategory(id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API}/position-categories/${id}`, { method: 'DELETE' })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** Assign strategy opportunity and instance to a position (e.g. stock for Covered Call underlying). */
export async function putPositionStrategy(body: {
  account_id: string
  contract_key: string
  strategy_opportunity_id: number | null
  strategy_instance_id?: number | null
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API}/positions/strategy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

export async function putPositionCategoryTag(account_id: string, contract_key: string, category_id: number | null): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API}/position-categories/tag`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id, contract_key, category_id }),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** Market Streams: symbol order per category (saved to DB). */
export async function fetchMarketStreamsSymbolOrder(): Promise<{ ok: boolean; order?: Record<string, string[]> }> {
  const r = await fetch(`${API}/position-categories/symbol-order`)
  if (!r.ok) return { ok: false }
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, order: j.order ?? {} }
}

/** Market Streams: save symbol order for one category. */
export async function putMarketStreamsSymbolOrder(category_name: string, symbols: string[]): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API}/position-categories/symbol-order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category_name, symbols }),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}
