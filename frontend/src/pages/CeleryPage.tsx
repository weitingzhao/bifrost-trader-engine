import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { StatusCeleryPanel } from './status/panels'
import { celeryMetricsFromStatus, useCeleryStopControl } from './status/celeryMetrics'

export interface CeleryPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
  breadcrumbLabel?: string
}

export function CeleryPage({
  status,
  loadStatus,
  embeddedInSettings,
  breadcrumbLabel = 'Celery',
}: CeleryPageProps) {
  const j = status
  const metrics = celeryMetricsFromStatus(j)
  const { celeryCtrlMsg, onCeleryStop } = useCeleryStopControl(loadStatus)

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'celery-page celery-page--embedded' : 'celery-page'}`}>
      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            {breadcrumbLabel}
            <InfoTooltip text="Celery worker health. Massive / bars job queues live on Dashboard → Celery. Use Dashboard → Console for per-worker Redis logs." />
          </h2>
          <p className="settings-page-subtitle">
            Health, stop worker, and Massive / bars job queues.
          </p>
        </div>
      </div>

      <div className="celery-page-grid settings-page-groups">
        <section className="replay-section celery-page-cell celery-page-cell--status" aria-labelledby="celery-status-head">
          <h3 id="celery-status-head" className="page-title-with-tooltip">
            Worker status
            <InfoTooltip text="Broker (Redis), worker processes, and optional IB connection used by the market worker." />
          </h3>
          <StatusCeleryPanel
            status={j}
            celeryLamp={metrics.celeryLamp}
            celeryBrokerConnected={metrics.celeryBrokerConnected}
            celeryWorkersAlive={metrics.celeryWorkersAlive}
            celeryLastTs={metrics.celeryLastTs}
            celeryWorkerIbConnected={metrics.celeryWorkerIbConnected}
            celeryWorkerIbClientId={metrics.celeryWorkerIbClientId}
            onCeleryStop={onCeleryStop}
            celeryCtrlMsg={celeryCtrlMsg}
          />
        </section>

        <section className="replay-section celery-page-cell celery-page-cell--config" aria-labelledby="celery-config-head">
          <h3 id="celery-config-head" className="page-title-with-tooltip">
            Configure
            <InfoTooltip text="Celery worker_market client ID is stored in IB configuration (YAML-backed)." />
          </h3>
          <p className="section-hint" style={{ marginBottom: '0.5rem' }}>
            Set <strong>Celery worker_market</strong> client ID under{' '}
            <a href="#settings-ib-connection">Settings → IB Configure</a>{' '}
            (Client ID YAML group). Keep it distinct from daemon and monitor client IDs.
          </p>
        </section>
      </div>
    </div>
  )
}
