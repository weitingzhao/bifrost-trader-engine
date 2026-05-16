'use client'

import { useRouter } from 'next/navigation'
import { StrategyStructurePage } from '@/views/StrategyStructurePage'
import { useApp } from '@/contexts/AppContext'

export default function StrategyStructureRoutePage() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  return (
    <StrategyStructurePage
      status={status}
      loadStatus={loadStatus}
      breadcrumbLabel="Structure"
      onNavigateToStrategy={() => router.push('/strategy/structure')}
    />
  )
}
