import type { StatusResponse } from '../../types'

export function celeryMetricsFromStatus(j: StatusResponse | null) {
  const c = j?.celery
  const celeryBrokerConnected = c?.broker_connected === true
  const celeryLastTs = c?.worker_last_updated_ts
  const celeryWorkerIbConnected = c?.worker_ib_connected === true
  const celeryWorkerIbClientId = c?.worker_ib_client_id ?? null
  const celeryWorkersAlive = (c?.workers?.length ?? 0) > 0
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
