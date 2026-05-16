'use client'

import { useRouter } from 'next/navigation'
import { WatchlistPage } from '@/views/WatchlistPage'
import { useApp } from '@/contexts/AppContext'

export default function WatchlistRoutePage() {
  const { status } = useApp()
  const router = useRouter()
  return <WatchlistPage status={status} onBreadcrumbResearch={() => router.push('/research/risk')} />
}
