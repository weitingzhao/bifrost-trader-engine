import type { Execution } from '../types'
import { sortExecByExecutionDateThenTime } from '../pages/performance/performanceUtils'

const QTY_EPS = 1e-9

function normAccount(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

function digitsOnly(s: string): string {
  return String(s ?? '').replace(/\D/g, '')
}

/** Match position contract_key to execution row (IB vs OCC local symbol). */
export function executionMatchesOptionPosition(exec: Execution, positionContractKey: string): boolean {
  const pk = (positionContractKey ?? '').trim()
  if (!pk) return false
  const ek = (exec.contract_key ?? '').trim()
  if (ek && keysLooselyEqual(ek, pk)) return true
  const pParts = pk.split('|')
  if (pParts.length < 5 || pParts[1].trim().toUpperCase() !== 'OPT') return false
  const symPos = pParts[0]!.trim().split(/\s+/)[0]!.toUpperCase()
  const expPos = digitsOnly(pParts[2] ?? '')
  const strikePos = Number(pParts[3])
  const rightPos = (pParts[4] ?? '').trim().toUpperCase().slice(0, 1)
  const exSym = (exec.symbol ?? '').trim().split(/\s+/)[0]!.toUpperCase()
  const exExp = digitsOnly(String(exec.expiry ?? ''))
  const exStrike = Number(exec.strike)
  const exRight = (exec.option_right ?? '').trim().toUpperCase().slice(0, 1)
  if (!symPos || !expPos || !Number.isFinite(strikePos) || !rightPos) return false
  if (exSym !== symPos || !Number.isFinite(exStrike) || !exRight) return false
  if (rightPos !== exRight) return false
  if (!exExp || !expPos) return false
  const exp8p = expPos.length >= 8 ? expPos.slice(0, 8) : expPos.padStart(8, '0').slice(0, 8)
  const exp8e = exExp.length >= 8 ? exExp.slice(0, 8) : exExp.padStart(8, '0').slice(0, 8)
  if (exp8p !== exp8e && !exp8p.endsWith(exp8e.slice(2)) && !exp8e.endsWith(exp8p.slice(2))) return false
  return Math.abs(exStrike - strikePos) < 1e-6
}

function keysLooselyEqual(a: string, b: string): boolean {
  const na = a.trim().toUpperCase()
  const nb = b.trim().toUpperCase()
  if (na === nb) return true
  const pa = na.split('|')
  const pb = nb.split('|')
  if (pa.length >= 5 && pb.length >= 5) {
    const tailA = pa.slice(2).join('|')
    const tailB = pb.slice(2).join('|')
    if (tailA === tailB) return true
  }
  return false
}

function sourceNorm(e: Execution): string {
  return (e.source ?? '').trim().toLowerCase()
}

/**
 * Prefer flex_trades fills for cost when any exist for this contract; otherwise tws_client (then tws_event).
 */
export function selectExecutionsForLiveBasis(rows: Execution[]): {
  rows: Execution[]
  basisSource: 'flex_trades' | 'tws_client' | null
} {
  if (!rows.length) return { rows: [], basisSource: null }
  const hasFlex = rows.some((e) => sourceNorm(e) === 'flex_trades')
  if (hasFlex) {
    return {
      rows: rows.filter((e) => sourceNorm(e) === 'flex_trades'),
      basisSource: 'flex_trades',
    }
  }
  const tws = rows.filter((e) => {
    const s = sourceNorm(e)
    return s === 'tws_client' || s === 'tws_event'
  })
  if (tws.length) return { rows: tws, basisSource: 'tws_client' }
  return { rows, basisSource: null }
}

type WorkItem = { side: 'BUY' | 'SELL'; price: number; remQty: number; remComm: number }

function buildWorkItems(sorted: Execution[]): WorkItem[] {
  const out: WorkItem[] = []
  for (const x of sorted) {
    const p = Number(x.price) || 0
    const commRaw = Number(x.commission)
    const comm = Number.isFinite(commRaw) ? commRaw : 0
    const qRaw = Number(x.quantity)
    const sideStr = (x.side ?? '').toString().trim().toUpperCase()
    let side: 'BUY' | 'SELL'
    let q: number
    if (Number.isFinite(qRaw) && qRaw < 0) {
      side = 'SELL'
      q = Math.abs(qRaw)
    } else if (Number.isFinite(qRaw) && qRaw > 0) {
      if (sideStr.includes('SELL') || sideStr === 'SLD' || sideStr === 'S') {
        side = 'SELL'
        q = qRaw
      } else {
        side = 'BUY'
        q = qRaw
      }
    } else {
      continue
    }
    if (!Number.isFinite(p) || q <= QTY_EPS) continue
    out.push({ side, price: p, remQty: q, remComm: comm })
  }
  return out
}

/** Same FIFO pairing as Trade Ledger option pairs; remaining lots = open inventory. */
function runOptionFifoPairDown(work: WorkItem[]): void {
  for (;;) {
    let pairFound = false
    const buyQ: WorkItem[] = []
    const sellQ: WorkItem[] = []

    for (const w of work) {
      if (w.remQty <= QTY_EPS) continue

      if (w.side === 'BUY') {
        if (sellQ.length > 0) {
          const s = sellQ[0]!
          const qMatch = Math.min(w.remQty, s.remQty)
          if (qMatch <= QTY_EPS) {
            buyQ.push(w)
            continue
          }
          const bAlloc = (qMatch / w.remQty) * w.remComm
          const sAlloc = (qMatch / s.remQty) * s.remComm
          w.remComm -= bAlloc
          w.remQty -= qMatch
          s.remComm -= sAlloc
          s.remQty -= qMatch
          pairFound = true
          break
        } else {
          buyQ.push(w)
        }
      } else {
        if (buyQ.length > 0) {
          const b = buyQ[0]!
          const qMatch = Math.min(w.remQty, b.remQty)
          if (qMatch <= QTY_EPS) {
            sellQ.push(w)
            continue
          }
          const bAlloc = (qMatch / b.remQty) * b.remComm
          const sAlloc = (qMatch / w.remQty) * w.remComm
          b.remComm -= bAlloc
          b.remQty -= qMatch
          w.remComm -= sAlloc
          w.remQty -= qMatch
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

/**
 * Average premium $/share for the open leg (matches IB avgCost convention × (mid − avg) × qty × 100).
 */
function fifoOpenAvgPerShare(sorted: Execution[], positionQty: number): number | null {
  if (!Number.isFinite(positionQty) || Math.abs(positionQty) < QTY_EPS) return null
  const work = buildWorkItems(sorted)
  if (!work.length) return null
  runOptionFifoPairDown(work)

  const tol = 0.02 + Math.abs(positionQty) * 0.02
  const mult = 100

  if (positionQty > 0) {
    const buys = work.filter((w) => w.side === 'BUY' && w.remQty > QTY_EPS)
    const sumQ = buys.reduce((a, w) => a + w.remQty, 0)
    if (Math.abs(sumQ - positionQty) > tol) return null
    let dollar = 0
    for (const w of buys) {
      dollar += w.remQty * w.price * mult + w.remComm
    }
    return dollar / (positionQty * mult)
  }

  const sells = work.filter((w) => w.side === 'SELL' && w.remQty > QTY_EPS)
  const sumQ = sells.reduce((a, w) => a + w.remQty, 0)
  if (Math.abs(sumQ - Math.abs(positionQty)) > tol) return null
  let premium = 0
  for (const w of sells) {
    premium += w.remQty * w.price * mult - w.remComm
  }
  return premium / (Math.abs(positionQty) * mult)
}

export function computeOptionLiveAvgPerShareFromExecutions(
  accountExecutions: Execution[],
  accountId: string,
  positionContractKey: string,
  positionQty: number,
): { avgPerShare: number | null; basisSource: 'flex_trades' | 'tws_client' | null } {
  const wantAcc = normAccount(accountId)
  const matched = accountExecutions.filter(
    (e) =>
      (e.sec_type ?? '').toUpperCase() === 'OPT' &&
      normAccount(e.account_id) === wantAcc &&
      executionMatchesOptionPosition(e, positionContractKey),
  )
  const { rows: chosen, basisSource } = selectExecutionsForLiveBasis(matched)
  if (!chosen.length) return { avgPerShare: null, basisSource: null }
  const sorted = [...chosen].sort(sortExecByExecutionDateThenTime)
  const avg = fifoOpenAvgPerShare(sorted, positionQty)
  return { avgPerShare: avg, basisSource }
}
