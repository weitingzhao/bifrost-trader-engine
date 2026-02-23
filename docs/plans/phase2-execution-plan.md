# Phase 2 执行计划与验收

与 [分步推进计划](../PLAN_NEXT_STEPS.md) 阶段 2 一致：独立监控/控制应用（R-M1b、R-M2、R-M3、R-M4b、R-C1b）；R-C3 可选。

## 已实现

- **配置**：`status.postgres`（与 Phase 1 共用）、`status_server.port`（config/config.yaml 及示例）。控制通道为 PostgreSQL 表 `daemon_control`（见 DATABASE.md §2.4），无需 `control.file`。
- **守护进程**：heartbeat 内轮询表 `daemon_control`（poll_and_consume_control）；消费到 `stop` 即 `request_stop()`；消费到 `flatten` 仅打日志（R-C3 未实现）。
- **独立应用**：`scripts/run_status_server.py`；`src/status_server/`（reader、self_check、app）。FastAPI：GET /status（含 status_lamp、self_check、block_reasons）、GET /operations（since_ts、until_ts、type、limit）、POST /control/stop、POST /control/flatten（均向 `daemon_control` 表 INSERT）。
- **文档**：README Phase 2 配置与 curl 示例；PLAN_NEXT_STEPS、DATABASE.md 控制通道说明；本文件验收记录。

## 验收清单（阶段 2 Test Case）

| Test Case ID | 通过条件 | 验收结果 |
|--------------|----------|----------|
| TC-2-R-M1b-1 | 独立应用提供 GET /status | 通过：GET /status 返回 JSON |
| TC-2-R-M1b-2 | 通过接口拿到当前运行状态（持仓、FSM、指标、配置摘要） | 通过：返回 status 对象含 daemon_state、trading_state、symbol、spot、bid/ask、net_delta、stock_position 等 |
| TC-2-R-M2-1 | self_check（ok/degraded/blocked）+ block_reasons 可读 | 通过：GET /status 含 self_check、block_reasons |
| TC-2-R-M3-1 | GET /status 含 status_lamp（green/yellow/red） | 通过：返回 status_lamp |
| TC-2-R-M4b-1 | GET /operations，支持时间/类型筛选 | 通过：since_ts、until_ts、type、limit 查询参数 |
| TC-2-R-M4b-2 | 返回涉及持仓变化的操作列表 | 通过：operations 数组 |
| TC-2-R-C1b-1 | POST /control/stop 使守护程序在预期时间内优雅退出 | 通过：POST 向 daemon_control 表 INSERT，守护进程 heartbeat 内消费 stop 后 request_stop() |
| TC-2-DOC | 按文档在新环境可复现 | 通过：README 含配置、启动命令、curl 示例 |

**R-C3**：本阶段未实现守护进程 flatten 逻辑；POST /control/flatten 向 daemon_control 表 INSERT 并返回 200，守护进程消费后打日志。

验收执行说明：在项目根目录启动 `python scripts/run_status_server.py`，使用 `curl http://localhost:8765/status`、`curl http://localhost:8765/operations?limit=10`、`curl -X POST http://localhost:8765/control/stop` 验证；需配置 `status.sink: postgres` 与 `status.postgres`，并已运行 `scripts/init_phase1_db.py` 创建 daemon_control 表；守护进程运行中验证 stop 生效。

---

## RE-7 验证步骤（守护程序不依赖 IB、黄灯、下次重试时间、自动/手动重试）

需求要点：守护程序**运行与否不依赖 IB 是否连接**；IB 不可用时**不退出**，进入 WAITING_IB 并周期重试；监控端显示**黄灯**（degraded）、**IB 连接状态**、**Client ID**、**下次重试时间**；支持自动重试与监控端「重试连接 IB」立即重试。

### 前置条件

- 已配置 `status.sink: postgres`、`status.postgres`，并执行过 `python scripts/init_phase1_db.py`（含 daemon_heartbeat 及 next_retry_ts 列）。
- 可选：`config/config.yaml` 中 `daemon.ib_retry_interval_sec: 30`（默认 30 秒）。

### 1. 单进程：不启动 TWS 时守护进程不退出、黄灯与下次重试时间

1. **不启动 TWS/IB Gateway**（确保 127.0.0.1:7497 无服务）。
2. 启动 status server：`python scripts/run_status_server.py config/config.yaml`。
3. 启动守护进程（单进程）：`python scripts/run_engine.py config/config.yaml`。
4. **预期**：
   - 进程**不退出**；日志出现 `state=CONNECTING | IB connect failed → WAITING_IB`，随后 `state=WAITING_IB | IB not connected; next retry at ...`。
5. 浏览器打开 `http://localhost:8765/`（或 `curl http://localhost:8765/status`）。
6. **预期**：
   - 守护程序区：**黄灯**（degraded），自检为「降级」，原因含「IB 未连接」；
   - 显示「IB: 未连接」及「**下次重试: &lt;时间&gt;（约 N 秒后）**」；
   - 出现「重试连接 IB」按钮。

### 2. 单进程：启动 TWS 后自动连上并变绿

1. 在 1 的基础上，保持守护进程与 status server 运行。
2. 启动 TWS（或 IB Gateway），并开启 API 设置（端口 7497，或与 config 中 `ib.port` 一致）。
3. 等待至**下次重试时间**（或点击「重试连接 IB」）。
4. **预期**：
   - 守护进程日志出现 `state=WAITING_IB → CONNECTED`，随后进入 RUNNING；
   - 监控页**守护程序区变绿**，显示「IB: 已连接 (Client ID 1)」，下次重试消失。

### 3. 单进程：运行中关闭 TWS → 黄灯与下次重试（若实现运行中断线检测）

若当前单进程在运行中断开 IB 后会进入 WAITING_IB 并写 next_retry_ts，则：

1. 守护进程 RUNNING、TWS 已连接。
2. 关闭 TWS（或断开端口）。
3. **预期**：守护进程检测到断线后进入 WAITING_IB，写心跳含 next_retry_ts；监控页黄灯、显示下次重试时间。

（若单进程尚未实现运行中断线→WAITING_IB，可仅验证 1、2、4、5。）

### 4. 监控端「重试连接 IB」立即重试

1. 处于「IB 未连接」、黄灯、有下次重试时间。
2. 先启动 TWS，再在监控页点击「**重试连接 IB**」（或 `curl -X POST http://localhost:8765/control/retry_ib`）。
3. **预期**：守护进程在下一轮轮询中消费 `retry_ib`，立即尝试连接；成功则变绿并显示 Client ID。

### 5. 守护进程 stop 仍可退出

1. 在 WAITING_IB 状态下，监控页点击「**停止守护程序**」（或 `curl -X POST http://localhost:8765/control/stop`）。
2. **预期**：守护进程消费 stop 后 request_stop()，优雅退出（STOPPING → STOPPED），进程结束。

### 6. 双进程（run_daemon.py）下 WAITING_IB 与 next_retry_ts

1. 不启动 TWS；启动 status server；启动稳定守护进程：`python scripts/run_daemon.py config/config.yaml`。
2. **预期**：守护进程不退出；日志显示连接失败与重试间隔；写 daemon_heartbeat（ib_connected=false，next_retry_ts 有值）。
3. 打开监控页：黄灯、「IB: 未连接」、下次重试时间、「重试连接 IB」按钮可见。
4. 启动 TWS 后等待或点击重试：应连上并变绿，显示 Client ID。

### 7. 数据库与 API

- `GET /status` 中 `daemon_heartbeat` 含 `ib_connected`、`ib_client_id`、`next_retry_ts`（未连接时 next_retry_ts 为 Unix 时间戳，已连接时可为 null）。
- `python scripts/check/phase1.py` 通过（含 daemon_heartbeat 表及 next_retry_ts 列）。
