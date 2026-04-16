import { Fragment, useCallback, useMemo, useState } from 'react'
import type { Execution, OptExecutionGroup, OptionStockLinkRow, OptionStockLinkSummary } from '../../../types'
import { fmtTsShort, fmtUsd } from '../../../utils/format'
import { buildOptExecutionGroups } from '../../portfolio/buildOptExecutionGroups'
import {
  collectLinkIdsForOptGroup,
  flattenLinksForOptGroup,
  getOptionStockLinkDetailForExecution,
  instanceAttributedSlippageForFill,
  instanceAttributedStockSlippageForOptGroup,
  ledgerOptDetailRowPnlInstanceSlice,
  sumInstanceGroupDisplayRealizedPnl,
} from '../../portfolio/ledgerOptHelpers'
import { ViewOptionStockLinksModal } from '../../portfolio/ViewOptionStockLinksModal'
import { InstanceAllocationSplitIcon } from './InstanceAllocationSplitIcon'

export type ExecutionSourceTab = 'performance_book' | 'tws_raw'

function formatStrike(strike: number | undefined | null): string {
  if (strike == null || !Number.isFinite(Number(strike))) return '—'
  const n = Number(strike)
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}

function formatAvg(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—'
  return p.toFixed(2)
}

function contractLabel(g: OptExecutionGroup): string {
  const t = g.trades[0]
  const sym = (t?.symbol ?? '').trim().split(/\s+/)[0] ?? ''
  const r = (t?.option_right ?? '').toString().toUpperCase().slice(0, 1) || '—'
  return `${sym} ${g.expiry ?? '—'} ${formatStrike(g.strike)} ${r}`.trim()
}

function ExecutionFillsTable({
  rows,
  source,
  splitMetaByExecId,
  optionStockLinkByOptionId,
  parentOptQtyByExecId,
  onViewOptionStockLinks,
}: {
  rows: Execution[]
  source: ExecutionSourceTab
  splitMetaByExecId?: Map<number, { ratioLabel: string; tooltip: string }>
  optionStockLinkByOptionId: Record<number, OptionStockLinkSummary>
  parentOptQtyByExecId: Map<number, number>
  onViewOptionStockLinks: (
    linkRows: OptionStockLinkRow[],
    title: string,
    slippageTotal: number | null,
    instanceAttributedSlippage: number | null,
  ) => void
}) {
  const isTwsRaw = source === 'tws_raw'
  if (rows.length === 0) return null
  return (
    <div className="table-wrapper instance-detail-fills-wrap">
      <table className="data-table instance-detail-fills-table">
        <thead>
          <tr>
            <th>Contract</th>
            <th>Date</th>
            {!isTwsRaw ? (
              <>
                <th>Report</th>
                <th>Txn type</th>
              </>
            ) : (
              <>
                <th>Expiry</th>
                <th>Strike</th>
              </>
            )}
            <th>Side</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Realized PnL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const execId =
              e.account_executions_id != null && Number.isFinite(Number(e.account_executions_id))
                ? Number(e.account_executions_id)
                : null
            const splitMeta =
              !isTwsRaw && execId != null && splitMetaByExecId != null
                ? splitMetaByExecId.get(execId)
                : undefined
            const optLedger =
              (e.sec_type ?? '').toUpperCase() === 'OPT' && execId != null
                ? ledgerOptDetailRowPnlInstanceSlice(
                    e,
                    parentOptQtyByExecId.get(execId),
                    optionStockLinkByOptionId,
                  )
                : null
            const realizedDisplay =
              optLedger != null
                ? fmtUsd(optLedger.displayPnl)
                : e.realized_pnl != null
                  ? fmtUsd(e.realized_pnl)
                  : '—'
            const realizedTitle = optLedger?.hasCombinedStock
              ? 'Option premium economics + prorated linked-stock slippage (Trade Ledger)'
              : undefined
            const stockLinkDetail =
              execId != null && (e.sec_type ?? '').toUpperCase() === 'OPT'
                ? getOptionStockLinkDetailForExecution(e, optionStockLinkByOptionId)
                : { linkIds: [] as number[], links: [] as OptionStockLinkRow[], slippageTotal: null as number | null }
            const fillStockAttr =
              execId != null && (e.sec_type ?? '').toUpperCase() === 'OPT'
                ? instanceAttributedSlippageForFill(e, parentOptQtyByExecId, optionStockLinkByOptionId)
                : null
            const detailTitle = `${(e.symbol ?? '').trim().split(/\s+/)[0] ?? '—'} ${formatStrike(e.strike)}`.trim()
            return (
              <tr key={`${e.account_executions_id ?? ''}-${e.exec_id ?? ''}-${e.time ?? ''}`}>
                <td>
                  {e.symbol ?? '—'}
                  {e.account_executions_id != null ? (
                    <span className="instance-detail-exec-id muted" title={`account_executions_id: ${e.account_executions_id}`}>
                      {' '}
                      #{e.account_executions_id}
                    </span>
                  ) : null}
                  {splitMeta != null ? (
                    <>
                      <InstanceAllocationSplitIcon title={splitMeta.tooltip} />
                      <span
                        className="muted instance-detail-split-ratio"
                        title={splitMeta.tooltip}
                      >
                        {splitMeta.ratioLabel}
                      </span>
                    </>
                  ) : null}
                  {stockLinkDetail.linkIds.length > 0 ? (
                    <span className="ledger-opt-link-stock-badges">
                      {stockLinkDetail.linkIds.map((lid) => (
                        <button
                          key={lid}
                          type="button"
                          className="ledger-opt-link-stock-badge"
                          title="View linked stock executions"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            onViewOptionStockLinks(
                              stockLinkDetail.links,
                              `Link #${lid} · Exec #${e.account_executions_id ?? '?'} · ${detailTitle}`,
                              stockLinkDetail.slippageTotal,
                              fillStockAttr,
                            )
                          }}
                        >
                          #{lid}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </td>
                <td>{e.trade_date ?? (e.time != null ? fmtTsShort(e.time) : '—')}</td>
                {!isTwsRaw ? (
                  <>
                    <td>{e.report_date ?? '—'}</td>
                    <td>{e.transaction_type ?? '—'}</td>
                  </>
                ) : (
                  <>
                    <td>{e.expiry != null && String(e.expiry).trim() !== '' ? String(e.expiry) : '—'}</td>
                    <td>{formatStrike(e.strike)}</td>
                  </>
                )}
                <td>{e.side ?? '—'}</td>
                <td className="tabular-nums">
                  {e.quantity == null || !Number.isFinite(Number(e.quantity))
                    ? '—'
                    : isTwsRaw
                      ? String(Math.abs(Number(e.quantity)))
                      : String(e.quantity)}
                </td>
                <td className="tabular-nums">{e.price != null ? Number(e.price).toFixed(2) : '—'}</td>
                <td className="tabular-nums" title={realizedTitle}>
                  {realizedDisplay}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function InstanceExecutionsPanel({
  loading,
  executionsFinal,
  executionsTws,
  splitMetaByExecId,
  optionStockLinkByOptionId,
  parentOptQtyByExecId,
}: {
  loading: boolean
  executionsFinal: Execution[]
  executionsTws: Execution[]
  splitMetaByExecId: Map<number, { ratioLabel: string; tooltip: string }>
  optionStockLinkByOptionId: Record<number, OptionStockLinkSummary>
  parentOptQtyByExecId: Map<number, number>
}) {
  const [tab, setTab] = useState<ExecutionSourceTab>('performance_book')
  const [stockModal, setStockModal] = useState<{
    open: boolean
    title: string
    rows: OptionStockLinkRow[]
    slippageTotal: number | null
    instanceAttributedSlippage: number | null
  }>({
    open: false,
    title: '',
    rows: [],
    slippageTotal: null,
    instanceAttributedSlippage: null,
  })

  const openViewStockLinks = useCallback(
    (
      rows: OptionStockLinkRow[],
      title: string,
      slippageTotal: number | null,
      instanceAttributedSlippage: number | null,
    ) => {
      setStockModal({ open: true, title, rows, slippageTotal, instanceAttributedSlippage })
    },
    [],
  )

  const activeRows = tab === 'performance_book' ? executionsFinal : executionsTws

  const groups = useMemo(() => buildOptExecutionGroups(activeRows), [activeRows])

  const nonOptRows = useMemo(
    () => activeRows.filter((e) => (e.sec_type ?? '').toUpperCase() !== 'OPT'),
    [activeRows],
  )

  if (loading) {
    return (
      <section className="detail-block instance-detail-executions">
        <h3 className="instance-detail-section-title">Executions</h3>
        <p className="muted">Loading executions…</p>
      </section>
    )
  }

  const tabHint =
    tab === 'performance_book'
      ? 'account_executions_final (Flex + journal). Contract-level buy/sell summary with fill rows below each contract. Split executions show this instance share only. OPT Realized PnL includes linked-stock slippage when links exist (Trade Ledger layer).'
      : 'executions_raw_tws (synthetic negative ids). Same grouping with fills below each contract. OPT Realized PnL includes linked-stock slippage when links exist.'

  return (
    <section className="detail-block instance-detail-executions">
      <h3 className="instance-detail-section-title">Executions</h3>
      <div className="instance-detail-exec-tabs" role="tablist" aria-label="Execution source">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'performance_book'}
          className={`instance-detail-exec-tab ${tab === 'performance_book' ? 'active' : ''}`}
          onClick={() => setTab('performance_book')}
        >
          Performance book
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tws_raw'}
          className={`instance-detail-exec-tab ${tab === 'tws_raw' ? 'active' : ''}`}
          onClick={() => setTab('tws_raw')}
        >
          TWS client
        </button>
      </div>
      <p className="muted instance-detail-exec-hint" title={tabHint}>
        {tab === 'performance_book'
          ? 'Final book: contract buy/sell match; fill-level rows follow each contract.'
          : 'TWS raw: positive qty with Side; fills listed under each contract.'}
      </p>

      {activeRows.length === 0 ? (
        <p className="muted">No executions for this instance in this source.</p>
      ) : (
        <>
          {groups.length > 0 && (
            <div className="table-wrapper instance-detail-match-wrap">
              <table className="data-table instance-detail-match-table">
                <thead>
                  <tr>
                    <th className="instance-detail-match-th-buy">Buy</th>
                    <th className="instance-detail-match-th-center">Contract / net</th>
                    <th className="instance-detail-match-th-sell">Sell</th>
                    <th className="tabular-nums">Group PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const matched = g.status === 'realized'
                    const linkIds = collectLinkIdsForOptGroup(g, optionStockLinkByOptionId)
                    const linkRows = flattenLinksForOptGroup(g, optionStockLinkByOptionId)
                    let linkSlippageSum: number | null = null
                    if (linkIds.length > 0) {
                      let s = 0
                      let anySl = false
                      const seenOid = new Set<number>()
                      for (const ex of g.trades ?? []) {
                        const oid = ex.account_executions_id
                        if (oid == null || seenOid.has(oid)) continue
                        seenOid.add(oid)
                        const t = optionStockLinkByOptionId[oid]?.slippage_total
                        if (t != null && Number.isFinite(t)) {
                          s += t
                          anySl = true
                        }
                      }
                      linkSlippageSum = anySl ? s : null
                    }
                    const instanceAttrGroup = instanceAttributedStockSlippageForOptGroup(
                      g,
                      optionStockLinkByOptionId,
                      parentOptQtyByExecId,
                    )
                    const groupStockIcon =
                      linkIds.length > 0 ? (
                        <button
                          type="button"
                          className="ledger-opt-link-stock-aggregate-icon"
                          title="Linked stock fills — open details"
                          aria-label="Linked stock fills"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            openViewStockLinks(
                              linkRows,
                              `Linked stocks · ${contractLabel(g)}`,
                              linkSlippageSum,
                              instanceAttrGroup,
                            )
                          }}
                        >
                          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M3 18h6v-6H3v6zm9-12h6V3h-6v3zM3 8h6V3H3v5zm9 10h6v-6h-6v6z" />
                            <path d="M14 9h2M9 14v2" />
                          </svg>
                        </button>
                      ) : null
                    return (
                      <Fragment key={g.contract_key}>
                        <tr className={`instance-detail-match-row ${matched ? 'is-matched' : ''}`}>
                          <td className="instance-detail-match-buy">
                            <div className="instance-detail-match-stack">
                              <span>
                                <span className="muted">Qty</span>{' '}
                                <span className="tabular-nums">{g.buy_volume.toFixed(4).replace(/\.?0+$/, '')}</span>
                              </span>
                              <span>
                                <span className="muted">Avg</span>{' '}
                                <span className="tabular-nums">{formatAvg(g.buy_avg_price)}</span>
                              </span>
                              <span>
                                <span className="muted">$</span>{' '}
                                <span>{fmtUsd(g.buy_cost)}</span>
                              </span>
                            </div>
                          </td>
                          <td className="instance-detail-match-center">
                            <div className="instance-detail-contract-title instance-detail-contract-title-with-stock">
                              <span>{contractLabel(g)}</span>
                              {groupStockIcon}
                            </div>
                            <div className="instance-detail-net-line">
                              <span className="muted">Net</span>{' '}
                              <span className="tabular-nums instance-detail-net-qty">{g.net_qty.toFixed(4).replace(/\.?0+$/, '')}</span>
                              <span
                                className={`instance-detail-status-chip ${matched ? 'is-flat' : 'is-open'}`}
                                title={matched ? 'Flat net qty for this contract' : 'Open net qty'}
                              >
                                {matched ? 'Matched' : 'Open'}
                              </span>
                            </div>
                          </td>
                          <td className="instance-detail-match-sell">
                            <div className="instance-detail-match-stack">
                              <span>
                                <span className="muted">Qty</span>{' '}
                                <span className="tabular-nums">{g.sell_volume.toFixed(4).replace(/\.?0+$/, '')}</span>
                              </span>
                              <span>
                                <span className="muted">Avg</span>{' '}
                                <span className="tabular-nums">{formatAvg(g.sell_avg_price)}</span>
                              </span>
                              <span>
                                <span className="muted">$</span>{' '}
                                <span>{fmtUsd(g.sell_premium)}</span>
                              </span>
                            </div>
                          </td>
                          <td
                            className="tabular-nums"
                            title="Premium match PnL plus prorated linked-stock slippage per fill (same as Trade Ledger layer)"
                          >
                            {fmtUsd(
                              sumInstanceGroupDisplayRealizedPnl(g, optionStockLinkByOptionId, parentOptQtyByExecId),
                            )}
                          </td>
                        </tr>
                        <tr className="instance-detail-match-detail-row">
                          <td colSpan={4}>
                            <ExecutionFillsTable
                              rows={g.trades}
                              source={tab}
                              splitMetaByExecId={tab === 'performance_book' ? splitMetaByExecId : undefined}
                              optionStockLinkByOptionId={optionStockLinkByOptionId}
                              parentOptQtyByExecId={parentOptQtyByExecId}
                              onViewOptionStockLinks={openViewStockLinks}
                            />
                          </td>
                        </tr>
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {nonOptRows.length > 0 && (
            <div className="instance-detail-non-opt">
              <h4 className="instance-detail-subheading">Other instruments</h4>
              <ExecutionFillsTable
                rows={nonOptRows}
                source={tab}
                splitMetaByExecId={tab === 'performance_book' ? splitMetaByExecId : undefined}
                optionStockLinkByOptionId={optionStockLinkByOptionId}
                parentOptQtyByExecId={parentOptQtyByExecId}
                onViewOptionStockLinks={openViewStockLinks}
              />
            </div>
          )}
        </>
      )}
      <ViewOptionStockLinksModal
        open={stockModal.open}
        title={stockModal.title}
        rows={stockModal.rows}
        slippageTotal={stockModal.slippageTotal}
        instanceAttributedSlippage={stockModal.instanceAttributedSlippage}
        onClose={() =>
          setStockModal({
            open: false,
            title: '',
            rows: [],
            slippageTotal: null,
            instanceAttributedSlippage: null,
          })
        }
      />
    </section>
  )
}
