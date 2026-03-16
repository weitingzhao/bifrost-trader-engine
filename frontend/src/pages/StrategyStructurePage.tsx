import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchStructures,
  fetchStructure,
  fetchStructureTypes,
  fetchStructureTypeDefaultLegs,
  fetchStructureSubtypeDefaultLegs,
  fetchStructureTypeSubtypes,
  fetchStrategyHistory,
  postActiveStrategy,
  createStructure,
  updateStructure,
  type StrategyStructure,
  type StructurePayload,
  type StructureLeg,
  type StructureConstraint,
  type StructureMetaEntry,
  type StrategyHistoryRow,
  type StructureTypeItem,
  type SubtypeItem,
  type InferRuleItem,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  STRUCTURE_TYPES,
  DEFAULT_STRUCTURE_PAYLOAD,
  getDefaultLegsFallback,
  getStructureTypeLabel,
  structureToPayload,
  formatHistoryTs,
  summarizeStateSummary,
  COVERED_CALL_SUBTYPES,
  COVERED_CALL_SUBTYPE_LABELS,
  COVERED_CALL_SUBTYPE_DESCRIPTIONS,
  getCoveredCallSubtypeMeta,
  COVERED_CALL_SUBTYPE_META_KEYS,
  inferCoveredCallSubtypeFromMeta,
  type CoveredCallSubtype,
  type CoveredCallSubtypeParams,
} from './strategy/strategyFormUtils'

export interface StrategyStructurePageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  breadcrumbLabel?: string
}

export function StrategyStructurePage({
  status,
  loadStatus,
  breadcrumbLabel = 'Structure',
}: StrategyStructurePageProps) {
  const [structures, setStructures] = useState<StrategyStructure[]>([])
  const [history, setHistory] = useState<StrategyHistoryRow[]>([])
  const [historyStructureFilter, setHistoryStructureFilter] = useState<number | ''>('')
  const [structuresLoading, setStructuresLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [structuresError, setStructuresError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [setActiveMsg, setSetActiveMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [formOpen, setFormOpen] = useState<'create' | number | null>(null)
  const [formPayload, setFormPayload] = useState<StructurePayload>(DEFAULT_STRUCTURE_PAYLOAD)
  const [formLegs, setFormLegs] = useState<StructureLeg[]>([])
  const [formConstraints, setFormConstraints] = useState<StructureConstraint[]>([])
  const [formNotes, setFormNotes] = useState('')
  const [formMeta, setFormMeta] = useState<StructureMetaEntry[]>([])
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formIsCopy, setFormIsCopy] = useState(false)
  /** When > 0, current type has fixed leg count from default-legs API; Add/Remove disabled and role/direction/right locked. */
  const [fixedLegCount, setFixedLegCount] = useState(0)
  const [defaultLegsLoading, setDefaultLegsLoading] = useState(false)
  /** When set, default legs came from client fallback (API failed or unavailable). Shown so backend failures are not hidden. */
  const [defaultLegsFallbackMsg, setDefaultLegsFallbackMsg] = useState<string | null>(null)
  /** Filter structure list: 'all' | 'active' | 'inactive'. */
  const [structureActiveFilter, setStructureActiveFilter] = useState<'all' | 'active' | 'inactive'>('active')
  /** Separate toggles: when true, allow editing the Qty / Strike / Expiration column per leg. Qty defaults off (show numbers read-only); Strike/Expiration off shows "resolved when used". */
  const [allowQtyPreset, setAllowQtyPreset] = useState(false)
  const [allowStrikePreset, setAllowStrikePreset] = useState(false)
  const [allowExpirationPreset, setAllowExpirationPreset] = useState(false)
  /** Wizard for New structure only: step 1=type, 2=subtype (when has_subtypes), 3=details. */
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1)
  /** Structure types from config API (for Step 1). Fallback to STRUCTURE_TYPES when empty. */
  const [structureTypes, setStructureTypes] = useState<StructureTypeItem[]>([])
  /** Subtypes + infer_rules for current structure_type when has_subtypes (for Step 2 / Edit). */
  const [subtypesConfig, setSubtypesConfig] = useState<{
    subtypes: SubtypeItem[]
    infer_rules: InferRuleItem[]
  } | null>(null)
  /** Selected subtype code (e.g. otm, atm). Replaces covered_call-specific state. */
  const [selectedSubtype, setSelectedSubtype] = useState<string | null>(null)
  /** Configurable meta param values (e.g. otm_pct, itm_pct) for current subtype. */
  const [wizardParamValues, setWizardParamValues] = useState<Record<string, string | number>>({})
  /** @deprecated Use selectedSubtype; kept for fallback when API fails (covered_call only). */
  const [coveredCallSubtype, setCoveredCallSubtype] = useState<CoveredCallSubtype | null>(null)
  /** Step 3 optional params for Covered Call (OTM % / ITM %); used when subtype meta_params drive same keys. */
  const [wizardOtmPct, setWizardOtmPct] = useState<number>(10)
  const [wizardItmPct, setWizardItmPct] = useState<number | ''>('')
  const [setActiveInProgress, setSetActiveInProgress] = useState(false)
  /** When set, the Availability toggle for this structure id is updating. */
  const [availabilityInProgress, setAvailabilityInProgress] = useState<number | null>(null)
  /** When set, show modal with this error (e.g. backend validation failed when toggling Available). */
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)
  /** When editing, the name at open (for name-change confirmation). */
  const [originalEditName, setOriginalEditName] = useState<string | null>(null)
  /** When set, show dialog: structure name would change; user can confirm new name, edit it, or keep original. */
  const [nameConfirmDialog, setNameConfirmDialog] = useState<{
    originalName: string
    suggestedName: string
    editedName: string
  } | null>(null)
  /** When editing, snapshot at open for version dialog: version, type, subtype, meta. */
  const [originalEditVersion, setOriginalEditVersion] = useState<number | null>(null)
  const [originalEditStructureType, setOriginalEditStructureType] = useState<string | null>(null)
  const [originalEditStructureSubtype, setOriginalEditStructureSubtype] = useState<string | null>(null)
  const [originalEditMeta, setOriginalEditMeta] = useState<StructureMetaEntry[] | null>(null)
  /** After name is resolved, if version dialog is shown this is the name to use on Save. */
  const [pendingSubmitName, setPendingSubmitName] = useState<string | null>(null)
  /** When set, show dialog: Type/SubType/Meta changed — use new version? (Apple switch, default on). */
  const [versionConfirmDialog, setVersionConfirmDialog] = useState<{ useNewVersion: boolean } | null>(null)
  /** Subtype default legs from API (null = not loaded / no subtype; [] = inherit type legs; non-empty = subtype-specific). */
  const [subtypeDefaultLegs, setSubtypeDefaultLegs] = useState<StructureLeg[] | null>(null)
  const [subtypeDefaultLegsLoading, setSubtypeDefaultLegsLoading] = useState(false)
  /** When true, last save failed with legs/schema error so we highlight "Use subtype default legs" if applicable. */
  const [formErrorIsSchemaMismatch, setFormErrorIsSchemaMismatch] = useState(false)

  const isWizard = (formOpen === 'create' && !formIsCopy) || typeof formOpen === 'number'

  const filteredStructures = structures.filter((row) => {
    if (structureActiveFilter === 'all') return true
    if (structureActiveFilter === 'active') return row.is_active === true
    return row.is_active !== true
  })

  /** Heuristic: backend validation error about legs/schema (for highlighting "Use subtype default legs"). */
  const isSchemaMismatchError = useCallback((msg: string): boolean => {
    const s = msg.toLowerCase()
    return /leg\s*\d|requires exactly|must be/.test(s) || s.includes('schema')
  }, [])

  /** Compare legs by count and role/direction/option_right (for subtype default vs current). */
  const legsMatch = useCallback((a: StructureLeg[], b: StructureLeg[]): boolean => {
    if (a.length !== b.length) return false
    return a.every((leg, i) => {
      const o = b[i]
      if (!o) return false
      const r = (leg.role ?? '').toString().trim().toUpperCase()
      const r2 = (o.role ?? '').toString().trim().toUpperCase()
      const d = (leg.direction ?? '').toString().trim().toUpperCase()
      const d2 = (o.direction ?? '').toString().trim().toUpperCase()
      const opt = (leg.option_right ?? '').toString().trim().toUpperCase()
      const opt2 = (o.option_right ?? '').toString().trim().toUpperCase()
      return r === r2 && d === d2 && opt === opt2
    })
  }, [])

  const loadStructures = useCallback(() => {
    setStructuresLoading(true)
    setStructuresError(null)
    fetchStructures(false)
      .then((res) => setStructures(res.items ?? []))
      .catch((e) => setStructuresError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStructuresLoading(false))
  }, [])

  useEffect(() => {
    loadStructures()
  }, [loadStructures])

  /** Load structure types from config API on mount (for Wizard type list). */
  useEffect(() => {
    fetchStructureTypes()
      .then((res) => setStructureTypes(res.items ?? []))
      .catch(() => setStructureTypes([]))
  }, [])

  /** When subtype is selected, fetch subtype default legs (for "Use subtype default legs" in step 3). */
  useEffect(() => {
    const typeVal = (formPayload.structure_type || '').trim()
    const subVal = selectedSubtype ?? null
    if (!typeVal || !subVal || formOpen === null) {
      setSubtypeDefaultLegs(null)
      return
    }
    let cancelled = false
    setSubtypeDefaultLegsLoading(true)
    setSubtypeDefaultLegs(null)
    fetchStructureSubtypeDefaultLegs(typeVal, subVal)
      .then((res) => {
        if (!cancelled) setSubtypeDefaultLegs(res.legs ?? [])
      })
      .catch(() => {
        if (!cancelled) setSubtypeDefaultLegs(null)
      })
      .finally(() => {
        if (!cancelled) setSubtypeDefaultLegsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [formPayload.structure_type, selectedSubtype, formOpen])

  /** Whether current form structure_type has subtypes (from API or fallback covered_call). */
  const currentTypeHasSubtypes =
    structureTypes.some((t) => t.structure_type === formPayload.structure_type && t.has_subtypes) ||
    (structureTypes.length === 0 && formPayload.structure_type === 'covered_call')

  useEffect(() => {
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    fetchStrategyHistory({
      limit: 100,
      strategy_structure_id: historyStructureFilter === '' ? undefined : historyStructureFilter,
    })
      .then((res) => {
        if (!cancelled) setHistory(res.items ?? [])
      })
      .catch((e) => {
        if (!cancelled) setHistoryError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [historyStructureFilter])

  const handleSetActiveStructure = async (structureId: number) => {
    setSetActiveInProgress(true)
    try {
      const res = await postActiveStrategy(structureId, status?.active_gate_safety_strategy_id ?? null)
      if (res.ok) {
        setSetActiveMsg({ text: 'Active structure updated. Daemon uses it on next start.', isErr: false })
        loadStatus()
      } else {
        setSetActiveMsg({ text: res.error ?? 'Failed to set active structure', isErr: true })
      }
      setTimeout(() => setSetActiveMsg({ text: '', isErr: false }), 5000)
    } finally {
      setSetActiveInProgress(false)
    }
  }

  const handleClearActiveStructure = async () => {
    setSetActiveInProgress(true)
    try {
      const res = await postActiveStrategy(null, status?.active_gate_safety_strategy_id ?? null)
      if (res.ok) {
        setSetActiveMsg({ text: 'Active structure cleared.', isErr: false })
        loadStatus()
      } else {
        setSetActiveMsg({ text: res.error ?? 'Failed to clear active structure', isErr: true })
      }
      setTimeout(() => setSetActiveMsg({ text: '', isErr: false }), 5000)
    } finally {
      setSetActiveInProgress(false)
    }
  }

  const handleToggleAvailability = async (row: StrategyStructure) => {
    const id = row.strategy_structure_id
    setAvailabilityInProgress(id)
    setAvailabilityError(null)
    try {
      const full = await fetchStructure(id)
      const payload = structureToPayload(full)
      await updateStructure(id, { ...payload, is_active: !row.is_active })
      loadStructures()
    } catch (e) {
      setAvailabilityError(e instanceof Error ? e.message : String(e))
    } finally {
      setAvailabilityInProgress(null)
    }
  }

  const openCreate = () => {
    setFormIsCopy(false)
    const defaultLegs = getDefaultLegsFallback('covered_call')
    setFormPayload({ ...DEFAULT_STRUCTURE_PAYLOAD, name: 'New structure', legs: defaultLegs })
    setFormLegs(defaultLegs)
    setFormConstraints([])
    setFormNotes('')
    setFormMeta([])
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setFixedLegCount(defaultLegs.length)
    setDefaultLegsLoading(false)
    setDefaultLegsFallbackMsg(null)
    setAllowQtyPreset(false)
    setAllowStrikePreset(false)
    setAllowExpirationPreset(false)
    setWizardStep(1)
    setSelectedSubtype(null)
    setSubtypeDefaultLegs(null)
    setSubtypesConfig(null)
    setWizardParamValues({})
    setCoveredCallSubtype(null)
    setWizardOtmPct(10)
    setWizardItmPct('')
    setFormOpen('create')
  }

  const openEdit = (id: number) => {
    setFormIsCopy(false)
    setFormLoading(true)
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setSubtypeDefaultLegs(null)
    setOriginalEditName(null)
    setFixedLegCount(0)
    setDefaultLegsLoading(false)
    setDefaultLegsFallbackMsg(null)
    setFormOpen(id)
    fetchStructure(id)
      .then((row) => {
        const p = structureToPayload(row)
        setFormPayload(p)
        setFormLegs(p.legs)
        setFormConstraints(p.constraints ?? [])
        setFormNotes(p.notes ?? '')
        setFormMeta(p.meta ?? [])
        setOriginalEditName(row.name ?? null)
        const v = typeof row.version === 'number' ? row.version : typeof row.version === 'string' ? parseInt(String(row.version), 10) || 1 : 1
        setOriginalEditVersion(v)
        setOriginalEditStructureType(row.structure_type ?? null)
        setOriginalEditStructureSubtype(row.structure_subtype ?? null)
        setOriginalEditMeta(p.meta != null ? [...p.meta] : null)
        const fixedCount = getDefaultLegsFallback(p.structure_type ?? '').length
        setFixedLegCount(fixedCount)
        const legs = p.legs ?? []
        setAllowQtyPreset(legs.some((leg: StructureLeg) => (leg.quantity ?? 1) !== 1))
        setAllowStrikePreset(legs.some((leg: StructureLeg) => leg.strike != null))
        setAllowExpirationPreset(legs.some((leg: StructureLeg) => leg.expiration != null && String(leg.expiration).trim() !== ''))
        setWizardStep(3)
        if (row.structure_type) {
          fetchStructureTypeSubtypes(row.structure_type)
            .then((data) => {
              setSubtypesConfig({ subtypes: data.subtypes ?? [], infer_rules: data.infer_rules ?? [] })
              const meta = row.metadata as Record<string, unknown> | null | undefined
              let inferred: string | null = null
              if (row.structure_subtype && (data.subtypes ?? []).some((s) => s.subtype === row.structure_subtype)) {
                inferred = row.structure_subtype
              } else if (data.infer_rules?.length && meta && typeof meta === 'object') {
                for (const rule of data.infer_rules) {
                  const v = meta[rule.meta_key]
                  const match = v != null && String(v) === rule.meta_value_text
                  if (match) {
                    inferred = rule.subtype
                    break
                  }
                }
              }
              if (!inferred && row.structure_type === 'covered_call') {
                inferred = inferCoveredCallSubtypeFromMeta(row.metadata ?? null)
              }
              if (inferred) {
                setSelectedSubtype(inferred)
                setCoveredCallSubtype(inferred as CoveredCallSubtype)
              } else {
                setSelectedSubtype(null)
                setCoveredCallSubtype(null)
              }
              const paramValues: Record<string, string | number> = {}
              if (meta && typeof meta === 'object') {
                if (meta.otm_pct != null) {
                  paramValues.otm_pct = Number(meta.otm_pct)
                  setWizardOtmPct(Number(meta.otm_pct))
                }
                if (meta.itm_pct != null) {
                  paramValues.itm_pct = Number(meta.itm_pct)
                  setWizardItmPct(Number(meta.itm_pct))
                }
                data.subtypes?.find((s) => s.subtype === inferred)?.meta_params?.forEach((mp) => {
                  if (mp.param_kind !== 'fixed' && meta[mp.meta_key] != null) {
                    const val = meta[mp.meta_key]
                    paramValues[mp.meta_key] = typeof val === 'number' ? val : Number(val) || String(val)
                  }
                })
              }
              setWizardParamValues(paramValues)
            })
            .catch(() => {
              if (row.structure_type === 'covered_call') {
                const subtype =
                  row.structure_subtype && (COVERED_CALL_SUBTYPES as readonly string[]).includes(row.structure_subtype)
                    ? (row.structure_subtype as CoveredCallSubtype)
                    : inferCoveredCallSubtypeFromMeta(row.metadata ?? null)
                setCoveredCallSubtype(subtype)
                const meta = row.metadata
                if (meta && typeof meta === 'object') {
                  if (meta.otm_pct != null) setWizardOtmPct(Number(meta.otm_pct))
                  if (meta.itm_pct != null) setWizardItmPct(Number(meta.itm_pct))
                }
              }
            })
        } else if (row.structure_type === 'covered_call') {
          const subtype =
            row.structure_subtype && (COVERED_CALL_SUBTYPES as readonly string[]).includes(row.structure_subtype)
              ? (row.structure_subtype as CoveredCallSubtype)
              : inferCoveredCallSubtypeFromMeta(row.metadata ?? null)
          setCoveredCallSubtype(subtype)
          const meta = row.metadata
          if (meta && typeof meta === 'object') {
            if (meta.otm_pct != null) setWizardOtmPct(Number(meta.otm_pct))
            if (meta.itm_pct != null) setWizardItmPct(Number(meta.itm_pct))
          }
        } else {
          setCoveredCallSubtype(null)
          setSelectedSubtype(null)
          setSubtypesConfig(null)
          setWizardParamValues({})
        }
      })
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const openCopy = (id: number) => {
    setFormIsCopy(true)
    setFormLoading(true)
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setSubtypeDefaultLegs(null)
    setFixedLegCount(0)
    setDefaultLegsLoading(false)
    setDefaultLegsFallbackMsg(null)
    setFormOpen('create')
    fetchStructure(id)
      .then((row) => {
        const p = structureToPayload(row)
        p.name = `${row.name} (copy)`
        setFormPayload(p)
        setFormLegs(p.legs)
        setFormConstraints(p.constraints ?? [])
        setFormNotes(p.notes ?? '')
        setFormMeta(p.meta ?? [])
        const fixedCount = getDefaultLegsFallback(p.structure_type ?? '').length
        setFixedLegCount(fixedCount)
        const legs = p.legs ?? []
        setAllowQtyPreset(legs.some((leg: StructureLeg) => (leg.quantity ?? 1) !== 1))
        setAllowStrikePreset(legs.some((leg: StructureLeg) => leg.strike != null))
        setAllowExpirationPreset(legs.some((leg: StructureLeg) => leg.expiration != null && String(leg.expiration).trim() !== ''))
      })
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const closeForm = () => {
    setFormOpen(null)
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setSubtypeDefaultLegs(null)
    setOriginalEditName(null)
    setOriginalEditVersion(null)
    setOriginalEditStructureType(null)
    setOriginalEditStructureSubtype(null)
    setOriginalEditMeta(null)
    setPendingSubmitName(null)
    setNameConfirmDialog(null)
    setVersionConfirmDialog(null)
    setWizardStep(1)
    setSelectedSubtype(null)
    setSubtypesConfig(null)
    setWizardParamValues({})
    setCoveredCallSubtype(null)
  }

  /** Build default structure name from type + subtype + params (used when entering step 3). */
  const buildWizardDefaultName = (): string => {
    const typeLabel =
      structureTypes.find((t) => t.structure_type === formPayload.structure_type)?.display_label ??
      getStructureTypeLabel(formPayload.structure_type)
    const sub = selectedSubtype ?? coveredCallSubtype
    const subLabel =
      subtypesConfig?.subtypes?.find((s) => s.subtype === sub)?.display_label ??
      (coveredCallSubtype ? COVERED_CALL_SUBTYPE_LABELS[coveredCallSubtype] : null)
    if (sub && subLabel) {
      const pct = wizardParamValues['otm_pct'] ?? wizardOtmPct
      const itmPct = wizardParamValues['itm_pct'] ?? wizardItmPct
      if ((sub === 'otm' || sub === 'deep_otm') && pct != null) return `${typeLabel} - ${subLabel} (${pct}%)`
      if (sub === 'itm' && itmPct !== '' && itmPct != null) return `${typeLabel} - ${subLabel} (${itmPct}%)`
      return `${typeLabel} - ${subLabel}`
    }
    return typeLabel
  }

  const goWizardNext = () => {
    if (wizardStep === 1) {
      const hasSubtypesToShow =
        currentTypeHasSubtypes &&
        (subtypesConfig?.subtypes?.length || formPayload.structure_type === 'covered_call')
      if (hasSubtypesToShow) setWizardStep(2)
      else {
        setWizardStep(3)
        updateForm({ name: buildWizardDefaultName() })
      }
    } else if (wizardStep === 2) {
      setWizardStep(3)
      updateForm({ name: buildWizardDefaultName() })
    }
  }

  /** Current meta as would be in payload (from infer_rules + wizardParamValues or fallback covered_call). */
  const getCurrentBuiltMeta = (): StructureMetaEntry[] => {
    if (subtypesConfig && selectedSubtype) {
      const subtypeMetaKeys = new Set(
        [
          ...subtypesConfig.infer_rules.map((r) => r.meta_key),
          ...(subtypesConfig.subtypes.find((s) => s.subtype === selectedSubtype)?.meta_params.map((p) => p.meta_key) ?? []),
        ]
      )
      let meta: StructureMetaEntry[] = (formMeta ?? []).filter((m) => m.meta_key && !subtypeMetaKeys.has(m.meta_key))
      subtypesConfig.infer_rules
        .filter((r) => r.subtype === selectedSubtype)
        .forEach((r) => meta.push({ meta_key: r.meta_key, meta_value_text: r.meta_value_text }))
      subtypesConfig.subtypes
        .find((s) => s.subtype === selectedSubtype)
        ?.meta_params?.forEach((p) => {
          if (p.param_kind !== 'fixed') {
            const v = wizardParamValues[p.meta_key]
            if (v !== undefined && v !== '') meta.push({ meta_key: p.meta_key, meta_value_text: String(v) })
          }
        })
      return meta
    }
    const subtypeMetaKeys = new Set<string>(COVERED_CALL_SUBTYPE_META_KEYS)
    let meta: StructureMetaEntry[] =
      formPayload.structure_type === 'covered_call' && coveredCallSubtype
        ? (formMeta ?? []).filter((m) => m.meta_key && !subtypeMetaKeys.has(m.meta_key))
        : [...(formMeta ?? [])]
    if (formPayload.structure_type === 'covered_call' && coveredCallSubtype) {
      const params: CoveredCallSubtypeParams = {}
      if (coveredCallSubtype === 'otm' || coveredCallSubtype === 'deep_otm') params.otm_pct = wizardOtmPct
      if (coveredCallSubtype === 'itm' && wizardItmPct !== '') params.itm_pct = Number(wizardItmPct)
      const subtypeMeta = getCoveredCallSubtypeMeta(coveredCallSubtype, Object.keys(params).length ? params : undefined)
      meta = [...meta, ...subtypeMeta]
    }
    return meta
  }

  const metaEntriesEqual = (a: StructureMetaEntry[], b: StructureMetaEntry[]): boolean => {
    const norm = (arr: StructureMetaEntry[]) =>
      [...arr]
        .filter((m) => m.meta_key)
        .sort((x, y) => (x.meta_key ?? '').localeCompare(y.meta_key ?? ''))
        .map((m) => `${m.meta_key}:${m.meta_value_text ?? ''}`)
        .join('|')
    return norm(a) === norm(b)
  }

  const haveTypeSubtypeOrMetaChanged = (): boolean => {
    if (originalEditStructureType == null) return false
    const currentType = (formPayload.structure_type || '').trim()
    if (currentType !== originalEditStructureType) return true
    const currentSubtype = selectedSubtype ?? (formPayload.structure_type === 'covered_call' && coveredCallSubtype ? coveredCallSubtype : null)
    const origSubtype = originalEditStructureSubtype ?? null
    if (currentSubtype !== origSubtype) return true
    if (originalEditMeta == null) return getCurrentBuiltMeta().length > 0
    return !metaEntriesEqual(getCurrentBuiltMeta(), originalEditMeta)
  }

  /** Build wizard payload with a given name and optional version override. */
  const buildWizardPayload = (name: string, versionOverride?: number): StructurePayload => {
    const structure_type = (formPayload.structure_type || '').trim()
    const meta = getCurrentBuiltMeta()
    const sub = selectedSubtype ?? coveredCallSubtype
    return {
      name: name.trim(),
      structure_type,
      structure_subtype: currentTypeHasSubtypes && sub ? sub : null,
      legs: formLegs,
      constraints: formConstraints.length ? formConstraints : undefined,
      version: versionOverride !== undefined ? versionOverride : (formPayload.version ?? 1),
      is_active: formPayload.is_active ?? true,
      notes: formNotes.trim() || undefined,
      meta: meta.length ? meta : undefined,
    }
  }

  const doWizardSubmit = async (chosenName: string, versionOverride?: number) => {
    const name = chosenName.trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    setFormError(null)
    setFormLoading(true)
    setNameConfirmDialog(null)
    setVersionConfirmDialog(null)
    setPendingSubmitName(null)
    try {
      const payload = buildWizardPayload(name, versionOverride)
      if (formOpen === 'create') {
        await createStructure(payload)
      } else {
        await updateStructure(formOpen as number, payload)
      }
      closeForm()
      loadStructures()
      loadStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFormError(msg)
      setFormErrorIsSchemaMismatch(isSchemaMismatchError(msg))
    } finally {
      setFormLoading(false)
    }
  }

  /** If edit and Type/SubType/Meta changed, show version dialog and store chosenName; else submit. */
  const trySubmitWithVersionCheck = (chosenName: string) => {
    const isEdit = typeof formOpen === 'number'
    if (isEdit && haveTypeSubtypeOrMetaChanged()) {
      setPendingSubmitName(chosenName)
      setNameConfirmDialog(null)
      setVersionConfirmDialog({ useNewVersion: true })
      return
    }
    void doWizardSubmit(chosenName)
  }

  const submitWizardForm = async () => {
    const name = (formPayload.name || '').trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    const structure_type = (formPayload.structure_type || '').trim()
    if (!structure_type) {
      setFormError('Structure type is required')
      return
    }
    if (formOpen === 'create' && formPayload.structure_type === 'covered_call' && !coveredCallSubtype) {
      setFormError('Please select a Covered Call subtype in step 2.')
      return
    }
    const suggestedName = buildWizardDefaultName()
    const isEdit = typeof formOpen === 'number'
    if (isEdit && originalEditName != null && suggestedName !== originalEditName) {
      setNameConfirmDialog({
        originalName: originalEditName,
        suggestedName,
        editedName: suggestedName,
      })
      return
    }
    trySubmitWithVersionCheck(name)
  }

  const updateForm = (patch: Partial<StructurePayload>) => {
    setFormPayload((prev) => ({ ...prev, ...patch }))
  }

  /** When user selects a structure type: load default legs and, if has_subtypes, load subtypes. */
  const handleStructureTypeChange = useCallback(
    (structure_type: string) => {
      updateForm({ structure_type })
      setDefaultLegsLoading(true)
      setDefaultLegsFallbackMsg(null)
      setSubtypesConfig(null)
      setSelectedSubtype(null)
      setWizardParamValues({})
      setCoveredCallSubtype(null)
      const typeHasSubtypes =
        structureTypes.some((t) => t.structure_type === structure_type && t.has_subtypes) ||
        (structureTypes.length === 0 && structure_type === 'covered_call')

      fetchStructureTypeDefaultLegs(structure_type)
        .then((res) => {
          const legs = res.legs ?? []
          if (legs.length > 0) {
            setFormLegs(legs)
            setFixedLegCount(legs.length)
            setDefaultLegsFallbackMsg(null)
          } else {
            const fallback = getDefaultLegsFallback(structure_type)
            setFormLegs(fallback)
            setFixedLegCount(fallback.length)
            setDefaultLegsFallbackMsg(fallback.length > 0 ? 'Default legs from local fallback.' : null)
          }
        })
        .catch(() => {
          const fallback = getDefaultLegsFallback(structure_type)
          setFormLegs(fallback)
          setFixedLegCount(fallback.length)
          setDefaultLegsFallbackMsg(
            fallback.length > 0 ? 'Default legs from local fallback (API failed).' : null
          )
        })
        .finally(() => setDefaultLegsLoading(false))

      if (typeHasSubtypes) {
        fetchStructureTypeSubtypes(structure_type)
          .then((data) => setSubtypesConfig({ subtypes: data.subtypes ?? [], infer_rules: data.infer_rules ?? [] }))
          .catch(() => setSubtypesConfig(null))
      }
    },
    [structureTypes, updateForm]
  )

  const submitForm = async () => {
    const name = (formPayload.name || '').trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    const structure_type = (formPayload.structure_type || '').trim()
    if (!structure_type) {
      setFormError('Structure type is required')
      return
    }
    setFormError(null)
    setFormLoading(true)
    const sub = selectedSubtype ?? (formPayload.structure_type === 'covered_call' ? coveredCallSubtype : null) ?? formPayload.structure_subtype ?? null
    const payload: StructurePayload = {
      name,
      structure_type,
      structure_subtype: formPayload.structure_type === 'covered_call' ? sub : undefined,
      legs: formLegs,
      constraints: formConstraints.length ? formConstraints : undefined,
      version: formPayload.version ?? 1,
      is_active: formPayload.is_active ?? true,
      notes: formNotes.trim() || undefined,
      meta: formMeta.length ? formMeta : undefined,
    }
    try {
      if (formOpen === 'create') {
        await createStructure(payload)
      } else {
        await updateStructure(formOpen as number, payload)
      }
      closeForm()
      loadStructures()
      loadStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFormError(msg)
      setFormErrorIsSchemaMismatch(isSchemaMismatchError(msg))
    } finally {
      setFormLoading(false)
    }
  }

  const updateLeg = (index: number, patch: Partial<StructureLeg>) => {
    setFormLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)))
  }
  const addLeg = () => {
    setFormLegs((prev) => [...prev, { role: '', direction: '', option_right: 'C', quantity: 1, strike: undefined, expiration: '' }])
  }
  const removeLeg = (index: number) => {
    setFormLegs((prev) => prev.filter((_, i) => i !== index))
  }
  const updateConstraint = (index: number, patch: Partial<StructureConstraint>) => {
    setFormConstraints((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }
  const addConstraint = () => {
    setFormConstraints((prev) => [...prev, { constraint_type: '', constraint_value_text: '', constraint_value_int: undefined }])
  }
  const removeConstraint = (index: number) => {
    setFormConstraints((prev) => prev.filter((_, i) => i !== index))
  }
  const updateMeta = (index: number, patch: Partial<StructureMetaEntry>) => {
    setFormMeta((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }
  const addMeta = () => {
    setFormMeta((prev) => [...prev, { meta_key: '', meta_value_text: '' }])
  }
  const removeMeta = (index: number) => {
    setFormMeta((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="card process-section">
      {/* Availability toggle error modal: backend rejected the change (e.g. validation), list stays visible */}
      {availabilityError != null && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => setAvailabilityError(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="availability-error-modal-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="availability-error-modal-title">Cannot change availability</h3>
            <p style={{ whiteSpace: 'pre-wrap', marginBottom: 'var(--space-3)' }}>{availabilityError}</p>
            <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
              The structure was not changed. Fix the issue in Edit (e.g. leg role) and try again.
            </p>
            <div className="data-reset-modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAvailabilityError(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {nameConfirmDialog != null && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => setNameConfirmDialog(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="name-confirm-modal-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="name-confirm-modal-title">Structure name will change</h3>
            <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
              Current name: <strong>{nameConfirmDialog.originalName}</strong>
            </p>
            <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
              The suggested new name (based on type and parameters) is below. You can keep it, edit it, or abandon the name change and save with the current name.
            </p>
            <div className="gates-form-row" style={{ marginBottom: 'var(--space-3)' }}>
              <label htmlFor="name-confirm-new-name">New name</label>
              <input
                id="name-confirm-new-name"
                type="text"
                value={nameConfirmDialog.editedName}
                onChange={(e) =>
                  setNameConfirmDialog((prev) =>
                    prev ? { ...prev, editedName: e.target.value } : null
                  )
                }
                placeholder="Structure name"
                style={{ width: '100%', maxWidth: '400px' }}
              />
            </div>
            <div className="data-reset-modal-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  trySubmitWithVersionCheck(
                    (nameConfirmDialog.editedName || '').trim() || nameConfirmDialog.suggestedName
                  )
                }
                disabled={formLoading}
              >
                Use new name and save
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => originalEditName && trySubmitWithVersionCheck(originalEditName)}
                disabled={formLoading}
              >
                Keep current name and save
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setNameConfirmDialog(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {versionConfirmDialog != null && pendingSubmitName != null && originalEditVersion != null && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => {
            setVersionConfirmDialog(null)
            setPendingSubmitName(null)
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="version-confirm-modal-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="version-confirm-modal-title">Type, SubType, or Meta changed</h3>
            <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
              Use a new version (Version + 1) for this structure? If not, changes will be saved with the current version.
            </p>
            <div
              className="gates-form-row"
              style={{
                alignItems: 'center',
                gap: 'var(--space-2)',
                marginBottom: 'var(--space-3)',
              }}
            >
              <label
                className="toggle-switch"
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                htmlFor="version-confirm-use-new"
              >
                <input
                  id="version-confirm-use-new"
                  type="checkbox"
                  checked={versionConfirmDialog.useNewVersion}
                  onChange={(e) =>
                    setVersionConfirmDialog((prev) =>
                      prev ? { ...prev, useNewVersion: e.target.checked } : null
                    )
                  }
                  aria-label="Use new version (Version + 1)"
                />
                <span className="toggle-switch-caption">Use new version (Version + 1)</span>
              </label>
            </div>
            <div className="data-reset-modal-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  doWizardSubmit(
                    pendingSubmitName,
                    versionConfirmDialog.useNewVersion ? originalEditVersion + 1 : originalEditVersion
                  )
                }
                disabled={formLoading}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setVersionConfirmDialog(null)
                  setPendingSubmitName(null)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 id="strategy-structure-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Strategy / {breadcrumbLabel}
        <InfoTooltip text="View and set active strategy structure and gate safety set; daemon uses these on next start." />
      </h2>

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="section-subtitle">Current active</h3>
        <div className="statusSummary">
          <div>
            <strong>Structure:</strong> {status?.active_strategy_structure_name ?? '—'}
            {status?.active_strategy_structure_id != null && ` (${status.active_strategy_structure_id})`}
          </div>
          <div>
            <strong>Gate safety:</strong> {status?.active_gate_safety_strategy_name ?? '—'}
            {status?.active_gate_safety_strategy_id != null && ` (${status.active_gate_safety_strategy_id})`}
          </div>
        </div>
        <p className="section-hint">Daemon uses these on next start.</p>
      </section>

      {setActiveMsg.text && (
        <p className={setActiveMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: 'var(--space-2)' }}>
          {setActiveMsg.text}
        </p>
      )}

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <h3 className="section-subtitle" style={{ margin: 0 }}>Structure strategies</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <div className="structure-active-filter-pills" role="group" aria-label="Filter by availability">
              {(['all', 'active', 'inactive'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`structure-active-filter-pill ${structureActiveFilter === value ? 'active' : ''}`}
                  onClick={() => setStructureActiveFilter(value)}
                >
                  {value === 'all' ? 'All' : value === 'active' ? 'Available' : 'Unavailable'}
                </button>
              ))}
            </div>
            <button type="button" className="btn-primary" onClick={openCreate}>
              Create structure
            </button>
          </div>
        </div>
        {structuresLoading && <p className="section-hint">Loading…</p>}
        {structuresError && <p className="msg-error">{structuresError}</p>}
        {!structuresLoading && !structuresError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Version</th>
                  <th>Available</th>
                  <th>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                      In use
                      <InfoTooltip text="Structure selected for the daemon. Only one can be in use." />
                    </span>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredStructures.map((row) => {
                  const isCurrentActive = status?.active_strategy_structure_id === row.strategy_structure_id
                  const availabilityUpdating = availabilityInProgress === row.strategy_structure_id
                  return (
                    <tr key={row.strategy_structure_id}>
                      <td>{row.name}</td>
                      <td>{getStructureTypeLabel(row.structure_type)}</td>
                      <td>{row.version ?? '—'}</td>
                      <td>
                        <label className="toggle-switch" style={{ cursor: availabilityUpdating ? 'not-allowed' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={row.is_active}
                            disabled={!!availabilityInProgress}
                            onChange={() => void handleToggleAvailability(row)}
                            aria-label={`Mark "${row.name}" as ${row.is_active ? 'unavailable' : 'available'}`}
                          />
                        </label>
                      </td>
                      <td>
                        <label className="toggle-switch" style={{ cursor: setActiveInProgress ? 'not-allowed' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={isCurrentActive}
                            disabled={setActiveInProgress}
                            onChange={(e) => {
                              if (e.target.checked) {
                                void handleSetActiveStructure(row.strategy_structure_id)
                              } else {
                                void handleClearActiveStructure()
                              }
                            }}
                            aria-label={`Use "${row.name}" as structure in use by daemon`}
                          />
                        </label>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-manage"
                          onClick={() => openEdit(row.strategy_structure_id)}
                        >
                          Edit
                        </button>
                        {' '}
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => openCopy(row.strategy_structure_id)}
                        >
                          Copy
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!structuresLoading && !structuresError && structures.length === 0 && (
          <p className="section-hint">No structure strategies in database.</p>
        )}
        {!structuresLoading && !structuresError && structures.length > 0 && filteredStructures.length === 0 && (
          <p className="section-hint">No structures match the current filter.</p>
        )}
      </section>

      {formOpen !== null && (
        <section className="strategy-section gates-form-section" style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--color-surface-elevated)', borderRadius: '8px' }}>
          <h3 className="section-subtitle">
            {formOpen === 'create' ? (formIsCopy ? 'New structure (copy)' : 'New structure') : `Edit structure ${formOpen}`}
          </h3>
          {formLoading && !formPayload.name && <p className="section-hint">Loading…</p>}
          {formError && (
            <div className="msg-error" style={{ marginBottom: 'var(--space-2)' }}>
              <p>{formError}</p>
              {formErrorIsSchemaMismatch && selectedSubtype && (
                <p className="form-hint" style={{ marginTop: 'var(--space-1)' }}>
                  Legs do not match the expected schema for subtype &quot;{selectedSubtype}&quot;. You can reset to subtype defaults from the legs section.
                </p>
              )}
            </div>
          )}
          {defaultLegsFallbackMsg && (
            <p className="form-hint msg-warning" style={{ marginBottom: 'var(--space-2)' }} role="alert">
              {defaultLegsFallbackMsg}
            </p>
          )}

          {isWizard ? (
            <>
              <div className="structure-wizard-stepper" role="list" aria-label="Wizard steps">
                <div
                  className={`structure-wizard-step-item ${wizardStep > 1 ? 'structure-wizard-step-done' : wizardStep === 1 ? 'structure-wizard-step-active' : ''}`}
                  role="listitem"
                  aria-current={wizardStep === 1 ? 'step' : undefined}
                  onClick={wizardStep > 1 ? () => setWizardStep(1) : undefined}
                  style={wizardStep > 1 ? { cursor: 'pointer' } : undefined}
                >
                  <div className="structure-wizard-step-head">
                    <div className="structure-wizard-step-circle">
                      {wizardStep > 1 ? (
                        <span className="structure-wizard-step-check" aria-hidden>✓</span>
                      ) : (
                        <span>1</span>
                      )}
                    </div>
                    <div className="structure-wizard-step-connector" aria-hidden />
                  </div>
                  <span className="structure-wizard-step-label">Structure type</span>
                </div>
                <div
                  className={`structure-wizard-step-item ${wizardStep > 2 ? 'structure-wizard-step-done' : wizardStep === 2 ? 'structure-wizard-step-active' : formPayload.structure_type !== 'covered_call' ? 'structure-wizard-step-skip' : ''}`}
                  role="listitem"
                  aria-current={wizardStep === 2 ? 'step' : undefined}
                  onClick={wizardStep > 2 ? () => setWizardStep(2) : undefined}
                  style={wizardStep > 2 ? { cursor: 'pointer' } : undefined}
                >
                  <div className="structure-wizard-step-head">
                    <div className="structure-wizard-step-circle">
                      {wizardStep > 2 ? (
                        <span className="structure-wizard-step-check" aria-hidden>✓</span>
                      ) : (
                        <span>2</span>
                      )}
                    </div>
                    <div className="structure-wizard-step-connector" aria-hidden />
                  </div>
                  <span className="structure-wizard-step-label">Subtype</span>
                </div>
                <div
                  className={`structure-wizard-step-item structure-wizard-step-item-last ${wizardStep === 3 ? 'structure-wizard-step-active' : ''}`}
                  role="listitem"
                  aria-current={wizardStep === 3 ? 'step' : undefined}
                >
                  <div className="structure-wizard-step-head">
                    <div className="structure-wizard-step-circle">
                      <span>3</span>
                    </div>
                  </div>
                  <span className="structure-wizard-step-label">Details</span>
                </div>
              </div>

              {wizardStep === 1 && (
                <div className="structure-wizard-step">
                  <h4 className="gates-form-group-title">Choose structure type</h4>
                  <div className="gates-form-row gates-form-row--structure-type">
                    <div className="structure-type-picker" role="radiogroup" aria-label="Structure type">
                      {(structureTypes.length > 0
                        ? structureTypes
                        : STRUCTURE_TYPES.map((st, i) => ({
                            structure_type: st,
                            display_label: getStructureTypeLabel(st),
                            sort_order: i,
                            has_subtypes: st === 'covered_call',
                          }))
                      ).map((typeItem) => (
                        <label
                          key={typeItem.structure_type}
                          className={`structure-type-option ${formPayload.structure_type === typeItem.structure_type ? 'structure-type-option--selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="structure_type_wizard"
                            value={typeItem.structure_type}
                            checked={formPayload.structure_type === typeItem.structure_type}
                            onChange={() => handleStructureTypeChange(typeItem.structure_type)}
                          />
                          <span>{typeItem.display_label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {defaultLegsLoading && <p className="form-hint">Loading default legs…</p>}
                </div>
              )}

              {wizardStep === 2 && currentTypeHasSubtypes && (
                <div className="structure-wizard-step">
                  {subtypesConfig?.subtypes?.length ? (
                    <>
                      <h4 className="gates-form-group-title">Choose subtype</h4>
                      <div className="structure-wizard-subtype-picker" role="radiogroup" aria-label="Subtype">
                        {subtypesConfig.subtypes.map((subItem) => (
                          <label
                            key={subItem.subtype}
                            className={`covered-call-subtype-option ${selectedSubtype === subItem.subtype ? 'covered-call-subtype-option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="structure_subtype"
                              value={subItem.subtype}
                              checked={selectedSubtype === subItem.subtype}
                              onChange={() => {
                                setSelectedSubtype(subItem.subtype)
                                setCoveredCallSubtype(subItem.subtype as CoveredCallSubtype)
                                const initial: Record<string, string | number> = {}
                                subItem.meta_params.forEach((p) => {
                                  if (p.param_kind !== 'fixed' && p.default_value_text != null && p.default_value_text !== '') {
                                    const num = Number(p.default_value_text)
                                    initial[p.meta_key] = Number.isFinite(num) ? num : p.default_value_text
                                  }
                                })
                                setWizardParamValues(initial)
                                if (subItem.subtype === 'deep_otm') setWizardOtmPct(20)
                                else if (subItem.subtype === 'otm') setWizardOtmPct(10)
                              }}
                            />
                            <span>{subItem.display_label}</span>
                          </label>
                        ))}
                      </div>

                      {selectedSubtype && (() => {
                        const subItem = subtypesConfig.subtypes.find((s) => s.subtype === selectedSubtype)
                        if (!subItem) return null
                        return (
                          <div className="covered-call-subtype-description" style={{ marginTop: 'var(--space-4)' }}>
                            <h5 className="gates-form-group-title" style={{ marginBottom: 'var(--space-2)' }}>{subItem.display_label}</h5>
                            {subItem.example != null && (
                              <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
                                <strong>Example:</strong> {subItem.example}
                              </p>
                            )}
                            {subItem.characteristics?.length > 0 && (
                              <>
                                <p className="form-hint" style={{ marginBottom: 'var(--space-1)' }}><strong>Characteristics:</strong></p>
                                <ul className="covered-call-subtype-list" style={{ marginBottom: 'var(--space-2)', paddingLeft: '1.25rem' }}>
                                  {subItem.characteristics.map((c, i) => (
                                    <li key={i} className="form-hint" style={{ marginBottom: 'var(--space-1)' }}>{c}</li>
                                  ))}
                                </ul>
                              </>
                            )}
                            {subItem.nature != null && subItem.nature !== '' && (
                              <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
                                <strong>Nature:</strong> {subItem.nature}
                              </p>
                            )}
                            {subItem.typical_use != null && (
                              <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
                                <strong>Typical use:</strong> {subItem.typical_use}
                              </p>
                            )}
                            {(subItem.subtype_explanation != null || subItem.meta_params?.some((p) => p.param_kind !== 'fixed')) && (
                              <div className="gates-form-group" style={{ marginTop: 'var(--space-3)' }}>
                                <h5 className="gates-form-group-title" style={{ marginBottom: 'var(--space-2)' }}>Configurable parameters (strategy_structure_meta)</h5>
                                {subItem.subtype_explanation != null && subItem.subtype_explanation !== '' && (
                                  <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>{subItem.subtype_explanation}</p>
                                )}
                                {subItem.meta_params
                                  ?.filter((p) => p.param_kind !== 'fixed')
                                  .map((p) => (
                                    <div key={p.meta_key} className="gates-form-row" style={{ alignItems: 'center', marginBottom: 'var(--space-2)' }}>
                                      <label style={{ minWidth: '120px' }}>{p.display_label ?? p.meta_key}</label>
                                      <input
                                        type="number"
                                        min={p.param_kind === 'percent' ? 1 : 0}
                                        max={p.param_kind === 'percent' ? 50 : undefined}
                                        value={wizardParamValues[p.meta_key] ?? p.default_value_text ?? ''}
                                        onChange={(e) => {
                                          const v = e.target.value === '' ? '' : (parseInt(e.target.value, 10) ?? e.target.value)
                                          setWizardParamValues((prev) => ({ ...prev, [p.meta_key]: v as string | number }))
                                          if (p.meta_key === 'otm_pct') setWizardOtmPct(typeof v === 'number' ? v : 10)
                                          if (p.meta_key === 'itm_pct') setWizardItmPct(typeof v === 'number' ? v : '')
                                        }}
                                        aria-label={p.display_label ?? p.meta_key}
                                      />
                                      {p.default_value_text != null && (
                                        <span className="form-hint" style={{ marginLeft: 'var(--space-2)' }}>Default {p.default_value_text}</span>
                                      )}
                                    </div>
                                  ))}
                                {subItem.meta_params?.some((p) => p.param_kind === 'fixed') && subItem.meta_params?.filter((p) => p.param_kind === 'fixed').length === subItem.meta_params?.length && (
                                  <p className="form-hint">No extra parameters (strike rule from subtype).</p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </>
                  ) : formPayload.structure_type === 'covered_call' ? (
                    <>
                      <h4 className="gates-form-group-title">Choose Covered Call subtype</h4>
                      <div className="structure-wizard-subtype-picker" role="radiogroup" aria-label="Covered Call subtype">
                        {COVERED_CALL_SUBTYPES.map((sub) => (
                          <label
                            key={sub}
                            className={`covered-call-subtype-option ${coveredCallSubtype === sub ? 'covered-call-subtype-option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="covered_call_subtype"
                              value={sub}
                              checked={coveredCallSubtype === sub}
                              onChange={() => {
                                setCoveredCallSubtype(sub)
                                if (sub === 'deep_otm') setWizardOtmPct(20)
                                else if (sub === 'otm') setWizardOtmPct(10)
                              }}
                            />
                            <span>{COVERED_CALL_SUBTYPE_LABELS[sub]}</span>
                          </label>
                        ))}
                      </div>
                      {coveredCallSubtype && COVERED_CALL_SUBTYPE_DESCRIPTIONS[coveredCallSubtype] && (
                        <div className="covered-call-subtype-description" style={{ marginTop: 'var(--space-4)' }}>
                          <h5 className="gates-form-group-title" style={{ marginBottom: 'var(--space-2)' }}>{COVERED_CALL_SUBTYPE_LABELS[coveredCallSubtype]}</h5>
                          <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
                            <strong>Example:</strong> {COVERED_CALL_SUBTYPE_DESCRIPTIONS[coveredCallSubtype].example}
                          </p>
                          <p className="form-hint" style={{ marginBottom: 'var(--space-1)' }}><strong>Characteristics:</strong></p>
                          <ul className="covered-call-subtype-list" style={{ marginBottom: 'var(--space-2)', paddingLeft: '1.25rem' }}>
                            {COVERED_CALL_SUBTYPE_DESCRIPTIONS[coveredCallSubtype].characteristics.map((c, i) => (
                              <li key={i} className="form-hint" style={{ marginBottom: 'var(--space-1)' }}>{c}</li>
                            ))}
                          </ul>
                          {COVERED_CALL_SUBTYPE_DESCRIPTIONS[coveredCallSubtype].nature && (
                            <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
                              <strong>Nature:</strong> {COVERED_CALL_SUBTYPE_DESCRIPTIONS[coveredCallSubtype].nature}
                            </p>
                          )}
                          <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
                            <strong>Typical use:</strong> {COVERED_CALL_SUBTYPE_DESCRIPTIONS[coveredCallSubtype].use}
                          </p>
                          <div className="gates-form-group" style={{ marginTop: 'var(--space-3)' }}>
                            <h5 className="gates-form-group-title" style={{ marginBottom: 'var(--space-2)' }}>Configurable parameters (strategy_structure_meta)</h5>
                            <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
                              Underlying is stock by default. Option strike is resolved when the structure is applied; set below to constrain (e.g. OTM %).
                            </p>
                            {(coveredCallSubtype === 'otm' || coveredCallSubtype === 'deep_otm') && (
                              <div className="gates-form-row" style={{ alignItems: 'center' }}>
                                <label style={{ minWidth: '100px' }}>OTM % (call strike)</label>
                                <input
                                  type="number"
                                  min={1}
                                  max={50}
                                  value={wizardOtmPct}
                                  onChange={(e) => setWizardOtmPct(parseInt(e.target.value, 10) || 10)}
                                  aria-label="OTM percentage for short call"
                                />
                                <span className="form-hint" style={{ marginLeft: 'var(--space-2)' }}>
                                  {coveredCallSubtype === 'deep_otm' ? 'Default 20%' : 'Default 10%'} — stored as otm_pct in meta
                                </span>
                              </div>
                            )}
                            {coveredCallSubtype === 'atm' && (
                              <p className="form-hint">No extra parameters. Call strike rule: ATM (resolved at trade).</p>
                            )}
                            {coveredCallSubtype === 'itm' && (
                              <div className="gates-form-row" style={{ alignItems: 'center' }}>
                                <label style={{ minWidth: '120px' }}>ITM % (optional)</label>
                                <input
                                  type="number"
                                  min={0}
                                  value={wizardItmPct}
                                  onChange={(e) => setWizardItmPct(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                                  placeholder="Optional"
                                  aria-label="ITM percentage for short call"
                                />
                                <span className="form-hint" style={{ marginLeft: 'var(--space-2)' }}>Stored as itm_pct in meta when set</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="form-hint">No subtype for this structure type. Click Next to continue.</p>
                  )}
                </div>
              )}

              {wizardStep === 3 && (
                <div className="structure-wizard-step">
                  <div className="gates-form-group">
                    <h4 className="gates-form-group-title">Details</h4>
                    <div className="gates-form-row">
                      <label>Name</label>
                      <div>
                        <input
                          type="text"
                          value={formPayload.name}
                          onChange={(e) => updateForm({ name: e.target.value })}
                          placeholder="Structure name"
                          style={{ width: '100%', maxWidth: '400px' }}
                        />
                        <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                          Auto-filled from structure type and subtype; you can edit.
                        </p>
                      </div>
                    </div>
                    <div className="gates-form-row">
                      <label>Version</label>
                      <div>
                        <input
                          type="number"
                          min={1}
                          value={formPayload.version ?? 1}
                          onChange={(e) => updateForm({ version: parseInt(e.target.value, 10) || 1 })}
                          disabled={typeof formOpen === 'number'}
                          aria-label="Version"
                        />
                        {typeof formOpen === 'number' && (
                          <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                            Read-only when editing. Use new version (Version + 1) is offered on Save when Type, SubType, or Meta change.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="gates-form-row">
                      <label className="toggle-switch" style={{ cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={formPayload.is_active ?? true}
                          onChange={(e) => updateForm({ is_active: e.target.checked })}
                          aria-label="Available"
                        />
                        <span className="toggle-switch-caption">Available</span>
                      </label>
                    </div>
                    {(subtypesConfig && selectedSubtype && subtypesConfig.subtypes.find((s) => s.subtype === selectedSubtype)?.meta_params?.some((p) => p.param_kind !== 'fixed')) ? (
                      <div className="gates-form-group" style={{ marginTop: 'var(--space-3)' }}>
                        <h4 className="gates-form-group-title">Subtype options</h4>
                        {subtypesConfig.subtypes
                          .find((s) => s.subtype === selectedSubtype)
                          ?.meta_params?.filter((p) => p.param_kind !== 'fixed')
                          .map((p) => (
                            <div key={p.meta_key} className="gates-form-row" style={{ alignItems: 'center' }}>
                              <label style={{ minWidth: '100px' }}>{p.display_label ?? p.meta_key}</label>
                              <input
                                type="number"
                                min={p.param_kind === 'percent' ? 1 : 0}
                                max={p.param_kind === 'percent' ? 50 : undefined}
                                value={wizardParamValues[p.meta_key] ?? p.default_value_text ?? ''}
                                onChange={(e) => {
                                  const v = e.target.value === '' ? '' : (parseInt(e.target.value, 10) ?? e.target.value)
                                  setWizardParamValues((prev) => ({ ...prev, [p.meta_key]: v as string | number }))
                                  if (p.meta_key === 'otm_pct') setWizardOtmPct(typeof v === 'number' ? v : 10)
                                  if (p.meta_key === 'itm_pct') setWizardItmPct(typeof v === 'number' ? v : '')
                                }}
                                aria-label={p.display_label ?? p.meta_key}
                              />
                              {p.default_value_text != null && (
                                <span className="form-hint" style={{ marginLeft: 'var(--space-2)' }}>Default {p.default_value_text}</span>
                              )}
                            </div>
                          ))}
                      </div>
                    ) : formPayload.structure_type === 'covered_call' && coveredCallSubtype ? (
                      <div className="gates-form-group" style={{ marginTop: 'var(--space-3)' }}>
                        <h4 className="gates-form-group-title">Covered Call options</h4>
                        {(coveredCallSubtype === 'otm' || coveredCallSubtype === 'deep_otm') && (
                          <div className="gates-form-row">
                            <label>OTM %</label>
                            <input
                              type="number"
                              min={1}
                              max={50}
                              value={wizardOtmPct}
                              onChange={(e) => setWizardOtmPct(parseInt(e.target.value, 10) || 10)}
                            />
                            <span className="form-hint" style={{ marginLeft: 'var(--space-2)' }}>{coveredCallSubtype === 'deep_otm' ? 'Default 20' : 'Default 10'}</span>
                          </div>
                        )}
                        {coveredCallSubtype === 'itm' && (
                          <div className="gates-form-row">
                            <label>ITM % (optional)</label>
                            <input
                              type="number"
                              min={0}
                              value={wizardItmPct}
                              onChange={(e) => setWizardItmPct(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                              placeholder="Optional"
                            />
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="gates-form-group">
                    <h4 className="gates-form-group-title">Legs (read-only)</h4>
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Role</th>
                            <th>Direction</th>
                            <th>Right</th>
                            <th>Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {formLegs.map((leg, i) => (
                            <tr key={i}>
                              <td>{leg.role ?? '—'}</td>
                              <td>{leg.direction ?? '—'}</td>
                              <td>{leg.option_right ?? '—'}</td>
                              <td>{leg.quantity ?? 1}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              <div className="gates-form-actions" style={{ marginTop: 'var(--space-4)' }}>
                <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
                {wizardStep < 3 ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={goWizardNext}
                    disabled={
                        wizardStep === 2 &&
                        currentTypeHasSubtypes &&
                        (subtypesConfig?.subtypes?.length ? !selectedSubtype : !coveredCallSubtype)
                      }
                  >
                    Next
                  </button>
                ) : (
                  <button type="button" className="btn-primary" onClick={submitWizardForm} disabled={formLoading}>
                    {formOpen === 'create' ? 'Create' : 'Save'}
                  </button>
                )}
              </div>
            </>
          ) : (
          <div className="gates-form">
            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Metadata</h4>
              <div className="gates-form-row">
                <label>Name</label>
                <input
                  type="text"
                  value={formPayload.name}
                  onChange={(e) => updateForm({ name: e.target.value })}
                  placeholder="Structure name"
                />
              </div>
              <div className="gates-form-row gates-form-row--structure-type">
                <span className="gates-form-row-label">Structure type</span>
                <div className="structure-type-picker" role="radiogroup" aria-label="Structure type">
                  {(structureTypes.length > 0
                    ? structureTypes
                    : STRUCTURE_TYPES.map((st, i) => ({
                        structure_type: st,
                        display_label: getStructureTypeLabel(st),
                        sort_order: i,
                        has_subtypes: st === 'covered_call',
                      }))
                  ).map((typeItem) => (
                    <label
                      key={typeItem.structure_type}
                      className={`structure-type-option ${formPayload.structure_type === typeItem.structure_type ? 'structure-type-option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="structure_type"
                        value={typeItem.structure_type}
                        checked={formPayload.structure_type === typeItem.structure_type}
                        onChange={() => handleStructureTypeChange(typeItem.structure_type)}
                      />
                      <span>{typeItem.display_label}</span>
                    </label>
                  ))}
                  {formPayload.structure_type === 'custom' && (structureTypes.length === 0 || !structureTypes.some((t) => t.structure_type === 'custom')) && (
                    <label className="structure-type-option structure-type-option--legacy structure-type-option--selected">
                      <input
                        type="radio"
                        name="structure_type"
                        value="custom"
                        checked={formPayload.structure_type === 'custom'}
                        onChange={() => {}}
                      />
                      <span>{getStructureTypeLabel('custom')} (legacy)</span>
                    </label>
                  )}
                </div>
              </div>
              <div className="gates-form-row">
                <label>Version</label>
                <div>
                  <input
                    type="number"
                    min={1}
                    value={formPayload.version ?? 1}
                    onChange={(e) => updateForm({ version: parseInt(e.target.value, 10) || 1 })}
                    disabled={typeof formOpen === 'number'}
                    aria-label="Version"
                  />
                  {typeof formOpen === 'number' && (
                    <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                      Read-only when editing. Use new version (Version + 1) is offered on Save when Type, SubType, or Meta change.
                    </p>
                  )}
                </div>
              </div>
              <div className="gates-form-row">
                <label className="toggle-switch" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={formPayload.is_active ?? true}
                    onChange={(e) => updateForm({ is_active: e.target.checked })}
                    aria-label="Available"
                  />
                  <span className="toggle-switch-caption">Available</span>
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Legs</h4>
              <p className="form-hint structure-legs-caption" style={{ marginBottom: 'var(--space-2)' }}>
                Define leg shape. Toggle each column on to edit; off shows &quot;resolved when used&quot;.
              </p>
              {defaultLegsLoading && (
                <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>Loading default legs…</p>
              )}
              {selectedSubtype && subtypeDefaultLegs !== null && subtypeDefaultLegs.length > 0 && !legsMatch(formLegs, subtypeDefaultLegs) && (
                <div
                  className="form-hint"
                  style={{
                    marginBottom: 'var(--space-2)',
                    padding: 'var(--space-2)',
                    background: formErrorIsSchemaMismatch ? 'var(--color-error-subtle, #fef2f2)' : 'var(--color-surface-elevated)',
                    borderRadius: '6px',
                    border: formErrorIsSchemaMismatch ? '1px solid var(--color-error, #b91c1c)' : undefined,
                  }}
                  role="alert"
                >
                  This subtype has its own default legs.
                  {' '}
                  <button
                    type="button"
                    className={formErrorIsSchemaMismatch ? 'btn-primary' : 'btn-secondary'}
                    style={formErrorIsSchemaMismatch ? { fontWeight: 600 } : undefined}
                    onClick={() => {
                      setFormLegs([...subtypeDefaultLegs])
                      setFixedLegCount(subtypeDefaultLegs.length)
                      setFormError(null)
                      setFormErrorIsSchemaMismatch(false)
                    }}
                  >
                    Use subtype default legs
                  </button>
                </div>
              )}
              {selectedSubtype && subtypeDefaultLegs !== null && subtypeDefaultLegs.length === 0 && (
                <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>Using type-level default legs.</p>
              )}
              {subtypeDefaultLegsLoading && selectedSubtype && (
                <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>Loading subtype default legs…</p>
              )}
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Direction</th>
                      <th>Right</th>
                      <th className="structure-leg-preset-th">
                        <span className="structure-leg-th-label">Qty (per leg)</span>
                        <InfoTooltip text="Number of contracts for this leg (e.g. 1 for straddle). Toggle on to set per leg." />
                        <label className="toggle-switch structure-leg-th-toggle" style={{ cursor: 'pointer', marginLeft: 'var(--space-1)' }} title="Allow Qty preset">
                          <input
                            type="checkbox"
                            checked={allowQtyPreset}
                            onChange={(e) => setAllowQtyPreset(e.target.checked)}
                            aria-label="Allow Qty preset"
                          />
                          <span className="toggle-switch-caption" aria-hidden>On</span>
                        </label>
                      </th>
                      <th className="structure-leg-preset-th structure-leg-optional">
                        <span className="structure-leg-th-label">Strike</span>
                        <InfoTooltip text="Optional preset; leave blank to resolve when structure is applied (e.g. ATM)." />
                        <label className="toggle-switch structure-leg-th-toggle" style={{ cursor: 'pointer', marginLeft: 'var(--space-1)' }} title="Allow Strike preset">
                          <input
                            type="checkbox"
                            checked={allowStrikePreset}
                            onChange={(e) => setAllowStrikePreset(e.target.checked)}
                            aria-label="Allow Strike preset"
                          />
                          <span className="toggle-switch-caption" aria-hidden>On</span>
                        </label>
                      </th>
                      <th className="structure-leg-preset-th structure-leg-optional">
                        <span className="structure-leg-th-label">Expiration</span>
                        <InfoTooltip text="Optional preset; leave blank to resolve from DTE or calendar when structure is applied." />
                        <label className="toggle-switch structure-leg-th-toggle" style={{ cursor: 'pointer', marginLeft: 'var(--space-1)' }} title="Allow Expiration preset">
                          <input
                            type="checkbox"
                            checked={allowExpirationPreset}
                            onChange={(e) => setAllowExpirationPreset(e.target.checked)}
                            aria-label="Allow Expiration preset"
                          />
                          <span className="toggle-switch-caption" aria-hidden>On</span>
                        </label>
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {formLegs.map((leg, i) => {
                      const locked = fixedLegCount > 0 && i < fixedLegCount
                      return (
                        <tr key={i}>
                          <td>
                            {locked ? (
                              <span style={{ minWidth: '60px', display: 'inline-block' }}>{leg.role ?? '—'}</span>
                            ) : (
                              <input
                                type="text"
                                value={leg.role ?? ''}
                                onChange={(e) => updateLeg(i, { role: e.target.value })}
                                placeholder="role"
                                style={{ width: '100%', minWidth: '60px' }}
                              />
                            )}
                          </td>
                          <td>
                            {locked ? (
                              <span style={{ minWidth: '60px', display: 'inline-block' }}>{leg.direction ?? '—'}</span>
                            ) : (
                              <input
                                type="text"
                                value={leg.direction ?? ''}
                                onChange={(e) => updateLeg(i, { direction: e.target.value })}
                                placeholder="long/short"
                                style={{ width: '100%', minWidth: '60px' }}
                              />
                            )}
                          </td>
                          <td>
                            {locked ? (
                              <span>{leg.option_right ?? '—'}</span>
                            ) : (
                              <select
                                value={leg.option_right ?? 'C'}
                                onChange={(e) => updateLeg(i, { option_right: e.target.value })}
                              >
                                <option value="C">C</option>
                                <option value="P">P</option>
                              </select>
                            )}
                          </td>
                          <td>
                            {allowQtyPreset ? (
                              <input
                                type="number"
                                value={leg.quantity ?? 1}
                                onChange={(e) => updateLeg(i, { quantity: parseInt(e.target.value, 10) || 0 })}
                                min={0}
                                style={{ width: '4em' }}
                              />
                            ) : (
                              <span className="structure-leg-qty-default" title="Default ratio per leg (toggle column on to edit)">{leg.quantity ?? 1}</span>
                            )}
                          </td>
                          <td className="structure-leg-optional">
                            {allowStrikePreset ? (
                              <input
                                type="number"
                                step="0.01"
                                value={leg.strike ?? ''}
                                onChange={(e) => updateLeg(i, { strike: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                                placeholder="e.g. ATM or blank"
                                style={{ width: '5em' }}
                              />
                            ) : (
                              <span className="structure-leg-resolved" title="Resolved when structure is used">resolved when used</span>
                            )}
                          </td>
                          <td className="structure-leg-optional">
                            {allowExpirationPreset ? (
                              <input
                                type="text"
                                value={leg.expiration ?? ''}
                                onChange={(e) => updateLeg(i, { expiration: e.target.value })}
                                placeholder="e.g. YYYYMMDD or blank"
                                style={{ width: '100%', minWidth: '70px' }}
                              />
                            ) : (
                              <span className="structure-leg-resolved" title="Resolved when structure is used">resolved when used</span>
                            )}
                          </td>
                          <td>
                            {fixedLegCount > 0 ? null : (
                              <button type="button" className="btn-secondary" onClick={() => removeLeg(i)}>Remove</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {fixedLegCount === 0 && !defaultLegsLoading && (
                <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addLeg}>Add leg</button>
              )}
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Constraints</h4>
              {formConstraints.map((c, i) => (
                <div key={i} className="gates-form-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={c.constraint_type ?? ''}
                    onChange={(e) => updateConstraint(i, { constraint_type: e.target.value })}
                    placeholder="constraint_type"
                    style={{ width: '160px' }}
                  />
                  <input
                    type="text"
                    value={c.constraint_value_text ?? ''}
                    onChange={(e) => updateConstraint(i, { constraint_value_text: e.target.value })}
                    placeholder="value (text)"
                    style={{ width: '120px' }}
                  />
                  <input
                    type="number"
                    value={c.constraint_value_int ?? ''}
                    onChange={(e) => updateConstraint(i, { constraint_value_int: e.target.value === '' ? undefined : parseInt(e.target.value, 10) })}
                    placeholder="value (int)"
                    style={{ width: '80px' }}
                  />
                  <button type="button" className="btn-secondary" onClick={() => removeConstraint(i)}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addConstraint}>Add constraint</button>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Notes</h4>
              <div className="gates-form-row">
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={2}
                  placeholder="Optional notes"
                  style={{ width: '100%', maxWidth: '600px' }}
                />
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Meta (key-value)</h4>
              {formMeta.map((m, i) => (
                <div key={i} className="gates-form-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={m.meta_key ?? ''}
                    onChange={(e) => updateMeta(i, { meta_key: e.target.value })}
                    placeholder="key"
                    style={{ width: '140px' }}
                  />
                  <input
                    type="text"
                    value={m.meta_value_text ?? ''}
                    onChange={(e) => updateMeta(i, { meta_value_text: e.target.value })}
                    placeholder="value"
                    style={{ width: '180px' }}
                  />
                  <button type="button" className="btn-secondary" onClick={() => removeMeta(i)}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addMeta}>Add meta</button>
            </div>

            <div className="gates-form-actions">
              <button type="button" className="btn-primary" onClick={submitForm} disabled={formLoading}>
                {formOpen === 'create' ? 'Create' : 'Save'}
              </button>
              <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
            </div>
          </div>
          )}
        </section>
      )}

      <section className="strategy-section">
        <h3 className="section-subtitle">Strategy history</h3>
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <label htmlFor="strategy-history-filter">Filter by structure: </label>
          <select
            id="strategy-history-filter"
            value={historyStructureFilter}
            onChange={(e) => setHistoryStructureFilter(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">All</option>
            {structures.map((s) => (
              <option key={s.strategy_structure_id} value={s.strategy_structure_id}>
                {s.name} ({s.strategy_structure_id})
              </option>
            ))}
          </select>
        </div>
        {historyLoading && <p className="section-hint">Loading…</p>}
        {historyError && <p className="msg-error">{historyError}</p>}
        {!historyLoading && !historyError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Structure ID</th>
                  <th>State summary</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.strategy_history_id}>
                    <td>{formatHistoryTs(row.ts)}</td>
                    <td>{row.strategy_structure_id}</td>
                    <td title={summarizeStateSummary(row.state_summary)}>
                      {summarizeStateSummary(row.state_summary)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!historyLoading && !historyError && history.length === 0 && (
          <p className="section-hint">No strategy history.</p>
        )}
      </section>
    </div>
  )
}
