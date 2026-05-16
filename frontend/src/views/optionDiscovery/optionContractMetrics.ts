import type { OptionSnapshotRow } from '../../api'

/** Normalize option right for chain pairing (C / P). */
export function normalizeOptionRight(r: string): 'C' | 'P' | null {
  const x = (r || '').trim().toUpperCase()
  if (x === 'C' || x === 'CALL') return 'C'
  if (x === 'P' || x === 'PUT') return 'P'
  return null
}

/** Stable key for a snapshot row: `${strike}|C` or `${strike}|P`. */
export function optionContractKey(row: OptionSnapshotRow): string | null {
  const nr = normalizeOptionRight(row.right)
  if (nr == null || !Number.isFinite(row.strike)) return null
  return `${row.strike}|${nr}`
}

/**
 * Default selected chain row: strike closest to underlying (ATM), prefer Call at that strike.
 * Returns contract key or null if rows empty.
 */
export function defaultSnapshotContractKey(
  rows: OptionSnapshotRow[],
  underlyingFromResponse: number | null,
  fallbackSpot: number | null,
): string | null {
  if (rows.length === 0) return null
  const spot =
    underlyingFromResponse != null && Number.isFinite(underlyingFromResponse) && underlyingFromResponse > 0
      ? underlyingFromResponse
      : fallbackSpot != null && Number.isFinite(fallbackSpot) && fallbackSpot > 0
        ? fallbackSpot
        : null
  if (spot == null) {
    const first = rows[0]
    return first ? optionContractKey(first) : null
  }
  const strikes = [...new Set(rows.map(r => r.strike).filter(s => Number.isFinite(s)))] as number[]
  if (strikes.length === 0) return optionContractKey(rows[0]!) ?? null
  strikes.sort((a, b) => a - b)
  let bestK = strikes[0]!
  let bestD = Math.abs(bestK - spot)
  for (const k of strikes) {
    const d = Math.abs(k - spot)
    if (d < bestD || (d === bestD && k < bestK)) {
      bestD = d
      bestK = k
    }
  }
  const callRow = rows.find(r => r.strike === bestK && normalizeOptionRight(r.right) === 'C')
  if (callRow) return optionContractKey(callRow)
  const putRow = rows.find(r => r.strike === bestK && normalizeOptionRight(r.right) === 'P')
  if (putRow) return optionContractKey(putRow)
  const anyRow = rows.find(r => r.strike === bestK)
  return anyRow ? optionContractKey(anyRow) : optionContractKey(rows[0]!) ?? null
}

export interface DerivedMetrics {
  spread: number | null
  spreadPct: number | null
  intrinsic: number | null
  extrinsic: number | null
  breakeven: number | null
  moneyness: number | null
  moneynessLabel: 'ITM' | 'ATM' | 'OTM' | '—'
}

/**
 * Mark for decomposition: API `mark` (Massive PG: day_close), else IB mid / NBBO / last / day close.
 */
export function effectiveQuotePremium(row: OptionSnapshotRow): number | null {
  if (row.mark != null && Number.isFinite(row.mark) && row.mark >= 0) return row.mark
  const { bid, ask, mid, last, day_close: dayClose } = row
  if (mid != null && Number.isFinite(mid) && mid >= 0) return mid
  if (bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2
  if (last != null && Number.isFinite(last) && last >= 0) return last
  if (dayClose != null && Number.isFinite(dayClose) && dayClose >= 0) return dayClose
  return null
}

export function computeDerivedMetrics(row: OptionSnapshotRow, underlying: number | null): DerivedMetrics {
  const bid = row.bid
  const ask = row.ask
  const strike = row.strike
  const nr = normalizeOptionRight(row.right)
  const isCall = nr !== 'P'

  const mark = effectiveQuotePremium(row)

  const spread = bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null
  const spreadPct = spread != null && mark != null && mark > 0 ? (spread / mark) * 100 : null

  let intrinsic: number | null = null
  let extrinsic: number | null = null
  let breakeven: number | null = null
  let moneyness: number | null = null
  let moneynessLabel: 'ITM' | 'ATM' | 'OTM' | '—' = '—'

  if (underlying != null && Number.isFinite(underlying) && underlying > 0) {
    intrinsic = isCall ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying)
    if (mark != null && Number.isFinite(mark)) {
      extrinsic = Math.max(0, mark - (intrinsic ?? 0))
      breakeven = isCall ? strike + mark : strike - mark
    }
    moneyness = ((underlying - strike) / underlying) * 100 * (isCall ? 1 : -1)
    const threshold = 0.5
    if (Math.abs(moneyness) < threshold) moneynessLabel = 'ATM'
    else if (moneyness > 0) moneynessLabel = 'ITM'
    else moneynessLabel = 'OTM'
  }

  return { spread, spreadPct, intrinsic, extrinsic, breakeven, moneyness, moneynessLabel }
}

export function parseDteNumeric(expiration: string): number | null {
  const s = (expiration || '').trim()
  if (!s) return null
  let y = 0,
    m = 0,
    d = 0
  if (/^\d{8}$/.test(s)) {
    y = parseInt(s.slice(0, 4), 10)
    m = parseInt(s.slice(4, 6), 10) - 1
    d = parseInt(s.slice(6, 8), 10)
  } else {
    const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (match) {
      y = parseInt(match[1], 10)
      m = parseInt(match[2], 10) - 1
      d = parseInt(match[3], 10)
    } else return null
  }
  const expDate = new Date(y, m, d)
  if (Number.isNaN(expDate.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  expDate.setHours(0, 0, 0, 0)
  const days = Math.round((expDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  return days >= 0 ? days : null
}

export interface TradabilityResult {
  score: number
  factors: { label: string; contribution: number; detail: string }[]
}

export function computeTradabilityScore(
  row: OptionSnapshotRow,
  _allRows: OptionSnapshotRow[],
  lastTradeAge: number | null,
  quoteUpdateCount: number | null,
): TradabilityResult {
  const factors: TradabilityResult['factors'] = []
  let total = 0

  const bid = row.bid
  const ask = row.ask
  const mid = row.mid
  if (bid != null && ask != null && mid != null && mid > 0) {
    const spreadPct = ((ask - bid) / mid) * 100
    const spreadScore = spreadPct < 2 ? 30 : spreadPct < 5 ? 22 : spreadPct < 10 ? 14 : spreadPct < 20 ? 6 : 0
    factors.push({ label: 'Spread', contribution: spreadScore, detail: `${spreadPct.toFixed(1)}%` })
    total += spreadScore
  } else {
    factors.push({ label: 'Spread', contribution: 0, detail: 'No bid/ask' })
  }

  const oi = row.open_interest
  if (oi != null && Number.isFinite(oi)) {
    const oiScore = oi >= 1000 ? 25 : oi >= 500 ? 20 : oi >= 100 ? 14 : oi >= 10 ? 7 : 2
    factors.push({ label: 'Open Interest', contribution: oiScore, detail: String(oi) })
    total += oiScore
  } else {
    factors.push({ label: 'Open Interest', contribution: 0, detail: 'N/A' })
  }

  if (quoteUpdateCount != null) {
    const qScore =
      quoteUpdateCount >= 20 ? 20 : quoteUpdateCount >= 10 ? 15 : quoteUpdateCount >= 5 ? 10 : quoteUpdateCount >= 1 ? 5 : 0
    factors.push({ label: 'Quote Activity', contribution: qScore, detail: `${quoteUpdateCount} updates` })
    total += qScore
  } else {
    factors.push({ label: 'Quote Activity', contribution: 5, detail: 'Unknown' })
    total += 5
  }

  if (lastTradeAge != null) {
    const ageMin = lastTradeAge / 60
    const tScore = ageMin < 5 ? 25 : ageMin < 30 ? 18 : ageMin < 120 ? 10 : ageMin < 1440 ? 4 : 0
    factors.push({
      label: 'Last Trade',
      contribution: tScore,
      detail: ageMin < 60 ? `${Math.round(ageMin)}m ago` : `${(ageMin / 60).toFixed(1)}h ago`,
    })
    total += tScore
  } else {
    factors.push({ label: 'Last Trade', contribution: 3, detail: 'Unknown' })
    total += 3
  }

  return { score: Math.min(100, Math.max(0, total)), factors: factors.sort((a, b) => b.contribution - a.contribution) }
}

export interface ScenarioResult {
  label: string
  pnl: number | null
  detail: string
}

export function computeScenarios(row: OptionSnapshotRow, underlying: number | null): ScenarioResult[] {
  if (underlying == null || !Number.isFinite(underlying) || underlying <= 0) return []
  const d = row.delta,
    g = row.gamma,
    v = row.vega
  if (d == null || !Number.isFinite(d)) return []

  const results: ScenarioResult[] = []
  const multiplier = 100

  const upPct = 0.01
  const upMove = underlying * upPct
  const pnlUp = (d * upMove + (g != null && Number.isFinite(g) ? 0.5 * g * upMove * upMove : 0)) * multiplier
  results.push({ label: 'S +1%', pnl: pnlUp, detail: `ΔS=$${upMove.toFixed(2)}` })

  const downPct = -0.01
  const downMove = underlying * downPct
  const ivBump = 2
  const pnlDown =
    (d * downMove + (g != null && Number.isFinite(g) ? 0.5 * g * downMove * downMove : 0) +
      (v != null && Number.isFinite(v) ? v * (ivBump / 100) : 0)) *
    multiplier
  results.push({ label: 'S -1%, IV +2pt', pnl: pnlDown, detail: `ΔS=$${downMove.toFixed(2)}, Δσ=+2pt` })

  return results
}

export interface RelativeValueResult {
  label: 'Rich' | 'Cheap' | 'Neutral' | '—'
  ivZScore: number | null
  neighborAvgIv: number | null
  neighborCount: number
}

export function computeRelativeValue(row: OptionSnapshotRow, allRows: OptionSnapshotRow[]): RelativeValueResult {
  if (row.iv == null || !Number.isFinite(row.iv)) return { label: '—', ivZScore: null, neighborAvgIv: null, neighborCount: 0 }
  const sameRight = allRows.filter(r => r.right === row.right && r.iv != null && Number.isFinite(r.iv!))
  if (sameRight.length < 3) return { label: '—', ivZScore: null, neighborAvgIv: null, neighborCount: sameRight.length }
  const ivs = sameRight.map(r => r.iv!)
  const mean = ivs.reduce((s, v) => s + v, 0) / ivs.length
  const std = Math.sqrt(ivs.reduce((s, v) => s + (v - mean) ** 2, 0) / ivs.length)
  if (std < 1e-8) return { label: 'Neutral', ivZScore: 0, neighborAvgIv: mean, neighborCount: sameRight.length }
  const z = (row.iv! - mean) / std
  const label = z > 1 ? 'Rich' : z < -1 ? 'Cheap' : 'Neutral'
  return { label, ivZScore: z, neighborAvgIv: mean, neighborCount: sameRight.length }
}

export function fmtOptNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** Format IV as percentage (raw decimal 0.52 → "52.34%"). */
export function fmtIV(iv: number | null | undefined): string {
  if (iv == null || !Number.isFinite(iv)) return '—'
  return (iv * 100).toFixed(2) + '%'
}
