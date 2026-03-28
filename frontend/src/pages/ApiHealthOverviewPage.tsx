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

type ProbeKind =
  | { kind: 'single'; origin: ApiOriginBase; researchPort?: number }
  | {
      kind: 'split'
      scheme: string
      host: string
      serverPort: number
      massivePort: number
      docsPort: number
      opsPort: number
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
  research: ServiceProbe
}

interface ColumnState {
  title: string
  display: string | null
  rows: Array<{
    label: string
    lamp: Lamp
    detail: string
  }>
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
  return service.charAt(0).toUpperCase() + service.slice(1)
}

function formatEnvLabel(env: string): string {
  const t = env.toLowerCase()
  if (t === 'dev') return 'Development'
  if (t === 'prod') return 'Production'
  return env
}

function lampFor(ok: boolean | null): Lamp {
  if (ok === true) return 'green'
  if (ok === false) return 'red'
  return 'none'
}

function _researchProbeOrigin(kind: ProbeKind): string {
  const rp =
    kind.kind === 'split'
      ? kind.researchPort
      : (kind.researchPort ?? 8773)
  if (kind.kind === 'split') {
    return `${kind.scheme}://${kind.host}:${rp}`
  }
  const o = kind.origin
  try {
    const raw =
      o && o.trim() !== ''
        ? o.includes('://')
          ? o
          : `http://${o}`
        : typeof window !== 'undefined'
          ? window.location.origin
          : 'http://127.0.0.1'
    const u = new URL(raw)
    const scheme = (u.protocol || 'http:').replace(':', '') || 'http'
    const host = u.hostname || '127.0.0.1'
    return `${scheme}://${host}:${rp}`
  } catch {
    return `http://127.0.0.1:${rp}`
  }
}

async function probeServices(kind: ProbeKind): Promise<ProbeResult> {
  const tmo = { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS }
  const oRes = _researchProbeOrigin(kind)
  if (kind.kind === 'single') {
    const o = kind.origin
    const baseLabel = o === '' ? '(same origin as this app)' : o
    const [sr, mr, dr, or, rr] = await Promise.allSettled([
      fetchHealthAtOrigin(o, tmo),
      fetchMassiveApiHealthAtOrigin(o, tmo),
      fetchDocsApiHealthAtOrigin(o, tmo),
      fetchOpsHealthAtOrigin(o, tmo),
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
      research: {
        ok: rr.status === 'fulfilled',
        ts: rr.status === 'fulfilled' ? rr.value.ts : undefined,
        base: oRes,
      },
    }
  }
  const { scheme, host, serverPort, massivePort, docsPort, opsPort } = kind
  const oS = `${scheme}://${host}:${serverPort}`
  const oM = `${scheme}://${host}:${massivePort}`
  const oD = `${scheme}://${host}:${docsPort}`
  const oO = `${scheme}://${host}:${opsPort}`
  const [sr, mr, dr, or, rr] = await Promise.allSettled([
    fetchHealthAtOrigin(oS, tmo),
    fetchMassiveApiHealthAtOrigin(oM, tmo),
    fetchDocsApiHealthAtOrigin(oD, tmo),
    fetchOpsHealthAtOrigin(oO, tmo),
    fetchResearchApiHealthAtOrigin(oRes, tmo),
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
    research: {
      ok: rr.status === 'fulfilled',
      ts: rr.status === 'fulfilled' ? rr.value.ts : undefined,
      base: oRes,
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
    let researchPort = 8773
    try {
      const h = await fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
      utilizedServices = normalizeUtilizedServices(h?.utilized_services)
      if (typeof h?.research_port === 'number' && Number.isFinite(h.research_port)) {
        researchPort = h.research_port
      }
    } catch {
      // same-origin /health may be unreachable; leave Services empty
    }
    return {
      dev: { display: devEnv, probe: { kind: 'single', origin: devEnv, researchPort } },
      prod: { display: prodEnv, probe: { kind: 'single', origin: prodEnv, researchPort } },
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
      const d = 8773
      return {
        dev: devEnv ? { display: devEnv, probe: { kind: 'single', origin: devEnv, researchPort: d } } : null,
        prod: prodEnv ? { display: prodEnv, probe: { kind: 'single', origin: prodEnv, researchPort: d } } : null,
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
    const rp =
      typeof h?.research_port === 'number' && Number.isFinite(h.research_port) ? h.research_port : 8773
    const noYamlPaths = cfgDev == null && cfgProd == null

    let dev: ColumnPlan | null = null
    if (devEnv) {
      dev = { display: devEnv, probe: { kind: 'single', origin: devEnv, researchPort: rp } }
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
            researchPort: rp,
          },
        }
      } catch {
        const o = cfgDev.replace(/\/$/, '')
        dev = { display: o, probe: { kind: 'single', origin: o, researchPort: rp } }
      }
    } else if (noYamlPaths && prof === 'dev') {
      dev = {
        display: pub || 'Same as this app',
        probe: { kind: 'single', origin: pub ?? '', researchPort: rp },
      }
    }

    let prod: ColumnPlan | null = null
    if (prodEnv) {
      prod = { display: prodEnv, probe: { kind: 'single', origin: prodEnv, researchPort: rp } }
    } else if (cfgProd) {
      const o = cfgProd.replace(/\/$/, '')
      prod = { display: o, probe: { kind: 'single', origin: o, researchPort: rp } }
    } else if (noYamlPaths && prof === 'prod') {
      prod = {
        display: pub || 'Same as this app',
        probe: { kind: 'single', origin: pub ?? '', researchPort: rp },
      }
    }

    return { dev, prod, utilizedServices }
  } catch {
    const d = 8773
    return {
      dev: devEnv ? { display: devEnv, probe: { kind: 'single', origin: devEnv, researchPort: d } } : null,
      prod: prodEnv ? { display: prodEnv, probe: { kind: 'single', origin: prodEnv, researchPort: d } } : null,
      utilizedServices: [],
    }
  }
}

function buildColumn(title: string, display: string | null, probe: ProbeResult | null): ColumnState {
  if (display === null) {
    return {
      title,
      display: null,
      rows: [],
      hint:
        title === 'Development'
          ? 'Set VITE_DEV_API_ORIGIN or open this UI against a dev server so the Development column can probe.'
          : 'Set VITE_PROD_API_ORIGIN or open this UI against a prod server so the Production column can probe.',
    }
  }
  if (!probe) {
    return { title, display, rows: [] }
  }
  const row = (label: string, p: ServiceProbe, failPath: string) => ({
    label,
    lamp: lampFor(p.ok),
    detail: p.ok
      ? `ts ${p.ts ?? '—'} · ${p.base}`
      : `${failPath} (unreachable or timed out) · ${p.base}`,
  })
  return {
    title,
    display,
    rows: [
      row('Bifrost server', probe.server, 'GET /health failed'),
      row('Massive API', probe.massive, 'GET /research/massive/health failed'),
      row('Docs API', probe.docs, 'GET /research/docs/health failed'),
      row('Ops API', probe.ops, 'GET /ops/health failed'),
      row('Research API', probe.research, 'GET /health failed'),
    ],
  }
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
        <section className="replay-section" aria-labelledby="api-overview-head">
          <div className="system-tab-panel">
            <div className="daemon-header">
              <div className="daemon-header-main daemon-header-with-lamp">
                <div>
                  <h2 id="api-overview-head" className="daemon-card-title page-title-with-tooltip">
                    API Overview
                    <InfoTooltip text="Services: from YAML utilized.services (via GET /health). The rest of this app uses the same rules to call Massive/Docs APIs (prod vs dev) so a dead dev stack does not break the UI when everything is declared prod. Health: Development and Production columns probe FastAPI endpoints; each request times out so a dead service does not freeze the page. Override bases with VITE_DEV_API_ORIGIN and VITE_PROD_API_ORIGIN." />
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
                <div className="api-overview-services-section" aria-labelledby="api-overview-services-head">
                  <h3 id="api-overview-services-head" className="api-overview-subsection-title">
                    Services
                    <InfoTooltip text="Declared in YAML as utilized.services (which sidecar stack each service uses). Values come from GET /health on the running bifrost-server (loaded at process start from your merged config — edit YAML alone does not apply until you restart that server). Not the same as the Health section column titles: those probe frontend.dev_path vs frontend.prod_path hosts." />
                  </h3>
                  {resolved.utilizedServices.length === 0 ? (
                    <p className="api-overview-services-empty massive-api-doc-hint">
                      No utilized.services in config, or bifrost-server did not return them (unreachable / timed out).
                    </p>
                  ) : (
                    <ul className="api-overview-services-list">
                      {resolved.utilizedServices.map((row) => (
                        <li key={`${row.service}-${row.env}`}>
                          <span className="api-overview-services-name">{formatServiceLabel(row.service)}</span>
                          <span className="api-overview-services-arrow" aria-hidden>
                            {' '}
                            →{' '}
                          </span>
                          <span className="api-overview-services-env">{formatEnvLabel(row.env)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="api-overview-health-section" aria-labelledby="api-overview-health-head">
                  <h3 id="api-overview-health-head" className="api-overview-subsection-title">
                    Health
                  </h3>
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
                          <div className="api-health-diagram">
                            {col.rows.map((row, i) => (
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
                          {col.rows.length === 0 ? (
                            <p className="api-health-overview-loading">Checking…</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null,
                )}
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
