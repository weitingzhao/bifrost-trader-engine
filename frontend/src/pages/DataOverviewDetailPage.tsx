import { useCallback, useEffect, useState } from 'react'
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
import { DataOverviewWatchlistStocks } from './dataOverview/DataOverviewWatchlistStocks'
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

type WatchlistSectionTab = 'options' | 'stocks'

export function DataOverviewDetailPage(_props: DataOverviewDetailPageProps) {
  const [wlRows, setWlRows] = useState<WatchlistDbCoverageSymbolRow[]>([])
  const [wlTab, setWlTab] = useState<WatchlistSectionTab>('options')
  const [wlGeneratedAt, setWlGeneratedAt] = useState<string | null>(null)
  const [wlMessage, setWlMessage] = useState<string | null>(null)
  const [wlError, setWlError] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)

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

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (wlTab !== 'options') {
      setOptionJobsSheetOpen(false)
    }
  }, [wlTab])

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
        <InfoTooltip text="Per-symbol watchlist matrix, Focus dataset, Compare / Check tools, and option coverage jobs. Aggregates and global coverage are on Data Overview → Summary." />
      </h2>

      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
        <button
          type="button"
          className="page-title-breadcrumb-link"
          style={{ fontSize: 'inherit', padding: 0 }}
          onClick={() => { window.location.hash = `#${COVERAGE_OVERVIEW_SUMMARY_ID}` }}
        >
          Open Summary
        </button>
        {' — '}
        aggregates, job queues, and global PostgreSQL coverage.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          Watchlist matrix and Massive coverage jobs.
        </span>
        <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          {wlTab === 'options' ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOptionJobsSheetOpen(true)}>
              Jobs
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void loadAll()}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <section className="replay-section" aria-labelledby="data-overview-wl-head" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 id="data-overview-wl-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          Watchlist coverage
          <InfoTooltip text="Options and Stocks: per-symbol matrix. Summary tables are on Data Overview → Summary." />
        </h3>
        {wlError ? <p className="status-page-msg err" role="alert">{wlError}</p> : null}
        {wlGeneratedAt ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            Generated at {wlGeneratedAt}
          </p>
        ) : null}
        {wlMessage && !wlError ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>{wlMessage}</p>
        ) : null}

        {wlRows.length > 0 ? (
          <>
            <div className="feed-massive-agg-tabs-wrap" style={{ marginBottom: 'var(--space-3)' }}>
              <div className="feed-massive-agg-tabs" role="tablist" aria-label="Watchlist coverage datasets">
                <button
                  type="button"
                  role="tab"
                  id="data-overview-wl-tab-options"
                  className={`feed-massive-agg-tab${wlTab === 'options' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={wlTab === 'options'}
                  tabIndex={wlTab === 'options' ? 0 : -1}
                  onClick={() => setWlTab('options')}
                >
                  Options
                </button>
                <button
                  type="button"
                  role="tab"
                  id="data-overview-wl-tab-stocks"
                  className={`feed-massive-agg-tab${wlTab === 'stocks' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={wlTab === 'stocks'}
                  tabIndex={wlTab === 'stocks' ? 0 : -1}
                  onClick={() => setWlTab('stocks')}
                >
                  Stocks
                </button>
              </div>
            </div>

            {wlTab === 'options' ? (
              <DataOverviewWatchlistOptions
                wlRows={wlRows}
                showWatchlistSummary={false}
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
            ) : (
              <DataOverviewWatchlistStocks
                wlRows={wlRows}
                showWatchlistSummary={false}
                onWatchlistRefreshRequested={refreshPipelineAfterJobs}
              />
            )}
          </>
        ) : null}
        {!loading && !wlError && wlRows.length === 0 && !wlMessage ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>No watchlist rows.</p>
        ) : null}
      </section>

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
