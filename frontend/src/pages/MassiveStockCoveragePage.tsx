import { useCallback, useEffect, useState } from 'react'
import type { BarCoverageItem, StatusResponse } from '../types'
import { fetchBarsCoverage, fetchMassiveStatus, type MassiveStatusResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { MassiveRefJobSessionProvider } from './massive/MassiveRefJobSessionContext'
import { MassiveStockOhlcDbEnqueueBlock } from './massive/MassiveStockOhlcDbEnqueueBlock'
import { MassiveTickerReferenceDbSection } from './massive/MassiveTickerReferenceDbSection'

interface MassiveStockCoveragePageProps {
  status: StatusResponse | null
}

/** Data Coverage → Stock → Massive Delay (DB): reference tools and navigation. */
export function MassiveStockCoveragePage({ status }: MassiveStockCoveragePageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [coverage, setCoverage] = useState<BarCoverageItem[] | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => { if (!cancelled) setMassiveStatus(s) })
      .catch(() => { if (!cancelled) setMassiveStatus(null) })
    return () => { cancelled = true }
  }, [])

  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true)
    setCoverageError(null)
    try {
      const res = await fetchBarsCoverage()
      setCoverage(res.coverage || [])
    } catch (e) {
      setCoverageError(e instanceof Error ? e.message : 'Load failed')
      setCoverage([])
    } finally {
      setCoverageLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCoverage()
  }, [loadCoverage])

  const configured = Boolean(massiveStatus?.configured)

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
          onClick={() => { window.location.hash = '#coverage-stock' }}
          aria-label="Go to Stock coverage (IB Live)"
        >
          Stock
        </button>
        {' / '}
        Massive Delay (DB)
        <InfoTooltip text="Massive (Polygon) stocks: REST and synced reference data are delayed per vendor plan (~15 minutes). For realtime watchlist history and EOD bar pulls, use Data Coverage → Stock → IB Live (Redis)." />
        {configured && (
          <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice} style={{ marginLeft: 'var(--space-2)' }}>
            Delayed feed
          </span>
        )}
      </h2>

      <section className="replay-section" aria-label="Massive stocks overview">
        <div style={{ marginBottom: 'var(--space-4)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { window.location.hash = '#coverage-stock' }}
          >
            IB Live (Redis)
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { window.location.hash = '#feed-massive-stock' }}
          >
            Massive Stock (API checklist)
          </button>
        </div>
      </section>

      {!configured ? (
        <p className="status-page-msg err" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
          Massive API key not configured. Set massive credentials in server config. Celery enqueue and REST checklist require a configured key.
        </p>
      ) : null}

      <section className="replay-section" aria-labelledby="massive-stock-coverage-refdb-title">
        <h3 id="massive-stock-coverage-refdb-title" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          Reference (PostgreSQL)
          <InfoTooltip text="Ticker reference (Celery ticker_reference_* jobs) and stock OHLC persistence (stock_ohlc_sync) on massive_stocks queues." />
        </h3>
        <div className="feed-massive-option-page" style={{ marginTop: 'var(--space-4)' }}>
          <MassiveRefJobSessionProvider>
            <h4 className="feed-massive-group-header" id="massive-delay-db-group-tickers">
              Tickers
            </h4>
            <MassiveTickerReferenceDbSection
              panelId="massive-stock-coverage-refdb"
              ariaLabelledBy="massive-delay-db-group-tickers"
            />
            <h4 className="feed-massive-group-header" id="massive-delay-db-group-agg-bars">
              Aggregate Bars (OHLC)
            </h4>
            <MassiveStockOhlcDbEnqueueBlock
              configured={configured}
              status={status}
              coverage={coverage}
              coverageLoading={coverageLoading}
              coverageError={coverageError}
              onRefreshCoverage={loadCoverage}
            />
          </MassiveRefJobSessionProvider>
        </div>
      </section>
    </div>
  )
}
