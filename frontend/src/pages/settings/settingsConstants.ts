import type { FlexAccountItem } from '../../types'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT_TYPE = 'tws_paper'
export const DEFAULT_DAEMON = 1
export const DEFAULT_LISTENER = 2
export const DEFAULT_IB_OPERATOR = 100
export const DEFAULT_WORKER = 500
/** IB ingestor client ID default (YAML ib.host.client_id.ingestor). */
export const DEFAULT_IB_INGESTOR = 150
/** IB Account Agent defaults (YAML ib.host / ib.secondary client_id.account_agent). */
export const DEFAULT_IB_ACCOUNT_AGENT = 151
export const DEFAULT_IB_ACCOUNT_AGENT_SECONDARY = 152
export const DEFAULT_HEARTBEAT_SEC = 10

/** Status / read-only view (sidebar group: Status). */
export const STATUS_SECTIONS = [{ id: 'settings-daemon', label: 'Daemon', icon: 'system' as const }] as const

/** Editable app config (sidebar group: Settings). */
export const CONFIG_SECTIONS = [
  { id: 'settings-heartbeat', label: 'Daemon App', icon: 'heartbeat' as const },
  { id: 'settings-ib-connection', label: 'IB Configure', icon: 'plug' as const },
  { id: 'settings-holidays', label: 'US market holidays', icon: 'calendar' as const },
] as const

/** Legacy hash before Overview was split; Settings redirects to summary. */
export const COVERAGE_OVERVIEW_LEGACY_ID = 'coverage-overview' as const

export const COVERAGE_OVERVIEW_GROUP_LABEL = 'Overview' as const

/** Data Coverage → Overview → Summary (aggregates); Detail is per-symbol matrix. */
export const COVERAGE_OVERVIEW_SUBSECTIONS = [
  {
    id: 'coverage-overview-summary' as const,
    label: 'Summary' as const,
    icon: 'coverage-overview' as const,
  },
  {
    id: 'coverage-overview-detail' as const,
    label: 'Detail' as const,
    icon: 'coverage-overview-detail' as const,
  },
] as const

/** Primary shortcut (summary aggregates) — same role as legacy single “Overview” page. */
export const COVERAGE_OVERVIEW_SUBSECTION = COVERAGE_OVERVIEW_SUBSECTIONS[0]

export const COVERAGE_OVERVIEW_SUMMARY_ID = COVERAGE_OVERVIEW_SUBSECTIONS[0].id
export const COVERAGE_OVERVIEW_DETAIL_ID = COVERAGE_OVERVIEW_SUBSECTIONS[1].id

export function isCoverageOverviewSectionHash(hash: string): boolean {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  return (
    h === COVERAGE_OVERVIEW_LEGACY_ID ||
    COVERAGE_OVERVIEW_SUBSECTIONS.some(s => s.id === h)
  )
}

/** Data Coverage → Option (top-level). */
export const COVERAGE_OPTION_SUBSECTION = {
  id: 'coverage-option' as const,
  label: 'Option' as const,
  icon: 'coverage-option' as const,
}

/** Data Coverage → Stock (first level) → these routes (second level). Hash ids unchanged. */
export const COVERAGE_STOCK_GROUP_LABEL = 'Stock' as const

export const COVERAGE_STOCK_SUBSECTIONS = [
  { id: 'coverage-stock' as const, label: 'IB Live (Redis)' as const, icon: 'coverage-stock' as const },
  { id: 'coverage-massive-stock' as const, label: 'Massive Delay (DB)' as const, icon: 'feed-massive-stock' as const },
] as const

export function isCoverageStockHash(hash: string): boolean {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  return h === 'coverage-stock' || h === 'coverage-massive-stock'
}

/** Feed: Interactive Brokers (single link, hash feed-ib-stock). Massive Overview / Common / Option / Stock nested under Feed → Massive in SettingsPage. */
export const FEED_MASSIVE_OVERVIEW_ID = 'feed-massive-overview' as const
export const FEED_MASSIVE_COMMON_ID = 'feed-massive-common' as const
export const FEED_MASSIVE_OPTION_ID = 'feed-massive-option' as const
export const FEED_MASSIVE_STOCK_ID = 'feed-massive-stock' as const

export const FEED_INTERACTIVE_BROKERS_LABEL = 'Interactive Brokers' as const

export const FEED_SUBSECTIONS = [{ id: 'feed-ib-stock', label: FEED_INTERACTIVE_BROKERS_LABEL, icon: 'feed-ib' as const }] as const

/** All sections in sidebar order (Status first, then Settings). Used for hash fallback etc. */
export const SETTINGS_SECTIONS = [...STATUS_SECTIONS, ...CONFIG_SECTIONS] as const

/** Sub-anchors for IB Configure: table groups + Flex Preference (under IB Preference section). */
export const IB_CONNECTION_SUBSECTIONS = [
  { id: 'ib-users', label: 'User (YAML)', icon: 'user-host' as const },
  { id: 'ib-client-ids', label: 'Client ID (YAML)', icon: 'user-host' as const },
  { id: 'ib-account', label: 'Account', icon: 'stream' as const },
  { id: 'ib-flex-query', label: 'Flex Query', icon: 'flex' as const },
  { id: 'flex-preference', label: 'Flex Preference', icon: 'flex' as const },
] as const

/** Fixed Flex query types: one row per type, no add/remove. Each maps to a future feature. */
export const FLEX_QUERY_TYPES = [
  { purpose: 'cash_transactions' as const, label: 'Cash Transactions' },
  { purpose: 'trades' as const, label: 'Trades' },
] as const

export function getDefaultFlexRows(): FlexAccountItem[] {
  return FLEX_QUERY_TYPES.map(({ purpose, label }) => ({
    purpose,
    query_label: label,
    query_host_id: '',
    query_secondary_id: '',
  }))
}
