import type { ReactNode } from 'react'
import { fmtDate } from '../../utils/format'
import { INSPECT_BARS_LIMIT_BY_PERIOD } from './constants'

export function inspectBarsLimitForPeriod(period: string): number {
  return INSPECT_BARS_LIMIT_BY_PERIOD[period] ?? 100
}

/** Unix sec or ms → UTC calendar YYYY-MM-DD (matches typical PG `extract(epoch from date)` at UTC midnight). */
export function epochToUtcIsoDate(ts: number): string {
  const sec = Number(ts)
  if (!Number.isFinite(sec)) return '—'
  const ms = sec > 1e12 ? sec : sec * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

/** Format stock_day YYYY-MM-DD for table display (calendar label, not derived from Unix epoch). */
function formatCoverageCalendarDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return iso
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10)
  const da = parseInt(m[3], 10)
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return iso
  return new Date(y, mo - 1, da).toLocaleDateString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

export type CoverageDailyDisplayOptions = {
  /** stock_day: use UTC calendar from epoch when min_day is absent (avoids local TZ −1 day on Range). */
  dailySessionDates?: boolean
}

function coverageCountNum(p: { count?: number | null }): number {
  const n = Number(p?.count)
  return Number.isFinite(n) ? n : 0
}

export function coverageCell(
  p: {
    count: number
    min_ts: number | null
    max_ts: number | null
    min_day?: string | null
    max_day?: string | null
  },
  options?: CoverageDailyDisplayOptions,
): string {
  if (coverageCountNum(p) === 0) return '—'
  const useUtc =
    Boolean(options?.dailySessionDates) && !(p.min_day && p.max_day)
  const cnt = coverageCountNum(p)
  const range =
    p.min_day && p.max_day
      ? `${formatCoverageCalendarDay(p.min_day)} ~ ${formatCoverageCalendarDay(p.max_day)}`
      : p.min_ts != null && p.max_ts != null
        ? useUtc
          ? `${formatCoverageCalendarDay(epochToUtcIsoDate(p.min_ts))} ~ ${formatCoverageCalendarDay(epochToUtcIsoDate(p.max_ts))}`
          : `${fmtDate(p.min_ts)} ~ ${fmtDate(p.max_ts)}`
        : ''
  return range ? `${cnt} bars (${range})` : `${cnt} bars`
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

/** stock_day calendar YYYY-MM-DD — same highlight behavior, no epoch/TZ shift. */
function CoverageCalendarDayLine({ iso, highlightDay }: { iso: string; highlightDay: boolean }) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) {
    return <span className="data-coverage-range-line">{iso}</span>
  }
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10)
  const da = parseInt(m[3], 10)
  const d = new Date(y, mo - 1, da)
  if (Number.isNaN(d.getTime())) {
    return <span className="data-coverage-range-line">—</span>
  }
  if (!highlightDay) {
    return <span className="data-coverage-range-line">{formatCoverageCalendarDay(iso)}</span>
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
export function coverageRange(
  p: {
    count: number
    min_ts: number | null
    max_ts: number | null
    min_day?: string | null
    max_day?: string | null
  },
  options?: CoverageDailyDisplayOptions,
): ReactNode {
  if (coverageCountNum(p) === 0) return '—'
  if (p.min_day && p.max_day) {
    return (
      <span className="data-coverage-range-stack">
        <span className="data-coverage-range-line">{formatCoverageCalendarDay(p.min_day)}</span>
        <CoverageCalendarDayLine iso={p.max_day} highlightDay />
      </span>
    )
  }
  const useUtc = Boolean(options?.dailySessionDates)
  if (p.min_ts == null && p.max_ts == null) return '—'
  if (p.min_ts != null && p.max_ts != null) {
    if (useUtc) {
      const minIso = epochToUtcIsoDate(p.min_ts)
      const maxIso = epochToUtcIsoDate(p.max_ts)
      return (
        <span className="data-coverage-range-stack">
          <span className="data-coverage-range-line">{formatCoverageCalendarDay(minIso)}</span>
          <CoverageCalendarDayLine iso={maxIso} highlightDay />
        </span>
      )
    }
    return (
      <span className="data-coverage-range-stack">
        <CoverageDateLine ts={p.min_ts} highlightDay={false} />
        <CoverageDateLine ts={p.max_ts} highlightDay />
      </span>
    )
  }
  if (p.min_ts != null) {
    if (useUtc) {
      const iso = epochToUtcIsoDate(p.min_ts)
      return (
        <span className="data-coverage-range-stack">
          <CoverageCalendarDayLine iso={iso} highlightDay />
          <span className="data-coverage-range-line">—</span>
        </span>
      )
    }
    return (
      <span className="data-coverage-range-stack">
        <CoverageDateLine ts={p.min_ts} highlightDay />
        <span className="data-coverage-range-line">—</span>
      </span>
    )
  }
  if (useUtc) {
    const iso = epochToUtcIsoDate(p.max_ts!)
    return (
      <span className="data-coverage-range-stack">
        <span className="data-coverage-range-line">—</span>
        <CoverageCalendarDayLine iso={iso} highlightDay />
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
  const cnt = coverageCountNum(p)
  if (cnt === 0) return '—'
  const showEnd = needPull && (isTradingDay !== false)
  if (!showEnd) return <>{cnt}</>
  return (
    <>
      {cnt}{' '}
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
