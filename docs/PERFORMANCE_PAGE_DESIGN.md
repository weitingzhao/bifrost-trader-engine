# Performance 页面需求与设计

本文档描述基于**账户执行记录（account_executions + account_execution_commissions）**的**交易绩效分析**需求、评估指标与实现要点，与 R-M7（复盘与风控）、R-H2（历史统计）对齐。

---

## 1. 目标与范围

- **目标**：为当前账户的交易记录提供**绩效视图**，在现有「按持仓/按成交明细」的 Portfolio 之外，增加**按日历维度**的盈亏与**交易能力评估指标**。
- **数据来源**：`account_executions` + `account_execution_commissions`（R-A2），含 `exec_time`、`realized_pnl`、`commission` 等。
- **范围**：独立 **Performance** 页面（可为 Portfolio 下子页或独立 Tab），支持按账户、时间范围筛选；不替代现有 PositionPnlPage（Overview / Open / Ledger）。

---

## 2. 评估交易能力的指标与方式

以下指标从**通用量化/交易评估**与**本项目场景**（期权 + 股票、对冲与手动）出发，建议分阶段支持。

### 2.1 盈亏与成本（基础）

| 指标 | 说明 | 数据来源 |
|------|------|----------|
| **Realized PnL** | 已实现盈亏（美元） | `account_execution_commissions.realized_pnl` 按笔汇总；若无则可用 (成交价−成本)×数量×乘数 近似 |
| **Commission** | 手续费合计 | `account_execution_commissions.commission` 汇总 |
| **Net PnL** | 净盈亏 = Realized PnL − Commission | 派生 |
| **Calendar PnL** | 按日/周/月的已实现盈亏 | 按 `exec_time` 截断到日/周/月后聚合 |

### 2.2 胜率与盈亏结构（R-H2 相关）

| 指标 | 说明 | 计算方式 |
|------|------|----------|
| **Win Rate（胜率）** | 盈利笔数 / 总成交笔数 | 按笔：realized_pnl > 0 为赢，< 0 为输，=0 可忽略或计半 |
| **Avg Win / Avg Loss** | 平均盈利额 / 平均亏损额 | 仅对赢/输笔分别求均 |
| **Profit Factor** | 总盈利 / 总亏损（绝对值） | 若总亏损=0 可记为 ∞ 或 N/A |
| **Largest Win / Largest Loss** | 单笔最大盈利/亏损 | max(realized_pnl), min(realized_pnl) |

### 2.3 收益与风险（进阶）

| 指标 | 说明 | 计算方式 |
|------|------|----------|
| **Cumulative PnL 曲线** | 按时间序的累计净盈亏 | 按 exec_time 排序后做 cumsum，用于绘图与回撤 |
| **Max Drawdown（最大回撤）** | 曲线从高点到后续低点的最大跌幅 | 累计曲线上的 peak-to-trough 最大值（美元或 %） |
| **Sharpe Ratio（夏普）** | 收益/波动（年化） | 日度净收益序列的 (mean/std)*sqrt(252)，可选；需足够样本 |
| **Trade Count / Frequency** | 按日/周/月成交笔数 | 与 R-H2「按日/周对冲次数」一致思路 |

### 2.4 按维度拆分（可选）

- **按账户**：多账户时按 `account_id` 分别汇总。
- **按标的/类型**：按 `symbol` 或 `sec_type`（STK/OPT）拆分，便于看股票 vs 期权贡献。
- **按来源**：按 `source`（manual / daemon）区分手动与机器交易表现。

---

## 3. 功能与 UI 要点

- **Calendar PnL**：提供按**日**、**周**、**月**的表格或图表（如日历热力图、柱状图），展示该周期内的 Net PnL、笔数、胜率等。
- **汇总指标卡片**：在选定时间范围内展示 Total Net PnL、Win Rate、Profit Factor、Max Drawdown、Trade Count 等。
- **累计收益曲线**：可选折线图，横轴时间、纵轴累计净盈亏，便于直观看趋势与回撤。
- **筛选**：时间范围（since/until）、账户（account_id）、可选 sec_type / source。
- **数据新鲜度**：与现有复盘页一致，依赖 GET /executions 的数据；可从「刷新执行记录」或 accounts_fetched_at 提示。

---

## 4. API 设计

### 4.1 GET /performance

- **用途**：返回选定时间范围内的绩效汇总与按日历聚合的 PnL。
- **参数**：`since_ts`、`until_ts`（Unix 秒）、`account_id`（可选）、`granularity`（day | week | month，默认 day）。
- **响应**（示例）：
  - `summary`: `{ total_pnl, total_commission, net_pnl, trade_count, win_count, loss_count, win_rate, profit_factor, avg_win, avg_loss, max_win, max_loss, max_drawdown }`
  - `calendar`: `[ { period_start_ts, period_label, pnl, commission, net_pnl, trade_count, win_rate } ]`，按 period 升序
  - `cumulative_curve`: `[ { ts, cumulative_net_pnl } ]`（按 exec_time 排序的累计点，用于绘图）

实现时从 `account_executions` JOIN `account_execution_commissions` 按时间范围查询，在应用层或 SQL 内按日/周/月聚合；`realized_pnl` 以 commissions 表为准，缺失时该笔不参与 PnL 汇总（或可选用价格差近似）。

---

## 5. 与现有需求的关系

- **R-M7**：Performance 作为复盘与风控分析的一部分，与「操作可查、执行记录、风控视图」同属复盘能力。
- **R-H2**：按日/周/月汇总、胜率、盈亏分布等由本页与 GET /performance 实现。
- **R-A2**：数据完全依赖 account_executions + account_execution_commissions。

---

## 6. 阶段建议

- **第一阶段**：GET /performance（summary + calendar 按日/周/月）+ Performance 页面骨架，展示 Calendar PnL 表与汇总卡片。
- **第二阶段**：累计收益曲线图、Max Drawdown、按 account_id / sec_type 筛选与分表。
- **第三阶段**：Sharpe、按 source 区分、日历热力图等增强。

---

## 7. 分步实现计划

### 7.1 组成与数据源

- **Realized**：`account_executions` + `account_execution_commissions`（exec_time、realized_pnl、commission、account_id、sec_type）。
- **Unrealized**：`account_positions` + `instrument_prices`（当前持仓 + 当前价，按现有 reader 的 unrealized_pnl 逻辑）。
- **Transaction**：资金流入/流出（数据源待定：IB Ledger 或新表 account_transactions）；用于收益率分母与「总资产变动 = 交易盈亏 + 资金流」展示。
- **收益率**：Realized 用 capital_base（期初权益 ± 资金流调整）；Unrealized 用当前权益；口径见执行计划 Phase 0。

### 7.2 分步顺序（与 Todo 一致）

- **Phase 0**：Capital base 与 Transaction 数据源与口径（期初权益、净资金流、capital_base 公式）。
- **Phase 1**：Realized 合计（金额）；校验 sum 与 get_executions 一致。
- **Phase 2**：Realized 按账户；分账户之和 = 合计。
- **Phase 3**：Realized 按 sec_type（STK/OPT）；分类型之和 = 合计。
- **Phase 4**：Realized 按账户×sec_type；二维之和 = 合计。
- **Phase 5**：Realized 日历（按日/周/月）；commission 按 period 真实汇总；各 period 之和 = 合计。
- **Phase 6**：Unrealized 合计（金额）；数据来自持仓+价格。
- **Phase 7**：Unrealized 按账户、按 sec_type、按账户×sec_type。
- **Phase 8**：展示层：Realized + Unrealized 分块展示；Transaction 单独展示；总回报 %；胜率/Profit Factor/Max Drawdown 仅针对 Realized。

### 7.3 与 R-M7、R-H2 的对应

- **R-M7**：复盘页中的 Performance 子页，展示上述 Realized/Unrealized/Transaction 与 %。
- **R-H2**：按日/周/月汇总、胜率、盈亏分布由 GET /performance 与 Performance 页实现，验收见 [performance-execution-plan.md](plans/performance-execution-plan.md)。

---

*文档版本：初版；与 REQUIREMENTS.md、DATABASE.md、PLAN_NEXT_STEPS.md 对齐。*
