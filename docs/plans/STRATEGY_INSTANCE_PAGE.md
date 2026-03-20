# 策略实例独立页面设计

本文档定义**策略实例**独立页面的产品与实现边界，供前端/全栈实施时查阅。需求定义见 [REQUIREMENTS.md](../REQUIREMENTS.md) §2.5。

---

## 1. 目的与定位

- **目的**：按「单笔开仓」（strategy_instance）聚合展示策略信息、盈亏、以及后续可扩展的风险/回测/资金占用，形成与「按账户」的 Portfolio、「按策略定义」的 Strategy 页并列的**按实例视角**。
- **目标用户**：复盘与按笔分析；需要查看某笔开仓的完整故事（属于哪条机会、结构是什么、该笔的成交与 PnL、未来可看风险与资金占用）。

---

## 2. 页面结构

### 2.1 列表页

- **路由与入口**：Strategy 子菜单「Instances」或 Portfolio 子菜单「Strategy Instances」（与现有导航一致，二选一或两处均可进入）。
- **筛选**：account_id、strategy_opportunity_id、可选时间范围（按 opened_at）。
- **表格列**：strategy_instance_id、机会策略名称（strategy_opportunity_name）、account_id、opened_at、label、可选 PnL 汇总（若后端支持或前端按 instance 调 GET /performance 聚合）。
- **操作**：点击行进入详情；可选「新建实例」按钮（表单项：opportunity、account、opened_at、label），提交后跳转详情或刷新列表。

### 2.2 详情页

- **路由**：如 `/strategies/instances/:id` 或 `/portfolio/instances/:id`（与列表入口一致）。
- **区块**：
  1. **策略信息**（只读）：来自 GET /strategies/instances/{id} 的 opportunity 名称、structure 信息（可再请求 GET /strategies/opportunities/{id} 或 GET /strategies/structures/{id} 若需结构详情）。
  2. **盈亏**：GET /performance?strategy_instance_id={id} 与 GET /executions?strategy_instance_id={id}；复用现有 Performance 汇总/日历与 Executions 列表组件或子集。
  3. **风险**：占位或链接到未来风险页。
  4. **回测**：占位或链接。
  5. **资金占用**：占位。

---

## 3. 数据流与 API 依赖

| 用途 | API | 说明 |
|------|-----|------|
| 列表 | GET /strategies/instances?account_id=&strategy_opportunity_id= | 已有；返回 items[]。 |
| 详情元数据 | GET /strategies/instances/{id} | 已有；含 strategy_opportunity_id、account_id、opened_at、label、notes、strategy_opportunity_name。 |
| 该实例成交 | GET /executions?strategy_instance_id={id} | 已有。 |
| 该实例绩效 | GET /performance?strategy_instance_id={id} | 已有。 |
| 新建实例 | POST /strategies/instances | 已有；body: strategy_opportunity_id、account_id、opened_at、label、notes。 |

**列表行 PnL 汇总**：当前 GET /strategies/instances 不返回 per-instance 的 PnL。可选方案：（a）后端在 list 接口中增加可选聚合返回 realized_pnl 等；（b）前端列表仅展示元数据，详情页再展示 PnL；（c）前端对每条实例请求 GET /performance?strategy_instance_id（请求多）。建议一期采用（b）或（c），二期再考虑后端聚合。

---

## 4. 与现有页面的关系

- **Add Trade**：可选 Strategy/Instance 下拉；本页不替代，补「新建实例」入口后可在此页创建实例再在 Add Trade 中选择。
- **Trade ledger（Ledger）**：按 Strategy/Instance 筛选；本页详情中的「成交」可复用相同数据与展示逻辑。
- **Performance**：按 Strategy/Instance 筛选；本页详情中的「盈亏」即该 instance 的 Performance 视图。
- **Accounts**：持仓表展示 Strategy/Instance 列；本页为「实例为中心」的汇总与详情，不替代 Accounts。

---

## 5. 实施顺序建议

1. 列表页：路由与导航、GET /strategies/instances、筛选与表格、进入详情链接。
2. 详情页：GET /strategies/instances/{id}、策略信息区块、GET /executions?strategy_instance_id 与 GET /performance?strategy_instance_id 的展示（复用或嵌入现有组件）。
3. 可选：列表页或详情页增加「新建实例」入口。
4. 详情页预留风险/回测/资金占用区块（标题 + 占位或链接）。

数据库与 API 已就绪（DATABASE.md §2.24.11），无需改后端即可完成列表与详情首版。

**归属模型**：account_positions 不存策略归属；策略信息唯一来源为 account_executions（一个持仓可对应多个策略）。实例详情页的持仓/风险数据来自 `GET /strategies/instances/{id}/open-option-legs`（executions ∩ positions）。列表页风险卡片通过 GET /status 的 positions.strategy_links 或 open-option-legs API 获取实例对应的 OPT 持仓。
