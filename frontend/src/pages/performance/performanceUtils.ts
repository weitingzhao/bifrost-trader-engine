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

export function execPnl(e: Execution): number {
  const qty = Number(e.quantity) || 0
  const price = Number(e.price) || 0
  const commission = Number(e.commission) || 0
  const pnl = qty * price * 100 - commission
  return Number.isFinite(pnl) ? pnl : 0
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
): { account_id: string; symbol: string; expiry: string; strike: string; quantity: number; c_side: string; c_price: number; p_side: string; p_price: number; commission: number; net_pnl: number }[] {
  const opt = executions.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const byKey: Record<string, Execution[]> = {}
  for (const e of opt) {
    const side = (e.side ?? 'BUY').toString().trim().toUpperCase() || 'BUY'
    if (side !== 'BUY' && side !== 'SELL') continue
    const key = [
      e.symbol ?? '',
      e.expiry ?? '',
      String(e.strike ?? ''),
      e.account_id ?? '',
    ].join('\t')
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(e)
  }
  const pairs: { account_id: string; symbol: string; expiry: string; strike: string; quantity: number; c_side: string; c_price: number; p_side: string; p_price: number; commission: number; net_pnl: number }[] = []
  for (const list of Object.values(byKey)) {
    const sorted = [...list].sort(sortExecByTradeDateThenTime)
    const buyQueue: { q: number; p: number; c: number; side: string }[] = []
    const sellQueue: { q: number; p: number; c: number; side: string }[] = []
    const sym = sorted[0]?.symbol ?? ''
    const exp = sorted[0]?.expiry ?? ''
    const str = String(sorted[0]?.strike ?? '')
    const acc = sorted[0]?.account_id ?? ''

    for (const x of sorted) {
      const q = Number(x.quantity) || 0
      const p = Number(x.price) || 0
      const comm = Number(x.commission) || 0
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) continue
      const side = (x.side ?? 'BUY').toString().trim().toUpperCase() || 'BUY'

      if (side === 'BUY') {
        let remaining = q
        while (remaining > 0 && sellQueue.length > 0) {
          const ss = sellQueue[0]
          const qMatch = Math.min(remaining, ss.q)
          if (qMatch <= 0) break
          const bAlloc = (qMatch / q) * comm
          const sAlloc = (qMatch / ss.q) * ss.c
          const signB = -1
          const signS = 1
          const legB = signB * qMatch * p * 100 - bAlloc
          const legS = signS * qMatch * ss.p * 100 - sAlloc
          pairs.push({
            account_id: acc,
            symbol: sym,
            expiry: exp,
            strike: str,
            quantity: Math.round(qMatch * 1e4) / 1e4,
            c_side: ss.side,
            c_price: Math.round(ss.p * 1e4) / 1e4,
            p_side: side,
            p_price: Math.round(p * 1e4) / 1e4,
            commission: Math.round((bAlloc + sAlloc) * 100) / 100,
            net_pnl: Math.round((legB + legS) * 100) / 100,
          })
          remaining -= qMatch
          if (qMatch >= ss.q) sellQueue.shift()
          else sellQueue[0] = { ...ss, q: ss.q - qMatch, c: ss.c * (1 - qMatch / ss.q) }
        }
        if (remaining > 0) buyQueue.push({ q: remaining, p, c: (remaining / q) * comm, side })
      } else {
        let remaining = q
        while (remaining > 0 && buyQueue.length > 0) {
          const bb = buyQueue[0]
          const qMatch = Math.min(remaining, bb.q)
          if (qMatch <= 0) break
          const bAlloc = (qMatch / bb.q) * bb.c
          const sAlloc = (qMatch / q) * comm
          const signB = -1
          const signS = 1
          const legB = signB * qMatch * bb.p * 100 - bAlloc
          const legS = signS * qMatch * p * 100 - sAlloc
          pairs.push({
            account_id: acc,
            symbol: sym,
            expiry: exp,
            strike: str,
            quantity: Math.round(qMatch * 1e4) / 1e4,
            c_side: bb.side,
            c_price: Math.round(bb.p * 1e4) / 1e4,
            p_side: side,
            p_price: Math.round(p * 1e4) / 1e4,
            commission: Math.round((bAlloc + sAlloc) * 100) / 100,
            net_pnl: Math.round((legB + legS) * 100) / 100,
          })
          remaining -= qMatch
          if (qMatch >= bb.q) buyQueue.shift()
          else buyQueue[0] = { ...bb, q: bb.q - qMatch, c: bb.c * (1 - qMatch / bb.q) }
        }
        if (remaining > 0) sellQueue.push({ q: remaining, p, c: (remaining / q) * comm, side })
      }
    }
  }
  return pairs
}

export function computeDayRealizedUnrealized(
  executions: Execution[],
  optPairs: BackendOptPair[] | null,
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
    : computeOptPairsFromExecutions(allExecs).map((p) => ({
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
    const sortedExecs = [...execs].sort(sortExecByTradeDateThenTime)
    const pairedExecIds = new Set<number>()
    for (const p of pairs) {
      if (p.leg_c_execution_id != null) pairedExecIds.add(p.leg_c_execution_id)
      if (p.leg_p_execution_id != null) pairedExecIds.add(p.leg_p_execution_id)
    }
    const unmatchedExecs = sortedExecs.filter((e) => e.account_executions_id == null || !pairedExecIds.has(e.account_executions_id))
    const groupSumPnl =
      unmatchedExecs.reduce((s, e) => s + execPnl(e), 0) +
      pairs.reduce((s, p) => s + (p.net_pnl ?? matchPnl(p)), 0)
    if (pairs.length > 0) {
      totalRealizedSum += groupSumPnl
      symbolsRealizedSet.add(symbol)
    } else {
      totalUnrealizedSum += groupSumPnl
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

export function computeDayRealizedUnrealizedStock(
  executions: Execution[],
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
    const sorted = [...list].sort(sortExecByTradeDateThenTime)
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
          const legB = -qMatch * p * 100 - bAlloc
          const legS = qMatch * ss.p * 100 - sAlloc
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
          const legB = -qMatch * bb.p * 100 - bAlloc
          const legS = qMatch * p * 100 - sAlloc
          totalRealized += legB + legS
          remaining -= qMatch
          if (qMatch >= bb.q) buyQueue.shift()
          else buyQueue[0] = { q: bb.q - qMatch, p: bb.p, c: bb.c * (1 - qMatch / bb.q) }
        }
        if (remaining > 0) sellQueue.push({ q: remaining, p, c: (remaining / q) * comm })
      }
    }
    for (const b of buyQueue) totalUnrealized += -b.q * b.p * 100 - b.c
    for (const s of sellQueue) totalUnrealized += s.q * s.p * 100 - s.c
  }
  return { realized: totalRealized, unrealized: totalUnrealized }
}
