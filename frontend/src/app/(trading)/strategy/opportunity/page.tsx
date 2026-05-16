'use client'

import { useRouter } from 'next/navigation'
import { StrategyOpportunityPage } from '@/views/StrategyOpportunityPage'
import { useApp } from '@/contexts/AppContext'

export default function StrategyOpportunityRoutePage() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  return (
    <StrategyOpportunityPage
      status={status}
      loadStatus={loadStatus}
      breadcrumbLabel="Opportunity"
      urlFocusOpportunityId={null}
      onNavigateToStrategy={() => router.push('/strategy/structure')}
      onCloseOppForm={() => router.push('/strategy/opportunity')}
    />
  )
}
