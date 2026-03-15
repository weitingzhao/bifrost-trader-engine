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
  return (
    <div id="system-panel-celery" role="tabpanel" aria-labelledby="tab-celery" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className="daemon-header-main daemon-header-with-lamp">
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${celeryLamp}`} title="Celery status lamp" />
          </div>
          <div>
            <h2 className="daemon-card-title">Celery</h2>
            <div>
              <strong>Status: {j ? (celeryBrokerConnected ? (celeryWorkersAlive ? 'Running (OK)' : 'Broker connected, no workers (start: python scripts/run_celery.py)') : 'Broker not connected') : 'Fetch failed'}</strong>
            </div>
          </div>
        </div>
        <div className="monitor-header-actions">
          <button
            type="button"
            className="btn-stop"
            title="Stop Celery worker process (same as Monitor/Daemon Stop); restart with: python scripts/run_celery.py"
            onClick={onCeleryStop}
          >
            Stop
          </button>
        </div>
      </div>
      <div className="daemon-groups">
        <div className="daemon-group">
          <div className="daemon-group-header">
            <div className={`lamp lamp-sm ${celeryBrokerConnected ? 'green' : 'red'}`} title="Celery broker (Redis) status" />
            <span className="daemon-group-title">Broker (Redis)</span>
            <InfoTooltip text="Celery broker and result backend. Same Redis as config.redis (db 1 for Celery). Required for queued bars backfill." />
          </div>
          <div className="daemon-group-body">
            {celeryBrokerConnected ? (
              <p className="section-hint countdown-line">
                <span className="countdown-num">Connected</span> <span>(bars queue available)</span>
              </p>
            ) : (
              <p className="section-hint">Not connected or Redis not configured</p>
            )}
          </div>
        </div>
        <div className="daemon-group">
          <div className="daemon-group-header">
            <div className={`lamp lamp-sm ${(j?.celery_workers?.length ?? 0) > 0 ? 'green' : celeryBrokerConnected ? 'yellow' : 'none'}`} title="Celery workers responding to ping" />
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
