# UI：Option 数据日粒度 Checklist 与数据补全

Option 数据状态的**日粒度 Checklist 完成度展示**与**数据补全触发**功能设计。与 Feed Massive Option 页面能力维度对齐，为 Option Discovery 和 Max Pain 等产品提供数据就绪信号。

**前置阅读**：[ARCHITECTURE_AND_RESEARCH.md](ARCHITECTURE_AND_RESEARCH.md)。  
**索引**：[README.md](README.md)。  
**界面文案**：English（遵守 `.cursor/rules/language.mdc`）。

---

## 1. 现状

- Feed Massive Option 页面（`FeedMassiveOptionPage`）已有 Checklist 能力维度，定义在 `frontend/src/pages/massiveFeedChecklistRows.ts`。
- 现有 Checklist 按**能力维度**展示（REST、WS、Flat Files、Project），每行有 `projectStatus`（implemented / partial / not-implemented）。
- **缺失**：无**日粒度**数据状态（今天某标的的 snapshot / OI / Max Pain 是否已完成？）、无一键补全入口。

---

## 2. 职责边界

| 页面 | 职责 | 数据 Checklist 角色 |
|------|------|---------------------|
| **Settings → Feed → Massive Option** | **监控**：能力维度是否 implemented、tier 兼容、WS 可达 | 展示**能力 Checklist**（已有） + **日粒度数据 Checklist**（新增） |
| **Research → Option Discovery** | **研究工具**：选标的 → 选到期 → Load quotes → 分析 | 消费数据；不直接展示 Checklist |

日粒度 Checklist 放在 **Feed Massive Option** 页面内（与能力 Checklist 同级但独立 section），也可选嵌入 Option Discovery 页面顶部作为轻量摘要。

---

## 3. 日粒度 Checklist 设计

### 3.1 维度定义

| 维度 ID | 名称（英文） | 数据来源 | 判断「完成」的条件 |
|---------|-------------|----------|-------------------|
| `daily-snapshot` | Chain Snapshot | `option_snapshots` | 当日（或最近交易日）该标的有 snapshot 行且 `snapshot_ts` 在当日 |
| `daily-oi` | End-of-Day OI | `option_open_interest_daily` | `trade_date` = 上一交易日 AND 行数 > 0 |
| `daily-max-pain` | Max Pain | `max_pain_daily` | `trade_date` = 上一交易日 AND 行数 > 0 |
| `daily-corporate` | Corporate Actions | `massive_corporate_action` | 该标的有记录且最后同步 < 7 天 |
| `daily-ws-alive` | WS Ingest | Redis `massive:meta:status` | `connected = true` AND `last_msg_age < 120s` |

### 3.2 后端 API

新增端点：

```
GET /research/massive/daily-checklist?symbols=NVDA,AAPL&trade_date=2026-03-23
```

返回：

```json
{
  "trade_date": "2026-03-23",
  "symbols": {
    "NVDA": {
      "daily-snapshot": { "status": "complete", "last_ts": "2026-03-23T15:45:00Z", "rows": 180 },
      "daily-oi": { "status": "missing", "last_trade_date": "2026-03-20" },
      "daily-max-pain": { "status": "missing" },
      "daily-corporate": { "status": "complete", "last_sync": "2026-03-22T18:00:00Z" },
      "daily-ws-alive": { "status": "degraded", "connected": false }
    }
  }
}
```

Status 取值：`complete` / `partial` / `missing` / `degraded`。

### 3.3 前端 UI

**位置**：Feed Massive Option 页面内新 section「Daily Data Status」。

**布局**：

- **标的选择器**：从 Watchlist STK 标的拉取（复用 Option Discovery 的 `useWatchlistStkSymbols`）。
- **日期**：默认当前交易日（或上一交易日，若当前为非交易时段）。
- **表格/卡片**：每个标的一行，5 列对应 5 个维度，每格显示状态 badge：
  - `Complete` (green)
  - `Partial` (yellow)
  - `Missing` (red)
  - `Degraded` (orange, 仅 WS)

**交互**：

- 点击 `Missing` 或 `Partial` badge → 触发对应 backfill 操作（见 §4）。
- 悬停 badge → tooltip 显示详情（最后更新时间、行数等）。

---

## 4. 数据补全（Backfill）入口

| 维度 | 补全操作 | 实现 |
|------|----------|------|
| `daily-snapshot` | 触发 `POST /research/massive/sync kind=snapshot` | 复用现有逻辑 |
| `daily-oi` | 触发 `POST /research/massive/sync kind=oi` | 复用现有逻辑（需要 OI 拉取实现完善） |
| `daily-max-pain` | 触发 `POST /research/massive/sync kind=max_pain` | 新增（依赖 OI 完成） |
| `daily-corporate` | 触发 `POST /research/massive/sync kind=corporate_action` | 复用现有逻辑 |
| `daily-ws-alive` | 显示 WS 进程重启提示（非 API 可补） | 仅提示 |

**Batch backfill**：提供「Backfill all missing」按钮，遍历 Missing 维度批量入队。前端显示批量 job 状态（pending/running/done）。

### 4.1 Job 状态展示

补全触发后在对应格子内显示 mini spinner + job 状态。轮询 `GET /research/massive/jobs/{id}` 直到 done/failed。完成后自动刷新 Checklist 状态。

---

## 5. Option Discovery 轻量摘要（可选）

在 Option Discovery 页面顶部条件区（symbol 选择后）展示：

```
NVDA · Snapshot: ✓ 15:45 · OI: ✗ missing · Max Pain: ✗
```

点击 `✗ missing` 可跳转 Feed Massive Option 的 Daily Data Status section，或直接触发 backfill。

---

## 6. 与现有 Checklist 的关系

| Checklist 类型 | 粒度 | 关注点 | 数据来源 |
|----------------|------|--------|----------|
| **能力 Checklist**（现有） | 能力维度 | 功能是否 implemented、tier 是否满足 | `massiveFeedChecklistRows.ts` 静态定义 + 运行时 status |
| **日粒度数据 Checklist**（新增） | 标的 × 日期 × 维度 | 数据是否完整、是否需要补全 | PG 查询 + Redis |

两者**共存**于 Feed Massive Option 页面，按 section 分开。能力 Checklist 回答「能不能做」，日粒度 Checklist 回答「今天做了没」。

---

## 7. Owner 决策（已锁定）

| 编号 | 决策 |
|------|------|
| UI-1 | **全部 Watchlist 中 optionable STK**，与 Watchlist 一致；非仅手动多选几个标的。 |
| UI-2 | **嵌入**：Option Discovery 在 Massive 已配置且已选标的时，条件区顶部展示一行日粒度摘要（含跳转 Feed → Daily Data Status）。 |
| UI-3 | **不要** Batch backfill 确认弹窗；补全完成后把 **job 结果**（及批量时的多行输出）留在页面 **Last run output** 区域展示即可。 |
