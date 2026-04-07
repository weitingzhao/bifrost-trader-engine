import {
  getMarketApiBase,
  getResearchApiBase,
  getStrategyApiBase,
} from '../../api/shared/apiRouting'

/** Monitor GET /health fields used to infer host:port when routing bases are empty. */
export type MonitorHealthForResearchBases = {
  research_port?: number
  strategy_port?: number
  market_port?: number
} | null

export function researchServiceBase(monitorHealth: MonitorHealthForResearchBases): string {
  const explicit = import.meta.env.VITE_RESEARCH_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getResearchApiBase().replace(/\/$/, '')
  if (routed) return routed
  const p = monitorHealth?.research_port
  if (typeof p === 'number' && Number.isFinite(p) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${p}`
  }
  return ''
}

export function strategyServiceBase(monitorHealth: MonitorHealthForResearchBases): string {
  const explicit = import.meta.env.VITE_STRATEGY_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getStrategyApiBase().replace(/\/$/, '')
  if (routed) return routed
  const p = monitorHealth?.strategy_port
  if (typeof p === 'number' && Number.isFinite(p) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${p}`
  }
  return ''
}

export function marketServiceBase(monitorHealth: MonitorHealthForResearchBases): string {
  const explicit = import.meta.env.VITE_MARKET_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getMarketApiBase().replace(/\/$/, '')
  if (routed) return routed
  const p = monitorHealth?.market_port
  if (typeof p === 'number' && Number.isFinite(p) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${p}`
  }
  return ''
}
