/// <reference types="vite/client" />

/** Injected by Vite `define` in vite.config.ts (package version · git short SHA · UTC time at dev/build start). */
declare const __UI_BUILD_LABEL__: string

interface ImportMetaEnv {
  /** Optional main bifrost-server origin (e.g. when UI is served separately). When unset, same-origin relative paths are used. */
  readonly VITE_API_BASE?: string
  /** Optional absolute origin for Massive API (Swagger/ReDoc). When unset, UI uses same hostname as the app + `port` from GET /research/massive/health (e.g. http://192.168.x.x:8766). */
  readonly VITE_MASSIVE_API_ORIGIN?: string
  /** Optional absolute origin for merged Docs API (Swagger/ReDoc). */
  readonly VITE_DOCS_API_ORIGIN?: string
  /** Optional absolute origin for Ops control plane API. */
  readonly VITE_OPS_API_ORIGIN?: string
  /** Optional absolute origin for Research API (option discovery, max pain). */
  readonly VITE_RESEARCH_API_ORIGIN?: string
  /** Optional bifrost-server origin for API Health overview (Development column). When unset, same-origin is used only if the loaded YAML profile is dev. */
  readonly VITE_DEV_API_ORIGIN?: string
  /** Optional bifrost-server origin for API Health overview (Production column). When unset, same-origin is used when config_profile is prod or utilized.services are all prod (config.yaml-only deploy). */
  readonly VITE_PROD_API_ORIGIN?: string
}
