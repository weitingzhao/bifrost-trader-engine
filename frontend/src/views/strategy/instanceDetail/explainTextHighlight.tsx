import type { ReactNode } from 'react'

/**
 * Longest-first so shorter phrases do not steal matches (e.g. "Net PnL/day" before "Net PnL").
 */
const PHRASES: string[] = [
  'structure_type',
  'Net PnL/day',
  'Net PnL',
  'Return %',
  'Cost / day',
  'Cost per day',
  'Annual return',
  'Capital at risk',
  'hold days used',
  'report_date',
  'Max loss at expiration',
  'max loss at expiration',
  'max loss',
  'risk profile',
  'execution slice',
  'execution rows',
  'Generic cascade',
  'Underlying notional',
  'underlying notional',
  'sell-side OPT',
  'Cash secured',
  'Stock cost basis',
  'hold time',
  'Reg-T',
  'portfolio margin',
  'Risk & cost',
  'performance summary',
  'Group PnL',
  'Commission',
  'Trade Ledger',
  'realized_pnl',
  'denominator',
  'scale factor',
  '365.25',
  'Risk profile',
].sort((a, b) => b.length - a.length)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Single regex: currency and symbols first, then phrases (longest first). */
function buildHighlightRegex(): RegExp {
  const phraseAlt = PHRASES.map(escapeRe).join('|')
  return new RegExp(
    [
      '\\$[\\d,]+\\.\\d{2}', // $1,234.56
      '\\([A-E]\\)', // (A)–(E)
      '\\+?\\d+\\.\\d{1,6}%', // +12.3% or 0.0%
      '\\b365\\.25\\b',
      '\\b\\d+\\.\\d{6}\\b', // scale factors
      '\\b\\d+\\.\\d{4}\\b', // per-day intermediates
      '#\\d+', // Instance #123
      `(?:${phraseAlt})`,
    ].join('|'),
    'gi',
  )
}

let cachedSource = ''
let cachedRe: RegExp | null = null

function getHighlightRegex(): RegExp {
  const src = buildHighlightRegex().source
  if (cachedRe && cachedSource === src) return cachedRe
  cachedSource = src
  cachedRe = new RegExp(src, 'gi')
  return cachedRe
}

/**
 * Wraps currency amounts, (A)–(E), common % / decimal metrics, and trading vocabulary in explain modals.
 */
export function explainHighlightText(text: string): ReactNode {
  if (text == null || text === '') return text
  const re = getHighlightRegex()
  re.lastIndex = 0
  const parts: ReactNode[] = []
  let last = 0
  let k = 0
  let guard = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (++guard > text.length) break
    if (m[0] === '') {
      re.lastIndex = m.index + 1
      continue
    }
    if (m.index > last) {
      parts.push(text.slice(last, m.index))
    }
    parts.push(
      <strong key={`eh-${m.index}-${k++}`} className="instance-detail-modal-explain-kpi">
        {m[0]}
      </strong>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts.length === 0 ? text : <>{parts}</>
}
