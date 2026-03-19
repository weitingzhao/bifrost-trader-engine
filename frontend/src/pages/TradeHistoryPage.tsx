import { useState } from 'react'
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

/** Trade ledger view; owns full Ledger UI via LedgerView. */
export function TradeHistoryPage({
  status,
  onViewChange,
  showViewTabs: _showViewTabs = false,
}: TradeHistoryPageProps) {
  const [addJournalOpen, setAddJournalOpen] = useState(false)
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
          {' / Trade ledger'}
          <InfoTooltip text="Trade ledger is the workspace for open and closed trades, Flex/TWS imports, and manual journal entries (journal_closed) for reconciliation. Instance groups option trades by strategy instance (With instance) or unlinked (No instance); Options shows all Closed/Open option contracts; Stocks lists all execution sources. Instance and Options both use the official execution book (Flex + journal) from the database." />
        </h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setAddJournalOpen(true)}
          aria-label="Add manual journal execution to trade ledger (journal_closed)"
        >
          Add journal
        </button>
      </div>
      <LedgerView
        status={status}
        onViewChange={onViewChange ?? (() => {})}
        addJournalOpen={addJournalOpen}
        onAddJournalOpenChange={setAddJournalOpen}
      />
    </div>
  )
}
