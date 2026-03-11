import type { ReactNode } from 'react'
import { fmtDate } from '../../utils/format'
import { INSPECT_BARS_LIMIT_BY_PERIOD } from './constants'

export function inspectBarsLimitForPeriod(period: string): number {
  return INSPECT_BARS_LIMIT_BY_PERIOD[period] ?? 100
}

export function coverageCell(p: { count: number; min_ts: number | null; max_ts: number | null }): string {
  if (p.count === 0) return '—'
  const range = p.min_ts != null && p.max_ts != null ? `${fmtDate(p.min_ts)} ~ ${fmtDate(p.max_ts)}` : ''
  return range ? `${p.count} bars (${range})` : `${p.count} bars`
}

export function coverageRange(p: { count: number; min_ts: number | null; max_ts: number | null }): string {
  if (p.count === 0 || (p.min_ts == null && p.max_ts == null)) return '—'
  if (p.min_ts != null && p.max_ts != null) return `${fmtDate(p.min_ts)} ~ ${fmtDate(p.max_ts)}`
  if (p.min_ts != null) return fmtDate(p.min_ts) + ' ~ —'
  return '— ~ ' + fmtDate(p.max_ts!)
}

/** Bars column: show count only, or count + (end) when needPull and trading day. */
export function coverageCompact(
  p: { count: number; min_ts: number | null; max_ts: number | null },
  needPull: boolean,
  isTradingDay: boolean | null,
): ReactNode {
  if (p.count === 0) return '—'
  const showEnd = needPull && (isTradingDay !== false)
  if (!showEnd) return <>{p.count}</>
  return (
    <>
      {p.count}{' '}
      <span className="data-coverage-end-warning">(end)</span>
    </>
  )
}

export function coverageStatusDisplay(status: string | undefined): { label: string; needBackfill: boolean; severity: 'ok' | 'gap' | 'missing' } {
  switch (status) {
    case 'ok':
      return { label: 'OK', needBackfill: false, severity: 'ok' }
    case 'missing':
      return { label: 'Missing', needBackfill: true, severity: 'missing' }
    case 'gap_start':
      return { label: 'Gap (start)', needBackfill: true, severity: 'gap' }
    case 'gap_end':
      return { label: 'Gap (end)', needBackfill: true, severity: 'gap' }
    case 'gap':
      return { label: 'Gap', needBackfill: true, severity: 'gap' }
    default:
      return { label: '', needBackfill: false, severity: 'ok' }
  }
}
