'use client'

import { useRouter } from 'next/navigation'
import { ResearchRiskAnalysisPage } from '@/views/ResearchRiskAnalysisPage'

export default function ResearchRiskPage() {
  const router = useRouter()
  return (
    <ResearchRiskAnalysisPage
      onGoToScreener={() => router.push('/research/risk')}
      breadcrumbLabel="Risk Model"
    />
  )
}
