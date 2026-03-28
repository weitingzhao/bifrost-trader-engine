import type { StatusResponse } from '../../types'

export function celeryMetricsFromStatus(j: StatusResponse | null) {
  const celeryBrokerConnected = j?.celery_broker_connected === true
  const celeryLastTs = j?.celery_worker_last_updated_ts
  const celeryWorkerIbConnected = j?.celery_worker_ib_connected === true
  const celeryWorkerIbClientId = j?.celery_worker_ib_client_id ?? null
  const celeryWorkersAlive = (j?.celery_workers?.length ?? 0) > 0
  /** Fallback when Ops snapshot is unavailable: red = broker down; yellow = broker up, no workers; green = broker + workers (queue coverage unknown). */
  const celeryLamp: 'green' | 'yellow' | 'red' | 'none' = !celeryBrokerConnected
    ? 'red'
    : celeryWorkersAlive
      ? 'green'
      : 'yellow'
  return {
    celeryBrokerConnected,
    celeryLastTs,
    celeryWorkerIbConnected,
    celeryWorkerIbClientId,
    celeryWorkersAlive,
    celeryLamp,
  }
}
