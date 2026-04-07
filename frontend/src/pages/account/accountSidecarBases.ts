import { getPortfolioApiBase, getTradingApiBase } from '../../api/shared/apiRouting'

/** Monitor GET /health fields used to infer host:port when routing bases are empty. */
export type MonitorHealthForAccountBases = {
  trading_port?: number
  portfolio_port?: number
} | null

export function tradingServiceBase(monitorHealth: MonitorHealthForAccountBases): string {
  const explicit = import.meta.env.VITE_TRADING_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getTradingApiBase().replace(/\/$/, '')
  if (routed) return routed
  const p = monitorHealth?.trading_port
  if (typeof p === 'number' && Number.isFinite(p) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${p}`
  }
  return ''
}

export function portfolioServiceBase(monitorHealth: MonitorHealthForAccountBases): string {
  const explicit = import.meta.env.VITE_PORTFOLIO_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getPortfolioApiBase().replace(/\/$/, '')
  if (routed) return routed
  const p = monitorHealth?.portfolio_port
  if (typeof p === 'number' && Number.isFinite(p) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${p}`
  }
  return ''
}
