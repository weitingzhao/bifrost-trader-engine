# Legacy CSS retirement tracker

Goal: remove [`frontend/src/styles/legacy.css`](../../frontend/src/styles/legacy.css) after migrating UI to Tailwind + shadcn + [`design-tokens.css`](../../frontend/src/styles/design-tokens.css).

## Metrics (run `cd frontend && npm run css:metrics`)

| Snapshot | legacy.css lines | allowlist TSX files | notes |
|----------|------------------|---------------------|-------|
| Phase 0 baseline | ~31468 | 113 | tokens extracted |
| Phase 1–4 complete | ~30963 | **74** | app header removed; waves 1–5 partial |

## Phase status

| Phase | Scope | Status |
|-------|--------|--------|
| 0 | design-tokens, metrics, lint:legacy-classes, delete sepa-data-ready.css | **Done** |
| 1 | AppLayout header, LampIndicator | **Done** |
| 2 | SectionPageTitle, SettingsShell, PageSection, DashboardStrip | **Done** (MessageCenter/Log/Modal still legacy CSS) |
| 3 | Satellite CSS partial | **Done** (inspector/settings-celery trimmed; data-readiness/screener remain) |
| 4 W1–W5 | Domain page migrations | **Partial** — major roots migrated; domain BEM (`feed-massive-*`, `sdp-*`, `celery-*`) remains |
| 5 | Delete legacy.css | **Blocked** until allowlist is empty (74 files). Gate: `npm run css:retirement:status` |

## Infrastructure added

- [`design-tokens.css`](../../frontend/src/styles/design-tokens.css) — canonical `:root` / light theme
- [`scripts/css-legacy-metrics.mjs`](../../frontend/scripts/css-legacy-metrics.mjs) — `npm run css:metrics`
- [`scripts/check-legacy-classnames.mjs`](../../frontend/scripts/check-legacy-classnames.mjs) — `npm run lint:legacy-classes` (in `npm run lint`)
- [`scripts/legacy-class-allowlist.json`](../../frontend/scripts/legacy-class-allowlist.json) — shrink with `node scripts/generate-legacy-class-allowlist.mjs` after each migration wave
- Playwright baselines: [`frontend/e2e/visual-baseline.spec.ts`](../../frontend/e2e/visual-baseline.spec.ts)
- Template 5 in [`page-templates.md`](../../frontend/src/styles/page-templates.md)

## Shared migration components

- `@/components/shared/page-section` — replaces `card process-section` roots
- `@/components/SectionPageTitle` — Tailwind breadcrumb titles
- `@/views/settings/SettingsPageCard` (+ header/section helpers) — Settings shells
- `@/components/layout/app-header-shortcuts` — app chrome
- `@/components/shared/lamp-indicator` — `LampIndicator`, `LampGlyphSlot`

## To finish Phase 5 (delete legacy.css)

1. Migrate remaining allowlist files (run `npm run css:metrics:verbose`).
2. Remove side-imports: `data-readiness.css`, `stock-screener.css`; shrink `settings-celery.css`, `stock-inspector.css` to zero.
3. Delete unused rules from `legacy.css` in domain chunks with Playwright diff.
4. Remove `@import "../styles/legacy.css"` from [`globals.css`](../../frontend/src/app/globals.css).
5. Delete `legacy.css`; set `LEGACY_CSS_RETIRED=1` in retirement gate script.

## Commands

```bash
cd frontend
npm run css:metrics
npm run css:metrics:verbose
npm run lint:legacy-classes
npm run css:retirement:status
node scripts/generate-legacy-class-allowlist.mjs   # only when intentionally refreshing baseline
npm run test:visual:update   # when dev server available
```
