import { useEffect, useState } from 'react'
import type { RealtimeQuote } from '../../../types'
import { fetchQuotes, subscribeQuotes } from '../../../api'
import { mergeQuotesIntoSymbolMap } from '../../accounts/accountsUtils'

export function useQuotesSubscription(): Record<string, RealtimeQuote> {
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then(res => {
        if (!cancelled) {
          setQuotesMap(() => {
            const map = mergeQuotesIntoSymbolMap({}, res.quotes || [])
            for (const q of res.quotes || []) {
              if (q.contract_key && (q.sec_type ?? '').toUpperCase() === 'OPT')
                map[q.contract_key] = q
            }
            return map
          })
        }
      })
      .catch(() => { if (!cancelled) setQuotesMap({}) })
    const unsub = subscribeQuotes(q => {
      setQuotesMap(prev => {
        const next = mergeQuotesIntoSymbolMap(prev, [q])
        if (q.contract_key && (q.sec_type ?? '').toUpperCase() === 'OPT')
          next[q.contract_key] = q
        return next
      })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return quotesMap
}
