import { useState } from 'react'
import type { StatusResponse } from '../types'
import { SectionPageTitle } from '../components/SectionPageTitle'
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
        <SectionPageTitle
          menu="Portfolio"
          pageTitle="Trade ledger"
          onMenuClick={() => onViewChange?.('accounts')}
          infoText="Trade ledger is the workspace for open and closed trades, Flex/TWS imports, and manual journal entries (journal_closed) for reconciliation. Instance groups option trades by strategy instance (With instance) or unlinked (No instance); Options shows all Closed/Open option contracts; Stocks lists all execution sources. Instance and Options both use the official execution book (Flex + journal) from the database."
          style={{ margin: 0 }}
        />
        <button
          type="button"
          className="btn btn-secondary trade-ledger-add-journal-btn"
          onClick={() => setAddJournalOpen(true)}
          aria-label="Add manual journal execution to trade ledger (journal_closed)"
        >
          <svg
            className="trade-ledger-add-journal-btn__icon"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M8 7h8" />
            <path d="M8 11h6" />
          </svg>
          <span>Add journal</span>
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
