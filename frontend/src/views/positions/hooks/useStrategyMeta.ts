import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PositionInstanceAttribution } from '../../../types'
import { fetchPositionAttribution } from '../../../api/trading/executions'
import { fetchOpportunities, fetchStructures } from '../../../api/strategy/strategies'
import type { StrategyOpportunity, StrategyStructure } from '../../../api/strategy/strategies'

export function useStrategyMeta() {
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [structures, setStructures] = useState<StrategyStructure[]>([])

  const loadStrategyMeta = useCallback(async () => {
    try {
      const [oppRes, strRes] = await Promise.all([
        fetchOpportunities(false),
        fetchStructures(false),
      ])
      setOpportunities(oppRes.items ?? [])
      setStructures(strRes.items ?? [])
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { loadStrategyMeta() }, [loadStrategyMeta])

  const [attributions, setAttributions] = useState<PositionInstanceAttribution[]>([])
  const loadAttributions = useCallback(async () => {
    try {
      const res = await fetchPositionAttribution()
      setAttributions(res.attributions ?? [])
    } catch { /* non-critical: falls back to empty → unassigned */ }
  }, [])

  const oppMap = useMemo(() => {
    const m = new Map<number, StrategyOpportunity>()
    for (const o of opportunities) m.set(o.strategy_opportunity_id, o)
    return m
  }, [opportunities])

  const structureMap = useMemo(() => {
    const m = new Map<number, StrategyStructure>()
    for (const s of structures) m.set(s.strategy_structure_id, s)
    return m
  }, [structures])

  return { opportunities, structures, attributions, loadStrategyMeta, loadAttributions, oppMap, structureMap }
}
