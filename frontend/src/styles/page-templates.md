# Page Layout Templates

All pages in the Bifrost frontend should conform to one of the templates
below. When creating a new page, pick the closest template and follow its
structure. When touching an existing page, migrate it to the matching
template if practical.

## 1. Full-Width Dashboard

Full viewport width, no sidebar. Used for pages with rich grids,
tables, or dashboard cards.

**CSS**: top-level `<div>` with padding from `--space-*` tokens.

**Pages**: LivePage, AccountsPage, MarketDataPage, PositionsPage,
PerformancePage, WatchlistPage, TradeHistoryPage, TransferPayPage,
ModelAnalysisPage, BacktestPage, OptionDiscoveryPage,
ResearchRiskAnalysisPage, StatusPage, StrategyInstancesPage,
StrategyInstanceDetailPage, StrategyOpportunityPage,
StrategyAllocationPage, StrategyStructurePage, GatesConfigPage,
StructureTypeConfigPage.

## 2. Settings Two-Column (SettingsShell)

Fixed-width sticky sidebar + flexible main column.
Use `<SettingsShell sidebar={...}>` from `pages/settings/SettingsShell.tsx`.

**CSS**: `settings-celery.css` — `.settings-page`, `.settings-sidebar`,
`.settings-main`.

**Pages**: SettingsPage (the only direct consumer; sidebar content is
domain-specific and passed as a prop).

## 3. Settings Embedded Detail

Rendered inside the Settings main column (template 2) when a sidebar
sub-link is selected. Root element carries `.settings-page-card` and a
page-specific `--embedded` modifier class.

**Rules** (from layout contract in `settings-celery.css`):
- Root node: `min-width: 0; max-width: 100%`.
- Internal grids/flex: all children `min-width: 0`.
- Wide content: use `.table-scroll-x` wrapper.

**Pages**: CeleryPage, DaemonStatusPage, ServerStatusPage, DataPage
(when `embeddedInSettings` is true), FeedMassiveOptionPage.

## 4. Centered Narrow Form (reserved)

Max-width container centered in viewport. Not yet used; reserved for
future standalone configuration wizards or onboarding flows.

**CSS**: not yet defined — create as needed.

## 5. Tailwind + shadcn (target — use for all new pages)

**Status**: Target template while Templates 1–3 are deprecated during
[LEGACY_CSS_RETIREMENT](../../docs/plans/LEGACY_CSS_RETIREMENT.md).

**Layout**:

- Root: `className="flex min-w-0 flex-col gap-4 p-4 md:p-6"` (or page-specific padding).
- Surfaces: `bg-card`, `border border-border`, `rounded-lg`, `shadow-sm`.
- Typography: `text-foreground`, `text-muted-foreground`, `text-sm`.
- Actions: `@/components/ui/button` (`Button`), not `.btn` / `.btn-primary`.
- Tables: `@/components/shared/data-table` or shadcn `Table` inside `overflow-x-auto`.
- Status lamps: `@/components/shared/lamp-indicator` (Tailwind), not `.lamp-icon`.
- Tokens: `design-tokens.css` for charts/domain CSS variables; theme via `data-theme` + `.dark`.

**Do not add** legacy class fragments (`card`, `process-section`, `btn-`,
`settings-page`, `wl2`, etc.) in files outside
`frontend/scripts/legacy-class-allowlist.json`. Run `npm run lint:legacy-classes`.

Templates 1–3 remain valid for unmigrated pages until their wave in the retirement plan completes.
