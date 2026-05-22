import { cn } from '@/lib/utils'
import { pnlNegativeClass, pnlPositiveClass } from '@/components/shared/appUi'

/** Tailwind tokens for portfolio / ledger / positions / live replay UI (replaces .replay-* in app-surfaces.css). */
export const rl = {
  page: 'max-w-full',
  pageTitle: 'mb-[var(--space-2)]',
  portfolioViewTabs: 'mb-[var(--space-2)]',
  portfolioViewTab: 'min-w-[10rem] justify-center',
  portfolioViewHint: 'm-0 mb-[var(--space-3)]',
  overviewFetchedAt: 'mt-[var(--space-3)]',
  pageSectionDesc: 'mb-[var(--space-5)] text-[var(--color-text-muted)]',

  toolbar: 'mb-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-3)]',

  section:
    'mt-[var(--space-5)] border-t border-border pt-[var(--space-4)] first:mt-[var(--space-4)] first:border-t-0 first:pt-0 [&_h3]:mb-[var(--space-3)] [&_h3]:text-[length:var(--text-title)] [&_h3]:text-[var(--color-text-main)]',
  sectionTradeRecords: 'ledger-trade-records-section max-w-full',
  positionsOpenFilterSymbol: 'w-[8.25rem] min-w-[6.5rem] max-w-40',
  positionsOpenFilterExpiry: 'w-[7.5rem] max-w-36',

  sub: 'my-[var(--space-4)_0_var(--space-2)_0] text-[length:var(--text-body)] font-semibold text-[var(--color-text-muted)]',

  fetchDaysLabel: 'font-medium',
  fetchRangeGroup:
    'inline-flex items-center gap-[var(--space-2)] rounded-full border border-border bg-[var(--color-surface-elevated)] p-[var(--space-1)_var(--space-2)]',
  fetchRangeGroupAccounts:
    'gap-[var(--space-2)] border-border bg-[color-mix(in_srgb,var(--color-surface-elevated)_42%,transparent)] px-[0.65rem] py-[0.35rem] shadow-[0_1px_0_color-mix(in_srgb,var(--color-text)_4%,transparent)] backdrop-blur-[10px]',
  poolGroup: 'px-[var(--space-2)]',
  fetchRadio:
    'inline-flex items-center gap-1 text-[length:var(--text-caption)] text-[var(--color-text-muted)] [&_input]:relative [&_input]:m-0 [&_input]:size-3 [&_input]:cursor-pointer [&_input]:appearance-none [&_input]:rounded-full [&_input]:border [&_input]:border-[var(--color-border-strong)] [&_input]:bg-transparent [&_input]:before:absolute [&_input]:before:inset-[2px] [&_input]:before:scale-0 [&_input]:before:rounded-[inherit] [&_input]:before:bg-[var(--color-accent)] [&_input]:before:transition-transform [&_input]:before:duration-[var(--transition-fast)] [&_input]:before:content-[""] [&_input]:checked:before:scale-100 [&_span]:cursor-pointer',
  fetchRefreshBtn:
    'ml-[var(--space-2)] inline-flex items-center justify-center gap-[0.4rem] rounded-full border border-[color-mix(in_srgb,var(--color-border)_75%,transparent)] bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] px-[0.75rem] py-[0.3rem] text-[length:var(--text-caption)] font-medium leading-[1.2] text-[var(--color-text)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-text)_6%,transparent),0_1px_2px_rgba(0,0,0,0.06)] backdrop-blur-[12px] transition-[background,border-color,color,box-shadow] duration-[0.18s] hover:border-[color-mix(in_srgb,var(--color-accent)_42%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] hover:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-accent)_12%,transparent),0_2px_8px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50',
  fetchRefreshBtnAccounts: 'box-border min-h-[1.875rem]',
  fetchRefreshBtnBusy: 'opacity-[0.92]',
  fetchRefreshSvg: 'block shrink-0 opacity-[0.92]',
  fetchRefreshSvgSpin: 'animate-[replay-fetch-refresh-spin_0.85s_linear_infinite]',
  syncHint: 'text-[length:var(--text-small)] text-[var(--color-text-muted)]',
  dataFromInline: 'ml-[var(--space-1)] whitespace-nowrap',

  barSymbolRow: 'mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)]',
  barSymbolLabel: 'min-w-[2.5rem] font-medium',
  barSymbolInput:
    'w-32 rounded border border-border bg-[var(--color-bg)] p-[var(--space-1)_var(--space-2)] text-base text-[var(--color-text)]',

  filters:
    'my-[var(--space-3)_0_var(--space-4)_0] flex flex-wrap items-center gap-[var(--space-3)] rounded-[var(--radius-md,6px)] border border-border bg-[var(--color-surface)] p-[var(--space-3)]',
  filtersBar: 'mb-[var(--space-2)] border-0 bg-transparent p-0 pb-[var(--space-3)]',
  filtersBarTwoRows: 'flex flex-col items-stretch gap-[var(--space-2)]',
  filtersBarRow: 'flex flex-wrap items-center gap-[var(--space-2)]',
  filtersBarRowStrategy: 'border-t border-border pt-[var(--space-1)]',
  filterLabel: 'min-w-[4rem] text-[length:var(--text-small)] text-[var(--color-text-muted)]',
  filterLabelInstance: '',
  filterInput:
    'rounded-[var(--radius-sm)] border border-border bg-[var(--color-bg)] p-[var(--space-1)_var(--space-2)] text-[length:var(--text-body)] text-[var(--color-text-main)] placeholder:text-[var(--color-text-dim)]',
  filterInputDim: 'text-[var(--color-text-dim)]',
  filterDate: 'bg-[var(--color-bg)] text-[var(--color-text-main)]',
  filterSelect:
    'cursor-pointer appearance-none rounded-[6px] border border-border bg-[var(--color-surface,#13171d)] bg-[length:12px_12px] bg-[position:right_0.5rem_center] bg-no-repeat py-[0.35rem] pl-[0.6rem] pr-8 text-[length:var(--text-small,0.875rem)] text-[var(--color-text-main,#e4e9ef)] [background-image:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2712%27%20height=%2712%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%237a8492%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpolyline%20points=%276%209%2012%2015%2018%209%27%3E%3C/polyline%3E%3C/svg%3E")] hover:border-[var(--color-border-strong,#3d4754)] focus:border-[var(--color-border-strong,#3d4754)] focus:outline-none',
  filterInputSymbol: 'w-20 max-w-24',
  filterWrapSymbol: 'min-w-0',
  filterSep: 'mx-[var(--space-1)] text-[var(--color-text-muted)]',
  filterRange: 'flex flex-col gap-[var(--space-1)]',
  filterRangeInputs: 'flex flex-wrap items-center gap-[var(--space-1)]',
  filterLabelMonth: 'inline-flex items-center gap-[var(--space-1)]',
  filterAccountWrap: 'inline-flex flex-wrap items-center gap-[var(--space-2)]',
  filterAccountPills: 'inline-flex flex-wrap items-center gap-[var(--space-1)]',
  filterPill:
    'cursor-pointer rounded-full border border-border bg-[var(--color-bg)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-small,0.875rem)] text-[var(--color-text-main)] transition-[background,border-color,color] duration-150 hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface)]',
  filterPillActive:
    'border-[var(--color-primary,#2563eb)] bg-[var(--color-primary,#2563eb)] text-white hover:border-[var(--color-primary-hover,#1d4ed8)] hover:bg-[var(--color-primary-hover,#1d4ed8)] hover:text-white',
  filterPillDraggable: 'cursor-grab active:cursor-grabbing active:opacity-70',
  filterPillGrip: 'pointer-events-none mr-[0.3em] select-none text-[0.85em] opacity-40',
  streamFilterPill:
    'rounded-[20px] border border-border bg-transparent px-3 py-[3px] text-[length:var(--text-caption)] font-medium text-[var(--color-text-muted)] transition-all duration-[var(--transition-fast)] hover:border-[var(--color-border-strong)] hover:bg-white/5 hover:text-[var(--color-text-main)] [html[data-theme=light]_&]:hover:bg-black/[0.04]',
  streamFilterPillActive:
    'border-[var(--color-accent)] bg-[var(--color-accent)] font-semibold text-[var(--color-bg)] shadow-[0_0_8px_var(--color-accent-glow)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)] hover:brightness-110 hover:shadow-[0_0_12px_var(--color-accent-glow)]',
  filterClear: 'ml-auto',

  muted: 'text-[var(--color-text-muted,#888)]',
  placeholder: 'text-[length:var(--text-caption)] text-[var(--color-text-muted,#888)]',

  bubbleSwitch:
    'inline-flex gap-0.5 rounded-full border border-border bg-[var(--color-surface-elevated,rgba(255,255,255,0.06))] p-[3px] [html[data-theme=dark]_.instance-sheet-filters_&]:border-[var(--color-border-strong,#3d4754)] [html[data-theme=dark]_.instance-sheet-filters_&]:bg-[rgba(8,10,14,0.85)]',
  bubbleSwitchWrap: 'flex-wrap',
  bubbleSwitchBtn:
    'cursor-pointer appearance-none rounded-full border-0 bg-transparent px-[0.85rem] py-[0.28rem] font-[inherit] text-[0.78rem] font-semibold leading-[1.2] text-[var(--color-text-muted,#8b949e)] transition-[background,color] duration-150 hover:bg-white/5 hover:text-[var(--color-text-main,#e4e9ef)] disabled:cursor-not-allowed disabled:opacity-70 [html[data-theme=dark]_.instance-sheet-filters_&]:hover:bg-white/[0.06]',
  bubbleSwitchBtnActive:
    'bg-[var(--color-surface,#1e242c)] text-[var(--color-text-main,#e4e9ef)] shadow-[0_1px_2px_rgba(0,0,0,0.25)] [html[data-theme=dark]_.instance-sheet-filters_&]:bg-[rgba(125,211,252,0.12)] [html[data-theme=dark]_.instance-sheet-filters_&]:text-[#e0f2fe] [html[data-theme=dark]_.instance-sheet-filters_&]:shadow-[inset_0_0_0_1px_rgba(125,211,252,0.32)]',

  portfolioBlock: 'w-full min-w-0',
  portfolioHeader:
    'mb-[var(--space-2)] flex min-w-0 flex-wrap items-center justify-between gap-[var(--space-3)]',
  portfolioTabsWrap: 'flex min-w-0 flex-[1_1_24rem] flex-col gap-[var(--space-2)]',
  portfolioTabs: 'mb-0 [&_.system-tab:disabled]:cursor-not-allowed [&_.system-tab:disabled]:opacity-45 [&_.system-tab:disabled:hover]:text-[var(--color-text-muted)]',
  portfolioTabHint: 'm-0 inline-flex flex-wrap items-center gap-[var(--space-2)]',
  portfolioFilters: 'flex flex-wrap items-center gap-[var(--space-4)]',
  portfolioTableWrap: 'mb-[var(--space-3)] w-full min-w-0 overflow-x-auto',
  portfolioTableWrapNoScroll: 'overflow-x-visible',
  portfolioGroupHeader: '',

  ledgerToolbar:
    'mb-[var(--space-2)] mt-[var(--space-1)] flex min-w-0 flex-wrap items-end justify-between gap-[var(--space-3)]',
  ledgerDetailViewToolbar:
    'flex flex-[0_1_auto] flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)] pb-0.5',
  ledgerDetailViewRadios: 'mb-0',
  ledgerTabMatrix: 'flex min-w-0 flex-col gap-[var(--space-1)]',
  ledgerTabMatrixAligned: 'w-full',
  ledgerTabMatrixOpenPositions: '',
  ledgerTabMatrixLabels:
    'grid grid-cols-6 gap-x-[var(--space-3)] px-[var(--space-1)]',
  ledgerTabMatrixLabelsOpen: 'grid-cols-5',
  ledgerTabGroupCaption:
    'rounded-md border border-[rgba(88,166,255,0.22)] bg-gradient-to-b from-[rgba(88,166,255,0.14)] to-[rgba(88,166,255,0.05)] px-2 py-[0.2rem_0.5rem_0.35rem] text-center text-[0.68rem] font-bold uppercase tracking-[0.07em] text-[var(--color-text-main,#e4e9ef)] shadow-[0_1px_0_rgba(0,0,0,0.12)]',
  ledgerTabGroupCaptionAttr: 'col-span-2',
  ledgerTabGroupCaptionInst: 'col-span-4',
  ledgerTabGroupCaptionPositionsAttr: 'col-span-1',
  ledgerTabGroupCaptionPositionsInst: 'col-span-4',
  ledgerTabButtonRow:
    'system-tabs box-border grid w-full grid-cols-6 items-stretch gap-x-[var(--space-3)] px-[var(--space-1)] [&_.system-tab]:min-w-0 [&_.system-tab]:justify-center [&_.system-tab]:text-center',
  ledgerTabButtonRowOpen: 'grid-cols-5',
  ledgerTabAtInstruments:
    'ml-0 border-l border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] pl-[var(--space-2)]',

  ledgerSummary:
    'mb-[var(--space-2)] flex flex-wrap items-baseline gap-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption,0.8125rem)] text-[var(--color-text-muted)]',
  ledgerSummaryLabel: 'shrink-0 font-semibold text-[var(--color-text-muted)]',
  ledgerSummaryInline: 'inline-flex flex-wrap items-baseline gap-x-[var(--space-3)]',
  ledgerSummarySep: 'mx-[var(--space-1)] text-[var(--color-border)]',
  ledgerSummaryTotal: 'ml-[var(--space-1)] font-semibold text-[var(--color-text-main)]',
  ledgerSummaryPeriod:
    'flex-col items-stretch gap-0 rounded-[10px] border border-border bg-[var(--color-dashboard-tile)] p-[var(--space-2)_var(--space-3)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
  ledgerSummaryPeriodHead:
    'mb-[var(--space-3)] flex w-full flex-wrap items-center justify-between gap-x-[var(--space-3)] gap-y-[var(--space-2)]',
  ledgerSummaryPeriodTabs:
    'inline-flex flex-wrap gap-0.5 rounded-[9px] border border-border bg-[var(--color-surface)] p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
  ledgerSummaryPeriodTab:
    'cursor-pointer appearance-none rounded-md border-0 bg-transparent px-[0.65rem] py-[0.35rem] font-[inherit] text-[length:var(--text-tiny)] font-semibold tracking-[0.02em] text-[var(--color-text-muted)] transition-[color,background] duration-[var(--transition-fast)] hover:bg-[var(--color-dashboard-tile)] hover:text-[var(--color-text-main)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
  ledgerSummaryPeriodTabActive:
    'bg-[var(--color-surface-elevated)] text-[var(--color-text-main)] shadow-[0_1px_2px_var(--color-dashboard-shadow)]',
  ledgerSummaryPeriodBody:
    'flex w-full min-w-0 flex-wrap items-stretch gap-[var(--space-3)]',
  ledgerSummaryCalendarGrid:
    'm-0 grid min-w-0 flex-[1_1_14rem] list-none grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-[var(--space-2)] p-0',
  ledgerSummaryPeriodCell:
    'flex min-h-[3.25rem] min-w-0 flex-col items-start gap-[0.2rem] rounded-lg border border-border bg-[var(--color-surface-elevated)] p-[var(--space-2)_var(--space-3)] shadow-[0_1px_2px_var(--color-dashboard-shadow)]',
  ledgerSummaryPeriodCellLabel:
    'font-mono text-[length:var(--text-tiny)] font-semibold leading-[1.2] tracking-[0.04em] text-[var(--color-text-dim)] [font-variant-numeric:tabular-nums]',
  ledgerSummaryPeriodCellMetrics:
    'inline-flex flex-wrap items-baseline gap-[0.35em] text-[length:var(--text-caption)] leading-[1.35] text-[var(--color-text-muted)]',
  ledgerSummaryStocksMetricSep: 'select-none text-[var(--color-border-strong)]',
  ledgerSummaryStocksNotional:
    'font-mono font-medium text-[var(--color-text-main)] [font-variant-numeric:tabular-nums]',
  ledgerSummaryStocksNotionalLine:
    'mt-[0.15rem] block font-mono text-[length:var(--text-tiny)] leading-[1.25] text-[var(--color-text-dim)] [font-variant-numeric:tabular-nums]',
  ledgerSummaryRealizedZero:
    'font-mono font-medium text-[var(--color-text-muted)] [font-variant-numeric:tabular-nums]',
  ledgerSummaryStocksTotal:
    'ml-auto inline-flex min-w-[min(100%,11rem)] flex-[0_1_auto] flex-col items-start justify-center gap-[0.2rem] rounded-lg border border-[var(--color-border-strong)] bg-gradient-to-br from-[var(--color-surface-elevated)] to-[var(--color-dashboard-tile)] p-[var(--space-2)_var(--space-3)]',
  ledgerSummaryStocksTotalLabel:
    'text-[length:var(--text-tiny)] font-bold uppercase tracking-[0.06em] text-[var(--color-text-dim)]',
  ledgerSummaryStocksTotalMetrics: 'text-[length:var(--text-body)]',
  ledgerSummaryStocksTotalU: '[font-variant-numeric:tabular-nums]',
  ledgerMetricExplainTrigger: 'cursor-help underline decoration-dotted underline-offset-2',

  ledgerDimensionBundle:
    'mb-[var(--space-3)] overflow-hidden rounded-lg border border-border bg-[var(--color-surface,#1a1a1a)]',
  ledgerDimensionHeader:
    'flex w-full cursor-pointer items-center gap-3 border-0 border-b border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] bg-gradient-to-b from-[rgba(88,166,255,0.08)] to-[rgba(88,166,255,0.02)] px-3 py-[0.45rem] text-left text-[0.85rem] text-[var(--color-text-main,#e4e9ef)] hover:bg-[var(--color-surface-hover,rgba(255,255,255,0.04))]',
  ledgerDimensionBody: 'border-t-0 bg-[var(--color-surface,#1a1a1a)] px-[0.85rem] py-2 pb-3',

  stockGroupTabs: 'mb-0 border-b-0 [&_.system-tab]:px-[var(--space-3)] [&_.system-tab]:py-[var(--space-1)] [&_.system-tab]:text-[length:var(--text-small,0.875rem)]',
  stockCategoryTabs:
    'mb-0 ml-[var(--space-2)] border-b-0 [&_.system-tab]:px-[var(--space-3)] [&_.system-tab]:py-[var(--space-1)] [&_.system-tab]:text-[length:var(--text-small,0.875rem)]',

  instanceContainFilter:
    'mb-[0.65rem] flex flex-wrap items-center gap-x-3 gap-y-2 py-[0.4rem] [.ledger-instance-controls-row_&]:mb-0',
  instanceContainFilterDisabled: 'pointer-events-none opacity-50',
  instanceContainFilterLabel:
    'inline-flex items-center gap-1 text-[0.8rem] font-semibold text-[var(--color-text-muted,#8b949e)]',
  instanceContainFilterMeta: 'ml-1 text-[0.75rem] text-[var(--color-text-muted,#8b949e)]',

  optGroups: 'mb-[var(--space-4)]',
  optExpandCol: 'w-8 text-center align-middle',
  optExpandIcon:
    'text-[calc(var(--text-body)*1.1)] font-bold text-[var(--color-text-muted)] transition-[color,transform] duration-[var(--transition-fast)] group-hover:text-[var(--color-text-main)]',
  optExpandIconExpanded: 'translate-y-px text-[var(--color-accent)]',
  optGroupRow: 'cursor-pointer hover:bg-[var(--color-surface-elevated)]',
  optContract:
    'bg-transparent align-middle font-mono text-[length:var(--text-small)] [&_.ledger-instance-icon-link]:-translate-y-[0.15em]',
  optActionsCell: '',
  optSummaryRow: 'font-semibold [&_td]:border-t-2 [&_td]:border-border [&_td]:pt-[var(--space-2)]',
  optTfootTotal: 'font-semibold [&_td]:border-t-2 [&_td]:border-border [&_td]:pt-[var(--space-2)]',
  optTfootLabel: 'text-right text-[var(--color-text-muted)]',
  thSub: 'text-[length:var(--text-small,0.875rem)] font-medium text-[var(--color-text-muted)]',
  thSortable:
    'cursor-pointer select-none whitespace-nowrap hover:text-[var(--color-accent,#06c)]',
  thNarrow: '',

  stockGroupHeader:
    'border-y border-border bg-[var(--color-surface-elevated)] px-[var(--space-3)] py-[var(--space-2)] font-semibold text-[var(--color-text-muted)]',
  stockGroupHeaderInner: 'flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]',
  stockGroupSymbol: 'mr-0',
  stockGroupSymbolPill:
    'inline-block rounded-md border border-[color-mix(in_srgb,var(--color-accent,#3b82f6)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-accent,#3b82f6)_18%,transparent)] px-2 py-[0.12rem] font-bold tracking-[0.02em] text-[var(--color-text-main)]',
  stockGroupAccount: 'mr-0 text-[var(--color-text-main)]',
  stockGroupCategory: 'font-medium text-[var(--color-text-muted)]',
  stockGroupCategoryPill:
    'inline-block rounded-md border border-[color-mix(in_srgb,#a855f7_32%,transparent)] bg-[color-mix(in_srgb,#a855f7_16%,transparent)] px-2 py-[0.12rem] font-semibold text-[var(--color-text-main)]',
  stockGroupPositionSnapshot:
    'min-w-0 max-w-full flex-[1_1_12rem] text-[0.88em] font-medium text-[var(--color-text-muted)] [font-variant-numeric:tabular-nums]',
  stockGroupPositionSnapshotLabel: 'text-[0.85em] font-semibold opacity-[0.88]',
  stockGroupPositionSnapshotSep: 'text-[var(--color-border-strong,var(--color-border))] opacity-[0.85]',
  stockGroupBasisPct:
    'min-w-0 max-w-full flex-[1_1_10rem] text-[0.88em] font-medium text-[var(--color-text-muted)] [font-variant-numeric:tabular-nums]',
  stockGroupTotalPnl:
    'ml-auto inline-flex flex-wrap items-baseline gap-[0.35rem] [font-variant-numeric:tabular-nums]',
  stockGroupTotalPnlLabel: 'text-[0.92em] font-semibold text-[var(--color-text-muted)]',

  strategyOppCell: 'ledger-strategy-opp-cell max-w-40',
  strategyOppCellInner: 'inline-flex min-w-0 max-w-full items-center gap-[0.35rem]',
  strategyOppText: 'block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
  instanceLabelInline: 'ml-[var(--space-1)] align-middle text-[length:var(--text-caption)] text-[var(--color-text-muted)]',
  instanceCellStack: 'flex flex-col items-start gap-[0.2rem]',

  instanceGroup:
    'mb-4 overflow-hidden rounded-lg border border-border bg-[var(--color-surface,#1a1a1a)]',
  instanceGroupHeaderRow:
    'flex w-full items-stretch bg-[var(--color-surface-elevated,var(--bg-surface-subtle,#161616))]',
  instanceGroupHeader:
    'flex min-w-0 flex-[1_1_auto] w-auto cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-2 text-left text-[0.85rem] text-[var(--color-text-main,#e4e9ef)] hover:bg-[var(--color-surface-hover,rgba(255,255,255,0.04))]',
  instanceGroupHeaderRowBtn:
    'flex w-full cursor-pointer items-center gap-3 border-0 bg-[var(--color-surface-elevated,var(--bg-surface-subtle,#161616))] px-3 py-2 text-left text-[0.85rem] text-[var(--color-text-main,#e4e9ef)] hover:bg-[var(--color-surface-hover,rgba(255,255,255,0.04))]',
  instanceDetailLink: 'shrink-0 self-center px-3 text-[0.78rem] font-medium',
  instanceChevron: 'inline-block shrink-0 text-[var(--color-text-muted,#888)] transition-transform duration-150',
  instanceChevronOpen: 'rotate-90',
  instanceGroupTitle: 'font-semibold',
  instanceGroupOpp: 'text-[0.82rem] text-[var(--color-text-muted,#8b949e)]',
  instanceGroupStats:
    'ml-auto flex flex-wrap gap-x-4 gap-y-3 text-[0.8rem] text-[var(--color-text-muted,#8b949e)]',
  instanceGroupBody:
    'border-t border-border bg-[var(--color-surface,#1a1a1a)] px-3 py-2 pb-3',
  instanceGroupBlock: 'mb-3 last:mb-0',
  instanceSubheading: 'm-0 mb-[0.35rem] text-[0.8rem] font-semibold text-[var(--color-text-muted,#8b949e)]',
  instanceNoInstSheet:
    'rounded-lg border border-border bg-[var(--color-surface,#1a1a1a)] px-4 py-3 pb-4',
  instanceNoInstSheetIntro: 'mb-4 mt-0',

  strategyInstanceNest:
    'mt-[0.85rem] border-l-2 border-border pl-3 [[data-first-nest]_&]:mt-0',
  strategyInstanceTitleRow:
    'mb-[0.35rem] flex flex-wrap items-baseline justify-between gap-x-3 gap-y-[0.35rem]',
  strategyInstanceHeaderRow: 'mb-[0.15rem] flex w-full items-center gap-2',
  strategyInstanceCollapseHeader:
    'm-0 flex min-w-0 flex-[1_1_auto] cursor-pointer items-center gap-[0.45rem] rounded-md border-0 bg-transparent px-[0.35rem] py-[0.3rem] text-left font-[inherit] text-inherit hover:bg-[var(--color-surface-hover,rgba(255,255,255,0.04))]',
  strategyInstanceHeadTitle:
    'min-w-0 flex-[1_1_auto] text-[0.82rem] font-semibold text-[var(--color-text-main,#e4e9ef)]',
  strategyInstanceIdText: 'font-semibold text-[var(--color-text-muted,#8b949e)]',
  strategyInstanceOpenLink: 'shrink-0 text-[0.78rem]',
  strategyInstanceCollapseBody: 'pt-[0.35rem]',
  strategyInstanceHeading: 'm-0 min-w-0 flex-[1_1_auto] text-[var(--color-text-main,#e4e9ef)]',
  strategyInstanceLabel: 'font-semibold',
  strategyInstanceStats:
    'ml-auto inline-flex flex-wrap gap-x-[0.85rem] gap-y-2 text-[0.78rem] text-[var(--color-text-muted,#8b949e)]',

  stgIns: '',
  stgInsSplit: '',
  stgInsHead: '',
  stgInsStrategy: '',
  stgInsAllocList: '',
  stgInsAllocItem: '',
  stgInsAllocLabel: '',
  stgInsLink: '',
  stgInsLinkCompact: '',
  stgInsAllocQty: '',
  stgInsSep: '',
  stgInsPreId: '',
  stgInsEmpty: '',

  statusRealized: 'text-[var(--color-success,#0a0)]',
  statusUnrealized: 'text-[var(--color-warning,#a60)]',
  pnlRealized: 'font-semibold text-[var(--color-success,#0a0)]',
  pnlUnrealized: 'font-semibold text-[var(--color-warning,#e67e22)]',
  pnlDetailNegative: 'text-[var(--color-danger)]',
  pnlDetailPositive: 'font-semibold text-[var(--color-success)]',
  timeAgo: 'text-[var(--color-lamp-yellow,#ca8a04)]',
  lastStrikePct: 'text-[0.9em]',

  cost: '',
  premium: '',
  contractExecId: '',
  detailPlaceholder: '',
  detailTotalLabel: '',
  optDetailTitle: '',
  execRowActions: '',

  expiredCloseForm: 'flex flex-col gap-[var(--space-1)]',
  expiredCloseRow: 'flex flex-wrap items-center gap-[var(--space-2)] [&_label]:inline-flex [&_label]:flex-col [&_label]:gap-0.5 [&_label]:text-[length:var(--text-caption)] [&_input]:max-w-24',
  expiredCloseSide: 'text-[length:var(--text-caption)] font-semibold',
  expiredCloseActions: 'mt-[var(--space-1)] flex gap-[var(--space-2)]',
  expiredCloseSummary: '',
  expiredCloseError: 'text-[length:var(--text-caption)] text-[var(--color-danger,#f87171)]',

  execModal: 'w-full max-w-lg rounded-xl border border-border bg-[var(--color-surface)] p-4 shadow-lg',
  execForm: 'flex flex-col gap-3',
  execFormRow: 'flex flex-col gap-1',
  execFormActions: 'mt-2 flex flex-wrap gap-2',
  execReadonly: 'rounded-md border border-border bg-[var(--color-surface-elevated)] px-2 py-1.5 text-sm text-muted-foreground',
  execSplitsSection: 'rounded-lg border border-border p-3',
  execSplitsSectionHeader: 'mb-2 items-center justify-between',
  execSplitsControls: 'flex flex-wrap items-center gap-2',
  execCheckboxLabel: 'inline-flex items-center gap-2 text-sm',
  execSplitsHint: 'm-0 text-xs text-muted-foreground',
  execSplitsRows: 'flex flex-col gap-2',
  execSplitRow: 'flex flex-wrap items-center gap-2',
  execSplitQty: 'w-24 rounded-md border border-border bg-background px-2 py-1 text-sm',
  execSplitRemove: 'text-sm text-[var(--color-danger)]',
  execSegBubbles: 'inline-flex flex-wrap gap-1',
  execFormRowMetrics: 'grid grid-cols-3 gap-2',
  execFormRowMetricsPnl: '',
  execMetricField: 'flex flex-col gap-0.5 text-sm',
  execTypeRadios: 'flex flex-wrap gap-2',
  barPeriodRadios: 'inline-flex flex-wrap gap-2',
  formError: '',
  formLabel: '',
  formInput: '',

  linkAssignBtn: 'px-[0.4rem] py-[0.15rem] text-[length:var(--text-caption)]',
} as const

export function bubbleSwitchBtn(active?: boolean) {
  return cn(rl.bubbleSwitchBtn, active && rl.bubbleSwitchBtnActive)
}

export function filterPill(active?: boolean, opts?: { stream?: boolean; draggable?: boolean }) {
  return cn(
    opts?.stream ? rl.streamFilterPill : rl.filterPill,
    active && (opts?.stream ? rl.streamFilterPillActive : rl.filterPillActive),
    opts?.draggable && rl.filterPillDraggable,
  )
}

export function expandIcon(expanded?: boolean) {
  return cn(rl.optExpandIcon, expanded && rl.optExpandIconExpanded)
}

export function fetchRefreshBtn(busy?: boolean, accounts?: boolean) {
  return cn(rl.fetchRefreshBtn, accounts && rl.fetchRefreshBtnAccounts, busy && rl.fetchRefreshBtnBusy)
}

export function fetchRefreshSvg(spin?: boolean) {
  return cn(rl.fetchRefreshSvg, spin && rl.fetchRefreshSvgSpin)
}

export function periodSummaryTab(active?: boolean) {
  return cn(rl.ledgerSummaryPeriodTab, active && rl.ledgerSummaryPeriodTabActive)
}

export function ledgerTabMatrixLabels(openPositions?: boolean) {
  return cn(rl.ledgerTabMatrixLabels, openPositions && rl.ledgerTabMatrixLabelsOpen)
}

export function ledgerTabButtonRowClass(openPositions?: boolean) {
  return cn(rl.ledgerTabButtonRow, openPositions && rl.ledgerTabButtonRowOpen)
}

export function pnlDetailClass(value: number) {
  if (value < 0) return rl.pnlDetailNegative
  if (value > 0) return rl.pnlDetailPositive
  return ''
}

export function ledgerUrPnlLineClass(v: number) {
  if (v > 0) return rl.pnlRealized
  if (v < 0) return rl.pnlDetailNegative
  return rl.ledgerSummaryRealizedZero
}

export function stkNotionalSideColorClass(side: string | undefined | null) {
  const s = (side ?? '').toString().trim().toUpperCase()
  if (s === 'BUY' || s === 'BOT' || s === 'B') return rl.pnlRealized
  if (s === 'SELL' || s === 'SLD' || s === 'S') return rl.pnlDetailNegative
  return rl.ledgerSummaryRealizedZero
}

export function pnlUnrealizedClass(value: number, positiveClass = pnlPositiveClass, negativeClass = pnlNegativeClass) {
  return cn(rl.pnlUnrealized, value >= 0 ? positiveClass : negativeClass)
}

export function filterInputClass(extra?: string) {
  return cn(rl.filterInput, rl.filterSelect, extra)
}

export function ledgerMetricPnlClass(v: number) {
  if (v > 0) return rl.pnlRealized
  if (v < 0) return rl.pnlDetailNegative
  return rl.ledgerSummaryRealizedZero
}

export function ledgerMetricExplainClass(v: number) {
  return cn(rl.ledgerMetricExplainTrigger, ledgerMetricPnlClass(v))
}

export function instanceChevronClass(open?: boolean) {
  return cn(rl.instanceChevron, open && rl.instanceChevronOpen)
}
