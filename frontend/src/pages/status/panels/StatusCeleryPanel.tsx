import type { StatusResponse } from '../../../types'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { fmtSince, fmtTs } from '../../../utils/format'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

export interface StatusCeleryPanelProps {
  status: StatusResponse | null
  celeryLamp: Lamp
  celeryBrokerConnected: boolean
  celeryWorkersAlive: boolean
  celeryLastTs: number | null | undefined
  celeryWorkerIbConnected: boolean
  celeryWorkerIbClientId: number | null
  onCeleryStop: () => void
  celeryCtrlMsg: { text: string; isErr: boolean }
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
  onCeleryStop,
  celeryCtrlMsg,
  className,
}: StatusCeleryPanelProps) {
  const workersCount = j?.celery_workers?.length ?? 0
  /** Redis up but no Celery process: yellow (infra OK, service down). Both down: red. */
  const brokerLamp: Lamp =
    !celeryBrokerConnected ? 'red' : workersCount > 0 ? 'green' : 'yellow'
  /** No ping response = not running — red (not yellow). */
  const workerLamp: Lamp = workersCount > 0 ? 'green' : 'red'

  return (
    <div id="system-panel-celery" role="tabpanel" aria-labelledby="tab-celery" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className="daemon-header-main daemon-header-with-lamp">
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              <span className={`title-inline-lamp lamp-icon ${celeryLamp}`} title="Celery status lamp" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
              </span>
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
                      : 'No worker process (start: python scripts/run_celery.py)'
                  : 'Fetch failed'}
              </strong>
            </div>
          </div>
        </div>
        <div className="monitor-header-actions">
          <button
            type="button"
            className="section-header-icon-btn"
            title="Stop Celery worker process (same as Monitor/Daemon Stop); restart with: python scripts/run_celery.py"
            aria-label="Stop Celery"
            onClick={onCeleryStop}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="daemon-groups">
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className={`title-inline-lamp lamp-icon ${brokerLamp}`} title="Celery broker (Redis) status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-4l-3 9L9 3 6 12H2" /></svg>
            </span>
            <span className="daemon-group-title">Broker (Redis)</span>
            <InfoTooltip text="Celery broker and result backend. Same Redis as config.redis (db 1 for Celery). Required for queued bars backfill." />
          </div>
          <div className="daemon-group-body">
            {celeryBrokerConnected ? (
              workersCount > 0 ? (
                <p className="section-hint countdown-line">
                  <span className="countdown-num">Connected</span> <span>(bars queue available)</span>
                </p>
              ) : (
                <p className="section-hint">
                  Redis reachable — <strong>no worker process</strong> (start: python scripts/run_celery.py)
                </p>
              )
            ) : (
              <p className="section-hint">Not connected or Redis not configured</p>
            )}
          </div>
        </div>
        <div className="daemon-group">
          <div className="daemon-group-header">
            <span className={`title-inline-lamp lamp-icon ${workerLamp}`} title="Celery workers responding to inspect ping" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
            </span>
            <span className="daemon-group-title">Celery Workers</span>
            <InfoTooltip text="Workers that responded to inspect ping. Worker connects to IB using Settings → Celery worker_market; connection is kept so backfill can use it. Use Stop above to terminate the worker." />
          </div>
          <div className="daemon-group-body">
            <p className="section-hint">
              {(j?.celery_workers?.length ?? 0) > 0
                ? (j?.celery_workers ?? []).join(', ')
                : 'None (start worker: python scripts/run_celery.py)'}
            </p>
            <p className="section-hint countdown-line">
              Last job:{' '}
              {celeryLastTs != null && Number.isFinite(celeryLastTs)
                ? `${fmtTs(celeryLastTs)} (${fmtSince(celeryLastTs)} ago)`
                : 'None yet'}
            </p>
            <p className="section-hint countdown-line">
              IB:{' '}
              {celeryWorkerIbConnected ? (
                <span className="countdown-num">Connected @ {celeryWorkerIbClientId ?? '—'}</span>
              ) : (
                <>
                  Not connected{' '}
                  <InfoTooltip text="IB runs inside Worker. Start worker first (python scripts/run_celery.py); client_id in Settings → Celery worker_market." />
                </>
              )}
            </p>
          </div>
        </div>
      </div>
      {celeryCtrlMsg.text ? (
        <div className={`msg ${celeryCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
          {celeryCtrlMsg.text}
        </div>
      ) : null}
    </div>
  )
}
