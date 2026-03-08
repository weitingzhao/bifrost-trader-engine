# Performance 计算与展示执行计划（R-M7 / R-H2 细化）

与 [分步推进计划](../PLAN_NEXT_STEPS.md) **阶段 3** 中的 R-M7（复盘与风控分析页面）、R-H2（历史统计）一致。本计划为 **Performance 页面** 的计算逻辑与展示的**专项执行计划**，按 [PERFORMANCE_PAGE_DESIGN.md](../PERFORMANCE_PAGE_DESIGN.md) §7 分步实现。

**依赖**：R-A2（account_executions + account_execution_commissions）、R-A1（account_positions）、instrument_prices；GET /performance 与 [servers/reader.py](../../servers/reader.py) 中 `get_performance_stats` 为实施锚点。当前 `get_performance_stats` 为 stub，返回空壳结构。

---

## 范围与成功标准

- **交付物**：GET /performance 返回 Realized PnL（按账户、按标的类型、日历）、Unrealized PnL（按账户、按类型）、资金流与收益率口径（Phase 0 定义后）；Performance 页分块展示 Realized / Unrealized / Transaction 及盈亏百分比。
- **成功标准**：各 Phase 的「校验条件」满足（分项之和 = 合计）；验收清单中每项可执行并通过。

---

## 阶段计划总览（一个阶段一个阶段做）

按下列顺序执行，**每阶段验收通过后再进入下一阶段**。每一步算对、再求和，避免一次性复杂逻辑出错。

| 阶段 | 目标 | 依赖 | 本阶段验收 |
|------|------|------|------------|
| **Phase 0** | Capital base 与 Transaction 数据源与口径（期初权益、净资金流、capital_base 公式，用于后续 return %） | 无 | Transaction 可查；capital_base、start_equity 文档化 |
| **Phase 1** | Realized 合计（金额）：全量汇总，与 get_executions 手算一致 | Phase 0（return_pct 可选） | 全量 realized 金额与 DB sum 一致 |
| **Phase 2** | Realized 按账户；分账户之和 = 合计 | Phase 1 | 分账户之和 = Phase 1 合计 |
| **Phase 3** | Realized 按 sec_type（STK/OPT）；分类型之和 = 合计 | Phase 1 | 分 sec_type 之和 = Phase 1 合计 |
| **Phase 4** | Realized 按账户×sec_type；二维之和 = 合计 | Phase 1 | 所有格之和 = Phase 1 合计 |
| **Phase 5** | Realized 日历（日/周/月）；各 period 之和 = 合计 | Phase 1 | 日历 period 之和 = Phase 1 合计；commission 按 period 真实汇总 |
| **Phase 6** | Unrealized 合计（持仓+价格）；与手算一致 | 无（数据独立） | Unrealized 合计与持仓手算一致 |
| **Phase 7** | Unrealized 按账户、按 sec_type、按账户×sec_type | Phase 6 | 分项之和 = Phase 6 合计 |
| **Phase 8** | 展示层：Realized + Unrealized + Transaction 分块；总回报 %；胜率/PF/MDD 仅 Realized | Phase 0–7 | 前端分块展示；总回报 % 与口径一致 |

**执行原则**：先做 Phase 0（资金与分母），再做 Phase 1（Realized 合计并校验），再按 2→3→4→5 做 Realized 拆分与日历；Phase 6–7（Unrealized）可与 Realized 并行或在其后；最后 Phase 8 展示。每阶段文档内子项用 `- [ ]` / `- [x]` 勾选，阶段级用下方「阶段 Todo」跟踪。

---

## 阶段 Todo（当前做到哪一阶段）

- [ ] **Phase 0**：Capital base 与 Transaction
- [ ] **Phase 1**：Realized 合计
- [ ] **Phase 2**：Realized 按账户
- [ ] **Phase 3**：Realized 按 sec_type
- [ ] **Phase 4**：Realized 按账户×sec_type
- [ ] **Phase 5**：Realized 日历
- [ ] **Phase 6**：Unrealized 合计
- [ ] **Phase 7**：Unrealized 按账户 / sec_type / 二维
- [ ] **Phase 8**：展示层（Realized + Unrealized + Transaction + %）

---

## Todo List（按 Phase 执行，完成一项勾选一项）

### Phase 0：Capital base 与 Transaction

- [ ] **0.1** 定义 Transaction 数据源：**IB Flex Web Service**（Activity Flex Query，勾选 Cash Transactions 节）；拉取结果解析后写入表 **account_transactions**（account_id, ts, amount, type=deposit/withdrawal/transfer/dividend/other, currency, description 等）；配置：Token 与 Query ID 由环境变量或配置提供（见文档 FLEX_TRANSACTIONS.md 或等价说明）。
- [ ] **0.2** 按时间范围 + 账户查询净资金流（net_cash_flow）；支持按 account_id 拆分、可选按 period 聚合。
- [ ] **0.3** 期初权益口径（start_equity）：历史快照（status_history 或权益快照表）或近似（current_equity - 期间 PnL）；文档约定选用方式。
- [ ] **0.4** 定义 capital_base 公式（用于 return %），如 start_equity + 0.5 * net_cash_flow 或 start_equity；全量/分账户/分类型/日历的 % 均基于同一口径。

### Phase 1：Realized 合计

- [ ] **1.1** 使用 `get_executions(since_ts, until_ts, account_id)` 取数；不新增表。
- [ ] **1.2** 单笔 net = realized_pnl - commission；NULL 处理约定（缺失 commission/realized_pnl 时该笔不参与 PnL 或按 0，文档约定）。
- [ ] **1.3** 全量汇总：total_realized_pnl, total_commission, net_pnl, trade_count；与手算或 DB sum 校验一致。
- [ ] **1.4** GET /performance 返回 realized 合计（金额）；可选 return_pct（分母用 Phase 0 的 capital_base）；同时可返回 start_equity、net_cash_flow 供前端展示。

### Phase 2：Realized 按账户

- [ ] **2.1** 同一批 execution 按 account_id 分组。
- [ ] **2.2** 每组内汇总 realized_pnl、commission、net、trade_count。
- [ ] **2.3** 校验：各账户之和 = Phase 1 合计。
- [ ] **2.4** API 返回 realized_by_account: [ { account_id, total_pnl, commission, net_pnl, trade_count [, return_pct ] }, ... ]。

### Phase 3：Realized 按 sec_type（STK/OPT）

- [ ] **3.1** 同一批 execution 按 sec_type 分组。
- [ ] **3.2** 每组内汇总 realized_pnl、commission、net、trade_count。
- [ ] **3.3** 校验：各 sec_type 之和 = Phase 1 合计。
- [ ] **3.4** API 返回 realized_by_sec_type: [ { sec_type, total_pnl, commission, net_pnl, trade_count [, return_pct ] }, ... ]。

### Phase 4：Realized 按账户×sec_type

- [ ] **4.1** 同一批 execution 按 (account_id, sec_type) 分组。
- [ ] **4.2** 每格汇总 realized_pnl、commission、net、trade_count。
- [ ] **4.3** 校验：所有格之和 = Phase 1 合计。
- [ ] **4.4** API 返回 realized_by_account_and_sec_type: [ { account_id, sec_type, ... }, ... ]。

### Phase 5：Realized 日历

- [ ] **5.1** 用 exec_time 按 period 归属（日/周/月，UTC 或约定时区）；每条 execution 只属于一个 period。
- [ ] **5.2** 每个 period 内：Σ realized_pnl、Σ commission（该 period 内真实手续费之和，不按笔数摊总 commission）、net、trade_count。
- [ ] **5.3** 校验：所有 period 之和 = Phase 1 合计。
- [ ] **5.4** API 返回 calendar: [ { period_start_ts, period_label, pnl, commission, net_pnl, trade_count [, return_pct ] }, ... ]；支持 granularity=day|week|month。
- [ ] **5.5**（可选）日历按 account_id 或 sec_type 再拆分；分项之和 = 该 period 合计。

### Phase 6：Unrealized 合计

- [ ] **6.1** 数据源：当前持仓（get_accounts_from_tables 或等效），每笔持仓的 unrealized_pnl 沿用 reader 现有逻辑（OPT: (price−avg_cost)*qty*100；STK: (price−avg_cost)*qty）。
- [ ] **6.2** 全量汇总 total_unrealized_pnl（不区分账户、类型）。
- [ ] **6.3** 校验：与手算若干持仓的 unrealized 再 sum 一致。
- [ ] **6.4** API 返回 unrealized: { total_pnl [, return_pct ] }（分母用 current_equity）；可选 position_count、current_equity。

### Phase 7：Unrealized 按账户、按 sec_type、按账户×sec_type

- [ ] **7.1** 按 account_id 分组汇总 unrealized_pnl；校验各账户之和 = Phase 6 合计。
- [ ] **7.2** 按 sec_type 分组汇总；校验两类型之和 = Phase 6 合计。
- [ ] **7.3** 按 (account_id, sec_type) 二维汇总；校验所有格之和 = Phase 6 合计。
- [ ] **7.4** API 返回 unrealized_by_account、unrealized_by_sec_type、unrealized_by_account_and_sec_type（结构可仿 realized）。

### Phase 8：展示层

- [ ] **8.1** 总盈亏（金额）= Realized 全量 net_pnl + Unrealized 全量 total_pnl；单独展示 Net cash flow（Phase 0）；总资产变动 = 交易盈亏 + 资金流；总回报 % = (Realized + Unrealized) / capital_base 或 (end_equity - start_equity - net_cash_flow) / capital_base。
- [ ] **8.2** 胜率、Profit Factor、Max Drawdown 仅针对 Realized；Unrealized 不参与；累计收益曲线 % 纵轴可用累计 net PnL / capital_base。
- [ ] **8.3** 前端：Realized 区域（合计 + 按账户 + 按类型 + 日历）、Unrealized 区域（合计 + 按账户 + 按类型）、Transaction 单独一块；所有金额与 % 均展示。

---

## 验收清单（各 Phase 校验条件）

| Phase | 验收条件 | 验收结果 |
|-------|----------|----------|
| 0 | Transaction 可查；capital_base 公式文档化；start_equity 可得出（或近似） | 待执行 |
| 1 | 全量 realized 金额与 get_executions 手算 sum 一致 | 待执行 |
| 2 | 分账户 realized 之和 = Phase 1 合计 | 待执行 |
| 3 | 分 sec_type realized 之和 = Phase 1 合计 | 待执行 |
| 4 | 分 (account, sec_type) realized 之和 = Phase 1 合计 | 待执行 |
| 5 | 日历各 period 之和 = Phase 1 合计；commission 为 period 内真实汇总 | 待执行 |
| 6 | Unrealized 合计与持仓+价格手算一致 | 待执行 |
| 7 | Unrealized 分账户/分类型/二维之和 = Phase 6 合计 | 待执行 |
| 8 | 前端分块展示 Realized / Unrealized / Transaction；总回报 % 与口径一致 | 待执行 |

---

## 当前代码锚点

| 关注点 | 位置 | 说明 |
|--------|------|------|
| get_performance_stats（stub） | servers/reader.py | 当前返回空壳 summary/calendar/cumulative_curve；待从 Phase 0/1 起实现 |
| get_executions | servers/reader.py | 已实现；account_executions LEFT JOIN account_execution_commissions；按 since_ts/until_ts/account_id 筛选 |
| get_accounts_from_tables | servers/reader.py | 已实现；accounts + account_positions + instrument_prices；含 per-position unrealized_pnl |
| GET /performance | servers/app.py | 调用 reader.get_performance_stats(since_ts, until_ts, account_id, granularity) |
| Performance 页 | frontend/src/pages/PerformancePage.tsx | 调用 fetchPerformance；展示 summary、calendar；待接 Phase 1–8 返回结构 |

---

## 与 PLAN_NEXT_STEPS / PHASE_ASSESSMENT 的对应

- **执行计划**：本文档即 `docs/plans/performance-execution-plan.md`，为 R-M7/R-H2 下 Performance 计算与展示的专项计划。
- **验收依据**：Performance 页计算与展示的细化验收以本文档「验收清单」与各 Phase Todo 的校验条件为准；[PLAN_NEXT_STEPS](../PLAN_NEXT_STEPS.md) 阶段 3 步骤 3.8 引用本文档。
