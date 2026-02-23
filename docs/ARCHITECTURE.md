# 系统架构设计

本文档基于 **产品需求**（[RUN_ENVIRONMENT_AND_REQUIREMENTS.md](RUN_ENVIRONMENT_AND_REQUIREMENTS.md)）与 **分步推进计划**（[PLAN_NEXT_STEPS.md](PLAN_NEXT_STEPS.md)）做全盘系统架构设计，作为实现与评审的单一参考。FSM、状态空间、配置分类等细节见文档索引，此处只做映射与总览。

---

## 1. 架构定位与文档关系

| 文档 | 角色 |
|------|------|
| **RUN_ENVIRONMENT_AND_REQUIREMENTS.md** | 产品需求唯一定义：IB/账户、部署、监控/控制、历史与回测等。 |
| **PLAN_NEXT_STEPS.md** | 分阶段实现计划、每阶段里程碑与验收标准；验收通过方可进入下一阶段。 |
| **本文档 (ARCHITECTURE.md)** | 系统级架构：三大组成部分、组件划分、数据流、部署视图、需求→组件→阶段映射。 |
| **STATE_SPACE_MAPPING.md / FSM_LINKAGE.md / CONFIG_SAFETY_TAXONOMY.md** | 状态空间、FSM、配置安全边界等专项，此处不重复。 |

---

## 2. 三大组成部分（架构支柱）

系统由三部分组成，对应需求文档 §2，缺一不可：

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
| **基于回测的策略优化与安全边界验证** | 历史回放驱动核心逻辑，不连 TWS、不 place_order；产出理论 P&L、收益曲线与决策/block reason；**首要用于策略 PnL 优化**，兼做 Guard 参数对比与验证。 | 阶段 3.5（依赖阶段 1 历史表） |

---

## 3. 组件总览

### 3.1 自动交易（守护进程内）

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

### 3.2 状态 Sink（守护进程调用，存储由配置决定）

| 组件 | 说明 | 交付 |
|------|------|------|
| **StatusSink 抽象** | 接口：write_snapshot(snapshot)；snapshot 含 daemon_state、trading_state、symbol、spot、bid/ask、净 delta、股票持仓、option 腿数、daily_hedge_count、daily_pnl、data_lag_ms、config 摘要、ts。 | 阶段 1.1 |
| **SQLiteSink** | 单文件 SQLite：当前视图表 + 可选历史表（append/采样）。 | 阶段 1.1 首选 |
| **FileSink** | 仅当前状态写 JSON/YAML，可选/调试。 | 阶段 1.1 可选 |
| **RedisSink / PostgreSQLSink** | 同一接口，多消费者或远程集中存储。 | 阶段 3.3 按需 |

### 3.3 监控与控制（独立应用）

| 组件 | 说明 | 交付 |
|------|------|------|
| **独立应用入口** | 如 scripts/run_status_server.py；与守护进程分离进程。 | 阶段 2.1 |
| **读 sink** | 优先读 SQLite 当前视图（或文件），GET /status → JSON；可含 **自检结果**（self_check），供控制台展示与告警。 | 阶段 2.1 |
| **控制** | POST /control/stop（一键停止，R-C1）；POST /control/flatten（一键平敞口，R-C3）；可选 pause/resume（R-C2）；可选触发自检（守护进程写回 sink）。 | 阶段 2.1（stop、flatten）；细粒度 3.2（pause） |

### 3.4 历史与统计（只读消费 sink 数据）

| 组件 | 说明 | 交付 |
|------|------|------|
| **历史统计脚本/模块** | 只读历史表，聚合：胜率、盈亏分布、按日/周/月、对冲次数、滑点等；**不跑** FSM/Guard。 | 阶段 3.1 |

### 3.5 回测（策略 PnL 优化与安全边界验证）

| 组件 | 说明 | 交付 |
|------|------|------|
| **回测入口** | 如 scripts/backtest.py 或“回测模式”。 | 阶段 3.5 |
| **数据源** | 历史表或回放文件，按时间序喂 snapshot/tick。 | 依赖阶段 1 历史 |
| **复用核心** | StateClassifier、TradingFSM、ExecutionGuard、gamma_scalper_intent、apply_hedge_gates。 | 与实盘同一套 |
| **执行** | 不连 IB、不 place_order；产出 **理论 P&L、收益曲线、回撤** 及“是否对冲、方向/数量、block reason”；**首要支持策略参数优化**，兼做 Guard 对比与验证；可选多组参数批量跑。 | 阶段 3.5 |

---

## 4. 数据流

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

---

## 5. 部署视图

- **交易机（与 IB 同机）**：TWS（或 IB Gateway）与**稳定守护进程**（及可选对冲子进程）**必须同机**（RE-3）；手动交易与该机共享账户（不同 client_id）。
- **监控与交易分离（RE-5）**：**默认**为**交易机与监控机不在同一台计算机上**；status server 在监控机，交易机运行稳定守护进程（及由它启停的对冲子进程），经 PostgreSQL 通信。同机部署为可选变体。
- **交易机进程解耦（RE-6，见 RUN_ENVIRONMENT §3.2）**：交易机上**推荐**运行 **稳定守护进程**（`run_daemon.py`）与 **对冲应用**（`run_hedge_app.py`，由守护进程按监控端 resume/suspend 以子进程方式启动/关闭）。守护进程仅维护 IB 连接（占用一个 Client ID）、轮询 DB，不包含易变对冲逻辑，便于升级对冲代码时只重启对冲子进程而保留守护进程的 Client ID。
- **回测与统计**：与守护程序同仓库、同 Python 环境；回测不连 TWS，统计只读 DB，可在本机或能访问 DB 的环境运行。

### 5.1 部署拓扑与启停边界（便于 Agent / 实现参考）

**默认拓扑**：**跨机**——监控机与交易机分离；**交易机双进程**——稳定守护进程 + 对冲子进程（由守护进程按 DB 状态启停）。

- **交易机（Trading Host）**：
  - **稳定守护进程**（`run_daemon.py`）：连接 IB（占用 `ib.client_id`，如 1），**不包含对冲逻辑**；轮询 PostgreSQL（`daemon_control`、`daemon_run_status`）。**运行不依赖 IB**（RE-7）：守护进程本身**不因 IB 连接失败而退出**；若 IB 不可用则进入“等待 IB”状态（如 WAITING_IB），持续写心跳（`ib_connected=false`、`next_retry_ts`）、轮询 stop/retry_ib，并按配置间隔**自动重试**连接；监控端显示**黄灯**（degraded）表示“守护在工作但启动对冲条件不满足”，并展示**下次重试时间**；连接成功后正常 RUNNING、更新 Client ID。收到 **stop** 则消费并退出（并结束子进程）；收到 **resume**（suspended=false）则启动 **对冲应用** 子进程；收到 **suspend**（suspended=true）则安全结束子进程。该进程保持稳定、极少重启，从而长期占用同一 Client ID。
  - **对冲应用**（`run_hedge_app.py`）：由稳定守护进程在 resume 时以子进程启动；连接 IB 使用 `ib.hedge_client_id`（如 2），执行全部对冲逻辑（Gamma Scalping、FSM、写 status/operations）。升级对冲逻辑时只需重启此子进程（或由守护进程在下次 resume 时拉起新版本），无需重启稳定守护进程。
- **监控机（Monitoring Host）**：运行 **status server**（`run_status_server.py`），读 PostgreSQL，提供 GET /status、GET /operations、POST /control/stop、POST /control/flatten、POST /control/suspend、POST /control/resume。不提供「启动」；稳定守护进程在交易机执行 `run_daemon.py`（SSH/systemd/手动）。
- **PostgreSQL**：可与交易机或监控机同机或独立；稳定守护进程、对冲子进程与 status server 均需能连同一实例。

**启停语义**：

| 操作 | 谁处理 | 说明 |
|------|--------|------|
| **Stop** | 稳定守护进程轮询并**仅消费** `daemon_control` 中的 stop 后退出 | 监控端 POST /control/stop → 写 DB → 守护进程消费 stop，结束子进程并退出。 |
| **Flatten** | 对冲应用（子进程）轮询并消费 flatten | 守护进程不消费 flatten，由运行中的对冲子进程消费并执行。 |
| **Suspend** | 稳定守护进程根据 `daemon_run_status.suspended=true` 结束子进程 | 监控端 POST /control/suspend → 写 DB → 守护进程轮询后对子进程发 SIGTERM 等安全退出。 |
| **Resume** | 稳定守护进程根据 `daemon_run_status.suspended=false` 启动子进程 | 监控端 POST /control/resume → 写 DB → 守护进程轮询后 subprocess 启动 `run_hedge_app.py`。 |
| **Retry IB**（RE-7） | 稳定守护进程立即尝试连接 IB | 监控端 POST /control/retry_ib（或 daemon_control 写入 retry_ib）→ 守护进程消费后执行一次连接尝试；恢复后写回连接状态与 Client ID。 |
| **Start** | 不通过 status server | 在交易机执行 `run_daemon.py`（SSH/systemd/手动）。 |

**拓扑示意（默认：交易机与监控机分离；交易机双进程）**：

```
[ 操作者：浏览器 → 监控机 status server :8765 ]
                    │
                    │ GET /status, GET /operations
                    │ POST /control/stop, suspend, resume, flatten  → 写 daemon_control / daemon_run_status
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  监控机 (Monitoring Host)                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Status Server (run_status_server.py)                             │   │
│  │  读/写 PostgreSQL ←───────────────────────────────────────────────┼───┼──→ 同一 PostgreSQL
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                    ▲
                    │ 读 status_current, operations；写 daemon_control, daemon_run_status
                    │
┌─────────────────────────────────────────────────────────────────────────┐
│  交易机 (Trading Host) — 与 IB 同机                                       │
│  ┌─────────────┐   ┌─────────────────────────────────────────────────┐   │
│  │ TWS/Gateway │   │ 稳定守护进程 (run_daemon.py)                      │   │
│  │             │◄──│  IB client_id=1（仅占连接，无对冲逻辑）             │   │
│  └─────────────┘   │  轮询 DB：stop→退出；suspend→结束子进程；resume→   │   │
│         ▲          │  启动 run_hedge_app.py 子进程                       │   │
│         │          └───────────────────────┬─────────────────────────┘   │
│         │ client_id=2                     │ subprocess 启停              │
│         │          ┌───────────────────────▼─────────────────────────┐   │
│         └──────────│ 对冲应用 (run_hedge_app.py，子进程)                │   │
│                    │  StatusSink 写 PostgreSQL；消费 flatten            │   │
│                    └────────────────────────────────────────────────┘   │
│  启动：本机执行 run_daemon.py（SSH/systemd/手动）                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**单进程模式（可选）**：在交易机直接运行 `run_engine.py`（或 `run_hedge_app.py` 且不设 BIFROST_UNDER_DAEMON）时，为单进程：同一进程既连 IB 又执行对冲逻辑，并自行轮询 stop/suspend/resume。适用于试跑或不需要长期占用固定 Client ID 的场景。

---

## 6. 需求 → 组件 → 阶段映射

| 产品需求（RUN_ENVIRONMENT 节） | 对应组件 | 交付阶段 |
|--------------------------------|----------|----------|
| 单一 TWS、单一账户；自动/手动不同 client_id | IB Connector、配置 | 已实现 |
| 守护程序单进程单线程、与 TWS 同机 | DaemonFSM、run_engine、部署文档 | 已实现 |
| 监控：不依赖控制台查看状态 | StatusSink + SQLite/文件；独立应用 GET /status | 阶段 1.1 + 阶段 2.1 |
| 监控：状态自检（健康结论与 block 原因） | 守护进程自检结果写入 sink；监控控制台展示/告警 | 与阶段 2 一并考虑 |
| 监控：红绿灯（红/黄/绿一目了然） | 独立应用或 UI 基于 self_check 展示 status_lamp: green/yellow/red | 阶段 2（R-M3） |
| 监控：操作可查（执行记录，尤其持仓变化） | 守护进程写操作/事件到 sink；独立应用 GET /operations 或等效查询 | 阶段 1（写）+ 阶段 2（R-M4 查询） |
| 控制：一键停止（R-C1） | SIGTERM/SIGINT、控制文件；独立应用 POST /control/stop | 阶段 1.2/1.3 + 阶段 2.1 |
| 控制：一键平敞口（R-C3，安全兜底） | 控制通道 flatten；守护进程平掉本策略对冲敞口并写操作记录；独立应用 POST /control/flatten | 阶段 2（或 3.2） |
| 控制后续：暂停/恢复（R-C2） | 控制通道 trading_paused；独立应用发 pause/resume | 阶段 3.2 |
| 状态可扩展为带历史 | SQLite 当前表 + 历史表；sink 抽象 | 阶段 1.1 |
| 历史数据与统计 | 独立脚本/模块只读历史表聚合 | 阶段 3.1 |
| 回测（策略 PnL 优化 + Guard 验证） | 回测入口 + 复用 Classifier/FSM/Guard，历史回放；产出 PnL/收益曲线，首要优化策略回报 | 阶段 3.5 |
| 部署 A/B（Mac vs Linux）、进程管理 | 文档、可选 systemd/supervisor 示例 | 阶段 3.4 |
| 多消费者/远程存储可选 | RedisSink/PostgreSQLSink | 阶段 3.3 |

---

## 7. 与分步计划的对应关系

- **阶段 1**：在守护进程内引入 StatusSink 抽象与 SQLiteSink（及可选 FileSink）、信号停止、可选控制文件；架构上完成“自动交易写状态 + 可被外部停止”。
- **阶段 2**：独立应用读 sink、提供 GET /status 与 POST /control/stop；架构上完成“监控与控制”支柱的落地。
- **阶段 3**：历史统计（3.1）、细粒度控制（3.2）、可选 sink（3.3）、部署与进程管理（3.4）、回测（3.5）；架构上完成“历史可查、可暂停、可换 sink、可部署、可回测优化策略 PnL 并验证 Guard”。

各阶段 **里程碑、检查方式、验证标准** 以 [PLAN_NEXT_STEPS.md](PLAN_NEXT_STEPS.md) 为准；**本阶段验收通过后，方可启动下一阶段开发**。

---

## 8. 安全边界配置的存储与版本管理

当前与安全边界相关的配置（gates.strategy / state / intent / guard 等）均在 **YAML 文件** 中，守护进程通过文件路径加载并支持热重载。回测阶段会对这些参数做多组调整与对比，因此需要：**（1）实盘/回测各自使用的参数集可追溯；（2）能与“哪次交易、哪次回测”对应，便于匹配策略版本与回测结果。**

### 8.1 是否改为数据库存储？

| 方式 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| **文件** | 守护进程 **运行时** 的唯一下发源；回测可接受“配置文件路径 + 可选覆盖”。 | 简单、可热重载、无需 DB 依赖、可用 git 管理文件即版本。 | 多组参数多文件或需运行时覆盖；版本与“某次运行”的对应需通过 **写入 sink/回测输出** 来记录。 |
| **数据库（配置注册表）** | 存多份“配置版本”，每份有 version_id/name；守护进程与回测均可按 version 加载。 | 集中管理、易做参数扫描与对比、实盘/回测结果都可挂 config_version_id。 | 守护进程需支持“从 DB 取某版本再跑”或“导出为文件再跑”；多一套存储与迁移。 |

**结论**：  
- **不必** 把“当前运行用哪份配置”的 **运行时来源** 从文件改为 DB；守护进程继续用 **文件** 作为单源即可，热重载保留。  
- **必须** 的是：**每次写入状态或回测输出时，都带上“当时生效的配置标识”**，这样历史/回测才能与策略版本对应。  
- 若后续需要集中管理多组参数、按版本切换、与回测结果表关联，可再引入 **配置注册表**（见下），与“运行时仍用文件”兼容。

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

### 8.3 配置注册表（按需演进）

若需要 **多组参数集中管理、按版本切换、与回测结果表一一对应**，可增加 **配置注册表**：

- **存储**：与状态 sink 同库或独立库均可。表结构示例：`config_registry(id, version_name, config_json, created_at)`，其中 `config_json` 为完整 gates（及必要顶层项）的 JSON。
- **守护进程**：仍以 **文件** 为运行时来源。切换版本时：从注册表导出所选版本的 `config_json` 写为当前使用的 config 文件，再热重载或重启；或启动时指定“使用注册表中 version_id=X”并导出到临时文件后加载。这样不改动“从文件读配置”的主流程。
- **回测**：支持从注册表按 `version_id` 加载配置，或继续使用“配置文件路径 + 覆盖”。回测结果表增加 `config_version_id`（或 `config_hash`），与 `config_registry` 或与 sink 历史中的 config_hash 对齐。
- **匹配关系**：实盘某时段 ↔ sink 中 config_hash / config_version_id；回测某 run ↔ 回测结果中的 config_version_id / config_hash；二者一致即“同一策略版本”。

### 8.4 小结

| 问题 | 建议 |
|------|------|
| 当前用文件保存安全边界配置，回测会调整这些参数，文件方式还适用吗？ | **适用**。守护进程继续用 **文件** 作为运行时配置源；回测可接受“配置文件 + 覆盖”或“从注册表加载某版本”。 |
| 是否需要存到数据库？ | **运行时不必**；若需多版本管理与回测结果关联，可增加 **配置注册表**（DB），守护进程仍通过“导出为文件”或“按版本生成文件”使用。 |
| 如何按版本管理并匹配策略与回测结果？ | **最低要求**：sink 写入 **config 摘要或 config_hash**；回测输出写入 **所用参数或 config_version/config_hash**；可选在 YAML 中设 `config_version` 或在注册表中维护版本。**进阶**：配置注册表 + 回测结果表与实盘历史表均带 config_version_id/config_hash，实现策略版本与回测结果的一一对应。 |

---

## 9. 相关文档索引

- **[运行环境与需求](RUN_ENVIRONMENT_AND_REQUIREMENTS.md)** — 产品需求唯一定义
- **[分步推进计划](PLAN_NEXT_STEPS.md)** — 阶段划分与验收
- **[FSM 串联](fsm/FSM_LINKAGE.md)** — Daemon/Trading/Hedge 三 FSM 联动
- **[状态空间](STATE_SPACE_MAPPING.md)** — O,D,M,L,E,S 与代码/配置
- **[配置安全分类](CONFIG_SAFETY_TAXONOMY.md)** — gates 与安全边界
- **[Guard 微调与影响](GUARD_TUNING_AND_IMPACT.md)** — 参数调整与后果
- **§8 本文** — 安全边界配置的存储与版本管理（文件 vs 配置注册表、可追溯性、与回测结果匹配）
