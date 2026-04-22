import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bsComputeDetail } from '../utils/bsCalc'
import type { StatusResponse, WatchlistItem } from '../types'
import {
  fetchWatchlist,
  fetchOptionExpirations,
  fetchBarsBenchmark,
  postWatchlist,
  fetchMassiveStatus,
  postMassiveSync,
  fetchOptionSnapshotsPg,
  pollMassiveJobUntilDone,
  fetchMassiveJob,
  fetchMassiveLastTrade,
  fetchMassiveHistQuotes,
  fetchGreeksCoverage,
  fetchLiquiditySummary,
  fetchRelativeValue,
  fetchMassiveDailyChecklist,
} from '../api'
import type {
  MassiveStatusResponse,
  GreeksCoverageResponse,
  LiquiditySummaryResponse,
  RelativeValueResponse,
  MassiveDailyChecklistDims,
  MassiveDailyDimBlock,
} from '../api'
import type { OptionSnapshotRow } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtUsd } from '../utils/format'
import { buildPolygonOptionsTicker } from '../utils/polygonOptionsTicker'
import { OptionDiscoveryMaxPainPanel } from './optionDiscovery/OptionDiscoveryMaxPainPanel'
import { OptionDiscoveryContractChartPanel } from './optionDiscovery/OptionDiscoveryContractChartPanel'
import { OptionDiscoveryAnalyticsPanel, IvSmileChart, IvSmileLegend } from './optionDiscovery/OptionDiscoveryAnalytics'
import type { IvTermPoint, IvVolConePoint } from './optionDiscovery/OptionDiscoveryAnalytics'
import { OdLayerSection } from './optionDiscovery/OdLayerSection'
import { OdChainExpiryBubblePicker } from './optionDiscovery/OdChainExpiryBubblePicker'
import { OptionDiscoveryIvTermSection } from './optionDiscovery/OptionDiscoveryIvTermSection'
import { OptionDiscoveryCompareDrawer, addCompareRow } from './optionDiscovery/OptionDiscoveryCompareDrawer'
import { OdChartExpandOnHover } from './optionDiscovery/OdChartExpandOnHover'
import {
  type ExpirationKind,
  classifyExpiration,
  expirationDaysFromToday,
  isOptionExpirationPastNyClose,
  parseExpirationDateParts,
} from './optionDiscovery/expirationMeta'

const STRIKE_COUNT_OPTIONS = [4, 6, 8, 19, 30, 'all'] as const
type StrikeCountOption = (typeof STRIKE_COUNT_OPTIONS)[number]

/** IV term structure: default count (expiration list order); server accepts up to 12 expirations per request. */
const IV_TERM_DEFAULT_EXPIRATIONS = 8
const IV_TERM_MAX_EXPIRATIONS = 12

/** Strike ladder & chain: show both sides, calls only, or puts only. */
type StrikeSideMode = 'all' | 'call' | 'put'

/** Option chain table: symmetric columns on call/put sides (TD-style). */
type ChainColumnId =
  | 'day_open'
  | 'day_high'
  | 'day_low'
  | 'day_close'
  | 'day_vol'
  | 'iv'
  | 'delta'
  | 'gamma'
  | 'theta'
  | 'vega'
  | 'oi'

const CHAIN_COLUMN_LABEL: Record<ChainColumnId, string> = {
  day_open: 'Open',
  day_high: 'High',
  day_low: 'Low',
  day_close: 'Close',
  day_vol: 'Vol',
  iv: 'IV',
  delta: 'Delta',
  gamma: 'Gamma',
  theta: 'Theta',
  vega: 'Vega',
  oi: 'OI',
}

const DEFAULT_CHAIN_COLUMN_VISIBILITY: Record<ChainColumnId, boolean> = {
  day_open: false,
  day_high: false,
  day_low: false,
  day_close: true,
  day_vol: false,
  iv: true,
  delta: true,
  gamma: false,
  theta: false,
  vega: false,
  oi: true,
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let tid: ReturnType<typeof setTimeout> | null = null
  const debounced = (...args: unknown[]) => {
    if (tid) clearTimeout(tid)
    tid = setTimeout(() => fn(...args), ms)
  }
  debounced.cancel = () => { if (tid) clearTimeout(tid) }
  return debounced as T & { cancel: () => void }
}

const STD_DEV_OPTIONS = [1, 1.5, 2, 2.5, 'custom'] as const
type StdDevOption = (typeof STD_DEV_OPTIONS)[number]

/**
 * Select a window of strikes around spot from a reference set (real listed contracts).
 * When spot is unknown, use the median of the reference set as a proxy.
 */
function computeStrikesFromPreset(
  allStrikes: number[],
  spot: number | null,
  strikeCount: StrikeCountOption,
  stdDevValue: number,
): number[] {
  if (allStrikes.length === 0) return []
  const sorted = [...allStrikes].sort((a, b) => a - b)
  const effectiveSpot =
    spot != null && spot > 0 ? spot : sorted[Math.floor(sorted.length / 2)]
  const halfWidth = stdDevValue * 0.1 * effectiveSpot
  const inRange = sorted.filter(s => s >= effectiveSpot - halfWidth && s <= effectiveSpot + halfWidth)
  if (strikeCount === 'all') return inRange
  const n = Math.min(Number(strikeCount), inRange.length)
  const half = Math.floor(n / 2)
  const below = inRange.filter(s => s < effectiveSpot).sort((a, b) => (effectiveSpot - a) - (effectiveSpot - b)).slice(0, half)
  const above = inRange.filter(s => s > effectiveSpot).sort((a, b) => (a - effectiveSpot) - (b - effectiveSpot)).slice(0, n - half)
  const at = inRange.filter(s => s === effectiveSpot)
  return [...new Set([...below, ...at, ...above])].sort((a, b) => a - b)
}

interface OptionDiscoveryPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  onOpenMassiveFeed?: () => void
  breadcrumbLabel?: string
}

/** STK symbols from Watchlist that are optionable (sec_type STK and optionable=true). */
function nyCalendarDateIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  if (y && m && d) return `${y}-${m}-${d}`
  return new Date().toISOString().slice(0, 10)
}

function formatDimShort(_key: string, block: MassiveDailyDimBlock | undefined): string {
  if (!block?.status) return '—'
  const st = block.status.toLowerCase()
  if (st === 'complete') return 'OK'
  if (st === 'missing') return 'missing'
  if (st === 'partial') return 'partial'
  if (st === 'degraded') return 'degraded'
  return block.status
}

function formatSnapshotTime(block: MassiveDailyDimBlock | undefined): string {
  if (!block?.last_ts) return formatDimShort('daily-snapshot', block)
  const m = /T(\d{2}:\d{2})/.exec(block.last_ts)
  return m ? `OK ${m[1]}` : 'OK'
}

function useWatchlistStkSymbols(): string[] {
  const [items, setItems] = useState<WatchlistItem[]>([])
  useEffect(() => {
    let cancelled = false
    fetchWatchlist()
      .then(res => { if (!cancelled) setItems(res.items || []) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [])
  return useMemo(() => {
    const syms = items
      .filter(i => (i.sec_type || '').trim().toUpperCase() !== 'OPT')
      .filter(i => i.optionable === true)
      .map(i => (i.symbol || '').trim())
      .filter(Boolean)
    return [...new Set(syms)].sort()
  }, [items])
}

function fmtOptNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** Format IV as percentage (raw decimal 0.52 → "52.34%"). */
function fmtIV(iv: number | null | undefined): string {
  if (iv == null || !Number.isFinite(iv)) return '—'
  return (iv * 100).toFixed(2) + '%'
}

/** Normalize option right for chain pairing (C / P). */
function normalizeOptionRight(r: string): 'C' | 'P' | null {
  const x = (r || '').trim().toUpperCase()
  if (x === 'C' || x === 'CALL') return 'C'
  if (x === 'P' || x === 'PUT') return 'P'
  return null
}

/**
 * Default selected chain row: strike closest to underlying (ATM), prefer Call at that strike.
 * Falls back to index 0 when spot is unknown (previous behavior was first row / often lowest strike).
 */
function defaultSnapshotContractIndex(
  rows: OptionSnapshotRow[],
  underlyingFromResponse: number | null,
  fallbackSpot: number | null,
): number {
  if (rows.length === 0) return 0
  const spot =
    underlyingFromResponse != null && Number.isFinite(underlyingFromResponse) && underlyingFromResponse > 0
      ? underlyingFromResponse
      : fallbackSpot != null && Number.isFinite(fallbackSpot) && fallbackSpot > 0
        ? fallbackSpot
        : null
  if (spot == null) return 0
  const strikes = [...new Set(rows.map(r => r.strike).filter(s => Number.isFinite(s)))] as number[]
  if (strikes.length === 0) return 0
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
  const callIdx = rows.findIndex(r => r.strike === bestK && normalizeOptionRight(r.right) === 'C')
  if (callIdx >= 0) return callIdx
  const putIdx = rows.findIndex(r => r.strike === bestK && normalizeOptionRight(r.right) === 'P')
  if (putIdx >= 0) return putIdx
  const anyIdx = rows.findIndex(r => r.strike === bestK)
  return anyIdx >= 0 ? anyIdx : 0
}

function fmtOiCompact(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return String(Math.round(n))
}

interface StrikeOiPair {
  c: number | null
  p: number | null
}

/** Strike cell: center line, Call OI bar left, Put OI bar right; compact C/P numbers below. */
function StrikeLadderOiStrikeCell({
  strike,
  oiMax,
  oiByStrike,
  showOi,
}: {
  strike: number
  oiMax: number
  oiByStrike: Map<number, StrikeOiPair>
  showOi: boolean
}) {
  if (!showOi) {
    return <td className="strike-ladder-cell-strike">{strike.toFixed(1)}</td>
  }
  const o = oiByStrike.get(strike)
  const c = o?.c ?? null
  const p = o?.p ?? null
  const denom = oiMax > 0 ? oiMax : 1
  const cw = c != null ? Math.min(100, (c / denom) * 100) : 0
  const pw = p != null ? Math.min(100, (p / denom) * 100) : 0
  return (
    <td className="strike-ladder-cell-strike strike-ladder-cell-strike--oi">
      <div className="strike-ladder-oi-cell">
        <div className="strike-ladder-oi-strike">{strike.toFixed(1)}</div>
        <div className="strike-ladder-oi-bar" aria-hidden="true">
          <div className="strike-ladder-oi-bar-half strike-ladder-oi-bar-half--call">
            <div className="strike-ladder-oi-bar-fill strike-ladder-oi-bar-fill--call" style={{ width: `${cw}%` }} />
          </div>
          <div className="strike-ladder-oi-bar-center" />
          <div className="strike-ladder-oi-bar-half strike-ladder-oi-bar-half--put">
            <div className="strike-ladder-oi-bar-fill strike-ladder-oi-bar-fill--put" style={{ width: `${pw}%` }} />
          </div>
        </div>
        <div className="strike-ladder-oi-nums" aria-label={`Call OI ${fmtOiCompact(c)}, Put OI ${fmtOiCompact(p)}`}>
          <span className="strike-ladder-oi-nums-c">C {fmtOiCompact(c)}</span>
          <span className="strike-ladder-oi-nums-p">P {fmtOiCompact(p)}</span>
        </div>
      </div>
    </td>
  )
}

// ── P0–P3: Contract detail types & derived metric helpers ──

interface DerivedMetrics {
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
function effectiveQuotePremium(row: OptionSnapshotRow): number | null {
  if (row.mark != null && Number.isFinite(row.mark) && row.mark >= 0) return row.mark
  const { bid, ask, mid, last, day_close: dayClose } = row
  if (mid != null && Number.isFinite(mid) && mid >= 0) return mid
  if (bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2
  if (last != null && Number.isFinite(last) && last >= 0) return last
  if (dayClose != null && Number.isFinite(dayClose) && dayClose >= 0) return dayClose
  return null
}


function computeDerivedMetrics(
  row: OptionSnapshotRow,
  underlying: number | null,
): DerivedMetrics {
  const bid = row.bid
  const ask = row.ask
  const strike = row.strike
  const nr = normalizeOptionRight(row.right)
  const isCall = nr !== 'P'

  const mark = effectiveQuotePremium(row)

  const spread = bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)
    ? ask - bid : null
  const spreadPct = spread != null && mark != null && mark > 0 ? (spread / mark) * 100 : null

  let intrinsic: number | null = null
  let extrinsic: number | null = null
  let breakeven: number | null = null
  let moneyness: number | null = null
  let moneynessLabel: 'ITM' | 'ATM' | 'OTM' | '—' = '—'

  if (underlying != null && Number.isFinite(underlying) && underlying > 0) {
    intrinsic = isCall
      ? Math.max(0, underlying - strike)
      : Math.max(0, strike - underlying)
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

function parseDteNumeric(expiration: string): number | null {
  const s = (expiration || '').trim()
  if (!s) return null
  let y = 0, m = 0, d = 0
  if (/^\d{8}$/.test(s)) {
    y = parseInt(s.slice(0, 4), 10)
    m = parseInt(s.slice(4, 6), 10) - 1
    d = parseInt(s.slice(6, 8), 10)
  } else {
    const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (match) { y = parseInt(match[1], 10); m = parseInt(match[2], 10) - 1; d = parseInt(match[3], 10) }
    else return null
  }
  const expDate = new Date(y, m, d)
  if (Number.isNaN(expDate.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  expDate.setHours(0, 0, 0, 0)
  const days = Math.round((expDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  return days >= 0 ? days : null
}

// ── P1: Tradability Score (rule-based, client-side) ──

interface TradabilityResult {
  score: number
  factors: { label: string; contribution: number; detail: string }[]
}

function computeTradabilityScore(
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
    const qScore = quoteUpdateCount >= 20 ? 20 : quoteUpdateCount >= 10 ? 15 : quoteUpdateCount >= 5 ? 10 : quoteUpdateCount >= 1 ? 5 : 0
    factors.push({ label: 'Quote Activity', contribution: qScore, detail: `${quoteUpdateCount} updates` })
    total += qScore
  } else {
    factors.push({ label: 'Quote Activity', contribution: 5, detail: 'Unknown' })
    total += 5
  }

  if (lastTradeAge != null) {
    const ageMin = lastTradeAge / 60
    const tScore = ageMin < 5 ? 25 : ageMin < 30 ? 18 : ageMin < 120 ? 10 : ageMin < 1440 ? 4 : 0
    factors.push({ label: 'Last Trade', contribution: tScore, detail: ageMin < 60 ? `${Math.round(ageMin)}m ago` : `${(ageMin / 60).toFixed(1)}h ago` })
    total += tScore
  } else {
    factors.push({ label: 'Last Trade', contribution: 3, detail: 'Unknown' })
    total += 3
  }

  return { score: Math.min(100, Math.max(0, total)), factors: factors.sort((a, b) => b.contribution - a.contribution) }
}

// ── P2: Scenario PnL estimation (Delta/Gamma/Vega first/second order) ──

interface ScenarioResult {
  label: string
  pnl: number | null
  detail: string
}

function computeScenarios(
  row: OptionSnapshotRow,
  underlying: number | null,
): ScenarioResult[] {
  if (underlying == null || !Number.isFinite(underlying) || underlying <= 0) return []
  const d = row.delta, g = row.gamma, v = row.vega
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
  const pnlDown = (d * downMove + (g != null && Number.isFinite(g) ? 0.5 * g * downMove * downMove : 0)
    + (v != null && Number.isFinite(v) ? v * (ivBump / 100) : 0)) * multiplier
  results.push({ label: 'S -1%, IV +2pt', pnl: pnlDown, detail: `ΔS=$${downMove.toFixed(2)}, Δσ=+2pt` })

  return results
}

// ── P2: Relative Value (IV z-score vs neighbors in same expiry) ──

interface RelativeValueResult {
  label: 'Rich' | 'Cheap' | 'Neutral' | '—'
  ivZScore: number | null
  neighborAvgIv: number | null
  neighborCount: number
}

function computeRelativeValue(
  row: OptionSnapshotRow,
  allRows: OptionSnapshotRow[],
): RelativeValueResult {
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

export function OptionDiscoveryPage({
  status: _status,
  onGoToScreener,
  onOpenMassiveFeed,
  breadcrumbLabel = 'Option Discovery',
}: OptionDiscoveryPageProps) {
  const stkSymbols = useWatchlistStkSymbols()
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [expirations, setExpirations] = useState<string[]>([])
  const [strikes, setStrikes] = useState<number[]>([])
  const [stockDayLastPrice, setStockDayLastPrice] = useState<number | null>(null)
  const [expirationsError, setExpirationsError] = useState<string | null>(null)
  const [selectedExpiration, setSelectedExpiration] = useState('')
  const [expirationsLoading, setExpirationsLoading] = useState(false)
  const [expirationFilterKind, setExpirationFilterKind] = useState<ExpirationKind>('all')
  const [strikesLoading, setStrikesLoading] = useState(false)
  const [snapshotRows, setSnapshotRows] = useState<OptionSnapshotRow[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotFeedback, setSnapshotFeedback] = useState<{
    level: 'error' | 'warning' | 'info'
    title?: string
    body: string
  } | null>(null)
  /** True after user clicked Load quotes at least once (avoids misleading empty hint). */
  const [snapshotLoadAttempted, setSnapshotLoadAttempted] = useState(false)
  /** After a Massive warning, poll PG until rows appear or timeout (no extra Celery enqueue). */
  const [snapshotPgWatching, setSnapshotPgWatching] = useState(false)
  const [snapshotPgWatchSecondsLeft, setSnapshotPgWatchSecondsLeft] = useState<number | null>(null)
  const snapshotWatchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const snapshotWatchGenRef = useRef(0)
  const [underlyingPrice, setUnderlyingPrice] = useState<number | null>(null)
  const [addWatchlistFeedback, setAddWatchlistFeedback] = useState<string | null>(null)
  const [strikeCountOption, setStrikeCountOption] = useState<StrikeCountOption>(30)
  const [stdDevOption, setStdDevOption] = useState<StdDevOption>(2)
  const [customStdDev, setCustomStdDev] = useState<string>('2')
  const [multiSelectStrikes, setMultiSelectStrikes] = useState<number[]>([])
  const [strikeSideMode, setStrikeSideMode] = useState<StrikeSideMode>('all')
  const [chainColumnVisibility, setChainColumnVisibility] = useState<Record<ChainColumnId, boolean>>(
    () => ({ ...DEFAULT_CHAIN_COLUMN_VISIBILITY }),
  )
  const [symbolDailyPrices, setSymbolDailyPrices] = useState<Record<string, number | null>>({})
  /** Draft text for underlying; `selectedSymbol` updates only on Apply / Enter or chip click. */
  const [underlyingInput, setUnderlyingInput] = useState('')
  const otmCallWrapRef = useRef<HTMLDivElement>(null)

  // P0–P3: Contract detail panel state
  const [selectedContractIdx, setSelectedContractIdx] = useState<number | null>(null)
  /** Greeks card source: 'snapshot' = Massive data, 'bs' = local Black-Scholes calculation */
  const [greeksSource, setGreeksSource] = useState<'snapshot' | 'bs'>('snapshot')
  /** Timestamp of last successful option quotes load */
  const [lastQuotesLoadTs, setLastQuotesLoadTs] = useState<Date | null>(null)

  // P1: Liquidity async data
  const [liquidityLastTrade, setLiquidityLastTrade] = useState<Record<string, unknown> | null>(null)
  const [liquidityQuoteCount, setLiquidityQuoteCount] = useState<number | null>(null)
  const [liquidityLoading, setLiquidityLoading] = useState(false)

  // P1: Server-side liquidity summary
  const [serverLiquidity, setServerLiquidity] = useState<LiquiditySummaryResponse | null>(null)

  // P2: Greeks coverage for quality badge
  const [greeksCoverage, setGreeksCoverage] = useState<GreeksCoverageResponse | null>(null)

  // P2: Server-side relative value
  const [serverRelativeValue, setServerRelativeValue] = useState<RelativeValueResponse | null>(null)

  // IV term structure (Phase 2)
  const [termPoints, setTermPoints] = useState<IvTermPoint[]>([])
  const [termLoading, setTermLoading] = useState(false)
  const [termError, setTermError] = useState<string | null>(null)
  const [conePoints, setConePoints] = useState<IvVolConePoint[]>([])
  const [coneError, setConeError] = useState<string | null>(null)
  /** Subset of `expirations` (same order as the expiration list) to send to IV term API */
  const [ivTermExpKeys, setIvTermExpKeys] = useState<string[]>([])
  /** Massive: enqueue chain snapshot jobs for IV-term selection, then reload IV term */
  const [ivTermSyncLoading, setIvTermSyncLoading] = useState(false)
  const [ivTermSyncStatus, setIvTermSyncStatus] = useState<string | null>(null)
  /** Dedupes auto IV term load per symbol + expiration selection */
  const ivTermAutoLoadKeyRef = useRef<string>('')

  /** Expiration table + IV term chart: same All/Std/Wk/Qtr filter */
  const visibleExpirations = useMemo(() => {
    const byKind =
      expirationFilterKind === 'all'
        ? expirations
        : expirations.filter(exp => classifyExpiration(exp) === expirationFilterKind)
    return byKind.filter(exp => !isOptionExpirationPastNyClose(exp))
  }, [expirations, expirationFilterKind])

  const [compareOpen, setCompareOpen] = useState(false)
  const [compareRows, setCompareRows] = useState<OptionSnapshotRow[]>([])

  // P3: Event context
  const [eventContextWarnings, setEventContextWarnings] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => {
        if (!cancelled) {
          setMassiveStatus(s)
        }
      })
      .catch(() => {
        if (!cancelled) setMassiveStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const [dailyDims, setDailyDims] = useState<MassiveDailyChecklistDims | null>(null)
  const [dailyDimsDate, setDailyDimsDate] = useState<string | null>(null)
  const [dailyDimsLoading, setDailyDimsLoading] = useState(false)

  useEffect(() => {
    const sym = selectedSymbol.trim().toUpperCase()
    if (!sym || !massiveStatus?.configured) {
      setDailyDims(null)
      setDailyDimsDate(null)
      return
    }
    let cancelled = false
    setDailyDimsLoading(true)
    fetchMassiveDailyChecklist({ symbols: [sym], tradeDate: nyCalendarDateIso() })
      .then(res => {
        if (cancelled) return
        if (!res.ok || !res.symbols?.[sym]) {
          setDailyDims(null)
          setDailyDimsDate(null)
          return
        }
        setDailyDims(res.symbols[sym])
        setDailyDimsDate(res.trade_date ?? nyCalendarDateIso())
      })
      .catch(() => {
        if (!cancelled) {
          setDailyDims(null)
          setDailyDimsDate(null)
        }
      })
      .finally(() => {
        if (!cancelled) setDailyDimsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSymbol, massiveStatus?.configured])

  const stdDevValue = useMemo(() => {
    if (stdDevOption === 'custom') {
      const v = parseFloat(customStdDev)
      return Number.isFinite(v) && v > 0 ? v : 2
    }
    return Number(stdDevOption)
  }, [stdDevOption, customStdDev])

  const computedStrikes = useMemo(
    () =>
      computeStrikesFromPreset(strikes, stockDayLastPrice, strikeCountOption, stdDevValue),
    [strikes, stockDayLastPrice, strikeCountOption, stdDevValue],
  )

  const effectiveStrikes = useMemo(() => {
    if (multiSelectStrikes.length > 0) return multiSelectStrikes
    return computedStrikes
  }, [multiSelectStrikes, computedStrikes])

  /** Call/Put open interest per strike from last loaded quotes (for ladder energy bars). */
  const strikeOiByStrike = useMemo(() => {
    const m = new Map<number, StrikeOiPair>()
    for (const r of snapshotRows) {
      if (!Number.isFinite(r.strike)) continue
      const k = r.strike
      if (!m.has(k)) m.set(k, { c: null, p: null })
      const e = m.get(k)!
      const nr = normalizeOptionRight(r.right)
      const oi = r.open_interest != null && Number.isFinite(r.open_interest) ? r.open_interest : null
      if (nr === 'C') e.c = oi
      if (nr === 'P') e.p = oi
    }
    return m
  }, [snapshotRows])

  /** Scale OI bars within the current preset strike range. */
  const ladderOiMax = useMemo(() => {
    let max = 1
    for (const k of computedStrikes) {
      const o = strikeOiByStrike.get(k)
      if (!o) continue
      if (o.c != null) max = Math.max(max, o.c)
      if (o.p != null) max = Math.max(max, o.p)
    }
    return max
  }, [computedStrikes, strikeOiByStrike])

  const strikeLadderShowOi = snapshotRows.length > 0

  /** Stable key for PG watch cleanup when strike selection changes. */
  const strikesWatchKey = useMemo(
    () => effectiveStrikes.map(x => String(x)).join(','),
    [effectiveStrikes],
  )

  useEffect(() => {
    const el = otmCallWrapRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [computedStrikes, selectedSymbol])

  useEffect(() => {
    setUnderlyingInput(selectedSymbol.trim().toUpperCase())
  }, [selectedSymbol])

  useEffect(() => {
    const sym = selectedSymbol.trim().toUpperCase()
    if (!sym) {
      setSymbolDailyPrices({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark([sym])
      .then(({ benchmarks }) => {
        if (cancelled) return
        const b = benchmarks[sym]
        const close = b?.close != null && Number.isFinite(b.close) ? b.close : null
        setSymbolDailyPrices({ [sym]: close ?? null })
      })
      .catch(() => {
        if (!cancelled) setSymbolDailyPrices({})
      })
    return () => {
      cancelled = true
    }
  }, [selectedSymbol])

  const applyUnderlyingFromInput = useCallback(() => {
    const next = underlyingInput.trim().toUpperCase()
    setSelectedSymbol(next)
  }, [underlyingInput])

  const loadExpirations = useCallback(async (symbol: string) => {
    const s = (symbol || '').trim()
    if (!s) {
      setExpirations([])
      setStrikes([])
      setStockDayLastPrice(null)
      setExpirationsError(null)
      setSelectedExpiration('')
      return
    }
    setExpirationsLoading(true)
    setExpirationsError(null)
    try {
      const res = await fetchOptionExpirations(s, 'massive')
      setExpirations(res.expirations || [])
      setStockDayLastPrice(res.last_price ?? null)
      setExpirationsError(res.error ?? null)
      const firstExp = (res.expirations && res.expirations.length > 0 ? res.expirations[0] : '') || ''
      setSelectedExpiration(firstExp)
      setStrikes([])
    } catch {
      setExpirations([])
      setStrikes([])
      setStockDayLastPrice(null)
      setExpirationsError('Failed to load expirations')
      setSelectedExpiration('')
    } finally {
      setExpirationsLoading(false)
    }
  }, [])

  const loadStrikesForExpiration = useCallback(async (symbol: string, expiration: string) => {
    const s = (symbol || '').trim()
    const e = (expiration || '').trim()
    if (!s || !e) {
      setStrikes([])
      return
    }
    setStrikesLoading(true)
    try {
      const res = await fetchOptionExpirations(s, 'massive', { expiration: e })
      setStrikes(res.strikes ?? [])
      if (res.last_price != null) setStockDayLastPrice(res.last_price)
    } catch {
      setStrikes([])
    } finally {
      setStrikesLoading(false)
    }
  }, [])

  useEffect(() => {
    setMultiSelectStrikes([])
    setStrikes([])
    setStockDayLastPrice(null)
    if (selectedSymbol.trim()) {
      setExpirations([])
      setSelectedExpiration('')
      setExpirationsError(null)
      loadExpirations(selectedSymbol)
    } else {
      setExpirations([])
      setExpirationsError(null)
      setSelectedExpiration('')
    }
  }, [selectedSymbol, loadExpirations])

  useEffect(() => {
    setSnapshotLoadAttempted(false)
    setSnapshotFeedback(null)
  }, [selectedSymbol, selectedExpiration])

  useEffect(() => {
    setMultiSelectStrikes([])
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (sym && exp) {
      loadStrikesForExpiration(sym, exp)
    } else {
      setStrikes([])
    }
  }, [selectedExpiration, selectedSymbol, loadStrikesForExpiration])

  const stopSnapshotPgWatch = useCallback(() => {
    snapshotWatchGenRef.current += 1
    if (snapshotWatchIntervalRef.current != null) {
      clearInterval(snapshotWatchIntervalRef.current)
      snapshotWatchIntervalRef.current = null
    }
    setSnapshotPgWatching(false)
    setSnapshotPgWatchSecondsLeft(null)
  }, [])

  /** Poll PostgreSQL only (no new Celery job) until rows exist or timeout. */
  const startSnapshotPgWatch = useCallback((sym: string, exp: string, strikesCsv: string | undefined) => {
    if (snapshotWatchIntervalRef.current != null) {
      clearInterval(snapshotWatchIntervalRef.current)
      snapshotWatchIntervalRef.current = null
    }
    const gen = ++snapshotWatchGenRef.current
    const intervalMs = 3000
    const maxMs = 120_000
    const deadline = Date.now() + maxMs
    setSnapshotPgWatching(true)
    setSnapshotPgWatchSecondsLeft(Math.ceil(maxMs / 1000))

    const runTick = async () => {
      if (snapshotWatchGenRef.current !== gen) return
      const leftSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setSnapshotPgWatchSecondsLeft(leftSec)
      if (leftSec <= 0) {
        if (snapshotWatchGenRef.current === gen) {
          if (snapshotWatchIntervalRef.current != null) {
            clearInterval(snapshotWatchIntervalRef.current)
            snapshotWatchIntervalRef.current = null
          }
          setSnapshotPgWatching(false)
          setSnapshotPgWatchSecondsLeft(null)
        }
        return
      }
      try {
        const sn = await fetchOptionSnapshotsPg(sym, exp, strikesCsv, 'massive')
        if (snapshotWatchGenRef.current !== gen) return
        const rows = sn.rows ?? []
        if (rows.length > 0) {
          setSnapshotRows(rows)
          const up =
            sn.underlying_price != null && Number.isFinite(Number(sn.underlying_price))
              ? Number(sn.underlying_price)
              : null
          setSelectedContractIdx(defaultSnapshotContractIndex(rows, up, stockDayLastPrice))
          if (up != null) {
            setUnderlyingPrice(up)
          }
          setSnapshotFeedback(null)
          if (snapshotWatchIntervalRef.current != null) {
            clearInterval(snapshotWatchIntervalRef.current)
            snapshotWatchIntervalRef.current = null
          }
          setSnapshotPgWatching(false)
          setSnapshotPgWatchSecondsLeft(null)
        }
      } catch {
        /* ignore transient errors while watching */
      }
    }

    void runTick()
    snapshotWatchIntervalRef.current = setInterval(() => { void runTick() }, intervalMs)
  }, [stockDayLastPrice])

  useEffect(() => {
    stopSnapshotPgWatch()
  }, [selectedSymbol, selectedExpiration, strikesWatchKey, stopSnapshotPgWatch])

  useEffect(() => () => { stopSnapshotPgWatch() }, [stopSnapshotPgWatch])

  const loadIvTermStructure = useCallback(async () => {
    const sym = selectedSymbol.trim()
    const ordered = expirations.filter(e => ivTermExpKeys.includes(e))
    if (!sym || ordered.length < 2) return
    setTermLoading(true)
    setTermError(null)
    setConeError(null)
    setTermPoints([])
    setConePoints([])
    try {
      const { fetchIvTermStructure, fetchIvVolatilityCone } = await import('../api/research/research')
      const expSlice = ordered.slice(0, IV_TERM_MAX_EXPIRATIONS)
      const [res, coneRes] = await Promise.all([
        fetchIvTermStructure(sym, expSlice, 'massive'),
        fetchIvVolatilityCone(sym, expSlice, 'massive', 90),
      ])
      if (!res.ok) {
        setTermError(res.error ?? 'Failed to load IV term structure')
      } else {
        const pts = res.points ?? []
        if (pts.length < 2) {
          setTermError(
            'Not enough ATM IV in PostgreSQL for the checked expirations (need ≥2 with IV). Use Backfill snapshots (Massive) to enqueue chain jobs for the selection, or Load quotes in section 4 per expiration. You can check any expirations (up to 12), not only the first eight.',
          )
        } else {
          setTermError(null)
        }
        setTermPoints(pts)
      }
      if (!coneRes.ok) {
        setConeError(coneRes.error ?? 'Failed to load IV volatility cone')
        setConePoints([])
      } else {
        setConeError(null)
        setConePoints(coneRes.points ?? [])
      }
    } catch (e) {
      setTermError(e instanceof Error ? e.message : 'Failed to load IV term structure')
      setConeError(e instanceof Error ? e.message : 'Failed to load IV volatility cone')
    } finally {
      setTermLoading(false)
    }
  }, [selectedSymbol, expirations, ivTermExpKeys])

  useEffect(() => {
    if (!massiveStatus?.configured) return
    const sym = selectedSymbol.trim()
    if (!sym || expirationsLoading || expirationsError) return
    if (ivTermExpKeys.length < 2) return
    if (ivTermSyncLoading) return
    const key = `${sym}|${ivTermExpKeys.join(',')}`
    if (ivTermAutoLoadKeyRef.current === key) return
    const tid = window.setTimeout(() => {
      ivTermAutoLoadKeyRef.current = key
      void loadIvTermStructure()
    }, 400)
    return () => window.clearTimeout(tid)
  }, [
    massiveStatus?.configured,
    selectedSymbol,
    ivTermExpKeys,
    expirationsLoading,
    expirationsError,
    ivTermSyncLoading,
    loadIvTermStructure,
  ])

  const syncIvTermMassiveSnapshots = useCallback(async () => {
    const sym = selectedSymbol.trim()
    const ordered = expirations.filter(e => ivTermExpKeys.includes(e)).slice(0, IV_TERM_MAX_EXPIRATIONS)
    if (!sym || ordered.length < 2) return
    setIvTermSyncLoading(true)
    setTermError(null)
    setIvTermSyncStatus(null)
    try {
      for (let i = 0; i < ordered.length; i++) {
        const exp = ordered[i]
        setIvTermSyncStatus(`Massive chain snapshot ${i + 1}/${ordered.length} (${exp})…`)
        const massiveChainPayload: Record<string, unknown> = {
          underlying: sym,
          mode: 'chain',
          expiration_date: exp,
          limit: 250,
        }
        if (effectiveStrikes.length > 0) {
          massiveChainPayload.strike_price_gte = Math.min(...effectiveStrikes)
          massiveChainPayload.strike_price_lte = Math.max(...effectiveStrikes)
        }
        const sync = await postMassiveSync('feed_option_snapshots', massiveChainPayload)
        if (!sync.ok || !sync.job_id) {
          setTermError(sync.error ?? sync.message ?? `Massive sync failed for ${exp}`)
          return
        }
        const polled = await pollMassiveJobUntilDone(sync.job_id, { maxAttempts: 120, intervalMs: 1000 })
        if (!polled.ok) {
          setTermError(polled.error ?? `Massive job failed for ${exp}`)
          return
        }
      }
      setIvTermSyncStatus('Loading IV term structure…')
      await loadIvTermStructure()
    } catch (e) {
      setTermError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setIvTermSyncLoading(false)
      setIvTermSyncStatus(null)
    }
  }, [selectedSymbol, expirations, ivTermExpKeys, effectiveStrikes, loadIvTermStructure])

  const toggleIvTermExpiration = useCallback(
    (exp: string, checked: boolean) => {
      setIvTermExpKeys(prev => {
        const set = new Set(prev)
        if (checked) {
          if (set.size >= IV_TERM_MAX_EXPIRATIONS) return prev
          set.add(exp)
        } else {
          if (set.size <= 2 && set.has(exp)) return prev
          set.delete(exp)
        }
        return expirations.filter(e => set.has(e) && visibleExpirations.includes(e))
      })
    },
    [expirations, visibleExpirations],
  )

  const resetIvTermExpirationsToDefault = useCallback(() => {
    setIvTermExpKeys(visibleExpirations.slice(0, IV_TERM_DEFAULT_EXPIRATIONS).slice(0, IV_TERM_MAX_EXPIRATIONS))
  }, [visibleExpirations])

  const selectAllIvTermExpirations = useCallback(() => {
    setIvTermExpKeys(visibleExpirations.slice(0, IV_TERM_MAX_EXPIRATIONS))
  }, [visibleExpirations])

  /** Clears extra checks; keeps the first two expirations (minimum required for IV term). */
  const uncheckAllIvTermExpirations = useCallback(() => {
    if (visibleExpirations.length < 2) return
    setIvTermExpKeys(visibleExpirations.slice(0, 2))
  }, [visibleExpirations])

  useEffect(() => {
    setTermPoints([])
    setTermError(null)
    setConePoints([])
    setConeError(null)
    setIvTermExpKeys([])
    setIvTermSyncLoading(false)
    setIvTermSyncStatus(null)
    ivTermAutoLoadKeyRef.current = ''
  }, [selectedSymbol])

  useEffect(() => {
    if (visibleExpirations.length < 2) {
      setIvTermExpKeys([])
      return
    }
    setIvTermExpKeys(prev => {
      const def = visibleExpirations.slice(0, IV_TERM_DEFAULT_EXPIRATIONS).slice(0, IV_TERM_MAX_EXPIRATIONS)
      if (prev.length === 0) return def
      const kept = visibleExpirations.filter(e => prev.includes(e))
      if (kept.length >= 2) return kept.slice(0, IV_TERM_MAX_EXPIRATIONS)
      return def
    })
  }, [visibleExpirations])

  /** Full chain / strikes / quotes: stay on a valid row; default to first expiration after All/Std/Wk/Qtr filter. */
  useEffect(() => {
    if (visibleExpirations.length === 0) {
      setSelectedExpiration('')
      return
    }
    setSelectedExpiration(prev => (visibleExpirations.includes(prev) ? prev : visibleExpirations[0]))
  }, [visibleExpirations])

  const handleAddToCompare = useCallback((row: OptionSnapshotRow) => {
    setCompareRows(prev => addCompareRow(prev, row))
  }, [])

  const loadQuotes = useCallback(async () => {
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym || !exp) return
    const strikesToSend = effectiveStrikes.length > 0 ? effectiveStrikes : undefined
    stopSnapshotPgWatch()
    setSnapshotLoading(true)
    setSnapshotFeedback(null)
    setAddWatchlistFeedback(null)
    setSelectedContractIdx(null)
    setSnapshotLoadAttempted(true)
    try {
      // ── Massive path ──
      // Chain snapshot must match UI expiry/strikes: default API is ~10 rows with no filters (wrong contracts).
      const massiveChainPayload: Record<string, unknown> = {
        underlying: sym,
        mode: 'chain',
        expiration_date: exp,
        limit: 250,
      }
      if (strikesToSend && strikesToSend.length > 0) {
        const mn = Math.min(...strikesToSend)
        const mx = Math.max(...strikesToSend)
        massiveChainPayload.strike_price_gte = mn
        massiveChainPayload.strike_price_lte = mx
      }
      const sync = await postMassiveSync('feed_option_snapshots', massiveChainPayload)
      if (!sync.ok || !sync.job_id) {
        setSnapshotFeedback({ level: 'error', title: 'Sync failed', body: sync.error ?? sync.message ?? 'Massive sync failed' })
        setSnapshotRows([])
        setUnderlyingPrice(null)
        return
      }
      const polled = await pollMassiveJobUntilDone(sync.job_id, { maxAttempts: 120, intervalMs: 1000 })
      if (!polled.ok) {
        setSnapshotFeedback({ level: 'error', title: 'Job failed', body: polled.error ?? 'Massive job failed' })
        setSnapshotRows([])
        setUnderlyingPrice(null)
        return
      }
      const strikesCsv =
        strikesToSend && strikesToSend.length > 0 ? strikesToSend.map(x => String(x)).join(',') : undefined
      const sn = await fetchOptionSnapshotsPg(sym, exp, strikesCsv, 'massive')
      const rows = sn.rows ?? []
      setSnapshotRows(rows)
      setLastQuotesLoadTs(new Date())
      const up =
        sn.underlying_price != null && Number.isFinite(Number(sn.underlying_price))
          ? Number(sn.underlying_price)
          : null
      setUnderlyingPrice(up)

      if (rows.length > 0) {
        setSelectedContractIdx(defaultSnapshotContractIndex(rows, up, stockDayLastPrice))
        setSnapshotFeedback(null)
        return
      }

      // rows empty — determine the right feedback level
      if (sn.error) {
        setSnapshotFeedback({ level: 'error', body: sn.error })
        return
      }
      if (sn.warning) {
        setSnapshotFeedback({ level: 'warning', title: 'No snapshot rows matched', body: sn.warning })
        startSnapshotPgWatch(sym, exp, strikesCsv)
        return
      }

      // Neither error nor warning from backend — inspect job result
      const jobRes = await fetchMassiveJob(sync.job_id)
      const result = jobRes.job?.result as Record<string, unknown> | undefined
      const rw = result?.rows_written
      if (typeof rw === 'number' && rw === 0) {
        setSnapshotFeedback({
          level: 'warning',
          title: 'Snapshot wrote 0 rows',
          body: 'Massive chain snapshot completed but wrote 0 rows. The API may have returned empty data, or the Celery worker skipped inserts. Check Massive API key, symbol validity, and Celery logs.',
        })
      } else if (typeof rw === 'number' && rw > 0) {
        setSnapshotFeedback({
          level: 'warning',
          title: 'Contract key mismatch',
          body: `${rw} rows were written to PostgreSQL but none matched this expiration/strikes. Verify that the selected expiry and strikes exist in the Massive chain data.`,
        })
      } else {
        setSnapshotFeedback({
          level: 'warning',
          body: 'No quotes returned. Ensure Celery worker is running and consuming the Massive snapshot queue.',
        })
      }
      startSnapshotPgWatch(sym, exp, strikesCsv)
    } catch (e) {
      setSnapshotFeedback({ level: 'error', body: e instanceof Error ? e.message : 'Failed to load quotes' })
      setSnapshotRows([])
      setUnderlyingPrice(null)
    } finally {
      setSnapshotLoading(false)
    }
  }, [selectedSymbol, selectedExpiration, effectiveStrikes, stopSnapshotPgWatch, startSnapshotPgWatch, stockDayLastPrice])

  // Auto-load quotes when symbol / expiration / strikes / source change (debounced)
  const loadQuotesDebounced = useMemo(() => debounce(() => { void loadQuotes() }, 400), [loadQuotes])
  useEffect(() => {
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym || !exp) return
    loadQuotesDebounced()
    return () => loadQuotesDebounced.cancel()
  }, [selectedSymbol, selectedExpiration, effectiveStrikes.join(','), loadQuotesDebounced])

  const handleAddToWatchlist = useCallback(
    async (row: OptionSnapshotRow) => {
      const sym = selectedSymbol.trim()
      const exp = selectedExpiration.trim()
      if (!sym || !exp) return
      const contract_key = `${sym}|OPT|${exp}|${row.strike}|${row.right}`
      setAddWatchlistFeedback(null)
      const res = await postWatchlist({
        contract_key,
        symbol: sym,
        sec_type: 'OPT',
        expiry: exp,
        strike: row.strike,
        option_right: row.right,
        source: 'option_discovery',
      })
      if (res.ok) setAddWatchlistFeedback(contract_key)
      else setAddWatchlistFeedback(res.error ?? 'Add failed')
    },
    [selectedSymbol, selectedExpiration],
  )

  // P1: Load liquidity data when a contract is selected (Massive source only)
  useEffect(() => {
    if (selectedContractIdx == null) {
      setLiquidityLastTrade(null)
      setLiquidityQuoteCount(null)
      setServerLiquidity(null)
      return
    }
    const row = snapshotRows[selectedContractIdx]
    if (!row) return
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym || !exp) return
    const optTicker = buildPolygonOptionsTicker(sym, exp, row.strike, row.right)
    let cancelled = false
    setLiquidityLoading(true)
    Promise.allSettled([
      fetchMassiveLastTrade(optTicker),
      fetchMassiveHistQuotes(optTicker, { limit: 50 }),
      fetchLiquiditySummary(sym, selectedExpiration.trim(), row.strike, row.right, 'massive'),
    ]).then(([tradeRes, quotesRes, liqRes]) => {
      if (cancelled) return
      if (tradeRes.status === 'fulfilled' && tradeRes.value.ok && tradeRes.value.results) {
        setLiquidityLastTrade(tradeRes.value.results)
      } else {
        setLiquidityLastTrade(null)
      }
      if (quotesRes.status === 'fulfilled' && quotesRes.value.ok && quotesRes.value.count != null) {
        setLiquidityQuoteCount(quotesRes.value.count)
      } else {
        setLiquidityQuoteCount(null)
      }
      if (liqRes.status === 'fulfilled' && liqRes.value.ok) {
        setServerLiquidity(liqRes.value)
      } else {
        setServerLiquidity(null)
      }
      setLiquidityLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedContractIdx, snapshotRows, selectedSymbol, selectedExpiration])

  // P2: Load greeks coverage when quotes arrive (Massive source only)
  useEffect(() => {
    if (snapshotRows.length === 0) {
      setGreeksCoverage(null)
      return
    }
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym) return
    let cancelled = false
    fetchGreeksCoverage(sym, exp, 'massive').then(r => {
      if (!cancelled) setGreeksCoverage(r)
    }).catch(() => { if (!cancelled) setGreeksCoverage(null) })
    return () => { cancelled = true }
  }, [snapshotRows.length, selectedSymbol, selectedExpiration])

  // P2: Load server-side relative value when contract selected
  useEffect(() => {
    if (selectedContractIdx == null) {
      setServerRelativeValue(null)
      return
    }
    const row = snapshotRows[selectedContractIdx]
    if (!row) return
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym || !exp) return
    let cancelled = false
    fetchRelativeValue(sym, exp, row.strike, row.right, 'massive').then(r => {
      if (!cancelled) setServerRelativeValue(r)
    }).catch(() => { if (!cancelled) setServerRelativeValue(null) })
    return () => { cancelled = true }
  }, [selectedContractIdx, snapshotRows, selectedSymbol, selectedExpiration])

  // P3: Build event context warnings
  useEffect(() => {
    const warnings: string[] = []
    const dte = parseDteNumeric(selectedExpiration)
    if (dte != null && dte <= 3) warnings.push(`DTE is ${dte} — high theta decay, exercise/assignment risk.`)
    if (dte != null && dte === 0) warnings.push('Expiration day — avoid market orders, liquidity may vanish.')
    if (greeksCoverage?.freshness?.stale_rows != null && greeksCoverage.freshness.stale_rows > 0) {
      warnings.push(`${greeksCoverage.freshness.stale_rows} stale snapshot row(s) older than 24h.`)
    }
    setEventContextWarnings(warnings)
  }, [selectedExpiration, greeksCoverage])

  // Derived: selected row and its metrics
  const selectedRow = selectedContractIdx != null ? snapshotRows[selectedContractIdx] ?? null : null
  const selectedDerived = useMemo(() => {
    if (!selectedRow) return null
    return computeDerivedMetrics(selectedRow, underlyingPrice)
  }, [selectedRow, underlyingPrice])

  // overviewMidDisplay removed — Price card now shows day OHLC instead of bid/ask/mid

  const canLoadQuotes = selectedSymbol.trim() !== '' && selectedExpiration.trim() !== '' && !snapshotLoading

  const showCallSide = strikeSideMode === 'all' || strikeSideMode === 'call'
  const showPutSide = strikeSideMode === 'all' || strikeSideMode === 'put'

  const chainColumnList = useMemo((): ChainColumnId[] => {
    const order: ChainColumnId[] = [
      'day_open',
      'day_high',
      'day_low',
      'day_close',
      'day_vol',
      ...(['iv', 'delta', 'gamma', 'theta', 'vega', 'oi'] as const satisfies readonly ChainColumnId[]),
    ]
    return order.filter(id => chainColumnVisibility[id] !== false)
  }, [chainColumnVisibility])

  const chainStrikesSorted = useMemo(() => {
    const set = new Set<number>()
    for (const r of snapshotRows) {
      if (Number.isFinite(r.strike)) set.add(r.strike)
    }
    return [...set].sort((a, b) => a - b)
  }, [snapshotRows])

  const rowIndexByStrikeRight = useMemo(() => {
    const m = new Map<string, number>()
    snapshotRows.forEach((row, idx) => {
      const nr = normalizeOptionRight(row.right)
      if (nr != null) m.set(`${row.strike}|${nr}`, idx)
    })
    return m
  }, [snapshotRows])

  const toggleChainColumn = useCallback((id: ChainColumnId) => {
    setChainColumnVisibility(prev => {
      const on = prev[id] !== false
      return { ...prev, [id]: !on }
    })
  }, [])

  /** BS-computed Greeks for every snapshot row (used when greeksSource === 'bs'). */
  const bsRowValues = useMemo(() => {
    if (snapshotRows.length === 0 || underlyingPrice == null) return [] as (ReturnType<typeof bsComputeDetail> | null)[]
    const parts = parseExpirationDateParts(selectedExpiration)
    if (!parts) return [] as (ReturnType<typeof bsComputeDetail> | null)[]
    const { y, m, d } = parts
    const expDate = new Date(y, m, d)
    expDate.setHours(0, 0, 0, 0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dteDays = Math.max(0, Math.round((expDate.getTime() - today.getTime()) / 86400000))
    if (dteDays === 0) return [] as (ReturnType<typeof bsComputeDetail> | null)[]
    const tYears = dteDays / 365
    return snapshotRows.map(row => {
      const mktPrice = effectiveQuotePremium(row)
      if (mktPrice == null) return null
      return bsComputeDetail({ marketPrice: mktPrice, S: underlyingPrice, K: row.strike, tYears, r: 0.045, right: row.right })
    })
  }, [snapshotRows, underlyingPrice, selectedExpiration])

  const renderChainSideCells = useCallback(
    (
      side: 'call' | 'put',
      row: OptionSnapshotRow | undefined,
      rowIdx: number | null,
      sideSelected: boolean,
    ) =>
      chainColumnList.map(col => {
        const key = `${side}-${col}`
        let cell: string = '—'
        if (row) {
          switch (col) {
            case 'day_open':
              cell = row.day_open != null ? fmtUsd(row.day_open) : '—'
              break
            case 'day_high':
              cell = row.day_high != null ? fmtUsd(row.day_high) : '—'
              break
            case 'day_low':
              cell = row.day_low != null ? fmtUsd(row.day_low) : '—'
              break
            case 'day_close':
              cell = row.day_close != null ? fmtUsd(row.day_close) : '—'
              break
            case 'day_vol':
              cell = row.day_volume != null ? String(row.day_volume) : '—'
              break
            case 'iv': {
              const bsRow = greeksSource === 'bs' && rowIdx != null ? bsRowValues[rowIdx] : null
              cell = bsRow != null ? fmtIV(bsRow.iv) : fmtIV(row.iv)
              break
            }
            case 'delta': {
              const bsRow = greeksSource === 'bs' && rowIdx != null ? bsRowValues[rowIdx] : null
              cell = bsRow != null ? (bsRow.delta != null ? bsRow.delta.toFixed(4) : '—') : fmtOptNum(row.delta, 4)
              break
            }
            case 'gamma': {
              const bsRow = greeksSource === 'bs' && rowIdx != null ? bsRowValues[rowIdx] : null
              cell = bsRow != null ? (bsRow.gamma != null ? bsRow.gamma.toFixed(4) : '—') : fmtOptNum(row.gamma, 4)
              break
            }
            case 'theta': {
              const bsRow = greeksSource === 'bs' && rowIdx != null ? bsRowValues[rowIdx] : null
              cell = bsRow != null ? (bsRow.thetaPerDay != null ? bsRow.thetaPerDay.toFixed(4) : '—') : fmtOptNum(row.theta, 4)
              break
            }
            case 'vega': {
              const bsRow = greeksSource === 'bs' && rowIdx != null ? bsRowValues[rowIdx] : null
              cell = bsRow != null ? (bsRow.vegaPer1Pct != null ? bsRow.vegaPer1Pct.toFixed(4) : '—') : fmtOptNum(row.vega, 4)
              break
            }
            case 'oi':
              cell = row.open_interest != null ? String(row.open_interest) : '—'
              break
            default:
              break
          }
        }
        return (
          <td
            key={key}
            className={`od-chain-td od-chain-td-data${sideSelected ? ' od-chain-td--selected' : ''}`}
            onClick={e => {
              e.stopPropagation()
              if (rowIdx != null) setSelectedContractIdx(selectedContractIdx === rowIdx ? null : rowIdx)
            }}
          >
            {cell}
          </td>
        )
      }),
    [chainColumnList, selectedContractIdx, setSelectedContractIdx, greeksSource, bsRowValues],
  )


  return (
    <div className="card process-section">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        {onGoToScreener ? (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={onGoToScreener}
              aria-label="Go to Screener"
            >
              Research
            </button>
            {' / '}
            {breadcrumbLabel}
            {' '}
          </>
        ) : (
          <>{breadcrumbLabel}{' '}</>
        )}
        <InfoTooltip text="Option Discovery: choose underlying (from Watchlist STK with Option? on) and expiration. Expirations and quotes use Massive delayed snapshot sync + PostgreSQL." />
        {massiveStatus?.configured && (
          <span
            className="section-hint"
            style={{ marginLeft: '0.5rem', fontWeight: 600 }}
            title={massiveStatus.delay_notice}
          >
            Massive · 15 min delayed
          </span>
        )}
        {massiveStatus?.configured && massiveStatus && !massiveStatus.trades_enabled && (
          <span className="page-title-with-tooltip" style={{ marginLeft: '0.35rem' }}>
            <InfoTooltip text="Tape (last trades) is not available on this tier. Enable trades in Massive config for Developer." />
          </span>
        )}
      </h2>

      {/* ── Session bar: Chain title + daily data on one row ── */}
      <section className="replay-section option-discovery-session-bar" aria-label="Session">
        <div className="option-discovery-conditions-head-row">
          <h3 id="option-discovery-conditions-head">Chain</h3>
          {massiveStatus?.configured && selectedSymbol.trim() ? (
            <div className="option-discovery-daily-summary option-discovery-daily-summary--inline" role="status">
              {dailyDimsLoading ? (
                <span className="section-hint">Loading daily data status…</span>
              ) : dailyDims ? (
                <>
                  <span className="option-discovery-daily-summary-label">
                    Daily data ({dailyDimsDate ?? '—'})
                  </span>
                  <span className="section-hint option-discovery-daily-summary-bits">
                    {`${selectedSymbol.trim().toUpperCase()} · Snapshot: ${formatSnapshotTime(dailyDims['daily-snapshot'])} · OI: ${formatDimShort('daily-oi', dailyDims['daily-oi'])} · Max pain: ${formatDimShort('daily-max-pain', dailyDims['daily-max-pain'])} · Corporate: ${formatDimShort('daily-corporate', dailyDims['daily-corporate'])} · WS: ${formatDimShort('daily-ws-alive', dailyDims['daily-ws-alive'])}`}
                  </span>
                  {onOpenMassiveFeed && (
                    <button
                      type="button"
                      className="section-header-icon-btn od-daily-data-open-btn"
                      onClick={onOpenMassiveFeed}
                      title="Open daily data status in Settings"
                      aria-label="Open daily data status"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                        <line x1="3" y1="15" x2="21" y2="15" />
                        <line x1="9" y1="3" x2="9" y2="21" />
                        <line x1="15" y1="3" x2="15" y2="21" />
                      </svg>
                    </button>
                  )}
                </>
              ) : (
                <span className="section-hint">Daily data status unavailable.</span>
              )}
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Full-width main: controls + layers ── */}
      <div className="option-discovery-layout">
        <div className="option-discovery-main">
          <div className="option-discovery-main-inner">
            <div className="option-discovery-sticky-stack">
              <div className="option-discovery-controls" aria-label="Underlying selection">
                <section className="replay-section option-discovery-underlying" aria-label="Underlying">
                  <div className="option-discovery-underlying-body">
                    <div className="od-underlying-manual-row">
                      <label className="od-underlying-manual-label" htmlFor="od-underlying-manual-input">
                        Symbol
                      </label>
                      <input
                        id="od-underlying-manual-input"
                        type="text"
                        className="form-control od-underlying-manual-input"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="e.g. NVDA"
                        value={underlyingInput}
                        onChange={e => setUnderlyingInput(e.target.value.toUpperCase())}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            applyUnderlyingFromInput()
                          }
                        }}
                        aria-label="Underlying symbol"
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm od-underlying-apply-btn"
                        onClick={() => applyUnderlyingFromInput()}
                      >
                        Apply
                      </button>
                    </div>
                    {stkSymbols.length > 0 ? (
                      <div className="od-underlying-bubbles od-underlying-bubbles--below-manual">
                        <span className="od-underlying-bubbles-label" id="od-underlying-bubbles-label">
                          Wishlist
                        </span>
                        <div
                          className="od-underlying-bubble-row"
                          role="group"
                          aria-labelledby="od-underlying-bubbles-label"
                        >
                          {stkSymbols.map(sym => {
                            const symU = sym.toUpperCase()
                            const px = symbolDailyPrices[symU] ?? symbolDailyPrices[sym]
                            const priceLabel = px != null ? fmtUsd(px) : '—'
                            const active = selectedSymbol.trim().toUpperCase() === symU
                            return (
                              <button
                                key={sym}
                                type="button"
                                className={`od-underlying-chip ${active ? 'od-underlying-chip--active' : ''}`}
                                onClick={() => setSelectedSymbol(symU)}
                                aria-pressed={active}
                                aria-label={`${symU}, daily price ${priceLabel}`}
                                title={`${symU} · ${priceLabel} (daily)`}
                              >
                                <span className="od-underlying-chip-line">
                                  <span className="od-underlying-chip-symbol">{symU}</span>
                                  <span className="od-underlying-chip-sep" aria-hidden>
                                    {' '}
                                    ·{' '}
                                  </span>
                                  <span className="od-underlying-chip-price">{priceLabel}</span>
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ) : (
                      <p className="section-hint od-underlying-empty-hint" role="status">
                        Add optionable STK symbols to Watchlist for quick picks, or type a symbol above and Apply.
                      </p>
                    )}
                  </div>
                </section>
              </div>

              <div id="od-layer-context" className="od-sticky-context od-sticky-context--in-stack">
                <div className="od-sticky-context-row">
                  <span className="od-sticky-context-chip" title="Current context">
                    {selectedSymbol.trim() || '—'}
                    {selectedExpiration.trim() ? ` · ${selectedExpiration}` : ''}
                    {underlyingPrice != null ? ` · ${fmtUsd(underlyingPrice)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="section-header-icon-btn od-compare-icon-btn"
                    onClick={() => setCompareOpen(true)}
                    aria-label={`Open compare drawer (${compareRows.length} selected)`}
                    title={`Open compare drawer (${compareRows.length} selected)`}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M6 4v16" />
                      <path d="M18 4v16" />
                      <path d="M9 7h6" />
                      <path d="M9 12h6" />
                      <path d="M9 17h6" />
                    </svg>
                    <span className="od-compare-icon-btn-count" aria-hidden>{compareRows.length}</span>
                  </button>
                </div>
                <nav className="od-page-toc" aria-label="On this page">
                  <a href="#od-layer-1">1 · IV term</a>
                  <a href="#od-layer-2">2 · Max pain</a>
                  <a href="#od-layer-3">3 · Strike &amp; analytics</a>
                  <a href="#od-layer-4">4 · Quotes &amp; contract</a>
                </nav>
              </div>
            </div>

            <OdLayerSection
              id="od-layer-1"
              step={1}
              title="Underlying & IV term structure"
              subtitle="ATM IV across listed expirations (not limited to the selected expiry)."
              enabled={selectedSymbol.trim() !== ''}
              lockedHint="Select an underlying symbol above."
            >
              <OptionDiscoveryIvTermSection
                symbol={selectedSymbol}
                filteredExpirations={visibleExpirations}
                expirationFilterKind={expirationFilterKind}
                onExpirationFilterKindChange={setExpirationFilterKind}
                selectedExpirations={ivTermExpKeys}
                onToggleExpiration={toggleIvTermExpiration}
                onResetExpirationsToDefault={resetIvTermExpirationsToDefault}
                onSelectAllExpirations={selectAllIvTermExpirations}
                onUncheckAllExpirations={uncheckAllIvTermExpirations}
                maxExpirations={IV_TERM_MAX_EXPIRATIONS}
                defaultExpirationCount={IV_TERM_DEFAULT_EXPIRATIONS}
                massiveBackfillAvailable={Boolean(massiveStatus?.configured)}
                onBackfillMassiveSnapshots={syncIvTermMassiveSnapshots}
                snapshotSyncLoading={ivTermSyncLoading}
                snapshotSyncStatus={ivTermSyncStatus}
                onLoad={loadIvTermStructure}
                termPoints={termPoints}
                termLoading={termLoading}
                termError={termError}
                conePoints={conePoints}
                coneError={coneError}
                expirationsLoading={expirationsLoading}
                expirationsError={expirationsError}
              />
            </OdLayerSection>

            <OdLayerSection
              id="od-layer-2"
              step={2}
              title="Expiration · full chain"
              subtitle="Choose chain and quotes expiry below. Max pain and OI use that expiration (EOD-style). Defaults to the first expiry under the current filter when valid."
              enabled={selectedSymbol.trim() !== '' && visibleExpirations.length > 0}
              lockedHint="Select an underlying and wait for expirations (section 1), or widen All/Std/Wk/Qtr."
            >
              {selectedSymbol.trim() !== '' && (
                <div className="od-chain-expiry-bar">
                  <label className="od-chain-expiry-label" htmlFor="od-chain-expiry-select">
                    Chain / quotes expiry
                  </label>
                  <OdChainExpiryBubblePicker
                    stripId="od-chain-expiry-select"
                    options={visibleExpirations}
                    value={selectedExpiration}
                    onChange={setSelectedExpiration}
                    disabled={visibleExpirations.length === 0}
                    aria-label="Chain and quotes expiration date"
                  />
                  {visibleExpirations.length === 0 && (
                    <span className="section-hint od-chain-expiry-hint" role="status">
                      No expirations for this symbol or filter.
                    </span>
                  )}
                </div>
              )}
              {selectedSymbol.trim() !== '' && selectedExpiration.trim() !== '' && (
                <div
                  className="option-discovery-full-chain"
                  data-analytics-scope="full-chain"
                  aria-label="Full chain"
                >
                  <OptionDiscoveryMaxPainPanel
                    symbol={selectedSymbol}
                    expiration={selectedExpiration}
                    massiveConfigured={Boolean(massiveStatus?.configured)}
                  />
                </div>
              )}
            </OdLayerSection>

            <OdLayerSection
              id="od-layer-3"
              step={3}
              title="Strike window & option analytics"
              subtitle="Adjust the strike ladder, then review IV smile, OI, and gamma exposure for the loaded snapshot."
              enabled={selectedSymbol.trim() !== '' && selectedExpiration.trim() !== ''}
              lockedHint="Select symbol and chain expiry in section 2."
            >
          {/* Strike window (collapsible) */}
          <details className="option-discovery-strike-window" open aria-label="Strike window">
            <summary className="option-discovery-strike-window-summary">
              Strike window
              <span className="section-hint option-discovery-strike-window-count">
                {effectiveStrikes.length} selected · {computedStrikes.length} in range
              </span>
            </summary>
            <p className="section-hint option-discovery-strike-window-hint">
              Select strikes for the option chain table and window-scoped charts below.
            </p>
            <div className="option-discovery-strikes-content">
        {strikesLoading ? (
          <p className="section-hint strike-ladder-hint-below" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Loading strikes for selected expiration…</p>
        ) : computedStrikes.length > 0 ? (() => {
          const spot = stockDayLastPrice ?? undefined
          const below = spot != null ? computedStrikes.filter(s => s < spot).sort((a, b) => b - a) : []
          const at = spot != null ? computedStrikes.filter(s => s === spot) : []
          const above = spot != null ? computedStrikes.filter(s => s > spot).sort((a, b) => a - b) : []
          const aboveReversed = [...above].sort((a, b) => b - a)
          const hasZones = below.length > 0 || at.length > 0 || above.length > 0
          return (
            <div className="option-discovery-list-with-header option-discovery-strikes-with-header">
              <div className="strike-ladder-layout">
              <div className="strike-ladder-col strike-ladder-col-range">
                <div className="strike-ladder-col-header">Strikes Range</div>
                <div className="strike-ladder-controls">
                <div className="strike-ladder-controls-row">
                  <label htmlFor="option-discovery-strike-count">Count</label>
                  <select
                    id="option-discovery-strike-count"
                    value={String(strikeCountOption)}
                    onChange={e => setStrikeCountOption(e.target.value === 'all' ? 'all' : (Number(e.target.value) as StrikeCountOption))}
                    aria-label="Strike count"
                  >
                    {STRIKE_COUNT_OPTIONS.map(c => (
                      <option key={String(c)} value={String(c)}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="strike-ladder-controls-row">
                  <label htmlFor="option-discovery-std-dev">Std dev</label>
                  <select
                    id="option-discovery-std-dev"
                    value={String(stdDevOption)}
                    onChange={e => setStdDevOption(e.target.value === 'custom' ? 'custom' : (Number(e.target.value) as StdDevOption))}
                    aria-label="Standard deviations"
                  >
                    {STD_DEV_OPTIONS.map(d => (
                      <option key={String(d)} value={String(d)}>{d}</option>
                    ))}
                  </select>
                  {stdDevOption === 'custom' && (
                    <input
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={customStdDev}
                      onChange={e => setCustomStdDev(e.target.value)}
                      aria-label="Custom std dev"
                    />
                  )}
                </div>
                {spot != null && (below.length > 0 || above.length > 0 || at.length > 0) && (
                  <div className="strike-ladder-controls-price">
                    Current price: {fmtUsd(spot)}
                  </div>
                )}
                <div className="strike-ladder-toolbar">
                  <button
                    type="button"
                    className="section-header-icon-btn od-strike-range-icon-btn"
                    onClick={() => setMultiSelectStrikes([...computedStrikes])}
                    aria-label="Select all"
                    title="Select all strikes in range"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M9 12l2 2 4-4" />
                      <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="section-header-icon-btn od-strike-range-icon-btn"
                    onClick={() => setMultiSelectStrikes([])}
                    aria-label="Clear"
                    title="Clear selected strikes"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                    </svg>
                  </button>
                </div>
                <div className="strike-ladder-controls-summary">
                  <div>{effectiveStrikes.length} selected{multiSelectStrikes.length > 0 ? ' (custom)' : ' (preset)'}</div>
                  <div>{computedStrikes.length} in range</div>
                </div>
                <div className="strike-ladder-controls-row strike-ladder-side-mode-row">
                  <span className="strike-ladder-side-mode-label" id="option-discovery-strike-sides-label">
                    Sides
                  </span>
                  <div
                    className="replay-bubble-switch"
                    role="group"
                    aria-labelledby="option-discovery-strike-sides-label"
                  >
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${strikeSideMode === 'all' ? 'active' : ''}`}
                      onClick={() => setStrikeSideMode('all')}
                      aria-pressed={strikeSideMode === 'all'}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${strikeSideMode === 'call' ? 'active' : ''}`}
                      onClick={() => setStrikeSideMode('call')}
                      aria-pressed={strikeSideMode === 'call'}
                    >
                      Call
                    </button>
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${strikeSideMode === 'put' ? 'active' : ''}`}
                      onClick={() => setStrikeSideMode('put')}
                      aria-pressed={strikeSideMode === 'put'}
                    >
                      Put
                    </button>
                  </div>
                </div>
              </div>
              </div>
              <div
                className={`strike-ladder-two-cols${strikeSideMode !== 'all' ? ' strike-ladder-two-cols--single-side' : ''}`}
              >
                {showCallSide && (
                <div className="strike-ladder-col">
                  <div className="strike-ladder-col-header strike-ladder-col-header-call">
                    <label className="strike-ladder-col-header-check">
                      <input
                        type="checkbox"
                        checked={aboveReversed.length + at.length > 0 && [...aboveReversed, ...at].every(s => multiSelectStrikes.includes(s))}
                        onChange={e => {
                          if (e.target.checked) setMultiSelectStrikes(prev => [...new Set([...prev, ...aboveReversed, ...at])].sort((a, b) => a - b))
                          else setMultiSelectStrikes(prev => prev.filter(x => !aboveReversed.includes(x) && !at.includes(x)))
                        }}
                        aria-label="Check all OTM Call"
                      />
                      <span>OTM Call</span>
                    </label>
                  </div>
                  <div className="strike-ladder-wrap" ref={otmCallWrapRef}>
                    <table className="strike-ladder-table" role="grid" aria-label="OTM Call strikes">
                      <thead>
                        <tr>
                          <th scope="col">Select</th>
                          <th scope="col">{strikeLadderShowOi ? 'Strike / OI' : 'Strike'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {aboveReversed.length > 0 && aboveReversed.map(s => (
                          <tr key={s} className="strike-ladder-row-otm-call">
                            <td className="strike-ladder-cell-check">
                              <input
                                type="checkbox"
                                checked={multiSelectStrikes.includes(s)}
                                onChange={() => {
                                  if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                  else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                                }}
                                aria-label={`Select strike ${s}`}
                              />
                            </td>
                            <StrikeLadderOiStrikeCell
                              strike={s}
                              oiMax={ladderOiMax}
                              oiByStrike={strikeOiByStrike}
                              showOi={strikeLadderShowOi}
                            />
                          </tr>
                        ))}
                        {at.length > 0 && at.map(s => (
                          <tr key={s} className="strike-ladder-row-atm">
                            <td className="strike-ladder-cell-check">
                              <input
                                type="checkbox"
                                checked={multiSelectStrikes.includes(s)}
                                onChange={() => {
                                  if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                  else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                                }}
                                aria-label={`Select strike ${s}`}
                              />
                            </td>
                            <StrikeLadderOiStrikeCell
                              strike={s}
                              oiMax={ladderOiMax}
                              oiByStrike={strikeOiByStrike}
                              showOi={strikeLadderShowOi}
                            />
                          </tr>
                        ))}
                        </tbody>
                    </table>
                  </div>
                </div>
                )}
                {showPutSide && (
                <div className="strike-ladder-col">
                  <div className="strike-ladder-col-header strike-ladder-col-header-put">
                    <label className="strike-ladder-col-header-check">
                      <input
                        type="checkbox"
                        checked={below.length > 0 && below.every(s => multiSelectStrikes.includes(s))}
                        onChange={e => {
                          if (e.target.checked) setMultiSelectStrikes(prev => [...new Set([...prev, ...below])].sort((a, b) => a - b))
                          else setMultiSelectStrikes(prev => prev.filter(x => !below.includes(x)))
                        }}
                        aria-label="Check all OTM Put"
                      />
                      <span>OTM Put</span>
                    </label>
                  </div>
                  <div className="strike-ladder-wrap">
                    <table className="strike-ladder-table" role="grid" aria-label="OTM Put strikes">
                      <thead>
                        <tr>
                          <th scope="col">Select</th>
                          <th scope="col">{strikeLadderShowOi ? 'Strike / OI' : 'Strike'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {below.length > 0 && below.map(s => (
                          <tr key={s} className="strike-ladder-row-otm-put">
                            <td className="strike-ladder-cell-check">
                              <input
                                type="checkbox"
                                checked={multiSelectStrikes.includes(s)}
                                onChange={() => {
                                  if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                  else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                                }}
                                aria-label={`Select strike ${s}`}
                              />
                            </td>
                            <StrikeLadderOiStrikeCell
                              strike={s}
                              oiMax={ladderOiMax}
                              oiByStrike={strikeOiByStrike}
                              showOi={strikeLadderShowOi}
                            />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                )}
              </div>
              </div>
              {!hasZones && (
                <div className="strike-ladder-wrap" style={{ marginTop: '0.25rem' }}>
                  <table className="strike-ladder-table" role="grid" aria-label="Strikes">
                    <thead>
                      <tr>
                        <th scope="col">Select</th>
                        <th scope="col">{strikeLadderShowOi ? 'Strike / OI' : 'Strike'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...computedStrikes].sort((a, b) => a - b).map(s => (
                        <tr key={s}>
                          <td className="strike-ladder-cell-check">
                            <input
                              type="checkbox"
                              checked={multiSelectStrikes.includes(s)}
                              onChange={() => {
                                if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                              }}
                              aria-label={`Select strike ${s}`}
                            />
                          </td>
                          <StrikeLadderOiStrikeCell
                            strike={s}
                            oiMax={ladderOiMax}
                            oiByStrike={strikeOiByStrike}
                            showOi={strikeLadderShowOi}
                          />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })() : strikes.length > 0 ? (
          <p className="section-hint strike-ladder-hint-below" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Select symbol with daily data or adjust count/std dev.</p>
        ) : (
          <p className="section-hint strike-ladder-hint-below" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Select symbol and expiration to see strikes.</p>
        )}
            </div>
          </details>

          {/* Strike-window scope: snapshotRows / effectiveStrikes — not EOD full chain. */}
          <div
            className="option-discovery-view-scope"
            data-analytics-scope="strike-window"
            aria-label="Strike window scope"
          >
            <p className="section-hint option-discovery-view-scope-hint" id="option-discovery-view-scope-hint">
              Scoped to the selected strike window.
            </p>

          {/* Option Analytics — uses snapshotRows (strike selection) */}
          {selectedSymbol.trim() !== '' && selectedExpiration.trim() !== '' &&
            snapshotRows.length > 0 && !snapshotLoading && (
            <div
              className="od-option-structure-stack"
              aria-label="Option analytics"
              aria-describedby="option-discovery-view-scope-hint"
            >
              <OptionDiscoveryAnalyticsPanel
                rows={snapshotRows}
                underlying={underlyingPrice}
              />
            </div>
          )}
          </div>

            </OdLayerSection>

            <OdLayerSection
              id="od-layer-4"
              step={4}
              title="Option quotes & contract"
              subtitle="Refresh Massive snapshots, browse the chain, then open a contract for liquidity, risk, and K-line."
              enabled={selectedSymbol.trim() !== '' && selectedExpiration.trim() !== ''}
              lockedHint="Select symbol and chain expiry in section 2."
            >
          {/* ── Option quotes ── */}
          <section
            className="replay-section"
            aria-labelledby="option-discovery-table-head"
            aria-describedby="option-discovery-view-scope-hint"
          >
            <div className="od-option-quotes-head-row">
              <h3 id="option-discovery-table-head" className="od-option-quotes-head-title">
                Option quotes
                <InfoTooltip text="Massive: enqueue sync job (REST), then read snapshots from PostgreSQL; 15 min delayed." />
              </h3>
              {/* Greeks source toggle — always visible once section 4 is unlocked */}
              <span className="od-quotes-refresh-meta">
                {lastQuotesLoadTs != null && (
                  <span className="od-quotes-refresh-ts" title={`Data loaded at ${lastQuotesLoadTs.toLocaleString()}`}>
                    {lastQuotesLoadTs.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
                <span className="od-greeks-source-toggle" title="Switch IV & Greeks columns between Massive snapshot data and local Black-Scholes calculation">
                  <button
                    type="button"
                    className={`od-greeks-source-btn${greeksSource === 'snapshot' ? ' od-greeks-source-btn--active' : ''}`}
                    onClick={() => setGreeksSource('snapshot')}
                  >Snapshot</button>
                  <button
                    type="button"
                    className={`od-greeks-source-btn${greeksSource === 'bs' ? ' od-greeks-source-btn--active' : ''}`}
                    onClick={() => setGreeksSource('bs')}
                  >BS</button>
                </span>
              </span>
              <button
                type="button"
                className="section-header-icon-btn od-option-quotes-refresh-btn"
                onClick={() => void loadQuotes()}
                disabled={!canLoadQuotes}
                aria-label="Refresh option quotes"
                title={snapshotLoading ? 'Loading option quotes' : 'Refresh option quotes'}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 21h5v-5" />
                </svg>
              </button>
              {underlyingPrice != null && (
                <span className="section-hint od-option-quotes-underlying">Underlying: {fmtUsd(underlyingPrice)}</span>
              )}
            </div>
            {addWatchlistFeedback != null && (
              <div style={{ marginBottom: '0.5rem' }}>
                <span className="section-hint" role="status">
                  {addWatchlistFeedback.includes('|') ? 'Added to Watchlist.' : addWatchlistFeedback}
                </span>
              </div>
            )}
        {snapshotLoading && (
          <p className="section-hint">Fetching option quotes (may take ~10s)…</p>
        )}
        {snapshotFeedback != null && !snapshotLoading && (
          <div
            className={`od-snapshot-feedback od-snapshot-feedback--${snapshotFeedback.level}`}
            role={snapshotFeedback.level === 'error' ? 'alert' : 'status'}
          >
            {snapshotFeedback.title && <strong>{snapshotFeedback.title}</strong>}
            <span>{snapshotFeedback.body}</span>
            {snapshotFeedback.level !== 'error' && (
              <div className="od-feedback-actions">
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => void loadQuotes()}
                  disabled={!canLoadQuotes}
                  aria-label="Enqueue Massive snapshot job and reload quotes from PostgreSQL"
                >
                  Pull now
                </button>
                {onOpenMassiveFeed && (
                  <button type="button" className="button-feedback-nav" onClick={onOpenMassiveFeed}>
                    Open Massive Option
                  </button>
                )}
              </div>
            )}
            {snapshotPgWatching && (
              <p className="od-snapshot-watch-hint" role="status">
                Watching PostgreSQL for new snapshots… ~{snapshotPgWatchSecondsLeft ?? 0}s left. Matching rows will appear
                automatically when data is available. Use Pull now to enqueue another chain snapshot if the worker was not
                running.
              </p>
            )}
          </div>
        )}
        {snapshotRows.length > 0 && !snapshotLoading && (
          <>
            <div className="od-chain-column-filter" role="group" aria-label="Column visibility">
              <span className="od-chain-column-filter-label">Columns</span>
              <div className="od-chain-column-filter-list">
                <span className="od-chain-col-group-label">Day</span>
                {(['day_open', 'day_high', 'day_low', 'day_close', 'day_vol'] as const).map(id => (
                  <label key={id} className="od-chain-column-filter-item">
                    <input type="checkbox" checked={chainColumnVisibility[id] !== false} onChange={() => toggleChainColumn(id)} />
                    {CHAIN_COLUMN_LABEL[id]}
                  </label>
                ))}
                <span className="od-chain-col-group-sep" aria-hidden="true" />
                {(['iv', 'delta', 'gamma', 'theta', 'vega', 'oi'] as const).map(id => (
                  <label key={id} className="od-chain-column-filter-item">
                    <input type="checkbox" checked={chainColumnVisibility[id] !== false} onChange={() => toggleChainColumn(id)} />
                    {CHAIN_COLUMN_LABEL[id]}
                  </label>
                ))}
              </div>
            </div>
            {chainColumnList.length === 0 ? (
              <p className="section-hint" role="status">
                Select at least one column in Columns filter.
              </p>
            ) : (
              <div className="table-wrapper od-chain-table-wrap">
                <table className="data-table od-chain-table" aria-label="Option chain: calls, strike, puts">
                  <thead>
                    {strikeSideMode === 'put' ? (
                      <>
                        <tr className="od-chain-group-row">
                          <th rowSpan={2} className="od-chain-strike-col" scope="col">
                            Strike
                          </th>
                          <th
                            colSpan={chainColumnList.length}
                            className="od-chain-group-put"
                            scope="colgroup"
                          >
                            Puts
                          </th>
                        </tr>
                        <tr>
                          {chainColumnList.map(col => (
                            <th key={`put-h-${col}`} className="od-chain-th-put" scope="col">
                              {CHAIN_COLUMN_LABEL[col]}
                            </th>
                          ))}
                        </tr>
                      </>
                    ) : (
                      <>
                        <tr className="od-chain-group-row">
                          {showCallSide && (
                            <th
                              colSpan={chainColumnList.length}
                              className="od-chain-group-call"
                              scope="colgroup"
                            >
                              Calls
                            </th>
                          )}
                          <th rowSpan={2} className="od-chain-strike-col" scope="col">
                            Strike
                          </th>
                          {showPutSide && strikeSideMode === 'all' && (
                            <th
                              colSpan={chainColumnList.length}
                              className="od-chain-group-put"
                              scope="colgroup"
                            >
                              Puts
                            </th>
                          )}
                        </tr>
                        <tr>
                          {showCallSide &&
                            chainColumnList.map(col => (
                              <th key={`call-h-${col}`} className="od-chain-th-call" scope="col">
                                {CHAIN_COLUMN_LABEL[col]}
                              </th>
                            ))}
                          {showPutSide &&
                            strikeSideMode === 'all' &&
                            chainColumnList.map(col => (
                              <th key={`put-h-${col}`} className="od-chain-th-put" scope="col">
                                {CHAIN_COLUMN_LABEL[col]}
                              </th>
                            ))}
                        </tr>
                      </>
                    )}
                  </thead>
                  <tbody>
                    {chainStrikesSorted.map(strike => {
                      const callIdx = rowIndexByStrikeRight.get(`${strike}|C`) ?? null
                      const putIdx = rowIndexByStrikeRight.get(`${strike}|P`) ?? null
                      const callRow = callIdx != null ? snapshotRows[callIdx] : undefined
                      const putRow = putIdx != null ? snapshotRows[putIdx] : undefined
                      const callSel = callIdx != null && selectedContractIdx === callIdx
                      const putSel = putIdx != null && selectedContractIdx === putIdx
                      const rowHighlight =
                        (callIdx != null && callSel) || (putIdx != null && putSel)
                      const atm = underlyingPrice != null && Number.isFinite(underlyingPrice) && Math.abs(strike - underlyingPrice) < 0.021
                      const itm = !atm && underlyingPrice != null && Number.isFinite(underlyingPrice) && strike < underlyingPrice
                      const moneyClass = atm ? ' od-chain-row-atm' : itm ? ' od-chain-row-itm' : ' od-chain-row-otm'
                      return (
                        <tr
                          key={strike}
                          className={`od-chain-row od-quote-row${rowHighlight ? ' od-quote-row--selected' : ''}${moneyClass}`}
                          onClick={() => {
                            if (callIdx != null) setSelectedContractIdx(callSel ? null : callIdx)
                            else if (putIdx != null) setSelectedContractIdx(putSel ? null : putIdx)
                          }}
                        >
                          {strikeSideMode === 'put' ? (
                            <>
                              <td
                                className={`od-chain-strike-cell${callSel || putSel ? ' od-chain-strike-cell--selected' : ''}`}
                                onClick={e => {
                                  e.stopPropagation()
                                  if (putIdx != null) setSelectedContractIdx(putSel ? null : putIdx)
                                  else if (callIdx != null) setSelectedContractIdx(callSel ? null : callIdx)
                                }}
                              >
                                {strike.toFixed(2)}
                              </td>
                              {renderChainSideCells('put', putRow, putIdx, putSel)}
                            </>
                          ) : (
                            <>
                              {showCallSide && renderChainSideCells('call', callRow, callIdx, callSel)}
                              <td
                                className={`od-chain-strike-cell${callSel || putSel ? ' od-chain-strike-cell--selected' : ''}`}
                                onClick={e => {
                                  e.stopPropagation()
                                  if (callIdx != null) setSelectedContractIdx(callSel ? null : callIdx)
                                  else if (putIdx != null) setSelectedContractIdx(putSel ? null : putIdx)
                                }}
                              >
                                {strike.toFixed(2)}
                              </td>
                              {showPutSide && strikeSideMode === 'all' && renderChainSideCells('put', putRow, putIdx, putSel)}
                            </>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {snapshotRows.length === 0 && !snapshotLoading && !snapshotFeedback && (
          <p className="section-hint" role="status">
            {!snapshotLoadAttempted
              ? 'Select symbol and expiration to load quotes automatically.'
              : 'No quotes returned. Check Massive job queue, Celery worker, and PostgreSQL option_snapshots.'}
          </p>
        )}
      </section>

      {/* ── P3: Event context warnings ── */}
      {eventContextWarnings.length > 0 && selectedRow && (
        <div className="od-event-warnings" role="alert">
          {eventContextWarnings.map((w, i) => (
            <div key={i} className="od-event-warning-item">{w}</div>
          ))}
        </div>
      )}

      {/* ── P0–P3: Contract detail panel ── */}
      {selectedRow && selectedDerived && (
        <section className="replay-section od-contract-detail" aria-label="Contract detail">
          <div className="od-detail-header">
            <h3 className="od-detail-title">
              {selectedSymbol} {selectedRow.right === 'C' ? 'Call' : 'Put'} {selectedRow.strike.toFixed(2)}
              {' '}
              <span className="od-detail-expiry">{selectedExpiration} · {expirationDaysFromToday(selectedExpiration)} DTE</span>
              {' '}
              <span className={`od-moneyness-badge od-moneyness-badge--${selectedDerived.moneynessLabel.toLowerCase()}`}>
                {selectedDerived.moneynessLabel}
              </span>
            </h3>
            <button
              type="button"
              className="section-header-icon-btn od-detail-action-icon-btn"
              onClick={() => void handleAddToWatchlist(selectedRow)}
              aria-label={`Add ${selectedRow.right === 'C' ? 'Call' : 'Put'} ${selectedRow.strike} to Watchlist`}
              title={`Add ${selectedRow.right === 'C' ? 'Call' : 'Put'} ${selectedRow.strike} to Watchlist`}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
            <button
              type="button"
              className="section-header-icon-btn od-detail-action-icon-btn"
              onClick={() => {
                handleAddToCompare(selectedRow)
                setCompareOpen(true)
              }}
              aria-label="Add current contract to compare"
              title="Add current contract to compare"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 4v16" />
                <path d="M18 4v16" />
                <path d="M9 7h6" />
                <path d="M9 12h6" />
                <path d="M9 17h6" />
              </svg>
            </button>
            <span className="od-detail-delayed">Massive · 15 min delayed</span>
            <button
              type="button"
              className="od-detail-close"
              onClick={() => setSelectedContractIdx(null)}
              aria-label="Close contract detail"
            >
              ✕
            </button>
          </div>

          <div className="od-contract-detail-stack">
          {/* ── Overview (P0) ── */}
          <section className="od-detail-section" aria-labelledby="od-contract-sec-overview">
            <h4 id="od-contract-sec-overview" className="od-detail-section-title">Overview</h4>
            <div>
              <div className="od-card-grid">
                <div className="od-card-section">
                  <div className="od-card-section-title od-card-section-title--with-hint">
                    Price
                    <span className="od-card-section-source">Day</span>
                    <InfoTooltip text="Day bar OHLC from Massive (chain snapshot, 15 min delayed). Underlying spot for decomposition uses stock_day daily close when available." />
                  </div>
                  <div className="od-kv-grid">
                    {selectedRow.snapshot_ts && (
                      <>
                        <span className="od-kv-k">As of</span>
                        <span className="od-kv-v od-kv-dim">{new Date(selectedRow.snapshot_ts).toLocaleString()}</span>
                      </>
                    )}
                    <span className="od-kv-k">Open</span><span className="od-kv-v">{selectedRow.day_open != null ? fmtUsd(selectedRow.day_open) : '—'}</span>
                    <span className="od-kv-k">High</span><span className="od-kv-v">{selectedRow.day_high != null ? fmtUsd(selectedRow.day_high) : '—'}</span>
                    <span className="od-kv-k">Low</span><span className="od-kv-v">{selectedRow.day_low != null ? fmtUsd(selectedRow.day_low) : '—'}</span>
                    <span className="od-kv-k">Close</span><span className="od-kv-v">{selectedRow.day_close != null ? fmtUsd(selectedRow.day_close) : '—'}</span>
                    {selectedRow.day_volume != null && (
                      <><span className="od-kv-k">Vol</span><span className="od-kv-v">{selectedRow.day_volume.toLocaleString()}</span></>
                    )}
                  </div>
                </div>
                <div className="od-card-section">
                  <div className="od-card-section-title">Value Decomposition</div>
                  <div className="od-kv-grid">
                    <span className="od-kv-k">Intrinsic</span><span className="od-kv-v">{selectedDerived.intrinsic != null ? fmtUsd(selectedDerived.intrinsic) : '—'}</span>
                    <span className="od-kv-k">Extrinsic</span><span className="od-kv-v">{selectedDerived.extrinsic != null ? fmtUsd(selectedDerived.extrinsic) : '—'}</span>
                    <span className="od-kv-k">Breakeven</span><span className="od-kv-v">{selectedDerived.breakeven != null ? fmtUsd(selectedDerived.breakeven) : '—'}</span>
                    <span className="od-kv-k">Moneyness</span>
                    <span className="od-kv-v">
                      {selectedDerived.moneyness != null ? `${selectedDerived.moneyness > 0 ? '+' : ''}${selectedDerived.moneyness.toFixed(2)}%` : '—'}
                    </span>
                  </div>
                </div>
                <div className="od-card-section">
                  <div className="od-card-section-title">Underlying</div>
                  <div className="od-kv-grid">
                    <span className="od-kv-k">Symbol</span><span className="od-kv-v">{selectedSymbol}</span>
                    <span className="od-kv-k">Price</span><span className="od-kv-v">{underlyingPrice != null ? fmtUsd(underlyingPrice) : '—'}</span>
                    <span className="od-kv-k">Strike</span><span className="od-kv-v">{fmtUsd(selectedRow.strike)}</span>
                    <span className="od-kv-k">DTE</span><span className="od-kv-v">{expirationDaysFromToday(selectedExpiration)}</span>
                  </div>
                </div>
                <div className="od-card-section">
                  <div className="od-card-section-title od-card-section-title--with-hint">
                    Greeks
                    <span className="od-greeks-source-toggle">
                      <button
                        type="button"
                        className={`od-greeks-source-btn${greeksSource === 'snapshot' ? ' od-greeks-source-btn--active' : ''}`}
                        onClick={() => setGreeksSource('snapshot')}
                        title="Show IV & Greeks from Massive snapshot data"
                      >Snapshot</button>
                      <button
                        type="button"
                        className={`od-greeks-source-btn${greeksSource === 'bs' ? ' od-greeks-source-btn--active' : ''}`}
                        onClick={() => setGreeksSource('bs')}
                        title="Show IV & Greeks computed locally via Black-Scholes"
                      >BS</button>
                    </span>
                  </div>
                  {(() => {
                    if (greeksSource === 'snapshot') {
                      return (
                        <div className="od-kv-grid">
                          <span className="od-kv-k">IV</span><span className="od-kv-v">{fmtIV(selectedRow.iv)}</span>
                          <span className="od-kv-k">Delta</span><span className="od-kv-v">{fmtOptNum(selectedRow.delta, 4)}</span>
                          <span className="od-kv-k">Gamma</span><span className="od-kv-v">{fmtOptNum(selectedRow.gamma, 4)}</span>
                          <span className="od-kv-k">Theta</span><span className="od-kv-v">{fmtOptNum(selectedRow.theta, 4)}</span>
                          <span className="od-kv-k">Vega</span><span className="od-kv-v">{fmtOptNum(selectedRow.vega, 4)}</span>
                          <span className="od-kv-k">OI</span><span className="od-kv-v">{selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                        </div>
                      )
                    }
                    // BS mode: compute on the fly
                    const bsParts = parseExpirationDateParts(selectedExpiration)
                    const bsDteDays = bsParts ? Math.max(0, Math.round(
                      (new Date(bsParts.y, bsParts.m, bsParts.d).setHours(0,0,0,0) - new Date().setHours(0,0,0,0)) / 86400000
                    )) : 0
                    const bsMktPrice = effectiveQuotePremium(selectedRow)
                    const bsD = (underlyingPrice != null && bsMktPrice != null && bsDteDays > 0)
                      ? bsComputeDetail({ marketPrice: bsMktPrice, S: underlyingPrice, K: selectedRow.strike, tYears: bsDteDays / 365, r: 0.045, right: selectedRow.right })
                      : null
                    if (bsD == null || bsD.iv == null) {
                      return (
                        <div className="od-kv-grid">
                          <span className="od-kv-k od-kv-dim" style={{ gridColumn: '1/-1', fontSize: '0.75rem' }}>
                            {bsDteDays === 0 ? '已到期，无法计算' : underlyingPrice == null ? '标的价格未知' : 'IV 求解失败'}
                          </span>
                          <span className="od-kv-k">OI</span><span className="od-kv-v">{selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                        </div>
                      )
                    }
                    return (
                      <div className="od-kv-grid">
                        <span className="od-kv-k">IV</span><span className="od-kv-v">{bsD.iv != null ? (bsD.iv * 100).toFixed(2) + '%' : '—'}</span>
                        <span className="od-kv-k">Delta</span><span className="od-kv-v">{bsD.delta != null ? bsD.delta.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">Gamma</span><span className="od-kv-v">{bsD.gamma != null ? bsD.gamma.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">Theta</span><span className="od-kv-v">{bsD.thetaPerDay != null ? bsD.thetaPerDay.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">Vega/1%</span><span className="od-kv-v">{bsD.vegaPer1Pct != null ? bsD.vegaPer1Pct.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">OI</span><span className="od-kv-v">{selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                      </div>
                    )
                  })()}
                </div>
              </div>

              {/* P2: Data Quality Badge */}
              {greeksCoverage?.ok && greeksCoverage.total != null && greeksCoverage.total > 0 && (
                <div className="od-quality-badge">
                  <span className="od-quality-badge-title">Data Quality</span>
                  <span className="od-quality-item" title="Percentage of contracts with IV data">
                    IV {greeksCoverage.coverage?.iv_pct ?? 0}%
                  </span>
                  <span className="od-quality-item" title="Percentage with full greeks (Δ,Γ,Θ,ν)">
                    Greeks {greeksCoverage.coverage?.full_greeks_pct ?? 0}%
                  </span>
                  {greeksCoverage.freshness?.newest_ts && (
                    <span className="od-quality-item" title="Most recent snapshot timestamp">
                      Fresh: {new Date(greeksCoverage.freshness.newest_ts).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* ── BS vs Snapshot comparison ── */}
          {(() => {
            const parts = parseExpirationDateParts(selectedExpiration)
            if (!parts) return null
            const { y, m, d } = parts
            const expDate = new Date(y, m, d)
            expDate.setHours(0, 0, 0, 0)
            const todayMs = new Date()
            todayMs.setHours(0, 0, 0, 0)
            const dteDays = Math.max(0, Math.round((expDate.getTime() - todayMs.getTime()) / 86400000))
            if (dteDays === 0) return null
            const mktPrice = effectiveQuotePremium(selectedRow)
            if (mktPrice == null || underlyingPrice == null) return null

            const bsDetail = bsComputeDetail({
              marketPrice: mktPrice,
              S: underlyingPrice,
              K: selectedRow.strike,
              tYears: dteDays / 365,
              r: 0.045,
              right: selectedRow.right,
            })

            function diffPct(local: number | null, snap: number | null): number | null {
              if (local == null || snap == null || snap === 0) return null
              return ((local - snap) / Math.abs(snap)) * 100
            }
            function diffClass(pct: number | null): string {
              if (pct == null) return ''
              const abs = Math.abs(pct)
              if (abs < 3) return 'od-bs-diff--ok'
              if (abs < 10) return 'od-bs-diff--warn'
              return 'od-bs-diff--alert'
            }
            function fmtDiff(pct: number | null): string {
              if (pct == null) return '—'
              return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%'
            }

            const ivDiff = diffPct(bsDetail.iv, selectedRow.iv ?? null)
            const deltaDiff = diffPct(bsDetail.delta, selectedRow.delta ?? null)
            const gammaDiff = diffPct(bsDetail.gamma, selectedRow.gamma ?? null)
            const thetaDiff = diffPct(bsDetail.thetaPerDay, selectedRow.theta ?? null)
            const vegaDiff = diffPct(bsDetail.vegaPer1Pct, selectedRow.vega ?? null)

            // Market price source label
            let mktSrc = 'mark'
            if (selectedRow.mark != null) mktSrc = 'mark/day_close'
            else if (selectedRow.mid != null) mktSrc = 'mid'
            else if (selectedRow.bid != null && selectedRow.ask != null) mktSrc = '(bid+ask)/2'
            else if (selectedRow.last != null) mktSrc = 'last'
            else if (selectedRow.day_close != null) mktSrc = 'day_close'

            return (
              <section className="od-detail-section od-bs-compare" aria-labelledby="od-contract-sec-bs">
                <h4 id="od-contract-sec-bs" className="od-detail-section-title">
                  BS vs Snapshot
                  <span className="od-bs-compare__note"> · Black-Scholes 欧式近似（美式期权，ATM 误差通常 &lt;3%）</span>
                </h4>
                <div className="od-bs-compare__meta">
                  S={`$${underlyingPrice.toFixed(2)}`} · K=${selectedRow.strike.toFixed(2)} · DTE={dteDays} · 市场价=${mktPrice.toFixed(4)} ({mktSrc}) · r=4.50%
                </div>
                {bsDetail.iv == null ? (
                  <div className="od-bs-compare__noiv">BS IV 求解失败（价格异常或深度 ITM/OTM）</div>
                ) : (
                  <table className="od-bs-compare__table">
                    <thead>
                      <tr>
                        <th>指标</th>
                        <th>Snapshot (Massive)</th>
                        <th>BS 计算</th>
                        <th>差值 %</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>IV</td>
                        <td>{selectedRow.iv != null ? (selectedRow.iv * 100).toFixed(2) + '%' : '—'}</td>
                        <td>{(bsDetail.iv * 100).toFixed(2)}%</td>
                        <td className={`od-bs-diff ${diffClass(ivDiff)}`}>{fmtDiff(ivDiff)}</td>
                      </tr>
                      <tr>
                        <td>Delta</td>
                        <td>{selectedRow.delta != null ? selectedRow.delta.toFixed(4) : '—'}</td>
                        <td>{bsDetail.delta != null ? bsDetail.delta.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(deltaDiff)}`}>{fmtDiff(deltaDiff)}</td>
                      </tr>
                      <tr>
                        <td>Gamma</td>
                        <td>{selectedRow.gamma != null ? selectedRow.gamma.toFixed(4) : '—'}</td>
                        <td>{bsDetail.gamma != null ? bsDetail.gamma.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(gammaDiff)}`}>{fmtDiff(gammaDiff)}</td>
                      </tr>
                      <tr>
                        <td>Theta/日</td>
                        <td>{selectedRow.theta != null ? selectedRow.theta.toFixed(4) : '—'}</td>
                        <td>{bsDetail.thetaPerDay != null ? bsDetail.thetaPerDay.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(thetaDiff)}`}>{fmtDiff(thetaDiff)}</td>
                      </tr>
                      <tr>
                        <td>
                          <span title="Vega per 1% IV change. Massive may report per 1 vol point (same unit). If ×100 gap appears, Massive uses per-unit convention.">
                            Vega/1%
                          </span>
                        </td>
                        <td>{selectedRow.vega != null ? selectedRow.vega.toFixed(4) : '—'}</td>
                        <td>{bsDetail.vegaPer1Pct != null ? bsDetail.vegaPer1Pct.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(vegaDiff)}`}>
                          {fmtDiff(vegaDiff)}
                          {vegaDiff != null && Math.abs(vegaDiff) > 80 && (
                            <span className="od-bs-diff__hint"> 单位?</span>
                          )}
                        </td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4} className="od-bs-compare__legend">
                          <span className="od-bs-diff od-bs-diff--ok">■</span> &lt;3%&nbsp;&nbsp;
                          <span className="od-bs-diff od-bs-diff--warn">■</span> 3–10%&nbsp;&nbsp;
                          <span className="od-bs-diff od-bs-diff--alert">■</span> &gt;10%
                          &nbsp;·&nbsp;NR {bsDetail.iterCount} 次迭代 {bsDetail.converged ? '✓' : '(未收敛)'}
                          &nbsp;·&nbsp;BS 理论价={bsDetail.bsModelPrice != null ? `$${bsDetail.bsModelPrice.toFixed(4)}` : '—'}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </section>
            )
          })()}

          {/* ── Chart (K-line) ── */}
          <section className="od-detail-section" aria-labelledby="od-contract-sec-chart">
            <h4 id="od-contract-sec-chart" className="od-detail-section-title">Chart (K-line)</h4>
            <p className="section-hint od-detail-chart-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
              OHLC below uses contract history. If the chart is empty, click Backfill from Massive (Celery worker on the massive queue required).
            </p>
            <OptionDiscoveryContractChartPanel
              symbol={selectedSymbol}
              expiration={selectedExpiration}
              strike={selectedRow.strike}
              optionRight={selectedRow.right === 'P' ? 'P' : 'C'}
            />
          </section>

          {/* ── Liquidity (P1) ── */}
          {(() => {
            const lastTradeTs = liquidityLastTrade?.sip_timestamp != null
              ? Number(liquidityLastTrade.sip_timestamp) / 1e9
              : null
            const lastTradeAge = lastTradeTs != null ? (Date.now() / 1000) - lastTradeTs : null
            const tradability = computeTradabilityScore(selectedRow, snapshotRows, lastTradeAge, liquidityQuoteCount)
            const spreadRows = snapshotRows
              .filter(r => {
                if (r.right !== selectedRow.right) return false
                const m = effectiveQuotePremium(r)
                return r.bid != null && r.ask != null && m != null && m > 0
              })
              .map(r => {
                const m = effectiveQuotePremium(r)!
                return ((r.ask! - r.bid!) / m) * 100
              })
              .sort((a, b) => a - b)
            const curSpreadPct = selectedDerived?.spreadPct
            let spreadPercentile: number | null = null
            if (curSpreadPct != null && spreadRows.length > 1) {
              const rank = spreadRows.filter(s => s <= curSpreadPct).length
              spreadPercentile = (rank / spreadRows.length) * 100
            }
            return (
              <section className="od-detail-section" aria-labelledby="od-contract-sec-liquidity">
                <h4 id="od-contract-sec-liquidity" className="od-detail-section-title">Liquidity</h4>
                {liquidityLoading && <p className="section-hint">Loading liquidity data…</p>}
                <div className="od-card-grid">
                  <div className="od-card-section">
                    <div className="od-card-section-title">Tradability Score</div>
                    <div className="od-tradability-score">
                      <span className={`od-tradability-value od-tradability-${tradability.score >= 60 ? 'good' : tradability.score >= 30 ? 'fair' : 'poor'}`}>
                        {tradability.score}
                      </span>
                      <span className="od-tradability-label">/ 100</span>
                    </div>
                    <div className="od-tradability-factors">
                      {tradability.factors.map(f => (
                        <div key={f.label} className="od-tradability-factor">
                          <span className="od-kv-k">{f.label}</span>
                          <span className="od-kv-v">+{f.contribution} <span className="od-kv-dim">({f.detail})</span></span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="od-card-section">
                    <div className="od-card-section-title">Spread Analysis</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Spread ($)</span><span className="od-kv-v">{selectedDerived?.spread != null ? fmtUsd(selectedDerived.spread) : '—'}</span>
                      <span className="od-kv-k">Spread (%)</span>
                      <span className="od-kv-v">
                        {serverLiquidity?.spread_pct != null ? `${serverLiquidity.spread_pct.toFixed(1)}%` : selectedDerived?.spreadPct != null ? `${selectedDerived.spreadPct.toFixed(1)}%` : '—'}
                      </span>
                      <span className="od-kv-k">Percentile</span>
                      <span className="od-kv-v">
                        {serverLiquidity?.spread_percentile != null
                          ? `${serverLiquidity.spread_percentile.toFixed(0)}th`
                          : spreadPercentile != null ? `${spreadPercentile.toFixed(0)}th` : '—'}
                        <span className="od-kv-dim"> (vs {serverLiquidity?.contracts_compared ?? spreadRows.length} same-side contracts)</span>
                      </span>
                      <span className="od-kv-k">OI</span>
                      <span className="od-kv-v">{serverLiquidity?.oi != null ? String(serverLiquidity.oi) : selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                      {serverLiquidity?.oi_percentile != null && (
                        <>
                          <span className="od-kv-k">OI Percentile</span>
                          <span className="od-kv-v">{serverLiquidity.oi_percentile.toFixed(0)}th</span>
                        </>
                      )}
                      {serverLiquidity?.snapshot_ts && (
                        <>
                          <span className="od-kv-k">Snapshot</span>
                          <span className="od-kv-v od-kv-dim">{new Date(serverLiquidity.snapshot_ts).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="od-card-section">
                    <div className="od-card-section-title">Last Trade</div>
                    {liquidityLastTrade ? (
                      <div className="od-kv-grid">
                        <span className="od-kv-k">Price</span><span className="od-kv-v">{fmtUsd(Number(liquidityLastTrade.price))}</span>
                        <span className="od-kv-k">Size</span><span className="od-kv-v">{String(liquidityLastTrade.size ?? '—')}</span>
                        <span className="od-kv-k">Age</span>
                        <span className="od-kv-v">
                          {lastTradeAge != null ? (lastTradeAge < 3600 ? `${Math.round(lastTradeAge / 60)}m ago` : `${(lastTradeAge / 3600).toFixed(1)}h ago`) : '—'}
                        </span>
                        <span className="od-kv-k">Exchange</span><span className="od-kv-v">{String(liquidityLastTrade.exchange ?? '—')}</span>
                      </div>
                    ) : (
                      <p className="section-hint">{liquidityLoading ? 'Loading…' : 'No last trade data available.'}</p>
                    )}
                  </div>
                  <div className="od-card-section">
                    <div className="od-card-section-title">Quote Activity</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Recent Quotes</span>
                      <span className="od-kv-v">{liquidityQuoteCount != null ? `${liquidityQuoteCount} updates` : '—'}</span>
                    </div>
                  </div>
                </div>

                {/* P3: Execution guidance */}
                <div className="od-exec-guidance">
                  <span className="od-exec-guidance-title">Execution Notes</span>
                  {selectedDerived?.spreadPct != null && selectedDerived.spreadPct > 10 && (
                    <span className="od-exec-chip od-exec-chip--warn">Wide spread — use limit near mid</span>
                  )}
                  {selectedDerived?.spreadPct != null && selectedDerived.spreadPct <= 3 && (
                    <span className="od-exec-chip od-exec-chip--ok">Tight spread</span>
                  )}
                  {(selectedRow.open_interest == null || selectedRow.open_interest < 10) && (
                    <span className="od-exec-chip od-exec-chip--warn">Low OI — thin liquidity</span>
                  )}
                  {lastTradeAge != null && lastTradeAge > 3600 && (
                    <span className="od-exec-chip od-exec-chip--warn">Stale tape — last trade &gt;1h</span>
                  )}
                  {selectedRow.bid == null &&
                    selectedRow.ask == null &&
                    effectiveQuotePremium(selectedRow) != null && (
                    <span className="od-exec-chip od-exec-chip--warn">
                      No live NBBO — mark uses mid/day-bar fallback (not a live quote)
                    </span>
                  )}
                  {selectedRow.bid == null &&
                    selectedRow.ask == null &&
                    effectiveQuotePremium(selectedRow) == null && (
                    <span className="od-exec-chip od-exec-chip--danger">No bid/ask or day bar — illiquid or no data</span>
                  )}
                  {tradability.score >= 60 && selectedDerived?.spreadPct != null && selectedDerived.spreadPct <= 5 && (
                    <span className="od-exec-chip od-exec-chip--ok">Good tradability</span>
                  )}
                </div>
              </section>
            )
          })()}

          {/* ── Risk (P2) ── */}
          {(() => {
            const scenarios = computeScenarios(selectedRow, underlyingPrice)
            const hasGreeks = selectedRow.delta != null && Number.isFinite(selectedRow.delta!)
            return (
              <section className="od-detail-section" aria-labelledby="od-contract-sec-risk">
                <h4 id="od-contract-sec-risk" className="od-detail-section-title">Risk</h4>
                {!hasGreeks && (
                  <p className="section-hint">Greeks not available for this contract. Risk scenarios require at least delta.</p>
                )}
                <div className="od-card-grid">
                  <div className="od-card-section">
                    <div className="od-card-section-title">Greeks (per contract)</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Delta (Δ)</span><span className="od-kv-v">{fmtOptNum(selectedRow.delta, 4)}</span>
                      <span className="od-kv-k">Gamma (Γ)</span><span className="od-kv-v">{fmtOptNum(selectedRow.gamma, 4)}</span>
                      <span className="od-kv-k">Theta (Θ)</span><span className="od-kv-v">{fmtOptNum(selectedRow.theta, 4)}</span>
                      <span className="od-kv-k">Vega (ν)</span><span className="od-kv-v">{fmtOptNum(selectedRow.vega, 4)}</span>
                      <span className="od-kv-k">IV</span><span className="od-kv-v">{fmtIV(selectedRow.iv)}</span>
                    </div>
                  </div>
                  {scenarios.length > 0 && (
                    <div className="od-card-section">
                      <div className="od-card-section-title">Scenario Analysis (1 contract = 100 shares)</div>
                      <table className="od-scenario-table">
                        <thead>
                          <tr>
                            <th>Scenario</th>
                            <th>Est. PnL</th>
                            <th>Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scenarios.map(s => (
                            <tr key={s.label}>
                              <td>{s.label}</td>
                              <td className={s.pnl != null && s.pnl >= 0 ? 'od-pnl-pos' : 'od-pnl-neg'}>
                                {s.pnl != null ? `${s.pnl >= 0 ? '+' : ''}${fmtUsd(s.pnl)}` : '—'}
                              </td>
                              <td className="od-kv-dim">{s.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="od-card-section">
                    <div className="od-card-section-title">Exposure Summary</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Delta $ (per 1 lot)</span>
                      <span className="od-kv-v">
                        {selectedRow.delta != null && underlyingPrice != null
                          ? fmtUsd(selectedRow.delta * underlyingPrice * 100)
                          : '—'}
                      </span>
                      <span className="od-kv-k">Theta $ / day</span>
                      <span className="od-kv-v">
                        {selectedRow.theta != null ? fmtUsd(selectedRow.theta * 100) : '—'}
                      </span>
                      <span className="od-kv-k">Vega $ / 1pt IV</span>
                      <span className="od-kv-v">
                        {selectedRow.vega != null ? fmtUsd(selectedRow.vega * 100 * 0.01) : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </section>
            )
          })()}

          {/* ── Relative Value (P2) ── */}
          {(() => {
            const clientRv = computeRelativeValue(selectedRow, snapshotRows)
            const hasServer = serverRelativeValue?.ok && serverRelativeValue.label != null
            const rvLabel = hasServer ? serverRelativeValue!.label! : clientRv.label
            const rvZScore = hasServer ? serverRelativeValue!.iv_zscore : clientRv.ivZScore
            const rvAvgIv = hasServer ? serverRelativeValue!.avg_iv : clientRv.neighborAvgIv
            const rvCount = hasServer ? serverRelativeValue!.contracts_compared : clientRv.neighborCount
            const sameRight = snapshotRows.filter(r => r.right === selectedRow.right && r.iv != null && Number.isFinite(r.iv!))
            return (
              <section className="od-detail-section" aria-labelledby="od-contract-sec-relative">
                <h4 id="od-contract-sec-relative" className="od-detail-section-title">Relative Value</h4>
                <div className="od-card-grid">
                  <div className="od-card-section">
                    <div className="od-card-section-title">IV Relative Value {hasServer && <span className="od-kv-dim">(server)</span>}</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Label</span>
                      <span className={`od-kv-v od-rv-label od-rv-label--${rvLabel.toLowerCase()}`}>
                        {rvLabel}
                      </span>
                      <span className="od-kv-k">IV z-score</span>
                      <span className="od-kv-v">{rvZScore != null ? Number(rvZScore).toFixed(2) : '—'}</span>
                      <span className="od-kv-k">This IV</span>
                      <span className="od-kv-v">{fmtIV(selectedRow.iv)}</span>
                      <span className="od-kv-k">Avg IV (same side)</span>
                      <span className="od-kv-v">{rvAvgIv != null ? Number(rvAvgIv).toFixed(4) : '—'}</span>
                      {serverRelativeValue?.std_iv != null && (
                        <>
                          <span className="od-kv-k">Std IV</span>
                          <span className="od-kv-v">{Number(serverRelativeValue.std_iv).toFixed(4)}</span>
                        </>
                      )}
                      <span className="od-kv-k">Contracts compared</span>
                      <span className="od-kv-v">{rvCount ?? 0}</span>
                    </div>
                  </div>
                  {sameRight.length >= 3 && (
                    <div className="od-card-section">
                      <div className="od-card-section-title">IV Smile (same expiry, {selectedRow.right === 'C' ? 'Calls' : 'Puts'})</div>
                      <OdChartExpandOnHover
                        title={`IV Smile (same expiry, ${selectedRow.right === 'C' ? 'Calls' : 'Puts'})`}
                      >
                        <>
                          <IvSmileLegend side={selectedRow.right === 'C' ? 'call' : 'put'} underlying={underlyingPrice} />
                          <IvSmileChart rows={sameRight} underlying={underlyingPrice} side={selectedRow.right === 'C' ? 'call' : 'put'} />
                        </>
                      </OdChartExpandOnHover>
                    </div>
                  )}
                </div>

                {/* P2: Data Quality Badge */}
                {greeksCoverage?.ok && greeksCoverage.total != null && greeksCoverage.total > 0 && (
                  <div className="od-quality-badge">
                    <span className="od-quality-badge-title">Data Quality</span>
                    <span className="od-quality-item">IV {greeksCoverage.coverage?.iv_pct ?? 0}%</span>
                    <span className="od-quality-item">Greeks {greeksCoverage.coverage?.full_greeks_pct ?? 0}%</span>
                    <span className="od-quality-item">OI {greeksCoverage.coverage?.with_oi ?? 0} contracts</span>
                  </div>
                )}
              </section>
            )
          })()}
          </div>
        </section>
      )}
            </OdLayerSection>

          <OptionDiscoveryCompareDrawer
            open={compareOpen}
            onClose={() => setCompareOpen(false)}
            rows={compareRows}
            symbol={selectedSymbol}
            expiration={selectedExpiration}
            dteLabel={expirationDaysFromToday(selectedExpiration)}
            onRemove={i => setCompareRows(prev => prev.filter((_, j) => j !== i))}
            onClear={() => setCompareRows([])}
          />
        </div>{/* end option-discovery-main-inner */}
        </div>{/* end option-discovery-main */}
      </div>{/* end option-discovery-layout */}
    </div>
  )
}
