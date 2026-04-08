import type { RealtimeQuote, QuotesResponse } from '../../types'
import { getMarketApiBase, joinServiceBase } from '../shared/apiRouting'

function apiBase(): string {
  return getMarketApiBase()
}

function marketUrl(path: string): string {
  return joinServiceBase(apiBase(), path)
}

/** Normalize SSE JSON: accept numeric or string ts; derive symbol from contract_key when missing. */
function parseRealtimeQuoteFromSSEPayload(data: string): RealtimeQuote | null {
  try {
    const raw = JSON.parse(data) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    let sym = ''
    if (typeof raw.symbol === 'string') sym = raw.symbol.trim()
    else if (typeof raw.symbol === 'number' && Number.isFinite(raw.symbol)) sym = String(raw.symbol)
    if (!sym && typeof raw.contract_key === 'string') {
      sym = (raw.contract_key.split('|')[0] ?? '').trim()
    }
    const ts = Number(raw.ts)
    if (!sym || !Number.isFinite(ts)) return null
    return { ...(raw as unknown as RealtimeQuote), symbol: sym, ts }
  } catch {
    return null
  }
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
    const q = parseRealtimeQuoteFromSSEPayload(e.data)
    if (q) onQuote(q)
  }
  es.onerror = () => {
    // Do not es.close() here — native EventSource reconnects after transient errors; close() was killing the stream permanently.
  }
  return () => {
    es.close()
  }
}
