import { cn } from '@/lib/utils'

/** Option Discovery — Tailwind replacements for od-* / option-discovery-* (Phase 7 Wave 7) */
export const od = {
  greeksCalcTooltip:
    'pointer-events-none fixed z-[1000] max-w-[22rem] rounded-lg border border-border bg-popover p-3 text-xs shadow-lg',
  greeksCalcTooltipColLabel: 'text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground',
  greeksCalcTooltipHeading: 'mb-1 text-[0.65rem] font-bold uppercase tracking-wide text-muted-foreground',
  greeksCalcTooltipKv: 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.72rem] tabular-nums',
  greeksCalcTooltipKvCompare: 'grid-cols-[1.2rem_1fr_1fr]',
  greeksCalcTooltipMono: 'font-mono text-[0.68rem] leading-relaxed text-foreground',
  greeksCalcTooltipSection: 'border-t border-border pt-2 first:border-t-0 first:pt-0',
  greeksCalcTooltipSectionCompare: 'border-t border-dashed border-border',
  greeksCalcTooltipSectionFooter: 'text-muted-foreground',
  greeksCalcTooltipWarn: 'text-amber-400',
  greeksTable: 'w-full text-sm',
  greeksTableDteBadge:
    'ml-2 inline-flex rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-semibold tabular-nums text-muted-foreground',
  greeksTableExpiryHeader: 'bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground',
  greeksTableIvLow: 'text-emerald-400',
  greeksTableIvMid: 'text-amber-400',
  greeksTableIvHigh: 'text-red-400',
  greeksTableDeltaAtm: 'font-semibold text-primary',
  greeksTableRow: 'hover:bg-muted/30',
  greeksTableRowCall: 'border-l-2 border-l-emerald-500/40',
  greeksTableRowPut: 'border-l-2 border-l-red-500/40',
  greeksTableRightBadge:
    'inline-flex min-w-[1.25rem] justify-center rounded px-1 py-px text-[0.62rem] font-bold uppercase',
  greeksTableRightBadgeCall: 'bg-emerald-500/15 text-emerald-400',
  greeksTableRightBadgePut: 'bg-red-500/15 text-red-400',
  mpChartArea: '[margin-bottom:var(--space-3)]',
  mpChartInlineTrendHint: '[font-size:0.65rem] font-bold [letter-spacing:0.08em] [text-transform:uppercase] text-muted-foreground shrink-0',
  mpChartPane: 'min-w-0',
  mpChartPaneHead: 'flex flex-row items-baseline justify-between [gap:0.5rem 0.75rem] flex-wrap [margin-bottom:var(--space-1)] w-full',
  mpChartStack: 'flex flex-col gap-[var(--space-4)] [margin-bottom:var(--space-3)]',
  mpChartSubtitle: '[margin:0 0 var(--space-1)] text-[length:var(--text-caption)] font-semibold text-muted-foreground [letter-spacing:0.02em]',
  mpChartSubtitlePane: '[margin:0 0 var(--space-1)]',
  mpHeaderRow: 'flex items-center justify-between flex-wrap gap-[var(--space-2) var(--space-3)] [margin-bottom:var(--space-2)] w-full',
  mpLegend: 'min-w-0',
  mpLegendItem: 'inline-flex items-center [gap:0.35rem]',
  mpLegendItemMaxPain: 'text-primary font-semibold',
  mpLegendLine: 'min-w-0',
  mpLegendMaxPainValue: '[display:inline-block] [padding:0.04rem 0.35rem] rounded-full [border:1px solid color-mix(in srgb, var(--color-accent) 50%, var(--color-border))] bg-muted/30 text-foreground font-extrabold tabular-nums [letter-spacing:0.01em]',
  mpLegendSwatch: '[display:inline-block] [width:12px] [height:12px] [border-radius:2px] shrink-0',
  mpTab: '[background:none] [border:none] [border-bottom:2px solid transparent] [padding:var(--space-1) var(--space-3)] text-[length:var(--text-caption)] font-semibold text-muted-foreground cursor-pointer whitespace-nowrap',
  mpTabActive: 'text-primary [border-bottom-color:var(--color-accent)]',
  analyticsChartCell: 'flex flex-col min-w-0 [border:1px solid color-mix(in srgb, var(--color-border) 90%, transparent)] rounded-[10px] [padding:var(--space-1) var(--space-2) 0.35rem] bg-muted/30',
  analyticsChartHead: 'flex items-center justify-between gap-[var(--space-2)] [margin-bottom:var(--space-1)]',
  analyticsChartToggleBtn: 'min-w-0',
  analyticsChartsRow: 'grid gap-[var(--space-2)] items-stretch w-full',
  analyticsChartsScroll: 'min-w-0',
  analyticsSection: 'min-w-0',
  analyticsSkew: 'flex flex-wrap items-baseline gap-[var(--space-2)] [margin-bottom:var(--space-3)] text-sm',
  analyticsSkewDetail: 'text-muted-foreground/80 text-[length:var(--text-caption)]',
  analyticsSkewHint: 'text-muted-foreground/80 text-[length:var(--text-caption)]',
  analyticsSkewLabel: 'text-muted-foreground/80 inline-flex items-center gap-[var(--space-1)]',
  analyticsSkewVal: 'font-semibold [color:var(--color-text)]',
  analyticsSkewValCallHeavy: '[color:var(--color-lamp-green, #66bb6a)]',
  analyticsSkewValNeutral: 'text-muted-foreground/80',
  analyticsSkewValPutHeavy: '[color:var(--color-lamp-red, #ef5350)]',
  analyticsTermActions: '[margin:0.35rem 0 0.75rem] flex flex-wrap [gap:0.5rem] items-center',
  analyticsTermPrompt: 'flex flex-col items-start gap-[var(--space-2)] [padding:var(--space-3) 0]',
  analyticsTitle: 'flex items-center gap-[var(--space-2)] [margin:0 0 var(--space-2)]',
  bsCompare: '[&_h4]:flex [&_h4]:items-baseline [&_h4]:flex-wrap [&_h4]:gap-1',
  bsCompareLegend: 'text-left!',
  bsCompareMeta: '[font-size:0.75rem] font-mono text-muted-foreground [margin-bottom:0.6rem]',
  bsCompareNoiv: '[font-size:0.8rem] text-amber-500 [padding:0.4rem_0]',
  bsCompareNote: '[font-size:0.72rem] font-normal text-muted-foreground/80',
  bsCompareTable: 'w-full border-collapse [font-size:0.8rem] font-mono [&_th]:px-[0.6rem] [&_th]:py-1 [&_th]:text-right [&_th]:border-b [&_th]:border-border [&_th]:whitespace-nowrap [&_td]:px-[0.6rem] [&_td]:py-1 [&_td]:text-right [&_td]:border-b [&_td]:border-border [&_td]:whitespace-nowrap [&_th:first-child]:text-left [&_td:first-child]:text-left [&_th:first-child]:font-sans [&_td:first-child]:font-sans [&_th:first-child]:text-muted-foreground [&_td:first-child]:text-muted-foreground [&_th:first-child]:text-[0.75rem] [&_thead_th]:text-[0.72rem] [&_thead_th]:font-semibold [&_thead_th]:uppercase [&_thead_th]:tracking-wide [&_thead_th]:border-b [&_thead_th]:border-border [&_tfoot_td]:text-[0.7rem] [&_tfoot_td]:text-muted-foreground/80 [&_tfoot_td]:font-sans [&_tfoot_td]:border-b-0 [&_tfoot_td]:pt-[0.4rem]',
  bsDiff: 'font-mono font-semibold',
  bsDiffAlert: 'text-red-400',
  bsDiffOk: 'text-muted-foreground/80',
  bsDiffWarn: 'text-amber-500',
  bsDiffHint: '[font-size:0.68rem] font-normal text-muted-foreground/80 [margin-left:0.3rem]',
  cardGrid: 'min-w-0',
  cardSection: 'border border-border rounded-lg [padding:var(--space-2) var(--space-3)] bg-muted/30',
  cardSectionSource: 'min-w-0',
  cardSectionTitle: '[font-size:0.7rem] font-bold [text-transform:uppercase] [letter-spacing:0.04em] text-muted-foreground [margin-bottom:var(--space-2)]',
  cardSectionTitleWithHint: 'flex items-center [gap:0.35rem] flex-wrap',
  chainColGroupLabel: 'min-w-0',
  chainColGroupSep: 'min-w-0',
  chainColumnFilter: 'min-w-0',
  chainColumnFilterItem: 'inline-flex items-center [gap:0.38rem] [padding:0.2rem 0.55rem 0.22rem 0.5rem] rounded-full [border:1px solid color-mix(in srgb, var(--color-border) 88%, transparent)] bg-card text-[length:var(--text-caption)] text-foreground cursor-pointer select-none',
  chainColumnFilterLabel: '[font-size:0.72rem] font-bold [text-transform:uppercase] [letter-spacing:0.04em] text-muted-foreground shrink-0',
  chainColumnFilterList: 'flex flex-wrap [gap:0.4rem 0.5rem] items-center',
  chainExpiryBar: 'min-w-0',
  chainExpiryChip: 'inline-flex flex-row items-center justify-center [gap:0.35rem] [padding:0.2rem 0.55rem 0.2rem 0.6rem] rounded-full [border:1px solid color-mix(in srgb, var(--color-border) 80%, transparent)] bg-card text-foreground [font:inherit] cursor-pointer [line-height:1.2]',
  chainExpiryChipActive: '[border-color:color-mix(in srgb, var(--color-accent) 55%, var(--color-border))] bg-muted/30 [box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent)]',
  chainExpiryChipDate: '[font-size:0.76rem] font-bold tabular-nums [letter-spacing:0.01em]',
  chainExpiryChipDte: '[font-size:0.68rem] font-semibold tabular-nums text-muted-foreground',
  chainExpiryChipKinds: 'inline-flex items-center [gap:0.2rem] shrink-0',
  chainExpiryChipLine: 'inline-flex flex-row items-baseline flex-nowrap [gap:0] whitespace-nowrap min-w-0',
  chainExpiryChipSep: 'text-muted-foreground font-medium [font-size:0.7rem]',
  chainExpiryHint: 'm-0 [flex:1 1 100%]',
  chainExpiryLabel: 'text-[length:var(--text-caption)] font-semibold text-muted-foreground shrink-0',
  chainExpiryStrip: 'flex flex-row flex-wrap items-center [gap:0.35rem] min-w-0 [flex:1 1 auto]',
  chainGroupCall: 'text-center [background:rgba(52, 199, 89, 0.08)] [color:var(--color-success)] [border-right:1px solid var(--color-border)]',
  chainGroupPut: 'text-center [background:rgba(220, 53, 69, 0.07)] [color:var(--color-danger)] [border-left:1px solid var(--color-border)]',
  chainGroupRow: 'min-w-0',
  chainRow: '',
  chainRowAtm: '[background:var(--color-accent-soft, rgba(88, 166, 255, 0.10))] [border-top:2px solid var(--color-accent, #58a6ff)]',
  chainRowItm: '[background:rgba(52,199,89,0.06)]',
  chainRowOtm: '[background:transparent]',
  chainStrikeCell: '[text-align:center !important] font-bold bg-background cursor-pointer [border-left:1px solid var(--color-border)] [border-right:1px solid var(--color-border)]',
  chainStrikeCellSelected: '[box-shadow:inset 0 0 0 2px var(--color-accent)]',
  chainStrikeCol: '[vertical-align:middle] text-center [min-width:4.5rem] bg-background text-foreground [border-left:1px solid var(--color-border)] [border-right:1px solid var(--color-border)]',
  chainTable: 'w-full border-separate [border-spacing:0] text-[length:var(--text-caption)] tabular-nums',
  chainTableWrap: 'overflow-x-auto',
  chainTd: 'cursor-pointer',
  chainTdData: '',
  chainTdSelected: '[background:var(--color-accent-soft) !important]',
  chainThCall: '[background:rgba(52, 199, 89, 0.05)] text-muted-foreground font-semibold text-right [border-right:1px solid var(--color-border)]',
  chainThPut: '[background:rgba(220, 53, 69, 0.05)] text-muted-foreground font-semibold text-right [border-left:1px solid var(--color-border)]',
  chartExpandOverlay: 'fixed inset-0 [z-index:10060] pointer-events-none',
  chartExpandPanel: 'fixed [z-index:1] [box-sizing:border-box] flex flex-col [min-width:420px] [min-height:220px] overflow-hidden [padding:var(--space-2) var(--space-3) var(--space-3)] [border-radius:12px] [border:1px solid color-mix(in srgb, var(--color-border) 90%, var(--color-accent))] bg-muted/30 [box-shadow:0 20px 50px color-mix(in srgb, #000 35%, transparent)] [pointer-events:auto]',
  chartExpandPanelBody: 'flex-1 min-w-0 [min-height:0] overflow-auto w-full',
  chartExpandPanelClose: 'shrink-0 inline-flex items-center justify-center [width:1.75rem] [height:1.75rem] m-0 p-0 border border-border rounded-md bg-card text-muted-foreground [font-size:1.25rem] [line-height:1] cursor-pointer',
  chartExpandPanelDrag: '[cursor:grab]',
  chartExpandPanelHead: 'flex flex-row items-center justify-between gap-[var(--space-2)] [margin-bottom:var(--space-2)] select-none',
  chartExpandPanelHint: 'shrink-0 [margin:var(--space-2) 2rem 0 0] [font-size:0.65rem] text-muted-foreground/80',
  chartExpandPanelTitle: 'm-0 flex-1 min-w-0 [font-size:0.8rem] font-bold [letter-spacing:0.05em] [text-transform:uppercase] text-muted-foreground',
  chartExpandResizeGrip: 'absolute [right:2px] [bottom:2px] [width:22px] [height:22px] [z-index:2] [cursor:nwse-resize] [touch-action:none] [border-radius:0 0 10px 0] [background:linear-gradient( 135deg, transparent 0%, transparent 45%, color-mix(in srgb, var(--color-border-strong) 70%, transparent) 45%, color-mix(in srgb, var(--color-border-strong) 70%, transparent) 50%, transparent 50%, transparent 58%, color-mix(in srgb, var(--color-border-strong) 70%, transparent) 58%, color-mix(in srgb, var(--color-border-strong) 70%, transparent) 64%, transparent 64% )]',
  chartExpandTrigger: 'cursor-pointer min-w-0',
  chartSvg: 'min-w-0',
  chartVwapMissing: '[margin:0.5rem 0 0.75rem] [padding:0.5rem 0.65rem] text-[length:var(--text-caption)] [line-height:1.45] [color:var(--danger, #b91c1c)] [background:rgba(185, 28, 28, 0.1)] [border:1px solid rgba(185, 28, 28, 0.35)] rounded-md',
  compareDrawer: '[width:min(32rem, 100vw)] [max-width:100%] bg-card [border-left:1px solid var(--color-border)] [padding:var(--space-4)] overflow-y-auto [box-shadow:-4px 0 24px rgba(0, 0, 0, 0.15)]',
  compareDrawerActions: '[margin-top:var(--space-3)]',
  compareDrawerBackdrop: 'min-w-0',
  compareDrawerHeader: 'flex items-center justify-between gap-[var(--space-2)] [margin-bottom:var(--space-2)]',
  compareDrawerMeta: '[margin:0 0 var(--space-3)]',
  compareDrawerTitle: 'm-0 [font-size:var(--text-h3, 1.1rem)]',
  compareIconBtn: 'relative shrink-0',
  compareIconBtnCount: 'absolute [top:-0.35rem] [right:-0.35rem] [min-width:1rem] [height:1rem] [padding:0 0.2rem] rounded-full [background:var(--color-accent, #6ea8fe)] [color:#fff] [border:1px solid var(--color-surface)] [font-size:0.62rem] [line-height:1rem] text-center tabular-nums [pointer-events:none]',
  compareTable: 'min-w-0',
  compareTableWrap: '[max-height:60vh] overflow-auto',
  contractChart: 'min-w-0',
  contractChartIconBtn: 'min-w-0',
  contractChartPeriodCluster: 'flex flex-wrap items-center [gap:0.5rem 0.75rem] [flex:0 1 auto] min-w-0',
  contractChartPeriodInput: 'absolute [width:1px] [height:1px] p-0 [margin:-1px] overflow-hidden [clip:rect(0, 0, 0, 0)] whitespace-nowrap [border:0]',
  contractChartPeriodItem: 'relative inline-flex items-center justify-center cursor-pointer text-[length:var(--text-caption)] [padding:0.4rem 0.9rem] rounded-full border border-border bg-card text-muted-foreground select-none',
  contractChartPeriodItemText: '[line-height:1.2]',
  contractChartPeriods: 'flex flex-wrap [gap:0.4rem] items-center',
  contractChartSource: '[min-width:8rem] [padding:0.25rem 0.5rem] rounded-md border border-border bg-card [color:var(--color-text)]',
  contractChartToolbar: 'min-w-0',
  contractChartToolbarLabel: 'text-[length:var(--text-caption)] text-muted-foreground font-semibold [text-transform:uppercase] [letter-spacing:0.03em]',
  contractChartToolbarRight: 'flex flex-wrap items-center justify-end [gap:0.5rem 0.75rem] [flex:0 1 auto] [margin-left:auto]',
  contractChartVwapToggle: 'inline-flex items-center [gap:0.45rem] cursor-pointer text-[length:var(--text-caption)] font-semibold [color:var(--color-text)] select-none [padding:0.4rem 0.95rem] rounded-full border border-border bg-card',
  contractDetail: 'min-w-0',
  contractDetailDrawer: '[margin-top:0]',
  contractDetailStack: 'min-w-0',
  dailyDataOpenBtn: 'min-w-0',
  dataState: '[padding:var(--space-2)] rounded-md bg-card [border:1px dashed var(--color-border)]',
  dataStateHint: 'min-w-0',
  dataStateTitle: 'block font-semibold [margin-bottom:0.25rem]',
  detailClose: '[background:none] [border:none] [font-size:1.1rem] text-muted-foreground cursor-pointer [padding:0.15rem 0.4rem] rounded [line-height:1]',
  detailDelayed: '[font-size:0.7rem] font-semibold [color:#d29922] whitespace-nowrap',
  detailExpiry: '[font-weight:400] [font-size:0.8rem] text-muted-foreground',
  detailHeader: 'flex items-center gap-[var(--space-2)] [padding:var(--space-2) var(--space-3)] bg-background [border-bottom:1px solid var(--color-border)] flex-wrap',
  detailSection: '[padding:var(--space-3)] [border-top:1px solid var(--color-border)]',
  detailSectionTitle: '[margin:0 0 0.65rem] [font-size:0.75rem] font-bold [letter-spacing:0.04em] [text-transform:uppercase] text-muted-foreground',
  detailTab: '[padding:0.45rem 1rem] [background:none] [border:none] [border-bottom:2px solid transparent] text-muted-foreground [font-size:0.75rem] font-semibold cursor-pointer whitespace-nowrap',
  detailTabActive: 'text-primary [border-bottom-color:var(--color-accent)]',
  detailTitle: 'm-0 [font-size:0.95rem] font-bold [color:var(--color-text)] flex-1 min-w-0',
  eventWarningItem: 'min-w-0',
  eventWarnings: '[margin-top:var(--space-2)] [padding:var(--space-2) var(--space-3)] [background:rgba(210, 153, 34, 0.08)] [border:1px solid rgba(210, 153, 34, 0.3)] rounded-lg text-[length:var(--text-caption)] [color:#d29922]',
  eventWarningsDrawer: '[margin-bottom:var(--space-2)]',
  execChip: '[padding:2px 8px] rounded font-semibold whitespace-nowrap',
  execChipDanger: '[background:rgba(248, 81, 73, .12)] [color:var(--color-danger)]',
  execChipOk: '[background:rgba(52, 199, 89, .12)] [color:var(--color-success)]',
  execChipWarn: '[background:rgba(210, 153, 34, .12)] [color:#d29922]',
  execGuidance: 'min-w-0',
  execGuidanceTitle: 'font-bold [text-transform:uppercase] [letter-spacing:0.03em] text-muted-foreground [margin-right:var(--space-1)]',
  feedbackActions: 'min-w-0',
  gexDisclaimer: '[margin-top:var(--space-2)] [margin-bottom:0] [max-width:42rem]',
  greeksSourceBtn: '[background:transparent] [border:none] [padding:0.1rem 0.45rem] [font-size:0.62rem] font-semibold [text-transform:uppercase] [letter-spacing:0.04em] text-muted-foreground/80 cursor-pointer [line-height:1.6]',
  greeksSourceBtnActive: '[background:var(--color-accent-soft)] text-primary',
  greeksSourceToggle: 'min-w-0',
  ivBandIncomplete: 'font-semibold [color:var(--color-warning, #c98a2a)]',
  ivBar: 'w-full [max-width:1.2rem] [background:var(--color-border-strong)] [border-radius:2px 2px 0 0]',
  ivBarLabel: '[font-size:0.55rem] text-muted-foreground [margin-top:2px] [writing-mode:vertical-lr] [text-orientation:mixed] [max-height:2.5rem] overflow-hidden',
  ivBarWrap: 'flex-1 min-w-0 flex flex-col items-center [height:100%] justify-end',
  ivCombinedDetails: 'w-full min-w-0 [margin-top:var(--space-3)]',
  ivCombinedSummary: 'list-none cursor-pointer flex items-center [gap:0.4rem] [padding:var(--space-2) var(--space-3)] border border-border rounded-lg bg-muted/30 text-[length:var(--text-caption)] font-semibold text-muted-foreground select-none',
  ivCombinedSummaryText: 'flex-1 min-w-0',
  ivDataCellMuted: 'text-muted-foreground/80',
  ivDataCellWarn: 'tabular-nums',
  ivDataCode: '[font-size:0.85em] [padding:0.1em 0.35em] rounded bg-muted/30',
  ivDataRowConeWarn: '[background:rgba(201, 138, 42, 0.08)]',
  ivDataSource: '[margin:0 0 0.5rem !important] text-[length:var(--text-caption)] [line-height:1.4] [overflow-wrap:anywhere] [word-break:break-word]',
  ivDataTable: 'w-full border-collapse text-[length:var(--text-caption)]',
  ivDataTableMerged: 'min-w-0 max-w-full table-fixed text-[0.875rem] leading-[1.35]',
  ivDataTableEmpty: '[text-align:center !important] text-muted-foreground/80 [font-style:italic]',
  ivDataTableHeading: '[margin:0 0 0.35rem] text-sm font-semibold [color:var(--color-text)]',
  ivDataTableScroll: 'overflow-x-auto [-webkit-overflow-scrolling:touch]',
  ivDataTableSheet: 'w-full min-w-0 [max-width:100%] [margin-top:var(--space-3)] [padding:var(--space-2)] border border-border rounded-lg bg-card [overflow:visible]',
  ivDataTableSheetInDetails: '[margin-top:0] [border-top-left-radius:0] [border-top-right-radius:0]',
  ivDataTableWrap: 'min-w-0',
  ivDataTableWrapIvSheet: 'min-w-0',
  ivParamBandError: 'min-w-0',
  ivParamLegend: 'flex flex-wrap items-center gap-[var(--space-2) var(--space-3)] text-[length:var(--text-tiny)] text-muted-foreground [line-height:1.35]',
  ivParamLegendItem: 'inline-flex items-center [gap:0.35rem] whitespace-nowrap',
  ivParamSwatch: '[display:inline-block] [width:14px] [height:3px] [border-radius:1px] shrink-0',
  ivParamSwatchCall: '[width:8px] [height:8px] [border-radius:50%] [background:var(--color-accent, #6ea8fe)] border border-border',
  ivParamSwatchMean: '[background:var(--color-accent, #a3e635)] [height:3px]',
  ivParamSwatchMinmax: '[background:repeating-linear-gradient( 90deg, var(--color-text-muted) 0 3px, transparent 3px 6px )] [height:2px]',
  ivParamSwatchPut: '[width:8px] [height:8px] [border-radius:50%] [background:var(--color-warning, #e8a849)] border border-border',
  ivParamSwatchSd1: '[background:repeating-linear-gradient( 90deg, var(--color-link, #7dd3fc) 0 4px, transparent 4px 7px )] [height:2px]',
  ivParamSwatchSd2: '[background:repeating-linear-gradient(90deg, #64748b 0 2px, transparent 2px 5px)] [height:2px]',
  ivSamplesActual: 'font-semibold',
  ivSamplesPair: 'tabular-nums',
  ivSamplesReq: 'min-w-0',
  ivSamplesSep: 'min-w-0',
  ivSheetHover: 'group/iv inline-flex items-center relative cursor-help max-w-full',
  ivSheetHoverPopup: 'absolute [left:50%] [transform:translateX(-50%)] [top:calc(100% + 0.35rem)] [z-index:120] [min-width:14rem] [max-width:22rem] [padding:0.5rem 0.75rem] text-[length:var(--text-caption)] [font-weight:normal] [line-height:1.45] text-muted-foreground bg-background border border-border rounded-md [box-shadow:0 2px 8px rgba(0, 0, 0, 0.15)] [white-space:normal] [opacity:0] [pointer-events:none] group-hover/iv:opacity-100 group-hover/iv:pointer-events-auto',
  ivSheetHoverTarget: 'border-b border-dotted border-muted-foreground/80 group-[.iv-warn]/iv:font-semibold group-[.iv-warn]/iv:text-amber-500 group-[.iv-warn]/iv:border-amber-500',
  ivSheetHoverWarn: 'iv-warn',
  ivTermActionIconBtn: 'shrink-0',
  ivTermBackfillHint: '[margin-top:0.5rem] [margin-bottom:0]',
  ivTermChartCaption: '[margin-top:0.75rem] [margin-bottom:0] text-[length:var(--text-caption)] [word-break:break-word]',
  ivTermChartPane: 'min-w-0',
  ivTermChartPaneTitle: '[margin-top:0] [margin-bottom:0.35rem]',
  ivTermChartSvgWrap: 'w-full min-w-0',
  ivTermChartSvgWrapParametric: 'flex flex-col gap-[var(--space-2)]',
  ivTermConeChartsRow: 'grid grid-cols-2 gap-[var(--space-3)] items-stretch w-full min-w-0 [margin-top:0.5rem] max-[960px]:grid-cols-1',
  ivTermConeChartsRowTriple: 'grid-cols-3 max-[960px]:grid-cols-1',
  ivTermError: '[color:var(--color-danger, #c62828)] [margin-bottom:0.35rem]',
  ivTermExpBadges: 'inline-flex items-center [gap:0.3rem] shrink-0 [margin-left:0.15rem]',
  ivTermExpCard: 'min-w-0',
  ivTermExpCardActions: 'flex flex-wrap [gap:0.35rem] items-center justify-end [flex:1 1 auto] min-w-0',
  ivTermExpCardBadge: '[font-size:0.7rem] font-semibold tabular-nums [padding:0.12rem 0.45rem] rounded-full [border:1px solid color-mix(in srgb, var(--color-border) 70%, transparent)] bg-muted/30 text-foreground',
  ivTermExpCardBadgeWarn: '[border-color:color-mix(in srgb, var(--color-warning, #b45309) 45%, var(--color-border))] [color:var(--color-warning, #b45309)]',
  ivTermExpCardHeader: 'flex flex-col items-stretch [gap:0.35rem] [padding:0.55rem 0.65rem 0.5rem] [border-bottom:1px solid color-mix(in srgb, var(--color-border) 80%, transparent)]',
  ivTermExpCardHeading: 'flex flex-wrap items-center justify-between [gap:0.5rem 0.75rem] min-w-0 w-full',
  ivTermExpCardTitle: 'inline-flex items-center [gap:0.35rem] [font-size:0.7rem] font-bold [letter-spacing:0.06em] [text-transform:uppercase] text-muted-foreground',
  ivTermExpCheckbox: 'shrink-0 [width:0.95rem] [height:0.95rem] m-0 [accent-color:var(--color-accent, #6ea8fe)] [cursor:inherit]',
  ivTermExpDate: '[font-size:0.78rem] font-medium tabular-nums [letter-spacing:0.01em] text-foreground whitespace-nowrap overflow-hidden [text-overflow:ellipsis] [max-width:100%]',
  ivTermExpDateBlock: 'flex-1 min-w-0 flex flex-row items-center flex-nowrap [gap:0] [line-height:1.2]',
  ivTermExpDateDteSep: 'text-muted-foreground [font-size:0.72rem] font-medium shrink-0',
  ivTermExpDte: '[font-size:0.68rem] font-medium tabular-nums text-muted-foreground',
  ivTermExpFilterRow: '[width:auto] [flex:0 1 auto] justify-start min-w-0',
  ivTermExpItem: 'flex items-center [gap:0.45rem] m-0 [padding:0.38rem 0.45rem 0.38rem 0.4rem] rounded-lg [border:1px solid color-mix(in srgb, var(--color-border) 65%, transparent)] bg-muted/30 cursor-pointer',
  ivTermExpItemChecked: '[border-color:color-mix(in srgb, var(--color-accent) 55%, var(--color-border))] bg-muted/30 [box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent)]',
  ivTermExpKindBubble: 'min-w-0',
  ivTermExpLi: 'm-0 min-w-0',
  ivTermExpList: 'list-none m-0 [padding:0.5rem 0.55rem 0.55rem] grid [grid-template-columns:repeat(auto-fill, minmax(11.5rem, 1fr))] [gap:0.35rem] [max-height:12rem] overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:thin]',
  ivTermExpListStatus: 'min-w-0',
  ivTermExpPanel: 'min-w-0',
  ivTermExpToolbar: 'flex flex-row flex-wrap items-center [gap:0.35rem 0.55rem] w-full min-w-0',
  ivTermQuality: 'inline-flex items-center shrink-0 text-muted-foreground',
  ivTermQualityGood: '[color:var(--color-lamp-green, #66bb6a)]',
  ivTermQualityLimited: '[color:var(--color-warning, #b45309)]',
  ivTermQualityUnknown: 'text-muted-foreground/80',
  ivTermQuickSelectBtn: 'shrink-0 [padding:0.28rem 0.65rem] [font-size:0.72rem] font-semibold [letter-spacing:0.02em] rounded-full [border:1px solid color-mix(in srgb, var(--color-accent) 35%, var(--color-border))] bg-muted/30 text-foreground cursor-pointer',
  ivTermQuickSelectBtnMuted: '[border-color:color-mix(in srgb, var(--color-border) 90%, var(--color-text-muted))] bg-muted/30 text-muted-foreground',
  ivTermSection: '[margin-top:0]',
  ivTermSyncStatus: '[margin:0.35rem 0 0.5rem]',
  kvDim: 'text-muted-foreground [font-weight:400] [font-size:0.7rem]',
  kvGrid: 'grid [grid-template-columns:auto 1fr] [gap:0.2rem 0.75rem] text-[length:var(--text-caption)] tabular-nums',
  kvK: 'text-muted-foreground font-medium whitespace-nowrap',
  kvV: '[color:var(--color-text)] font-semibold',
  layerLockedHint: 'm-0',
  layerSection: '[scroll-margin-top:6rem] [padding-bottom:var(--space-2)] border-b border-border last:border-b-0',
  layerSectionBody: 'min-w-0',
  layerSectionHeadText: 'min-w-0 flex-1',
  layerSectionHeader: 'flex items-start gap-[var(--space-2)] [margin-bottom:var(--space-3)]',
  layerSectionLocked: '[&_header]:opacity-75',
  layerSectionSubtitle: '[margin:0.25rem 0 0]',
  layerSectionTitle: 'm-0 [font-size:var(--text-h3, 1.1rem)] font-semibold text-foreground',
  layerStep: 'shrink-0 [width:1.75rem] [height:1.75rem] [border-radius:50%] inline-flex items-center justify-center text-[length:var(--text-caption)] font-bold bg-card border border-border text-foreground',
  layerToggleBtn: 'shrink-0',
  maxPainCardLabel: 'text-[length:var(--text-caption)] text-muted-foreground/80 shrink-0',
  maxPainChartCell: 'flex flex-col [border:1px solid color-mix(in srgb, var(--color-border) 90%, transparent)] rounded-[10px] [padding:var(--space-1) var(--space-2) 0.35rem] bg-muted/30 min-w-0',
  maxPainChartsRow: 'grid grid-cols-3 gap-[var(--space-2)] items-stretch w-max min-w-[48rem] max-w-none',
  maxPainChartsScroll: 'min-w-0',
  maxPainCorpWarn: 'm-0 text-[length:var(--text-caption)] [color:#c9a227]',
  maxPainCorpWarnBelowMetrics: '[margin-top:var(--space-2)]',
  maxPainDisclaimerBody: '[margin:var(--space-2) 0 0] [padding-left:0.15rem] text-[length:var(--text-caption)] text-muted-foreground/80 [line-height:1.45]',
  maxPainDisclaimerDetails: '[margin:var(--space-3) 0 0] [max-width:52rem]',
  maxPainDisclaimerSummary: 'cursor-pointer list-none text-[length:var(--text-caption)] font-semibold text-muted-foreground select-none',
  maxPainHeader: 'min-w-0',
  maxPainHeaderActions: 'inline-flex items-center [gap:0.45rem]',
  maxPainLayout: 'w-full max-w-none [margin-bottom:var(--space-3)] max-[52rem]:max-w-full',
  maxPainMetricCell: 'inline-flex flex-row items-baseline [gap:0.35rem] [flex:0 0 auto] min-w-0 whitespace-nowrap',
  maxPainMetricsBar: 'w-full [margin-bottom:var(--space-3)] min-w-0',
  maxPainMetricsInner: 'flex flex-row flex-nowrap items-end [gap:0.75rem 1.5rem] [padding:var(--space-2) var(--space-3)] rounded-[10px] [border:1px solid color-mix(in srgb, var(--color-accent) 22%, var(--color-border))] bg-muted/30 [box-shadow:0 1px 0 color-mix(in srgb, var(--color-border) 55%, transparent)] overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:thin]',
  maxPainPanel: 'min-w-0',
  maxPainRefreshIconBtn: 'min-w-0',
  maxPainSection: '[margin-top:var(--space-4)] [padding-top:var(--space-3)] [border-top:1px solid var(--color-border)]',
  maxPainSvg: 'block w-full [max-width:100%] [height:auto]',
  maxPainTitle: 'm-0 text-[length:var(--text-body)] inline-flex items-center [gap:0.35rem] flex-wrap',
  maxPainTitleExp: 'font-medium [font-size:0.92em] text-muted-foreground tabular-nums',
  maxPainTrendPane: '[margin-top:0]',
  moneynessBadge: 'inline-block [padding:1px_6px] rounded [font-size:0.65rem] font-bold [letter-spacing:0.03em] uppercase align-middle',
  moneynessBadgeAtm: '[background:var(--color-accent-soft, rgba(88, 166, 255, .15))] text-primary',
  moneynessBadgeItm: '[background:var(--color-success-soft, rgba(52, 199, 89, .15))] [color:var(--color-success)]',
  moneynessBadgeOtm: 'bg-muted/30 text-muted-foreground',
  optionQuotesHeadRow: 'flex flex-wrap items-center [gap:0.5rem 0.75rem] [margin-top:0.45rem] [margin-bottom:0.65rem]',
  optionQuotesHeadTitle: 'm-0 inline-flex items-center [gap:0.35rem]',
  optionQuotesRefreshBtn: 'min-w-0',
  optionQuotesUnderlying: 'whitespace-nowrap',
  optionStructureStack: 'min-w-0',
  pageToc: 'flex flex-wrap gap-[var(--space-2) var(--space-3)] [margin-top:var(--space-2)] [padding-top:var(--space-2)] [border-top:1px solid var(--color-border)] text-[length:var(--text-caption)]',
  pnlNeg: '[color:var(--color-danger)] font-bold',
  pnlPos: '[color:var(--color-success)] font-bold',
  qualityBadge: 'min-w-0',
  qualityBadgeTitle: 'font-bold [text-transform:uppercase] [letter-spacing:0.03em] text-muted-foreground',
  qualityItem: '[padding:1px 8px] rounded bg-muted/30 [color:var(--color-text)] font-semibold',
  quotesRefreshMeta: 'min-w-0',
  quotesRefreshTs: '[font-size:0.68rem] [font-family:var(--font-mono, monospace)] text-muted-foreground/80 whitespace-nowrap',
  quoteRow: 'cursor-pointer transition-colors hover:bg-muted/40',
  quoteRowSelected: '[background:var(--color-accent-soft)] [outline:1px_solid_var(--color-accent)] [outline-offset:-1px]',
  rvLabel: 'font-extrabold!',
  rvLabelCheap: 'text-green-500!',
  rvLabelNeutral: 'text-primary',
  rvLabelRich: '[color:var(--color-danger) !important]',
  scenarioTable: 'min-w-0',
  snapshotFeedback: 'flex flex-col gap-1 [margin-bottom:var(--space-2)] [padding:var(--space-2)_var(--space-3)] rounded-lg text-[length:var(--text-caption)] [line-height:1.5]',
  snapshotFeedbackError: '[background:rgba(204, 0, 0, 0.07)] [border:1px solid rgba(204, 0, 0, 0.3)] [color:var(--color-danger, #c00)]',
  snapshotFeedbackInfo: '[background:rgba(56, 132, 244, 0.06)] [border:1px solid rgba(56, 132, 244, 0.2)] [color:#3884f4]',
  snapshotFeedbackWarning: '[background:rgba(210, 153, 34, 0.08)] [border:1px solid rgba(210, 153, 34, 0.3)] [color:#d29922]',
  snapshotWatchHint: '[margin:var(--space-2) 0 0] p-0 text-[length:var(--text-caption)] [line-height:1.45] text-muted-foreground [border:0]',
  stickyContext: 'min-w-0',
  stickyContextInStack: 'min-w-0',
  stickyContextChip: 'text-[length:var(--text-body)] font-semibold text-foreground',
  stickyContextRow: 'flex flex-wrap items-center gap-[var(--space-2)] justify-between',
  strikeRangeIconBtn: 'min-w-0',
  tradabilityFactor: 'flex justify-between gap-[var(--space-2)] text-[length:var(--text-caption)]',
  tradabilityFactors: 'flex flex-col [gap:0.15rem]',
  tradabilityFair: '[color:#d29922]',
  tradabilityGood: '[color:var(--color-success)]',
  tradabilityLabel: '[font-size:0.8rem] text-muted-foreground',
  tradabilityPoor: '[color:var(--color-danger)]',
  tradabilityScore: 'min-w-0',
  tradabilityValue: '[font-size:1.8rem] font-extrabold tabular-nums',
  underlyingApplyBtn: 'shrink-0',
  underlyingBubbleRow: 'flex flex-wrap [gap:0.35rem] items-center min-w-0 [flex:1 1 auto]',
  underlyingBubbles: 'min-w-0',
  underlyingBubblesBelowManual: '[margin-top:0.55rem]',
  underlyingBubblesLabel: '[font-size:0.7rem] font-bold [letter-spacing:0.06em] [text-transform:uppercase] text-muted-foreground shrink-0',
  underlyingChip: 'inline-flex flex-row items-center justify-center [gap:0.25rem] [padding:0.22rem 0.6rem] [min-height:auto] rounded-full [border:1px solid color-mix(in srgb, var(--color-border) 80%, transparent)] bg-muted/30 text-foreground [font:inherit] cursor-pointer [line-height:1.15]',
  underlyingChipActive: '[border-color:color-mix(in srgb, var(--color-accent) 55%, var(--color-border))] bg-muted/30 [box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent)]',
  underlyingChipLine: 'inline-flex flex-row items-baseline flex-nowrap [gap:0] whitespace-nowrap [max-width:100%] min-w-0',
  underlyingChipPrice: '[font-size:0.65rem] font-semibold tabular-nums text-muted-foreground',
  underlyingChipSep: 'text-muted-foreground font-medium [font-size:0.7rem]',
  underlyingChipSymbol: '[font-size:0.78rem] font-bold tabular-nums [letter-spacing:0.02em]',
  underlyingEmptyHint: 'm-0 text-[length:var(--text-caption)]',
  underlyingManualInput: '[flex:1 1 140px] min-w-0 [max-width:12rem] font-semibold tabular-nums',
  underlyingManualLabel: '[font-size:0.7rem] font-bold [letter-spacing:0.06em] [text-transform:uppercase] text-muted-foreground shrink-0',
  underlyingManualRow: 'min-w-0',
  optionDiscoveryConditionsHeadRow: 'flex flex-nowrap items-center [gap:0.5rem 0.75rem] shrink-0 [margin-bottom:var(--space-2)] min-w-0',
  optionDiscoveryControls: 'min-w-0',
  optionDiscoveryDailySummary: 'shrink-0 flex flex-wrap items-center [gap:0.5rem 0.75rem] [margin-bottom:var(--space-2)]',
  optionDiscoveryDailySummaryInline: 'shrink-0 flex flex-wrap items-center [gap:0.5rem 0.75rem] [margin-bottom:var(--space-2)]',
  optionDiscoveryDailySummaryBits: '[flex:1 1 14rem] min-w-0',
  optionDiscoveryDailySummaryLabel: 'text-[length:var(--text-caption)] font-semibold text-muted-foreground shrink-0 whitespace-nowrap',
  optionDiscoveryExpFilterBtn: 'w-full border border-border bg-card text-muted-foreground/80 [border-radius:7px] [font-size:0.62rem] [line-height:1] [padding:0.16rem 0.24rem] cursor-pointer',
  optionDiscoveryExpirationDaysCell: 'font-bold text-primary whitespace-nowrap',
  optionDiscoveryExpirationDaysHeader: 'font-bold text-primary',
  optionDiscoveryExpirationEmptyCell: 'text-center text-muted-foreground/80 text-[length:var(--text-caption)] [padding:0.8rem var(--space-2)]',
  optionDiscoveryExpirationFilters: 'grid [grid-template-columns:repeat(4, minmax(0, 1fr))] [gap:0.2rem] [margin:0.1rem 0 0.25rem]',
  optionDiscoveryExpirationKindBadge: 'inline-flex items-center whitespace-nowrap [padding:0.02rem 0.28rem] rounded-full border border-border [font-size:0.56rem] font-bold [line-height:1.2] shrink-0',
  optionDiscoveryExpirationKindBadgeQuarterlies: '[border-color:#8a6a2b] [color:#ffe4a3] [background:rgba(138, 106, 43, 0.24)]',
  optionDiscoveryExpirationKindBadgeWeeklies: '[border-color:#2f8f6b] [color:#c6f6e7] [background:rgba(47, 143, 107, 0.22)]',
  optionDiscoveryFullChain: 'min-w-0',
  optionDiscoveryLayout: 'min-w-0',
  optionDiscoveryListEmpty: '[padding:var(--space-2)] text-[length:var(--text-caption)] text-muted-foreground text-center',
  optionDiscoveryListHeader: '[padding:0.25rem var(--space-2)] [font-size:0.7rem] font-semibold [text-transform:uppercase] [letter-spacing:0.03em] text-muted-foreground bg-background border border-border [border-bottom:none] [border-radius:8px 8px 0 0]',
  optionDiscoveryListTable: 'w-full border-collapse text-[length:var(--text-caption)] tabular-nums',
  optionDiscoveryListWithHeader: 'min-w-0',
  optionDiscoveryListWrap: '[height:14rem] [min-height:14rem] [max-height:14rem] overflow-x-hidden overflow-y-auto border border-border rounded-lg bg-muted/30 [min-width:10rem]',
  optionDiscoveryMain: 'w-full min-w-0',
  optionDiscoveryMainInner: 'flex flex-col gap-[var(--space-4)] min-w-0',
  optionDiscoveryQuoteSourceInline: 'flex flex-wrap items-center [gap:0.35rem 0.5rem] shrink-0',
  optionDiscoveryQuoteSourceLabel: 'm-0',
  optionDiscoverySessionBar: 'min-w-0',
  optionDiscoveryStickyStack: 'sticky [top:var(--space-2)] [z-index:3] [margin:0 calc(-1 * var(--space-1))] bg-card border border-border rounded-lg [box-shadow:0 1px 0 rgba(0, 0, 0, 0.06)] [overflow:visible]',
  optionDiscoveryStrikeWindow: 'min-w-0',
  optionDiscoveryStrikeWindowCount: '[font-weight:400] [margin-left:auto]',
  optionDiscoveryStrikeWindowHint: '[margin:0 var(--space-3) var(--space-2)]',
  optionDiscoveryStrikeWindowSummary: 'cursor-pointer [padding:var(--space-2) var(--space-3)] text-[length:var(--text-body)] font-semibold text-foreground flex items-center gap-[var(--space-3)] select-none [list-style:revert]',
  optionDiscoveryStrikesContent: 'min-w-0',
  optionDiscoveryStrikesWithHeader: 'min-w-0',
  optionDiscoveryUnderlying: 'min-w-0',
  optionDiscoveryUnderlyingBody: 'min-w-0',
  optionDiscoveryUnderlyingPrice: '[font-size:0.8rem] text-muted-foreground',
  optionDiscoveryViewScope: 'min-w-0',
  optionDiscoveryViewScopeHint: '[margin:0 0 var(--space-3)] text-[length:var(--text-caption)] text-muted-foreground',
  optionGreeksPage: 'flex flex-col gap-4',
  optionGreeksPageControls: 'rounded-lg border border-border bg-card p-4',
  optionGreeksPageControlsInner: 'flex flex-wrap items-end gap-4',
  optionGreeksPageEmpty: 'py-8 text-center text-sm text-muted-foreground',
  optionGreeksPageError: 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
  optionGreeksPageField: 'flex min-w-[8rem] flex-col gap-1',
  optionGreeksPageInfoApprox: 'text-xs italic text-muted-foreground',
  optionGreeksPageInfoBar: 'flex flex-wrap gap-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm',
  optionGreeksPageInfoItem: 'inline-flex items-baseline gap-1.5',
  optionGreeksPageInfoLabel: 'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
  optionGreeksPageInput: 'h-9 rounded-md border border-border bg-background px-2 text-sm',
  optionGreeksPageLabel: 'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
  optionGreeksPageLoadBtn: 'h-9 shrink-0',
  optionGreeksPageLoading: 'py-6 text-center text-sm text-muted-foreground',
  optionGreeksPageLoadingDots: 'text-muted-foreground',
  optionGreeksPageSelect: 'h-9 rounded-md border border-border bg-background px-2 text-sm',
  optionGreeksPageToggleGroup: 'inline-flex overflow-hidden rounded-md border border-border',
  optionGreeksToggle: 'border-0 bg-transparent px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/40',
  optionGreeksToggleActive: 'bg-primary/10 font-semibold text-primary',
  strikeLadderCellCheck: 'min-w-0',
  strikeLadderCellStrike: 'min-w-0',
  strikeLadderCellStrikeOi: '[min-width:7.25rem] [max-width:9.5rem] [padding:0.25rem var(--space-2) !important] [vertical-align:top]',
  strikeLadderCol: 'flex-1 min-w-0 flex flex-col',
  strikeLadderColHeader: 'flex items-center justify-between gap-[var(--space-1)] [padding:0.25rem var(--space-2)] [font-size:0.7rem] font-semibold [text-transform:uppercase] [letter-spacing:0.03em] text-muted-foreground bg-background border border-border [border-bottom:none] [border-radius:8px 8px 0 0]',
  strikeLadderColHeaderCall: '[color:var(--color-success)]',
  strikeLadderColHeaderCheck: 'inline-flex items-center [gap:0.35rem] cursor-pointer m-0',
  strikeLadderColHeaderPut: '[color:var(--color-danger)]',
  strikeLadderColRange: '[flex:0 1 auto] [min-width:10rem] flex flex-col [align-self:stretch]',
  strikeLadderControls: 'shrink-0 flex flex-col gap-[var(--space-2)] [padding:var(--space-2)] border border-border rounded-lg bg-muted/30',
  strikeLadderControlsPrice: 'text-[length:var(--text-caption)] text-muted-foreground [padding:0.2rem 0]',
  strikeLadderControlsRow: 'flex items-center gap-[var(--space-1)] flex-wrap',
  strikeLadderControlsSummary: 'flex flex-col [gap:0.1rem] [font-size:0.7rem] text-muted-foreground [padding-top:0.15rem]',
  strikeLadderHintBelow: 'min-w-0',
  strikeLadderLayout: 'min-w-0',
  strikeLadderOiBar: 'flex flex-row items-stretch [height:6px] [border-radius:3px] overflow-hidden bg-background border border-border',
  strikeLadderOiBarCenter: '[width:2px] shrink-0 [background:var(--color-text-muted)] [opacity:0.65] [align-self:stretch]',
  strikeLadderOiBarFill: '[height:100%] min-w-0 [border-radius:1px]',
  strikeLadderOiBarFillCall: '[background:linear-gradient(90deg, rgba(52, 199, 89, 0.15), var(--color-success, #34c759))]',
  strikeLadderOiBarFillPut: '[background:linear-gradient(90deg, var(--color-danger, #dc3545), rgba(220, 53, 69, 0.2))]',
  strikeLadderOiBarHalf: 'flex-1 min-w-0 flex items-stretch',
  strikeLadderOiBarHalfCall: 'justify-end',
  strikeLadderOiBarHalfPut: 'justify-start',
  strikeLadderOiCell: 'flex flex-col [gap:0.2rem] items-stretch',
  strikeLadderOiNums: 'flex flex-row justify-between [gap:0.25rem] [font-size:0.58rem] font-semibold tabular-nums [line-height:1.15]',
  strikeLadderOiNumsC: '[color:var(--color-success)]',
  strikeLadderOiNumsP: '[color:var(--color-danger)]',
  strikeLadderOiStrike: 'font-bold [font-size:0.72rem] text-center [line-height:1.1] text-foreground',
  strikeLadderRowAtm: 'min-w-0',
  strikeLadderRowOtmCall: 'min-w-0',
  strikeLadderRowOtmPut: 'min-w-0',
  strikeLadderSideModeLabel: 'text-[length:var(--text-caption)] text-muted-foreground whitespace-nowrap',
  strikeLadderSideModeRow: 'flex-wrap items-center [gap:0.35rem]',
  strikeLadderTable: 'w-full border-collapse text-[length:var(--text-caption)] tabular-nums',
  strikeLadderToolbar: 'flex items-center gap-[var(--space-1)] flex-wrap [padding:0.25rem 0] text-[length:var(--text-caption)] text-muted-foreground',
  strikeLadderTwoCols: 'flex gap-[var(--space-2)] flex-1 min-w-0',
  strikeLadderTwoColsSingleSide: '[&>div]:flex-1 [&>div]:max-w-none',
  strikeLadderWrap: 'flex-1 min-w-0 [height:14rem] [min-height:14rem] [max-height:14rem] overflow-x-hidden overflow-y-auto border border-border rounded-lg bg-muted/30',
} as const

export function odDataStateClass(status: string) {
  const tone: Record<string, string> = {
    loading: 'border-primary/30 bg-primary/5',
    empty: 'border-dashed',
    error: 'border-destructive/40 bg-destructive/5 text-destructive',
    idle: '',
  }
  return cn(od.dataState, tone[status])
}

export function odLayerSectionClass(enabled: boolean) {
  return cn(od.layerSection, !enabled && od.layerSectionLocked)
}

export function odChainExpiryChipClass(active: boolean) {
  return cn(
    od.chainExpiryChip,
    'inline-flex flex-row items-center justify-center gap-[0.35rem] rounded-full border border-border/80 bg-card px-[0.55rem] py-[0.2rem] font-[inherit] leading-[1.2] transition-colors hover:border-primary/35 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-55',
    active && od.chainExpiryChipActive,
  )
}

export function odUnderlyingChipClass(active: boolean) {
  return cn(
    od.underlyingChip,
    'inline-flex flex-row items-center justify-center gap-1 rounded-full border border-border/80 bg-muted/40 px-[0.6rem] py-[0.22rem] font-[inherit] leading-[1.15] transition-colors hover:border-primary/35 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
    active && od.underlyingChipActive,
  )
}

export function odGreeksSourceBtnClass(active: boolean) {
  return cn(
    od.greeksSourceBtn,
    'border-0 bg-transparent px-[0.45rem] py-[0.1rem] text-[0.62rem] font-semibold uppercase tracking-wide text-muted-foreground/80 transition-colors hover:bg-border hover:text-muted-foreground',
    active && od.greeksSourceBtnActive,
  )
}

export function odMoneynessBadgeClass(label: string) {
  const map: Record<string, string> = {
    itm: od.moneynessBadgeItm,
    atm: od.moneynessBadgeAtm,
    otm: od.moneynessBadgeOtm,
  }
  return cn(od.moneynessBadge, map[label.toLowerCase()])
}

export function odSnapshotFeedbackClass(level: 'error' | 'warning' | 'info') {
  const map = { error: od.snapshotFeedbackError, warning: od.snapshotFeedbackWarning, info: od.snapshotFeedbackInfo }
  return cn(od.snapshotFeedback, map[level])
}

export function odChainRowClass(opts: { atm?: boolean; itm?: boolean; selected?: boolean; highlight?: boolean }) {
  return cn(
    od.chainRow,
    od.quoteRow,
    'cursor-pointer transition-colors hover:bg-muted/40',
    opts.atm && od.chainRowAtm,
    !opts.atm && opts.itm && od.chainRowItm,
    !opts.atm && !opts.itm && od.chainRowOtm,
    opts.highlight && od.quoteRowSelected,
  )
}

export function odChainTdClass(selected: boolean) {
  return cn(od.chainTd, od.chainTdData, 'cursor-pointer', selected && od.chainTdSelected)
}

export function odChainStrikeCellClass(selected: boolean) {
  return cn(od.chainStrikeCell, selected && od.chainStrikeCellSelected)
}

export function odAnalyticsSkewValClass(sign: string) {
  const map: Record<string, string> = {
    'put-heavy': od.analyticsSkewValPutHeavy,
    'call-heavy': od.analyticsSkewValCallHeavy,
    neutral: od.analyticsSkewValNeutral,
  }
  return cn(od.analyticsSkewVal, map[sign] ?? od.analyticsSkewValNeutral)
}

export function odIvTermExpItemClass(checked: boolean) {
  return cn(
    od.ivTermExpItem,
    'flex cursor-pointer items-center gap-[0.45rem] rounded-lg border border-border/65 bg-muted/30 p-[0.38rem_0.45rem] transition-colors hover:border-primary/30 hover:bg-primary/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
    checked && od.ivTermExpItemChecked,
  )
}

export function odIvSheetHoverClass(warn?: boolean) {
  return cn(od.ivSheetHover, warn && od.ivSheetHoverWarn)
}

export function odStrikeLadderTwoColsClass(singleSide: boolean) {
  return cn(od.strikeLadderTwoCols, singleSide && od.strikeLadderTwoColsSingleSide)
}

export function odIvTermConeChartsRowClass(triple: boolean) {
  return cn(od.ivTermConeChartsRow, triple && od.ivTermConeChartsRowTriple)
}

export function odExpFilterBtnClass(active: boolean) {
  return cn(
    od.optionDiscoveryExpFilterBtn,
    'w-full cursor-pointer rounded-md border border-border bg-card px-1 py-[0.16rem] text-[0.62rem] leading-none text-muted-foreground/80 hover:border-border hover:text-foreground',
    active && 'border-primary bg-primary/10 text-primary',
  )
}

export function odExpirationKindBadge(kind: 'weeklies' | 'quarterlies') {
  return cn(
    od.optionDiscoveryExpirationKindBadge,
    kind === 'weeklies' ? od.optionDiscoveryExpirationKindBadgeWeeklies : od.optionDiscoveryExpirationKindBadgeQuarterlies,
    od.ivTermExpKindBubble,
  )
}

export function odBsDiffClass(kind: 'ok' | 'warn' | 'alert') {
  const map = { ok: od.bsDiffOk, warn: od.bsDiffWarn, alert: od.bsDiffAlert }
  return cn(od.bsDiff, map[kind])
}

export function greeksIvClass(iv: number | null) {
  if (iv == null) return ''
  if (iv < 0.3) return od.greeksTableIvLow
  if (iv < 0.8) return od.greeksTableIvMid
  return od.greeksTableIvHigh
}

export function greeksDeltaClass(delta: number | null) {
  if (delta == null) return ''
  const abs = Math.abs(delta)
  if (abs >= 0.4 && abs <= 0.6) return od.greeksTableDeltaAtm
  return ''
}

export function odChartSvgClass() {
  return cn(od.maxPainSvg, od.chartSvg, 'block h-auto w-full max-w-full')
}

export function odIconBtnNeutral(extra?: string) {
  return cn(extra, '[&.section-header-icon-btn:hover]:transform-none [&.section-header-icon-btn:active]:transform-none')
}
