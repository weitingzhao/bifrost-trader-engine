'use client'

import { useRouter } from 'next/navigation'
import { StrategyWinRatePage } from '@/views/StrategyWinRatePage'

export default function StrategyWinRateRoutePage() {
  const router = useRouter()
  return (
    <StrategyWinRatePage
      onGoToInstances={(opts) => {
        if (opts?.structureFilter?.trim()) {
          router.push(
            `/strategy/instances?structureFilter=${encodeURIComponent(opts.structureFilter.trim())}`,
          )
        } else {
          router.push('/strategy/instances')
        }
      }}
    />
  )
}
