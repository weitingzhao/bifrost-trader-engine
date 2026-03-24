/**
 * Polygon/Massive REST options ticker: O:{UNDERLYING}{YYMMDD}{C|P}{strike×1000 padded 8}
 * @see https://polygon.io/docs/options/getting-started
 */
export function buildPolygonOptionsTicker(
  symbol: string,
  expiration: string,
  strike: number,
  right: string,
): string {
  const sym = symbol.trim().toUpperCase()
  const raw = expiration.trim().replace(/-/g, '')
  let yymmdd: string
  if (raw.length === 8 && /^\d{8}$/.test(raw)) {
    yymmdd = raw.slice(2, 8)
  } else if (raw.length === 6 && /^\d{6}$/.test(raw)) {
    yymmdd = raw
  } else {
    yymmdd = raw.slice(0, 6)
  }
  const r = (right || 'C').trim().toUpperCase()
  const rc = r === 'PUT' || r === 'P' ? 'P' : 'C'
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0')
  return `O:${sym}${yymmdd}${rc}${strikeStr}`
}
