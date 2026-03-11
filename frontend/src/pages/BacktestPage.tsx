import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'

interface BacktestPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

export function BacktestPage({ status: _status, onGoToScreener, breadcrumbLabel = 'Backtest' }: BacktestPageProps) {
  return (
    <div className="card process-section">
      <h2 id="backtest-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
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
          </>
        ) : (
          breadcrumbLabel
        )}
        <InfoTooltip text="Backtest and strategy validation — planned for a later release." />
      </h2>
      <p className="section-hint">
        Backtest and strategy validation will be available in a later release.
      </p>
    </div>
  )
}
