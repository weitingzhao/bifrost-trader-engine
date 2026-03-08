import type { PortfolioView } from './PositionsPage'
import { PositionsPage } from './PositionsPage'
import type { StatusResponse } from '../types'

export type { PortfolioView }

interface TradeHistoryPageProps {
  status: StatusResponse | null
  onViewChange?: (view: PortfolioView) => void
  showViewTabs?: boolean
}

/** Trade History (ledger) view; delegates to PositionsPage with currentView="ledger". */
export function TradeHistoryPage({
  status,
  onViewChange,
  showViewTabs = false,
}: TradeHistoryPageProps) {
  return (
    <PositionsPage
      status={status}
      currentView="ledger"
      onViewChange={onViewChange}
      showViewTabs={showViewTabs}
    />
  )
}
