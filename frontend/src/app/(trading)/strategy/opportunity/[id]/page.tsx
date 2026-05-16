'use client'

import { useRouter, useParams } from 'next/navigation'
import { StrategyOpportunityPage } from '@/views/StrategyOpportunityPage'
import { useApp } from '@/contexts/AppContext'

export default function StrategyOpportunityIdRoutePage() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const raw = params?.id
  const urlFocusOpportunityId = raw != null ? Number(raw) : null
  return (
    <StrategyOpportunityPage
      status={status}
      loadStatus={loadStatus}
      breadcrumbLabel="Opportunity"
      urlFocusOpportunityId={Number.isFinite(urlFocusOpportunityId) ? urlFocusOpportunityId : null}
      onNavigateToStrategy={() => router.push('/strategy/structure')}
      onCloseOppForm={() => router.push('/strategy/opportunity')}
    />
  )
}
