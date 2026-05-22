import { test, expect } from '@playwright/test'

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
      await expect(page).toHaveScreenshot(`${theme}-${slug}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.02,
      })
    })
  }
}
