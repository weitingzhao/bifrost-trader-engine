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
  | 'system'
  | 'server'
  | 'daemon'
  | 'celery'
  | 'massive-option'
  | 'reference'
  | 'snapshot'
  | 'aggregates'
  | 'greeks-iv'
  | 'daily-oi'
  | 'trades'
  | 'corporate-actions'
  | 'websocket'
  | 'celery-queue'

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
    /** Greeks / IV verify: check on circle */
    case 'greeks-iv':
      return (
        <svg {...SVG_COMMON}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
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
    /** Option trades: bidirectional exchange */
    case 'trades':
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
    /** WebSocket: radiating signal */
    case 'websocket':
      return (
        <svg {...SVG_COMMON}>
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1.5" />
        </svg>
      )
    /** Massive job queue: numbered list */
    case 'celery-queue':
      return (
        <svg {...SVG_COMMON}>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="4" cy="6" r="1.25" fill="currentColor" strokeWidth="0" />
          <circle cx="4" cy="12" r="1.25" fill="currentColor" strokeWidth="0" />
          <circle cx="4" cy="18" r="1.25" fill="currentColor" strokeWidth="0" />
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
