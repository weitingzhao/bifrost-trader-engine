# 产品需求

本文档是 **Bifrost Trader Engine** 的**产品需求**唯一定义。**功能需求**（R-M*/R-C*/R-H*/R-B*/R-A*、**R-IB*** 等）不随运行环境变化；**环境与部署约束**（R-DV*）定义 Dev/Prod 隔离、共享 TWS 纪律及**可选调试拓扑**（R-DV4：多 UI 只读同一 Redis 行情），详见本文档 §7 及 [ARCHITECTURE.md](ARCHITECTURE.md) §2。

能力进度与差距评估见 [CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

---

## 产品需求分类（总览）

产品需求按以下类别组织：

| 分类 | 需求编号 | 需求简述 | 说明章节 |
|------|----------|----------|----------|
| **a. 守护程序相关** | **R-H1** | 状态可扩展为带历史：写入接口支持“当前 + 历史”，避免先文件后迁库。 | §1.1 |
| | **R-C1** | 一键停止：能在局域网内停止守护程序（含优雅退出）；停止后不再下发任何新单；须支持通过监控 Web 界面发起停止。 | §1.2 |
| | **R-C2** | 暂停/恢复自动对冲；暂停期间不下新单，监控与自检仍可用。 | §1.3 |
| **b. 监控相关** | **R-M1** | 状态可观测：运行状态（持仓、FSM、指标、配置摘要）可不依赖控制台查看。 | §2.1 |
| | **R-M2** | 状态自检：可对守护程序发起自检，得到健康结论（ok/degraded/blocked）与 block_reasons。 | §2.2 |
| | **R-M3** | 红绿灯监控：监控界面须提供红/黄/绿式状态指示，一目了然识别运行是否正常。 | §2.1 |
| | **R-M4** | 操作可查：能查询执行过的操作，尤其涉及持仓变化的操作（对冲下单、成交、撤单等）。 | §2.3 |
| | **R-M5** | 监控 Web 界面：操作者通过浏览器访问监控应用，直观查看守护进程运行状态（红绿灯、自检、状态摘要、操作列表），并通过界面发起停止等控制。 | §2.4 |
| | **R-M7** | 复盘与风控分析页面：独立于实时监控的复盘与风控分析页面（账户执行交易、辅助行情、风控评估）。 | §2.5 |
| | **R-M8** | 组合级模型化回报与风险：在明确假设下基于当前持仓与账户摘要，计算理论盈亏边界、CAR/DTE 年化、Delta、压力矩阵等；与会计绩效（R-M7）区分展示。 | §2.6 |
| **c. 金融数据采集** | **R-A1** | 账户与持仓可获取：从 IB 获取当前账户基本信息与当前持仓，作为自动交易对冲的基本能力。 | §3.1 |
| | **R-A4** | 双 IB 账户与统一 Portfolio：支持两账户；主账户自动+行情，第二账户仅手动；统一 Portfolio 展示与管理。 | §3.1.1 |
| | **R-A2** | 账户执行交易可获取：从 IB 获取账户执行/成交记录（含手动与机器），用于事后复盘与风控。 | §3.3 |
| | **R-A5** | 未成交订单可观测（事件驱动）：以事件驱动方式获取并展示当前未成交订单（Limit 挂单等）。 | §3.3.1 |
| | **R-A3** | 复盘辅助行情可获取：为复盘与风控分析提供辅助行情数据（如 K 线、历史 tick 等）。 | §3.4 |
| | **R-A6** | Massive 期权研究数据：从 Massive（Polygon）获取期权链、快照、聚合 K 线、Greeks/IV、日终 OI、参考数据与公司行动等，作为期权研究主力数据源；分级能力（Starter / Developer）。 | §3.5 |
| | **R-A7** | 美股标的参考数据：从 Massive（Polygon）Stocks 参考类 REST（All Tickers、Ticker Overview、Ticker Types、Related Tickers）拉取并持久化至 PostgreSQL，支持更新策略与查询/联想（含 Research UI）；与 R-A6 互补；**不依赖 IB** 作为标的元数据来源。 | §3.5.1 |
| | **R-A8** | 股票筛选与基本面数据：基于 Massive Stocks 的技术面与基本面接口，支持 SEPA 等股票筛选（技术面 + EPS/Revenue 增长与加速），并形成可复用筛选结果接口。 | §3.5.2 |
| | **R-M6** | 标的与持仓当前市价可获取：监控页须能获取并展示交易标的与持仓的当前市价（spot/last/mid 等），供评估持仓盈亏、期权虚实与风险。 | §3.2 |
| **d. 策略编辑、回测与历史统计** | **R-H2** | 历史统计：基于历史数据做胜率、盈亏分布、按日/周/月汇总、对冲次数与滑点等。 | §4.1 |
| | **R-B1** | 策略 PnL 优化：在历史数据上对比不同参数的理论 P&L、收益曲线、回撤等，优化策略回报。 | §4.2 |
| | **R-B2** | 安全边界验证：Guard/边界参数可验证；不同参数下对冲与拦截次数及原因可复盘。 | §4.2 |
| | **R-OS1** | 期权结构细化：每种结构类型对应明确腿模式与可选盈亏模型，便于校验、风控与监控。 | §4.4 |
| **e. 策略应用（自动交易）** | **R-C3** | 一键平敞口：异常或红时可一键平掉本策略管理的对冲敞口；仅针对本守护程序负责的对冲仓位。依赖 R-A1 及策略边界等。 | §5 |
| **f. 实时行情与联动** | **R-RM1** | 守护进程心跳循环 + **消费**行情与账户更新（来源为 IB Ingestor / IB Account Agent 写入的 Redis）；轮询主要用于控制通道。 | §6 |
| | **R-RM2** | IB Ingestor 将订阅所得行情写入 Redis；IB Account Agent 将账户域事件结果写入 Redis；监控 Server 不写上述业务 Redis 键；Daemon 不写行情唯一真源键。 | §6 |
| | **R-RM3** | Ingestor/Account Agent 写 Redis 后通过 Pub/Sub 或 Streams 通知监控；监控订阅后读 Redis 并推前端。 | §6 |
| **g. 研究与发现** | **R-OD1** | 期权发现入口：Research 下提供 Option Discovery 子页，可选标的（来自 Watchlist STK）与到期日，为按到期询价与机会发现提供入口；主力数据源为 Massive（R-A6），IB 作交叉校验或降级路径。 | §2.7 |
| **h. 环境与部署** | **R-DV1** | Dev/Prod PostgreSQL 逻辑隔离：独立 database，各进程仅连本环境库，settings 与业务数据不跨环境混用。 | §7 |
| | **R-DV2** | 生产在 Linux 服务器部署完整运行栈（Engine、Server、Redis、Celery）；开发在本机连 Dev 库。 | §7 |
| | **R-DV3** | IB/TWS 为共享基础设施（两台 Mac Mini）；Dev/Prod 通过不同 client_id 或 TWS 端口区分；同一 IB 账户同一时刻仅一个 Engine 下单。 | §7 |
| | **R-DV4** | 调试拓扑下多套 Monitor/Market 只读同一 Redis 实时行情（**单点 IB Ingestor** 写入行情键；与 Daemon 是否同机无关）；PG 仍隔离（R-DV1），Engine 互斥不变（R-DV3）。 | §7 |
| **i. IB 边缘服务与 Daemon 边界（目标架构）** | **R-IB1** | IB Ingestor 独占行情类 IB 订阅（Watchlist + 按需 `reqMktData`），行情数据写入 Redis；监控只读。 | §3.6 |
| | **R-IB2** | IB Account Agent 独占账户域 IB 事件订阅，只更新 Redis；不写入 PostgreSQL。 | §3.6 |
| | **R-IB3** | IB Operator 仅主动 IB 调用与 Redis Stream RPC；不承担任何 IB 订阅型服务。 | §3.6 |
| | **R-IB4** | Daemon 不直连 IB；从 Redis 消费行情与账户态势；账户类持久化由 Daemon（或约定的同类消费者）根据 Redis 写入 PG；交易执行经 Operator RPC。 | §3.6 |

**说明**：「说明章节」列指向本文档中该需求的细节描述位置。能力进度见 [CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

---

## 1. 守护程序相关（a）

### 1.1 状态可扩展为带历史（R-H1）

- **目标**：sink 写入接口支持“当前视图 + 历史表”，避免先文件后迁库；后续增加历史查询或统计时无需修改守护程序写逻辑。
- **范围**：sink 表结构或写入接口同时支持当前视图（单行或最新 ts）与历史表（append 或按间隔采样）；配置可选择 sink 类型与路径，守护程序按配置写入。

### 1.2 一键停止（R-C1）

- **目标**：能在局域网内**停止**守护程序（含优雅退出）；停止后**不再下发任何新单**；须支持通过**监控 Web 界面**发起停止。
- **范围**：R-C1a 信号/控制文件（阶段 1）；R-C1b 独立应用发停止 + Web UI（阶段 2）。**日常启停（生产）**：与 Socket Services 同源，经 **Ops 控制面**（`GET/POST /ops/market-ingest/*`）对 **`bifrost-engine.service`** 执行 **systemd start/stop/restart**；**systemd stop** 发送 SIGTERM，进程优雅退出并更新 **`daemon_heartbeat`**（如 `graceful_shutdown_at`），与现有一键停止目标一致。**备选**：监控端 **POST /control/stop** 写 `daemon_control`，由 Engine 轮询消费后退出（例如仅 DB 可达、不经 Ops 时）。**开发与排障**：仍可在交易机直接执行 `run_engine.py` 或等价的本地启动方式。

### 1.3 暂停/恢复（R-C2）

- **目标**：细粒度控制——**暂停**期间不再下发新的对冲单，但守护进程保持运行，监控与自检仍可用；**恢复**后继续正常对冲。适用于黄灯时“先暂停新单、观察再决定是否停止或平敞口”。

---

## 2. 监控相关（b）

### 2.1 状态可观测与红绿灯（R-M1、R-M3）

- **目标（R-M1）**：守护程序的运行状态（持仓、FSM 状态、指标、配置摘要）必须能**不依赖控制台**查看（经 sink → 独立应用）。
- **红绿灯（R-M3，必须）**：监控界面须提供**红/黄/绿**式状态指示：
  - **绿**：运行正常（自检结论 ok）。
  - **黄**：降级（degraded，需关注但非致命）。
  - **红**：异常或阻塞（blocked，当前不会发起新对冲）。
- **使用者与范围**：仅操作者本人，**局域网**内；不要求公网或手机访问。

### 2.2 状态自检（R-M2）

- **目标**：操作者或监控控制台能够对守护程序发起**状态自检**，得到“当前状态是否正常、各状态与参数是否符合期望”的结论。
- **形态**：自检由守护进程执行（复用现有 CompositeState、guards、config），结果为只读；可通过 sink 写入。自检输出包含：总体结论（**ok / degraded / blocked**，驱动红绿灯）、各项检查、以及若不可对冲时的 block_reasons。

### 2.3 操作可查（R-M4）

- **目标**：操作者能够**查询**自动交易程序**已执行的操作**，尤其是**导致持仓变化的操作**（如对冲下单、成交、撤单等），用于审计、排障与复盘。
- **范围**：至少覆盖与持仓相关的动作；每条记录建议包含时间、类型、方向、数量、价格（若已成交）、以及当时触发的状态或原因（如 D2/D3、block_reason 等）。守护程序将操作/事件记录写入 sink；独立监控应用提供查询接口（如 `GET /operations`）。

### 2.4 监控 Web 界面（R-M5）

- **目标**：操作者通过**浏览器**打开监控应用提供的 Web 页面，**直观看到**守护程序的运行状态。界面须包含：红绿灯（R-M3）、自检结论（R-M2）、与 IB 连接状态及 Client ID、状态摘要、操作列表（R-M4）、控制（停止、一键平敞口、重试连接 IB 等）、**当前生效的结构策略与安全边界**（可在 Status 或独立页展示），以及**策略与安全边界的查看与切换**（如 Research → Strategy 页面：结构策略列表、安全边界列表、策略历史、Set active）。**Engine 进程启停**：在 **Settings → Socket** 与同表 Socket Services 一致，经 Ops 对 **systemd** 发起启停（见 R-C1）；Status / Daemon 页可链向该入口；监控 HTTP API 本身不 exec `run_engine.py`。
- **范围**：局域网内浏览器访问；不要求公网或手机 App。

### 2.5 复盘与风控分析页面（R-M7）

- **目标**：提供**独立于实时交易监控**的**复盘与风控分析**页面，用于事后查看账户执行交易、辅助行情（如 K 线）及风险模型评估，与当前“红绿灯 + 状态 + 操作列表”的监控页**分离**，避免实时监控与复盘分析混在同一视图。
- **范围**：监控应用内新增页面或路由（如「复盘」/「风控」）；可查看账户执行交易记录（R-A2）、辅助行情（R-A3）、以及基于历史数据的风险/统计视图；不要求与 R-M5 同屏，通过导航切换。数据由阶段 3 的 R-A2、R-A3 及 R-H2 提供。
- **Performance 页面细化**：Performance 页面由 **Realized PnL** 与 **Unrealized PnL** 分开展示；按**账户**、按**标的类型（股票/期权）** 拆分计算与展示；考虑**资金流入流出（Transaction）** 对收益率分母的影响，并支持**盈亏百分比**。数据来源：Realized 来自 account_executions + account_execution_commissions（R-A2）；Unrealized 来自 account_positions + contract_quote_live；**Transaction 来自 IB Flex Web Service（Activity Flex Query - Cash Transactions），拉取后写入 account_transactions**；期初权益与 capital_base 口径以实现时对齐本文档与 [ARCHITECTURE.md](ARCHITECTURE.md) 为准。
- **（扩展）按策略归属**：支持将交易结果归属到**机会策略**与**策略实例**，Performance 与复盘可按策略、按策略实例展示 PnL 与汇总。**归属仅存于 account_executions**（每条成交可带 strategy_opportunity_id / strategy_instance_id）；account_positions 不存策略字段——一个持仓可对应多个策略，通过 executions 推导 strategy_links。Realized PnL 按 execution 归属聚合；Unrealized 按标的展示时附带策略维度（strategy_links）。表结构与写入约定见 [DATABASE.md](DATABASE.md) §2.24.11。
- **策略实例 UI（扩展）**：策略实例的列表与详情作为 **Strategy 域子视图**（如 **Strategy → Instances**）呈现，用于按「单笔开仓」查看所属机会策略/结构与盈亏（Realized/Unrealized）等；与 Portfolio、Strategy 定义页同一监控应用内导航，不单独维护独立页面设计文档。
- **与分步计划**：阶段 3（与 R-A2、R-A3 数据能力一并交付）。
- **与 R-M8 的边界**：R-M7 的 Performance、Realized/Unrealized 等为**会计与市值口径**；**模型化**理论回报、CAR、压力测试等见 **§2.6（R-M8）** 与专项文档 [PORTFOLIO_RISK_RETURN.md](plans/PORTFOLIO_RISK_RETURN.md)。

### 2.6 组合级模型化回报与风险（R-M8）

- **目标**：在**单一选中 IB 账户**、**当前真实持仓**（无假设开仓）前提下，提供组合级 **Model Analysis**：到期 payoff 意义上的 max gain / max loss（含 Unbounded 处理）、**Capital at risk（CAR）**、**按 DTE 的简单年化**、**Delta 与 Delta 美元等价**、固定档的**压力测试矩阵**（标的 ±5%/±10%、IV ±5 vol，含数据降级）；账户摘要中的 **Buying Power / Cash / Net Liquidation** 仅作**展示**（不自研 margin 引擎）。
- **范围**：须与 R-M7 的 REAL PERFORMANCE **UI 与数据层分离**（英文区块标题、Disclaimer、警告样式）；**禁止**输出无公式支撑的任意收益区间；详细定义、分阶段（V1 / V1.5 / V2）、CAR 聚合与多到期规则见 [PORTFOLIO_RISK_RETURN.md](plans/PORTFOLIO_RISK_RETURN.md)。
- **实现**：**服务端单一真源**计算并对外 API；独立 risk 进程为可选演进，非 V1 强制。

### 2.7 期权发现入口（R-OD1）

- **目标**：在 Research 下提供 **Option Discovery** 子页，作为按到期询价与机会发现的入口；操作者可选择标的（来自 Watchlist STK）与到期日，展示该到期下的期权报价、Greeks/IV、日终 OI 等。
- **标的维表（R-A7）**：Option Discovery 的标的选择可与 **`stocks` 持久化维表**（Massive Stocks 参考同步，见 §3.5.1）**逐步对齐**，与 Watchlist STK 并存，减少重复输入与符号歧义。
- **主力数据源**：**Massive（Polygon）**（R-A6）为 Option Discovery 的**主力研究数据源**——链与到期、Snapshot 快照、延迟 Greeks/IV、日终 Open Interest 等均优先从 Massive 获取；**IB** 作交叉校验或在 Massive 不可用（如 API Key 未配置、Management 模式）时的**降级路径**（可选、分阶段）。
- **延迟披露**：Massive Starter 订阅为 **15 分钟延迟**数据，界面须在相关数据区域标注 `Massive · 15 min delayed`，避免与 IB 实盘行情混淆或误用于自动下单决策。
- **范围**：第一步为 **UI 与占位 API**——Research 二级菜单新增「Option Discovery」、新页面含标的选择（Watchlist STK）、到期选择（占位）、占位表格/说明；后端提供 `GET /research/option-expirations?symbol=...&provider=massive|ib|auto`，可返回空列表或 mock 到期。后续步骤：接入 Massive / IB 返回真实到期与行权价、期权快照与发现逻辑。
- **能力进度**：见 [CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

---

## 3. 金融数据采集（c）

### 3.1 账户与持仓可获取（R-A1）

- **目标**：自动交易程序能够从 IB **获取当前账户基本信息**（如账户 ID、Balance、NetLiquidation 等）以及**当前持仓**（股票、期权等），作为自动交易对冲的**基本前置能力**。
- **范围**：账户信息至少含账户标识、现金/权益类汇总；当前持仓至少含本策略可能涉及的标的的持仓数量与方向。数据在运行周期内可持续更新，异常或断连时行为明确（重试或降级）。
- **目标架构（R-IB2、R-IB4）**：真源经 TWS → **IB Account Agent** → **Redis**；Daemon **不直连 IB**，根据 Redis 更新将账户/持仓相关数据写入 sink/PG，使监控与策略仍满足本条语义。
- **与分步计划**：阶段 3（数据获取）。

### 3.1.1 双 IB 账户与统一 Portfolio（R-A4）

- **目标**：系统支持 **两个 IB 账户**；主账户承担自动交易与行情，第二账户仅手动交易；两账户统一纳入 **Portfolio 管理**（持仓、执行、PnL、资金流）。
- **Host 账户**：**自动对冲**通过 **IB Operator RPC**（目标架构）；**行情订阅**由 **IB Ingestor**（及账户事件由 **IB Account Agent**）连 TWS 写入 Redis；Daemon 编排策略且不直连 TWS。该账户同时支持手动交易。由配置项 `host_account_id`（settings 表 `ib_host_account_id`）指定，未配置时取 TWS 返回的 managed accounts 中第一个。
- **第二账户**：**仅用于手动交易**；Daemon 不对该账户自动下单；行情与账户数据仍可由 Ingestor/Agent 按配置覆盖；纳入系统目的为 **统一 Portfolio 管理**。
- **统一 Portfolio 管理**：监控/复盘界面可对**两账户**统一查看与管理——持仓、账户摘要、执行/成交、资金流水、按账户拆分的 Realized/Unrealized PnL；R-A1、R-A2、R-M7 Performance 数据范围涵盖两账户，支持按账户筛选与汇总。
- **与分步计划**：阶段 3（与 R-A1、R-A2 一并交付）。

### 3.2 标的与持仓当前市价可获取（R-M6）

- **目标**：监控页须能获取并展示**交易标的**与**持仓**的**当前市价**（如标的 spot、bid/ask 或 last/mid），供评估持仓盈亏、期权虚实与风险；对自动交易程序为必备能力。
- **范围**：至少包含本策略涉及的**标的 spot**（或等价 last/mid），在 GET /status 或 sink 当前视图中可供监控页读取；多标的/多腿时各标的当前价须可区分获取。**目标架构**：市价来自 **IB Ingestor** 写入的 Redis（及 sink 聚合路径）；Daemon 可据 Redis 更新 **contract_quote_live** 等，而非进程内直连 `reqMktData`。
- **与分步计划**：阶段 3（数据获取）。

### 3.3 账户执行交易可获取（R-A2）

- **目标**：能够获取**当前账户**的**执行/成交记录**（含**手动交易**与**机器交易**），用于**事后复盘**与**风险控制**；与 R-M4（本程序写入的操作记录）区分——R-A2 为账户级全部成交数据，数据来源为 IB。
- **范围**：从 IB API 获取账户执行/成交（如 executions、fills 或报表接口）；可同步或按需拉取并写入 sink 或独立表，供独立应用查询（如 GET /executions 或 /trades）；记录至少含时间、标的、方向、数量、成交价、手续费等，可区分来源（若 IB 提供）。**目标架构**：账户域事件经 **Account Agent → Redis**；Daemon 根据 Redis 将执行/成交写入 PG/sink（或约定消费者）；**IB Operator** 可承担按需 **`reqExecutions`** 类主动拉取，但不维持订阅流（R-IB3）。
- **与分步计划**：阶段 3（数据获取）。

### 3.3.1 未成交订单可观测（R-A5）

- **目标**：以**事件驱动**方式获取并展示当前**未成交订单**（如 Limit 挂单），使操作者能实时看到挂单列表及状态变更（提交、部分成交、全部成交、撤单）。
- **范围**：
  - **目标架构**：**IB Account Agent** 连接 IB 并订阅 **orderStatusEvent**、**openOrderEvent**（及可选 **execDetailsEvent**），将当前 open orders 视图写入 **Redis**；可选 **reqAllOpenOrders()** 等以包含 TWS 手动挂单；**Daemon 不订阅 IB**，从 Redis 消费并写入 sink/PG 供监控查询；
  - （迁移前实现可仍为守护进程内订阅，以代码为准）
  - 状态写入 sink（如 PG 表或现有心跳/状态通道）或经联动通道推送；监控端提供 **GET /open-orders**（或等效）查询当前挂单列表；
  - 监控页可展示挂单列表（标的、方向、数量、限价、状态、已成交/剩余等），数据以事件驱动更新为主，可辅以轮询快照。
- **与 R-A2 区分**：R-A2 为**已成交**执行记录（复盘与风控）；R-A5 为**未成交**订单的实时可观测性。
- **能力进度**：见 [CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

### 3.4 复盘辅助行情可获取（R-A3）

- **目标**：为**复盘与风控分析**、**策略回测**提供**辅助行情数据**（**K 线**、报价等），便于在复盘时结合成交记录查看当时行情与风险模型评估；支持**股票与期权**。
- **范围**：
  - **标的**：除当前持仓外，支持 **Watchlist**（自选/待操作标的，可含股票与期权，含当前持仓、未持仓与曾持仓）；Watchlist 落库持久化，服务重启不丢失。
  - **数据源**：**IB** 为复盘/回测用 K 线的既有来源；**期权研究专用**数据（链、Snapshot、分钟/秒聚合 K 线、Greeks/IV、日终 Open Interest）以 **Massive（Polygon）** 为**优先回填与展示来源**（R-A6）。写入 option_day / option_min 等表时附带 `source` 列（`ib` 或 `massive`）区分来源。按标的与周期从对应数据源拉取并写入库，减少重复请求。
  - **标的元数据与符号解析**：上市股票类**参考信息**（名称、交易所、类型、关联标的等）以 **Massive Stocks 参考 API 同步落库**（**R-A7**，§3.5.1）为**主路径**，**不**依赖 IB 作为该类元数据的权威来源；与 K 线、报价数据源划分相互独立。
  - **K 线**：股票与期权**分表存储**——股票日线 **stock_day**、股票分钟/小时线 **stock_min**（周期 1 min、5 mins、1 hour）；期权日线 **option_day**、期权分钟/小时线 **option_min**。日 K 为主；分钟/小时线供复盘与短期回测。
  - **拉取策略**：首次按标的拉取时可请求**全部历史**；后续根据**最新一根 K 线距离当前的时间**智能决定请求的 duration，避免重复拉取已入库区间。
  - **报价**：持仓与 Watchlist 标的的**当前报价**（bid/ask/last/mid）可获取；Watchlist 的报价在拉取后**写入 contract_quote_live**（与持仓共用），供前端统一展示与后续使用。
  - **参考指数（Reference Indices）**：为与 Watchlist 股票对比，支持**美股大盘指数**（如 S&P 500 ^GSPC、Dow 30 ^DJI、Nasdaq ^IXIC）的日线数据。数据源为 **Massive/Polygon**（`POST /indices/refresh` 与 v2 daily aggs；config 中 `reference_indices` 含 `symbol`、`label`、可选 `polygon_ticker`）；按配置拉取日线并 UPSERT 写入 **stock_day**（`source='massive'`，同一 symbol 同一 bar_time 覆盖）；可**补齐缺失区间**（gap-fill）。GET /status 返回 `reference_indices` 供前端展示「大盘」行；现有 `/bars/benchmark` 支持传入指数 symbol 获取最新日线。
- **与分步计划**：阶段 3（数据获取）；回测与复盘策略的具体形态可后续阶段再细化。

### 3.5 Massive 期权研究数据（R-A6）

- **目标**：从 **Massive（Polygon）** 获取**美股期权**的研究级数据，作为 Option Discovery（R-OD1）与期权分析的**主力数据源**，补充 IB 在历史期权数据上的不足。**IB/TWS 仍为执行、账户真源与实盘行情**（与 R-A1/R-A2/R-M6 等一致）；Massive 定位为**研究专用、可复现批处理**。
- **订阅分级**：
  - **Options Starter（当前）**：全美股期权代码、无限 API 调用、2 年历史数据、100% 市场覆盖、**15 分钟延迟**、无限文件下载、参考数据（Reference Data）、公司行动（Corporate Actions）、技术指标（Technical Indicators）、**实时 Greeks 与 IV**（延迟语境下）、日终 Open Interest、分钟聚合（Minute Aggregates）、秒聚合（Second Aggregates）、WebSocket、Snapshot。
  - **Options Developer（$79，未来升级）**：在 Starter 基础上增加 **Trades**（逐笔成交数据）。
- **分级实现**：需求、架构与数据库中**写清分级能力**；数据库**预留** Trades 相关表（如 `option_trades`），Starter 阶段仅建表不写入；**API 与 UI 通过 feature flag**（配置项 `massive.tier` 或 `massive.features.trades_enabled`）控制 Trades 功能的暴露与写入，升级后仅需修改配置即可启用。
- **数据覆盖**（Starter 可用）：
  - **期权链与到期**（合约参考、行权价列表）
  - **Snapshot 快照**（bid/ask/last/mid + Greeks/IV）
  - **聚合 K 线**（分钟与秒级 OHLCV）
  - **日终 Open Interest**
  - **参考数据**（标的信息、合约元数据）
  - **公司行动**（拆股、股息等）
  - **WebSocket 延迟流**（quote/snapshot 通道）
- **数据覆盖（Developer 增量）**：
  - **Trades（逐笔成交）**：含价格、数量、交易所、成交条件等
  - **WebSocket Trades 通道**
- **延迟与边界**：Starter 订阅的数据**延迟 15 分钟**，界面须明确标注；**不得**将 Massive 延迟数据作为 ExecutionGuard 或自动下单决策的输入（仅 IB 实盘行情可作为交易决策依据）。
- **非功能**：
  - **API Key 安全**：仅存于 `config.yaml`（`massive.api_key`）或环境变量，不入库明文、不在前端暴露。
  - **限流**：即使 Massive 标称 unlimited API 调用，Worker 仍应在请求间留退避间隔（429/5xx 指数退避），遵守供应商 ToS。
  - **前端不直连 Massive**：密钥保护与 CORS 限制，所有请求经后端代理或落库后读取。
- **与分步计划**：纳入期权研究阶段；具体实现顺序见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 3.5.1 美股标的参考数据（R-A7）

- **目标**：建立可复用的**美股（及按需扩展）标的维表**：universe 列表（All Tickers）+ 单标的详情（Ticker Overview）+ 类型词典（Ticker Types）+ 关联标的边关系（Related Tickers），供 Option Discovery（§2.7）、分析页、Watchlist 选标等复用；与 **R-A6** 期权数据互补。
- **数据源**：**Massive Stocks REST**——**All Tickers**（cursor 分页）、**Ticker Overview**（单标的）、**Ticker Types**、**Related Tickers**；与 [ARCHITECTURE.md](ARCHITECTURE.md) §2.10 一致：**前端不直连 Massive**，API Key 仅存服务端。
- **持久化（业务表名）**：**`tickers`**（主档，`tickers_id` 主键、`ticker` UNIQUE）、**`ticker_overview`**、**`ticker_types`**、**`ticker_related_tickers`**；可选 **`job_ticker_reference_state`** 等存 universe 同步游标/checkpoint。**表名保持业务语义**，不使用供应商前缀表名；**将来**若多数据源并存可增 `source` 列（当前需求不强制）。列清单与约束以 **[DATABASE.md](DATABASE.md)** 为准（§2.14.1 等章节）。
- **功能**：
  - **存储与更新**：后台任务分页同步 universe、按标的 enrichment（Overview）、Related 按 from 标的批量刷新、Types 词典低频全量更新；**幂等、429/5xx 指数退避**与 R-A6 非功能一致。
  - **查询**：按 symbol 精确读、筛选、**联想/搜索**（服务端接口，**不全量**下发明细到浏览器）。
- **UI**：Research 或 Settings → Feed 等：**标的选择/搜索**、**详情与 peers** 以**落库/API**为准；与 Massive Stock Feed 页**原始代理调试**并存时，**生产分析路径以 PostgreSQL/API 为准**，代理仅作排障与能力验证。
- **边界**：与 R-A6 相同——**不得**将 Massive 侧数据作为 ExecutionGuard 或自动下单决策输入；界面展示须与套餐/延迟一致（如 Starter 下 **15 分钟延迟**类提示，与实现及 Massive 文档对齐），避免与 IB 实盘行情混淆。

### 3.5.2 股票筛选与基本面数据（R-A8）

- **目标**：基于 Massive Stocks 现有数据能力，支持**美股股票量化筛选**。首个目标方法论为 **SEPA（Specific Entry Point Analysis，Mark Minervini）**，并将筛选结果作为后续研究与观察列表输入。
- **筛选范围**：
  - **基础筛选（技术面）**：50 日均量阈值、价格相对 52 周高低点、SMA(50/150/200) 关系、SMA(200) 上升斜率、价格位于关键均线上方、CRS（相对强弱）阈值等。
  - **二级筛选（基本面）**：EPS/Revenue 的季度同比增长、连续季度增速加速、3 年增长、最近财年增长加速等。
- **数据来源与映射**：
  - **技术面**：`stock_day`（OHLCV）与现有 Massive 聚合能力（如 grouped daily）用于计算 SMA、52 周 high/low、均量和全市场排名所需原始数据。
  - **基本面**：Massive `GET /vX/reference/financials`（已由服务端 fundamentals 路由代理）用于读取 `income_statement` 中 `basic_earnings_per_share`、`diluted_earnings_per_share`、`revenues` 等字段，支持 `timeframe=quarterly|annual|trailing_twelve_months`。
- **CRS 定义约束**：CRS（相对强弱排名）与 RSI（技术指标）不同；CRS 需基于全市场可比样本计算 52 周区间表现并转化为百分位排名。
- **实施建议（分阶段）**：
  - **Phase 1（技术面筛选）**：先在本地库按技术面条件过滤，形成候选集。
  - **Phase 2（基本面筛选）**：仅对候选集调用 financials 接口计算 EPS/Revenue 条件，降低外部 API 压力。
  - **Phase 3（可选）**：若筛选规模扩大，可增加财务数据缓存/落库与定时刷新策略。
- **边界**：筛选结果用于研究与候选池管理，不直接作为 ExecutionGuard 或自动下单决策输入；交易执行侧仍以 IB 实盘链路为准。

### 3.6 IB 边缘服务与 Daemon 边界（目标架构，R-IB1～R-IB4）

以下描述**目标架构**下 IB 相关进程职责与 Daemon 边界；与 [ARCHITECTURE.md](ARCHITECTURE.md) §2.11 一致。迁移中的代码路径以实现为准，能力进度见 [CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

- **R-IB1（IB Ingestor）**：独占**行情类** IB 订阅——Watchlist 标的及按需 **`reqMktData`**（均由 Ingestor 统一管理与去重）；将订阅所得行情写入 **Redis**；**不**写入 PostgreSQL。监控与其它服务对行情业务键**只读**，不写入行情唯一真源。
- **R-IB2（IB Account Agent）**：独占**账户域** IB 订阅与事件——持仓变化、订单状态、挂单、成交、`commissionReport`，以及为与 TWS 对齐所需的 **`reqOpenOrders` / `reqExecutions` 等补全**；仅将结果写入 **Redis**（拟议键前缀如 `ib:account:*`，以实现为准）；**不**写入 PostgreSQL。
- **R-IB3（IB Operator）**：仅处理**主动** IB API 调用（如下单、撤单、查询类 `req*`）及 **Redis Stream 命令 RPC**；**不承担**任何长期**订阅型**服务（含不在此进程内维持 `reqMktData` 订阅流）。
- **R-IB4（Daemon / Engine）**：**不持有** IB Client、**不直连** TWS/Gateway；从 **Redis** 读取 Ingestor 与 Account Agent 更新的行情与账户态势，供策略与风控；**账户类**数据落 **PostgreSQL** 由 Daemon（或文档允许的**同类 Redis 消费者**）根据 Redis 内容写入；**自动下单与平敞口等执行**通过 **IB Operator RPC** 完成，而非进程内 `place_order`。

---

## 4. 策略编辑、回测与历史统计（d）

### 4.1 历史统计（R-H2）

- **目标**：基于历史数据做胜率、盈亏分布、按日/周/月汇总、对冲次数与滑点等。
- **形态**：存在**独立脚本或模块**（如 `scripts/check/stats_from_history.py` 或 `src/stats/`），**只读**阶段 1 sink 写入的历史表；**不跑** FSM/Guard/StateClassifier。输出至少包含按日/周对冲次数、盈亏分布或汇总；可离线运行，不依赖守护进程在线。
- **Performance 计算逻辑**：按日/周/月汇总、胜率、盈亏分布及 Performance 页的**计算逻辑**与 R-M7 的 Performance 子页一致。
- **（扩展）按策略归属**：历史统计与 Performance 可支持按**机会策略**、按**策略实例**聚合 PnL 与汇总；Strategy → Instances（或等价入口）可展示该实例维度的历史统计与汇总。能力进度见 [CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

### 4.2 回测（R-B1、R-B2）

- **R-B1（策略 PnL 优化）**：在历史数据上对比不同参数组合下的理论 P&L、夏普/回撤、对冲频率与滑点等，用于**优化策略收益**。
- **R-B2（安全边界验证）**：Guard 与边界参数的有效性与合理性可验证；不同参数下对冲次数、被各 guard 拦截的次数及原因便于复盘与微调。
- **回测作为手段**：**不连接 TWS 实盘**，用**历史行情与持仓快照**回放，驱动与实盘**同一套** StateClassifier、TradingFSM、ExecutionGuard 逻辑；产出理论 P&L、收益曲线、最大回撤及决策与 block reason。实现依赖历史存储。
- **策略编辑**：当前阶段以配置（YAML/gates）与回测参数对比为主；若后续支持可视化策略编辑或策略模板，可在本类下扩展需求。

### 4.3 策略与安全边界数据模型与落库（扩展）

- **目标**：策略三层（结构策略、机会策略、策略分配 Allocations）与安全边界四层（gates：strategy / state / intent / guard）支持**落库**，便于版本管理、回测关联与按版本切换。
- **范围**：
  - **结构策略**（strategy_structure）、**机会策略**（strategy_opportunity）、**策略分配**（strategy_allocation / Allocations）存于 DB；安全边界以 **gate_safety_strategy**（根表）及 **gate_safety_state**、**gate_safety_intent**、**gate_safety_guard**、**gate_safety_strategy_earnings_dates** 存于 DB，**无 JSON 列**，仅标量列。
  - 当前生效的结构策略与安全边界由 **settings** 表字段 **active_strategy_structure_id**、**active_gate_safety_strategy_id** 指定；守护进程可**优先从 DB 加载 gates**，未配置时回退 config 文件。
- **引用**：表结构与命名标准见 [docs/DATABASE.md](docs/DATABASE.md) §2.24 与 [.cursor/rules/database-design.mdc](.cursor/rules/database-design.mdc)。**Phase A** 提供后台管理与监控：GET /status 返回当前生效策略与安全边界 id/name；GET /strategies/structures、/history、/gate-safety、/gate-safety/{id} 及 POST/PUT /gate-safety 供管理端与策略使用情况查询及 Gates CRUD；strategy_history 由守护进程在 append_history 时写入。**监控端提供 Research → Strategy 页面**，用于查看当前生效策略/边界、结构策略列表、安全边界列表、策略使用历史，并支持在页面上将某条结构或某条安全边界设为当前生效（POST /config/active-strategy）；**Research → Gates 页面**用于 Gates 参数配置管理：创建、编辑、复制边界集，以及将某条设为当前生效；守护进程在下次启动或重载时使用新生效 id。
- **Allocations 层「当前生效」**：策略分配（Allocations）目前仅落库与 CRUD；**当前生效的 Allocations**（如 settings 增加 active_strategy_allocation_id）为**后续扩展**，用于多账户/多策略组合时指定当前监控或执行的分配集，并与机会监控、Daemon 按分配集加载 opportunity 列表等能力衔接。实现步骤与验收在后续阶段规划时细化；能力拆解与进度见 [plans/CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

### 4.4 期权结构细化（R-OS1）

- **目标**：将「结构类型」从展示用标签升级为**带明确腿约束与盈亏语义的建模基础**。每种结构类型（如 Covered Call、Iron Condor）对应**确定的腿模式**（腿数、角色、方向、期权类型等）以及**可选的盈亏模型**，便于系统校验、风控、监控与产品演进。
- **细化意义**（为何需要）：
  - **语义可执行**：结构类型对应明确腿组合后，系统能校验、能依赖；例如 Covered Call = 股票 + Short Call，腿数或腿型不符即可拒绝或告警。
  - **盈亏可建模**：每种结构有对应的盈亏形态（如 Covered Call 的 cap/权利金、Iron Condor 的 max profit/loss）；风控与监控才能按结构类型套用对应模型（保证金、风险限额、持仓是否符合预期）。
  - **体系可打通**：结构类型成为连接「策略定义 → Gate/安全边界 → 绩效与风控」的稳定维度；按结构类型配置差异化风控、按结构聚合统计与回测才有依据。
  - **产品可演进**：用户按类型选结构时只填该结构所需参数，出错空间小；后续可做按结构类型的模板、推荐、统计与合规说明。
- **范围**：
  - 为各 `structure_type`（如 covered_call、iron_condor、straddle_strangle、cash_secured_put、calendar_spread、leaps、custom）定义**腿 schema**（腿数、每腿角色/方向/option_right 等约束）；Covered Call 等类型采用业界通行定义（如股票 + 卖出看涨期权互相对冲）。
  - Structure 页面与（可选）后端按类型进行**校验或引导**（预填模板、限制腿数、下拉约束）；`custom` 可保持自由编辑。
  - 可选：将结构类型与**盈亏模型**关联，为风控、复盘与回测提供依据；具体模型定义与实现阶段在立项时再定。
- **当前状态**：需求与方向预留，具体实施在后续规划时细化。

---

## 5. 策略应用（自动交易）（e）

**终极目标**：自动交易（守护进程按策略与风控自动对冲）。  
**中间目标（自动交易之前的过渡）**：对市场行情机会的**监控并提醒**出现交易机会，由操作者**手动判断是否下单**；对应需求 **R-RM9**（可选）「仅建议、不实盘」——守护完整跑策略与风控，执行层截断，将 hedge 建议写入 daemon_auto_operations（或专用表），由 Web UI 呈现，供人工决策。能力拆解与各维度进度见 [plans/CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。

### 5.1 一键平敞口（R-C3）

- **目标**：在**红**或操作者判断需紧急降敞口时，**一键平掉本策略管理的对冲敞口**（即自动对冲所用的股票持仓平至目标，如 0 或与当前期权 delta 匹配）。**仅针对本守护程序负责的对冲仓位**，不触碰账户内其他头寸（如手动交易、其他策略）。**仅针对主账户**上本策略管理的对冲敞口，不触碰第二账户。
- **与监控的对应**：与**红**灯配套——不仅“停新单”，还能主动**卸掉已有敞口**，实现安全兜底。
- **实现依赖**：R-A1（账户与持仓可获取）、策略边界与平仓逻辑等；安排在阶段 5。控制通道支持 `flatten`；守护进程收到后根据当前账户/持仓与目标计算平仓量，**通过 IB Operator RPC 下单**（目标架构），将此次操作写入 sink 操作记录；独立应用提供 POST /control/flatten。

---

## 6. 实时行情与联动（f，R-RM*）

此处仅作索引与简述。

| 编号 | 需求简述 | 说明 |
|------|----------|------|
| **R-RM1** | 心跳 + 消费 Redis 侧行情与账户更新 | 行情由 **IB Ingestor**、账户态势由 **IB Account Agent** 写入 Redis；Daemon 心跳与策略循环**消费**上述数据；轮询主要用于控制通道。 |
| **R-RM2** | Ingestor 写行情 Redis；Account Agent 写账户 Redis | 监控 Server **不**写上述业务 Redis 键；Daemon **不**写行情唯一真源键。 |
| **R-RM3** | 联动机制：Pub/Sub 或 Streams | Ingestor/Account Agent 写 Redis 后发布通知；监控订阅，收到后读 Redis（或消息体）并推给 Web UI。 |
| **R-RM9**（可选） | 第一里程碑可为「仅建议、不实盘」 | 守护完整跑策略与风控，执行层截断，将 hedge 建议写入 daemon_auto_operations，由 Web UI 呈现。 |

**何时在 UI 提供实时行情**：操作中监控、与守护行为对照、同屏决策、建议模式时需要；仅健康检查、事后复盘、只看统计时不需要。

---

## 7. 环境与部署约束（h，R-DV*）

环境与部署约束定义 Dev/Prod 的隔离规则与共享 TWS 纪律。技术实现与拓扑细节见 [ARCHITECTURE.md](ARCHITECTURE.md) §2（尤其 §2.1、§2.8）及 §6。

### 7.1 Dev/Prod PostgreSQL 逻辑隔离（R-DV1）

- **目标**：Dev 与 Prod 使用**独立 database**（可在同一 PostgreSQL 服务器上以不同 database 名区分，如 `bifrost_dev` / `bifrost_prod`）。
- **约束**：各进程（Engine、Server、Celery）仅连接**本环境**配置的数据库。`settings`、`daemon_control`、`daemon_run_status` 及所有业务表**不跨环境混用**。数据库迁移、种子数据、备份按环境独立执行。

### 7.2 Prod 完整运行栈（R-DV2）

- **目标**：**生产环境**在指定 **Linux 服务器**（如局域网 192.168.10.70）上部署**完整运行栈**——`run_engine.py`、`run_server.py`、Redis、Celery bars worker——连接 **Prod DB**。
- **开发环境**默认在本机运行 Server（+ 可选 Engine/Redis/Celery），连接 **Dev DB**。
- 具体主机 IP 与端口以 [ARCHITECTURE.md](ARCHITECTURE.md) §2.8 与 §6 为准。

### 7.3 TWS 共享与 Engine 互斥（R-DV3）

- **目标**：**两台 Mac Mini** 各运行一套 TWS（Host / Secondary），为 Dev 与 Prod **共享基础设施**（与 R-A4 一致）。
- **区分**：Dev 与 Prod 通过 **不同 `client_id` 与/或不同 TWS/Gateway 监听端口** 区分连接。
- **互斥**：**同一 IB 账户同一时刻仅允许一个自动交易 Engine** 对该账户下单，避免双环境双 Engine 实盘冲突。与现有单进程约束（RE-6）及控制语义一致。
- **Ops 启停 Engine**：Engine 在 Ops 中**不**使用 Socket ingest 的 Redis 租约字段时，Dev/Prod **不得**对同一账户**双启**两个 `bifrost-engine` 进程；互斥仍由运维与 R-DV3 纪律保证。

### 7.4 共享 Redis 实时行情（调试拓扑，R-DV4）

- **目标**：在**调试或并行验收**时，允许 **Dev UI 与 Prod UI 同时看到同一条 IB 实时行情推流**（R-RM2/R-RM3 的只读侧）：**单处**运行连接 TWS 的 **IB Ingestor**（**行情键**的唯一写入方），向 **唯一** Redis 写报价并发布 Pub/Sub；各环境的 **Market API**（可位于不同主机、不同端口）配置**相同**的 `redis.host` / `redis.port` / `redis.db`（及与 Ingestor 一致的 `channel`），使前端 SSE 订阅同一数据源；与 **Daemon（Engine）是否同机运行无关**。
- **不替代**：**R-DV1** 仍成立——各环境 **PostgreSQL** 独立 database，`GET /status`、控制面、业务数据仍按环境分离。**R-DV3** 仍成立——共享 Redis **不**表示允许多个 Engine 对同一账户同时自动下单；调试时通常只保留**一个** Ingestor（及配套的互斥纪律）向共享 Redis 写行情。
- **运维注意**：Celery broker/result 与实时行情若共用 Redis **进程**，须用 **不同 `db` 索引** 区分（与 [ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§2.8 一致），避免队列与行情键混用。

---

## 8. 小结表（便于快速查阅）

| 分类 | 需求编号 | 主题 |
|------|----------|------|
| a. 守护程序相关 | R-H1 | 状态可扩展为带历史 |
| | R-C1 | 一键停止 |
| | R-C2 | 暂停/恢复 |
| b. 监控相关 | R-M1 | 状态可观测 |
| | R-M2 | 状态自检 |
| | R-M3 | 红绿灯监控 |
| | R-M4 | 操作可查 |
| | R-M5 | 监控 Web 界面 |
| | R-M7 | 复盘与风控分析页面 |
| c. 金融数据采集 | R-A1 | 账户与持仓可获取 |
| | R-A4 | 双 IB 账户与统一 Portfolio |
| | R-A2 | 账户执行交易可获取（复盘与风控） |
| | R-A5 | 未成交订单可观测（事件驱动） |
| | R-A3 | 复盘辅助行情可获取（如 K 线） |
| | R-A6 | Massive 期权研究数据（链/快照/Greeks/OI/聚合等） |
| | R-A8 | 股票筛选与基本面数据（SEPA 技术面 + EPS/Revenue 条件） |
| | R-M6 | 标的与持仓当前市价可获取 |
| d. 策略编辑、回测与历史统计 | R-H2 | 历史统计 |
| | R-B1、R-B2 | 回测（策略 PnL 优化 + Guard 验证） |
| | R-OS1 | 期权结构细化（腿模式 + 盈亏模型） |
| e. 策略应用（自动交易） | R-C3 | 一键平敞口 |
| **f. 实时行情与联动** | **R-RM1** | 心跳 + 消费 Redis 行情与账户更新 |
| | **R-RM2** | Ingestor/Account Agent 写 Redis；监控不写业务键 |
| | **R-RM3** | 联动机制（Redis Pub/Sub 或 Streams） |
| | R-RM9（可选） | 仅建议不实盘（第一里程碑） |
| **h. 环境与部署** | **R-DV1** | Dev/Prod PostgreSQL 逻辑隔离 |
| | **R-DV2** | Prod Linux 完整运行栈；Dev 本机 |
| | **R-DV3** | TWS 共享 + Engine 互斥 |
| | **R-DV4** | 调试拓扑：多 UI 只读同一 Redis 行情（Ingestor 写）；PG 与 Engine 纪律不变 |
| **i. IB 边缘服务与 Daemon 边界** | **R-IB1**～**R-IB4** | Ingestor / Account Agent / Operator / Daemon 职责，见 §3.6 |

**运行环境与约束**（IB/账户、Dev/Prod 隔离、部署拓扑、监控与交易分离、单进程、守护程序与 IB 连接等）见 [ARCHITECTURE.md](ARCHITECTURE.md)「运行环境与部署约束」（§2）。

---

*最后更新：2026-04-28，新增 **R-A8（§3.5.2）**：股票筛选与基本面数据（SEPA）需求，明确技术面/基本面条件、CRS 口径与分阶段实施建议，并同步更新总览与小结表。此前：2026-04-07，**R-C1 / R-M5 / §7.3**：补充 Engine 经 Ops+systemd 与 Socket 同源启停及 `daemon_heartbeat` 优雅写库；**R-DV3** 补充 Ops 启停 Engine 时互斥纪律。此前：新增 **R-IB1～R-IB4**（§3.6）与 IB 边缘服务拆分目标架构；修订 **R-RM***、**R-DV4** 及 R-A/R-C3 相关叙述，与 [ARCHITECTURE.md](ARCHITECTURE.md) §2.11 对齐。*
