# 系统架构设计

本文档基于 **产品需求**（[REQUIREMENTS.md](REQUIREMENTS.md)）做全盘系统架构设计，作为实现与评审的单一参考。**运行环境与部署约束**（两台 Mac Mini 独占 TWS、双 IB 账户、Prod Linux 全栈 + Dev 本机、PostgreSQL Dev/Prod 隔离、监控与交易逻辑解耦等）在本文档 §2；**IB Ingestor / IB Account Agent / IB Operator 与 Engine 边界**见 **§2.11**，与需求 **R-IB1～R-IB4** 对应。FSM、状态空间、配置分类等细节见文档索引，此处只做映射与总览。

---

## 1. 架构定位与文档关系

| 文档 | 角色 |
|------|------|
| **REQUIREMENTS.md** | 产品功能需求唯一定义：监控、控制、历史、回测、交易基础等（R-M*/R-C*/R-H*/R-B*/R-A*、**R-IB***）；环境与部署约束（R-DV*）。 |
| **本文档 (ARCHITECTURE.md)** | 系统级架构：**运行环境与部署约束**（§2）、三大组成部分、**HTTP 服务拆分（backend/*，§4.0）**、组件划分、数据流、部署视图、需求→组件→阶段映射。 |
| **CAPABILITY_TRACKING.md** | 能力维度拆解与当前进度（木桶原理）。 |
| **research/STATE_SPACE_MAPPING.md**、**FSM_LINKAGE.md**、**research/CONFIG_SAFETY_TAXONOMY.md** | 状态空间、FSM、配置安全边界等专项，此处不重复。 |

---

## 2. 运行环境与部署约束

以下为**运行环境与约束**的唯一定义；产品功能需求不因运行环境不同而改变，见 [REQUIREMENTS.md](REQUIREMENTS.md)。

### 2.1 IB / TWS 与账户（RE-1）

- **数据与下单**：均通过 IB API 来自 **TWS**（Trader Workstation）。
- **TWS 主机**：**两台 Mac Mini**，各运行一套 TWS（或 IB Gateway）；分别承载 **Host 账户** 与 **Secondary 账户**（见需求 R-A4）。两台 Mac Mini 均在局域网内，供 **IB 边缘服务**（Ingestor、Account Agent、Operator 等）与监控端经 IB API 连接。
- **账户**：**两个 IB 账户**（见需求 R-A4）。
  - **Host 账户**：**目标架构（R-IB1～R-IB4，[REQUIREMENTS.md](REQUIREMENTS.md) §3.6）**：**行情类订阅**由 **IB Ingestor**（Watchlist + 按需 `reqMktData`）写 **Redis**；**账户域事件**（持仓、挂单、成交、commission 等）由 **IB Account Agent** 写 **Redis**；**自动下单**由 **IB Operator** 经主动 API 执行；**Engine（Daemon）不直连 TWS**，从 Redis 读行情与账户态势，将账户类数据**写入 PostgreSQL**，对冲指令经 **Operator RPC**。**迁移中**的实现可仍含守护进程内 `IBConnector`，以代码为准。由 settings 表 `host_account_id`（列名 `ib_host_account_id`）指定，未配置时取 TWS 返回的 managed accounts 中第一个。**各进程 `client_id` 在 `config.yaml`（单一真源）** 区分 Ingestor / Agent / Operator / 其他；`host_account_id` 等仍在 PostgreSQL settings 表。
  - **第二账户**：**仅手动交易**；Daemon 不对其自动下单。账户与持仓纳入 Portfolio 时，由 Account Agent（及监控拉取路径）按配置覆盖；若在**另一 TWS 或另一登录**下，则通过监控端或独立服务的**第二 IB 连接**拉取后写入同一库（当前计划仅文档预留，不实现第二连接）。
- **实现方式**：TWS 允许多个 API 连接，用不同的 **client_id** 区分。Ingestor、Account Agent、Operator、Celery、监控端 Account/Market 各用不同 `client_id`（见配置注释）。
- **Dev/Prod 与 TWS 共享**（R-DV3）：两台 Mac Mini 上的 TWS 为 Dev 与 Prod **共享基础设施**。Dev 与 Prod 通过 **不同 `client_id` 与/或不同 TWS socket 端口** 区分连接。**同一 IB 账户同一时刻仅允许一个自动交易 Engine 对该账户下单**，避免双环境双 Engine 实盘冲突。

### 2.2 架构支柱（RE-2）

系统由三部分组成，缺一不可（详见下文 §3）：

| 组成部分 | 说明 |
|----------|------|
| **自动交易** | 以 **单进程、单线程**（单一 asyncio 事件循环）的 **守护程序** 实现；负责 StateClassifier、FSM、Guard、编排与写状态。**目标架构**：不直连 TWS；行情/账户来自 Redis；下单经 IB Operator RPC（见 §2.11）。 |
| **监控与控制** | 与守护程序 **物理解耦**；状态的读取、控制指令的发送由 **独立应用** 完成。 |
| **基于回测的策略优化与安全边界验证** | 历史回放驱动同一套 StateClassifier、FSM、Guard 逻辑，**不连 TWS、不下真实单**；首要用于策略 PnL 优化，兼做 Guard 验证（见 REQUIREMENTS.md §4）。 |

### 2.3 部署与运行位置（RE-3、RE-4）

受 IB 限制，**TWS（或 IB Gateway）运行在两台专用 Mac Mini 上**（分别承载 Host 与 Secondary 账户，见 §2.1），仅承担 TWS 与手动交易入口角色。操作者通过远程桌面登录 Mac Mini 进行手动交易。**守护程序**可在以下两种位置之一运行；**目标架构**下行情与账户经 **Redis**（Ingestor / Account Agent），下单经 **IB Operator**；**迁移中**仍可为经 IB API 直连 TWS：

| 方案 | TWS 所在 | 守护程序所在 | 说明 |
|------|----------|--------------|------|
| **A. Mac Mini 同机** | 专用 Mac Mini | **同一台 Mac Mini** | 守护程序与 TWS 同机，经本机 API 连接 TWS；部署简单，延迟最低。 |
| **B. Linux 服务器（当前选定）** | 两台 Mac Mini（仅 TWS） | **局域网 Linux 服务器（如 192.168.10.70）** | 守护程序在 Linux 上运行；**目标架构**下边缘服务经**网络**连接 TWS，Engine 消费 Redis 并经 Operator 下单。**生产环境**（Prod）采用此方案。 |

- **TWS 主机（Mac Mini ×2）**：仅运行 TWS（或 IB Gateway）；不强制要求本机再跑守护程序。用户通过远程桌面在 Mac Mini 上进行手动交易，与自动交易共享同一账户（不同 client_id）。
- **守护程序主机**：可为上述 Mac Mini（方案 A），或局域网内另一台 Linux 服务器（方案 B）；仅运行 `run_engine.py` 单进程，连接 TWS、执行对冲逻辑、写状态与心跳。**当前 Prod 采用方案 B**。
- **监控范围（RE-4）**：仅操作者本人、**家庭/办公室局域网**；不要求公网或手机。

### 2.4 监控服务与交易服务分离（RE-5）

**架构原则**：监控服务（status server）与守护进程**逻辑解耦**——它们是独立进程，仅通过 PostgreSQL 通信；无论部署在同机还是不同机器上均成立。

**当前选定拓扑**：Prod 在 **Linux 服务器（192.168.10.70）** 上 **同机部署** Engine、Server、Redis、Celery（进程级分离）。**可选变体**：监控机与守护程序主机物理分离（如 status server 在开发机 / 另一台笔记本），只需能连同一 PostgreSQL。

- **TWS 主机（Mac Mini ×2）**：仅运行 TWS；用户远程登录该机进行手动交易。
- **守护程序主机**：运行 `run_engine.py`，执行对冲、写状态与心跳；**目标架构**下不直连 TWS；可为 Mac Mini（与 TWS 同机）或 Linux 服务器。
- **监控服务**：与守护进程**逻辑解耦**（独立进程）；控制通道采用 **PostgreSQL 表 `daemon_control`**（见 [DATABASE.md](DATABASE.md) §2.4）。跨机与同机均只需能连**同一 PostgreSQL**。
- **启停**：监控端 POST /control/stop → 写 DB → 守护进程轮询消费后退出；**启动**须在**守护程序主机**上执行 `run_engine.py`（SSH/systemd/手动）。

### 2.5 守护程序主机单进程（RE-6）

**守护程序主机**（即运行 `run_engine.py` 的那台机器：Mac Mini 或 Linux 服务器）上仅运行 **单进程**（`run_engine.py`）：同一进程连接 TWS、执行对冲逻辑、轮询 `daemon_control` 与 `daemon_run_status`，并写心跳与状态。升级对冲逻辑需重启整个进程。

### 2.6 守护程序与 IB 连接（RE-7）

**核心原则**：**守护程序本身的运行与否不依赖 IB 是否可连接**。IB 不可用时守护程序仍保持运行，仅“启动/执行对冲”的条件不满足；监控端显示**黄灯**（degraded），而非红/退出。

**目标架构补充（R-IB4）**：Daemon **不持有** IB API 会话；**降级**可包含：Redis 中**行情/账户数据过期或不可用**、**IB Operator RPC** 不可达、或边缘服务（Ingestor / Account Agent）不健康。`WAITING_IB` 等状态在迁移后可专指「执行路径不具备」（例如无法完成 Operator 下单），或与「数据未就绪」合并为文档化的自检 **degraded** 条件——以实现为准。

**要求**：
- **运行不依赖 IB**：守护程序**不得**因“IB 连接失败”而退出。启动时若无法连接 IB，应进入 WAITING_IB 等状态，持续写心跳、轮询控制，并**按配置间隔周期重试**连接 IB。（**目标架构**下重试对象可为 **Operator 可用性** 或 **Redis 数据新鲜度**，而非进程内 `ib.connect`。）
- **不预先假设 IB 已运行**：不得无限阻塞；采用带超时的连接尝试。
- **未连接时监控为黄灯**：守护进程存活但 IB 未连接时，自检结论为 **degraded**（黄灯）。
- **连接状态可观测**：监控端须展示守护程序是否与 IB 连接及连接成功时的 **Client ID**；未连接时展示**下次计划重试时间**（如 `next_retry_ts`）。
- **自动重试与可选手动重试**：到点自动重试；监控端可选提供「重试连接 IB」按钮，通过 `daemon_control` 写入 `retry_ib`。

### 2.7 非实时市场数据拉取与 Worker（R-A3 扩展）

**原则**：**非实时要求的市场数据拉取**（如 K 线 backfill、历史补全）**不在 API 进程内同步执行**，而是通过**任务队列 + 独立 Worker 进程**在后台执行，以保证 API 响应不受拉取耗时与 IB 限速影响，且与守护程序、监控服务进程隔离。

**要求**：
- **队列**：拉取任务（如 backfill 请求）写入**队列**；当前实现采用 **Celery + Redis**（broker 与 result backend 使用同一 Redis，与实时行情可选共用实例、不同 db）；任务行仍写入 **job_bars_backfill** 表（job_id 即 Celery task_id），便于 GET /bars/jobs 与前端轮询。
- **独立 Worker 进程**：单独进程从队列取任务并执行拉取（如调用 IB 历史数据接口、写 stock_day/stock_min）；**与 status server（API）进程、守护进程分离**，可部署于同一主机或不同主机，只需能连同一 PostgreSQL（及 Redis）与 IB（若 Worker 直连 TWS）。启动方式：`python scripts/run_celery.py` 或 `celery -A src.workers.celery_app worker -l info -Q bars --concurrency=1`（必须单进程，否则多进程会争用同一 IB client_id）。
- **API 行为**：监控/数据 API 收到 backfill 等请求时**仅入队并返回 job_id**；客户端通过 **GET /bars/jobs/{job_id}**（或等效）轮询任务状态与结果；任务完成后可刷新 coverage/列表。
- **限速与串行**：Worker 串行处理任务并在任务间留间隔（如 2s），以符合 IB 官方历史数据 Pacing 限制。

### 2.8 开发与生产环境（RE-8，R-DV1/R-DV2）

Dev 与 Prod 在 **PostgreSQL 层面逻辑隔离**：同一 PostgreSQL 服务器（如 192.168.10.80）上使用**不同 `database` 名**（如 `bifrost_dev` / `bifrost_prod`）；或独立实例。各进程仅连接**本环境**配置的数据库，settings、控制通道、业务数据**不跨环境混用**。

| 环境 | 运行栈 | 数据库 | TWS 连接 |
|------|--------|--------|----------|
| **Prod** | **Linux 服务器（192.168.10.70）**：Engine + Server + Redis + Celery | **Prod DB**（192.168.10.80 上独立 database） | 经 IB API 连接两台 Mac Mini 上的 TWS（Prod client_id） |
| **Dev** | **开发机（Mac）**：Engine（可选）、Server、Redis、Celery | **Dev DB**（192.168.10.80 上独立 database） | 经 IB API 连接同一两台 Mac Mini（Dev client_id，与 Prod 互斥） |

**调试 / 开发推荐拓扑（单 TWS 套接字、唯一 Redis 行情）**：**目标架构**下由 **IB Ingestor**（`run_ib_ingestor.py`）持有行情类 IB 连接，向 **唯一** Redis 写入 `ib:ingester:tick:*` 并在 **`ib:ingester:channel`** 上 `PUBLISH`；**IB Account Agent**（独立进程，实现与 systemd 名待定，如 `bifrost-ib-account-agent.service`）写入**另一 Redis 命名空间**（拟议 `ib:account:*`，以设计为准）。**Dev 与 Prod 两套 UI** 各自后端的 **Market API** 将 `redis.host` / `redis.port` / `redis.db`（及可选 `redis.subscribe_channel`，默认 `ib:ingester:channel`）指向**同一** Redis，使两端 SSE 订阅**同一** ingestor 发布流。Daemon **不写** `ib:ingester:tick:*` 唯一真源；仍可写入 `quote:{symbol}` 等派生键（供轮询等路径，迁移期兼容）；**不再**使用 `daemon:quotes` 频道推送。**不改变**以下纪律：**PostgreSQL** 仍按上表各连各库（R-DV1）；**同一 IB 账户仅一处 Engine 自动下单**（R-DV3）。若 Celery broker 与实时行情共用 Redis 实例，须用 **不同 `redis.db` 索引** 区分 broker/result 与行情缓存，避免与 §2.7「队列与行情可选共用实例、不同 db」冲突。

**约束**：
- 数据库**迁移（schema migration）、种子数据、备份**按环境独立执行；**禁止**将 Dev 的破坏性操作（清表、重建等）默认指向 Prod。
- 配置文件按环境维护：`config/config.dev.yaml`（默认）与 `config/config.prod.yaml`（均不提交仓库；模板为 `config/config.dev.yaml.example`、`config/config.prod.yaml.example`，复制后填写）。通过 `BIFROST_CONFIG`、`BIFROST_ENV=dev|prod`、或启动参数 `--prod` / `--env prod` / 首个路径参数选择。至少 `postgres.database`、IB 各 `client_id`（`ib.host.client_id` / 可选 `ib.secondary.client_id`）（及必要时 `postgres.host`/`redis.host`）不同。
- **配置合并**：若存在 **`config/config.yaml`**，在解析到 `config.dev.yaml` / `config.prod.yaml` 时，会先读入 `config.yaml` 再与环境文件做**深度合并**（环境文件覆盖同名键）。合并后的整表供 Engine / Server / Celery 使用。**Status Server**（`run_server.py`）在默认情况下要求合并结果中含**合法 `ib:`**（与监控端 IB 能力一致）；仅 **Management 专用**时可设 `server.skip_monitor_ib: true` 以跳过 IB 校验与监控端 IB 客户端初始化（见 §2.9）。
- **TWS 共享纪律**：见 §2.1「Dev/Prod 与 TWS 共享」——同一 IB 账户同一时刻仅允许一个自动交易 Engine 下单。

### 2.9 Management 专用部署（无后台写库）

当一台主机**仅作为 Management / 前端测试**（如本地 Mac 开发机）而不运行 Engine 时，遵循以下约定：

- **不运行 Celery**（`scripts/run_celery.py`）：bars worker 会通过 IB 拉取数据并写 `stock_*` 等业务表，Management 主机不应有此行为。
- **不运行 Engine**（`scripts/run_engine.py`）：守护进程连接 IB 下单/写心跳，仅在 Prod（或 Dev 调试时临时）主机运行。
- **仅运行 Monitor API + Frontend**：`run_server.py` + `run_frontend.sh`（若 UI 调用其他域接口，需另起对应 `run_server_*.py`），依赖 Daemon 写入 PostgreSQL 与 Redis 的数据；前端通过 SSE 消费 Redis 行情。
- **Redis 地址**：若 Management 主机需要读取另一台（如 192.168.10.70）上 Daemon 写入的行情，将 `redis.host` 指向该服务器 IP。
- **可选**：`server.skip_monitor_ib: true`（config 中），启用后 `run_server.py` **不**校验 YAML 中的 `ib` 段，且 `startup_event` 不初始化 `AccountIbClient` / `MarketIbClient`，避免 Management 机器连接 IB。正常运行 Status Server（与 Engine 同栈或需监控 IB）时应提供完整 `ib:`，勿依赖此项。

### 2.10 外部研究数据源：Massive / Polygon（R-A6）

**定位**：**Massive（Polygon）** 为期权研究与发现（R-OD1、R-A6）的**主力数据源**，通过 HTTPS REST 与 WebSocket 获取延迟期权数据。**与 IB/TWS 完全独立**——不占用 `client_id`，不经过 Mac Mini，不受 IB Pacing 限制。

**配置**（`config.yaml` 或环境变量）：
- `massive.api_key`（或 `MASSIVE_API_KEY`）：API 密钥，不入库、不暴露给前端。
- `massive.tier`：`starter` | `developer`（默认 `starter`），驱动 feature flag。
- `massive.features.trades_enabled`：布尔，`developer` 时可设 true，启用 Trades 写入与 API。
- 可选 `massive.rest_base`、`massive.ws_url`（默认取官方 endpoint）。

**进程划分**：
- **REST 入队类任务**（历史聚合回填、日终 OI 拉取、批量快照等）：与现有 `job_bars_backfill` 模式一致，新增 **`job_massive_backfill`** 任务表，由 **Celery Worker**（独立 queue `massive`）串行执行拉取与落库。**与 IB bars queue 分离**——两个 Worker 可独立扩缩容，互不影响限速策略。
- **WebSocket 长连接**（延迟 quote/snapshot 流）：**不宜**放在短生命周期 Celery task 内。采用 **独立 asyncio 长驻进程**（如 `scripts/run_massive_ws.py`）或 Status Server 内**受控后台任务**，消费 Massive WS → 写 Redis（最新报价 ring）+ 可选 PG 抽样 → 经现有 SSE 或应用层 WebSocket 推前端。**Starter** 仅开延迟 quote/snapshot 通道；**Developer** 增开 trades 通道（与 REST 同 feature flag）。
- **前端不直连 Massive**（密钥保护与 CORS），所有数据通过后端落库或代理。

**延迟边界**：Massive Starter 数据**延迟 15 分钟**。全链路标注 **15m delay**，与守护进程实时 IB 行情严格区分。**禁止**将 Massive 数据作为 ExecutionGuard 或自动下单决策的输入——仅 IB 实盘行情可进入交易决策链路。

**限流与幂等**：即使 Massive 标称 unlimited API 调用，Worker 在请求间留退避间隔（429/5xx 指数退避）；写入按供应商唯一 ID（`massive_trade_id`、bar 唯一键）做 UPSERT，保证幂等。

```
┌──────────────────────────────────────────────────┐
│  Massive（Polygon）REST / WebSocket               │
│  (HTTPS 出网，不经 Mac Mini / TWS)                │
└────────────┬──────────────────────┬───────────────┘
             │ REST                 │ WebSocket
             ▼                     ▼
┌────────────────────┐  ┌──────────────────────────┐
│  Celery massive    │  │  WS Ingest 进程           │
│  queue (Worker)    │  │  (asyncio 长驻 / Server)  │
│  历史回填/OI/快照  │  │  延迟 quote/trades → Redis │
└──────────┬─────────┘  └──────────┬───────────────┘
           │ PG write              │ Redis + PG
           ▼                      ▼
┌──────────────────────────────────────────────────┐
│  PostgreSQL (option_day/min/OI/snapshots/trades) │
│  Redis (最新报价 ring, 短期缓存)                  │
└──────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│  FastAPI（Monitor 与/或 Research 等独立进程）      │
│  GET /research/... → 读 PG                        │
│  SSE / WS 推前端 (从 Redis 转发)                   │
└──────────────────────────────────────────────────┘
```

**部署说明**：上图逻辑不变；物理上 `/research/...` 等路由可由 **独立 FastAPI 进程**（如 `scripts/run_server_massive.py` → `backend.research`）提供，与 Monitor（`run_server.py`）分端口监听，见 §4.0。

#### 2.10.1 REST API 行为约定

| 路径 | 说明 | Starter | Developer |
|------|------|---------|-----------|
| `GET /research/massive/status` | 是否配置 key、tier、延迟说明；不返回密钥。 | 可用 | 可用 |
| `GET /research/option-expirations?symbol=...&provider=massive\|ib\|auto` | 链与到期；默认 `auto`（Massive 优先，不可用时退 IB）。 | 可用 | 可用 |
| `GET /research/option-snapshots?...` | 从 DB 读最新落地快照或 Massive 透传缓存；限制单次合约数。 | 可用 | 可用 |
| `GET /bars?...&source=massive` | 历史聚合柱线；`source` 参数可选；响应带 `source` 字段。 | 可用 | 可用 |
| `GET /research/option-oi?...` | 日终 Open Interest 读取。 | 可用 | 可用 |
| `GET /research/option-trades?...` | 逐笔成交（分页 + 时间范围）。**仅当** `massive.features.trades_enabled=true` 时返回数据，否则 403 或空列表 + 说明 tier。 | 不可用 | 可用 |
| `POST /research/massive/sync` | 入队异步拉取任务，返回 `job_id`；kind 参数指定任务类型。 | 可用（trades 除外） | 全部 |
| `GET /research/massive/jobs/{id}` | 查询异步任务状态与结果。 | 可用 | 可用 |

#### 2.10.2 WebSocket 行为约定

- **上游**：Massive 官方 WebSocket（期权 quotes/trades 等，以文档为准）。
- **本项目**：**Ingest 进程**消费上游 → 写 Redis（最新报价 ring）+ 可选 PG 抽样；**前端**不直连 Massive（密钥保护与 CORS），通过 **SSE（现有模式）** 或 **服务端 WebSocket** 转发摘要字段（contract_key、mid、iv、greeks、ts）。
- **Starter**：仅开**延迟 quote/snapshot** 通道。
- **Developer**：增开 **trades** 通道（与 REST 同 feature flag）。

#### 2.10.3 Ingest 运维（监控 / 启停 / 日志）

- **Redis meta（逻辑健康）**：Massive 期权 WS 为 `bifrost:health:ws_massive_option`（Monitor 可回退 `bifrost:health:massive_ws` 与 `massive:meta:status`）；IB ingestor / IB Operator 分别为 `bifrost:health:ws_ib_ingestor`、`bifrost:health:ws_ib_operator`（可回退上一版 bifrost 名；不再使用 `ib:ingester:meta:health` / `ib:operator:meta:health` 写健康）。**IB Account Agent** 落地后可增加独立 health 键（如 `bifrost:health:ws_ib_account_agent`，以实现为准）。字段含 `connected`、`last_msg_ts` 等。订阅与 tick 等数据键：`ib:ingester:*`；账户域 **`ib:account:*`**（拟议）；Operator 仅 **`ib:operator:cmd`** 等主动命令通道，**不**维持行情订阅。`GET /status` 的 `socket` 摘要供 UI 展示。
- **日志**：Socket Services ingest 将控制台日志写入 Redis Stream `bifrost:console:ws_massive_option`（Massive）、`bifrost:console:ws_ib_ingestor`（IB ingestor）、`bifrost:console:ws_ib_operator`（IB Operator）；Massive 对应 Monitor `GET /api/massive-ws/logs` 与 SSE `/api/massive-ws/logs/stream`。
- **进程控制**：Ops `GET /ops/market-ingest/services`、`POST /ops/market-ingest/control`（需 **operator**，与 `POST /ops/workers/scale` 同级；Redis broker 启停等仍为 admin）；`systemd` unit 须列入 `ops.allowed_units` 与 Agent 白名单。示例 unit：ingest 类 `deploy/systemd/bifrost-massive-ws.service`；**Engine** 为 `deploy/systemd/bifrost-engine.service`（可在 `ops.market_ingest_services` 中配置 **`redis_meta_key` 为空**，则不做 Socket 租约/ingest 健康清理）。注册表默认见 `backend/ops/market_ingest_config.py` 与各环境 YAML（示例见 `config/config.dev.yaml.example`）。
- **跨机**：Ops 与 ingest 不同机时，使用 `executor_mode=agent`，在 ingest 机运行 Local Control Agent；新增 unit 时同步扩展 `backend/ops/agent/protocol.py` 中的 `ALLOWED_UNIT_PATTERNS`。

#### 2.10.4 UI 行为约定

- **Research → Option Discovery**：展示数据源 badge **Massive · 15 min delayed**；表格列：strike、bid/ask、last、IV、Greeks（来自落地快照）、OI（日终）。
- **Trades Tab/列**：无 Developer tier 时**隐藏**「Tape/Trades」Tab 或列，或显示升级提示（英文文案 `Trades data requires Options Developer subscription`）。
- **Settings / About**（可选）：展示当前 `tier` 与能力列表。
- **所有 UI 文案使用英文**（遵守 workspace rule）。

#### 2.10.5 Worker 行为约定

- **Celery queue**：`massive`（与 IB `bars` 分离）；`concurrency` 按 Massive 限流设 1–N。
- **任务类型**：历史聚合回填、日 OI 拉取、快照批量、**Trades 回填**（仅 flag 开时入队与执行）；文件下载（若使用 Unlimited File Downloads）可作独立 task 解压/导入 staging 再 MERGE。
- **重试与幂等**：429/5xx 指数退避；写入按供应商唯一 ID（`massive_trade_id`、bar 唯一键）UPSERT。
- **启动**：`celery -A src.workers.celery_app worker -l info -Q massive --concurrency=N`（与 `bars` worker 可同机不同进程并行）。

#### 2.10.6 Feature flag 约定

配置项 `massive.tier`（`starter` | `developer`）驱动 `massive.features.trades_enabled` 默认值；也可单独覆盖。

| feature flag | Starter 默认 | Developer 默认 | 影响范围 |
|--------------|-------------|----------------|----------|
| `trades_enabled` | `false` | `true` | API：`GET /research/option-trades` 是否返回数据；Worker：trades kind 任务是否入队与执行；UI：Trades Tab 是否展示；WS Ingest：trades 通道是否订阅。 |

升级后仅修改配置并重启相关进程（Server + Worker + 可选 WS Ingest），无需 schema 迁移。

#### 2.10.7 详细说明与追踪

上述 §2.10 定义了 Massive 数据源的**架构约定**与**行为边界**。表结构、迁移与实现进度以 **[DATABASE.md](DATABASE.md)** 与 **[plans/CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)** 为准；历史分项实施计划文档已移除，不再单独维护。

#### 2.10.8 IB ingestor 与 Redis Pub/Sub（调试）

独立进程 `scripts/run_ib_ingestor.py` 将最新报价写入字符串键 `ib:ingester:tick:*`，并在**固定频道** **`ib:ingester:channel`** 上 `PUBLISH` 轻量通知（JSON 含 `contract_key`、`ts`）。**Market SSE**（`GET …/quotes/stream`）订阅该频道并 `GET` 对应 tick 键。守护进程写入的 **`quote:*`** 为另一套键空间（无 Pub/Sub；可选供 `GET /quotes` 等轮询路径）。

**为何在 Redis Insight / `PUBSUB CHANNELS *` 里「看不到」该频道**：Pub/Sub 频道**不是**字符串键，**不会**出现在 Browser 的 key 列表中；`EXISTS ib:ingester:channel` 对键空间恒为假。命令 **`PUBSUB CHANNELS`** 只列出**当前至少有一个客户端正在 `SUBSCRIBE` 的频道**——若尚无任何订阅者，列表为空属正常，**不代表** ingestor 未发布。

**如何订阅全部 tick 通知**：对 **`ib:ingester:channel`** 执行 **`SUBSCRIBE`**（或 Redis Insight **Pub/Sub** 工具中**手动输入**该频道名并连接；勿依赖「从列表里选频道」，列表可能为空）。收到消息后按 `contract_key` 再 **`GET ib:ingester:tick:{contract_key}`** 取完整 JSON。勿使用 `ib:ingester:ticks`（不存在）；tick 明细在键前缀 **`ib:ingester:tick:`** 下，不是按合约各建一个 Pub/Sub 频道。

**CLI 验证**：`redis-cli -h … -p … SUBSCRIBE ib:ingester:channel`（会话会阻塞，仅用于排障）。短时 **`MONITOR`** 可看到 `PUBLISH` 命令，勿长期开启。

### 2.11 IB Ingestor、IB Account Agent、IB Operator 与 Engine（目标职责）

与 [REQUIREMENTS.md](REQUIREMENTS.md) **§3.6（R-IB1～R-IB4）** 一致，以下为 **IB 边缘服务** 与 **Engine** 的架构边界（实现迁移中允许与下文不完全一致，以代码与 CAPABILITY_TRACKING 为准）。

| 进程 / 脚本 | 职责 | IB API 模式 | 写入 / 对外 |
|-------------|------|-------------|-------------|
| **IB Ingestor** | 独占**行情类订阅**：Watchlist STK/OPT 与按需 **`reqMktData`**（统一去重与生命周期） | 仅**订阅型**（`reqMktData` 等） | **Redis** `ib:ingester:*`；**不**写 PG |
| **IB Account Agent**（**新增**；启动脚本与包名实现时确定） | 独占**账户域订阅**：持仓事件、订单状态、挂单、成交、`commissionReport`；及为对齐 TWS 的 **`reqOpenOrders` / `reqExecutions` 等补全** | **订阅 + 必要时的主动 `req*`**；不在此做长期 `reqMktData` | **仅 Redis**（拟议 `ib:account:*`）；**不**写 PG |
| **IB Operator**（`run_ib_operator.py`） | **主动**调用：下单、撤单、查询类 `req*`、历史拉取等；**Redis Stream 命令 RPC** | **无长期订阅**；不承担 `reqMktData` 行情流 | RPC 结果；可选按命令写 PG（以实现为准）；**不**写 `ib:ingester:*` |
| **Engine / Daemon**（`run_engine.py`） | 策略 FSM、风控、心跳、读控制通道；**不**持有 `IBConnector`（目标） | 无 TWS 连接 | 读 **Redis**（Ingestor + Agent）；**账户类**落 **PostgreSQL**；执行经 **Operator 客户端 RPC** |

**数据流摘要**：`TWS → Ingestor → Redis（行情）`；`TWS → Account Agent → Redis（账户态势）`；`Daemon → Operator → TWS（下单等）`；`Daemon → PostgreSQL（由 Redis 驱动的账户持久化）`。

---

系统由三部分组成，对应上文 §2.2，缺一不可：

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  (1) 自动交易                                                                     │
│  守护进程：Redis(行情+账户) → 解析腿 → StateClassifier → FSM → Guard → Operator RPC │
│  单进程、单 asyncio 循环；目标不直连 TWS；仅通过 sink 暴露状态、通过控制通道接受指令   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    写入状态 snapshot    │    读取控制文件/API
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  (2) 监控与控制                                                                   │
│  独立应用：读 sink 输出（SQLite/文件）→ GET /status；写控制文件/API → 停止/暂停   │
│  与守护进程物理解耦；局域网内操作者使用                                            │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  (3) 基于回测的策略优化与安全边界验证                                               │
│  同一套 StateClassifier + FSM + Guard，数据源=历史回放，执行=模拟（不下真实单）     │
│  输出：理论 P&L、收益曲线、每 tick 决策与 block reason；首要用于策略 PnL 优化，兼做 Guard 验证 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| 组成部分 | 职责 | 交付阶段 |
|----------|------|----------|
| **自动交易** | **目标**：Redis 输入（行情+账户）+ Operator RPC 执行；解析 21–35 DTE 近 ATM、Greeks、状态分类、TradingFSM/HedgeFSM、hedge gate、ExecutionGuard；写状态到 sink、轮询控制通道。**迁移中**可仍为直连 TWS。 | 已实现 + 阶段 1（sink、停止）；去 IB 见 CAPABILITY_TRACKING |
| **监控与控制** | 独立进程读 sink，提供 HTTP/CLI，发停止（及后续 pause/resume）；不修改守护程序业务逻辑。 | 阶段 2 |
| **基于回测的策略优化与安全边界验证** | 历史回放驱动核心逻辑，不连 TWS、不 place_order；产出理论 P&L、收益曲线与决策/block reason；**首要用于策略 PnL 优化**，兼做 Guard 参数对比与验证。 | **阶段 4**（依赖阶段 1 历史表） |

---

## 4. 组件总览

### 4.0 HTTP 服务拆分（backend/*）

监控与业务 HTTP 由多个 **FastAPI 应用**组成，代码在 **`backend/<domain>/`**，按域独立进程部署；与守护进程（Engine）仍仅通过 **PostgreSQL**（及可选 **Redis**）耦合，不违背 RE-5。典型 **Prod** 可同机起多进程；也可用反向代理将多端口聚合为单一对外入口。端口键名以合并后的 YAML 为准，示例见 **`config/config.dev.yaml.example`** / **`config/config.yaml.example`**（`server` 段）：

| 域（逻辑） | Python 包 | 启动脚本 | 配置端口键（示例默认） |
|------------|-----------|----------|-------------------------|
| Monitor（状态、控制、日志等） | `backend.monitor` | `scripts/run_server.py` | `server.port`（未配置时 **`run_server.py` 默认 8765**；可在 YAML `server.port` 覆盖） |
| Massive / Feed（`/research/massive/*`、SSE 等） | `backend.massive` | `scripts/run_server_massive.py` | `server.massive_port`（8766） |
| Research（期权发现、max pain 等独立 API） | `backend.research` | `scripts/run_server_research.py` | `server.research_port`（8773） |
| Docs（合并 OpenAPI 等） | `backend.docs` | `scripts/run_server_docs.py` | `server.docs_port`（8767） |
| Ops（队列、Worker、Bars 任务等） | `backend.ops` | `scripts/run_server_ops.py` | `server.ops_port`（8768） |
| Trading（成交、绩效等） | `backend.trading` | `scripts/run_server_trading.py` | `server.trading_port`（8769） |
| Strategy | `backend.strategy` | `scripts/run_server_strategy.py` | `server.strategy_port`（8770） |
| Portfolio | `backend.portfolio` | `scripts/run_server_portfolio.py` | `server.portfolio_port`（8771） |
| Market（行情、Watchlist 等） | `backend.market` | `scripts/run_server_market.py` | `server.market_port`（8772） |

**Celery**：任务应用模块为 **`src.workers.celery_app`**（与 `scripts/run_celery.py` 一致）。Massive/Polygon 等队列任务在 **`src.massive.tasks`**；**`backend.massive`** 为 Massive/Feed 对应 HTTP（含 WebSocket/SSE）。

**运维分组（Prod systemd / `scripts/bifrost_ssh.sh`）**：HTTP 进程按四类聚合以便 deploy 后重启、systemctl 与状态扫描 — **architecture** = Monitor + Ops + Docs；**account** = Trading + Portfolio；**research** = Market + Research（`run_server_research`）+ Strategy；**feed** = Massive（`run_server_massive`）。Engine、Agent、Celery、ingest 单元不在此四类内，脚本中仍用「core / full stack」等组合。

**前端**：开发环境下对各 API 基址的配置需与上述多进程一致；详见 **[docs/index.md](index.md)**「项目组成与启动」。

### 4.1 自动交易（守护进程内）

| 组件 | 说明 | 代码/配置 |
|------|------|-----------|
| **IB Connector** | **目标架构**：Engine **不**持有 `IBConnector`；行情与账户来自 **Redis**（Ingestor / Account Agent）；下单通过 **IB Operator 客户端**。迁移中仍可能使用 `src/connector/ib.py`。 | `src/connector/ib.py` / Operator 客户端 |
| **IB Account Agent**（边缘服务） | 账户域 IB 事件 → **仅 Redis**；不写 PG。 | 独立进程（待实现）；见 §2.11 |
| **Store** | 内存：持仓、spot、last_hedge、daily_hedge_count、daily_pnl。 | 现有 store |
| **Portfolio / 解析腿** | 按 structure（min/max DTE、ATM 带）解析期权腿，计算净 delta（Black–Scholes）。 | 现有 + gates.strategy |
| **StateClassifier** | 将持仓/行情/greeks/执行 → 六维状态 O,D,M,L,E,S。 | gates.state（delta/market/liquidity/system） |
| **DaemonFSM** | 生命周期：IDLE → CONNECTING → CONNECTED → RUNNING → STOPPING。 | src/fsm/daemon_fsm.py |
| **TradingFSM** | 策略层：BOOT → SYNC → IDLE → ARMED → MONITOR → NEED_HEDGE ⇄ HEDGING ⇄ SAFE。 | src/fsm/trading_fsm.py |
| **HedgeFSM** | 执行层：EXEC_IDLE → PLAN → SEND → … → FILLED/FAIL。 | src/fsm/hedge_fsm.py |
| **Hedge gate** | should_output_target(cs)；apply_hedge_gates(intent, cs, guard)。 | src/strategy/hedge_gate.py |
| **ExecutionGuard** | 下单前门控：cooldown、每日/仓位/亏损限制等。 | gates.guard.risk、src/guards/execution_guard.py |
| **StatusSink（接口）** | write_snapshot(snapshot_dict)；由配置选择实现（SQLite/File/可选 Redis-PG）；snapshot 可含 **自检结果**（见需求 §4.1）。 | 阶段 1.1 引入 |
| **状态自检** | 基于当前 CompositeState、guards、config 做只读评估；输出 ok/degraded/blocked 与 block_reasons；供监控控制台展示或告警。 | 与阶段 2 监控一并考虑 |
| **控制通道** | 轮询控制文件（或后续 API）：**stop**（R-C1）、**flatten**（R-C3 一键平敞口）、可选 trading_paused（R-C2）；可选“触发自检”并写回 sink。 | 阶段 1.2/1.3（stop）；阶段 2 或 3.2（flatten、pause） |
| **Open Orders 与账户事件** | **目标**：**Account Agent** 订阅 orderStatusEvent、openOrderEvent 等 → **Redis**；Daemon 读 Redis 并写入 sink/PG；可选 reqAllOpenOrders 在 Agent 侧。 | Agent + Redis + Daemon 持久化 |

### 4.2 状态 Sink（守护进程调用，存储由配置决定）

| 组件 | 说明 | 交付 |
|------|------|------|
| **StatusSink 抽象** | 接口：write_snapshot(snapshot)；snapshot 含 daemon_state、trading_state、symbol、spot、bid/ask、净 delta、股票持仓、option 腿数、daily_hedge_count、daily_pnl、data_lag_ms、config 摘要、ts。 | 阶段 1.1 |
| **SQLiteSink** | 单文件 SQLite：当前视图表 + 可选历史表（append/采样）。 | 阶段 1.1 首选 |
| **FileSink** | 仅当前状态写 JSON/YAML，可选/调试。 | 阶段 1.1 可选 |
| **RedisSink / PostgreSQLSink** | 同一接口，多消费者或远程集中存储。 | 阶段 3.3 按需 |

### 4.3 监控与控制（独立应用）

| 组件 | 说明 | 交付 |
|------|------|------|
| **独立应用入口** | 如 scripts/run_server.py；与守护进程分离进程。 | 阶段 2.1 |
| **读 sink** | 优先读 SQLite 当前视图（或文件），GET /status → JSON；可含 **自检结果**（self_check），供控制台展示与告警。 | 阶段 2.1 |
| **控制** | POST /control/stop（一键停止，R-C1）；POST /control/flatten（一键平敞口，R-C3）；可选 pause/resume（R-C2）；可选触发自检（守护进程写回 sink）。 | 阶段 2.1（stop、flatten）；细粒度 3.2（pause） |

监控前端 Research 子页包含 Screener、Risk Model、Data、Backtest 与 **Option Discovery**（R-OD1）；Option Discovery 主力数据源为 **Massive**（R-A6），后续接入期权到期/询价/Greeks/OI 等数据；IB 作交叉校验或降级路径。

### 4.4 非实时市场数据拉取（Worker）

| 组件 | 说明 | 交付 |
|------|------|------|
| **任务队列** | backfill 等非实时拉取请求入队；**实现**：**Celery + Redis**（broker/result backend），任务行仍写 job_bars_backfill 表。 | 阶段 3（与 R-A3 一并） |
| **独立 Worker 进程** | Celery worker（`scripts/run_celery.py` 或 `celery -A src.workers.celery_app worker -Q bars`）取任务，串行执行拉取（IB 历史数据、写 stock_day/stock_min 等），任务间间隔以满足 IB Pacing。 | 阶段 3 |
| **API 入队与查询** | POST /bars/backfill（或等效）入队并返回 job_id；GET /bars/jobs、GET /bars/jobs/{id} 查询状态与结果；前端轮询 job 状态。 | 阶段 3 |

### 4.5 Massive 期权研究数据（R-A6）

| 组件 | 说明 | 交付 |
|------|------|------|
| **MassiveClient（REST）** | 封装 Massive REST API 调用（链/到期、snapshot、聚合 bars、OI、参考、trades 等）；统一限流、重试、API key 注入。 | 期权研究阶段 |
| **Massive Celery Worker** | 独立 queue `massive`（与 IB `bars` 分离）；任务类型：历史聚合回填、日 OI、批量快照、Trades 回填（flag 控制）；文件下载可作独立 task 解压导入。concurrency 按 Massive 限流设置。 | 期权研究阶段 |
| **Massive WS Ingest** | 独立 asyncio 进程或 Server 后台任务；消费 Massive WebSocket 延迟 quote/trades → Redis 最新报价 ring + 可选 PG 抽样；通过 SSE 或应用层 WS 转发前端。 | 可选后置 |
| **Research 路由扩展** | `GET /research/massive/status`（key/tier/延迟）、`GET /research/option-expirations?provider=...`、`GET /research/option-trades?...`（flag 控制）、`POST /research/massive/sync`（入队返回 job_id）、`GET /research/massive/jobs/{id}`。 | 期权研究阶段 |
| **Feature flag** | 配置 `massive.tier` / `massive.features.trades_enabled`；API/UI 按 flag 控制 Trades 可见性与写入；升级后仅改配置。 | 期权研究阶段 |

### 4.6 历史与统计（只读消费 sink 数据）

| 组件 | 说明 | 交付 |
|------|------|------|
| **历史统计脚本/模块** | 只读历史表，聚合：胜率、盈亏分布、按日/周/月、对冲次数、滑点等；**不跑** FSM/Guard。 | 阶段 3 |

### 4.7 回测（策略 PnL 优化与安全边界验证）

| 组件 | 说明 | 交付 |
|------|------|------|
| **回测入口** | 如 scripts/backtest.py 或“回测模式”。 | 阶段 4 |
| **数据源** | 历史表或回放文件，按时间序喂 snapshot/tick。 | 依赖阶段 1 历史 |
| **复用核心** | StateClassifier、TradingFSM、ExecutionGuard、gamma_scalper_intent、apply_hedge_gates。 | 与实盘同一套 |
| **执行** | 不连 IB、不 place_order；产出 **理论 P&L、收益曲线、回撤** 及“是否对冲、方向/数量、block reason”；**首要支持策略参数优化**，兼做 Guard 对比与验证；可选多组参数批量跑。 | 阶段 4 |

---

## 5. 数据流

```
                    ┌─────────────┐
                    │    TWS     │
                    └──────┬──────┘
                           │ 目标：行情/账户经边缘服务；下单经 Operator
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  守护进程 (GsTrading)                                                        │
│  Store ← Redis(行情+账户) → 解析腿 → Greeks → StateClassifier → CompositeState │
│       → TradingFSM → hedge_gate → ExecutionGuard → (若通过) HedgeFSM → Operator RPC │
│       → 每次 heartbeat / _eval_hedge 后: StatusSink.write_snapshot(...)   │
│       → 轮询 控制文件/API → stop 或 trading_paused                          │
└──────────────────────────────────────────────────────────────────────────┘
       │ write_snapshot                    │ read 控制
       ▼                                  ▲
┌─────────────────┐                ┌─────┴─────┐
│  SQLite / 文件   │  current +     │ 控制文件   │
│  (或 Redis/PG)  │  history       │ (或 API)   │
└────────┬────────┘                └───────────┘
         │ read
         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  独立应用 (监控/控制)                                                        │
│  GET /status ← 读当前  │  POST /control/stop (写控制文件)                    │
└──────────────────────────────────────────────────────────────────────────┘

回测路径（不经过 TWS）：
┌─────────────────┐    按时间序      ┌─────────────────────────────────────┐
│  历史表/回放文件  │ ── snapshot ──► │ 同一套 Classifier → FSM → Guard       │
└─────────────────┘                  │ 执行 = 写结果（无真实下单）             │
                                     └─────────────────────────────────────┘
                                                      │
                                                      ▼
                                              决策序列、block reason、理论 P&L
```

### 5.1 实时行情缓存与联动（R-RM*，可选）

在保留上述数据流的前提下，**目标架构**下实时行情与联动由 **IB Ingestor** 与 **IB Account Agent** 写入 Redis，**Daemon 不写**行情唯一真源键（见 [REQUIREMENTS.md](REQUIREMENTS.md) §6、§3.6）。

- **IB Ingestor**：将 **订阅所得行情** 写入 **Redis**（如 `ib:ingester:tick:*`），并在 **`ib:ingester:channel`**（或 Streams）上发布「有更新」通知；含 Watchlist 与按需 **`reqMktData`**（§2.11）。
- **IB Account Agent**：将 **账户域事件** 结果写入 **Redis**（拟议 `ib:account:*`）；**不**写 PG。
- **守护进程**：从 Redis **消费**行情与账户快照，写心跳与 **PostgreSQL**（账户类持久化）；**不**在进程内订阅 `reqMktData` 作为真源。
- **Redis**：行情与账户键的**写入方**为 Ingestor / Agent；监控 Server **不**写上述业务键。
- **监控 Server**：订阅联动通道；收到通知后**读 Redis**，向前端推送（WebSocket/SSE 或 GET /quotes）；与 Engine **物理解耦**，仅需同连 Redis。
- **未成交订单（R-A5）**：**目标**：Account Agent 事件 → Redis → Daemon 落 PG/sink；与 R-RM* 共用 Redis 联动模式。

部署时 Redis 可与 PG 同机或独立；未配置或不可用时系统退化为仅 PG + 现有 GET /status 轮询，不破坏现有行为。

### 5.2 未成交订单数据流（R-A5，事件驱动）

- **目标架构**：TWS → IB API 推送 **orderStatusEvent** / **openOrderEvent** / **execDetailsEvent** → **IB Account Agent** 内回调 → 更新 **Redis** 中 open orders 视图；**Daemon** 读 Redis 并写入 **sink/PG**（如 `daemon_open_orders` 等）。
- **迁移前**：仍可存在于守护进程内 **IB Connector** 回调路径，以实现为准。
- 监控 Server 读 sink 或订阅联动通道，提供 **GET /open-orders**（或 GET /status 内嵌 open_orders）；前端展示挂单列表及状态变更。
- 初期实现可仅采用「sink + GET /open-orders」；Redis 推送在 R-RM* 与 Agent 落地后统一。

---

---

## 6. 部署视图

- **TWS 主机（Mac Mini ×2）**：**两台 Mac Mini** 各运行一套 TWS（或 IB Gateway），分别承载 Host 与 Secondary 账户（RE-1，§2.1）；用户通过远程桌面登录该机进行手动交易。
- **Prod 全栈（Linux 服务器 192.168.10.70）**：运行 Engine（`run_engine.py`）、**IB Ingestor**（`run_ib_ingestor.py`）、**IB Operator**（`run_ib_operator.py`）、**IB Account Agent**（独立进程，待实现；可选 `bifrost-ib-account-agent.service`）、**一个或多个 FastAPI 进程**（至少 Monitor：`run_server.py`；按需增加 `run_server_ops.py`、`run_server_trading.py` 等，见 §4.0）、Redis、Celery worker（`bars` / `massive` 等队列）；**边缘服务**经 IB API 跨网连接两台 Mac Mini 上的 TWS。单机仅一个 Engine 进程（RE-6，§2.5）。
- **Dev 开发机（Mac）**：运行 **Monitor 及各域 API**（按功能按需）、Redis、Celery（Engine 可选）；连接 Dev DB 与同一两台 Mac Mini（使用与 Prod 不同的 client_id）。
- **PostgreSQL（独立主机 192.168.10.80）**：承载 **Prod DB** 与 **Dev DB**（不同 database 名，R-DV1，§2.8）；Prod 与 Dev 各连各库。
- **监控与守护（RE-5，§2.4）**：Prod 上 Engine 与 Server 同机但**进程级分离**；可选监控机物理分离变体。
- **回测与统计**：与守护程序同仓库、同 Python 环境；回测不连 TWS，统计只读 DB，可在本机或能访问 DB 的环境运行。

### 6.1 部署拓扑与启停边界（便于 Agent / 实现参考）

**选定拓扑**：**两台 Mac Mini 独占 TWS**（Host / Secondary）；**Prod 全栈在 Linux 服务器**（方案 B），经 IB API 连接 TWS；**Dev 在开发机**连 Dev DB。**PostgreSQL 在独立主机**，按 database 隔离 Dev/Prod。

- **TWS 主机（Mac Mini ×2）**：仅运行 TWS（或 IB Gateway）；操作者通过远程桌面登录进行手动交易。
- **Prod 主机（Linux 服务器 192.168.10.70）**：
  - **守护进程**（`run_engine.py`）：**目标架构**下**不直连** TWS；从 **Redis** 读行情与账户数据，执行对冲逻辑（Gamma Scalping、FSM、写 status/operations）；下单经 **IB Operator**；轮询 Prod DB（`daemon_control`、`daemon_run_status`）。**运行不依赖直连 IB**（RE-7、§2.6）：若数据或 Operator 不可用则 degraded / WAITING 类状态，持续写心跳、轮询 stop/retry。收到 **stop** 则消费并退出；**suspend** / **resume** 通过 `daemon_run_status.suspended` 切换 Daemon FSM 的 RUNNING_SUSPENDED。
  - **IB Ingestor / IB Operator / IB Account Agent**：长驻边缘服务，见 §2.11；与 Engine 同机或按运维拆分（需共享 Redis 与 PG 访问纪律）。
  - **HTTP API**（§4.0）：**Monitor**（`run_server.py`）读 Prod DB，提供 GET /status、GET /operations、POST /control/* 等；**不**在 Monitor 进程内 exec 守护进程。**Engine 启停**：经 **Ops**（`GET/POST /ops/market-ingest/*`，与 Socket Services 同源）对 **`bifrost-engine.service`** 执行 **systemd** start/stop/restart（须列入 `ops.market_ingest_services` 与 Agent/`ops.allowed_units` 白名单）。其余域（Ops、Trading、Research 等）按需同机另起进程。守护进程本体仍为本机 **`run_engine.py`**（由 systemd 拉起或开发/排障时手动）。
  - **Redis + Celery worker**：同机部署；`bars` / `massive` 等队列见 `scripts/run_celery.py`。
- **Dev 开发机（Mac）**：运行 Monitor 及各域 API（+ 可选 Engine/Redis/Celery）；连接 **Dev DB**；连接 TWS 时使用与 Prod 不同的 `client_id`。Dev Engine **不得**与 Prod Engine 同时对同一 IB 账户下单（R-DV3，§2.1）。
- **PostgreSQL（192.168.10.80）**：Prod DB 与 Dev DB 在同一服务器上不同 `database`；守护进程、各 FastAPI 进程、Worker 均连本环境对应库。

**启停语义**：

| 操作 | 谁处理 | 说明 |
|------|--------|------|
| **Stop**（推荐日常） | **systemd** 对 `bifrost-engine.service` 发 **SIGTERM** | Ops UI → `POST /ops/market-ingest/control`（stop）→ Local Control Agent / 本机 executor → `systemctl stop`；进程走 FSM 清理，退出时写 **`daemon_heartbeat.graceful_shutdown_at`** 等（与 IB Account Agent 同类「优雅停机」宽限期：`TimeoutStopSec` 见 unit 文件）。 |
| **Stop**（备选） | 守护进程轮询并消费 `daemon_control` 中的 stop 后退出 | 监控端 POST /control/stop → 写 DB → 守护进程消费 stop 并退出；同样可触发优雅写库。 |
| **Start / Restart** | **systemd** | Ops UI → 同上 API（start/restart）→ `systemctl`；**Monitor 不 subprocess 启动**。 |
| **Flatten** | 守护进程轮询并消费 flatten | 监控端 POST /control/flatten → 写 DB → 守护进程消费并执行。 |
| **Suspend** | 守护进程根据 `daemon_run_status.suspended=true` 进入 RUNNING_SUSPENDED | 监控端 POST /control/suspend → 写 DB → 守护进程轮询后不再执行 maybe_hedge。 |
| **Resume** | 守护进程根据 `daemon_run_status.suspended=false` 回到 RUNNING | 监控端 POST /control/resume → 写 DB → 守护进程轮询后恢复执行 maybe_hedge。 |
| **Retry IB**（RE-7） | 守护进程立即尝试连接 TWS | 监控端 POST /control/retry_ib → 写 DB → 守护进程消费后执行一次连接尝试；恢复后写回连接状态与 Client ID。 |
| **手工启动** | 操作者 / 排障 | 在**守护程序主机**直接执行 `run_engine.py`（不经 Ops）；开发与 SSH 排障仍可用。 |

**拓扑示意（当前选定：两台 Mac Mini TWS + Linux Prod 全栈 + Dev 开发机 + PostgreSQL 独立主机）**：

```
┌──────────────────────────────────────┐
│  TWS Mac Mini ×2                     │
│  (Host TWS + Secondary TWS)          │
│  仅 TWS / 手动交易                    │
└────────────┬─────────────────────────┘
             │ IB API（局域网）
             │
   ┌─────────┴──────────┐
   │                     │
   ▼                     ▼
┌─────────────────────┐  ┌─────────────────────┐
│  Prod (Linux 70)    │  │  Dev (开发机 Mac)    │
│  Engine             │  │  Monitor + 域 API    │
│  Monitor + 域 API   │  │  Redis + Celery      │
│  Redis + Celery     │  │  Engine（可选）       │
└────────┬────────────┘  └────────┬────────────┘
         │ postgres                │ postgres
         ▼                        ▼
┌──────────────────────────────────────┐
│  PostgreSQL (192.168.10.80)          │
│  ┌────────────┐  ┌────────────┐     │
│  │  Prod DB   │  │  Dev DB    │     │
│  └────────────┘  └────────────┘     │
└──────────────────────────────────────┘
```

---

## 7. 需求 → 组件 → 阶段映射

| 产品需求（REQUIREMENTS.md） | 对应组件 | 交付阶段 |
|--------------------------------|----------|----------|
|--------------------------------|----------|----------|
| 两个 IB 账户；Host 账户：自动+行情+手动；第二账户：仅手动，统一 Portfolio（R-A4） | 配置 host_account_id（ib_host_account_id）、Ingestor/Agent/Operator 分工、守护进程按 Host 账户对冲、监控/Performance 按 account_id 展示 | 阶段 3 |
| 两台 Mac Mini TWS（Host/Secondary）、多 account_id；自动/手动不同 client_id；Dev/Prod 不同 client_id | 边缘服务 client_id、配置 | 已实现 |
| 两台 Mac Mini 独占 TWS；守护程序可选同机或 Linux 单进程 | DaemonFSM、run_engine、部署文档（§2.3） | 已实现 |
| 监控：不依赖控制台查看状态 | StatusSink + SQLite/文件；独立应用 GET /status | 阶段 1.1 + 阶段 2.1 |
| 监控：状态自检（健康结论与 block 原因） | 守护进程自检结果写入 sink；监控控制台展示/告警 | 与阶段 2 一并考虑 |
| 监控：红绿灯（红/黄/绿一目了然） | 独立应用或 UI 基于 self_check 展示 status_lamp: green/yellow/red | 阶段 2（R-M3） |
| 监控：操作可查（执行记录，尤其持仓变化） | 守护进程写操作/事件到 sink；独立应用 GET /operations 或等效查询 | 阶段 1（写）+ 阶段 2（R-M4 查询） |
| 控制：一键停止（R-C1） | SIGTERM/SIGINT、控制文件；独立应用 POST /control/stop | 阶段 1.2/1.3 + 阶段 2.1 |
| 控制：一键平敞口（R-C3，安全兜底） | 控制通道 flatten；守护进程平掉本策略对冲敞口并写操作记录；独立应用 POST /control/flatten | 阶段 5 |
| 控制后续：暂停/恢复（R-C2） | 控制通道 trading_paused；独立应用发 pause/resume | 阶段 5 |
| 状态可扩展为带历史 | SQLite 当前表 + 历史表；sink 抽象 | 阶段 1.1 |
| 历史数据与统计 | 独立脚本/模块只读历史表聚合 | 阶段 3 |
| 回测（策略 PnL 优化 + Guard 验证） | 回测入口 + 复用 Classifier/FSM/Guard，历史回放；产出 PnL/收益曲线，首要优化策略回报 | 阶段 4 |
| 部署 A/B（Mac vs Linux）、进程管理 | 文档、可选 systemd/supervisor 示例 | 按需 |
| **Dev/Prod 环境隔离（R-DV1/R-DV2/R-DV3）** | 配置分环境（`postgres.database` 等）、部署文档、运维纪律；TWS 共享 + client_id 隔离 | 与架构修订同步 |
| 多消费者/远程存储可选 | RedisSink/PostgreSQLSink | 按需 |
| **非实时市场数据拉取（R-A3 扩展）** | 队列（PG 表或 Redis+RQ）+ **独立 Worker 进程**；API 入队返回 job_id，GET /bars/jobs、GET /bars/jobs/{id}；串行+间隔满足 IB Pacing | 阶段 3 |
| **Massive 期权研究数据（R-A6）** | MassiveClient REST + Celery Worker（queue `massive`）+ 可选 WS Ingest；Research 路由扩展；feature flag 控制 Trades；不占 IB client_id，不进入 ExecutionGuard | 期权研究阶段 |
| **实时行情与联动（R-RM*）** | Ingestor/Agent 写 Redis；Daemon 消费；Pub/Sub 或 Streams；监控订阅并推前端 | 见 REQUIREMENTS §6、[REQUIREMENTS.md](REQUIREMENTS.md) §3.6 |
| **IB 边缘服务与 Daemon 边界（R-IB1～R-IB4）** | §2.11；Ingestor / Account Agent / Operator / Engine 职责 | 见 REQUIREMENTS §3.6 |
| **未成交订单可观测（R-A5）** | **目标**：Account Agent → Redis → Daemon → sink/PG；GET /open-orders | 阶段 3 或与 Agent 同步 |

---

## 8. 安全边界配置

当前与安全边界相关的配置（gates.strategy / state / intent / guard 等）均在 **YAML 文件** 中，守护进程通过文件路径加载并支持热重载。回测阶段会对这些参数做多组调整与对比，因此需要：**（1）实盘/回测各自使用的参数集可追溯；（2）能与“哪次交易、哪次回测”对应，便于匹配策略版本与回测结果。**

### 8.1 是否改为数据库存储？

| 方式 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| **文件** | 守护进程 **运行时** 的唯一下发源；回测可接受“配置文件路径 + 可选覆盖”。 | 简单、可热重载、无需 DB 依赖、可用 git 管理文件即版本。 | 多组参数多文件或需运行时覆盖；版本与“某次运行”的对应需通过 **写入 sink/回测输出** 来记录。 |
| **数据库（配置注册表）** | 存多份“配置版本”，每份有 version_id/name；守护进程与回测均可按 version 加载。 | 集中管理、易做参数扫描与对比、实盘/回测结果都可挂 config_version_id。 | 守护进程需支持“从 DB 取某版本再跑”或“导出为文件再跑”；多一套存储与迁移。 |

**结论**：  
- **不必** 把“当前运行用哪份配置”的 **运行时来源** 从文件改为 DB；守护进程继续用 **文件** 作为单源即可，热重载保留。  
- **必须** 的是：**每次写入状态或回测输出时，都带上“当时生效的配置标识”**，这样历史/回测才能与策略版本对应。  
- **已落实**：集中管理多组参数、按版本切换已通过 **gate_safety_*** 表与 **strategy_*** 表实现（见 §9.3）；**settings** 表字段 **active_strategy_structure_id**、**active_gate_safety_strategy_id** 指定当前生效项；守护进程在两者非空时可**优先从 DB 加载** gates/结构，未配置时回退文件，与“运行时仍可用文件”并存。

### 8.2 可追溯性（最低要求）

无论配置来自文件还是 DB，都应满足：

1. **Sink 快照**  
   每次 `write_snapshot` 时写入 **config 摘要**（已规划）：至少包含 **生效中的安全边界相关配置** 的只读快照（如 gates 下 strategy/state/intent/guard 的扁平或 JSON），或其 **哈希**（如 `config_hash`）。这样每条状态/历史记录都对应“当时用的参数集”。

2. **回测输出**  
   每次回测运行（单组或批量）在结果中记录 **本 run 使用的完整 gates 参数** 或 **config_version / config_hash**。便于：  
   - 对比“同一段历史、不同参数”的回测结果；  
   - 与实盘历史对比（实盘某时段 sink 中的 config_hash 与某次回测的 config_hash 一致 ⇒ 同一策略版本）。

3. **版本标识**  
   - **方案 A（仅文件）**：在 YAML 中增加可选字段如 `config_version: "v1.2"` 或 `config_name: "baseline_202502"`，由人工维护；sink 与回测输出一并写入，用于展示与匹配。  
   - **方案 B（git）**：配置文件随仓库版本控制，实盘/回测记录 `config_path` + 可选 `git_commit`，通过 commit 对应到版本。  
   - **方案 C（配置注册表）**：见下。

### 8.3 策略与安全边界表（已落实，DATABASE.md §2.24）

**配置注册表**已落实为以下表结构（与状态 sink 同库；详见 [DATABASE.md](DATABASE.md) §2.24）：

- **安全边界**：根表 **gate_safety_strategy**（边界集主键 + strategy 层标量列）；子表 **gate_safety_strategy_earnings_dates**、**gate_safety_state**、**gate_safety_intent**、**gate_safety_guard**（均以 gate_safety_strategy_id 为 PK/FK），**无 JSON 列**。
- **策略三层**：**strategy_structure**（结构策略）、**strategy_opportunity**（机会策略，引用 structure + 可选 default_gate_safety_strategy_id）、**strategy_allocation**（策略分配 Allocations，引用 gate_safety_strategy_id）。
- **当前生效**：**settings** 表列 **active_strategy_structure_id**、**active_gate_safety_strategy_id**；守护进程启动时若两列非空，则从 DB 组装「结构」与「gates」，否则回退 config 文件。**Allocations 层**：策略分配（strategy_allocation）当前无「当前生效」列；**后续可扩展** settings 增加 **active_strategy_allocation_id**，供多账户/多策略组合时指定当前监控或执行的分配集，并与机会监控、Daemon 按分配集加载 opportunity 列表衔接（需求与能力进度见 REQUIREMENTS.md §4.3、[plans/CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)）。**后续重构预留**：Settings 表可能聚焦为仅承载系统级配置（IB、Flex、心跳等）；「当前生效」的 strategy/gate/allocation id 可迁至独立表（如 runtime_strategy_config 或与 daemon_run_status 合并）。迁出时仅需调整 reader 与 POST /config/active-strategy 的读写对象，API 与前端语义不变。

**守护进程**：支持“从 DB 取当前生效的 gate_safety_strategy_id 对应的 gates”并注入 config；未配置或读不到时仍以**文件**为运行时来源。**Phase A**：若 active_strategy_structure_id 非空，则从 DB 加载 structure 并注入 config[\"active_strategy_structure\"]；PostgresSink 在 append_history 时写入 strategy_history。切换版本：更新 settings 的 active_gate_safety_strategy_id / active_strategy_structure_id 后重启或热重载（若实现）。

**后台**：GET /status 返回 active_strategy_structure_id、active_gate_safety_strategy_id 及对应 name；GET /strategies/structures、/structures/{id}、/history、/gate-safety、/gate-safety/{id} 及 POST/PUT /gate-safety 供管理与策略使用情况查询及 CRUD。**监控前端**在 **Research → Strategy** 提供策略管理页（当前生效、列表、Set active）；在 **Research → Gates** 提供 Gates 配置管理页（列表、创建、编辑、Set active、复制）。

**策略实例 UI**：**策略实例**列表与详情作为 **Strategy 域**子视图（如 **Strategy → Instances**），与 Structure / Opportunity / Allocations 同一导航分组；数据模型与表结构见 [DATABASE.md](DATABASE.md) §2.24.11。API 侧可按 `strategy_instance_id` 筛选 GET /executions、GET /performance 等（具体路由以各 `backend/*` 应用为准）。

**回测**：支持从 DB 按 gate_safety_strategy_id 加载配置，或继续使用“配置文件路径 + 覆盖”。回测结果可记录 **config_hash** 或 **gate_safety_strategy_id**，与 sink 历史中的 config_summary 对齐。

### 9.4 小结

| 问题 | 建议 |
|------|------|
| 当前用文件保存安全边界配置，回测会调整这些参数，文件方式还适用吗？ | **适用**。守护进程可优先从 **DB**（settings 指定 active_gate_safety_strategy_id）加载 gates，未配置时仍用 **文件**；回测可接受“配置文件 + 覆盖”或“从 DB 按 gate_safety_strategy_id 加载”。 |
| 是否需要存到数据库？ | **已落实**：gate_safety_* 与 strategy_* 表（DATABASE.md §2.24）；settings 存当前生效 id；守护进程在 id 非空时从 DB 加载，否则回退文件。 |
| 如何按版本管理并匹配策略与回测结果？ | **最低要求**：sink 写入 **config 摘要或 config_hash**（可含 gate_safety_strategy_id）；回测输出写入 **所用参数或 gate_safety_strategy_id**。**已落实**：gate_safety_strategy 等表提供多版本；回测与实盘历史均可挂 gate_safety_strategy_id 实现一一对应。 |

---

## 9. 相关文档索引

- **[产品需求](REQUIREMENTS.md)** — 产品功能需求（守护程序、监控、金融数据采集、策略编辑/回测/历史统计、策略应用）、**R-IB1～R-IB4**（§3.6）与环境部署约束（R-DV*）
- **[运行环境与部署约束](ARCHITECTURE.md#2-运行环境与部署约束)** — 本文档 §2
- **[能力评估与进度](plans/CAPABILITY_TRACKING.md)** — 能力维度拆解与当前进度
- **[FSM 串联](fsm/FSM_LINKAGE.md)** — Daemon/Trading/Hedge 三 FSM 联动
- **[状态空间](research/STATE_SPACE_MAPPING.md)** — O,D,M,L,E,S 与代码/配置
- **[配置安全分类](research/CONFIG_SAFETY_TAXONOMY.md)** — gates 与安全边界
- **[Guard 微调与影响](research/GUARD_TUNING_AND_IMPACT.md)** — 参数调整与后果
- **§8 本文** — 安全边界配置的存储与版本管理（文件 vs 配置注册表、可追溯性、与回测结果匹配）

*最后更新：2026-04-07 — §2.10.3、§6.1：**Engine** 经 Ops `market-ingest` + systemd 启停；启停语义表区分 systemd stop 与 POST /control/stop。此前：新增 §2.11（IB Ingestor / Account Agent / Operator / Engine 目标职责），修订 §2.1、§2.6、§2.8、§4.1、§5、§6.1、§7 映射与 [REQUIREMENTS.md](REQUIREMENTS.md) §3.6、R-RM*、R-DV4 对齐。*
