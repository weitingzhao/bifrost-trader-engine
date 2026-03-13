import { API } from './constants'

/** R-OD1: Option expirations and strikes for a symbol (IB reqSecDefOptParams). Includes last_price from stock_day when available. */
export async function fetchOptionExpirations(symbol: string): Promise<{
  symbol: string
  expirations: string[]
  strikes?: number[]
  last_price?: number
  error?: string
}> {
  const s = (symbol || '').trim()
  if (!s) return { symbol: '', expirations: [], error: 'symbol is required' }
  const r = await fetch(`${API}/research/option-expirations?symbol=${encodeURIComponent(s)}`)
  const j = await r.json().catch(() => ({}))
  const strikes: number[] | undefined = Array.isArray(j.strikes)
    ? (j.strikes.filter((x: unknown) => typeof x === 'number' && Number.isFinite(x)) as number[])
    : undefined
  const last_price =
    j.last_price != null && Number.isFinite(Number(j.last_price)) ? Number(j.last_price) : undefined
  return {
    symbol: j.symbol ?? s,
    expirations: Array.isArray(j.expirations) ? j.expirations : [],
    ...(strikes !== undefined ? { strikes } : {}),
    ...(last_price !== undefined ? { last_price } : {}),
    error: j.error,
  }
}

export interface OptionSnapshotRow {
  strike: number
  right: string
  bid: number | null
  ask: number | null
  last: number | null
  mid: number | null
}

/** OD.3: Option snapshot (bid/ask/last/mid) for symbol + expiration with optional strikes. */
export async function fetchOptionSnapshot(
  symbol: string,
  expiration: string,
  strikes?: number[],
): Promise<{
  symbol: string
  expiration: string
  underlying_price?: number
  rows: OptionSnapshotRow[]
  error?: string
}> {
  const s = (symbol || '').trim()
  const e = (expiration || '').trim()
  if (!s || !e) {
    return { symbol: s, expiration: e, rows: [], error: 'symbol and expiration are required' }
  }
  const body = { symbol: s, expiration: e, ...(strikes != null ? { strikes } : {}) }
  const r = await fetch(`${API}/research/option-snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  const rows: OptionSnapshotRow[] = Array.isArray(j.rows)
    ? j.rows.map((row: Record<string, unknown>) => ({
        strike: Number(row.strike),
        right: String(row.right ?? ''),
        bid: row.bid != null && Number.isFinite(Number(row.bid)) ? Number(row.bid) : null,
        ask: row.ask != null && Number.isFinite(Number(row.ask)) ? Number(row.ask) : null,
        last: row.last != null && Number.isFinite(Number(row.last)) ? Number(row.last) : null,
        mid: row.mid != null && Number.isFinite(Number(row.mid)) ? Number(row.mid) : null,
      }))
    : []
  return {
    symbol: j.symbol ?? s,
    expiration: j.expiration ?? e,
    ...(j.underlying_price != null && Number.isFinite(Number(j.underlying_price))
      ? { underlying_price: Number(j.underlying_price) }
      : {}),
    rows,
    error: j.error,
  }
}
