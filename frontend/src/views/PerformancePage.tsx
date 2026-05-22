import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
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
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { ViewOptionStockLinksModal } from './portfolio/ViewOptionStockLinksModal'
import {
  getOptionStockLinkDetailForExecution,
  realizedPnlFifoMatchPlusStock,
  scaledLedgerOptDetailRowPnl,
} from './portfolio/ledgerOptHelpers'
import { fmtChicagoTime, fmtPnl, fmtPnlCalendar, fmtUsd, fmtUsdCompact } from '../utils/format'
import {
  filterExecutionsByUnixRange,
  loadPerformanceDayPnLBulk,
  slicePerformanceForCalendarMonth,
  stkFillNotional,
  stkSignedTradeNotionalUsd,
  sumStkBrokerRealizedPnlForTradeDate,
  type PerformanceCalendarAssetTab,
  type PerformanceDayPnLCell,
} from './performance/performanceBulk'
import {
  buildPositionCategoryByAccountContract,
  getStkLedgerBucketForExecution,
  sumStkPositionMarketValueForBucket,
  serializePositionCategoryKey,
  type StkLedgerBucket,
} from './portfolio/stkLedgerBucket'
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

const CALENDAR_STK_TAB_LABEL: Record<'stocks' | 'fixed_income' | 'cash_like', string> = {
  stocks: 'Stocks',
  fixed_income: 'Fixed income',
  cash_like: 'Cash-like',
}

interface PerformancePageProps {
  status: StatusResponse | null
  onViewChange?: (view: 'accounts') => void
}

export function PerformancePage({ status, onViewChange }: PerformancePageProps) {
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<'quarter' | 'halfyear' | 'year' | '3year'>('quarter')
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
  const [calendarDayPnLByAsset, setCalendarDayPnLByAsset] = useState<Record<
    PerformanceCalendarAssetTab,
    Record<string, PerformanceDayPnLCell>
  > | null>(null)
  const [calendarStkNotionalByBucket, setCalendarStkNotionalByBucket] = useState<Record<
    'stocks' | 'fixed_income' | 'cash_like',
    Record<string, number>
  > | null>(null)
  const [calendarDayPnLLoading, setCalendarDayPnLLoading] = useState(false)
  const [calendarAssetTab, setCalendarAssetTab] = useState<PerformanceCalendarAssetTab>('options')
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
    opt: Record<string, PerformanceDayPnLCell>
    stock: Record<string, PerformanceDayPnLCell>
    stocks: Record<string, PerformanceDayPnLCell>
    fixed_income: Record<string, PerformanceDayPnLCell>
    cash_like: Record<string, PerformanceDayPnLCell>
    stkBucketNotional: {
      stocks: Record<string, number>
      fixed_income: Record<string, number>
      cash_like: Record<string, number>
    }
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

  const positionCategoryKey = useMemo(
    () => serializePositionCategoryKey(status),
    [status],
  )
  const positionCategoryByAccountContract = useMemo(
    () => buildPositionCategoryByAccountContract(status),
    [positionCategoryKey],
  )

  const calendarMonthPerformance = useMemo((): PerformanceResponse | null => {
    if (!data) return null
    return slicePerformanceForCalendarMonth(data, calendarMonth)
  }, [data, calendarMonth])

  const calendarDayPnL = useMemo((): Record<string, PerformanceDayPnLCell> | null => {
    if (!calendarDayPnLByAsset) return null
    return calendarDayPnLByAsset[calendarAssetTab] ?? null
  }, [calendarDayPnLByAsset, calendarAssetTab])

  const calendarDayNotional = useMemo((): Record<string, number> | null => {
    if (!calendarStkNotionalByBucket || calendarAssetTab === 'options') return null
    return calendarStkNotionalByBucket[calendarAssetTab] ?? null
  }, [calendarStkNotionalByBucket, calendarAssetTab])

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
      setCalendarDayPnLByAsset(null)
      setCalendarStkNotionalByBucket(null)
      setCalendarDayPnLLoading(false)
      perfBulkRef.current = null
      return
    }
    setByDayRangeLoading(true)
    setCalendarDayPnLLoading(true)
    let cancelled = false
    const bulkKey = `${sinceStr}|${untilStr}|${strategyOpportunityId ?? ''}|${strategyInstanceId ?? ''}`
    void loadPerformanceDayPnLBulk({
      sinceStr,
      untilStr,
      calendarMonth,
      strategyOpportunityId,
      strategyInstanceId,
      lookBackDays: OPT_PAIR_LOOK_BACK_DAYS,
      positionCategoryByAccountContract,
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
        setCalendarDayPnLByAsset(r.calendarDayPnLByAsset)
        setCalendarStkNotionalByBucket(r.calendarStkNotionalByBucket)
      })
      .catch(() => {
        if (cancelled) return
        perfBulkRef.current = null
        const dateStrsList = listDateStrings(sinceStr, untilStr)
        const z = (): PerformanceDayPnLCell => ({ realized: 0, unrealized: 0 })
        const buildFallbackByDay = () => {
          const fallbackOpt: Record<string, PerformanceDayPnLCell> = {}
          const fallbackStock: Record<string, PerformanceDayPnLCell> = {}
          const fallbackStocks: Record<string, PerformanceDayPnLCell> = {}
          const fallbackFi: Record<string, PerformanceDayPnLCell> = {}
          const fallbackCash: Record<string, PerformanceDayPnLCell> = {}
          const zN = (): number => 0
          const fallbackNS: Record<string, number> = {}
          const fallbackNFi: Record<string, number> = {}
          const fallbackNCash: Record<string, number> = {}
          for (const dateStr of dateStrsList) {
            fallbackOpt[dateStr] = z()
            fallbackStock[dateStr] = z()
            fallbackStocks[dateStr] = z()
            fallbackFi[dateStr] = z()
            fallbackCash[dateStr] = z()
            fallbackNS[dateStr] = zN()
            fallbackNFi[dateStr] = zN()
            fallbackNCash[dateStr] = zN()
          }
          return {
            opt: fallbackOpt,
            stock: fallbackStock,
            stocks: fallbackStocks,
            fixed_income: fallbackFi,
            cash_like: fallbackCash,
            stkBucketNotional: {
              stocks: fallbackNS,
              fixed_income: fallbackNFi,
              cash_like: fallbackNCash,
            },
          }
        }
        setByDayRangeData((prev) => (prev != null ? prev : buildFallbackByDay()))
        setCalendarDayPnLByAsset((prev) => (prev != null ? prev : null))
        setCalendarStkNotionalByBucket((prev) => (prev != null ? prev : null))
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
  }, [timeRange, calendarMonth, strategyOpportunityId, strategyInstanceId, positionCategoryKey])

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
      setSelectedDayExecutions(slice)
      if (calendarAssetTab === 'options') {
        const optPairs = computeBackendOptPairsFromExecutions(slice, sortExecByExecutionDateThenTime)
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
      } else {
        setSelectedDayOptPairs(null)
        const stkTab = calendarAssetTab as StkLedgerBucket
        const rSum = sumStkBrokerRealizedPnlForTradeDate(slice, selectedDay, stkTab, positionCategoryByAccountContract)
        setSelectedDayComputedPnL({ realized: rSum, unrealized: 0 })
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
        const execs = res.executions ?? []
        setSelectedDayExecutions(execs)
        if (calendarAssetTab === 'options') {
          setSelectedDayOptPairs('opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null)
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
        } else {
          setSelectedDayOptPairs(null)
          const stkTab = calendarAssetTab as StkLedgerBucket
          const rSum = sumStkBrokerRealizedPnlForTradeDate(execs, selectedDay, stkTab, positionCategoryByAccountContract)
          setSelectedDayComputedPnL({ realized: rSum, unrealized: 0 })
        }
      })
      .catch(() => {
        setSelectedDayExecutions([])
        setSelectedDayOptPairs(null)
        setSelectedDayComputedPnL(null)
      })
      .finally(() => setSelectedDayExecutionsLoading(false))
  }, [
    selectedDay,
    timeRange,
    calendarMonth,
    strategyOpportunityId,
    strategyInstanceId,
    perfBulkVersion,
    calendarAssetTab,
    positionCategoryKey,
  ])

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

  const [growthUnit, setGrowthUnit] = useState<'pct' | 'usd'>('usd')
  type GrowthLayer = 'options' | 'stocks' | 'fixed_income' | 'cash_like'
  const GROWTH_LAYERS: { key: GrowthLayer; label: string; color: string; colorFill: string }[] = [
    { key: 'options', label: 'Options', color: 'rgb(163,230,53)', colorFill: 'rgba(163,230,53,0.28)' },
    { key: 'stocks', label: 'Stocks', color: 'rgb(56,189,248)', colorFill: 'rgba(56,189,248,0.22)' },
    { key: 'fixed_income', label: 'Fix-In', color: 'rgb(251,191,36)', colorFill: 'rgba(251,191,36,0.18)' },
    { key: 'cash_like', label: 'Cash-like', color: 'rgb(167,139,250)', colorFill: 'rgba(167,139,250,0.18)' },
  ]
  const [growthLayersVisible, setGrowthLayersVisible] = useState<Record<GrowthLayer, boolean>>({
    options: true,
    stocks: false,
    fixed_income: true,
    cash_like: false,
  })
  const [growthHoverIdx, setGrowthHoverIdx] = useState<number | null>(null)
  const [growthTipPos, setGrowthTipPos] = useState<{ left: number; top: number; anchor: 'left' | 'center' | 'right' } | null>(null)
  const growthChartWrapRef = useRef<HTMLDivElement>(null)
  const portfolioGrowthChart = useMemo(() => {
    if (!byDayRangeData) return null
    const capitalBaseRaw = data?.transaction?.capital_base ?? data?.transaction?.start_equity ?? data?.unrealized?.current_equity ?? null
    const capitalBase = Number(capitalBaseRaw)
    const hasCapitalBase = Number.isFinite(capitalBase) && capitalBase > 0
    const isPct = growthUnit === 'pct' && hasCapitalBase

    const optMap = byDayRangeData.opt
    const stocksMap = byDayRangeData.stocks
    const fiMap = byDayRangeData.fixed_income
    const fiNotionalMap = byDayRangeData.stkBucketNotional.fixed_income
    const cashMap = byDayRangeData.cash_like
    const allDates = [...new Set([
      ...Object.keys(optMap), ...Object.keys(stocksMap),
      ...Object.keys(fiMap), ...Object.keys(fiNotionalMap), ...Object.keys(cashMap),
    ])].sort()
    if (allDates.length === 0) return null

    /** Fixed income: cumulative signed STK notional (N); % view is N÷capital base (same N as FI bars; bars show monthly N annualized to %). */
    const vis = growthLayersVisible
    const conv = (v: number) => (isPct ? (100 * v) / capitalBase : v)

    let cumStk = 0, cumFi = 0, cumCash = 0, cumOpt = 0
    let currentOptUMonth = ''
    let optUMonthStartRealizedRaw = 0
    let optUMonthDeltaRaw = 0
    const points = allDates.map((dateStr) => {
      cumOpt += optMap[dateStr]?.realized ?? 0
      cumStk += stocksMap[dateStr]?.realized ?? 0
      cumFi += fiNotionalMap[dateStr] ?? 0
      cumCash += cashMap[dateStr]?.realized ?? 0
      const mk = dateStr.slice(0, 7)
      const uNowRaw = optMap[dateStr]?.unrealized ?? 0
      if (mk !== currentOptUMonth) {
        currentOptUMonth = mk
        optUMonthStartRealizedRaw = cumOpt
        optUMonthDeltaRaw = 0
      } else {
        optUMonthDeltaRaw += uNowRaw
      }
      const optUnrealUsdMonthAnchored = optUMonthStartRealizedRaw + optUMonthDeltaRaw
      const totalRaw = cumOpt + cumStk + cumFi + cumCash
      const totalRawVisible =
        (vis.options ? cumOpt : 0) +
        (vis.stocks ? cumStk : 0) +
        (vis.fixed_income ? cumFi : 0) +
        (vis.cash_like ? cumCash : 0)
      return {
        dateStr,
        dateLabel: (() => {
          const [yy, mm, dd] = dateStr.split('-').map(Number)
          return new Date(yy, mm - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        })(),
        total: conv(totalRaw),
        totalVisible: conv(totalRawVisible),
        options: conv(cumOpt),
        optionsUnrealMonthStart: conv(optUMonthStartRealizedRaw),
        optionsUnrealMonthDelta: conv(optUMonthDeltaRaw),
        optionsUnrealMonthAnchored: conv(optUnrealUsdMonthAnchored),
        stocks: conv(cumStk),
        fixed_income: conv(cumFi),
        cash_like: conv(cumCash),
        totalRaw,
        totalRawVisible,
      }
    })

    const W = 720, H = 220, PL = 6, PR = 6, PT = 14, PB = 28
    const chartW = W - PL - PR, chartH = H - PT - PB

    const valsForScale: number[] = []
    for (const p of points) {
      if (vis.options) {
        valsForScale.push(p.options)
        valsForScale.push(p.optionsUnrealMonthAnchored)
      }
      if (vis.stocks) valsForScale.push(p.stocks)
      if (vis.fixed_income) valsForScale.push(p.fixed_income)
      if (vis.cash_like) valsForScale.push(p.cash_like)
      valsForScale.push(p.totalVisible)
    }
    const allValues = valsForScale
    let minY = Math.min(0, ...allValues)
    let maxY = Math.max(0, ...allValues)
    if (Math.abs(maxY - minY) < 1e-9) { maxY += 1; minY -= 1 }
    const yPad = (maxY - minY) * 0.1
    minY -= yPad; maxY += yPad

    const xScale = (i: number) => PL + (i / Math.max(1, points.length - 1)) * chartW
    const yScale = (v: number) => PT + chartH - ((v - minY) / (maxY - minY)) * chartH

    const makePath = (vals: number[]) =>
      vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ')
    const makeArea = (vals: number[]) => {
      const top = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ')
      const base = `L${xScale(vals.length - 1).toFixed(1)},${yScale(0).toFixed(1)} L${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} Z`
      return `${top} ${base}`
    }

    const totalPath = makePath(points.map((p) => p.totalVisible))
    const totalArea = makeArea(points.map((p) => p.totalVisible))
    const layerAreas = GROWTH_LAYERS.map((l) => ({ ...l, area: makeArea(points.map((p) => p[l.key])), path: makePath(points.map((p) => p[l.key])) }))
    const optionsUnrealPath = vis.options ? makePath(points.map((p) => p.optionsUnrealMonthAnchored)) : ''

    const gridCount = 5
    const gridLines = Array.from({ length: gridCount }, (_, i) => {
      const v = minY + ((maxY - minY) * (i + 1)) / (gridCount + 1)
      return { y: yScale(v), label: isPct ? `${v.toFixed(1)}%` : fmtUsd(v) }
    })

    const xTickCount = Math.min(points.length, 8)
    const xTickStep = Math.max(1, Math.floor(points.length / xTickCount))
    const xTicks = points
      .filter((_, i) => i % xTickStep === 0 || i === points.length - 1)
      .map((p) => ({ x: xScale(points.indexOf(p)), label: p.dateLabel }))

    const zeroY = minY <= 0 && maxY >= 0 ? yScale(0) : null
    const last = points[points.length - 1]!
    const first = points[0]!

    const nPts = points.length
    const monthBands: { x1: number; x2: number; alt: boolean }[] = []
    if (nPts > 0) {
      let seg0 = 0
      let altBand = false
      const pushSeg = (i0: number, i1: number) => {
        const x1 = i0 === 0 ? PL : (xScale(i0 - 1) + xScale(i0)) / 2
        const x2 = i1 === nPts - 1 ? W - PR : (xScale(i1) + xScale(i1 + 1)) / 2
        if (x2 > x1 + 0.25) monthBands.push({ x1, x2, alt: altBand })
        altBand = !altBand
      }
      for (let i = 1; i < nPts; i++) {
        if (points[i]!.dateStr.slice(0, 7) !== points[seg0]!.dateStr.slice(0, 7)) {
          pushSeg(seg0, i - 1)
          seg0 = i
        }
      }
      pushSeg(seg0, nPts - 1)
    }

    const growthChartHit = points.map((p, i) => ({
      cx: xScale(i),
      cyTotal: yScale(p.totalVisible),
      cyOptUnreal: yScale(p.optionsUnrealMonthAnchored),
    }))

    return {
      W, H, PL, PR, PT, PB, chartW, chartH,
      totalPath, totalArea, layerAreas, gridLines, xTicks, zeroY,
      first, last, hasCapitalBase, isPct, points,
      monthBands,
      optionsUnrealPath,
      growthChartHit,
    }
  }, [data, byDayRangeData, growthUnit, growthLayersVisible])

  const clearGrowthChartHover = useCallback(() => {
    setGrowthHoverIdx(null)
    setGrowthTipPos(null)
  }, [])

  const onGrowthChartPointer = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      const chart = portfolioGrowthChart
      if (!chart) return
      if (e.type === 'pointerleave' || e.type === 'pointercancel') {
        clearGrowthChartHover()
        return
      }
      const wrap = growthChartWrapRef.current
      if (!wrap) return
      const svg = e.currentTarget.ownerSVGElement
      if (!svg) return
      const svgRect = svg.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      const vbW = chart.W
      const vbH = chart.H
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const inv = ctm.inverse()
      const svgPt = svg.createSVGPoint()
      svgPt.x = e.clientX
      svgPt.y = e.clientY
      const local = svgPt.matrixTransform(inv)
      const xSvg = local.x
      const plotL = chart.PL
      const plotR = chart.W - chart.PR
      if (xSvg < plotL || xSvg > plotR) {
        clearGrowthChartHover()
        return
      }
      const n = chart.points.length
      if (n === 0) return
      let idx = 0
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < chart.growthChartHit.length; i++) {
        const d = Math.abs(chart.growthChartHit[i]!.cx - xSvg)
        if (d < best) {
          best = d
          idx = i
        }
      }
      const hit = chart.growthChartHit[idx]
      if (!hit) return
      setGrowthHoverIdx(idx)
      const xPx = svgRect.left - wrapRect.left + (hit.cx / vbW) * svgRect.width
      const yPx = svgRect.top - wrapRect.top + (hit.cyTotal / vbH) * svgRect.height
      const margin = 8
      const tipW = 260
      const tipHalf = tipW / 2
      let anchor: 'left' | 'center' | 'right' = 'center'
      let left = xPx
      if (xPx + tipHalf + margin > wrapRect.width) {
        anchor = 'right'
        left = Math.max(margin + tipW, xPx)
      } else if (xPx - tipHalf - margin < 0) {
        anchor = 'left'
        left = Math.min(wrapRect.width - margin - tipW, xPx)
      }
      setGrowthTipPos({ left, top: yPx, anchor })
    },
    [portfolioGrowthChart, clearGrowthChartHover],
  )

  useEffect(() => {
    clearGrowthChartHover()
  }, [portfolioGrowthChart, clearGrowthChartHover])

  /** FI: monthly signed notional; shares growthUnit — $ = month N, % = annualized (N÷FI position value)×365/d. */
  const fiMonthlyNotionalChart = useMemo(() => {
    if (!byDayRangeData) return null
    const fiPositionValueBaseRaw = sumStkPositionMarketValueForBucket(status, 'fixed_income')
    const fiPositionValueBase = Number(fiPositionValueBaseRaw)
    const hasFiPositionValueBase = Number.isFinite(fiPositionValueBase) && fiPositionValueBase > 0
    const { sinceStr, untilStr } = getTimeRangeDates(timeRange, calendarMonth)
    const monthKeys = listMonthKeysInRange(sinceStr, untilStr)
    if (monthKeys.length === 0) return null
    const daily = byDayRangeData.stkBucketNotional.fixed_income
    const totals = new Map<string, number>(monthKeys.map((k) => [k, 0]))
    for (const [dateStr, raw] of Object.entries(daily)) {
      const mk = dateStr.slice(0, 7)
      if (!totals.has(mk)) continue
      totals.set(mk, (totals.get(mk) ?? 0) + (Number(raw) || 0))
    }
    const rows = monthKeys.map((monthKey) => {
      const [y, m] = monthKey.split('-').map(Number)
      const label = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      const monthlyNotional = totals.get(monthKey) ?? 0
      const daysInMonth = new Date(y, m, 0).getDate()
      const monthlyRatio = hasFiPositionValueBase && fiPositionValueBase > 0 ? monthlyNotional / fiPositionValueBase : 0
      const annualizedRatio =
        hasFiPositionValueBase && fiPositionValueBase > 0 && daysInMonth > 0 ? monthlyRatio * (365 / daysInMonth) : 0
      return { monthKey, label, monthlyNotional, monthlyRatio, annualizedRatio, daysInMonth }
    })
    const useRatio = hasFiPositionValueBase
    const fiAnnMode = useRatio && growthUnit === 'pct'
    const vals = !useRatio
      ? rows.map((r) => r.monthlyNotional)
      : fiAnnMode
        ? rows.map((r) => r.annualizedRatio)
        : rows.map((r) => r.monthlyNotional)
    let minY = Math.min(0, ...vals)
    let maxY = Math.max(0, ...vals)
    if (Math.abs(maxY - minY) < 1e-9) {
      maxY = 1
      minY = -1
    }
    const pad = (maxY - minY) * 0.08
    minY -= pad
    maxY += pad
    const n = rows.length
    const W = Math.max(176, Math.min(328, 40 + n * 12))
    const H = 186
    const axisGutter = 32
    const plotX0 = axisGutter + 2
    const PR = 6
    const PB = 26
    const plotTop = 6
    const plotBottom = H - PB
    const chartW = W - plotX0 - PR
    const chartH = plotBottom - plotTop
    const yScale = (v: number) => plotBottom - ((v - minY) / (maxY - minY)) * chartH
    const zeroY = yScale(0)
    const slot = chartW / Math.max(1, n)
    const barW = Math.max(2, Math.min(20, slot * 0.58))
    const xLabelStep = Math.max(1, Math.ceil(n / 5))
    const plotVal = (r: (typeof rows)[0]) =>
      !useRatio ? r.monthlyNotional : fiAnnMode ? r.annualizedRatio : r.monthlyNotional
    const bars = rows.map((r, i) => {
      const v = plotVal(r)
      const cx = plotX0 + (i + 0.5) * slot
      const x = cx - barW / 2
      const t = yScale(Math.max(0, v))
      const b = yScale(Math.min(0, v))
      const h = Math.max(v === 0 ? 0 : 1, Math.abs(b - t))
      const yRect = Math.min(t, b)
      const valueLine = !useRatio
        ? fmtUsd(r.monthlyNotional)
        : fiAnnMode
          ? `${(100 * r.annualizedRatio).toFixed(2)}%`
          : fmtUsd(r.monthlyNotional)
      const valueX = cx
      let labelY: number
      if (v === 0) labelY = Math.max(plotTop + 4, zeroY - 6)
      else if (v > 0) labelY = Math.max(plotTop + 4, yRect - 5)
      else labelY = Math.min(plotBottom - 10, yRect + h + 6)
      return {
        key: r.monthKey,
        x,
        y: yRect,
        w: barW,
        h,
        label: r.label,
        monthlyNotional: r.monthlyNotional,
        monthlyRatio: r.monthlyRatio,
        annualizedRatio: r.annualizedRatio,
        valueLine,
        valueX,
        labelY,
        showXLabel: i % xLabelStep === 0 || i === n - 1,
        tone: v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero' as const,
      }
    })
    const yTopLabel = !useRatio || !fiAnnMode ? fmtUsdCompact(maxY) : `${(100 * maxY).toFixed(2)}%`
    const yBotLabel = !useRatio || !fiAnnMode ? fmtUsdCompact(minY) : `${(100 * minY).toFixed(2)}%`
    return {
      W,
      H,
      plotX0,
      axisGutter,
      PR,
      PB,
      plotTop,
      plotBottom,
      bars,
      zeroY,
      yTopLabel,
      yBotLabel,
      chartW,
      chartH,
      useRatio,
      fiAnnMode,
      fiPositionValueBase,
    }
  }, [byDayRangeData, timeRange, calendarMonth, growthUnit, status])

  return (
    <div className={cn(w9.appPageStack, 'performance-page')}>
      <PageSection className="performance-summary-section" aria-label="Performance">
        <SectionPageTitle
          menu="Portfolio"
          pageTitle="Performance"
          onMenuClick={() => onViewChange?.('accounts')}
          infoText="Track realized and unrealized PnL with daily drill-downs. Charts and aggregates above use Flex Trades and journal-closed executions only."
        />
        <p className="performance-page-subtitle">
          Track realized and unrealized PnL with daily drill-downs. Charts and aggregates above use Flex Trades and journal-closed executions only.
        </p>
        <section className="performance-time-range-block performance-pane" aria-label="Time range and daily statistics">
        <div className="performance-filters performance-filters-inline">
          {loading && <p className={cn(w9.sectionHint, 'performance-filters-loading')}>Loading…</p>}
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
                <label className={`performance-time-range-pill ${timeRange === 'halfyear' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="timeRange"
                    value="halfyear"
                    checked={timeRange === 'halfyear'}
                    onChange={() => setTimeRange('halfyear')}
                    className="performance-time-range-pill-input"
                    aria-label="Half year"
                  />
                  <span className="performance-time-range-pill-label">Half year</span>
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
              const stocksMap = byDayRangeData.stocks
              const fiMap = byDayRangeData.fixed_income
              const cashMap = byDayRangeData.cash_like
              const nMap = byDayRangeData.stkBucketNotional
              const dateStrs = Object.keys(optMap).sort()
              const totalSum = dateStrs.reduce(
                (a, dateStr) => {
                  const opt = optMap[dateStr] ?? { realized: 0, unrealized: 0 }
                  const s = stocksMap[dateStr] ?? { realized: 0, unrealized: 0 }
                  const f = fiMap[dateStr] ?? { realized: 0, unrealized: 0 }
                  const c = cashMap[dateStr] ?? { realized: 0, unrealized: 0 }
                  return {
                    optRealized: a.optRealized + opt.realized,
                    optUnrealized: a.optUnrealized + opt.unrealized,
                    stocksNotional: a.stocksNotional + (nMap.stocks[dateStr] ?? 0),
                    stocksRealized: a.stocksRealized + s.realized,
                    fiNotional: a.fiNotional + (nMap.fixed_income[dateStr] ?? 0),
                    fiRealized: a.fiRealized + f.realized,
                    cashNotional: a.cashNotional + (nMap.cash_like[dateStr] ?? 0),
                    cashRealized: a.cashRealized + c.realized,
                  }
                },
                {
                  optRealized: 0,
                  optUnrealized: 0,
                  stocksNotional: 0,
                  stocksRealized: 0,
                  fiNotional: 0,
                  fiRealized: 0,
                  cashNotional: 0,
                  cashRealized: 0,
                },
              )
              return (
                <span className="by-day-total-summary-inline" aria-label="Total sum of all days">
                  <span className="by-day-total-summary-kv">
                    Option{' '}
                    <span className={totalSum.optRealized >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtPnl(totalSum.optRealized)}</span> /{' '}
                    <span className="by-day-sum-number">{fmtPnl(totalSum.optUnrealized)}</span>
                  </span>
                  <span className="by-day-total-summary-kv">
                    Stocks{' '}
                    <span className="by-day-sum-number">{fmtUsd(totalSum.stocksNotional)}</span> /{' '}
                    <span className={totalSum.stocksRealized >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtPnl(totalSum.stocksRealized)}</span>
                  </span>
                  <span className="by-day-total-summary-kv">
                    FI{' '}
                    <span className="by-day-sum-number">{fmtUsd(totalSum.fiNotional)}</span> /{' '}
                    <span className={totalSum.fiRealized >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtPnl(totalSum.fiRealized)}</span>
                  </span>
                  <span className="by-day-total-summary-kv">
                    Cash-like{' '}
                    <span className="by-day-sum-number">{fmtUsd(totalSum.cashNotional)}</span> /{' '}
                    <span className={totalSum.cashRealized >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtPnl(totalSum.cashRealized)}</span>
                  </span>
                </span>
              )
            })()}
          </div>
        </div>
        {portfolioGrowthChart && (
          <section className="performance-growth-panel" aria-label="Portfolio equity growth">
            <div className="performance-growth-panel-header">
              <div>
                <div className="performance-growth-panel-title-row">
                  <h3>Portfolio Equity Growth</h3>
                  <InfoTooltip
                    text={
                      'USD: Options, Stocks, and Cash-like use cumulative realized PnL in US dollars. Fixed Income uses cumulative signed notional (N as return) in US dollars. The % / $ toggle also switches the FI bar chart: in $, bars use that month’s total signed notional. The white Total line and the Total figure sum only the asset classes whose boxes are checked. Net PnL is always the full portfolio (all four). — %: same as USD but scaled to % of capital base; FI bars use annualized % when % is selected. Options: the dashed line in the same color is end-of-day unrealized, replotted each calendar month so its value on the first day of that month in the range equals cumulative Options realized on that day; within the month it moves by Δ unrealized vs that anchor (same daily U as the calendar, month-localized).'
                    }
                  />
                </div>
              </div>
              <div className="performance-growth-controls">
                <div className="performance-growth-unit-toggle" role="group" aria-label="Growth chart and Fixed income bar units">
                  <button className={growthUnit === 'pct' ? 'active' : ''} onClick={() => setGrowthUnit('pct')} disabled={!portfolioGrowthChart.hasCapitalBase}>%</button>
                  <button className={growthUnit === 'usd' ? 'active' : ''} onClick={() => setGrowthUnit('usd')}>$</button>
                </div>
                <div className="performance-growth-kpis">
                  <span>
                    Total
                    <strong className={portfolioGrowthChart.last.totalRawVisible >= 0 ? 'tone-positive' : 'tone-negative'}>
                      {portfolioGrowthChart.isPct ? `${portfolioGrowthChart.last.totalVisible.toFixed(2)}%` : fmtPnl(portfolioGrowthChart.last.totalRawVisible)}
                    </strong>
                  </span>
                  <span>
                    Net PnL
                    <strong className={portfolioGrowthChart.last.totalRaw >= 0 ? 'tone-positive' : 'tone-negative'}>
                      {fmtPnl(portfolioGrowthChart.last.totalRaw)}
                    </strong>
                  </span>
                </div>
              </div>
            </div>
            <div className="performance-growth-body">
              <div className="performance-growth-legend-side performance-growth-legend--equity-left" aria-label="Equity growth legend">
                <span className="performance-growth-legend-hint">PnL by asset class</span>
                {GROWTH_LAYERS.map((l) => {
                  const lastPt = portfolioGrowthChart.last
                  const val = lastPt[l.key]
                  const on = growthLayersVisible[l.key]
                  return (
                    <label
                      key={l.key}
                      className={`performance-growth-legend-row${on ? '' : ' performance-growth-legend-row-off'}`}
                    >
                      <input
                        type="checkbox"
                        className="performance-growth-layer-checkbox"
                        checked={on}
                        onChange={() =>
                          setGrowthLayersVisible((v) => ({ ...v, [l.key]: !v[l.key] }))
                        }
                        aria-label={`Plot ${l.label}`}
                      />
                      <span className="performance-growth-legend-swatch" style={{ background: l.color }} />
                      <span className="performance-growth-legend-label" style={{ color: l.color }}>{l.label}</span>
                      <span className="performance-growth-legend-value" style={{ color: l.color }}>
                        {portfolioGrowthChart.isPct
                          ? `${val.toFixed(2)}%`
                          : l.key === 'fixed_income'
                            ? fmtUsd(val)
                            : fmtPnl(val)}
                      </span>
                    </label>
                  )
                })}
                <div className="performance-growth-legend-row performance-growth-legend-row-total">
                  <span className="performance-growth-legend-swatch" style={{ background: 'rgb(255,255,255)' }} />
                  <span className="performance-growth-legend-label">Total</span>
                  <span className="performance-growth-legend-value">
                    {portfolioGrowthChart.isPct ? `${portfolioGrowthChart.last.totalVisible.toFixed(2)}%` : fmtPnl(portfolioGrowthChart.last.totalRawVisible)}
                  </span>
                </div>
              </div>
              <div className="performance-growth-main-charts">
                <div className="performance-growth-chart-wrap" ref={growthChartWrapRef}>
                  <svg
                    className="performance-growth-chart"
                    viewBox={`0 0 ${portfolioGrowthChart.W} ${portfolioGrowthChart.H}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`Portfolio equity growth from ${portfolioGrowthChart.first.dateLabel} to ${portfolioGrowthChart.last.dateLabel}`}
                  >
                    <g className="performance-growth-month-bands" aria-hidden="true">
                      {portfolioGrowthChart.monthBands.map((b, i) => (
                        <rect
                          key={i}
                          className={
                            b.alt
                              ? 'performance-growth-month-band performance-growth-month-band-alt'
                              : 'performance-growth-month-band'
                          }
                          x={b.x1}
                          y={portfolioGrowthChart.PT}
                          width={Math.max(0, b.x2 - b.x1)}
                          height={portfolioGrowthChart.chartH}
                        />
                      ))}
                    </g>
                    {portfolioGrowthChart.gridLines.map((gl, i) => (
                      <Fragment key={i}>
                        <line className="performance-growth-grid" x1={portfolioGrowthChart.PL} x2={portfolioGrowthChart.W - portfolioGrowthChart.PR} y1={gl.y} y2={gl.y} />
                        <text className="performance-growth-ylabel" x={portfolioGrowthChart.PL + 4} y={gl.y - 4} textAnchor="start" dominantBaseline="auto">{gl.label}</text>
                      </Fragment>
                    ))}
                    {portfolioGrowthChart.zeroY != null && (
                      <line className="performance-growth-zero-line" x1={portfolioGrowthChart.PL} x2={portfolioGrowthChart.W - portfolioGrowthChart.PR} y1={portfolioGrowthChart.zeroY} y2={portfolioGrowthChart.zeroY} />
                    )}
                    {portfolioGrowthChart.xTicks.map((t, i) => (
                      <text key={i} className="performance-growth-xlabel" x={t.x} y={portfolioGrowthChart.H - 4} textAnchor="middle">{t.label}</text>
                    ))}
                    {portfolioGrowthChart.layerAreas
                      .filter((l) => growthLayersVisible[l.key])
                      .map((l) => (
                        <path key={`fill-${l.key}`} d={l.area} fill={l.colorFill} />
                      ))}
                    {portfolioGrowthChart.layerAreas
                      .filter((l) => growthLayersVisible[l.key])
                      .map((l) => (
                        <path key={`stroke-${l.key}`} d={l.path} fill="none" stroke={l.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                      ))}
                    {growthLayersVisible.options && portfolioGrowthChart.optionsUnrealPath && (
                      <path
                        className="performance-growth-line-options-unreal"
                        d={portfolioGrowthChart.optionsUnrealPath}
                        fill="none"
                        stroke={GROWTH_LAYERS[0]!.color}
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    <path className="performance-growth-line performance-growth-line-total" d={portfolioGrowthChart.totalPath} />
                    <rect
                      className="performance-growth-chart-hit-surface"
                      x={0}
                      y={0}
                      width={portfolioGrowthChart.W}
                      height={portfolioGrowthChart.H}
                      fill="transparent"
                      onPointerMove={onGrowthChartPointer}
                      onPointerLeave={onGrowthChartPointer}
                      onPointerCancel={onGrowthChartPointer}
                    />
                    {growthHoverIdx != null && portfolioGrowthChart.growthChartHit[growthHoverIdx] && (() => {
                      const h = portfolioGrowthChart.growthChartHit[growthHoverIdx]!
                      const yb = portfolioGrowthChart.H - portfolioGrowthChart.PB
                      return (
                        <g className="performance-growth-hover-marker" pointerEvents="none">
                          <line
                            className="performance-growth-hover-xline"
                            x1={h.cx}
                            x2={h.cx}
                            y1={portfolioGrowthChart.PT}
                            y2={yb}
                          />
                          <circle
                            className="performance-growth-hover-dot"
                            cx={h.cx}
                            cy={h.cyTotal}
                            r={4}
                          />
                        </g>
                      )
                    })()}
                  </svg>
                  {growthHoverIdx != null &&
                    growthTipPos != null &&
                    portfolioGrowthChart.points[growthHoverIdx] &&
                    (() => {
                      const pt = portfolioGrowthChart.points[growthHoverIdx]!
                      const pct = portfolioGrowthChart.isPct
                      const fmtLayer = (key: GrowthLayer, v: number) =>
                        pct
                          ? `${v.toFixed(2)}%`
                          : key === 'fixed_income'
                            ? fmtUsd(v)
                            : fmtPnl(v)
                      const dateLong = (() => {
                        const [yy, mm, dd] = pt.dateStr.split('-').map(Number)
                        return new Date(yy, mm - 1, dd).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      })()
                      return (
                        <div
                          className="performance-growth-chart-tooltip"
                          style={{ left: growthTipPos.left, top: growthTipPos.top }}
                          data-anchor={growthTipPos.anchor}
                          role="tooltip"
                        >
                          <div className="performance-growth-chart-tooltip-date">{dateLong}</div>
                          <div className="performance-growth-chart-tooltip-rows">
                            {GROWTH_LAYERS.filter((l) => growthLayersVisible[l.key]).map((l) => (
                              <div key={l.key} className="performance-growth-chart-tooltip-row">
                                <span className="performance-growth-chart-tooltip-label">{l.label}</span>
                                <span className="performance-growth-chart-tooltip-value">{fmtLayer(l.key, pt[l.key])}</span>
                              </div>
                            ))}
                            {growthLayersVisible.options && (
                              <div className="performance-growth-chart-tooltip-row performance-growth-chart-tooltip-row-unreal">
                                <span className="performance-growth-chart-tooltip-label">U start (R0)</span>
                                <span className="performance-growth-chart-tooltip-value">
                                  {pct ? `${pt.optionsUnrealMonthStart.toFixed(2)}%` : fmtPnl(pt.optionsUnrealMonthStart)}
                                </span>
                              </div>
                            )}
                            {growthLayersVisible.options && (
                              <div className="performance-growth-chart-tooltip-row performance-growth-chart-tooltip-row-unreal">
                                <span className="performance-growth-chart-tooltip-label">U extra (sum in month)</span>
                                <span className="performance-growth-chart-tooltip-value">
                                  {pct ? `${pt.optionsUnrealMonthDelta.toFixed(2)}%` : fmtPnl(pt.optionsUnrealMonthDelta)}
                                </span>
                              </div>
                            )}
                            {growthLayersVisible.options && (
                              <div className="performance-growth-chart-tooltip-row performance-growth-chart-tooltip-row-unreal performance-growth-chart-tooltip-row-unreal-total">
                                <span className="performance-growth-chart-tooltip-label">U total (dashed)</span>
                                <span className="performance-growth-chart-tooltip-value">
                                  {pct ? `${pt.optionsUnrealMonthAnchored.toFixed(2)}%` : fmtPnl(pt.optionsUnrealMonthAnchored)}
                                </span>
                              </div>
                            )}
                            <div className="performance-growth-chart-tooltip-row performance-growth-chart-tooltip-row-total">
                              <span className="performance-growth-chart-tooltip-label">Total</span>
                              <span className="performance-growth-chart-tooltip-value">
                                {pct ? `${pt.totalVisible.toFixed(2)}%` : fmtPnl(pt.totalRawVisible)}
                              </span>
                            </div>
                            <div className="performance-growth-chart-tooltip-row performance-growth-chart-tooltip-row-net">
                              <span className="performance-growth-chart-tooltip-label">Net (all four)</span>
                              <span className="performance-growth-chart-tooltip-value">{fmtPnl(pt.totalRaw)}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })()}
                </div>
                {fiMonthlyNotionalChart && (
                  <div className="performance-growth-fi-bar-panel" aria-label="Fixed income notional by month">
                    <div className="performance-fi-bar-panel-head">
                      <div className="performance-fi-bar-panel-title-row">
                        <span className="performance-fi-bar-panel-kicker">Fixed income</span>
                        <InfoTooltip
                          text={
                            fiMonthlyNotionalChart.useRatio
                              ? 'Uses the same % / $ control as Portfolio Equity Growth (top right). $: bar height and labels are that month’s total signed STK notional in the Fixed income bucket (same N as the gold line). %: bar height and labels use ann. ratio = (month N ÷ current Fixed income position value) × (365 ÷ days in month).'
                              : 'Bar height and caption: monthly total signed STK notional (US$) in the Fixed income bucket. Load/current Fixed income STK positions to enable ann. % mode for this panel.'
                          }
                        />
                      </div>
                    </div>
                    <svg
                      className={`performance-growth-fi-notional-chart performance-growth-fi-notional-chart--${fiMonthlyNotionalChart.fiAnnMode ? 'ann' : 'usd'}`}
                      viewBox={`0 0 ${fiMonthlyNotionalChart.W} ${fiMonthlyNotionalChart.H}`}
                      preserveAspectRatio="xMidYMid meet"
                      role="img"
                      aria-label={
                        fiMonthlyNotionalChart.useRatio
                          ? 'Fixed income monthly notional versus capital base, annualized percentage and dollar notional'
                          : 'Fixed income monthly signed notional in US dollars'
                      }
                    >
                      <text
                        className="performance-fi-notional-yaxis performance-fi-notional-yaxis-top"
                        x={4}
                        y={fiMonthlyNotionalChart.plotTop + 8}
                        textAnchor="start"
                        dominantBaseline="auto"
                      >
                        {fiMonthlyNotionalChart.yTopLabel}
                      </text>
                      <text
                        className="performance-fi-notional-yaxis performance-fi-notional-yaxis-bot"
                        x={4}
                        y={fiMonthlyNotionalChart.plotBottom - 4}
                        textAnchor="start"
                        dominantBaseline="auto"
                      >
                        {fiMonthlyNotionalChart.yBotLabel}
                      </text>
                      <line
                        className="performance-fi-notional-zero"
                        x1={fiMonthlyNotionalChart.plotX0}
                        x2={fiMonthlyNotionalChart.W - fiMonthlyNotionalChart.PR}
                        y1={fiMonthlyNotionalChart.zeroY}
                        y2={fiMonthlyNotionalChart.zeroY}
                      />
                      {fiMonthlyNotionalChart.bars.map((b) => (
                        <g key={b.key}>
                          {b.h > 0 && (
                            <rect
                              className={`performance-fi-notional-bar performance-fi-notional-bar-${b.tone}`}
                              x={b.x}
                              y={b.y}
                              width={b.w}
                              height={b.h}
                              rx={1}
                            >
                              <title>
                                {fiMonthlyNotionalChart.useRatio
                                  ? `${b.label}: ${(100 * b.annualizedRatio).toFixed(2)}%`
                                  : `${b.label}: ${fmtUsd(b.monthlyNotional)}`}
                              </title>
                            </rect>
                          )}
                          <text
                            className={`performance-fi-notional-bar-caption performance-fi-notional-bar-caption-${b.tone}`}
                            x={b.valueX}
                            y={b.labelY}
                            textAnchor="middle"
                            dominantBaseline="auto"
                          >
                            {b.valueLine}
                          </text>
                          {b.showXLabel && (
                            <text className="performance-fi-notional-xlabel" x={b.x + b.w / 2} y={fiMonthlyNotionalChart.H - 6} textAnchor="middle">
                              {b.label}
                            </text>
                          )}
                        </g>
                      ))}
                    </svg>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        {byDayRangeLoading ? (
          <p className={w9.sectionHint}>Loading…</p>
        ) : !byDayRangeData ? (
          <p className={w9.sectionHint}>Select time range above to load daily PnL.</p>
        ) : (() => {
          const optMap = byDayRangeData.opt
          const stocksMap = byDayRangeData.stocks
          const fiMap = byDayRangeData.fixed_income
          const cashMap = byDayRangeData.cash_like
          const nMap = byDayRangeData.stkBucketNotional
          const dateStrs = Object.keys(optMap).sort()
          type ByCol =
            | 'optRealized'
            | 'optUnrealized'
            | 'stocksNotional'
            | 'stocksRealized'
            | 'fiNotional'
            | 'fiRealized'
            | 'cashNotional'
            | 'cashRealized'
          const rows: {
            dateStr: string
            optRealized: number
            optUnrealized: number
            stocksNotional: number
            stocksRealized: number
            fiNotional: number
            fiRealized: number
            cashNotional: number
            cashRealized: number
          }[] = dateStrs.map((dateStr) => {
            const opt = optMap[dateStr] ?? { realized: 0, unrealized: 0 }
            const st = stocksMap[dateStr] ?? { realized: 0, unrealized: 0 }
            const fi = fiMap[dateStr] ?? { realized: 0, unrealized: 0 }
            const cash = cashMap[dateStr] ?? { realized: 0, unrealized: 0 }
            return {
              dateStr,
              optRealized: opt.realized,
              optUnrealized: opt.unrealized,
              stocksNotional: nMap.stocks[dateStr] ?? 0,
              stocksRealized: st.realized,
              fiNotional: nMap.fixed_income[dateStr] ?? 0,
              fiRealized: fi.realized,
              cashNotional: nMap.cash_like[dateStr] ?? 0,
              cashRealized: cash.realized,
            }
          })
          if (dateStrs.length === 0) return <p className={w9.sectionHint}>No Option or Stock PnL in the selected range.</p>
          const ZERO_THRESH = 0.005
          const pnlTd = (val: number, col: ByCol) => {
            if (Math.abs(val) < ZERO_THRESH) return <td>—</td>
            if (col === 'stocksNotional' || col === 'fiNotional') {
              const tone =
                val > 0
                  ? ' performance-by-day-notional-stk-pos'
                  : val < 0
                    ? ' performance-by-day-notional-stk-neg'
                    : ''
              return <td className={`performance-by-day-notional${tone}`}>{fmtUsd(val)}</td>
            }
            if (col === 'cashNotional') {
              return (
                <td className={cn(w9.performanceByDayNotional, 'performance-by-day-notional-cash-like')}>{fmtUsd(val)}</td>
              )
            }
            const isUnrealized = col === 'optUnrealized'
            const cls = isUnrealized ? 'tone-unrealized' : val >= 0 ? 'tone-positive' : 'tone-negative'
            return <td className={cls}>{fmtPnl(val)}</td>
          }
          const pnlTdSum = (val: number, col: ByCol) => pnlTd(val, col)
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
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Opt R</th>
                    <th>Opt U</th>
                    <th>Stocks N</th>
                    <th>Stocks R</th>
                    <th>FI N</th>
                    <th>FI R</th>
                    <th>Cash N</th>
                    <th>Cash R</th>
                  </tr>
                </thead>
                <tbody>
                  {groupEntriesNewestFirst.map(([monthKey, { monthLabel, rows: groupRows }]) => {
                    const sum = groupRows.reduce(
                      (a, r) => ({
                        optRealized: a.optRealized + r.optRealized,
                        optUnrealized: a.optUnrealized + r.optUnrealized,
                        stocksNotional: a.stocksNotional + r.stocksNotional,
                        stocksRealized: a.stocksRealized + r.stocksRealized,
                        fiNotional: a.fiNotional + r.fiNotional,
                        fiRealized: a.fiRealized + r.fiRealized,
                        cashNotional: a.cashNotional + r.cashNotional,
                        cashRealized: a.cashRealized + r.cashRealized,
                      }),
                      {
                        optRealized: 0,
                        optUnrealized: 0,
                        stocksNotional: 0,
                        stocksRealized: 0,
                        fiNotional: 0,
                        fiRealized: 0,
                        cashNotional: 0,
                        cashRealized: 0,
                      },
                    )
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
                          {pnlTdSum(sum.optRealized, 'optRealized')}
                          {pnlTdSum(sum.optUnrealized, 'optUnrealized')}
                          {pnlTdSum(sum.stocksNotional, 'stocksNotional')}
                          {pnlTdSum(sum.stocksRealized, 'stocksRealized')}
                          {pnlTdSum(sum.fiNotional, 'fiNotional')}
                          {pnlTdSum(sum.fiRealized, 'fiRealized')}
                          {pnlTdSum(sum.cashNotional, 'cashNotional')}
                          {pnlTdSum(sum.cashRealized, 'cashRealized')}
                        </tr>
                        {expanded && [...groupRows].reverse().map((r) => (
                          <tr key={r.dateStr} className="by-day-day-row">
                            <td>{r.dateStr}</td>
                            {pnlTd(r.optRealized, 'optRealized')}
                            {pnlTd(r.optUnrealized, 'optUnrealized')}
                            {pnlTd(r.stocksNotional, 'stocksNotional')}
                            {pnlTd(r.stocksRealized, 'stocksRealized')}
                            {pnlTd(r.fiNotional, 'fiNotional')}
                            {pnlTd(r.fiRealized, 'fiRealized')}
                            {pnlTd(r.cashNotional, 'cashNotional')}
                            {pnlTd(r.cashRealized, 'cashRealized')}
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

      <section className={cn(w9.performanceCalendarSection, 'performance-pane')} aria-label="Calendar">
        <h3 className="inline-flex items-center gap-1 text-sm font-semibold">
          Calendar
          <InfoTooltip text="Options: daily Realized and Unrealized (R/U)—FIFO option PnL plus prorated option–stock link slippage. Stocks / Fixed income: daily Realized is Σ realized_pnl; daily Notional is signed net trade size (qty×price) for coloring. Cash-like: Realized same; Notional is Σ |qty|×price. Unrealized is not shown for STK tabs. Category labels use GET /status (approximate on history)." />
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
                const hasAnyCalendarActivity =
                  calendarAssetTab === 'options'
                    ? calendarDayPnL != null
                      ? Object.values(calendarDayPnL).some(
                          (d) => Math.abs(d.realized) >= 0.005 || Math.abs(d.unrealized) >= 0.005,
                        )
                      : cells.some((c) => c.dateStr && optDays[c.dateStr] != null)
                    : calendarDayPnL != null && calendarDayNotional != null
                      ? Object.keys(calendarDayPnL).some((ds) => {
                          const d = calendarDayPnL![ds]!
                          const n = calendarDayNotional![ds] ?? 0
                          return Math.abs(d.realized) >= 0.005 || Math.abs(n) >= 0.005
                        })
                      : false
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
                      <div className={w9.performanceCalendarLeft}>
                    <div className={cn(w9.performanceCalendarAssetTabs, w9.systemTabs)} role="tablist" aria-label="Calendar asset class">
                      {(
                        [
                          ['options', 'Options'],
                          ['stocks', 'Stocks'],
                          ['fixed_income', 'Fixed income'],
                          ['cash_like', 'Cash-like'],
                        ] as const
                      ).map(([tab, label]) => (
                        <button
                          key={tab}
                          type="button"
                          role="tab"
                          aria-selected={calendarAssetTab === tab}
                          className={`system-tab performance-calendar-asset-tab ${calendarAssetTab === tab ? 'active' : ''}`}
                          onClick={() => setCalendarAssetTab(tab)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {calendarAssetTab === 'options' && optUnrealized != null && (
                      <p className={w9.performanceCalendarTotalUnrealized}>
                        Option Unrealized (as of now):{' '}
                        <strong className={(optUnrealized ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtUsd(optUnrealized)}</strong>
                      </p>
                    )}
                    {!hasAnyCalendarActivity && (
                      <p className={cn(w9.sectionHint, 'performance-calendar-no-data')}>
                        {calendarAssetTab === 'options'
                          ? 'No option PnL in this month for the selected filters. Try another month or a larger range.'
                          : `No ${CALENDAR_STK_TAB_LABEL[calendarAssetTab].toLowerCase()} PnL in this month. Try another month or a larger range.`}
                      </p>
                    )}
                    {calendarDayPnLLoading && (
                      <p className={cn(w9.sectionHint, 'performance-calendar-loading')}>Loading daily metrics…</p>
                    )}
                    <div className="performance-calendar-nav">
                      <Button type="button" variant="secondary" onClick={goPrev} aria-label="Previous month">&larr; Prev</Button>
                      <span className={w9.performanceCalendarTitle}>{monthLabel}</span>
                      <Button type="button" variant="secondary" onClick={goNext} aria-label="Next month">Next &rarr;</Button>
                    </div>
                    <div className="performance-calendar-legend" aria-label="PnL legend">
                      <span className="performance-calendar-legend-item performance-calendar-legend-item-realized">R = Realized</span>
                      {calendarAssetTab === 'options' ? (
                        <span className="performance-calendar-legend-item performance-calendar-legend-item-unrealized">U = Unrealized</span>
                      ) : (
                        <span className={cn(w9.performanceCalendarLegendItemNotional, 'performance-calendar-legend-item')}>
                          N = Notional (signed net Stocks/FI; Cash-like |qty|×price)
                        </span>
                      )}
                    </div>
                    <div className={w9.performanceCalendarGrid} role="grid">
                      <div className={cn(w9.performanceCalendarRow, w9.performanceCalendarHeader)}>
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((wd) => (
                          <div key={wd} className={cn(w9.performanceCalendarCell, w9.performanceCalendarDow)}>{wd}</div>
                        ))}
                      </div>
                      {Array.from({ length: totalCells / 7 }, (_, rowIdx) => (
                        <div key={rowIdx} className={w9.performanceCalendarRow}>
                          {cells.slice(rowIdx * 7, rowIdx * 7 + 7).map((c, colIdx) => {
                            /** Missing date key → zeros so STK Realized is never dropped (was null → no R line). */
                            const dayPnL =
                              c.dateStr && calendarDayPnL != null
                                ? (calendarDayPnL[c.dateStr] ?? { realized: 0, unrealized: 0 })
                                : null
                            const dayNotional =
                              c.dateStr && calendarDayNotional != null ? calendarDayNotional[c.dateStr] : null
                            const legacyInfo = c.dateStr ? optDays[c.dateStr] : null
                            const useDetailPnL = c.dateStr === selectedDay && selectedDayComputedPnL != null
                            const realizedVal = useDetailPnL
                              ? selectedDayComputedPnL.realized
                              : dayPnL != null
                                ? dayPnL.realized
                                : calendarAssetTab === 'options'
                                  ? (legacyInfo?.net_pnl ?? null)
                                  : null
                            const unrealizedVal =
                              calendarAssetTab === 'options'
                                ? useDetailPnL
                                  ? selectedDayComputedPnL.unrealized
                                  : dayPnL != null
                                    ? dayPnL.unrealized
                                    : null
                                : null
                            const notionalVal = calendarAssetTab !== 'options' ? dayNotional : null
                            const showPnL = c.day != null
                            const showU =
                              calendarAssetTab === 'options' &&
                              showPnL &&
                              unrealizedVal != null &&
                              Math.abs(Number(unrealizedVal)) >= 0.005
                            const showN =
                              calendarAssetTab !== 'options' &&
                              showPnL &&
                              notionalVal != null &&
                              Math.abs(Number(notionalVal)) >= 0.005
                            /** STK tabs: no Unrealized row; show Realized whenever |R| matters or same day has Notional (activity). */
                            const showR =
                              showPnL &&
                              realizedVal != null &&
                              (calendarAssetTab === 'options'
                                ? Math.abs(Number(realizedVal)) >= 0.005
                                : Math.abs(Number(realizedVal)) >= 0.005 || showN)
                            const toneR = showR && (realizedVal ?? 0) !== 0 ? ((realizedVal!) >= 0 ? 'tone-positive' : 'tone-negative') : ''
                            const toneU = showU && (unrealizedVal ?? 0) !== 0 ? 'tone-unrealized' : ''
                            const titleParts: string[] = []
                            if (calendarAssetTab === 'options') {
                              if (useDetailPnL || dayPnL != null || legacyInfo != null) {
                                titleParts.push(`Realized: ${fmtUsd(realizedVal ?? 0)}`)
                                titleParts.push(unrealizedVal != null ? `Unrealized: ${fmtUsd(unrealizedVal)}` : 'Unrealized: —')
                              } else if (c.dateStr) {
                                titleParts.push('No option PnL that day')
                              }
                            } else if (useDetailPnL || dayPnL != null || (dayNotional != null && c.dateStr)) {
                              titleParts.push(`Realized: ${fmtUsd(realizedVal ?? 0)}`)
                              titleParts.push(notionalVal != null ? `Notional: ${fmtUsd(notionalVal)}` : 'Notional: —')
                            } else if (c.dateStr) {
                              titleParts.push(
                                `No ${CALENDAR_STK_TAB_LABEL[calendarAssetTab].toLowerCase()} activity that day`,
                              )
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
                                {c.day != null && <span className={w9.performanceCalendarDay}>{c.day}</span>}
                                {(showR || showU || showN) && (
                                  <div className={w9.performanceCalendarPnlLines}>
                                    {showR && (
                                      <span className={`performance-calendar-pnl performance-calendar-realized ${toneR}`}>
                                        R:{' '}
                                        {calendarAssetTab === 'options'
                                          ? fmtPnlCalendar(realizedVal)
                                          : fmtUsd(realizedVal)}
                                      </span>
                                    )}
                                    {showU && (
                                      <span className={`performance-calendar-pnl performance-calendar-unrealized ${toneU}`}>
                                        U: {fmtPnlCalendar(unrealizedVal)}
                                      </span>
                                    )}
                                    {showN && (
                                      <span
                                        className={`performance-calendar-pnl performance-calendar-notional${
                                          calendarAssetTab === 'cash_like'
                                            ? ' performance-calendar-notional-cash-like'
                                            : calendarAssetTab === 'stocks' || calendarAssetTab === 'fixed_income'
                                              ? notionalVal! > 0
                                                ? ' performance-calendar-notional-stk-pos'
                                                : notionalVal! < 0
                                                  ? ' performance-calendar-notional-stk-neg'
                                                  : ' performance-calendar-notional-stk-zero'
                                              : ''
                                        }`}
                                      >
                                        N: {fmtUsd(notionalVal)}
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
                    <div className={cn(w9.performanceCalendarSummary, 'performance-calendar-summary-panel')}>
                    <div className="performance-summary-rows performance-summary-inside-calendar">
                      <div className={cn(w9.performanceSummaryRow, 'performance-summary-row-summary')}>
                        <span className={w9.performanceSummaryType}>Summary</span>
                        <div className={w9.performanceSummaryMetrics}>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Total PnL</span>
                            <span className={`performance-summary-metric-value ${(summary.total_pnl ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}`}>{fmtUsd(summary.total_pnl)}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Realized</span>
                            <span className={w9.performanceSummaryMetricValue}>{fmtUsd(summary.total_realized_pnl ?? summary.total_pnl)}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Net</span>
                            <span className={`performance-summary-metric-value ${(summary.net_pnl ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}`}>{fmtUsd(summary.net_pnl)}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Unrealized</span>
                            <span className={w9.performanceSummaryMetricValue}>{fmtUsd(summary.total_unrealized_pnl)}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Comm</span>
                            <span className={w9.performanceSummaryMetricValue}>{fmtUsd(summary.total_commission)}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Trades</span>
                            <span className={w9.performanceSummaryMetricValue}>{summary.trade_count ?? 0}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Win rate</span>
                            <span className={w9.performanceSummaryMetricValue}>{summary.win_rate != null ? `${(summary.win_rate * 100).toFixed(1)}%` : '—'}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Return%</span>
                            <span className={w9.performanceSummaryMetricValue}>{summary.return_pct != null ? `${summary.return_pct.toFixed(2)}%` : '—'}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>PF</span>
                            <span className={w9.performanceSummaryMetricValue}>{summary.profit_factor != null ? (Number.isFinite(summary.profit_factor) ? summary.profit_factor.toFixed(2) : '∞') : '—'}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Max DD</span>
                            <span className={w9.performanceSummaryMetricValue}>{summary.max_drawdown != null ? fmtUsd(-summary.max_drawdown) : '—'}</span>
                          </div>
                          <div className={w9.performanceSummaryMetric}>
                            <span className={w9.performanceSummaryMetricLabel}>Avg W/L</span>
                            <span className={w9.performanceSummaryMetricValue}>{fmtUsd(summary.avg_win)} / {fmtUsd(summary.avg_loss)}</span>
                          </div>
                        </div>
                      </div>
                      {(() => {
                        const realized = data.realized_by_sec_type ?? []
                        const unrealized = data.unrealized_by_sec_type ?? []
                        const hasCalendar = calendarDayPnLByAsset != null && Object.keys(calendarDayPnLByAsset).length > 0
                        const sumBucketMonth = (tab: 'options' | 'stocks' | 'fixed_income' | 'cash_like') => {
                          const rec = calendarDayPnLByAsset?.[tab]
                          if (!rec) return { r: 0, u: 0 }
                          return Object.values(rec).reduce(
                            (a, d) => ({ r: a.r + (d.realized ?? 0), u: a.u + (d.unrealized ?? 0) }),
                            { r: 0, u: 0 },
                          )
                        }
                        const sumNotionalMonth = (tab: 'stocks' | 'fixed_income' | 'cash_like') => {
                          const rec = calendarStkNotionalByBucket?.[tab]
                          if (!rec) return 0
                          return Object.values(rec).reduce((a, n) => a + n, 0)
                        }
                        const optM = sumBucketMonth('options')
                        const stocksM = sumBucketMonth('stocks')
                        const fiM = sumBucketMonth('fixed_income')
                        const cashM = sumBucketMonth('cash_like')
                        const stocksNMonth = sumNotionalMonth('stocks')
                        const fiNMonth = sumNotionalMonth('fixed_income')
                        const cashNMonth = sumNotionalMonth('cash_like')
                        const rOpt = realized.find((x) => x.sec_type === 'OPT')
                        const uOpt = unrealized.find((x) => x.sec_type === 'OPT')
                        const rStk = realized.find((x) => x.sec_type === 'STK')
                        const uStk = unrealized.find((x) => x.sec_type === 'STK')
                        const optRealizedPnl = hasCalendar ? optM.r : (rOpt?.total_pnl ?? 0)
                        const optUnrealizedPnl = hasCalendar ? optM.u : (uOpt?.total_pnl ?? 0)
                        const optNetPnl = hasCalendar ? optM.r - (rOpt?.commission ?? 0) : (rOpt?.net_pnl ?? 0)
                        const hasOpt = hasCalendar || rOpt != null || uOpt != null
                        const hasStkBackend = rStk != null || uStk != null
                        const InlineRow = ({
                          type,
                          realized: rVal,
                          commission,
                          net,
                          trades,
                          unrealized: uVal,
                          toneR,
                          toneN,
                          toneU,
                        }: {
                          type: string
                          realized: string
                          commission: string
                          net: string
                          trades: string
                          unrealized: string
                          toneR: 'positive' | 'negative'
                          toneN: 'positive' | 'negative'
                          toneU: 'positive' | 'negative'
                        }) => (
                          <div className={w9.performanceSummaryRow}>
                            <span className={w9.performanceSummaryType}>{type}</span>
                            <div className={w9.performanceSummaryMetrics}>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Realized</span>
                                <span className={`performance-summary-metric-value ${toneR === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{rVal}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Comm</span>
                                <span className={w9.performanceSummaryMetricValue}>{commission}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Net</span>
                                <span className={`performance-summary-metric-value ${toneN === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{net}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Trades</span>
                                <span className={w9.performanceSummaryMetricValue}>{trades}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Unrealized</span>
                                <span className={`performance-summary-metric-value ${toneU === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{uVal}</span>
                              </div>
                            </div>
                          </div>
                        )
                        const StkBucketInlineRow = ({
                          type: rowType,
                          realized: rStr,
                          notional: nStr,
                          commission,
                          net,
                          trades,
                          toneR,
                          notionalCashLike,
                          notionalSignedTone,
                        }: {
                          type: string
                          realized: string
                          notional: string
                          commission: string
                          net: string
                          trades: string
                          toneR: 'positive' | 'negative'
                          notionalCashLike?: boolean
                          notionalSignedTone?: 'pos' | 'neg' | 'zero'
                        }) => (
                          <div className={w9.performanceSummaryRow}>
                            <span className={w9.performanceSummaryType}>{rowType}</span>
                            <div className={w9.performanceSummaryMetrics}>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Realized</span>
                                <span className={`performance-summary-metric-value ${toneR === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{rStr}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Notional</span>
                                <span
                                  className={`performance-summary-metric-value performance-summary-metric-notional${
                                    notionalCashLike
                                      ? ' performance-summary-metric-notional-cash-like'
                                      : notionalSignedTone === 'pos'
                                        ? ' performance-summary-metric-notional-stk-pos'
                                        : notionalSignedTone === 'neg'
                                          ? ' performance-summary-metric-notional-stk-neg'
                                          : notionalSignedTone === 'zero'
                                            ? ' performance-summary-metric-notional-stk-zero'
                                            : ''
                                  }`}
                                >
                                  {nStr}
                                </span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Comm</span>
                                <span className={w9.performanceSummaryMetricValue}>{commission}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Net</span>
                                <span className={`performance-summary-metric-value ${toneR === 'positive' ? 'tone-positive' : 'tone-negative'}`}>{net}</span>
                              </div>
                              <div className={w9.performanceSummaryMetric}>
                                <span className={w9.performanceSummaryMetricLabel}>Trades</span>
                                <span className={w9.performanceSummaryMetricValue}>{trades}</span>
                              </div>
                            </div>
                          </div>
                        )
                        const stkBucketRow = (
                          label: string,
                          mr: number,
                          mnMonth: number,
                          fallbackR: number,
                          showFallback: boolean,
                        ) => {
                          const useBulk = hasCalendar && calendarStkNotionalByBucket != null
                          const rVal = useBulk ? mr : fallbackR
                          const nVal = useBulk ? mnMonth : 0
                          const hasRow =
                            useBulk
                              ? Math.abs(mr) >= 0.005 || Math.abs(mnMonth) >= 0.005
                              : showFallback && Math.abs(fallbackR) >= 0.005
                          if (!hasRow) {
                            return (
                              <div className={w9.performanceSummaryRow}>
                                <span className={w9.performanceSummaryType}>{label}</span>
                                <span className={cn(w9.sectionHint, w9.performanceSummaryEmpty)}>No data in the selected range.</span>
                              </div>
                            )
                          }
                          const toneR = rVal >= 0 ? 'positive' : 'negative'
                          let notionalSignedTone: 'pos' | 'neg' | 'zero' | undefined
                          if (useBulk && (label === 'Stocks' || label === 'Fixed income')) {
                            notionalSignedTone = nVal > 0 ? 'pos' : nVal < 0 ? 'neg' : 'zero'
                          }
                          return (
                            <StkBucketInlineRow
                              type={label}
                              realized={fmtUsd(rVal)}
                              notional={useBulk ? fmtUsd(nVal) : '—'}
                              commission={useBulk ? '—' : fmtUsd(rStk?.commission ?? 0)}
                              net={fmtUsd(useBulk ? rVal : (rStk?.net_pnl ?? 0))}
                              trades={useBulk ? '—' : String(rStk?.trade_count ?? 0)}
                              toneR={toneR}
                              notionalCashLike={label === 'Cash-like'}
                              notionalSignedTone={notionalSignedTone}
                            />
                          )
                        }
                        return (
                          <>
                            {hasOpt ? (
                              <InlineRow
                                type="Option"
                                realized={fmtUsd(optRealizedPnl)}
                                commission={fmtUsd(rOpt?.commission ?? 0)}
                                net={fmtUsd(optNetPnl)}
                                trades={String(rOpt?.trade_count ?? 0)}
                                unrealized={fmtUsd(optUnrealizedPnl)}
                                toneR={(optRealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'}
                                toneN={(optNetPnl ?? 0) >= 0 ? 'positive' : 'negative'}
                                toneU={(optUnrealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'}
                              />
                            ) : (
                              <div className={w9.performanceSummaryRow}>
                                <span className={w9.performanceSummaryType}>Option</span>
                                <span className={cn(w9.sectionHint, w9.performanceSummaryEmpty)}>No data in the selected range.</span>
                              </div>
                            )}
                            {stkBucketRow('Stocks', stocksM.r, stocksNMonth, rStk?.total_pnl ?? 0, hasStkBackend)}
                            {stkBucketRow('Fixed income', fiM.r, fiNMonth, 0, false)}
                            {stkBucketRow('Cash-like', cashM.r, cashNMonth, 0, false)}
                          </>
                        )
                      })()}
                    </div>
                    </div>
                    </div>
                    {selectedDay != null && (
                      <div className={w9.performanceCalendarDayDetail} aria-live="polite">
                        <h4 className={w9.performanceCalendarDayDetailTitle}>
                          Records for {selectedDay}
                          <Button type="button" variant="secondary" size="sm" className={w9.performanceCalendarDayDetailClose} onClick={() => setSelectedDay(null)} aria-label="Close">×</Button>
                        </h4>
                        {selectedDayExecutionsLoading ? (
                          <p className={w9.sectionHint}>Loading executions…</p>
                        ) : (
                          <>
                            {calendarAssetTab !== 'options' &&
                              (() => {
                                const allExecs = selectedDayExecutions ?? []
                                const dayExecs = allExecs.filter((e) => executionDateStr(e) === selectedDay)
                                const bucketExecs = dayExecs.filter(
                                  (e) =>
                                    getStkLedgerBucketForExecution(e, positionCategoryByAccountContract) ===
                                    calendarAssetTab,
                                )
                                const lbl = CALENDAR_STK_TAB_LABEL[calendarAssetTab]
                                if (bucketExecs.length === 0) {
                                  return (
                                    <p className={w9.sectionHint}>
                                      No {lbl} executions on this trade date in the loaded window.
                                    </p>
                                  )
                                }
                                return (
                                  <div className={w9.performanceCalendarStkDayDetail}>
                                    <h5 className={w9.performanceCalendarDayDetailSubtitle}>STK executions ({lbl})</h5>
                                    <p className={w9.sectionHint}>
                                      Calendar daily realized is the sum of broker <code className="performance-inline-code">realized_pnl</code> on fills for this trade date in this bucket (same as column totals below). Stocks / Fixed income Notional is signed trade size (qty×price, net buy vs sell); Cash-like uses |qty|×price. Category is from GET /status (same as Trade Ledger).
                                    </p>
                                    <div className="table-wrap performance-calendar-stk-day-table-wrap">
                                      <table className="data-table performance-calendar-stk-day-table">
                                        <thead>
                                          <tr>
                                            <th>Account</th>
                                            <th>Symbol</th>
                                            <th>Side</th>
                                            <th>Qty</th>
                                            <th>Price</th>
                                            <th>Notional</th>
                                            <th>Realized PnL</th>
                                            <th>Commission</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {bucketExecs.map((ex) => {
                                            const signedNv = stkSignedTradeNotionalUsd(ex)
                                            const notionalCellClass =
                                              calendarAssetTab === 'cash_like'
                                                ? ' performance-calendar-stk-notional-cell-cash-like'
                                                : calendarAssetTab === 'stocks' || calendarAssetTab === 'fixed_income'
                                                  ? signedNv > 0
                                                    ? ' performance-stk-notional-pos'
                                                    : signedNv < 0
                                                      ? ' performance-stk-notional-neg'
                                                      : ' performance-stk-notional-zero'
                                                  : ''
                                            const notionalDisplay =
                                              calendarAssetTab === 'cash_like' ? stkFillNotional(ex) : signedNv
                                            return (
                                            <tr key={ex.account_executions_id ?? `${ex.time}-${ex.symbol}`}>
                                              <td>{ex.account_id ?? '—'}</td>
                                              <td>{ex.symbol ?? '—'}</td>
                                              <td>{ex.side ?? '—'}</td>
                                              <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                                              <td>{fmtUsd(ex.price)}</td>
                                              <td
                                                className={`performance-calendar-stk-notional-cell${notionalCellClass}`}
                                              >
                                                {fmtUsd(notionalDisplay)}
                                              </td>
                                              <td>{fmtUsd(Number(ex.realized_pnl) || 0)}</td>
                                              <td>{fmtUsd(ex.commission ?? 0)}</td>
                                            </tr>
                                            )
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )
                              })()}
                            {calendarAssetTab === 'options' &&
                              (() => {
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
                                  <h5 className={w9.performanceCalendarDayDetailSubtitle}>
                                    {selectedDayPnLType === 'realized'
                                      ? 'Matched legs and pairs by contract (FIFO)'
                                      : 'Executions by contract (unmatched quantity)'}
                                  </h5>
                                  {selectedDayPnLType === 'realized' && (
                                    <p className={cn(w9.sectionHint, 'performance-calendar-records-realized-hint')}>
                                      Realized lists execution legs that participate in a FIFO match (scaled to matched qty when partial), then match rows. Match row PnL is option (FIFO) only. Execution rows show per-leg premium plus prorated linked stock (Trade Ledger detail). Realized tab and symbol totals = sum of Match option PnL (FIFO) for the contract plus prorated linked-stock slippage on matched fills. Open quantity appears under Unrealized.
                                    </p>
                                  )}
                                  {contractKeys.length === 0 ? (
                                    <p className={w9.sectionHint}>No Option executions in DB for this trade date.</p>
                                  ) : (
                                    <>
                                      <div className={cn(w9.performanceCalendarPnlTypeTabs, w9.systemTabs)} role="tablist" aria-label="PnL type">
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
                                              <span className={w9.performanceCalendarTabCount}>({symbolsRealized.reduce((n, s) => n + (keysBySymbolRealized.get(s) ?? []).length, 0)})</span>
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
                                              <span className={w9.performanceCalendarTabCount}>({symbolsUnrealized.reduce((n, s) => n + (keysBySymbolUnrealized.get(s) ?? []).length, 0)})</span>
                                              <span className={cn(w9.performanceCalendarTabSum, 'tone-unrealized')}>
                                                {fmtUsd(totalUnrealizedSum)}
                                              </span>
                                              <span className="performance-records-commission-sum"> {fmtUsd(totalCommissionUnrealized)}</span>
                                            </>
                                          )}
                                        </button>
                                      </div>
                                      <div className={cn(w9.performanceCalendarSymbolTabs, w9.systemTabs)} role="tablist" aria-label="Symbol">
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
                                      <div className={cn(w9.systemTabPanel, w9.performanceCalendarSymbolPanel)} role="tabpanel">
                                        {symbolsForType.length === 0 ? (
                                          <p className={w9.sectionHint}>
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
                                        <div key={key} className={w9.performanceCalendarContractGroup}>
                                          <h6 className={w9.performanceCalendarContractTitle}>
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
                                                      <span className={w9.performanceCalendarExecIdWrap}>
                                                        {ex.account_executions_id ?? '—'}
                                                        {isRealizedTab && linkIds.length > 0 ? (
                                                          <span className={w9.ledgerOptLinkStockBadges}>
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
          <p className={w9.sectionHint}>Select time range above and load data to see calendar.</p>
        )}
      </section>

      <section className="performance-on-the-fly-section performance-pane" aria-label="On the fly executions">
        <div className="performance-on-the-fly-header">
          <h3 className="text-base font-semibold performance-on-the-fly-title">On the fly</h3>
          <Button
            type="button"
            variant="secondary"
            className="performance-on-the-fly-toggle"
            aria-expanded={onTheFlyOpen}
            onClick={() => setOnTheFlyOpen((o) => !o)}
          >
            {onTheFlyOpen ? 'Hide' : 'Show'}
          </Button>
        </div>
        <p className={cn(w9.sectionHint, 'performance-on-the-fly-hint')}>
          TWS-side executions that are not already covered by the official book (same account and contract as a row in
          the Flex/Journal ledger). Option combo legs (<code className="performance-inline-code">BAG</code>) are
          omitted. Same time range and strategy filters as above.
        </p>
        {onTheFlyOpen && (
          <>
            {onTheFlyLoading && <p className={w9.sectionHint}>Loading…</p>}
            {onTheFlyError && <p className={cn(w9.sectionHint, 'tone-negative')}>{onTheFlyError}</p>}
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
              <p className={w9.sectionHint}>No on-the-fly executions in this range.</p>
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
      </PageSection>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive" role="alert">
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
