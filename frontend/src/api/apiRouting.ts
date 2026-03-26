/**
 * Resolve per-service API origins from GET /health (utilized.services + frontend paths).
 * When Massive/Docs are declared as prod, requests must not go through the Vite dev proxy to local dev ports.
 */
import { fetchWithTimeout } from './fetchTimeout'
import { API_HEALTH_FETCH_TIMEOUT_MS } from './fetchTimeout'

export interface HealthRoutingFields {
  config_profile?: 'dev' | 'prod'
  frontend_public_origin?: string
  frontend_dev_path?: string
  frontend_prod_path?: string
  server_port?: number
  massive_port?: number
  docs_port?: number
  utilized_services?: Array<{ service: string; env: string }>
}

function trimEnv(s: string | undefined): string | undefined {
  const t = s?.trim()
  return t ? t.replace(/\/$/, '') : undefined
}

export function joinServiceBase(base: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const b = base.replace(/\/$/, '')
  return b ? `${b}${p}` : p
}

function envForService(
  rows: Array<{ service: string; env: string }>,
  name: string,
): 'dev' | 'prod' | null {
  const row = rows.find(r => r.service.toLowerCase() === name.toLowerCase())
  if (!row) return null
  const e = String(row.env).toLowerCase().trim()
  if (e === 'dev' || e === 'prod') return e
  return null
}

/**
 * Same rules as Settings → API Overview column resolution: one origin per env column,
 * with split host:port when frontend_dev_path is set and VITE_* overrides are unset.
 */
function baseForEnvRole(
  env: 'dev' | 'prod',
  role: 'server' | 'massive' | 'docs',
  h: HealthRoutingFields,
): string {
  const devEnv = trimEnv(import.meta.env.VITE_DEV_API_ORIGIN)
  const prodEnv = trimEnv(import.meta.env.VITE_PROD_API_ORIGIN)
  const sp = typeof h.server_port === 'number' && Number.isFinite(h.server_port) ? h.server_port : 8765
  const mp = typeof h.massive_port === 'number' && Number.isFinite(h.massive_port) ? h.massive_port : 8766
  const dp = typeof h.docs_port === 'number' && Number.isFinite(h.docs_port) ? h.docs_port : 8767
  const cfgDev = trimEnv(h.frontend_dev_path)
  const cfgProd = trimEnv(h.frontend_prod_path)
  const pub = trimEnv(h.frontend_public_origin)
  const noYamlPaths = cfgDev == null && cfgProd == null

  if (env === 'dev') {
    if (devEnv) return devEnv
    if (cfgDev) {
      try {
        const raw = cfgDev.includes('://') ? cfgDev : `http://${cfgDev}`
        const u = new URL(raw)
        const scheme = (u.protocol || 'http:').replace(':', '') || 'http'
        const host = u.hostname
        if (!host) throw new Error('no host')
        const port = role === 'massive' ? mp : role === 'docs' ? dp : sp
        return `${scheme}://${host}:${port}`
      } catch {
        return cfgDev.replace(/\/$/, '')
      }
    }
    if (noYamlPaths && h.config_profile === 'dev') {
      return pub ?? ''
    }
    return ''
  }

  if (prodEnv) return prodEnv
  if (cfgProd) return cfgProd.replace(/\/$/, '')
  if (noYamlPaths && h.config_profile === 'prod') {
    return pub ?? ''
  }
  return ''
}

function resolveBasesFromHealth(health: HealthRoutingFields | null): {
  server: string
  massive: string
  docs: string
} {
  const serverEntry = trimEnv(import.meta.env.VITE_API_BASE) ?? ''

  const explicitMassive = trimEnv(import.meta.env.VITE_MASSIVE_API_ORIGIN)
  const explicitDocs = trimEnv(import.meta.env.VITE_DOCS_API_ORIGIN)

  if (!health) {
    return {
      server: serverEntry,
      massive: explicitMassive ?? '',
      docs: explicitDocs ?? '',
    }
  }

  const rows = Array.isArray(health.utilized_services) ? health.utilized_services : []
  const massEnv = envForService(rows, 'massive')
  const docsEnv = envForService(rows, 'docs')
  const srvEnv =
    envForService(rows, 'server') ??
    envForService(rows, 'main') ??
    envForService(rows, 'api')

  let massive = explicitMassive ?? ''
  if (!massive && massEnv) {
    massive = baseForEnvRole(massEnv, 'massive', health)
  }

  let docs = explicitDocs ?? ''
  if (!docs && docsEnv) {
    docs = baseForEnvRole(docsEnv, 'docs', health)
  }

  let server = serverEntry
  if (!server && srvEnv) {
    server = baseForEnvRole(srvEnv, 'server', health)
  }

  return { server, massive, docs }
}

let serverBase = trimEnv(import.meta.env.VITE_API_BASE) ?? ''
let massiveBase = ''
let docsBase = ''

let initPromise: Promise<void> | null = null

export function getServerApiBase(): string {
  return serverBase
}

export function getMassiveApiBase(): string {
  return massiveBase
}

export function getDocsApiBase(): string {
  return docsBase
}

async function loadHealth(): Promise<HealthRoutingFields | null> {
  const entry = trimEnv(import.meta.env.VITE_API_BASE) ?? ''
  const url = joinServiceBase(entry, '/health')
  try {
    const credentials: RequestCredentials = entry ? 'omit' : 'same-origin'
    const r = await fetchWithTimeout(url, { credentials }, API_HEALTH_FETCH_TIMEOUT_MS)
    if (!r.ok) return null
    return (await r.json()) as HealthRoutingFields
  } catch {
    return null
  }
}

export function initApiRouting(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const health = await loadHealth()
      const b = resolveBasesFromHealth(health)
      serverBase = b.server
      massiveBase = b.massive
      docsBase = b.docs
    })()
  }
  return initPromise
}
