import type { Execution, OptExecutionGroup } from '../../types'

/**
 * Net position: |quantity| with `side`. API may return signed qty (sell negative) or positive qty + side
 * (e.g. tws); abs + side matches both. Pure sign-of-quantity aggregation breaks when all fills are positive.
 */
const NET_QTY_EPS = 1e-9

export function buildOptExecutionGroups(sourceExecutions: Execution[]): OptExecutionGroup[] {
  const opt = sourceExecutions.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const key = (e: Execution) => `${(e.contract_key ?? '').trim()}|${Number.isFinite(Number(e.strike)) ? Number(e.strike) : 0}`
  const groups = new Map<string, Execution[]>()
  for (const e of opt) {
    const k = key(e)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(e)
  }
  const result: OptExecutionGroup[] = []
  for (const [, trades] of groups) {
    if (trades.length === 0) continue
    const first = trades[0]
    let contract_key = first.contract_key ?? ''
    if (!contract_key && (first.sec_type ?? '').toUpperCase() === 'OPT') {
      // Take only the ticker before any space (IB sometimes stores full OCC string in symbol)
      const sym = (first.symbol ?? '').trim().split(/\s+/)[0]?.trim() ?? ''
      const exp = String(first.expiry ?? '').trim().replace(/-/g, '')
      const str = first.strike != null ? String(first.strike) : ''
      const right = ((first.option_right ?? 'C') + '').toUpperCase().slice(0, 1)
      contract_key = `${sym}|OPT|${exp}|${str}|${right}`
    }
    const strike = Number(first.strike) ?? 0
    const expiry = first.expiry ?? ''
    let buy_qty = 0
    let sell_qty = 0
    let buy_value = 0
    let sell_value = 0
    let buy_value_raw = 0
    let sell_value_raw = 0
    let net_qty = 0
    for (const t of trades) {
      const rawQty = Number(t.quantity)
      const q = Number.isFinite(rawQty) ? Math.abs(rawQty) : 0
      if (q < NET_QTY_EPS) continue
      const p = Number(t.price) || 0
      const c = Number(t.commission) || 0
      const side = (t.side ?? '').toUpperCase()
      if (side === 'BUY' || side === 'BOT' || side === 'B') {
        buy_qty += q
        buy_value += p * q * 100 + c
        buy_value_raw += p * q
        net_qty += q
      } else if (side === 'SELL' || side === 'SLD' || side === 'S') {
        sell_qty += q
        sell_value += p * q * 100 - c
        sell_value_raw += p * q
        net_qty -= q
      }
    }
    const buy_cost = buy_value
    const sell_premium = sell_value
    const realized_pnl = sell_premium - buy_cost
    const buy_avg_price = buy_qty > 0 ? buy_value_raw / buy_qty : null
    const sell_avg_price = sell_qty > 0 ? sell_value_raw / sell_qty : null
    result.push({
      contract_key,
      strike,
      expiry,
      net_qty,
      buy_volume: buy_qty,
      sell_volume: sell_qty,
      buy_avg_price,
      sell_avg_price,
      buy_cost,
      sell_premium,
      realized_pnl,
      status: Math.abs(net_qty) < NET_QTY_EPS ? 'realized' : 'unrealized',
      trades: trades.slice().sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
    })
  }
  result.sort((a, b) => (b.trades[0]?.time ?? 0) - (a.trades[0]?.time ?? 0))
  return result
}

export function isOptionExpired(expiryRaw: string | undefined | null): boolean {
  if (!expiryRaw) return false
  const s = String(expiryRaw).trim().replace(/-/g, '')
  if (s.length !== 6 && s.length !== 8) return false
  const year = Number(s.slice(0, 4))
  const month = Number(s.slice(4, 6))
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return false
  let day = 1
  if (s.length === 8) {
    day = Number(s.slice(6, 8))
    if (!Number.isFinite(day) || day < 1 || day > 31) return false
  } else {
    const lastDay = new Date(year, month, 0).getDate()
    day = lastDay
  }
  const expDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59))
  const now = new Date()
  return now.getTime() > expDate.getTime()
}
