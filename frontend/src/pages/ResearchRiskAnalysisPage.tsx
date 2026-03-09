import { useCallback, useEffect, useState } from 'react'
import type { RiskSummaryResponse } from '../types'
import { fetchRiskSummary } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

interface ResearchBreadcrumbProps {
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

export function ResearchRiskAnalysisPage({ onGoToScreener, breadcrumbLabel = 'Risk Model' }: ResearchBreadcrumbProps = {}) {
  const [riskSummary, setRiskSummary] = useState<RiskSummaryResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchRiskSummary()
      setRiskSummary(res)
    } catch {
      setRiskSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="card process-section">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        {onGoToScreener ? (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={onGoToScreener}
              aria-label="Go to Screener"
            >
              Research
            </button>
            {' / '}
            {breadcrumbLabel}
            {' '}
          </>
        ) : (
          <>Risk Model{' '}</>
        )}
        <InfoTooltip text="Risk model summary from status_current and operations (daily hedge count, daily PnL, spot, ops 24h). Data from GET /risk_summary." />
      </h2>
      <p className="section-hint">
        Summary of risk model metrics; refreshes every 30s. Source: status_current + operations (last 24h).
      </p>

      <section className="replay-section" aria-labelledby="research-risk-model-head">
        <h3 id="research-risk-model-head">Risk model</h3>
        {loading ? (
          <p className="section-hint">Loading…</p>
        ) : riskSummary ? (
          <div className="risk-summary-cards">
            <div className="risk-card">
              <span className="risk-card-label">Daily hedge count</span>
              <span className="risk-card-value">{riskSummary.daily_hedge_count ?? '—'}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Daily PnL (USD)</span>
              <span className="risk-card-value">{fmtUsd(riskSummary.daily_pnl)}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Spot</span>
              <span className="risk-card-value">{fmtUsd(riskSummary.spot)}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Ops (24h)</span>
              <span className="risk-card-value">{riskSummary.operations_count_24h ?? 0}</span>
            </div>
          </div>
        ) : (
          <p className="section-hint">Unable to load risk summary (check API and DB).</p>
        )}
      </section>

      <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  )
}
