# DataPage.tsx 重构分析

基于当前 `frontend/src/pages/DataPage.tsx`（约 1289 行）与 Status 页已采用的「面板 + 工具函数」拆分方式，整理是否需要继续重构及建议拆分方案。

---

## 1. 当前结构概览

| 区块 | 约行号 | 内容 | 行数约 |
|------|--------|------|--------|
| State | 20–72 | 30+ `useState`（bars、coverage、modals、backfill、jobs、trading day） | ~55 |
| Memos | 81–127 | sortedBars, sortedBarsJobs, chartBars, tableBars, coverageGroups | ~50 |
| Callbacks / effects | 129–313 | loadCoverage, loadBarsJobs, EOD refresh, indices refresh, loadBarsFromApi, openBarsForSymbol | ~185 |
| **Coverage 区块** | 330–613 | 工具栏（fake IB、Dry run、EOD Pull、Refresh indices）、消息、Coverage 表（Indices/Watchlist）、每行 Reset/Pull | ~285 |
| **EOD Dry run 弹窗** | 615–713 | watchlistRefreshPreview 确认 | ~100 |
| **Reset 确认弹窗** | 715–780 | 按周期清空 bars | ~65 |
| **Pull 范围弹窗** | 783–896 | Max/Min/Custom、周期多选、Confirm | ~115 |
| **Preview 区块** | 898–1077 | Symbol、Period、Load、BarsCandlestickChart、bars 表 | ~180 |
| **Celery jobs 区块** | 1079–1265 | 状态筛选、条数、刷新、jobs 表、单条 Delete | ~185 |
| **Delete all 弹窗** | 1268–1295 | 按选中状态批量删 jobs | ~30 |

特点：

- 单文件内同时承担：**Coverage**、**Bars 预览**、**Celery jobs** 三大功能 + 四个弹窗。
- 状态与回调集中在一处，修改任一功能都要在 1200+ 行里定位。
- 与已拆分的 Status 页（`status/panels/` + hooks）风格不一致，不利于后续加需求或做单测。

**结论：建议继续重构**，目标与 Status 页类似：按「区块/子功能」拆成面板与弹窗组件，并视情况用 hooks 收敛状态与请求逻辑。

---

## 2. 建议拆分方案（与 Status 对齐）

### 2.1 目录与职责

在现有 `pages/data/` 下已有：

- `constants.ts`、`dataCoverageUtils.tsx`、`useBarCandidateSymbols.ts`、`BarsCandlestickChart.tsx`

建议新增：

- **`pages/data/panels/`**：三个面板组件，只负责 UI 与事件回调，状态由父组件或 hook 传入。
- **可选**：`pages/data/hooks/` 或直接在 `pages/data/` 下的 `useDataCoverage.ts`、`useBarsJobs.ts`，把 coverage 与 jobs 的 state + 请求收敛到 hook 里，便于 DataPage 只做「布局 + 组合」。

### 2.2 面板拆分建议

| 组件 | 建议路径 | 职责 | 从 DataPage 迁出内容 |
|------|----------|------|----------------------|
| **DataCoveragePanel** | `data/panels/DataCoveragePanel.tsx` | Coverage 表 + 工具栏（EOD Pull、Refresh indices、backfill 选项）+ 表格内 Reset/Pull 按钮 | 约 330–613 行（含 toolbar、消息、表格）；弹窗可仍由 DataPage 或本 panel 内嵌（见下）。 |
| **DataBarsPreviewPanel** | `data/panels/DataBarsPreviewPanel.tsx` | Symbol/Period 输入、Load、BarsCandlestickChart、bars 表格 | 约 898–1077 行。 |
| **DataJobsPanel** | `data/panels/DataJobsPanel.tsx` | Celery jobs 筛选、条数、刷新、jobs 表、单条 Delete | 约 1079–1265 行。 |

弹窗有两种做法（任选其一即可）：

- **方案 A**：弹窗仍留在 `DataPage.tsx`，只把「触发弹窗的按钮/逻辑」放在对应 Panel 里，Panel 通过 `onResetClick`、`onPullClick`、`onEodDryRunConfirm` 等回调把状态提升到 DataPage。这样 DataPage 继续持有 modal 的 state，便于多个 panel 共享同一套 modal（如 Reset/Pull 都可能从 Coverage 触发）。
- **方案 B**：每个弹窗拆成独立组件（如 `DataResetConfirmModal.tsx`、`DataPullRangeModal.tsx`、`DataEodDryRunModal.tsx`、`DataDeleteAllJobsModal.tsx`），放在 `data/panels/` 或 `data/modals/`，由 DataPage 传入 `open`、`onClose`、`onConfirm` 及所需数据。这样 DataPage 只负责组合与状态，弹窗 UI 可单独维护和测试。

建议优先 **方案 A**，与当前 Status 页「状态在父、面板只负责展示和回调」的方式一致；若后续某弹窗逻辑变重再单独拆成方案 B。

### 2.3 可选：Hooks 收敛状态与请求

若希望 DataPage 进一步瘦身、方便单测和复用，可增加：

| Hook | 建议路径 | 职责 |
|------|----------|------|
| **useDataCoverage** | `data/useDataCoverage.ts` | coverage、coveragePolicy、loading/error、loadCoverage、coverageGroups、deletingSymbol、deleteSymbolError、resetConfirm*、pullModal*、backfill 选项、EOD refresh、indices refresh、watchlistRefreshPreview 等 state + 相关 callbacks。 |
| **useBarsJobs** | `data/useBarsJobs.ts` | barsJobs、loading/error、total、limit、statusSelected、sort、loadBarsJobs、toggleBarsJobsStatus、deleteJob、confirmDeleteAll、sortedBarsJobs。 |

这样 DataPage 主要保留：

- 与「Bars 预览」相关的 state（bars、barSymbol、barPeriod、loadBarsFromApi、openBarsForSymbol 等），或再抽成 `useBarsInspect`；
- 三个 Panel 的渲染 + 四个弹窗的渲染；
- 从 hooks 读状态、传 props 给 Panel 和弹窗。

Bars 预览逻辑相对独立且体量适中，可以暂时保留在 DataPage，等有需要再抽成 `useBarsInspect`。

---

## 3. 其他可顺手整理的点

- **重复的周期列表**：`['1 D', '1 min', '5 mins', '1 hour']` 与 `BAR_PERIODS` 在 Reset/Pull 等多处出现，可统一用 `data/constants.ts` 的 `BAR_PERIODS` 或导出一个 `ALL_BAR_PERIOD_VALUES`，避免魔术数组。
- **Reset/Pull 的 period 选项**：与 `BAR_PERIODS` 的 label 一致，可用同一数据源生成选项，减少重复。

---

## 4. 建议实施顺序

1. **先拆面板**（不动状态）：新建 `DataCoveragePanel`、`DataBarsPreviewPanel`、`DataJobsPanel`，通过 props 接收当前 DataPage 的 state 与 callbacks，把对应 JSX 迁入各 panel，DataPage 只负责 `useState` 和组合同一层级的三个 `<Section>`。这样单文件行数可降到约 600–700，结构立刻清晰。
2. **再拆弹窗**（可选）：若希望 DataPage 再瘦身，把四个弹窗拆成四个组件（方案 B），DataPage 只保留「是否打开 + 当前操作目标」等少量 state 和弹窗的 `<Modal ... />` 调用。
3. **最后按需加 hooks**：若后续要加「自动刷新 coverage」「jobs 轮询」或复用 coverage 逻辑到其他页，再抽 `useDataCoverage` / `useBarsJobs`，并让 DataPage 改为消费这些 hooks。

按上述顺序做，可以在不大改行为的前提下，把 DataPage 从「超大盘面」收敛到与当前 Status 页类似的「页面壳 + 若干面板 + 少量弹窗」，便于后续维护和新需求扩展。
