'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

const CRUMB_LABEL: Record<string, string> = {
  live: 'Live',
  portfolio: 'Portfolio',
  accounts: 'Accounts',
  positions: 'Positions',
  performance: 'Performance',
  'model-analysis': 'Model Analysis',
  ledger: 'Trade ledger',
  transfer: 'Transfer & Pay',
  research: 'Research',
  risk: 'Risk Model',
  screener: 'Option Screener',
  sepa: 'Stock Screener',
  'stock-readiness': 'Stock Data Readiness',
  backtest: 'Backtest',
  options: 'Option Discovery',
  greeks: 'IV & Greeks',
  watchlist: 'Watchlist',
  strategy: 'Strategy',
  structure: 'Structure',
  opportunity: 'Opportunity',
  instances: 'Instances',
  'win-rate': 'Win Rate',
  allocations: 'Allocations',
  gates: 'Gates',
  'type-config': 'Option Category',
  settings: 'Settings',
  system: 'System',
  config: 'Config',
  api: 'API',
  coverage: 'Coverage',
  feed: 'Feed',
  massive: 'Massive',
  celery: 'Celery',
  subscribe: 'Subscribe',
  ingest: 'Ingest',
}

function labelForSegment(seg: string): string {
  return CRUMB_LABEL[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function TradingPathBreadcrumb() {
  const pathname = usePathname()
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) {
    return null
  }
  const cumulative = segments.map((_, i) => `/${segments.slice(0, i + 1).join('/')}`)

  return (
    <Breadcrumb className="hidden min-w-0 md:block">
      <BreadcrumbList className="text-xs">
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1
          const href = cumulative[i]!
          const label = labelForSegment(seg)
          return (
            <span key={href} className="contents">
              {i > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem className="max-w-[10rem] truncate sm:max-w-[14rem]">
                {isLast ? (
                  <BreadcrumbPage title={label}>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={href} title={label} className="truncate">
                      {label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </span>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
