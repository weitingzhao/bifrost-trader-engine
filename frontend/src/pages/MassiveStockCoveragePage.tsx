import { useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchMassiveStatus, type MassiveStatusResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { MassiveTickerReferenceDbSection } from './massive/MassiveTickerReferenceDbSection'

interface MassiveStockCoveragePageProps {
  status: StatusResponse | null
}

/** Data Coverage → Stock → Massive Delay (DB): reference tools and navigation. */
export function MassiveStockCoveragePage({ status: _status }: MassiveStockCoveragePageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => { if (!cancelled) setMassiveStatus(s) })
      .catch(() => { if (!cancelled) setMassiveStatus(null) })
    return () => { cancelled = true }
  }, [])

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

      <section className="replay-section" aria-labelledby="massive-stock-coverage-refdb-title">
        <h3 id="massive-stock-coverage-refdb-title" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          Reference (PostgreSQL)
          <InfoTooltip text="Search and verify synced ticker reference rows. Populate via Celery ticker_reference_* jobs on massive_stocks queues." />
        </h3>
        <MassiveTickerReferenceDbSection
          panelId="massive-stock-coverage-refdb"
          ariaLabelledBy="massive-stock-coverage-refdb-title"
        />
      </section>
    </div>
  )
}
