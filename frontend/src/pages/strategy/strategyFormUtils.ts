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

export function getStructureDisplayLabel(row: StrategyStructure): string {
  if (row.template_display_name) return row.template_display_name
  if (row.structure_subtype_label) return row.structure_subtype_label
  return getStructureTypeLabel(row.structure_type)
}

export const DEFAULT_STRUCTURE_PAYLOAD: StructurePayload = {
  name: '',
  strategy_template_id: undefined,
  structure_type: '',
  legs: [],
  constraints: [],
  version: 1,
  is_active: true,
  notes: '',
  meta: [],
}

/** Strategy structure types supported by the Option Screener. */
export const SCREENER_STRUCTURE_TYPES = [
  { value: 'cash_secured_put', label: 'Cash Secured Put' },
  { value: 'covered_call', label: 'Covered Call' },
  { value: 'iron_condor', label: 'Iron Condor' },
  { value: 'bull_put_spread', label: 'Bull Put Spread' },
  { value: 'bear_call_spread', label: 'Bear Call Spread' },
] as const

export const SCOPE_TYPES = ['', 'watchlist_stk', 'explicit_symbols'] as const

/** Display labels for scope types (backend key -> human-readable). */
export const SCOPE_TYPE_LABELS: Record<string, string> = {
  '': '— None',
  watchlist_stk: 'Watchlist (stocks)',
  explicit_symbols: 'Explicit symbols',
}

export function getScopeTypeLabel(key: string | null | undefined): string {
  if (key == null || key === '') return '— None'
  return SCOPE_TYPE_LABELS[key] ?? key
}

/** Scope cell: show symbol list (or scope label), title = full symbols on hover. */
export function getScopeDisplay(
  scopeType: string | null | undefined,
  symbols: string[] | null | undefined
): { text: string; title: string } {
  const list = symbols?.filter((s) => s != null && String(s).trim()) ?? []
  const symbolsLabel = list.length > 0 ? list.join(', ') : ''
  if (scopeType == null || scopeType === '') {
    return { text: '— None', title: '' }
  }
  if (scopeType === 'explicit_symbols') {
    const text = list.length > 0 ? symbolsLabel : 'Explicit symbols'
    return { text, title: symbolsLabel }
  }
  if (scopeType === 'watchlist_stk') {
    const text = list.length > 0 ? symbolsLabel : 'Watchlist (stocks)'
    return { text, title: list.length > 0 ? symbolsLabel : 'All watchlist STK' }
  }
  return { text: getScopeTypeLabel(scopeType), title: symbolsLabel }
}

export const CONDITION_TYPES = ['iv_min', 'iv_max', 'dte_min', 'dte_max', 'earnings_blackout_days', 'min_volume'] as const

/** Display labels for entry condition types (backend key -> human-readable). */
export const CONDITION_TYPE_LABELS: Record<string, string> = {
  iv_min: 'IV min',
  iv_max: 'IV max',
  dte_min: 'DTE min',
  dte_max: 'DTE max',
  earnings_blackout_days: 'Earnings blackout (days)',
  min_volume: 'Min volume',
}

export function getConditionTypeLabel(key: string | null | undefined): string {
  if (key == null || key === '') return '—'
  return CONDITION_TYPE_LABELS[key] ?? key
}

/**
 * Suggested opportunity name: symbol(s) + structure display name + entry summary.
 * Used on create; user may edit the name afterward.
 */
export function buildSuggestedOpportunityName(params: {
  structureName: string
  scopeType: string | null | undefined
  symbols: string[]
  entryConditions: EntryConditionItem[]
}): string {
  const { structureName, scopeType, symbols, entryConditions } = params
  const symList = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)

  let symbolPart = ''
  if (scopeType === 'explicit_symbols') {
    symbolPart = symList.join(', ')
  } else if (scopeType === 'watchlist_stk') {
    symbolPart = symList.length > 0 ? symList.join(', ') : 'Watchlist STK'
  }

  const structPart = (structureName || '').trim()

  const entryParts = entryConditions
    .filter((c) => (c.condition_type ?? '').trim())
    .map((c) => {
      const label = getConditionTypeLabel(c.condition_type)
      const vt = (c.value_text ?? '').trim()
      const vn = c.value_numeric
      const numStr =
        vn != null && typeof vn === 'number' && Number.isFinite(vn) ? String(vn) : ''
      const tail = [vt, numStr].filter(Boolean).join(' ')
      const base = tail ? `${label} ${tail}` : label
      return base.replace(/\s+/g, ' ').trim()
    })
  const entryPart = entryParts.join(' · ')

  return [symbolPart, structPart, entryPart].filter(Boolean).join(' ')
}

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
  const structure_type = row.structure_type ?? 'custom'
  const structure_subtype =
    structure_type === 'covered_call' && row.structure_subtype != null && row.structure_subtype !== ''
      ? row.structure_subtype
      : undefined
  return {
    name: row.name,
    strategy_template_id: row.strategy_template_id ?? undefined,
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

/** One-line summary of structure legs for sheet display. */
export function summarizeLegs(legs: StructureLeg[] | null | undefined): string {
  if (!legs?.length) return '—'
  return legs
    .map((l) => {
      const q = l.quantity ?? 1
      const d = l.direction ?? ''
      const r = l.role ?? ''
      const o = l.option_right ?? ''
      const parts = [r, d, o].filter(Boolean)
      return `${q}× ${parts.join(' ')}`.trim() || '—'
    })
    .join(', ')
}

/** One-line summary of structure constraints for sheet display. */
export function summarizeConstraints(constraints: StructureConstraint[] | null | undefined): string {
  if (!constraints?.length) return '—'
  return constraints
    .map((c) => {
      const t = (c.constraint_type ?? '').trim()
      if (!t) return ''
      const v = c.constraint_value_text ?? c.constraint_value_int ?? ''
      return `${t}: ${v}`
    })
    .filter(Boolean)
    .join(', ')
}

/** Sub type for sheet display: prefer display label, else raw subtype (e.g. otm, atm), else —. */
export function summarizeSubtype(
  subtype: string | null | undefined,
  subtypeLabel?: string | null
): string {
  if (subtypeLabel != null && subtypeLabel !== '') return subtypeLabel
  if (subtype == null || subtype === '') return '—'
  return subtype
}
