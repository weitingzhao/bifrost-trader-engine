import { describe, it, expect } from 'vitest'
import {
  optExecutionMatchKey,
  optionLastStrikePctClass,
  pnlClassForTone,
  fmtMvAbbrev,
  sortStockCoverageItemsByColumn,
} from './positionUtils'
import type { StockCoverageItem } from '../portfolio/types'

// ─── optExecutionMatchKey ──────────────────────────────────────────────────

describe('optExecutionMatchKey', () => {
  it('extracts OPT canonical key from standard 5-part contract_key', () => {
    expect(optExecutionMatchKey('ACC1', 'NVDA|OPT|20240119|150|C')).toBe('ACC1|OPT|20240119|150|C')
  })

  it('normalizes strike: removes trailing .00', () => {
    expect(optExecutionMatchKey('ACC1', 'NVDA|OPT|20240119|150.00|C')).toBe('ACC1|OPT|20240119|150|C')
  })

  it('normalizes right to uppercase first char', () => {
    expect(optExecutionMatchKey('ACC1', 'NVDA|OPT|20240119|150|p')).toBe('ACC1|OPT|20240119|150|P')
  })

  it('trims whitespace from accountId', () => {
    expect(optExecutionMatchKey(' ACC1 ', 'NVDA|OPT|20240119|150|C')).toBe('ACC1|OPT|20240119|150|C')
  })

  it('falls through for non-OPT contract (STK, 3-part)', () => {
    expect(optExecutionMatchKey('ACC1', 'NVDA|STK|USD')).toBe('ACC1|NVDA|STK|USD')
  })

  it('falls through for 5-part but non-OPT type', () => {
    // parts[1] = "FUT", not "OPT" → fallback
    expect(optExecutionMatchKey('ACC1', 'NQ|FUT|20240919|0|0')).toBe('ACC1|NQ|FUT|20240919|0|0')
  })

  it('handles empty contractKey gracefully', () => {
    expect(optExecutionMatchKey('ACC1', '')).toBe('ACC1|')
  })
})

// ─── optionLastStrikePctClass ─────────────────────────────────────────────

describe('optionLastStrikePctClass', () => {
  // pct === 0 → always ''
  it('returns empty string when pct is 0', () => {
    expect(optionLastStrikePctClass('C', 'Buy', 0)).toBe('')
    expect(optionLastStrikePctClass('P', 'Sell', 0)).toBe('')
  })

  // Unknown right → ''
  it('returns empty string for unknown right', () => {
    expect(optionLastStrikePctClass('X', 'Buy', 5)).toBe('')
  })

  // Call + Sell
  it('C Sell positive → pnl-negative (ITM is bad for seller)', () => {
    expect(optionLastStrikePctClass('C', 'Sell', 5)).toBe('pnl-negative')
  })
  it('C Sell negative → pnl-positive', () => {
    expect(optionLastStrikePctClass('C', 'Sell', -5)).toBe('pnl-positive')
  })

  // Call + Buy
  it('C Buy positive → pnl-positive', () => {
    expect(optionLastStrikePctClass('C', 'Buy', 5)).toBe('pnl-positive')
  })
  it('C Buy negative → pnl-negative', () => {
    expect(optionLastStrikePctClass('C', 'Buy', -5)).toBe('pnl-negative')
  })

  // Put + Sell
  it('P Sell positive → pnl-positive', () => {
    expect(optionLastStrikePctClass('P', 'Sell', 5)).toBe('pnl-positive')
  })
  it('P Sell negative → pnl-negative', () => {
    expect(optionLastStrikePctClass('P', 'Sell', -5)).toBe('pnl-negative')
  })

  // Put + Buy
  it('P Buy positive → pnl-negative (underlying moves away from strike)', () => {
    expect(optionLastStrikePctClass('P', 'Buy', 5)).toBe('pnl-negative')
  })
  it('P Buy negative → pnl-positive', () => {
    expect(optionLastStrikePctClass('P', 'Buy', -5)).toBe('pnl-positive')
  })
})

// ─── pnlClassForTone ─────────────────────────────────────────────────────

describe('pnlClassForTone', () => {
  it('profit → pnl-positive', () => {
    expect(pnlClassForTone('profit')).toBe('pnl-positive')
  })
  it('loss → pnl-negative', () => {
    expect(pnlClassForTone('loss')).toBe('pnl-negative')
  })
  it('flat → empty string', () => {
    expect(pnlClassForTone('flat')).toBe('')
  })
})

// ─── fmtMvAbbrev ──────────────────────────────────────────────────────────

describe('fmtMvAbbrev', () => {
  it('millions: 1_000_000 → $1.0M', () => {
    expect(fmtMvAbbrev(1_000_000)).toBe('$1.0M')
  })
  it('millions: 2_500_000 → $2.5M', () => {
    expect(fmtMvAbbrev(2_500_000)).toBe('$2.5M')
  })
  it('thousands: 5_000 → $5K', () => {
    expect(fmtMvAbbrev(5_000)).toBe('$5K')
  })
  it('thousands: 10_000 → $10K', () => {
    expect(fmtMvAbbrev(10_000)).toBe('$10K')
  })
  it('sub-thousand: 999 → $999', () => {
    expect(fmtMvAbbrev(999)).toBe('$999')
  })
  it('sub-thousand: 0 → $0', () => {
    expect(fmtMvAbbrev(0)).toBe('$0')
  })
  it('sub-thousand: rounds to nearest dollar', () => {
    expect(fmtMvAbbrev(500.7)).toBe('$501')
  })
})

// ─── sortStockCoverageItemsByColumn ───────────────────────────────────────

function item(symbol: string, account_id: string, held_shares: number, opts: Partial<StockCoverageItem> = {}): StockCoverageItem {
  return { symbol, account_id, required_shares: 100, held_shares, surplus_or_gap: 0, instances_needing: 0, ...opts }
}

describe('sortStockCoverageItemsByColumn', () => {
  it('sorts by symbol asc', () => {
    const list = [item('ZZZ', 'A', 0), item('AAA', 'B', 0), item('MMM', 'C', 0)]
    const result = sortStockCoverageItemsByColumn(list, 'symbol', 'asc')
    expect(result.map(r => r.symbol)).toEqual(['AAA', 'MMM', 'ZZZ'])
  })

  it('sorts by symbol desc', () => {
    const list = [item('ZZZ', 'A', 0), item('AAA', 'B', 0)]
    const result = sortStockCoverageItemsByColumn(list, 'symbol', 'desc')
    expect(result.map(r => r.symbol)).toEqual(['ZZZ', 'AAA'])
  })

  it('sorts by held shares asc', () => {
    const list = [item('A', 'X', 300), item('B', 'X', 100), item('C', 'X', 200)]
    const result = sortStockCoverageItemsByColumn(list, 'held', 'asc')
    expect(result.map(r => r.held_shares)).toEqual([100, 200, 300])
  })

  it('sorts by held shares desc', () => {
    const list = [item('A', 'X', 100), item('B', 'X', 300)]
    const result = sortStockCoverageItemsByColumn(list, 'held', 'desc')
    expect(result.map(r => r.held_shares)).toEqual([300, 100])
  })

  it('nulls last for cost_basis sort', () => {
    const a = item('A', 'X', 0, { cost_basis_total: null })
    const b = item('B', 'X', 0, { cost_basis_total: 5000 })
    const result = sortStockCoverageItemsByColumn([a, b], 'cost_basis', 'asc')
    // b (has value) before a (null)
    expect(result[0].symbol).toBe('B')
    expect(result[1].symbol).toBe('A')
  })

  it('does not mutate the original array', () => {
    const list = [item('B', 'X', 0), item('A', 'X', 0)]
    sortStockCoverageItemsByColumn(list, 'symbol', 'asc')
    expect(list[0].symbol).toBe('B')
  })
})
