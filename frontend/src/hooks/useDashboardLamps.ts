import { useMemo } from 'react'
import type { StatusResponse, RealtimeQuote } from '../types'
import type { LampId } from '../contexts/AppContext'
import {
  computeMarketStreamsOk,
  computeAccountSyncLamp,
  computeOpenOrdersSectionOk,
} from '../utils/livePageLamps'

export interface DashboardLamps {
  marketStreamsOk: boolean
  accountSyncLampForOpenOrders: { lamp: LampId | 'gray'; title: string }
  openOrdersSectionOk: boolean
  dashboardStreamsLamp: LampId
  dashboardOpenOrdersLamp: LampId
}

/**
 * Computes all dashboard lamp states from live status and quotes.
 * `liveLampClock` is a periodic tick from AppContext that forces re-evaluation
 * of time-sensitive staleness checks (heartbeats, quote age).
 */
export function useDashboardLamps(
  status: StatusResponse | null,
  quotesMap: Record<string, RealtimeQuote>,
  liveLampClock: number,
): DashboardLamps {
  const marketStreamsOk = useMemo(
    () => computeMarketStreamsOk(status, quotesMap),
    // liveLampClock triggers re-evaluation of staleness thresholds
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, quotesMap, liveLampClock],
  )

  const accountSyncLampForOpenOrders = useMemo(
    () => computeAccountSyncLamp(status),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, liveLampClock],
  )

  const openOrdersSectionOk = useMemo(
    () => computeOpenOrdersSectionOk(status, Date.now() / 1000),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, liveLampClock],
  )

  const dashboardStreamsLamp: LampId = marketStreamsOk ? 'green' : 'red'
  const dashboardOpenOrdersLamp: LampId = openOrdersSectionOk ? 'green' : 'red'

  return {
    marketStreamsOk,
    accountSyncLampForOpenOrders,
    openOrdersSectionOk,
    dashboardStreamsLamp,
    dashboardOpenOrdersLamp,
  }
}
