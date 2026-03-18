# Option 策略完成度：结构策略 / 机会策略 / 策略分配（Allocations）

基于 [REQUIREMENTS.md](../REQUIREMENTS.md) §4.3、[PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md)「策略与安全边界落库」及 [DATABASE.md](../DATABASE.md) §2.24，对当前项目中 **结构策略（strategy_structure）**、**机会策略（strategy_opportunity）**、**策略分配（strategy_allocation / Allocations）** 三层的实现与完成度做一梳理。

---

## 一、目标定义（需求与计划）

| 层级 | 表/概念 | 需求与计划中的目标 |
|------|---------|--------------------|
| **结构策略** | `strategy_structure` + 子表 leg/constraint/meta | 存于 DB；版本管理、回测关联；当前生效由 `settings.active_strategy_structure_id` 指定；Phase A：Reader、Daemon 加载、strategy_history 写入、GET /strategies/structures、Strategy 页列表与 Set active。 |
| **机会策略** | `strategy_opportunity` + 子表 symbol/entry_condition | 存于 DB；引用结构策略 + 可选 default_gate_safety_strategy_id；scope_type + 标的与入场条件子表（无 jsonb）。Phase A 扩展：列表/详情、创建/更新 API 与 UI。 |
| **策略分配（Allocations）** | `strategy_allocation` | 存于 DB；包含多条机会策略（通过 strategy_allocation_opportunity）、可选分配级 gate_safety_strategy_id、max_positions/max_bp_pct；供“分配”管理与切换。 |

验收依据：PLAN_NEXT_STEPS「策略与安全边界落库」SG.1–SG.4 及 **Phase A**（只读闭环 + 后台管理与监控）、Phase A 监控端 UI（Research → Strategy 页）。

---

## 二、完成度总表

| 维度 | 结构策略 | 机会策略 | 策略分配（Allocations） |
|------|----------|----------|--------------------------|
| **DDL / 表存在** | ✅ 已实现 | ✅ 已实现 | ✅ strategy_allocation + strategy_allocation_opportunity |
| **Reader（列表/详情）** | ✅ list_structures, get_structure_by_id | ✅ list_opportunities, get_opportunity_by_id | ✅ list_allocations, get_allocation_by_id |
| **Writer（创建/更新）** | ✅ create_structure, update_structure | ✅ create_opportunity, update_opportunity | ✅ create_allocation, update_allocation |
| **API（GET/POST/PUT）** | ✅ /structures, /structures/{id} | ✅ /opportunities, /opportunities/{id} | ✅ /allocations, /allocations/{id} |
| **当前生效与切换** | ✅ active_strategy_structure_id + POST /config/active-strategy | — | — 无 active_allocation 概念 |
| **Daemon 使用** | ✅ 从 DB 加载 structure 注入 config | — | — 未参与 |
| **strategy_history 写入** | ✅ append_history 时写 strategy_structure_id | — | — |
| **GET /status 展示** | ✅ active_strategy_structure_id/name | — | — |
| **Strategy 页** | ✅ 列表、详情、创建/编辑、Set active | ✅ 列表、详情、创建/编辑 | ✅ Allocations 子项、列表、创建/编辑 |
| **前端 API 与类型** | ✅ fetchStructures, fetchStructure, create/update | ✅ fetchOpportunities, fetchOpportunity, create/update | ✅ fetchAllocations, fetchAllocation, create/updateAllocation |

结论简要：

- **结构策略**：按 Phase A 目标已闭环（DDL、Reader、Writer、API、Daemon 加载、strategy_history、Status 与 Strategy 页、Set active）。
- **机会策略**：DDL、Reader、Writer、API、Strategy 页的列表/创建/编辑均已有；未要求“当前生效”与 Daemon 直接使用，故无该项不算缺口。
- **策略分配（Allocations）**：DDL（strategy_allocation、strategy_allocation_opportunity）、Reader、Writer、API（/strategies/allocations）、Strategy 页 Allocations 子项与 CRUD 已实现；无“当前生效”与 Daemon 集成。

---

## 三、分项说明

### 3.1 结构策略（strategy_structure）

- **数据库**：`pg_ddl` 已建 `strategy_structure`、`strategy_structure_leg`、`strategy_structure_constraint`、`strategy_structure_meta`；主表已去 JSON 列，数据在子表。
- **Reader**：`servers/reader/strategy.py` 中 `get_structure_by_id`、`list_structures`，从子表组装 legs/constraints/metadata。
- **Writer**：`servers/reader/strategy_structure_write.py` 的 `create_structure`、`update_structure`。
- **API**：`servers/routers/strategies.py` 的 GET/POST/PUT `/strategies/structures`、`/structures/{id}`。
- **Status**：GET /status 含 `active_strategy_structure_id`、`active_strategy_structure_name`；POST /config/active-strategy 可写 `active_strategy_structure_id`。
- **Daemon**：`active_strategy_structure_id` 非空时从 DB 加载 structure 并注入 config；PostgresSink 在 append_history 时写 `strategy_history`。
- **前端**：Research → Strategy 页有结构策略列表、详情、表单（legs/constraints/notes/meta）、创建/编辑、Set active。

**完成度：按 Phase A 与需求 §4.3 对“结构策略”的约定，已满足。**

---

### 3.2 机会策略（strategy_opportunity）

- **数据库**：`strategy_opportunity`、`strategy_opportunity_symbol`、`strategy_opportunity_entry_condition` 已建；机会表为 scope_type + 子表，无 jsonb 列。
- **Reader**：`strategy.py` 中 `list_opportunities`、`get_opportunity_by_id`（含 symbols、entry_conditions 子表组装）。
- **Writer**：`strategy_opportunity_write.py` 的 `create_opportunity`、`update_opportunity`。
- **API**：GET/POST/PUT `/strategies/opportunities`、`/opportunities/{id}`。
- **前端**：Strategy 页有机会策略列表、详情、创建/编辑（name、structure、scope_type、symbols、entry_conditions、default_gate_safety_strategy_id、is_active）。

需求与 Phase A 未要求“当前生效的机会策略”或 Daemon 直接读 opportunity，因此没有“Set active opportunity”或 daemon 使用 opportunity 的验收条。

**完成度：列表/详情/创建/更新/UI 均已实现；与当前计划对齐。**

---

### 3.3 策略分配（strategy_allocation / Allocations）

- **数据库**：`strategy_allocation`、`strategy_allocation_opportunity` 表在 `pg_ddl` 中创建；主表列：`strategy_allocation_id`、`name`、`gate_safety_strategy_id`、`max_positions`、`max_bp_pct`、`is_active`、`created_at`、`updated_at`。关联表存 allocation–opportunity 多对多。DATABASE.md §2.24.3、§2.24.3a。
- **Reader**：`servers/reader/strategy.py` 中 `list_allocations`、`get_allocation_by_id`；common 封装同名方法。
- **Writer**：`servers/reader/strategy_allocation_write.py` 的 `create_allocation`、`update_allocation`。
- **API**：GET/POST/PUT `/strategies/allocations`、`/allocations/{id}`。
- **当前生效**：settings 无 `active_strategy_allocation_id`；无“当前生效分配”的切换与展示。
- **Daemon**：未从 DB 读 allocation，也未按 allocation 聚合多个 opportunity 使用。
- **前端**：Strategy 页有“Allocations”子项；`frontend/src/api/strategies.ts` 含 StrategyAllocation、fetchAllocations、fetchAllocation、createAllocation、updateAllocation。

**完成度：表、Reader、Writer、API、Strategy 页 Allocations 列表与 CRUD 已实现；无“当前生效”与 Daemon 集成。**

---

## 四、与 Phase A 验收的对应关系

- **SG.1（DDL）**：strategy_structure、strategy_opportunity、strategy_allocation、gate_safety_*、settings 两列 → ✅ 表与列均存在。
- **SG.2（Reader）**：get_gates_by_id、active_* 从 settings 读 → ✅ 已实现；structure/opportunity 的 list/get_by_id → ✅ 已实现；allocation → ✅ list_allocations、get_allocation_by_id 已实现。
- **Phase A 监控端 UI**：Strategy 页，结构策略列表/历史/Set active、安全边界列表 → ✅；机会策略列表与 CRUD → ✅；策略分配（Allocations）→ ✅ Strategy 子项 Allocations 列表与 CRUD。

即：**结构策略 + 机会策略 + 策略分配（Allocations）** 在“策略与安全边界落库”及 Phase A 的既定范围内已完成表与 CRUD；Allocations 无“当前生效”与 Daemon 集成。

---

## 五、建议（后续若要做“当前生效”分配或 Daemon 使用）

1. **当前生效（可选）**：若产品需要“当前生效分配”，在 settings 增加 `active_strategy_allocation_id`，并增加 POST /config/active-allocation 与 GET /status 返回当前 allocation id/name。
2. **Daemon（可选）**：若运行时需按“当前分配”决定参与的机会列表，在 daemon 配置加载路径中根据 active_strategy_allocation_id 解析 opportunity 列表并注入。

---

## 六、交易归属与策略实例（Strategy Instance & Trade Attribution）

**状态**：待实现（SI.1–SI.4）。  
**设计**：[DATABASE.md](../DATABASE.md) §2.24.11（表 strategy_instance；account_executions 增加 strategy_opportunity_id、strategy_instance_id；account_positions 不存策略归属，从 executions 推导 strategy_links）。  
**步骤与验收**：[PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md)「策略实例与交易归属」。

---

*文档基于当前代码与 docs 整理，日期：2026-03-14。*
