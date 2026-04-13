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

/** Feed: IB Stock (single link). Massive Option/Stock submenus are nested under Feed in SettingsPage. */
export const FEED_MASSIVE_OPTION_ID = 'feed-massive-option' as const
export const FEED_MASSIVE_STOCK_ID = 'feed-massive-stock' as const

export const FEED_SUBSECTIONS = [{ id: 'feed-ib-stock', label: 'IB Stock', icon: 'feed-ib' as const }] as const

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
