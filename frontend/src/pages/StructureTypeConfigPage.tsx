import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchTemplates,
  fetchTemplateDetail,
  fetchDimsGrouped,
  fetchParamKindOptions,
  fetchLegRoleOptions,
  fetchLegDirectionOptions,
  fetchLegOptionRightOptions,
  fetchMetaKeyOptions,
  fetchMetaValueOptions,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  replaceTemplateLegs,
  replaceTemplateParams,
  replaceTemplateCharacteristics,
  createDim,
  deleteDim,
  type StrategyTemplateRow,
  type StrategyTemplateDetail,
  type StructureTypeLegPayload,
  type StructureLeg,
  type MetaParamPayload,
  type MetaParamItem,
  type StructureTypeConfigOption,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

const DIM_TYPES = [
  'direction',
  'structure',
  'coverage',
  'risk',
  'volatility',
  'time',
] as const

const DIM_LABELS: Record<string, string> = {
  direction: 'Direction',
  structure: 'Structure',
  coverage: 'Coverage',
  risk: 'Risk',
  volatility: 'Volatility',
  time: 'Time',
}

const DIM_ICONS: Record<string, string> = {
  direction: '↕',
  structure: '⬡',
  coverage: '◎',
  risk: '⚡',
  volatility: '〰',
  time: '⏱',
}

export interface StructureTypeConfigPageProps {
  breadcrumbLabel?: string
}

const PAGE_TITLE_SUFFIX = 'Option Type Config'

export function StructureTypeConfigPage({
  breadcrumbLabel = PAGE_TITLE_SUFFIX,
}: StructureTypeConfigPageProps) {
  const [templates, setTemplates] = useState<StrategyTemplateRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<StrategyTemplateDetail | null>(null)
  const [dimsByType, setDimsByType] = useState<Record<string, { strategy_dim_id: number; code: string; display_label: string; sort_order: number }[]>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [dimsOpen, setDimsOpen] = useState(false)
  const [newDimType, setNewDimType] = useState('direction')
  const [newDimCode, setNewDimCode] = useState('')
  const [newDimLabel, setNewDimLabel] = useState('')

  const [paramKindOpts, setParamKindOpts] = useState<StructureTypeConfigOption[]>([])
  const [legRoleOpts, setLegRoleOpts] = useState<StructureTypeConfigOption[]>([])
  const [legDirOpts, setLegDirOpts] = useState<StructureTypeConfigOption[]>([])
  const [legOrOpts, setLegOrOpts] = useState<StructureTypeConfigOption[]>([])

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmMsg, setConfirmMsg] = useState('')
  const [confirmAction, setConfirmAction] = useState<() => Promise<void>>(() => async () => {})

  const [createOpen, setCreateOpen] = useState(false)
  const [newTplCode, setNewTplCode] = useState('')
  const [newTplName, setNewTplName] = useState('')

  const [saveFeedback, setSaveFeedback] = useState<{ section: string; ok: boolean } | null>(null)
  const [searchText, setSearchText] = useState('')
  const [dimFilters, setDimFilters] = useState<Record<string, string>>({})
  const [filtersExpanded, setFiltersExpanded] = useState(false)

  const activeDimFilterCount = Object.values(dimFilters).filter(Boolean).length
  const hasAnyFilter = activeDimFilterCount > 0 || searchText.trim().length > 0

  const filteredTemplates = useMemo(() => {
    let result = templates
    const q = searchText.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (t) =>
          t.display_name.toLowerCase().includes(q) ||
          t.template_code.toLowerCase().includes(q)
      )
    }
    if (activeDimFilterCount > 0) {
      result = result.filter((t) =>
        DIM_TYPES.every((dt) => {
          const filterVal = dimFilters[dt]
          if (!filterVal) return true
          return (t[`dim_${dt}` as keyof StrategyTemplateRow] as string | null) === filterVal
        })
      )
    }
    return result
  }, [templates, searchText, dimFilters, activeDimFilterCount])

  const sidebarTemplates = useMemo(() => {
    return [...filteredTemplates].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    )
  }, [filteredTemplates])

  const [dragTemplateId, setDragTemplateId] = useState<number | null>(null)

  const clearAllFilters = () => { setDimFilters({}); setSearchText('') }

  const showFeedback = (section: string, ok: boolean) => {
    setSaveFeedback({ section, ok })
    setTimeout(() => setSaveFeedback(null), 2000)
  }

  const loadTemplates = useCallback(async () => {
    const { items } = await fetchTemplates(false)
    setTemplates(items)
  }, [])

  const applyTemplateReorder = async (draggedId: number, targetId: number) => {
    if (draggedId === targetId) return
    const order = [...templates].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    )
    const ids = order.map((t) => t.strategy_template_id)
    const from = ids.indexOf(draggedId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, draggedId)
    const updates: Promise<unknown>[] = []
    for (let i = 0; i < next.length; i++) {
      const tid = next[i]
      const row = templates.find((t) => t.strategy_template_id === tid)
      const newOrder = (i + 1) * 10
      if (row && row.sort_order !== newOrder) {
        updates.push(updateTemplate(tid, { sort_order: newOrder }))
      }
    }
    if (updates.length === 0) return
    try {
      await Promise.all(updates)
      await loadTemplates()
      showFeedback('reorder', true)
    } catch {
      showFeedback('reorder', false)
    }
  }

  const loadDims = useCallback(async () => {
    const { by_type } = await fetchDimsGrouped()
    setDimsByType(by_type)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setErr(null)
      try {
        await Promise.all([
          loadTemplates(),
          loadDims(),
          fetchParamKindOptions().then((r) => {
            if (!cancelled) setParamKindOpts(r.options)
          }),
          fetchLegRoleOptions().then((r) => {
            if (!cancelled) setLegRoleOpts(r.options)
          }),
          fetchLegDirectionOptions().then((r) => {
            if (!cancelled) setLegDirOpts(r.options)
          }),
          fetchLegOptionRightOptions().then((r) => {
            if (!cancelled) setLegOrOpts(r.options)
          }),
        ])
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadTemplates, loadDims])

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      return
    }
    let cancelled = false
    fetchTemplateDetail(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const saveTemplateInfo = async () => {
    if (!detail) return
    try {
      const code = detail.template_code.trim().toLowerCase().replace(/\s+/g, '_')
      if (!code || !/^[a-z][a-z0-9_]*$/.test(code)) {
        showFeedback('info', false)
        return
      }
      await updateTemplate(detail.strategy_template_id, {
        template_code: code,
        display_name: detail.display_name,
        dim_direction: detail.dim_direction,
        dim_structure: detail.dim_structure,
        dim_coverage: detail.dim_coverage,
        dim_risk: detail.dim_risk,
        dim_volatility: detail.dim_volatility,
        dim_time: detail.dim_time,
        explanation: detail.explanation,
        typical_use: detail.typical_use,
        example: detail.example,
        nature: detail.nature,
        sort_order: detail.sort_order,
        is_active: detail.is_active,
      })
      await loadTemplates()
      const d = await fetchTemplateDetail(detail.strategy_template_id)
      setDetail(d)
      showFeedback('info', true)
    } catch {
      showFeedback('info', false)
    }
  }

  const saveLegs = async () => {
    if (!detail) return
    try {
      const legs: StructureTypeLegPayload[] = (detail.legs || []).map((l: StructureLeg, i: number) => ({
        role: l.role,
        direction: l.direction,
        option_right: l.option_right === null || l.option_right === undefined ? '' : String(l.option_right),
        quantity_default: l.quantity ?? 1,
        sort_order: i,
      }))
      await replaceTemplateLegs(detail.strategy_template_id, legs)
      const d = await fetchTemplateDetail(detail.strategy_template_id)
      setDetail(d)
      showFeedback('legs', true)
    } catch {
      showFeedback('legs', false)
    }
  }

  const saveParams = async () => {
    if (!detail) return
    try {
      const items: MetaParamPayload[] = (detail.meta_params || []).map((p: MetaParamItem) => ({
        meta_key: p.meta_key,
        display_label: p.display_label,
        default_value_text: p.default_value_text,
        param_kind: p.param_kind || 'fixed',
        sort_order: p.sort_order,
      }))
      await replaceTemplateParams(detail.strategy_template_id, items)
      const d = await fetchTemplateDetail(detail.strategy_template_id)
      setDetail(d)
      showFeedback('params', true)
    } catch {
      showFeedback('params', false)
    }
  }

  const saveCharacteristics = async () => {
    if (!detail) return
    try {
      await replaceTemplateCharacteristics(detail.strategy_template_id, detail.characteristics || [])
      const d = await fetchTemplateDetail(detail.strategy_template_id)
      setDetail(d)
      showFeedback('chars', true)
    } catch {
      showFeedback('chars', false)
    }
  }

  const openDeleteTemplate = () => {
    if (!detail) return
    setConfirmMsg(
      `Delete template "${detail.display_name}"? This fails if any strategy structure references it.`
    )
    setConfirmAction(() => async () => {
      await deleteTemplate(detail.strategy_template_id)
      setSelectedId(null)
      await loadTemplates()
    })
    setConfirmOpen(true)
  }

  const openCreateTemplate = async () => {
    const code = newTplCode.trim().toLowerCase().replace(/\s+/g, '_')
    const name = newTplName.trim() || code
    if (!code) return
    const { strategy_template_id } = await createTemplate({
      template_code: code,
      display_name: name,
      dim_structure: 'custom',
      sort_order: 100,
    })
    setCreateOpen(false)
    setNewTplCode('')
    setNewTplName('')
    await loadTemplates()
    setSelectedId(strategy_template_id)
  }

  const addDimRow = async () => {
    if (!newDimCode.trim()) return
    await createDim(newDimType, {
      code: newDimCode.trim().toLowerCase(),
      display_label: newDimLabel.trim() || newDimCode.trim(),
      sort_order: 0,
    })
    setNewDimCode('')
    setNewDimLabel('')
    await loadDims()
  }

  if (loading && !templates.length) {
    return (
      <div className="otc-page">
        <header className="otc-page-header">
          <h1 className="otc-page-title">
            <span className="otc-page-title-prefix">Strategy / </span>
            {breadcrumbLabel}
          </h1>
        </header>
        <div className="otc-loading">Loading…</div>
      </div>
    )
  }

  if (err && !templates.length) {
    return (
      <div className="otc-page">
        <header className="otc-page-header">
          <h1 className="otc-page-title">
            <span className="otc-page-title-prefix">Strategy / </span>
            {breadcrumbLabel}
          </h1>
        </header>
        <div className="otc-error">{err}</div>
      </div>
    )
  }

  return (
    <div className="otc-page">
      <header className="otc-page-header">
        <h1 className="otc-page-title">
          <span className="otc-page-title-prefix">Strategy / </span>
          {breadcrumbLabel}
        </h1>
        <div className="otc-page-actions">
          <button type="button" className="otc-btn otc-btn-ghost" onClick={() => setDimsOpen(true)}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Dimensions
          </button>
          <button type="button" className="otc-btn otc-btn-accent" onClick={() => setCreateOpen(true)}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            New template
          </button>
        </div>
      </header>

      <div className="otc-layout">
        {/* ───── Sidebar ───── */}
        <aside className="otc-sidebar">
          <div className="otc-sidebar-header">
            <span className="otc-sidebar-count">
              {saveFeedback?.section === 'reorder' && (
                <span className={`otc-sidebar-reorder-feedback ${saveFeedback.ok ? 'ok' : 'err'}`}>
                  {saveFeedback.ok ? 'Order saved' : 'Reorder failed'}
                </span>
              )}
              {hasAnyFilter
                ? `${filteredTemplates.length} / ${templates.length}`
                : `${templates.length}`}{' '}
              templates
            </span>
            <button
              type="button"
              className={`otc-filter-toggle ${filtersExpanded ? 'otc-filter-toggle--open' : ''} ${activeDimFilterCount > 0 ? 'otc-filter-toggle--active' : ''}`}
              onClick={() => setFiltersExpanded((v) => !v)}
              title="Filter by dimensions"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              {activeDimFilterCount > 0 && (
                <span className="otc-filter-badge">{activeDimFilterCount}</span>
              )}
            </button>
          </div>
          <div className="otc-search-bar">
            <span className="otc-search-icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input
              className="otc-search-input"
              type="text"
              autoComplete="off"
              placeholder="Search templates…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            {searchText && (
              <button type="button" className="otc-search-clear" onClick={() => setSearchText('')} aria-label="Clear search">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
          {filtersExpanded && (
            <div className="otc-filter-panel">
              {DIM_TYPES.map((dt) => (
                <label key={dt} className="otc-filter-row">
                  <span className="otc-filter-row-icon">{DIM_ICONS[dt]}</span>
                  <span className="otc-filter-row-label">{DIM_LABELS[dt]}</span>
                  <select
                    className="otc-filter-select"
                    value={dimFilters[dt] || ''}
                    onChange={(e) =>
                      setDimFilters((prev) => {
                        const next = { ...prev }
                        if (e.target.value) next[dt] = e.target.value
                        else delete next[dt]
                        return next
                      })
                    }
                  >
                    <option value="">All</option>
                    {(dimsByType[dt] || []).map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.display_label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {activeDimFilterCount > 0 && (
                <button type="button" className="otc-filter-clear" onClick={clearAllFilters}>
                  Clear all filters
                </button>
              )}
            </div>
          )}
          {hasAnyFilter && (
            <p className="otc-sidebar-reorder-hint">
              Clear filters to reorder templates by dragging.
            </p>
          )}
          <ul className="otc-sidebar-list">
            {sidebarTemplates.map((t) => (
              <li
                key={t.strategy_template_id}
                className={`otc-sidebar-list-row ${dragTemplateId === t.strategy_template_id ? 'otc-sidebar-list-row--drag' : ''}`}
                onDragOver={
                  hasAnyFilter
                    ? undefined
                    : (e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                      }
                }
                onDrop={
                  hasAnyFilter
                    ? undefined
                    : (e) => {
                        e.preventDefault()
                        const id = parseInt(
                          e.dataTransfer.getData('application/x-strategy-template-id'),
                          10
                        )
                        if (!Number.isNaN(id)) {
                          void applyTemplateReorder(id, t.strategy_template_id)
                        }
                        setDragTemplateId(null)
                      }
                }
              >
                {!hasAnyFilter && (
                  <span
                    className="otc-sidebar-drag-handle"
                    draggable
                    role="button"
                    tabIndex={0}
                    aria-label="Drag to reorder"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') e.preventDefault()
                    }}
                    onDragStart={(e) => {
                      e.stopPropagation()
                      setDragTemplateId(t.strategy_template_id)
                      e.dataTransfer.setData(
                        'application/x-strategy-template-id',
                        String(t.strategy_template_id)
                      )
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragTemplateId(null)}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
                      <circle cx="9" cy="6" r="1.5" />
                      <circle cx="15" cy="6" r="1.5" />
                      <circle cx="9" cy="12" r="1.5" />
                      <circle cx="15" cy="12" r="1.5" />
                      <circle cx="9" cy="18" r="1.5" />
                      <circle cx="15" cy="18" r="1.5" />
                    </svg>
                  </span>
                )}
                <button
                  type="button"
                  className={`otc-sidebar-item ${selectedId === t.strategy_template_id ? 'otc-sidebar-item--active' : ''}`}
                  onClick={() => setSelectedId(t.strategy_template_id)}
                >
                  <span className="otc-sidebar-item-name">{t.display_name}</span>
                  <span className="otc-sidebar-item-code">{t.template_code}</span>
                </button>
              </li>
            ))}
            {filteredTemplates.length === 0 && hasAnyFilter && (
              <li className="otc-sidebar-no-match">
                No templates match the current filters.
              </li>
            )}
          </ul>
        </aside>

        {/* ───── Detail pane ───── */}
        <section className="otc-detail">
          {!detail ? (
            <div className="otc-empty-state">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.25"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
              <p>Select a template from the sidebar</p>
            </div>
          ) : (
            <div className="otc-detail-scroll">
              {/* ── Template Info Card ── */}
              <div className="otc-card">
                <div className="otc-card-header">
                  <div className="otc-card-header-left">
                    <h2 className="otc-card-title">{detail.display_name}</h2>
                    <span className="otc-card-badge">{detail.template_code}</span>
                  </div>
                  <div className="otc-card-header-actions">
                    {saveFeedback?.section === 'info' && (
                      <span className={`otc-save-feedback ${saveFeedback.ok ? 'ok' : 'err'}`}>
                        {saveFeedback.ok ? 'Saved' : 'Error'}
                      </span>
                    )}
                    <button type="button" className="otc-btn otc-btn-accent otc-btn-sm" onClick={() => void saveTemplateInfo()}>
                      Save
                    </button>
                    <button type="button" className="otc-btn otc-btn-danger-ghost otc-btn-sm" onClick={openDeleteTemplate}>
                      Delete
                    </button>
                  </div>
                </div>
                <div className="otc-form-row">
                  <label className="otc-field otc-field--template-code">
                    <span className="otc-field-label-row">
                      <span className="otc-field-label">Template code</span>
                      <InfoTooltip text="Lowercase snake_case. Save applies; must be unique." />
                    </span>
                    <input
                      className="otc-input otc-input--mono"
                      value={detail.template_code}
                      onChange={(e) =>
                        setDetail({ ...detail, template_code: e.target.value })
                      }
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <label className="otc-field">
                    <span className="otc-field-label">Display name</span>
                    <input
                      className="otc-input"
                      value={detail.display_name}
                      onChange={(e) => setDetail({ ...detail, display_name: e.target.value })}
                    />
                  </label>
                  <label className="otc-field otc-field--narrow">
                    <span className="otc-field-label">Sort order</span>
                    <input
                      className="otc-input"
                      type="number"
                      value={detail.sort_order}
                      onChange={(e) =>
                        setDetail({ ...detail, sort_order: parseInt(e.target.value, 10) || 0 })
                      }
                    />
                  </label>
                  <label className="otc-field otc-field--toggle">
                    <span className="otc-toggle-wrap">
                      <input
                        type="checkbox"
                        className="otc-toggle-input"
                        checked={detail.is_active}
                        onChange={(e) => setDetail({ ...detail, is_active: e.target.checked })}
                      />
                      <span className="otc-toggle-track" />
                    </span>
                    <span className="otc-field-label">Active</span>
                  </label>
                </div>
              </div>

              {/* ── Six Dimensions Card ── */}
              <div className="otc-card">
                <div className="otc-card-header">
                  <h3 className="otc-section-title">Six Dimensions</h3>
                </div>
                <div className="otc-dim-grid">
                  {DIM_TYPES.map((dt) => (
                    <label key={dt} className="otc-dim-cell">
                      <span className="otc-dim-icon">{DIM_ICONS[dt]}</span>
                      <span className="otc-dim-label">{DIM_LABELS[dt]}</span>
                      <select
                        className="otc-select"
                        value={detail[`dim_${dt}` as keyof StrategyTemplateDetail] as string || ''}
                        onChange={(e) =>
                          setDetail({
                            ...detail,
                            [`dim_${dt}`]: e.target.value || null,
                          } as StrategyTemplateDetail)
                        }
                      >
                        <option value="">—</option>
                        {(dimsByType[dt] || []).map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.display_label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              {/* ── Default Legs Card ── */}
              <div className="otc-card">
                <div className="otc-card-header">
                  <h3 className="otc-section-title">Default Legs</h3>
                  <div className="otc-card-header-actions">
                    {saveFeedback?.section === 'legs' && (
                      <span className={`otc-save-feedback ${saveFeedback.ok ? 'ok' : 'err'}`}>
                        {saveFeedback.ok ? 'Saved' : 'Error'}
                      </span>
                    )}
                    <button
                      type="button"
                      className="otc-btn otc-btn-ghost otc-btn-sm"
                      onClick={() =>
                        setDetail({
                          ...detail,
                          legs: [...(detail.legs || []), { quantity: 1, role: 'call', direction: 'long', option_right: 'C' }],
                        })
                      }
                    >
                      + Add leg
                    </button>
                    <button type="button" className="otc-btn otc-btn-accent otc-btn-sm" onClick={() => void saveLegs()}>
                      Save
                    </button>
                  </div>
                </div>
                {(detail.legs || []).length === 0 ? (
                  <p className="otc-table-empty">No legs defined. Click "Add leg" to get started.</p>
                ) : (
                  <div className="otc-table-wrap">
                    <table className="otc-table">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Direction</th>
                          <th>Right</th>
                          <th className="otc-col-num">Qty</th>
                          <th className="otc-col-action" />
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.legs || []).map((leg: StructureLeg, i: number) => (
                          <tr key={i}>
                            <td>
                              <select
                                className="otc-select otc-select--compact"
                                value={leg.role || ''}
                                onChange={(e) => {
                                  const legs = [...(detail.legs || [])]
                                  legs[i] = { ...legs[i], role: e.target.value || null }
                                  setDetail({ ...detail, legs })
                                }}
                              >
                                <option value="">—</option>
                                {legRoleOpts.map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                className="otc-select otc-select--compact"
                                value={leg.direction || ''}
                                onChange={(e) => {
                                  const legs = [...(detail.legs || [])]
                                  legs[i] = { ...legs[i], direction: e.target.value || null }
                                  setDetail({ ...detail, legs })
                                }}
                              >
                                {legDirOpts.map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <select
                                className="otc-select otc-select--compact"
                                value={leg.option_right ?? ''}
                                onChange={(e) => {
                                  const legs = [...(detail.legs || [])]
                                  legs[i] = {
                                    ...legs[i],
                                    option_right: e.target.value === '' ? null : e.target.value,
                                  }
                                  setDetail({ ...detail, legs })
                                }}
                              >
                                {legOrOpts.map((o) => (
                                  <option key={o.value === '' ? '_empty' : o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="otc-col-num">
                              <input
                                className="otc-input otc-input--compact otc-input--num"
                                type="number"
                                min={1}
                                value={leg.quantity ?? 1}
                                onChange={(e) => {
                                  const legs = [...(detail.legs || [])]
                                  legs[i] = { ...legs[i], quantity: parseInt(e.target.value, 10) || 1 }
                                  setDetail({ ...detail, legs })
                                }}
                              />
                            </td>
                            <td className="otc-col-action">
                              <button
                                type="button"
                                className="otc-row-delete"
                                title="Remove leg"
                                onClick={() => {
                                  const legs = [...(detail.legs || [])]
                                  legs.splice(i, 1)
                                  setDetail({ ...detail, legs })
                                }}
                              >
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ── Meta Parameters Card ── */}
              <div className="otc-card">
                <div className="otc-card-header">
                  <h3 className="otc-section-title">Meta Parameters</h3>
                  <div className="otc-card-header-actions">
                    {saveFeedback?.section === 'params' && (
                      <span className={`otc-save-feedback ${saveFeedback.ok ? 'ok' : 'err'}`}>
                        {saveFeedback.ok ? 'Saved' : 'Error'}
                      </span>
                    )}
                  </div>
                </div>
                <TemplateMetaEditor
                  detail={detail}
                  setDetail={setDetail}
                  paramKindOpts={paramKindOpts}
                  onSave={() => void saveParams()}
                />
              </div>

              {/* ── Characteristics Card ── */}
              <div className="otc-card">
                <div className="otc-card-header">
                  <h3 className="otc-section-title">Characteristics</h3>
                  <div className="otc-card-header-actions">
                    {saveFeedback?.section === 'chars' && (
                      <span className={`otc-save-feedback ${saveFeedback.ok ? 'ok' : 'err'}`}>
                        {saveFeedback.ok ? 'Saved' : 'Error'}
                      </span>
                    )}
                    <button type="button" className="otc-btn otc-btn-accent otc-btn-sm" onClick={() => void saveCharacteristics()}>
                      Save
                    </button>
                  </div>
                </div>
                <textarea
                  className="otc-textarea"
                  rows={5}
                  placeholder="One characteristic per line…"
                  value={(detail.characteristics || []).join('\n')}
                  onChange={(e) =>
                    setDetail({
                      ...detail,
                      characteristics: e.target.value.split('\n').filter(Boolean),
                    })
                  }
                />
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ───── Confirm Dialog ───── */}
      {confirmOpen && (
        <div className="otc-overlay" role="dialog" aria-modal="true" onClick={() => setConfirmOpen(false)}>
          <div className="otc-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="otc-dialog-icon otc-dialog-icon--danger">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <p className="otc-dialog-msg">{confirmMsg}</p>
            <div className="otc-dialog-actions">
              <button type="button" className="otc-btn otc-btn-ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="otc-btn otc-btn-danger"
                onClick={() => {
                  void confirmAction().then(() => setConfirmOpen(false))
                }}
              >
                Confirm delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───── Create Template Dialog ───── */}
      {createOpen && (
        <div className="otc-overlay" role="dialog" aria-modal="true" onClick={() => setCreateOpen(false)}>
          <div className="otc-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="otc-dialog-title">New Template</h3>
            <label className="otc-field">
              <span className="otc-field-label">Template code (snake_case)</span>
              <input className="otc-input" value={newTplCode} onChange={(e) => setNewTplCode(e.target.value)} autoFocus />
            </label>
            <label className="otc-field">
              <span className="otc-field-label">Display name</span>
              <input className="otc-input" value={newTplName} onChange={(e) => setNewTplName(e.target.value)} />
            </label>
            <div className="otc-dialog-actions">
              <button type="button" className="otc-btn otc-btn-ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button type="button" className="otc-btn otc-btn-accent" onClick={() => void openCreateTemplate()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───── Dimensions Dialog ───── */}
      {dimsOpen && (
        <div className="otc-overlay" role="dialog" aria-modal="true" onClick={() => setDimsOpen(false)}>
          <div className="otc-dialog otc-dialog--wide" onClick={(e) => e.stopPropagation()}>
            <div className="otc-dialog-header-row">
              <h3 className="otc-dialog-title">Manage Dimension Values</h3>
              <button type="button" className="otc-dialog-close" onClick={() => setDimsOpen(false)} aria-label="Close">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="otc-dims-grid">
              {DIM_TYPES.map((dt) => (
                <div key={dt} className="otc-dims-column">
                  <div className="otc-dims-column-header">
                    <span className="otc-dim-icon">{DIM_ICONS[dt]}</span>
                    <span>{DIM_LABELS[dt]}</span>
                  </div>
                  {(dimsByType[dt] || []).length === 0 ? (
                    <p className="otc-dims-empty">No values</p>
                  ) : (
                    <ul className="otc-dims-values">
                      {(dimsByType[dt] || []).map((row) => (
                        <li key={row.strategy_dim_id} className="otc-dims-value-row">
                          <code className="otc-dims-code">{row.code}</code>
                          <span className="otc-dims-label-text">{row.display_label}</span>
                          <button
                            type="button"
                            className="otc-row-delete"
                            title={`Delete ${row.code}`}
                            onClick={() => {
                              setConfirmMsg(`Delete dimension value "${row.code}"?`)
                              setConfirmAction(() => async () => {
                                await deleteDim(row.strategy_dim_id)
                                await loadDims()
                              })
                              setConfirmOpen(true)
                            }}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <div className="otc-dims-add-row">
              <select className="otc-select" value={newDimType} onChange={(e) => setNewDimType(e.target.value)}>
                {DIM_TYPES.map((dt) => (
                  <option key={dt} value={dt}>{DIM_LABELS[dt]}</option>
                ))}
              </select>
              <input className="otc-input" placeholder="code" value={newDimCode} onChange={(e) => setNewDimCode(e.target.value)} />
              <input className="otc-input" placeholder="label" value={newDimLabel} onChange={(e) => setNewDimLabel(e.target.value)} />
              <button type="button" className="otc-btn otc-btn-accent otc-btn-sm" onClick={() => void addDimRow()}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TemplateMetaEditor({
  detail,
  setDetail,
  paramKindOpts,
  onSave,
}: {
  detail: StrategyTemplateDetail
  setDetail: (d: StrategyTemplateDetail) => void
  paramKindOpts: StructureTypeConfigOption[]
  onSave: () => void
}) {
  const [metaKeyOpts, setMetaKeyOpts] = useState<StructureTypeConfigOption[]>([])
  const [valueOptsByKey, setValueOptsByKey] = useState<Record<string, StructureTypeConfigOption[]>>({})

  useEffect(() => {
    fetchMetaKeyOptions().then((r) => setMetaKeyOpts(r.options))
  }, [])

  const loadValues = async (metaKey: string) => {
    if (valueOptsByKey[metaKey]) return
    const r = await fetchMetaValueOptions('covered_call', metaKey)
    setValueOptsByKey((prev) => ({ ...prev, [metaKey]: r.options }))
  }

  return (
    <>
      {(detail.meta_params || []).length === 0 ? (
        <p className="otc-table-empty">No meta parameters defined.</p>
      ) : (
        <div className="otc-table-wrap">
          <table className="otc-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Default</th>
                <th>Kind</th>
                <th className="otc-col-action" />
              </tr>
            </thead>
            <tbody>
              {(detail.meta_params || []).map((p: MetaParamItem, i: number) => (
                <tr key={i}>
                  <td>
                    <select
                      className="otc-select otc-select--compact"
                      value={p.meta_key}
                      onChange={(e) => {
                        const mp = [...(detail.meta_params || [])]
                        mp[i] = { ...mp[i], meta_key: e.target.value }
                        setDetail({ ...detail, meta_params: mp })
                        void loadValues(e.target.value)
                      }}
                    >
                      {metaKeyOpts.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="otc-input otc-input--compact"
                      value={p.display_label || ''}
                      onChange={(e) => {
                        const mp = [...(detail.meta_params || [])]
                        mp[i] = { ...mp[i], display_label: e.target.value }
                        setDetail({ ...detail, meta_params: mp })
                      }}
                    />
                  </td>
                  <td>
                    {valueOptsByKey[p.meta_key]?.length ? (
                      <select
                        className="otc-select otc-select--compact"
                        value={p.default_value_text || ''}
                        onFocus={() => void loadValues(p.meta_key)}
                        onChange={(e) => {
                          const mp = [...(detail.meta_params || [])]
                          mp[i] = { ...mp[i], default_value_text: e.target.value }
                          setDetail({ ...detail, meta_params: mp })
                        }}
                      >
                        <option value="">—</option>
                        {(valueOptsByKey[p.meta_key] || []).map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="otc-input otc-input--compact"
                        value={p.default_value_text || ''}
                        onChange={(e) => {
                          const mp = [...(detail.meta_params || [])]
                          mp[i] = { ...mp[i], default_value_text: e.target.value }
                          setDetail({ ...detail, meta_params: mp })
                        }}
                      />
                    )}
                  </td>
                  <td>
                    <select
                      className="otc-select otc-select--compact"
                      value={p.param_kind || 'fixed'}
                      onChange={(e) => {
                        const mp = [...(detail.meta_params || [])]
                        mp[i] = { ...mp[i], param_kind: e.target.value }
                        setDetail({ ...detail, meta_params: mp })
                      }}
                    >
                      {paramKindOpts.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="otc-col-action">
                    <button
                      type="button"
                      className="otc-row-delete"
                      title="Remove parameter"
                      onClick={() => {
                        const mp = [...(detail.meta_params || [])]
                        mp.splice(i, 1)
                        setDetail({ ...detail, meta_params: mp })
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="otc-meta-actions">
        <button
          type="button"
          className="otc-btn otc-btn-ghost otc-btn-sm"
          onClick={() =>
            setDetail({
              ...detail,
              meta_params: [
                ...(detail.meta_params || []),
                { meta_key: 'otm_pct', display_label: 'OTM %', param_kind: 'percent', sort_order: 0 },
              ],
            })
          }
        >
          + Add parameter
        </button>
        <button type="button" className="otc-btn otc-btn-accent otc-btn-sm" onClick={onSave}>
          Save
        </button>
      </div>
    </>
  )
}
