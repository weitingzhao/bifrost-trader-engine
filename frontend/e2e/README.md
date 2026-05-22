# Visual regression (Playwright)

Baseline screenshots for legacy CSS retirement. Requires dev stack or `PLAYWRIGHT_SKIP_WEB_SERVER=1` with `npm run dev` already running.

```bash
cd frontend
npx playwright install chromium
npm run test:visual:update   # first time / intentional UI changes
npm run test:visual          # compare against baselines
```

Set `PLAYWRIGHT_BASE_URL` if not using port 5173.
