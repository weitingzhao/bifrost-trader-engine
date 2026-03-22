# 终极目标能力拆解与进度（木桶原理）

本文档按**木桶原理**列出达成**终极目标（自动交易）**所需的各方面能力，并标注当前进度，便于**分项跟踪**、发现短板。与 [REQUIREMENTS.md](../REQUIREMENTS.md) 需求编号对应；**每次实现完成后可更新本表**。

**终极目标**：自动交易（守护进程按策略与风控自动对冲）。  
**中间目标**：对市场行情机会的监控并提醒出现交易机会，由操作者手动判断是否下单（对应 R-RM9「仅建议、不实盘」）。

---

## 能力维度与当前进度总表

| 序号 | 能力维度 | 对应需求/阶段 | 当前进度 | 说明 / 短板 |
|------|----------|----------------|----------|-------------|
| **1** | **账户与持仓可获取** | R-A1，阶段 3 | ✅ 已实现 | 守护程序从 IB 获取账户摘要与当前持仓；CONNECTED/RUNNING 后按间隔更新；写入 account / account_positions，GET /status 可读。 |
| **2** | **双 IB 账户与统一 Portfolio** | R-A4，阶段 3 | ⏳ 实现中/待验收 | Host 账户（ib_host_account_id）自动+行情；第二账户仅手动；两账户需在 GET /status、Portfolio、Performance 按账户展示并验收。 |
| **3** | **标的与持仓当前市价** | R-M6，阶段 3 | ✅ 已实现 | 心跳拉取 spot 写入 daemon_auto_status_current；GET /status 含 spot；监控页可展示持仓+市价、盈亏、期权虚实。 |
| **4** | **策略·结构层（Structure）** | Phase A / 策略落库 | ✅ 已实现 | 表+Reader+Writer+API；Daemon 从 DB 加载 active_strategy_structure；Strategy 页列表/历史/Set active；Current Active 展示。 |
| **5** | **策略·机会层（Opportunity）** | 策略落库 | ✅ 已实现 | 表+Reader+Writer+API；Strategy 页 Opportunity 列表与 CRUD；无「当前生效」、Daemon 未使用。 |
| **6** | **策略·分配层（Allocations）** | 策略落库 | ✅ 已实现 | 表+Reader+Writer+API；settings.active_strategy_allocation_id、GET /status 返回、Strategy 页（Structure/Gates/Allocations）Current Active 展示、Allocations 页 Set active 已实现；Daemon 未使用（可选后续）。 |
| **7** | **安全边界（Gates）** | Phase A / 策略落库 | ✅ 已实现 | 表+Reader+Writer+API；Daemon 从 DB 加载 active_gate_safety_strategy_id；Gates 页 CRUD 与 Set active；Current Active 展示。 |
| **8** | **状态可观测与历史** | R-M1a/1b，R-H1，阶段 1/2 | ✅ 已实现 | Sink 当前+历史；GET /status；监控页可查看状态与配置摘要。 |
| **9** | **状态自检与红绿灯** | R-M2，R-M3，阶段 2 | ✅ 已实现 | self_check（ok/degraded/blocked）、block_reasons；GET /status 含 status_lamp；监控页红/黄/绿指示。 |
| **10** | **操作可查** | R-M4a/4b，阶段 1/2 | ✅ 已实现 | 对冲意图/下单/成交/撤单写入 daemon_auto_operations；GET /operations；监控页可查。 |
| **11** | **一键停止** | R-C1a/1b，阶段 1/2 | ✅ 已实现 | 信号停止；POST /control/stop；局域网内可发起停止。 |
| **12** | **账户执行交易与复盘** | R-A2，R-M7，阶段 3 | ⏳ 部分/待验收 | 执行记录获取、复盘与风控分析页面、Performance 按账户与 Realized/Unrealized 拆分；阶段 3 验收范围。 |
| **13** | **复盘辅助行情（K 线等）** | R-A3，阶段 3 | ⏳ 部分 | Backfill 队列表+API+Celery Worker；GET /bars；非实时拉取；阶段 3 部分步骤已实现。 |
| **14** | **历史统计** | R-H2，阶段 3 | ✅ 已实现 | scripts/check/stats_from_history.py；按日/周对冲次数、盈亏汇总；可离线运行。 |
| **15** | **机会监控与提醒（中间目标）** | R-RM9（可选） | ❌ 未实现 | 守护跑策略与风控但执行层截断，将「建议对冲」写入 operations 或专用表；监控页展示「交易机会/建议」列表；操作者手动决定是否下单。**下一步重点之一**。 |
| **16** | **实时行情与联动** | R-RM1/2/3 | ❌ 未实现 | 守护双线（心跳+事件）；行情写 Redis；Pub/Sub 或 Streams 联动监控；可选，与机会监控可配合。 |
| **17** | **回测（PnL 优化 + Guard 验证）** | R-B1，R-B2，阶段 4 | ❌ 未实现 | 历史回放、理论 P&L、收益曲线、回撤；Guard 拦截次数与原因复盘。 |
| **18** | **暂停/恢复自动对冲** | R-C2，阶段 5 | ❌ 未实现 | 暂停期间不下新单，监控与自检仍可用；恢复后继续对冲。 |
| **19** | **一键平敞口** | R-C3，阶段 5 | ❌ 未实现 | 红或紧急时一键平掉主账户本策略对冲敞口；仅主账户，不碰第二账户。 |
| **20** | **自动下单（终极目标）** | 阶段 5 | ❌ 未实现 | 守护进程在满足策略与风控时自动发单；依赖 1–11 及 17–19 等能力齐备。 |
| **21** | **交易归属与策略实例（按策略 PnL）** | 阶段 3 扩展 | ❌ 未实现 | strategy_instance 表；execution 归属 strategy_opportunity 与 strategy_instance（position 不存策略，从 executions 推导 strategy_links）；Performance/复盘按策略与实例聚合；**策略实例独立页面**（列表 + 详情：策略、盈亏、风险/回测/资金占用等）。产品边界见 [STRATEGY_INSTANCE_PAGE.md](STRATEGY_INSTANCE_PAGE.md)。实现后可按策略、按单笔开仓查看 PnL 与盈亏比，补齐 R-M7/R-H2 的按策略维度。 |
| **22** | **组合级模型化回报与风险（Model Analysis）** | R-M8 | ⏳ V1 已实现 | V1 完成：服务端 payoff envelope + CAR + DTE 年化 + BS Delta + stress matrix（`GET /portfolio/model-analysis`）；前端 Model Analysis 页（Disclaimer、per-underlying 表、drill-down、account stress matrix）。V1.5/V2 待做：Expected Return/POP、多账户合并、独立 risk 进程。专项见 [PORTFOLIO_RISK_RETURN.md](PORTFOLIO_RISK_RETURN.md)。 |
| **23** | **Massive 期权研究数据（Option Discovery 主力源）** | R-A6，R-OD1，R-A3 | ⚠️ 部分实现 | 已实现：`massive` 配置与 REST 客户端、`job_massive_backfill` + Celery `massive` 队列、`GET /research/massive/status|option-snapshots|option-oi|option-trades`、`POST /research/massive/sync`、expirations `provider=auto|ib|massive`、`GET /bars` 支持 `asset=option`+`source`、Option Discovery UI（Massive badge、延迟说明、同步+轮询、Greeks/OI 列）。可选二期：Massive WS → Redis → SSE 仍未做。详见 [ARCHITECTURE.md](../ARCHITECTURE.md) §2.10。 |

---

## 策略三层与「当前生效」小结

| 层级 | 表/API | 当前生效（settings） | Daemon 使用 | Current Active 展示 | Set active 入口 |
|------|--------|----------------------|-------------|---------------------|-----------------|
| **Structure** | strategy_structure，GET/POST /strategies/structures | active_strategy_structure_id ✅ | ✅ 加载并注入 config | ✅ Structure 页 + Gates 页（Gates 页仅 Gate） | ✅ Structure 页 |
| **Gates** | gate_safety_*，GET/POST /strategies/gate-safety | active_gate_safety_strategy_id ✅ | ✅ 加载 gates | ✅ Structure 页 + Gates 页 | ✅ Gates 页 |
| **Allocations** | strategy_allocation，GET/POST /strategies/allocations | active_strategy_allocation_id ✅ | ❌ 未使用 | ✅ Structure 页 + Gates 页 + Allocations 页 | ✅ Allocations 页 |

**下一步**：Allocations 层「当前生效」已补齐。可与「机会监控与提醒」（R-RM9）结合，使监控范围由当前生效的 Allocation 决定（可选）；Daemon 按 allocation 加载 opportunity 列表为后续迭代。

---

## 与阶段、文档的对应关系

- **阶段 1/2**：能力 8、9、10、11 已验收。
- **阶段 3**：能力 1、2、3、12、13、14 属本阶段；2、12、13 待验收或部分完成。
- **Strategy 三层**：能力 4、5、6、7；6 的「当前生效」已实现（2026-03-17）。
- **期权研究（Massive）**：能力 23（R-A6）；独立于自动交易链路，可与 Option Discovery（R-OD1）、复盘辅助行情（R-A3）协同推进。
- **中间目标（监控+提醒）**：能力 15（R-RM9）；可与能力 4、5、6、7 及 1、2、3 组合推进。
- **终极目标**：能力 20；依赖 1–19 中与自动交易相关的项均达标。

**更新约定**：实现或验收完成某能力维度后，将上表「当前进度」更新为 ✅ 并简要注明；发现新短板或新维度时可增行。
