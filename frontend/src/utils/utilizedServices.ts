/** Rows from GET /health utilized_services (YAML utilized.services). */

export interface UtilizedServiceRow {
  service: string
  env: string
}

export function normalizeUtilizedServices(raw: unknown): UtilizedServiceRow[] {
  if (!Array.isArray(raw)) return []
  const out: UtilizedServiceRow[] = []
  for (const x of raw) {
    if (x != null && typeof x === 'object' && 'service' in x && 'env' in x) {
      const s = String((x as { service: unknown }).service).trim()
      const e = String((x as { env: unknown }).env).trim()
      if (s && e) out.push({ service: s, env: e })
    }
  }
  return out
}

export type UtilizedStackEnv = 'prod' | 'dev'

export function utilizedEnvFor(rows: UtilizedServiceRow[], service: string): UtilizedStackEnv | null {
  const key = service.toLowerCase()
  const row = rows.find(r => r.service.toLowerCase() === key)
  if (!row) return null
  const e = row.env.toLowerCase()
  if (e === 'prod') return 'prod'
  if (e === 'dev') return 'dev'
  return null
}
