import { w9 } from '@/styles/wave9Classes'
/** Indices row: show DB symbol as primary; optional muted Polygon ticker (avoid "Label^SYM" clutter). */

export function ReferenceIndexCoverageSymbolCell({
  symbol,
  reference,
}: {
  symbol: string
  reference?: { symbol?: string; label?: string; polygon_ticker?: string } | null
}) {
  const px = (reference?.polygon_ticker || '').trim()
  const label = (reference?.label || '').trim()
  const titleParts: string[] = []
  if (label && label !== symbol) {
    titleParts.push(label)
  }
  if (px) {
    titleParts.push(`Massive/Polygon ticker: ${px}`)
  }
  const title = titleParts.length > 0 ? titleParts.join(' · ') : undefined
  return (
    <span className="data-coverage-ref-symbol-wrap">
      <strong title={title}>{symbol}</strong>
      {px ? (
        <span className={w9.dataCoverageRefPolygon} title="Aggregate ticker used for Massive/Polygon sync">
          {' · '}
          {px}
        </span>
      ) : null}
    </span>
  )
}
