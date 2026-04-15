import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BarCoverageItem, BarsCoverageResponse, StatusResponse } from '../../types'
import {
  fetchBarsCoverage,
  fetchBarsJobs,
  postBarsBackfill,
  postWatchlistEodRefresh,
  fetchWatchlistEodRefreshPreview,
  postIndicesRefresh,
  deleteBarsForSymbol,
} from '../../api'
import type { WatchlistEodRefreshPreviewResponse } from '../../api'
import { fetchMarketTradingDay } from '../../api'
import { ALL_BAR_PERIOD_VALUES } from './constants'
import { splitCoverageByReferenceIndices } from './coverageSymbolGroups'

export function useBarsCoverage(status: StatusResponse | null) {
  const [coverage, setCoverage] = useState<BarCoverageItem[] | null>(null)
  const [coveragePolicy, setCoveragePolicy] = useState<BarsCoverageResponse['policy'] | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [deletingSymbol, setDeletingSymbol] = useState<string | null>(null)
  const [deleteSymbolError, setDeleteSymbolError] = useState<string | null>(null)
  const [resetConfirmSymbol, setResetConfirmSymbol] = useState<string | null>(null)
  const [resetConfirmIsIndex, setResetConfirmIsIndex] = useState(false)
  const [resetPeriods, setResetPeriods] = useState<string[]>(() => [...ALL_BAR_PERIOD_VALUES])
  const [backfillIsTest, setBackfillIsTest] = useState(false)
  const [backfillApiIntervalSec, setBackfillApiIntervalSec] = useState(10)
  const [backfillSymbol, setBackfillSymbol] = useState<string | null>(null)
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null)
  const [needWatchlistDryRun, setNeedWatchlistDryRun] = useState(false)
  const [watchlistPreviewLoading, setWatchlistPreviewLoading] = useState(false)
  const [watchlistRefreshRunning, setWatchlistRefreshRunning] = useState(false)
  const [watchlistRefreshMessage, setWatchlistRefreshMessage] = useState<string | null>(null)
  const [indicesRefreshLoading, setIndicesRefreshLoading] = useState(false)
  const [indicesRefreshMessage, setIndicesRefreshMessage] = useState<string | null>(null)
  const [pullModalSymbol, setPullModalSymbol] = useState<string | null>(null)
  const [pullModalIsIndex, setPullModalIsIndex] = useState(false)
  const [pullSelectedPeriods, setPullSelectedPeriods] = useState<string[]>(() => [...ALL_BAR_PERIOD_VALUES])
  const [pullRangeMode, setPullRangeMode] = useState<'max' | 'min' | 'custom' | null>('max')
  const [watchlistRefreshPreview, setWatchlistRefreshPreview] = useState<WatchlistEodRefreshPreviewResponse | null>(null)
  const [pullCustomDailyDays, setPullCustomDailyDays] = useState(30)
  const [pullCustom1minHours, setPullCustom1minHours] = useState(24)
  const [pullCustom5minDays, setPullCustom5minDays] = useState(7)
  const [pullCustom1hourDays, setPullCustom1hourDays] = useState(7)
  const [isTradingDay, setIsTradingDay] = useState<boolean | null>(null)

  useEffect(() => {
    fetchMarketTradingDay()
      .then((r) => setIsTradingDay(r.is_trading_day))
      .catch(() => setIsTradingDay(true))
  }, [])

  const coverageGroups = useMemo((): { label: string; rows: BarCoverageItem[] }[] => {
    return splitCoverageByReferenceIndices(coverage ?? [], status?.live_ui?.reference_indices)
  }, [coverage, status?.live_ui?.reference_indices])

  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true)
    setCoverageError(null)
    setDeleteSymbolError(null)
    try {
      const res = await fetchBarsCoverage()
      setCoverage(res.coverage || [])
      setCoveragePolicy(res.policy ?? null)
    } catch (e) {
      setCoverageError(e instanceof Error ? e.message : 'Load failed')
      setCoverage([])
    } finally {
      setCoverageLoading(false)
    }
  }, [])

  const loadBarsJobs = useCallback(async () => {
    try {
      await fetchBarsJobs(5, 0, 'done')
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadCoverage() }, [loadCoverage])

  const openWatchlistEodRefreshPreview = useCallback(async () => {
    setWatchlistPreviewLoading(true)
    setWatchlistRefreshMessage(null)
    try {
      const res = await fetchWatchlistEodRefreshPreview({ override_days: 1, api_interval_sec: backfillApiIntervalSec })
      if (!res.ok) { setWatchlistRefreshMessage(res.error || 'Dry run failed'); return }
      setWatchlistRefreshPreview(res)
    } catch (e) {
      setWatchlistRefreshMessage(e instanceof Error ? e.message : 'Dry run failed')
    } finally {
      setWatchlistPreviewLoading(false)
    }
  }, [backfillApiIntervalSec])

  const confirmWatchlistEodRefresh = useCallback(async () => {
    setWatchlistRefreshRunning(true)
    setWatchlistRefreshMessage(null)
    try {
      const res = await postWatchlistEodRefresh({ override_days: 1, is_test: backfillIsTest, api_interval_sec: backfillApiIntervalSec })
      if (!res.ok) { setWatchlistRefreshMessage(res.error || 'EOD refresh failed'); return }
      setWatchlistRefreshMessage(res.message || `Queued ${res.queued_count ?? 0} EOD refresh job(s) for ${res.symbols_count ?? 0} symbol(s).`)
      setWatchlistRefreshPreview(null)
      if ((res.queued_count ?? 0) > 0) { await loadBarsJobs(); await loadCoverage() }
    } catch (e) {
      setWatchlistRefreshMessage(e instanceof Error ? e.message : 'EOD refresh failed')
    } finally {
      setWatchlistRefreshRunning(false)
    }
  }, [backfillApiIntervalSec, backfillIsTest, loadBarsJobs, loadCoverage])

  const handleRefreshIndices = useCallback(async () => {
    setIndicesRefreshLoading(true)
    setIndicesRefreshMessage(null)
    try {
      const res = await postIndicesRefresh()
      if (res.ok) {
        setIndicesRefreshMessage(res.updated.length > 0 ? `Refreshed ${res.updated.length} index(s): ${res.updated.join(', ')}.` : 'No reference indices in config.')
        await loadCoverage()
      } else {
        setIndicesRefreshMessage(res.errors?.length ? res.errors.join('; ') : 'Refresh failed.')
      }
    } catch (e) {
      setIndicesRefreshMessage(e instanceof Error ? e.message : 'Refresh failed.')
    } finally {
      setIndicesRefreshLoading(false)
    }
  }, [loadCoverage])

  const handleWatchlistEodRefreshClick = useCallback(async () => {
    if (needWatchlistDryRun) { await openWatchlistEodRefreshPreview(); return }
    await confirmWatchlistEodRefresh()
  }, [confirmWatchlistEodRefresh, needWatchlistDryRun, openWatchlistEodRefreshPreview])

  const handleOpenReset = useCallback((symbol: string, isIndex: boolean) => {
    setResetConfirmSymbol(symbol)
    setResetConfirmIsIndex(isIndex)
    setResetPeriods(isIndex ? ['1 D'] : [...ALL_BAR_PERIOD_VALUES])
  }, [])

  const handleOpenPull = useCallback((symbol: string, isIndex: boolean) => {
    setPullModalSymbol(symbol)
    setPullModalIsIndex(isIndex)
    setPullSelectedPeriods(isIndex ? ['1 D'] : [...ALL_BAR_PERIOD_VALUES])
    setPullRangeMode('max')
    setPullCustomDailyDays(30)
    setPullCustom1minHours(24)
    setPullCustom5minDays(7)
    setPullCustom1hourDays(7)
  }, [])

  const openBarsForSymbol = useCallback(async (_symbol: string, _period: string) => {
    // no-op in coverage standalone — bars inspect lives in Interactive Brokers (Feed) page
  }, [])

  const handleConfirmReset = useCallback(async () => {
    const sym = resetConfirmSymbol
    const periods = resetConfirmIsIndex ? ['1 D'] : [...resetPeriods]
    setResetConfirmSymbol(null)
    setResetConfirmIsIndex(false)
    if (!sym || periods.length === 0) return
    setDeleteSymbolError(null)
    setDeletingSymbol(sym)
    try {
      const res = await deleteBarsForSymbol(sym, periods)
      if (res.ok) await loadCoverage()
      else setDeleteSymbolError(res.error || 'Delete failed')
    } catch (e) {
      setDeleteSymbolError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeletingSymbol(null)
    }
  }, [resetConfirmSymbol, resetConfirmIsIndex, resetPeriods, loadCoverage])

  const handleConfirmPull = useCallback(async () => {
    if (!pullModalSymbol || pullRangeMode === null) return
    if (pullModalIsIndex) {
      const sym = pullModalSymbol
      const days = pullRangeMode === 'max' ? 365 : pullRangeMode === 'min' ? 30 : pullCustomDailyDays
      setPullModalSymbol(null)
      setPullModalIsIndex(false)
      setBackfillSymbol(sym)
      setBackfillMessage(null)
      try {
        const res = await postIndicesRefresh({ symbol: sym, days })
        if (res.ok && res.updated.length > 0) {
          setBackfillMessage(`Pulled ${res.updated.length} index: ${res.updated.join(', ')}.`)
          loadCoverage()
        } else {
          setBackfillMessage(res.errors?.length ? res.errors.join('; ') : 'Pull failed')
        }
      } catch (e) {
        setBackfillMessage(e instanceof Error ? e.message : 'Request failed')
      } finally {
        setTimeout(() => { setBackfillSymbol(null); setBackfillMessage(null) }, 4000)
      }
      return
    }
    if (pullSelectedPeriods.length === 0) return
    const sym = pullModalSymbol
    const periods = [...pullSelectedPeriods]
    const getOptions = (period: string) => {
      const base = { queue: true as const, is_test: backfillIsTest, api_interval_sec: backfillApiIntervalSec }
      if (pullRangeMode === 'max') return base
      if (pullRangeMode === 'min') {
        if (period === '1 D') return { ...base, days: 30 }
        if (period === '1 min') return { ...base, span_hours: 1 }
        if (period === '5 mins') return { ...base, days: 1 }
        if (period === '1 hour') return { ...base, days: 7 }
        return base
      }
      if (pullRangeMode === 'custom') {
        if (period === '1 D') return { ...base, days: pullCustomDailyDays }
        if (period === '1 min') return { ...base, span_hours: pullCustom1minHours }
        if (period === '5 mins') return { ...base, days: pullCustom5minDays }
        if (period === '1 hour') return { ...base, days: pullCustom1hourDays }
        return base
      }
      return base
    }
    setPullModalSymbol(null)
    setPullModalIsIndex(false)
    setBackfillSymbol(sym)
    setBackfillMessage(null)
    try {
      const results = await Promise.all(periods.map(period => postBarsBackfill(sym, period, getOptions(period))))
      const ok = results.filter(r => r.ok).length
      const err = results.find(r => !r.ok && r.error)
      let msg: string
      if (ok > 0 && err) msg = `Queued ${ok} job(s). Some failed: ${err.error}`
      else if (ok > 0) msg = `Queued ${ok} job(s).`
      else if (err) msg = err.error || 'Pull failed'
      else msg = 'No jobs queued'
      setBackfillMessage(msg)
      if (ok > 0) loadCoverage()
    } catch (e) {
      setBackfillMessage(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setTimeout(() => { setBackfillSymbol(null); setBackfillMessage(null) }, 4000)
    }
  }, [pullModalSymbol, pullModalIsIndex, pullRangeMode, pullSelectedPeriods, pullCustomDailyDays, pullCustom1minHours, pullCustom5minDays, pullCustom1hourDays, backfillIsTest, backfillApiIntervalSec, loadCoverage])

  return {
    coverage, coveragePolicy, coverageLoading, coverageError,
    deleteSymbolError, deletingSymbol,
    backfillSymbol, backfillMessage,
    isTradingDay, coverageGroups,
    indicesRefreshLoading, indicesRefreshMessage,
    watchlistRefreshMessage, watchlistPreviewLoading, watchlistRefreshRunning,
    backfillIsTest, needWatchlistDryRun, backfillApiIntervalSec,
    loadCoverage, handleRefreshIndices, handleWatchlistEodRefreshClick,
    handleOpenReset, handleOpenPull, openBarsForSymbol,
    setBackfillIsTest, setNeedWatchlistDryRun, setBackfillApiIntervalSec,
    // Reset modal state
    resetConfirmSymbol, resetConfirmIsIndex, resetPeriods, setResetPeriods,
    setResetConfirmSymbol, setResetConfirmIsIndex, handleConfirmReset,
    // Pull modal state
    pullModalSymbol, pullModalIsIndex, pullSelectedPeriods, setPullSelectedPeriods,
    pullRangeMode, setPullRangeMode, setPullModalSymbol, setPullModalIsIndex,
    pullCustomDailyDays, setPullCustomDailyDays,
    pullCustom1minHours, setPullCustom1minHours,
    pullCustom5minDays, setPullCustom5minDays,
    pullCustom1hourDays, setPullCustom1hourDays,
    handleConfirmPull,
    // Watchlist preview
    watchlistRefreshPreview, setWatchlistRefreshPreview,
    confirmWatchlistEodRefresh,
  }
}
