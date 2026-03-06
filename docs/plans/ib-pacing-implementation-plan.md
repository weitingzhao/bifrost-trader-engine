# IB 市场数据边界配置与 Worker 用量计量 / 限流 — 实现方案

本文档描述：**将 IB 历史数据边界条件配置化**，以及 **Worker/API 侧用量计量、与边界比对、限流与监控** 的详细实现方案。  
边界定义来源：[IB_MARKET_DATA_BOUNDARIES.md](../IB_MARKET_DATA_BOUNDARIES.md)。

---

## 1. 目标与约束

- **边界条件进配置**：当前边界写在文档中，需改为项目内可配置（如 `config.yaml` 或 DB），便于按环境/账户调参。
- **用量可计量**：Celery Worker 与监控端 API 发起的每次 IB 历史请求均需被计量（10 分钟滑动窗口、同一请求 15 秒冷却等）。
- **用量与边界可比对**：发起请求前用当前用量与配置边界比对，超限则**等待/退避**，避免 Pacing Violation。
- **用量可监控**：监控端能查看当前用量、配置边界、是否接近/超限、下次可请求时间等。

**约束**：  
- API 与 Worker 为不同进程，需**共享用量状态**（Redis）。  
- 限流逻辑需落在**每次** `reqHistoricalDataAsync` 调用前/后（含 `get_historical_bars_range` 内的多段请求）。

---

## 2. 配置方案

### 2.1 配置存放位置与结构

- **主配置**：在 `config/config.yaml` 中新增 `ib.pacing` 段（与现有 `ib.host/port/client_id` 同级），字段与默认值如下。
- **可选**：后续若需“运行时可调、不重启生效”，可在 `settings` 表或 Redis 中存覆盖值，读取时优先用覆盖值。

建议结构（YAML）：

```yaml
# config/config.yaml
ib:
  host: "127.0.0.1"
  port: 7497
  client_id: 1
  connect_timeout: 60
  # IB 历史数据 Pacing 边界（见 docs/IB_MARKET_DATA_BOUNDARIES.md）
  pacing:
    # 10 分钟内最多请求次数（官方 60，建议略低以提高稳定性）
    max_requests_per_10min: 60
    # 相同请求（symbol+period+duration）最小间隔（秒）
    min_interval_identical_sec: 15
    # 同一 Contract+Exchange+TickType 2 秒内最多次数（官方 6）
    max_requests_per_2sec_per_contract: 6
    # 同时未完成请求数上限（官方 50；当前实现单连接顺序请求，可设 1 或略大）
    max_concurrent: 10
    # BID_ASK 类型计为 2 次；当前仅用 TRADES，可预留
    bid_ask_counts_as: 2
```

Step size（duration 与 bar size 合法组合）可作为**校验用配置**单独一段，用于发起请求前校验参数，避免违规：

```yaml
  # 可选：用于校验单次请求 duration/bar 组合（见 IB_MARKET_DATA_BOUNDARIES.md §2）
  # step_size:
  #   "1 min": ["1 D"]
  #   "5 mins": ["1 D", "1 W"]
  #   "1 hour": ["1 D", "1 W"]
  #   "1 day": ["1 D", "2 D", "1 W", "1 M", "1 Y"]
```

首版可实现仅 `pacing` 段；step size 仍由代码写死（如 `get_historical_bars_range` 内现有逻辑），后续再配置化。

### 2.2 默认值来源

- `max_requests_per_10min`: 60（官方）
- `min_interval_identical_sec`: 15（官方“相同请求 15 秒内不重复”）
- `max_requests_per_2sec_per_contract`: 6（官方）
- `max_concurrent`: 10 或 1（当前单连接顺序请求，保守取 1 亦可）
- `bid_ask_counts_as`: 2（官方，当前未用 BID_ASK 可保留默认）

### 2.3 配置读取

- 在 `servers/ib_pacing.py`（或 `src/connector/ib_pacing.py`）中通过现有 `read_config()` 读取 `config["ib"]["pacing"]`，缺省时使用上述默认值。
- Worker 与 API 均使用同一配置来源（项目 config + 可选 Redis/DB 覆盖），保证边界一致。

---

## 3. 计量方案

### 3.1 需计量的指标

| 指标 | 含义 | 用途 |
|------|------|------|
| 10 分钟滑动窗口请求数 | 过去 600 秒内发起的历史请求次数 | 与 `max_requests_per_10min` 比对，超限则等待 |
| 相同请求上次时间 | 按 (symbol, period, duration) 维度的上次请求时间 | 与 `min_interval_identical_sec` 比对，未满 15s 则等待 |
| （可选）2 秒内同 Contract 请求数 | 按 (symbol, exchange, tick_type) 的 2 秒内计数 | 与 `max_requests_per_2sec_per_contract` 比对 |
| （可选）当前未完成数 | 已发起未返回的请求数 | 与 `max_concurrent` 比对；当前单连接顺序请求可暂不实现 |

首版建议：**必做** 10 分钟窗口 + 相同请求 15 秒冷却；**可选** 2 秒/Contract、max_concurrent。

### 3.2 存储与进程共享

- **存储**：Redis，以便 API 多进程与 Celery Worker 共享同一用量视图。
- **Key 设计**（示例）：
  - `bifrost:ib_pacing:timestamps`：Sorted Set，member = 请求时间戳（或 “ts:uuid”），score = 时间戳（float）。用于 10 分钟窗口计数与剔除过期。
  - `bifrost:ib_pacing:last:{key}`：String，value = 最近一次请求时间戳；key = 规范化后的 `(symbol, period, duration)`，如 `NVDA|1 D|1 D`。TTL 设为 20 秒即可（超过 15s 冷却即可过期）。

**规范 key**：  
- 将 symbol/period/duration 统一为固定格式（如 period 统一为 `1 D` / `1 min` / `5 mins` / `1 hour`），再拼成字符串，避免同一逻辑请求多 key。

### 3.3 请求计数粒度

- **每次**调用 `reqHistoricalDataAsync` 计为 **1 次**（当前仅用 TRADES；若未来用 BID_ASK 则按配置 `bid_ask_counts_as` 计 2 次）。
- `get_historical_bars_range` 内多段 chunk 每段一次 `reqHistoricalDataAsync`，因此每段**前**检查并等待、**后**记录一次。

### 3.4 谁写入 / 谁读取

- **写入**：所有发起 IB 历史请求的路径——即 `IBConnector.get_historical_bars_async` 与 `IBConnector.get_historical_bars_range` 在“每次请求后”调用统一的 `record_request(symbol, period, duration)`。
- **读取**：同一模块在“每次请求前”调用 `wait_if_needed(symbol, period, duration)`，内部根据 Redis 当前数据与配置做等待。
- 这样 API（MarketIbClient）与 Worker（通过 MarketIbClient 调 connector）都会经同一套 pacing 逻辑，用量自然汇总。

---

## 4. 比对与限流

### 4.1 请求前：wait_if_needed(symbol, period, duration)

逻辑（建议顺序）：

1. **相同请求冷却**：查 Redis `bifrost:ib_pacing:last:{key}`；若存在且 `now - last_ts < min_interval_identical_sec`，则 `asyncio.sleep` 至 `last_ts + min_interval_identical_sec - now`。
2. **10 分钟窗口**：  
   - `ZREMRANGEBYSCORE bifrost:ib_pacing:timestamps -inf (now-600)` 剔除过期；  
   - `ZCARD` 得当前 count；  
   - 若 `count >= max_requests_per_10min`，则取最小 score（最早请求时间），`sleep` 至 `oldest_ts + 600 - now`，然后回到步骤 2 再查一次（防止多进程竞争）。
3. **（可选）2 秒/Contract**：若实现，则按 (symbol, exchange, tick_type) 查 2 秒内次数，超限则 sleep 到最早那次 + 2s 再重试。

实现为 **async**：`wait_if_needed_async`，内部用 `asyncio.sleep`，不阻塞事件循环。

### 4.2 请求后：record_request(symbol, period, duration)

- `ZADD bifrost:ib_pacing:timestamps {now} {now}`（或 member 用唯一 id 避免覆盖）。
- `SET bifrost:ib_pacing:last:{key} {now} EX 20`。
- （若实现 2 秒/Contract）更新对应 key 的计数或时间戳。

**注意**：若请求失败（异常），是否仍 `record_request`？建议**仍记录**，因为 IB 端仍会计入 pacing；否则会少计、导致实际超限。

### 4.3 退避策略

- 当前采用**固定等待**：等到“最早请求滚出 10 分钟”或“相同请求满 15 秒”再发起。
- 不在首版实现的扩展：指数退避、最大等待时间、取消任务等，可按后续需求再加。

---

## 5. 监控与可见性

### 5.1 用量与边界暴露接口

- **方式一**：在现有 `GET /status` 的 payload 中增加字段，例如 `ib_pacing_usage`，由 status 服务从 Redis 读取并计算（见下）。
- **方式二**：单独 `GET /bars/pacing` 或 `GET /monitor/ib_pacing`，返回更详细的 pacing 状态，供“数据/系统”页使用。

推荐：**两种都做**——`/status` 带简要字段（便于统一轮询）；`/bars/pacing` 返回完整结构，供前端“IB Pacing”卡片或 Data 页使用。

### 5.2 返回结构示例（get_usage）

```json
{
  "config": {
    "max_requests_per_10min": 60,
    "min_interval_identical_sec": 15,
    "max_requests_per_2sec_per_contract": 6,
    "max_concurrent": 10
  },
  "usage": {
    "requests_last_10min": 45,
    "oldest_request_ts": 1710000000.0,
    "next_request_allowed_ts": null,
    "throttled": false,
    "throttle_reason": null
  },
  "last_by_key": {
    "NVDA|1 D|1 D": 1710000100.0,
    "NVDA|1 min|1 D": 1710000080.0
  }
}
```

- `next_request_allowed_ts`：若因 10 分钟满而限流，则为 `oldest_request_ts + 600`；若因 15 秒冷却，则为对应 last_ts + 15。前端可显示 “Next request allowed in Xs”。
- `throttled`：当前是否处于“被限流”状态（即若立即发起会被 wait_if_needed 卡住）。
- `throttle_reason`: `"10min_limit"` | `"identical_cooldown"` | null。

### 5.3 谁提供 get_usage

- **无状态**：仅依赖 Redis 中已有 key，任何能连上同一 Redis 的进程都可计算。
- **实现**：在 `servers/ib_pacing.py` 中实现 `IbPacing.get_usage()`（或模块级 `get_usage(redis_url, config)`），内部读 Redis、做 ZREMRANGEBYSCORE + ZCARD、读 last_*，组装上述 JSON。
- **API 调用**：status 服务在 `GET /status` 和 `GET /bars/pacing` 中通过 `read_config()` 取 redis 与 `ib.pacing`，调用 `get_usage(...)` 填入响应。无需持有 MarketIbClient 或 Worker 引用。

### 5.4 前端展示

- **位置**：Data 页（或 DaemonMonitor 的“系统/Celery”区块）增加“IB Pacing”小卡片。
- **内容**：当前 10 分钟请求数 / 上限、是否 throttled、下次可请求剩余秒数（由 `next_request_allowed_ts - now` 计算）；可选展示 `last_by_key` 最近几条。
- **刷新**：与现有 status 轮询一致（如每 5–10 秒），或随 GET /status 一并拉取。

---

## 6. 与现有代码的衔接

### 6.1 新增模块

- **`servers/ib_pacing.py`**（推荐，与 `ib_clients.py` 同层）  
  - 类 `IbPacing`：  
    - `__init__(self, redis_url: str, config: dict)`  
    - `async def wait_if_needed_async(self, symbol: str, period: str, duration: str) -> None`  
    - `def record_request(self, symbol: str, period: str, duration: str) -> None`（若用 redis 的异步客户端则可改为 async）  
    - `def get_usage(self) -> dict`  
  - 内部使用 Redis Sorted Set + String，键名如上；配置从 `config["ib"]["pacing"]` 读，缺省用文档默认值。

若希望 connector 层不依赖 servers，可把“接口”放在 `src/connector/ib_pacing.py`（仅定义协议/抽象），实现在 `servers/ib_pacing.py`；connector 只接受 duck-typed 对象（有 `wait_if_needed_async`、`record_request`、可选 `get_usage`）。

### 6.2 IBConnector（src/connector/ib.py）

- **可选参数**：`get_historical_bars_async(..., pacing=None)`、`get_historical_bars_range(..., pacing=None)`。
- 当 `pacing` 非 None 时：  
  - 在**每次** `reqHistoricalDataAsync` **前**：`await pacing.wait_if_needed_async(symbol, period, duration_str)`；  
  - **后**：`pacing.record_request(symbol, period, duration_str)`。  
- `get_historical_bars_range` 的循环内，每段 chunk 的 duration 已知（如 `1 D`/`1 W`/`1 Y`），symbol/period 已知，直接传入即可。

这样无需改动 connector 的 chunk 逻辑，仅增加两处钩子。

### 6.3 MarketIbClient（servers/ib_clients.py）

- **构造**：`MarketIbClient(..., pacing: Optional[IbPacing] = None)`，保存为 `self._pacing`。
- **ensure_connected**：创建 `IBConnector` 时暂不传 pacing（connector 本身不持 pacing 引用）；在 **fetch_bars / fetch_bars_range** 调用 connector 时传入 `pacing=self._pacing`。
- 即：  
  - `fetch_bars` 单次请求：调用前 `wait_if_needed_async`，调用后 `record_request`（若由 connector 内做，则需把 pacing 传给 connector；见下）。  
  - `fetch_bars_range`：connector 内多段，每段前/后由 connector 调 pacing，因此需把 pacing 传入 connector。

**统一做法**：在 connector 的 `get_historical_bars_async` 与 `get_historical_bars_range` 增加参数 `pacing=None`，在 connector 内“每次 reqHistoricalDataAsync 前后”调用 pacing；MarketIbClient 在调用这两个方法时传入 `self._pacing`。这样 API 与 Worker 只要创建 MarketIbClient 时带上同一个 Redis 的 IbPacing 即可共享用量。

### 6.4 API 与 Worker 创建 IbPacing / MarketIbClient

- **API（app.py startup）**：  
  - 从 config 读 `redis` 与 `ib.pacing`；  
  - 若 Redis 可用，则 `app.state.ib_pacing = IbPacing(redis_url, config)`，否则 `app.state.ib_pacing = None`；  
  - `MarketIbClient(..., pacing=app.state.ib_pacing)`。  
- **Worker（bars_tasks.py）**：  
  - 使用同一 config 与同一 Redis（`broker_url` 或 config.redis）；  
  - 在 `_get_or_create_worker_ib_client` 中创建 `IbPacing(broker_url, config)`（或从模块级单例获取），再 `MarketIbClient(..., pacing=pacing)`。  
- 这样两边的请求都会写入/读取同一批 Redis key，用量一致、限流一致。

### 6.5 GET /status 与 GET /bars/pacing

- 在 `servers/app.py` 中：  
  - `GET /status`：若 `app.state.ib_pacing` 存在，则 `payload["ib_pacing_usage"] = app.state.ib_pacing.get_usage()`，否则不填或填 `null`。  
  - 新增 `GET /bars/pacing`：返回 `app.state.ib_pacing.get_usage()` 或 无 pacing 时的说明。

### 6.6 前端

- `frontend/src/types.ts`：为 status 或 bars/pacing 增加 `ib_pacing_usage` 或单独类型（如 `IbPacingUsage`）。  
- Data 页或 DaemonMonitor：从 GET /status 或 GET /bars/pacing 取数，展示“10 分钟用量/上限”“是否限流”“下次可请求 Xs”。

---

## 7. 分步实现建议

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | 配置：在 config.yaml.example 与文档中增加 `ib.pacing` 段及默认值；代码中 `read_config()` 能读到并向下传递 | 配置可生效、默认值与文档一致 |
| 2 | 计量与存储：实现 `servers/ib_pacing.py`（Redis 10min 窗口 + last_identical），实现 `wait_if_needed_async`、`record_request`、`get_usage` | 单进程或双进程测试可验证写入/读取一致 |
| 3 | 限流接入：IBConnector 两处方法增加 `pacing` 参数，每次请求前后调用 pacing；MarketIbClient 与 API/Worker 创建时传入 IbPacing | 实际请求会先 wait、再 record，与边界一致 |
| 4 | 监控：GET /status 与 GET /bars/pacing 返回 get_usage()；前端“IB Pacing”卡片展示用量与限流状态 | 使用量可被监控 |
| 5 | （可选）2 秒/Contract、max_concurrent、step_size 配置化 | 更贴近官方全部边界 |

步骤 1–4 即可满足“边界配置化 + 用量计量 + 比对与限流 + 可监控”；步骤 5 可按需要后续迭代。

---

## 8. 与文档的对应

- 边界定义与官方出处仍以 [IB_MARKET_DATA_BOUNDARIES.md](../IB_MARKET_DATA_BOUNDARIES.md) 为准。  
- 本文档为**实现方案**：配置项、Redis 设计、接口、与现有组件的衔接及分步实施顺序。  
- 若在 `IB_MARKET_DATA_BOUNDARIES.md` 末尾增加“实现”小节，可写：“配置与限流实现见 [plans/ib-pacing-implementation-plan.md](plans/ib-pacing-implementation-plan.md)。”

以上为完整实现方案，可直接按步骤落地开发与联调。
