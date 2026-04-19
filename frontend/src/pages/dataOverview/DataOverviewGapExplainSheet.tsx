import { useEffect, useRef } from 'react'

/** Shared copy — also reflected in matrix tooltips where relevant. */
export const GAP_SCOPE_CORE_TEXT =
  'For each expiry (newest 60 in option_contracts if there are more), we take every contract returned by Massive GET /v3/reference/options/contracts (paginated, with expiration_date). The comparable PostgreSQL count is how many of your option_contracts rows have the same contract_key as one of those API rows. Rows that exist only in the database but are not in the API response for that expiry are excluded from the PG side (they do not affect Gap or Cov%). Gap = Massive row count − matched PG rows. Cov% = 100 × matched PG ÷ Massive total for compared expiries (never above 100%).'

/** option_snapshots matrix Check — chain snapshot API vs PG, scoped to option_contracts keys. */
export const SNAPSHOT_GAP_SCOPE_CORE_TEXT =
  'For each expiry (newest 60 in option_contracts if there are more), we paginate Massive GET /v3/snapshot/options/{underlying} with an expiration_date filter. From each API result we derive contract_key the same way as chain snapshot ingest. Ref is the count of distinct contract_keys that appear in both the API response and your option_contracts rows for that expiry. PG is how many of those keys have at least one option_snapshots row (source=massive). Gap = Ref − PG. Cov% = 100 × PG ÷ Ref when Ref > 0. This is not the reference contracts list API used for option_contracts reference gap.'

export function DataOverviewGapExplainSheet({
  open,
  onClose,
  variant = 'contracts',
}: {
  open: boolean
  onClose: () => void
  /** Which matrix toolbar opened the sheet (copy differs). */
  variant?: 'contracts' | 'snapshots' | 'option_day_bars'
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet data-overview-gap-explain-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-gap-explain-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-gap-explain-title" className="ref-jobs-sheet-title">
            Gap scope
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="data-overview-gap-explain-sheet__body">
          {variant === 'option_day_bars' ? (
            <>
              <p className="data-overview-gap-explain-sheet__lead">
                In the <code>option_day</code> matrix, <strong>Ref</strong> is the count of distinct (expiry, strike, right)
                keys in <code>option_contracts</code> for compared expiries. <strong>PG</strong> is how many of those keys have
                at least one <code>option_day</code> row (source <code>massive</code>). <strong>Gap</strong> = Ref − PG.{' '}
                <strong>Cov%</strong> is PG ÷ Ref. Check is purely local (no Massive HTTP).
              </p>
              <h4 className="data-overview-gap-explain-sheet__h">Fill row gap vs Fill column data (option_day)</h4>
              <p className="data-overview-gap-explain-sheet__p">
                After <strong>Check</strong>, <strong>Fill row gap</strong> enqueues Celery <code>option_day_pool_row_gap</code>:
                Massive GET /v2/aggs (daily) for missing contracts up to a configured lookback (default ~2 years), capped per
                run. <strong>Fill column data</strong> runs <code>option_day_pool_column_fill</code>: GET /v1/open-close per
                trading day for rows with incomplete OHLC, volume, or VWAP in the lookback window, then optional VWAP patch
                from day aggs. Column fill may prioritize trading days where bar-quality daily metrics are below 97% when that
                data is available. This is separate from <code>option_contracts</code> reference or nullable column backfill.
              </p>
            </>
          ) : variant === 'snapshots' ? (
            <>
              <p className="data-overview-gap-explain-sheet__lead">
                In the <code>option_snapshots</code> matrix, <strong>Ref</strong> is the number of distinct contracts Massive
                returns in the chain snapshot API that also exist in <code>option_contracts</code> for that expiry.{' '}
                <strong>Gap</strong> is Ref minus PG snapshot rows (distinct <code>contract_key</code> with source{' '}
                <code>massive</code>). <strong>Cov%</strong> is PG ÷ Ref (never above 100%).
              </p>
              <h4 className="data-overview-gap-explain-sheet__h">How the total Gap and Cov% are computed</h4>
              <p className="data-overview-gap-explain-sheet__p">{SNAPSHOT_GAP_SCOPE_CORE_TEXT}</p>
              <h4 className="data-overview-gap-explain-sheet__h">Prerequisites</h4>
              <p className="data-overview-gap-explain-sheet__p">
                The symbol must have <code>option_contracts</code> rows. Check uses the Massive snapshot endpoint, not GET{' '}
                /v3/reference/options/contracts.
              </p>
            </>
          ) : (
            <>
              <p className="data-overview-gap-explain-sheet__lead">
                In the <code>option_contracts</code> matrix, <strong>Ref</strong> is the number of reference contracts Massive
                returns per compared expiry; <strong>Gap</strong> is Ref minus PG rows that match those contracts by{' '}
                <code>contract_key</code>. <strong>Cov%</strong> is matched PG ÷ Ref (never above 100%).
              </p>

              <h4 className="data-overview-gap-explain-sheet__h">How the total Gap and Cov% are computed</h4>
              <p className="data-overview-gap-explain-sheet__p">{GAP_SCOPE_CORE_TEXT}</p>
            </>
          )}

          {variant === 'contracts' ? (
            <>
          <h4 className="data-overview-gap-explain-sheet__h">Per-expiry breakdown (All gaps sheet)</h4>
          <p className="data-overview-gap-explain-sheet__p">
            After <strong>Check</strong>, open <strong>All gaps</strong> for per-expiry tables. The <strong>PG</strong>{' '}
            column is the <em>matched</em> count. When the API also returns totals for PG-only rows excluded from the
            comparison, that is the count of contracts stored locally whose <code>contract_key</code> did not appear in the
            Massive reference response for that expiry.
          </p>

          <h4 className="data-overview-gap-explain-sheet__h">What is not listed</h4>
          <p className="data-overview-gap-explain-sheet__p">
            Expiries that exist only on Massive (not yet in PostgreSQL) never appear in Compare or in the All gaps tables
            until a chain snapshot (or similar) inserts rows for that expiry into <code>option_contracts</code>.
          </p>

          <h4 className="data-overview-gap-explain-sheet__h">Data Overview toolbar: Fill row gap vs Fill column data</h4>
          <p className="data-overview-gap-explain-sheet__p">
            For <code>option_contracts</code>, both actions require a finished <strong>Check</strong> for the symbols you are
            fixing. <strong>Fill row gap</strong> enqueues one reference upsert per <em>pooled</em> symbol that still has a{' '}
            <strong>non-zero Gap</strong> (Massive contract <em>list</em> API; merges <code>massive_option_ticker</code>).{' '}
            <strong>Fill column data</strong> enqueues nullable detail backfill only for pooled symbols whose watchlist matrix
            metrics for <code>option_contracts</code> are still below <strong>97%</strong> (ticker / nullable averages), after{' '}
            Check. Rows need <code>massive_option_ticker</code> for detail calls; use row fill or All gaps if tickers are
            missing.
          </p>

          <h4 className="data-overview-gap-explain-sheet__h">Per-expiry fill in All gaps</h4>
          <p className="data-overview-gap-explain-sheet__p">
            <strong>Fill row gap</strong> on a single expiry scopes the same reference upsert to one <code>expiration_date</code>{' '}
            when supported by the worker. <strong>Fill row gaps in section</strong> enqueues one job per expiry in the &quot;Behind
            reference&quot; block.
          </p>

          <h4 className="data-overview-gap-explain-sheet__h">Row-level gap vs nullable column data</h4>
          <p className="data-overview-gap-explain-sheet__p">
            Reference upsert (toolbar <strong>Fill row gap</strong>, per-expiry actions, and <strong>Fill row</strong> on the
            <code>massive_option_ticker</code> row in All gaps) uses the Massive contract <em>list</em> API. It aligns rows with
            the reference and merges <code>massive_option_ticker</code>. It does <strong>not</strong> backfill{' '}
            <code>exercise_style</code> or <code>shares_per_contract</code> — those come from the per-contract <em>detail</em>{' '}
            API. In <strong>All gaps</strong>, use <strong>Fill column</strong> under &quot;Nullable / optional column NULL
            share&quot; for those fields (or toolbar <strong>Fill column data</strong> for both columns across the pool). Run
            row/ticker fill first if <code>massive_option_ticker</code> is missing on rows that need detail backfill.
          </p>

          <h4 className="data-overview-gap-explain-sheet__h">When Fill row gap is disabled</h4>
          <p className="data-overview-gap-explain-sheet__p">
            The toolbar enables <strong>Fill row gap</strong> only when at least one pooled symbol has Check complete and a
            non-zero Gap. When every pooled symbol shows total <strong>gap 0</strong> after Check, row fill is not offered.{' '}
            <strong>Fill column data</strong> enables only when at least one pooled symbol has Check complete and column
            health still below 97%.
          </p>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
