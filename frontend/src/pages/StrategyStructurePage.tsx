import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchStructures,
  fetchStructure,
  fetchTemplates,
  fetchTemplateDetail,
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
  type StrategyTemplateRow,
  type StrategyTemplateDetail,
  type MetaParamItem,
} from '../api'
import { DraggableModal } from '../components/DraggableModal'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  DEFAULT_STRUCTURE_PAYLOAD,
  getStructureDisplayLabel,
  structureToPayload,
  wizardParamValuesFromSavedMeta,
  formatHistoryTs,
  summarizeStateSummary,
  summarizeLegs,
  summarizeConstraints,
} from './strategy/strategyFormUtils'

const TEMPLATE_DIM_TYPES = [
  'direction',
  'structure',
  'coverage',
  'risk',
  'volatility',
  'time',
] as const

const TEMPLATE_DIM_LABELS: Record<(typeof TEMPLATE_DIM_TYPES)[number], string> = {
  direction: 'Direction',
  structure: 'Structure',
  coverage: 'Coverage',
  risk: 'Risk',
  volatility: 'Volatility',
  time: 'Time',
}

function templateDimAt(t: StrategyTemplateRow, dt: (typeof TEMPLATE_DIM_TYPES)[number]): string | null {
  const v = t[`dim_${dt}` as keyof StrategyTemplateRow]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

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
  const [defaultLegsLoading, setDefaultLegsLoading] = useState(false)
  /** When set, default legs came from client fallback (API failed or unavailable). Shown so backend failures are not hidden. */
  const [defaultLegsFallbackMsg, setDefaultLegsFallbackMsg] = useState<string | null>(null)
  /** Filter structure list: 'all' | 'active' | 'inactive'. */
  const [structureActiveFilter, setStructureActiveFilter] = useState<'all' | 'active' | 'inactive'>('active')
  /** Sheet tabs by dim_structure. '' = All. */
  const [structureTypeTab, setStructureTypeTab] = useState<string>('')
  /** Wizard: 1=template, 2=meta params, 3=details. */
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1)
  const [templates, setTemplates] = useState<StrategyTemplateRow[]>([])
  const [tplFilterSearch, setTplFilterSearch] = useState('')
  const [tplDimFilters, setTplDimFilters] = useState<Record<string, string>>({})
  const [tplFiltersExpanded, setTplFiltersExpanded] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null)
  const [wizardTemplateDetail, setWizardTemplateDetail] = useState<StrategyTemplateDetail | null>(null)
  /** True after user leaves step 2 (so step 3 does not duplicate parameter fields). */
  const [wizardVisitedMetaStep, setWizardVisitedMetaStep] = useState(false)
  /** Configurable meta param values (e.g. otm_pct, itm_pct) for current subtype. */
  const [wizardParamValues, setWizardParamValues] = useState<Record<string, string | number>>({})
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
  const [originalEditTemplateId, setOriginalEditTemplateId] = useState<number | null>(null)
  const [originalEditMeta, setOriginalEditMeta] = useState<StructureMetaEntry[] | null>(null)
  /** After name is resolved, if version dialog is shown this is the name to use on Save. */
  const [pendingSubmitName, setPendingSubmitName] = useState<string | null>(null)
  /** When set, show dialog: Type/SubType/Meta changed — use new version? (Apple switch, default on). */
  const [versionConfirmDialog, setVersionConfirmDialog] = useState<{ useNewVersion: boolean } | null>(null)
  /** When true, last save failed with legs/schema error so we highlight "Use subtype default legs" if applicable. */
  const [formErrorIsSchemaMismatch, setFormErrorIsSchemaMismatch] = useState(false)

  const isWizard = (formOpen === 'create' && !formIsCopy) || typeof formOpen === 'number'

  const filteredStructures = structures.filter((row) => {
    if (structureActiveFilter === 'all') return true
    if (structureActiveFilter === 'active') return row.is_active === true
    return row.is_active !== true
  })

  /** Structures for current Type tab (filtered by structureTypeTab; Option Types define the tabs). */
  const structuresForTypeTab =
    structureTypeTab === ''
      ? filteredStructures
      : filteredStructures.filter((row) => (row.dim_structure || 'other') === structureTypeTab)

  const dimStructureTabs = Array.from(
    new Set(structures.map((s) => s.dim_structure || 'other').filter(Boolean))
  ).sort()

  /** Heuristic: backend validation error about legs/schema (for highlighting "Use subtype default legs"). */
  const isSchemaMismatchError = useCallback((msg: string): boolean => {
    const s = msg.toLowerCase()
    return /leg\s*\d|requires exactly|must be/.test(s) || s.includes('schema')
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

  useEffect(() => {
    if (structureTypeTab !== '' && !dimStructureTabs.includes(structureTypeTab)) {
      setStructureTypeTab('')
    }
  }, [dimStructureTabs, structureTypeTab])

  useEffect(() => {
    fetchTemplates(true)
      .then((res) => setTemplates(res.items ?? []))
      .catch(() => setTemplates([]))
  }, [])

  useEffect(() => {
    if (formOpen === null) {
      setTplFilterSearch('')
      setTplDimFilters({})
      setTplFiltersExpanded(false)
    }
  }, [formOpen])

  const tplDimOptions = useMemo(() => {
    const by: Record<string, Set<string>> = {}
    for (const dt of TEMPLATE_DIM_TYPES) by[dt] = new Set()
    for (const t of templates) {
      for (const dt of TEMPLATE_DIM_TYPES) {
        const v = templateDimAt(t, dt)
        if (v) by[dt].add(v)
      }
    }
    const out: Record<string, string[]> = {}
    for (const dt of TEMPLATE_DIM_TYPES) {
      out[dt] = Array.from(by[dt]).sort((a, b) => a.localeCompare(b))
    }
    return out
  }, [templates])

  const filteredTemplatesForPicker = useMemo(() => {
    let result = templates
    const q = tplFilterSearch.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (t) =>
          t.display_name.toLowerCase().includes(q) ||
          t.template_code.toLowerCase().includes(q) ||
          (t.typical_use && t.typical_use.toLowerCase().includes(q)) ||
          (t.explanation && t.explanation.toLowerCase().includes(q))
      )
    }
    for (const dt of TEMPLATE_DIM_TYPES) {
      const fv = tplDimFilters[dt]
      if (fv) result = result.filter((t) => templateDimAt(t, dt) === fv)
    }
    return result
  }, [templates, tplFilterSearch, tplDimFilters])

  const activeTplFilterCount =
    Object.values(tplDimFilters).filter(Boolean).length + (tplFilterSearch.trim() ? 1 : 0)

  const wizardTemplatesToShow = useMemo(() => {
    const f = filteredTemplatesForPicker
    const sel = selectedTemplateId
    if (!sel) return f
    if (f.some((t) => t.strategy_template_id === sel)) return f
    const cur = templates.find((t) => t.strategy_template_id === sel)
    return cur ? [cur, ...f] : f
  }, [filteredTemplatesForPicker, selectedTemplateId, templates])

  const copyTemplateSelectOptions = useMemo(() => {
    const tid = formPayload.strategy_template_id
    const f = filteredTemplatesForPicker
    if (!tid) return f
    if (f.some((t) => t.strategy_template_id === tid)) return f
    const cur = templates.find((t) => t.strategy_template_id === tid)
    return cur ? [cur, ...f] : f
  }, [filteredTemplatesForPicker, formPayload.strategy_template_id, templates])

  useEffect(() => {
    const tid = formPayload.strategy_template_id
    if (!tid || formOpen === null) return
    let cancelled = false
    setDefaultLegsLoading(true)
    fetchTemplateDetail(tid)
      .then((d) => {
        if (!cancelled) setFormLegs(d.legs ?? [])
      })
      .catch(() => {
        if (!cancelled) setFormLegs([])
      })
      .finally(() => {
        if (!cancelled) setDefaultLegsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [formPayload.strategy_template_id, formOpen])

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
      const res = await postActiveStrategy(
        structureId,
        status?.strategy?.active?.gate_safety?.id ?? null,
        status?.strategy?.active?.allocation?.id ?? null,
      )
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
      const res = await postActiveStrategy(
        null,
        status?.strategy?.active?.gate_safety?.id ?? null,
        status?.strategy?.active?.allocation?.id ?? null,
      )
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
    setFormPayload({
      ...DEFAULT_STRUCTURE_PAYLOAD,
      name: 'New structure',
      structure_type: '',
      legs: [],
    })
    setFormLegs([])
    setFormConstraints([])
    setFormNotes('')
    setFormMeta([])
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setDefaultLegsLoading(false)
    setDefaultLegsFallbackMsg(null)
    setWizardStep(1)
    setSelectedTemplateId(null)
    setWizardTemplateDetail(null)
    setWizardVisitedMetaStep(false)
    setWizardParamValues({})
    setFormOpen('create')
  }

  const openEdit = (id: number) => {
    setFormIsCopy(false)
    setFormLoading(true)
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setOriginalEditName(null)
    setDefaultLegsLoading(false)
    setDefaultLegsFallbackMsg(null)
    setWizardStep(3)
    setFormPayload({ ...DEFAULT_STRUCTURE_PAYLOAD, name: '' })
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
        setOriginalEditTemplateId(row.strategy_template_id ?? null)
        setOriginalEditMeta(p.meta != null ? [...p.meta] : null)
        setWizardStep(3)
        setSelectedTemplateId(row.strategy_template_id ?? null)
        if (row.strategy_template_id) {
          fetchTemplateDetail(row.strategy_template_id)
            .then((d) => {
              setWizardTemplateDetail(d)
              setWizardParamValues(wizardParamValuesFromSavedMeta(p.meta, d.meta_params))
            })
            .catch(() => setWizardTemplateDetail(null))
        } else {
          setWizardTemplateDetail(null)
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
        if (row.strategy_template_id) {
          handleTemplateSelect(row.strategy_template_id)
        }
      })
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const closeForm = () => {
    setFormOpen(null)
    setFormError(null)
    setFormErrorIsSchemaMismatch(false)
    setOriginalEditName(null)
    setOriginalEditVersion(null)
    setOriginalEditTemplateId(null)
    setOriginalEditMeta(null)
    setPendingSubmitName(null)
    setNameConfirmDialog(null)
    setVersionConfirmDialog(null)
    setWizardStep(1)
    setSelectedTemplateId(null)
    setWizardTemplateDetail(null)
    setWizardVisitedMetaStep(false)
    setWizardParamValues({})
  }

  const buildWizardDefaultName = (): string => {
    const t = wizardTemplateDetail
    if (t) {
      const pct = wizardParamValues['otm_pct']
      const itmPct = wizardParamValues['itm_pct']
      if (pct != null && String(pct) !== '') return `${t.display_name} (${pct}% OTM)`
      if (itmPct != null && String(itmPct) !== '') return `${t.display_name} (${itmPct}% ITM)`
      return t.display_name
    }
    const tpl = templates.find((x) => x.strategy_template_id === selectedTemplateId)
    return tpl?.display_name ?? 'Structure'
  }

  const goWizardNext = () => {
    if (wizardStep === 1) {
      if (!selectedTemplateId) {
        setFormError('Select a template')
        return
      }
      const hasEditableMeta =
        wizardTemplateDetail?.meta_params?.some((p: MetaParamItem) => p.param_kind !== 'fixed') ?? false
      if (hasEditableMeta) {
        setWizardStep(2)
      } else {
        setWizardVisitedMetaStep(false)
        setWizardStep(3)
        updateForm({ name: buildWizardDefaultName() })
      }
    } else if (wizardStep === 2) {
      setWizardVisitedMetaStep(true)
      setWizardStep(3)
      updateForm({ name: buildWizardDefaultName() })
    }
  }

  const getCurrentBuiltMeta = (): StructureMetaEntry[] => {
    if (wizardTemplateDetail?.meta_params?.length) {
      const meta: StructureMetaEntry[] = []
      wizardTemplateDetail.meta_params.forEach((p: MetaParamItem) => {
        if (p.param_kind === 'fixed') {
          if (p.default_value_text != null && p.default_value_text !== '')
            meta.push({ meta_key: p.meta_key, meta_value_text: p.default_value_text })
        } else {
          const v = wizardParamValues[p.meta_key]
          if (v !== undefined && v !== '') meta.push({ meta_key: p.meta_key, meta_value_text: String(v) })
        }
      })
      return meta
    }
    return [...(formMeta ?? [])]
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
    const curTid = formPayload.strategy_template_id ?? null
    if (curTid !== originalEditTemplateId) return true
    if (originalEditMeta == null) return getCurrentBuiltMeta().length > 0
    return !metaEntriesEqual(getCurrentBuiltMeta(), originalEditMeta)
  }

  const buildWizardPayload = (name: string, versionOverride?: number): StructurePayload => {
    const meta = getCurrentBuiltMeta()
    const tpl = wizardTemplateDetail
    return {
      name: name.trim(),
      strategy_template_id: formPayload.strategy_template_id,
      structure_type: tpl?.template_code ?? formPayload.structure_type,
      structure_subtype: null,
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
    if (!formPayload.strategy_template_id) {
      setFormError('Template is required')
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

  const handleTemplateSelect = useCallback(
    (strategy_template_id: number) => {
      setSelectedTemplateId(strategy_template_id)
      updateForm({ strategy_template_id, structure_subtype: null })
      setDefaultLegsLoading(true)
      setDefaultLegsFallbackMsg(null)
      setWizardParamValues({})
      fetchTemplateDetail(strategy_template_id)
        .then((d) => {
          setWizardTemplateDetail(d)
          updateForm({
            strategy_template_id,
            structure_type: d.template_code,
          })
          setFormLegs(d.legs ?? [])
          setDefaultLegsFallbackMsg(
            (d.legs ?? []).length === 0 && d.template_code !== 'custom'
              ? 'No legs on template.'
              : null
          )
          const pv: Record<string, string | number> = {}
          d.meta_params?.forEach((p: MetaParamItem) => {
            if (p.param_kind !== 'fixed' && p.default_value_text)
              pv[p.meta_key] = p.default_value_text
          })
          setWizardParamValues(pv)
        })
        .catch(() => {
          setWizardTemplateDetail(null)
          setFormLegs([])
          setDefaultLegsFallbackMsg('Failed to load template.')
        })
        .finally(() => setDefaultLegsLoading(false))
    },
    [updateForm]
  )

  const submitForm = async () => {
    const name = (formPayload.name || '').trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    const tid = formPayload.strategy_template_id
    if (!tid) {
      setFormError('Template is required')
      return
    }
    setFormError(null)
    setFormLoading(true)
    const payload: StructurePayload = {
      name,
      strategy_template_id: tid,
      structure_type: formPayload.structure_type,
      structure_subtype: null,
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
      <DraggableModal
        open={availabilityError != null}
        onBackdropClick={() => setAvailabilityError(null)}
        title="Cannot change availability"
        titleId="availability-error-modal-title"
        maxWidth="min(520px, calc(100vw - 24px))"
        footer={
          <div className="data-reset-modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setAvailabilityError(null)}>
              Close
            </button>
          </div>
        }
      >
        <p style={{ whiteSpace: 'pre-wrap', marginBottom: 'var(--space-3)' }}>{availabilityError}</p>
        <p className="form-hint" style={{ marginBottom: 0 }}>
          The structure was not changed. Fix the issue in Option Type Config or Edit (e.g. meta) and try again.
        </p>
      </DraggableModal>

      <DraggableModal
        open={nameConfirmDialog != null}
        onBackdropClick={() => setNameConfirmDialog(null)}
        title="Structure name will change"
        titleId="name-confirm-modal-title"
        maxWidth="min(520px, calc(100vw - 24px))"
        footer={
          <div className="data-reset-modal-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                nameConfirmDialog &&
                trySubmitWithVersionCheck(
                  (nameConfirmDialog.editedName || '').trim() || nameConfirmDialog.suggestedName,
                )
              }
              disabled={formLoading || nameConfirmDialog == null}
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
            <button type="button" className="btn btn-secondary" onClick={() => setNameConfirmDialog(null)}>
              Cancel
            </button>
          </div>
        }
      >
        {nameConfirmDialog != null && (
          <>
            <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
              Current name: <strong>{nameConfirmDialog.originalName}</strong>
            </p>
            <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
              The suggested new name (based on type and parameters) is below. You can keep it, edit it, or abandon the
              name change and save with the current name.
            </p>
            <div className="gates-form-row" style={{ marginBottom: 0 }}>
              <label htmlFor="name-confirm-new-name">New name</label>
              <input
                id="name-confirm-new-name"
                type="text"
                value={nameConfirmDialog.editedName}
                onChange={(e) =>
                  setNameConfirmDialog((prev) => (prev ? { ...prev, editedName: e.target.value } : null))
                }
                placeholder="Structure name"
                style={{ width: '100%', maxWidth: '400px' }}
              />
            </div>
          </>
        )}
      </DraggableModal>

      <DraggableModal
        open={versionConfirmDialog != null && pendingSubmitName != null && originalEditVersion != null}
        onBackdropClick={() => {
          setVersionConfirmDialog(null)
          setPendingSubmitName(null)
        }}
        title="Type, SubType, or Meta changed"
        titleId="version-confirm-modal-title"
        maxWidth="min(520px, calc(100vw - 24px))"
        footer={
          <div className="data-reset-modal-actions" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                pendingSubmitName != null &&
                originalEditVersion != null &&
                versionConfirmDialog &&
                doWizardSubmit(
                  pendingSubmitName,
                  versionConfirmDialog.useNewVersion ? originalEditVersion + 1 : originalEditVersion,
                )
              }
              disabled={formLoading || versionConfirmDialog == null}
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
        }
      >
        {versionConfirmDialog != null && (
          <>
            <p className="form-hint" style={{ marginBottom: 'var(--space-3)' }}>
              Use a new version (Version + 1) for this structure? If not, changes will be saved with the current
              version.
            </p>
            <div
              className="gates-form-row"
              style={{
                alignItems: 'center',
                gap: 'var(--space-2)',
                marginBottom: 0,
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
                    setVersionConfirmDialog((prev) => (prev ? { ...prev, useNewVersion: e.target.checked } : null))
                  }
                  aria-label="Use new version (Version + 1)"
                />
                <span className="toggle-switch-caption">Use new version (Version + 1)</span>
              </label>
            </div>
          </>
        )}
      </DraggableModal>

      <h2 id="strategy-structure-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Strategy / {breadcrumbLabel}
        <InfoTooltip text="View and set active strategy structure and gate safety set; daemon uses these on next start." />
      </h2>

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="section-subtitle">Current active</h3>
        <div className="statusSummary">
          <div>
            <strong>Structure:</strong> {status?.strategy?.active?.structure?.name ?? '—'}
            {status?.strategy?.active?.structure?.id != null && ` (${status?.strategy?.active?.structure?.id})`}
          </div>
          <div>
            <strong>Gate safety:</strong> {status?.strategy?.active?.gate_safety?.name ?? '—'}
            {status?.strategy?.active?.gate_safety?.id != null && ` (${status?.strategy?.active?.gate_safety?.id})`}
          </div>
          <div>
            <strong>Allocation:</strong> {status?.strategy?.active?.allocation?.name ?? '—'}
            {status?.strategy?.active?.allocation?.id != null && ` (${status?.strategy?.active?.allocation?.id})`}
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
        {!structuresLoading && !structuresError && dimStructureTabs.length > 0 && (
          <div
            className="system-tabs structure-sheet-type-tabs"
            role="tablist"
            aria-label="Structure dimension"
          >
            <button
              type="button"
              role="tab"
              aria-selected={structureTypeTab === ''}
              className={`system-tab ${structureTypeTab === '' ? 'active' : ''}`}
              onClick={() => setStructureTypeTab('')}
            >
              All
            </button>
            {dimStructureTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={structureTypeTab === tab}
                className={`system-tab ${structureTypeTab === tab ? 'active' : ''}`}
                onClick={() => setStructureTypeTab(tab)}
              >
                {tab.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        )}
        {structuresLoading && <p className="section-hint">Loading…</p>}
        {structuresError && <p className="msg-error">{structuresError}</p>}
        {!structuresLoading && !structuresError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Template</th>
                  <th>Dimensions</th>
                  <th>Legs</th>
                  <th>Constraints</th>
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
                {structuresForTypeTab.map((row) => {
                  const isCurrentActive = status?.strategy?.active?.structure?.id === row.strategy_structure_id
                  const availabilityUpdating = availabilityInProgress === row.strategy_structure_id
                  return (
                    <tr key={row.strategy_structure_id}>
                      <td>
                        {row.name}
                        {row.version != null && row.version !== '' && (
                          <span className="structure-sheet-version" aria-label={`Version ${row.version}`}> v{row.version}</span>
                        )}
                      </td>
                      <td>{getStructureDisplayLabel(row)}</td>
                      <td className="structure-sheet-cell-summary">
                        {[row.dim_direction, row.dim_structure, row.dim_volatility]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                      <td className="structure-sheet-cell-summary" title={summarizeLegs(row.legs)}>{summarizeLegs(row.legs)}</td>
                      <td className="structure-sheet-cell-summary" title={summarizeConstraints(row.constraints)}>{summarizeConstraints(row.constraints)}</td>
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
        <section className="structure-form-panel">
          <div className="structure-form-header">
            <h3>
              {formOpen === 'create' ? (formIsCopy ? 'New structure' : 'New structure') : 'Edit structure'}
              {formOpen === 'create' && formIsCopy && <span className="structure-form-header-badge">Copy</span>}
              {typeof formOpen === 'number' && <span className="structure-form-header-badge">ID {formOpen}</span>}
            </h3>
            <button type="button" className="structure-form-header-close" onClick={closeForm} aria-label="Close form">&times;</button>
          </div>
          <div className="structure-form-body">
          {formLoading && !formPayload.name && <p className="section-hint">Loading…</p>}
          {formError && (
            <div className="msg-error" style={{ marginBottom: 'var(--space-3)' }}>
              <p>{formError}</p>
              {formErrorIsSchemaMismatch && (
                <p className="form-hint" style={{ marginTop: 'var(--space-1)' }}>
                  Legs do not match the expected schema for this type/subtype. Update Option Type Config if needed.
                </p>
              )}
            </div>
          )}
          {defaultLegsFallbackMsg && (
            <p className="form-hint msg-warning" style={{ marginBottom: 'var(--space-3)' }} role="alert">
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
                  <span className="structure-wizard-step-label">Template</span>
                </div>
                <div
                  className={`structure-wizard-step-item ${wizardStep > 2
                      ? 'structure-wizard-step-done'
                      : wizardStep === 2
                        ? 'structure-wizard-step-active'
                        : !(
                          selectedTemplateId &&
                          (wizardTemplateDetail?.meta_params ?? []).some(
                            (p: MetaParamItem) => p.param_kind !== 'fixed'
                          )
                        )
                          ? 'structure-wizard-step-skip'
                          : ''
                    }`}
                  role="listitem"
                  aria-current={wizardStep === 2 ? 'step' : undefined}
                  onClick={
                    wizardStep > 2 &&
                      selectedTemplateId &&
                      (wizardTemplateDetail?.meta_params ?? []).some((p: MetaParamItem) => p.param_kind !== 'fixed')
                      ? () => setWizardStep(2)
                      : undefined
                  }
                  style={
                    wizardStep > 2 &&
                      (wizardTemplateDetail?.meta_params ?? []).some((p: MetaParamItem) => p.param_kind !== 'fixed')
                      ? { cursor: 'pointer' }
                      : undefined
                  }
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
                  <span className="structure-wizard-step-label">Parameters</span>
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
                  <h4 className="gates-form-group-title">Choose template</h4>
                  <div className="structure-template-filters" aria-label="Template filters">
                    <div className="structure-template-filters-search-row">
                      <input
                        type="search"
                        className="structure-template-filters-search structure-details-input"
                        placeholder="Filter by name or code…"
                        value={tplFilterSearch}
                        onChange={(e) => setTplFilterSearch(e.target.value)}
                        aria-label="Filter templates by name or code"
                      />
                      <button
                        type="button"
                        className="btn-secondary structure-template-filters-toggle"
                        onClick={() => setTplFiltersExpanded((v) => !v)}
                        aria-expanded={tplFiltersExpanded}
                      >
                        {tplFiltersExpanded ? 'Hide dimensions' : 'Filter by dimensions'}
                        {Object.values(tplDimFilters).filter(Boolean).length > 0
                          ? ` (${Object.values(tplDimFilters).filter(Boolean).length})`
                          : ''}
                      </button>
                      {activeTplFilterCount > 0 && (
                        <button
                          type="button"
                          className="btn-secondary structure-template-filters-clear"
                          onClick={() => {
                            setTplFilterSearch('')
                            setTplDimFilters({})
                          }}
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                    {tplFiltersExpanded && (
                      <div className="structure-template-filters-dims">
                        {TEMPLATE_DIM_TYPES.map((dt) => (
                          <label key={dt} className="structure-template-filter-dim">
                            <span className="structure-template-filter-dim-label">{TEMPLATE_DIM_LABELS[dt]}</span>
                            <select
                              className="structure-details-input structure-template-filter-select"
                              value={tplDimFilters[dt] ?? ''}
                              onChange={(e) =>
                                setTplDimFilters((prev) => ({
                                  ...prev,
                                  [dt]: e.target.value,
                                }))
                              }
                              aria-label={`Filter by ${TEMPLATE_DIM_LABELS[dt]}`}
                            >
                              <option value="">Any</option>
                              {tplDimOptions[dt].map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    )}
                    <p className="structure-template-filters-meta">
                      Showing {wizardTemplatesToShow.length} of {templates.length} templates
                      {activeTplFilterCount > 0 && wizardTemplatesToShow.length === 0 ? (
                        <span className="structure-template-filters-empty-hint"> — No match. Adjust filters.</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="structure-template-grid" role="radiogroup" aria-label="Template">
                    {wizardTemplatesToShow.length === 0 ? (
                      <p className="structure-template-grid-empty">
                        No templates match the current filters. Clear filters or change criteria.
                      </p>
                    ) : (
                      wizardTemplatesToShow.map((tpl) => (
                        <label
                          key={tpl.strategy_template_id}
                          className={`structure-template-card ${selectedTemplateId === tpl.strategy_template_id ? 'structure-template-card--selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="structure_template_wizard"
                            value={tpl.strategy_template_id}
                            checked={selectedTemplateId === tpl.strategy_template_id}
                            onChange={() => handleTemplateSelect(tpl.strategy_template_id)}
                          />
                          <span className="structure-template-card__name">{tpl.display_name}</span>
                          <span className="structure-template-card__code">{tpl.template_code}</span>
                          {(tpl.typical_use || tpl.explanation) && (
                            <span className="structure-template-card__desc">{tpl.typical_use || tpl.explanation}</span>
                          )}
                          <div className="structure-template-card__tags">
                            {TEMPLATE_DIM_TYPES.map((dt) => {
                              const v = templateDimAt(tpl, dt)
                              return v ? (
                                <span key={dt} className="structure-template-card__tag" title={TEMPLATE_DIM_LABELS[dt]}>
                                  {v}
                                </span>
                              ) : null
                            })}
                          </div>
                        </label>
                      ))
                    )}
                  </div>
                  {defaultLegsLoading && <p className="form-hint">Loading template…</p>}
                </div>
              )}

              {wizardStep === 2 && wizardTemplateDetail && (
                <div className="structure-wizard-step">
                  <h4 className="gates-form-group-title">Parameters</h4>
                  {wizardTemplateDetail.example && (
                    <p className="structure-param-example"><strong>Example:</strong> {wizardTemplateDetail.example}</p>
                  )}
                  {(wizardTemplateDetail.meta_params ?? []).filter((p: MetaParamItem) => p.param_kind !== 'fixed').length === 0 ? (
                    <p className="form-hint">No editable parameters. Click Next.</p>
                  ) : (
                    <div className="structure-param-card">
                      {(wizardTemplateDetail.meta_params ?? [])
                        .filter((p: MetaParamItem) => p.param_kind !== 'fixed')
                        .map((p: MetaParamItem) => (
                          <div key={p.meta_key} className="gates-form-row">
                            <label>{p.display_label ?? p.meta_key}</label>
                            <input
                              type="number"
                              min={p.param_kind === 'percent' ? 1 : 0}
                              max={p.param_kind === 'percent' ? 50 : undefined}
                              value={wizardParamValues[p.meta_key] ?? p.default_value_text ?? ''}
                              onChange={(e) => {
                                const v = e.target.value === '' ? '' : (parseInt(e.target.value, 10) ?? e.target.value)
                                setWizardParamValues((prev) => ({ ...prev, [p.meta_key]: v as string | number }))
                              }}
                              aria-label={p.display_label ?? p.meta_key}
                            />
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {wizardStep === 3 && (() => {
                const metaNF = (wizardTemplateDetail?.meta_params ?? []).filter(
                  (p: MetaParamItem) => p.param_kind !== 'fixed'
                )
                const showStep3Meta = metaNF.length > 0 && !wizardVisitedMetaStep
                return (
                  <div className="structure-wizard-step structure-details-step">
                    <div className={`structure-details-card${!showStep3Meta ? ' structure-details-card--span-2' : ''}`}>
                      <h4 className="structure-details-card-title">Metadata</h4>
                      <div className="structure-details-meta-grid">
                        <div className="structure-details-field structure-details-field--name">
                          <label className="structure-details-label">
                            Name <InfoTooltip text="Auto-filled from structure type and subtype; you can edit." />
                          </label>
                          <input
                            type="text"
                            value={formPayload.name}
                            onChange={(e) => updateForm({ name: e.target.value })}
                            placeholder="Structure name"
                            className="structure-details-input"
                            aria-label="Structure name"
                          />
                        </div>
                        <div className="structure-details-field structure-details-field--version">
                          <label className="structure-details-label">
                            Version
                            {typeof formOpen === 'number' && (
                              <InfoTooltip text="Read-only when editing. New version is offered on Save when Type, SubType, or Meta change." />
                            )}
                          </label>
                          <input
                            type="number"
                            min={1}
                            value={formPayload.version ?? 1}
                            onChange={(e) => updateForm({ version: parseInt(e.target.value, 10) || 1 })}
                            disabled={typeof formOpen === 'number'}
                            className="structure-details-input structure-details-input--narrow"
                            aria-label="Version"
                          />
                        </div>
                        <div className="structure-details-field structure-details-field--available">
                          <label className="toggle-switch structure-details-toggle" style={{ cursor: 'pointer' }}>
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
                    </div>
                    {showStep3Meta && wizardTemplateDetail && (
                      <div className="structure-details-card">
                        <h4 className="structure-details-card-title">Parameters</h4>
                        <div className="structure-details-params">
                          {metaNF.map((p: MetaParamItem) => (
                            <div key={p.meta_key} className="structure-details-param-row">
                              <label className="structure-details-label">{p.display_label ?? p.meta_key}</label>
                              <input
                                type="number"
                                min={p.param_kind === 'percent' ? 1 : 0}
                                max={p.param_kind === 'percent' ? 50 : undefined}
                                value={wizardParamValues[p.meta_key] ?? p.default_value_text ?? ''}
                                onChange={(e) => {
                                  const v =
                                    e.target.value === ''
                                      ? ''
                                      : parseInt(e.target.value, 10) ?? e.target.value
                                  setWizardParamValues((prev) => ({
                                    ...prev,
                                    [p.meta_key]: v as string | number,
                                  }))
                                }}
                                className="structure-details-input structure-details-input--narrow"
                                aria-label={p.display_label ?? p.meta_key}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Row 2: Legs | Constraints */}
                    <div className="structure-details-card">
                      <h4 className="structure-details-card-title">Legs</h4>
                      <p className="structure-details-hint structure-details-card-desc">
                        From template. Not editable here.
                      </p>
                      {defaultLegsLoading ? (
                        <p className="structure-details-hint">Loading legs…</p>
                      ) : (
                        <div className="structure-details-table-wrap">
                          <table className="structure-details-table" aria-label="Structure legs">
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
                      )}
                    </div>
                    <div className="structure-details-card">
                      <h4 className="structure-details-card-title">Constraints</h4>
                      <div className="structure-details-constraints">
                        {formConstraints.map((c, i) => (
                          <div key={i} className="structure-details-constraint-row">
                            <input
                              type="text"
                              value={c.constraint_type ?? ''}
                              onChange={(e) => updateConstraint(i, { constraint_type: e.target.value })}
                              placeholder="Type"
                              className="structure-details-input structure-details-constraint-type"
                              aria-label="Constraint type"
                            />
                            <input
                              type="text"
                              value={c.constraint_value_text ?? ''}
                              onChange={(e) => updateConstraint(i, { constraint_value_text: e.target.value })}
                              placeholder="Value (text)"
                              className="structure-details-input structure-details-constraint-value"
                              aria-label="Value text"
                            />
                            <input
                              type="number"
                              value={c.constraint_value_int ?? ''}
                              onChange={(e) => updateConstraint(i, { constraint_value_int: e.target.value === '' ? undefined : parseInt(e.target.value, 10) })}
                              placeholder="Int"
                              className="structure-details-input structure-details-constraint-int"
                              aria-label="Value int"
                            />
                            <button
                              type="button"
                              className="btn-secondary structure-details-constraint-remove"
                              onClick={() => removeConstraint(i)}
                              aria-label="Remove constraint"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        <button type="button" className="btn-secondary structure-details-add-constraint" onClick={addConstraint}>
                          Add constraint
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })()}

            </>
          ) : (
            <div className="structure-copy-grid">
              <div className="structure-details-card structure-details-card--span-2">
                <h4 className="structure-details-card-title">Metadata</h4>
                <div className="structure-details-meta-grid">
                  <div className="structure-details-field structure-details-field--name">
                    <label className="structure-details-label">Name</label>
                    <input
                      type="text"
                      value={formPayload.name}
                      onChange={(e) => updateForm({ name: e.target.value })}
                      placeholder="Structure name"
                      className="structure-details-input"
                      aria-label="Structure name"
                    />
                  </div>
                  <div className="structure-details-field structure-details-field--version">
                    <label className="structure-details-label">Version</label>
                    <input
                      type="number"
                      min={1}
                      value={formPayload.version ?? 1}
                      onChange={(e) => updateForm({ version: parseInt(e.target.value, 10) || 1 })}
                      disabled={typeof formOpen === 'number'}
                      className="structure-details-input structure-details-input--narrow"
                      aria-label="Version"
                    />
                  </div>
                  <div className="structure-details-field structure-details-field--available">
                    <label className="toggle-switch structure-details-toggle" style={{ cursor: 'pointer' }}>
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
                <div className="structure-copy-template-block" style={{ marginTop: 'var(--space-2)' }}>
                  <label className="structure-details-label">Template</label>
                  <div className="structure-template-filters structure-template-filters--compact" aria-label="Template filters">
                    <div className="structure-template-filters-search-row">
                      <input
                        type="search"
                        className="structure-template-filters-search structure-details-input"
                        placeholder="Filter by name or code…"
                        value={tplFilterSearch}
                        onChange={(e) => setTplFilterSearch(e.target.value)}
                        aria-label="Filter templates by name or code"
                      />
                      <button
                        type="button"
                        className="btn-secondary structure-template-filters-toggle"
                        onClick={() => setTplFiltersExpanded((v) => !v)}
                        aria-expanded={tplFiltersExpanded}
                      >
                        {tplFiltersExpanded ? 'Hide dimensions' : 'Dimensions'}
                        {Object.values(tplDimFilters).filter(Boolean).length > 0
                          ? ` (${Object.values(tplDimFilters).filter(Boolean).length})`
                          : ''}
                      </button>
                      {activeTplFilterCount > 0 && (
                        <button
                          type="button"
                          className="btn-secondary structure-template-filters-clear"
                          onClick={() => {
                            setTplFilterSearch('')
                            setTplDimFilters({})
                          }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {tplFiltersExpanded && (
                      <div className="structure-template-filters-dims">
                        {TEMPLATE_DIM_TYPES.map((dt) => (
                          <label key={dt} className="structure-template-filter-dim">
                            <span className="structure-template-filter-dim-label">{TEMPLATE_DIM_LABELS[dt]}</span>
                            <select
                              className="structure-details-input structure-template-filter-select"
                              value={tplDimFilters[dt] ?? ''}
                              onChange={(e) =>
                                setTplDimFilters((prev) => ({
                                  ...prev,
                                  [dt]: e.target.value,
                                }))
                              }
                              aria-label={`Filter by ${TEMPLATE_DIM_LABELS[dt]}`}
                            >
                              <option value="">Any</option>
                              {tplDimOptions[dt].map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    )}
                    <p className="structure-template-filters-meta">
                      {copyTemplateSelectOptions.length} template(s) in list
                    </p>
                  </div>
                  <select
                    value={formPayload.strategy_template_id ?? ''}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (v) handleTemplateSelect(v)
                    }}
                    aria-label="Template"
                    className="structure-details-input structure-copy-template-select"
                  >
                    <option value="">— Select —</option>
                    {copyTemplateSelectOptions.map((tpl) => (
                      <option key={tpl.strategy_template_id} value={tpl.strategy_template_id}>
                        {tpl.display_name} ({tpl.template_code})
                      </option>
                    ))}
                  </select>
                  {copyTemplateSelectOptions.length === 0 && (
                    <p className="form-hint">No templates match filters. Clear filters to see all.</p>
                  )}
                </div>
              </div>

              <div className="structure-details-card">
                <h4 className="structure-details-card-title">Legs</h4>
                <p className="structure-details-hint structure-details-card-desc">
                  From template. Not editable here.
                </p>
                {defaultLegsLoading ? (
                  <p className="structure-details-hint">Loading legs…</p>
                ) : (
                  <div className="structure-details-table-wrap">
                    <table className="structure-details-table" aria-label="Structure legs">
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
                )}
              </div>

              <div className="structure-details-card">
                <h4 className="structure-details-card-title">Constraints</h4>
                <div className="structure-details-constraints">
                  {formConstraints.map((c, i) => (
                    <div key={i} className="structure-details-constraint-row">
                      <input
                        type="text"
                        value={c.constraint_type ?? ''}
                        onChange={(e) => updateConstraint(i, { constraint_type: e.target.value })}
                        placeholder="Type"
                        className="structure-details-input structure-details-constraint-type"
                        aria-label="Constraint type"
                      />
                      <input
                        type="text"
                        value={c.constraint_value_text ?? ''}
                        onChange={(e) => updateConstraint(i, { constraint_value_text: e.target.value })}
                        placeholder="Value (text)"
                        className="structure-details-input structure-details-constraint-value"
                        aria-label="Value text"
                      />
                      <input
                        type="number"
                        value={c.constraint_value_int ?? ''}
                        onChange={(e) => updateConstraint(i, { constraint_value_int: e.target.value === '' ? undefined : parseInt(e.target.value, 10) })}
                        placeholder="Int"
                        className="structure-details-input structure-details-constraint-int"
                        aria-label="Value int"
                      />
                      <button
                        type="button"
                        className="btn-secondary structure-details-constraint-remove"
                        onClick={() => removeConstraint(i)}
                        aria-label="Remove constraint"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn-secondary structure-details-add-constraint" onClick={addConstraint}>
                    Add constraint
                  </button>
                </div>
              </div>

              <div className="structure-details-card">
                <h4 className="structure-details-card-title">Notes</h4>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={3}
                  placeholder="Optional notes"
                  className="structure-details-input"
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>

              <div className="structure-details-card">
                <h4 className="structure-details-card-title">Meta</h4>
                <div className="structure-details-constraints">
                  {formMeta.map((m, i) => (
                    <div key={i} className="structure-details-constraint-row">
                      <input
                        type="text"
                        value={m.meta_key ?? ''}
                        onChange={(e) => updateMeta(i, { meta_key: e.target.value })}
                        placeholder="Key"
                        className="structure-details-input structure-details-constraint-type"
                        aria-label="Meta key"
                      />
                      <input
                        type="text"
                        value={m.meta_value_text ?? ''}
                        onChange={(e) => updateMeta(i, { meta_value_text: e.target.value })}
                        placeholder="Value"
                        className="structure-details-input structure-details-constraint-value"
                        aria-label="Meta value"
                      />
                      <button
                        type="button"
                        className="btn-secondary structure-details-constraint-remove"
                        onClick={() => removeMeta(i)}
                        aria-label="Remove meta"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn-secondary structure-details-add-constraint" onClick={addMeta}>
                    Add meta
                  </button>
                </div>
              </div>
            </div>
          )}
          </div>
          <div className="structure-form-footer">
            <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
            {isWizard ? (
              wizardStep < 3 ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={goWizardNext}
                  disabled={wizardStep === 1 && !selectedTemplateId}
                >
                  Next
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={submitWizardForm} disabled={formLoading}>
                  {formOpen === 'create' ? 'Create' : 'Save'}
                </button>
              )
            ) : (
              <button type="button" className="btn-primary" onClick={submitForm} disabled={formLoading}>
                {formOpen === 'create' ? 'Create' : 'Save'}
              </button>
            )}
          </div>
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
