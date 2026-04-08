import type { RealtimeQuote, QuotesResponse } from '../../types'
import { getMarketApiBase, joinServiceBase } from '../shared/apiRouting'

function apiBase(): string {
  return getMarketApiBase()
}

function marketUrl(path: string): string {
  return joinServiceBase(apiBase(), path)
}

/** GET /quotes: STK from IB Ingestor Redis ticks; empty symbols = server watchlist. */
export async function fetchQuotes(symbols?: string[]): Promise<QuotesResponse> {
  const params = new URLSearchParams()
  if (symbols?.length) params.set('symbols', symbols.join(','))
  const r = await fetch(marketUrl(`/quotes?${params}`))
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** SSE /quotes/stream: IB Ingestor pub/sub channel; payloads load ib:ingester:tick:*. */
export function subscribeQuotes(onQuote: (q: RealtimeQuote) => void): () => void {
  const url = marketUrl('/quotes/stream')
  const es = new EventSource(url)
  es.onmessage = (e: MessageEvent) => {
    try {
      const q = JSON.parse(e.data) as RealtimeQuote
      if (q && typeof q.symbol === 'string' && typeof q.ts === 'number') onQuote(q)
    } catch {
      // ignore parse error (e.g. keepalive comment)
    }
  }
  es.onerror = () => {
    // Do not es.close() here — native EventSource reconnects after transient errors; close() was killing the stream permanently.
  }
  return () => {
    es.close()
  }
}
