# 系统架构设计

本文档基于 **产品需求**（[REQUIREMENTS.md](REQUIREMENTS.md)）与 **分步推进计划**（[PLAN_NEXT_STEPS.md](PLAN_NEXT_STEPS.md)）做全盘系统架构设计，作为实现与评审的单一参考。**运行环境与部署约束**（单 TWS/账户、TWS 独占 Mac Mini、守护程序可选同机或 Linux、监控与交易分离等）在本文档 §2；FSM、状态空间、配置分类等细节见文档索引，此处只做映射与总览。

---

## 1. 架构定位与文档关系

| 文档 | 角色 |
|------|------|
| **REQUIREMENTS.md** | 产品功能需求唯一定义：监控、控制、历史、回测、交易基础等（R-M*/R-C*/R-H*/R-B*/R-A*）。 |
| **本文档 (ARCHITECTURE.md)** | 系统级架构：**运行环境与部署约束**（§2）、三大组成部分、组件划分、数据流、部署视图、需求→组件→阶段映射。 |
| **PLAN_NEXT_STEPS.md** | 分阶段实现计划、每阶段里程碑与验收标准；验收通过方可进入下一阶段。 |
| **STATE_SPACE_MAPPING.md / FSM_LINKAGE.md / CONFIG_SAFETY_TAXONOMY.md** | 状态空间、FSM、配置安全边界等专项，此处不重复。 |

---

## 2. 运行环境与部署约束

以下为**运行环境与约束**的唯一定义；产品功能需求不因运行环境不同而改变，见 [REQUIREMENTS.md](REQUIREMENTS.md)。

### 2.1 IB / TWS 与账户（RE-1）

- **数据与下单**：均通过 IB API 来自 **TWS**（Trader Workstation）。
- **账户**：**单一 IB 账户**。
- **使用方式**：该账户需同时支持 **自动交易**（本项目 Gamma scalping 逻辑）与 **手动交易**（用户交易其他标的和策略），二者**共享同一账户和保证金**。
- **实现方式**：TWS 允许多个 API 连接，用不同的 **client_id** 区分。守护程序使用一个 `client_id`（如 1）；手动交易使用 TWS 界面或另一 `client_id`（如 2）的客户端。**不需要**开两个 TWS 实例。

### 2.2 架构支柱（RE-2）

系统由三部分组成，缺一不可（详见下文 §3）：

| 组成部分 | 说明 |
|----------|------|
| **自动交易** | 以 **单进程、单线程**（单一 asyncio 事件循环）的 **守护程序** 实现；负责连接 TWS、持仓/行情、StateClassifier、FSM、Guard、下单等。 |
| **监控与控制** | 与守护程序 **物理解耦**；状态的读取、控制指令的发送由 **独立应用** 完成。 |
| **基于回测的策略优化与安全边界验证** | 历史回放驱动同一套 StateClassifier、FSM、Guard 逻辑，**不连 TWS、不下真实单**；首要用于策略 PnL 优化，兼做 Guard 验证（见 REQUIREMENTS.md §4）。 |

### 2.3 部署与运行位置（RE-3、RE-4）

受 IB 限制，**TWS（或 IB Gateway）单独运行在一台专用的 Mac Mini 上**，该机仅承担 TWS 与手动交易入口角色。操作者通过 **MacBook Air 等设备远程登录该 Mac Mini** 后进行手动交易。**守护程序**可在以下两种位置之一运行，并通过 IB API 连接该 Mac Mini 上的 TWS 获取行情与下单：

| 方案 | TWS 所在 | 守护程序所在 | 说明 |
|------|----------|--------------|------|
| **A. Mac Mini 同机** | 专用 Mac Mini | **同一台 Mac Mini** | 守护程序与 TWS 同机，经本机 API 连接 TWS；部署简单，延迟最低。 |
| **B. Linux 服务器** | 专用 Mac Mini | **另一台 Linux 服务器** | 守护程序在 Linux 上运行，经**网络**连接 Mac Mini 上的 TWS 获取行情数据并下单；TWS 需允许来自局域网的 API 连接。 |

- **TWS 主机（Mac Mini）**：仅运行 TWS（或 IB Gateway）；不强制要求本机再跑守护程序。用户通过远程桌面（如 MacBook Air 远程登录）在该 Mac Mini 上进行手动交易，与自动交易共享同一账户（不同 client_id）。
- **守护程序主机**：可为上述 Mac Mini（方案 A），或局域网内另一台 Linux 服务器（方案 B）；仅运行 `run_engine.py` 单进程，连接 TWS、执行对冲逻辑、写状态与心跳。
- **监控范围（RE-4）**：仅操作者本人、**家庭/办公室局域网**；不要求公网或手机。

### 2.4 监控服务与交易服务分离（RE-5）

**默认部署**：**监控机与守护程序所在主机分离**。守护进程运行在**守护程序主机**（Mac Mini 或 Linux 服务器，见 §2.3），status server 运行在**监控机**（如操作者日常使用的 MacBook Air 等），二者通过同一 PostgreSQL 通信；同机部署为可选变体。

- **TWS 主机（Mac Mini）**：仅运行 TWS；用户远程登录该机进行手动交易。
- **守护程序主机**：运行 `run_engine.py`，连接 Mac Mini 上的 TWS（同机或跨网），执行对冲、写状态与心跳；可为 Mac Mini（与 TWS 同机）或 Linux 服务器。
- **监控服务**：与守护进程**物理解耦**，**默认运行在局域网内另一台主机**（监控机）；控制通道采用 **PostgreSQL 表 `daemon_control`**（见 [DATABASE.md](DATABASE.md) §2.4）。跨机与同机均只需能连**同一 PostgreSQL**。
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

---

## 3. 三大组成部分（架构支柱）

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

### 4.4 历史与统计（只读消费 sink 数据）

| 组件 | 说明 | 交付 |
|------|------|------|
| **历史统计脚本/模块** | 只读历史表，聚合：胜率、盈亏分布、按日/周/月、对冲次数、滑点等；**不跑** FSM/Guard。 | 阶段 3 |

### 4.5 回测（策略 PnL 优化与安全边界验证）

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

---

## 6. 部署视图

- **TWS 主机（Mac Mini）**：受 IB 限制，**TWS（或 IB Gateway）单独运行在一台专用 Mac Mini 上**；用户通过 MacBook Air 等远程登录该机进行手动交易（RE-3，见 §2.3）。
- **守护程序主机**：可为同一台 Mac Mini（与 TWS 同机）或**另一台 Linux 服务器**；运行 `run_engine.py`，经 IB API 连接 Mac Mini 上的 TWS 获取行情并下单。单机仅运行单进程（RE-6，§2.5）。
- **监控与守护分离（RE-5，§2.4）**：默认监控机与守护程序主机分离；status server 在监控机，经 PostgreSQL 与守护程序通信。
- **回测与统计**：与守护程序同仓库、同 Python 环境；回测不连 TWS，统计只读 DB，可在本机或能访问 DB 的环境运行。

### 6.1 部署拓扑与启停边界（便于 Agent / 实现参考）

**默认拓扑**：**TWS 独占 Mac Mini**；**守护程序**在 Mac Mini（同机）或 Linux 服务器上单进程运行，经 IB API 连接 TWS；**监控机**与守护程序主机分离，经 PostgreSQL 通信。

- **TWS 主机（Mac Mini）**：仅运行 TWS（或 IB Gateway）；操作者通过 MacBook Air 等远程登录该机进行手动交易。若采用方案 A，本机同时运行守护进程。
- **守护程序主机（Mac Mini 或 Linux 服务器）**：
  - **守护进程**（`run_engine.py`）：连接 Mac Mini 上的 TWS（`ib.client_id` 如 1），执行全部对冲逻辑（Gamma Scalping、FSM、写 status/operations）；轮询 PostgreSQL（`daemon_control`、`daemon_run_status`）。**运行不依赖 IB**（RE-7）：若 TWS 不可用则进入 WAITING_IB，持续写心跳（`ib_connected=false`、`next_retry_ts`）、轮询 stop/retry_ib，并按配置间隔**自动重试**连接；监控端显示**黄灯**（degraded）。收到 **stop** 则消费并退出；**suspend**/ **resume** 通过 `daemon_run_status.suspended` 切换 Daemon FSM 的 RUNNING_SUSPENDED，同一进程内不再执行 maybe_hedge 或恢复执行。
- **监控机（Monitoring Host）**：运行 **status server**（`run_server.py`），读 PostgreSQL，提供 GET /status、GET /operations、POST /control/stop、POST /control/flatten、POST /control/suspend、POST /control/resume。不提供「启动」；守护进程在**守护程序主机**执行 `run_engine.py`（SSH/systemd/手动）。
- **PostgreSQL**：可与守护程序主机或监控机同机或独立；守护进程与 status server 均需能连同一实例。

**启停语义**：

| 操作 | 谁处理 | 说明 |
|------|--------|------|
| **Stop** | 守护进程轮询并消费 `daemon_control` 中的 stop 后退出 | 监控端 POST /control/stop → 写 DB → 守护进程消费 stop 并退出。 |
| **Flatten** | 守护进程轮询并消费 flatten | 监控端 POST /control/flatten → 写 DB → 守护进程消费并执行。 |
| **Suspend** | 守护进程根据 `daemon_run_status.suspended=true` 进入 RUNNING_SUSPENDED | 监控端 POST /control/suspend → 写 DB → 守护进程轮询后不再执行 maybe_hedge。 |
| **Resume** | 守护进程根据 `daemon_run_status.suspended=false` 回到 RUNNING | 监控端 POST /control/resume → 写 DB → 守护进程轮询后恢复执行 maybe_hedge。 |
| **Retry IB**（RE-7） | 守护进程立即尝试连接 TWS | 监控端 POST /control/retry_ib → 写 DB → 守护进程消费后执行一次连接尝试；恢复后写回连接状态与 Client ID。 |
| **Start** | 不通过 status server | 在**守护程序主机**执行 `run_engine.py`（SSH/systemd/手动）。 |

**拓扑示意（TWS 独占 Mac Mini；守护程序可选同机或 Linux；监控机分离）**：

```
[ 操作者：MacBook Air 等 ]  ──远程登录──►  [ TWS 主机 Mac Mini ]  ◄── IB API ──  守护程序（同机或 Linux）
        │                                            │ 仅 TWS              │
        │ 浏览器                                      │ 手动交易            │ run_engine.py
        ▼                                            │                     │ 轮询 DB、写状态
┌───────────────────────────────────┐                │                     │
│  监控机 (Monitoring Host)          │                │  方案 A：同机       │
│  Status Server (run_server.py)    │◄── PostgreSQL ─┼─────────────────────┘
│  读/写 daemon_control 等           │                │
└───────────────────────────────────┘                │  方案 B：守护程序在 Linux 服务器
                                                      │  Linux ◄── IB API ──┘
```

---

## 7. 需求 → 组件 → 阶段映射

| 产品需求（REQUIREMENTS.md） | 对应组件 | 交付阶段 |
|--------------------------------|----------|----------|
|--------------------------------|----------|----------|
| 单一 TWS、单一账户；自动/手动不同 client_id | IB Connector、配置 | 已实现 |
| TWS 独占 Mac Mini；守护程序可选同机或 Linux 单进程 | DaemonFSM、run_engine、部署文档（§2.3） | 已实现 |
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
| 多消费者/远程存储可选 | RedisSink/PostgreSQLSink | 按需 |

---

## 8. 与分步计划的对应关系

- **阶段 1**：在守护进程内引入 StatusSink 抽象与 SQLiteSink（及可选 FileSink）、信号停止、可选控制文件；架构上完成“自动交易写状态 + 可被外部停止”。
- **阶段 2**：独立应用读 sink、提供 GET /status 与 POST /control/stop；架构上完成“监控与控制”支柱的落地。
- **阶段 3**：数据获取（账户、持仓、市值、交易历史与统计）；架构上完成策略与监控所需数据的获取。
- **阶段 4**：策略框架与回测（R-B1、R-B2）；架构上完成“可回测优化策略 PnL 并验证 Guard”。
- **阶段 5**：自动交易对冲与监控（R-C2、R-C3）；架构上完成暂停/恢复、一键平敞口等。

各阶段 **里程碑、检查方式、验证标准** 以 [PLAN_NEXT_STEPS.md](PLAN_NEXT_STEPS.md) 为准；**本阶段验收通过后，方可启动下一阶段开发**。

---

## 9. 安全边界配置的存储与版本管理

当前与安全边界相关的配置（gates.strategy / state / intent / guard 等）均在 **YAML 文件** 中，守护进程通过文件路径加载并支持热重载。回测阶段会对这些参数做多组调整与对比，因此需要：**（1）实盘/回测各自使用的参数集可追溯；（2）能与“哪次交易、哪次回测”对应，便于匹配策略版本与回测结果。**

### 9.1 是否改为数据库存储？

| 方式 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| **文件** | 守护进程 **运行时** 的唯一下发源；回测可接受“配置文件路径 + 可选覆盖”。 | 简单、可热重载、无需 DB 依赖、可用 git 管理文件即版本。 | 多组参数多文件或需运行时覆盖；版本与“某次运行”的对应需通过 **写入 sink/回测输出** 来记录。 |
| **数据库（配置注册表）** | 存多份“配置版本”，每份有 version_id/name；守护进程与回测均可按 version 加载。 | 集中管理、易做参数扫描与对比、实盘/回测结果都可挂 config_version_id。 | 守护进程需支持“从 DB 取某版本再跑”或“导出为文件再跑”；多一套存储与迁移。 |

**结论**：  
- **不必** 把“当前运行用哪份配置”的 **运行时来源** 从文件改为 DB；守护进程继续用 **文件** 作为单源即可，热重载保留。  
- **必须** 的是：**每次写入状态或回测输出时，都带上“当时生效的配置标识”**，这样历史/回测才能与策略版本对应。  
- 若后续需要集中管理多组参数、按版本切换、与回测结果表关联，可再引入 **配置注册表**（见下），与“运行时仍用文件”兼容。

### 9.2 可追溯性（最低要求）

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

### 9.3 配置注册表（按需演进）

若需要 **多组参数集中管理、按版本切换、与回测结果表一一对应**，可增加 **配置注册表**：

- **存储**：与状态 sink 同库或独立库均可。表结构示例：`config_registry(id, version_name, config_json, created_at)`，其中 `config_json` 为完整 gates（及必要顶层项）的 JSON。
- **守护进程**：仍以 **文件** 为运行时来源。切换版本时：从注册表导出所选版本的 `config_json` 写为当前使用的 config 文件，再热重载或重启；或启动时指定“使用注册表中 version_id=X”并导出到临时文件后加载。这样不改动“从文件读配置”的主流程。
- **回测**：支持从注册表按 `version_id` 加载配置，或继续使用“配置文件路径 + 覆盖”。回测结果表增加 `config_version_id`（或 `config_hash`），与 `config_registry` 或与 sink 历史中的 config_hash 对齐。
- **匹配关系**：实盘某时段 ↔ sink 中 config_hash / config_version_id；回测某 run ↔ 回测结果中的 config_version_id / config_hash；二者一致即“同一策略版本”。

### 9.4 小结

| 问题 | 建议 |
|------|------|
| 当前用文件保存安全边界配置，回测会调整这些参数，文件方式还适用吗？ | **适用**。守护进程继续用 **文件** 作为运行时配置源；回测可接受“配置文件 + 覆盖”或“从注册表加载某版本”。 |
| 是否需要存到数据库？ | **运行时不必**；若需多版本管理与回测结果关联，可增加 **配置注册表**（DB），守护进程仍通过“导出为文件”或“按版本生成文件”使用。 |
| 如何按版本管理并匹配策略与回测结果？ | **最低要求**：sink 写入 **config 摘要或 config_hash**；回测输出写入 **所用参数或 config_version/config_hash**；可选在 YAML 中设 `config_version` 或在注册表中维护版本。**进阶**：配置注册表 + 回测结果表与实盘历史表均带 config_version_id/config_hash，实现策略版本与回测结果的一一对应。 |

---

## 10. 相关文档索引

- **[产品需求](REQUIREMENTS.md)** — 产品功能需求按五类定义（守护程序、监控、金融数据采集、策略编辑/回测/历史统计、策略应用）
- **[运行环境与部署约束](ARCHITECTURE.md#2-运行环境与部署约束)** — 本文档 §2
- **[分步推进计划](PLAN_NEXT_STEPS.md)** — 阶段划分与验收
- **[FSM 串联](fsm/FSM_LINKAGE.md)** — Daemon/Trading/Hedge 三 FSM 联动
- **[状态空间](STATE_SPACE_MAPPING.md)** — O,D,M,L,E,S 与代码/配置
- **[配置安全分类](CONFIG_SAFETY_TAXONOMY.md)** — gates 与安全边界
- **[Guard 微调与影响](GUARD_TUNING_AND_IMPACT.md)** — 参数调整与后果
- **§9 本文** — 安全边界配置的存储与版本管理（文件 vs 配置注册表、可追溯性、与回测结果匹配）
