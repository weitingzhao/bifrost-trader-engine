# Celery Worker IB Connection 实现说明

## 目标

- Worker（bars backfill）使用 **Settings → Worker IB Client ID** 建立并保持一条 IB 连接，与 Monitor/Daemon 类似。
- 监控页 Celery → IB connection 可显示 **Worker Client: Connected @ xxx** 或 **Not connected**。
- Worker 启动后会**自动尝试建连**，若启动时失败则会继续**自动重试**；不再提供前端 **Connect** 按钮，也不再通过 API 手动触发。

## 数据流（自动模式）

### 1. Worker 启动后自动准备建连

### 2. Worker 轮询并建连

- **位置**：`servers/bars_tasks.py`。
- **何时启动轮询**：Celery 的 **worker_process_init** 信号在**每个 worker 子进程**初始化时触发 → `_connect_ib_at_startup()` → …  
  **重要**：必须用 **`--concurrency=1`** 启动 Worker（`run_celery.py` 已默认带上）。若多进程，每个进程都会用同一 IB client_id 建连，只有第一个会成功，其余报 “client id is already in use”。
- **轮询逻辑**（`_worker_connect_poll_loop`）：
  - 首次会先等待约 **3 秒**，给 TWS / DB 一点准备时间；
  - 若当前**未连接**：用 `StatusReader(status_cfg).get_ib_config()` 取 Settings 中的 Worker IB 配置，调用 `_get_or_create_worker_ib_client(ib_cfg)` 建连；
  - 若启动时建连失败：之后会按固定周期继续**自动重试**；
  - 建连成功后：`_write_worker_ib_status(True, client_id)` 写 Redis key `bifrost:worker_ib_status`（TTL 90s），供 GET /status 使用。
- **前提**：**Celery Worker 进程已启动**（例如 `python scripts/run_celery.py`）。若 Worker 未运行，界面会一直显示 Not connected。

## GET /status 如何显示 Worker Client

- **位置**：`servers/app.py` → GET /status。
- **逻辑**：调用 `servers.celery_app.get_worker_ib_status()`，从 Redis 读 `bifrost:worker_ib_status`；若存在且 `connected==true`，则返回 `celery_worker_ib_connected=True`、`celery_worker_ib_client_id=<id>`。
- **前端**：`DaemonMonitorPage` 用 `j?.celery_worker_ib_connected`、`j?.celery_worker_ib_client_id` 显示 “Worker Client: Connected @ xxx” 或 “Not connected”。

## 未连接时的常见原因

1. **Worker 未运行**  
   没有进程轮询并建连，也不会写 `worker_ib_status`，所以界面一直是 Not connected。  
   **处理**：先启动 `python scripts/run_celery.py`。

2. **Worker 连不上 IB**  
   Worker 已自动尝试建连，但 TWS/Gateway 未开或配置错误。  
   **处理**：看 Worker 终端/日志是否有建连失败信息；确认 Settings 中 IB 与 Worker Client ID 正确，且 TWS 允许该 client_id。

3. **Error 326: client id is already in use**  
   Worker 用了多进程（未加 `--concurrency=1`），每个子进程都用同一 client_id 连 IB，只有第一个成功，其余被 TWS 拒绝。  
   **处理**：用 `python scripts/run_celery.py` 启动（脚本已带 `--concurrency=1`）；若手动跑 celery，请加：`celery -A servers.celery_app worker -l info -Q bars --concurrency=1`。

4. **Redis 中残留旧状态**  
   若 Redis 里残留了过期前的 `worker_ib_status`，界面短时间内可能仍显示已连接。  
   **处理**：等 90 秒让 key 过期，或重启 Worker 并确认未写回错误状态。

## 小结

| 步骤           | 位置           | 作用                         |
|----------------|----------------|------------------------------|
| Worker 启动    | `run_celery.py` / Celery 初始化 | 启动 loop 并安排建连 |
| 自动重试建连   | `bars_tasks.py`  | Worker 子进程自动检查并建连 |
| 写 worker 状态 | bars_tasks.py  | 建连后写 worker_ib_status         |
| 读状态         | GET /status    | 返回 celery_worker_ib_connected 等 |
| 显示           | 前端           | Worker Client: Connected @ xxx   |

**必要条件**：Celery Worker 已启动、Redis 可用；Worker 启动后会自动尝试建连，成功时界面会变为 Connected。
