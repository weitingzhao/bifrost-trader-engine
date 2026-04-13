import type { OpsHostEnvPill } from './opsHostEnvPill'
import { opsHostEnvFromConfigProfile } from './opsHostEnvPill'

/** Ops /health: config profile + executor — summary for Socket/Daemon Ops panels. */
export function socketServicesHostColumnDisplay(opts: {
  configProfile: string | null
  localControl: string | null
  marketIngestScriptControl: boolean
}): { title: string; pill: OpsHostEnvPill } {
  const pill = opsHostEnvFromConfigProfile(opts.configProfile)
  const bits: string[] = []
  if (pill.pillVariant === 'dev') {
    bits.push('Ops config profile: dev (config.dev.yaml overlay).')
  } else if (pill.pillVariant === 'prod') {
    bits.push('Ops config profile: prod (config.prod.yaml overlay).')
  } else {
    bits.push('Ops config profile not inferred (custom path or base config.yaml only).')
  }
  if (opts.marketIngestScriptControl) {
    bits.push('Ingest control: local scripts on this Ops host (typical Mac dev).')
  } else if (opts.localControl === 'subprocess') {
    bits.push('Subprocess executor without market ingest script control.')
  } else {
    bits.push('Ingest control: systemd on this Ops host (typical Linux prod).')
  }
  return { title: bits.join(' '), pill }
}

/** Ops /health config_profile → dev|prod for cross-stack action gating (matches opsHostEnvFromConfigProfile). */
export function normalizedPageDevProd(configProfile: string | null): 'dev' | 'prod' | null {
  const p = (configProfile ?? '').toLowerCase().trim()
  if (p === 'dev' || p === 'development') return 'dev'
  if (p === 'prod' || p === 'production') return 'prod'
  return null
}

/** Per-row Host: Redis lease (which stack started the service via Ops), not the browser's Ops routing. */
export function runtimeControlHostDisplay(
  redisControlEnv: string | null | undefined,
  redisMetaKey: string,
  redisControlHost?: string | null,
): { title: string; pill: OpsHostEnvPill } {
  const r = (redisControlEnv ?? '').toLowerCase().trim()
  const host = (redisControlHost ?? '').trim()
  const hostSentence = host ? ` Last Ops start host: ${host}.` : ''
  if (r === 'dev' || r === 'prod') {
    const pill = opsHostEnvFromConfigProfile(r)
    const keyHint = redisMetaKey ? `${redisMetaKey}` : 'ingest meta hash'
    return {
      pill,
      title: `Ops control lease in Redis (${keyHint}): last start from ${pill.ariaLabel}.${hostSentence} Fields bifrost_ops_control_env, bifrost_ops_control_host.`,
    }
  }
  return {
    pill: { shortLabel: '—', pillVariant: 'other', ariaLabel: 'Unclaimed' },
    title: redisMetaKey.trim()
      ? `No Ops control lease in Redis yet (${redisMetaKey}). Starting from Ops (Dev or Prod) writes bifrost_ops_control_env and bifrost_ops_control_host.${hostSentence}`
      : 'No redis_meta_key for this row; cross-stack lease is not tracked.',
  }
}

export type IngestActionBlock = 'none' | 'admin' | 'script' | 'remote_env' | 'stack_conflict'

/**
 * Per-row Redis lease plus stack-wide view: only one of dev or prod may run Socket (or Daemon ingest)
 * services against the same Redis. Ops writes `redis_control_env` per `redis_meta_key`; rows without a
 * lease yet must still respect a lease held on any sibling row.
 */
export function resolveEffectiveRedisControlEnv(
  svc: { id: string; redis_control_env?: string | null },
  allRows: { id: string; redis_control_env?: string | null }[],
): string | null | undefined {
  const own = (svc.redis_control_env ?? '').toLowerCase().trim()
  if (own === 'dev' || own === 'prod') {
    return svc.redis_control_env
  }
  const distinct = new Set<'dev' | 'prod'>()
  for (const r of allRows) {
    const v = (r.redis_control_env ?? '').toLowerCase().trim()
    if (v === 'dev' || v === 'prod') distinct.add(v)
  }
  if (distinct.size > 1) {
    return '__stack_conflict__'
  }
  if (distinct.size === 1) {
    const [only] = [...distinct]
    return only
  }
  return svc.redis_control_env ?? null
}

export function ingestActionBlock(
  canOperate: boolean,
  disableIngestScript: boolean,
  pageEnv: 'dev' | 'prod' | null,
  effectiveRedisControlEnv: string | null | undefined,
): IngestActionBlock {
  if (!canOperate) return 'admin'
  if (disableIngestScript) return 'script'
  const lease = (effectiveRedisControlEnv ?? '').toLowerCase().trim()
  if (lease === '__stack_conflict__') return 'stack_conflict'
  if (pageEnv) {
    if (lease === 'dev' || lease === 'prod') {
      if (lease !== pageEnv) return 'remote_env'
    }
  }
  return 'none'
}

export function ingestActionBlockMessage(block: IngestActionBlock): string {
  switch (block) {
    case 'admin':
      return 'Operator role required (Ops token).'
    case 'script':
      return 'Control disabled: subprocess Ops without ingest script support (upgrade Ops or use Linux systemd).'
    case 'remote_env':
      return 'Control is held by the other stack (Redis). Stop the service from that Ops host first.'
    case 'stack_conflict':
      return 'Conflicting dev/prod Redis control leases across services. Stop processes on one stack first.'
    default:
      return ''
  }
}
