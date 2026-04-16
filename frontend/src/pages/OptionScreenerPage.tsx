import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import type { ScreenerFilters, ScreenerContractRow, ScreenerSymbolGroup, ScreenerResponse } from '../api/research/screener'
import { runScreener } from '../api/research/screener'
import type { StrategyStructure, OpportunityPayload, EntryConditionItem } from '../api/strategy/strategies'
import { fetchStructures, createOpportunity } from '../api/strategy/strategies'
import { SCREENER_STRUCTURE_TYPES } from './strategy/strategyFormUtils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OptionScreenerPageProps {
  status?: StatusResponse | null
  onGoToScreener?: () => void
  onOpenMassiveFeed?: () => void
  onOpenMassiveDelay?: () => void
  breadcrumbLabel?: string
}

// ---------------------------------------------------------------------------
// Filter enable/disable state
// ---------------------------------------------------------------------------

type FilterKey = 'dte' | 'max_prob_itm' | 'min_annualized_return' | 'max_spread_pct' | 'min_premium'

const DEFAULT_ENABLED: Record<FilterKey, boolean> = {
  dte: true,
  max_prob_itm: true,
  min_annualized_return: true,
  max_spread_pct: true,
  min_premium: false,
}

const LS_KEY_ENABLED = 'optionScreenerFiltersEnabled'

function loadFiltersEnabled(): Record<FilterKey, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY_ENABLED)
    if (raw) return { ...DEFAULT_ENABLED, ...JSON.parse(raw) } as Record<FilterKey, boolean>
  } catch { /* ignore */ }
  return { ...DEFAULT_ENABLED }
}

function saveFiltersEnabled(e: Record<FilterKey, boolean>): void {
  try { localStorage.setItem(LS_KEY_ENABLED, JSON.stringify(e)) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const LS_KEY = 'optionScreenerFilters'

const DEFAULT_FILTERS: ScreenerFilters = {
  structure_type: 'cash_secured_put',
  symbols: [],
  dte_min: 10,
  dte_max: 60,
  max_prob_itm: 0.30,
  min_annualized_return: 0.10,
  max_spread_pct: 0.30,
  include_earnings_span: false,
  min_premium: null,
  source: 'massive',
}

function loadFilters(): ScreenerFilters {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      return { ...DEFAULT_FILTERS, ...JSON.parse(raw) } as ScreenerFilters
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_FILTERS }
}

function saveFilters(f: ScreenerFilters): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmtPct(v: number | null | undefined, decimals = 1): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(decimals)}%`
}

function fmtNum(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

function ratingColor(rating: string): string {
  switch (rating) {
    case 'A': return '#22c55e'
    case 'B': return '#3b82f6'
    case 'C': return '#f59e0b'
    default: return '#ef4444'
  }
}

function riskColor(risk: string): string {
  switch (risk) {
    case 'low': return '#22c55e'
    case 'medium': return '#f59e0b'
    default: return '#ef4444'
  }
}

function scoreBar(score: number): string {
  // hue: 120 (green) → 0 (red) based on score 0–100
  const hue = Math.round((score / 100) * 120)
  return `hsl(${hue}, 70%, 45%)`
}

// ---------------------------------------------------------------------------
// DataSourcesPanel
// ---------------------------------------------------------------------------

interface DataSourcesPanelProps {
  result: ScreenerResponse | null
  onOpenMassiveFeed?: () => void
  onOpenMassiveDelay?: () => void
}

function DataSourcesPanel({ result, onOpenMassiveFeed, onOpenMassiveDelay }: DataSourcesPanelProps) {
  const hasWarnings = result != null && Object.keys(result.warnings).length > 0
  const [open, setOpen] = useState(true)

  // Auto-expand when warnings appear
  useEffect(() => {
    if (hasWarnings) setOpen(true)
  }, [hasWarnings])

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: 'none',
    background: active ? '#3b82f6' : 'rgba(255,255,255,0.08)',
    color: active ? '#fff' : '#a0aec0',
    fontWeight: active ? 600 : 400,
    whiteSpace: 'nowrap' as const,
  })

  const rows: { icon: string; table: string; desc: string; action?: () => void; actionLabel?: string; isAuto?: boolean }[] = [
    {
      icon: '⚡', table: 'option_contracts', desc: '到期日列表',
      action: onOpenMassiveFeed, actionLabel: 'Feed / Massive / Option',
    },
    {
      icon: '⚡', table: 'option_snapshots', desc: '报价快照（bid/ask/iv/delta）',
      action: onOpenMassiveFeed, actionLabel: 'Feed / Massive / Option',
    },
    {
      icon: '○', table: 'report_atm_iv_daily', desc: 'IV 历史百分位',
      isAuto: true,
    },
    {
      icon: '⚡', table: 'stock_day', desc: '现货价格',
      action: onOpenMassiveDelay, actionLabel: 'Coverage / Massive Delay',
    },
  ]

  return (
    <div style={{
      border: '1px solid var(--color-border, #2a3040)',
      borderRadius: 8, marginBottom: 18, overflow: 'hidden',
      background: 'var(--color-surface2, #252d3b)',
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '9px 16px', background: 'none', border: 'none',
          cursor: 'pointer', color: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: 0.5 }}>
          DATA SOURCES
        </span>
        {hasWarnings && (
          <span style={{
            background: 'rgba(245,158,11,0.2)', border: '1px solid rgba(245,158,11,0.4)',
            borderRadius: 4, padding: '1px 7px', fontSize: 11, color: '#fcd34d',
          }}>
            {Object.keys(result!.warnings).length} warning{Object.keys(result!.warnings).length !== 1 ? 's' : ''}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: '#4a5568' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--color-border, #2a3040)', padding: '10px 16px' }}>
          {rows.map(row => (
            <div key={row.table} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}>
              <span style={{ fontSize: 14, minWidth: 18, textAlign: 'center' }}>{row.icon}</span>
              <code style={{ fontSize: 12, color: '#93c5fd', minWidth: 200 }}>{row.table}</code>
              <span style={{ fontSize: 12, color: '#718096', flex: 1 }}>{row.desc}</span>
              {row.isAuto ? (
                <span style={{ fontSize: 11, color: '#4a5568', fontStyle: 'italic' }}>
                  ⓘ Celery 自动
                </span>
              ) : row.action ? (
                <button
                  type="button"
                  onClick={row.action}
                  style={btnStyle(hasWarnings)}
                >
                  → {row.actionLabel}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Save-as-Opportunity Modal
// ---------------------------------------------------------------------------

interface SaveModalProps {
  contract: ScreenerContractRow
  structureType: string
  onClose: () => void
}

function SaveOpportunityModal({ contract, structureType, onClose }: SaveModalProps) {
  const [structures, setStructures] = useState<StrategyStructure[]>([])
  const [structuresLoading, setStructuresLoading] = useState(true)
  const [selectedStructureId, setSelectedStructureId] = useState<number | ''>('')
  const [oppName, setOppName] = useState(
    `${contract.symbol} ${structureType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} ${contract.expiration}`
  )
  const [dteMin, setDteMin] = useState(String(Math.max(1, contract.dte - 5)))
  const [dteMax, setDteMax] = useState(String(contract.dte + 5))
  const [ivMin, setIvMin] = useState(
    contract.iv != null ? fmtNum(contract.iv * 0.8, 3) : ''
  )
  const [ivMax, setIvMax] = useState(
    contract.iv != null ? fmtNum(contract.iv * 1.2, 3) : ''
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<number | null>(null)

  useEffect(() => {
    fetchStructures(true)
      .then(r => {
        const filtered = r.items.filter(s => s.structure_type === structureType)
        setStructures(filtered)
        if (filtered.length === 1) setSelectedStructureId(filtered[0].strategy_structure_id)
      })
      .catch(() => setStructures([]))
      .finally(() => setStructuresLoading(false))
  }, [structureType])

  const handleSave = useCallback(async () => {
    if (!selectedStructureId) return
    setSaving(true)
    setSaveError(null)
    try {
      const conditions: EntryConditionItem[] = []
      const dteMinN = parseInt(dteMin, 10)
      const dteMaxN = parseInt(dteMax, 10)
      if (!isNaN(dteMinN)) conditions.push({ condition_type: 'dte_min', value_numeric: dteMinN })
      if (!isNaN(dteMaxN)) conditions.push({ condition_type: 'dte_max', value_numeric: dteMaxN })
      const ivMinN = parseFloat(ivMin)
      const ivMaxN = parseFloat(ivMax)
      if (!isNaN(ivMinN) && ivMin !== '') conditions.push({ condition_type: 'iv_min', value_numeric: ivMinN })
      if (!isNaN(ivMaxN) && ivMax !== '') conditions.push({ condition_type: 'iv_max', value_numeric: ivMaxN })

      const payload: OpportunityPayload = {
        name: oppName.trim() || `${contract.symbol} ${structureType}`,
        strategy_structure_id: selectedStructureId as number,
        scope_type: 'explicit_symbols',
        symbols: [contract.symbol],
        entry_conditions: conditions.length > 0 ? conditions : undefined,
        is_active: true,
      }
      const result = await createOpportunity(payload)
      setSavedId(result.strategy_opportunity_id)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [selectedStructureId, oppName, dteMin, dteMax, ivMin, ivMax, contract, structureType])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1050,
        background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--color-surface, #1e2430)',
        border: '1px solid var(--color-border, #2a3040)',
        borderRadius: 8, padding: '24px 28px', width: 480, maxWidth: '95vw',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <h5 style={{ marginBottom: 16, fontWeight: 600 }}>Save as Strategy Opportunity</h5>

        {/* Contract summary */}
        <div style={{
          background: 'var(--color-surface2, #252d3b)', borderRadius: 6,
          padding: '10px 14px', marginBottom: 18, fontSize: 13,
        }}>
          <strong>{contract.symbol}</strong>{' '}
          {contract.right === 'P' ? 'Put' : 'Call'}{' '}
          ${contract.strike} exp {contract.expiration} ({contract.dte}d)
          {' · '}
          <span style={{ color: ratingColor(contract.rating) }}>
            {contract.rating} {contract.score.toFixed(1)}
          </span>
          {contract.apr_pct != null && (
            <span style={{ color: '#a0aec0' }}> · {contract.apr_pct.toFixed(1)}% APR</span>
          )}
        </div>

        {/* Strategy Structure */}
        <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
          Strategy Structure
        </label>
        {structuresLoading ? (
          <div style={{ fontSize: 13, color: '#a0aec0', marginBottom: 14 }}>Loading structures…</div>
        ) : structures.length === 0 ? (
          <div style={{ fontSize: 13, color: '#f59e0b', marginBottom: 14 }}>
            No active {structureType.replace(/_/g, ' ')} structures found. Create one first.
          </div>
        ) : (
          <select
            value={selectedStructureId}
            onChange={e => setSelectedStructureId(e.target.value === '' ? '' : Number(e.target.value))}
            style={{
              width: '100%', marginBottom: 14, padding: '6px 10px',
              background: 'var(--color-surface2, #252d3b)',
              border: '1px solid var(--color-border, #2a3040)',
              borderRadius: 5, color: 'inherit', fontSize: 13,
            }}
          >
            <option value="">— select —</option>
            {structures.map(s => (
              <option key={s.strategy_structure_id} value={s.strategy_structure_id}>
                {s.name || s.structure_type}
              </option>
            ))}
          </select>
        )}

        {/* Name */}
        <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
          Opportunity Name
        </label>
        <input
          type="text"
          value={oppName}
          onChange={e => setOppName(e.target.value)}
          style={{
            width: '100%', marginBottom: 14, padding: '6px 10px',
            background: 'var(--color-surface2, #252d3b)',
            border: '1px solid var(--color-border, #2a3040)',
            borderRadius: 5, color: 'inherit', fontSize: 13,
          }}
        />

        {/* DTE conditions */}
        <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
          DTE Range (entry conditions)
        </label>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <input
            type="number"
            placeholder="DTE min"
            value={dteMin}
            onChange={e => setDteMin(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--color-surface2, #252d3b)',
              border: '1px solid var(--color-border, #2a3040)',
              borderRadius: 5, color: 'inherit', fontSize: 13,
            }}
          />
          <input
            type="number"
            placeholder="DTE max"
            value={dteMax}
            onChange={e => setDteMax(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--color-surface2, #252d3b)',
              border: '1px solid var(--color-border, #2a3040)',
              borderRadius: 5, color: 'inherit', fontSize: 13,
            }}
          />
        </div>

        {/* IV conditions */}
        <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
          IV Range (entry conditions)
          <span style={{ color: '#a0aec0', fontWeight: 400 }}> — contract IV ±20%, editable</span>
        </label>
        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <input
            type="text"
            placeholder="IV min (e.g. 0.20)"
            value={ivMin}
            onChange={e => setIvMin(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--color-surface2, #252d3b)',
              border: '1px solid var(--color-border, #2a3040)',
              borderRadius: 5, color: 'inherit', fontSize: 13,
            }}
          />
          <input
            type="text"
            placeholder="IV max (e.g. 0.50)"
            value={ivMax}
            onChange={e => setIvMax(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--color-surface2, #252d3b)',
              border: '1px solid var(--color-border, #2a3040)',
              borderRadius: 5, color: 'inherit', fontSize: 13,
            }}
          />
        </div>

        {/* Error / Success */}
        {saveError && (
          <div style={{
            background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444',
            borderRadius: 5, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#fca5a5',
          }}>
            {saveError}
          </div>
        )}
        {savedId != null && (
          <div style={{
            background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e',
            borderRadius: 5, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#86efac',
          }}>
            Saved as Opportunity #{savedId}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '7px 18px', borderRadius: 5, border: '1px solid var(--color-border, #2a3040)',
              background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13,
            }}
          >
            {savedId != null ? 'Close' : 'Cancel'}
          </button>
          {savedId == null && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !selectedStructureId || structures.length === 0}
              style={{
                padding: '7px 18px', borderRadius: 5, border: 'none',
                background: saving ? '#4a5568' : '#3b82f6',
                color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13,
              }}
            >
              {saving ? 'Saving…' : 'Save Opportunity'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Contract table for a single symbol group
// ---------------------------------------------------------------------------

interface ContractTableProps {
  contracts: ScreenerContractRow[]
  onSave: (c: ScreenerContractRow) => void
}

function ContractTable({ contracts, onSave }: ContractTableProps) {
  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-border, #2a3040)', color: '#a0aec0' }}>
            <th style={{ padding: '6px 8px', textAlign: 'left' }}>Strike</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>DTE</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Score</th>
            <th style={{ padding: '6px 8px', textAlign: 'center' }}>Rtg</th>
            <th style={{ padding: '6px 8px', textAlign: 'center' }}>Risk</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>IV</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>IV%ile</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Premium</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Prob ITM</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Margin</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>APR %</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Safety</th>
            <th style={{ padding: '6px 8px', textAlign: 'center' }}>OI</th>
            <th style={{ padding: '6px 8px', textAlign: 'center' }}></th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((c, i) => (
            <tr
              key={`${c.expiration}-${c.strike}-${i}`}
              style={{
                borderBottom: '1px solid var(--color-border, #1a2030)',
                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
              }}
            >
              <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>
                <span style={{ color: '#a0aec0', fontSize: 11 }}>{c.expiration.slice(4, 6)}/{c.expiration.slice(6)}</span>
                {' '}
                <strong>${c.strike.toFixed(0)}</strong>
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{c.dte}</td>
              <td style={{ padding: '5px 8px', textAlign: 'right' }}>
                <span style={{
                  display: 'inline-block', width: 32, height: 4, borderRadius: 2,
                  background: scoreBar(c.score), verticalAlign: 'middle', marginRight: 6,
                }} />
                <span style={{ fontFamily: 'monospace' }}>{c.score.toFixed(1)}</span>
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                <span style={{
                  display: 'inline-block', padding: '1px 7px', borderRadius: 4,
                  background: ratingColor(c.rating) + '33',
                  color: ratingColor(c.rating), fontWeight: 700, fontSize: 12,
                }}>
                  {c.rating}
                </span>
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                <span style={{
                  display: 'inline-block', padding: '1px 7px', borderRadius: 4,
                  background: riskColor(c.risk) + '22',
                  color: riskColor(c.risk), fontSize: 11,
                }}>
                  {c.risk}
                </span>
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                {c.iv != null ? fmtPct(c.iv) : '—'}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                {c.iv_percentile != null ? `${c.iv_percentile.toFixed(0)}th` : '—'}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                ${c.premium.toFixed(2)}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                {fmtPct(c.prob_itm)}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                ${(c.margin / 100).toFixed(0)}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', color: c.apr_pct != null && c.apr_pct > 50 ? '#22c55e' : 'inherit' }}>
                {c.apr_pct != null ? `${c.apr_pct.toFixed(1)}%` : '—'}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                {fmtPct(c.safety_margin)}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: '#a0aec0' }}>
                {c.open_interest != null ? c.open_interest.toLocaleString() : '—'}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                <button
                  type="button"
                  title="Save as Strategy Opportunity"
                  onClick={() => onSave(c)}
                  style={{
                    background: 'none', border: '1px solid var(--color-border, #2a3040)',
                    borderRadius: 4, cursor: 'pointer', padding: '2px 8px',
                    color: '#a0aec0', fontSize: 13,
                  }}
                >
                  ⊕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Symbol group row (collapsible)
// ---------------------------------------------------------------------------

interface GroupRowProps {
  group: ScreenerSymbolGroup
  onSave: (c: ScreenerContractRow) => void
}

function GroupRow({ group, onSave }: GroupRowProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div style={{
      border: '1px solid var(--color-border, #2a3040)',
      borderRadius: 7, marginBottom: 12, overflow: 'hidden',
    }}>
      {/* Group header */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 16,
          width: '100%', padding: '10px 16px',
          background: 'var(--color-surface2, #252d3b)',
          border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 700, minWidth: 56 }}>{group.symbol}</span>
        <span style={{ color: '#a0aec0', fontSize: 13 }}>
          ${group.spot.toFixed(2)}
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: ratingColor(
            group.best_score >= 75 ? 'A' : group.best_score >= 55 ? 'B' : group.best_score >= 35 ? 'C' : 'D'
          ) + '22',
          border: `1px solid ${ratingColor(
            group.best_score >= 75 ? 'A' : group.best_score >= 55 ? 'B' : group.best_score >= 35 ? 'C' : 'D'
          )}55`,
          borderRadius: 5, padding: '2px 10px', fontSize: 13,
          color: ratingColor(
            group.best_score >= 75 ? 'A' : group.best_score >= 55 ? 'B' : group.best_score >= 35 ? 'C' : 'D'
          ),
        }}>
          <strong>Best</strong> {group.best_score.toFixed(1)}
        </span>
        {group.avg_iv != null && (
          <span style={{ fontSize: 12, color: '#a0aec0' }}>
            Avg IV {fmtPct(group.avg_iv)}
          </span>
        )}
        <span style={{
          marginLeft: 'auto', fontSize: 12, color: '#a0aec0',
          background: 'rgba(255,255,255,0.07)', borderRadius: 4, padding: '2px 8px',
        }}>
          {group.contract_count} contracts
        </span>
        <span style={{ fontSize: 16, color: '#a0aec0', marginLeft: 8 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Contract table */}
      {expanded && (
        <div style={{ padding: '0 16px 12px' }}>
          <ContractTable contracts={group.contracts} onSave={onSave} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter row with checkbox toggle
// ---------------------------------------------------------------------------

interface FilterRowProps {
  enabled: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}

function FilterRow({ enabled, onToggle, label, children }: FilterRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          paddingTop: 20, flexShrink: 0,
        }}
        title={enabled ? `Disable ${label} filter` : `Enable ${label} filter`}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          style={{ accentColor: '#3b82f6', width: 14, height: 14, cursor: 'pointer' }}
        />
      </label>
      <div style={{ flex: 1, opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none', transition: 'opacity 0.15s' }}>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function OptionScreenerPage({
  onGoToScreener,
  onOpenMassiveFeed,
  onOpenMassiveDelay,
  breadcrumbLabel = 'Screener',
}: OptionScreenerPageProps) {
  const [filters, setFilters] = useState<ScreenerFilters>(loadFilters)
  const [filtersEnabled, setFiltersEnabled] = useState<Record<FilterKey, boolean>>(loadFiltersEnabled)
  const [symbolsInput, setSymbolsInput] = useState(() => loadFilters().symbols.join(', '))
  const [result, setResult] = useState<ScreenerResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveModal, setSaveModal] = useState<{ open: boolean; contract: ScreenerContractRow | null }>({
    open: false,
    contract: null,
  })

  // Persist filter changes
  useEffect(() => { saveFilters(filters) }, [filters])
  useEffect(() => { saveFiltersEnabled(filtersEnabled) }, [filtersEnabled])

  const updateFilter = useCallback(<K extends keyof ScreenerFilters>(key: K, value: ScreenerFilters[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }, [])

  const toggleFilter = useCallback((key: FilterKey) => {
    setFiltersEnabled(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const parseSymbols = useCallback((): string[] => {
    return symbolsInput
      .split(/[,\s\n]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
  }, [symbolsInput])

  const handleRun = useCallback(async () => {
    const syms = parseSymbols()
    if (syms.length === 0) {
      setError('Enter at least one symbol.')
      return
    }
    // Build merged filters: disabled fields sent as null
    const merged: ScreenerFilters = {
      ...filters,
      symbols: syms,
      dte_min: filtersEnabled.dte ? filters.dte_min : null,
      dte_max: filtersEnabled.dte ? filters.dte_max : null,
      max_prob_itm: filtersEnabled.max_prob_itm ? filters.max_prob_itm : null,
      min_annualized_return: filtersEnabled.min_annualized_return ? filters.min_annualized_return : null,
      max_spread_pct: filtersEnabled.max_spread_pct ? filters.max_spread_pct : null,
      min_premium: filtersEnabled.min_premium ? filters.min_premium : null,
    }
    setFilters(prev => ({ ...prev, symbols: syms }))
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await runScreener(merged)
      setResult(res)
      if (!res.ok && res.error) {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Screener request failed')
    } finally {
      setLoading(false)
    }
  }, [filters, filtersEnabled, parseSymbols])

  const handleSave = useCallback((contract: ScreenerContractRow) => {
    setSaveModal({ open: true, contract })
  }, [])

  const handleModalClose = useCallback(() => {
    setSaveModal({ open: false, contract: null })
  }, [])

  // Display values for disabled filters (show stored value but greyed)
  const dteMinDisplay = filters.dte_min ?? 10
  const dteMaxDisplay = filters.dte_max ?? 60
  const maxProbItmDisplay = filters.max_prob_itm ?? 0.30
  const minAnnualReturnDisplay = filters.min_annualized_return ?? 0.10
  const maxSpreadDisplay = filters.max_spread_pct ?? 0.30
  const minPremiumDisplay = filters.min_premium ?? 0

  return (
    <div className="card process-section" style={{ maxWidth: 1280 }}>
      {/* Page title */}
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        {onGoToScreener ? (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={onGoToScreener}
              aria-label="Go to Research"
            >
              Research
            </button>
            {' / '}
            {breadcrumbLabel}
            {' '}
          </>
        ) : (
          <>Option Screener{' '}</>
        )}
      </h2>
      <p className="section-hint" style={{ marginBottom: 16 }}>
        Screen option contracts by strategy structure and scoring criteria. Data from Massive sync (option_snapshots + report_option_atm_iv_daily).
      </p>

      {/* ----------------------------------------------------------------- */}
      {/* Data Sources Panel                                                 */}
      {/* ----------------------------------------------------------------- */}
      <DataSourcesPanel
        result={result}
        onOpenMassiveFeed={onOpenMassiveFeed}
        onOpenMassiveDelay={onOpenMassiveDelay}
      />

      {/* ----------------------------------------------------------------- */}
      {/* Filter Panel                                                       */}
      {/* ----------------------------------------------------------------- */}
      <section
        style={{
          background: 'var(--color-surface2, #252d3b)',
          border: '1px solid var(--color-border, #2a3040)',
          borderRadius: 8, padding: '18px 20px', marginBottom: 24,
        }}
      >
        {/* Strategy type */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#a0aec0', marginBottom: 6 }}>
            Strategy Type
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SCREENER_STRUCTURE_TYPES.map(st => {
              const isActive = filters.structure_type === st.value
              const isEnabled = st.value === 'cash_secured_put'
              return (
                <button
                  key={st.value}
                  type="button"
                  disabled={!isEnabled}
                  onClick={() => isEnabled && updateFilter('structure_type', st.value)}
                  title={isEnabled ? st.label : `${st.label} — coming in V2`}
                  style={{
                    padding: '5px 14px', borderRadius: 5, fontSize: 13,
                    border: isActive
                      ? '1px solid #3b82f6'
                      : '1px solid var(--color-border, #2a3040)',
                    background: isActive ? 'rgba(59,130,246,0.2)' : 'transparent',
                    color: isEnabled ? (isActive ? '#93c5fd' : 'inherit') : '#4a5568',
                    cursor: isEnabled ? 'pointer' : 'not-allowed',
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  {st.label}
                  {!isEnabled && <span style={{ marginLeft: 4, fontSize: 10 }}>V2</span>}
                </button>
              )
            })}
          </div>
        </div>

        {/* Symbols row */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
            Symbols (comma or space separated)
          </label>
          <input
            type="text"
            placeholder="AAPL, NVDA, TSLA"
            value={symbolsInput}
            onChange={e => setSymbolsInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRun() }}
            style={{
              width: '100%', padding: '7px 11px',
              background: 'var(--color-surface, #1e2430)',
              border: '1px solid var(--color-border, #2a3040)',
              borderRadius: 5, color: 'inherit', fontSize: 13,
            }}
          />
        </div>

        {/* DTE row with checkbox */}
        <div style={{ marginBottom: 16 }}>
          <FilterRow enabled={filtersEnabled.dte} onToggle={() => toggleFilter('dte')} label="DTE">
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
                  DTE Min
                </label>
                <input
                  type="number"
                  min={1} max={365}
                  value={dteMinDisplay}
                  onChange={e => updateFilter('dte_min', Number(e.target.value))}
                  style={{
                    width: 72, padding: '7px 8px',
                    background: 'var(--color-surface, #1e2430)',
                    border: '1px solid var(--color-border, #2a3040)',
                    borderRadius: 5, color: 'inherit', fontSize: 13,
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
                  DTE Max
                </label>
                <input
                  type="number"
                  min={1} max={365}
                  value={dteMaxDisplay}
                  onChange={e => updateFilter('dte_max', Number(e.target.value))}
                  style={{
                    width: 72, padding: '7px 8px',
                    background: 'var(--color-surface, #1e2430)',
                    border: '1px solid var(--color-border, #2a3040)',
                    borderRadius: 5, color: 'inherit', fontSize: 13,
                  }}
                />
              </div>
              {!filtersEnabled.dte && (
                <span style={{ fontSize: 11, color: '#4a5568', paddingBottom: 10, fontStyle: 'italic' }}>
                  disabled — all expirations included
                </span>
              )}
            </div>
          </FilterRow>
        </div>

        {/* Sliders row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 16 }}>
          {/* Prob ITM max */}
          <FilterRow enabled={filtersEnabled.max_prob_itm} onToggle={() => toggleFilter('max_prob_itm')} label="Max Prob ITM">
            <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
              <span>Max Prob ITM</span>
              <span style={{ color: filtersEnabled.max_prob_itm ? '#e2e8f0' : '#4a5568' }}>
                {filtersEnabled.max_prob_itm ? `${(maxProbItmDisplay * 100).toFixed(0)}%` : 'off'}
              </span>
            </label>
            <input
              type="range" min={1} max={50} step={1}
              value={Math.round(maxProbItmDisplay * 100)}
              onChange={e => updateFilter('max_prob_itm', Number(e.target.value) / 100)}
              style={{ width: '100%' }}
            />
          </FilterRow>

          {/* Min annualized return */}
          <FilterRow enabled={filtersEnabled.min_annualized_return} onToggle={() => toggleFilter('min_annualized_return')} label="Min Annual Return">
            <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
              <span>Min Annual Return</span>
              <span style={{ color: filtersEnabled.min_annualized_return ? '#e2e8f0' : '#4a5568' }}>
                {filtersEnabled.min_annualized_return ? `${(minAnnualReturnDisplay * 100).toFixed(0)}%` : 'off'}
              </span>
            </label>
            <input
              type="range" min={0} max={150} step={5}
              value={Math.round(minAnnualReturnDisplay * 100)}
              onChange={e => updateFilter('min_annualized_return', Number(e.target.value) / 100)}
              style={{ width: '100%' }}
            />
          </FilterRow>

          {/* Max spread pct */}
          <FilterRow enabled={filtersEnabled.max_spread_pct} onToggle={() => toggleFilter('max_spread_pct')} label="Max Spread %">
            <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
              <span>Max Spread %</span>
              <span style={{ color: filtersEnabled.max_spread_pct ? '#e2e8f0' : '#4a5568' }}>
                {filtersEnabled.max_spread_pct ? `${(maxSpreadDisplay * 100).toFixed(0)}%` : 'off'}
              </span>
            </label>
            <input
              type="range" min={1} max={100} step={1}
              value={Math.round(maxSpreadDisplay * 100)}
              onChange={e => updateFilter('max_spread_pct', Number(e.target.value) / 100)}
              style={{ width: '100%' }}
            />
          </FilterRow>
        </div>

        {/* Min premium + earnings + run */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20 }}>
          <FilterRow enabled={filtersEnabled.min_premium} onToggle={() => toggleFilter('min_premium')} label="Min Premium">
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a0aec0', marginBottom: 4 }}>
                Min Premium ($)
              </label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={minPremiumDisplay}
                onChange={e => updateFilter('min_premium', Number(e.target.value))}
                style={{
                  width: 90, padding: '7px 8px',
                  background: 'var(--color-surface, #1e2430)',
                  border: '1px solid var(--color-border, #2a3040)',
                  borderRadius: 5, color: 'inherit', fontSize: 13,
                }}
              />
            </div>
          </FilterRow>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', paddingBottom: 2 }}>
            <input
              type="checkbox"
              checked={filters.include_earnings_span}
              onChange={e => updateFilter('include_earnings_span', e.target.checked)}
            />
            Include earnings span
          </label>

          <div style={{ flex: 1 }} />

          <button
            type="button"
            onClick={handleRun}
            disabled={loading}
            style={{
              padding: '8px 24px', borderRadius: 6,
              background: loading ? '#374151' : '#3b82f6',
              border: 'none', color: '#fff',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 14, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            {loading ? (
              <>
                <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Scanning…
              </>
            ) : 'Run Screener'}
          </button>
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Error                                                              */}
      {/* ----------------------------------------------------------------- */}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: 6, padding: '10px 16px', marginBottom: 18,
          fontSize: 13, color: '#fca5a5',
        }}>
          {error}
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Results summary                                                    */}
      {/* ----------------------------------------------------------------- */}
      {result && result.ok && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            marginBottom: 16,
          }}>
            <span style={{ fontSize: 13, color: '#a0aec0' }}>
              {result.total_contracts} contract{result.total_contracts !== 1 ? 's' : ''}
              {' across '}
              {result.groups.length} symbol{result.groups.length !== 1 ? 's' : ''}
              {result.groups.length > 0 && (
                <> · best score <strong style={{ color: '#e2e8f0' }}>{result.groups[0].best_score.toFixed(1)}</strong></>
              )}
            </span>
            <span style={{ color: '#4a5568', fontSize: 12 }}>
              {result.scan_ts}
            </span>
          </div>

          {/* Warnings */}
          {Object.keys(result.warnings).length > 0 && (
            <div style={{
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
              borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12,
            }}>
              {Object.entries(result.warnings).map(([sym, msg]) => (
                <div key={sym} style={{ color: '#fcd34d' }}>
                  <strong>{sym}:</strong> {msg}
                </div>
              ))}
            </div>
          )}

          {/* No results */}
          {result.groups.length === 0 && (
            <div style={{ color: '#a0aec0', fontSize: 13, padding: '20px 0' }}>
              No contracts matched the current filters. Try disabling some filter checkboxes, widening the DTE range, raising Max Prob ITM, or lowering Min Annual Return.
            </div>
          )}

          {/* Group rows */}
          {result.groups.map(group => (
            <GroupRow
              key={group.symbol}
              group={group}
              onSave={handleSave}
            />
          ))}
        </>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Save Modal                                                         */}
      {/* ----------------------------------------------------------------- */}
      {saveModal.open && saveModal.contract && (
        <SaveOpportunityModal
          contract={saveModal.contract}
          structureType={filters.structure_type}
          onClose={handleModalClose}
        />
      )}

      {/* Spinner keyframe */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
