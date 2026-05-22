import { cn } from '@/lib/utils'
import type { EffectiveServiceStatus } from '../massive/FeedMassiveServiceBlock'

/** Shared Tailwind classes for Feed → Massive pages (replaces feed-massive.css). */
export const fm = {
  page: 'max-w-[72rem] min-w-0',
  optionPage: 'max-w-[72rem] min-w-0',
  titleBlock: 'mb-[var(--space-4)] flex flex-wrap items-start justify-between gap-[var(--space-3)]',
  titleMain: 'flex min-w-0 flex-wrap items-center gap-[var(--space-2)]',
  delayPill:
    'inline-flex items-center gap-[0.35rem] rounded-full border border-[var(--color-border-strong)] bg-[var(--color-warning-soft)] px-[0.65rem] py-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-[0.03em] text-[var(--color-warning)] [html[data-theme=light]_&]:text-[#a16207]',

  statusStrip:
    'mb-[var(--space-5)] rounded-[10px] border border-border bg-gradient-to-br from-[var(--color-surface-elevated)] to-[var(--color-bg)] p-[var(--space-4)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] [html[data-theme=light]_&]:bg-gradient-to-br [html[data-theme=light]_&]:from-white [html[data-theme=light]_&]:to-[var(--color-surface-elevated)] [html[data-theme=light]_&]:shadow-[0_1px_2px_var(--color-dashboard-shadow)]',
  statusStripGrid: 'grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] items-start gap-[var(--space-4)]',
  statusItem: 'flex flex-col gap-[var(--space-1)]',
  statusKey:
    'text-[length:var(--text-tiny)] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-dim)]',
  statusValue: 'font-mono text-[length:var(--text-body)] font-medium text-[var(--color-text-main)]',
  statusValueOk: 'text-[var(--color-lamp-green)]',
  statusValueBad: 'text-[var(--color-lamp-red)]',
  statusNote:
    'mt-[var(--space-3)] border-t border-border pt-[var(--space-3)] text-[length:var(--text-caption)] leading-[1.45] text-[var(--color-text-muted)]',

  apiCoverageBanner:
    'mb-[var(--space-5)] rounded-[10px] border border-border bg-[var(--color-surface-elevated)] p-[var(--space-4)]',
  apiCoverageBannerRow: 'flex flex-wrap items-start justify-between gap-[var(--space-4)]',
  apiCoverageCopy: 'min-w-0 flex-[1_1_14rem]',
  apiCoverageTitle:
    'mb-[var(--space-1)] text-[length:var(--text-small)] font-bold uppercase tracking-[0.04em] text-[var(--color-text-main)]',
  apiCoverageDesc:
    'm-0 max-w-[42rem] text-[length:var(--text-caption)] leading-[1.45] text-[var(--color-text-dim)]',
  apiCoverageActions: 'flex shrink-0 flex-wrap gap-[var(--space-2)]',
  apiCoverageSyncMsg: 'm-[var(--space-3)_0_0] text-[length:var(--text-caption)] text-[var(--color-text-dim)]',
  apiCoverageFrameWrap:
    'mt-[var(--space-4)] min-h-[min(70vh,720px)] overflow-hidden rounded-[10px] border border-border bg-[var(--color-bg)]',
  apiCoverageIframe: 'block h-[min(70vh,720px)] w-full border-0 bg-[#0d1117]',

  tabNavSection: 'mb-[var(--space-2)] mt-[var(--space-4)]',
  capNavSticky:
    'sticky top-0 z-[5] -mx-[var(--space-4)] mb-[var(--space-4)] bg-[var(--color-bg)] px-[var(--space-4)] py-[var(--space-2)]',
  capSheet:
    'rounded-[10px] border border-border bg-gradient-to-br from-[var(--color-surface-elevated)] to-[var(--color-bg)] p-[var(--space-4)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] [html[data-theme=light]_&]:bg-gradient-to-br [html[data-theme=light]_&]:from-white [html[data-theme=light]_&]:to-[var(--color-surface-elevated)] [html[data-theme=light]_&]:shadow-[0_1px_2px_var(--color-dashboard-shadow)]',
  capHint:
    'mb-[var(--space-3)] max-w-[48rem] text-[length:var(--text-caption)] leading-[1.5] text-[var(--color-text-muted)]',
  capGroup: 'mb-[var(--space-3)] last:mb-0',
  capGroupToggle:
    'mb-[var(--space-1)] flex w-full cursor-pointer items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border-0 bg-transparent p-[0.2rem_0.15rem] text-left font-[inherit] text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]',
  capGroupToggleActive: 'text-[var(--color-accent)] [&_.fm-cap-group-label]:text-[var(--color-accent)]',
  capGroupChevron:
    'inline-flex h-[1.1rem] w-[1.1rem] shrink-0 items-center justify-center text-[0.45rem] text-[var(--color-text-dim)] transition-transform duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-hover:text-[var(--color-text-main)]',
  capGroupChevronOpen: '-rotate-180',
  capGroupLabel:
    'fm-cap-group-label block pl-0 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.06em]',
  capGroupPanel: '',
  capSummary: 'flex flex-wrap gap-[var(--space-2)] pb-[var(--space-1)] pl-[var(--space-4)]',

  tabChip:
    'inline-flex max-w-[min(14rem,85vw)] cursor-pointer items-center gap-[0.4rem] rounded-full border border-border bg-[var(--color-bg)] px-[0.6rem] py-[0.35rem] text-[length:var(--text-caption)] font-medium text-[var(--color-text-main)] no-underline transition-[border-color,background] duration-[var(--transition-fast)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-accent-soft)] [.feed-massive-cap-sheet_&]:bg-[var(--color-surface)]',
  tabChipActive:
    'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]',
  tabChipLabel: 'overflow-hidden text-ellipsis whitespace-nowrap text-left',

  tabDot: 'inline-block h-2 w-2 shrink-0 rounded-full shadow-[0_0_0_1px_rgba(0,0,0,0.2)]',
  tabDotOk: 'bg-[var(--color-lamp-green)]',
  tabDotPartial: 'bg-[var(--color-lamp-yellow)]',
  tabDotFail: 'bg-[var(--color-lamp-red)]',
  tabDotTier: 'bg-[var(--color-link)]',

  tabPanel: 'mt-[var(--space-3)] min-w-0',

  queueSummary:
    'mb-[var(--space-3)] flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)] rounded-[var(--radius-sm)] border border-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)]',
  queueSummaryLabel:
    'text-[length:var(--text-xs)] font-bold uppercase tracking-[0.06em] text-[var(--color-text-muted)]',
  queueSummaryStat: 'text-[var(--color-text)]',
  queueSummaryLink: 'text-[length:var(--text-xs)] text-[var(--color-link)] no-underline hover:underline',
  queueSummaryWarn: 'text-[length:var(--text-xs)] text-[var(--color-warning)]',

  deliveryTabs: 'mb-[var(--space-4)]',
  deliveryTablist:
    'mb-[var(--space-3)] flex flex-wrap gap-0.5 border-b border-border pb-[var(--space-2)]',
  deliveryTab:
    '-mb-px cursor-pointer rounded-t-lg border border-transparent px-4 py-[0.45rem] font-[inherit] text-[length:var(--text-body)] font-semibold text-[var(--color-text-muted)] transition-[background,color] duration-[120ms] hover:bg-[rgba(148,163,184,0.1)] hover:text-[var(--color-text)]',
  deliveryTabActive:
    'border-border border-b-[var(--color-surface,var(--color-bg))] bg-[var(--color-surface,var(--color-bg))] text-[var(--color-text)] shadow-[0_1px_0_0_var(--color-surface,var(--color-bg))]',
  deliveryPanel: 'min-w-0',

  aggTabsWrap: 'mt-[var(--space-4)] overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]',
  aggTabs: 'flex flex-wrap gap-0.5 border-b border-border bg-[var(--color-bg)] p-[var(--space-2)]',
  aggTab:
    'inline-flex cursor-pointer items-center gap-[var(--space-1)] rounded-md border-0 bg-transparent px-[var(--space-3)] py-[var(--space-2)] font-[inherit] text-[length:var(--text-caption)] text-[var(--color-text-dim)] transition-[background,color] duration-[120ms] hover:bg-[rgba(148,163,184,0.12)] hover:text-[var(--color-text)]',
  aggTabActive:
    'bg-[var(--color-surface)] text-[var(--color-text)] shadow-[0_0_0_1px_var(--color-border)] [&_.fm-agg-tab-badge]:bg-[rgba(59,130,246,0.2)] [&_.fm-agg-tab-badge]:text-[var(--color-text)]',
  aggTabBadge:
    'fm-agg-tab-badge inline-block rounded-[3px] bg-[var(--color-border)] px-[5px] py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-dim)]',
  aggTabPanels: 'p-[var(--space-3)_var(--space-4)_var(--space-4)]',
  aggTabPanel: '',
  aggSubDoc: 'text-[length:var(--text-caption)] leading-[1.55] text-[var(--color-text)] [&_p]:my-[var(--space-1)] first:mt-0',
  aggSubEndpoint: '!mt-[var(--space-2)] text-[var(--color-text-dim)]',

  card: 'rounded-[10px] border border-border bg-[var(--color-surface-elevated)] p-[var(--space-4)] transition-[border-color,box-shadow] duration-[var(--transition-fast)] hover:border-[var(--color-border-strong)]',
  cardCapActive:
    'border-[var(--color-accent)] shadow-[0_0_0_1px_var(--color-accent-soft),0_8px_28px_rgba(0,0,0,0.12)] hover:border-[var(--color-accent)] hover:shadow-[0_0_0_1px_var(--color-accent-soft),0_10px_32px_rgba(0,0,0,0.14)] [html[data-theme=light]_&]:shadow-[0_0_0_2px_var(--color-accent-soft),0_6px_20px_var(--color-dashboard-shadow)]',
  cardHead: 'mb-[var(--space-3)] flex flex-wrap items-baseline justify-between gap-[var(--space-2)]',
  cardIcon:
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)] [&_svg]:h-4 [&_svg]:w-4',
  cardLead:
    'm-0 mb-[var(--space-3)] max-w-[42rem] text-[length:var(--text-caption)] leading-[1.5] text-[var(--color-text-muted)]',

  capSection: 'overflow-hidden p-0',
  capPanelHeader: 'm-0',
  capPanelToggle:
    'flex w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[inherit] border-0 bg-transparent p-[var(--space-3)_var(--space-4)] text-left font-[inherit] text-[length:var(--text-body)] font-semibold tracking-[-0.02em] text-[var(--color-text-main)] transition-[background] duration-[var(--transition-fast)] hover:bg-[var(--color-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)]',
  capPanelChevron:
    'inline-block h-[0.45rem] w-[0.45rem] shrink-0 rotate-[-45deg] border-b-2 border-r-2 border-current opacity-65 transition-transform duration-[var(--transition-fast)]',
  capPanelChevronOpen: 'rotate-45',
  capPanelTitle: 'min-w-0 flex-1',
  capPanelBody:
    'flex flex-col gap-[var(--space-3)] border-t border-border p-[0_var(--space-4)_var(--space-4)]',

  sectionHeader:
    'mb-[var(--space-2)] mt-[var(--space-4)] border-b border-[var(--color-border-subtle,var(--color-border))] pb-[var(--space-1)] text-[length:var(--text-sm)] font-semibold uppercase tracking-[0.04em] text-[var(--text-muted)]',
  groupHeader:
    'mb-[var(--space-3)] mt-[var(--space-5)] border-b-2 border-border pb-[var(--space-2)] text-[length:var(--text-base)] font-bold tracking-[0.02em] text-[var(--color-text)] first:mt-0',

  field: 'flex min-w-0 flex-col gap-[var(--space-1)] [&_.form-input]:min-w-[6rem] [&_.form-label]:text-[length:var(--text-tiny)] [&_.form-label]:uppercase [&_.form-label]:tracking-[0.04em] [&_.form-label]:text-[var(--color-text-dim)]',
  fieldLabel: '',
  formGrid: 'mb-[var(--space-3)] grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-[var(--space-3)]',
  formGridWide: 'grid-cols-1 min-[520px]:grid-cols-2',
  inlineActions: 'flex flex-wrap items-end gap-[var(--space-3)]',
  actionsRow: 'mt-[var(--space-1)] flex flex-wrap items-center gap-[var(--space-2)]',

  detailsDebug: 'mt-[var(--space-2)] [&_summary]:cursor-pointer [&_summary]:text-[length:var(--text-caption)] [&_summary]:font-medium [&_summary]:text-[var(--color-text-main)]',
  preJson:
    'm-[var(--space-2)_0_0] max-h-[22rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm,4px)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated,var(--color-bg-secondary))] p-[var(--space-2)] text-[length:var(--text-small,0.8125rem)] leading-[1.4]',

  tableWrap:
    'mt-[var(--space-3)] max-w-full min-w-0 overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-[var(--color-bg)] [scrollbar-color:rgba(148,163,184,0.4)_transparent] [scrollbar-width:thin] [&_.data-table_td]:border-b [&_.data-table_td]:border-border [&_.data-table_th]:border-b [&_.data-table_th]:border-border [&_.data-table_thead_th]:font-semibold [&_.data-table_thead_th]:text-[var(--color-text-muted)] [&_.data-table_tbody_tr:nth-child(even)_td]:bg-[color-mix(in_srgb,var(--color-surface)_50%,transparent)] [html[data-theme=light]_&]:[&_.data-table_tbody_tr:nth-child(even)_td]:bg-[color-mix(in_srgb,var(--color-surface-elevated)_60%,transparent)]',
  table: 'w-full border-collapse',

  empty: 'p-[var(--space-5)] text-center text-[length:var(--text-caption)] text-[var(--color-text-muted)]',
  jobId: 'font-mono font-medium text-[var(--color-link)]',
  badge: 'inline-flex items-center rounded border border-transparent px-2 py-[0.15rem] text-[length:var(--text-tiny)] font-semibold uppercase tracking-[0.04em]',
  badgeDone: 'border-[rgba(34,197,94,0.35)] bg-[var(--color-success-soft)] text-[var(--color-success)]',
  badgeFail: 'border-[rgba(239,68,68,0.35)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
  badgePending: 'border-[rgba(234,179,8,0.35)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  badgeRun: 'border-[rgba(163,230,53,0.25)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]',

  verifyMeta:
    'mt-[var(--space-3)] rounded-md bg-[var(--color-dashboard-tile)] p-[var(--space-2)_var(--space-3)] text-[length:var(--text-caption)] text-[var(--color-text-muted)] [&_strong]:font-mono [&_strong]:text-[var(--color-text-main)]',
  tierGateNotice:
    '!mt-[var(--space-2)] rounded-md border border-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] p-[var(--space-2)_var(--space-3)] text-[length:var(--text-sm)] text-[var(--color-warning)]',

  serviceBlock: 'mb-[var(--space-3)]',
  svcToolbar: 'mb-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)]',
  svcLamp: 'inline-block h-[0.65rem] w-[0.65rem] shrink-0 rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.25)]',
  svcLampOk: 'bg-[var(--color-lamp-green)]',
  svcLampPartial: 'bg-[var(--color-lamp-yellow)]',
  svcLampFail: 'bg-[var(--color-lamp-red)]',
  svcLampTier: 'bg-[var(--color-link)]',
  svcStatusLabel: 'text-[length:var(--text-caption)] font-semibold text-[var(--color-text-muted)]',
  svcCapName: 'text-[length:var(--text-body)] font-semibold leading-[1.2] text-[var(--color-text)]',
  svcImplStatus:
    'rounded-[var(--radius-sm,4px)] bg-[color-mix(in_srgb,var(--color-text-muted)_12%,transparent)] px-[0.45rem] py-[0.1rem] text-[length:var(--text-caption)] font-medium text-[var(--color-text-muted)]',
  svcHelpBtn: 'ml-auto px-[0.65rem] py-1 text-[length:var(--text-caption)]',
  svcWork: 'mb-[var(--space-3)] grid min-w-0 grid-cols-1 gap-[var(--space-3)]',
  svcWorkSplit: 'min-[768px]:grid-cols-2 min-[768px]:items-stretch',
  svcEvidence:
    'min-w-0 rounded-md border border-border bg-[var(--color-dashboard-tile)] p-[var(--space-2)_var(--space-3)]',
  svcTest:
    'min-w-0 rounded-md border border-border bg-[var(--color-dashboard-tile)] p-[var(--space-2)_var(--space-3)]',
  svcEvidenceLabel:
    'mb-[var(--space-1)] block text-[0.65rem] font-bold uppercase tracking-[0.06em] text-[var(--color-text-dim)]',
  svcEvidenceBody: 'text-[length:var(--text-caption)] leading-[1.45] text-[var(--color-text-muted)]',
  svcTestLabel:
    'mb-[var(--space-1)] block text-[0.65rem] font-bold uppercase tracking-[0.06em] text-[var(--color-text-dim)]',
  svcTestBody: 'text-[length:var(--text-caption)] leading-[1.45] text-[var(--color-text-muted)]',
  svcMain:
    'min-[640px]:grid min-[640px]:grid-cols-[minmax(0,auto)_minmax(0,1fr)] min-[640px]:items-start min-[640px]:gap-x-[var(--space-4)] min-[640px]:gap-y-[var(--space-2)] [&_.fm-card-head]:min-[640px]:mb-0 [&_.fm-card-lead]:min-[640px]:m-0 [&_.fm-card-lead]:max-w-none [&_.fm-agg-tabs-wrap]:min-[640px]:col-span-full',
  svcVerification:
    'mt-[var(--space-3)] rounded-lg border border-dashed border-border bg-[var(--color-dashboard-tile)] p-0',
  svcVerificationSummary:
    'cursor-pointer list-none p-[var(--space-2)_var(--space-3)] text-[length:var(--text-caption)] font-semibold text-[var(--color-text-muted)] [&::-webkit-details-marker]:hidden',
  svcVerificationBody:
    'border-t border-[var(--color-border-subtle,rgba(255,255,255,0.06))] p-[0_var(--space-3)_var(--space-3)]',
  svcEvidenceOk: 'text-[var(--color-lamp-green)]',
  svcEvidencePending: 'text-[var(--color-text-muted)]',

  helpLead: 'mb-[var(--space-1)] mt-[var(--space-3)] text-[length:var(--text-caption)] text-[var(--color-text-main)]',
  helpText: 'mb-[var(--space-2)] text-[length:var(--text-small,0.875rem)] leading-[1.5] text-[var(--color-text-muted)]',

  wsCmdRow: 'mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)]',
  wsCmd:
    'block min-w-0 flex-[1_1_0] break-all rounded border border-border bg-[var(--color-bg)] px-2 py-1 text-[length:var(--text-tiny)]',
  wsSubBlock: '',

  flatDeliveryNote: 'mt-[var(--space-1)] text-[0.78rem] opacity-90',
  flatDocLink:
    'ml-1 font-semibold text-[var(--color-link)] underline underline-offset-2 hover:text-[var(--color-link-hover)] focus-visible:rounded-[2px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-link)] [html[data-theme=dark]_&]:text-[#9fd4ff] [html[data-theme=dark]_&]:hover:text-[#c7e6ff]',

  refLists: 'mt-[var(--space-3)] grid grid-cols-2 items-start gap-[var(--space-3)] max-[52rem]:grid-cols-1 [&_.fm-details-debug]:mt-0 [&_.fm-details-debug]:min-w-0',

  dailySection:
    'mb-[var(--space-5)] rounded-[10px] border border-border bg-[var(--color-surface-elevated)] p-[var(--space-4)]',
  dailyHead: 'mb-[var(--space-3)] flex flex-wrap items-start justify-between gap-[var(--space-4)]',
  dailyTitle:
    'mb-[var(--space-1)] text-[length:var(--text-small)] font-bold uppercase tracking-[0.04em] text-[var(--color-text-main)]',
  dailyLead: 'm-0 max-w-[48rem] text-[length:var(--text-caption)] leading-[1.45] text-[var(--color-text-dim)]',
  dailyToolbar: 'flex flex-wrap items-end gap-[var(--space-2)]',
  dailyDate: '[&_input[type=date]]:rounded-md [&_input[type=date]]:border [&_input[type=date]]:border-border [&_input[type=date]]:bg-[var(--color-bg)] [&_input[type=date]]:p-[var(--space-1)_var(--space-2)] [&_input[type=date]]:font-mono [&_input[type=date]]:text-[length:var(--text-caption)] [&_input[type=date]]:text-[var(--color-text-main)]',
  dailyWarn: 'mb-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-dim)]',
  dailyMeta: 'mb-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]',
  dailyTableWrap: 'overflow-x-auto rounded-[10px] border border-border bg-[var(--color-bg)]',
  dailyTable: 'w-full border-collapse text-[length:var(--text-caption)] [&_td]:border-b [&_td]:border-border [&_td]:p-[var(--space-2)] [&_td]:align-middle [&_th]:border-b [&_th]:border-border [&_th]:p-[var(--space-2)] [&_th]:align-middle [&_thead_th]:whitespace-nowrap [&_thead_th]:font-semibold [&_thead_th]:text-[var(--color-text-muted)]',
  dailyBadge:
    'inline-flex min-w-[5.5rem] cursor-default items-center justify-center rounded-md border border-transparent bg-transparent px-2 py-0.5 font-[inherit] text-[length:var(--text-caption)] font-semibold disabled:cursor-default disabled:opacity-85 [&:not(:disabled)]:cursor-pointer',
  dailyBadgeOk:
    'border-[color-mix(in_srgb,var(--color-lamp-green)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-lamp-green)_12%,transparent)] text-[var(--color-lamp-green)]',
  dailyBadgePartial:
    'border-[color-mix(in_srgb,#c9a227_40%,transparent)] bg-[color-mix(in_srgb,#c9a227_12%,transparent)] text-[#c9a227]',
  dailyBadgeDegraded:
    'border-[color-mix(in_srgb,#e67e22_40%,transparent)] bg-[color-mix(in_srgb,#e67e22_10%,transparent)] text-[#e67e22]',
  dailyBadgeBad:
    'border-[color-mix(in_srgb,var(--color-lamp-red)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-lamp-red)_10%,transparent)] text-[var(--color-lamp-red)]',
  dailyBadgeBusy: 'opacity-90',
  dailyResults: 'mt-[var(--space-3)]',
  dailyResultsLabel: 'mb-[var(--space-1)] text-[length:var(--text-caption)] font-semibold text-[var(--color-text-muted)]',
  dailyResultsPre: 'max-h-[16rem] text-[11px]',

  overviewIntro: 'my-[var(--space-3)_0_var(--space-2)] text-[length:var(--text-body)] leading-[1.45] text-[var(--color-text-muted)]',
  overviewGrid: 'mt-[var(--space-3)] grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-[var(--space-4)]',
  overviewColumn:
    'min-w-0 rounded-[var(--radius-md,10px)] border border-border bg-[var(--color-surface-raised,var(--color-bg))] p-[var(--space-4)]',
  overviewColumnTitle: 'mb-[var(--space-2)] text-[length:var(--text-subtitle)] font-semibold',
  overviewColumnLead: 'mb-[var(--space-3)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]',
  overviewGroups: 'm-0 list-none p-0',
  overviewGroup: 'mb-[var(--space-3)] last:mb-0',
  overviewGroupLabel:
    'mb-[var(--space-2)] text-[length:var(--text-tiny)] font-semibold uppercase tracking-[0.04em] text-[var(--color-text-muted)]',
  overviewRows: 'm-0 list-none p-0',
  overviewRow: 'flex items-center gap-[var(--space-2)] py-[0.2rem] text-[length:var(--text-caption)]',
  overviewRowLabel: 'min-w-0',
  overviewActions: 'mt-[var(--space-4)]',
  overviewFootnote: 'mt-[var(--space-5)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]',

  refdbJobs: '',
  refdbJobsToolbar: 'mb-[var(--space-2)] flex flex-wrap items-center justify-between gap-[var(--space-2)]',
  refdbJobsToolbarActions: 'flex flex-wrap items-center gap-[var(--space-2)]',
  refdbOverviewScope: '',
} as const

export function feedMassiveTabDotClass(eff: EffectiveServiceStatus | string): string {
  return cn(
    fm.tabDot,
    eff === 'implemented' && fm.tabDotOk,
    eff === 'partial' && fm.tabDotPartial,
    eff === 'not-on-tier' && fm.tabDotTier,
    eff !== 'implemented' && eff !== 'partial' && eff !== 'not-on-tier' && fm.tabDotFail,
  )
}

export function feedMassiveSvcLampClass(eff: EffectiveServiceStatus | string): string {
  return cn(
    fm.svcLamp,
    eff === 'implemented' && fm.svcLampOk,
    eff === 'partial' && fm.svcLampPartial,
    eff === 'not-on-tier' && fm.svcLampTier,
    eff !== 'implemented' && eff !== 'partial' && eff !== 'not-on-tier' && fm.svcLampFail,
  )
}

export function feedMassiveStatusValueClass(ok: boolean): string {
  return cn(fm.statusValue, ok ? fm.statusValueOk : fm.statusValueBad)
}

export function feedMassiveCapPanelClass(highlight: boolean): string {
  return cn(fm.card, fm.capSection, highlight && fm.cardCapActive)
}

export function feedMassiveJobBadgeClass(status: string): string {
  const s = status.toLowerCase()
  return cn(
    fm.badge,
    s === 'done' && fm.badgeDone,
    s === 'failed' && fm.badgeFail,
    s === 'running' && fm.badgeRun,
    s !== 'done' && s !== 'failed' && s !== 'running' && fm.badgePending,
  )
}

export function feedMassiveDailyBadgeClass(status: string | undefined, busy?: boolean): string {
  const x = (status ?? '').toLowerCase()
  return cn(
    fm.dailyBadge,
    x === 'complete' && fm.dailyBadgeOk,
    x === 'partial' && fm.dailyBadgePartial,
    x === 'degraded' && fm.dailyBadgeDegraded,
    x !== 'complete' && x !== 'partial' && x !== 'degraded' && fm.dailyBadgeBad,
    busy && fm.dailyBadgeBusy,
  )
}
