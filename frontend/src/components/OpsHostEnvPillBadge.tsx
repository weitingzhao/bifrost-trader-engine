import type { OpsHostEnvPill } from '../utils/opsHostEnvPill'

export function OpsHostEnvPillBadge({
  pill,
  className,
  title,
}: {
  pill: OpsHostEnvPill
  /** e.g. dashboard layout helpers */
  className?: string
  /** Native tooltip (e.g. config profile source). */
  title?: string
}) {
  const extra = className ? ` ${className}` : ''
  return (
    <span
      className={`api-overview-env-pill api-overview-env-pill--${pill.pillVariant}${extra}`}
      aria-label={pill.ariaLabel}
      title={title}
    >
      <span className="api-overview-env-pill-dot" aria-hidden />
      {pill.shortLabel}
    </span>
  )
}
