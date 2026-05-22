import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Bell, BookOpen, Moon, MoreVertical, Play, SlidersHorizontal, Sun, Zap } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { postMonitorStop } from '../api/monitor/monitor'
import { celeryMetricsFromStatus } from '../views/status/celeryMetrics'
import { useSettingsApiHealthProbes } from '../hooks/useSettingsApiHealthProbes'
import { UI_BUILD_LABEL } from '../uiBuildLabel'
import { useSocketIngestProbe } from '../hooks/useSocketIngestProbe'
import { MessageCenter, type MessageCenterHandle } from '../components/MessageCenter'
import { DashboardStrip } from '../components/DashboardStrip'
import { useDashboardLamps } from '../hooks/useDashboardLamps'
import { useStreamSummaryItems } from '../hooks/useStreamSummaryItems'
import { isMassiveCommonFeedHash, isMassiveOverviewFeedHash } from '../views/massive/feedMassiveCommonTabUtils'
import { FEED_MASSIVE_DAILY_DATA_ID, isMassiveOptionFeedHash } from '../views/massive/feedMassiveTabUtils'
import { isMassiveStockFeedHash } from '../views/massive/feedMassiveStockTabUtils'
import { SettingsSidebarLampGlyph } from '../views/settings/settingsSidebarLampGlyphs'
import type { SettingsSidebarLampGlyphId } from '../views/settings/settingsSidebarLampGlyphs'
import {
  COVERAGE_OVERVIEW_SUBSECTION,
  COVERAGE_OVERVIEW_GROUP_LABEL,
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
import { aggregateDaemonProcessesHealthFromStatus } from '../utils/socketIngestLamp'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { TradingSidebar } from '@/components/layout/trading-sidebar'
import { TradingPathBreadcrumb } from '@/components/layout/trading-path-breadcrumb'
import {
  AppHeaderQueueBadge,
  AppHeaderShortcutButton,
  AppHeaderShortcutPill,
  AppHeaderStopButton,
} from '@/components/layout/app-header-shortcuts'
import { HeaderLampGlyph } from '@/components/layout/header-lamp-glyph'
import { LampGlyphSlot } from '@/components/shared/lamp-indicator'
import { TradingLayoutOutletProvider } from '../contexts/TradingLayoutOutletContext'
import { isDevBuild, publicEnv } from '@/lib/publicEnv'
import {
  settingsBasePathForHash,
  settingsHashKey,
  isDaemonSettingsHash,
  isSocketSettingsHash,
  isCelerySettingsHash,
  isCoverageOverviewHash,
  isCoverageOptionHash,
} from '@/lib/settingsSlugRouting'
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
  return 'dark'
}

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '')
  document.documentElement.classList.toggle('dark', theme !== 'light')
}

function mkdocsHandbookHref(): string {
  const explicit = publicEnv('VITE_MKDOCS_URL')?.trim()
  if (explicit) return explicit
  if (isDevBuild()) return 'http://127.0.0.1:8000/'
  return '/mkdocs/'
}

function useUrlHash(): string {
  const pathname = usePathname()
  const [urlHash, setUrlHash] = useState('')
  useEffect(() => {
    setUrlHash(window.location.hash)
    const onHash = () => setUrlHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [pathname])
  return urlHash
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

  const daemonShortcutLamp = useMemo(() => aggregateDaemonProcessesHealthFromStatus(status), [status])
  const dl = daemonShortcutLamp.lamp
  const celeryLamp: LampId = celeryRuntimeLampOverride ?? celeryMetricsFromStatus(status).celeryLamp

  const {
    marketStreamsOk,
    accountSyncLampForOpenOrders,
    dashboardStreamsLamp,
    dashboardOpenOrdersLamp,
  } = useDashboardLamps(status, quotesMap, liveLampClock)

  const streamSummaryItems = useStreamSummaryItems(status, quotesMap, benchmarks, marketStreamsOk)

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
      <div className="relative z-[1] flex min-h-svh w-full max-w-none">
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
              <div className="flex shrink-0 items-center gap-1">
                <AppHeaderShortcutPill aria-label="API settings shortcuts and stop monitor">
                  <div className="inline-flex items-center gap-px" role="toolbar" aria-label="Open Settings API pages">
                    {HEADER_API_SHORTCUTS.map(({ hash, glyph, title, lampPicker }) => {
                      const active = activeTab === 'settings' && urlHash === hash
                      const lamp = lampPicker === 'architecture' ? apiHealthProbes.architectureApiLamp : lampPicker === 'account' ? apiHealthProbes.accountApiLamp : lampPicker === 'research' ? apiHealthProbes.researchApiLamp : apiHealthProbes.massiveApiLamp
                      return (
                        <AppHeaderShortcutButton
                          key={hash}
                          active={active}
                          title={title}
                          aria-label={title}
                          onClick={() => goSettings(hash)}
                        >
                          <HeaderLampGlyph lamp={lamp}>
                            <SettingsSidebarLampGlyph id={glyph} />
                          </HeaderLampGlyph>
                        </AppHeaderShortcutButton>
                      )
                    })}
                  </div>
                  <AppHeaderStopButton
                    onClick={() => runQuickStop(postMonitorStop, 'Stop Monitor API')}
                    title="Stop Monitor API process"
                    aria-label="Stop Monitor API process"
                  />
                </AppHeaderShortcutPill>
                <AppHeaderShortcutPill aria-label="App runtime: Socket, Daemon, Celery">
                  <div className="inline-flex items-center gap-px" role="toolbar" aria-label="Socket, Daemon, Celery shortcuts">
                    <AppHeaderShortcutButton
                      active={activeTab === 'settings' && isSocketSettingsHash(urlHash)}
                      title={socketIngestProbe.title}
                      aria-label="Settings → Socket"
                      onClick={() => goSettings('#settings-ws-connector')}
                    >
                      <HeaderLampGlyph lamp={socketIngestProbe.lamp}>
                        <SettingsSidebarLampGlyph id="websocket" />
                      </HeaderLampGlyph>
                    </AppHeaderShortcutButton>
                    <AppHeaderShortcutButton
                      active={activeTab === 'settings' && isDaemonSettingsHash(urlHash)}
                      title={`${daemonShortcutLamp.title} — Settings → Daemon`}
                      aria-label="Settings → Daemon"
                      onClick={() => goSettings('#settings-daemon')}
                    >
                      <HeaderLampGlyph lamp={dl}>
                        <SettingsSidebarLampGlyph id="daemon" />
                      </HeaderLampGlyph>
                    </AppHeaderShortcutButton>
                    <AppHeaderShortcutButton
                      active={activeTab === 'settings' && isCelerySettingsHash(urlHash)}
                      title="Celery workers and queue pending — Settings → Celery"
                      aria-label="Settings → Celery"
                      onClick={() => goSettings('#settings-celery')}
                      className="inline-flex items-center gap-0.5 pr-1"
                    >
                      <HeaderLampGlyph lamp={celeryLamp}>
                        <SettingsSidebarLampGlyph id="celery" />
                      </HeaderLampGlyph>
                      <AppHeaderQueueBadge
                        value={celeryQueuePendingTotal != null ? (celeryQueuePendingTotal > 99 ? '99+' : String(celeryQueuePendingTotal)) : '—'}
                      />
                    </AppHeaderShortcutButton>
                  </div>
                </AppHeaderShortcutPill>
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
                    {activeMsgCount > 0 ? (
                      <span
                        className="absolute -right-0.5 -top-0.5 flex min-w-[1.1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[0.65rem] font-bold leading-none text-amber-950"
                        aria-hidden
                      >
                        {activeMsgCount > 99 ? '99+' : activeMsgCount}
                      </span>
                    ) : null}
                    <MoreVertical size={20} aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44 max-h-[72vh] overflow-y-auto overscroll-contain">
                  <DropdownMenuItem
                    className={cn('text-amber-400 focus:text-amber-400', activeMsgCount > 0 && 'focus:bg-amber-400/10')}
                    onClick={() => { messageCenterRef.current?.openDrawer(); setHeaderMenuOpen(false) }}
                    title={activeMsgCount > 0 ? 'View system messages' : 'View system messages (none active)'}
                  >
                    <Bell size={15} className="shrink-0" aria-hidden />
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
                        <LampGlyphSlot lamp={lamp}>
                          <SettingsSidebarLampGlyph id={glyph} />
                        </LampGlyphSlot>
                        {menuLabel}
                      </DropdownMenuItem>
                    )
                  })}

                  <DropdownMenuLabel>App</DropdownMenuLabel>
                  <DropdownMenuItem
                    className={cn('pl-6', activeTab === 'settings' && isSocketSettingsHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings('#settings-ws-connector')} title="Settings → Socket">
                    <LampGlyphSlot lamp={socketIngestProbe.lamp}>
                      <SettingsSidebarLampGlyph id="websocket" />
                    </LampGlyphSlot>
                    Socket
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={cn('pl-6', activeTab === 'settings' && isDaemonSettingsHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings('#settings-daemon')} title={`${daemonShortcutLamp.title} — Settings → Daemon`}>
                    <LampGlyphSlot lamp={dl}>
                      <Play size={14} fill="currentColor" stroke="none" aria-hidden />
                    </LampGlyphSlot>
                    Daemon
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={cn('pl-6', activeTab === 'settings' && isCelerySettingsHash(urlHash) && 'font-semibold text-accent bg-accent/10')}
                    onClick={() => goSettings('#settings-celery')} title="Settings → Celery">
                    <LampGlyphSlot lamp={celeryLamp}>
                      <Zap size={14} aria-hidden />
                    </LampGlyphSlot>
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
                    <SlidersHorizontal size={18} className="shrink-0" aria-hidden />
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
                        <Sun size={16} aria-hidden />
                      </button>
                      <button type="button" role="radio" aria-checked={theme === 'dark'}
                        className="inline-flex items-center justify-center w-8 h-7 rounded-full border-0 cursor-pointer transition-colors"
                        style={theme === 'dark'
                          ? { background: 'var(--color-accent-soft)', color: 'var(--color-accent)' }
                          : { background: 'transparent', color: 'var(--color-text-muted)' }}
                        onClick={() => { setTheme('dark'); setHeaderMenuOpen(false) }} title="Dark">
                        <Moon size={16} aria-hidden />
                      </button>
                    </div>
                  </div>

                  <DropdownMenuSeparator />
                  <div className="flex items-center gap-1 w-full px-1 py-0.5">
                    <DropdownMenuItem asChild className="flex-1">
                      <a href={mkdocsHandbookHref()} target="_blank" rel="noopener noreferrer"
                        onClick={() => setHeaderMenuOpen(false)}>
                        <BookOpen size={18} className="shrink-0" aria-hidden />
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

