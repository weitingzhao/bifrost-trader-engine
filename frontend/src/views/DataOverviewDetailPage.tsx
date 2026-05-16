import { useCallback, useEffect, useState } from 'react'
import type { OptionsFocusDataset } from './dataOverview/optionFocusDataset'
import type { StocksFocusDataset } from './dataOverview/stockFocusDataset'
import {
  optionsFocusDatasetToUnified,
  stocksFocusDatasetToUnified,
  type WatchlistUnifiedDataset,
  unifiedFocusToOptions,
  unifiedFocusToStocks,
  watchlistUnifiedShowsOptionsMatrix,
  watchlistUnifiedShowsStocksMatrix,
} from './dataOverview/watchlistUnifiedFocus'
import type { StatusResponse } from '../types'
import {
  postOptionContractsReferenceGapBatch,
  fetchOptionSnapshotsContractsGap,
  fetchWatchlistDbCoverage,
} from '../api'
import type {
  OptionContractsReferenceGapResult,
  OptionSnapshotsContractsGapResult,
  WatchlistDbCoverageSymbolRow,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { DataOverviewWatchlistOptions } from './dataOverview/DataOverviewWatchlistOptions'
import { DataOverviewStocksUtilitiesSection, DataOverviewWatchlistStocks } from './dataOverview/DataOverviewWatchlistStocks'
import { WatchlistCoverageFocusChips } from './dataOverview/WatchlistCoverageFocusChips'
import {
  COVERAGE_OPTION_SUBSECTION,
  COVERAGE_OVERVIEW_SUMMARY_ID,
  FEED_MASSIVE_STOCK_ID,
} from './settings/settingsConstants'

interface DataOverviewDetailPageProps {
  status: StatusResponse | null
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

const REF_GAP_CHUNK_DELAY_MS = 75

export function DataOverviewDetailPage(_props: DataOverviewDetailPageProps) {
  const [wlRows, setWlRows] = useState<WatchlistDbCoverageSymbolRow[]>([])
  const [unifiedFocus, setUnifiedFocus] = useState<WatchlistUnifiedDataset>(null)
  const [wlGeneratedAt, setWlGeneratedAt] = useState<string | null>(null)
  const [wlMessage, setWlMessage] = useState<string | null>(null)
  const [wlError, setWlError] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)

  const [refGapBySymbol, setRefGapBySymbol] = useState<Record<string, OptionContractsReferenceGapResult>>({})
  const [refGapLoading, setRefGapLoading] = useState(false)
  const [refGapError, setRefGapError] = useState<string | null>(null)

  const [snapshotGapBySymbol, setSnapshotGapBySymbol] = useState<
    Record<string, OptionSnapshotsContractsGapResult>
  >({})
  const [snapshotGapLoading, setSnapshotGapLoading] = useState(false)
  const [snapshotGapError, setSnapshotGapError] = useState<string | null>(null)

  const [comparePool, setComparePool] = useState<string[]>([])
  const [optionJobsSheetOpen, setOptionJobsSheetOpen] = useState(false)

  const applyWatchlistResult = useCallback((wl: Awaited<ReturnType<typeof fetchWatchlistDbCoverage>>) => {
    if (wl?.ok) {
      setWlRows(wl.symbols ?? [])
      setWlGeneratedAt(wl.generated_at ?? null)
      setWlMessage(typeof wl.message === 'string' ? wl.message : null)
      setWlError(null)
    } else {
      setWlRows([])
      setWlGeneratedAt(null)
      setWlMessage(null)
      setWlError(
        wl && !wl.ok
          ? wl.error ?? 'Watchlist coverage failed'
          : 'Watchlist coverage failed',
      )
    }
  }, [])

  const loadWatchlist = useCallback(async () => {
    setWlError(null)
    setWlMessage(null)
    try {
      const wl = await fetchWatchlistDbCoverage()
      applyWatchlistResult(wl)
    } catch (e) {
      setWlRows([])
      setWlGeneratedAt(null)
      setWlMessage(null)
      setWlError(e instanceof Error ? e.message : 'Watchlist coverage failed')
    }
  }, [applyWatchlistResult])

  const loadAll = useCallback(async () => {
    setLoading(true)
    await loadWatchlist()
    setLoading(false)
  }, [loadWatchlist])

  const refreshPipelineAfterJobs = useCallback(async () => {
    await loadWatchlist()
  }, [loadWatchlist])

  const handleCompareMassiveReference = useCallback(
    async (
      symbols: string[],
      progress?: {
        onSymbolStart?: (symbol: string) => void
        onSymbolDone?: (symbol: string, result: OptionContractsReferenceGapResult) => void
        onSymbolError?: (symbol: string, message: string) => void
      },
      options?: { maxExpiries?: number },
    ) => {
      setRefGapLoading(true)
      setRefGapError(null)
      const maxExpiries = options?.maxExpiries ?? 60
      try {
        const raw = symbols.map(s => s.trim().toUpperCase()).filter(Boolean)
        const seen = new Set<string>()
        const unique = raw.filter(s => (seen.has(s) ? false : (seen.add(s), true)))
        const eligible = unique.filter(u => {
          const row = wlRows.find(r => r.symbol.trim().toUpperCase() === u)
          return row?.option_contracts.has_data
        })
        if (eligible.length === 0) {
          setRefGapError(
            unique.length === 0
              ? 'Add symbols to the compare pool (click Symbol in the matrix).'
              : 'No pool symbols have option_contracts rows yet.',
          )
          return
        }
        for (let i = 0; i < eligible.length; i++) {
          const sym = eligible[i]!
          progress?.onSymbolStart?.(sym)
          try {
            const batchRes = await postOptionContractsReferenceGapBatch([sym], { max_expiries: maxExpiries })
            if (!batchRes.ok || !batchRes.results) {
              const msg = typeof batchRes.error === 'string' ? batchRes.error : 'Compare failed'
              progress?.onSymbolError?.(sym, msg)
            } else {
              const res = batchRes.results[sym]
              if (!res) {
                progress?.onSymbolError?.(sym, 'No result')
              } else if (!res.ok) {
                const msg = typeof res.error === 'string' ? res.error : 'Compare failed'
                progress?.onSymbolError?.(sym, msg)
              } else {
                setRefGapBySymbol(prev => ({ ...prev, [sym]: res }))
                progress?.onSymbolDone?.(sym, res)
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Compare failed'
            progress?.onSymbolError?.(sym, msg)
          }
          if (i < eligible.length - 1) {
            await delayMs(REF_GAP_CHUNK_DELAY_MS)
          }
        }
      } catch (e) {
        setRefGapError(e instanceof Error ? e.message : 'Compare failed')
      } finally {
        setRefGapLoading(false)
      }
    },
    [wlRows],
  )

  const handleCompareSnapshotGap = useCallback(
    async (
      symbols: string[],
      progress?: {
        onSymbolStart?: (symbol: string) => void
        onSymbolDone?: (symbol: string, result: OptionSnapshotsContractsGapResult) => void
        onSymbolError?: (symbol: string, message: string) => void
      },
    ) => {
      setSnapshotGapLoading(true)
      setSnapshotGapError(null)
      try {
        const raw = symbols.map(s => s.trim().toUpperCase()).filter(Boolean)
        const seen = new Set<string>()
        const unique = raw.filter(s => (seen.has(s) ? false : (seen.add(s), true)))
        const eligible = unique.filter(u => {
          const row = wlRows.find(r => r.symbol.trim().toUpperCase() === u)
          return row?.option_contracts.has_data
        })
        if (eligible.length === 0) {
          setSnapshotGapError(
            unique.length === 0
              ? 'Add symbols to the compare pool (click Symbol in the matrix).'
              : 'No pool symbols have option_contracts rows yet.',
          )
          return
        }
        for (const sym of eligible) {
          progress?.onSymbolStart?.(sym)
          try {
            const res = await fetchOptionSnapshotsContractsGap(sym)
            if (!res.ok) {
              const msg = typeof res.error === 'string' ? res.error : 'Check failed'
              progress?.onSymbolError?.(sym, msg)
              continue
            }
            setSnapshotGapBySymbol(prev => ({ ...prev, [sym]: res }))
            progress?.onSymbolDone?.(sym, res)
          } catch (err) {
            progress?.onSymbolError?.(
              sym,
              err instanceof Error ? err.message : 'Check failed',
            )
          }
        }
      } catch (e) {
        setSnapshotGapError(e instanceof Error ? e.message : 'Check failed')
      } finally {
        setSnapshotGapLoading(false)
      }
    },
    [wlRows],
  )

  const toggleComparePool = useCallback((symbol: string) => {
    const u = symbol.trim().toUpperCase()
    if (!u) return
    setComparePool(prev => (prev.includes(u) ? prev.filter(s => s !== u) : [...prev, u]))
  }, [])

  const selectAllComparePool = useCallback(() => {
    const all = wlRows.map(r => r.symbol.trim().toUpperCase()).filter(Boolean)
    const seen = new Set<string>()
    setComparePool(all.filter(s => (seen.has(s) ? false : (seen.add(s), true))))
  }, [wlRows])

  const clearComparePool = useCallback(() => {
    setComparePool([])
  }, [])

  const handleOptionsFocusChange = useCallback((v: OptionsFocusDataset) => {
    const u = optionsFocusDatasetToUnified(v)
    if (u !== null) setUnifiedFocus(u)
  }, [])

  const handleStocksFocusChange = useCallback((v: StocksFocusDataset) => {
    const u = stocksFocusDatasetToUnified(v)
    if (u !== null) setUnifiedFocus(u)
  }, [])

  const showOptionsMatrix = watchlistUnifiedShowsOptionsMatrix(unifiedFocus)
  const showStocksMatrix = watchlistUnifiedShowsStocksMatrix(unifiedFocus)

  useEffect(() => {
    if (!watchlistUnifiedShowsOptionsMatrix(unifiedFocus)) {
      setOptionJobsSheetOpen(false)
    }
  }, [unifiedFocus])

  /** Load watchlist coverage only after the user picks a table chip; reuse rows when switching tables. */
  useEffect(() => {
    if (unifiedFocus == null) return
    if (wlRows.length > 0) return
    void loadAll()
  }, [unifiedFocus, wlRows.length, loadAll])

  return (
    <div className="card process-section market-data-page market-data-page--settings-embed">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        <button
          type="button"
          className="page-title-breadcrumb-link"
          onClick={() => { window.location.hash = '#settings-heartbeat' }}
          aria-label="Go to Settings"
        >
          Settings
        </button>
        {' / '}
        <button
          type="button"
          className="page-title-breadcrumb-link"
          onClick={() => { window.location.hash = `#${COVERAGE_OVERVIEW_SUMMARY_ID}` }}
          aria-label="Go to Data Overview Summary"
        >
          Data Overview
        </button>
        {' / '}
        Detail
        {wlGeneratedAt ? (
          <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', fontSize: 'var(--text-body)' }}>
            {' · '}
            Generated at {wlGeneratedAt}
          </span>
        ) : null}
        <InfoTooltip text="Per-symbol watchlist matrix, table focus chips, Compare / Check tools, and option coverage jobs. Aggregates and global coverage are on Data Overview → Summary." />
      </h2>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          Watchlist matrix and Massive coverage jobs.
        </span>
        <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          {wlRows.length > 0 && watchlistUnifiedShowsOptionsMatrix(unifiedFocus) ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOptionJobsSheetOpen(true)}>
              Jobs
            </button>
          ) : null}
        </div>
      </div>

      <section className="replay-section" aria-labelledby="data-overview-wl-head" style={{ marginBottom: 'var(--space-4)' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-2)',
            marginBottom: 'var(--space-2)',
          }}
        >
          <h3 id="data-overview-wl-head" className="page-title-with-tooltip" style={{ marginBottom: 0 }}>
            Watchlist coverage
            <InfoTooltip text="Select one PostgreSQL table chip — watchlist coverage loads after you pick. Options vs Stocks by asset class. Summary tables are on Data Overview → Summary." />
          </h3>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={loading || unifiedFocus == null}
            onClick={() => void loadAll()}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {wlError ? <p className="status-page-msg err" role="alert">{wlError}</p> : null}
        {wlMessage && !wlError ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>{wlMessage}</p>
        ) : null}

        <div className="replay-section" style={{ marginBottom: 'var(--space-4)' }}>
          <WatchlistCoverageFocusChips embedded value={unifiedFocus} onChange={setUnifiedFocus} />
        </div>

        {unifiedFocus == null ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)', marginBottom: 'var(--space-3)' }}>
            Select a table chip to load watchlist coverage.
          </p>
        ) : null}

        {unifiedFocus != null && loading ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)', marginBottom: 'var(--space-3)' }}>
            Loading watchlist coverage…
          </p>
        ) : null}

        {unifiedFocus != null && !loading && !wlError && wlRows.length > 0 ? (
          <>
            {showOptionsMatrix ? (
              <>
                <h4 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                  Options
                </h4>
                <DataOverviewWatchlistOptions
                  wlRows={wlRows}
                  showWatchlistSummary={false}
                  embedFocusChips={false}
                  focusDataset={unifiedFocusToOptions(unifiedFocus)}
                  onFocusDatasetChange={handleOptionsFocusChange}
                  onWatchlistRefreshRequested={refreshPipelineAfterJobs}
                  refGapBySymbol={refGapBySymbol}
                  onCompareMassiveReference={handleCompareMassiveReference}
                  refGapLoading={refGapLoading}
                  refGapError={refGapError}
                  snapshotGapBySymbol={snapshotGapBySymbol}
                  onCompareSnapshotGap={handleCompareSnapshotGap}
                  snapshotGapLoading={snapshotGapLoading}
                  snapshotGapError={snapshotGapError}
                  comparePool={comparePool}
                  onToggleComparePool={toggleComparePool}
                  onSelectAllComparePool={selectAllComparePool}
                  onClearComparePool={clearComparePool}
                  jobsSheetOpen={optionJobsSheetOpen}
                  onJobsSheetOpenChange={setOptionJobsSheetOpen}
                />
              </>
            ) : null}

            {showStocksMatrix ? (
              <>
                <h4
                  className="page-title-with-tooltip"
                  style={{
                    marginTop: showOptionsMatrix ? 'var(--space-4)' : undefined,
                    marginBottom: 'var(--space-2)',
                    fontSize: 'var(--text-body)',
                  }}
                >
                  Stocks
                </h4>
                <DataOverviewWatchlistStocks
                  wlRows={wlRows}
                  showWatchlistSummary={false}
                  embedFocusChips={false}
                  focusDataset={unifiedFocusToStocks(unifiedFocus)}
                  onFocusDatasetChange={handleStocksFocusChange}
                  onWatchlistRefreshRequested={refreshPipelineAfterJobs}
                />
              </>
            ) : null}
          </>
        ) : null}

        {unifiedFocus != null && !loading && !wlError && wlRows.length === 0 && !wlMessage ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>No watchlist rows.</p>
        ) : null}
      </section>

      {wlRows.length > 0 ? <DataOverviewStocksUtilitiesSection wlRows={wlRows} /> : null}

      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginTop: 'var(--space-4)' }}>
        Massive option sync and chain tools:{' '}
        <button type="button" className="page-title-breadcrumb-link" style={{ fontSize: 'inherit', padding: 0 }} onClick={() => { window.location.hash = `#${COVERAGE_OPTION_SUBSECTION.id}` }}>
          Data Coverage → Option
        </button>
        {' · '}
        Stock daily bars (DB):{' '}
        <button type="button" className="page-title-breadcrumb-link" style={{ fontSize: 'inherit', padding: 0 }} onClick={() => { window.location.hash = `#${FEED_MASSIVE_STOCK_ID}` }}>
          Feed → Massive → Stock
        </button>
      </p>
    </div>
  )
}
