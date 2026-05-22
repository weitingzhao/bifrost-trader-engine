# Page Layout Templates

All pages in the Bifrost frontend use **Tailwind + shadcn** (Phase 7 complete).
When creating or touching a page, follow the layout below.

## Tailwind + shadcn (standard)

**Reference**: [LEGACY_CSS_RETIREMENT](../../docs/plans/LEGACY_CSS_RETIREMENT.md) — CSS debt zero.

**Layout**:

- Root: `className="flex min-w-0 flex-col gap-4 p-4 md:p-6"` (or page-specific padding).
- Surfaces: `bg-card`, `border border-border`, `rounded-lg`, `shadow-sm`.
- Typography: `text-foreground`, `text-muted-foreground`, `text-sm`.
- Actions: `@/components/ui/button` (`Button`), not legacy `.btn` classes.
- Tables: `@/components/shared/data-table` or shadcn `Table` inside `overflow-x-auto`.
- Status lamps: `@/components/shared/lamp-indicator` (Tailwind), not `.lamp-icon`.
- Tokens: `design-tokens.css` for charts/domain CSS variables; theme via `data-theme` + `.dark`.
- Shared modules: `appUi.ts`, `replayLayout.ts` (`rl`), `wave9Classes.ts` (`w9`), domain `*Ui.ts` / `*Classes.ts`.

**Do not add** legacy class fragments (`card`, `process-section`, `btn-`,
`settings-page`, `wl2`, etc.) in files outside
`frontend/scripts/legacy-class-allowlist.json`. Run `npm run lint:legacy-classes`.

## Centered Narrow Form (reserved)

Max-width container centered in viewport. Not yet used; reserved for
future standalone configuration wizards or onboarding flows.

**CSS**: define with Tailwind utilities when needed.

## Settings sidebar layout

Settings pages use `<SettingsShell sidebar={...}>` from
`pages/settings/SettingsShell.tsx` — sticky sidebar + flexible main column,
styled with Tailwind via `settingsUi.ts` (`su`), not legacy BEM CSS.
