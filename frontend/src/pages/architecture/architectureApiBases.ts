import type { DocsApiHealthResponse } from '../../api'
import { getDocsApiBase, getOpsApiBase, getServerApiBase } from '../../api/shared/apiRouting'

/** GET /health shape for Monitor (bifrost-server). */
export type MonitorHealthForBases = {
  monitor_port?: number
} | null

/** GET /ops/health minimal shape for base URL fallback. */
export type OpsHealthForBases = {
  port?: number
} | null

export function monitorApiDocsBase(health: MonitorHealthForBases): string {
  const explicit = import.meta.env.VITE_API_BASE?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getServerApiBase().replace(/\/$/, '')
  if (routed) return routed
  const mp = health?.monitor_port
  if (typeof mp === 'number' && Number.isFinite(mp) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${mp}`
  }
  return ''
}

export function docsApiDocsBase(health: DocsApiHealthResponse | null): string {
  const explicit = import.meta.env.VITE_DOCS_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getDocsApiBase().replace(/\/$/, '')
  if (routed) return routed
  const port = health?.port
  if (typeof port === 'number' && Number.isFinite(port) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${port}`
  }
  return ''
}

export function opsApiDocsBase(health: OpsHealthForBases): string {
  const explicit = import.meta.env.VITE_OPS_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getOpsApiBase().replace(/\/$/, '')
  if (routed) return routed
  const port = health?.port
  if (typeof port === 'number' && Number.isFinite(port) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${port}`
  }
  return ''
}
