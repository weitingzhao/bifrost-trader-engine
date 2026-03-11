import type { IbAccountSnapshot, RealtimeQuote } from '../../types'

export type DailyBenchmark = {
  bar_time: number
  close: number
  prev_close?: number | null
  is_today?: boolean
  is_stale?: boolean
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

export function computeDailyChange(
  bench: DailyBenchmark | undefined,
  currPrice: number | null,
  qty: number,
  dailyPrevClose?: number | null,
): { changePct: number | null; pnlVsBench: number | null } {
  if (currPrice == null || !Number.isFinite(currPrice)) {
    return { changePct: null, pnlVsBench: null }
  }
  let basePrice: number | null = null
  if (dailyPrevClose != null && Number.isFinite(dailyPrevClose) && dailyPrevClose > 0) {
    basePrice = dailyPrevClose
  } else if (bench && Number.isFinite(bench.close) && bench.close > 0) {
    const prevClose =
      bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0
        ? bench.prev_close
        : null
    basePrice = bench.is_today && prevClose != null ? prevClose : bench.close
  }
  if (basePrice == null || !Number.isFinite(basePrice) || basePrice <= 0) {
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
  const liveLast = args.liveQuote?.last
  if (liveLast != null && Number.isFinite(liveLast) && liveLast > 0) {
    return {
      price: liveLast,
      source: 'live',
      updatedAtSec:
        args.liveQuote?.ts != null && Number.isFinite(args.liveQuote.ts)
          ? args.liveQuote.ts
          : null,
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
