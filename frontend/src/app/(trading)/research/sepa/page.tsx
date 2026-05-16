'use client'

import { useRouter } from 'next/navigation'
import { StockScreenerPage } from '@/views/StockScreenerPage'

export default function StockScreenerRoutePage() {
  const router = useRouter()
  return (
    <StockScreenerPage
      onBreadcrumbResearch={() => router.push('/research/risk')}
      breadcrumbLabel="Stock Screener"
    />
  )
}
