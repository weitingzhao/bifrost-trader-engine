import type { StatusResponse } from '../../../types'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { fmtSince, fmtTs } from '../../../utils/format'
import { SettingsTitleLamp } from '../../settings/SettingsTitleLamp'
import type { LampTone } from '@/components/shared/lamp-indicator'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

export interface StatusCeleryPanelProps {
  status: StatusResponse | null
  celeryLamp: Lamp
  celeryBrokerConnected: boolean
  celeryWorkersAlive: boolean
  celeryLastTs: number | null | undefined
  celeryWorkerIbConnected: boolean
  celeryWorkerIbClientId: number | null
  className?: string
}

export function StatusCeleryPanel({
  status: j,
  celeryLamp,
  celeryBrokerConnected,
  celeryWorkersAlive,
  celeryLastTs,
  celeryWorkerIbConnected,
  celeryWorkerIbClientId,
  className,
}: StatusCeleryPanelProps) {
  const workersCount = j?.celery?.workers?.length ?? 0
  /** Redis up but no Celery process: yellow (infra OK, service down). Both down: red. */
  const brokerLamp: Lamp =
    !celeryBrokerConnected ? 'red' : workersCount > 0 ? 'green' : 'yellow'
  /** No ping response = not running — red (not yellow). */
  const workerLamp: Lamp = workersCount > 0 ? 'green' : 'red'

  return (
    <div id="system-panel-celery" role="tabpanel" aria-labelledby="tab-celery" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className={cn(w9.daemonHeaderMain, 'daemon-header-with-lamp')}>
          <div>
            <h2 className={cn(w9.daemonCardTitle, 'inline-flex', 'flex-wrap', 'items-center', 'gap-2', 'm-0')}>
              <SettingsTitleLamp lamp={celeryLamp as LampTone} title="Celery status lamp">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
              </SettingsTitleLamp>
              Celery
            </h2>
            <div>
              <strong>
                Status:{' '}
                {j
                  ? !celeryBrokerConnected
                    ? 'Broker not connected'
                    : celeryWorkersAlive
                      ? 'Running (OK)'
                      : 'No worker process (start: python scripts/systemd/run_celery.py)'
                  : 'Fetch failed'}
              </strong>
            </div>
          </div>
        </div>
      </div>
      <div className={w9.daemonGroups}>
        <div className={w9.daemonGroup}>
          <div className={w9.daemonGroupHeader}>
            <SettingsTitleLamp lamp={brokerLamp as LampTone} title="Celery broker (Redis) status">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
            </SettingsTitleLamp>
            <span className={w9.daemonGroupTitle}>Broker (Redis)</span>
            <InfoTooltip text="Celery broker and result backend. Same Redis as config.redis (db 1 for Celery). Required for queued bars backfill." />
          </div>
          <div className={w9.daemonGroupBody}>
            {celeryBrokerConnected ? (
              workersCount > 0 ? (
                <p className={cn(w9.sectionHint, w9.countdownLine)}>
                  <span className={w9.countdownNum}>Connected</span> <span>(stocks_ib queue available)</span>
                </p>
              ) : (
                <p className={w9.sectionHint}>
                  Redis reachable — <strong>no worker process</strong> (start: python scripts/systemd/run_celery.py)
                </p>
              )
            ) : (
              <p className={w9.sectionHint}>Not connected or Redis not configured</p>
            )}
          </div>
        </div>
        <div className={w9.daemonGroup}>
          <div className={w9.daemonGroupHeader}>
            <SettingsTitleLamp lamp={workerLamp as LampTone} title="Celery workers responding to inspect ping">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
            </SettingsTitleLamp>
            <span className={w9.daemonGroupTitle}>Celery Workers</span>
            <InfoTooltip text="Workers that responded to inspect ping. Worker connects to IB using Settings → Celery worker_market; connection is kept so backfill can use it. Scale and consoles live under Settings → Celery." />
          </div>
          <div className={w9.daemonGroupBody}>
            <p className={w9.sectionHint}>
              {(j?.celery?.workers?.length ?? 0) > 0
                ? (j?.celery?.workers ?? []).join(', ')
                : 'None (start worker: python scripts/systemd/run_celery.py)'}
            </p>
            <p className={cn(w9.sectionHint, w9.countdownLine)}>
              Last job:{' '}
              {celeryLastTs != null && Number.isFinite(celeryLastTs)
                ? `${fmtTs(celeryLastTs)} (${fmtSince(celeryLastTs)} ago)`
                : 'None yet'}
            </p>
            <p className={cn(w9.sectionHint, w9.countdownLine)}>
              IB:{' '}
              {celeryWorkerIbConnected ? (
                <span className={w9.countdownNum}>Connected @ {celeryWorkerIbClientId ?? '—'}</span>
              ) : (
                <>
                  Not connected{' '}
                  <InfoTooltip text="IB runs inside Worker. Start worker first (python scripts/systemd/run_celery.py); client_id in Settings → Celery worker_market." />
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
