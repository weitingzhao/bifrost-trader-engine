import { useCallback, useEffect, useState, Fragment } from 'react'
import type { Execution, PerformanceResponse, StatusResponse } from '../types'
import type { BackendOptPair } from '../types'
import { fetchExecutions, fetchPerformance } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtChicagoTime, fmtPnl, fmtPnlCalendar, fmtUsd } from '../utils/format'
import {
  computeDayRealizedUnrealized,
  computeDayRealizedUnrealizedStock,
  computeOptPairsFromExecutions,
  dateStrMinusDays,
  executionDateStr,
  execPnl,
  getChicagoDayRange,
  getTimeRangeDates,
  listDateStrings,
  listMonthKeysInRange,
  matchPnl,
  normalizeStrike,
  optionRightToFull,
  sortExecByTradeDateThenTime,
} from './performance/performanceUtils'

interface PerformancePageProps {
  status: StatusResponse | null
  onViewChange?: (view: 'accounts') => void
}

export function PerformancePage({ status: _status, onViewChange }: PerformancePageProps) {
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<'quarter' | 'year' | '3year'>('quarter')
  const [calendarMonth, setCalendarMonth] = useState<string>(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedDayPnLType, setSelectedDayPnLType] = useState<'realized' | 'unrealized'>('realized')
  const [selectedDaySymbolTab, setSelectedDaySymbolTab] = useState<string | null>(null)
  const [selectedDayExecutions, setSelectedDayExecutions] = useState<Execution[] | null>(null)
  const [selectedDayOptPairs, setSelectedDayOptPairs] = useState<BackendOptPair[] | null>(null)
  const [selectedDayExecutionsLoading, setSelectedDayExecutionsLoading] = useState(false)
  const [calendarDayPnL, setCalendarDayPnL] = useState<Record<string, { realized: number; unrealized: number }> | null>(null)
  const [calendarDayPnLLoading, setCalendarDayPnLLoading] = useState(false)
  const [calendarMonthPerformance, setCalendarMonthPerformance] = useState<PerformanceResponse | null>(null)
  const [calendarMonthPerformanceLoading, setCalendarMonthPerformanceLoading] = useState(false)
  const [byDayExpandedMonths, setByDayExpandedMonths] = useState<Set<string>>(new Set())
  const [byDayRangeData, setByDayRangeData] = useState<{
    opt: Record<string, { realized: number; unrealized: number }>
    stock: Record<string, { realized: number; unrealized: number }>
  } | null>(null)
  const [byDayRangeLoading, setByDayRangeLoading] = useState(false)
  const [selectedDayComputedPnL, setSelectedDayComputedPnL] = useState<{ realized: number; unrealized: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const { since_ts } = getChicagoDayRange(sinceStr)
    const { until_ts } = getChicagoDayRange(untilStr)
    try {
      const res = await fetchPerformance({
        since_ts,
        until_ts,
        account_id: undefined,
        granularity: 'day',
      })
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load performance')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [timeRange, calendarMonth])

  useEffect(() => {
    load()
  }, [load])

  // By day: default all months collapsed (do not auto-expand current month)
  // useEffect that auto-expanded calendarMonth removed so newest month is not expanded by default

  // By day: fetch executions per month (same as Calendar logic) and merge for full range
  useEffect(() => {
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const monthKeys = listMonthKeysInRange(sinceStr, untilStr)
    if (monthKeys.length === 0) {
      setByDayRangeData(null)
      setByDayRangeLoading(false)
      return
    }
    setByDayRangeLoading(true)
    setByDayRangeData(null)

    const fetchOneMonth = (monthKey: string): Promise<{ opt: Record<string, { realized: number; unrealized: number }>; stock: Record<string, { realized: number; unrealized: number }> }> => {
      const [y, m] = monthKey.split('-').map(Number)
      const firstDateStr = `${monthKey}-01`
      const lastDay = new Date(y, m, 0).getDate()
      const lastDateStr = `${monthKey}-${String(lastDay).padStart(2, '0')}`
      const { since_ts } = getChicagoDayRange(firstDateStr)
      const { until_ts } = getChicagoDayRange(lastDateStr)
      return fetchExecutions(since_ts, until_ts, 5000, true)
        .then((res) => {
          const execs = res.executions ?? []
          const optPairs = 'opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null
          const execById = new Map<number, Execution>()
          for (const e of execs) {
            if (e.id != null) execById.set(e.id, e)
          }
          const optMap: Record<string, { realized: number; unrealized: number }> = {}
          const stockMap: Record<string, { realized: number; unrealized: number }> = {}
          for (let day = 1; day <= lastDay; day++) {
            const dateStr = `${monthKey}-${String(day).padStart(2, '0')}`
            const dayExecs = execs.filter((e) => executionDateStr(e) === dateStr)
            const sameDayPairs =
              optPairs == null
                ? null
                : optPairs.filter((p) => {
                  const legP = execById.get(p.leg_p_execution_id)
                  const pDate = legP != null ? executionDateStr(legP) : ''
                  return pDate === dateStr
                })
            const useBackendPairs = sameDayPairs != null && sameDayPairs.length > 0
            const { realized: optR, unrealized: optU } = computeDayRealizedUnrealized(
              dayExecs,
              useBackendPairs ? sameDayPairs : null,
            )
            const { realized: stkR, unrealized: stkU } = computeDayRealizedUnrealizedStock(dayExecs)
            optMap[dateStr] = { realized: optR, unrealized: optU }
            stockMap[dateStr] = { realized: stkR, unrealized: stkU }
          }
          return { opt: optMap, stock: stockMap }
        })
    }

    Promise.all(monthKeys.map(fetchOneMonth))
      .then((results) => {
        const optMap: Record<string, { realized: number; unrealized: number }> = {}
        const stockMap: Record<string, { realized: number; unrealized: number }> = {}
        for (const r of results) {
          Object.assign(optMap, r.opt)
          Object.assign(stockMap, r.stock)
        }
        setByDayRangeData({ opt: optMap, stock: stockMap })
      })
      .catch(() => {
        const dateStrsList = listDateStrings(sinceStr, untilStr)
        const fallbackOpt: Record<string, { realized: number; unrealized: number }> = {}
        const fallbackStock: Record<string, { realized: number; unrealized: number }> = {}
        for (const dateStr of dateStrsList) {
          fallbackOpt[dateStr] = { realized: 0, unrealized: 0 }
          fallbackStock[dateStr] = { realized: 0, unrealized: 0 }
        }
        setByDayRangeData({ opt: fallbackOpt, stock: fallbackStock })
      })
      .finally(() => setByDayRangeLoading(false))
  }, [timeRange, calendarMonth])

  useEffect(() => {
    setSelectedDay(null)
    setSelectedDayPnLType('realized')
    setSelectedDaySymbolTab(null)
  }, [calendarMonth])

  // Reset PnL type and symbol tab when switching to another day
  useEffect(() => {
    if (selectedDay) {
      setSelectedDayPnLType('realized')
      setSelectedDaySymbolTab(null)
    }
  }, [selectedDay])

  // Fetch executions for the calendar month and compute per-day Realized/Unrealized (same as Records)
  useEffect(() => {
    if (!calendarMonth) {
      setCalendarDayPnL(null)
      return
    }
    const [y, m] = calendarMonth.split('-').map(Number)
    const firstDateStr = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const lastDateStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const { since_ts } = getChicagoDayRange(firstDateStr)
    const { until_ts } = getChicagoDayRange(lastDateStr)
    setCalendarDayPnLLoading(true)
    setCalendarDayPnL(null)
    fetchExecutions(since_ts, until_ts, 5000, true)
      .then((res) => {
        const execs = res.executions ?? []
        const optPairs = 'opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null
        const execById = new Map<number, Execution>()
        for (const e of execs) {
          if (e.id != null) execById.set(e.id, e)
        }
        const map: Record<string, { realized: number; unrealized: number }> = {}
        for (let day = 1; day <= lastDay; day++) {
          const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const dayExecs = execs.filter((e) => executionDateStr(e) === dateStr)
          const sameDayPairs =
            optPairs == null
              ? null
              : optPairs.filter((p) => {
                const legP = execById.get(p.leg_p_execution_id)
                const pDate = legP != null ? executionDateStr(legP) : ''
                return pDate === dateStr
              })
          const useBackendPairs = sameDayPairs != null && sameDayPairs.length > 0
          const { realized, unrealized } = computeDayRealizedUnrealized(
            dayExecs,
            useBackendPairs ? sameDayPairs : null,
          )
          map[dateStr] = { realized, unrealized }
        }
        setCalendarDayPnL(map)
      })
      .catch(() => setCalendarDayPnL({}))
      .finally(() => setCalendarDayPnLLoading(false))
  }, [calendarMonth])

  // Calendar PnL owns its own performance query for the displayed month (so Time Range does not trigger refetch)
  useEffect(() => {
    if (!calendarMonth) {
      setCalendarMonthPerformance(null)
      return
    }
    const [y, m] = calendarMonth.split('-').map(Number)
    const firstDateStr = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const lastDateStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const { since_ts } = getChicagoDayRange(firstDateStr)
    const { until_ts } = getChicagoDayRange(lastDateStr)
    setCalendarMonthPerformanceLoading(true)
    setCalendarMonthPerformance(null)
    fetchPerformance({
      since_ts,
      until_ts,
      account_id: undefined,
      granularity: 'day',
    })
      .then(setCalendarMonthPerformance)
      .catch(() => setCalendarMonthPerformance(null))
      .finally(() => setCalendarMonthPerformanceLoading(false))
  }, [calendarMonth])

  // When a day is selected, fetch executions from (selectedDay - LOOK_BACK_DAYS) through end of selected day
  // so backend can pair opens from before the month with closes on the selected day; then filter display to selected day only.
  const OPT_PAIR_LOOK_BACK_DAYS = 60
  useEffect(() => {
    if (!selectedDay) {
      setSelectedDayExecutions(null)
      setSelectedDayOptPairs(null)
      setSelectedDayComputedPnL(null)
      return
    }
    const lookBackStart = dateStrMinusDays(selectedDay, OPT_PAIR_LOOK_BACK_DAYS)
    const { since_ts: monthStartTs } = getChicagoDayRange(lookBackStart)
    const { until_ts: dayEndTs } = getChicagoDayRange(selectedDay)
    setSelectedDayExecutionsLoading(true)
    fetchExecutions(monthStartTs, dayEndTs, 5000, true)
      .then((res) => {
        setSelectedDayExecutions(res.executions ?? [])
        setSelectedDayOptPairs('opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null)
        const execs = res.executions ?? []
        const optPairs = 'opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null
        const execByIdForDate = new Map(execs.map((e: Execution) => [e.id!, e]))
        const legDate = (eid: number) => {
          const ex = execByIdForDate.get(eid)
          return ex != null ? executionDateStr(ex) : ''
        }
        const dayExecs = execs.filter((e: Execution) => executionDateStr(e) === selectedDay)
        const relevantPairs =
          optPairs != null && optPairs.length > 0
            ? optPairs.filter(
                (p: { leg_c_execution_id?: number; leg_p_execution_id?: number }) =>
                  p.leg_c_execution_id != null &&
                  p.leg_p_execution_id != null &&
                  execByIdForDate.has(p.leg_c_execution_id) &&
                  execByIdForDate.has(p.leg_p_execution_id) &&
                  (legDate(p.leg_c_execution_id) === selectedDay || legDate(p.leg_p_execution_id) === selectedDay),
              )
            : null
        const { realized, unrealized, symbolsRealized, symbolsUnrealized } = computeDayRealizedUnrealized(
          dayExecs,
          relevantPairs != null && relevantPairs.length > 0 ? relevantPairs : null,
        )
        setSelectedDayComputedPnL({ realized, unrealized })
        setCalendarDayPnL((prev) => (prev && selectedDay ? { ...prev, [selectedDay]: { realized, unrealized } } : prev))
        if (symbolsRealized.length === 0 && symbolsUnrealized.length > 0) {
          setSelectedDayPnLType('unrealized')
        }
      })
      .catch(() => {
        setSelectedDayExecutions([])
        setSelectedDayOptPairs(null)
        setSelectedDayComputedPnL(null)
      })
      .finally(() => setSelectedDayExecutionsLoading(false))
  }, [selectedDay])

  const summary = data?.summary

  return (
    <div className="app-page-stack performance-page">
      <section className="card performance-summary-section" aria-label="Performance">
        <h2 className="card-title page-title-with-tooltip">
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Performance'}
        </h2>
        <section className="performance-time-range-block" aria-label="Time range and daily statistics">
        <div className="performance-filters performance-filters-inline">
          {loading && <p className="section-hint performance-filters-loading">Loading…</p>}
          <div className="performance-filter-group">
            <fieldset className="performance-filter performance-filter-time-range" aria-label="Time range">
              <span className="performance-filter-legend-inline">Time range</span>
              <div className="performance-time-range-pills" role="group">
                <label className={`performance-time-range-pill ${timeRange === 'quarter' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="timeRange"
                    value="quarter"
                    checked={timeRange === 'quarter'}
                    onChange={() => setTimeRange('quarter')}
                    className="performance-time-range-pill-input"
                    aria-label="Quarter"
                  />
                  <span className="performance-time-range-pill-label">Quarter</span>
                </label>
                <label className={`performance-time-range-pill ${timeRange === 'year' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="timeRange"
                    value="year"
                    checked={timeRange === 'year'}
                    onChange={() => setTimeRange('year')}
                    className="performance-time-range-pill-input"
                    aria-label="Year"
                  />
                  <span className="performance-time-range-pill-label">Year</span>
                </label>
                <label className={`performance-time-range-pill ${timeRange === '3year' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="timeRange"
                    value="3year"
                    checked={timeRange === '3year'}
                    onChange={() => setTimeRange('3year')}
                    className="performance-time-range-pill-input"
                    aria-label="3 Years"
                  />
                  <span className="performance-time-range-pill-label">3 Years</span>
                </label>
              </div>
            </fieldset>
            {(() => {
              const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
              const fromFmt = sinceStr.replace(/-/g, '/')
              const toFmt = untilStr.replace(/-/g, '/')
              return (
                <span className="performance-range-label" aria-label="Trade range">
                  {fromFmt} ~ {toFmt}
                </span>
              )
            })()}
            {byDayRangeData && (() => {
              const optMap = byDayRangeData.opt
              const stockMap = byDayRangeData.stock
              const dateStrs = Object.keys(optMap).sort()
              const totalSum = dateStrs.reduce(
                (a, dateStr) => {
                  const opt = optMap[dateStr] ?? { realized: 0, unrealized: 0 }
                  const stk = stockMap[dateStr] ?? { realized: 0, unrealized: 0 }
                  return {
                    optRealized: a.optRealized + opt.realized,
                    optUnrealized: a.optUnrealized + opt.unrealized,
                    stkRealized: a.stkRealized + stk.realized,
                    stkUnrealized: a.stkUnrealized + stk.unrealized,
                  }
                },
                { optRealized: 0, optUnrealized: 0, stkRealized: 0, stkUnrealized: 0 },
              )
              return (
                <span className="by-day-total-summary-inline" aria-label="Total sum of all days">
                  <span className="by-day-total-summary-kv">Option <span className={totalSum.optRealized >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtPnl(totalSum.optRealized)}</span> / <span className="by-day-sum-number">{fmtPnl(totalSum.optUnrealized)}</span></span>
                  <span className="by-day-total-summary-kv">Stock <span className={totalSum.stkRealized >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtPnl(totalSum.stkRealized)}</span> / <span className="by-day-sum-number">{fmtPnl(totalSum.stkUnrealized)}</span></span>
                </span>
              )
            })()}
          </div>
        </div>
        {byDayRangeLoading ? (
          <p className="section-hint">Loading…</p>
        ) : !byDayRangeData ? (
          <p className="section-hint">Select time range above to load daily PnL.</p>
        ) : (() => {
          const optMap = byDayRangeData.opt
          const stockMap = byDayRangeData.stock
          const dateStrs = Object.keys(optMap).sort()
          const rows: { dateStr: string; optRealized: number; optUnrealized: number; stkRealized: number; stkUnrealized: number }[] = dateStrs.map((dateStr) => {
            const opt = optMap[dateStr] ?? { realized: 0, unrealized: 0 }
            const stk = stockMap[dateStr] ?? { realized: 0, unrealized: 0 }
            return { dateStr, optRealized: opt.realized, optUnrealized: opt.unrealized, stkRealized: stk.realized, stkUnrealized: stk.unrealized }
          })
          if (dateStrs.length === 0) return <p className="section-hint">No Option or Stock PnL in the selected range.</p>
          const ZERO_THRESH = 0.005
          const pnlTd = (val: number, col: 'optRealized' | 'optUnrealized' | 'stkRealized' | 'stkUnrealized') => {
            if (Math.abs(val) < ZERO_THRESH) return <td>—</td>
            const isUnrealized = col === 'optUnrealized' || col === 'stkUnrealized'
            const cls = isUnrealized ? 'tone-unrealized' : (val >= 0 ? 'tone-positive' : 'tone-negative')
            return <td className={cls}>{fmtPnl(val)}</td>
          }
          const pnlTdSum = (val: number, col: 'optRealized' | 'optUnrealized' | 'stkRealized' | 'stkUnrealized') => {
            if (Math.abs(val) < ZERO_THRESH) return <td>—</td>
            const isUnrealized = col === 'optUnrealized' || col === 'stkUnrealized'
            const cls = isUnrealized ? 'tone-unrealized' : (val >= 0 ? 'tone-positive' : 'tone-negative')
            return <td className={cls}>{fmtPnl(val)}</td>
          }
          const groups = new Map<string, { monthLabel: string; rows: typeof rows }>()
          for (const r of rows) {
            const monthKey = r.dateStr.slice(0, 7)
            if (!groups.has(monthKey)) {
              const [yy, mm] = monthKey.split('-').map(Number)
              groups.set(monthKey, { monthLabel: new Date(yy, mm - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), rows: [] })
            }
            groups.get(monthKey)!.rows.push(r)
          }
          const groupEntriesNewestFirst = Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]))
          const toggleMonth = (key: string) => {
            setByDayExpandedMonths((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
          }
          return (
            <>
            <div className="table-wrap">
              <table className="data-table by-day-table" role="grid">
                <thead><tr><th>Date</th><th>Option Realized</th><th>Option Unrealized</th><th>Stock Realized</th><th>Stock Unrealized</th></tr></thead>
                <tbody>
                  {groupEntriesNewestFirst.map(([monthKey, { monthLabel, rows: groupRows }]) => {
                    const sum = groupRows.reduce((a, r) => ({
                      optRealized: a.optRealized + r.optRealized,
                      optUnrealized: a.optUnrealized + r.optUnrealized,
                      stkRealized: a.stkRealized + r.stkRealized,
                      stkUnrealized: a.stkUnrealized + r.stkUnrealized,
                    }), { optRealized: 0, optUnrealized: 0, stkRealized: 0, stkUnrealized: 0 })
                    const expanded = byDayExpandedMonths.has(monthKey)
                    return (
                      <Fragment key={monthKey}>
                        <tr className="by-day-group-row" onClick={() => toggleMonth(monthKey)} role="button" tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMonth(monthKey) } }}
                          aria-expanded={expanded} aria-label={`${monthLabel}, Sum. Click to ${expanded ? 'collapse' : 'expand'} days`}>
                          <td className="by-day-group-label">
                            <span className="by-day-group-expand" aria-hidden>{expanded ? '▼' : '▶'}</span>
                            <strong>{monthLabel}</strong>
                            <span className="by-day-group-sum-label"> Sum</span>
                          </td>
                          {pnlTdSum(sum.optRealized, 'optRealized')}{pnlTdSum(sum.optUnrealized, 'optUnrealized')}{pnlTdSum(sum.stkRealized, 'stkRealized')}{pnlTdSum(sum.stkUnrealized, 'stkUnrealized')}
                        </tr>
                        {expanded && [...groupRows].reverse().map((r) => (
                          <tr key={r.dateStr} className="by-day-day-row">
                            <td>{r.dateStr}</td>
                            {pnlTd(r.optRealized, 'optRealized')}{pnlTd(r.optUnrealized, 'optUnrealized')}{pnlTd(r.stkRealized, 'stkRealized')}{pnlTd(r.stkUnrealized, 'stkUnrealized')}
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
          )
        })()}
        </section>
      </section>

      {error && (
        <div className="card card-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      <section className="card performance-calendar-section" aria-label="Calendar">
        <h3 className="card-subtitle page-title-with-tooltip">
          Calendar
          <InfoTooltip text="Daily Option Realized and Unrealized in calendar form." />
        </h3>
        {data && summary ? (
          <>
              {calendarMonthPerformanceLoading && (
                <p className="section-hint performance-calendar-loading">Loading calendar…</p>
              )}
              {(() => {
                const bySec = calendarMonthPerformance?.calendar_by_sec_type ?? []
                const optDays: Record<string, { net_pnl: number; pnl: number; commission: number; trade_count: number; pairs?: import('../types').OptRealizedPair[] }> = {}
                bySec.filter((r) => r.sec_type === 'OPT').forEach((r) => {
                  optDays[r.period_label] = { net_pnl: r.net_pnl, pnl: r.pnl, commission: r.commission, trade_count: r.trade_count, pairs: r.pairs }
                })
                const optUnrealized = (calendarMonthPerformance?.unrealized_by_sec_type ?? []).find((u) => u.sec_type === 'OPT')?.total_pnl ?? null
                const [y, m] = calendarMonth.split('-').map(Number)
                const first = new Date(y, m - 1, 1)
                const last = new Date(y, m, 0)
                const startOffset = first.getDay()
                const daysInMonth = last.getDate()
                const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7
                const cells: { day: number | null; dateStr: string | null }[] = []
                for (let i = 0; i < totalCells; i++) {
                  if (i < startOffset) {
                    cells.push({ day: null, dateStr: null })
                  } else if (i < startOffset + daysInMonth) {
                    const day = i - startOffset + 1
                    cells.push({ day, dateStr: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` })
                  } else {
                    cells.push({ day: null, dateStr: null })
                  }
                }
                const hasAnyOptInMonth = calendarDayPnL != null
                  ? Object.keys(calendarDayPnL).length > 0
                  : cells.some((c) => c.dateStr && optDays[c.dateStr] != null)
                const goPrev = () => {
                  const d = new Date(y, m - 2, 1)
                  setCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
                }
                const goNext = () => {
                  const d = new Date(y, m, 1)
                  setCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
                }
                const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                return (
                  <>
                    <div className="performance-calendar-with-summary">
                      <div className="performance-calendar-left">
                    {optUnrealized != null && (
                      <p className="performance-calendar-total-unrealized">
                        Option Unrealized (as of now): <strong className={(optUnrealized ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtUsd(optUnrealized)}</strong>
                      </p>
                    )}
                    {!hasAnyOptInMonth && (
                      <p className="section-hint performance-calendar-no-data">
                        No Option realized in this month (only paired same-day BUY+SELL count). Try a larger range or another month.
                      </p>
                    )}
                    {calendarDayPnLLoading && (
                      <p className="section-hint performance-calendar-loading">Loading daily Realized/Unrealized…</p>
                    )}
                    <div className="performance-calendar-nav">
                      <button type="button" className="btn btn-secondary" onClick={goPrev} aria-label="Previous month">← Prev</button>
                      <span className="performance-calendar-title">{monthLabel}</span>
                      <button type="button" className="btn btn-secondary" onClick={goNext} aria-label="Next month">Next →</button>
                    </div>
                    <div className="performance-calendar-grid" role="grid">
                      <div className="performance-calendar-row performance-calendar-header">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((wd) => (
                          <div key={wd} className="performance-calendar-cell performance-calendar-dow">{wd}</div>
                        ))}
                      </div>
                      {Array.from({ length: totalCells / 7 }, (_, rowIdx) => (
                        <div key={rowIdx} className="performance-calendar-row">
                          {cells.slice(rowIdx * 7, rowIdx * 7 + 7).map((c, colIdx) => {
                            const dayPnL = c.dateStr && calendarDayPnL != null ? calendarDayPnL[c.dateStr] : null
                            const legacyInfo = c.dateStr ? optDays[c.dateStr] : null
                            const useDetailPnL = c.dateStr === selectedDay && selectedDayComputedPnL != null
                            const realizedVal = useDetailPnL ? selectedDayComputedPnL.realized : (dayPnL != null ? dayPnL.realized : (legacyInfo?.net_pnl ?? null))
                            const unrealizedVal = useDetailPnL ? selectedDayComputedPnL.unrealized : (dayPnL != null ? dayPnL.unrealized : null)
                            const showPnL = c.day != null
                            const showR = showPnL && realizedVal != null && Math.abs(Number(realizedVal)) >= 0.005
                            const showU = showPnL && unrealizedVal != null && Math.abs(Number(unrealizedVal)) >= 0.005
                            const toneR = showR && (realizedVal ?? 0) !== 0 ? ((realizedVal!) >= 0 ? 'tone-positive' : 'tone-negative') : ''
                            const toneU = showU && (unrealizedVal ?? 0) !== 0 ? 'tone-unrealized' : ''
                            const titleParts: string[] = []
                            if (useDetailPnL || dayPnL != null || legacyInfo != null) {
                              titleParts.push(`Realized: ${fmtUsd(realizedVal ?? 0)}`)
                              titleParts.push(unrealizedVal != null ? `Unrealized: ${fmtUsd(unrealizedVal)}` : 'Unrealized: —')
                            } else if (c.dateStr) {
                              titleParts.push('No Option trades that day')
                            }
                            return (
                              <div
                                key={colIdx}
                                role={c.dateStr ? 'button' : undefined}
                                tabIndex={c.dateStr ? 0 : undefined}
                                onClick={c.dateStr ? () => setSelectedDay(c.dateStr) : undefined}
                                onKeyDown={c.dateStr ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelectedDay(c.dateStr) } } : undefined}
                                className={`performance-calendar-cell ${c.day == null ? 'performance-calendar-cell-outside' : ''} ${toneR} ${c.dateStr ? 'performance-calendar-cell-clickable' : ''} ${selectedDay === c.dateStr ? 'performance-calendar-cell-selected' : ''}`}
                                title={titleParts.length ? titleParts.join('\n') : (c.dateStr ? 'Click to see contributing records' : undefined)}
                              >
                                {c.day != null && <span className="performance-calendar-day">{c.day}</span>}
                                {(showR || showU) && (
                                  <div className="performance-calendar-pnl-lines">
                                    {showR && (
                                      <span className={`performance-calendar-pnl performance-calendar-realized ${toneR}`}>
                                        R: {fmtPnlCalendar(realizedVal)}
                                      </span>
                                    )}
                                    {showU && (
                                      <span className={`performance-calendar-pnl performance-calendar-unrealized ${toneU}`}>
                                        U: {fmtPnlCalendar(unrealizedVal)}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                      </div>
                    <div className="performance-calendar-summary">
                    <div className="performance-summary-rows performance-summary-inside-calendar">
                      <div className="performance-summary-row performance-summary-row-summary">
                        <span className="performance-summary-type">Summary</span>
                        <div className="performance-summary-metrics">
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Total PnL</span>
                            <span className={`performance-summary-metric-value ${(summary.total_pnl ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}`}>{fmtUsd(summary.total_pnl)}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Realized</span>
                            <span className="performance-summary-metric-value">{fmtUsd(summary.total_realized_pnl ?? summary.total_pnl)}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Net</span>
                            <span className={`performance-summary-metric-value ${(summary.net_pnl ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}`}>{fmtUsd(summary.net_pnl)}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Unrealized</span>
                            <span className="performance-summary-metric-value">{fmtUsd(summary.total_unrealized_pnl)}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Comm</span>
                            <span className="performance-summary-metric-value">{fmtUsd(summary.total_commission)}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Trades</span>
                            <span className="performance-summary-metric-value">{summary.trade_count ?? 0}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Win rate</span>
                            <span className="performance-summary-metric-value">{summary.win_rate != null ? `${(summary.win_rate * 100).toFixed(1)}%` : '—'}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Return%</span>
                            <span className="performance-summary-metric-value">{summary.return_pct != null ? `${summary.return_pct.toFixed(2)}%` : '—'}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">PF</span>
                            <span className="performance-summary-metric-value">{summary.profit_factor != null ? (Number.isFinite(summary.profit_factor) ? summary.profit_factor.toFixed(2) : '∞') : '—'}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Max DD</span>
                            <span className="performance-summary-metric-value">{summary.max_drawdown != null ? fmtUsd(-summary.max_drawdown) : '—'}</span>
                          </div>
                          <div className="performance-summary-metric">
                            <span className="performance-summary-metric-label">Avg W/L</span>
                            <span className="performance-summary-metric-value">{fmtUsd(summary.avg_win)} / {fmtUsd(summary.avg_loss)}</span>
                          </div>
                        </div>
                      </div>
                      {(() => {
                        const realized = data.realized_by_sec_type ?? []
                        const unrealized = data.unrealized_by_sec_type ?? []
                        const hasCalendar = calendarDayPnL != null && Object.keys(calendarDayPnL).length > 0
                        const optRealizedFromCalendar = Object.values(calendarDayPnL ?? {}).reduce((s, d) => s + (d.realized ?? 0), 0)
                        const optUnrealizedFromCalendar = Object.values(calendarDayPnL ?? {}).reduce((s, d) => s + (d.unrealized ?? 0), 0)
                        const rOpt = realized.find((x) => x.sec_type === 'OPT')
                        const uOpt = unrealized.find((x) => x.sec_type === 'OPT')
                        const rStk = realized.find((x) => x.sec_type === 'STK')
                        const uStk = unrealized.find((x) => x.sec_type === 'STK')
                        const optRealizedPnl = hasCalendar ? optRealizedFromCalendar : (rOpt?.total_pnl ?? 0)
                        const optUnrealizedPnl = hasCalendar ? optUnrealizedFromCalendar : (uOpt?.total_pnl ?? 0)
                        const optNetPnl = hasCalendar ? optRealizedFromCalendar - (rOpt?.commission ?? 0) : (rOpt?.net_pnl ?? 0)
                        const hasOpt = hasCalendar || rOpt != null || uOpt != null
                        const hasStk = rStk != null || uStk != null
                        const InlineRow = ({ type, realized: rVal, commission, net, trades, unrealized: uVal, toneR, toneN, toneU }: { type: string; realized: string; commission: string; net: string; trades: string; unrealized: string; toneR: 'positive' | 'negative'; toneN: 'positive' | 'negative'; toneU: 'positive' | 'negative' }) => (
                          <div className="performance-summary-row">
                            <span className="performance-summary-type">{type}</span>
                            <div className="performance-summary-metrics">
                              <div className="performance-summary-metric">
                                <span className="performance-summary-metric-label">Realized</span>
                                <span className={`performance-summary-metric-value ${toneR === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{rVal}</span>
                              </div>
                              <div className="performance-summary-metric">
                                <span className="performance-summary-metric-label">Comm</span>
                                <span className="performance-summary-metric-value">{commission}</span>
                              </div>
                              <div className="performance-summary-metric">
                                <span className="performance-summary-metric-label">Net</span>
                                <span className={`performance-summary-metric-value ${toneN === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{net}</span>
                              </div>
                              <div className="performance-summary-metric">
                                <span className="performance-summary-metric-label">Trades</span>
                                <span className="performance-summary-metric-value">{trades}</span>
                              </div>
                              <div className="performance-summary-metric">
                                <span className="performance-summary-metric-label">Unrealized</span>
                                <span className={`performance-summary-metric-value ${toneU === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{uVal}</span>
                              </div>
                            </div>
                          </div>
                        )
                        return (
                          <>
                            {hasOpt ? <InlineRow type="Option" realized={fmtUsd(optRealizedPnl)} commission={fmtUsd(rOpt?.commission ?? 0)} net={fmtUsd(optNetPnl)} trades={String(rOpt?.trade_count ?? 0)} unrealized={fmtUsd(optUnrealizedPnl)} toneR={(optRealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'} toneN={(optNetPnl ?? 0) >= 0 ? 'positive' : 'negative'} toneU={(optUnrealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'} /> : <div className="performance-summary-row"><span className="performance-summary-type">Option</span><span className="section-hint performance-summary-empty">No data in the selected range.</span></div>}
                            {hasStk ? <InlineRow type="Stock" realized={fmtUsd(rStk?.total_pnl ?? 0)} commission={fmtUsd(rStk?.commission ?? 0)} net={fmtUsd(rStk?.net_pnl ?? 0)} trades={String(rStk?.trade_count ?? 0)} unrealized={fmtUsd(uStk?.total_pnl ?? 0)} toneR={((rStk?.total_pnl ?? 0) >= 0) ? 'positive' : 'negative'} toneN={((rStk?.net_pnl ?? 0) >= 0) ? 'positive' : 'negative'} toneU={((uStk?.total_pnl ?? 0) >= 0) ? 'positive' : 'negative'} /> : <div className="performance-summary-row"><span className="performance-summary-type">Stock</span><span className="section-hint performance-summary-empty">No data in the selected range.</span></div>}
                          </>
                        )
                      })()}
                    </div>
                    </div>
                    </div>
                    {selectedDay != null && (
                      <div className="performance-calendar-day-detail" aria-live="polite">
                        <h4 className="performance-calendar-day-detail-title">
                          Records for {selectedDay}
                          <button type="button" className="btn btn-secondary btn-sm performance-calendar-day-detail-close" onClick={() => setSelectedDay(null)} aria-label="Close">×</button>
                        </h4>
                        {selectedDayExecutionsLoading ? (
                          <p className="section-hint">Loading executions…</p>
                        ) : (
                          <>
                            {(() => {
                              const allExecs = selectedDayExecutions ?? []
                              const dayExecs = allExecs.filter((e) => executionDateStr(e) === selectedDay)
                              const optExecs = dayExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
                              const backendPairs = selectedDayOptPairs ?? []
                              const execById = new Map<number, Execution>()
                              for (const e of allExecs) {
                                if (e.id != null) execById.set(e.id, e)
                              }
                              const legDateStr = (eid: number) => {
                                const ex = execById.get(eid)
                                return ex != null ? executionDateStr(ex) : ''
                              }
                              // Pairs that have at least one leg on the selected day (can look back to earlier days).
                              const relevantPairs = backendPairs.filter(
                                (p) =>
                                  p.leg_c_execution_id != null &&
                                  p.leg_p_execution_id != null &&
                                  execById.has(p.leg_c_execution_id) &&
                                  execById.has(p.leg_p_execution_id) &&
                                  (legDateStr(p.leg_c_execution_id) === selectedDay || legDateStr(p.leg_p_execution_id) === selectedDay),
                              )
                              type DayPair = {
                                account_id: string
                                symbol: string
                                expiry: string
                                strike: string
                                quantity: number
                                c_side: string
                                c_price: number
                                p_side: string
                                p_price: number
                                commission: number
                                net_pnl: number
                                leg_c_execution_id?: number
                                leg_p_execution_id?: number
                              }
                              const dayPairs: DayPair[] = relevantPairs.length > 0
                                ? relevantPairs.map((p) => ({
                                  account_id: p.account_id,
                                  symbol: p.symbol,
                                  expiry: p.expiry,
                                  strike: p.strike,
                                  quantity: p.quantity,
                                  c_side: p.c_side,
                                  c_price: p.c_price,
                                  p_side: p.p_side,
                                  p_price: p.p_price,
                                  commission: p.commission,
                                  net_pnl: p.net_pnl,
                                  leg_c_execution_id: p.leg_c_execution_id,
                                  leg_p_execution_id: p.leg_p_execution_id,
                                }))
                                : computeOptPairsFromExecutions(dayExecs).map((p) => ({
                                  ...p,
                                  leg_c_execution_id: undefined,
                                  leg_p_execution_id: undefined,
                                }))
                              const contractKey = (e: Execution) =>
                                `${e.account_id ?? ''}\t${e.symbol ?? ''}\t${e.expiry ?? ''}\t${normalizeStrike(e.strike)}`
                              const pairKey = (p: { account_id: string; symbol: string; expiry: string; strike: string | number }) =>
                                `${p.account_id}\t${p.symbol}\t${p.expiry}\t${normalizeStrike(p.strike)}`
                              const keyNoAccount = (sym: string, exp: string, str: string | number) =>
                                `${sym}\t${exp}\t${normalizeStrike(str)}`
                              const dayPairsEnriched: (typeof dayPairs)[0][] = dayPairs.map((p) => ({
                                ...p,
                                account_id: p.account_id ||
                                  (p.leg_c_execution_id != null ? execById.get(p.leg_c_execution_id)?.account_id : undefined) ||
                                  (p.leg_p_execution_id != null ? execById.get(p.leg_p_execution_id)?.account_id : undefined) ||
                                  '',
                              }))
                              const pairByKey = new Map<string, (typeof dayPairs)[0][]>()
                              for (const p of dayPairsEnriched) {
                                const k = pairKey(p)
                                if (!pairByKey.has(k)) pairByKey.set(k, [])
                                pairByKey.get(k)!.push(p)
                              }
                              const pairByKeyNoAccount = new Map<string, (typeof dayPairs)[0][]>()
                              for (const p of dayPairsEnriched) {
                                const kNoAcc = keyNoAccount(p.symbol, p.expiry, p.strike)
                                if (!pairByKeyNoAccount.has(kNoAcc)) pairByKeyNoAccount.set(kNoAcc, [])
                                pairByKeyNoAccount.get(kNoAcc)!.push(p)
                              }
                              const byContract = new Map<string, Execution[]>()
                              for (const e of optExecs) {
                                const sym = e.symbol ?? ''
                                const exp = e.expiry ?? ''
                                const str = e.strike ?? ''
                                const acc = e.account_id ?? ''
                                let k: string
                                if (acc.trim() !== '') {
                                  k = contractKey(e)
                                } else {
                                  const pairList = pairByKeyNoAccount.get(keyNoAccount(sym, exp, str))
                                  k = pairList?.length && pairList[0].account_id
                                    ? pairKey(pairList[0])
                                    : contractKey(e)
                                }
                                if (!byContract.has(k)) byContract.set(k, [])
                                byContract.get(k)!.push(e)
                              }
                              const allContractKeys = new Set<string>(byContract.keys())
                              for (const p of dayPairsEnriched) {
                                allContractKeys.add(pairKey(p))
                              }
                              const contractKeys = Array.from(allContractKeys).sort((a, b) => {
                                const execsA = byContract.get(a) ?? []
                                const execsB = byContract.get(b) ?? []
                                const pairsA = pairByKey.get(a) ?? (a.startsWith('\t') ? pairByKeyNoAccount.get(a.slice(1)) ?? [] : [])
                                const pairsB = pairByKey.get(b) ?? (b.startsWith('\t') ? pairByKeyNoAccount.get(b.slice(1)) ?? [] : [])
                                const legTimes = (pairs: (typeof dayPairsEnriched)) => {
                                  if (pairs.length === 0) return []
                                  const p = pairs[0]
                                  const out: number[] = []
                                  if (p.leg_c_execution_id != null) { const t = execById.get(p.leg_c_execution_id)?.time; if (t != null) out.push(t) }
                                  if (p.leg_p_execution_id != null) { const t = execById.get(p.leg_p_execution_id)?.time; if (t != null) out.push(t) }
                                  return out
                                }
                                const tA = execsA.length > 0
                                  ? Math.min(...execsA.map((e) => e.time ?? 0))
                                  : (() => { const lt = legTimes(pairsA); return lt.length > 0 ? Math.min(...lt) : 0 })()
                                const tB = execsB.length > 0
                                  ? Math.min(...execsB.map((e) => e.time ?? 0))
                                  : (() => { const lt = legTimes(pairsB); return lt.length > 0 ? Math.min(...lt) : 0 })()
                                return tA - tB
                              })
                              const keysBySymbol = new Map<string, string[]>()
                              for (const key of contractKeys) {
                                const execs = byContract.get(key) ?? []
                                const pairs = pairByKey.get(key) ?? (key.startsWith('\t') ? pairByKeyNoAccount.get(key.slice(1)) ?? [] : [])
                                const first = execs[0]
                                const firstPair = pairs[0]
                                const symbol = first?.symbol ?? firstPair?.symbol ?? '—'
                                if (!keysBySymbol.has(symbol)) keysBySymbol.set(symbol, [])
                                keysBySymbol.get(symbol)!.push(key)
                              }
                              const keysBySymbolRealized = new Map<string, string[]>()
                              const keysBySymbolUnrealized = new Map<string, string[]>()
                              const symbolSumRealized = new Map<string, number>()
                              const symbolSumUnrealized = new Map<string, number>()
                              const symbolCommissionRealized = new Map<string, number>()
                              const symbolCommissionUnrealized = new Map<string, number>()
                              let totalRealizedSum = 0
                              let totalUnrealizedSum = 0
                              let totalCommissionRealized = 0
                              let totalCommissionUnrealized = 0
                              for (const key of contractKeys) {
                                const pairs = pairByKey.get(key) ?? (key.startsWith('\t') ? pairByKeyNoAccount.get(key.slice(1)) ?? [] : [])
                                const execs = byContract.get(key) ?? []
                                const first = execs[0]
                                const firstPair = pairs[0]
                                const symbol = first?.symbol ?? firstPair?.symbol ?? '—'
                                const sortedExecs = [...execs].sort(sortExecByTradeDateThenTime)
                                const pairedExecIds = new Set<number>()
                                for (const p of pairs) {
                                  if (p.leg_c_execution_id != null) pairedExecIds.add(p.leg_c_execution_id)
                                  if (p.leg_p_execution_id != null) pairedExecIds.add(p.leg_p_execution_id)
                                }
                                const unmatchedExecs = sortedExecs.filter((e) => e.id == null || !pairedExecIds.has(e.id))
                                const groupSumPnl =
                                  unmatchedExecs.reduce((s, e) => s + execPnl(e), 0) +
                                  pairs.reduce((s, p) => s + (p.net_pnl ?? matchPnl(p)), 0)
                                const groupCommissionSum =
                                  pairs.reduce((s, p) => s + (Number(p.commission) || 0), 0) +
                                  unmatchedExecs.reduce((s, e) => s + (Number(e.commission) || 0), 0)
                                if (pairs.length > 0) {
                                  if (!keysBySymbolRealized.has(symbol)) keysBySymbolRealized.set(symbol, [])
                                  keysBySymbolRealized.get(symbol)!.push(key)
                                  symbolSumRealized.set(symbol, (symbolSumRealized.get(symbol) ?? 0) + groupSumPnl)
                                  symbolCommissionRealized.set(symbol, (symbolCommissionRealized.get(symbol) ?? 0) + groupCommissionSum)
                                  totalRealizedSum += groupSumPnl
                                  totalCommissionRealized += groupCommissionSum
                                } else {
                                  if (!keysBySymbolUnrealized.has(symbol)) keysBySymbolUnrealized.set(symbol, [])
                                  keysBySymbolUnrealized.get(symbol)!.push(key)
                                  symbolSumUnrealized.set(symbol, (symbolSumUnrealized.get(symbol) ?? 0) + groupSumPnl)
                                  symbolCommissionUnrealized.set(symbol, (symbolCommissionUnrealized.get(symbol) ?? 0) + groupCommissionSum)
                                  totalUnrealizedSum += groupSumPnl
                                  totalCommissionUnrealized += groupCommissionSum
                                }
                              }
                              const symbolsRealized = Array.from(keysBySymbolRealized.keys()).sort()
                              const symbolsUnrealized = Array.from(keysBySymbolUnrealized.keys()).sort()
                              const keysBySymbolForType = selectedDayPnLType === 'realized' ? keysBySymbolRealized : keysBySymbolUnrealized
                              const symbolsForType = selectedDayPnLType === 'realized' ? symbolsRealized : symbolsUnrealized
                              const symbolSumForType = selectedDayPnLType === 'realized' ? symbolSumRealized : symbolSumUnrealized
                              const symbolCommissionForType = selectedDayPnLType === 'realized' ? symbolCommissionRealized : symbolCommissionUnrealized
                              const effectiveSymbol = (selectedDaySymbolTab && symbolsForType.includes(selectedDaySymbolTab) ? selectedDaySymbolTab : symbolsForType[0]) ?? null
                              return (
                                <>
                                  <h5 className="performance-calendar-day-detail-subtitle">
                                    Option executions by contract
                                  </h5>
                                  {contractKeys.length === 0 ? (
                                    <p className="section-hint">No Option executions in DB for this day (exec_time in server Chicago range).</p>
                                  ) : (
                                    <>
                                      <div className="performance-calendar-pnl-type-tabs system-tabs" role="tablist" aria-label="PnL type">
                                        <button
                                          type="button"
                                          role="tab"
                                          aria-selected={selectedDayPnLType === 'realized'}
                                          className={`system-tab ${selectedDayPnLType === 'realized' ? 'active' : ''}`}
                                          onClick={() => setSelectedDayPnLType('realized')}
                                        >
                                          Realized
                                          {symbolsRealized.length > 0 && (
                                            <>
                                              <span className="performance-calendar-tab-count">({symbolsRealized.reduce((n, s) => n + (keysBySymbolRealized.get(s) ?? []).length, 0)})</span>
                                              <span className={`performance-calendar-tab-sum ${totalRealizedSum >= 0 ? 'tone-positive' : 'tone-negative'}`}>
                                                {fmtUsd(totalRealizedSum)}
                                              </span>
                                              <span className="performance-records-commission-sum"> {fmtUsd(totalCommissionRealized)}</span>
                                            </>
                                          )}
                                        </button>
                                        <button
                                          type="button"
                                          role="tab"
                                          aria-selected={selectedDayPnLType === 'unrealized'}
                                          className={`system-tab ${selectedDayPnLType === 'unrealized' ? 'active' : ''}`}
                                          onClick={() => setSelectedDayPnLType('unrealized')}
                                        >
                                          Unrealized
                                          {symbolsUnrealized.length > 0 && (
                                            <>
                                              <span className="performance-calendar-tab-count">({symbolsUnrealized.reduce((n, s) => n + (keysBySymbolUnrealized.get(s) ?? []).length, 0)})</span>
                                              <span className="performance-calendar-tab-sum tone-unrealized">
                                                {fmtUsd(totalUnrealizedSum)}
                                              </span>
                                              <span className="performance-records-commission-sum"> {fmtUsd(totalCommissionUnrealized)}</span>
                                            </>
                                          )}
                                        </button>
                                      </div>
                                      <div className="performance-calendar-symbol-tabs system-tabs" role="tablist" aria-label="Symbol">
                                        {symbolsForType.map((sym) => {
                                          const sum = symbolSumForType.get(sym) ?? 0
                                          const comm = symbolCommissionForType.get(sym) ?? 0
                                          const sumClass = selectedDayPnLType === 'unrealized'
                                            ? 'tone-unrealized'
                                            : (sum >= 0 ? 'tone-positive' : 'tone-negative')
                                          return (
                                            <button
                                              key={sym}
                                              type="button"
                                              role="tab"
                                              aria-selected={sym === effectiveSymbol}
                                              className={`system-tab ${sym === effectiveSymbol ? 'active' : ''}`}
                                              onClick={() => setSelectedDaySymbolTab(sym)}
                                            >
                                              {sym}
                                              <span className={`performance-calendar-tab-sum ${sumClass}`}>
                                                {fmtUsd(sum)}
                                              </span>
                                              <span className="performance-records-commission-sum"> {fmtUsd(comm)}</span>
                                            </button>
                                          )
                                        })}
                                      </div>
                                      <div className="system-tab-panel performance-calendar-symbol-panel" role="tabpanel">
                                        {symbolsForType.length === 0 ? (
                                          <p className="section-hint">
                                            {selectedDayPnLType === 'realized'
                                              ? 'No realized (matched BUY↔SELL) contracts for this day.'
                                              : 'No unrealized (open) contracts for this day.'}
                                          </p>
                                        ) : (
                                        <>
                                          {(effectiveSymbol ? (keysBySymbolForType.get(effectiveSymbol) ?? []) : []).map((key) => {
                                      const execs = byContract.get(key) ?? []
                                      const pairs =
                                        pairByKey.get(key) ??
                                        (key.startsWith('\t') ? pairByKeyNoAccount.get(key.slice(1)) ?? [] : [])
                                      const first = execs[0]
                                      const firstPair = pairs[0]
                                      const symbol = first?.symbol ?? firstPair?.symbol ?? '—'
                                      const expiry = first?.expiry ?? firstPair?.expiry ?? '—'
                                      const strike = first?.strike ?? firstPair?.strike ?? '—'
                                      const rightFull = optionRightToFull(
                                        first?.option_right ??
                                          (firstPair && firstPair.leg_c_execution_id != null
                                            ? execById.get(firstPair.leg_c_execution_id)?.option_right
                                            : firstPair && firstPair.leg_p_execution_id != null
                                              ? execById.get(firstPair.leg_p_execution_id)?.option_right
                                              : undefined)
                                      )
                                      const sortedExecs = [...execs].sort(sortExecByTradeDateThenTime)
                                      type Row = { type: 'Execution'; e: Execution } | { type: 'Match'; p: (typeof dayPairs)[0] }
                                      const pairedExecIds = new Set<number>()
                                      for (const p of pairs) {
                                        if (p.leg_c_execution_id != null) pairedExecIds.add(p.leg_c_execution_id)
                                        if (p.leg_p_execution_id != null) pairedExecIds.add(p.leg_p_execution_id)
                                      }
                                      const unmatchedExecs = sortedExecs.filter((e) => e.id == null || !pairedExecIds.has(e.id))
                                      const rows: Row[] = [
                                        ...sortedExecs.map((e) => ({ type: 'Execution' as const, e })),
                                        ...pairs.map((p) => ({ type: 'Match' as const, p })),
                                      ]
                                      const groupSumPnl =
                                        unmatchedExecs.reduce((s, e) => s + execPnl(e), 0) +
                                        pairs.reduce((s, p) => s + (p.net_pnl ?? matchPnl(p)), 0)
                                      const groupCommissionSum =
                                        pairs.reduce((s, p) => s + (Number(p.commission) || 0), 0) +
                                        unmatchedExecs.reduce((s, e) => s + (Number(e.commission) || 0), 0)
                                      return (
                                        <div key={key} className="performance-calendar-contract-group">
                                          <h6 className="performance-calendar-contract-title">
                                            {symbol} {expiry} {strike} {rightFull !== '—' ? rightFull : ''}
                                            <span className={
                                              pairs.length > 0
                                                ? (groupSumPnl >= 0 ? 'tone-positive' : 'tone-negative')
                                                : 'tone-unrealized'
                                            }>
                                              {' '}{fmtUsd(groupSumPnl)}
                                            </span>
                                            <span className="performance-records-commission-sum">
                                              {' '}{fmtUsd(groupCommissionSum)}
                                            </span>
                                          </h6>
                                          <table className="performance-calendar-pairs-table performance-calendar-unified-table">
                                            <thead>
                                              <tr>
                                                <th>Record type</th>
                                                <th>Id</th>
                                                <th>Account</th>
                                                <th>EXEC TIME</th>
                                                <th>Side</th>
                                                <th>Qty</th>
                                                <th>Price</th>
                                                <th>Commission</th>
                                                <th>PnL</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {rows.map((row, idx) =>
                                                row.type === 'Match' ? (() => {
                                                  const legC = row.p.leg_c_execution_id != null ? execById.get(row.p.leg_c_execution_id) : undefined
                                                  const legP = row.p.leg_p_execution_id != null ? execById.get(row.p.leg_p_execution_id) : undefined
                                                  const tC = legC?.time != null ? Number(legC.time) : null
                                                  const tP = legP?.time != null ? Number(legP.time) : null
                                                  // Show the matched (opening) leg's time/side/price — leg_c is the earlier leg that was matched.
                                                  const execTimeStr = tC != null ? fmtChicagoTime(tC) : (tP != null ? fmtChicagoTime(tP) : '—')
                                                  return (
                                                    <tr key={`match-${idx}`} className="performance-calendar-row-match">
                                                      <td>Match</td>
                                                      <td>
                                                        {row.p.leg_c_execution_id != null && row.p.leg_p_execution_id != null
                                                          ? `${row.p.leg_c_execution_id} / ${row.p.leg_p_execution_id}`
                                                          : '—'}
                                                      </td>
                                                      <td>{row.p.account_id || '—'}</td>
                                                      <td>{execTimeStr}</td>
                                                      <td>{row.p.c_side}</td>
                                                      <td>{legC?.quantity != null && legP?.quantity != null ? `${legC.quantity} / ${legP.quantity}` : String(row.p.quantity)}</td>
                                                      <td>{fmtUsd(row.p.c_price)}</td>
                                                      <td>{fmtUsd(row.p.commission)}</td>
                                                      <td className={(() => { const mp = row.p.net_pnl ?? matchPnl(row.p); return Math.abs(mp) < 0.005 ? '' : (mp >= 0 ? 'tone-positive' : 'tone-negative'); })()}>{fmtPnl(row.p.net_pnl ?? matchPnl(row.p))}</td>
                                                    </tr>
                                                  )
                                                })() : (
                                                  (() => {
                                                    return (
                                                  <tr key={row.e.id ?? idx} className="performance-calendar-row-execution">
                                                    <td>Execution</td>
                                                    <td>{row.e.id ?? '—'}</td>
                                                    <td>{row.e.account_id ?? '—'}</td>
                                                    <td>{fmtChicagoTime(row.e.time)}</td>
                                                    <td>{row.e.side ?? '—'}</td>
                                                    <td>{row.e.quantity ?? '—'}</td>
                                                    <td>{fmtUsd(row.e.price)}</td>
                                                    <td>{fmtUsd(row.e.commission)}</td>
                                                    <td className={(() => { const ep = execPnl(row.e); return Math.abs(ep) < 0.005 ? '' : (ep >= 0 ? 'tone-positive' : 'tone-negative'); })()}>{fmtPnl(execPnl(row.e))}</td>
                                                  </tr>
                                                    );
                                                  })()
                                                )
                                              )}
                                            </tbody>
                                          </table>
                                        </div>
                                      )
                                    })}
                                        </>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </>
                              )
                            })()}
                          </>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}
          </>
        ) : (
          <p className="section-hint">Select time range above and load data to see calendar.</p>
        )}
      </section>
    </div>
  )
}
