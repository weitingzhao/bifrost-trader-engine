import { InfoTooltip } from '../../components/InfoTooltip'
import type { UtilizedServiceRow } from '../../utils/utilizedServices'

export interface ApiConfiguredRoutesSectionProps {
  utilizedServices: UtilizedServiceRow[]
  /** DOM id for the "Configured routes" h4 (must be unique per page). */
  configuredHeadingId: string
}

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
  if (['trading', 'portfolio'].includes(k)) return 'Account'
  if (['research', 'strategy', 'market'].includes(k)) return 'Research'
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

/**
 * "Configured routes" block from Services Overview (YAML utilized.services → dev/prod chips by category).
 */
export function ApiConfiguredRoutesSection({
  utilizedServices,
  configuredHeadingId,
}: ApiConfiguredRoutesSectionProps) {
  return (
    <div className="api-overview-services-section" aria-labelledby={configuredHeadingId}>
      <h4 id={configuredHeadingId} className="api-overview-subsection-title api-overview-subsection-title--nested">
        Configured routes
        <InfoTooltip text="From YAML utilized.services: map service keys (server/monitor, ops, docs, market, trading, portfolio, research, strategy, massive, ib, …) to dev or prod. Shown under Architecture, Account, Research, and Feed. Restart bifrost-server after YAML changes." />
      </h4>
      {utilizedServices.length === 0 ? (
        <p className="api-overview-services-empty massive-api-doc-hint">
          No utilized.services in config, or bifrost-server did not return them (unreachable / timed out).
        </p>
      ) : (
        <div className="api-overview-configured-strip" role="list">
          {groupUtilizedServicesForOverview(utilizedServices).map((g) => (
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
  )
}
