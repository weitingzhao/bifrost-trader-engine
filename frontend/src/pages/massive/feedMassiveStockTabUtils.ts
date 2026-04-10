/** Hash segment for Massive Stock feature tabs (under Settings → Feed). */
export const FEED_MASSIVE_STOCK_TAB_PREFIX = 'feed-massive-stock-tab-'

export function feedMassiveStockTabHash(tabId: string): string {
  return `#${FEED_MASSIVE_STOCK_TAB_PREFIX}${tabId}`
}

export function parseFeedMassiveStockTabFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h.startsWith(FEED_MASSIVE_STOCK_TAB_PREFIX)) {
    return h.slice(FEED_MASSIVE_STOCK_TAB_PREFIX.length) || null
  }
  return null
}

/** Legacy scroll anchor: feed-massive-stock-svc-<id> */
export function parseFeedMassiveStockSvcFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h.startsWith('feed-massive-stock-svc-')) {
    return h.slice('feed-massive-stock-svc-'.length) || null
  }
  return null
}

const FEED_MASSIVE_STOCK_PAGE = 'feed-massive-stock'

/** Hash: open Feed → Massive Stock → Tickers sub-tab (REST / Reference DB). */
export const FEED_MASSIVE_STOCK_TICKERS_SUB_PREFIX = 'feed-massive-stock-tk-'

export const MASSIVE_STOCK_TICKERS_SUB_TABS = [
  'all_tickers',
  'ticker_overview',
  'ticker_types',
  'related_tickers',
  'reference_db',
] as const

export type MassiveStockTickersSubTab = (typeof MASSIVE_STOCK_TICKERS_SUB_TABS)[number]

const TICKERS_SUB_TAB_SET = new Set<string>(MASSIVE_STOCK_TICKERS_SUB_TABS)

export function feedMassiveStockTickersSubHash(sub: MassiveStockTickersSubTab): string {
  return `#${FEED_MASSIVE_STOCK_TICKERS_SUB_PREFIX}${sub}`
}

export function parseFeedMassiveStockTickersSubTabFromHash(hash: string): MassiveStockTickersSubTab | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h.startsWith(FEED_MASSIVE_STOCK_TICKERS_SUB_PREFIX)) return null
  const rest = h.slice(FEED_MASSIVE_STOCK_TICKERS_SUB_PREFIX.length)
  if (TICKERS_SUB_TAB_SET.has(rest)) return rest as MassiveStockTickersSubTab
  return null
}

/** True when Settings → Feed should show the Massive Stock page (incl. capability anchors). */
export function isMassiveStockFeedHash(hash: string): boolean {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h === FEED_MASSIVE_STOCK_PAGE) return true
  if (h.startsWith('feed-massive-stock-svc-')) return true
  if (h.startsWith(FEED_MASSIVE_STOCK_TAB_PREFIX)) return true
  if (h.startsWith(FEED_MASSIVE_STOCK_TICKERS_SUB_PREFIX)) return true
  return false
}

/** DOM id prefix for Massive Stock service checklist → section scroll targets. */
export function feedMassiveStockSvcAnchorId(serviceId: string): string {
  return `feed-massive-stock-svc-${serviceId}`
}
