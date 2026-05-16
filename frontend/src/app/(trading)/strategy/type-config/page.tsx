'use client'

import { useRouter } from 'next/navigation'
import { StructureTypeConfigPage } from '@/views/StructureTypeConfigPage'

export default function StrategyTypeConfigRoutePage() {
  const router = useRouter()
  return (
    <StructureTypeConfigPage
      breadcrumbLabel="Option Category"
      onNavigateToStrategy={() => router.push('/strategy/structure')}
    />
  )
}
