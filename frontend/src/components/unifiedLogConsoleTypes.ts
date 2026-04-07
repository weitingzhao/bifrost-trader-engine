import type { MouseEvent, RefObject } from 'react'

export type UnifiedLogConsoleStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface UnifiedLogConsoleEntry {
  id: number
  source: string
  line: string
}

export interface UnifiedAggregatedLogConsoleController {
  entries: UnifiedLogConsoleEntry[]
  filteredEntries: UnifiedLogConsoleEntry[]
  sourcesEnabled: Record<string, boolean>
  toggleLogSource: (source: string) => void
  status: UnifiedLogConsoleStatus
  errorDetail: string | null
  liveWarning: string | null
  clearError: string | null
  heightPx: number
  consoleRef: RefObject<HTMLPreElement>
  selectAll: () => void
  clearAllStreams: () => Promise<void>
  onResizeStart: (e: MouseEvent<HTMLDivElement>) => void
}

export type UnifiedLogSourceDefinition = { source: string; label: string }
