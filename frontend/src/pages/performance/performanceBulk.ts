import type { Execution, OptionStockLinkSummary, PerformanceResponse } from '../../types'
import { fetchExecutions } from '../../api'
import { fetchOptionStockLinkMapForExecutions } from './fetchOptionStockLinkMap'
import {
  computeBackendOptPairsFromExecutions,
  computeOptionDayPnLForPerformanceDate,
  computeStockDayPnLForPerformanceDate,
  dateStrMinusDays,
  getChicagoDayRange,
  listDateStrings,
  listMonthKeysInRange,
  sortExecByExecutionDateThenTime,
} from './performanceUtils'

const FETCH_LIMIT = 10000

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

export interface PerformanceDayPnLBulkResult {
  calendarDayPnL: Record<string, { realized: number; unrealized: number }>
  byDayRangeData: {
    opt: Record<string, { realized: number; unrealized: number }>
    stock: Record<string, { realized: number; unrealized: number }>
  }
  linkByOptionId: Record<number, OptionStockLinkSummary>
  /** Full execution window used for drill-down when the selected day falls in range */
  rawExecsWindow: Execution[]
}

/**
 * One batched load: merged executions + one bulk link query, then per-day OPT/STK R/U in memory.
 */
export async function loadPerformanceDayPnLBulk(params: {
  sinceStr: string
  untilStr: string
  calendarMonth: string
  strategyOpportunityId: number | null
  strategyInstanceId: number | null
  lookBackDays: number
}): Promise<PerformanceDayPnLBulkResult> {
  const { sinceStr, untilStr, calendarMonth, strategyOpportunityId, strategyInstanceId, lookBackDays } = params

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
  const opt: Record<string, { realized: number; unrealized: number }> = {}
  const stock: Record<string, { realized: number; unrealized: number }> = {}

  for (const dateStr of rangeDates) {
    const lb = dateStrMinusDays(dateStr, lookBackDays)
    const { since_ts } = getChicagoDayRange(lb)
    const { until_ts: dayEnd } = getChicagoDayRange(dateStr)
    const slice = filterExecutionsByUnixRange(rawExecsWindow, since_ts, dayEnd)
    const pairs = computeBackendOptPairsFromExecutions(slice, sortExecByExecutionDateThenTime)
    const optRes = computeOptionDayPnLForPerformanceDate(dateStr, slice, pairs, linkByOptionId)
    opt[dateStr] = { realized: optRes.realized, unrealized: optRes.unrealized }
    const stkRes = computeStockDayPnLForPerformanceDate(dateStr, slice, sortExecByExecutionDateThenTime)
    stock[dateStr] = { realized: stkRes.realized, unrealized: stkRes.unrealized }
  }

  const [cy, cm] = calendarMonth.split('-').map(Number)
  const lastD = new Date(cy, cm, 0).getDate()
  const calendarDayPnL: Record<string, { realized: number; unrealized: number }> = {}
  for (let day = 1; day <= lastD; day++) {
    const dateStr = `${cy}-${String(cm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const o = opt[dateStr]
    if (o) {
      calendarDayPnL[dateStr] = { realized: o.realized, unrealized: o.unrealized }
    } else {
      calendarDayPnL[dateStr] = { realized: 0, unrealized: 0 }
    }
  }

  return {
    calendarDayPnL,
    byDayRangeData: { opt, stock },
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
