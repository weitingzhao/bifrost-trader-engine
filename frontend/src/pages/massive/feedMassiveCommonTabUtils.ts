import { FEED_MASSIVE_OVERVIEW_ID } from '../settings/settingsConstants'
import { isMassiveOptionFeedHash } from './feedMassiveTabUtils'
import { isMassiveStockFeedHash } from './feedMassiveStockTabUtils'

/** Scroll anchor: feed-massive-common-svc-<capId> (shared REST caps: technical-indicators, market-ops). */
const PREFIX = 'feed-massive-common-svc-'

const FEED_MASSIVE_COMMON_PAGE = 'feed-massive-common'

export function feedMassiveCommonSvcAnchorId(serviceId: string): string {
  return `${PREFIX}${serviceId}`
}

export function parseFeedMassiveCommonSvcFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h.startsWith(PREFIX)) {
    return h.slice(PREFIX.length) || null
  }
  return null
}

/** True when Settings → Feed should show the Massive Common page (shared TI + Market Ops). */
export function isMassiveCommonFeedHash(hash: string): boolean {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (h === FEED_MASSIVE_COMMON_PAGE) return true
  if (h.startsWith(PREFIX)) return true
  return false
}

/** Settings → Feed → Massive → Overview (capabilities across Stock / Option / Common). */
export function isMassiveOverviewFeedHash(hash: string): boolean {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  return h === FEED_MASSIVE_OVERVIEW_ID
}

/** Any Massive feed route (overview, stock, option, or common). */
export function isAnyMassiveFeedHash(hash: string): boolean {
  const norm = hash.startsWith('#') ? hash : `#${hash}`
  return (
    isMassiveOverviewFeedHash(norm) ||
    isMassiveCommonFeedHash(norm) ||
    isMassiveOptionFeedHash(norm) ||
    isMassiveStockFeedHash(norm)
  )
}

export function commonHashForLegacyTiMoHash(rawHashWithoutPound: string): string | null {
  if (rawHashWithoutPound === 'feed-massive-svc-technical-indicators' || rawHashWithoutPound === 'feed-massive-tab-technical-indicators') {
    return feedMassiveCommonSvcAnchorId('technical-indicators')
  }
  if (rawHashWithoutPound === 'feed-massive-svc-market-ops' || rawHashWithoutPound === 'feed-massive-tab-market-ops') {
    return feedMassiveCommonSvcAnchorId('market-ops')
  }
  return null
}
