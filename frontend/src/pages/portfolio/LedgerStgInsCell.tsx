import type { Execution } from '../../types'
import { executionInstanceLabel } from './ledgerOptHelpers'

function formatAllocQty(q: number): string {
  const n = Number(q)
  if (!Number.isFinite(n)) return '—'
  return n % 1 === 0 ? String(n) : String(Number(n.toFixed(6)))
}

/** Trade History details: Stg/Ins column — single instance or multi-instance allocation list. */
export function LedgerStgInsCell({ ex }: { ex: Execution }) {
  const strategyName = ex.strategy_opportunity_name?.trim()
  const allocs = ex.instance_allocations
  const hasSplits = Array.isArray(allocs) && allocs.length > 0
  const instanceId = ex.strategy_instance_id

  if (!strategyName && instanceId == null && !hasSplits) {
    return <>—</>
  }

  if (hasSplits) {
    return (
      <div className="replay-stg-ins replay-stg-ins--split">
        {strategyName ? (
          <div className="replay-stg-ins-head">
            <span className="replay-stg-ins-strategy">{strategyName}</span>
          </div>
        ) : null}
        <ul className="replay-stg-ins-alloc-list" aria-label="Instance allocations">
          {allocs!.map(a => {
            const sid = a.strategy_instance_id
            const label =
              a.strategy_instance_label?.trim() || executionInstanceLabel(ex, sid) || undefined
            const qty = a.allocated_quantity
            return (
              <li key={sid} className="replay-stg-ins-alloc-item">
                {label ? (
                  <span className="replay-stg-ins-alloc-label" title={label}>
                    {label}
                  </span>
                ) : null}
                <a
                  href={`#/strategies/instances/${sid}`}
                  className="replay-stg-ins-link replay-stg-ins-link--compact"
                  target="_blank"
                  rel="noopener noreferrer"
                  title={label ? `Open instance #${sid} (${label})` : `Open instance #${sid}`}
                  aria-label={`Open instance #${sid}`}
                >
                  #{sid}
                </a>
                <span className="replay-stg-ins-alloc-qty">{formatAllocQty(qty)}</span>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  if (instanceId != null) {
    const instLabel = executionInstanceLabel(ex, instanceId)?.trim()
    return (
      <span className="replay-stg-ins">
        {strategyName ? (
          <>
            <span className="replay-stg-ins-strategy">{strategyName}</span>
            <span className="replay-stg-ins-sep">/</span>
          </>
        ) : null}
        {instLabel ? (
          <span className="replay-stg-ins-pre-id" title={instLabel}>
            {instLabel}
          </span>
        ) : null}
        <a
          href={`#/strategies/instances/${instanceId}`}
          className="replay-stg-ins-link"
          target="_blank"
          rel="noopener noreferrer"
          title={
            instLabel
              ? `Open instance #${instanceId} (${instLabel})`
              : `Open instance #${instanceId}`
          }
          aria-label={`Open instance #${instanceId}`}
        >
          #{instanceId}
        </a>
      </span>
    )
  }

  if (strategyName) {
    return (
      <span className="replay-stg-ins">
        <span className="replay-stg-ins-strategy">{strategyName}</span>
        <span className="replay-stg-ins-sep">/</span>
        <span className="replay-stg-ins-empty">—</span>
      </span>
    )
  }

  return <>—</>
}
