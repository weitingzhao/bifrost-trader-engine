# Legacy CSS retirement tracker

Goal: **CSS debt zero** — Tailwind + shadcn + design tokens only, plus explicitly allowed component CSS.

## Phase status

| Phase | Scope | Status |
|-------|--------|--------|
| 0–6 | Delete `legacy.css`, allowlist 0, banned tokens | **Done** |
| **7** | Delete `app-surfaces` + satellite BEM CSS | **Done** (Wave 9, 2026-05-21) |

## Phase 7 Done definition

1. `globals.css` does not import: `app-surfaces`, `feed-massive`, `settings-celery`, `data-readiness`, `stock-screener`, `stock-inspector`.
2. Those files are deleted from the repo.
3. Global base lives in [`tailwind-base.css`](../../frontend/src/styles/tailwind-base.css).
4. Domain BEM line count **&lt; 500** (including allowed component CSS).
5. `lint:legacy-classes` passes; Playwright baselines committed.

## Allowed component CSS (explicit registry)

| File | Purpose | Budget |
|------|---------|--------|
| [`message-center.css`](../../frontend/src/styles/message-center.css) | Toast/drawer animations | ~400 lines |
| [`log-console.css`](../../frontend/src/styles/log-console.css) | Optional — only if Wave 1 needs it | TBD |
| [`option-discovery-chrome.css`](../../frontend/src/styles/option-discovery-chrome.css) | ~~Optional — strike ladder~~ **Not used** (Wave 7: ~72 strike-ladder rules → full Tailwind in `optionDiscoveryClasses.ts`) | — |

New entries require a line in this table before merge.

## Current CSS layout (CSS debt zero)

| File | Lines (approx) | Status |
|------|----------------|--------|
| `tailwind-base.css` | ~61 | Keep |
| `design-tokens.css` | 177 | Keep |
| `shadcn-tokens.css` | 100 | Keep |
| `message-center.css` | 381 | Keep |
| `wave9Classes.ts` | ~450 | Tailwind tokens (generated from deleted `app-surfaces.css`) |
| ~~`app-surfaces.css`~~ | ~~9,838~~ | **Deleted** |
| ~~`feed-massive.css`~~ | — | **Deleted** (Wave 6–8) |
| ~~`settings-celery.css`~~ | — | **Deleted** (Wave 6–8) |
| ~~`data-readiness.css`~~ | — | **Deleted** (Wave 6–8) |
| ~~`stock-screener.css`~~ | — | **Deleted** (Wave 6–8) |
| ~~`stock-inspector.css`~~ | — | **Deleted** (Wave 6–8) |

Load order: [`globals.css`](../../frontend/src/app/globals.css) — Tailwind → tokens → **tailwind-base** → message-center → shadcn.

## Metrics

```bash
cd frontend
npm run css:retirement:status
npm run css:dead-rules:verbose
npm run lint:legacy-classes
npx playwright install chromium
npm run test:visual:update   # intentional UI changes
npm run test:visual
```

## Shared migration components

- `@/components/shared/page-section` — `PageSection`
- `@/components/SectionPageTitle` — `SECTION_TITLE_CLASS`
- `@/components/ui/*` — Button, Dialog, Select, Table
- `@/components/shared/lamp-indicator` — lamps
- `@/components/shared/data-table` — tables
- `@/components/shared/exec-row-buttons` — portfolio row actions
- `@/components/shared/appUi.ts` — app-tab pills, table pagination, data-table wrap, section hints, PnL tones
- `@/lib/replayLayout.ts` — `rl` portfolio / ledger / positions / live replay UI
- `@/styles/wave9Classes.ts` — `w9` residual app-surfaces tokens (Wave 9)
- `@/views/status/statusUi.tsx` — daemon groups, system tabs, event-subscribe tables
- `@/views/settings/settingsUi.ts` — IB config / holidays / heartbeat blocks
- `@/views/performance/performanceUi.ts` — Performance summary, filters, growth, calendar tables
- `@/views/gates/gatesUi.ts` — GatesConfig form + list table
- `@/views/strategy/strategyWinRateUi.ts` — Strategy win-rate cards
- `@/components/risk/riskScenarioUi.ts` — RiskProfileDl scenario matrix + help portal
- `@/views/dataOverview/dataOverviewClasses.ts` — `dov`
- `@/views/massive/refJobsClasses.ts` — `rj`
- `@/views/feed/feedMassiveStyles.ts` — `fm`
- `@/views/celery/celeryUi.tsx` — Celery sections + tables
- `@/views/optionDiscovery/optionDiscoveryClasses.ts` — `od`

## Phase 7 Wave 9 (2026-05-21)

**Done.** Deleted `app-surfaces.css` (~9,838 lines). Migrated remaining TSX to Tailwind modules:

- Extended `appUi.ts` (operations table, section hints, PnL tones, page stack)
- Generated [`wave9Classes.ts`](../../frontend/src/styles/wave9Classes.ts) (~441 keys) for residual selectors
- Codemods: `generate-wave9-classes.mjs`, `migrate-wave9-classes.mjs` + replay/wave6 migrations
- Settings groups: `settingsUi.SETTINGS_GROUP_CARD` replaces `.daemon-group` hooks
- `globals.css` no longer imports `app-surfaces.css`

**Verification:** zero `className` tokens from deleted `app-surfaces` selectors; `lint:legacy-classes` OK.

## Plan reference

Phase 7 waves: `.cursor/plans/css_debt_zero_plan_ed27f763.plan.md` (do not edit plan file from agents; update this tracker only).
