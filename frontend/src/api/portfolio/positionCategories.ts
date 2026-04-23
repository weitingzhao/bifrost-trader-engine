import type { PositionCategoriesResponse } from '../../types'
import {
  getPortfolioApiBaseForBrowser,
  getServerApiBaseForBrowser,
  initApiRouting,
  joinServiceBase,
} from '../shared/apiRouting'

function _trimBase(b: string): string {
  return (b || '').replace(/\/$/, '')
}

/**
 * Prefer GET /health portfolio origin, then Monitor (same DB) when portfolio process is not running
 * (local dev: run_server.py only) or connection fails.
 * Always try same-origin relative last: when Monitor base is cleared by LAN/loopback alignment,
 * Vite/nginx still proxy `/position-categories` to the API (Watchlist, Accounts, Live).
 */
async function fetchPortfolioPath(path: string, init?: RequestInit): Promise<Response> {
  await initApiRouting()
  const port = _trimBase(getPortfolioApiBaseForBrowser())
  const srv = _trimBase(getServerApiBaseForBrowser())
  const ordered: string[] = []
  if (port) ordered.push(port)
  if (srv && srv !== port) ordered.push(srv)
  if (!ordered.some((b) => b === '')) ordered.push('')
  let last: Response | null = null
  let lastErr: unknown = null
  for (const base of ordered) {
    try {
      const r = await fetch(joinServiceBase(base, path), init)
      last = r
      if (r.ok) return r
      // Do not retry on client errors except 404 (route missing on that host).
      if (r.status >= 400 && r.status < 500 && r.status !== 404) return r
      lastErr = new Error(r.statusText)
    } catch (e) {
      lastErr = e
    }
  }
  if (last) return last
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'Request failed'))
}

export async function fetchPositionCategories(): Promise<PositionCategoriesResponse> {
  const r = await fetchPortfolioPath('/position-categories')
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function postPositionCategory(item: { name: string; description?: string; sort_order?: number }): Promise<{ ok: boolean; id?: number; error?: string }> {
  const res = await fetchPortfolioPath('/position-categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, id: j.id, error: j.error }
}

/** PATCH category (name/description/sort_order). Not exported from api/index; use when adding edit-category UI. */
export async function patchPositionCategory(id: number, item: { name?: string; description?: string; sort_order?: number }): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchPortfolioPath(`/position-categories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

export async function deletePositionCategory(id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchPortfolioPath(`/position-categories/${id}`, { method: 'DELETE' })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** Batch update strategy attribution on executions (by contract_key or execution_ids). */
export async function patchExecutionStrategyAttribution(body: {
  account_id: string
  contract_key?: string
  execution_ids?: number[]
  strategy_opportunity_id: number | null
  strategy_instance_id?: number | null
}): Promise<{ ok: boolean; updated?: number; error?: string }> {
  const res = await fetchPortfolioPath('/executions/strategy-attribution', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, updated: j.updated, error: j.error }
}

export async function putPositionCategoryTag(account_id: string, contract_key: string, category_id: number | null): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchPortfolioPath('/position-categories/tag', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id, contract_key, category_id }),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}

/** Market Streams: symbol order per category (saved to DB). */
export async function fetchMarketStreamsSymbolOrder(): Promise<{ ok: boolean; order?: Record<string, string[]> }> {
  const r = await fetchPortfolioPath('/position-categories/symbol-order')
  if (!r.ok) return { ok: false }
  const j = await r.json().catch(() => ({}))
  return { ok: j.ok === true, order: j.order ?? {} }
}

/** Market Streams: save symbol order for one category. */
export async function putMarketStreamsSymbolOrder(category_name: string, symbols: string[]): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchPortfolioPath('/position-categories/symbol-order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category_name, symbols }),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: j.ok === true, error: j.error }
}
