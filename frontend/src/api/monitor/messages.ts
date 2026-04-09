import type { SystemMessage, SystemMessagesResponse } from '../../types'
import { apiBase } from '../shared/constants'

export async function fetchSystemMessages(limit = 20): Promise<SystemMessagesResponse> {
  const r = await fetch(`${apiBase()}/api/messages?limit=${encodeURIComponent(String(limit))}`)
  if (!r.ok) throw new Error(r.statusText)
  const data = (await r.json()) as Partial<SystemMessagesResponse>
  return { messages: Array.isArray(data.messages) ? data.messages : [] }
}

export function subscribeSystemMessages(
  onMessage: (message: SystemMessage) => void,
  onError?: () => void,
): () => void {
  const es = new EventSource(`${apiBase()}/api/messages/stream`)
  es.onmessage = (e: MessageEvent<string>) => {
    try {
      const data = JSON.parse(e.data) as SystemMessage
      if (data && typeof data.message_id === 'string') {
        onMessage(data)
      }
    } catch {
      // ignore malformed SSE payloads
    }
  }
  es.onerror = () => {
    onError?.()
  }
  return () => es.close()
}
