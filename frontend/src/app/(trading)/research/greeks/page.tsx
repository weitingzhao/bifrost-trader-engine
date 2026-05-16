'use client'

import { useRouter } from 'next/navigation'
import OptionGreeksPage from '@/views/OptionGreeksPage'

export default function OptionGreeksRoutePage() {
  const router = useRouter()
  return (
    <OptionGreeksPage
      onBreadcrumbResearch={() => router.push('/research/risk')}
      breadcrumbLabel="IV & Greeks"
    />
  )
}
