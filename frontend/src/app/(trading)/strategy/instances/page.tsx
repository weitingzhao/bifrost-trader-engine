'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { StrategyInstancesPage } from '@/views/StrategyInstancesPage'
import { useApp } from '@/contexts/AppContext'
import { useMemo } from 'react'

function StrategyInstancesInner() {
  const { status, loadStatus } = useApp()
  const router = useRouter()
  const searchParams = useSearchParams()
  const instancesStructureFilterIntent = useMemo(() => {
    const filter = searchParams.get('structureFilter')?.trim()
    if (!filter) return null
    return { token: Date.now(), structureName: filter }
  }, [searchParams])
  return (
    <StrategyInstancesPage
      status={status}
      loadStatus={loadStatus}
      urlStrategyInstanceId={null}
      onNavigateToStrategy={() => router.push('/strategy/structure')}
      breadcrumbLabel="Instances"
      instancesStructureFilterIntent={instancesStructureFilterIntent}
      onOpenInstanceDetail={(instanceId) => router.push(`/strategy/instances/${instanceId}`)}
      onCloseInstanceDetail={() => router.push('/strategy/instances')}
    />
  )
}

export default function StrategyInstancesRoutePage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading…</div>}>
      <StrategyInstancesInner />
    </Suspense>
  )
}
