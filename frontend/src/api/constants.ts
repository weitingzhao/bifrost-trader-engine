import {
  getServerApiBase,
  getMassiveApiBase,
  getDocsApiBase,
  initApiRouting,
  joinServiceBase,
} from './apiRouting'

export {
  getServerApiBase,
  getMassiveApiBase,
  getDocsApiBase,
  initApiRouting,
  joinServiceBase,
}

/** Main bifrost-server API prefix (empty = same origin). Set after `initApiRouting()` in main.tsx. */
export function apiBase(): string {
  return getServerApiBase()
}
