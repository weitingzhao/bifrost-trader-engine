'use client'

import { useRouter } from 'next/navigation'
import { OptionScreenerPage } from '@/views/OptionScreenerPage'
import { useApp } from '@/contexts/AppContext'

export default function OptionScreenerRoutePage() {
  const { status } = useApp()
  const router = useRouter()
  return (
    <OptionScreenerPage
      status={status}
      onBreadcrumbResearch={() => router.push('/research/risk')}
      onOpenOptionCoverage={() => {
        router.push('/settings/coverage#coverage-overview-summary')
      }}
      breadcrumbLabel="Option Screener"
    />
  )
}
