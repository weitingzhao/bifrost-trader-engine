/** Wall-clock instants in America/New_York for Massive Custom Bars presets (no external deps). */

const NY = 'America/New_York'

function nyYmdParts(utcMs: number): { ymd: string; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = f.formatToParts(new Date(utcMs))
  const y = parts.find((p) => p.type === 'year')?.value
  const mo = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '', 10)
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '', 10)
  const ymd = y && mo && d ? `${y}-${mo}-${d}` : ''
  return { ymd, hour: hh, minute: mm }
}

/** Find UTC ms where America/New_York shows `ymd` at `hour`:`minute` (first match in scan window). */
export function utcMsForNyWallClock(ymd: string, hour24: number, minute: number): number | null {
  const [Y, M, D] = ymd.split('-').map((s) => parseInt(s, 10))
  if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null
  const start = Date.UTC(Y, M - 1, D, 4, 0, 0) - 12 * 3600000
  const end = Date.UTC(Y, M - 1, D + 1, 8, 0, 0) + 12 * 3600000
  for (let ms = start; ms < end; ms += 60000) {
    const p = nyYmdParts(ms)
    if (p.ymd === ymd && p.hour === hour24 && p.minute === minute) return ms
  }
  return null
}

export function nyCalendarDateIso(nowMs: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  if (y && m && d) return `${y}-${m}-${d}`
  return new Date(nowMs).toISOString().slice(0, 10)
}

function previousNyCalendarDate(ymd: string): string {
  let ms = utcMsForNyWallClock(ymd, 12, 0)
  if (ms == null) return ymd
  const target = ymd
  ms -= 3600000
  let guard = 0
  while (nyCalendarDateIso(ms) === target && guard < 48) {
    ms -= 3600000
    guard++
  }
  return nyCalendarDateIso(ms)
}

function nextNyCalendarDate(ymd: string): string {
  let ms = utcMsForNyWallClock(ymd, 12, 0)
  if (ms == null) return ymd
  const start = nyCalendarDateIso(ms)
  ms += 3600000
  let guard = 0
  while (nyCalendarDateIso(ms) === start && guard < 48) {
    ms += 3600000
    guard++
  }
  return nyCalendarDateIso(ms)
}

/** Move a New York calendar date by `deltaDays` (Gregorian), hour-by-hour so DST is handled. */
export function addCalendarDaysNy(ymd: string, deltaDays: number): string {
  let cur = ymd
  const n = Math.abs(deltaDays)
  const forward = deltaDays >= 0
  for (let i = 0; i < n; i++) {
    cur = forward ? nextNyCalendarDate(cur) : previousNyCalendarDate(cur)
  }
  return cur
}

export interface CustomBarsWindow {
  startMs: number
  endMs: number
  /** Short English note for tooltips. */
  description: string
}

/** Fixed demo window: one regular session (09:30–16:00 ET) on 2024-06-03 — matches Feed Massive Stock default. */
export function presetRegularSessionDemo(): CustomBarsWindow {
  return {
    startMs: 1717421400000,
    endMs: 1717444800000,
    description: 'Single regular session (09:30–16:00 America/New_York) on 2024-06-03 — same default as Feed → Massive Stock → Custom Bars.',
  }
}

/** Regular session on the given NY calendar date. */
export function presetNyRegularSessionForDate(ymd: string): CustomBarsWindow | null {
  const open = utcMsForNyWallClock(ymd, 9, 30)
  const close = utcMsForNyWallClock(ymd, 16, 0)
  if (open == null || close == null) return null
  return {
    startMs: open,
    endMs: close,
    description: `Regular session (09:30–16:00 ET) on ${ymd} (America/New_York).`,
  }
}

/** From first NY calendar day through last NY calendar day (inclusive), regular session open on `startYmd` to close on `endYmd`. */
export function presetNyRegularSessionRange(startYmd: string, endYmd: string): CustomBarsWindow | null {
  const open = utcMsForNyWallClock(startYmd, 9, 30)
  const close = utcMsForNyWallClock(endYmd, 16, 0)
  if (open == null || close == null || open >= close) return null
  return {
    startMs: open,
    endMs: close,
    description: `America/New_York regular hours from ${startYmd} 09:30 through ${endYmd} 16:00.`,
  }
}
