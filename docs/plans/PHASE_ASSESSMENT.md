# 阶段评估与下一步（基于分步推进计划）

基于 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 与各阶段执行计划（phase1/phase2/phase3-execution-plan.md）的评估与建议。**每次阶段评估时更新本文档**的「评估结论」「当前项目进展」「项目里程碑时间线」及待办；项目需求、系统架构、分步推进计划在需求与硬件/架构不变时**不修改**，见 [项目工作流](PROJECT_WORKFLOW.md)。

**评估/更新记录**：首次评估 2026-02-14；**最后更新** 2026-02-26。

---

## 评估结论（结论先行）

**当前项目进度**：阶段 1、2 **已验收完成**；阶段 3（数据获取）**已完成实现**（R-A1、R-M6、R-H2 已落地），待正式验收；阶段 4（策略与回测）、阶段 5（自动对冲与监控）**未开始**。R-C3（一键平敞口）已明确延后至阶段 5。

**当前里程碑状态**：阶段 1/2 验收完成日 2026-02-26；阶段 3 部分实现 2026-02-14，项目**当前处于阶段 3 工作状态**；2026-02-26 需求/计划变更（R-M6 加入、阶段重组为 3=数据获取、4=策略与回测、5=自动对冲与监控）。详见下文「当前项目进展」与「项目里程碑时间线」表。

**建议下一步**：（1）完成 R-H2 后执行阶段 3 验收；（2）或进入阶段 4（策略与回测）。Test Case 覆盖与各阶段详情见下文对应章节。

---

## 当前项目进展（阶段完成状态）

以下**实现完成时间**、**验收完成时间**采用 YYYY-MM-DD；未完成者标「—」。**每次阶段评估后**由负责人更新本表与「项目里程碑时间线」。

| 阶段 | 实现状态 | 验收状态 | **实现完成时间** | **验收完成时间** | 备注 |
|------|----------|----------|------------------|------------------|------|
| **阶段 1** | ✅ **已完成实现** | ✅ **验收完成** | 2026-02-14 | 2026-02-26 | sink（PostgreSQL）、信号停止、操作写入、历史表已落地 |
| **阶段 2** | ✅ **已完成实现** | ✅ **验收完成** | 2026-02-14 | 2026-02-26 | 独立应用（servers/）、GET /status、红绿灯、GET /operations、POST /control/stop 已落地；R-C3 不在本阶段 |
| **阶段 3**（数据获取） | ✅ **已完成实现** | ⏳ 待正式验收 | 2026-02-26 | — | **当前项目工作阶段**；R-A1、R-M6、R-H2 已落地；`scripts/stats_from_history.py` 历史统计 |
| **阶段 4**（策略与回测） | 未开始 | — | — | — | R-B1、R-B2 回测与策略框架 |
| **阶段 5**（自动对冲与监控） | 未开始 | — | — | — | R-C2 暂停/恢复、R-C3 一键平敞口；接口已预留 |

---

## 项目里程碑时间线

按时间顺序记录**需求/计划变更**与**阶段实现/验收**里程碑。格式：**日期** | **类型** | **内容**。**每次阶段评估后**由负责人更新。

| 日期 | 类型 | 内容 |
|------|------|------|
| 2026-02-14 | 阶段实现 | **阶段 1** 实现完成：R-M1a、R-M4a、R-C1a、R-H1（sink、操作写入、信号停止、当前+历史） |
| 2026-02-14 | 阶段实现 | **阶段 2** 实现完成：R-M1b、R-M2、R-M3、R-M4b、R-C1b（独立应用、GET /status、红绿灯、GET /operations、POST /control/stop） |
| 2026-02-14 | 阶段实现 | **阶段 3（部分）**：R-A1（账户与持仓可获取）、R-M6（标的与持仓当前市价可获取）已实现；R-H2 待实现 |
| **2026-02-26** | 需求/计划 | **R-M6** 需求加入；**阶段重组**：阶段 3=数据获取、阶段 4=策略与回测、阶段 5=自动对冲与监控 |
| **2026-02-26** | 阶段验收 | **阶段 1** 正式验收通过（全部 TC-1-* 通过并记录） |
| **2026-02-26** | 阶段验收 | **阶段 2** 正式验收通过（全部 TC-2-* 通过并记录） |
| — | 阶段验收 | 阶段 3 正式验收通过（R-A1、R-M6、R-H2 全部验收条通过） |

**使用说明**：阶段实现完成或正式验收通过后，将上表对应行日期更新为实际完成日（YYYY-MM-DD），并同步更新「当前项目进展」表中的**实现完成时间**或**验收完成时间**。是否进入下一阶段或是否调整需求/架构，由负责人在评估后给出结论，见 [项目工作流](PROJECT_WORKFLOW.md)。

---

## 一、当前待办与下一步

**阶段 1、2 已验收完成**（2026-02-26）。**当前项目处于阶段 3 工作状态**，已有 [phase3-execution-plan.md](phase3-execution-plan.md)，建议按下面优先级推进。

| 优先级 | 待办项 | 说明 |
|--------|--------|------|
| **必选** | **阶段 3 执行计划与验收** | 已有 [phase3-execution-plan.md](phase3-execution-plan.md)（阶段 3 数据获取）。按该执行计划或 PLAN_NEXT_STEPS 的 TC-3-* 逐条执行阶段 3 验收并记录（含 R-H2 实现后）；可选新增 `scripts/check/phase3_0.py` 做 GET /status 字段与账户/持仓/spot 的校验。 |
| 可选 | phase2 自检脚本 | 新增 `scripts/check/phase2.py`：请求 GET /status、GET /operations，校验 status_lamp、self_check 等字段存在；可与已运行 daemon 配合测 POST /control/stop。 |

**结论**：阶段 3 已有 [phase3-execution-plan.md](phase3-execution-plan.md)，可按其验收清单与 PLAN_NEXT_STEPS 的 TC-3-* 执行正式验收（R-H2 实现后；无 phase3_0.py 时需人工执行并记录）。

---

## 二、阶段 1（状态 Sink + 最小控制）— 已验收完成

### 2.1 阶段 1 目标与需求

| 需求   | 简述 |
|--------|------|
| **R-M1a** | 状态可观测·写出侧：守护程序将运行状态写入 sink，供外部读取 |
| **R-M4a** | 操作可查·写出侧：对冲/下单/成交/撤单等写入操作表 |
| **R-C1a** | 一键停止·信号与控制文件：SIGTERM/SIGINT 触发优雅退出（控制文件留阶段 2） |
| **R-H1**  | 状态可扩展为带历史：sink 支持当前视图 + 历史表，配置可选 sink |

### 2.2 实现完成度（与执行计划 Todo 对照）

| 步骤 | 内容 | 状态 | **完成时间** | 说明 |
|------|------|------|--------------|------|
| 1.1–1.3 | 配置与 StatusSink 接口 | ✅ | 2026-02-14 | `config.status.sink` / `status.postgres`，`src/sink/base.py`，GsTrading 按配置创建 sink |
| 2.1–2.2 | PostgreSQLSink | ✅ | 2026-02-14 | `status_current` / `status_history` / `operations`，`write_snapshot(append_history)`、`write_operation` |
| 3.1–3.3 | GsTrading 挂接快照 | ✅ | 2026-02-14 | heartbeat 写当前表；进入 RUNNING 立即写一次；spot 不可用时写 minimal；有操作时 append_history |
| 4.1–4.2 | 操作记录写入 | ✅ | 2026-02-14 | hedge_intent、order_sent、fill、reject 处 `write_operation`，必要时 `write_snapshot(..., append_history=True)` |
| 5.1 | 信号停止 | ✅ | 2026-02-14 | `run_engine.py` / `_run_daemon_main` 注册 SIGTERM/SIGINT → `app.stop()`，asyncio 安全退出 |
| 6 | 控制文件 | ⏸️ | — | 按计划留给阶段 2 |
| 7.1 | 文档 | ✅ | 2026-02-14 | 依赖 PostgreSQL、status 配置、查表示例已说明 |
| **7.2** | **正式验收** | ✅ | 2026-02-26 | 已按「检查方式」与 Test Case 清单执行，全部 TC-1-* 通过 |

### 2.3 运行环境与体验（近期补齐）

- **IB 连接**：`ib_insync` 已改为 async 用法，避免 “event loop already running”；Client ID 冲突（326）时自动换 ID 重试，单次尝试约 15–20s 超时并打明确日志。
- **status_current**：进入 RUNNING 即写一条；heartbeat 在 spot 不可用时也写 minimal，保证表里始终有当前状态。
- **控制台**：统一 `[Daemon] state=...` 前缀，便于一眼看出当前状态与流转。

### 2.4 阶段 1 结论

- **实现**：阶段 1 功能已按计划实现（控制文件除外，留阶段 2）。
- **验收**：2026-02-26 正式验收通过。

### 2.5 阶段 1 Test Case（TC-1-*）

以下与 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 阶段 1「本阶段 Test Case 清单」对应。**覆盖方式**：**自动化** = 有脚本可执行并给出 PASS/FAIL；**人工** = 需按文档步骤手动执行并记录。

| Test Case ID | 对应需求 | 覆盖方式 | 说明 |
|--------------|----------|----------|------|
| TC-1-R-M1a-1 | R-M1a | 人工 | 需启动守护程序后查 sink 是否有新 snapshot；phase1.py 不启动 daemon |
| TC-1-R-M1a-2 | R-M1a | **自动化** | `scripts/check/phase1.py` 中 check_pg_schema：表存在且可读 |
| TC-1-R-M1a-3 | R-M1a | **自动化** | phase1.py 中 check_sink_interface：SNAPSHOT_KEYS 与 DATABASE.md 一致 |
| TC-1-R-M4a-1 | R-M4a | 人工 | 需有对冲/下单/成交发生后再查 operations 表 |
| TC-1-R-M4a-2 | R-M4a | **自动化** | phase1.py 中 check_sink_interface：OPERATION_KEYS 一致 |
| TC-1-R-M4a-3 | R-M4a | **自动化** | phase1.py 中 check_pg_schema：operations 表及列存在 |
| TC-1-R-H1-1 | R-H1 | **自动化** | phase1.py 中 check_pg_schema：status_current + status_history 表及列 |
| TC-1-R-H1-2 | R-H1 | 设计/文档 | 无需改写逻辑即可扩展历史读；无独立自动化 |
| TC-1-R-H1-3 | R-H1 | **自动化** | phase1.py 中 check_config：status.sink + postgres 配置 |
| TC-1-R-C1a-1 | R-C1a | **自动化** | phase1.py --signal-test：起 daemon、SIGTERM、断言退出 |
| TC-1-R-C1a-2 | R-C1a | 不适用 | 控制文件按计划留阶段 2；当前为 DB 控制，无 1.3 |

**阶段 1 小结**：约 **6 个 TC** 由 `scripts/check/phase1.py` 覆盖；**3 个**需人工；**1 个**为设计验证；**1 个**不适用。

---

## 三、阶段 2（独立监控/控制应用）— 已验收完成

阶段 2 功能已实现，与阶段 1 共同构成当前可运行的整体。**R-C3（一键平敞口）不在阶段 2 验收**，已延后至**阶段 5**。

### 3.1 阶段 2 目标与需求

| 需求   | 简述 |
|--------|------|
| **R-M1b** | 状态可观测·读与展示：独立应用 GET /status，展示当前运行状态 |
| **R-M2** | 状态自检：self_check（ok/degraded/blocked）+ block_reasons，可读可展示 |
| **R-M3** | 红绿灯监控：GET /status 含 status_lamp（green/yellow/red） |
| **R-M4b** | 操作可查·读与查询：GET /operations，按时间/类型筛选 |
| **R-C1b** | 一键停止·独立应用发停止：POST /control/stop，写控制通道或调本地 API |

*R-C3 延后：依赖 R-A1、持仓与策略边界等，见阶段 5。*

### 3.2 可做的工作（与计划步骤对应）

| 步骤 | 内容 | 交付物 | **完成时间** |
|------|------|--------|--------------|
| 2.1 | 独立应用入口 | 读 sink；GET /status（含 status_lamp）；GET /operations；POST /control/stop；flatten 接口预留 | 2026-02-14 |
| 2.2 | 配置与文档 | sink 路径、控制通道、监控端口等入 config 与 README/docs | 2026-02-14 |
| 2.3 | R-C3 不在本阶段 | 控制通道已支持 command=flatten，守护进程消费后暂打日志；平仓逻辑在阶段 5 实现 | 2026-02-14 |

**里程碑**：独立进程可读 sink；GET /status 含红绿灯；GET /operations 可查操作；POST /control/stop 可停守护进程。

### 3.3 阶段 2 前置依赖

- 阶段 1 验收通过（sink 与信号已就绪）。
- 控制通道（如 daemon_control 表）在阶段 2 定义并实现（R-C1b 与 POST /control/stop）。

### 3.4 阶段 2 实现说明（已落地）

- **独立应用**：`scripts/run_server.py`；`servers/`（reader、self_check、app）。GET /status 含 status_lamp、self_check、block_reasons；GET /operations 支持 since_ts、until_ts、type、limit；POST /control/stop、POST /control/flatten 写 daemon_control 表（flatten 仅写表，守护进程侧不执行平仓）。
- **守护进程**：heartbeat 内轮询 daemon_control，读到 `stop` 即 `request_stop()`；读到 `flatten` 暂打日志（R-C3 延后）。
- **配置与文档**：README 含 Phase 2 配置、启动命令与 curl 示例；PLAN_NEXT_STEPS 含控制通道说明。

### 3.5 阶段 2 Test Case（TC-2-*）

以下与 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 阶段 2「本阶段 Test Case 清单」对应。

| Test Case ID | 对应需求 | 覆盖方式 | 说明 |
|--------------|----------|----------|------|
| TC-2-R-M1b-1 | R-M1b | 人工 | curl/浏览器 GET /status，确认返回 200 与 JSON |
| TC-2-R-M1b-2 | R-M1b | 人工 | 确认返回含 status、daemon_heartbeat 等字段 |
| TC-2-R-M2-1 | R-M2 | 人工 | 确认 GET /status 含 self_check、block_reasons |
| TC-2-R-M3-1 | R-M3 | 人工 | 确认含 status_lamp（green/yellow/red）且与自检一致 |
| TC-2-R-M4b-1 | R-M4b | 人工 | GET /operations?limit=10 等，确认支持参数与返回列表 |
| TC-2-R-M4b-2 | R-M4b | 人工 | 确认返回为操作列表，含 type、ts、side 等 |
| TC-2-R-C1b-1 | R-C1b | 人工 | POST /control/stop 后确认守护进程在预期内退出 |
| TC-2-DOC | 文档 | 人工 | 新环境按 README 从零部署一次 |

*R-C3 不纳入阶段 2 验收，TC-2-R-C3-* 已移除；R-C3 待阶段 5 规划。*

**阶段 2 小结**：**全部 TC-2-*（8 项）目前为人工验收**；无 `scripts/check/phase2.py` 或 pytest 集成。

---

## 四、阶段 3 执行计划与验收现状（当前工作阶段）

### 4.1 执行计划与验收依据

与**阶段 1、2** 不同，**阶段 3（数据获取）** 目前状态如下：

| 项目 | 阶段 1 | 阶段 2 | 阶段 3（数据获取） |
|------|--------|--------|------------------|
| **执行计划文档** | ✅ [phase1-execution-plan.md](phase1-execution-plan.md) | ✅ [phase2-execution-plan.md](phase2-execution-plan.md) | ✅ [phase3-execution-plan.md](phase3-execution-plan.md)（Todo、验收清单、代码锚点） |
| **自检/验收脚本** | ✅ `scripts/check/phase1.py` | ⏳ 无 phase2.py（可选） | ❌ **无** scripts/check/phase3_0.py 或等价脚本 |
| **验收依据** | 执行计划 + PLAN_NEXT_STEPS TC-1-* | phase2 验收清单 + PLAN_NEXT_STEPS TC-2-* | phase3-execution-plan + PLAN_NEXT_STEPS 阶段 3 验证标准与 TC-3-* |

**影响**：阶段 3 的**正式验收**可依据 [phase3-execution-plan.md](phase3-execution-plan.md) 的 Todo/验收清单与 [PLAN_NEXT_STEPS 阶段 3](../PLAN_NEXT_STEPS.md#阶段-3数据获取账户持仓市值交易历史与统计) 的「检查方式」「验证标准」逐条执行并记录；目前**无** phase3_0.py，需人工执行 TC-3-* 或后续补充自检脚本。

**建议**：按 phase3-execution-plan 执行阶段 3 验收并更新里程碑时间线；可选新增 `scripts/check/phase3_0.py`（如校验 GET /status 含 account、positions、spot 等字段）以便自动化部分 TC。

### 4.2 阶段 3 Test Case（TC-3-*）

以下与 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 阶段 3「本阶段 Test Case 清单」对应。

| Test Case ID | 对应需求 | 覆盖方式 | 说明 |
|--------------|----------|----------|------|
| TC-3-R-A1-1 | R-A1 | 人工/未自动化 | 守护程序连接 IB 后能请求并获取当前账户基本信息 |
| TC-3-R-A1-2 | R-A1 | 人工/未自动化 | 守护程序能获取当前持仓，可供内部对冲逻辑使用 |
| TC-3-R-A1-3 | R-A1 | 人工/未自动化 | 账户与持仓在运行中可持续更新；IB 断连或异常时行为明确 |
| TC-3-R-M6-1 | R-M6 | 人工/未自动化 | 守护程序在运行中从 IB 拉取标的市价并写入 status_current/sink |
| TC-3-R-M6-2 | R-M6 | 人工/未自动化 | GET /status 返回中含标的市价（如 status.spot），可供监控页读取 |
| TC-3-R-M6-3 | R-M6 | 人工/未自动化 | 监控页能结合持仓与市价展示（持仓+当前价、盈亏、期权虚实等） |
| TC-3-R-H2-1 | R-H2 | 人工/已实现 | `scripts/stats_from_history.py` 只读历史表；输出含按日/周对冲次数与盈亏相关；可离线运行 |

*阶段 3（R-A1、R-M6、R-H2）已实现；验收待执行并记录。*

### 4.3 Test Case 覆盖汇总

| 阶段 | Test Case 总数 | 自动化 | 人工 | 不适用/未实现 |
|------|----------------|--------|------|----------------|
| 阶段 1 | 11 | 6 | 3 | 2（R-H1-2 设计；R-C1a-2 留阶段 2） |
| 阶段 2 | 8 | 0 | 8 | 0（R-C3 已移出阶段 2，无 TC-2-R-C3-*） |
| 阶段 3 | 7 | 0 | 7（待验收） | 0 |

---

## 五、总结

| 项目     | 结论 |
|----------|------|
| **结论位置** | 本文档**开头「评估结论」**已给出当前进度、里程碑状态与建议下一步；每次评估时优先更新该节及「当前项目进展」「项目里程碑时间线」表。 |
| **阶段 1/2** | 已实现（2026-02-14），**验收完成**（2026-02-26）；有 phase1/phase2 执行计划与 phase1.py。 |
| **阶段 3** | **当前项目工作阶段**；R-A1、R-M6、R-H2 已实现；有 phase3-execution-plan，无 phase3_0.py。 |
| **阶段 4/5** | 未开始。 |
