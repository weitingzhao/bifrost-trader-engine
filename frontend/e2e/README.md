# Visual regression (Playwright)

Baseline screenshots for legacy CSS retirement (Phase 7). Requires a running frontend; backend APIs improve fidelity but are not required for shell layout checks.

## Local

```bash
cd frontend
npx playwright install chromium   # once per machine (also runs on npm install via postinstall)
npm run test:visual:update   # first time / intentional UI changes
npm run test:visual          # compare against baselines
```

Pages with SSE/polling never reach `networkidle`; baselines use `load` + a short settle delay.

### Dynamic regions (masked)

These routes mask timestamps and live counts so baselines stay stable across polls:

| Route | Masked selectors |
|-------|------------------|
| `/live` | Dashboard strip, streams summary bar, open-orders freshness, quote / watchlist / open-order table bodies |
| `/portfolio/positions` | Pie legend values, live tabular-nums in chart columns |
| `/settings/celery` | Queue summary table (P/R/D/F counts), worker instance Dev/Prod counts |

Mask locators live in `e2e/visual-baseline.spec.ts` (`ROUTE_MASK_SELECTORS`).

Set `PLAYWRIGHT_BASE_URL` if not using port 5173.

Use `PLAYWRIGHT_SKIP_WEB_SERVER=1` when `npm run dev` (or `npm run start` after build) is already running.

If tests time out, raise `timeout` in `playwright.config.ts` or start backends so API calls finish.

## CI (GitHub Actions)

Workflow: [`.github/workflows/frontend-visual.yml`](../../.github/workflows/frontend-visual.yml)

Triggers on push to `main` (frontend paths) and `workflow_dispatch`. The job is **optional** (`continue-on-error: true`) — inspect uploaded artifacts when it fails.

Steps mirror local CI:

```bash
cd frontend
npm ci
npx playwright install chromium --with-deps
npm run build
npm run test:visual   # playwright.config uses `npm run start` when CI=true
```

Baselines are committed under `e2e/visual-baseline.spec.ts-snapshots/`. Update locally with `npm run test:visual:update` and commit snapshot diffs when UI changes are intentional.

## CSS dead-rule hints

```bash
npm run css:dead-rules
npm run css:dead-rules:verbose
```

Lists top-level CSS selectors in domain stylesheets with no matching TSX `className` token (hint only — descendants/modifiers may still apply).
