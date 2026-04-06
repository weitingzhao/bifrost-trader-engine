import { apiBase, getOpsApiBase, joinServiceBase } from '../shared/constants'
import { getOpsToken, workerConsoleUrl } from '../ops/ops'

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

export async function fetchServerLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${apiBase()}/api/server/logs?${params}`)
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

export async function clearServerLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/server/logs`, { method: 'DELETE' })
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

export async function trimServerLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/server/logs/trim`, {
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

export function subscribeServerLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/server/logs/stream`
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
  const r = await fetch(`${apiBase()}/api/massive-ws/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearMassiveWsLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/massive-ws/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimMassiveWsLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/massive-ws/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeMassiveWsLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/massive-ws/logs/stream`
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
  const r = await fetch(`${apiBase()}/api/ib-operator/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearIbOperatorLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/ib-operator/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimIbOperatorLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/ib-operator/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeIbOperatorLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/ib-operator/logs/stream`
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
  const r = await fetch(`${apiBase()}/api/ib-ingestor/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearIbIngestorLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/ib-ingestor/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimIbIngestorLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase()}/api/ib-ingestor/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeIbIngestorLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${apiBase()}/api/ib-ingestor/logs/stream`
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
