/**
 * Trading / Portfolio sidecar control (capabilities + shutdown), same auth as Ops API.
 */

import { joinServiceBase } from '../shared/apiRouting'
import { opsAuthHeaders, opsControlFailureMessage, type OpsCapabilities } from '../ops/ops'

function parseJsonResponse<T>(text: string): T {
  return JSON.parse(text) as T
}

export async function fetchTradingCapabilities(serviceOrigin: string): Promise<OpsCapabilities> {
  const base = serviceOrigin.replace(/\/$/, '')
  const r = await fetch(joinServiceBase(base, '/trading/auth/capabilities'), {
    headers: opsAuthHeaders(),
    credentials: 'omit',
  })
  const text = await r.text()
  return parseJsonResponse<OpsCapabilities>(text)
}

export async function postTradingShutdown(serviceOrigin: string): Promise<{ ok: boolean; error?: string }> {
  const base = serviceOrigin.replace(/\/$/, '')
  let r: Response
  try {
    r = await fetch(joinServiceBase(base, '/trading/shutdown'), {
      method: 'POST',
      headers: opsAuthHeaders(),
      credentials: 'omit',
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let data: { ok?: boolean; error?: string } = {}
  try {
    const text = await r.text()
    data = text ? parseJsonResponse(text) : {}
  } catch (e) {
    if (!r.ok) {
      return { ok: false, error: `Request failed (HTTP ${r.status})` }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    return { ok: false, error: opsControlFailureMessage(data, r) }
  }
  return { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : undefined }
}

export async function fetchPortfolioCapabilities(serviceOrigin: string): Promise<OpsCapabilities> {
  const base = serviceOrigin.replace(/\/$/, '')
  const r = await fetch(joinServiceBase(base, '/portfolio/auth/capabilities'), {
    headers: opsAuthHeaders(),
    credentials: 'omit',
  })
  const text = await r.text()
  return parseJsonResponse<OpsCapabilities>(text)
}

export async function postPortfolioShutdown(serviceOrigin: string): Promise<{ ok: boolean; error?: string }> {
  const base = serviceOrigin.replace(/\/$/, '')
  let r: Response
  try {
    r = await fetch(joinServiceBase(base, '/portfolio/shutdown'), {
      method: 'POST',
      headers: opsAuthHeaders(),
      credentials: 'omit',
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let data: { ok?: boolean; error?: string } = {}
  try {
    const text = await r.text()
    data = text ? parseJsonResponse(text) : {}
  } catch (e) {
    if (!r.ok) {
      return { ok: false, error: `Request failed (HTTP ${r.status})` }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    return { ok: false, error: opsControlFailureMessage(data, r) }
  }
  return { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : undefined }
}
