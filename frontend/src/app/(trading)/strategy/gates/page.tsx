'use client'

import { useRouter } from 'next/navigation'
import { GatesConfigPage } from '@/views/GatesConfigPage'
import { useApp } from '@/contexts/AppContext'

export default function StrategyGatesRoutePage() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  return (
    <GatesConfigPage
      status={status}
      loadStatus={loadStatus}
      onGoToStrategy={() => router.push('/strategy/structure')}
      breadcrumbLabel="Gates"
    />
  )
}
