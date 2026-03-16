import { useCallback, useEffect, useState } from 'react'
import {
  fetchStructureTypes,
  fetchStructureTypeDefaultLegs,
  fetchStructureTypeSubtypes,
  fetchParamKindOptions,
  fetchLegRoleOptions,
  fetchLegDirectionOptions,
  fetchLegOptionRightOptions,
  fetchMetaKeyOptions,
  fetchMetaValueOptions,
  createStructureType,
  updateStructureType,
  deleteStructureType,
  replaceStructureTypeLegs,
  fetchStructureSubtypeDefaultLegs,
  replaceStructureSubtypeLegs,
  createSubtype,
  updateSubtype,
  deleteSubtype,
  replaceSubtypeCharacteristics,
  replaceSubtypeMetaParams,
  replaceInferRules,
  type StructureTypeItem,
  type StructureTypePayload,
  type StructureTypeUpdatePayload,
  type StructureTypeLegPayload,
  type SubtypeItem,
  type SubtypePayload,
  type SubtypeUpdatePayload,
  type MetaParamItem,
  type InferRuleItem,
  type StructureTypeConfigOption,
} from '../api'

export interface StructureTypeConfigPageProps {
  breadcrumbLabel?: string
}

export function StructureTypeConfigPage({
  breadcrumbLabel = 'Type Config',
}: StructureTypeConfigPageProps) {
  const [types, setTypes] = useState<StructureTypeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [detailLegs, setDetailLegs] = useState<StructureTypeLegPayload[]>([])
  const [detailSubtypes, setDetailSubtypes] = useState<SubtypeItem[]>([])
  const [detailInferRules, setDetailInferRules] = useState<InferRuleItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [expandedSubtype, setExpandedSubtype] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const [createTypeOpen, setCreateTypeOpen] = useState(false)
  const [createTypePayload, setCreateTypePayload] = useState<StructureTypePayload>({
    structure_type: '',
    display_label: '',
    sort_order: 0,
    has_subtypes: false,
    type_explanation: null,
  })
  const [createTypeSaving, setCreateTypeSaving] = useState(false)
  const [createTypeError, setCreateTypeError] = useState<string | null>(null)

  const [createSubtypeOpen, setCreateSubtypeOpen] = useState(false)
  const [createSubtypePayload, setCreateSubtypePayload] = useState<SubtypePayload>({
    subtype: '',
    display_label: '',
    example: null,
    typical_use: null,
    subtype_explanation: null,
    nature: null,
    sort_order: 0,
  })
  const [createSubtypeSaving, setCreateSubtypeSaving] = useState(false)
  const [createSubtypeError, setCreateSubtypeError] = useState<string | null>(null)

  const [typeForm, setTypeForm] = useState<StructureTypeUpdatePayload>({})
  const [typeFormSaving, setTypeFormSaving] = useState(false)
  const [legsSaving, setLegsSaving] = useState(false)
  const [inferRulesSaving, setInferRulesSaving] = useState(false)
  const [subtypeSaveState, setSubtypeSaveState] = useState<Record<string, 'idle' | 'saving'>>({})

  const [subtypeLegsByKey, setSubtypeLegsByKey] = useState<Record<string, StructureTypeLegPayload[] | null>>({})
  const [subtypeModeByKey, setSubtypeModeByKey] = useState<Record<string, 'inherit' | 'override'>>({})
  const [subtypeLegsLoadingByKey, setSubtypeLegsLoadingByKey] = useState<Record<string, boolean>>({})
  const [subtypeLegsSavingByKey, setSubtypeLegsSavingByKey] = useState<Record<string, boolean>>({})

  const [paramKindOptions, setParamKindOptions] = useState<StructureTypeConfigOption[]>([])
  const [legRoleOptions, setLegRoleOptions] = useState<StructureTypeConfigOption[]>([])
  const [legDirectionOptions, setLegDirectionOptions] = useState<StructureTypeConfigOption[]>([])
  const [legOptionRightOptions, setLegOptionRightOptions] = useState<StructureTypeConfigOption[]>([])
  const [metaKeyOptions, setMetaKeyOptions] = useState<StructureTypeConfigOption[]>([])
  const [metaValueOptionsByKey, setMetaValueOptionsByKey] = useState<Record<string, StructureTypeConfigOption[]>>({})

  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    message: string
    confirming: boolean
    action: (() => Promise<void>) | null
  }>({
    open: false,
    title: '',
    message: '',
    confirming: false,
    action: null,
  })

  const loadTypes = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchStructureTypes()
      .then((res) => setTypes(res.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadTypes()
  }, [loadTypes])

  useEffect(() => {
    if (!loading && types.length > 0 && selectedType === null) {
      setSelectedType(types[0].structure_type)
    }
  }, [loading, types, selectedType])

  useEffect(() => {
    fetchParamKindOptions()
      .then((r) => setParamKindOptions(r.options ?? []))
      .catch(() => setParamKindOptions([]))
  }, [])
  useEffect(() => {
    Promise.all([
      fetchLegRoleOptions().then((r) => r.options ?? []),
      fetchLegDirectionOptions().then((r) => r.options ?? []),
      fetchLegOptionRightOptions().then((r) => r.options ?? []),
    ])
      .then(([role, direction, optionRight]) => {
        setLegRoleOptions(role)
        setLegDirectionOptions(direction)
        setLegOptionRightOptions(optionRight)
      })
      .catch(() => {
        setLegRoleOptions([])
        setLegDirectionOptions([])
        setLegOptionRightOptions([])
      })
  }, [])

  useEffect(() => {
    if (!selectedType) {
      setMetaKeyOptions([])
      setMetaValueOptionsByKey({})
      return
    }
    setMetaValueOptionsByKey({})
    fetchMetaKeyOptions(selectedType)
      .then((r) => setMetaKeyOptions(r.options ?? []))
      .catch(() => setMetaKeyOptions([]))
  }, [selectedType])

  useEffect(() => {
    if (!selectedType) return
    const keys = new Set(detailInferRules.map((r) => r.meta_key).filter(Boolean))
    keys.forEach((metaKey) => {
      fetchMetaValueOptions(selectedType, metaKey)
        .then((res) =>
          setMetaValueOptionsByKey((prev) => ({ ...prev, [metaKey]: res.options ?? [] }))
        )
        .catch(() => { })
    })
  }, [selectedType, detailInferRules])

  const loadDetail = useCallback((structureType: string) => {
    if (!structureType) {
      setDetailLegs([])
      setDetailSubtypes([])
      setDetailInferRules([])
      return
    }
    setDetailLoading(true)
    setDetailError(null)
    Promise.all([
      fetchStructureTypeDefaultLegs(structureType),
      fetchStructureTypeSubtypes(structureType),
    ])
      .then(([legsRes, subtypesRes]) => {
        const legs = (legsRes.legs ?? []).map((l) => ({
          role: l.role ?? null,
          direction: l.direction ?? null,
          option_right: l.option_right ?? null,
          quantity_default: l.quantity ?? 1,
          sort_order: (legsRes.legs ?? []).indexOf(l),
        }))
        setDetailLegs(legs)
        setDetailSubtypes(subtypesRes.subtypes ?? [])
        setDetailInferRules(subtypesRes.infer_rules ?? [])
        const current = types.find((t) => t.structure_type === structureType)
        if (current) {
          setTypeForm({
            display_label: current.display_label,
            sort_order: current.sort_order,
            has_subtypes: current.has_subtypes,
            type_explanation: current.type_explanation ?? null,
          })
        }
      })
      .catch((e) => setDetailError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDetailLoading(false))
  }, [types])

  useEffect(() => {
    if (selectedType) loadDetail(selectedType)
    else {
      setDetailLegs([])
      setDetailSubtypes([])
      setDetailInferRules([])
      setTypeForm({})
    }
  }, [selectedType, loadDetail])

  useEffect(() => {
    if (!selectedType) return
    setSubtypeLegsByKey({})
    setSubtypeModeByKey({})
    setSubtypeLegsLoadingByKey({})
    setSubtypeLegsSavingByKey({})
  }, [selectedType])

  const openCreateType = () => {
    setCreateTypePayload({
      structure_type: '',
      display_label: '',
      sort_order: types.length,
      has_subtypes: false,
      type_explanation: null,
    })
    setCreateTypeError(null)
    setCreateTypeOpen(true)
  }

  const submitCreateType = async () => {
    const st = (createTypePayload.structure_type || '').trim().toLowerCase().replace(/\s+/g, '_')
    if (!st) {
      setCreateTypeError('Structure type code is required')
      return
    }
    setCreateTypeSaving(true)
    setCreateTypeError(null)
    try {
      await createStructureType({
        ...createTypePayload,
        structure_type: st,
        display_label: (createTypePayload.display_label || '').trim() || st,
        sort_order: createTypePayload.sort_order ?? types.length,
        has_subtypes: createTypePayload.has_subtypes ?? false,
        type_explanation: (createTypePayload.type_explanation || '').trim() || null,
      })
      loadTypes()
      setSelectedType(st)
      setCreateTypeOpen(false)
    } catch (e) {
      setCreateTypeError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreateTypeSaving(false)
    }
  }

  const handleDeleteType = (structureType: string) => {
    setConfirmState({
      open: true,
      title: 'Delete structure type',
      message: `Delete structure type "${structureType}"? This will remove its default legs and subtypes. It will fail if any strategy or gate set references this type.`,
      confirming: false,
      action: async () => {
        try {
          await deleteStructureType(structureType)
          loadTypes()
          if (selectedType === structureType) setSelectedType(null)
        } catch (e) {
          setDetailError(e instanceof Error ? e.message : String(e))
        }
      },
    })
  }

  const saveTypeForm = async () => {
    if (!selectedType) return
    setTypeFormSaving(true)
    setDetailError(null)
    try {
      await updateStructureType(selectedType, typeForm)
      loadTypes()
      loadDetail(selectedType)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setTypeFormSaving(false)
    }
  }

  const updateLegs = (next: StructureTypeLegPayload[]) => setDetailLegs(next)
  const addLeg = () => {
    setDetailLegs((prev) => [
      ...prev,
      {
        role: legRoleOptions[0]?.value ?? null,
        direction: legDirectionOptions[0]?.value ?? null,
        option_right: legOptionRightOptions[0]?.value ?? null,
        quantity_default: 1,
        sort_order: prev.length,
      },
    ])
  }
  const removeLeg = (index: number) => {
    setDetailLegs((prev) => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, sort_order: i })))
  }

  const saveLegs = async () => {
    if (!selectedType) return
    setLegsSaving(true)
    setDetailError(null)
    try {
      await replaceStructureTypeLegs(
        selectedType,
        detailLegs.map((l, i) => ({
          role: l.role,
          direction: l.direction,
          option_right: l.option_right,
          quantity_default: l.quantity_default ?? 1,
          sort_order: i,
        }))
      )
      loadDetail(selectedType)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setLegsSaving(false)
    }
  }

  const openCreateSubtype = () => {
    setCreateSubtypePayload({
      subtype: '',
      display_label: '',
      example: null,
      typical_use: null,
      subtype_explanation: null,
      nature: null,
      sort_order: detailSubtypes.length,
    })
    setCreateSubtypeError(null)
    setCreateSubtypeOpen(true)
  }

  const submitCreateSubtype = async () => {
    const sub = (createSubtypePayload.subtype || '').trim().toLowerCase().replace(/\s+/g, '_')
    if (!sub || !selectedType) {
      setCreateSubtypeError('Subtype code is required')
      return
    }
    setCreateSubtypeSaving(true)
    setCreateSubtypeError(null)
    try {
      await createSubtype(selectedType, {
        ...createSubtypePayload,
        subtype: sub,
        display_label: (createSubtypePayload.display_label || '').trim() || sub,
        sort_order: createSubtypePayload.sort_order ?? detailSubtypes.length,
      })
      loadDetail(selectedType!)
      setCreateSubtypeOpen(false)
    } catch (e) {
      setCreateSubtypeError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreateSubtypeSaving(false)
    }
  }

  const handleDeleteSubtype = (subtype: string) => {
    if (!selectedType) return
    setConfirmState({
      open: true,
      title: 'Delete subtype',
      message: `Delete subtype "${subtype}"?`,
      confirming: false,
      action: async () => {
        try {
          await deleteSubtype(selectedType, subtype)
          loadDetail(selectedType)
        } catch (e) {
          setDetailError(e instanceof Error ? e.message : String(e))
        }
      },
    })
  }

  const saveSubtype = async (
    subtype: string,
    payload: SubtypeUpdatePayload
  ) => {
    if (!selectedType) return
    setSubtypeSaveState((s) => ({ ...s, [subtype]: 'saving' }))
    setDetailError(null)
    try {
      await updateSubtype(selectedType, subtype, payload)
      loadDetail(selectedType)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubtypeSaveState((s) => ({ ...s, [subtype]: 'idle' }))
    }
  }

  const saveCharacteristics = async (subtype: string, items: string[]) => {
    if (!selectedType) return
    setSubtypeSaveState((s) => ({ ...s, [subtype]: 'saving' }))
    setDetailError(null)
    try {
      await replaceSubtypeCharacteristics(selectedType, subtype, items)
      loadDetail(selectedType)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubtypeSaveState((s) => ({ ...s, [subtype]: 'idle' }))
    }
  }

  const saveMetaParams = async (
    subtype: string,
    items: { meta_key: string; display_label?: string | null; default_value_text?: string | null; param_kind?: string | null; sort_order: number }[]
  ) => {
    if (!selectedType) return
    setSubtypeSaveState((s) => ({ ...s, [subtype]: 'saving' }))
    setDetailError(null)
    try {
      await replaceSubtypeMetaParams(selectedType, subtype, items)
      loadDetail(selectedType)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubtypeSaveState((s) => ({ ...s, [subtype]: 'idle' }))
    }
  }

  const subtypeKey = (type: string, subtype: string) => `${type}:${subtype}`

  const legsEqual = (
    a: StructureTypeLegPayload[],
    b: { role?: string | null; direction?: string | null; option_right?: string | null; quantity_default?: number; quantity?: number }[]
  ): boolean => {
    if (a.length !== b.length) return false
    return a.every((leg, i) => {
      const o = b[i]
      if (!o) return false
      const qA = leg.quantity_default ?? leg.quantity ?? 1
      const qB = 'quantity_default' in o ? (o.quantity_default ?? 1) : ('quantity' in o ? (o.quantity ?? 1) : 1)
      return (
        (leg.role ?? '').toString().trim() === (o.role ?? '').toString().trim() &&
        (leg.direction ?? '').toString().trim() === (o.direction ?? '').toString().trim() &&
        (leg.option_right ?? '').toString().trim() === (o.option_right ?? '').toString().trim() &&
        qA === qB
      )
    })
  }

  const loadSubtypeLegs = useCallback(
    (type: string, subtype: string) => {
      const key = subtypeKey(type, subtype)
      if (subtypeLegsLoadingByKey[key]) return
      setSubtypeLegsLoadingByKey((s) => ({ ...s, [key]: true }))
      fetchStructureSubtypeDefaultLegs(type, subtype)
        .then((res) => {
          const legs = (res.legs ?? []).map((l, i) => ({
            role: l.role ?? null,
            direction: l.direction ?? null,
            option_right: l.option_right ?? null,
            quantity_default: l.quantity ?? 1,
            sort_order: i,
          }))
          const typeLegs = detailLegs.map((l, i) => ({
            role: l.role,
            direction: l.direction,
            option_right: l.option_right,
            quantity_default: l.quantity_default ?? 1,
            quantity: l.quantity_default ?? 1,
          }))
          if (legsEqual(typeLegs, legs)) {
            setSubtypeModeByKey((s) => ({ ...s, [key]: 'inherit' }))
            setSubtypeLegsByKey((s) => ({ ...s, [key]: [] }))
          } else {
            setSubtypeModeByKey((s) => ({ ...s, [key]: 'override' }))
            setSubtypeLegsByKey((s) => ({ ...s, [key]: legs }))
          }
        })
        .catch(() => {
          setSubtypeLegsByKey((s) => ({ ...s, [key]: [] }))
          setSubtypeModeByKey((s) => ({ ...s, [key]: 'inherit' }))
        })
        .finally(() => {
          setSubtypeLegsLoadingByKey((s) => ({ ...s, [key]: false }))
        })
    },
    [detailLegs, subtypeLegsLoadingByKey]
  )

  const saveSubtypeLegs = useCallback(
    async (type: string, subtype: string, legs: StructureTypeLegPayload[]) => {
      const key = subtypeKey(type, subtype)
      setSubtypeLegsSavingByKey((s) => ({ ...s, [key]: true }))
      setDetailError(null)
      try {
        await replaceStructureSubtypeLegs(
          type,
          subtype,
          legs.map((l, i) => ({
            role: l.role,
            direction: l.direction,
            option_right: l.option_right,
            quantity_default: l.quantity_default ?? 1,
            sort_order: i,
          }))
        )
        setSubtypeLegsByKey((s) => ({ ...s, [key]: legs }))
        setSubtypeModeByKey((s) => ({ ...s, [key]: 'override' }))
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e))
      } finally {
        setSubtypeLegsSavingByKey((s) => ({ ...s, [key]: false }))
      }
    },
    []
  )

  const switchSubtypeToInherit = useCallback(
    async (type: string, subtype: string) => {
      const key = subtypeKey(type, subtype)
      setSubtypeLegsSavingByKey((s) => ({ ...s, [key]: true }))
      setDetailError(null)
      try {
        await replaceStructureSubtypeLegs(type, subtype, [])
        setSubtypeModeByKey((s) => ({ ...s, [key]: 'inherit' }))
        setSubtypeLegsByKey((s) => ({ ...s, [key]: [] }))
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e))
      } finally {
        setSubtypeLegsSavingByKey((s) => ({ ...s, [key]: false }))
      }
    },
    []
  )

  const switchSubtypeToOverride = useCallback(
    (type: string, subtype: string) => {
      const key = subtypeKey(type, subtype)
      const current = subtypeLegsByKey[key]
      const initial =
        current != null && current.length > 0
          ? current
          : detailLegs.map((l, i) => ({
            role: l.role,
            direction: l.direction,
            option_right: l.option_right,
            quantity_default: l.quantity_default ?? 1,
            sort_order: i,
          }))
      setSubtypeModeByKey((s) => ({ ...s, [key]: 'override' }))
      setSubtypeLegsByKey((s) => ({ ...s, [key]: initial }))
    },
    [detailLegs, subtypeLegsByKey]
  )

  useEffect(() => {
    if (!selectedType || !expandedSubtype) return
    const key = subtypeKey(selectedType, expandedSubtype)
    if (subtypeLegsByKey[key] === undefined && !subtypeLegsLoadingByKey[key]) {
      loadSubtypeLegs(selectedType, expandedSubtype)
    }
  }, [selectedType, expandedSubtype, subtypeLegsByKey, subtypeLegsLoadingByKey, loadSubtypeLegs])

  const updateInferRules = (next: InferRuleItem[]) => setDetailInferRules(next)
  const saveInferRules = async () => {
    if (!selectedType) return
    setInferRulesSaving(true)
    setDetailError(null)
    try {
      await replaceInferRules(selectedType, detailInferRules)
      loadDetail(selectedType)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setInferRulesSaving(false)
    }
  }

  const selectedTypeItem = types.find((t) => t.structure_type === selectedType)

  return (
    <div className="card process-section">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Strategy / {breadcrumbLabel}
      </h2>

      <div style={{ display: 'flex', gap: 0, flexWrap: 'nowrap', alignItems: 'stretch' }}>
        <aside
          style={{
            width: sidebarCollapsed ? 48 : 260,
            minWidth: sidebarCollapsed ? 48 : 220,
            flexShrink: 0,
            transition: 'width 0.2s ease',
            overflow: 'hidden',
            borderRight: '1px solid var(--color-border)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-surface-elevated)',
            borderRadius: 8,
            marginRight: 'var(--space-4)',
          }}
        >
          {sidebarCollapsed ? (
            <div style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSidebarCollapsed(false)}
                title="Show structure types"
                aria-label="Show structure types"
                style={{ padding: 'var(--space-2) var(--space-1)', minWidth: 36 }}
              >
                &#9654;
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)', padding: 'var(--space-2) var(--space-2) 0' }}>
                <h3 className="section-subtitle" style={{ margin: 0 }}>Structure types</h3>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setSidebarCollapsed(true)}
                  title="Hide sidebar"
                  style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--text-caption)' }}
                  aria-label="Hide sidebar"
                >
                  &#9664;
                </button>
              </div>
              <div style={{ padding: '0 var(--space-2)', flex: 1, minHeight: 0, overflow: 'auto' }}>
                <button type="button" className="btn-primary" onClick={openCreateType} style={{ width: '100%', marginBottom: 'var(--space-2)' }}>
                  Add type
                </button>
                {loading && <p className="section-hint">Loading…</p>}
                {error && <p className="msg-error">{error}</p>}
                {!loading && !error && (
                  <ul className="structure-type-config-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {types.map((t) => (
                      <li key={t.structure_type}>
                        <button
                          type="button"
                          className={`structure-type-config-list-item ${selectedType === t.structure_type ? 'active' : ''}`}
                          onClick={() => setSelectedType(t.structure_type)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: 'var(--space-2) var(--space-3)',
                            marginBottom: 'var(--space-1)',
                            borderRadius: 6,
                            border: '1px solid var(--color-border)',
                            background: selectedType === t.structure_type ? 'var(--color-accent-soft)' : 'transparent',
                            color: 'var(--color-text-main)',
                            cursor: 'pointer',
                          }}
                        >
                          <strong>{t.display_label}</strong>
                          <span style={{ marginLeft: 'var(--space-2)', color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>
                            {t.structure_type}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!loading && !error && types.length === 0 && (
                  <p className="section-hint">No structure types. Add one to get started.</p>
                )}
              </div>
            </>
          )}
        </aside>

        <section className="strategy-section" style={{ flex: 1, minWidth: 0 }}>
          {!selectedType && (
            <p className="section-hint">Select a structure type to view and edit its config.</p>
          )}
          {selectedType && detailLoading && <p className="section-hint">Loading…</p>}
          {selectedType && detailError && <p className="msg-error">{detailError}</p>}
          {selectedType && !detailLoading && (
            <>
              <h3 className="section-subtitle">
                Type:{' '}
                {selectedTypeItem?.display_label
                  ? `${selectedTypeItem.display_label} (${selectedType})`
                  : selectedType}
              </h3>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => handleDeleteType(selectedType)}
                  style={{ marginLeft: 'auto' }}
                >
                  Delete type
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
                <div className="strategy-section" style={{ minWidth: 0 }}>
                  <h4 className="section-subtitle" style={{ fontSize: 'var(--text-body)' }}>Type info</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <label>Display label</label>
                    <input
                      type="text"
                      value={typeForm.display_label ?? selectedTypeItem?.display_label ?? ''}
                      onChange={(e) => setTypeForm((p) => ({ ...p, display_label: e.target.value }))}
                      placeholder="Display name"
                    />
                    <label>Sort order</label>
                    <input
                      type="number"
                      value={typeForm.sort_order ?? selectedTypeItem?.sort_order ?? 0}
                      onChange={(e) => setTypeForm((p) => ({ ...p, sort_order: parseInt(e.target.value, 10) || 0 }))}
                    />
                    <label
                      className="toggle-switch"
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                    >
                      <span>Has subtypes</span>
                      <input
                        type="checkbox"
                        checked={typeForm.has_subtypes ?? selectedTypeItem?.has_subtypes ?? false}
                        onChange={(e) =>
                          setTypeForm((p) => ({ ...p, has_subtypes: e.target.checked }))
                        }
                        aria-label="Has subtypes"
                      />
                    </label>
                    <label>Type explanation</label>
                    <input
                      type="text"
                      value={typeForm.type_explanation ?? selectedTypeItem?.type_explanation ?? ''}
                      onChange={(e) => setTypeForm((p) => ({ ...p, type_explanation: e.target.value || null }))}
                      placeholder="Optional"
                    />
                  </div>
                  <button type="button" className="btn-primary" onClick={saveTypeForm} disabled={typeFormSaving} style={{ marginTop: 'var(--space-2)' }}>
                    {typeFormSaving ? 'Saving…' : 'Save type info'}
                  </button>
                </div>

                <div className="strategy-section" style={{ minWidth: 0 }}>
                  <h4 className="section-subtitle" style={{ fontSize: 'var(--text-body)' }}>Default legs</h4>
                  <div className="table-wrap" style={{ width: '100%' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Direction</th>
                          <th>Option (C/P)</th>
                          <th>Qty</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailLegs.map((leg, i) => (
                          <tr key={i}>
                            <td>
                              <select
                                value={leg.role ?? ''}
                                onChange={(e) =>
                                  updateLegs(
                                    detailLegs.map((l, j) => (j === i ? { ...l, role: e.target.value || null } : l))
                                  )
                                }
                                style={{ width: '100%', minWidth: 120 }}
                              >
                                <option value="">—</option>
                                {legRoleOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                value={leg.direction ?? ''}
                                onChange={(e) =>
                                  updateLegs(
                                    detailLegs.map((l, j) => (j === i ? { ...l, direction: e.target.value || null } : l))
                                  )
                                }
                                style={{ width: '100%', minWidth: 90 }}
                              >
                                <option value="">—</option>
                                {legDirectionOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                value={leg.option_right ?? ''}
                                onChange={(e) =>
                                  updateLegs(
                                    detailLegs.map((l, j) => (j === i ? { ...l, option_right: e.target.value || null } : l))
                                  )
                                }
                                style={{ width: 100 }}
                              >
                                {legOptionRightOptions.map((opt) => (
                                  <option key={opt.value || '_empty'} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                type="number"
                                value={leg.quantity_default ?? 1}
                                onChange={(e) =>
                                  updateLegs(
                                    detailLegs.map((l, j) =>
                                      j === i ? { ...l, quantity_default: parseInt(e.target.value, 10) || 1 } : l
                                    )
                                  )
                                }
                                min={1}
                                style={{ width: 50 }}
                              />
                            </td>
                            <td>
                              <button type="button" className="btn-secondary" onClick={() => removeLeg(i)}>
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button type="button" className="btn-secondary" onClick={addLeg} style={{ marginRight: 'var(--space-2)' }}>
                    Add leg
                  </button>
                  <button type="button" className="btn-primary" onClick={saveLegs} disabled={legsSaving}>
                    {legsSaving ? 'Saving…' : 'Save legs'}
                  </button>
                </div>
              </div>

              <div className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 'var(--space-2)',
                    borderBottom: '1px solid var(--color-border)',
                    paddingBottom: 'var(--space-2)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <h4
                      className="section-subtitle"
                      style={{ margin: 0, fontSize: 'var(--text-body)' }}
                    >
                      Subtypes
                    </h4>
                    {detailSubtypes.length > 0 && (
                      <div
                        className="structure-subtype-tabs"
                        role="tablist"
                        aria-label="Subtypes"
                        style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}
                      >
                        {detailSubtypes.map((sub) => {
                          const isActive = expandedSubtype === sub.subtype
                          return (
                            <button
                              key={sub.subtype}
                              type="button"
                              role="tab"
                              aria-selected={isActive}
                              className={`structure-subtype-tab ${isActive ? 'structure-subtype-tab--active' : ''
                                }`}
                              onClick={() =>
                                setExpandedSubtype((prev) =>
                                  prev === sub.subtype ? null : sub.subtype
                                )
                              }
                              style={{
                                padding: '4px 10px',
                                borderRadius: 999,
                                border: '1px solid var(--color-border)',
                                background: isActive
                                  ? 'var(--color-accent-soft)'
                                  : 'var(--color-surface)',
                                fontSize: 'var(--text-caption)',
                                cursor: 'pointer',
                                color: isActive
                                  ? 'var(--color-text-main)'
                                  : 'var(--color-text-muted)',
                              }}
                            >
                              {sub.display_label || sub.subtype}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <button type="button" className="btn-primary" onClick={openCreateSubtype}>
                    Add subtype
                  </button>
                </div>
                {detailSubtypes.length === 0 && <p className="section-hint">No subtypes. Add one if this type has variants (e.g. covered_call: otm, atm, itm).</p>}
                {detailSubtypes.map((sub) => (
                  <SubtypeBlock
                    key={sub.subtype}
                    subtype={sub}
                    structureType={selectedType!}
                    typeDefaultLegs={detailLegs}
                    subtypeLegs={subtypeLegsByKey[subtypeKey(selectedType!, sub.subtype)] ?? null}
                    subtypeMode={subtypeModeByKey[subtypeKey(selectedType!, sub.subtype)] ?? 'inherit'}
                    subtypeLegsLoading={subtypeLegsLoadingByKey[subtypeKey(selectedType!, sub.subtype)] ?? false}
                    subtypeLegsSaving={subtypeLegsSavingByKey[subtypeKey(selectedType!, sub.subtype)] ?? false}
                    onLoadSubtypeLegs={() => loadSubtypeLegs(selectedType!, sub.subtype)}
                    onSwitchToInherit={() => switchSubtypeToInherit(selectedType!, sub.subtype)}
                    onSwitchToOverride={() => switchSubtypeToOverride(selectedType!, sub.subtype)}
                    onSaveSubtypeLegs={(legs) => saveSubtypeLegs(selectedType!, sub.subtype, legs)}
                    legRoleOptions={legRoleOptions}
                    legDirectionOptions={legDirectionOptions}
                    legOptionRightOptions={legOptionRightOptions}
                    metaKeyOptions={metaKeyOptions}
                    paramKindOptions={paramKindOptions}
                    expanded={expandedSubtype === sub.subtype}
                    onToggle={() => setExpandedSubtype((x) => (x === sub.subtype ? null : sub.subtype))}
                    onSaveSubtype={(payload) => saveSubtype(sub.subtype, payload)}
                    onSaveCharacteristics={(items) => saveCharacteristics(sub.subtype, items)}
                    onSaveMetaParams={(items) => saveMetaParams(sub.subtype, items)}
                    onDelete={() => handleDeleteSubtype(sub.subtype)}
                    saving={subtypeSaveState[sub.subtype] === 'saving'}
                  />
                ))}
              </div>

              <div className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
                <h4 className="section-subtitle" style={{ fontSize: 'var(--text-body)' }}>Infer rules (meta → subtype)</h4>
                <p className="section-hint" style={{ marginBottom: 'var(--space-2)' }}>
                  When editing a structure, these rules infer the subtype from strategy_structure_meta.
                </p>
                <div className="table-wrap" style={{ width: '100%' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>meta_key</th>
                        <th>meta_value_text</th>
                        <th>subtype</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailInferRules.map((r, i) => {
                        const valueOpts = r.meta_key ? (metaValueOptionsByKey[r.meta_key] ?? []) : []
                        return (
                          <tr key={i}>
                            <td>
                              <select
                                value={r.meta_key}
                                onChange={(e) =>
                                  updateInferRules(
                                    detailInferRules.map((x, j) => (j === i ? { ...x, meta_key: e.target.value, meta_value_text: '' } : x))
                                  )
                                }
                                style={{ width: '100%', minWidth: 120 }}
                              >
                                <option value="">—</option>
                                {metaKeyOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              {valueOpts.length > 0 ? (
                                <select
                                  value={r.meta_value_text}
                                  onChange={(e) =>
                                    updateInferRules(
                                      detailInferRules.map((x, j) => (j === i ? { ...x, meta_value_text: e.target.value } : x))
                                    )
                                  }
                                  style={{ width: '100%', minWidth: 120 }}
                                >
                                  <option value="">—</option>
                                  {valueOpts.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={r.meta_value_text}
                                  onChange={(e) =>
                                    updateInferRules(
                                      detailInferRules.map((x, j) => (j === i ? { ...x, meta_value_text: e.target.value } : x))
                                    )
                                  }
                                  style={{ width: '100%', minWidth: 120 }}
                                  placeholder="No enum constraint"
                                />
                              )}
                            </td>
                            <td>
                              <select
                                value={r.subtype}
                                onChange={(e) =>
                                  updateInferRules(
                                    detailInferRules.map((x, j) => (j === i ? { ...x, subtype: e.target.value } : x))
                                  )
                                }
                                style={{ width: '100%', minWidth: 80 }}
                              >
                                <option value="">—</option>
                                {detailSubtypes.map((s) => (
                                  <option key={s.subtype} value={s.subtype}>
                                    {s.display_label ? `${s.display_label} (${s.subtype})` : s.subtype}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => updateInferRules(detailInferRules.filter((_, j) => j !== i))}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => updateInferRules([...detailInferRules, { meta_key: metaKeyOptions[0]?.value ?? '', meta_value_text: '', subtype: detailSubtypes[0]?.subtype ?? '' }])}
                  disabled={metaKeyOptions.length === 0 || detailSubtypes.length === 0}
                  style={{ marginRight: 'var(--space-2)' }}
                  title={metaKeyOptions.length === 0 ? 'No meta_key allowed for this structure type' : detailSubtypes.length === 0 ? 'Add at least one subtype first' : undefined}
                >
                  Add rule
                </button>
                <button type="button" className="btn-primary" onClick={saveInferRules} disabled={inferRulesSaving}>
                  {inferRulesSaving ? 'Saving…' : 'Save infer rules'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {createTypeOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ padding: 'var(--space-4)', maxWidth: 400 }}>
            <h3 className="section-subtitle">New structure type</h3>
            {createTypeError && <p className="msg-error">{createTypeError}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
              <label>Type code (ID)</label>
              <input
                type="text"
                value={createTypePayload.structure_type}
                onChange={(e) => setCreateTypePayload((p) => ({ ...p, structure_type: e.target.value }))}
                placeholder="e.g. covered_call"
              />
              <label>Display label</label>
              <input
                type="text"
                value={createTypePayload.display_label}
                onChange={(e) => setCreateTypePayload((p) => ({ ...p, display_label: e.target.value }))}
                placeholder="e.g. Covered Call"
              />
              <label>Sort order</label>
              <input
                type="number"
                value={createTypePayload.sort_order ?? 0}
                onChange={(e) => setCreateTypePayload((p) => ({ ...p, sort_order: parseInt(e.target.value, 10) || 0 }))}
              />
              <label>Has subtypes</label>
              <input
                type="checkbox"
                checked={createTypePayload.has_subtypes ?? false}
                onChange={(e) => setCreateTypePayload((p) => ({ ...p, has_subtypes: e.target.checked }))}
              />
              <label>Type explanation</label>
              <input
                type="text"
                value={createTypePayload.type_explanation ?? ''}
                onChange={(e) => setCreateTypePayload((p) => ({ ...p, type_explanation: e.target.value || null }))}
                placeholder="Optional"
              />
            </div>
            <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-2)' }}>
              <button type="button" className="btn-primary" onClick={submitCreateType} disabled={createTypeSaving}>
                {createTypeSaving ? 'Creating…' : 'Create'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setCreateTypeOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {createSubtypeOpen && selectedType && (
        <div className="modal-overlay" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ padding: 'var(--space-4)', maxWidth: 480 }}>
            <h3 className="section-subtitle">New subtype for {selectedType}</h3>
            {createSubtypeError && <p className="msg-error">{createSubtypeError}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
              <label>Subtype code</label>
              <input
                type="text"
                value={createSubtypePayload.subtype}
                onChange={(e) => setCreateSubtypePayload((p) => ({ ...p, subtype: e.target.value }))}
                placeholder="e.g. otm"
              />
              <label>Display label</label>
              <input
                type="text"
                value={createSubtypePayload.display_label}
                onChange={(e) => setCreateSubtypePayload((p) => ({ ...p, display_label: e.target.value }))}
                placeholder="e.g. OTM Covered Call"
              />
              <label>Example</label>
              <input
                type="text"
                value={createSubtypePayload.example ?? ''}
                onChange={(e) => setCreateSubtypePayload((p) => ({ ...p, example: e.target.value || null }))}
                placeholder="Optional"
              />
              <label>Typical use</label>
              <input
                type="text"
                value={createSubtypePayload.typical_use ?? ''}
                onChange={(e) => setCreateSubtypePayload((p) => ({ ...p, typical_use: e.target.value || null }))}
                placeholder="Optional"
              />
              <label>Sort order</label>
              <input
                type="number"
                value={createSubtypePayload.sort_order ?? 0}
                onChange={(e) => setCreateSubtypePayload((p) => ({ ...p, sort_order: parseInt(e.target.value, 10) || 0 }))}
              />
            </div>
            <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-2)' }}>
              <button type="button" className="btn-primary" onClick={submitCreateSubtype} disabled={createSubtypeSaving}>
                {createSubtypeSaving ? 'Creating…' : 'Create'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setCreateSubtypeOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div className="card" style={{ padding: 'var(--space-4)', maxWidth: 480 }}>
            <h3 id="confirm-dialog-title" className="section-subtitle" style={{ marginTop: 0 }}>
              {confirmState.title || 'Confirm action'}
            </h3>
            <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              {confirmState.message}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  setConfirmState((prev) => ({
                    ...prev,
                    open: false,
                    confirming: false,
                    action: null,
                  }))
                }
                disabled={confirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={async () => {
                  if (!confirmState.action) {
                    setConfirmState((prev) => ({ ...prev, open: false }))
                    return
                  }
                  setConfirmState((prev) => ({ ...prev, confirming: true }))
                  await confirmState.action()
                  setConfirmState({
                    open: false,
                    title: '',
                    message: '',
                    confirming: false,
                    action: null,
                  })
                }}
                disabled={confirmState.confirming}
              >
                {confirmState.confirming ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SubtypeBlock({
  subtype,
  structureType,
  typeDefaultLegs,
  subtypeLegs,
  subtypeMode,
  subtypeLegsLoading,
  subtypeLegsSaving,
  onLoadSubtypeLegs,
  onSwitchToInherit,
  onSwitchToOverride,
  onSaveSubtypeLegs,
  legRoleOptions,
  legDirectionOptions,
  legOptionRightOptions,
  metaKeyOptions,
  paramKindOptions,
  expanded,
  onToggle,
  onSaveSubtype,
  onSaveMetaParams,
  onSaveCharacteristics,
  onDelete,
  saving,
}: {
  subtype: SubtypeItem
  structureType: string
  typeDefaultLegs: StructureTypeLegPayload[]
  subtypeLegs: StructureTypeLegPayload[] | null
  subtypeMode: 'inherit' | 'override'
  subtypeLegsLoading: boolean
  subtypeLegsSaving: boolean
  onLoadSubtypeLegs: () => void
  onSwitchToInherit: () => void
  onSwitchToOverride: () => void
  onSaveSubtypeLegs: (legs: StructureTypeLegPayload[]) => Promise<void>
  legRoleOptions: StructureTypeConfigOption[]
  legDirectionOptions: StructureTypeConfigOption[]
  legOptionRightOptions: StructureTypeConfigOption[]
  metaKeyOptions: StructureTypeConfigOption[]
  paramKindOptions: StructureTypeConfigOption[]
  expanded: boolean
  onToggle: () => void
  onSaveSubtype: (p: SubtypeUpdatePayload) => void
  onSaveCharacteristics: (items: string[]) => void
  onSaveMetaParams: (items: MetaParamItem[]) => void
  onDelete: () => void
  saving: boolean
}) {
  const [edit, setEdit] = useState<SubtypeUpdatePayload>({})
  const [charEdit, setCharEdit] = useState<string[]>([])
  const [metaEdit, setMetaEdit] = useState<MetaParamItem[]>([])
  const [metaValueOptionsByKey, setMetaValueOptionsByKey] = useState<Record<string, StructureTypeConfigOption[]>>({})
  const [legRows, setLegRows] = useState<StructureTypeLegPayload[]>([])

  useEffect(() => {
    setEdit({})
    setCharEdit(subtype.characteristics ?? [])
    setMetaEdit(subtype.meta_params ?? [])
  }, [subtype.subtype, subtype.characteristics, subtype.meta_params])

  useEffect(() => {
    if (subtypeMode === 'override') {
      if (subtypeLegs != null && subtypeLegs.length > 0) {
        setLegRows(subtypeLegs.map((l, i) => ({ ...l, sort_order: i })))
      } else {
        setLegRows(
          typeDefaultLegs.map((l, i) => ({
            role: l.role,
            direction: l.direction,
            option_right: l.option_right,
            quantity_default: l.quantity_default ?? 1,
            sort_order: i,
          }))
        )
      }
    }
  }, [subtypeMode, subtypeLegs, typeDefaultLegs])

  useEffect(() => {
    if (!structureType) return
    const keys = new Set(
      metaEdit.filter((m) => m.meta_key && (m.param_kind === 'fixed' || !m.param_kind)).map((m) => m.meta_key!)
    )
    keys.forEach((metaKey) => {
      fetchMetaValueOptions(structureType, metaKey)
        .then((res) =>
          setMetaValueOptionsByKey((prev) => ({ ...prev, [metaKey]: res.options ?? [] }))
        )
        .catch(() => { })
    })
  }, [structureType, metaEdit])

  const displayLabel = edit.display_label !== undefined ? edit.display_label : subtype.display_label
  const example = edit.example !== undefined ? edit.example : subtype.example
  const typicalUse = edit.typical_use !== undefined ? edit.typical_use : subtype.typical_use
  const subtypeExplanation = edit.subtype_explanation !== undefined ? edit.subtype_explanation : subtype.subtype_explanation
  const nature = edit.nature !== undefined ? edit.nature : subtype.nature
  const sortOrder = edit.sort_order !== undefined ? edit.sort_order : subtype.sort_order

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 'var(--space-2)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          padding: 'var(--space-2) var(--space-3)',
          background: expanded ? 'var(--color-surface-elevated)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--color-text-main)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong>{subtype.display_label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{subtype.subtype}</span>
      </button>
      {expanded && (
        <div style={{ padding: 'var(--space-3)', borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
            <label>Display label</label>
            <input
              type="text"
              value={displayLabel}
              onChange={(e) => setEdit((p) => ({ ...p, display_label: e.target.value }))}
            />
            <label>Example</label>
            <input
              type="text"
              value={example ?? ''}
              onChange={(e) => setEdit((p) => ({ ...p, example: e.target.value || null }))}
            />
            <label>Typical use</label>
            <input
              type="text"
              value={typicalUse ?? ''}
              onChange={(e) => setEdit((p) => ({ ...p, typical_use: e.target.value || null }))}
            />
            <label>Subtype explanation</label>
            <input
              type="text"
              value={subtypeExplanation ?? ''}
              onChange={(e) => setEdit((p) => ({ ...p, subtype_explanation: e.target.value || null }))}
              placeholder="Optional"
            />
            <label>Nature</label>
            <input
              type="text"
              value={nature ?? ''}
              onChange={(e) => setEdit((p) => ({ ...p, nature: e.target.value || null }))}
              placeholder="Optional"
            />
            <label>Sort order</label>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setEdit((p) => ({ ...p, sort_order: parseInt(e.target.value, 10) || 0 }))}
            />
          </div>
          <button type="button" className="btn-primary" onClick={() => onSaveSubtype(edit)} disabled={saving} style={{ marginRight: 'var(--space-2)' }}>
            {saving ? 'Saving…' : 'Save subtype'}
          </button>
          <button type="button" className="btn-danger" onClick={onDelete} style={{ marginRight: 'var(--space-2)' }}>
            Delete subtype
          </button>

          <h5 style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>Subtype default legs</h5>
          {subtypeLegsLoading && (
            <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
              Loading…
            </p>
          )}
          {!subtypeLegsLoading && (
            <>
              <div
                className="subtype-legs-mode-toggle"
                style={{
                  display: 'inline-flex',
                  borderRadius: 999,
                  border: '1px solid var(--color-border)',
                  padding: '2px',
                  background: 'var(--color-surface-elevated)',
                  marginBottom: 'var(--space-2)',
                }}
                role="radiogroup"
                aria-label="Default legs mode"
              >
                <button
                  type="button"
                  className={subtypeMode === 'inherit' ? 'pill-toggle pill-toggle-active' : 'pill-toggle'}
                  onClick={() => !subtypeLegsSaving && onSwitchToInherit()}
                  disabled={subtypeLegsSaving}
                  aria-pressed={subtypeMode === 'inherit'}
                  style={{
                    border: 'none',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 'var(--text-caption)',
                    cursor: subtypeLegsSaving ? 'not-allowed' : 'pointer',
                    background:
                      subtypeMode === 'inherit' ? 'var(--color-accent-soft)' : 'transparent',
                    color:
                      subtypeMode === 'inherit'
                        ? 'var(--color-text-main)'
                        : 'var(--color-text-muted)',
                  }}
                >
                  Use type default legs
                </button>
                <button
                  type="button"
                  className={subtypeMode === 'override' ? 'pill-toggle pill-toggle-active' : 'pill-toggle'}
                  onClick={() => !subtypeLegsSaving && onSwitchToOverride()}
                  disabled={subtypeLegsSaving}
                  aria-pressed={subtypeMode === 'override'}
                  style={{
                    border: 'none',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 'var(--text-caption)',
                    cursor: subtypeLegsSaving ? 'not-allowed' : 'pointer',
                    background:
                      subtypeMode === 'override' ? 'var(--color-accent-soft)' : 'transparent',
                    color:
                      subtypeMode === 'override'
                        ? 'var(--color-text-main)'
                        : 'var(--color-text-muted)',
                  }}
                >
                  Override with subtype-specific legs
                </button>
              </div>
              {subtypeMode === 'inherit' && (
                <p className="form-hint" style={{ marginBottom: 'var(--space-2)' }}>
                  This subtype inherits type-level legs.
                </p>
              )}
              {subtypeMode === 'override' && (
                <>
                  <div className="table-wrap" style={{ width: '100%' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Direction</th>
                          <th>Option (C/P)</th>
                          <th>Qty</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {legRows.map((leg, i) => (
                          <tr key={i}>
                            <td>
                              <select
                                value={leg.role ?? ''}
                                onChange={(e) =>
                                  setLegRows((prev) =>
                                    prev.map((l, j) => (j === i ? { ...l, role: e.target.value || null } : l))
                                  )
                                }
                                style={{ width: '100%', minWidth: 120 }}
                              >
                                <option value="">—</option>
                                {legRoleOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                value={leg.direction ?? ''}
                                onChange={(e) =>
                                  setLegRows((prev) =>
                                    prev.map((l, j) => (j === i ? { ...l, direction: e.target.value || null } : l))
                                  )
                                }
                                style={{ width: '100%', minWidth: 90 }}
                              >
                                <option value="">—</option>
                                {legDirectionOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                value={leg.option_right ?? ''}
                                onChange={(e) =>
                                  setLegRows((prev) =>
                                    prev.map((l, j) => (j === i ? { ...l, option_right: e.target.value || null } : l))
                                  )
                                }
                                style={{ width: 100 }}
                              >
                                {legOptionRightOptions.map((opt) => (
                                  <option key={opt.value || '_empty'} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                type="number"
                                value={leg.quantity_default ?? 1}
                                onChange={(e) =>
                                  setLegRows((prev) =>
                                    prev.map((l, j) =>
                                      j === i ? { ...l, quantity_default: parseInt(e.target.value, 10) || 1 } : l
                                    )
                                  )
                                }
                                min={1}
                                style={{ width: 50 }}
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() =>
                                  setLegRows((prev) =>
                                    prev.filter((_, j) => j !== i).map((l, j) => ({ ...l, sort_order: j }))
                                  )
                                }
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      setLegRows((prev) => [
                        ...prev,
                        {
                          role: legRoleOptions[0]?.value ?? null,
                          direction: legDirectionOptions[0]?.value ?? null,
                          option_right: legOptionRightOptions[0]?.value ?? null,
                          quantity_default: 1,
                          sort_order: prev.length,
                        },
                      ])
                    }
                    style={{ marginRight: 'var(--space-2)' }}
                  >
                    Add leg
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => onSaveSubtypeLegs(legRows)}
                    disabled={subtypeLegsSaving}
                  >
                    {subtypeLegsSaving ? 'Saving…' : 'Save legs'}
                  </button>
                </>
              )}
            </>
          )}

          <h5 style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>Characteristics</h5>
          <textarea
            value={charEdit.join('\n')}
            onChange={(e) => setCharEdit(e.target.value.split('\n'))}
            rows={3}
            placeholder="One per line"
            style={{ width: '100%', minWidth: 0, marginBottom: 'var(--space-2)' }}
          />
          <button type="button" className="btn-primary" onClick={() => onSaveCharacteristics(charEdit)} disabled={saving}>
            {saving ? 'Saving…' : 'Save characteristics'}
          </button>

          <h5 style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>Meta params</h5>
          <div className="table-wrap" style={{ width: '100%' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>meta_key</th>
                  <th>display_label</th>
                  <th>default_value_text</th>
                  <th>param_kind</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {metaEdit.map((m, i) => {
                  const isFixed = m.param_kind === 'fixed'
                  const fixedValueOpts = m.meta_key && (m.param_kind === 'fixed' || !m.param_kind)
                    ? (metaValueOptionsByKey[m.meta_key] ?? [])
                    : []
                  return (
                    <tr key={i}>
                      <td>
                        <select
                          value={m.meta_key}
                          onChange={(e) =>
                            setMetaEdit((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, meta_key: e.target.value, default_value_text: null } : x))
                            )
                          }
                          disabled={isFixed}
                          style={{ width: '100%', minWidth: 100 }}
                        >
                          <option value="">—</option>
                          {metaKeyOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={m.display_label ?? ''}
                          onChange={(e) =>
                            setMetaEdit((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, display_label: e.target.value || null } : x))
                            )
                          }
                          style={{ width: '100%', minWidth: 100 }}
                        />
                      </td>
                      <td>
                        {fixedValueOpts.length > 0 ? (
                          <select
                            value={m.default_value_text ?? ''}
                            onChange={(e) =>
                              setMetaEdit((prev) =>
                                prev.map((x, j) => (j === i ? { ...x, default_value_text: e.target.value || null } : x))
                              )
                            }
                            disabled={isFixed}
                            style={{ width: 120 }}
                          >
                            <option value="">—</option>
                            {fixedValueOpts.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={m.default_value_text ?? ''}
                            onChange={(e) =>
                              setMetaEdit((prev) =>
                                prev.map((x, j) => (j === i ? { ...x, default_value_text: e.target.value || null } : x))
                              )
                            }
                            disabled={isFixed}
                            style={{ width: 100 }}
                            placeholder="Optional"
                          />
                        )}
                      </td>
                      <td>
                        <select
                          value={m.param_kind ?? ''}
                          onChange={(e) =>
                            setMetaEdit((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, param_kind: e.target.value || null } : x))
                            )
                          }
                          disabled={isFixed}
                          style={{ width: 90 }}
                        >
                          <option value="">—</option>
                          {paramKindOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {!isFixed && (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setMetaEdit((prev) => prev.filter((_, j) => j !== i))}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              setMetaEdit((prev) => [
                ...prev,
                {
                  meta_key: metaKeyOptions[0]?.value ?? '',
                  display_label: null,
                  default_value_text: null,
                  param_kind: paramKindOptions.find((opt) => opt.value !== 'fixed')?.value ?? null,
                  sort_order: prev.length,
                },
              ])
            }
            disabled={metaKeyOptions.length === 0}
            style={{ marginRight: 'var(--space-2)' }}
            title={metaKeyOptions.length === 0 ? 'No meta_key allowed for this structure type' : undefined}
          >
            Add meta param
          </button>
          <button type="button" className="btn-primary" onClick={() => onSaveMetaParams(metaEdit)} disabled={saving} style={{ marginTop: 'var(--space-2)' }}>
            {saving ? 'Saving…' : 'Save meta params'}
          </button>
        </div>
      )}
    </div>
  )
}
