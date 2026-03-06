# Celery Worker IB Connection 实现说明

## 目标

- Worker（bars backfill）使用 **Settings → Worker IB Client ID** 建立并保持一条 IB 连接，与 Monitor/Daemon 类似。
- 监控页 Celery → IB connection 可显示 **Worker Client: Connected @ xxx** 或 **Not connected**，并可通过 **Connect** 按钮请求 Worker 建连。

## 数据流（三步）

### 1. 前端点击 Connect

- **位置**：`frontend/src/pages/DaemonMonitorPage.tsx`  
  Celery 标签 → IB connection 区块 → 按钮 `Connect`（未连接时可点）。
- **逻辑**：`onCeleryConnect()` → `postCeleryConnect()` → **POST /control/celery_connect**（无 body）。
- **预期**：请求发出后先显示 “Requesting Worker IB connection…”，收到 200 后显示 “Worker connect requested; status will update in a few seconds.”，并刷新一次 status；若失败则显示错误信息。

### 2. API 写 Redis

- **位置**：`servers/app.py` → `POST /control/celery_connect`。
- **逻辑**：从 `servers.celery_app` 取 `broker_url`、`WORKER_CONNECT_REQUESTED_KEY`（`bifrost:worker_connect_requested`），用 `redis.from_url(broker_url)` 连接 Redis，执行 `r.setex(WORKER_CONNECT_REQUESTED_KEY, 120, "1")`（TTL 120 秒）。
- **前提**：API 与 Worker 使用同一 Redis（同一 `config.redis` / `broker_url`），且 API 能连上 Redis。不依赖 `control_via_db`。

### 3. Worker 轮询并建连

- **位置**：`servers/bars_tasks.py`。
- **何时启动轮询**：Celery 的 **worker_process_init** 信号在**每个 worker 子进程**初始化时触发 → `_connect_ib_at_startup()` → …  
  **重要**：必须用 **`--concurrency=1`** 启动 Worker（`run_celery.py` 已默认带上）。若多进程，每个进程都会用同一 IB client_id 建连，只有第一个会成功，其余报 “client id is already in use”。
- **轮询逻辑**（`_worker_connect_poll_loop`）：
  - 每 **5 秒**：读 Redis `WORKER_CONNECT_REQUESTED_KEY`；
  - 若存在且当前**未连接**：删 key，用 `StatusReader(status_cfg).get_ib_config()` 取 Settings 中的 Worker IB 配置，调用 `_get_or_create_worker_ib_client(ib_cfg)` 建连；
  - 建连成功后：`_write_worker_ib_status(True, client_id)` 写 Redis key `bifrost:worker_ib_status`（TTL 90s），供 GET /status 使用。
- **前提**：**Celery Worker 进程已启动**（例如 `python scripts/run_celery.py`）。若 Worker 未跑，点击 Connect 只会写入 `worker_connect_requested`，没有进程会消费它，界面会一直显示 Not connected。

## GET /status 如何显示 Worker Client

- **位置**：`servers/app.py` → GET /status。
- **逻辑**：调用 `servers.celery_app.get_worker_ib_status()`，从 Redis 读 `bifrost:worker_ib_status`；若存在且 `connected==true`，则返回 `celery_worker_ib_connected=True`、`celery_worker_ib_client_id=<id>`。
- **前端**：`DaemonMonitorPage` 用 `j?.celery_worker_ib_connected`、`j?.celery_worker_ib_client_id` 显示 “Worker Client: Connected @ xxx” 或 “Not connected”。

## 点击 Connect “没有反应” 的常见原因

1. **Worker 未运行**  
   只有 API 写 Redis，没有进程轮询并建连，也不会写 `worker_ib_status`，所以界面一直是 Not connected。  
   **处理**：先启动 `python scripts/run_celery.py`，再点 Connect。

2. **前端未发请求或报错**  
   例如网络/代理问题、CORS、或接口 5xx。  
   **处理**：打开浏览器开发者工具 → Network，点 Connect 看是否有 **POST /control/celery_connect**，以及状态码和响应 body；同时看 Console 是否有报错。

3. **API 写 Redis 失败**  
   例如 Redis 未起、`broker_url` 与 Worker 不一致、或权限问题。  
   **处理**：看 API 日志是否有 `celery_connect failed: ...`；确认 `config.redis` 与 Celery 使用同一 Redis。

4. **Worker 连不上 IB**  
   Worker 已收到 key 并尝试建连，但 TWS/Gateway 未开或配置错误。  
   **处理**：看 Worker 终端/日志是否有 `Worker connect (UI requested) failed: ...`；确认 Settings 中 IB 与 Worker Client ID 正确，且 TWS 允许该 client_id。

5. **Error 326: client id is already in use**  
   Worker 用了多进程（未加 `--concurrency=1`），每个子进程都用同一 client_id 连 IB，只有第一个成功，其余被 TWS 拒绝。  
   **处理**：用 `python scripts/run_celery.py` 启动（脚本已带 `--concurrency=1`）；若手动跑 celery，请加：`celery -A servers.celery_app worker -l info -Q bars --concurrency=1`。

6. **Connect 按钮被禁用**    
   当 `celery_worker_ib_connected === true` 时按钮会 disabled。若 Redis 里残留了过期的 `worker_ib_status`，可能仍被当成已连接。  
   **处理**：等 90 秒让 key 过期，或重启 Worker 并确认未写回错误状态。

## 小结

| 步骤           | 位置           | 作用                         |
|----------------|----------------|------------------------------|
| 点击 Connect   | 前端 DaemonMonitorPage | 调用 POST /control/celery_connect |
| 写 Redis       | app.py         | 设置 worker_connect_requested    |
| 轮询 + 建连    | bars_tasks.py  | Worker 子进程内每 5s 检查并建连   |
| 写 worker 状态 | bars_tasks.py  | 建连后写 worker_ib_status         |
| 读状态         | GET /status    | 返回 celery_worker_ib_connected 等 |
| 显示           | 前端           | Worker Client: Connected @ xxx   |

**必要条件**：Celery Worker 已启动、Redis 可用、API 与 Worker 使用同一 Redis；Connect 后约 5–10 秒内轮询到并建连成功时，界面会变为 Connected。
