import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import type { PortfolioView } from './portfolio/types'
import { LedgerView } from './portfolio/LedgerView'

export type { PortfolioView }

interface TradeHistoryPageProps {
  status: StatusResponse | null
  onViewChange?: (view: PortfolioView) => void
  showViewTabs?: boolean
}

/** Trade History (ledger) view; owns full Ledger UI via LedgerView. */
export function TradeHistoryPage({
  status,
  onViewChange,
  showViewTabs: _showViewTabs = false,
}: TradeHistoryPageProps) {
  return (
    <div className="card process-section replay-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Trade History'}
          <InfoTooltip text="Trade History is the maintenance workspace for closed trades, execution imports, and manual trade corrections." />
        </h2>
      </div>
      <LedgerView status={status} onViewChange={onViewChange ?? (() => {})} />
    </div>
  )
}
