import type { StatusResponse } from '../types'
import { IbEventSubscribePanel } from './status/panels/IbEventSubscribePanel'

export interface IbEventSubscribePageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
}

export function IbEventSubscribePage({ status, loadStatus, embeddedInSettings }: IbEventSubscribePageProps) {
  return (
    <div
      id={embeddedInSettings ? 'settings-subscribe' : undefined}
      className={`settings-page-card ${embeddedInSettings ? 'daemon-status-page daemon-status-page--embedded' : 'daemon-status-page'}`}
    >
      <div className="daemon-groups settings-page-groups">
        <section className="replay-section" aria-label="IB Event Subscribe">
          <IbEventSubscribePanel status={status} loadStatus={loadStatus} />
        </section>
      </div>
    </div>
  )
}
