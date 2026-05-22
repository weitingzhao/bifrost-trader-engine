import { useCallback, useEffect, useState } from 'react'
import type { RiskSummaryResponse } from '../types'
import { fetchRiskSummary } from '../api'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { fmtUsd } from '../utils/format'

interface ResearchRiskAnalysisPageProps {
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

export function ResearchRiskAnalysisPage({ onGoToScreener, breadcrumbLabel = 'Risk Model' }: ResearchRiskAnalysisPageProps = {}) {
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
    <PageSection>
      <SectionPageTitle
        menu="Research"
        pageTitle={breadcrumbLabel}
        onMenuClick={onGoToScreener}
        menuNavigateAriaLabel="Research home"
        infoText="Risk model summary from daemon auto status and operations (daily hedge count, daily PnL, spot, ops 24h). Data from GET /risk_summary."
        style={{ marginBottom: 'var(--space-2)' }}
      />
      <p className="text-sm text-muted-foreground">
        Summary of risk model metrics; refreshes every 30s. Source: daemon auto status + operations (last 24h).
        Position sizing analysis is available in Watchlist → Sizing step.
      </p>

      <section className="flex flex-col gap-3" aria-labelledby="research-risk-model-head">
        <h3 id="research-risk-model-head" className="text-base font-semibold text-foreground">
          Risk model
        </h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : riskSummary ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Daily hedge count</span>
              <span className="font-mono text-xl tabular-nums text-foreground">{riskSummary.daily_hedge_count ?? '—'}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Daily PnL (USD)</span>
              <span className="font-mono text-xl tabular-nums text-foreground">{fmtUsd(riskSummary.daily_pnl)}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Spot</span>
              <span className="font-mono text-xl tabular-nums text-foreground">{fmtUsd(riskSummary.spot)}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Ops (24h)</span>
              <span className="font-mono text-xl tabular-nums text-foreground">{riskSummary.operations_count_24h ?? 0}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Unable to load risk summary (check API and DB).</p>
        )}
      </section>

      <Button type="button" variant="secondary" onClick={load} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </Button>
    </PageSection>
  )
}
