'use client'

import { useRouter } from 'next/navigation'
import { AccountsPage } from '@/views/AccountsPage'
import { useApp } from '@/contexts/AppContext'
import type { PortfolioView } from '@/views/portfolio/types'

function portfolioPath(view: PortfolioView): string {
  if (view === 'accounts') return '/portfolio/accounts'
  if (view === 'performance') return '/portfolio/performance'
  if (view === 'model-analysis') return '/portfolio/model-analysis'
  if (view === 'ledger') return '/portfolio/ledger'
  if (view === 'transfer') return '/portfolio/transfer'
  return '/portfolio/positions'
}

export default function AccountsRoutePage() {
  const {
    status,
    accountsDisplay,
    ibAccountIndex,
    setIbAccountIndex,
    ibAccountsRefreshing,
    onRefreshAccounts,
    accountsRefreshFeedback,
  } = useApp()
  const router = useRouter()
  return (
    <AccountsPage
      status={status}
      accountsDisplay={accountsDisplay}
      ibAccountIndex={ibAccountIndex}
      setIbAccountIndex={setIbAccountIndex}
      ibAccountsRefreshing={ibAccountsRefreshing}
      onRefreshAccounts={onRefreshAccounts}
      refreshFeedback={accountsRefreshFeedback}
      onViewChange={(v) => router.push(portfolioPath(v))}
    />
  )
}
