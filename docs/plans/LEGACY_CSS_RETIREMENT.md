# Legacy CSS retirement tracker

Goal: remove monolithic `legacy.css` and migrate UI to Tailwind + shadcn + [`design-tokens.css`](../../frontend/src/styles/design-tokens.css).

**Status: Phase 6 complete (2026-05-22)** — `legacy.css` deleted; styles split into domain bundles; allowlist empty.

## Metrics (run `cd frontend && npm run css:metrics`)

| Snapshot | legacy.css | allowlist TSX | notes |
|----------|------------|---------------|-------|
| Phase 0 baseline | ~31468 lines | 113 | tokens extracted |
| Phase 1–4 | ~30963 | 73→54 | app header, partial domains |
| Phase 6 complete | **0 (file removed)** | **0** | `app-surfaces.css` + `feed-massive.css` + satellites |

## Phase status

| Phase | Scope | Status |
|-------|--------|--------|
| 0 | design-tokens, metrics, lint:legacy-classes | **Done** |
| 1 | AppLayout header, LampIndicator | **Done** |
| 2 | SectionPageTitle, SettingsShell, PageSection | **Done** |
| 3 | Satellite CSS (screener, data-readiness, inspector, celery) | **Done** (globals import) |
| 4 | Domain page banned-class migration | **Done** |
| 5 / 6 G | Delete `legacy.css` | **Done** — replaced by `app-surfaces.css` + `feed-massive.css` |
| 6 A–F | Waves Celery → shared → research → feed → API → remainder | **Done** (banned tokens cleared) |

## Post-retirement CSS layout

| File | Role |
|------|------|
| [`design-tokens.css`](../../frontend/src/styles/design-tokens.css) | `:root` / light theme |
| [`shadcn-tokens.css`](../../frontend/src/styles/shadcn-tokens.css) | shadcn bridge |
| [`message-center.css`](../../frontend/src/styles/message-center.css) | MessageCenter (extracted from legacy) |
| [`app-surfaces.css`](../../frontend/src/styles/app-surfaces.css) | Remaining domain surfaces (shrink over time) |
| [`feed-massive.css`](../../frontend/src/styles/feed-massive.css) | Feed → Massive BEM |
| [`settings-celery.css`](../../frontend/src/styles/settings-celery.css) | Celery / dashboard console |
| [`stock-inspector.css`](../../frontend/src/styles/stock-inspector.css) | Stock inspector |
| [`stock-screener.css`](../../frontend/src/styles/stock-screener.css) | Screener (global import) |
| [`data-readiness.css`](../../frontend/src/styles/data-readiness.css) | Data readiness (global import) |

Load order: [`globals.css`](../../frontend/src/app/globals.css) — Tailwind → tokens → message-center → shadcn → surfaces → feed-massive → satellites.

## Governance

- [`scripts/legacy-class-match.mjs`](../../frontend/scripts/legacy-class-match.mjs) — token-level banned class detection (avoids `action-btn` false positives)
- [`scripts/legacy-class-allowlist.json`](../../frontend/scripts/legacy-class-allowlist.json) — must stay **empty**
- `npm run lint:legacy-classes` — fails on banned tokens outside allowlist

## Shared migration components

- `@/components/shared/page-section` — `PageSection`
- `@/components/SectionPageTitle` — titles + `SECTION_TITLE_CLASS`
- `@/views/settings/*` — Settings shells
- `@/components/shared/lamp-indicator` — `LampIndicator`, `LampGlyphSlot`
- `@/components/shared/exec-row-buttons` — portfolio row actions

## Next shrink targets (optional)

1. Tailwind-migrate `app-surfaces.css` by domain (replay, gates, IB settings, tables).
2. Tailwind-migrate `feed-massive.css` + delete file.
3. Retire `settings-celery.css` after full Celery Tailwind pass.

## Commands

```bash
cd frontend
npm run css:metrics
npm run css:metrics:verbose
npm run lint:legacy-classes
npm run css:retirement:status
node scripts/generate-legacy-class-allowlist.mjs   # should print 0 paths
npm run test:visual:update   # when dev server available
```
