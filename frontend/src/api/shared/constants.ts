import {
  getServerApiBase,
  getMassiveApiBase,
  getDocsApiBase,
  getOpsApiBase,
  initApiRouting,
  joinServiceBase,
} from './apiRouting'

export {
  getServerApiBase,
  getMassiveApiBase,
  getDocsApiBase,
  getOpsApiBase,
  initApiRouting,
  joinServiceBase,
}

/** Main bifrost-server API prefix (empty = same origin). Set after `initApiRouting()` in main.tsx. */
export function apiBase(): string {
  return getServerApiBase()
}
