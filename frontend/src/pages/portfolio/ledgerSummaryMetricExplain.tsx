/** English copy for Trade ledger Summary metric explain panel (UI strings). */

import type { ReactNode } from 'react'
import type { LedgerMetricExplainKind } from './ledgerMetricExplainKinds'
import {
  LEDGER_METRIC_EXPLAIN_MAX_ROWS,
  type LedgerMetricExplainPayload,
} from './ledgerSummaryExplainPayload'

export type { LedgerMetricExplainKind } from './ledgerMetricExplainKinds'

export function ledgerMetricExplainTitle(kind: LedgerMetricExplainKind): string {
  switch (kind) {
    case 'options_period_realized':
      return 'Option summary — realized PnL (period cell)'
    case 'options_total_realized':
      return 'Option summary — realized PnL (total)'
    case 'stocks_period_realized':
      return 'Stock summary — realized PnL (period cell)'
    case 'stocks_period_notional':
      return 'Stock summary — notional (period cell)'
    case 'stocks_total_realized':
      return 'Stock summary — realized PnL (total)'
    case 'stocks_total_notional':
      return 'Stock summary — notional (total)'
    case 'stocks_total_unrealized':
      return 'Stock summary — unrealized PnL (total)'
    default:
      return 'Summary metric'
  }
}

function SectionTitle({ n, children }: { n: 1 | 2 | 3 | 4; children: ReactNode }) {
  return <h4 className="ledger-metric-explain-section">{n}. {children}</h4>
}

function LedgerMetricExplainLiveExample({ payload }: { payload: LedgerMetricExplainPayload }) {
  return (
    <>
      <SectionTitle n={4}>Live example — current Summary</SectionTitle>
      <p className="ledger-metric-explain-live-context">
        <strong>Trade ledger tab:</strong> {payload.ledgerTabLabel}
        {' · '}
        <strong>Summary period mode:</strong> {payload.summaryPeriodModeLabel}
        {' · '}
        <strong>Bucket:</strong> {payload.bucketLabel}
      </p>
      <p className="ledger-metric-explain-live-metric">
        <strong>{payload.metricLabel}</strong> — value shown in the grid:{' '}
        <strong>{payload.displayedFormatted}</strong>
        <span className="ledger-metric-explain-live-raw">
          {' '}
          (numeric:{' '}
          {Number.isFinite(payload.displayedRaw) ? payload.displayedRaw.toFixed(4) : '—'})
        </span>
      </p>
      <p className="ledger-metric-explain-live-sub">Substitution with rows in this bucket:</p>
      {payload.formulaLines.map((line, i) => (
        <pre key={i} className="ledger-metric-explain-formula ledger-metric-explain-formula--compact">
          {line}
        </pre>
      ))}
      {payload.emptyMessage ? (
        <p className="ledger-metric-explain-note">{payload.emptyMessage}</p>
      ) : null}
      {payload.detailRows.length > 0 ? (
        <div className="ledger-metric-explain-table-wrap">
          <table className="ledger-metric-explain-table">
            <thead>
              <tr>
                {payload.detailColumnHeaders.map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.detailRows.map((row, ri) => (
                <tr key={ri}>
                  {payload.detailColumnHeaders.map(h => (
                    <td key={h}>{String((row as Record<string, unknown>)[h] ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {payload.truncatedCount > 0 ? (
            <p className="ledger-metric-explain-note">
              … and {payload.truncatedCount} more row(s) not shown (display limit {LEDGER_METRIC_EXPLAIN_MAX_ROWS}
              ).
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

export function LedgerSummaryMetricExplainContent({
  kind,
  payload,
}: {
  kind: LedgerMetricExplainKind
  payload: LedgerMetricExplainPayload
}) {
  return (
    <div className="ledger-metric-explain">
      {kind === 'options_period_realized' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              <strong>API:</strong> <code>GET /executions</code> with <code>source_scope=performance_book</code>{' '}
              — server reads finalized executions (e.g. <code>account_executions_final</code> in the backend).
            </li>
            <li>
              <strong>UI rows:</strong> each execution has <code>time</code> (Unix seconds), <code>sec_type</code>,{' '}
              <code>symbol</code>, <code>expiry</code>, <code>strike</code>, <code>option_right</code>, etc.
            </li>
            <li>
              <strong>Groups:</strong> <code>buildOptExecutionGroups(executions)</code> produces{' '}
              <code>OptExecutionGroup[]</code>. Each group has <code>status</code>, <code>realized_pnl</code>,{' '}
              <code>trades[]</code> (fills for that contract).
            </li>
            <li>
              <strong>Closed PnL field:</strong> for <code>status === &apos;realized&apos;</code>,{' '}
              <code>realized_pnl</code> is the group-level closed PnL computed from those fills (cash flow and
              commission), not a single raw IB column.
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <ol className="ledger-metric-explain-steps">
            <li>
              Let <code>G</code> be the set of groups with <code>status === &apos;realized&apos;</code> after
              Trade ledger filters.
            </li>
            <li>
              For each <code>g ∈ G</code>, assign a calendar month{' '}
              <code>m(g) = YYYY-MM</code> from{' '}
              <code>max( t.time | t ∈ g.trades )</code> (UTC, from Unix seconds).
            </li>
            <li>
              Map <code>m(g)</code> to the selected Summary period key <code>P</code> (Month / Quarter / Half-year /
              Year) using the same rules as the period labels in the grid.
            </li>
            <li>
              For the cell labeled period key <code>P*</code>:
              <pre className="ledger-metric-explain-formula">
                {`value(P*) = Σ  g.realized_pnl
  over all g ∈ G such that periodKey(m(g)) = P*`}
              </pre>
            </li>
          </ol>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              The number is <code>fmtUsd0(value)</code> — USD with no decimals in this formatter.
            </li>
            <li>
              Color: <span className="replay-pnl-realized">positive</span> &gt; 0,{' '}
              <span className="replay-pnl-detail-negative">negative</span> &lt; 0, neutral gray for exactly 0.
            </li>
            <li>
              Same row also shows <code>N groups</code> and the period label (e.g. <code>2024 Q2</code>).
            </li>
          </ul>
        </>
      )}
      {kind === 'options_total_realized' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              Same as period cells: <code>GET /executions</code> (<code>performance_book</code>) →{' '}
              <code>buildOptExecutionGroups</code> → closed groups with <code>realized_pnl</code>.
            </li>
            <li>
              Trade ledger filters (symbol, expiry year/month or Since rolling window, account, structure, wishlist
              symbol) apply before the sum.
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <p>
            Let <code>G</code> be all closed option groups in scope after filters.
          </p>
          <pre className="ledger-metric-explain-formula">
            {`totalRealizedPnL = Σ  g.realized_pnl
  for g ∈ G where g.status === 'realized'`}
          </pre>
          <p className="ledger-metric-explain-note">
            The grid above does not change this total — it is the full sum over the same filtered closed groups.
          </p>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              Shown in the <strong>Total</strong> box next to the total group count, as{' '}
              <code>fmtUsd0(totalRealizedPnL)</code>.
            </li>
            <li>Color follows the sign of <code>totalRealizedPnL</code> (same rules as period cells).</li>
          </ul>
        </>
      )}
      {kind === 'stocks_period_realized' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              <strong>API:</strong> <code>GET /executions</code> (same Trade ledger feed as the table). Each row is
              an <code>Execution</code>.
            </li>
            <li>
              <strong>Stock filter:</strong> rows where <code>sec_type</code> is <code>STK</code>, after Trade
              ledger filters and the Stocks category tab when applicable.
            </li>
            <li>
              <strong>Per-fill PnL field:</strong> <code>execution.realized_pnl</code> — populated from IB
              commission report (<code>realizedPNL</code>) when the fill is reported (R-A2 pipeline), stored in
              the DB and returned by the API. Missing values are treated as <code>0</code> in the sum.
            </li>
            <li>
              <strong>Time field for bucketing:</strong> <code>execution.time</code> (Unix seconds).
            </li>
            <li>
              <strong>Unrealized:</strong> period cells are <strong>realized only</strong>. Unrealized PnL is a
              position snapshot (see Total unrealized explain); it is not allocated into historical month/quarter
              buckets.
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <ol className="ledger-metric-explain-steps">
            <li>
              Let <code>E</code> be the set of in-scope stock executions.
            </li>
            <li>
              For each <code>e ∈ E</code>, month bucket <code>m(e) = YYYY-MM</code> from{' '}
              <code>e.time</code> (UTC).
            </li>
            <li>
              Roll monthly buckets into the selected Summary period key <code>P</code> (Month / Quarter / Half-year /
              Year).
            </li>
            <li>
              For the cell with period key <code>P*</code>:
              <pre className="ledger-metric-explain-formula">
                {`realizedPnL(P*) = Σ  COALESCE(e.realized_pnl, 0)
  for e ∈ E such that periodKey(m(e)) = P*`}
              </pre>
            </li>
          </ol>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              The colored value is <code>fmtUsd0(realizedPnL(P*))</code> on the same line as{' '}
              <code>N trades</code>.
            </li>
            <li>
              Styling: green if sum &gt; 0, red if &lt; 0, neutral gray if 0.
            </li>
            <li>
              The line below is <strong>Notional</strong> (see its own explain) — not the same as realized PnL.
            </li>
          </ul>
        </>
      )}
      {kind === 'stocks_period_notional' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              Same execution rows <code>e</code> as in this period cell (same filters and period bucket as
              realized PnL).
            </li>
            <li>
              Fields used: <code>e.quantity</code>, <code>e.price</code> (per share).
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <p>Per execution:</p>
          <pre className="ledger-metric-explain-formula">
            {`notional(e) = |quantity(e)| × price(e)`}
          </pre>
          <p>For the period cell <code>P*</code>:</p>
          <pre className="ledger-metric-explain-formula">
            {`notional(P*) = Σ  notional(e)
  for e in the same bucket as P*`}
          </pre>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              Second line in the cell: the label <strong>Notional</strong> plus the amount formatted with{' '}
              <code>fmtUsd0</code> (USD, no decimals), in smaller muted text.
            </li>
            <li>This is trade size in dollars, not profit or loss.</li>
          </ul>
        </>
      )}
      {kind === 'stocks_total_realized' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              Same as the Stocks table: <code>GET /executions</code> with stock rows, after filters and category
              tab.
            </li>
            <li>
              Field: <code>realized_pnl</code> on each execution (IB commission report, missing → 0).
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <pre className="ledger-metric-explain-formula">
            {`totalRealizedPnL = Σ  COALESCE(e.realized_pnl, 0)
  for all stock executions e in scope (no period filter)`}
          </pre>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              In the <strong>Total</strong> box: realized total after the trade count,{' '}
              <code>fmtUsd0(totalRealizedPnL)</code>, colored by sign; then <strong>U</strong> (unrealized from
              positions) and <strong>nv</strong> (notional).
            </li>
            <li>Independent of the period grid — it is the full filtered ledger total.</li>
          </ul>
        </>
      )}
      {kind === 'stocks_total_unrealized' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              <strong>API:</strong> <code>GET /status</code> → <code>portfolio.accounts[].positions[]</code> (IB
              snapshot). Unrealized is <strong>not</strong> on execution rows.
            </li>
            <li>
              For each STK position, the server computes <code>unrealized_pnl</code> from mark vs average cost
              (same as Accounts).
            </li>
            <li>
              Keys match ledger rows: <code>account_id</code> + STK <code>contract_key</code>{' '}
              (<code>symbol|STK|||</code>).
            </li>
            <li>
              The table <strong>Notional</strong> column per fill is <code>|quantity| × price</code> (trade size in
              dollars). Cell color is by side: <strong>Buy</strong> green, <strong>Sell</strong> red. Unrelated to{' '}
              <strong>U</strong> (position-level unrealized). The <strong>Realized</strong> column is per fill;
              unrealized appears only on <strong>Group U/R PnL</strong> (when grouped) and <strong>Total U</strong>.
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <ol className="ledger-metric-explain-steps">
            <li>
              Let <code>K</code> be distinct <code>(account, STK contract_key)</code> pairs from in-scope stock
              executions.
            </li>
            <li>
              For each <code>k ∈ K</code>, read <code>U(k)</code> from the position map if present.
            </li>
            <li>
              <pre className="ledger-metric-explain-formula">
                {`totalUnrealized = Σ  U(k)   over k where a position row exists
  (missing position → omitted; if none exist, show em dash)`}
              </pre>
            </li>
          </ol>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              In the <strong>Total</strong> box: label <code>U</code> plus <code>fmtUsd0(totalUnrealized)</code>{' '}
              when any matching position exists.
            </li>
          </ul>
        </>
      )}
      {kind === 'stocks_total_notional' && (
        <>
          <SectionTitle n={1}>Raw data sources</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              Same execution set as the Total row: all stock executions in scope after filters.
            </li>
            <li>
              Fields: <code>quantity</code>, <code>price</code> per row.
            </li>
          </ul>
          <SectionTitle n={2}>Formula and calculation</SectionTitle>
          <pre className="ledger-metric-explain-formula">
            {`totalNotional = Σ  |quantity(e)| × price(e)
  for all stock executions e in scope`}
          </pre>
          <SectionTitle n={3}>Result on screen</SectionTitle>
          <ul className="ledger-metric-explain-list">
            <li>
              In the <strong>Total</strong> box: prefix <code>nv</code>, then the amount from{' '}
              <code>fmtUsd0(totalNotional)</code> — monospace, main text color.
            </li>
            <li>Not colored as profit/loss; it is volume, not PnL.</li>
          </ul>
        </>
      )}
      <LedgerMetricExplainLiveExample payload={payload} />
    </div>
  )
}
