# Visual regression (Playwright)

Baseline screenshots for legacy CSS retirement. Requires dev stack or `PLAYWRIGHT_SKIP_WEB_SERVER=1` with `npm run dev` already running.

```bash
cd frontend
npx playwright install chromium   # once per machine (also runs on npm install via postinstall)
npm run test:visual:update   # first time / intentional UI changes
npm run test:visual          # compare against baselines
```

Pages with SSE/polling never reach `networkidle`; baselines use `load` + a short settle delay.
If tests time out, raise `timeout` in `playwright.config.ts` or start backends so API calls finish.

Set `PLAYWRIGHT_BASE_URL` if not using port 5173.
