'use client'

import { useRouter } from 'next/navigation'
import { OptionDiscoveryPage } from '@/views/OptionDiscoveryPage'
import { useApp } from '@/contexts/AppContext'

export default function OptionDiscoveryRoutePage() {
  const { status } = useApp()
  const router = useRouter()
  return (
    <OptionDiscoveryPage
      status={status}
      onGoToScreener={() => router.push('/research/risk')}
      onOpenMassiveFeed={() => {
        router.push('/settings/massive/daily#feed-massive-daily-data')
      }}
      breadcrumbLabel="Option Discovery"
    />
  )
}
