import type { Execution } from '../../types'
import type { BackendOptPair } from '../../types'

export function optionRightToFull(r: string | null | undefined): string {
  if (r == null || String(r).trim() === '') return '—'
  const s = String(r).trim().toUpperCase()
  if (s === 'C' || s === 'CALL') return 'CALL'
  if (s === 'P' || s === 'PUT') return 'PUT'
  return s
}

export function normalizeStrike(s: string | number | null | undefined): string {
  if (s == null || s === '') return ''
  const n = Number(s)
  return Number.isFinite(n) ? String(n) : String(s).trim()
}

export function sortExecByTradeDateThenTime(a: Execution, b: Execution): number {
  const da = (a.trade_date ?? '').trim()
  const db = (b.trade_date ?? '').trim()
  if (da !== db) return da.localeCompare(db)
  return (a.time ?? 0) - (b.time ?? 0)
}

/** Sort by Flex trade_date if present, else Chicago exec date (for TWS-only rows without trade_date). */
export function sortExecByExecutionDateThenTime(a: Execution, b: Execution): number {
  const da = executionDateStr(a)
  const db = executionDateStr(b)
  if (da !== db) return da.localeCompare(db)
  const ta = a.time ?? 0
  const tb = b.time ?? 0
  if (ta !== tb) return ta - tb
  const ia = a.account_executions_id ?? 0
  const ib = b.account_executions_id ?? 0
  return ia - ib
}

/** Signed cash flow for one option leg — same base as Trade Ledger Options Details (per execution). */
export function ledgerOptionExecutionCashFlowSigned(e: Execution): number {
  const s = (e.side ?? '').toUpperCase()
  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
  const q = Math.abs(Number(e.quantity) || 0)
  const p = Number(e.price) || 0
  const c = Number(e.commission) || 0
  const value = q * p * 100 - c
  return isBuy ? -value : value
}

/** Per-row display PnL (ledger Details table): Sell uses abs for display. */
export function ledgerOptionExecutionDisplayPnl(e: Execution): number {
  const s = (e.side ?? '').toUpperCase()
  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
  const isSell = s === 'SELL' || s === 'SLD' || s === 'S'
  const raw = ledgerOptionExecutionCashFlowSigned(e)
  if (isSell) return Math.abs(raw)
  if (isBuy) return raw
  return raw
}

export function execPnl(e: Execution): number {
  const qty = Number(e.quantity) || 0
  const price = Number(e.price) || 0
  const commission = Number(e.commission) || 0
  const pnl = qty * price * 100 - commission
  return Number.isFinite(pnl) ? pnl : 0
}

/** CSS tone for per-leg PnL cell: BUY = outflow (red), SELL = inflow (green); matches ledger intuition. */
export function executionLegPnlToneClass(e: Execution, ep: number): string {
  if (Math.abs(ep) < 0.005) return ''
  const s = (e.side ?? '').toString().trim().toUpperCase()
  if (s === 'BUY' || s === 'BOT' || s === 'B') return 'tone-negative'
  if (s === 'SELL' || s === 'SLD' || s === 'S') return 'tone-positive'
  return ep >= 0 ? 'tone-positive' : 'tone-negative'
}

/**
 * On-the-fly STK row: per-fill “Unrealized PnL” column = quantity × price (no multiplier).
 * Sign: BUY positive, SELL negative — differs from OPT leg cash-flow display.
 */
export function stockOnTheFlyUnrealizedPnlLeg(e: Execution): number | null {
  if ((e.sec_type ?? '').toUpperCase() !== 'STK') return null
  const q = Math.abs(Number(e.quantity) || 0)
  const p = Number(e.price) || 0
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) return null
  const s = (e.side ?? '').toString().trim().toUpperCase()
  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
  const isSell = s === 'SELL' || s === 'SLD' || s === 'S'
  const gross = q * p
  if (isBuy) return gross
  if (isSell) return -gross
  return gross
}

export function matchPnl(p: { quantity: number; c_side: string; p_side: string; c_price: number; p_price: number; commission: number }): number {
  const qty = Number(p.quantity) || 0
  const cPrice = Number(p.c_price) || 0
  const pPrice = Number(p.p_price) || 0
  const commission = Number(p.commission) || 0
  const sideC = (p.c_side ?? '').toString().trim().toUpperCase()
  const sideP = (p.p_side ?? '').toString().trim().toUpperCase()
  const halfComm = commission / 2
  const legC = qty * cPrice * 100 + halfComm
  const legP = qty * pPrice * 100 + halfComm
  const pnlC = sideC === 'BUY' ? legC : -legC
  const pnlP = sideP === 'BUY' ? legP : -legP
  const pnl = pnlC + pnlP
  return Number.isFinite(pnl) ? pnl : 0
}

export function getChicagoDayRange(dateStr: string): { since_ts: number; until_ts: number } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = formatter.formatToParts(new Date(utcNoon))
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '12', 10)
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  const offsetMinutes = (hour - 12) * 60 + minute
  const startOfDayChicagoMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60 * 1000
  const untilMs = startOfDayChicagoMs + 24 * 3600 * 1000 - 1
  return {
    since_ts: Math.floor(startOfDayChicagoMs / 1000),
    until_ts: Math.floor(untilMs / 1000),
  }
}

export function dateStrMinusDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  t.setDate(t.getDate() - days)
  const yy = t.getFullYear()
  const mm = String(t.getMonth() + 1).padStart(2, '0')
  const dd = String(t.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function unixTimeToChicagoDateStr(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  const sec = ts > 1e12 ? ts / 1000 : ts
  const d = new Date(sec * 1000)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const y = parts.find((p) => p.type === 'year')?.value ?? ''
  const m = parts.find((p) => p.type === 'month')?.value ?? ''
  const day = parts.find((p) => p.type === 'day')?.value ?? ''
  return `${y}-${m}-${day}`
}

export function executionDateStr(e: Execution): string {
  const td = (e.trade_date ?? '').trim()
  if (td && /^\d{4}-\d{2}-\d{2}$/.test(td)) return td
  if (e.time != null && Number.isFinite(Number(e.time))) return unixTimeToChicagoDateStr(Number(e.time))
  return ''
}

/**
 * Backend opt pairs attributed to a calendar day: both legs present in execById,
 * at least one leg's trade date (executionDateStr) equals selectedDay,
 * and for each leg on selectedDay, FIFO pair qty must not exceed that execution's |quantity|
 * (same execution can appear in multiple pairs with partial qty — strict equality was wrong).
 */
export function filterRelevantOptPairsForDay(
  backendPairs: BackendOptPair[],
  execById: Map<number, Execution>,
  selectedDay: string,
): BackendOptPair[] {
  return backendPairs.filter((p) => {
    if (
      p.leg_c_execution_id == null ||
      p.leg_p_execution_id == null ||
      !execById.has(p.leg_c_execution_id) ||
      !execById.has(p.leg_p_execution_id)
    ) {
      return false
    }
    const pairQtyAbs = Math.abs(Number(p.quantity) || 0)
    const legC = execById.get(p.leg_c_execution_id)!
    const legP = execById.get(p.leg_p_execution_id)!
    const cOnDay = executionDateStr(legC) === selectedDay
    const pOnDay = executionDateStr(legP) === selectedDay
    if (!cOnDay && !pOnDay) return false
    const absC = Math.abs(Number(legC.quantity) || 0)
    const absP = Math.abs(Number(legP.quantity) || 0)
    if (cOnDay && pairQtyAbs > absC) return false
    if (pOnDay && pairQtyAbs > absP) return false
    return true
  })
}

export function getTimeRangeDates(
  timeRange: 'quarter' | 'year' | '3year',
  calendarMonth: string,
): { sinceStr: string; untilStr: string } {
  const [y, m] = calendarMonth.split('-').map(Number)
  const monthsBack = timeRange === 'quarter' ? 2 : timeRange === 'year' ? 11 : 35
  const startDate = new Date(y, m - 1 - monthsBack, 1)
  const endDate = new Date(y, m, 0)
  const sinceStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-01`
  const untilStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`
  return { sinceStr, untilStr }
}

export function listDateStrings(sinceStr: string, untilStr: string): string[] {
  const [sy, sm, sd] = sinceStr.split('-').map(Number)
  const [ey, em, ed] = untilStr.split('-').map(Number)
  const out: string[] = []
  const d = new Date(sy, sm - 1, sd)
  const end = new Date(ey, em - 1, ed)
  while (d.getTime() <= end.getTime()) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

export function listMonthKeysInRange(sinceStr: string, untilStr: string): string[] {
  const [sy, sm] = sinceStr.split('-').map(Number)
  const [ey, em] = untilStr.split('-').map(Number)
  const out: string[] = []
  let y = sy
  let m = sm
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

export function computeOptPairsFromExecutions(
  executions: Execution[],
  sortExec: (a: Execution, b: Execution) => number = sortExecByExecutionDateThenTime,
): { account_id: string; symbol: string; expiry: string; strike: string; quantity: number; c_side: string; c_price: number; p_side: string; p_price: number; commission: number; net_pnl: number }[] {
  const QTY_EPS = 1e-9
  const opt = executions.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const byKey: Record<string, Execution[]> = {}
  for (const e of opt) {
    const side = (e.side ?? 'BUY').toString().trim().toUpperCase() || 'BUY'
    if (side !== 'BUY' && side !== 'SELL') continue
    const key = [e.symbol ?? '', e.expiry ?? '', String(e.strike ?? ''), e.account_id ?? ''].join('\t')
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(e)
  }
  const pairs: { account_id: string; symbol: string; expiry: string; strike: string; quantity: number; c_side: string; c_price: number; p_side: string; p_price: number; commission: number; net_pnl: number }[] = []
  for (const list of Object.values(byKey)) {
    const sorted = [...list].sort(sortExec)
    const sym = sorted[0]?.symbol ?? ''
    const exp = sorted[0]?.expiry ?? ''
    const str = String(sorted[0]?.strike ?? '')
    const acc = sorted[0]?.account_id ?? ''

    type WorkItem = { side: string; price: number; remQty: number; remComm: number }
    const work: WorkItem[] = []
    for (const x of sorted) {
      const q = Number(x.quantity) || 0
      const p = Number(x.price) || 0
      const comm = Number(x.commission) || 0
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) continue
      const side = (x.side ?? 'BUY').toString().trim().toUpperCase() || 'BUY'
      work.push({ side, price: p, remQty: q, remComm: comm })
    }

    // Iterative FIFO: one pair per round, deduct matched qty, repeat.
    for (;;) {
      let pairFound = false
      const buyQ: WorkItem[] = []
      const sellQ: WorkItem[] = []

      for (const w of work) {
        if (w.remQty <= QTY_EPS) continue

        if (w.side === 'BUY') {
          if (sellQ.length > 0) {
            const s = sellQ[0]
            const qMatch = Math.min(w.remQty, s.remQty)
            if (qMatch <= QTY_EPS) { buyQ.push(w); continue }
            const bAlloc = (qMatch / w.remQty) * w.remComm
            const sAlloc = (qMatch / s.remQty) * s.remComm
            const legB = -1 * qMatch * w.price * 100 - bAlloc
            const legS = 1 * qMatch * s.price * 100 - sAlloc
            pairs.push({
              account_id: acc, symbol: sym, expiry: exp, strike: str,
              quantity: Math.round(qMatch * 1e4) / 1e4,
              c_side: s.side, c_price: Math.round(s.price * 1e4) / 1e4,
              p_side: w.side, p_price: Math.round(w.price * 1e4) / 1e4,
              commission: Math.round((bAlloc + sAlloc) * 100) / 100,
              net_pnl: Math.round((legB + legS) * 100) / 100,
            })
            w.remComm -= bAlloc; w.remQty -= qMatch
            s.remComm -= sAlloc; s.remQty -= qMatch
            pairFound = true
            break
          } else {
            buyQ.push(w)
          }
        } else {
          if (buyQ.length > 0) {
            const b = buyQ[0]
            const qMatch = Math.min(w.remQty, b.remQty)
            if (qMatch <= QTY_EPS) { sellQ.push(w); continue }
            const bAlloc = (qMatch / b.remQty) * b.remComm
            const sAlloc = (qMatch / w.remQty) * w.remComm
            const legB = -1 * qMatch * b.price * 100 - bAlloc
            const legS = 1 * qMatch * w.price * 100 - sAlloc
            pairs.push({
              account_id: acc, symbol: sym, expiry: exp, strike: str,
              quantity: Math.round(qMatch * 1e4) / 1e4,
              c_side: b.side, c_price: Math.round(b.price * 1e4) / 1e4,
              p_side: w.side, p_price: Math.round(w.price * 1e4) / 1e4,
              commission: Math.round((bAlloc + sAlloc) * 100) / 100,
              net_pnl: Math.round((legB + legS) * 100) / 100,
            })
            b.remComm -= bAlloc; b.remQty -= qMatch
            w.remComm -= sAlloc; w.remQty -= qMatch
            pairFound = true
            break
          } else {
            sellQ.push(w)
          }
        }
      }
      if (!pairFound) break
    }
  }
  return pairs
}

export function computeDayRealizedUnrealized(
  executions: Execution[],
  optPairs: BackendOptPair[] | null,
  sortExec: (a: Execution, b: Execution) => number = sortExecByExecutionDateThenTime,
): { realized: number; unrealized: number; symbolsRealized: string[]; symbolsUnrealized: string[] } {
  type DayPair = {
    account_id: string
    symbol: string
    expiry: string
    strike: string
    quantity: number
    c_side: string
    c_price: number
    p_side: string
    p_price: number
    commission: number
    net_pnl: number
    leg_c_execution_id?: number
    leg_p_execution_id?: number
  }
  const allExecs = executions
  const optExecs = allExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const dayPairs: DayPair[] = (optPairs != null && optPairs.length > 0)
    ? optPairs.map((p) => ({
      account_id: p.account_id,
      symbol: p.symbol,
      expiry: p.expiry,
      strike: p.strike,
      quantity: p.quantity,
      c_side: p.c_side,
      c_price: p.c_price,
      p_side: p.p_side,
      p_price: p.p_price,
      commission: p.commission,
      net_pnl: p.net_pnl,
      leg_c_execution_id: p.leg_c_execution_id,
      leg_p_execution_id: p.leg_p_execution_id,
    }))
    : computeOptPairsFromExecutions(allExecs, sortExec).map((p) => ({
      ...p,
      leg_c_execution_id: undefined,
      leg_p_execution_id: undefined,
    }))
  const pairKey = (p: { account_id: string; symbol: string; expiry: string; strike: string | number }) =>
    `${p.account_id}\t${p.symbol}\t${p.expiry}\t${normalizeStrike(p.strike)}`
  const keyNoAccount = (sym: string, exp: string, str: string | number) =>
    `${sym}\t${exp}\t${normalizeStrike(str)}`
  const contractKey = (e: Execution) =>
    `${e.account_id ?? ''}\t${e.symbol ?? ''}\t${e.expiry ?? ''}\t${normalizeStrike(e.strike)}`
  const execById = new Map<number, Execution>()
  for (const e of allExecs) {
    if (e.account_executions_id != null) execById.set(e.account_executions_id, e)
  }
  const dayPairsEnriched: DayPair[] = dayPairs.map((p) => ({
    ...p,
    account_id: p.account_id ||
      (p.leg_c_execution_id != null ? execById.get(p.leg_c_execution_id)?.account_id : undefined) ||
      (p.leg_p_execution_id != null ? execById.get(p.leg_p_execution_id)?.account_id : undefined) ||
      '',
  }))
  const pairByKey = new Map<string, DayPair[]>()
  for (const p of dayPairsEnriched) {
    const k = pairKey(p)
    if (!pairByKey.has(k)) pairByKey.set(k, [])
    pairByKey.get(k)!.push(p)
  }
  const pairByKeyNoAccount = new Map<string, DayPair[]>()
  for (const p of dayPairsEnriched) {
    const kNoAcc = keyNoAccount(p.symbol, p.expiry, p.strike)
    if (!pairByKeyNoAccount.has(kNoAcc)) pairByKeyNoAccount.set(kNoAcc, [])
    pairByKeyNoAccount.get(kNoAcc)!.push(p)
  }
  const byContract = new Map<string, Execution[]>()
  for (const e of optExecs) {
    const sym = e.symbol ?? ''
    const exp = e.expiry ?? ''
    const str = e.strike ?? ''
    const acc = e.account_id ?? ''
    let k: string
    if (acc.trim() !== '') {
      k = contractKey(e)
    } else {
      const pairList = pairByKeyNoAccount.get(keyNoAccount(sym, exp, str))
      k = pairList?.length && pairList[0].account_id
        ? pairKey(pairList[0])
        : contractKey(e)
    }
    if (!byContract.has(k)) byContract.set(k, [])
    byContract.get(k)!.push(e)
  }
  const allContractKeys = new Set<string>(byContract.keys())
  for (const p of dayPairsEnriched) {
    allContractKeys.add(pairKey(p))
  }
  const contractKeys = Array.from(allContractKeys)
  let totalRealizedSum = 0
  let totalUnrealizedSum = 0
  const symbolsRealizedSet = new Set<string>()
  const symbolsUnrealizedSet = new Set<string>()
  for (const key of contractKeys) {
    const pairs = pairByKey.get(key) ?? (key.startsWith('\t') ? pairByKeyNoAccount.get(key.slice(1)) ?? [] : [])
    const execs = byContract.get(key) ?? []
    const first = execs[0]
    const firstPair = pairs[0]
    const symbol = first?.symbol ?? firstPair?.symbol ?? '—'
    const sortedExecs = [...execs].sort(sortExec)
    const matchedQtyById = new Map<number, number>()
    for (const p of pairs) {
      const pq = Math.abs(p.quantity) || 0
      if (p.leg_c_execution_id != null) matchedQtyById.set(p.leg_c_execution_id, (matchedQtyById.get(p.leg_c_execution_id) ?? 0) + pq)
      if (p.leg_p_execution_id != null) matchedQtyById.set(p.leg_p_execution_id, (matchedQtyById.get(p.leg_p_execution_id) ?? 0) + pq)
    }
    const realizedPnl = pairs.reduce((s, p) => s + (p.net_pnl ?? matchPnl(p)), 0)
    let unrealizedPnl = 0
    let hasUnmatched = false
    for (const e of sortedExecs) {
      const eq = Math.abs(Number(e.quantity) || 0)
      if (eq <= 0) continue
      const mq = e.account_executions_id != null ? (matchedQtyById.get(e.account_executions_id) ?? 0) : 0
      const uq = eq - mq
      if (uq > 1e-9) {
        unrealizedPnl += (uq / eq) * ledgerOptionExecutionCashFlowSigned(e)
        hasUnmatched = true
      }
    }
    if (Math.abs(realizedPnl) >= 0.005 || pairs.length > 0) {
      totalRealizedSum += realizedPnl
      symbolsRealizedSet.add(symbol)
    }
    if (Math.abs(unrealizedPnl) >= 0.005 || hasUnmatched) {
      totalUnrealizedSum += unrealizedPnl
      symbolsUnrealizedSet.add(symbol)
    }
  }
  return {
    realized: totalRealizedSum,
    unrealized: totalUnrealizedSum,
    symbolsRealized: Array.from(symbolsRealizedSet).sort(),
    symbolsUnrealized: Array.from(symbolsUnrealizedSet).sort(),
  }
}

/**
 * Option Realized/Unrealized for one calendar day — same rules as Calendar day-detail.
 * `execs` / `optPairs` must come from GET /executions with until_ts = end of `dateStr`
 * and since_ts = start of (dateStr − lookback), so FIFO matches the drill-down.
 */
export function computeOptionDayPnLForPerformanceDate(
  dateStr: string,
  execs: Execution[],
  optPairs: BackendOptPair[] | null,
): { realized: number; unrealized: number; symbolsRealized: string[]; symbolsUnrealized: string[] } {
  const execByIdForDate = new Map<number, Execution>(
    execs.filter((e) => e.account_executions_id != null).map((e) => [e.account_executions_id!, e]),
  )
  const dayExecs = execs.filter((e) => executionDateStr(e) === dateStr)
  const relevantPairs =
    optPairs != null && optPairs.length > 0
      ? filterRelevantOptPairsForDay(optPairs, execByIdForDate, dateStr)
      : null
  return computeDayRealizedUnrealized(
    dayExecs,
    relevantPairs != null && relevantPairs.length > 0 ? relevantPairs : null,
  )
}

/** Run async tasks with limited concurrency; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) break
      results[i] = await fn(items[i]!, i)
    }
  }
  const n = Math.min(Math.max(1, limit), Math.max(1, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

export function computeDayRealizedUnrealizedStock(
  executions: Execution[],
  sortExec: (a: Execution, b: Execution) => number = sortExecByTradeDateThenTime,
): { realized: number; unrealized: number } {
  const stk = executions.filter((e) => (e.sec_type ?? '').toUpperCase() === 'STK')
  const byKey: Record<string, Execution[]> = {}
  for (const e of stk) {
    const side = (e.side ?? 'BUY').toString().trim().toUpperCase()
    if (side !== 'BUY' && side !== 'SELL') continue
    const key = `${e.symbol ?? ''}\t${e.account_id ?? ''}`
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(e)
  }
  let totalRealized = 0
  let totalUnrealized = 0
  for (const list of Object.values(byKey)) {
    const sorted = [...list].sort(sortExec)
    const buyQueue: { q: number; p: number; c: number }[] = []
    const sellQueue: { q: number; p: number; c: number }[] = []

    for (const x of sorted) {
      const q = Number(x.quantity) || 0
      const p = Number(x.price) || 0
      const comm = Number(x.commission) || 0
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) continue
      const side = (x.side ?? 'BUY').toString().trim().toUpperCase()

      if (side === 'BUY') {
        let remaining = q
        while (remaining > 0 && sellQueue.length > 0) {
          const ss = sellQueue[0]
          const qMatch = Math.min(remaining, ss.q)
          if (qMatch <= 0) break
          const bAlloc = (qMatch / q) * comm
          const sAlloc = (qMatch / ss.q) * ss.c
          const legB = -qMatch * p - bAlloc
          const legS = qMatch * ss.p - sAlloc
          totalRealized += legB + legS
          remaining -= qMatch
          if (qMatch >= ss.q) sellQueue.shift()
          else sellQueue[0] = { q: ss.q - qMatch, p: ss.p, c: ss.c * (1 - qMatch / ss.q) }
        }
        if (remaining > 0) buyQueue.push({ q: remaining, p, c: (remaining / q) * comm })
      } else {
        let remaining = q
        while (remaining > 0 && buyQueue.length > 0) {
          const bb = buyQueue[0]
          const qMatch = Math.min(remaining, bb.q)
          if (qMatch <= 0) break
          const bAlloc = (qMatch / bb.q) * bb.c
          const sAlloc = (qMatch / q) * comm
          const legB = -qMatch * bb.p - bAlloc
          const legS = qMatch * p - sAlloc
          totalRealized += legB + legS
          remaining -= qMatch
          if (qMatch >= bb.q) buyQueue.shift()
          else buyQueue[0] = { q: bb.q - qMatch, p: bb.p, c: bb.c * (1 - qMatch / bb.q) }
        }
        if (remaining > 0) sellQueue.push({ q: remaining, p, c: (remaining / q) * comm })
      }
    }
    // STK unrealized sign (opposite of option cash-flow leg): open long (remaining buys) = positive cost basis;
    // open short (remaining sells) = negative obligation.
    for (const b of buyQueue) totalUnrealized += b.q * b.p + b.c
    for (const s of sellQueue) totalUnrealized += -s.q * s.p + s.c
  }
  return { realized: totalRealized, unrealized: totalUnrealized }
}

/**
 * Per Chicago calendar day for STK: **realized** = increment in cumulative FIFO realized PnL (closes attributed to
 * the day the offsetting fill occurs); **unrealized** = end-of-day open position (same sign as
 * {@link computeDayRealizedUnrealizedStock}).
 * `execs` must include all STK fills from the same lookback window as the drill-down (through end of `dateStr`).
 */
export function computeStockDayPnLForPerformanceDate(
  dateStr: string,
  execs: Execution[],
  sortExec: (a: Execution, b: Execution) => number = sortExecByExecutionDateThenTime,
): { realized: number; unrealized: number } {
  const stk = execs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'STK')
  const throughDay = stk.filter((e) => {
    const d = executionDateStr(e)
    return d !== '' && d <= dateStr
  })
  const throughPrev = stk.filter((e) => {
    const d = executionDateStr(e)
    return d !== '' && d < dateStr
  })
  const endDay = computeDayRealizedUnrealizedStock(throughDay, sortExec)
  const endPrev =
    throughPrev.length === 0 ? { realized: 0, unrealized: 0 } : computeDayRealizedUnrealizedStock(throughPrev, sortExec)
  return {
    realized: endDay.realized - endPrev.realized,
    unrealized: endDay.unrealized,
  }
}
