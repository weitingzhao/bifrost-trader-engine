import { isDevBuild } from '@/lib/publicEnv'
import { apiBase, getOpsApiBase, joinServiceBase } from '../shared/constants'
import { getOpsToken, workerConsoleUrl } from '../ops/ops'

/**
 * Monitor log APIs always hit bifrost-server. In Vite dev, when VITE_API_BASE points at
 * :monitor_port while the page is on :5173, cross-origin EventSource often fails; same-origin
 * `/api/...` goes through the dev proxy to Monitor.
 */
function bifrostMonitorApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const base = apiBase().replace(/\/$/, '')
  if (isDevBuild() && typeof window !== 'undefined' && base) {
    try {
      const apiOrigin = new URL(base, window.location.origin).origin
      if (apiOrigin !== window.location.origin) {
        return p
      }
    } catch {
      /* use absolute base below */
    }
  }
  return joinServiceBase(base, p)
}

function opsAuthHeaders(): Record<string, string> {
  const token = getOpsToken()
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

export async function fetchCeleryLogs(
  workerId: string,
  tail = 50,
): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail), worker: workerId })
  const url = joinServiceBase(getOpsApiBase(), `/ops/celery/logs?${params}`)
  const r = await fetch(url, { headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function fetchDaemonLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${apiBase()}/api/daemon/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function fetchMonitorLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${apiBase()}/api/monitor/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearCeleryLogs(workerId: string): Promise<{ ok: boolean; error?: string }> {
  const q = new URLSearchParams({ worker: workerId })
  const url = joinServiceBase(getOpsApiBase(), `/ops/celery/logs?${q}`)
  const r = await fetch(url, { method: 'DELETE', headers: opsAuthHeaders() })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function clearDaemonLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/daemon/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function fetchAccountSyncDaemonLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const url = bifrostMonitorApiUrl(`/api/account-sync-daemon/logs?${params}`)
  const r = await fetch(url)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export function subscribeAccountSyncDaemonLogs(
  onLine: (line: string) => void,
  onError?: () => void,
): () => void {
  const url = bifrostMonitorApiUrl('/api/account-sync-daemon/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function clearAccountSyncDaemonLogs(): Promise<{ ok: boolean; error?: string }> {
  const url = bifrostMonitorApiUrl('/api/account-sync-daemon/logs')
  const r = await fetch(url, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function clearMonitorLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/monitor/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimCeleryLogs(
  maxLines: number,
  workerId: string,
): Promise<{ ok: boolean; error?: string }> {
  const q = new URLSearchParams({ worker: workerId })
  const url = joinServiceBase(getOpsApiBase(), `/ops/celery/logs/trim?${q}`)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opsAuthHeaders() },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimDaemonLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/daemon/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimMonitorLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/monitor/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeCeleryLogs(
  onLine: (line: string) => void,
  onError: (() => void) | undefined,
  workerId: string,
): () => void {
  const url = workerConsoleUrl(workerId)
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export function subscribeDaemonLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/daemon/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export function subscribeMonitorLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/monitor/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchMassiveLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${apiBase()}/api/massive/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearMassiveLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/massive/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimMassiveLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/massive/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeMassiveLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/massive/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchMassiveWsLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(bifrostMonitorApiUrl(`/api/massive-ws/logs?${params}`))
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearMassiveWsLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/massive-ws/logs'), { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimMassiveWsLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/massive-ws/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeMassiveWsLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/massive-ws/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchIbOperatorLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(bifrostMonitorApiUrl(`/api/ib-operator/logs?${params}`))
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearIbOperatorLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/ib-operator/logs'), { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimIbOperatorLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/ib-operator/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeIbOperatorLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/ib-operator/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchIbIngestorLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(bifrostMonitorApiUrl(`/api/ib-ingestor/logs?${params}`))
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearIbIngestorLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/ib-ingestor/logs'), { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimIbIngestorLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/ib-ingestor/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeIbIngestorLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/ib-ingestor/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchIbAccountAgentLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(bifrostMonitorApiUrl(`/api/ib-account-agent/logs?${params}`))
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearIbAccountAgentLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/ib-account-agent/logs'), { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimIbAccountAgentLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/ib-account-agent/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeIbAccountAgentLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/ib-account-agent/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchDocsLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${apiBase()}/api/docs/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearDocsLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/docs/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimDocsLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/docs/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeDocsLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/docs/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchOpsLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${apiBase()}/api/ops/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearOpsLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/ops/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimOpsLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/ops/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeOpsLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/ops/logs/stream`
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchTradingLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  return fetchMonitorLogTail(`/api/trading/logs?${params}`)
}

export async function clearTradingLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/trading/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimTradingLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/trading/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

function monitorLogsTailErrorMessage(r: Response, body: Record<string, unknown>): string {
  const err = body.error
  const detail = body.detail
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (typeof detail === 'string' && detail.trim()) return detail.trim()
  if (Array.isArray(detail)) {
    const parts = detail
      .map(item => {
        if (item && typeof item === 'object' && 'msg' in item) {
          return String((item as { msg?: string }).msg ?? '').trim()
        }
        return ''
      })
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  if (r.status === 404) {
    return `HTTP ${r.status}: log route missing — ensure VITE_API_BASE / routing points at the Monitor API, not Trading or Portfolio.`
  }
  return `HTTP ${r.status}: could not load log tail from Monitor.`
}

async function fetchMonitorLogTail(pathWithQuery: string): Promise<{ lines: string[]; error?: string }> {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  const url = bifrostMonitorApiUrl(path)
  let r: Response
  try {
    r = await fetch(url, { credentials: 'omit' })
  } catch (e) {
    return { lines: [], error: e instanceof Error ? e.message : String(e) }
  }
  const text = await r.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  const lines = Array.isArray(body.lines) ? (body.lines as string[]) : []
  const payloadError = typeof body.error === 'string' ? body.error : undefined
  if (!r.ok) {
    return {
      lines,
      error: payloadError || monitorLogsTailErrorMessage(r, body),
    }
  }
  return { lines, error: payloadError }
}

export function subscribeTradingLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = joinServiceBase(apiBase(), '/api/trading/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchPortfolioLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  return fetchMonitorLogTail(`/api/portfolio/logs?${params}`)
}

export async function clearPortfolioLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/portfolio/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimPortfolioLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/portfolio/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribePortfolioLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = joinServiceBase(apiBase(), '/api/portfolio/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchResearchLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  return fetchMonitorLogTail(`/api/research/logs?${params}`)
}

export async function clearResearchLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/research/logs'), { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimResearchLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/research/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeResearchLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/research/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchStrategyLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  return fetchMonitorLogTail(`/api/strategy/logs?${params}`)
}

export async function clearStrategyLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/strategy/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimStrategyLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/strategy/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeStrategyLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/strategy/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}

export async function fetchMarketLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  return fetchMonitorLogTail(`/api/market/logs?${params}`)
}

export async function clearMarketLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/market/logs'), { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimMarketLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(bifrostMonitorApiUrl('/api/market/logs/trim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeMarketLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = bifrostMonitorApiUrl('/api/market/logs/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { line?: string }
      if (data && typeof data.line === 'string') onLine(data.line)
    } catch {
      // ignore
    }
  }
  es.onerror = () => {
    onError?.()
    es.close()
  }
  return () => {
    es.close()
  }
}
