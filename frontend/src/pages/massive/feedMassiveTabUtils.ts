/** Hash segment for Massive Option feature tabs (under Settings → Feed). */
export const FEED_MASSIVE_TAB_PREFIX = 'feed-massive-tab-'

export function feedMassiveTabHash(tabId: string): string {
  return `#${FEED_MASSIVE_TAB_PREFIX}${tabId}`
}

export function parseFeedMassiveTabFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h.startsWith(FEED_MASSIVE_TAB_PREFIX)) {
    return h.slice(FEED_MASSIVE_TAB_PREFIX.length) || null
  }
  return null
}

/** Legacy scroll anchor: feed-massive-svc-<id> */
export function parseFeedMassiveSvcFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h.startsWith('feed-massive-svc-')) {
    return h.slice('feed-massive-svc-'.length) || null
  }
  return null
}

export const FEED_MASSIVE_DEFAULT_TAB_ID = 'reference'
