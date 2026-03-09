import type { StatusResponse } from '../types'

interface BacktestPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

export function BacktestPage({ status: _status, onGoToScreener, breadcrumbLabel = 'Back test' }: BacktestPageProps) {
  return (
    <div className="replay-main">
      <section className="replay-section" aria-labelledby="backtest-head">
        {onGoToScreener ? (
          <h2 id="backtest-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
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
          </h2>
        ) : (
          <h2 id="backtest-head">Back test</h2>
        )}
        <p className="section-hint">Backtest tools. (Placeholder)</p>
      </section>
    </div>
  )
}
