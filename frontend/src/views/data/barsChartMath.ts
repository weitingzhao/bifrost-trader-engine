import type { Bar } from '../../types'

/** Coerce API / JSON values to finite numbers for chart math. */
export function toF(x: unknown): number {
  if (x == null || x === '') return NaN
  if (typeof x === 'number') return Number.isFinite(x) ? x : NaN
  const n = Number(x)
  return Number.isFinite(n) ? n : NaN
}

export function normalizeBarForChart(b: Bar): Bar | null {
  const time = toF(b.time)
  const open = toF(b.open)
  const high = toF(b.high)
  const low = toF(b.low)
  const close = toF(b.close)
  if (!Number.isFinite(time)) return null
  const out: Bar = { time, open, high, low, close }
  const vol = b.volume != null ? toF(b.volume) : NaN
  if (Number.isFinite(vol)) out.volume = vol
  if (b.vwap != null) {
    const vw = toF(b.vwap)
    if (Number.isFinite(vw)) out.vwap = vw
  }
  return out
}

/** EMA where the first value is SMA of first `span` closes (all must be finite). */
export function emaSeries(closes: number[], span: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null)
  if (span <= 0 || closes.length < span) return out
  const alpha = 2 / (span + 1)
  let s = 0
  for (let i = 0; i < span; i++) {
    if (!Number.isFinite(closes[i])) return closes.map(() => null)
    s += closes[i]
  }
  let e = s / span
  out[span - 1] = e
  for (let i = span; i < closes.length; i++) {
    const c = closes[i]
    if (!Number.isFinite(c)) continue
    e = alpha * c + (1 - alpha) * e
    out[i] = e
  }
  return out
}

export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const n = closes.length
  const out: (number | null)[] = Array(n).fill(null)
  if (n < period + 1 || period <= 0) return out
  let avgG = 0
  let avgL = 0
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1]
    if (ch >= 0) avgG += ch
    else avgL -= ch
  }
  avgG /= period
  avgL /= period
  const rsiAt = () => {
    if (avgL === 0) return avgG === 0 ? 50 : 100
    return 100 - 100 / (1 + avgG / avgL)
  }
  out[period] = rsiAt()
  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1]
    const g = ch > 0 ? ch : 0
    const l = ch < 0 ? -ch : 0
    avgG = (avgG * (period - 1) + g) / period
    avgL = (avgL * (period - 1) + l) / period
    out[i] = rsiAt()
  }
  return out
}

export interface MacdPoint {
  macd: number | null
  signal: number | null
  hist: number | null
}

export function macdSeries(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  const ef = emaSeries(closes, fast)
  const es = emaSeries(closes, slow)
  const n = closes.length
  const macdArr: (number | null)[] = Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const a = ef[i]
    const b = es[i]
    if (a != null && b != null) macdArr[i] = a - b
  }
  const first = macdArr.findIndex(x => x != null)
  const sigArr: (number | null)[] = Array(n).fill(null)
  if (first >= 0) {
    const segment = macdArr.slice(first).map(x => (x == null ? NaN : x)) as number[]
    const segSig = emaSeries(segment, signalPeriod)
    for (let j = 0; j < segSig.length; j++) sigArr[first + j] = segSig[j]
  }
  return closes.map((_, i) => {
    const m = macdArr[i]
    const s = sigArr[i]
    if (m == null || s == null) return { macd: null, signal: null, hist: null }
    return { macd: m, signal: s, hist: m - s }
  })
}

export interface BollingerPoint {
  mid: number | null
  upper: number | null
  lower: number | null
}

export function bollingerSeries(closes: number[], period = 20, mult = 2): BollingerPoint[] {
  const n = closes.length
  const out: BollingerPoint[] = closes.map(() => ({ mid: null, upper: null, lower: null }))
  for (let i = period - 1; i < n; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    if (slice.some(x => !Number.isFinite(x))) continue
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const var_ = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period
    const sd = Math.sqrt(var_)
    out[i] = {
      mid: mean,
      upper: mean + mult * sd,
      lower: mean - mult * sd,
    }
  }
  return out
}

/** Classic pivot from one bar's H/L/C (previous session). */
export function pivotLevelsFromHlc(high: number, low: number, close: number): {
  p: number
  r1: number
  s1: number
  r2: number
  s2: number
} | null {
  if (![high, low, close].every(Number.isFinite)) return null
  const p = (high + low + close) / 3
  const r1 = 2 * p - low
  const s1 = 2 * p - high
  const r2 = p + (high - low)
  const s2 = p - (high - low)
  return { p, r1, s1, r2, s2 }
}

/** Recent-window swing high / low. */
export function swingHighLow(highs: number[], lows: number[], lookback: number): { resistance: number; support: number } | null {
  const n = highs.length
  if (n === 0) return null
  const w = Math.max(3, Math.min(lookback, n))
  const hi = highs.slice(-w)
  const lo = lows.slice(-w)
  if (hi.some(x => !Number.isFinite(x)) || lo.some(x => !Number.isFinite(x))) return null
  return { resistance: Math.max(...hi), support: Math.min(...lo) }
}
