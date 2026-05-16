'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Cpu,
  Gauge,
  Grid3x3,
  HeartPulse,
  Landmark,
  Layers,
  LineChart,
  ListOrdered,
  PieChart,
  Radio,
  Rss,
  Scale,
  Sparkles,
  Target,
  TrendingUp,
  Wallet,
  Wrench,
} from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

const portfolioItems = [
  { title: 'Accounts', href: '/portfolio/accounts', icon: Wallet },
  { title: 'Positions', href: '/portfolio/positions', icon: PieChart },
  { title: 'Performance', href: '/portfolio/performance', icon: LineChart },
  { title: 'Model Analysis', href: '/portfolio/model-analysis', icon: BarChart3 },
  { title: 'Trade ledger', href: '/portfolio/ledger', icon: ListOrdered },
  { title: 'Transfer & Pay', href: '/portfolio/transfer', icon: Landmark },
] as const

const researchItems = [
  { title: 'Risk Model', href: '/research/risk', icon: Gauge },
  { title: 'Stock Screener', href: '/research/sepa', icon: TrendingUp },
  { title: 'Stock Data Readiness', href: '/research/stock-readiness', icon: Activity },
  { title: 'Option Screener', href: '/research/screener', icon: Target },
  { title: 'Watchlist', href: '/research/watchlist', icon: ListOrdered },
  { title: 'Option Discovery', href: '/research/options', icon: Sparkles },
  { title: 'Backtest', href: '/research/backtest', icon: LineChart },
  { title: 'IV & Greeks', href: '/research/greeks', icon: BarChart3 },
] as const

const strategyItems = [
  { title: 'Instances', href: '/strategy/instances', icon: ListOrdered },
  { title: 'Win Rate', href: '/strategy/win-rate', icon: TrendingUp },
  { title: 'Structure', href: '/strategy/structure', icon: BookOpen },
  { title: 'Opportunity', href: '/strategy/opportunity', icon: Target },
  { title: 'Allocations', href: '/strategy/allocations', icon: PieChart },
  { title: 'Gates', href: '/strategy/gates', icon: Scale },
  { title: 'Option Category', href: '/strategy/type-config', icon: Wrench },
] as const

const systemItems = [
  { title: 'Health', href: '/settings/api', icon: HeartPulse },
  { title: 'Daemon', href: '/settings/system', icon: Cpu },
  { title: 'Celery', href: '/settings/celery', icon: Layers },
  { title: 'Ingest', href: '/settings/ingest', icon: Radio },
  { title: 'Subscribe', href: '/settings/subscribe', icon: Bell },
  { title: 'Coverage', href: '/settings/coverage', icon: Grid3x3 },
  { title: 'Feed', href: '/settings/feed', icon: Rss },
  { title: 'Configure', href: '/settings/config', icon: Wrench },
] as const

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/strategy/instances') return pathname.startsWith('/strategy/instances')
  if (href === '/strategy/opportunity') return pathname.startsWith('/strategy/opportunity')
  return pathname === href || pathname.startsWith(`${href}/`)
}

function isActiveSettingsPath(pathname: string, href: string): boolean {
  const slug = href.replace('/settings/', '')
  const currentSlug = pathname.replace('/settings/', '').split('/')[0]
  if (slug === 'system' && (currentSlug === 'system' || pathname === '/settings')) return true
  if (slug === 'feed' && (currentSlug === 'feed' || currentSlug === 'massive')) return true
  if (slug === currentSlug) return true
  return false
}

export function TradingSidebar() {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Bifrost Trader">
              <Link href="/live">
                <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Image src="/img/logo.png" alt="" width={32} height={32} className="size-8 object-contain" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Bifrost Trader</span>
                  <span className="truncate text-xs text-muted-foreground">Monitor</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Market</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname.startsWith('/live')} tooltip="Live">
                  <Link href="/live">
                    <Activity className="size-4" />
                    <span>Live</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Research</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {researchItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActivePath(pathname, item.href)} tooltip={item.title}>
                    <Link href={item.href}>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Portfolio</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {portfolioItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActivePath(pathname, item.href)} tooltip={item.title}>
                    <Link href={item.href}>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Strategy</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {strategyItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActivePath(pathname, item.href)} tooltip={item.title}>
                    <Link href={item.href}>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {systemItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActiveSettingsPath(pathname, item.href)} tooltip={item.title}>
                    <Link href={item.href}>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  )
}
