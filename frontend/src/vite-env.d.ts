/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute origin for Massive API (Swagger/ReDoc). When unset, UI uses same hostname as the app + `port` from GET /research/massive/health (e.g. http://192.168.x.x:8766). */
  readonly VITE_MASSIVE_API_ORIGIN?: string
}
