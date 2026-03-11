import { API } from './constants'

export async function fetchCeleryLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${API}/api/celery/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function fetchDaemonLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${API}/api/daemon/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function fetchServerLogs(tail = 50): Promise<{ lines: string[]; error?: string }> {
  const params = new URLSearchParams({ tail: String(tail) })
  const r = await fetch(`${API}/api/server/logs?${params}`)
  const j = await r.json().catch(() => ({ lines: [] }))
  return { lines: Array.isArray(j.lines) ? j.lines : [], error: j.error }
}

export async function clearCeleryLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/celery/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function clearDaemonLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/daemon/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function clearServerLogs(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/server/logs`, { method: 'DELETE' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimCeleryLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/celery/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimDaemonLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/daemon/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export async function trimServerLogs(maxLines: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API}/api/server/logs/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_lines: maxLines }),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.ok !== false, error: j.error }
}

export function subscribeCeleryLogs(onLine: (line: string) => void, onError?: () => void): () => void {
  const url = `${API || ''}/api/celery/logs/stream`
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
  const url = `${API || ''}/api/daemon/logs/stream`
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
  const url = `${API || ''}/api/server/logs/stream`
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
