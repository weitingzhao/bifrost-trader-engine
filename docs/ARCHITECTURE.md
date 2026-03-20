# 系统架构设计

本文档基于 **产品需求**（[REQUIREMENTS.md](REQUIREMENTS.md)）做全盘系统架构设计，作为实现与评审的单一参考。**运行环境与部署约束**（两台 Mac Mini 独占 TWS、双 IB 账户、Prod Linux 全栈 + Dev 本机、PostgreSQL Dev/Prod 隔离、监控与交易逻辑解耦等）在本文档 §2；FSM、状态空间、配置分类等细节见文档索引，此处只做映射与总览。

---

## 1. 架构定位与文档关系

| 文档 | 角色 |
|------|------|
| **REQUIREMENTS.md** | 产品功能需求唯一定义：监控、控制、历史、回测、交易基础等（R-M*/R-C*/R-H*/R-B*/R-A*）；环境与部署约束（R-DV*）。 |
| **本文档 (ARCHITECTURE.md)** | 系统级架构：**运行环境与部署约束**（§2）、三大组成部分、组件划分、数据流、部署视图、需求→组件→阶段映射。 |
| **CAPABILITY_TRACKING.md** | 能力维度拆解与当前进度（木桶原理）。 |
| **research/STATE_SPACE_MAPPING.md**、**FSM_LINKAGE.md**、**research/CONFIG_SAFETY_TAXONOMY.md** | 状态空间、FSM、配置安全边界等专项，此处不重复。 |

---

## 2. 运行环境与部署约束

以下为**运行环境与约束**的唯一定义；产品功能需求不因运行环境不同而改变，见 [REQUIREMENTS.md](REQUIREMENTS.md)。

### 2.1 IB / TWS 与账户（RE-1）

- **数据与下单**：均通过 IB API 来自 **TWS**（Trader Workstation）。
- **TWS 主机**：**两台 Mac Mini**，各运行一套 TWS（或 IB Gateway）；分别承载 **Host 账户** 与 **Secondary 账户**（见需求 R-A4）。两台 Mac Mini 均在局域网内，供守护程序与监控端通过 IB API 连接。
- **账户**：**两个 IB 账户**（见需求 R-A4）。
  - **Host 账户**：数据与下单经当前 IB API 连接 TWS；承担**自动交易**（本项目 Gamma scalping）、**手动交易**及**行情/持仓数据源**。由 settings 表 `host_account_id`（列名 `ib_host_account_id`）指定，未配置时取 TWS 返回的 managed accounts 中第一个。**Client ID 与 host_account_id 均在 PostgreSQL settings 表**，config.yaml 不再定义。
  - **第二账户**：**仅手动交易**；守护进程不对其下单或订阅行情。若与主账户在同一 TWS 同一登录下，由现有守护进程/监控端拉取并写入 `account` / `account_positions` 等表；若在**另一 TWS 或另一登录**下，则通过监控端或独立服务的**第二 IB 连接**拉取后写入同一库（当前计划仅文档预留，不实现第二连接）。
- **实现方式**：TWS 允许多个 API 连接，用不同的 **client_id** 区分。守护程序使用一个 `client_id`（如 1）；手动交易使用 TWS 界面或另一 `client_id`（如 2）的客户端；监控端 Account/Market、Celery 各用不同 client_id。
- **Dev/Prod 与 TWS 共享**（R-DV3）：两台 Mac Mini 上的 TWS 为 Dev 与 Prod **共享基础设施**。Dev 与 Prod 通过 **不同 `client_id` 与/或不同 TWS socket 端口** 区分连接。**同一 IB 账户同一时刻仅允许一个自动交易 Engine 对该账户下单**，避免双环境双 Engine 实盘冲突。

### 2.2 架构支柱（RE-2）

系统由三部分组成，缺一不可（详见下文 §3）：

| 组成部分 | 说明 |
|----------|------|
| **自动交易** | 以 **单进程、单线程**（单一 asyncio 事件循环）的 **守护程序** 实现；负责连接 TWS、持仓/行情、StateClassifier、FSM、Guard、下单等。 |
| **监控与控制** | 与守护程序 **物理解耦**；状态的读取、控制指令的发送由 **独立应用** 完成。 |
| **基于回测的策略优化与安全边界验证** | 历史回放驱动同一套 StateClassifier、FSM、Guard 逻辑，**不连 TWS、不下真实单**；首要用于策略 PnL 优化，兼做 Guard 验证（见 REQUIREMENTS.md §4）。 |

### 2.3 部署与运行位置（RE-3、RE-4）

受 IB 限制，**TWS（或 IB Gateway）运行在两台专用 Mac Mini 上**（分别承载 Host 与 Secondary 账户，见 §2.1），仅承担 TWS 与手动交易入口角色。操作者通过远程桌面登录 Mac Mini 进行手动交易。**守护程序**可在以下两种位置之一运行，并通过 IB API 连接 Mac Mini 上的 TWS 获取行情与下单：

| 方案 | TWS 所在 | 守护程序所在 | 说明 |
|------|----------|--------------|------|
| **A. Mac Mini 同机** | 专用 Mac Mini | **同一台 Mac Mini** | 守护程序与 TWS 同机，经本机 API 连接 TWS；部署简单，延迟最低。 |
| **B. Linux 服务器（当前选定）** | 两台 Mac Mini（仅 TWS） | **局域网 Linux 服务器（如 192.168.10.70）** | 守护程序在 Linux 上运行，经**网络**连接 Mac Mini 上的 TWS 获取行情数据并下单；TWS 需允许来自局域网的 API 连接。**生产环境**（Prod）采用此方案。 |

- **TWS 主机（Mac Mini ×2）**：仅运行 TWS（或 IB Gateway）；不强制要求本机再跑守护程序。用户通过远程桌面在 Mac Mini 上进行手动交易，与自动交易共享同一账户（不同 client_id）。
- **守护程序主机**：可为上述 Mac Mini（方案 A），或局域网内另一台 Linux 服务器（方案 B）；仅运行 `run_engine.py` 单进程，连接 TWS、执行对冲逻辑、写状态与心跳。**当前 Prod 采用方案 B**。
- **监控范围（RE-4）**：仅操作者本人、**家庭/办公室局域网**；不要求公网或手机。

### 2.4 监控服务与交易服务分离（RE-5）

**架构原则**：监控服务（status server）与守护进程**逻辑解耦**——它们是独立进程，仅通过 PostgreSQL 通信；无论部署在同机还是不同机器上均成立。

**当前选定拓扑**：Prod 在 **Linux 服务器（192.168.10.70）** 上 **同机部署** Engine、Server、Redis、Celery（进程级分离）。**可选变体**：监控机与守护程序主机物理分离（如 status server 在开发机 / 另一台笔记本），只需能连同一 PostgreSQL。

- **TWS 主机（Mac Mini ×2）**：仅运行 TWS；用户远程登录该机进行手动交易。
- **守护程序主机**：运行 `run_engine.py`，连接 Mac Mini 上的 TWS（同机或跨网），执行对冲、写状态与心跳；可为 Mac Mini（与 TWS 同机）或 Linux 服务器。
- **监控服务**：与守护进程**逻辑解耦**（独立进程）；控制通道采用 **PostgreSQL 表 `daemon_control`**（见 [DATABASE.md](DATABASE.md) §2.4）。跨机与同机均只需能连**同一 PostgreSQL**。
- **启停**：监控端 POST /control/stop → 写 DB → 守护进程轮询消费后退出；**启动**须在**守护程序主机**上执行 `run_engine.py`（SSH/systemd/手动）。

### 2.5 守护程序主机单进程（RE-6）

**守护程序主机**（即运行 `run_engine.py` 的那台机器：Mac Mini 或 Linux 服务器）上仅运行 **单进程**（`run_engine.py`）：同一进程连接 TWS、执行对冲逻辑、轮询 `daemon_control` 与 `daemon_run_status`，并写心跳与状态。升级对冲逻辑需重启整个进程。

### 2.6 守护程序与 IB 连接（RE-7）

**核心原则**：**守护程序本身的运行与否不依赖 IB 是否可连接**。IB 不可用时守护程序仍保持运行，仅“启动/执行对冲”的条件不满足；监控端显示**黄灯**（degraded），而非红/退出。

**要求**：
- **运行不依赖 IB**：守护程序**不得**因“IB 连接失败”而退出。启动时若无法连接 IB，应进入 WAITING_IB 等状态，持续写心跳、轮询控制，并**按配置间隔周期重试**连接 IB。
- **不预先假设 IB 已运行**：不得无限阻塞；采用带超时的连接尝试。
- **未连接时监控为黄灯**：守护进程存活但 IB 未连接时，自检结论为 **degraded**（黄灯）。
- **连接状态可观测**：监控端须展示守护程序是否与 IB 连接及连接成功时的 **Client ID**；未连接时展示**下次计划重试时间**（如 `next_retry_ts`）。
- **自动重试与可选手动重试**：到点自动重试；监控端可选提供「重试连接 IB」按钮，通过 `daemon_control` 写入 `retry_ib`。

### 2.7 非实时市场数据拉取与 Worker（R-A3 扩展）

**原则**：**非实时要求的市场数据拉取**（如 K 线 backfill、历史补全）**不在 API 进程内同步执行**，而是通过**任务队列 + 独立 Worker 进程**在后台执行，以保证 API 响应不受拉取耗时与 IB 限速影响，且与守护程序、监控服务进程隔离。

**要求**：
- **队列**：拉取任务（如 backfill 请求）写入**队列**；当前实现采用 **Celery + Redis**（broker 与 result backend 使用同一 Redis，与实时行情可选共用实例、不同 db）；任务行仍写入 **job_bars_backfill** 表（job_id 即 Celery task_id），便于 GET /bars/jobs 与前端轮询。
- **独立 Worker 进程**：单独进程从队列取任务并执行拉取（如调用 IB 历史数据接口、写 stock_day/stock_min）；**与 status server（API）进程、守护进程分离**，可部署于同一主机或不同主机，只需能连同一 PostgreSQL（及 Redis）与 IB（若 Worker 直连 TWS）。启动方式：`python scripts/run_celery.py` 或 `celery -A servers.celery_app worker -l info -Q bars --concurrency=1`（必须单进程，否则多进程会争用同一 IB client_id）。
- **API 行为**：监控/数据 API 收到 backfill 等请求时**仅入队并返回 job_id**；客户端通过 **GET /bars/jobs/{job_id}**（或等效）轮询任务状态与结果；任务完成后可刷新 coverage/列表。
- **限速与串行**：Worker 串行处理任务并在任务间留间隔（如 2s），以符合 IB 官方历史数据 Pacing 限制。

### 2.8 开发与生产环境（RE-8，R-DV1/R-DV2）

Dev 与 Prod 在 **PostgreSQL 层面逻辑隔离**：同一 PostgreSQL 服务器（如 192.168.10.80）上使用**不同 `database` 名**（如 `bifrost_dev` / `bifrost_prod`）；或独立实例。各进程仅连接**本环境**配置的数据库，settings、控制通道、业务数据**不跨环境混用**。

| 环境 | 运行栈 | 数据库 | TWS 连接 |
|------|--------|--------|----------|
| **Prod** | **Linux 服务器（192.168.10.70）**：Engine + Server + Redis + Celery | **Prod DB**（192.168.10.80 上独立 database） | 经 IB API 连接两台 Mac Mini 上的 TWS（Prod client_id） |
| **Dev** | **开发机（Mac）**：Engine（可选）、Server、Redis、Celery | **Dev DB**（192.168.10.80 上独立 database） | 经 IB API 连接同一两台 Mac Mini（Dev client_id，与 Prod 互斥） |

**约束**：
- 数据库**迁移（schema migration）、种子数据、备份**按环境独立执行；**禁止**将 Dev 的破坏性操作（清表、重建等）默认指向 Prod。
- `config/config.yaml` 按环境维护（或通过环境变量 / 多配置文件区分），至少 `postgres.database`（及必要时 `postgres.host`/`postgres.user`）不同。
- **TWS 共享纪律**：见 §2.1「Dev/Prod 与 TWS 共享」——同一 IB 账户同一时刻仅允许一个自动交易 Engine 下单。

---

系统由三部分组成，对应上文 §2.2，缺一不可：

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  (1) 自动交易                                                                     │
│  守护进程：TWS ↔ 持仓/行情 → 解析腿 → StateClassifier → FSM → Guard → 下单        │
│  单进程、单 asyncio 循环；不内置监控 UI，仅通过 sink 暴露状态、通过控制通道接受指令  │
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
| **自动交易** | 连接 TWS、持仓/行情、解析 21–35 DTE 近 ATM、Greeks、状态分类、TradingFSM/HedgeFSM、hedge gate、ExecutionGuard、真实下单；写状态到 sink、轮询控制通道。 | 已实现 + 阶段 1（sink、停止） |
| **监控与控制** | 独立进程读 sink，提供 HTTP/CLI，发停止（及后续 pause/resume）；不修改守护程序业务逻辑。 | 阶段 2 |
| **基于回测的策略优化与安全边界验证** | 历史回放驱动核心逻辑，不连 TWS、不 place_order；产出理论 P&L、收益曲线与决策/block reason；**首要用于策略 PnL 优化**，兼做 Guard 参数对比与验证。 | **阶段 4**（依赖阶段 1 历史表） |

---

## 4. 组件总览

### 4.1 自动交易（守护进程内）

| 组件 | 说明 | 代码/配置 |
|------|------|-----------|
| **IB Connector** | 连接 TWS、持仓、标的行情、下单。 | 现有 connector 层 |
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
| **Open Orders 事件订阅** | 订阅 IB orderStatusEvent、openOrderEvent（及可选 execDetailsEvent）；维护内存 open orders 列表；写入 sink 或经联动通道推送；可选 reqAllOpenOrders 包含 TWS 手动挂单。 | connector + 事件回调 + sink/联动 |

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

监控前端 Research 子页包含 Screener、Risk Model、Data、Backtest 与 **Option Discovery**（R-OD1）；Option Discovery 第一步为入口页与占位 API，后续接入期权到期/询价数据。

### 4.4 非实时市场数据拉取（Worker）

| 组件 | 说明 | 交付 |
|------|------|------|
| **任务队列** | backfill 等非实时拉取请求入队；**实现**：**Celery + Redis**（broker/result backend），任务行仍写 job_bars_backfill 表。 | 阶段 3（与 R-A3 一并） |
| **独立 Worker 进程** | Celery worker（`scripts/run_celery.py` 或 `celery -A servers.celery_app worker -Q bars`）取任务，串行执行拉取（IB 历史数据、写 stock_day/stock_min 等），任务间间隔以满足 IB Pacing。 | 阶段 3 |
| **API 入队与查询** | POST /bars/backfill（或等效）入队并返回 job_id；GET /bars/jobs、GET /bars/jobs/{id} 查询状态与结果；前端轮询 job 状态。 | 阶段 3 |

### 4.5 历史与统计（只读消费 sink 数据）

| 组件 | 说明 | 交付 |
|------|------|------|
| **历史统计脚本/模块** | 只读历史表，聚合：胜率、盈亏分布、按日/周/月、对冲次数、滑点等；**不跑** FSM/Guard。 | 阶段 3 |

### 4.6 回测（策略 PnL 优化与安全边界验证）

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
                           │ 持仓、行情、下单
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  守护进程 (GsTrading)                                                        │
│  Store ← 持仓/spot  →  解析腿 → Greeks → StateClassifier → CompositeState  │
│       → TradingFSM → hedge_gate → ExecutionGuard → (若通过) HedgeFSM → 下单  │
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

在保留上述数据流的前提下，可增加**实时行情缓存与守护→监控联动**：

- **守护进程**：除心跳写 PG 外，在 **IB 事件回调**中把行情写入 **Redis**（缓存），并通过 **Redis Pub/Sub 或 Streams** 发布「有更新」通知。
- **Redis**：仅作行情**缓存**与**联动通道**；**唯一写入方为守护进程**；监控 Server **不**向 Redis 写行情。
- **监控 Server**：订阅 Redis 联动通道；收到通知后**读 Redis**（或解析消息体），向前端推送（WebSocket/SSE 或 GET /quotes）；与守护仍**物理解耦**，仅需与守护同连 Redis。
- **未成交订单（R-A5）**：可与行情联动共用“守护事件 → 写 Redis/发布”模式；初期亦可仅写 PG/sink + GET /open-orders。

部署时 Redis 可与 PG 同机或独立；未配置或不可用时系统退化为仅 PG + 现有 GET /status 轮询，不破坏现有行为。

### 5.2 未成交订单数据流（R-A5，事件驱动）

- TWS → IB API 推送 **orderStatusEvent** / **openOrderEvent** / **execDetailsEvent** → 守护进程内 **IB Connector** 回调。
- 回调内更新内存 open orders 列表（或等价结构），并写入 **sink**（如 PG 表 `daemon_open_orders` 或现有状态表）或经 **Redis Pub/Sub/Streams** 发布（与 R-RM* 联动一致）。
- 监控 Server 读 sink 或订阅联动通道，提供 **GET /open-orders**（或 GET /status 内嵌 open_orders）；前端展示挂单列表及状态变更。
- 初期实现可仅采用「sink + GET /open-orders」；Redis 推送可在 R-RM* 落地后复用同一通道。

---

---

## 6. 部署视图

- **TWS 主机（Mac Mini ×2）**：**两台 Mac Mini** 各运行一套 TWS（或 IB Gateway），分别承载 Host 与 Secondary 账户（RE-1，§2.1）；用户通过远程桌面登录该机进行手动交易。
- **Prod 全栈（Linux 服务器 192.168.10.70）**：运行 Engine（`run_engine.py`）、Server（`run_server.py`）、Redis、Celery bars worker；经 IB API 跨网连接两台 Mac Mini 上的 TWS。单机仅一个 Engine 进程（RE-6，§2.5）。
- **Dev 开发机（Mac）**：运行 Server、Redis、Celery（Engine 可选）；连接 Dev DB 与同一两台 Mac Mini（使用与 Prod 不同的 client_id）。
- **PostgreSQL（独立主机 192.168.10.80）**：承载 **Prod DB** 与 **Dev DB**（不同 database 名，R-DV1，§2.8）；Prod 与 Dev 各连各库。
- **监控与守护（RE-5，§2.4）**：Prod 上 Engine 与 Server 同机但**进程级分离**；可选监控机物理分离变体。
- **回测与统计**：与守护程序同仓库、同 Python 环境；回测不连 TWS，统计只读 DB，可在本机或能访问 DB 的环境运行。

### 6.1 部署拓扑与启停边界（便于 Agent / 实现参考）

**选定拓扑**：**两台 Mac Mini 独占 TWS**（Host / Secondary）；**Prod 全栈在 Linux 服务器**（方案 B），经 IB API 连接 TWS；**Dev 在开发机**连 Dev DB。**PostgreSQL 在独立主机**，按 database 隔离 Dev/Prod。

- **TWS 主机（Mac Mini ×2）**：仅运行 TWS（或 IB Gateway）；操作者通过远程桌面登录进行手动交易。
- **Prod 主机（Linux 服务器 192.168.10.70）**：
  - **守护进程**（`run_engine.py`）：连接 Mac Mini 上的 TWS（Prod `client_id`），执行全部对冲逻辑（Gamma Scalping、FSM、写 status/operations）；轮询 Prod DB（`daemon_control`、`daemon_run_status`）。**运行不依赖 IB**（RE-7）：若 TWS 不可用则进入 WAITING_IB，持续写心跳（`ib_connected=false`、`next_retry_ts`）、轮询 stop/retry_ib，并按配置间隔**自动重试**连接；监控端显示**黄灯**（degraded）。收到 **stop** 则消费并退出；**suspend** / **resume** 通过 `daemon_run_status.suspended` 切换 Daemon FSM 的 RUNNING_SUSPENDED。
  - **Server**（`run_server.py`）：读 Prod DB，提供 GET /status、GET /operations、POST /control/stop 等。不提供「启动」；守护进程在本机执行 `run_engine.py`（systemd/手动）。
  - **Redis + Celery bars worker**：同机部署，串行执行 backfill 任务。
- **Dev 开发机（Mac）**：运行 Server（+ 可选 Engine/Redis/Celery）；连接 **Dev DB**；连接 TWS 时使用与 Prod 不同的 `client_id`。Dev Engine **不得**与 Prod Engine 同时对同一 IB 账户下单（R-DV3，§2.1）。
- **PostgreSQL（192.168.10.80）**：Prod DB 与 Dev DB 在同一服务器上不同 `database`；守护进程、Server、Worker 均连本环境对应库。

**启停语义**：

| 操作 | 谁处理 | 说明 |
|------|--------|------|
| **Stop** | 守护进程轮询并消费 `daemon_control` 中的 stop 后退出 | 监控端 POST /control/stop → 写 DB → 守护进程消费 stop 并退出。 |
| **Flatten** | 守护进程轮询并消费 flatten | 监控端 POST /control/flatten → 写 DB → 守护进程消费并执行。 |
| **Suspend** | 守护进程根据 `daemon_run_status.suspended=true` 进入 RUNNING_SUSPENDED | 监控端 POST /control/suspend → 写 DB → 守护进程轮询后不再执行 maybe_hedge。 |
| **Resume** | 守护进程根据 `daemon_run_status.suspended=false` 回到 RUNNING | 监控端 POST /control/resume → 写 DB → 守护进程轮询后恢复执行 maybe_hedge。 |
| **Retry IB**（RE-7） | 守护进程立即尝试连接 TWS | 监控端 POST /control/retry_ib → 写 DB → 守护进程消费后执行一次连接尝试；恢复后写回连接状态与 Client ID。 |
| **Start** | 不通过 status server | 在**守护程序主机**执行 `run_engine.py`（SSH/systemd/手动）。 |

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
│  Engine             │  │  Server              │
│  Server             │  │  Redis + Celery      │
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
| 两个 IB 账户；Host 账户：自动+行情+手动；第二账户：仅手动，统一 Portfolio（R-A4） | 配置 host_account_id（ib_host_account_id）、IB Connector、守护进程按 Host 账户对冲、监控/Performance 按 account_id 展示 | 阶段 3 |
| 两台 Mac Mini TWS（Host/Secondary）、多 account_id；自动/手动不同 client_id；Dev/Prod 不同 client_id | IB Connector、配置 | 已实现 |
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
| **实时行情与联动（R-RM*）** | 守护双线（心跳+事件）；Redis 行情缓存；Redis Pub/Sub 或 Streams 联动；监控订阅并推前端 | 见 REQUIREMENTS §6 |
| **未成交订单可观测（R-A5）** | Open Orders 事件订阅（orderStatusEvent、openOrderEvent、可选 execDetailsEvent）；维护 open orders 并写 sink 或推送；GET /open-orders；可选 reqAllOpenOrders | 阶段 3 或「实时行情与联动」步骤 |

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

**策略实例页面**：监控前端提供**策略实例**独立页面（列表 + 详情）。列表按账户、机会策略、时间范围筛选，展示 instance 元数据与汇总 PnL；详情页以单条 strategy_instance 为主体，分块展示：策略信息（来自 strategy_opportunity / strategy_structure）、盈亏（调用 GET /performance?strategy_instance_id、GET /executions?strategy_instance_id 等）、预留风险/回测/资金占用等区块。数据流：GET /strategies/instances（列表）、GET /strategies/instances/{id}（详情元数据）、GET /executions、GET /performance 按 strategy_instance_id 筛选；与 Strategy 定义页（Structure/Opportunity/Allocations）、Portfolio 账户视角（Accounts/Trade ledger/Performance）并列。

**回测**：支持从 DB 按 gate_safety_strategy_id 加载配置，或继续使用“配置文件路径 + 覆盖”。回测结果可记录 **config_hash** 或 **gate_safety_strategy_id**，与 sink 历史中的 config_summary 对齐。

### 9.4 小结

| 问题 | 建议 |
|------|------|
| 当前用文件保存安全边界配置，回测会调整这些参数，文件方式还适用吗？ | **适用**。守护进程可优先从 **DB**（settings 指定 active_gate_safety_strategy_id）加载 gates，未配置时仍用 **文件**；回测可接受“配置文件 + 覆盖”或“从 DB 按 gate_safety_strategy_id 加载”。 |
| 是否需要存到数据库？ | **已落实**：gate_safety_* 与 strategy_* 表（DATABASE.md §2.24）；settings 存当前生效 id；守护进程在 id 非空时从 DB 加载，否则回退文件。 |
| 如何按版本管理并匹配策略与回测结果？ | **最低要求**：sink 写入 **config 摘要或 config_hash**（可含 gate_safety_strategy_id）；回测输出写入 **所用参数或 gate_safety_strategy_id**。**已落实**：gate_safety_strategy 等表提供多版本；回测与实盘历史均可挂 gate_safety_strategy_id 实现一一对应。 |

---

## 9. 相关文档索引

- **[产品需求](REQUIREMENTS.md)** — 产品功能需求（守护程序、监控、金融数据采集、策略编辑/回测/历史统计、策略应用）与环境部署约束（R-DV*）
- **[运行环境与部署约束](ARCHITECTURE.md#2-运行环境与部署约束)** — 本文档 §2
- **[能力评估与进度](plans/CAPABILITY_TRACKING.md)** — 能力维度拆解与当前进度
- **[FSM 串联](fsm/FSM_LINKAGE.md)** — Daemon/Trading/Hedge 三 FSM 联动
- **[状态空间](research/STATE_SPACE_MAPPING.md)** — O,D,M,L,E,S 与代码/配置
- **[配置安全分类](research/CONFIG_SAFETY_TAXONOMY.md)** — gates 与安全边界
- **[Guard 微调与影响](research/GUARD_TUNING_AND_IMPACT.md)** — 参数调整与后果
- **§8 本文** — 安全边界配置的存储与版本管理（文件 vs 配置注册表、可追溯性、与回测结果匹配）
