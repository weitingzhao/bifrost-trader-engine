import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { postMonitorStop } from '../api/monitor/monitor'
import { celeryMetricsFromStatus } from '../views/status/celeryMetrics'
import { useSettingsApiHealthProbes } from '../hooks/useSettingsApiHealthProbes'
import { UI_BUILD_LABEL } from '../uiBuildLabel'
import { useSocketIngestProbe } from '../hooks/useSocketIngestProbe'
import { MessageCenter, type MessageCenterHandle } from '../components/MessageCenter'
import { isMassiveCommonFeedHash, isMassiveOverviewFeedHash } from '../views/massive/feedMassiveCommonTabUtils'
import { FEED_MASSIVE_DAILY_DATA_ID, isMassiveOptionFeedHash } from '../views/massive/feedMassiveTabUtils'
import { isMassiveStockFeedHash } from '../views/massive/feedMassiveStockTabUtils'
import { SettingsSidebarLampGlyph } from '../views/settings/settingsSidebarLampGlyphs'
import type { SettingsSidebarLampGlyphId } from '../views/settings/settingsSidebarLampGlyphs'
import {
  COVERAGE_OVERVIEW_SUBSECTION,
  COVERAGE_OVERVIEW_GROUP_LABEL,
  COVERAGE_OVERVIEW_LEGACY_ID,
  COVERAGE_OVERVIEW_SUBSECTIONS,
  COVERAGE_OVERVIEW_SUMMARY_ID,
  COVERAGE_OPTION_SUBSECTION,
  COVERAGE_STOCK_GROUP_LABEL,
  COVERAGE_STOCK_SUBSECTIONS,
  FEED_MASSIVE_COMMON_ID,
  FEED_MASSIVE_OPTION_ID,
  FEED_MASSIVE_OVERVIEW_ID,
  FEED_MASSIVE_STOCK_ID,
  FEED_SUBSECTIONS,
} from '../views/settings/settingsConstants'
import { SettingsSectionIcon } from '../views/settings/SettingsSectionIcon'
import { useApp, type LampId } from '../contexts/AppContext'
import { fmtPctCompact, fmtUsdCompact } from '../utils/format'
import { aggregateDaemonProcessesHealthFromStatus } from '../utils/socketIngestLamp'
import {
  computeAccountSyncLamp,
  computeMarketStreamsOk,
  computeOpenOrdersSectionOk,
} from '../utils/livePageLamps'
import {
  computeDailyChange,
  quoteDisplayLast,
} from '../views/accounts/accountsUtils'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { TradingSidebar } from '@/components/layout/trading-sidebar'
import { TradingPathBreadcrumb } from '@/components/layout/trading-path-breadcrumb'
import { TradingLayoutOutletProvider } from '../contexts/TradingLayoutOutletContext'
import { isDevBuild, publicEnv } from '@/lib/publicEnv'
import { settingsBasePathForHash } from '@/lib/settingsSlugRouting'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const THEME_KEY = 'bifrost-monitor-theme'

type ThemeId = 'dark' | 'light'

function loadTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'light' || t === 'dark') return t
  } catch {}
  return 'light'
}

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '')
}

function mkdocsHandbookHref(): string {
  const explicit = publicEnv('VITE_MKDOCS_URL')?.trim()
  if (explicit) return explicit
  if (isDevBuild()) return 'http://127.0.0.1:8000/'
  return '/mkdocs/'
}

function useUrlHash(): string {
  const pathname = usePathname()
  const [urlHash, setUrlHash] = useState(() => (typeof window !== 'undefined' ? window.location.hash : ''))
  useEffect(() => {
    setUrlHash(typeof window !== 'undefined' ? window.location.hash : '')
    const onHash = () => setUrlHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [pathname])
  return urlHash
}

type StreamTone = 'neutral' | 'positive' | 'negative'
interface StreamSummaryItem { label: string; value: string; tone: StreamTone }

function DashboardStrip({
  streamLamp,
  streamItems,
  onStreamClick,
  openOrderCount,
  onOpenOrdersClick,
  openOrdersLamp,
  openOrdersLampTitle,
}: {
  streamLamp: 'green' | 'yellow' | 'red' | 'none'
  streamItems: StreamSummaryItem[]
  onStreamClick?: () => void
  openOrderCount: number
  onOpenOrdersClick?: () => void
  openOrdersLamp?: 'green' | 'yellow' | 'red' | 'none'
  openOrdersLampTitle?: string
}) {
  const tickerItems =
    streamItems.length > 0
      ? [...streamItems, ...streamItems]
      : [
          { label: 'Streams', value: 'No data', tone: 'neutral' as const },
          { label: 'Streams', value: 'No data', tone: 'neutral' as const },
        ]

  return (
    <section className="card dashboard-strip" aria-label="Dashboard">
      <div className="dashboard-strip-grid">
        <div className="dashboard-open-orders-cluster" aria-label="Open orders summary">
          <button
            type="button"
            className="dashboard-open-orders-btn"
            onClick={onOpenOrdersClick}
            aria-label="Open orders"
            title="View open orders on Live page"
          >
            {openOrdersLamp != null && (
              <span
                className={`lamp-icon ${openOrdersLamp}`}
                aria-hidden
                title={
                  openOrdersLampTitle != null && openOrdersLampTitle !== ''
                    ? openOrdersLampTitle
                    : openOrdersLamp === 'green'
                      ? 'Open orders: Account Sync Daemon healthy (DB sync).'
                      : 'Open orders: Account Sync Daemon degraded or unknown.'
                }
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
              </span>
            )}
            <span className="dashboard-open-orders-label">Open orders</span>
            <span className="dashboard-open-orders-value">{openOrderCount}</span>
          </button>
        </div>
        <div className="dashboard-streams-cluster" aria-label="Market streams summary">
          <button
            type="button"
            className="dashboard-streams-inline dashboard-streams-btn"
            onClick={onStreamClick}
            aria-label="Go to Live page"
            title="Go to Live page"
          >
            <span className={`lamp-icon ${streamLamp}`} aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-4l-3 9L9 3 6 12H2" />
              </svg>
            </span>
            <div className="dashboard-streams-marquee">
              <div className="dashboard-streams-track">
                {tickerItems.map((item, index) => (
                  <span key={`${item.label}-${item.value}-${index}`} className="dashboard-streams-item">
                    <span className="dashboard-streams-item-label">{item.label}</span>
                    <span className={`dashboard-streams-item-value tone-${item.tone}`}>{item.value}</span>
                  </span>
                ))}
              </div>
            </div>
          </button>
        </div>
      </div>
    </section>
  )
}

const HEADER_API_SHORTCUTS: {
  hash: string
  glyph: SettingsSidebarLampGlyphId
  title: string
  menuLabel: string
  lampPicker: 'architecture' | 'account' | 'research' | 'massive'
}[] = [
  { hash: '#settings-api-architecture', glyph: 'api-architecture', title: 'Settings → API → Architecture', menuLabel: 'Architecture', lampPicker: 'architecture' },
  { hash: '#settings-api-account', glyph: 'api-account', title: 'Settings → API → Account', menuLabel: 'Account', lampPicker: 'account' },
  { hash: '#settings-api-research', glyph: 'api-research', title: 'Settings → API → Research', menuLabel: 'Research', lampPicker: 'research' },
  { hash: '#settings-api-massive', glyph: 'api-massive', title: 'Settings → API → Massive', menuLabel: 'Massive', lampPicker: 'massive' },
]

function headerApiShortcutLampClass(lamp: 'green' | 'yellow' | 'red' | 'none' | 'gray'): string {
  return `title-inline-lamp lamp-icon ${lamp === 'none' ? 'none' : lamp}`
}

function settingsHashKey(hash: string): string {
  return (hash.startsWith('#') ? hash.slice(1) : hash).trim()
}

function isDaemonSettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-daemon' || h === 'settings-system' || h === 'settings-system-daemon'
}

function isSocketSettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-ws-connector' || h === 'settings-market-ingest' || h === 'settings-ib-connector' || h === 'settings-ws-agent'
}

function isCelerySettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-celery' || h === 'settings-system-celery' || h === 'settings-dashboard-celery'
}

function isCoverageOverviewHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === COVERAGE_OVERVIEW_LEGACY_ID || COVERAGE_OVERVIEW_SUBSECTIONS.some(s => s.id === h)
}

function isCoverageOptionHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'coverage-option' || h === FEED_MASSIVE_DAILY_DATA_ID
}

/** Derive active tab from current pathname */
function pathnameToTabId(pathname: string): 'live' | 'research' | 'replay' | 'strategy' | 'settings' {
  if (pathname.startsWith('/portfolio')) return 'replay'
  if (pathname.startsWith('/research')) return 'research'
  if (pathname.startsWith('/strategy')) return 'strategy'
  if (pathname.startsWith('/settings')) return 'settings'
  return 'live'
}

export function TradingLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const activeTab = pathnameToTabId(pathname)
  const urlHash = useUrlHash()

  const {
    status, quotesMap, liveLampClock, benchmarks,
    systemMessages, msgDismissedIds, dismissMessage, dismissAllMessages,
    celeryRuntimeLampOverride, celeryQueuePendingTotal,
  } = useApp()

  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [headerMenuUiBuildOpen, setHeaderMenuUiBuildOpen] = useState(false)
  const [quickCtrlMsg, setQuickCtrlMsg] = useState({ text: '', isErr: false })
  const messageCenterRef = useRef<MessageCenterHandle>(null) as RefObject<MessageCenterHandle>

  const apiHealthProbes = useSettingsApiHealthProbes(true)
  const socketIngestProbe = useSocketIngestProbe(true, status)

  useEffect(() => { applyTheme(theme); try { localStorage.setItem(THEME_KEY, theme) } catch {} }, [theme])

  useEffect(() => { if (!headerMenuOpen) setHeaderMenuUiBuildOpen(false) }, [headerMenuOpen])

  const j = status
  const daemonShortcutLamp = useMemo(() => aggregateDaemonProcessesHealthFromStatus(j), [j])
  const dl = daemonShortcutLamp.lamp
  const celeryLamp: LampId = celeryRuntimeLampOverride ?? celeryMetricsFromStatus(status).celeryLamp
  const marketStreamsOk = useMemo(() => computeMarketStreamsOk(j, quotesMap), [j, quotesMap, liveLampClock])
  const accountSyncLampForOpenOrders = useMemo(() => computeAccountSyncLamp(j), [j, liveLampClock])
  const openOrdersSectionOk = useMemo(() => computeOpenOrdersSectionOk(j, Date.now() / 1000), [j, liveLampClock])
  const dashboardStreamsLamp: LampId = marketStreamsOk ? 'green' : 'red'
  const dashboardOpenOrdersLamp: LampId = openOrdersSectionOk ? 'green' : 'red'

  const watchlistSymbols = useMemo(
    () => [...new Set([...(status?.live_ui?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [status?.live_ui?.subscribed_tickers, quotesMap],
  )

  const streamSummaryItems = useMemo<StreamSummaryItem[]>(() => {
    const accountsList = status?.portfolio?.accounts ?? []
    const rows = watchlistSymbols.map((symbol) => {
      let qty = 0; let totalCost = 0; let hasCost = false
      for (const acc of accountsList) {
        for (const p of acc?.positions ?? []) {
          const sym = (p.symbol || '').trim()
          const secType = (p.secType || '').toString().toUpperCase()
          const posQty = typeof p.position === 'number' ? p.position : 0
          if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
          qty += posQty
          if (p.avgCost != null && Number.isFinite(p.avgCost as number)) {
            totalCost += (p.avgCost as number) * posQty; hasCost = true
          }
        }
      }
      const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
      const symKey = (symbol || '').trim().toUpperCase()
      const quote = quotesMap[symKey] ?? quotesMap[symbol]
      const bench = benchmarks[symKey]
      const curr = quoteDisplayLast(quote)
      const { changePct, pnlVsBench } = computeDailyChange(bench, curr, qty ?? 0)
      const pnlCost = curr != null && avgCost != null && Number.isFinite(qty) && qty !== 0 ? (curr - avgCost) * qty : null
      return { qty, avgCost, pnlCost, pnlVsBench, changePct }
    })
    const totalDailyDollar = rows.reduce((acc, row) => acc + (row.pnlVsBench != null && Number.isFinite(row.pnlVsBench) ? row.pnlVsBench : 0), 0)
    const sumLastQty = watchlistSymbols.reduce((acc, symbol, index) => {
      const qty = Number.isFinite(rows[index]?.qty) ? rows[index]!.qty : 0
      const sk = (symbol || '').trim().toUpperCase()
      const last = quoteDisplayLast(quotesMap[sk] ?? quotesMap[symbol]) ?? 0
      return acc + last * qty
    }, 0)
    const totalDailyDenom = sumLastQty - totalDailyDollar
    const totalDailyPct = totalDailyDenom > 0 && Number.isFinite(totalDailyDollar) ? (totalDailyDollar / totalDailyDenom) * 100 : null
    const toneForNumber = (value: number | null | undefined): StreamTone => {
      if (value == null || !Number.isFinite(value)) return 'neutral'
      if (value > 0) return 'positive'
      if (value < 0) return 'negative'
      return 'neutral'
    }
    return [
      { label: 'Market Streams', value: marketStreamsOk ? 'Online' : 'Offline', tone: marketStreamsOk ? 'positive' : 'negative' },
      ...watchlistSymbols.map((symbol, i) => {
        const row = rows[i]
        const pct = row?.changePct ?? null
        const dollar = row?.pnlVsBench ?? null
        const valueStr = pct != null && dollar != null ? `${fmtPctCompact(pct)} / ${fmtUsdCompact(dollar)}` : pct != null ? fmtPctCompact(pct) : dollar != null ? fmtUsdCompact(dollar) : '—'
        return { label: symbol, value: valueStr, tone: toneForNumber(pct ?? dollar) }
      }),
      { label: 'Daily %', value: fmtPctCompact(totalDailyPct), tone: toneForNumber(totalDailyPct) },
      { label: 'Daily $', value: fmtUsdCompact(totalDailyDollar), tone: toneForNumber(totalDailyDollar) },
    ]
  }, [status?.portfolio?.accounts, status?.live_ui?.reference_indices, watchlistSymbols, quotesMap, benchmarks, marketStreamsOk])

  const goSettings = useCallback((hash: string) => {
    const fullHash = hash.startsWith('#') ? hash : `#${hash}`
    const base = settingsBasePathForHash(fullHash)
    router.push(`${base}${fullHash}`)
    setHeaderMenuOpen(false)
  }, [router])

  const runQuickStop = async (api: () => Promise<{ ok?: boolean; error?: string }>, label: string) => {
    setQuickCtrlMsg({ text: `${label}…`, isErr: false })
    try {
      const r = await api()
      setQuickCtrlMsg({ text: r.ok === true ? 'Done.' : (r.error ?? 'Failed'), isErr: r.ok !== true })
    } catch (e) {
      setQuickCtrlMsg({ text: (e instanceof Error ? e.message : 'Failed'), isErr: true })
    }
    setTimeout(() => setQuickCtrlMsg({ text: '', isErr: false }), 3000)
  }

  const settingsViewSection = useMemo(() => {
    if (activeTab !== 'settings') return null
    const h = (urlHash.startsWith('#') ? urlHash.slice(1) : urlHash).trim()
    if (!h) return 'system'
    const hashNorm = urlHash.startsWith('#') ? urlHash : `#${urlHash}`
    if (isMassiveOverviewFeedHash(hashNorm) || isMassiveCommonFeedHash(hashNorm) || isMassiveOptionFeedHash(hashNorm) || isMassiveStockFeedHash(hashNorm)) return 'massive'
    if (h === FEED_MASSIVE_DAILY_DATA_ID || h === 'settings-subscribe' || h.startsWith('settings-daemon') || h.startsWith('settings-system') || h.startsWith('settings-celery') || h === 'settings-ws-connector' || h === 'settings-market-ingest' || h === 'settings-ib-connector' || h === 'settings-ws-agent' || h.startsWith('feed-') || h.startsWith('coverage-')) return 'system'
    return 'config'
  }, [activeTab, urlHash])

  const activeMsgCount = useMemo(
    () => systemMessages.filter((m) => !msgDismissedIds.has(m.message_id)).length,
    [systemMessages, msgDismissedIds],
  )

  const showDashboard = activeTab === 'live' || activeTab === 'strategy' || activeTab === 'replay' || activeTab === 'research'

  return (
    <SidebarProvider>
      <div className="app app-shell-next flex min-h-svh w-full max-w-none">
        <TradingSidebar />
        <SidebarInset className="flex min-h-svh min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-2 px-4 py-2 mb-3 border-b border-border">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="-ml-1 shrink-0" />
              <TradingPathBreadcrumb />
            </div>

            <div className="flex items-center gap-2">
              {quickCtrlMsg.text ? (
                <span className={cn(
                  'text-xs max-w-56 truncate text-right',
                  quickCtrlMsg.isErr ? 'text-destructive' : 'text-muted-foreground',
                )}>{quickCtrlMsg.text}</span>
              ) : null}
              <MessageCenter
                ref={messageCenterRef}
                messages={systemMessages}
                dismissedIds={msgDismissedIds}
                onDismiss={dismissMessage}
                onDismissAll={dismissAllMessages}
              />
              <div className="flex items-center gap-1 shrink-0">
                <div className="app-header-lamp-stop-group app-header-api-shortcuts-group" aria-label="API settings shortcuts and stop monitor">
                  <div className="app-header-api-shortcuts" role="toolbar" aria-label="Open Settings API pages">
                    {HEADER_API_SHORTCUTS.map(({ hash, glyph, title, lampPicker }) => {
                      const active = activeTab === 'settings' && urlHash === hash
                      const lamp = lampPicker === 'architecture' ? apiHealthProbes.architectureApiLamp : lampPicker === 'account' ? apiHealthProbes.accountApiLamp : lampPicker === 'research' ? apiHealthProbes.researchApiLamp : apiHealthProbes.massiveApiLamp
                      return (
                        <button key={hash} type="button" className={`app-header-api-shortcut-btn${active ? ' active' : ''}`}
                          title={title} aria-label={title} onClick={() => goSettings(hash)}>
                          <span className={headerApiShortcutLampClass(lamp)} aria-hidden>
                            <SettingsSidebarLampGlyph id={glyph} />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <button type="button" className="app-header-lamp-switch"
                    onClick={() => runQuickStop(postMonitorStop, 'Stop Monitor API')}
                    title="Stop Monitor API process" aria-label="Stop Monitor API process">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="app-header-lamp-stop-group app-header-api-shortcuts-group" aria-label="App runtime: Socket, Daemon, Celery">
                  <div className="app-header-api-shortcuts" role="toolbar" aria-label="Socket, Daemon, Celery shortcuts">
                    <button type="button" className={`app-header-api-shortcut-btn${activeTab === 'settings' && isSocketSettingsHash(urlHash) ? ' active' : ''}`}
                      title={socketIngestProbe.title} aria-label="Settings → Socket"
                      onClick={() => goSettings('#settings-ws-connector')}>
                      <span className={`title-inline-lamp lamp-icon ${socketIngestProbe.lamp === 'none' ? 'none' : socketIngestProbe.lamp}`} aria-hidden>
                        <SettingsSidebarLampGlyph id="websocket" />
                      </span>
                    </button>
                    <button type="button" className={`app-header-api-shortcut-btn${activeTab === 'settings' && isDaemonSettingsHash(urlHash) ? ' active' : ''}`}
                      title={`${daemonShortcutLamp.title} — Settings → Daemon`} aria-label="Settings → Daemon"
                      onClick={() => goSettings('#settings-daemon')}>
                      <span className={headerApiShortcutLampClass(dl)} aria-hidden>
                        <SettingsSidebarLampGlyph id="daemon" />
                      </span>
                    </button>
                    <button type="button"
                      className={`app-header-api-shortcut-btn app-header-api-shortcut-btn--celery${activeTab === 'settings' && isCelerySettingsHash(urlHash) ? ' active' : ''}`}
                      title="Celery workers and queue pending — Settings → Celery" aria-label="Settings → Celery"
                      onClick={() => goSettings('#settings-celery')}>
                      <span className={headerApiShortcutLampClass(celeryLamp)} aria-hidden>
                        <SettingsSidebarLampGlyph id="celery" />
                      </span>
                      <span className="app-header-queue-value app-header-queue-value--inline"
                        title="Queue summary Pending total">
                        {celeryQueuePendingTotal != null ? (celeryQueuePendingTotal > 99 ? '99+' : String(celeryQueuePendingTotal)) : '—'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              <DropdownMenu open={headerMenuOpen} onOpenChange={setHeaderMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className={cn('relative shrink-0 h-8 w-8', (headerMenuOpen || activeTab === 'settings') && 'bg-accent/10 border-accent text-accent-foreground')}
                    title={activeMsgCount > 0 ? `Menu — ${activeMsgCount} active messages` : 'Menu'}
                    aria-label={activeMsgCount > 0 ? `Open menu (${activeMsgCount} active messages)` : 'Open menu'}
                  >
                    {activeMsgCount > 0 && <span className="msc-bell-badge" aria-hidden>{activeMsgCount > 99 ? '99+' : activeMsgCount}</span>}
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />
                    </svg>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44 max-h-[72vh] overflow-y-auto overscroll-contain">
                  <DropdownMenuItem
                    className={cn('text-amber-400 focus:text-amber-400', activeMsgCount > 0 && 'focus:bg-amber-400/10')}
                    onClick={() => { messageCenterRef.current?.openDrawer(); setHeaderMenuOpen(false) }}
                    title={activeMsgCount > 0 ? 'View system messages' : 'View system messages (none active)'}
                  >
                    <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" className="shrink-0" aria-hidden>
                      <path d="M10 2a6 6 0 00-6 6v2.586l-1.707 1.707A1 1 0 003 14h14a1 1 0 00.707-1.707L16 10.586V8a6 6 0 00-6-6zM8.5 17a1.5 1.5 0 003 0H8.5z" />
                    </svg>
                    Messages
                    {activeMsgCount > 0 ? <span className="ml-auto text-xs font-bold bg-amber-400/20 text-amber-400 px-1.5 py-0.5 rounded-full">{activeMsgCount}</span> : null}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />

                  <DropdownMenuLabel>API</DropdownMenuLabel>
                  {HEADER_API_SHORTCUTS.map(({ hash, glyph, title, menuLabel, lampPicker }) => {
                    const lamp = lampPicker === 'architecture' ? apiHealthProbes.architectureApiLamp : lampPicker === 'account' ? apiHealthProbes.accountApiLamp : lampPicker === 'research' ? apiHealthProbes.researchApiLamp : apiHealthProbes.massiveApiLamp
                    return (
                      <DropdownMenuItem key={hash}
                        className={cn('pl-6', activeTab === 'settings' && urlHash === hash && 'font-semibold text-accent bg-accent/10')}
                        onClick={() => goSettings(hash)} title={title}>
                        <span className={headerApiShortcutLampClass(lamp)} aria-hidden>
                          <SettingsSidebarLampGlyph id={glyph} />
                        </span>
                        {menuLabel}
                      </DropdownMenuItem>
                    )
                  })}

                  <DropdownMenuLabel>App</DropdownMenuLabel>
                  <DropdownMenuItem
                    className={cn('pl-6', activeTab === 'settings' && isSocketSettingsHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings('#settings-ws-connector')} title="Settings → Socket">
                    <span className={`title-inline-lamp lamp-icon ${socketIngestProbe.lamp === 'none' ? 'none' : socketIngestProbe.lamp}`} aria-hidden>
                      <SettingsSidebarLampGlyph id="websocket" />
                    </span>
                    Socket
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={cn('pl-6', activeTab === 'settings' && isDaemonSettingsHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings('#settings-daemon')} title={`${daemonShortcutLamp.title} — Settings → Daemon`}>
                    <span className={`app-header-menu-system-lamp title-inline-lamp lamp-icon ${dl}`} aria-hidden>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
                    </span>
                    Daemon
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={cn('pl-6', activeTab === 'settings' && isCelerySettingsHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings('#settings-celery')} title="Settings → Celery">
                    <span className={`app-header-menu-system-lamp title-inline-lamp ${celeryLamp === 'none' ? 'none' : celeryLamp}`} aria-hidden>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                    </span>
                    Celery
                  </DropdownMenuItem>

                  <DropdownMenuLabel>Data Coverage</DropdownMenuLabel>
                  <DropdownMenuItem
                    className={cn(activeTab === 'settings' && isCoverageOverviewHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings(`#${COVERAGE_OVERVIEW_SUMMARY_ID}`)} title={`Settings → Data Coverage → ${COVERAGE_OVERVIEW_GROUP_LABEL} → Summary`}>
                    <SettingsSectionIcon name={COVERAGE_OVERVIEW_SUBSECTION.icon} />
                    {COVERAGE_OVERVIEW_GROUP_LABEL}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={cn(activeTab === 'settings' && isCoverageOptionHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings(`#${COVERAGE_OPTION_SUBSECTION.id}`)} title={`Settings → Data Coverage → ${COVERAGE_OPTION_SUBSECTION.label}`}>
                    <SettingsSectionIcon name={COVERAGE_OPTION_SUBSECTION.icon} />
                    {COVERAGE_OPTION_SUBSECTION.label}
                  </DropdownMenuItem>
                  <DropdownMenuLabel className="pl-5 text-[10px] tracking-widest uppercase opacity-60">{COVERAGE_STOCK_GROUP_LABEL}</DropdownMenuLabel>
                  {COVERAGE_STOCK_SUBSECTIONS.map((sub) => (
                    <DropdownMenuItem key={sub.id}
                      className={cn('pl-8', activeTab === 'settings' && settingsHashKey(urlHash) === sub.id && 'font-semibold text-accent bg-accent/10')}
                      onClick={() => goSettings(`#${sub.id}`)} title={`Settings → Data Coverage → Stock → ${sub.label}`}>
                      <SettingsSectionIcon name={sub.icon} />
                      {sub.label}
                    </DropdownMenuItem>
                  ))}

                  <DropdownMenuLabel>Feed</DropdownMenuLabel>
                  {FEED_SUBSECTIONS.map((sub) => (
                    <DropdownMenuItem key={sub.id}
                      className={cn('pl-6', activeTab === 'settings' && settingsHashKey(urlHash) === sub.id && 'font-semibold text-accent bg-accent/10')}
                      onClick={() => goSettings(`#${sub.id}`)} title={`Settings → Feed → ${sub.label}`}>
                      <SettingsSectionIcon name={sub.icon} />
                      {sub.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuLabel className="pl-5 text-[10px] tracking-widest uppercase opacity-60">Massive</DropdownMenuLabel>
                  {[
                    { id: FEED_MASSIVE_OVERVIEW_ID, label: 'Overview', icon: 'feed-massive' as const, check: isMassiveOverviewFeedHash },
                    { id: FEED_MASSIVE_STOCK_ID, label: 'Stock', icon: 'feed-massive-stock' as const, check: isMassiveStockFeedHash },
                    { id: FEED_MASSIVE_OPTION_ID, label: 'Option', icon: 'feed-massive' as const, check: isMassiveOptionFeedHash },
                    { id: FEED_MASSIVE_COMMON_ID, label: 'Comm', icon: 'feed-massive' as const, check: isMassiveCommonFeedHash },
                  ].map(({ id: mId, label: mLabel, icon, check }) => (
                    <DropdownMenuItem key={mId}
                      className={cn('pl-8', activeTab === 'settings' && check(urlHash) && 'font-semibold text-accent bg-accent/10')}
                      onClick={() => goSettings(`#${mId}`)} title={`Settings → Feed → Massive → ${mLabel}`}>
                      <SettingsSectionIcon name={icon} />
                      {mLabel}
                    </DropdownMenuItem>
                  ))}

                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className={cn(activeTab === 'settings' && settingsViewSection === 'config' && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => { goSettings('#settings-heartbeat') }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                      <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                      <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
                    </svg>
                    Settings
                  </DropdownMenuItem>

                  <div className="flex items-center justify-between gap-2 px-2 py-1.5" role="group" aria-label="Theme">
                    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground shrink-0">Theme</span>
                    <div className="inline-flex items-center p-0.5 rounded-full border border-border bg-muted shrink-0" role="radiogroup" aria-label="Color theme">
                      <button type="button" role="radio" aria-checked={theme === 'light'}
                        className="inline-flex items-center justify-center w-8 h-7 rounded-full border-0 cursor-pointer transition-colors"
                        style={theme === 'light'
                          ? { background: 'var(--color-accent-soft)', color: 'var(--color-accent)' }
                          : { background: 'transparent', color: 'var(--color-text-muted)' }}
                        onClick={() => { setTheme('light'); setHeaderMenuOpen(false) }} title="Light">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                        </svg>
                      </button>
                      <button type="button" role="radio" aria-checked={theme === 'dark'}
                        className="inline-flex items-center justify-center w-8 h-7 rounded-full border-0 cursor-pointer transition-colors"
                        style={theme === 'dark'
                          ? { background: 'var(--color-accent-soft)', color: 'var(--color-accent)' }
                          : { background: 'transparent', color: 'var(--color-text-muted)' }}
                        onClick={() => { setTheme('dark'); setHeaderMenuOpen(false) }} title="Dark">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <DropdownMenuSeparator />
                  <div className="flex items-center gap-1 w-full px-1 py-0.5">
                    <DropdownMenuItem asChild className="flex-1">
                      <a href={mkdocsHandbookHref()} target="_blank" rel="noopener noreferrer"
                        onClick={() => setHeaderMenuOpen(false)}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                          <path d="M8 7h8" /><path d="M8 11h8" />
                        </svg>
                        Docs
                      </a>
                    </DropdownMenuItem>
                    <button type="button"
                      className={cn('shrink-0 inline-flex items-center justify-center w-8 h-8 border border-border rounded-md bg-transparent text-muted-foreground cursor-pointer text-base font-bold transition-colors hover:bg-muted',
                        headerMenuUiBuildOpen && 'bg-accent/10 border-accent text-accent')}
                      onClick={() => setHeaderMenuUiBuildOpen((o) => !o)} aria-expanded={headerMenuUiBuildOpen}
                      aria-controls="app-header-menu-ui-build-panel"
                      title="Show UI build label (compare after deploy for cache / stale static files)">
                      ?
                    </button>
                  </div>
                  {headerMenuUiBuildOpen && (
                    <div className="mx-1 mb-1 px-3 py-2 rounded-md bg-muted border border-border" id="app-header-menu-ui-build-panel" role="region" aria-label="UI build">
                      <span className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">UI build</span>
                      <span className="block text-xs tabular-nums leading-tight break-all">{UI_BUILD_LABEL}</span>
                    </div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

      {showDashboard && (
        <DashboardStrip
          streamLamp={dashboardStreamsLamp}
          streamItems={streamSummaryItems}
          onStreamClick={() => router.push('/live')}
          openOrderCount={(status?.portfolio?.open_orders ?? []).length}
          onOpenOrdersClick={() => router.push('/live')}
          openOrdersLamp={dashboardOpenOrdersLamp}
          openOrdersLampTitle={`Open orders (PostgreSQL): ${accountSyncLampForOpenOrders.title}`}
        />
      )}

      <TradingLayoutOutletProvider
        value={{ celeryLamp, apiHealthProbes, socketIngestProbe }}
      >
        {children}
      </TradingLayoutOutletProvider>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
}

/** @deprecated Use `TradingLayout` — kept for incremental refactors */
export const AppLayout = TradingLayout
