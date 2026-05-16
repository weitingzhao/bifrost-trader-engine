import type { Execution, OptionStockLinkSummary, PerformanceResponse } from '../../types'
import { fetchExecutions } from '../../api'
import {
  getStkLedgerBucketForExecution,
  type PerformanceCalendarAssetTab,
  type StkLedgerBucket,
} from '../portfolio/stkLedgerBucket'
import { fetchOptionStockLinkMapForExecutions } from './fetchOptionStockLinkMap'
import {
  computeBackendOptPairsFromExecutions,
  computeOptionDayPnLForPerformanceDate,
  dateStrMinusDays,
  executionDateStr,
  getChicagoDayRange,
  listDateStrings,
  listMonthKeysInRange,
  sortExecByExecutionDateThenTime,
} from './performanceUtils'

const FETCH_LIMIT = 10000

const STK_BUCKETS: readonly StkLedgerBucket[] = ['stocks', 'fixed_income', 'cash_like']

export type { PerformanceCalendarAssetTab }

/** Filter executions to those with `time` in [since_ts, until_ts] (inclusive), matching GET /executions. */
export function filterExecutionsByUnixRange(
  execs: Execution[],
  since_ts: number,
  until_ts: number,
): Execution[] {
  return execs.filter((e) => {
    const t = e.time
    if (t == null || !Number.isFinite(Number(t))) return false
    const tf = Number(t)
    return tf >= since_ts && tf <= until_ts
  })
}

function dedupeExecutionsById(rows: Execution[]): Execution[] {
  const m = new Map<number, Execution>()
  for (const e of rows) {
    const id = e.account_executions_id
    if (id != null && Number.isFinite(Number(id))) m.set(Number(id), e)
  }
  return [...m.values()].sort((a, b) => sortExecByExecutionDateThenTime(a, b))
}

/**
 * Fetch all executions in [lookbackStartDateStr, rangeEndDateStr] (Chicago day bounds), merging chunked
 * responses if the row cap is hit.
 */
export async function fetchPerformanceExecutionsMerged(
  lookbackStartDateStr: string,
  rangeEndDateStr: string,
  strategyOpportunityId: number | null,
  strategyInstanceId: number | null,
  sourceScope: 'performance_book' | 'on_the_fly' = 'performance_book',
): Promise<Execution[]> {
  const { since_ts: gSince } = getChicagoDayRange(lookbackStartDateStr)
  const { until_ts: gUntil } = getChicagoDayRange(rangeEndDateStr)

  const one = await fetchExecutions(
    gSince,
    gUntil,
    FETCH_LIMIT,
    false,
    strategyOpportunityId ?? undefined,
    strategyInstanceId ?? undefined,
    sourceScope,
  )
  let rows = one.executions ?? []
  if (rows.length < FETCH_LIMIT) {
    return dedupeExecutionsById(rows)
  }

  const monthKeys = listMonthKeysInRange(lookbackStartDateStr, rangeEndDateStr)
  const merged: Execution[] = []
  for (const mk of monthKeys) {
    const [y, m] = mk.split('-').map(Number)
    const firstDateStr = `${mk}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const lastDateStr = `${mk}-${String(lastDay).padStart(2, '0')}`
    const chunkLb = dateStrMinusDays(firstDateStr, 180)
    const { since_ts: cs } = getChicagoDayRange(chunkLb)
    const { until_ts: cu } = getChicagoDayRange(lastDateStr)
    const res = await fetchExecutions(
      cs,
      cu,
      FETCH_LIMIT,
      false,
      strategyOpportunityId ?? undefined,
      strategyInstanceId ?? undefined,
      sourceScope,
    )
    merged.push(...(res.executions ?? []))
  }
  return dedupeExecutionsById(merged)
}

export type PerformanceDayPnLCell = { realized: number; unrealized: number }

export interface PerformanceDayPnLBulkResult {
  /** Per visible-month day, for each asset tab (Chicago month grid). */
  calendarDayPnLByAsset: Record<PerformanceCalendarAssetTab, Record<string, PerformanceDayPnLCell>>
  byDayRangeData: {
    opt: Record<string, PerformanceDayPnLCell>
    /** All STK (same as sum of three buckets per day when classification partitions). */
    stock: Record<string, PerformanceDayPnLCell>
    stocks: Record<string, PerformanceDayPnLCell>
    fixed_income: Record<string, PerformanceDayPnLCell>
    cash_like: Record<string, PerformanceDayPnLCell>
    /** Per range date: Σ |qty|×price for STK fills on that trade date in each bucket (Trade Ledger notional). */
    stkBucketNotional: {
      stocks: Record<string, number>
      fixed_income: Record<string, number>
      cash_like: Record<string, number>
    }
  }
  /** Visible calendar month only: daily notional per STK bucket (for Stocks / FI / Cash-like tabs). */
  calendarStkNotionalByBucket: Record<StkLedgerBucket, Record<string, number>>
  linkByOptionId: Record<number, OptionStockLinkSummary>
  /** Full execution window used for drill-down when the selected day falls in range */
  rawExecsWindow: Execution[]
}

function monthGridForSource(
  cy: number,
  cm: number,
  source: Record<string, PerformanceDayPnLCell>,
): Record<string, PerformanceDayPnLCell> {
  const lastD = new Date(cy, cm, 0).getDate()
  const out: Record<string, PerformanceDayPnLCell> = {}
  for (let day = 1; day <= lastD; day++) {
    const dateStr = `${cy}-${String(cm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const o = source[dateStr]
    out[dateStr] = o ? { realized: o.realized, unrealized: o.unrealized } : { realized: 0, unrealized: 0 }
  }
  return out
}

function monthGridForNotional(cy: number, cm: number, source: Record<string, number>): Record<string, number> {
  const lastD = new Date(cy, cm, 0).getDate()
  const out: Record<string, number> = {}
  for (let day = 1; day <= lastD; day++) {
    const dateStr = `${cy}-${String(cm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    out[dateStr] = source[dateStr] ?? 0
  }
  return out
}

/** Σ |qty| × price for one STK fill (same as Trade Ledger trade size; always ≥ 0). */
export function stkFillNotional(e: Execution): number {
  if ((e.sec_type ?? '').toUpperCase() !== 'STK') return 0
  const q = Math.abs(Number(e.quantity) || 0)
  const p = Number(e.price) || 0
  return q * p
}

/**
 * Signed trade notional for STK: `quantity × price` when quantity is signed (IB convention);
 * if quantity is unsigned, infer sign from side (SELL → +|q|×p, BUY → −|q|×p).
 * Used for Stocks / Fixed income daily aggregates (net buy vs sell); Cash-like uses {@link stkFillNotional}.
 */
export function stkSignedTradeNotionalUsd(e: Execution): number {
  if ((e.sec_type ?? '').toUpperCase() !== 'STK') return 0
  const p = Number(e.price) || 0
  if (!Number.isFinite(p)) return 0
  const qRaw = Number(e.quantity)
  if (Number.isFinite(qRaw) && Math.abs(qRaw) > 1e-12) {
    return qRaw * p
  }
  const absQ = Math.abs(Number(e.quantity) || 0)
  if (absQ <= 0) return 0
  const nv = absQ * p
  const side = (e.side ?? '').toString().trim().toUpperCase()
  if (side === 'SELL' || side === 'SLD' || side === 'S') return nv
  if (side === 'BUY' || side === 'BOT' || side === 'B') return -nv
  return nv
}

/**
 * Sum broker-reported `realized_pnl` on STK fills for Chicago trade date `tradeDateStr`, optionally filtered by
 * Ledger bucket. Matches the drill-down table and Trade Ledger (Flex), unlike FIFO replay on a subset of fills.
 */
export function sumStkBrokerRealizedPnlForTradeDate(
  execs: readonly Execution[],
  tradeDateStr: string,
  bucket: 'all' | StkLedgerBucket,
  positionCategoryByAccountContract: Map<string, string>,
): number {
  let sum = 0
  for (const e of execs) {
    if ((e.sec_type ?? '').toUpperCase() !== 'STK') continue
    if (executionDateStr(e) !== tradeDateStr) continue
    if (bucket !== 'all') {
      if (getStkLedgerBucketForExecution(e, positionCategoryByAccountContract) !== bucket) continue
    }
    sum += Number(e.realized_pnl) || 0
  }
  return sum
}

/**
 * One batched load: merged executions + one bulk link query, then per-day OPT/STK R/U in memory.
 * STK bucket realized uses Σ execution `realized_pnl` (same as Ledger); OPT uses existing day logic.
 */
export async function loadPerformanceDayPnLBulk(params: {
  sinceStr: string
  untilStr: string
  calendarMonth: string
  strategyOpportunityId: number | null
  strategyInstanceId: number | null
  lookBackDays: number
  positionCategoryByAccountContract: Map<string, string>
}): Promise<PerformanceDayPnLBulkResult> {
  const {
    sinceStr,
    untilStr,
    calendarMonth,
    strategyOpportunityId,
    strategyInstanceId,
    lookBackDays,
    positionCategoryByAccountContract,
  } = params

  const lookbackStartDateStr = dateStrMinusDays(sinceStr, lookBackDays)
  const rawExecsWindow = await fetchPerformanceExecutionsMerged(
    lookbackStartDateStr,
    untilStr,
    strategyOpportunityId,
    strategyInstanceId,
    'performance_book',
  )
  const linkByOptionId = await fetchOptionStockLinkMapForExecutions(rawExecsWindow)

  const rangeDates = listDateStrings(sinceStr, untilStr)
  const opt: Record<string, PerformanceDayPnLCell> = {}
  const stock: Record<string, PerformanceDayPnLCell> = {}
  const stocks: Record<string, PerformanceDayPnLCell> = {}
  const fixed_income: Record<string, PerformanceDayPnLCell> = {}
  const cash_like: Record<string, PerformanceDayPnLCell> = {}
  const notionalStocks: Record<string, number> = {}
  const notionalFi: Record<string, number> = {}
  const notionalCash: Record<string, number> = {}

  for (const dateStr of rangeDates) {
    const lb = dateStrMinusDays(dateStr, lookBackDays)
    const { since_ts } = getChicagoDayRange(lb)
    const { until_ts: dayEnd } = getChicagoDayRange(dateStr)
    const slice = filterExecutionsByUnixRange(rawExecsWindow, since_ts, dayEnd)
    const pairs = computeBackendOptPairsFromExecutions(slice, sortExecByExecutionDateThenTime)
    const optRes = computeOptionDayPnLForPerformanceDate(dateStr, slice, pairs, linkByOptionId)
    opt[dateStr] = { realized: optRes.realized, unrealized: optRes.unrealized }
    const stockR = sumStkBrokerRealizedPnlForTradeDate(rawExecsWindow, dateStr, 'all', positionCategoryByAccountContract)
    stock[dateStr] = { realized: stockR, unrealized: 0 }

    for (const b of STK_BUCKETS) {
      const r = sumStkBrokerRealizedPnlForTradeDate(rawExecsWindow, dateStr, b, positionCategoryByAccountContract)
      const cell: PerformanceDayPnLCell = { realized: r, unrealized: 0 }
      if (b === 'stocks') stocks[dateStr] = cell
      else if (b === 'fixed_income') fixed_income[dateStr] = cell
      else cash_like[dateStr] = cell
    }

    let ns = 0
    let nf = 0
    let nc = 0
    for (const e of rawExecsWindow) {
      if ((e.sec_type ?? '').toUpperCase() !== 'STK') continue
      if (executionDateStr(e) !== dateStr) continue
      const buck = getStkLedgerBucketForExecution(e, positionCategoryByAccountContract)
      if (buck === 'stocks') ns += stkSignedTradeNotionalUsd(e)
      else if (buck === 'fixed_income') nf += stkSignedTradeNotionalUsd(e)
      else if (buck === 'cash_like') nc += stkFillNotional(e)
    }
    notionalStocks[dateStr] = ns
    notionalFi[dateStr] = nf
    notionalCash[dateStr] = nc
  }

  const [cy, cm] = calendarMonth.split('-').map(Number)

  const calendarDayPnLByAsset: Record<PerformanceCalendarAssetTab, Record<string, PerformanceDayPnLCell>> = {
    options: monthGridForSource(cy, cm, opt),
    stocks: monthGridForSource(cy, cm, stocks),
    fixed_income: monthGridForSource(cy, cm, fixed_income),
    cash_like: monthGridForSource(cy, cm, cash_like),
  }

  const calendarStkNotionalByBucket: Record<StkLedgerBucket, Record<string, number>> = {
    stocks: monthGridForNotional(cy, cm, notionalStocks),
    fixed_income: monthGridForNotional(cy, cm, notionalFi),
    cash_like: monthGridForNotional(cy, cm, notionalCash),
  }

  return {
    calendarDayPnLByAsset,
    calendarStkNotionalByBucket,
    byDayRangeData: {
      opt,
      stock,
      stocks,
      fixed_income,
      cash_like,
      stkBucketNotional: {
        stocks: notionalStocks,
        fixed_income: notionalFi,
        cash_like: notionalCash,
      },
    },
    linkByOptionId,
    rawExecsWindow,
  }
}

/** Month-scoped calendar rows from a full-range `data` response (same month shown in the grid). */
export function slicePerformanceForCalendarMonth(
  data: PerformanceResponse,
  calendarMonth: string,
): PerformanceResponse {
  const [y, m] = calendarMonth.split('-').map(Number)
  const pfx = `${y}-${String(m).padStart(2, '0')}-`
  const cal = (data.calendar ?? []).filter((r) => (r.period_label ?? '').startsWith(pfx))
  const bySec = (data.calendar_by_sec_type ?? []).filter((r) => (r.period_label ?? '').startsWith(pfx))
  return { ...data, calendar: cal, calendar_by_sec_type: bySec }
}
