import type { IbAccountSnapshot, StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtExpiry(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return '—'
  const s = String(raw).trim().replace(/\D/g, '')
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return raw
}

function getNetLiq(a: IbAccountSnapshot): number {
  const v = a.summary?.NetLiquidation
  if (v == null) return 0
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function rightLabel(r: string | undefined): string {
  if (!r) return '—'
  const u = String(r).toUpperCase()
  if (u === 'C' || u === 'CALL') return 'Call'
  if (u === 'P' || u === 'PUT') return 'Put'
  return r
}

function optionIntrinsic(isCall: boolean, k: number, s: number): number {
  return isCall ? Math.max(0, s - k) : Math.max(0, k - s)
}

function optionMoneyness(isCall: boolean, k: number, s: number): string {
  if (!Number.isFinite(k) || !Number.isFinite(s)) return '—'
  if (Math.abs(s - k) < 0.01) return 'ATM'
  if (isCall) return s > k ? 'ITM' : 'OTM'
  return s < k ? 'ITM' : 'OTM'
}

export interface IbAccountsPageProps {
  status: StatusResponse | null
  accountsDisplay: IbAccountSnapshot[] | null
  ibAccountIndex: number
  setIbAccountIndex: (i: number) => void
  ibAccountsRefreshing: boolean
  onRefreshAccounts: () => Promise<void>
  /** Short feedback after refresh (success/fail/timeout); cleared by parent after a few seconds */
  refreshFeedback?: string | null
}

export function IbAccountsPage({
  status,
  accountsDisplay,
  ibAccountIndex,
  setIbAccountIndex,
  ibAccountsRefreshing,
  onRefreshAccounts,
  refreshFeedback,
}: IbAccountsPageProps) {
  const j = status
  const rawAccounts = (accountsDisplay ?? j?.accounts) as IbAccountSnapshot[] | undefined
  const hasAccounts = Array.isArray(rawAccounts) && rawAccounts.length > 0
  const fetchedAt = j?.accounts_fetched_at

  if (!hasAccounts) {
    return (
      <div className="card process-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h2 style={{ margin: 0 }} className="page-title-with-tooltip">
            IB Accounts{' '}
            <InfoTooltip text="Multi-account summary & positions from DB; auto-refresh every 1h." />
          </h2>
          <button
            type="button"
            className="btn-resume"
            disabled={ibAccountsRefreshing}
            onClick={onRefreshAccounts}
            title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
          >
            {ibAccountsRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {refreshFeedback != null && refreshFeedback !== '' && (
          <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
            {refreshFeedback}
          </p>
        )}
        <p className="section-hint">
          No account data (IB not connected or daemon has not written yet; after connection, data is pulled on heartbeat and written to accounts / account_positions)
        </p>
      </div>
    )
  }

  const accounts = [...rawAccounts!].sort((a, b) => getNetLiq(b) - getNetLiq(a))
  const selectedIndex = Math.min(ibAccountIndex, accounts.length - 1)
  const acc = accounts[selectedIndex]
  const aid = acc.account_id ?? `Account-${selectedIndex + 1}`
  const sum = acc.summary ?? {}
  const netLiq = sum.NetLiquidation != null ? parseFloat(String(sum.NetLiquidation)) : undefined
  const totalCash = sum.TotalCashValue != null ? parseFloat(String(sum.TotalCashValue)) : undefined
  const buyingPower = sum.BuyingPower != null ? parseFloat(String(sum.BuyingPower)) : undefined
  const positions = acc.positions ?? []
  const stockPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() !== 'OPT')
  const optionPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() === 'OPT')
  const spot =
    status?.status?.spot != null && Number.isFinite(Number(status.status.spot))
      ? Number(status.status.spot)
      : null

  return (
    <div className="card process-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }} className="page-title-with-tooltip">
          IB Accounts{' '}
          <InfoTooltip text="Multi-account summary & positions from DB; auto-refresh every 1h." />
        </h2>
        <button
          type="button"
          className="btn-resume"
          disabled={ibAccountsRefreshing}
          onClick={onRefreshAccounts}
          title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
        >
          {ibAccountsRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {refreshFeedback != null && refreshFeedback !== '' && (
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
          {refreshFeedback}
        </p>
      )}

      {fetchedAt != null && Number.isFinite(fetchedAt) && (
        <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Data from {new Date(fetchedAt * 1000).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })}
          , {(() => {
            const sec = Math.floor(Date.now() / 1000 - fetchedAt)
            if (sec < 60) return `${sec}s ago`
            if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
            return `${(sec / 3600).toFixed(1)}h ago`
          })()}
        </p>
      )}
      {hasAccounts && (fetchedAt == null || !Number.isFinite(fetchedAt)) && (
        <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Data time unknown (click "Refresh" to have monitor fetch from IB and write to DB; fetch time will appear here)
        </p>
      )}

      <div className="ib-accounts-wrap">
        {accounts.length > 1 && (
          <div className="ib-accounts-tabs">
            {accounts.map((a, idx) => (
              <button
                key={a.account_id ?? idx}
                type="button"
                className={`ib-accounts-tab ${idx === selectedIndex ? 'active' : ''}`}
                onClick={() => setIbAccountIndex(idx)}
              >
                {a.account_id ?? `Account-${idx + 1}`}
                {(a.positions?.length ?? 0) > 0 && (
                  <span className="section-hint" style={{ marginLeft: '0.35rem', fontWeight: 'normal' }}>
                    ({a.positions!.length})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="ib-accounts-content">
          <div className="ib-summary-row">
            <div className="ib-summary-item">
              <span className="label">Account</span>
              <span className="value">{aid}</span>
            </div>
            {netLiq != null && Number.isFinite(netLiq) && (
              <div className="ib-summary-item">
                <span className="label">Net liquidation</span>
                <span className="value">{fmtUsd(netLiq)}</span>
              </div>
            )}
            {totalCash != null && Number.isFinite(totalCash) && (
              <div className="ib-summary-item">
                <span className="label">Total cash</span>
                <span className="value">{fmtUsd(totalCash)}</span>
              </div>
            )}
            {buyingPower != null && Number.isFinite(buyingPower) && (
              <div className="ib-summary-item">
                <span className="label">Buying power</span>
                <span className="value">{fmtUsd(buyingPower)}</span>
              </div>
            )}
          </div>

          <div className="ib-positions-title">Stock positions</div>
          {stockPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <table className="ib-positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Cost</th>
                    <th>Total cost</th>
                    <th>Price</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {stockPositions.map((pos, i) => {
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const totalCost = Number.isFinite(qty) && Number.isFinite(cost) ? qty * cost : null
                    const sym = (pos.symbol ?? '').toString().toUpperCase()
                    const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
                    const perPrice =
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : NaN
                    const showSpotForRow =
                      spot != null &&
                      Number.isFinite(spot) &&
                      sym !== '' &&
                      mainSym !== '' &&
                      sym === mainSym
                    const fallbackSpot = showSpotForRow ? spot : null
                    const currPrice =
                      Number.isFinite(perPrice) && perPrice > 0 ? perPrice : fallbackSpot
                    const pnl =
                      currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                        ? (currPrice - cost) * qty
                        : null
                    return (
                      <tr key={`stk-${pos.symbol}-${i}`} className="ib-pos-stock">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{totalCost != null ? fmtUsd(totalCost) : '—'}</td>
                        <td>{currPrice != null ? fmtUsd(currPrice) : '—'}</td>
                        <td>{pnl != null ? fmtUsd(pnl) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {(() => {
                const sumTotal = stockPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc + qty * cost
                  return acc
                }, 0)
                if (!Number.isFinite(sumTotal)) return null
                return (
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Stock total cost: {fmtUsd(sumTotal)}
                  </p>
                )
              })()}
            </>
          )}

          <div className="ib-positions-title" style={{ marginTop: '1rem' }}>Option positions</div>
          {optionPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <table className="ib-positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Right</th>
                    <th>Expiry</th>
                    <th>Strike</th>
                    <th>Qty</th>
                    <th>Side</th>
                    <th>Cost</th>
                    <th>Premium</th>
                    <th>Intrinsic</th>
                    <th>Moneyness</th>
                  </tr>
                </thead>
                <tbody>
                  {optionPositions.map((pos, i) => {
                    const expiryRaw = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
                    const strike = pos.strike != null ? Number(pos.strike) : NaN
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const right = (pos.right ?? '').toUpperCase()
                    const isCall = right === 'C' || right === 'CALL'
                    const premium = Number.isFinite(qty) && Number.isFinite(cost) ? -(qty * cost) : null
                    const intrinsic = spot != null && Number.isFinite(strike) ? optionIntrinsic(isCall, strike, spot) : null
                    const moneyness = spot != null && Number.isFinite(strike) ? optionMoneyness(isCall, strike, spot) : '—'
                    const sideLabel = Number.isFinite(qty) ? (qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—') : '—'
                    return (
                      <tr key={`opt-${pos.symbol}-${i}`} className="ib-pos-opt">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{rightLabel(pos.right)}</td>
                        <td>{expiryRaw ? fmtExpiry(expiryRaw) : '—'}</td>
                        <td>{Number.isFinite(strike) ? fmtUsd(strike) : '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{sideLabel}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{premium != null ? fmtUsd(premium) : '—'}</td>
                        <td>{intrinsic != null ? fmtUsd(intrinsic) : '—'}</td>
                        <td>{moneyness}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {(() => {
                const sumPremium = optionPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc - qty * cost
                  return acc
                }, 0)
                if (!Number.isFinite(sumPremium)) return null
                return (
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Option premium total: {fmtUsd(sumPremium)}
                    {spot != null && (
                      <span className="section-desc" style={{ marginLeft: '0.5rem' }}>
                        (spot {fmtUsd(spot)})
                      </span>
                    )}
                  </p>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
