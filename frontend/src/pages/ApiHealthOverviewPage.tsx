import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchDocsApiHealthAtOrigin,
  fetchHealth,
  fetchHealthAtOrigin,
  fetchMassiveApiHealth,
  fetchMassiveApiHealthAtOrigin,
  fetchOpsHealthAtOrigin,
  fetchResearchApiHealthAtOrigin,
  type ApiOriginBase,
} from '../api'
import { API_HEALTH_FETCH_TIMEOUT_MS } from '../api/shared/fetchTimeout'
import { InfoTooltip } from '../components/InfoTooltip'
import { normalizeUtilizedServices, type UtilizedServiceRow } from '../utils/utilizedServices'

export interface ApiHealthOverviewPageProps {
  embeddedInSettings?: boolean
}

type Lamp = 'green' | 'red' | 'none'

/** Ports for trading/strategy/portfolio/market/research when probing host:port/health (split stack or single nginx host + sidecar ports). */
interface MicroPorts {
  tradingPort: number
  strategyPort: number
  portfolioPort: number
  marketPort: number
  researchPort: number
}

type ProbeKind =
  | { kind: 'single'; origin: ApiOriginBase; microPorts: MicroPorts }
  | {
      kind: 'split'
      scheme: string
      host: string
      serverPort: number
      massivePort: number
      docsPort: number
      opsPort: number
      tradingPort: number
      strategyPort: number
      portfolioPort: number
      marketPort: number
      researchPort: number
    }

interface ColumnPlan {
  display: string
  probe: ProbeKind
}

interface ServiceProbe {
  ok: boolean
  ts?: number
  base: string
}

interface ProbeResult {
  server: ServiceProbe
  massive: ServiceProbe
  docs: ServiceProbe
  ops: ServiceProbe
  trading: ServiceProbe
  strategy: ServiceProbe
  portfolio: ServiceProbe
  market: ServiceProbe
  research: ServiceProbe
}

interface HealthProbeRow {
  label: string
  lamp: Lamp
  detail: string
}

interface HealthGroupState {
  title: string
  rows: HealthProbeRow[]
}

interface ColumnState {
  title: string
  display: string | null
  groups: HealthGroupState[]
  hint?: string
}

function trimEnv(s: string | undefined): string | undefined {
  const t = s?.trim()
  return t ? t.replace(/\/$/, '') : undefined
}

export type { UtilizedServiceRow }

function formatServiceLabel(service: string): string {
  const t = service.toLowerCase()
  if (t === 'massive') return 'Massive'
  if (t === 'docs') return 'Docs'
  if (t === 'ops') return 'Ops'
  if (t === 'research') return 'Research'
  if (t === 'server' || t === 'main' || t === 'api' || t === 'monitor') return 'Monitor'
  if (t === 'trading') return 'Trading'
  if (t === 'strategy') return 'Strategy'
  if (t === 'portfolio') return 'Portfolio'
  if (t === 'market') return 'Market'
  if (t === 'ib') return 'IB'
  return service.charAt(0).toUpperCase() + service.slice(1)
}

const SERVICES_CONFIGURED_GROUP_ORDER = ['Architecture', 'Account', 'Research', 'Feed', 'Other'] as const

function configuredServiceGroup(service: string): (typeof SERVICES_CONFIGURED_GROUP_ORDER)[number] {
  const k = service.toLowerCase()
  if (['server', 'main', 'api', 'monitor', 'ops', 'docs'].includes(k)) return 'Architecture'
  if (['market', 'trading', 'portfolio'].includes(k)) return 'Account'
  if (['research', 'strategy'].includes(k)) return 'Research'
  if (['massive', 'ib'].includes(k)) return 'Feed'
  return 'Other'
}

function groupUtilizedServicesForOverview(rows: UtilizedServiceRow[]): Array<{ title: string; rows: UtilizedServiceRow[] }> {
  const buckets: Record<string, UtilizedServiceRow[]> = {
    Architecture: [],
    Account: [],
    Research: [],
    Feed: [],
    Other: [],
  }
  for (const r of rows) {
    buckets[configuredServiceGroup(r.service)].push(r)
  }
  return SERVICES_CONFIGURED_GROUP_ORDER.filter((t) => buckets[t].length > 0).map((t) => ({
    title: t,
    rows: buckets[t],
  }))
}

function formatEnvLabel(env: string): string {
  const t = env.toLowerCase()
  if (t === 'dev') return 'Development'
  if (t === 'prod') return 'Production'
  return env
}

/** Pill color variant for configured routes (aligns with Settings API sidebar: dev = sky, prod = green). */
function envPillVariant(env: string): 'dev' | 'prod' | 'other' {
  const t = env.toLowerCase().trim()
  if (t === 'dev' || t === 'development') return 'dev'
  if (t === 'prod' || t === 'production') return 'prod'
  return 'other'
}

function formatEnvShortLabel(env: string): string {
  const v = envPillVariant(env)
  if (v === 'dev') return 'Dev'
  if (v === 'prod') return 'Prod'
  return env.trim() || '—'
}

function lampFor(ok: boolean | null): Lamp {
  if (ok === true) return 'green'
  if (ok === false) return 'red'
  return 'none'
}

function defaultMicroPorts(): MicroPorts {
  return {
    tradingPort: 8769,
    strategyPort: 8770,
    portfolioPort: 8771,
    marketPort: 8772,
    researchPort: 8773,
  }
}

function microPortsFromHealth(h: Record<string, unknown> | undefined | null): MicroPorts {
  const n = (x: unknown, d: number) =>
    typeof x === 'number' && Number.isFinite(x) ? x : d
  return {
    tradingPort: n(h?.trading_port, 8769),
    strategyPort: n(h?.strategy_port, 8770),
    portfolioPort: n(h?.portfolio_port, 8771),
    marketPort: n(h?.market_port, 8772),
    researchPort: n(h?.research_port, 8773),
  }
}

function _microserviceHealthBase(kind: ProbeKind, port: number): string {
  if (kind.kind === 'split') {
    return `${kind.scheme}://${kind.host}:${port}`
  }
  const o = kind.origin
  const raw =
    o && o.trim() !== ''
      ? o.includes('://')
        ? o
        : `http://${o}`
      : typeof window !== 'undefined'
        ? window.location.origin
        : 'http://127.0.0.1'
  try {
    const u = new URL(raw)
    const scheme = (u.protocol || 'http:').replace(':', '') || 'http'
    const host = u.hostname || '127.0.0.1'
    return `${scheme}://${host}:${port}`
  } catch {
    return `http://127.0.0.1:${port}`
  }
}

function _researchProbeOrigin(kind: ProbeKind): string {
  const rp = kind.kind === 'split' ? kind.researchPort : kind.microPorts.researchPort
  return _microserviceHealthBase(kind, rp)
}

async function probeServices(kind: ProbeKind): Promise<ProbeResult> {
  const tmo = { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS }
  const oRes = _researchProbeOrigin(kind)
  if (kind.kind === 'single') {
    const o = kind.origin
    const baseLabel = o === '' ? '(same origin as this app)' : o
    const mp = kind.microPorts
    const oTr = _microserviceHealthBase(kind, mp.tradingPort)
    const oSt = _microserviceHealthBase(kind, mp.strategyPort)
    const oPf = _microserviceHealthBase(kind, mp.portfolioPort)
    const oMk = _microserviceHealthBase(kind, mp.marketPort)
    const [sr, mr, dr, or, tr, st, pf, mk, rr] = await Promise.allSettled([
      fetchHealthAtOrigin(o, tmo),
      fetchMassiveApiHealthAtOrigin(o, tmo),
      fetchDocsApiHealthAtOrigin(o, tmo),
      fetchOpsHealthAtOrigin(o, tmo),
      fetchHealthAtOrigin(oTr, tmo),
      fetchHealthAtOrigin(oSt, tmo),
      fetchHealthAtOrigin(oPf, tmo),
      fetchHealthAtOrigin(oMk, tmo),
      fetchResearchApiHealthAtOrigin(oRes, tmo),
    ])
    return {
      server: {
        ok: sr.status === 'fulfilled',
        ts: sr.status === 'fulfilled' ? sr.value.ts : undefined,
        base: baseLabel,
      },
      massive: {
        ok: mr.status === 'fulfilled',
        ts: mr.status === 'fulfilled' ? mr.value.ts : undefined,
        base: baseLabel,
      },
      docs: {
        ok: dr.status === 'fulfilled',
        ts: dr.status === 'fulfilled' ? dr.value.ts : undefined,
        base: baseLabel,
      },
      ops: {
        ok: or.status === 'fulfilled',
        ts: or.status === 'fulfilled' ? or.value.ts : undefined,
        base: baseLabel,
      },
      trading: {
        ok: tr.status === 'fulfilled',
        ts: tr.status === 'fulfilled' ? tr.value.ts : undefined,
        base: oTr,
      },
      strategy: {
        ok: st.status === 'fulfilled',
        ts: st.status === 'fulfilled' ? st.value.ts : undefined,
        base: oSt,
      },
      portfolio: {
        ok: pf.status === 'fulfilled',
        ts: pf.status === 'fulfilled' ? pf.value.ts : undefined,
        base: oPf,
      },
      market: {
        ok: mk.status === 'fulfilled',
        ts: mk.status === 'fulfilled' ? mk.value.ts : undefined,
        base: oMk,
      },
      research: {
        ok: rr.status === 'fulfilled',
        ts: rr.status === 'fulfilled' ? rr.value.ts : undefined,
        base: oRes,
      },
    }
  }
  const {
    scheme,
    host,
    serverPort,
    massivePort,
    docsPort,
    opsPort,
    tradingPort,
    strategyPort,
    portfolioPort,
    marketPort,
    researchPort,
  } = kind
  const oS = `${scheme}://${host}:${serverPort}`
  const oM = `${scheme}://${host}:${massivePort}`
  const oD = `${scheme}://${host}:${docsPort}`
  const oO = `${scheme}://${host}:${opsPort}`
  const oTr = `${scheme}://${host}:${tradingPort}`
  const oSt = `${scheme}://${host}:${strategyPort}`
  const oPf = `${scheme}://${host}:${portfolioPort}`
  const oMk = `${scheme}://${host}:${marketPort}`
  const oR = `${scheme}://${host}:${researchPort}`
  const [sr, mr, dr, or, tr, st, pf, mk, rr] = await Promise.allSettled([
    fetchHealthAtOrigin(oS, tmo),
    fetchMassiveApiHealthAtOrigin(oM, tmo),
    fetchDocsApiHealthAtOrigin(oD, tmo),
    fetchOpsHealthAtOrigin(oO, tmo),
    fetchHealthAtOrigin(oTr, tmo),
    fetchHealthAtOrigin(oSt, tmo),
    fetchHealthAtOrigin(oPf, tmo),
    fetchHealthAtOrigin(oMk, tmo),
    fetchResearchApiHealthAtOrigin(oR, tmo),
  ])
  return {
    server: {
      ok: sr.status === 'fulfilled',
      ts: sr.status === 'fulfilled' ? sr.value.ts : undefined,
      base: oS,
    },
    massive: {
      ok: mr.status === 'fulfilled',
      ts: mr.status === 'fulfilled' ? mr.value.ts : undefined,
      base: oM,
    },
    docs: {
      ok: dr.status === 'fulfilled',
      ts: dr.status === 'fulfilled' ? dr.value.ts : undefined,
      base: oD,
    },
    ops: {
      ok: or.status === 'fulfilled',
      ts: or.status === 'fulfilled' ? or.value.ts : undefined,
      base: oO,
    },
    trading: {
      ok: tr.status === 'fulfilled',
      ts: tr.status === 'fulfilled' ? tr.value.ts : undefined,
      base: oTr,
    },
    strategy: {
      ok: st.status === 'fulfilled',
      ts: st.status === 'fulfilled' ? st.value.ts : undefined,
      base: oSt,
    },
    portfolio: {
      ok: pf.status === 'fulfilled',
      ts: pf.status === 'fulfilled' ? pf.value.ts : undefined,
      base: oPf,
    },
    market: {
      ok: mk.status === 'fulfilled',
      ts: mk.status === 'fulfilled' ? mk.value.ts : undefined,
      base: oMk,
    },
    research: {
      ok: rr.status === 'fulfilled',
      ts: rr.status === 'fulfilled' ? rr.value.ts : undefined,
      base: oR,
    },
  }
}

async function resolveColumnPlans(): Promise<{
  dev: ColumnPlan | null
  prod: ColumnPlan | null
  utilizedServices: UtilizedServiceRow[]
}> {
  const devEnv = trimEnv(import.meta.env.VITE_DEV_API_ORIGIN)
  const prodEnv = trimEnv(import.meta.env.VITE_PROD_API_ORIGIN)
  if (devEnv && prodEnv) {
    let utilizedServices: UtilizedServiceRow[] = []
    let microPorts = defaultMicroPorts()
    try {
      const h = await fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
      utilizedServices = normalizeUtilizedServices(h?.utilized_services)
      microPorts = microPortsFromHealth(h as Record<string, unknown> | undefined)
    } catch {
      // same-origin /health may be unreachable; leave Services empty
    }
    return {
      dev: { display: devEnv, probe: { kind: 'single', origin: devEnv, microPorts } },
      prod: { display: prodEnv, probe: { kind: 'single', origin: prodEnv, microPorts } },
      utilizedServices,
    }
  }

  try {
    const to = API_HEALTH_FETCH_TIMEOUT_MS
    const [hr, mhr] = await Promise.allSettled([
      fetchHealth({ timeoutMs: to }),
      fetchMassiveApiHealth({ timeoutMs: to }),
    ])
    const h = hr.status === 'fulfilled' ? hr.value : undefined
    const mh = mhr.status === 'fulfilled' ? mhr.value : undefined

    if (!h && !mh) {
      const microPorts = defaultMicroPorts()
      return {
        dev: devEnv ? { display: devEnv, probe: { kind: 'single', origin: devEnv, microPorts } } : null,
        prod: prodEnv ? { display: prodEnv, probe: { kind: 'single', origin: prodEnv, microPorts } } : null,
        utilizedServices: [],
      }
    }

    const utilizedServices = normalizeUtilizedServices(h?.utilized_services)

    const prof = mh?.config_profile ?? h?.config_profile
    const pub = trimEnv(h?.frontend_public_origin)
    const cfgDev = trimEnv(h?.frontend_dev_path)
    const cfgProd = trimEnv(h?.frontend_prod_path)
    const sp = typeof h?.server_port === 'number' && Number.isFinite(h.server_port) ? h.server_port : 8765
    const mp = typeof h?.massive_port === 'number' && Number.isFinite(h.massive_port) ? h.massive_port : 8766
    const dp = typeof h?.docs_port === 'number' && Number.isFinite(h.docs_port) ? h.docs_port : 8767
    const op = typeof h?.ops_port === 'number' && Number.isFinite(h.ops_port) ? h.ops_port : 8768
    const microPorts = microPortsFromHealth(h as Record<string, unknown> | undefined)
    const noYamlPaths = cfgDev == null && cfgProd == null

    let dev: ColumnPlan | null = null
    if (devEnv) {
      dev = { display: devEnv, probe: { kind: 'single', origin: devEnv, microPorts } }
    } else if (cfgDev) {
      try {
        const raw = cfgDev.includes('://') ? cfgDev : `http://${cfgDev}`
        const u = new URL(raw)
        const scheme = (u.protocol || 'http:').replace(':', '') || 'http'
        const host = u.hostname
        if (!host) throw new Error('no host')
        dev = {
          display: cfgDev.replace(/\/$/, ''),
          probe: {
            kind: 'split',
            scheme,
            host,
            serverPort: sp,
            massivePort: mp,
            docsPort: dp,
            opsPort: op,
            tradingPort: microPorts.tradingPort,
            strategyPort: microPorts.strategyPort,
            portfolioPort: microPorts.portfolioPort,
            marketPort: microPorts.marketPort,
            researchPort: microPorts.researchPort,
          },
        }
      } catch {
        const o = cfgDev.replace(/\/$/, '')
        dev = { display: o, probe: { kind: 'single', origin: o, microPorts } }
      }
    } else if (noYamlPaths && prof === 'dev') {
      dev = {
        display: pub || 'Same as this app',
        probe: { kind: 'single', origin: pub ?? '', microPorts },
      }
    }

    let prod: ColumnPlan | null = null
    if (prodEnv) {
      prod = { display: prodEnv, probe: { kind: 'single', origin: prodEnv, microPorts } }
    } else if (cfgProd) {
      const o = cfgProd.replace(/\/$/, '')
      prod = { display: o, probe: { kind: 'single', origin: o, microPorts } }
    } else if (noYamlPaths && prof === 'prod') {
      prod = {
        display: pub || 'Same as this app',
        probe: { kind: 'single', origin: pub ?? '', microPorts },
      }
    }

    return { dev, prod, utilizedServices }
  } catch {
    const microPorts = defaultMicroPorts()
    return {
      dev: devEnv ? { display: devEnv, probe: { kind: 'single', origin: devEnv, microPorts } } : null,
      prod: prodEnv ? { display: prodEnv, probe: { kind: 'single', origin: prodEnv, microPorts } } : null,
      utilizedServices: [],
    }
  }
}

function buildColumn(title: string, display: string | null, probe: ProbeResult | null): ColumnState {
  if (display === null) {
    return {
      title,
      display: null,
      groups: [],
      hint:
        title === 'Development'
          ? 'Set VITE_DEV_API_ORIGIN or open this UI against a dev server so the Development column can probe.'
          : 'Set VITE_PROD_API_ORIGIN or open this UI against a prod server so the Production column can probe.',
    }
  }
  if (!probe) {
    return { title, display, groups: [] }
  }
  const row = (label: string, p: ServiceProbe, failPath: string): HealthProbeRow => ({
    label,
    lamp: lampFor(p.ok),
    detail: p.ok
      ? `ts ${p.ts ?? '—'} · ${p.base}`
      : `${failPath} (unreachable or timed out) · ${p.base}`,
  })
  const groups: HealthGroupState[] = [
    {
      title: 'Architecture',
      rows: [
        row('Monitor', probe.server, 'GET /health failed'),
        row('Ops API', probe.ops, 'GET /ops/health failed'),
        row('Docs API', probe.docs, 'GET /research/docs/health failed'),
      ],
    },
    {
      title: 'Account',
      rows: [
        row('Market API', probe.market, 'GET /health failed'),
        row('Trading API', probe.trading, 'GET /health failed'),
        row('Portfolio API', probe.portfolio, 'GET /health failed'),
      ],
    },
    {
      title: 'Research',
      rows: [
        row('Research API', probe.research, 'GET /health failed'),
        row('Strategy API', probe.strategy, 'GET /health failed'),
      ],
    },
    {
      title: 'Feed',
      rows: [row('Massive API', probe.massive, 'GET /research/massive/health failed')],
    },
  ]
  return { title, display, groups }
}

export function ApiHealthOverviewPage({ embeddedInSettings }: ApiHealthOverviewPageProps) {
  const mountedRef = useRef(true)
  const [resolved, setResolved] = useState<{
    dev: ColumnPlan | null
    prod: ColumnPlan | null
    utilizedServices: UtilizedServiceRow[]
  } | null>(null)
  const [devCol, setDevCol] = useState<ColumnState | null>(null)
  const [prodCol, setProdCol] = useState<ColumnState | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string>('—')
  const [probeBusy, setProbeBusy] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    resolveColumnPlans().then((r) => {
      if (mountedRef.current) {
        setResolved({
          dev: r.dev,
          prod: r.prod,
          utilizedServices: r.utilizedServices,
        })
      }
    })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!resolved) return
    setProbeBusy(true)
    try {
      const [dSettled, pSettled] = await Promise.allSettled([
        resolved.dev != null ? probeServices(resolved.dev.probe) : Promise.resolve(null),
        resolved.prod != null ? probeServices(resolved.prod.probe) : Promise.resolve(null),
      ])
      const dProbe = dSettled.status === 'fulfilled' ? dSettled.value : null
      const pProbe = pSettled.status === 'fulfilled' ? pSettled.value : null
      if (!mountedRef.current) return
      setDevCol(
        buildColumn('Development', resolved.dev?.display ?? null, dProbe),
      )
      setProdCol(
        buildColumn('Production', resolved.prod?.display ?? null, pProbe),
      )
      setLastRefresh(new Date().toLocaleTimeString())
    } finally {
      if (mountedRef.current) setProbeBusy(false)
    }
  }, [resolved])

  useEffect(() => {
    if (!resolved) return
    void refresh()
    const t = window.setInterval(() => { void refresh() }, 15_000)
    return () => window.clearInterval(t)
  }, [resolved, refresh])

  const wrapClass = embeddedInSettings
    ? 'settings-page-card massive-api-status-page massive-api-status-page--embedded api-health-overview'
    : 'settings-page-card massive-api-status-page api-health-overview'

  const displayDev =
    devCol ??
    (resolved?.dev
      ? buildColumn('Development', resolved.dev.display, null)
      : null)
  const displayProd =
    prodCol ??
    (resolved?.prod
      ? buildColumn('Production', resolved.prod.display, null)
      : null)

  return (
    <div className={wrapClass}>
      <div className="server-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="services-overview-head">
          <div className="system-tab-panel">
            <div className="daemon-header">
              <div className="daemon-header-main daemon-header-with-lamp">
                <div>
                  <h2 id="services-overview-head" className="daemon-card-title page-title-with-tooltip">
                    Services Overview
                    <InfoTooltip text="Configured routes from YAML utilized.services (GET /health), and live probes for Dev vs Prod. The app uses the same routing rules so a dead dev stack does not break the UI when services are declared prod. Requests time out per probe. Override bases with VITE_DEV_API_ORIGIN and VITE_PROD_API_ORIGIN." />
                  </h2>
                  <p className="massive-api-doc-hint">
                    Last refresh: {lastRefresh}
                    {probeBusy ? ' · Updating…' : ''}
                  </p>
                </div>
              </div>
            </div>

            {!resolved ? (
              <p className="api-health-overview-loading">Resolving…</p>
            ) : (
              <>
                <div className="api-overview-api-scope" aria-labelledby="services-overview-api-head">
                  <h3 id="services-overview-api-head" className="api-overview-scope-title">
                    API
                  </h3>

                  <div className="api-overview-services-section" aria-labelledby="services-overview-configured-head">
                    <h4 id="services-overview-configured-head" className="api-overview-subsection-title api-overview-subsection-title--nested">
                      Configured routes
                      <InfoTooltip text="From YAML utilized.services: map service keys (server/monitor, ops, docs, market, trading, portfolio, research, strategy, massive, ib, …) to dev or prod. Shown under Architecture, Account, Research, and Feed. Restart bifrost-server after YAML changes." />
                    </h4>
                    {resolved.utilizedServices.length === 0 ? (
                      <p className="api-overview-services-empty massive-api-doc-hint">
                        No utilized.services in config, or bifrost-server did not return them (unreachable / timed out).
                      </p>
                    ) : (
                      <div className="api-overview-configured-strip" role="list">
                        {groupUtilizedServicesForOverview(resolved.utilizedServices).map((g) => (
                          <div key={g.title} className="api-overview-configured-category" role="listitem">
                            <span className="api-overview-configured-cat-label">{g.title}</span>
                            <div className="api-overview-configured-chips" role="group" aria-label={g.title}>
                              {g.rows.map((row) => {
                                const pill = envPillVariant(row.env)
                                return (
                                  <div
                                    key={`${row.service}-${row.env}`}
                                    className="api-overview-configured-chip"
                                    title={`${formatServiceLabel(row.service)} → ${formatEnvLabel(row.env)}`}
                                  >
                                    <span className="api-overview-services-name">{formatServiceLabel(row.service)}</span>
                                    <span
                                      className={`api-overview-env-pill api-overview-env-pill--${pill}`}
                                      aria-label={formatEnvLabel(row.env)}
                                    >
                                      <span className="api-overview-env-pill-dot" aria-hidden />
                                      {formatEnvShortLabel(row.env)}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="api-overview-health-section" aria-labelledby="services-overview-health-head">
                    <h4 id="services-overview-health-head" className="api-overview-subsection-title api-overview-subsection-title--nested">
                      Health
                    </h4>
                    <div
                      className="api-health-overview-grid"
                      role="region"
                      aria-label="FastAPI health by environment"
                    >
                      {[displayDev, displayProd].map((col) =>
                        col ? (
                          <div key={col.title} className="api-health-overview-column">
                            <div className="api-health-overview-column-head">
                              <h4 className="api-health-overview-env-title">{col.title}</h4>
                              <span className="api-health-overview-origin">{col.display ?? 'Not configured'}</span>
                            </div>
                            {col.hint ? (
                              <p className="api-health-overview-hint">{col.hint}</p>
                            ) : (
                              <>
                                {col.groups.map((g) => (
                                  <div key={`${col.title}-${g.title}`} className="api-health-overview-group">
                                    <h5 className="api-health-overview-group-title">{g.title}</h5>
                                    <div className="api-health-diagram">
                                      {g.rows.map((row, i) => (
                                        <div key={row.label} className="api-health-diagram-step">
                                          {i > 0 ? <div className="api-health-diagram-line" /> : null}
                                          <div
                                            className={`api-health-diagram-node api-health-diagram-node--${row.lamp}`}
                                            title={row.detail}
                                          />
                                          <div className="api-health-diagram-label">{row.label}</div>
                                          <div className="api-health-diagram-detail">{row.detail}</div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                                {col.groups.length === 0 ? (
                                  <p className="api-health-overview-loading">Checking…</p>
                                ) : null}
                              </>
                            )}
                          </div>
                        ) : null,
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
