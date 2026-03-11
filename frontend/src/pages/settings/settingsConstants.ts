import type { FlexAccountItem } from '../../types'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT_TYPE = 'tws_paper'
export const DEFAULT_DAEMON = 1
export const DEFAULT_LISTENER = 2
export const DEFAULT_REFRESH_EXECUTIONS = 100
export const DEFAULT_BARS_FETCH = 101
export const DEFAULT_WORKER = 500
export const DEFAULT_HEARTBEAT_SEC = 10

export const SETTINGS_SECTIONS = [
  { id: 'settings-heartbeat', label: 'Daemon App', icon: 'heartbeat' },
  { id: 'settings-ib-connection', label: 'IB Settings', icon: 'plug' },
  { id: 'settings-holidays', label: 'US market holidays', icon: 'calendar' },
  { id: 'settings-key-value', label: 'Key-Value Config', icon: 'key-value' },
] as const

export const IB_CONNECTION_SUBSECTIONS = [
  { id: 'ib-primary', label: 'Host User', icon: 'user-host' },
  { id: 'ib-second', label: 'Second User', icon: 'user-second' },
  { id: 'ib-trading-account', label: 'Trading account', icon: 'user-host' },
  { id: 'ib-stream-accounts', label: 'Stream accounts (Live)', icon: 'stream' },
  { id: 'ib-client-ids', label: 'Client IDs', icon: 'id' },
  { id: 'ib-flex', label: 'Flex Settings', icon: 'flex' },
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
