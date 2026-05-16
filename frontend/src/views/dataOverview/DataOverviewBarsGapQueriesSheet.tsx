import { useCallback, useEffect, useRef } from 'react'

/** Escape single quotes for SQL string literals in examples. */
function sqlLit(s: string): string {
  return s.replace(/'/g, "''")
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }, [text])
  return (
    <div className="data-overview-bars-gap-queries__block">
      <div className="data-overview-bars-gap-queries__block-head">
        <span className="data-overview-bars-gap-queries__block-label">{label}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
          Copy
        </button>
      </div>
      <pre className="data-overview-bars-gap-queries__pre">{text}</pre>
    </div>
  )
}

export function DataOverviewBarsGapQueriesSheet({
  open,
  onClose,
  symbol,
  expiry,
  table,
  optionMinPeriod,
}: {
  open: boolean
  onClose: () => void
  symbol: string
  expiry: string
  table: 'option_day' | 'option_min'
  optionMinPeriod?: string
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const sym = symbol.trim().toUpperCase()
  const exp = expiry.trim()
  const expSql = sqlLit(exp)
  const symSql = sqlLit(sym)
  const barsTable = table === 'option_min' ? 'option_min' : 'option_day'
  const period = (optionMinPeriod ?? '').trim()
  const periodSql = sqlLit(period)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const refQuery = `-- Ref (UI column "Ref"): distinct contract keys from option_contracts for this expiry.
-- Backend: src/vendor/massive/bars_contracts_gap.py — set size of CONCAT rows (deduplicated).
SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS contract_key
FROM option_contracts
WHERE UPPER(TRIM(symbol)) = '${symSql}'
  AND expiry = '${expSql}';`

  const coveredQuery =
    table === 'option_min' && !period
      ? `-- option_min: set Bar period in the Data Overview toolbar (must match option_min.period in PostgreSQL), then reopen SQL & API.`
      : table === 'option_min' && period
        ? `-- Covered (UI column "Covered"): keys that appear in option_min with source = massive for this expiry and period.
SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS contract_key
FROM option_min
WHERE source = 'massive'
  AND UPPER(TRIM(symbol)) = '${symSql}'
  AND expiry = '${expSql}'
  AND period = '${periodSql}';`
        : `-- Covered (UI column "Covered"): keys that appear in option_day with source = massive for this expiry.
SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS contract_key
FROM option_day
WHERE source = 'massive'
  AND UPPER(TRIM(symbol)) = '${symSql}'
  AND expiry = '${expSql}';`

  const gapQuery =
    table === 'option_min' && !period
      ? `-- option_min: set Bar period in the Data Overview toolbar, then reopen SQL & API.`
      : table === 'option_min' && period
        ? `-- Gap = Ref − Covered, where Covered = |cov_keys ∩ ref_keys| (same as UI).
WITH ref_keys AS (
  SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS k
  FROM option_contracts
  WHERE UPPER(TRIM(symbol)) = '${symSql}' AND expiry = '${expSql}'
),
cov_keys AS (
  SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS k
  FROM option_min
  WHERE source = 'massive'
    AND UPPER(TRIM(symbol)) = '${symSql}'
    AND expiry = '${expSql}'
    AND period = '${periodSql}'
)
SELECT
  (SELECT COUNT(*) FROM ref_keys) AS ref_count,
  (SELECT COUNT(*) FROM ref_keys r INNER JOIN cov_keys c ON r.k = c.k) AS covered_count,
  (SELECT COUNT(*) FROM ref_keys) - (SELECT COUNT(*) FROM ref_keys r INNER JOIN cov_keys c ON r.k = c.k) AS gap_count;`
        : `-- Gap = Ref − Covered, where Covered = |cov_keys ∩ ref_keys| (same as UI).
WITH ref_keys AS (
  SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS k
  FROM option_contracts
  WHERE UPPER(TRIM(symbol)) = '${symSql}' AND expiry = '${expSql}'
),
cov_keys AS (
  SELECT DISTINCT CONCAT(expiry, '|', strike::text, '|', option_right) AS k
  FROM option_day
  WHERE source = 'massive'
    AND UPPER(TRIM(symbol)) = '${symSql}'
    AND expiry = '${expSql}'
)
SELECT
  (SELECT COUNT(*) FROM ref_keys) AS ref_count,
  (SELECT COUNT(*) FROM ref_keys r INNER JOIN cov_keys c ON r.k = c.k) AS covered_count,
  (SELECT COUNT(*) FROM ref_keys) - (SELECT COUNT(*) FROM ref_keys r INNER JOIN cov_keys c ON r.k = c.k) AS gap_count;`

  const rowGapTargetsQuery =
    table === 'option_min'
      ? `-- Row-gap pool (option_min) uses option_min_pool_fill — see backend src/massive/option_min_pool_fill.py.`
      : `-- Contracts Fill row gap would process for this expiry (no option_day row yet, source=massive):
-- src/massive/option_day_pool_fill.py list_option_day_row_gap_targets
SELECT oc.massive_option_ticker, oc.symbol, oc.expiry, oc.strike, oc.option_right
FROM option_contracts oc
WHERE UPPER(TRIM(oc.symbol)) = '${symSql}'
  AND oc.expiry = '${expSql}'
  AND oc.massive_option_ticker IS NOT NULL
  AND TRIM(oc.massive_option_ticker) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM option_day od
    WHERE UPPER(TRIM(od.symbol)) = UPPER(TRIM(oc.symbol))
      AND od.expiry = oc.expiry
      AND od.strike = oc.strike
      AND od.option_right = oc.option_right
      AND od.source = 'massive'
  )
ORDER BY oc.strike, oc.option_right;`

  const massiveRest = `-- Massive / Polygon: daily aggregates for one options ticker (Fill row gap uses this).
-- Client: src/vendor/massive/client.py fetch_option_aggs
-- Default lookback: row_lookback_days = 730 (see enqueue payload). from/to are inclusive NY calendar dates for timespan "day".
--
-- GET https://api.polygon.io/v2/aggs/ticker/{OPTIONS_TICKER}/range/1/day/{FROM_DATE}/{TO_DATE}
-- Query string: sort=asc&limit=50000&apiKey=YOUR_API_KEY
-- OPTIONS_TICKER: URL-encode (e.g. O:ANET260529C00080000 → O%3AANET260529C00080000)
-- For O: tickers, omit "adjusted" (Polygon options behavior matches MassiveClient._v2_range_aggs_query_params).
--
curl -sS 'https://api.polygon.io/v2/aggs/ticker/O%3AREPLACE_WITH_O_TICKER/range/1/day/YYYY-MM-DD/YYYY-MM-DD?sort=asc&limit=50000&apiKey=YOUR_API_KEY'
--
-- Replace REPLACE_WITH_O_TICKER with the value from option_contracts.massive_option_ticker (without O: prefix if you already put O%3A in path).
-- Replace FROM_DATE / TO_DATE with your lookback window in America/New_York (engine aligns ms window to these dates for day bars).`

  if (!open) return null

  return (
    <div
      className="ref-jobs-sheet-backdrop ref-jobs-sheet-backdrop--nested"
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={asideRef}
        className="ref-jobs-sheet data-overview-bars-gap-queries-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-bars-gap-queries-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-bars-gap-queries-title" className="ref-jobs-sheet-title">
            Queries &amp; API
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <p className="ref-jobs-sheet-meta data-overview-bars-gap-queries__meta">
          <code>{sym}</code> · expiry <code>{exp}</code> · <code>{barsTable}</code>
          {table === 'option_min' && period ? (
            <>
              {' '}
              · period <code>{period}</code>
            </>
          ) : null}
        </p>
        <div className="data-overview-bars-gap-queries__body">
          <p className="data-overview-bars-gap-queries__lead">
            Values match <strong>Check</strong> / this sheet (local PostgreSQL only for Ref / Covered / Gap). Fill row gap calls
            Massive REST as below.
          </p>
          <CopyBlock label="Ref — option_contracts keys (count = Ref)" text={refQuery} />
          <CopyBlock label="Covered — bar table keys ∩ ref (count = Covered)" text={coveredQuery} />
          <CopyBlock label="Ref, Covered, Gap — single verification query" text={gapQuery} />
          <CopyBlock label="Row-gap targets (option_day only) — contracts missing any massive option_day row" text={rowGapTargetsQuery} />
          <CopyBlock label="Massive REST — GET /v2/aggs (daily, per options ticker)" text={massiveRest} />
        </div>
      </aside>
    </div>
  )
}
