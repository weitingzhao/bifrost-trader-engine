# Bifrost Monitor UI — Design Contract

## Surface

- **Trading console**: dark-first engineering UI; data tables and status lamps are primary.
- **Theme**: `next-themes` (`class` on `<html>`) + legacy `data-theme` on `<html>` from the in-app theme toggle until fully consolidated.

## Density

- **Compact**: default control height `h-8`, body `text-sm`, tight vertical rhythm for dense monitoring.

## Typography

- **Sans**: DM Sans (`--font-dm-sans`).
- **Mono / numbers**: JetBrains Mono (`--font-jb-mono`); use `tabular-nums font-medium` for numeric columns.

## Color semantics

- **Primary accent**: lime (`--primary` in `globals.css` / shadcn tokens) — aligns with legacy `--color-accent`.
- **Status lamps**: `--status-green`, `--status-yellow`, `--status-red` (OKLCH in token layer).
- **Destructive**: reserved for irreversible or dangerous actions in UI.

## Navigation

- **App shell**: shadcn `Sidebar` (collapsible icon rail) + `TradingLayout` header (lamps, menu, dashboard strip).
- **Settings**: canonical routes under `/settings/...` with legacy hash anchors for deep links within a section (`slugToDefaultHash` / `settingsBasePathForHash`).

## Source layout

- **App Router routes**: `src/app/`
- **Screen components**: `src/views/` (renamed from `src/pages` so Next.js does not register the legacy `src/pages` router).

## CSS migration

- **Legacy**: `src/styles/legacy.css` (former `App.css`) remains imported from `globals.css` until screens are migrated to Tailwind utilities (Phase 7).

## Data fetching

- **HTTP polling**: `@tanstack/react-query` for monitor status, operations log, and Celery aggregate (see `AppContext`).
- **SSE**: quotes and system messages stay in `AppProvider` streams (not react-query).
