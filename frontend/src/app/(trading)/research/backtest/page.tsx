'use client'

import { useRouter } from 'next/navigation'
import { BacktestPage } from '@/views/BacktestPage'
import { useApp } from '@/contexts/AppContext'

export default function BacktestRoutePage() {
  const { status } = useApp()
  const router = useRouter()
  return (
    <BacktestPage
      status={status}
      onGoToScreener={() => router.push('/research/risk')}
      breadcrumbLabel="Backtest"
    />
  )
}
