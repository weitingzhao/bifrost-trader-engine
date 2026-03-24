import type { MassiveStatusResponse } from '../../api'
import checklistRows from '../massiveFeedChecklistRows'
import type { ChecklistRow, CapabilityGroup } from '../massiveFeedChecklistRows'
import { CAPABILITY_GROUP_ORDER } from '../massiveFeedChecklistRows'

/** Effective project status for a capability (tier may override trades). */
export type EffectiveServiceStatus = ChecklistRow['projectStatus'] | 'not-on-tier'

const TIER_RANK: Record<string, number> = { starter: 0, developer: 1, business: 2 }

export function tierOkForRow(
  row: ChecklistRow,
  massiveStatus: MassiveStatusResponse | null,
  configured: boolean,
): boolean {
  if (!massiveStatus || !configured) return false
  const actual = (massiveStatus.tier || 'starter').toLowerCase()
  return (TIER_RANK[actual] ?? 0) >= (TIER_RANK[row.tierMin] ?? 0)
}

export function tradesOkForRow(row: ChecklistRow, massiveStatus: MassiveStatusResponse | null): boolean {
  return !row.requiresTrades || Boolean(massiveStatus?.trades_enabled)
}

/** Tier-sensitive capabilities: trades-quotes gates on trades_enabled;
 *  fmv gates on Business tier. Legacy 'trades' id kept as fallback. */
export function effectiveChecklistProjectStatus(
  row: ChecklistRow,
  configured: boolean,
  tierOk: boolean,
  tradesOk: boolean,
): EffectiveServiceStatus {
  if (row.requiresTrades) {
    if (configured && (!tierOk || !tradesOk)) return 'not-on-tier'
    return row.projectStatus
  }
  if (row.id === 'trades-quotes' || row.id === 'trades') {
    if (configured && (!tierOk || !tradesOk)) return 'not-on-tier'
    return row.projectStatus
  }
  if (row.id === 'fmv') {
    if (configured && !tierOk) return 'not-on-tier'
    return row.projectStatus
  }
  return row.projectStatus
}

/** Sidebar `title-inline-lamp` color: Celery-style green / yellow / red, plus tier (link-colored). */
export type MassiveSidebarLamp = 'green' | 'yellow' | 'red' | 'tier'

export function effectiveStatusToSidebarLamp(eff: EffectiveServiceStatus): MassiveSidebarLamp {
  if (eff === 'implemented') return 'green'
  if (eff === 'partial') return 'yellow'
  if (eff === 'not-on-tier') return 'tier'
  return 'red'
}

export function massiveFeedParentLamp(massiveStatus: MassiveStatusResponse | null): 'green' | 'yellow' | 'red' {
  const configured = Boolean(massiveStatus?.configured)
  if (!configured) return 'red'
  const lamps = checklistRows.map(row => {
    const tierOk = tierOkForRow(row, massiveStatus, true)
    const tradesOk = tradesOkForRow(row, massiveStatus)
    const eff = effectiveChecklistProjectStatus(row, true, tierOk, tradesOk)
    return effectiveStatusToSidebarLamp(eff)
  })
  if (lamps.includes('red')) return 'red'
  if (lamps.includes('yellow') || lamps.includes('tier')) return 'yellow'
  return 'green'
}

export function shortServiceLabel(row: ChecklistRow): string {
  const s = row.service.trim()
  if (s.length <= 22) return s
  return `${s.slice(0, 20)}…`
}

export function checklistEffectiveStatusLabel(eff: EffectiveServiceStatus): string {
  if (eff === 'implemented') return 'Implemented'
  if (eff === 'partial') return 'Partial'
  if (eff === 'not-on-tier') return 'Not on tier'
  return 'Not implemented'
}

/** Group rows by CapabilityGroup in display order. */
export function groupedChecklistRows(): { group: CapabilityGroup; rows: ChecklistRow[] }[] {
  return CAPABILITY_GROUP_ORDER.map(g => ({
    group: g,
    rows: checklistRows.filter(r => r.group === g),
  })).filter(g => g.rows.length > 0)
}

export function capabilityGroupForRowId(rowId: string): CapabilityGroup | null {
  const row = checklistRows.find(r => r.id === rowId)
  return row?.group ?? null
}
