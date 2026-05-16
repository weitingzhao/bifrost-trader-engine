'use client'

import { useRouter } from 'next/navigation'
import { StockDataReadinessPage } from '@/views/StockDataReadinessPage'

export default function StockReadinessRoutePage() {
  const router = useRouter()
  return (
    <StockDataReadinessPage
      onBreadcrumbResearch={() => router.push('/research/risk')}
      breadcrumbLabel="Stock Data Readiness"
      onOpenCelerySettings={() => {
        router.push('/settings/celery#settings-celery')
      }}
      onOpenFeedMassiveStock={() => {
        router.push('/settings/massive/stock#feed-massive-stock')
      }}
      onOpenDataCoverageSummary={() => {
        router.push('/settings/coverage#coverage-overview-summary')
      }}
    />
  )
}
