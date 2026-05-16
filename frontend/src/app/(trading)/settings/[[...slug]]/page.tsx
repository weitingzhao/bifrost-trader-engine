import { Suspense } from 'react'
import { SettingsRouteClient } from '@/app/(trading)/settings/settings-route-client'

export default function SettingsCatchAllPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading settings…</div>}>
      <SettingsRouteClient />
    </Suspense>
  )
}
