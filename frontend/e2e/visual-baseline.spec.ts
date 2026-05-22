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

      await page.goto(route, { waitUntil: 'networkidle', timeout: 90_000 })
      await page.waitForTimeout(800)

      const slug = route.replace(/\//g, '_').replace(/^_/, '') || 'root'
      await expect(page).toHaveScreenshot(`${theme}-${slug}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.02,
      })
    })
  }
}
