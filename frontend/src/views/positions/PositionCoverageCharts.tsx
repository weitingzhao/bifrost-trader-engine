import { fmtUsd } from '../../utils/format'
import { InfoTooltip } from '../../components/InfoTooltip'
import { fmtMvAbbrev } from './positionUtils'

export interface CoverageAssetPieData {
  coreStockMV: number
  fixedIncomeMV: number
  cashLikeMV: number
  cash: number | null
  bp: number | null
  denom: number
  pStock: number
  pFixedIncome: number
  pCashLike: number
  pCash: number
  pBp: number
  includeBpInChart: boolean
  includeFiInChart: boolean
  includeCashLikeInChart: boolean
  simpleCenterPct: boolean
  netLiq: number | null
}

interface Props {
  streamHostAccountId: string
  streamSecondaryAccountId: string
  account: string
  onAccountChange: (id: string) => void
  legendMode: 'pct' | 'usd'
  onLegendModeChange: (mode: 'pct' | 'usd') => void
  pieData: CoverageAssetPieData
  onIncludeBpChange: (v: boolean) => void
  onIncludeFiChange: (v: boolean) => void
  onIncludeCashLikeChange: (v: boolean) => void
}

export function PositionCoverageCharts({
  streamHostAccountId,
  streamSecondaryAccountId,
  account,
  onAccountChange,
  legendMode,
  onLegendModeChange,
  pieData,
  onIncludeBpChange,
  onIncludeFiChange,
  onIncludeCashLikeChange,
}: Props) {
  const {
    coreStockMV,
    fixedIncomeMV,
    cashLikeMV,
    cash,
    bp,
    denom,
    pStock,
    pFixedIncome,
    pCashLike,
    pCash,
    pBp,
    netLiq,
    includeBpInChart,
    includeFiInChart,
    includeCashLikeInChart,
    simpleCenterPct,
  } = pieData

  const cx = 66
  const cy = 66
  const rMid = 46
  const ringStroke = 14
  const circ = 2 * Math.PI * rMid
  let ringOff = 0
  const ringSeg = (frac: number, className: string, key: string) => {
    const len = Math.max(0, frac) * circ
    if (len < 0.5) return null
    const el = (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={rMid}
        fill="none"
        className={className}
        strokeWidth={ringStroke}
        strokeLinecap="butt"
        strokeDasharray={`${len} ${circ}`}
        strokeDashoffset={-ringOff}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    )
    ringOff += len
    return el
  }

  let centerMain = '—'
  let centerSub = ''
  let centerValClass = 'coverage-asset-pie-center-val coverage-asset-pie-center-val--basis'
  if (denom > 0) {
    if (simpleCenterPct) {
      if (legendMode === 'usd') {
        centerMain = fmtUsd(denom)
        centerSub = netLiq != null ? `Net liq. ${fmtMvAbbrev(netLiq)}` : 'Stock + cash basis'
        centerValClass = 'coverage-asset-pie-center-val coverage-asset-pie-center-val--basis'
      } else {
        centerMain = `${(pStock * 100).toFixed(1)} · ${(pCash * 100).toFixed(1)}`
        centerSub = '% of sum'
        centerValClass = 'coverage-asset-pie-center-val coverage-asset-pie-center-val--triplet'
      }
    } else if (legendMode === 'usd') {
      centerMain = fmtUsd(denom)
      centerSub = netLiq != null ? `Net liq. ${fmtMvAbbrev(netLiq)}` : 'Chart basis'
      centerValClass = 'coverage-asset-pie-center-val coverage-asset-pie-center-val--basis'
    } else {
      centerMain = '100.0%'
      centerSub =
        netLiq != null
          ? `Basis ${fmtMvAbbrev(denom)} · Net liq. ${fmtMvAbbrev(netLiq)}`
          : `Chart basis ${fmtMvAbbrev(denom)}`
      centerValClass = 'coverage-asset-pie-center-val coverage-asset-pie-center-val--basis'
    }
  } else if (netLiq != null) {
    centerMain = fmtUsd(netLiq)
    centerSub = 'Net liq.'
    centerValClass = 'coverage-asset-pie-center-val coverage-asset-pie-center-val--netliq'
  }

  const ringAriaParts = [
    'Stock (core equities)',
    includeFiInChart ? 'Fixed income' : null,
    includeCashLikeInChart ? 'Cash-like' : null,
    'Net cash',
    includeBpInChart ? 'Buying power' : null,
  ].filter(Boolean)

  return (
    <div className="coverage-charts-section pos-comp-coverage-charts">
      <div className="coverage-charts-toolbar coverage-charts-toolbar--account-mix">
        <span className="coverage-charts-toolbar-label">Account</span>
        <div
          className="coverage-section-account-filter"
          role="group"
          aria-label="Account filter for asset mix chart"
        >
          {[
            { id: 'all', label: 'All' },
            ...(streamHostAccountId ? [{ id: streamHostAccountId, label: streamHostAccountId }] : []),
            ...(streamSecondaryAccountId && streamSecondaryAccountId !== streamHostAccountId
              ? [{ id: streamSecondaryAccountId, label: streamSecondaryAccountId }]
              : []),
          ].map(opt => (
            <button
              key={opt.id}
              type="button"
              className={`coverage-asset-pie-acct-btn${account === opt.id ? ' active' : ''}`}
              onClick={() => onAccountChange(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="coverage-charts-grid">
        <div className="coverage-charts-cell coverage-asset-pie-section">
          <div
            className="coverage-asset-pie-header"
            style={{ flexWrap: 'wrap', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}
          >
            <span className="coverage-asset-pie-title">Asset mix</span>
            <InfoTooltip text="Stock = market value of non-option positions classified as core equities (same as Stocks tab; excludes ledger Fixed income and Cash-like). Fixed income / Cash-like use position category labels. Net cash = IB TotalCashValue. Buying power = IB BuyingPower. Include/Exclude changes the ring and chart basis (center main in $ mode). The sub line shows IB net liquidation for reference when known. % / $ toggles legend columns like Option charts." />
            <div
              className="coverage-asset-pie-bubble-switch"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              role="group"
              aria-label="Asset mix: percent of chart basis or dollars in legend; donut center follows mode when the ring uses full basis"
            >
              <button
                type="button"
                className={`coverage-asset-pie-bubble-btn${legendMode === 'pct' ? ' active' : ''}`}
                aria-pressed={legendMode === 'pct'}
                onClick={() => onLegendModeChange('pct')}
              >
                %
              </button>
              <button
                type="button"
                className={`coverage-asset-pie-bubble-btn${legendMode === 'usd' ? ' active' : ''}`}
                aria-pressed={legendMode === 'usd'}
                onClick={() => onLegendModeChange('usd')}
              >
                $
              </button>
            </div>
          </div>
          <div className="coverage-asset-pie-body">
            <div className="coverage-asset-pie-chart-block">
              <svg
                width={132}
                height={132}
                viewBox="0 0 132 132"
                className="coverage-asset-pie-svg"
                role="img"
                aria-label={`Ring chart: ${ringAriaParts.join(', ')} as shares of their sum`}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={rMid}
                  fill="none"
                  className="coverage-asset-pie-ring-track"
                  strokeWidth={ringStroke}
                />
                {denom > 0 ? (
                  <>
                    {ringSeg(pStock, 'coverage-asset-pie-ring-seg-stock', 'seg-stock')}
                    {includeFiInChart
                      ? ringSeg(pFixedIncome, 'coverage-asset-pie-ring-seg-fi', 'seg-fi')
                      : null}
                    {includeCashLikeInChart
                      ? ringSeg(pCashLike, 'coverage-asset-pie-ring-seg-cashlike', 'seg-cashlike')
                      : null}
                    {ringSeg(pCash, 'coverage-asset-pie-ring-seg-cash', 'seg-cash')}
                    {includeBpInChart
                      ? ringSeg(pBp, 'coverage-asset-pie-ring-seg-bp', 'seg-bp')
                      : null}
                  </>
                ) : null}
                <text
                  x={cx}
                  y={cy - 4}
                  className={centerValClass}
                  textAnchor="middle"
                  dominantBaseline="auto"
                  style={{ fontSize: '0.98rem', fill: 'var(--color-text-main, #e4e9ef)' }}
                >
                  {centerMain}
                </text>
                <text
                  x={cx}
                  y={cy + 11}
                  className="coverage-asset-pie-center-sub"
                  textAnchor="middle"
                  dominantBaseline="auto"
                  style={{ fontSize: '0.74rem', fill: 'var(--color-text-dim, #5c6572)' }}
                >
                  {centerSub}
                </text>
              </svg>
              <div className="coverage-asset-pie-bp-side">
                <div className="coverage-asset-pie-chart-toggle-row">
                  <span className="coverage-asset-pie-bp-label">Fixed income in chart</span>
                  <div
                    className="coverage-asset-pie-bubble-switch"
                    role="group"
                    aria-label="Include fixed income in ring denominator"
                  >
                    <button
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${!includeFiInChart ? ' active' : ''}`}
                      aria-pressed={!includeFiInChart}
                      onClick={() => onIncludeFiChange(false)}
                    >
                      Exclude
                    </button>
                    <button
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${includeFiInChart ? ' active' : ''}`}
                      aria-pressed={includeFiInChart}
                      onClick={() => onIncludeFiChange(true)}
                    >
                      Include
                    </button>
                  </div>
                </div>
                <div className="coverage-asset-pie-chart-toggle-row">
                  <span className="coverage-asset-pie-bp-label">Cash-like in chart</span>
                  <div
                    className="coverage-asset-pie-bubble-switch"
                    role="group"
                    aria-label="Include cash-like in ring denominator"
                  >
                    <button
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${!includeCashLikeInChart ? ' active' : ''}`}
                      aria-pressed={!includeCashLikeInChart}
                      onClick={() => onIncludeCashLikeChange(false)}
                    >
                      Exclude
                    </button>
                    <button
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${includeCashLikeInChart ? ' active' : ''}`}
                      aria-pressed={includeCashLikeInChart}
                      onClick={() => onIncludeCashLikeChange(true)}
                    >
                      Include
                    </button>
                  </div>
                </div>
                <div className="coverage-asset-pie-chart-toggle-row">
                  <span className="coverage-asset-pie-bp-label">Buying power in chart</span>
                  <div
                    className="coverage-asset-pie-bubble-switch"
                    role="group"
                    aria-label="Include buying power in ring denominator"
                  >
                    <button
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${!includeBpInChart ? ' active' : ''}`}
                      aria-pressed={!includeBpInChart}
                      onClick={() => onIncludeBpChange(false)}
                    >
                      Exclude
                    </button>
                    <button
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${includeBpInChart ? ' active' : ''}`}
                      aria-pressed={includeBpInChart}
                      onClick={() => onIncludeBpChange(true)}
                    >
                      Include
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="coverage-asset-pie-legend coverage-asset-pie-legend--asset-mix-two-col">
              <div className="coverage-asset-pie-legend-mix-col">
                <div className="coverage-asset-pie-legend-item">
                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--stock" />
                  <span className="coverage-asset-pie-legend-label">Stock</span>
                  <span className="coverage-asset-pie-legend-pct">
                    {legendMode === 'pct' ? (denom > 0 ? `${(pStock * 100).toFixed(1)}%` : '—') : '—'}
                  </span>
                  <span className="coverage-asset-pie-legend-value" title={fmtUsd(coreStockMV)}>
                    {legendMode === 'pct' ? fmtMvAbbrev(coreStockMV) : fmtUsd(coreStockMV)}
                  </span>
                </div>
                <div
                  className={`coverage-asset-pie-legend-item${!includeFiInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                  title={
                    !includeFiInChart
                      ? 'Fixed income MV is listed; not included in ring denominator.'
                      : undefined
                  }
                >
                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--fi" />
                  <span className="coverage-asset-pie-legend-label">Fixed income</span>
                  <span className="coverage-asset-pie-legend-pct">
                    {legendMode === 'pct'
                      ? includeFiInChart && denom > 0
                        ? `${(pFixedIncome * 100).toFixed(1)}%`
                        : '—'
                      : '—'}
                  </span>
                  <span className="coverage-asset-pie-legend-value" title={fmtUsd(fixedIncomeMV)}>
                    {legendMode === 'pct' ? fmtMvAbbrev(fixedIncomeMV) : fmtUsd(fixedIncomeMV)}
                  </span>
                </div>
                <div
                  className={`coverage-asset-pie-legend-item${!includeBpInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                  title={
                    !includeBpInChart
                      ? 'Buying power is listed for reference; not included in ring denominator.'
                      : undefined
                  }
                >
                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--bp" />
                  <span className="coverage-asset-pie-legend-label">Buying power</span>
                  <span className="coverage-asset-pie-legend-pct">
                    {legendMode === 'pct'
                      ? includeBpInChart && denom > 0
                        ? `${(pBp * 100).toFixed(1)}%`
                        : '—'
                      : '—'}
                  </span>
                  <span
                    className="coverage-asset-pie-legend-value"
                    title={bp != null && Number.isFinite(bp) ? fmtUsd(bp) : undefined}
                  >
                    {bp != null && Number.isFinite(bp) ? fmtUsd(bp) : '—'}
                  </span>
                </div>
              </div>
              <div className="coverage-asset-pie-legend-mix-col">
                <div
                  className={`coverage-asset-pie-legend-item${!includeCashLikeInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                  title={
                    !includeCashLikeInChart
                      ? 'Cash-like MV is listed; not included in ring denominator.'
                      : undefined
                  }
                >
                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--cashlike" />
                  <span className="coverage-asset-pie-legend-label">Cash-like</span>
                  <span className="coverage-asset-pie-legend-pct">
                    {legendMode === 'pct'
                      ? includeCashLikeInChart && denom > 0
                        ? `${(pCashLike * 100).toFixed(1)}%`
                        : '—'
                      : '—'}
                  </span>
                  <span className="coverage-asset-pie-legend-value" title={fmtUsd(cashLikeMV)}>
                    {legendMode === 'pct' ? fmtMvAbbrev(cashLikeMV) : fmtUsd(cashLikeMV)}
                  </span>
                </div>
                <div className="coverage-asset-pie-legend-item">
                  <span className="coverage-asset-pie-dot coverage-asset-pie-dot--cash" />
                  <span className="coverage-asset-pie-legend-label">Net cash</span>
                  <span className="coverage-asset-pie-legend-pct">
                    {legendMode === 'pct' ? (denom > 0 ? `${(pCash * 100).toFixed(1)}%` : '—') : '—'}
                  </span>
                  <span
                    className="coverage-asset-pie-legend-value"
                    title={cash != null && Number.isFinite(cash) ? fmtUsd(cash) : undefined}
                  >
                    {cash != null && Number.isFinite(cash)
                      ? legendMode === 'pct'
                        ? fmtMvAbbrev(cash)
                        : fmtUsd(cash)
                      : '—'}
                  </span>
                </div>
              </div>
              {denom > 0 && (
                <div className="coverage-asset-pie-legend-divider coverage-asset-pie-legend-divider--mix-full" aria-hidden />
              )}
              {denom > 0 && (
                <div className="coverage-asset-pie-legend-item coverage-asset-pie-legend-sum coverage-asset-pie-legend-sum--mix-full">
                  <span className="coverage-asset-pie-legend-label">Sum (chart basis)</span>
                  <span className="coverage-asset-pie-legend-value" title={fmtUsd(denom)}>
                    {legendMode === 'pct' ? fmtMvAbbrev(denom) : fmtUsd(denom)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
