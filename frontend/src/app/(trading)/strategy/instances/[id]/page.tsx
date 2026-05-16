'use client'

import { Suspense } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { StrategyInstancesPage } from '@/views/StrategyInstancesPage'
import { useApp } from '@/contexts/AppContext'
import { useMemo } from 'react'

function StrategyInstancesIdInner() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const raw = params?.id
  const urlStrategyInstanceId = raw != null ? Number(raw) : null
  const instancesStructureFilterIntent = useMemo(() => {
    const filter = searchParams.get('structureFilter')?.trim()
    if (!filter) return null
    return { token: Date.now(), structureName: filter }
  }, [searchParams])
  return (
    <StrategyInstancesPage
      status={status}
      loadStatus={loadStatus}
      urlStrategyInstanceId={Number.isFinite(urlStrategyInstanceId) ? urlStrategyInstanceId : null}
      onNavigateToStrategy={() => router.push('/strategy/structure')}
      breadcrumbLabel="Instances"
      instancesStructureFilterIntent={instancesStructureFilterIntent}
      onOpenInstanceDetail={(instanceId) => router.push(`/strategy/instances/${instanceId}`)}
      onCloseInstanceDetail={() => router.push('/strategy/instances')}
    />
  )
}

export default function StrategyInstancesIdRoutePage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading…</div>}>
      <StrategyInstancesIdInner />
    </Suspense>
  )
}
