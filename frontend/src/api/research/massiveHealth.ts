import {
  getMassiveApiBase,
  getDocsApiBase,
  getOpsApiBase,
  getResearchApiBaseForBrowser,
  joinServiceBase,
} from '../shared/apiRouting'
import { fetchWithTimeout } from '../shared/fetchTimeout'
import { isDevBuild } from '@/lib/publicEnv'
import { opsAuthHeaders, opsControlFailureMessage, type OpsCapabilities } from '../ops/ops'

function massiveUrl(path: string): string {
  const base = getMassiveApiBase()
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (isDevBuild() && typeof window !== 'undefined') {
    const b = base.replace(/\/$/, '')
    if (!b) {
      return normalizedPath
    }
    try {
      const apiOrigin = new URL(b).origin
      if (apiOrigin !== window.location.origin) {
        return normalizedPath
      }
    } catch {
      /* fall through */
    }
  }
  return joinServiceBase(base, path)
}

function researchApiUrl(path: string): string {
  return joinServiceBase(getResearchApiBaseForBrowser(), path)
}

function docsUrl(path: string): string {
  return joinServiceBase(getDocsApiBase(), path)
}

function opsMassiveJobsUrl(path: string): string {
  if (path.startsWith('?')) {
    return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${path}`)
  }
  const p = path.startsWith('/') ? path : `/${path}`
  return joinServiceBase(getOpsApiBase(), `/ops/research/massive/jobs${p}`)
}

export interface MassiveApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  /** Listening port of the Massive FastAPI process (from YAML `server.massive_port`). */
  port?: number
  /** Resolved absolute path of the loaded config file (startup). */
  config_path?: string | null
}

export async function fetchMassiveApiHealth(options?: { timeoutMs?: number }): Promise<MassiveApiHealthResponse> {
  const url = massiveUrl('/research/massive/health')
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(`Massive API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-massive',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

/** Health from GET /health on the Docs FastAPI process (same payload as /research/docs/health). */
export interface DocsApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  /** Listening port of the Docs FastAPI process (from YAML `server.docs_port`). */
  port?: number
  config_path?: string | null
  /** Upstream URLs used to build merged OpenAPI. */
  main_url: string
  massive_url: string
  research_url: string
}

export async function fetchDocsApiHealth(): Promise<DocsApiHealthResponse> {
  const r = await fetch(docsUrl('/health'))
  if (!r.ok) throw new Error(`Docs API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-docs',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
    main_url: typeof j.main_url === 'string' ? j.main_url : '',
    massive_url: typeof j.massive_url === 'string' ? j.massive_url : '',
    research_url: typeof j.research_url === 'string' ? j.research_url : '',
  }
}

/** Same shape as GET /ops/auth/capabilities (shared ops.auth tokens). */
export async function fetchDocsCapabilities(): Promise<OpsCapabilities> {
  const r = await fetch(docsUrl('/research/docs/auth/capabilities'), { headers: opsAuthHeaders() })
  const text = await r.text()
  try {
    return JSON.parse(text) as OpsCapabilities
  } catch {
    throw new Error(
      `Docs API returned non-JSON response (HTTP ${r.status}${text ? `, body: ${text.slice(0, 120)}` : ''}).`,
    )
  }
}

/** Absolute origin (no trailing slash) or empty string for same-origin as the UI. */
export type ApiOriginBase = string

function joinApiOrigin(origin: ApiOriginBase, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const o = origin.replace(/\/$/, '')
  return o ? `${o}${p}` : p
}

/** GET /health on bifrost-server at the given origin (CORS must allow this UI origin when cross-origin). */
export async function fetchHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<{
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod'
}> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-server',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile,
  }
}

export async function fetchMassiveApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<MassiveApiHealthResponse> {
  const url = joinApiOrigin(origin, '/research/massive/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Massive API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-massive',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export interface ResearchApiHealthResponse {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod' | null
  port?: number
  config_path?: string | null
}

export async function fetchResearchApiHealth(options?: { timeoutMs?: number }): Promise<ResearchApiHealthResponse> {
  const url = researchApiUrl('/health')
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, {}, options.timeoutMs)
      : await fetch(url)
  if (!r.ok) throw new Error(`Research API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-research',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export async function fetchResearchApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<ResearchApiHealthResponse> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Research API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-research',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
  }
}

export async function fetchDocsApiHealthAtOrigin(
  origin: ApiOriginBase,
  options?: { timeoutMs?: number },
): Promise<DocsApiHealthResponse> {
  const url = joinApiOrigin(origin, '/health')
  const init = { credentials: 'omit' as const }
  const r =
    options?.timeoutMs != null
      ? await fetchWithTimeout(url, init, options.timeoutMs)
      : await fetch(url, init)
  if (!r.ok) throw new Error(`Docs API health: ${r.status}`)
  const j = await r.json()
  return {
    status: j.status ?? 'unknown',
    service: j.service ?? 'bifrost-docs',
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: j.config_profile ?? null,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
    config_path: typeof j.config_path === 'string' ? j.config_path : null,
    main_url: typeof j.main_url === 'string' ? j.main_url : '',
    massive_url: typeof j.massive_url === 'string' ? j.massive_url : '',
    research_url: typeof j.research_url === 'string' ? j.research_url : '',
  }
}

export async function postDocsShutdown(): Promise<{ ok: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch(docsUrl('/research/docs/shutdown'), {
      method: 'POST',
      headers: opsAuthHeaders(),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let data: { ok?: boolean; error?: string } = {}
  try {
    const text = await r.text()
    data = text ? (JSON.parse(text) as { ok?: boolean; error?: string }) : {}
  } catch (e) {
    if (!r.ok) {
      return { ok: false, error: `Request failed (HTTP ${r.status})` }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    return { ok: false, error: opsControlFailureMessage(data, r) }
  }
  return { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : undefined }
}

export async function postMassiveShutdown(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(massiveUrl('/research/massive/shutdown'), { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  return {
    ok: r.ok && j.ok !== false,
    error: j.error || (r.ok ? undefined : r.statusText || 'Request failed'),
  }
}

export interface MassiveStatusResponse {
  configured: boolean
  tier: string
  delay_notice: string
  trades_enabled: boolean
  /** Empty-DB daily_smart backfill window (years), from server massive config */
  daily_full_backfill_years: number
}

export async function fetchMassiveStatus(): Promise<MassiveStatusResponse> {
  const r = await fetch(massiveUrl('/research/massive/status'))
  const j = await r.json().catch(() => ({}))
  const years = Number(j.daily_full_backfill_years)
  return {
    configured: Boolean(j.configured),
    tier: typeof j.tier === 'string' ? j.tier : 'starter',
    delay_notice: typeof j.delay_notice === 'string' ? j.delay_notice : '',
    trades_enabled: Boolean(j.trades_enabled),
    daily_full_backfill_years: Number.isFinite(years) && years > 0 ? years : 5,
  }
}

/** Per-dimension block from GET /research/massive/daily-checklist */
export interface MassiveDailyDimBlock {
  status?: string
  rows?: number
  last_ts?: string
  trade_date?: string
  last_trade_date?: string | null
  last_sync?: string
  connected?: boolean
  last_msg_age_s?: number | null
}

export type MassiveDailyChecklistDims = {
  'daily-snapshot'?: MassiveDailyDimBlock
  'daily-oi'?: MassiveDailyDimBlock
  'daily-max-pain'?: MassiveDailyDimBlock
  'daily-corporate'?: MassiveDailyDimBlock
  'daily-ws-alive'?: MassiveDailyDimBlock
}

export async function fetchMassiveDailyChecklist(params: {
  symbols: string[]
  tradeDate?: string
}): Promise<{
  ok: boolean
  trade_date?: string
  symbols?: Record<string, MassiveDailyChecklistDims>
  error?: string
}> {
  const syms = [...new Set((params.symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(
    0,
    80,
  )
  if (syms.length === 0) {
    return { ok: false, error: 'symbols is required' }
  }
  const q = new URLSearchParams({ symbols: syms.join(',') })
  const td = (params.tradeDate || '').trim()
  if (td) q.set('trade_date', td)
  const r = await fetch(massiveUrl(`/research/massive/daily-checklist?${q.toString()}`))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  if (!j.ok) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  const symMap = j.symbols && typeof j.symbols === 'object' ? (j.symbols as Record<string, MassiveDailyChecklistDims>) : {}
  return {
    ok: true,
    trade_date: typeof j.trade_date === 'string' ? j.trade_date : undefined,
    symbols: symMap,
  }
}

/** Row from GET /research/massive/db-coverage-summary */
export interface DbCoverageSummaryRow {
  id: string
  table_name: string
  dataset_label: string
  domain: string
  drill_down_hash: string
  distinct_symbols: number | null
  newest_activity: string | null
  newest_trade_date?: string | null
  error?: string | null
}

export interface DbCoverageSummaryResponse {
  ok: boolean
  error?: string
  generated_at?: string
  tables?: DbCoverageSummaryRow[]
  /** When set, row counts use Massive source filters (see API docs). */
  source_scope?: string
}

/** GET /research/massive/celery-beat-schedule — Massive Celery Beat entries (UTC). */
export interface MassiveCeleryBeatEntry {
  name: string
  task: string
  label: string
  crontab: Record<string, string | number>
}

export interface MassiveCeleryBeatScheduleResponse {
  ok: boolean
  timezone?: string
  entries?: MassiveCeleryBeatEntry[]
  error?: string
}

export async function fetchMassiveCeleryBeatSchedule(): Promise<MassiveCeleryBeatScheduleResponse> {
  const r = await fetch(massiveUrl('/research/massive/celery-beat-schedule'))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  if (j.ok === false) {
    return { ok: false, error: typeof j.error === 'string' ? j.error : 'Request failed' }
  }
  return j as MassiveCeleryBeatScheduleResponse
}

export async function fetchDbCoverageSummary(): Promise<DbCoverageSummaryResponse> {
  const r = await fetch(massiveUrl('/research/massive/db-coverage-summary'))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: typeof j.error === 'string' ? j.error : `HTTP ${r.status}`,
    }
  }
  return j as DbCoverageSummaryResponse
}

// suppress unused-import warnings for helpers used only by other sub-files
void opsMassiveJobsUrl
