'use client'

import { useRouter } from 'next/navigation'
import { LivePage } from '@/views/LivePage'
import { useApp } from '@/contexts/AppContext'

export default function LiveRoutePage() {
  const { status } = useApp()
  const router = useRouter()
  return (
    <LivePage
      status={status}
      onNavigateToStrategy={() => router.push('/strategy/structure')}
      onNavigateToSubscribe={() => {
        router.push('/settings/subscribe#settings-subscribe')
      }}
    />
  )
}
