import { useEffect, useState } from 'react'
import type { OptionSnapshotRow } from '../../api'
import {
  fetchMassiveLastTrade,
  fetchMassiveHistQuotes,
  fetchLiquiditySummary,
  fetchRelativeValue,
} from '../../api'
import type { LiquiditySummaryResponse, RelativeValueResponse } from '../../api'
import { buildPolygonOptionsTicker } from '../../utils/polygonOptionsTicker'

export function useOptionContractLiquidity(
  symbol: string,
  expiration: string,
  selectedRow: OptionSnapshotRow | null,
) {
  const [liquidityLastTrade, setLiquidityLastTrade] = useState<Record<string, unknown> | null>(null)
  const [liquidityQuoteCount, setLiquidityQuoteCount] = useState<number | null>(null)
  const [liquidityLoading, setLiquidityLoading] = useState(false)
  const [serverLiquidity, setServerLiquidity] = useState<LiquiditySummaryResponse | null>(null)
  const [serverRelativeValue, setServerRelativeValue] = useState<RelativeValueResponse | null>(null)

  useEffect(() => {
    if (selectedRow == null) {
      setLiquidityLastTrade(null)
      setLiquidityQuoteCount(null)
      setServerLiquidity(null)
      setServerRelativeValue(null)
      return
    }
    const sym = symbol.trim()
    const exp = expiration.trim()
    if (!sym || !exp) return
    const optTicker = buildPolygonOptionsTicker(sym, exp, selectedRow.strike, selectedRow.right)
    let cancelled = false
    setLiquidityLoading(true)
    Promise.allSettled([
      fetchMassiveLastTrade(optTicker),
      fetchMassiveHistQuotes(optTicker, { limit: 50 }),
      fetchLiquiditySummary(sym, exp, selectedRow.strike, selectedRow.right, 'massive'),
    ]).then(([tradeRes, quotesRes, liqRes]) => {
      if (cancelled) return
      if (tradeRes.status === 'fulfilled' && tradeRes.value.ok && tradeRes.value.results) {
        setLiquidityLastTrade(tradeRes.value.results)
      } else {
        setLiquidityLastTrade(null)
      }
      if (quotesRes.status === 'fulfilled' && quotesRes.value.ok && quotesRes.value.count != null) {
        setLiquidityQuoteCount(quotesRes.value.count)
      } else {
        setLiquidityQuoteCount(null)
      }
      if (liqRes.status === 'fulfilled' && liqRes.value.ok) {
        setServerLiquidity(liqRes.value)
      } else {
        setServerLiquidity(null)
      }
      setLiquidityLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedRow, symbol, expiration])

  useEffect(() => {
    if (selectedRow == null) {
      setServerRelativeValue(null)
      return
    }
    const sym = symbol.trim()
    const exp = expiration.trim()
    if (!sym || !exp) return
    let cancelled = false
    fetchRelativeValue(sym, exp, selectedRow.strike, selectedRow.right, 'massive')
      .then(r => {
        if (!cancelled) setServerRelativeValue(r)
      })
      .catch(() => {
        if (!cancelled) setServerRelativeValue(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedRow, symbol, expiration])

  return {
    liquidityLastTrade,
    liquidityQuoteCount,
    liquidityLoading,
    serverLiquidity,
    serverRelativeValue,
  }
}
