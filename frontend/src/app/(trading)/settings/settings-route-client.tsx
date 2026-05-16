'use client'

import { useParams, useRouter } from 'next/navigation'
import { useMemo } from 'react'
import { SettingsPage } from '@/views/SettingsPage'
import { useApp } from '@/contexts/AppContext'
import { useTradingLayoutOutlet } from '@/contexts/TradingLayoutOutletContext'
import { celeryMetricsFromStatus } from '@/views/status/celeryMetrics'
import type { LampId } from '@/contexts/AppContext'

export function SettingsRouteClient() {
  const params = useParams<{ slug?: string | string[] }>()
  const router = useRouter()
  const { status, loadStatus, operations, celeryRuntimeLampOverride } = useApp()
  const { celeryLamp: layoutCeleryLamp, apiHealthProbes } = useTradingLayoutOutlet()

  const slug = useMemo(() => {
    const raw = params.slug
    if (raw == null) return undefined
    return Array.isArray(raw) ? raw : [raw]
  }, [params.slug])

  const celeryLamp: LampId =
    layoutCeleryLamp ?? (celeryRuntimeLampOverride ?? celeryMetricsFromStatus(status).celeryLamp)

  return (
    <SettingsPage
      status={status}
      loadStatus={loadStatus}
      operations={operations}
      onNavigateToStrategy={() => router.push('/strategy/structure')}
      onNavigateToSocket={() => router.push('/settings/ingest')}
      onGoToScreener={() => router.push('/research/risk')}
      celeryLamp={celeryLamp}
      apiHealthProbes={apiHealthProbes}
      settingsRouteSlug={slug}
    />
  )
}
