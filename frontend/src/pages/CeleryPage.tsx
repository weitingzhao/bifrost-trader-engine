import type { StatusResponse } from '../types'
import { fetchCeleryLogs, subscribeCeleryLogs, clearCeleryLogs } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'
import { StatusCeleryPanel, StatusSseQueuesPanel } from './status/panels'
import { celeryMetricsFromStatus, useCeleryStopControl } from './status/celeryMetrics'
import { CeleryJobQueuesSection } from './celery/CeleryJobQueuesSection'

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
  const deferredStart = useDeferredStart()
  const celeryConsole = useLogConsole({
    fetchLogs: fetchCeleryLogs,
    subscribeLogs: subscribeCeleryLogs,
    clearLogs: clearCeleryLogs,
    enabled: deferredStart,
  })

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'celery-page celery-page--embedded' : 'celery-page'}`}>
      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            {breadcrumbLabel}
            <InfoTooltip text="Celery worker health, worker log stream, SSE backlog for Celery logs, and queue job tables." />
          </h2>
          <p className="settings-page-subtitle">
            Health, stop worker, worker log, Celery log SSE backlog, and Massive / bars job queues.
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

        <div className="celery-page-cell celery-page-cell--sse">
          <StatusSseQueuesPanel categoryKeys={['celery_logs']} heading="Celery log SSE backlog" />
        </div>

        <section className="replay-section celery-page-cell celery-page-cell--log" aria-labelledby="celery-console-head">
          <h3 id="celery-console-head" className="page-title-with-tooltip">
            Worker log
            <InfoTooltip text="Real-time Celery worker log (Redis stream). Start worker: python scripts/run_celery.py" />
          </h3>
          <LogConsolePanel
            controller={celeryConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis/Celery broker may be down)."
            emptyText="No log lines yet. Start Worker: python scripts/run_celery.py"
            infoTooltipText="Real-time Worker log (Redis Stream). Run `python scripts/run_celery.py` to see output."
            resizeAriaLabel="Resize Celery console height"
            clearTitle="Clear displayed log and Redis stream; new lines will continue to appear when Worker runs"
          />
        </section>

        <CeleryJobQueuesSection />

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
