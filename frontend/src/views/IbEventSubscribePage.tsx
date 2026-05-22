import { rl } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import type { StatusResponse } from '../types'
import { IbEventSubscribePanel } from './status/panels/IbEventSubscribePanel'
import { SettingsPageCard } from './settings/SettingsPageCard'
import { SettingsPageGroups } from './settings/SettingsPageGroups'

export interface IbEventSubscribePageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
}

export function IbEventSubscribePage({ status, loadStatus, embeddedInSettings }: IbEventSubscribePageProps) {
  return (
    <SettingsPageCard
      id={embeddedInSettings ? 'settings-subscribe' : undefined}
      embedded={embeddedInSettings}
      className={embeddedInSettings ? 'daemon-status-page daemon-status-page--embedded' : 'daemon-status-page'}
    >
      <SettingsPageGroups className={w9.daemonGroups}>
        <section className={rl.section} aria-label="IB Event Subscribe">
          <IbEventSubscribePanel status={status} loadStatus={loadStatus} />
        </section>
      </SettingsPageGroups>
    </SettingsPageCard>
  )
}
