'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { SettingsApiHealthProbesState } from '@/hooks/useSettingsApiHealthProbes'
import type { LampId } from '@/contexts/AppContext'
import type { SocketIngestProbeState } from '@/hooks/useSocketIngestProbe'

export interface TradingLayoutOutletValue {
  celeryLamp: LampId
  apiHealthProbes: SettingsApiHealthProbesState
  socketIngestProbe: SocketIngestProbeState
}

const TradingLayoutOutletCtx = createContext<TradingLayoutOutletValue | null>(null)

export function TradingLayoutOutletProvider({
  value,
  children,
}: {
  value: TradingLayoutOutletValue
  children: ReactNode
}) {
  return <TradingLayoutOutletCtx.Provider value={value}>{children}</TradingLayoutOutletCtx.Provider>
}

export function useTradingLayoutOutlet(): TradingLayoutOutletValue {
  const v = useContext(TradingLayoutOutletCtx)
  if (!v) {
    throw new Error('useTradingLayoutOutlet must be used within TradingLayoutOutletProvider')
  }
  return v
}
