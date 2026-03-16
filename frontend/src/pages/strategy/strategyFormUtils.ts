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

export const DEFAULT_STRUCTURE_PAYLOAD: StructurePayload = {
  name: '',
  structure_type: '',
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
