/**
 * Colored lamp icons in Settings sidebar (Celery row, Massive Option parent, capability subs).
 * Each glyph is chosen to match the feature (not a generic list icon).
 */
const SVG_COMMON = {
  viewBox: '0 0 24 24' as const,
  width: 12,
  height: 12,
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

export type SettingsSidebarLampGlyphId =
  | 'system-status'
  | 'dashboard'
  | 'system'
  | 'server'
  | 'daemon'
  | 'celery'
  | 'api'
  | 'api-massive'
  | 'api-monitor'
  | 'api-docs'
  | 'api-ops'
  | 'massive-option'
  | 'reference'
  | 'snapshot'
  | 'aggregates'
  | 'daily-oi'
  | 'trades-quotes'
  | 'corporate-actions'
  | 'websocket'
  | 'ws-aggregates-s'
  | 'ws-aggregates-m'
  | 'ws-quotes'
  | 'ws-trades'
  | 'fmv'
  | 'contracts'
  | 'market-ops'
  | 'technical-indicators'
  | 'flat-file-day-aggs'
  | 'flat-file-minute-aggs'
  | 'flat-file-quotes'
  | 'flat-file-trades'

export function SettingsSidebarLampGlyph({ id }: { id: SettingsSidebarLampGlyphId | string }) {
  const k = id as SettingsSidebarLampGlyphId
  switch (k) {
    /** System Status: gear + pulse (aggregated system health) */
    case 'system-status':
      return (
        <svg {...SVG_COMMON}>
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    /** Dashboard: control plane grid */
    case 'dashboard':
      return (
        <svg {...SVG_COMMON}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      )
    /** System (management / monitor): same glyph as legacy `server` id */
    case 'system':
    case 'server':
      return (
        <svg {...SVG_COMMON}>
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <circle cx="6" cy="6" r="1" fill="currentColor" strokeWidth="0" />
          <circle cx="6" cy="18" r="1" fill="currentColor" strokeWidth="0" />
        </svg>
      )
    /** Daemon: play button (engine process) */
    case 'daemon':
      return (
        <svg {...SVG_COMMON}>
          <path d="M8 5v14l11-7L8 5z" />
        </svg>
      )
    /** Celery: async workers (lightning = task execution) */
    case 'celery':
      return (
        <svg {...SVG_COMMON}>
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      )
    /** API parent (FastAPI aggregate): same zigzag as SettingsSectionIcon api */
    case 'api':
      return (
        <svg {...SVG_COMMON}>
          <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.12.12 0 0 1 .2.07v8.26h6.68a1 1 0 0 1 .78 1.63l-9.9 10.2a.12.12 0 0 1-.2-.07v-8.26H4z" />
        </svg>
      )
    /** API Massive: lightning bolt (API service) */
    case 'api-massive':
      return (
        <svg {...SVG_COMMON}>
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      )
    /** API Monitor: status / control plane (display) */
    case 'api-monitor':
      return (
        <svg {...SVG_COMMON}>
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <path d="M8 21h8" />
        </svg>
      )
    /** API Docs: merged OpenAPI documentation */
    case 'api-docs':
      return (
        <svg {...SVG_COMMON}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <path d="M8 7h8M8 11h6" />
        </svg>
      )
    /** API Ops: controls / command plane */
    case 'api-ops':
      return (
        <svg {...SVG_COMMON}>
          <path d="M12 2v5" />
          <path d="M12 17v5" />
          <path d="M4.93 4.93l3.54 3.54" />
          <path d="M15.53 15.53l3.54 3.54" />
          <path d="M2 12h5" />
          <path d="M17 12h5" />
          <path d="M4.93 19.07l3.54-3.54" />
          <path d="M15.53 8.47l3.54-3.54" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )
    /** Massive Option: options / market data trend */
    case 'massive-option':
      return (
        <svg {...SVG_COMMON}>
          <path d="M3 3v18h18" />
          <path d="m7 16 3-4 3 2 5-8 3 4" />
          <path d="M17 8h4v4" />
        </svg>
      )
    /** Reference / contracts: book / spec */
    case 'reference':
      return (
        <svg {...SVG_COMMON}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <path d="M8 7h8M8 11h6" />
        </svg>
      )
    /** Chain snapshot: 3D box / chain facet */
    case 'snapshot':
      return (
        <svg {...SVG_COMMON}>
          <path d="M12 3 3 7.5 12 12l9-4.5L12 3" />
          <path d="M3 7.5V16.5l9 4.5 9-4.5V7.5" />
          <path d="M12 12v9" />
        </svg>
      )
    /** Option aggregates (bars): OHLC bars */
    case 'aggregates':
      return (
        <svg {...SVG_COMMON}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      )
    /** Daily OI: gauge / meter */
    case 'daily-oi':
      return (
        <svg {...SVG_COMMON}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      )
    /** Trades & Quotes: bidirectional exchange */
    case 'trades-quotes':
      return (
        <svg {...SVG_COMMON}>
          <path d="M16 3h5v5" />
          <path d="M8 21H3v-5" />
          <path d="M21 3 14 10" />
          <path d="M3 21l7-7" />
        </svg>
      )
    /** Corporate actions: building / filings */
    case 'corporate-actions':
      return (
        <svg {...SVG_COMMON}>
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
          <path d="M16 7V5a4 4 0 0 0-8 0v2" />
        </svg>
      )
    /** Contracts: document with check */
    case 'contracts':
      return (
        <svg {...SVG_COMMON}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <polyline points="9 14 11 16 15 12" />
        </svg>
      )
    /** Market Ops: globe */
    case 'market-ops':
      return (
        <svg {...SVG_COMMON}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </svg>
      )
    /** Technical Indicators: line chart */
    case 'technical-indicators':
      return (
        <svg {...SVG_COMMON}>
          <path d="M3 3v18h18" />
          <path d="m7 15 3-4 3 2 4-6" />
        </svg>
      )
    /** WebSocket: radiating signal */
    case 'websocket':
      return (
        <svg {...SVG_COMMON}>
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1.5" />
        </svg>
      )
    /** WS aggregates /s and /m */
    case 'ws-aggregates-s':
    case 'ws-aggregates-m':
      return (
        <svg {...SVG_COMMON}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      )
    /** WS quotes and trades */
    case 'ws-quotes':
    case 'ws-trades':
      return (
        <svg {...SVG_COMMON}>
          <path d="M16 3h5v5" />
          <path d="M8 21H3v-5" />
          <path d="M21 3 14 10" />
          <path d="M3 21l7-7" />
        </svg>
      )
    /** FMV: diamond (fair market value) */
    case 'fmv':
      return (
        <svg {...SVG_COMMON}>
          <path d="M6 3h12l4 6-10 12L2 9l4-6z" />
          <path d="M2 9h20" />
          <path d="M10 3l-4 6 6 12 6-12-4-6" />
        </svg>
      )
    /** Flat Files: day aggregates */
    case 'flat-file-day-aggs':
      return (
        <svg {...SVG_COMMON}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="15" x2="16" y2="15" />
          <line x1="8" y1="18" x2="16" y2="18" />
        </svg>
      )
    /** Flat Files: minute aggregates */
    case 'flat-file-minute-aggs':
      return (
        <svg {...SVG_COMMON}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <circle cx="12" cy="16" r="3" />
          <path d="M12 16V14.5" />
        </svg>
      )
    /** Flat Files: quotes */
    case 'flat-file-quotes':
      return (
        <svg {...SVG_COMMON}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 17h8" />
          <path d="M9 14h6" />
        </svg>
      )
    /** Flat Files: trades */
    case 'flat-file-trades':
      return (
        <svg {...SVG_COMMON}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 17h8" />
          <path d="m10 13 2 2 2-2" />
        </svg>
      )
    default:
      return (
        <svg {...SVG_COMMON}>
          <circle cx="12" cy="12" r="4" />
        </svg>
      )
  }
}
