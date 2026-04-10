import { useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchMassiveStatus, type MassiveStatusResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { MassiveStockReferenceDbSection } from './massive/MassiveStockReferenceDbSection'

interface MassiveStockCoveragePageProps {
  status: StatusResponse | null
}

/**
 * Data Coverage → Stock Data: delayed vendor data and PostgreSQL reference sync.
 * Realtime watchlist bars remain under Stock IB (Realtime).
 */
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
        Stock Data
        <InfoTooltip text="Massive (Polygon) stocks: REST and synced reference data are delayed per vendor plan (~15 minutes). For realtime watchlist history and EOD bar pulls, use Data Coverage → Stock IB (Realtime)." />
        {configured && (
          <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice} style={{ marginLeft: 'var(--space-2)' }}>
            Delayed feed
          </span>
        )}
      </h2>

      <section className="replay-section" aria-label="Massive stocks overview">
        <p style={{ marginBottom: 'var(--space-3)', color: 'var(--color-text-muted)', maxWidth: '52rem', lineHeight: 1.55 }}>
          Massive market data for both options and stocks is delayed (typically about 15 minutes). Intraday and realtime
          updates for the watchlist still come from IB. This page focuses on Massive-backed reference data in PostgreSQL
          and related maintenance; IB bar coverage and backfill remain on Stock IB (Realtime).
        </p>
        <div style={{ marginBottom: 'var(--space-4)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { window.location.hash = '#coverage-stock' }}
          >
            Stock IB (Realtime)
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { window.location.hash = '#feed-massive-stock' }}
          >
            Stock Data (API checklist)
          </button>
        </div>
      </section>

      <section className="replay-section" aria-labelledby="massive-stock-coverage-refdb-title">
        <h3 id="massive-stock-coverage-refdb-title" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          Reference (PostgreSQL)
          <InfoTooltip text="Search and verify synced stock reference rows. Populate via Celery stock_reference_* jobs on massive_stocks queues." />
        </h3>
        <MassiveStockReferenceDbSection
          panelId="massive-stock-coverage-refdb"
          ariaLabelledBy="massive-stock-coverage-refdb-title"
        />
      </section>
    </div>
  )
}
