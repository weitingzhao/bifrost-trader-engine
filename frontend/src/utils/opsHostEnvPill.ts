/** Matches Services Overview env chips (`api-overview-env-pill--*`). */
export type OpsHostEnvPillVariant = 'dev' | 'prod' | 'other'

export interface OpsHostEnvPill {
  shortLabel: string
  pillVariant: OpsHostEnvPillVariant
  ariaLabel: string
}

/** Map Ops GET /health `config_profile` to Dev/Prod pill (same rules as ApiConfiguredRoutesSection). */
export function opsHostEnvFromConfigProfile(configProfile: string | null | undefined): OpsHostEnvPill {
  const p = (configProfile ?? '').toLowerCase().trim()
  if (p === 'dev' || p === 'development') {
    return { shortLabel: 'Dev', pillVariant: 'dev', ariaLabel: 'Development' }
  }
  if (p === 'prod' || p === 'production') {
    return { shortLabel: 'Prod', pillVariant: 'prod', ariaLabel: 'Production' }
  }
  return { shortLabel: '—', pillVariant: 'other', ariaLabel: 'Unknown environment' }
}
