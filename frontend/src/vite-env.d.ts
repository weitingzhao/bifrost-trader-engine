/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute origin for Massive API (Swagger/ReDoc). When unset, UI uses same hostname as the app + `port` from GET /research/massive/health (e.g. http://192.168.x.x:8766). */
  readonly VITE_MASSIVE_API_ORIGIN?: string
  /** Optional bifrost-server origin for API Health overview (Development column). When unset, same-origin is used only if the loaded YAML profile is dev. */
  readonly VITE_DEV_API_ORIGIN?: string
  /** Optional bifrost-server origin for API Health overview (Production column). When unset, same-origin is used only if the loaded YAML profile is prod. */
  readonly VITE_PROD_API_ORIGIN?: string
}
