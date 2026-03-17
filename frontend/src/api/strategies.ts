import type { ControlResponse } from '../types'
import { API } from './constants'

export interface StrategyStructure {
  strategy_structure_id: number
  name: string
  structure_type: string | null
  /** For covered_call: otm | atm | itm | deep_otm; null for other types. */
  structure_subtype?: string | null
  /** Display label from Option Type Config (e.g. "OTM Covered Call"); present when list includes JOIN. */
  structure_subtype_label?: string | null
  is_active: boolean
  version: string | number | null
  created_at: string | null
  updated_at: string | null
  notes?: string | null
  /** Present when fetched by id (from child tables). */
  legs?: StructureLeg[]
  constraints?: StructureConstraint[]
  metadata?: Record<string, unknown>
}

export interface StructureLeg {
  role?: string | null
  direction?: string | null
  option_right?: string | null
  quantity?: number | null
  strike?: number | null
  expiration?: string | null
}

export interface StructureConstraint {
  constraint_type?: string | null
  constraint_value_text?: string | null
  constraint_value_int?: number | null
}

export interface StructureMetaEntry {
  meta_key: string
  meta_value_text?: string | null
}

/** Payload for create/update strategy structure. */
export interface StructurePayload {
  name: string
  structure_type: string
  /** For covered_call: otm | atm | itm | deep_otm; omit or null for other types. */
  structure_subtype?: string | null
  legs: StructureLeg[]
  constraints?: StructureConstraint[]
  version?: number
  is_active?: boolean
  notes?: string
  meta?: StructureMetaEntry[]
}

/** Structure type from config API (GET /strategies/structure-types). */
export interface StructureTypeItem {
  structure_type: string
  display_label: string
  sort_order: number
  has_subtypes: boolean
  type_explanation?: string | null
}

/** Meta param definition per subtype (from config API). */
export interface MetaParamItem {
  meta_key: string
  display_label?: string | null
  default_value_text?: string | null
  param_kind?: string | null
  sort_order: number
}

/** Subtype from config API (GET /strategies/structure-types/:type/subtypes). */
export interface SubtypeItem {
  subtype: string
  display_label: string
  example?: string | null
  typical_use?: string | null
  subtype_explanation?: string | null
  nature?: string | null
  sort_order: number
  characteristics: string[]
  meta_params: MetaParamItem[]
}

/** Rule to infer subtype from metadata (Edit flow). */
export interface InferRuleItem {
  meta_key: string
  meta_value_text: string
  subtype: string
}

/** Payload for create structure type. */
export interface StructureTypePayload {
  structure_type: string
  display_label?: string
  sort_order?: number
  has_subtypes?: boolean
  type_explanation?: string | null
}

/** Payload for update structure type (all optional). */
export interface StructureTypeUpdatePayload {
  display_label?: string
  sort_order?: number
  has_subtypes?: boolean
  type_explanation?: string | null
}

/** One default leg for replace default-legs. */
export interface StructureTypeLegPayload {
  role?: string | null
  direction?: string | null
  option_right?: string | null
  quantity_default?: number
  quantity?: number
  sort_order?: number
}

/** Payload for create subtype. */
export interface SubtypePayload {
  subtype: string
  display_label?: string
  example?: string | null
  typical_use?: string | null
  subtype_explanation?: string | null
  nature?: string | null
  sort_order?: number
}

/** Payload for update subtype (all optional). */
export interface SubtypeUpdatePayload {
  display_label?: string
  example?: string | null
  typical_use?: string | null
  subtype_explanation?: string | null
  nature?: string | null
  sort_order?: number
}

/** One meta param for replace meta-params. */
export interface MetaParamPayload {
  meta_key: string
  display_label?: string | null
  default_value_text?: string | null
  param_kind?: string | null
  sort_order?: number
}

export interface GateSafetySet {
  gate_safety_strategy_id: number
  name: string
  version: string | null
  structure_type: string | null
  is_active: boolean
}

/** Full gate set for edit: metadata + gates (config shape) + earnings_dates. */
export interface GateSafetyFull {
  gate_safety_strategy_id: number
  name: string
  version: number
  structure_type: string | null
  is_active: boolean
  gates: GateSafetyGates
  earnings_dates: string[]
}

/** Nested gates shape aligned with backend / config. */
export interface GateSafetyGates {
  strategy?: {
    structure?: { min_dte?: number; max_dte?: number; atm_band_pct?: number }
    earnings?: { blackout_days_before?: number; blackout_days_after?: number; dates?: string[] }
    trading_hours_only?: boolean
  }
  state?: {
    delta?: { epsilon_band?: number; threshold_hedge_shares?: number; max_delta_limit?: number }
    market?: { vol_window_min?: number; stale_ts_threshold_ms?: number }
    liquidity?: { wide_spread_pct?: number; extreme_spread_pct?: number }
    system?: { data_lag_threshold_ms?: number }
  }
  intent?: {
    hedge?: {
      min_hedge_shares?: number
      cooldown_seconds?: number
      max_hedge_shares_per_order?: number
      min_price_move_pct?: number
    }
  }
  guard?: {
    risk?: {
      max_daily_hedge_count?: number
      max_position_shares?: number
      max_daily_loss_usd?: number
      max_net_delta_shares?: number
      max_spread_pct?: number
      paper_trade?: boolean
    }
  }
}

/** Payload for create/update gate safety set. */
export interface GateSafetyPayload {
  name: string
  version?: number
  structure_type?: string | null
  is_active?: boolean
  gates: GateSafetyGates
  earnings_dates?: string[]
}

export interface EntryConditionItem {
  condition_type: string
  value_text?: string | null
  value_numeric?: number | null
}

export interface StrategyOpportunity {
  strategy_opportunity_id: number
  name: string
  strategy_structure_id: number
  structure_name?: string | null
  default_gate_safety_strategy_id?: number | null
  gate_safety_name?: string | null
  scope_type?: string | null
  symbols?: string[] | null
  entry_conditions?: EntryConditionItem[] | null
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

/** Payload for create/update strategy opportunity. */
export interface OpportunityPayload {
  name: string
  strategy_structure_id: number
  default_gate_safety_strategy_id?: number | null
  scope_type?: string | null
  symbols?: string[] | null
  entry_conditions?: EntryConditionItem[] | null
  is_active?: boolean
}

export interface StrategyAllocation {
  strategy_allocation_id: number
  name: string
  strategy_opportunity_ids: number[]
  gate_safety_strategy_id?: number | null
  gate_safety_name?: string | null
  allocation_limits?: Record<string, unknown> | null
  /** Top-level DB columns; prefer these when present for edit form. */
  max_positions?: number | null
  max_bp_pct?: number | null
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

/** Payload for create/update strategy allocation. */
export interface AllocationPayload {
  name: string
  strategy_opportunity_ids: number[]
  gate_safety_strategy_id?: number | null
  allocation_limits?: Record<string, unknown> | null
  is_active?: boolean
}

export interface StrategyHistoryRow {
  strategy_history_id: number
  strategy_structure_id: number
  /** Unix seconds or ISO date string from DB */
  ts: number | string
  state_summary: unknown
  created_at: string | null
}

export async function fetchStructures(activeOnly = true): Promise<{ items: StrategyStructure[] }> {
  const params = new URLSearchParams()
  params.set('active_only', String(activeOnly))
  const r = await fetch(`${API}/strategies/structures?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchStructure(id: number): Promise<StrategyStructure> {
  const r = await fetch(`${API}/strategies/structures/${id}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Fetch structure types from config (for Wizard Step 1). */
export async function fetchStructureTypes(): Promise<{ items: StructureTypeItem[] }> {
  const r = await fetch(`${API}/strategies/structure-types`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Fetch default legs for a structure type (industry-aligned defaults API). Returns empty legs for custom/unknown. */
export async function fetchStructureTypeDefaultLegs(structureType: string): Promise<{ legs: StructureLeg[] }> {
  const r = await fetch(`${API}/strategies/structure-types/${encodeURIComponent(structureType)}/default-legs`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Fetch default legs for a specific subtype (falls back to type-level legs when no subtype override).
 * subtype_override: true when Option Type Config has "Override with subtype-specific legs" for this subtype. */
export async function fetchStructureSubtypeDefaultLegs(
  structureType: string,
  subtype: string,
): Promise<{ legs: StructureLeg[]; subtype_override?: boolean }> {
  const r = await fetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes/${encodeURIComponent(subtype)}/default-legs`
  )
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Fetch subtypes with characteristics and meta_params, plus infer_rules (for Wizard Step 2 / Edit). */
export async function fetchStructureTypeSubtypes(
  structureType: string
): Promise<{ subtypes: SubtypeItem[]; infer_rules: InferRuleItem[] }> {
  const r = await fetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes`
  )
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** One option for Type Config dropdowns: value (stored/API) and label (display). */
export interface StructureTypeConfigOption {
  value: string
  label: string
}

/** Allowed param_kind values with display labels (single source of truth from backend). */
export async function fetchParamKindOptions(): Promise<{ options: StructureTypeConfigOption[] }> {
  const r = await fetch(`${API}/strategies/structure-types/param-kind-options`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Allowed leg role values with display labels for Type Config Default legs. */
export async function fetchLegRoleOptions(): Promise<{ options: StructureTypeConfigOption[] }> {
  const r = await fetch(`${API}/strategies/structure-types/leg-role-options`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Allowed leg direction values with display labels for Type Config Default legs. */
export async function fetchLegDirectionOptions(): Promise<{ options: StructureTypeConfigOption[] }> {
  const r = await fetch(`${API}/strategies/structure-types/leg-direction-options`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Allowed leg option_right values (empty = stock) with display labels for Type Config Default legs. */
export async function fetchLegOptionRightOptions(): Promise<{ options: StructureTypeConfigOption[] }> {
  const r = await fetch(`${API}/strategies/structure-types/leg-option-right-options`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Allowed meta_key values with display labels for a structure type (Type Config). */
export async function fetchMetaKeyOptions(
  structureType: string
): Promise<{ options: StructureTypeConfigOption[] }> {
  const r = await fetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/meta-key-options`
  )
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

/** Allowed meta_value_text with display labels for (structure_type, meta_key). Empty if no enum. */
export async function fetchMetaValueOptions(
  structureType: string,
  metaKey: string
): Promise<{ options: StructureTypeConfigOption[] }> {
  const params = new URLSearchParams({ meta_key: metaKey })
  const r = await fetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/meta-value-options?${params}`
  )
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

async function structureTypeConfigFetch(
  url: string,
  options: { method: string; body?: string }
): Promise<unknown> {
  const r = await fetch(url, {
    method: options.method,
    headers: { 'Content-Type': 'application/json' },
    body: options.body,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j
}

export async function createStructureType(
  payload: StructureTypePayload
): Promise<{ structure_type: string }> {
  return structureTypeConfigFetch(`${API}/strategies/structure-types`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }) as Promise<{ structure_type: string }>
}

export async function updateStructureType(
  structureType: string,
  payload: StructureTypeUpdatePayload
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}`,
    { method: 'PUT', body: JSON.stringify(payload) }
  ) as Promise<{ ok: boolean }>
}

export async function deleteStructureType(structureType: string): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}`,
    { method: 'DELETE' }
  ) as Promise<{ ok: boolean }>
}

export async function replaceStructureTypeLegs(
  structureType: string,
  legs: StructureTypeLegPayload[]
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/default-legs`,
    { method: 'PUT', body: JSON.stringify({ legs }) }
  ) as Promise<{ ok: boolean }>
}

export async function replaceStructureSubtypeLegs(
  structureType: string,
  subtype: string,
  legs: StructureTypeLegPayload[]
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes/${encodeURIComponent(subtype)}/default-legs`,
    { method: 'PUT', body: JSON.stringify({ legs }) }
  ) as Promise<{ ok: boolean }>
}

export async function createSubtype(
  structureType: string,
  payload: SubtypePayload
): Promise<{ subtype: string }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes`,
    { method: 'POST', body: JSON.stringify(payload) }
  ) as Promise<{ subtype: string }>
}

export async function updateSubtype(
  structureType: string,
  subtype: string,
  payload: SubtypeUpdatePayload
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes/${encodeURIComponent(subtype)}`,
    { method: 'PUT', body: JSON.stringify(payload) }
  ) as Promise<{ ok: boolean }>
}

export async function deleteSubtype(
  structureType: string,
  subtype: string
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes/${encodeURIComponent(subtype)}`,
    { method: 'DELETE' }
  ) as Promise<{ ok: boolean }>
}

export async function replaceSubtypeCharacteristics(
  structureType: string,
  subtype: string,
  items: string[]
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes/${encodeURIComponent(subtype)}/characteristics`,
    { method: 'PUT', body: JSON.stringify({ items }) }
  ) as Promise<{ ok: boolean }>
}

export async function replaceSubtypeMetaParams(
  structureType: string,
  subtype: string,
  items: MetaParamPayload[]
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/subtypes/${encodeURIComponent(subtype)}/meta-params`,
    { method: 'PUT', body: JSON.stringify({ items }) }
  ) as Promise<{ ok: boolean }>
}

export async function replaceInferRules(
  structureType: string,
  items: InferRuleItem[]
): Promise<{ ok: boolean }> {
  return structureTypeConfigFetch(
    `${API}/strategies/structure-types/${encodeURIComponent(structureType)}/infer-rules`,
    { method: 'PUT', body: JSON.stringify({ items }) }
  ) as Promise<{ ok: boolean }>
}

export async function createStructure(payload: StructurePayload): Promise<{ strategy_structure_id: number }> {
  const r = await fetch(`${API}/strategies/structures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { strategy_structure_id: number }
}

export async function updateStructure(id: number, payload: StructurePayload): Promise<{ ok: boolean }> {
  const r = await fetch(`${API}/strategies/structures/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { ok: boolean }
}

export async function deleteStructure(id: number): Promise<void> {
  const r = await fetch(`${API}/strategies/structures/${id}`, { method: 'DELETE' })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error((j as { detail?: string }).detail || r.statusText)
  }
}

export interface StrategyHistoryParams {
  from_ts?: number
  to_ts?: number
  strategy_structure_id?: number
  limit?: number
}

export async function fetchStrategyHistory(
  params: StrategyHistoryParams = {}
): Promise<{ items: StrategyHistoryRow[] }> {
  const search = new URLSearchParams()
  if (params.from_ts != null) search.set('from_ts', String(params.from_ts))
  if (params.to_ts != null) search.set('to_ts', String(params.to_ts))
  if (params.strategy_structure_id != null)
    search.set('strategy_structure_id', String(params.strategy_structure_id))
  if (params.limit != null) search.set('limit', String(Math.min(500, Math.max(1, params.limit))))
  const r = await fetch(`${API}/strategies/history?${search}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchOpportunities(activeOnly = true): Promise<{ items: StrategyOpportunity[] }> {
  const params = new URLSearchParams()
  params.set('active_only', String(activeOnly))
  const r = await fetch(`${API}/strategies/opportunities?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchOpportunity(id: number): Promise<StrategyOpportunity> {
  const r = await fetch(`${API}/strategies/opportunities/${id}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function createOpportunity(payload: OpportunityPayload): Promise<{ strategy_opportunity_id: number }> {
  const r = await fetch(`${API}/strategies/opportunities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { strategy_opportunity_id: number }
}

export async function updateOpportunity(id: number, payload: OpportunityPayload): Promise<{ ok: boolean }> {
  const r = await fetch(`${API}/strategies/opportunities/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { ok: boolean }
}

export async function fetchAllocations(activeOnly = true): Promise<{ items: StrategyAllocation[] }> {
  const params = new URLSearchParams()
  params.set('active_only', String(activeOnly))
  const r = await fetch(`${API}/strategies/allocations?${params}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchAllocation(id: number): Promise<StrategyAllocation> {
  const r = await fetch(`${API}/strategies/allocations/${id}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function createAllocation(payload: AllocationPayload): Promise<{ strategy_allocation_id: number }> {
  const r = await fetch(`${API}/strategies/allocations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { strategy_allocation_id: number }
}

export async function updateAllocation(id: number, payload: Partial<AllocationPayload>): Promise<{ ok: boolean }> {
  const r = await fetch(`${API}/strategies/allocations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { ok: boolean }
}

export async function fetchGateSafetySets(): Promise<{ items: GateSafetySet[] }> {
  const r = await fetch(`${API}/strategies/gate-safety`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function fetchGateSafetyFull(id: number): Promise<GateSafetyFull> {
  const r = await fetch(`${API}/strategies/gate-safety/${id}`)
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

export async function createGateSafety(payload: GateSafetyPayload): Promise<{ gate_safety_strategy_id: number }> {
  const r = await fetch(`${API}/strategies/gate-safety`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { gate_safety_strategy_id: number }
}

export async function updateGateSafety(id: number, payload: GateSafetyPayload): Promise<{ ok: boolean }> {
  const r = await fetch(`${API}/strategies/gate-safety/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { detail?: string }).detail || r.statusText)
  return j as { ok: boolean }
}

export async function postActiveStrategy(
  structureId?: number | null,
  gateSafetyId?: number | null
): Promise<
  ControlResponse & {
    active_strategy_structure_id?: number | null
    active_gate_safety_strategy_id?: number | null
  }
> {
  const r = await fetch(`${API}/config/active-strategy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      active_strategy_structure_id: structureId ?? null,
      active_gate_safety_strategy_id: gateSafetyId ?? null,
    }),
  })
  const j = await r.json().catch(() => ({}))
  return {
    ...j,
    ok: r.ok,
    error: j.error || (r.ok ? undefined : r.statusText),
    active_strategy_structure_id: j.active_strategy_structure_id ?? structureId,
    active_gate_safety_strategy_id: j.active_gate_safety_strategy_id ?? gateSafetyId,
  }
}
