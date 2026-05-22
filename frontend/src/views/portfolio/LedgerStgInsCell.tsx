import { rl } from '@/lib/replayLayout'
import { cn } from '@/lib/utils'
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
      <div className={cn(rl.stgIns, rl.stgInsSplit)}>
        {strategyName ? (
          <div className={rl.stgInsHead}>
            <span className={rl.stgInsStrategy}>{strategyName}</span>
          </div>
        ) : null}
        <ul className={rl.stgInsAllocList} aria-label="Instance allocations">
          {allocs!.map(a => {
            const sid = a.strategy_instance_id
            const label =
              a.strategy_instance_label?.trim() || executionInstanceLabel(ex, sid) || undefined
            const qty = a.allocated_quantity
            return (
              <li key={sid} className={rl.stgInsAllocItem}>
                {label ? (
                  <span className={rl.stgInsAllocLabel} title={label}>
                    {label}
                  </span>
                ) : null}
                <a
                  href={`#/strategies/instances/${sid}`}
                  className={cn(rl.stgInsLink, rl.stgInsLinkCompact)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={label ? `Open instance #${sid} (${label})` : `Open instance #${sid}`}
                  aria-label={`Open instance #${sid}`}
                >
                  #{sid}
                </a>
                <span className={rl.stgInsAllocQty}>{formatAllocQty(qty)}</span>
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
      <span className={rl.stgIns}>
        {strategyName ? (
          <>
            <span className={rl.stgInsStrategy}>{strategyName}</span>
            <span className={rl.stgInsSep}>/</span>
          </>
        ) : null}
        {instLabel ? (
          <span className={rl.stgInsPreId} title={instLabel}>
            {instLabel}
          </span>
        ) : null}
        <a
          href={`#/strategies/instances/${instanceId}`}
          className={rl.stgInsLink}
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
      <span className={rl.stgIns}>
        <span className={rl.stgInsStrategy}>{strategyName}</span>
        <span className={rl.stgInsSep}>/</span>
        <span className={rl.stgInsEmpty}>—</span>
      </span>
    )
  }

  return <>—</>
}
