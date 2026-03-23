import { useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../../types'
import { postCeleryStop } from '../../api'
import { useControlAction } from './useControlAction'

export function celeryMetricsFromStatus(j: StatusResponse | null) {
  const celeryBrokerConnected = j?.celery_broker_connected === true
  const celeryLastTs = j?.celery_worker_last_updated_ts
  const celeryWorkerIbConnected = j?.celery_worker_ib_connected === true
  const celeryWorkerIbClientId = j?.celery_worker_ib_client_id ?? null
  const celeryWorkersAlive = (j?.celery_workers?.length ?? 0) > 0
  /** Green only when broker reachable and at least one worker responds to inspect ping. No yellow “idle” — stopped worker = red. */
  const celeryLamp: 'green' | 'yellow' | 'red' | 'none' = !celeryBrokerConnected
    ? 'red'
    : celeryWorkersAlive
      ? 'green'
      : 'red'
  return {
    celeryBrokerConnected,
    celeryLastTs,
    celeryWorkerIbConnected,
    celeryWorkerIbClientId,
    celeryWorkersAlive,
    celeryLamp,
  }
}

/** Shared Celery stop control + message state for StatusCeleryPanel. */
export function useCeleryStopControl(loadStatus: () => Promise<StatusResponse | null>) {
  const [celeryCtrlMsg, setCeleryCtrlMsg] = useState({ text: '', isErr: false })
  const celeryCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runCeleryAction = useControlAction(setCeleryCtrlMsg, celeryCtrlMsgClearRef, { onSuccess: loadStatus })
  useEffect(
    () => () => {
      if (celeryCtrlMsgClearRef.current != null) clearTimeout(celeryCtrlMsgClearRef.current)
    },
    [],
  )
  const onCeleryStop = () =>
    runCeleryAction(postCeleryStop, {
      loading: 'Requesting Celery worker stop…',
      success: 'Celery worker stop requested; process will exit within a few seconds.',
    })
  return { celeryCtrlMsg, onCeleryStop }
}
