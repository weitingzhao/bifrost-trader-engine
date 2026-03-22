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

const COVERAGE_DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}

function toCoverageDate(ts: number): Date {
  const sec = Number(ts)
  return new Date(Number.isFinite(sec) ? (sec > 1e12 ? sec : sec * 1000) : NaN)
}

/** One date line; when `highlightDay`, only the calendar day digits are emphasized (latest end in range). */
function CoverageDateLine({ ts, highlightDay }: { ts: number; highlightDay: boolean }) {
  const d = toCoverageDate(ts)
  if (Number.isNaN(d.getTime())) {
    return <span className="data-coverage-range-line">—</span>
  }
  if (!highlightDay) {
    return <span className="data-coverage-range-line">{fmtDate(ts)}</span>
  }
  const parts = new Intl.DateTimeFormat(undefined, COVERAGE_DATE_FMT).formatToParts(d)
  return (
    <span className="data-coverage-range-line">
      {parts.map((part, i) =>
        part.type === 'day' ? (
          <span key={i} className="data-coverage-range-day-highlight">
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </span>
  )
}

/** Range column: two lines (start / end) to keep column narrow vs one long "a ~ b" row. */
export function coverageRange(p: { count: number; min_ts: number | null; max_ts: number | null }): ReactNode {
  if (p.count === 0 || (p.min_ts == null && p.max_ts == null)) return '—'
  if (p.min_ts != null && p.max_ts != null) {
    return (
      <span className="data-coverage-range-stack">
        <CoverageDateLine ts={p.min_ts} highlightDay={false} />
        <CoverageDateLine ts={p.max_ts} highlightDay />
      </span>
    )
  }
  if (p.min_ts != null) {
    return (
      <span className="data-coverage-range-stack">
        <CoverageDateLine ts={p.min_ts} highlightDay />
        <span className="data-coverage-range-line">—</span>
      </span>
    )
  }
  return (
    <span className="data-coverage-range-stack">
      <span className="data-coverage-range-line">—</span>
      <CoverageDateLine ts={p.max_ts!} highlightDay />
    </span>
  )
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
