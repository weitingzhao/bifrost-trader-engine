import { useCallback, useEffect, useState } from 'react'
import type { LivePositionRow, OpenOptionPosition } from '../../portfolio/types'

interface Params {
  openTab: string
  onOpenOptionDiscovery?: () => void
  onClearError: () => void
}

export function usePositionInspectors({ openTab, onOpenOptionDiscovery, onClearError }: Params) {
  const [stockInspector, setStockInspector] = useState<{
    symbol: string
    accountId: string
    position: LivePositionRow
  } | null>(null)
  const [optionInspector, setOptionInspector] = useState<OpenOptionPosition | null>(null)
  const [strategyInspectorInstanceId, setStrategyInspectorInstanceId] = useState<number | null>(null)

  const openStockInspector = useCallback((p: LivePositionRow) => {
    const sym = (p.symbol ?? '').trim().toUpperCase()
    const acc = (p.account_id ?? '').trim() || '—'
    if (!sym) return
    setOptionInspector(null)
    setStrategyInspectorInstanceId(null)
    setStockInspector({ symbol: sym, accountId: acc, position: p })
  }, [])

  const openOptionInspector = useCallback((p: OpenOptionPosition) => {
    setStockInspector(null)
    setStrategyInspectorInstanceId(null)
    onClearError()
    setOptionInspector(p)
  }, [onClearError])

  const openStrategyInspector = useCallback((strategyInstanceId: number) => {
    if (!Number.isFinite(strategyInstanceId)) return
    setStockInspector(null)
    setOptionInspector(null)
    onClearError()
    setStrategyInspectorInstanceId(strategyInstanceId)
  }, [onClearError])

  const handleNavigateOptionDiscovery = useCallback(() => {
    setOptionInspector(null)
    onOpenOptionDiscovery?.()
  }, [onOpenOptionDiscovery])

  useEffect(() => {
    setStockInspector(null)
    setOptionInspector(null)
    setStrategyInspectorInstanceId(null)
  }, [openTab])

  const closeStockInspector = useCallback(() => setStockInspector(null), [])
  const closeOptionInspector = useCallback(() => setOptionInspector(null), [])
  const closeStrategyInspector = useCallback(() => setStrategyInspectorInstanceId(null), [])

  return {
    stockInspector,
    optionInspector,
    strategyInspectorInstanceId,
    openStockInspector,
    openOptionInspector,
    openStrategyInspector,
    handleNavigateOptionDiscovery,
    closeStockInspector,
    closeOptionInspector,
    closeStrategyInspector,
  }
}
