import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import type {
  Execution,
  OptionStockLinkRow,
  OptionStockLinkSummary,
  PerformanceResponse,
  StatusResponse,
} from '../types'
import type { BackendOptPair } from '../types'
import type { StrategyOpportunity } from '../api'
import type { StrategyInstance } from '../types'
import { fetchExecutions, fetchPerformance, fetchOpportunities, fetchStrategyInstances, postOptionStockLinksQuery } from '../api'
import ExecSourceBadge from '../components/ExecSourceBadge'
import { InfoTooltip } from '../components/InfoTooltip'
import { ViewOptionStockLinksModal } from './portfolio/ViewOptionStockLinksModal'
import {
  getOptionStockLinkDetailForExecution,
  realizedPnlFifoMatchPlusStock,
  scaledLedgerOptDetailRowPnl,
} from './portfolio/ledgerOptHelpers'
import { fmtChicagoTime, fmtPnl, fmtPnlCalendar, fmtUsd } from '../utils/format'
import {
  filterExecutionsByUnixRange,
  loadPerformanceDayPnLBulk,
  slicePerformanceForCalendarMonth,
} from './performance/performanceBulk'
import { fetchOptionStockLinkMapForExecutions } from './performance/fetchOptionStockLinkMap'
import {
  computeBackendOptPairsFromExecutions,
  computeDayRealizedUnrealized,
  computeDayRealizedUnrealizedStock,
  computeOptionDayPnLForPerformanceDate,
  computeOptPairsFromExecutions,
  dateStrMinusDays,
  executionDateStr,
  executionLegPnlToneClass,
  ledgerOptionExecutionCashFlowSigned,
  filterRelevantOptPairsForDay,
  getChicagoDayRange,
  getTimeRangeDates,
  ledgerOptionExecutionDisplayPnl,
  stockOnTheFlyUnrealizedPnlLeg,
  listDateStrings,
  listMonthKeysInRange,
  matchPnl,
  normalizeStrike,
  optionRightToFull,
  sortExecByExecutionDateThenTime,
} from './performance/performanceUtils'

/** Backend: account_executions_final (official book). Use for all Performance data except the On the fly panel. */
const PERFORMANCE_EXEC_SOURCE_SCOPE = 'performance_book' as const

/** Days to look back from each calendar day / selected day so OPT pairing matches the execution fetch window. */
const OPT_PAIR_LOOK_BACK_DAYS = 180

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
  const [selectedDayOptionStockLinkByOptionId, setSelectedDayOptionStockLinkByOptionId] = useState<
    Record<number, OptionStockLinkSummary>
  >({})
  const [viewStockLinksModal, setViewStockLinksModal] = useState<{
    open: boolean
    title: string
    rows: OptionStockLinkRow[]
    slippageTotal: number | null
  }>({ open: false, title: '', rows: [], slippageTotal: null })
  const handleViewOptionStockLinks = useCallback(
    (rows: OptionStockLinkRow[], title: string, slippageTotal: number | null) => {
      setViewStockLinksModal({ open: true, title, rows, slippageTotal })
    },
    [],
  )
  const [calendarDayPnL, setCalendarDayPnL] = useState<Record<string, { realized: number; unrealized: number }> | null>(null)
  const [calendarDayPnLLoading, setCalendarDayPnLLoading] = useState(false)
  /** Batched executions + link map for drill-down; key matches getTimeRangeDates + filters */
  const perfBulkRef = useRef<{
    key: string
    rawExecsWindow: Execution[]
    linkByOptionId: Record<number, OptionStockLinkSummary>
  } | null>(null)
  /** Incremented when bulk day PnL load completes so selected-day effect can switch from fallback fetch to cache */
  const [perfBulkVersion, setPerfBulkVersion] = useState(0)
  const [byDayExpandedMonths, setByDayExpandedMonths] = useState<Set<string>>(new Set())
  const [byDayRangeData, setByDayRangeData] = useState<{
    opt: Record<string, { realized: number; unrealized: number }>
    stock: Record<string, { realized: number; unrealized: number }>
  } | null>(null)
  const [byDayRangeLoading, setByDayRangeLoading] = useState(false)
  const [selectedDayComputedPnL, setSelectedDayComputedPnL] = useState<{ realized: number; unrealized: number } | null>(null)
  const [strategyOpportunityId, setStrategyOpportunityId] = useState<number | null>(null)
  const [strategyInstanceId, setStrategyInstanceId] = useState<number | null>(null)
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [instances, setInstances] = useState<StrategyInstance[]>([])
  const [onTheFlyOpen, setOnTheFlyOpen] = useState(false)
  const [onTheFlyPerf, setOnTheFlyPerf] = useState<PerformanceResponse | null>(null)
  const [onTheFlyExecs, setOnTheFlyExecs] = useState<Execution[]>([])
  const [onTheFlyOptPairs, setOnTheFlyOptPairs] = useState<BackendOptPair[] | null>(null)
  const [onTheFlySecTab, setOnTheFlySecTab] = useState<'all' | 'OPT' | 'STK'>('all')
  const [onTheFlyLoading, setOnTheFlyLoading] = useState(false)
  const [onTheFlyError, setOnTheFlyError] = useState<string | null>(null)

  const calendarMonthPerformance = useMemo((): PerformanceResponse | null => {
    if (!data) return null
    return slicePerformanceForCalendarMonth(data, calendarMonth)
  }, [data, calendarMonth])

  const onTheFlyComputed = useMemo(() => {
    if (onTheFlyExecs.length === 0) return null
    const sortExec = sortExecByExecutionDateThenTime
    const optPairs = onTheFlyOptPairs != null && onTheFlyOptPairs.length > 0 ? onTheFlyOptPairs : null
    const optAg = computeDayRealizedUnrealized(onTheFlyExecs, optPairs, sortExec)
    const stkExecsOnly = onTheFlyExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'STK')
    const stkAg = computeDayRealizedUnrealizedStock(stkExecsOnly, sortExec)
    return { opt: optAg, stk: stkAg }
  }, [onTheFlyExecs, onTheFlyOptPairs])

  useEffect(() => {
    fetchOpportunities(true)
      .then(r => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
  }, [])
  useEffect(() => {
    if (strategyOpportunityId == null || !Number.isFinite(strategyOpportunityId)) {
      setInstances([])
      return
    }
    fetchStrategyInstances({ strategy_opportunity_id: strategyOpportunityId })
      .then(r => setInstances(r.items ?? []))
      .catch(() => setInstances([]))
  }, [strategyOpportunityId])

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
        strategy_opportunity_id: strategyOpportunityId ?? undefined,
        strategy_instance_id: strategyInstanceId ?? undefined,
        source_scope: PERFORMANCE_EXEC_SOURCE_SCOPE,
      })
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load performance')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [timeRange, calendarMonth, strategyOpportunityId, strategyInstanceId])

  useEffect(() => {
    load()
  }, [load])

  const loadOnTheFly = useCallback(async () => {
    setOnTheFlyLoading(true)
    setOnTheFlyError(null)
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const { since_ts } = getChicagoDayRange(sinceStr)
    const { until_ts } = getChicagoDayRange(untilStr)
    try {
      const [perf, exRes] = await Promise.all([
        fetchPerformance({
          since_ts,
          until_ts,
          granularity: 'day',
          strategy_opportunity_id: strategyOpportunityId ?? undefined,
          strategy_instance_id: strategyInstanceId ?? undefined,
          source_scope: 'on_the_fly',
        }),
        fetchExecutions(
          since_ts,
          until_ts,
          5000,
          true,
          strategyOpportunityId ?? undefined,
          strategyInstanceId ?? undefined,
          'on_the_fly',
        ),
      ])
      setOnTheFlyPerf(perf)
      const raw = exRes.executions ?? []
      const pairs = 'opt_pairs' in exRes && Array.isArray((exRes as { opt_pairs?: BackendOptPair[] }).opt_pairs)
        ? (exRes as { opt_pairs: BackendOptPair[] }).opt_pairs
        : null
      setOnTheFlyOptPairs(pairs)
      setOnTheFlyExecs([...raw].sort((a, b) => sortExecByExecutionDateThenTime(a, b)).reverse())
    } catch (e) {
      setOnTheFlyError(e instanceof Error ? e.message : 'Failed to load on-the-fly data')
      setOnTheFlyPerf(null)
      setOnTheFlyExecs([])
      setOnTheFlyOptPairs(null)
    } finally {
      setOnTheFlyLoading(false)
    }
  }, [timeRange, calendarMonth, strategyOpportunityId, strategyInstanceId])

  useEffect(() => {
    if (!onTheFlyOpen) return
    void loadOnTheFly()
  }, [onTheFlyOpen, loadOnTheFly])

  // By day + calendar daily OPT R/U: one merged executions fetch + one bulk link query, then in-memory per-day PnL
  useEffect(() => {
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const monthKeys = listMonthKeysInRange(sinceStr, untilStr)
    if (monthKeys.length === 0) {
      setByDayRangeData(null)
      setByDayRangeLoading(false)
      setCalendarDayPnL(null)
      setCalendarDayPnLLoading(false)
      perfBulkRef.current = null
      return
    }
    setByDayRangeLoading(true)
    setByDayRangeData(null)
    setCalendarDayPnLLoading(true)
    setCalendarDayPnL(null)
    let cancelled = false
    const bulkKey = `${sinceStr}|${untilStr}|${strategyOpportunityId ?? ''}|${strategyInstanceId ?? ''}`
    void loadPerformanceDayPnLBulk({
      sinceStr,
      untilStr,
      calendarMonth,
      strategyOpportunityId,
      strategyInstanceId,
      lookBackDays: OPT_PAIR_LOOK_BACK_DAYS,
    })
      .then((r) => {
        if (cancelled) return
        perfBulkRef.current = {
          key: bulkKey,
          rawExecsWindow: r.rawExecsWindow,
          linkByOptionId: r.linkByOptionId,
        }
        setPerfBulkVersion((v) => v + 1)
        setByDayRangeData(r.byDayRangeData)
        setCalendarDayPnL(r.calendarDayPnL)
      })
      .catch(() => {
        if (cancelled) return
        perfBulkRef.current = null
        const dateStrsList = listDateStrings(sinceStr, untilStr)
        const fallbackOpt: Record<string, { realized: number; unrealized: number }> = {}
        const fallbackStock: Record<string, { realized: number; unrealized: number }> = {}
        for (const dateStr of dateStrsList) {
          fallbackOpt[dateStr] = { realized: 0, unrealized: 0 }
          fallbackStock[dateStr] = { realized: 0, unrealized: 0 }
        }
        setByDayRangeData({ opt: fallbackOpt, stock: fallbackStock })
        setCalendarDayPnL({})
      })
      .finally(() => {
        if (!cancelled) {
          setByDayRangeLoading(false)
          setCalendarDayPnLLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [timeRange, calendarMonth, strategyOpportunityId, strategyInstanceId])

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

  // When a day is selected: reuse batched executions + links when possible (same window as calendar / By day)
  useEffect(() => {
    if (!selectedDay) {
      setSelectedDayExecutions(null)
      setSelectedDayOptPairs(null)
      setSelectedDayComputedPnL(null)
      return
    }
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const bulkKey = `${sinceStr}|${untilStr}|${strategyOpportunityId ?? ''}|${strategyInstanceId ?? ''}`
    const b = perfBulkRef.current
    const lookBackStart = dateStrMinusDays(selectedDay, OPT_PAIR_LOOK_BACK_DAYS)
    const { since_ts: monthStartTs } = getChicagoDayRange(lookBackStart)
    const { until_ts: dayEndTs } = getChicagoDayRange(selectedDay)

    if (
      b?.key === bulkKey &&
      selectedDay >= sinceStr &&
      selectedDay <= untilStr
    ) {
      setSelectedDayExecutionsLoading(true)
      const slice = filterExecutionsByUnixRange(b.rawExecsWindow, monthStartTs, dayEndTs)
      const optPairs = computeBackendOptPairsFromExecutions(slice, sortExecByExecutionDateThenTime)
      setSelectedDayExecutions(slice)
      setSelectedDayOptPairs(optPairs)
      const { realized, unrealized, symbolsRealized, symbolsUnrealized } = computeOptionDayPnLForPerformanceDate(
        selectedDay,
        slice,
        optPairs,
        b.linkByOptionId,
      )
      setSelectedDayComputedPnL({ realized, unrealized })
      if (symbolsRealized.length === 0 && symbolsUnrealized.length > 0) {
        setSelectedDayPnLType('unrealized')
      }
      setSelectedDayExecutionsLoading(false)
      return
    }

    setSelectedDayExecutionsLoading(true)
    fetchExecutions(
      monthStartTs,
      dayEndTs,
      5000,
      true,
      strategyOpportunityId ?? undefined,
      strategyInstanceId ?? undefined,
      PERFORMANCE_EXEC_SOURCE_SCOPE,
    )
      .then(async (res) => {
        setSelectedDayExecutions(res.executions ?? [])
        setSelectedDayOptPairs('opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null)
        const execs = res.executions ?? []
        const optPairs = 'opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null
        const linkMap = await fetchOptionStockLinkMapForExecutions(execs)
        const { realized, unrealized, symbolsRealized, symbolsUnrealized } = computeOptionDayPnLForPerformanceDate(
          selectedDay,
          execs,
          optPairs,
          linkMap,
        )
        setSelectedDayComputedPnL({ realized, unrealized })
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
  }, [selectedDay, timeRange, calendarMonth, strategyOpportunityId, strategyInstanceId, perfBulkVersion])

  /** Option–stock links for day-detail: reuse bulk link map when the batch matches. */
  useEffect(() => {
    if (!selectedDayExecutions || selectedDayExecutions.length === 0) {
      setSelectedDayOptionStockLinkByOptionId({})
      return
    }
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const bulkKey = `${sinceStr}|${untilStr}|${strategyOpportunityId ?? ''}|${strategyInstanceId ?? ''}`
    const b = perfBulkRef.current
    const opt = selectedDayExecutions.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
    if (b?.key === bulkKey) {
      const next: Record<number, OptionStockLinkSummary> = {}
      for (const e of opt) {
        const id = e.account_executions_id
        if (id == null) continue
        next[id] = b.linkByOptionId[id] ?? { links: [], slippage_total: null }
      }
      setSelectedDayOptionStockLinkByOptionId(next)
      return
    }
    let cancelled = false
    const byAccount = new Map<string, number[]>()
    for (const e of opt) {
      const id = e.account_executions_id
      const acc = (e.account_id ?? '').trim()
      if (id == null || !acc) continue
      if (!byAccount.has(acc)) byAccount.set(acc, [])
      byAccount.get(acc)!.push(id)
    }
    const batches = Array.from(byAccount.entries()).map(([account_id, option_account_executions_ids]) => ({
      account_id,
      option_account_executions_ids,
    }))
    if (batches.length === 0) {
      setSelectedDayOptionStockLinkByOptionId({})
      return
    }
    void postOptionStockLinksQuery({ batches })
      .then((res) => {
        if (cancelled) return
        const raw = res.by_option_id ?? {}
        const next: Record<number, OptionStockLinkSummary> = {}
        for (const [k, v] of Object.entries(raw)) {
          const num = Number(k)
          if (!Number.isFinite(num)) continue
          const summary = v as OptionStockLinkSummary
          next[num] = {
            links: summary.links ?? [],
            slippage_total: summary.slippage_total ?? null,
          }
        }
        setSelectedDayOptionStockLinkByOptionId(next)
      })
      .catch(() => {
        if (!cancelled) setSelectedDayOptionStockLinkByOptionId({})
      })
    return () => {
      cancelled = true
    }
  }, [selectedDayExecutions, timeRange, calendarMonth, strategyOpportunityId, strategyInstanceId])

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
        <p className="performance-page-subtitle">
          Track realized and unrealized PnL with daily drill-downs. Charts and aggregates above use Flex Trades and journal-closed executions only.
        </p>
        <section className="performance-time-range-block performance-pane" aria-label="Time range and daily statistics">
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
            <fieldset className="performance-filter performance-filter-strategy" aria-label="Strategy filter">
              <span className="performance-filter-legend-inline">Strategy</span>
              <select
                value={strategyOpportunityId ?? ''}
                onChange={e => {
                  const v = e.target.value
                  setStrategyOpportunityId(v === '' ? null : Number(v))
                  setStrategyInstanceId(null)
                }}
                className="performance-filter-select"
                aria-label="Strategy (opportunity)"
              >
                <option value="">All</option>
                {opportunities.map(o => (
                  <option key={o.strategy_opportunity_id} value={String(o.strategy_opportunity_id)}>
                    {o.name ?? `#${o.strategy_opportunity_id}`}
                  </option>
                ))}
              </select>
            </fieldset>
            <fieldset className="performance-filter performance-filter-instance" aria-label="Instance filter">
              <span className="performance-filter-legend-inline">Instance</span>
              <select
                value={strategyInstanceId ?? ''}
                onChange={e => {
                  const v = e.target.value
                  setStrategyInstanceId(v === '' ? null : Number(v))
                }}
                className="performance-filter-select"
                aria-label="Instance"
                disabled={strategyOpportunityId == null}
              >
                <option value="">All</option>
                {instances.map(si => (
                  <option key={si.strategy_instance_id} value={String(si.strategy_instance_id)}>
                    {si.label?.trim() || `#${si.strategy_instance_id}`}
                  </option>
                ))}
              </select>
            </fieldset>
            {(() => {
              const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
              const fromFmt = sinceStr.replace(/-/g, '/')
              const toFmt = untilStr.replace(/-/g, '/')
              return (
                <span className="performance-range-label" aria-label="Trade range">
                  <span className="performance-range-label-title">Range</span>
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
            <div className="table-wrap performance-by-day-table-wrap">
              <table className="data-table by-day-table" role="grid">
                <thead><tr><th>Date</th><th>Opt Realized</th><th>Opt Unrealized</th><th>Stk Realized</th><th>Stk Unrealized</th></tr></thead>
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

      <section className="performance-calendar-section performance-pane" aria-label="Calendar">
        <h3 className="card-subtitle page-title-with-tooltip">
          Calendar
          <InfoTooltip text="Daily Option Realized and Unrealized (R/U). Realized matches day drill-down: FIFO match option PnL plus prorated linked-stock slippage when option–stock links exist." />
        </h3>
        {data && summary ? (
          <>
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
                      <button type="button" className="btn btn-secondary" onClick={goPrev} aria-label="Previous month">&larr; Prev</button>
                      <span className="performance-calendar-title">{monthLabel}</span>
                      <button type="button" className="btn btn-secondary" onClick={goNext} aria-label="Next month">Next &rarr;</button>
                    </div>
                    <div className="performance-calendar-legend" aria-label="PnL legend">
                      <span className="performance-calendar-legend-item performance-calendar-legend-item-realized">R = Realized</span>
                      <span className="performance-calendar-legend-item performance-calendar-legend-item-unrealized">U = Unrealized</span>
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
                    <div className="performance-calendar-summary performance-calendar-summary-card">
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
                                if (e.account_executions_id != null) execById.set(e.account_executions_id, e)
                              }
                              const relevantPairs = filterRelevantOptPairsForDay(backendPairs, execById, selectedDay)
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
                                const sortedExecs = [...execs].sort(sortExecByExecutionDateThenTime)
                                const matchedQtyById = new Map<number, number>()
                                for (const p of pairs) {
                                  const pq = Math.abs(p.quantity) || 0
                                  if (p.leg_c_execution_id != null) matchedQtyById.set(p.leg_c_execution_id, (matchedQtyById.get(p.leg_c_execution_id) ?? 0) + pq)
                                  if (p.leg_p_execution_id != null) matchedQtyById.set(p.leg_p_execution_id, (matchedQtyById.get(p.leg_p_execution_id) ?? 0) + pq)
                                }
                                const pairNetSum = pairs.reduce((s, p) => s + (p.net_pnl ?? matchPnl(p)), 0)
                                const realizedPnl = realizedPnlFifoMatchPlusStock(
                                  pairNetSum,
                                  sortedExecs,
                                  matchedQtyById,
                                  selectedDayOptionStockLinkByOptionId,
                                )
                                const realizedComm = pairs.reduce((s, p) => s + (Number(p.commission) || 0), 0)
                                let unrealizedPnl = 0
                                let unrealizedComm = 0
                                let hasUnmatched = false
                                for (const e of sortedExecs) {
                                  const eq = Math.abs(Number(e.quantity) || 0)
                                  if (eq <= 0) continue
                                  const mq = e.account_executions_id != null ? (matchedQtyById.get(e.account_executions_id) ?? 0) : 0
                                  const uq = eq - mq
                                  if (uq > 1e-9) {
                                    const ratio = uq / eq
                                    unrealizedPnl += ratio * ledgerOptionExecutionCashFlowSigned(e)
                                    unrealizedComm += ratio * (Number(e.commission) || 0)
                                    hasUnmatched = true
                                  }
                                }
                                if (pairs.length > 0) {
                                  if (!keysBySymbolRealized.has(symbol)) keysBySymbolRealized.set(symbol, [])
                                  keysBySymbolRealized.get(symbol)!.push(key)
                                  symbolSumRealized.set(symbol, (symbolSumRealized.get(symbol) ?? 0) + realizedPnl)
                                  symbolCommissionRealized.set(symbol, (symbolCommissionRealized.get(symbol) ?? 0) + realizedComm)
                                  totalRealizedSum += realizedPnl
                                  totalCommissionRealized += realizedComm
                                }
                                if (hasUnmatched) {
                                  if (!keysBySymbolUnrealized.has(symbol)) keysBySymbolUnrealized.set(symbol, [])
                                  keysBySymbolUnrealized.get(symbol)!.push(key)
                                  symbolSumUnrealized.set(symbol, (symbolSumUnrealized.get(symbol) ?? 0) + unrealizedPnl)
                                  symbolCommissionUnrealized.set(symbol, (symbolCommissionUnrealized.get(symbol) ?? 0) + unrealizedComm)
                                  totalUnrealizedSum += unrealizedPnl
                                  totalCommissionUnrealized += unrealizedComm
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
                                    {selectedDayPnLType === 'realized'
                                      ? 'Matched legs and pairs by contract (FIFO)'
                                      : 'Executions by contract (unmatched quantity)'}
                                  </h5>
                                  {selectedDayPnLType === 'realized' && (
                                    <p className="section-hint performance-calendar-records-realized-hint">
                                      Realized lists execution legs that participate in a FIFO match (scaled to matched qty when partial), then match rows. Match row PnL is option (FIFO) only. Execution rows show per-leg premium plus prorated linked stock (Trade Ledger detail). Realized tab and symbol totals = sum of Match option PnL (FIFO) for the contract plus prorated linked-stock slippage on matched fills. Open quantity appears under Unrealized.
                                    </p>
                                  )}
                                  {contractKeys.length === 0 ? (
                                    <p className="section-hint">No Option executions in DB for this trade date.</p>
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
                                              ? 'No realized (matched BUY↔SELL) pairs for this day.'
                                              : 'No unrealized (unmatched) executions for this day.'}
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
                                      const sortedExecs = [...execs].sort(sortExecByExecutionDateThenTime)
                                      type Row =
                                        | { type: 'Execution'; e: Execution; unmatchedRatio?: number; matchedRatio?: number }
                                        | { type: 'Match'; p: (typeof dayPairs)[0] }
                                      const matchedQtyById2 = new Map<number, number>()
                                      for (const p of pairs) {
                                        const pq = Math.abs(p.quantity) || 0
                                        if (p.leg_c_execution_id != null) matchedQtyById2.set(p.leg_c_execution_id, (matchedQtyById2.get(p.leg_c_execution_id) ?? 0) + pq)
                                        if (p.leg_p_execution_id != null) matchedQtyById2.set(p.leg_p_execution_id, (matchedQtyById2.get(p.leg_p_execution_id) ?? 0) + pq)
                                      }
                                      const isRealizedTab = selectedDayPnLType === 'realized'
                                      let tabUnrealizedPnl = 0
                                      let tabUnrealizedComm = 0
                                      const unmatchedRows: { e: Execution; unmatchedRatio: number }[] = []
                                      if (!isRealizedTab) {
                                        for (const e of sortedExecs) {
                                          const eq = Math.abs(Number(e.quantity) || 0)
                                          if (eq <= 0) continue
                                          const mq = e.account_executions_id != null ? (matchedQtyById2.get(e.account_executions_id) ?? 0) : 0
                                          const uq = eq - mq
                                          if (uq > 1e-9) {
                                            const ratio = uq / eq
                                            unmatchedRows.push({ e, unmatchedRatio: ratio })
                                            tabUnrealizedPnl += ratio * ledgerOptionExecutionCashFlowSigned(e)
                                            tabUnrealizedComm += ratio * (Number(e.commission) || 0)
                                          }
                                        }
                                      }
                                      const pairedLegIdSet = new Set<number>()
                                      for (const p of pairs) {
                                        if (p.leg_c_execution_id != null) pairedLegIdSet.add(p.leg_c_execution_id)
                                        if (p.leg_p_execution_id != null) pairedLegIdSet.add(p.leg_p_execution_id)
                                      }
                                      const realizedExecRows: { e: Execution; matchedRatio: number }[] = []
                                      if (isRealizedTab) {
                                        for (const e of sortedExecs) {
                                          const id = e.account_executions_id
                                          if (id == null || !pairedLegIdSet.has(id)) continue
                                          const eq = Math.abs(Number(e.quantity) || 0)
                                          if (eq <= 0) continue
                                          const mq = matchedQtyById2.get(id) ?? 0
                                          if (mq <= 1e-9) continue
                                          realizedExecRows.push({ e, matchedRatio: mq / eq })
                                        }
                                      }
                                      // Realized: execution legs involved in a match (scaled when partial), then FIFO match rows.
                                      const rows: Row[] = isRealizedTab
                                        ? [
                                            ...realizedExecRows.map(({ e, matchedRatio }) => ({
                                              type: 'Execution' as const,
                                              e,
                                              matchedRatio,
                                            })),
                                            ...pairs.map((p) => ({ type: 'Match' as const, p })),
                                          ]
                                        : unmatchedRows.map(({ e, unmatchedRatio }) => ({ type: 'Execution' as const, e, unmatchedRatio }))
                                      const pairNetSumTab = pairs.reduce((s, p) => s + (p.net_pnl ?? matchPnl(p)), 0)
                                      const tabPnl = isRealizedTab
                                        ? realizedPnlFifoMatchPlusStock(
                                            pairNetSumTab,
                                            sortedExecs,
                                            matchedQtyById2,
                                            selectedDayOptionStockLinkByOptionId,
                                          )
                                        : tabUnrealizedPnl
                                      const tabComm = isRealizedTab
                                        ? pairs.reduce((s, p) => s + (Number(p.commission) || 0), 0)
                                        : tabUnrealizedComm
                                      if (rows.length === 0) return null
                                      return (
                                        <div key={key} className="performance-calendar-contract-group">
                                          <h6 className="performance-calendar-contract-title">
                                            {symbol} {expiry} {strike} {rightFull !== '—' ? rightFull : ''}
                                            <span className={
                                              isRealizedTab
                                                ? (tabPnl >= 0 ? 'tone-positive' : 'tone-negative')
                                                : 'tone-unrealized'
                                            }>
                                              {' '}{fmtUsd(tabPnl)}
                                            </span>
                                            <span className="performance-records-commission-sum">
                                              {' '}{fmtUsd(tabComm)}
                                            </span>
                                          </h6>
                                          <table className="performance-calendar-pairs-table performance-calendar-unified-table">
                                            <thead>
                                              <tr>
                                                <th>Record type</th>
                                                <th>Id</th>
                                                <th>Account</th>
                                                <th>TRADE DATE</th>
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
                                                  const tdC = (legC?.trade_date ?? '').trim()
                                                  const tdP = (legP?.trade_date ?? '').trim()
                                                  const tradeDateStr =
                                                    tdC !== '' ? tdC : tdP !== '' ? tdP : '—'
                                                  const mp = row.p.net_pnl ?? matchPnl(row.p)
                                                  return (
                                                    <tr key={`match-${idx}`} className="performance-calendar-row-match">
                                                      <td>Match</td>
                                                      <td>
                                                        {row.p.leg_c_execution_id != null && row.p.leg_p_execution_id != null
                                                          ? `${row.p.leg_c_execution_id} / ${row.p.leg_p_execution_id}`
                                                          : '—'}
                                                      </td>
                                                      <td>{row.p.account_id || '—'}</td>
                                                      <td>{tradeDateStr}</td>
                                                      <td>{`${row.p.c_side} / ${row.p.p_side}`}</td>
                                                      <td>{String(row.p.quantity)}</td>
                                                      <td>{`${fmtUsd(row.p.c_price)} / ${fmtUsd(row.p.p_price)}`}</td>
                                                      <td>{fmtUsd(row.p.commission)}</td>
                                                      <td
                                                        className={
                                                          Math.abs(mp) < 0.005 ? '' : mp >= 0 ? 'tone-positive' : 'tone-negative'
                                                        }
                                                      >
                                                        {fmtPnl(mp)}
                                                      </td>
                                                    </tr>
                                                  )
                                                })() : (
                                                  (() => {
                                                    const r =
                                                      row.unmatchedRatio != null
                                                        ? row.unmatchedRatio
                                                        : row.matchedRatio != null
                                                          ? row.matchedRatio
                                                          : 1
                                                    const ec = (Number(row.e.commission) || 0) * r
                                                    const eq = Math.abs(Number(row.e.quantity) || 0)
                                                    const displayQty = r < 1 - 1e-9 ? Math.round((eq * r) * 1e4) / 1e4 : (row.e.quantity ?? '—')
                                                    const ex = row.e
                                                    const sym0 = (ex.symbol ?? '').trim().split(/\s+/)[0]?.trim() ?? ''
                                                    const detailTitle = [sym0, optionRightToFull(ex.option_right), ex.strike != null ? String(ex.strike) : '']
                                                      .filter((x) => String(x).trim() !== '')
                                                      .join(' ')
                                                    const { displayPnl: execDisplayPnl, hasCombinedStock } = isRealizedTab
                                                      ? scaledLedgerOptDetailRowPnl(ex, r, selectedDayOptionStockLinkByOptionId)
                                                      : {
                                                          displayPnl: ledgerOptionExecutionCashFlowSigned(ex) * r,
                                                          hasCombinedStock: false,
                                                        }
                                                    const pnlClass = isRealizedTab
                                                      ? Math.abs(execDisplayPnl) < 0.005
                                                        ? ''
                                                        : execDisplayPnl >= 0
                                                          ? 'tone-positive'
                                                          : 'tone-negative'
                                                      : executionLegPnlToneClass(ex, execDisplayPnl)
                                                    const { linkIds, links, slippageTotal: linkSlip } = getOptionStockLinkDetailForExecution(
                                                      ex,
                                                      selectedDayOptionStockLinkByOptionId,
                                                    )
                                                    return (
                                                  <tr key={row.e.account_executions_id ?? idx} className="performance-calendar-row-execution">
                                                    <td>Execution</td>
                                                    <td>
                                                      <span className="performance-calendar-exec-id-wrap">
                                                        {ex.account_executions_id ?? '—'}
                                                        {isRealizedTab && linkIds.length > 0 ? (
                                                          <span className="ledger-opt-link-stock-badges">
                                                            {linkIds.map((lid) => (
                                                              <button
                                                                key={lid}
                                                                type="button"
                                                                className="ledger-opt-link-stock-badge"
                                                                onClick={(e) => {
                                                                  e.stopPropagation()
                                                                  handleViewOptionStockLinks(
                                                                    links,
                                                                    `Link #${lid} · Exec #${ex.account_executions_id ?? '?'} · ${detailTitle || 'Option'}`,
                                                                    linkSlip,
                                                                  )
                                                                }}
                                                              >
                                                                #{lid}
                                                              </button>
                                                            ))}
                                                          </span>
                                                        ) : null}
                                                      </span>
                                                    </td>
                                                    <td>{row.e.account_id ?? '—'}</td>
                                                    <td>{(row.e.trade_date ?? '').trim() || '—'}</td>
                                                    <td>{row.e.side ?? '—'}</td>
                                                    <td>{displayQty}</td>
                                                    <td>{fmtUsd(row.e.price)}</td>
                                                    <td>{fmtUsd(ec)}</td>
                                                    <td
                                                      className={pnlClass}
                                                      title={
                                                        isRealizedTab && hasCombinedStock
                                                          ? 'Option premium cash flow for matched quantity plus linked stock slippage (vs Flex close)'
                                                          : undefined
                                                      }
                                                    >
                                                      {fmtPnl(execDisplayPnl)}
                                                    </td>
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

      <section className="performance-on-the-fly-section performance-pane" aria-label="On the fly executions">
        <div className="performance-on-the-fly-header">
          <h3 className="card-title performance-on-the-fly-title">On the fly</h3>
          <button
            type="button"
            className="btn btn-secondary performance-on-the-fly-toggle"
            aria-expanded={onTheFlyOpen}
            onClick={() => setOnTheFlyOpen((o) => !o)}
          >
            {onTheFlyOpen ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="section-hint performance-on-the-fly-hint">
          TWS-side executions that are not already covered by the official book (same account and contract as a row in
          the Flex/Journal ledger). Option combo legs (<code className="performance-inline-code">BAG</code>) are
          omitted. Same time range and strategy filters as above.
        </p>
        {onTheFlyOpen && (
          <>
            {onTheFlyLoading && <p className="section-hint">Loading…</p>}
            {onTheFlyError && <p className="section-hint tone-negative">{onTheFlyError}</p>}
            {!onTheFlyLoading && !onTheFlyError && onTheFlyPerf?.summary != null && (
              <div className="performance-on-the-fly-summary" aria-label="On the fly summary total">
                <span className="performance-on-the-fly-summary-kv">
                  Trades <strong>{onTheFlyPerf.summary.trade_count ?? 0}</strong>
                </span>
                <span className="performance-on-the-fly-summary-kv">
                  Net PnL{' '}
                  <strong className={(() => {
                    const n = onTheFlyPerf.summary.net_pnl ?? 0
                    if (Math.abs(n) < 0.005) return ''
                    return n >= 0 ? 'tone-positive' : 'tone-negative'
                  })()}>{fmtPnl(onTheFlyPerf.summary.net_pnl ?? 0)}</strong>
                </span>
                <span className="performance-on-the-fly-summary-kv">
                  Realized <strong>{fmtPnl(onTheFlyPerf.summary.total_realized_pnl ?? 0)}</strong>
                </span>
                <span className="performance-on-the-fly-summary-kv">
                  Commission <strong>{fmtUsd(onTheFlyPerf.summary.total_commission ?? 0)}</strong>
                </span>
              </div>
            )}
            {!onTheFlyLoading && !onTheFlyError && onTheFlyComputed != null && onTheFlyExecs.length > 0 && (() => {
              const optExecs = onTheFlyExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
              const stkExecs = onTheFlyExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'STK')
              const optComm = optExecs.reduce((s, e) => s + (Number(e.commission) || 0), 0)
              const stkComm = stkExecs.reduce((s, e) => s + (Number(e.commission) || 0), 0)
              const { opt: oAg, stk: sAg } = onTheFlyComputed
              const kvClass = (n: number) => (Math.abs(n) < 0.005 ? '' : n >= 0 ? 'tone-positive' : 'tone-negative')
              return (
                <div className="performance-on-the-fly-by-sec" aria-label="On the fly by sec type">
                  <div className="performance-on-the-fly-summary performance-on-the-fly-summary-sec">
                    <span className="performance-on-the-fly-summary-sec-label">Options (OPT)</span>
                    <span className="performance-on-the-fly-summary-kv">
                      Trades <strong>{optExecs.length}</strong>
                    </span>
                    <span className="performance-on-the-fly-summary-kv">
                      Realized (FIFO){' '}
                      <strong className={kvClass(oAg.realized)}>{fmtPnl(oAg.realized)}</strong>
                    </span>
                    <span className="performance-on-the-fly-summary-kv">
                      Unrealized (open){' '}
                      <strong className={kvClass(oAg.unrealized)}>{fmtPnl(oAg.unrealized)}</strong>
                      <InfoTooltip text="Option legs use the same per-execution cash flow as Trade Ledger → Options → Details (PnL column). Pairing uses backend opt pairs when available, else FIFO by contract. Trade date falls back to exec date when Flex trade_date is missing." />
                    </span>
                    <span className="performance-on-the-fly-summary-kv">
                      Commission <strong>{fmtUsd(optComm)}</strong>
                    </span>
                  </div>
                  <div className="performance-on-the-fly-summary performance-on-the-fly-summary-sec">
                    <span className="performance-on-the-fly-summary-sec-label">Stocks (STK)</span>
                    <span className="performance-on-the-fly-summary-kv">
                      Trades <strong>{stkExecs.length}</strong>
                    </span>
                    <span className="performance-on-the-fly-summary-kv">
                      Realized (FIFO){' '}
                      <strong className={kvClass(sAg.realized)}>{fmtPnl(sAg.realized)}</strong>
                    </span>
                    <span className="performance-on-the-fly-summary-kv">
                      Unrealized (open){' '}
                      <strong
                        className={
                          Math.abs(sAg.unrealized) < 0.005 ? '' : 'tone-unrealized performance-on-the-fly-stk-unrealized'
                        }
                      >
                        {fmtPnl(sAg.unrealized)}
                      </strong>
                      <InfoTooltip text="Realized: FIFO matched lots (buy vs sell) within the time range. Unrealized: open lots — long (remaining buys) is positive cost-style; short (remaining sells) is negative — opposite sign convention to option legs. Shares × price, no multiplier. Trade date uses exec date when trade_date is missing." />
                    </span>
                    <span className="performance-on-the-fly-summary-kv">
                      Commission <strong>{fmtUsd(stkComm)}</strong>
                    </span>
                  </div>
                </div>
              )
            })()}
            {!onTheFlyLoading && !onTheFlyError && onTheFlyExecs.length === 0 && (
              <p className="section-hint">No on-the-fly executions in this range.</p>
            )}
            {!onTheFlyLoading && onTheFlyExecs.length > 0 && (
              <>
                <div className="performance-on-the-fly-sec-tabs" role="tablist" aria-label="On the fly sec type">
                  {(['all', 'OPT', 'STK'] as const).map((tab) => {
                    const count =
                      tab === 'all'
                        ? onTheFlyExecs.length
                        : tab === 'OPT'
                          ? onTheFlyExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT').length
                          : onTheFlyExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'STK').length
                    const label = tab === 'all' ? 'All' : tab === 'OPT' ? 'OPT' : 'STK'
                    return (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={onTheFlySecTab === tab}
                        className={`performance-on-the-fly-sec-tab ${onTheFlySecTab === tab ? 'active' : ''}`}
                        onClick={() => setOnTheFlySecTab(tab)}
                      >
                        {label}
                        <span className="performance-on-the-fly-sec-tab-count">{count}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="table-wrap performance-on-the-fly-table-wrap">
                  <table className="data-table performance-on-the-fly-table">
                    <thead>
                      <tr>
                        <th>Sec</th>
                        <th>Execution ID</th>
                        <th>Trade date</th>
                        <th>Time</th>
                        <th>Account</th>
                        <th>Symbol</th>
                        <th>Expiry</th>
                        <th>Strike</th>
                        <th>Right</th>
                        <th>Side</th>
                        <th>Qty</th>
                        <th>Price</th>
                        <th>Source</th>
                        <th>
                          {onTheFlySecTab === 'STK'
                            ? 'Unrealized PnL'
                            : onTheFlySecTab === 'OPT'
                              ? 'PnL'
                              : 'PnL / Unrealized PnL'}
                        </th>
                        <th>Realized PnL</th>
                        <th>Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {onTheFlyExecs
                        .filter((e) => {
                          if (onTheFlySecTab === 'all') return true
                          return (e.sec_type ?? '').toUpperCase() === onTheFlySecTab
                        })
                        .map((e) => {
                          const rp = e.realized_pnl
                          const rpNum = rp != null && typeof rp === 'number' && Number.isFinite(rp) ? rp : null
                          const isOpt = (e.sec_type ?? '').toUpperCase() === 'OPT'
                          const isStk = (e.sec_type ?? '').toUpperCase() === 'STK'
                          const tradeDateDisplay = (e.trade_date ?? '').trim() || executionDateStr(e) || '—'
                          const ledgerPnl = isOpt ? ledgerOptionExecutionDisplayPnl(e) : null
                          const stkUnrealLeg = isStk ? stockOnTheFlyUnrealizedPnlLeg(e) : null
                          const ledgerPnlClass =
                            ledgerPnl == null || !isOpt
                              ? ''
                              : Math.abs(ledgerPnl) < 0.005
                                ? ''
                                : ledgerPnl >= 0
                                  ? 'tone-positive'
                                  : 'tone-negative'
                          const stkUnrealLegClass =
                            isStk && stkUnrealLeg != null
                              ? 'tone-unrealized performance-on-the-fly-stk-table-unreal-pnl'
                              : ''
                          return (
                            <tr key={e.account_executions_id ?? `${e.account_id}-${e.time}-${e.symbol}`}>
                              <td>{e.sec_type ?? '—'}</td>
                              <td>{e.account_executions_id ?? '—'}</td>
                              <td title={(e.trade_date ?? '').trim() ? undefined : 'Exec date (Chicago) — no Flex trade_date on this row'}>
                                {tradeDateDisplay}
                              </td>
                              <td>{fmtChicagoTime(e.time)}</td>
                              <td>{e.account_id ?? '—'}</td>
                              <td>{e.symbol ?? '—'}</td>
                              <td>{isOpt ? (e.expiry ?? '—') : '—'}</td>
                              <td>{isOpt ? (e.strike != null ? String(e.strike) : '—') : '—'}</td>
                              <td>{isOpt ? optionRightToFull(e.option_right) : '—'}</td>
                              <td>{e.side ?? '—'}</td>
                              <td>{e.quantity ?? '—'}</td>
                              <td>{fmtUsd(e.price)}</td>
                              <td><ExecSourceBadge source={e.source} /></td>
                              <td className={isOpt ? ledgerPnlClass : stkUnrealLegClass}>
                                {isOpt && ledgerPnl != null
                                  ? fmtPnl(ledgerPnl)
                                  : isStk && stkUnrealLeg != null
                                    ? fmtPnl(stkUnrealLeg)
                                    : '—'}
                              </td>
                              <td className={rpNum == null ? '' : rpNum >= 0 ? 'tone-positive' : 'tone-negative'}>
                                {rpNum == null ? '—' : fmtPnl(rpNum)}
                              </td>
                              <td>{fmtUsd(e.commission)}</td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
      </section>

      {error && (
        <div className="card card-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      <ViewOptionStockLinksModal
        open={viewStockLinksModal.open}
        title={viewStockLinksModal.title}
        rows={viewStockLinksModal.rows}
        slippageTotal={viewStockLinksModal.slippageTotal}
        onClose={() =>
          setViewStockLinksModal({ open: false, title: '', rows: [], slippageTotal: null })
        }
      />
    </div>
  )
}
