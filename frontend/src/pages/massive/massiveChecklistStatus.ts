import type { MassiveStatusResponse } from '../../api'
import checklistRows from '../massiveFeedChecklistRows'
import type { ChecklistRow } from '../massiveFeedChecklistRows'

/** Effective project status for a capability (tier may override trades). */
export type EffectiveServiceStatus = ChecklistRow['projectStatus'] | 'not-on-tier'

export function tierOkForRow(
  row: ChecklistRow,
  massiveStatus: MassiveStatusResponse | null,
  configured: boolean,
): boolean {
  if (!massiveStatus || !configured) return false
  return row.tierMin === 'starter' ? true : (massiveStatus.tier || '').toLowerCase() === 'developer'
}

export function tradesOkForRow(row: ChecklistRow, massiveStatus: MassiveStatusResponse | null): boolean {
  return !row.requiresTrades || Boolean(massiveStatus?.trades_enabled)
}

/** Option trades: when Massive tier / trades_enabled disallow API, show tier — not "not implemented". */
export function effectiveChecklistProjectStatus(
  row: ChecklistRow,
  configured: boolean,
  tierOk: boolean,
  tradesOk: boolean,
): EffectiveServiceStatus {
  if (row.id !== 'trades') return row.projectStatus
  if (configured && (!tierOk || !tradesOk)) return 'not-on-tier'
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
