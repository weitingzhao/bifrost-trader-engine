import { useMemo } from 'react'
import type { IbAccountSnapshot, StatusResponse } from '../../types'

/** Bar candidate symbols from positions (Watchlist can be merged later). */
export function useBarCandidateSymbols(status: StatusResponse | null): string[] {
  return useMemo(() => {
    const fromAccounts = (status?.portfolio?.accounts || []).flatMap((acc: IbAccountSnapshot) =>
      (acc.positions || []).map(p => p.symbol).filter((s): s is string => Boolean(s?.trim())),
    )
    return [...new Set(fromAccounts)].sort()
  }, [status?.portfolio?.accounts])
}
