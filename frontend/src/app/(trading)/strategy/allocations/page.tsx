'use client'

import { useRouter } from 'next/navigation'
import { StrategyAllocationPage } from '@/views/StrategyAllocationPage'
import { useApp } from '@/contexts/AppContext'

export default function StrategyAllocationsRoutePage() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  return (
    <StrategyAllocationPage
      status={status}
      loadStatus={loadStatus}
      breadcrumbLabel="Allocations"
      onNavigateToStrategy={() => router.push('/strategy/structure')}
    />
  )
}
