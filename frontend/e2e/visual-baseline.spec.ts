import { test, expect, type Locator, type Page } from '@playwright/test'

const ROUTES = [
  '/live',
  '/portfolio/positions',
  '/portfolio/ledger',
  '/portfolio/accounts',
  '/settings/celery',
  '/research/options',
  '/strategy/instances',
] as const

const THEMES = ['dark', 'light'] as const

/** Header celery pending badge — live queue count from Ops poll. */
const HEADER_CELERY_PENDING = '[title="Queue summary Pending total"]'

/** Per-route Playwright screenshot masks for timestamps and live counts. */
const ROUTE_MASK_SELECTORS: Partial<Record<(typeof ROUTES)[number], readonly string[]>> = {
  '/live': [
    HEADER_CELERY_PENDING,
    '.dashboard-strip',
    '.live-streams-summary-bar',
    '.open-orders-freshness-badge',
    '.realtime-quotes-table tbody',
    '.live-watching-stocks-table-wrap tbody',
    '.open-orders-table tbody',
  ],
  '/portfolio/positions': [
    HEADER_CELERY_PENDING,
    '.coverage-asset-pie-legend',
    '.pos-comp-chart-col .tabular-nums',
  ],
  '/settings/celery': [
    HEADER_CELERY_PENDING,
    '[aria-label="dashboard-celery-top-queue-summary-head"] table tbody',
    '[aria-label="dashboard-celery-top-queue-summary-head"] table tfoot',
    '[aria-label="dashboard-worker-instance-situation-head"] table tbody',
  ],
}

function maskLocators(page: Page, route: (typeof ROUTES)[number]): Locator[] {
  const selectors = ROUTE_MASK_SELECTORS[route]
  if (!selectors?.length) return []
  return selectors.map((sel) => page.locator(sel))
}

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`visual baseline ${theme} ${route}`, async ({ page }) => {
      await page.addInitScript((t) => {
        document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : '')
        document.documentElement.classList.toggle('dark', t !== 'light')
      }, theme)

      // load — not networkidle (Live/Celery/Positions keep SSE or polling open)
      await page.goto(route, { waitUntil: 'load', timeout: 60_000 })
      const shell = page.locator('[data-sidebar="sidebar"], [data-slot="sidebar-inset"]').first()
      await shell.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined)
      await page.waitForTimeout(1500)

      const slug = route.replace(/\//g, '_').replace(/^_/, '') || 'root'
      const mask = maskLocators(page, route)
      await expect(page).toHaveScreenshot(`${theme}-${slug}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.02,
        ...(mask.length > 0 ? { mask } : {}),
      })
    })
  }
}
