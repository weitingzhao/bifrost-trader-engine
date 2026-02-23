# 阶段评估与下一步（基于分步推进计划）

基于 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 与 [phase1-execution-plan.md](phase1-execution-plan.md) 的评估与建议。  
**Test Case 覆盖详情**见本文档「六、Test Case 覆盖情况」。

---

## 一、当前阶段评估结论

**阶段 1 与阶段 2 均已实现并落地**：sink、信号停止、独立监控应用（servers/）、GET /status、GET /operations、红绿灯、POST /control/stop 等均已在代码中实现。控制通道采用 PostgreSQL（daemon_control / daemon_run_status），无本地控制文件。  
**R-C3（一键平敞口）已明确延后**：依赖阶段 3 多项能力（R-A1 账户与持仓、策略边界、平仓逻辑等），**不纳入阶段 2 验收**，延后至**阶段 3.6 或更后**；独立应用与控制表已预留 flatten 接口，守护进程侧平仓逻辑待后续阶段实现。  
**尚未完成**：阶段 1/2 的**正式验收**（按 PLAN_NEXT_STEPS 逐条执行 Test Case 并记录通过）；阶段 2 的**自动化 TC 脚本**尚未建设；阶段 3.0（R-A1）及以后未实现。

**当前项目所处阶段**：**阶段 2 已完成实现**（不含 R-C3），建议下一步为（1）**开启阶段三之前**完成下文「待办」中的必选项，或（2）直接进入 **阶段 3.0（R-A1 账户与持仓可获取）**。

---

## 二、开启阶段三之前待办

在**正式进入阶段 3.0 开发**之前，建议完成以下工作，以便阶段边界清晰、可回溯。

| 优先级 | 待办项 | 说明 |
|--------|--------|------|
| **必选** | **阶段 1 正式验收** | 按 [PLAN_NEXT_STEPS](../PLAN_NEXT_STEPS.md) 阶段 1「检查方式」与「本阶段 Test Case 清单」执行：运行 `python scripts/check/phase1.py`（及可选 `--signal-test`），补人工 TC（如起 daemon 后查 snapshot/operations），**全部 TC-1-* 通过**并记录，视为阶段 1 通过。 |
| **必选** | **阶段 2 正式验收** | 按 PLAN_NEXT_STEPS 阶段 2「检查方式」与「本阶段 Test Case 清单」执行：GET /status、GET /operations、POST /control/stop、文档部署等，**全部 TC-2-*（不含 R-C3）通过**并记录，视为阶段 2 通过。 |
| 可选 | 阶段 1/2 TC 记录 | 将验收结果记录到文档或 issue（如通过/不通过、执行日期），便于后续审计与回归。 |
| 可选 | phase2 自检脚本 | 新增 `scripts/check/phase2.py`：请求 GET /status、GET /operations，校验 status_lamp、self_check 等字段存在；可与已运行 daemon 配合测 POST /control/stop。 |

**结论**：若不做正式验收即可进入阶段 3.0，建议至少**跑通 phase1.py 并确认阶段 2 人工检查项无阻塞**；正式验收可在阶段 3.0 开发间隙补做。

---

## 三、阶段 1（状态 Sink + 最小控制）

### 3.1 阶段 1 目标与需求

| 需求   | 简述 |
|--------|------|
| **R-M1a** | 状态可观测·写出侧：守护程序将运行状态写入 sink，供外部读取 |
| **R-M4a** | 操作可查·写出侧：对冲/下单/成交/撤单等写入操作表 |
| **R-C1a** | 一键停止·信号与控制文件：SIGTERM/SIGINT 触发优雅退出（控制文件留阶段 2） |
| **R-H1**  | 状态可扩展为带历史：sink 支持当前视图 + 历史表，配置可选 sink |

### 3.2 实现完成度（与执行计划 Todo 对照）

| 步骤 | 内容 | 状态 | 说明 |
|------|------|------|------|
| 1.1–1.3 | 配置与 StatusSink 接口 | ✅ | `config.status.sink` / `status.postgres`，`src/sink/base.py`，GsTrading 按配置创建 sink |
| 2.1–2.2 | PostgreSQLSink | ✅ | `status_current` / `status_history` / `operations`，`write_snapshot(append_history)`、`write_operation` |
| 3.1–3.3 | GsTrading 挂接快照 | ✅ | heartbeat 写当前表；进入 RUNNING 立即写一次；spot 不可用时写 minimal；有操作时 append_history |
| 4.1–4.2 | 操作记录写入 | ✅ | hedge_intent、order_sent、fill、reject 处 `write_operation`，必要时 `write_snapshot(..., append_history=True)` |
| 5.1 | 信号停止 | ✅ | `run_engine.py` / `_run_daemon_main` 注册 SIGTERM/SIGINT → `app.stop()`，asyncio 安全退出 |
| 6 | 控制文件 | ⏸️ | 按计划留给阶段 2 |
| 7.1 | 文档 | ✅ | 依赖 PostgreSQL、status 配置、查表示例已说明 |
| **7.2** | **正式验收** | ⏳ | 需按「检查方式」与 Test Case 清单执行，确认全部 TC-1-* 通过 |

### 3.3 运行环境与体验（近期补齐）

- **IB 连接**：`ib_insync` 已改为 async 用法，避免 “event loop already running”；Client ID 冲突（326）时自动换 ID 重试，单次尝试约 15–20s 超时并打明确日志。
- **status_current**：进入 RUNNING 即写一条；heartbeat 在 spot 不可用时也写 minimal，保证表里始终有当前状态。
- **控制台**：统一 `[Daemon] state=...` 前缀，便于一眼看出当前状态与流转。

### 3.4 阶段 1 结论

- **实现**：阶段 1 功能已按计划实现（控制文件除外，留阶段 2）。
- **待完成**：执行 **7.2 正式验收**——跑自检脚本并人工核对 Test Case，全部通过后可视为阶段 1 通过。

**建议动作**：

1. 本地/CI 执行：`python scripts/check/phase1.py`（有 TWS 时默认带 IB；无 TWS 用 `--skip-ib`）。
2. 需要信号测试时：`python scripts/check/phase1.py --signal-test`（可选 `--signal-verbose` 看证据）。
3. 按 [phase1-execution-plan.md](phase1-execution-plan.md) 的「检查方式」与「本阶段 Test Case 清单」逐条确认，全部通过后勾选 7.2，阶段 1 收尾。

---

## 四、阶段 2（独立监控/控制应用）— 已落地

阶段 2 功能已实现，与阶段 1 共同构成当前可运行的整体。**R-C3（一键平敞口）不在阶段 2 验收**，已延后至阶段 3.6 或更后。

### 4.1 阶段 2 目标与需求

| 需求   | 简述 |
|--------|------|
| **R-M1b** | 状态可观测·读与展示：独立应用 GET /status，展示当前运行状态 |
| **R-M2** | 状态自检：self_check（ok/degraded/blocked）+ block_reasons，可读可展示 |
| **R-M3** | 红绿灯监控：GET /status 含 status_lamp（green/yellow/red） |
| **R-M4b** | 操作可查·读与查询：GET /operations，按时间/类型筛选 |
| **R-C1b** | 一键停止·独立应用发停止：POST /control/stop，写控制通道或调本地 API |

*R-C3 延后：依赖 R-A1、持仓与策略边界等，见阶段 3.6 或更后。*

### 4.2 可做的工作（与计划步骤对应）

| 步骤 | 内容 | 交付物 |
|------|------|--------|
| 2.1 | 独立应用入口 | 读 sink；GET /status（含 status_lamp）；GET /operations；POST /control/stop；flatten 接口预留 |
| 2.2 | 配置与文档 | sink 路径、控制通道、监控端口等入 config 与 README/docs |
| 2.3 | R-C3 不在本阶段 | 控制通道已支持 command=flatten，守护进程消费后暂打日志；平仓逻辑在阶段 3.6 或更后实现 |

**里程碑**：独立进程可读 sink；GET /status 含红绿灯；GET /operations 可查操作；POST /control/stop 可停守护进程。

### 4.3 阶段 2 前置依赖

- 阶段 1 验收通过（sink 与信号已就绪）。
- 控制通道（如 daemon_control 表）在阶段 2 定义并实现（R-C1b 与 POST /control/stop）。

### 4.4 阶段 2 实现说明（已落地）

- **独立应用**：`scripts/run_server.py`；`servers/`（reader、self_check、app）。GET /status 含 status_lamp、self_check、block_reasons；GET /operations 支持 since_ts、until_ts、type、limit；POST /control/stop、POST /control/flatten 写 daemon_control 表（flatten 仅写表，守护进程侧不执行平仓）。
- **守护进程**：heartbeat 内轮询 daemon_control，读到 `stop` 即 `request_stop()`；读到 `flatten` 暂打日志（R-C3 延后）。
- **配置与文档**：README 含 Phase 2 配置、启动命令与 curl 示例；PLAN_NEXT_STEPS 含控制通道说明。

---

## 五、再后续阶段（概要）

| 阶段   | 主要内容 |
|--------|----------|
| **3.0** | **R-A1**：账户与持仓可获取——守护程序从 IB 获取账户基本信息（账户、Balance 等）与当前持仓，作为自动交易对冲的基本能力 |
| **3.1** | R-H2：历史统计脚本/模块，只读历史表，按日/周对冲次数、盈亏等 |
| **3.2** | R-C2：暂停/恢复自动对冲（pause/resume） |
| **3.3** | 可选 Redis/PostgreSQL 等 sink 扩展 |
| **3.4** | 部署与进程管理（systemd/supervisor、文档） |
| **3.5** | R-B1/R-B2：回测（策略 PnL、Guard 边界验证） |
| **3.6 或更后** | **R-C3**：一键平敞口（依赖 R-A1、策略边界与平仓逻辑等） |

---

## 六、Test Case 覆盖情况

以下与 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 中各阶段「本阶段 Test Case 清单」对应。**覆盖方式**：**自动化** = 有脚本可执行并给出 PASS/FAIL；**人工** = 需按文档步骤手动执行并记录。

### 6.1 阶段 1（TC-1-*）

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

**阶段 1 小结**：约 **6 个 TC** 由 `scripts/check/phase1.py` 覆盖（Config、Sink 接口、PostgreSQL 表结构、SIGTERM 退出）；**3 个**需人工（起 daemon 后查 snapshot/operations）；**1 个**为设计验证；**1 个**不适用。运行环境验证（IB 连通性）由 phase1.py 默认执行，可用 `--skip-ib` 跳过。

### 6.2 阶段 2（TC-2-*）

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

*R-C3 不纳入阶段 2 验收，TC-2-R-C3-* 已移除；R-C3 待阶段 3.6 或更后规划。*

**阶段 2 小结**：**全部 TC-2-*（8 项）目前为人工验收**；无 `scripts/check/phase2.py` 或 pytest 集成。建议后续增加 phase2 自检脚本（如请求 GET /status、GET /operations、校验 status_lamp 与 self_check 存在，可选 POST /control/stop 需配合已运行 daemon）。

### 6.3 阶段 3.0（TC-3.0-R-A1-*）

| Test Case ID | 对应需求 | 覆盖方式 | 说明 |
|--------------|----------|----------|------|
| TC-3.0-R-A1-1 | R-A1 | 未实现 | 阶段 3.0 未开发 |
| TC-3.0-R-A1-2 | R-A1 | 未实现 | 同上 |
| TC-3.0-R-A1-3 | R-A1 | 未实现 | 同上 |

### 6.4 覆盖汇总

| 阶段 | Test Case 总数 | 自动化 | 人工 | 不适用/未实现 |
|------|----------------|--------|------|----------------|
| 阶段 1 | 11 | 6 | 3 | 2（R-H1-2 设计；R-C1a-2 留阶段 2） |
| 阶段 2 | 8 | 0 | 8 | 0（R-C3 已移出阶段 2，无 TC-2-R-C3-*） |
| 阶段 3.0 | 3 | 0 | 0 | 3（阶段未实现） |

**建议**：  
- 阶段 1 验收：执行 `python scripts/check/phase1.py`（及可选 `--signal-test`），再按清单补人工 TC（TC-1-R-M1a-1、TC-1-R-M4a-1），通过后视为阶段 1 通过。  
- 阶段 2 验收：按 PLAN_NEXT_STEPS 检查方式逐条人工执行并记录；有需要可新增 `scripts/check/phase2.py` 做 GET /status、/operations 与字段校验。  
- 阶段 3.0：实现 R-A1 时再补充 TC-3.0-R-A1-* 的自动化或人工步骤。

---

## 七、总结

| 项目     | 结论 |
|----------|------|
| **当前阶段** | **阶段 2 已实现**（阶段 1+2 功能均已落地） |
| **阶段 1 状态** | 功能已实现；部分 TC 由 phase1.py 自动化，其余需人工验收 |
| **阶段 2 状态** | 功能已实现（servers/、GET /status、红绿灯、POST /control/stop）；R-C3 不纳入，延后至 3.6 或更后；TC 全部为人工，无 phase2 脚本 |
| **建议下一步** | （1）完成「二、开启阶段三之前待办」中的必选验收后再进入阶段 3.0；或（2）直接进入 **阶段 3.0（R-A1）**，验收可后续补做 |
| **阶段 3.0 之后** | 按需推进 3.1（历史统计）、3.2（暂停/恢复）、3.4（部署）、3.5（回测）等 |
