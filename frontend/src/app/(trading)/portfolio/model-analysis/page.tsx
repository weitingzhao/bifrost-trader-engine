'use client'

import { useRouter } from 'next/navigation'
import { ModelAnalysisPage } from '@/views/ModelAnalysisPage'
import { useApp } from '@/contexts/AppContext'
import type { PortfolioView } from '@/views/portfolio/types'

function portfolioPath(view: PortfolioView): string {
  if (view === 'accounts') return '/portfolio/accounts'
  if (view === 'performance') return '/portfolio/performance'
  if (view === 'model-analysis') return '/portfolio/model-analysis'
  if (view === 'ledger') return '/portfolio/ledger'
  if (view === 'transfer') return '/portfolio/transfer'
  return '/portfolio/positions'
}

export default function ModelAnalysisRoutePage() {
  const { status } = useApp()
  const router = useRouter()
  return <ModelAnalysisPage status={status} onViewChange={(v) => router.push(portfolioPath(v))} />
}
