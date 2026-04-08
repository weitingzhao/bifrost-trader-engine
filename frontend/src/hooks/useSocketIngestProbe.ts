import { useEffect, useMemo, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchMarketIngestServices, type MarketIngestServiceRow } from '../api/ops/ops'
import { aggregateIngestRedisHealthLamp, type AggregateIngestLamp } from '../utils/socketIngestLamp'

const POLL_MS = 20_000

/** Same ingest + Redis roll-up as Settings → Socket (single poll in App for header shortcut). */
export interface SocketIngestProbeState {
  lamp: AggregateIngestLamp
  title: string
}

export function useSocketIngestProbe(enabled: boolean, status: StatusResponse | null): SocketIngestProbeState {
  const [services, setServices] = useState<MarketIngestServiceRow[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = () => {
      fetchMarketIngestServices()
        .then((res) => {
          if (cancelled) return
          if (res.ok && Array.isArray(res.services)) {
            setServices(res.services)
            setFetchError(null)
          } else {
            setServices([])
            setFetchError(
              res.error
                ? `Could not load ingest services: ${res.error}`
                : 'Could not load ingest services from Ops.',
            )
          }
        })
        .catch(() => {
          if (!cancelled) {
            setServices([])
            setFetchError('Could not load ingest services from Ops.')
          }
        })
    }
    load()
    const t = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [enabled])

  return useMemo(() => {
    if (fetchError) {
      return { lamp: 'none' as AggregateIngestLamp, title: fetchError }
    }
    const ingestOnly = services.filter(s => s.id !== 'trading_engine')
    return aggregateIngestRedisHealthLamp(ingestOnly.map(svc => ({ svc })), status)
  }, [services, fetchError, status])
}
