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
  monitor_port?: number
  massive_port?: number
  docs_port?: number
  ops_port?: number
  trading_port?: number
  strategy_port?: number
  portfolio_port?: number
  market_port?: number
  research_port?: number
  utilized_services?: Array<{ service: string; env: string }>
}

function trimEnv(s: string | undefined): string | undefined {
  const t = s?.trim()
  return t ? t.replace(/\/$/, '') : undefined
}

type ListenPortKey =
  | 'monitor_port'
  | 'massive_port'
  | 'docs_port'
  | 'ops_port'
  | 'trading_port'
  | 'strategy_port'
  | 'portfolio_port'
  | 'market_port'
  | 'research_port'

/** No numeric fallbacks: routing must match merged YAML exposed on GET /health. */
function listenPortFromHealth(h: HealthRoutingFields, key: ListenPortKey, label: string): number {
  const v = h[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(
      `GET /health must include numeric ${label} (from merged server.* YAML). ` +
        `Redeploy Monitor or fix config; do not rely on client-side port guesses.`,
    )
  }
  return v
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

function utilizedRowsAllEnv(
  rows: Array<{ service: string; env: string }>,
  env: 'prod' | 'dev',
): boolean {
  if (rows.length === 0) return false
  return rows.every((r) => String(r.env).toLowerCase().trim() === env)
}

/**
 * Same rules as Settings → Services Overview column resolution: one origin per env column,
 * with split host:port when frontend_dev_path is set and VITE_* overrides are unset.
 */
function baseForEnvRole(
  env: 'dev' | 'prod',
  role:
    | 'server'
    | 'massive'
    | 'docs'
    | 'ops'
    | 'trading'
    | 'strategy'
    | 'portfolio'
    | 'market'
    | 'research',
  h: HealthRoutingFields,
): string {
  const devEnv = trimEnv(import.meta.env.VITE_DEV_API_ORIGIN)
  const prodEnv = trimEnv(import.meta.env.VITE_PROD_API_ORIGIN)
  const sp = listenPortFromHealth(h, 'monitor_port', 'monitor_port')
  const mp = listenPortFromHealth(h, 'massive_port', 'massive_port')
  const dp = listenPortFromHealth(h, 'docs_port', 'docs_port')
  const op = listenPortFromHealth(h, 'ops_port', 'ops_port')
  const tp = listenPortFromHealth(h, 'trading_port', 'trading_port')
  const stp = listenPortFromHealth(h, 'strategy_port', 'strategy_port')
  const pfp = listenPortFromHealth(h, 'portfolio_port', 'portfolio_port')
  const mkp = listenPortFromHealth(h, 'market_port', 'market_port')
  const rp = listenPortFromHealth(h, 'research_port', 'research_port')
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
        let port: number
        if (role === 'massive') port = mp
        else if (role === 'docs') port = dp
        else if (role === 'ops') port = op
        else if (role === 'trading') port = tp
        else if (role === 'strategy') port = stp
        else if (role === 'portfolio') port = pfp
        else if (role === 'market') port = mkp
        else if (role === 'research') port = rp
        else port = sp
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
  const rows = Array.isArray(h.utilized_services) ? h.utilized_services : []
  const inferredProdStack =
    h.config_profile === 'prod' ||
    (h.config_profile == null && utilizedRowsAllEnv(rows, 'prod'))
  if (!cfgProd && inferredProdStack) {
    return pub ?? ''
  }
  return ''
}

function resolveBasesFromHealth(health: HealthRoutingFields | null): {
  server: string
  massive: string
  docs: string
  ops: string
  trading: string
  strategy: string
  portfolio: string
  market: string
  research: string
} {
  const serverEntry = trimEnv(import.meta.env.VITE_API_BASE) ?? ''

  const explicitMassive = trimEnv(import.meta.env.VITE_MASSIVE_API_ORIGIN)
  const explicitDocs = trimEnv(import.meta.env.VITE_DOCS_API_ORIGIN)
  const explicitOps = trimEnv(import.meta.env.VITE_OPS_API_ORIGIN)
  const explicitTrading = trimEnv(import.meta.env.VITE_TRADING_API_ORIGIN)
  const explicitStrategy = trimEnv(import.meta.env.VITE_STRATEGY_API_ORIGIN)
  const explicitPortfolio = trimEnv(import.meta.env.VITE_PORTFOLIO_API_ORIGIN)
  const explicitMarket = trimEnv(import.meta.env.VITE_MARKET_API_ORIGIN)
  const explicitResearch = trimEnv(import.meta.env.VITE_RESEARCH_API_ORIGIN)

  if (!health) {
    return {
      server: serverEntry,
      massive: explicitMassive ?? '',
      docs: explicitDocs ?? '',
      ops: explicitOps ?? '',
      trading: explicitTrading ?? '',
      strategy: explicitStrategy ?? '',
      portfolio: explicitPortfolio ?? '',
      market: explicitMarket ?? '',
      research: explicitResearch ?? '',
    }
  }

  const rows = Array.isArray(health.utilized_services) ? health.utilized_services : []
  const massEnv = envForService(rows, 'massive')
  const docsEnv = envForService(rows, 'docs')
  const opsEnv = envForService(rows, 'ops')
  let tradingEnv = envForService(rows, 'trading')
  let strategyEnv = envForService(rows, 'strategy')
  let portfolioEnv = envForService(rows, 'portfolio')
  let marketEnv = envForService(rows, 'market')
  let researchEnv = envForService(rows, 'research')
  const srvEnv =
    envForService(rows, 'server') ??
    envForService(rows, 'main') ??
    envForService(rows, 'api')

  /** Local split-stack: same host as frontend_dev_path, ports from YAML — no utilized row required per service. */
  const splitDevEnv: 'dev' | null =
    health.config_profile === 'dev' && trimEnv(health.frontend_dev_path) ? 'dev' : null
  if (splitDevEnv) {
    if (!tradingEnv) tradingEnv = splitDevEnv
    if (!strategyEnv) strategyEnv = splitDevEnv
    if (!portfolioEnv) portfolioEnv = splitDevEnv
    if (!marketEnv) marketEnv = splitDevEnv
    if (!researchEnv) researchEnv = splitDevEnv
  }

  let massive = explicitMassive ?? ''
  if (!massive && massEnv) {
    massive = baseForEnvRole(massEnv, 'massive', health)
  }

  let docs = explicitDocs ?? ''
  if (!docs && docsEnv) {
    docs = baseForEnvRole(docsEnv, 'docs', health)
  }

  let ops = explicitOps ?? ''
  if (!ops && opsEnv) {
    ops = baseForEnvRole(opsEnv, 'ops', health)
  }

  let trading = explicitTrading ?? ''
  if (!trading && tradingEnv) {
    trading = baseForEnvRole(tradingEnv, 'trading', health)
  }

  let strategy = explicitStrategy ?? ''
  if (!strategy && strategyEnv) {
    strategy = baseForEnvRole(strategyEnv, 'strategy', health)
  }

  let portfolio = explicitPortfolio ?? ''
  if (!portfolio && portfolioEnv) {
    portfolio = baseForEnvRole(portfolioEnv, 'portfolio', health)
  }

  let market = explicitMarket ?? ''
  if (!market && marketEnv) {
    market = baseForEnvRole(marketEnv, 'market', health)
  }

  let research = explicitResearch ?? ''
  if (!research && researchEnv) {
    research = baseForEnvRole(researchEnv, 'research', health)
  }

  let server = serverEntry
  if (!server && srvEnv) {
    server = baseForEnvRole(srvEnv, 'server', health)
  }

  return { server, massive, docs, ops, trading, strategy, portfolio, market, research }
}

let serverBase = trimEnv(import.meta.env.VITE_API_BASE) ?? ''
let massiveBase = ''
let docsBase = ''
let opsBase = ''
let tradingBase = ''
let strategyBase = ''
let portfolioBase = ''
let marketBase = ''
let researchBase = ''

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

export function getOpsApiBase(): string {
  return opsBase
}

export function getTradingApiBase(): string {
  return tradingBase
}

export function getStrategyApiBase(): string {
  return strategyBase
}

export function getPortfolioApiBase(): string {
  return portfolioBase
}

export function getMarketApiBase(): string {
  return marketBase
}

export function getResearchApiBase(): string {
  return researchBase
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
      opsBase = b.ops
      tradingBase = b.trading
      strategyBase = b.strategy
      portfolioBase = b.portfolio
      marketBase = b.market
      researchBase = b.research
    })()
  }
  return initPromise
}
