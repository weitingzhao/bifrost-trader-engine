/**
 * Maps /settings/[...slug] segments to the legacy Settings hash anchor.
 * Deep navigation within a section still uses `location.hash`.
 */

const FEED_MASSIVE_OVERVIEW_ID = 'feed-massive-overview' as const
const FEED_MASSIVE_COMMON_ID = 'feed-massive-common' as const
const FEED_MASSIVE_OPTION_ID = 'feed-massive-option' as const
const FEED_MASSIVE_STOCK_ID = 'feed-massive-stock' as const
const FEED_MASSIVE_DAILY_DATA_ID = 'feed-massive-daily-data' as const

const COVERAGE_OVERVIEW_LEGACY_ID = 'coverage-overview' as const
const COVERAGE_OVERVIEW_SUBSECTION_IDS = ['coverage-overview-summary', 'coverage-overview-detail'] as const

// ---------------------------------------------------------------------------
// Hash query helpers — used by AppLayout header shortcuts to determine which
// settings section is currently active.
// ---------------------------------------------------------------------------

export function settingsHashKey(hash: string): string {
  return (hash.startsWith('#') ? hash.slice(1) : hash).trim()
}

export function isDaemonSettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-daemon' || h === 'settings-system' || h === 'settings-system-daemon'
}

export function isSocketSettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return (
    h === 'settings-ws-connector' ||
    h === 'settings-market-ingest' ||
    h === 'settings-ib-connector' ||
    h === 'settings-ws-agent'
  )
}

export function isCelerySettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-celery' || h === 'settings-system-celery' || h === 'settings-dashboard-celery'
}

export function isCoverageOverviewHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === COVERAGE_OVERVIEW_LEGACY_ID || (COVERAGE_OVERVIEW_SUBSECTION_IDS as readonly string[]).includes(h)
}

export function isCoverageOptionHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'coverage-option' || h === FEED_MASSIVE_DAILY_DATA_ID
}

export function settingsPathFromSlug(segments: readonly string[]): string {
  if (segments.length === 0) return '/settings'
  return `/settings/${segments.join('/')}`
}

export function slugToDefaultHash(segments: readonly string[]): string {
  const a = segments[0] ?? ''
  const b = segments[1] ?? ''
  switch (a) {
    case 'system':
      return '#settings-daemon'
    case 'config':
      return '#settings-heartbeat'
    case 'api':
      return '#settings-api'
    case 'coverage':
      if (b === 'detail') return '#coverage-overview-detail'
      if (b === 'option') return '#coverage-option'
      if (b === 'stock') return '#coverage-stock'
      if (b === 'massive-stock') return '#coverage-massive-stock'
      return '#coverage-overview-summary'
    case 'feed':
      return '#feed-ib-stock'
    case 'massive':
      if (b === 'stock') return '#feed-massive-stock'
      if (b === 'option') return '#feed-massive-option'
      if (b === 'common') return '#feed-massive-common'
      if (b === 'daily') return '#feed-massive-daily-data'
      return '#feed-massive-overview'
    case 'celery':
      return '#settings-celery'
    case 'subscribe':
      return '#settings-subscribe'
    case 'ingest':
      return '#settings-ws-connector'
    default:
      return '#settings-daemon'
  }
}

/** Pick canonical `/settings/...` path for a legacy settings hash (used by header shortcuts). */
export function settingsBasePathForHash(hash: string): string {
  const h = (hash.startsWith('#') ? hash.slice(1) : hash).trim()
  if (h.startsWith('settings-api') || h === 'settings-services-overview') return '/settings/api'
  if (h.startsWith('settings-celery') || h === 'feed-celery' || h.startsWith('settings-dashboard-celery')) {
    return '/settings/celery'
  }
  if (h === 'settings-daemon' || h.startsWith('settings-system')) return '/settings/system'
  if (
    h === 'settings-heartbeat' ||
    h === 'settings-ib-connection' ||
    h.startsWith('ib-') ||
    h === 'flex-preference'
  ) {
    return '/settings/config'
  }
  if (
    h === 'settings-ws-connector' ||
    h === 'settings-market-ingest' ||
    h === 'settings-ib-connector' ||
    h === 'settings-ws-agent'
  ) {
    return '/settings/ingest'
  }
  if (h === 'settings-subscribe') return '/settings/subscribe'
  if (h.startsWith('coverage-')) return '/settings/coverage'
  if (h.startsWith('feed-massive')) {
    if (h === FEED_MASSIVE_STOCK_ID) return '/settings/massive/stock'
    if (h === FEED_MASSIVE_OPTION_ID) return '/settings/massive/option'
    if (h === FEED_MASSIVE_COMMON_ID || h.startsWith('feed-massive-common-svc-')) return '/settings/massive/common'
    if (h === FEED_MASSIVE_DAILY_DATA_ID) return '/settings/massive/daily'
    if (h === FEED_MASSIVE_OVERVIEW_ID) return '/settings/massive'
    return '/settings/massive'
  }
  if (h.startsWith('feed-')) return '/settings/feed'
  return '/settings'
}
