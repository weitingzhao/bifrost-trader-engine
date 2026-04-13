import type { IbAccountSnapshot, RealtimeQuote } from '../../types'

export type DailyBenchmark = {
  bar_time: number
  close: number
  prev_close?: number | null
  is_today?: boolean
  is_stale?: boolean
}

/** Normalize benchmark map keys to uppercase so UI rows match stock_day / ingestor symbol casing. */
export function normalizeBenchmarkMap(
  raw: Record<string, DailyBenchmark> | undefined | null,
): Record<string, DailyBenchmark> {
  const out: Record<string, DailyBenchmark> = {}
  if (!raw) return out
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toUpperCase()
    if (key && v && typeof v === 'object') out[key] = v as DailyBenchmark
  }
  return out
}

/** Display price for streams: last trade if present, else mid (ingestor often has bid/ask only). */
export function quoteDisplayLast(q: { last?: number | null; mid?: number | null } | undefined | null): number | null {
  if (!q) return null
  const last = q.last != null ? Number(q.last) : NaN
  if (Number.isFinite(last) && last > 0) return last
  const mid = q.mid != null ? Number(q.mid) : NaN
  if (Number.isFinite(mid) && mid > 0) return mid
  return null
}

/** True when quote is equity stream for quotesMap merge (OPT rows must not overwrite underlying symbol). */
export function isStkStreamQuote(q: RealtimeQuote): boolean {
  const st = (q.sec_type ?? '').toString().toUpperCase()
  if (st === 'STK') return true
  const ck = (q.contract_key ?? '').trim()
  return ck.includes('|STK|')
}

/** Merge GET /quotes or SSE items into a symbol-keyed map (uppercase STK keys). */
export function mergeQuotesIntoSymbolMap(
  prev: Record<string, RealtimeQuote>,
  quotes: RealtimeQuote[],
): Record<string, RealtimeQuote> {
  const next = { ...prev }
  for (const q of quotes) {
    const sym = (q.symbol ?? '').trim()
    if (!sym) continue
    const mapKey = sym.toUpperCase()
    if (isStkStreamQuote(q) || !q.contract_key) {
      next[mapKey] = q
    }
  }
  return next
}

export type PriceSource = 'live' | 'db' | 'daemon' | null

export function getNetLiq(a: IbAccountSnapshot): number {
  const v = a.summary?.NetLiquidation
  if (v == null) return 0
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

export function rightLabel(r: string | undefined): string {
  if (!r) return '—'
  const u = String(r).toUpperCase()
  if (u === 'C' || u === 'CALL') return 'Call'
  if (u === 'P' || u === 'PUT') return 'Put'
  return r
}

/** Display elapsed since price_updated_at (Unix sec): seconds → minutes → hours → days. */
export function formatLastUpdate(updatedAtSec: number | null | undefined): string {
  if (updatedAtSec == null || !Number.isFinite(updatedAtSec)) return '—'
  const nowSec = Date.now() / 1000
  const elapsed = Math.max(0, Math.floor(nowSec - updatedAtSec))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`
  return `${Math.floor(elapsed / 86400)}d`
}

export function optionIntrinsic(isCall: boolean, k: number, s: number): number {
  return isCall ? Math.max(0, s - k) : Math.max(0, k - s)
}

export function optionMoneyness(isCall: boolean, k: number, s: number): string {
  if (!Number.isFinite(k) || !Number.isFinite(s)) return '—'
  if (Math.abs(s - k) < 0.01) return 'ATM'
  if (isCall) return s > k ? 'ITM' : 'OTM'
  return s < k ? 'ITM' : 'OTM'
}

/**
 * Prior close for Daily % / Daily $ (same precedence as Accounts STK rows):
 * position daily_prev_close from IB when present, else stock_day benchmark bar.
 */
export function resolveDailyBasePrice(
  bench: DailyBenchmark | undefined,
  dailyPrevCloseFromPosition?: number | null,
): number | null {
  if (dailyPrevCloseFromPosition != null && Number.isFinite(dailyPrevCloseFromPosition) && dailyPrevCloseFromPosition > 0) {
    return dailyPrevCloseFromPosition
  }
  if (bench && Number.isFinite(bench.close) && bench.close > 0) {
    const prevClose =
      bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0
        ? bench.prev_close
        : null
    const base = bench.is_today && prevClose != null ? prevClose : bench.close
    return Number.isFinite(base) && base > 0 ? base : null
  }
  return null
}

export function computeDailyChange(
  bench: DailyBenchmark | undefined,
  currPrice: number | null,
  qty: number,
  dailyPrevClose?: number | null,
): { changePct: number | null; pnlVsBench: number | null } {
  if (currPrice == null || !Number.isFinite(currPrice)) {
    return { changePct: null, pnlVsBench: null }
  }
  const basePrice = resolveDailyBasePrice(bench, dailyPrevClose)
  if (basePrice == null) {
    return { changePct: null, pnlVsBench: null }
  }
  return {
    changePct: ((currPrice - basePrice) / basePrice) * 100,
    pnlVsBench: Number.isFinite(qty) ? (currPrice - basePrice) * qty : null,
  }
}

export function resolvePreferredPrice(args: {
  liveQuote?: RealtimeQuote
  dbPrice?: number | null
  dbUpdatedAt?: number | null
  daemonSpot?: number | null
  daemonUpdatedAt?: number | null
}): { price: number | null; source: PriceSource; updatedAtSec: number | null } {
  // Match Live / dashboard: use mid when last is absent (ingestor often has bid/ask only).
  const livePx = quoteDisplayLast(args.liveQuote)
  if (livePx != null && Number.isFinite(livePx) && livePx > 0) {
    const tsRaw = args.liveQuote?.ts
    const tsNum = tsRaw != null ? Number(tsRaw) : NaN
    return {
      price: livePx,
      source: 'live',
      updatedAtSec: Number.isFinite(tsNum) ? tsNum : null,
    }
  }
  if (args.dbPrice != null && Number.isFinite(args.dbPrice) && args.dbPrice > 0) {
    return {
      price: args.dbPrice,
      source: 'db',
      updatedAtSec:
        args.dbUpdatedAt != null && Number.isFinite(args.dbUpdatedAt)
          ? args.dbUpdatedAt
          : null,
    }
  }
  if (args.daemonSpot != null && Number.isFinite(args.daemonSpot) && args.daemonSpot > 0) {
    return {
      price: args.daemonSpot,
      source: 'daemon',
      updatedAtSec:
        args.daemonUpdatedAt != null && Number.isFinite(args.daemonUpdatedAt)
          ? args.daemonUpdatedAt
          : null,
    }
  }
  return { price: null, source: null, updatedAtSec: null }
}
