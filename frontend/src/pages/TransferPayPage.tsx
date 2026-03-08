import type { StatusResponse } from '../types'

interface TransferPayPageProps {
  status: StatusResponse | null
  onViewChange?: (view: 'accounts') => void
}

export function TransferPayPage({ status: _status, onViewChange }: TransferPayPageProps) {
  return (
    <div className="replay-main">
      <section className="replay-section" aria-labelledby="transfer-pay-head">
        <h2 id="transfer-pay-head" className="page-title-with-tooltip">
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Transfer & Pay'}
        </h2>
        <p className="section-hint">Transfer and payment tools. (Placeholder)</p>
      </section>
    </div>
  )
}
