import type {
  StructurePayload,
  StructureLeg,
  StructureConstraint,
  StructureMetaEntry,
  StrategyStructure,
  OpportunityPayload,
  StrategyOpportunity,
  EntryConditionItem,
} from '../../api'
import { fmtTs } from '../../utils/format'

/** Display order: Covered Call, Cash Secured Put, Iron Condor, Straddle/Strangle, LEAPS, Calendar Spread. */
export const STRUCTURE_TYPES = [
  'covered_call',
  'cash_secured_put',
  'iron_condor',
  'straddle_strangle',
  'leaps',
  'calendar_spread',
] as const

/** Human-readable labels for structure types (no custom in UI). */
export const STRUCTURE_TYPE_LABELS: Record<string, string> = {
  straddle_strangle: 'Straddle / Strangle',
  cash_secured_put: 'Cash Secured Put',
  covered_call: 'Covered Call',
  iron_condor: 'Iron Condor',
  leaps: 'LEAPS',
  calendar_spread: 'Calendar Spread',
  custom: 'Custom',
}

export function getStructureTypeLabel(structureType: string | null | undefined): string {
  if (structureType == null || structureType === '') return '—'
  return STRUCTURE_TYPE_LABELS[structureType] ?? structureType
}

/** Covered Call subtypes for wizard Step 2. */
export const COVERED_CALL_SUBTYPES = ['otm', 'atm', 'itm', 'deep_otm'] as const
export type CoveredCallSubtype = (typeof COVERED_CALL_SUBTYPES)[number]

export const COVERED_CALL_SUBTYPE_LABELS: Record<CoveredCallSubtype, string> = {
  otm: 'OTM Covered Call',
  atm: 'ATM Covered Call',
  itm: 'ITM Covered Call',
  deep_otm: 'Deep OTM Covered Call',
}

export function getCoveredCallSubtypeLabel(subtype: CoveredCallSubtype | null | undefined): string {
  if (subtype == null) return '—'
  return COVERED_CALL_SUBTYPE_LABELS[subtype] ?? subtype
}

/** Per-subtype description for wizard: example, characteristics, nature (optional), use. All English. */
export interface CoveredCallSubtypeDescription {
  example: string
  characteristics: string[]
  nature?: string
  use: string
}

export const COVERED_CALL_SUBTYPE_DESCRIPTIONS: Record<CoveredCallSubtype, CoveredCallSubtypeDescription> = {
  otm: {
    example: 'Long 100 NVDA, Sell NVDA 1M 10% OTM Call',
    characteristics: [
      'Collect premium',
      'Cap upside',
      'Provide downside buffer',
    ],
    use: 'Enhance income on long-term stock holdings; the most common type.',
  },
  atm: {
    example: 'Long NVDA, Sell NVDA ATM Call',
    characteristics: [
      'Very high premium',
      'Nearly lock in gains',
      'High assignment risk',
    ],
    use: 'Short-term lock gains; preparing to sell stock; commonly used by funds.',
  },
  itm: {
    example: 'NVDA = 100, Sell 90 Call',
    characteristics: [
      'Very high premium',
      'Similar to selling stock early',
    ],
    nature: 'Synthetic limit sell',
    use: 'Want to sell stock but also capture time value.',
  },
  deep_otm: {
    example: 'Sell 20% OTM Call',
    characteristics: [
      'Small premium',
      'Minimal impact on upside',
    ],
    use: 'Enhance income for very long-term holders; many long-term investors use this.',
  },
}

/** Params for OTM/Deep OTM (otm_pct) or ITM (itm_pct). */
export interface CoveredCallSubtypeParams {
  otm_pct?: number
  itm_pct?: number
}

/** Infer Covered Call subtype from structure meta (e.g. when structure_subtype is null / legacy data). */
export function inferCoveredCallSubtypeFromMeta(
  metadata: Record<string, unknown> | null | undefined
): CoveredCallSubtype | null {
  if (!metadata || typeof metadata !== 'object') return null
  const rule = metadata.call_strike_rule
  if (typeof rule !== 'string') return null
  const r = rule.trim().toLowerCase()
  if (r === 'otm_10pct') return 'otm'
  if (r === 'atm') return 'atm'
  if (r === 'itm') return 'itm'
  if (r === 'deep_otm_20pct') return 'deep_otm'
  return null
}

/** Meta keys controlled by Covered Call wizard (subtype + otm_pct/itm_pct). When building payload, filter these from existing meta and replace with fresh subtype meta so edits persist and subtype changes remove old keys. */
export const COVERED_CALL_SUBTYPE_META_KEYS = ['call_strike_rule', 'otm_pct', 'itm_pct'] as const

/** Build structure meta entries for Covered Call from subtype and optional params. */
export function getCoveredCallSubtypeMeta(
  subtype: CoveredCallSubtype,
  params?: CoveredCallSubtypeParams
): StructureMetaEntry[] {
  const meta: StructureMetaEntry[] = []
  switch (subtype) {
    case 'otm':
      meta.push({ meta_key: 'call_strike_rule', meta_value_text: 'otm_10pct' })
      if (params?.otm_pct != null) meta.push({ meta_key: 'otm_pct', meta_value_text: String(params.otm_pct) })
      break
    case 'atm':
      meta.push({ meta_key: 'call_strike_rule', meta_value_text: 'atm' })
      break
    case 'itm':
      meta.push({ meta_key: 'call_strike_rule', meta_value_text: 'itm' })
      if (params?.itm_pct != null) meta.push({ meta_key: 'itm_pct', meta_value_text: String(params.itm_pct) })
      break
    case 'deep_otm':
      meta.push({ meta_key: 'call_strike_rule', meta_value_text: 'deep_otm_20pct' })
      if (params?.otm_pct != null) meta.push({ meta_key: 'otm_pct', meta_value_text: String(params.otm_pct) })
      break
    default:
      break
  }
  return meta
}

/** Client-side fallback when default-legs API fails (e.g. backend down). Matches backend templates. */
export const COVERED_CALL_DEFAULT_LEGS: StructureLeg[] = [
  { role: 'underlying', direction: 'long', option_right: null, quantity: 1, strike: null, expiration: '' },
  { role: 'call', direction: 'short', option_right: 'C', quantity: 1, strike: null, expiration: '' },
]

export const STRADDLE_STRANGLE_DEFAULT_LEGS: StructureLeg[] = [
  { role: 'call', direction: 'long', option_right: 'C', quantity: 1, strike: null, expiration: '' },
  { role: 'put', direction: 'long', option_right: 'P', quantity: 1, strike: null, expiration: '' },
]

export const CASH_SECURED_PUT_DEFAULT_LEGS: StructureLeg[] = [
  { role: 'put', direction: 'short', option_right: 'P', quantity: 1, strike: null, expiration: '' },
]

export const IRON_CONDOR_DEFAULT_LEGS: StructureLeg[] = [
  { role: 'put', direction: 'long', option_right: 'P', quantity: 1, strike: null, expiration: '' },
  { role: 'put', direction: 'short', option_right: 'P', quantity: 1, strike: null, expiration: '' },
  { role: 'call', direction: 'short', option_right: 'C', quantity: 1, strike: null, expiration: '' },
  { role: 'call', direction: 'long', option_right: 'C', quantity: 1, strike: null, expiration: '' },
]

export const LEAPS_DEFAULT_LEGS: StructureLeg[] = [
  { role: 'call', direction: 'long', option_right: 'C', quantity: 1, strike: null, expiration: '' },
]

export const CALENDAR_SPREAD_DEFAULT_LEGS: StructureLeg[] = [
  { role: 'call', direction: 'short', option_right: 'C', quantity: 1, strike: null, expiration: '' },
  { role: 'call', direction: 'long', option_right: 'C', quantity: 1, strike: null, expiration: '' },
]

/** Return default legs for a structure type when API is unavailable. */
export function getDefaultLegsFallback(structureType: string): StructureLeg[] {
  const t = (structureType || '').trim().toLowerCase()
  switch (t) {
    case 'covered_call':
      return [...COVERED_CALL_DEFAULT_LEGS]
    case 'straddle_strangle':
      return [...STRADDLE_STRANGLE_DEFAULT_LEGS]
    case 'cash_secured_put':
      return [...CASH_SECURED_PUT_DEFAULT_LEGS]
    case 'iron_condor':
      return [...IRON_CONDOR_DEFAULT_LEGS]
    case 'leaps':
      return [...LEAPS_DEFAULT_LEGS]
    case 'calendar_spread':
      return [...CALENDAR_SPREAD_DEFAULT_LEGS]
    default:
      return []
  }
}

export const DEFAULT_STRUCTURE_PAYLOAD: StructurePayload = {
  name: '',
  structure_type: 'covered_call',
  legs: [],
  constraints: [],
  version: 1,
  is_active: true,
  notes: '',
  meta: [],
}

export const SCOPE_TYPES = ['', 'watchlist_stk', 'explicit_symbols'] as const
export const CONDITION_TYPES = ['iv_min', 'iv_max', 'dte_min', 'dte_max', 'earnings_blackout_days', 'min_volume'] as const

export const DEFAULT_OPPORTUNITY_PAYLOAD: OpportunityPayload = {
  name: '',
  strategy_structure_id: 0,
  default_gate_safety_strategy_id: null,
  scope_type: null,
  symbols: [],
  entry_conditions: [],
  is_active: true,
}

export function opportunityToPayload(row: StrategyOpportunity): OpportunityPayload {
  return {
    name: row.name,
    strategy_structure_id: row.strategy_structure_id,
    default_gate_safety_strategy_id: row.default_gate_safety_strategy_id ?? null,
    scope_type: row.scope_type ?? null,
    symbols: row.symbols ?? [],
    entry_conditions: (row.entry_conditions ?? []) as EntryConditionItem[],
    is_active: row.is_active,
  }
}

export function structureToPayload(row: StrategyStructure): StructurePayload {
  const legs: StructureLeg[] = Array.isArray(row.legs) ? (row.legs as StructureLeg[]) : []
  const constraints: StructureConstraint[] = Array.isArray(row.constraints)
    ? (row.constraints as StructureConstraint[])
    : []
  const meta: StructureMetaEntry[] =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? Object.entries(row.metadata).map(([meta_key, meta_value_text]) => ({
          meta_key,
          meta_value_text: meta_value_text as string | null,
        }))
      : []
  const structure_type = row.structure_type ?? 'straddle_strangle'
  const structure_subtype =
    structure_type === 'covered_call' && row.structure_subtype != null && row.structure_subtype !== ''
      ? row.structure_subtype
      : undefined
  return {
    name: row.name,
    structure_type,
    structure_subtype: structure_subtype ?? null,
    legs,
    constraints,
    version:
      typeof row.version === 'number'
        ? row.version
        : typeof row.version === 'string'
          ? parseInt(row.version, 10) || 1
          : 1,
    is_active: row.is_active,
    notes: row.notes ?? '',
    meta,
  }
}

export function formatHistoryTs(ts: number | string | null | undefined): string {
  if (ts == null) return '—'
  if (typeof ts === 'number' && Number.isFinite(ts)) return fmtTs(ts)
  return String(ts)
}

export function summarizeStateSummary(state_summary: unknown): string {
  if (state_summary == null) return '—'
  if (typeof state_summary === 'string') return state_summary.slice(0, 120)
  try {
    const s = JSON.stringify(state_summary)
    return s.length > 120 ? s.slice(0, 117) + '...' : s
  } catch {
    return '—'
  }
}
