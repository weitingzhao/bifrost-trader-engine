import {
  getServerApiBase,
  getServerApiBaseForBrowser,
  getMassiveApiBase,
  getDocsApiBase,
  getOpsApiBase,
  getOpsApiBaseForBrowser,
  getMarketApiBase,
  getResearchApiBase,
  getResearchApiBaseForBrowser,
  initApiRouting,
  joinServiceBase,
} from './apiRouting'

export {
  getServerApiBase,
  getServerApiBaseForBrowser,
  getMassiveApiBase,
  getDocsApiBase,
  getOpsApiBase,
  getOpsApiBaseForBrowser,
  getMarketApiBase,
  getResearchApiBase,
  getResearchApiBaseForBrowser,
  initApiRouting,
  joinServiceBase,
}

/** Main bifrost-server API prefix (empty = same origin). Set after `initApiRouting()` in main.tsx. */
export function apiBase(): string {
  return getServerApiBaseForBrowser()
}
