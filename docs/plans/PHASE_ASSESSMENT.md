# 阶段评估与下一步（基于分步推进计划）

基于 [PLAN_NEXT_STEPS.md](../PLAN_NEXT_STEPS.md) 与 [phase1-execution-plan.md](phase1-execution-plan.md) 的评估与建议。

---

## 一、当前阶段：阶段 1（状态 Sink + 最小控制）

### 1.1 阶段 1 目标与需求

| 需求   | 简述 |
|--------|------|
| **R-M1a** | 状态可观测·写出侧：守护程序将运行状态写入 sink，供外部读取 |
| **R-M4a** | 操作可查·写出侧：对冲/下单/成交/撤单等写入操作表 |
| **R-C1a** | 一键停止·信号与控制文件：SIGTERM/SIGINT 触发优雅退出（控制文件留阶段 2） |
| **R-H1**  | 状态可扩展为带历史：sink 支持当前视图 + 历史表，配置可选 sink |

### 1.2 实现完成度（与执行计划 Todo 对照）

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

### 1.3 运行环境与体验（近期补齐）

- **IB 连接**：`ib_insync` 已改为 async 用法，避免 “event loop already running”；Client ID 冲突（326）时自动换 ID 重试，单次尝试约 15–20s 超时并打明确日志。
- **status_current**：进入 RUNNING 即写一条；heartbeat 在 spot 不可用时也写 minimal，保证表里始终有当前状态。
- **控制台**：统一 `[Daemon] state=...` 前缀，便于一眼看出当前状态与流转。

### 1.4 阶段 1 结论

- **实现**：阶段 1 功能已按计划实现（控制文件除外，留阶段 2）。
- **待完成**：执行 **7.2 正式验收**——跑自检脚本并人工核对 Test Case，全部通过后可视为阶段 1 通过。

**建议动作**：

1. 本地/CI 执行：`python scripts/check/phase1.py`（有 TWS 时默认带 IB；无 TWS 用 `--skip-ib`）。
2. 需要信号测试时：`python scripts/check/phase1.py --signal-test`（可选 `--signal-verbose` 看证据）。
3. 按 [phase1-execution-plan.md](phase1-execution-plan.md) 的「检查方式」与「本阶段 Test Case 清单」逐条确认，全部通过后勾选 7.2，阶段 1 收尾。

---

## 二、下一阶段：阶段 2（独立监控/控制应用）

阶段 1 验收通过后，按计划进入 **阶段 2**。

### 2.1 阶段 2 目标与需求

| 需求   | 简述 |
|--------|------|
| **R-M1b** | 状态可观测·读与展示：独立应用 GET /status，展示当前运行状态 |
| **R-M2** | 状态自检：self_check（ok/degraded/blocked）+ block_reasons，可读可展示 |
| **R-M3** | 红绿灯监控：GET /status 含 status_lamp（green/yellow/red） |
| **R-M4b** | 操作可查·读与查询：GET /operations，按时间/类型筛选 |
| **R-C1b** | 一键停止·独立应用发停止：POST /control/stop，写控制文件或调本地 API |
| **R-C3**（可选） | 一键平敞口：POST /control/flatten，仅平本策略对冲敞口 |

### 2.2 可做的工作（与计划步骤对应）

| 步骤 | 内容 | 交付物 |
|------|------|--------|
| 2.1 | 独立应用入口 | 如 `scripts/run_status_server.py`：读 sink（PostgreSQL 当前视图 + 操作表）；GET /status（含 status_lamp）；GET /operations；POST /control/stop（控制文件或本地 API）；可选 POST /control/flatten |
| 2.2 | 配置与文档 | sink 路径、控制文件路径、监控端口等入 config 与 README/docs |
| 2.3 | R-C3（若本阶段做） | 守护进程支持 flatten 指令；独立应用 POST /control/flatten |

**里程碑**：独立进程可读 sink；GET /status 含红绿灯；GET /operations 可查操作；POST /control/stop 可停守护进程；若做 R-C3 则 POST /control/flatten 可平本策略敞口。

### 2.3 阶段 2 前置依赖

- 阶段 1 验收通过（sink 与信号已就绪）。
- 控制文件路径与格式需在阶段 2 定义并实现（R-C1b 与 POST /control/stop）。

### 2.4 阶段 2 实现说明（已落地）

- **独立应用**：`scripts/run_status_server.py`；`src/status_server/`（reader、self_check、app）。GET /status 含 status_lamp、self_check、block_reasons；GET /operations 支持 since_ts、until_ts、type、limit；POST /control/stop、POST /control/flatten 写控制文件。
- **守护进程**：heartbeat 内轮询 `control.file`，读到 `stop` 即 `request_stop()`；`flatten` 暂仅打日志（R-C3 未实现）。
- **配置与文档**：README 含 Phase 2 配置、启动命令与 curl 示例；PLAN_NEXT_STEPS 含控制文件格式说明。

---

## 三、再后续阶段（概要）

| 阶段   | 主要内容 |
|--------|----------|
| **3.1** | R-H2：历史统计脚本/模块，只读历史表，按日/周对冲次数、盈亏等 |
| **3.2** | R-C2：暂停/恢复自动对冲（pause/resume） |
| **3.3** | 可选 Redis/PostgreSQL 等 sink 扩展 |
| **3.4** | 部署与进程管理（systemd/supervisor、文档） |
| **3.5** | R-B1/R-B2：回测（策略 PnL、Guard 边界验证） |

---

## 四、总结

| 项目     | 结论 |
|----------|------|
| **当前阶段** | 阶段 1（状态 Sink + 最小控制） |
| **阶段 1 状态** | 功能已实现；待完成 7.2 正式验收（跑自检 + 核对 Test Case） |
| **建议下一步** | 完成阶段 1 验收 → 进入阶段 2（独立监控/控制应用：GET /status、/operations，POST /control/stop，红绿灯，可选 flatten） |
| **阶段 2 之后** | 按需推进 3.1（历史统计）、3.2（暂停/恢复）、3.4（部署）、3.5（回测）等 |
