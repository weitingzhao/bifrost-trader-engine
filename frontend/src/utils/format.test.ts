import { describe, it, expect } from 'vitest'
import { fmtUsd, fmtExpiry, parseOptionContractKey } from './format'

// ─── fmtUsd ───────────────────────────────────────────────────────────────

describe('fmtUsd', () => {
  it('formats positive number to USD with two decimals', () => {
    expect(fmtUsd(1234.56)).toBe('$1,234.56')
  })

  it('formats negative number', () => {
    expect(fmtUsd(-1234.56)).toBe('-$1,234.56')
  })

  it('formats zero', () => {
    expect(fmtUsd(0)).toBe('$0.00')
  })

  it('returns em-dash for null', () => {
    expect(fmtUsd(null)).toBe('—')
  })

  it('returns em-dash for undefined', () => {
    expect(fmtUsd(undefined)).toBe('—')
  })

  it('returns em-dash for NaN', () => {
    expect(fmtUsd(NaN)).toBe('—')
  })

  it('returns em-dash for Infinity', () => {
    expect(fmtUsd(Infinity)).toBe('—')
  })
})

// ─── fmtExpiry ───────────────────────────────────────────────────────────

describe('fmtExpiry', () => {
  it('formats 8-digit YYYYMMDD to YYYY-MM-DD', () => {
    expect(fmtExpiry('20240119')).toBe('2024-01-19')
  })

  it('formats 6-digit YYYYMM to YYYY-MM', () => {
    expect(fmtExpiry('202401')).toBe('2024-01')
  })

  it('strips hyphens from already-formatted date, then re-formats', () => {
    expect(fmtExpiry('2024-01-19')).toBe('2024-01-19')
  })

  it('returns em-dash for null', () => {
    expect(fmtExpiry(null)).toBe('—')
  })

  it('returns em-dash for empty string', () => {
    expect(fmtExpiry('')).toBe('—')
  })

  it('returns em-dash for whitespace-only string', () => {
    expect(fmtExpiry('   ')).toBe('—')
  })

  it('returns raw string for non-standard formats (e.g. partial 4 digits)', () => {
    // 4 digits → not 6 or 8 → fallback to raw trimmed value
    expect(fmtExpiry('2024')).toBe('2024')
  })
})

// ─── parseOptionContractKey ──────────────────────────────────────────────

describe('parseOptionContractKey', () => {
  it('parses standard 5-part OPT contract key', () => {
    const result = parseOptionContractKey('NVDA|OPT|20240119|150|C')
    expect(result).toEqual({ expiry: '20240119', strike: '150', right: 'C', rightLabel: 'CALL' })
  })

  it('parses put contract', () => {
    const result = parseOptionContractKey('NVDA|OPT|20240119|140|P')
    expect(result).toEqual({ expiry: '20240119', strike: '140', right: 'P', rightLabel: 'PUT' })
  })

  it('lowercases right and uppercases in result', () => {
    const result = parseOptionContractKey('NVDA|OPT|20240119|150|c')
    expect(result.right).toBe('C')
    expect(result.rightLabel).toBe('CALL')
  })

  it('returns em-dashes for null input', () => {
    const result = parseOptionContractKey(null)
    expect(result).toEqual({ expiry: '—', strike: '—', right: '—', rightLabel: '—' })
  })

  it('returns em-dashes for empty string input', () => {
    const result = parseOptionContractKey('')
    expect(result).toEqual({ expiry: '—', strike: '—', right: '—', rightLabel: '—' })
  })

  it('returns em-dashes for missing fields', () => {
    // Only 2 parts: expiry and strike will be missing
    const result = parseOptionContractKey('NVDA|OPT')
    expect(result.expiry).toBe('—')
    expect(result.strike).toBe('—')
    expect(result.right).toBe('—')
  })
})
