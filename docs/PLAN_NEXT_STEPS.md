# 分步推进计划（与需求对比）

本文档与 **产品需求**（[REQUIREMENTS.md](REQUIREMENTS.md)）、**系统架构**（[ARCHITECTURE.md](ARCHITECTURE.md)）对齐，给出分步推进计划，**与需求一一对比**：各阶段实现并验收的需求、里程碑、检查方式与验证标准（Test Case）。在**需求不变、硬件/架构不变**的前提下，本文档**保持稳定**，无需随执行进度修改；仅当需求或硬件/运行环境发生变更时才需调整本文档及需求/架构。

**当前项目进展、阶段完成状态、项目里程碑时间线** 在每次阶段评估时更新，见 **[阶段评估与下一步](plans/PHASE_ASSESSMENT.md)**。

**需求详情与说明章节**：各需求的功能描述与细节见 [REQUIREMENTS.md](REQUIREMENTS.md) 产品需求分类及「说明章节」列；**验收标准与 Test Case** 以本文档「需求与阶段一一对应及详细验收标准」及各阶段「验证标准」「本阶段 Test Case 清单」为准。

**验收原则**：**仅当本阶段验证标准全部通过后，方可启动下一阶段开发**。阶段验收时，按「需求与阶段一一对应及详细验收标准」表中**本阶段负责的需求**逐条核对验收标准，全部通过则阶段通过。

**需求拆分说明**：产品需求 R-M1、R-M4、R-C1 在实现上横跨阶段 1（守护程序侧）与阶段 2（独立应用侧）。为**明确阶段 1 与阶段 2 的验收边界**，在分步计划中将三者拆成**仅属于单一阶段**的子项，便于每阶段独立验收、无重叠判定：

| 产品需求 | 阶段 1 子项（仅阶段 1 验收） | 阶段 2 子项（仅阶段 2 验收） |
|----------|-----------------------------|-----------------------------|
| R-M1 状态可观测 | **R-M1a** 状态可观测·写出侧 | **R-M1b** 状态可观测·读与展示 |
| R-M4 操作可查 | **R-M4a** 操作可查·写出侧 | **R-M4b** 操作可查·读与查询 |
| R-C1 一键停止 | **R-C1a** 一键停止·信号与控制文件 | **R-C1b** 一键停止·独立应用发停止 |

产品需求文档（REQUIREMENTS.md）仍使用 R-M1、R-M4、R-C1；**阶段验收**以本计划中的 R-M1a/1b、R-M4a/4b、R-C1a/1b 为准。

**需求完成定义**：某需求（含子项 R-M1a/1b 等）**已完成**，当且仅当在其**完成阶段**验收时，该需求在本文档「需求与阶段一一对应及详细验收标准」表中的**验收条（①②③…）全部通过**。**阶段通过** = 本阶段所有需求之验收条全部通过；仅当阶段通过后方可进入下一阶段。**验证需要通过哪些 Test Case**：见各阶段「验证标准」表及「本阶段 Test Case 清单」；每一条验收条对应至少一个可执行 Test Case（编号 TC-阶段-需求-序号），阶段验收时须逐条执行并通过。

**当前项目进展与里程碑**：见 [阶段评估与下一步](plans/PHASE_ASSESSMENT.md) 的「当前项目进展（阶段完成状态）」与「项目里程碑时间线」。每次阶段评估后由负责人更新该文档，本文档（需求与阶段对应、验收标准）保持不变。

**下一步聚焦**：在阶段 3 验收与双账户闭环基础上，推进 **Strategy 三层策略的进一步完善**（含 Allocations 层「当前生效」的扩展），以及**机会监控与提醒**（R-RM9「仅建议、不实盘」）作为自动交易前的过渡目标。达成终极目标（自动交易）所需的各方面能力拆解与当前进度，见 [终极目标能力拆解与进度（木桶原理）](plans/CAPABILITY_TRACKING.md)，可**分项跟踪**进度与短板。

---

## 需求与阶段对应总表

| 阶段 | 本阶段实现并验收的需求 | 阶段目标（一句话） |
|------|------------------------|--------------------|
| **阶段 1** ✅实现 | **R-M1a**、**R-M4a**、**R-C1a**、**R-H1** | 守护程序通过 sink 写出状态与操作记录，支持进程外停止（信号/控制文件） |
| **阶段 2** ✅实现 | **R-M1b**、**R-M2**、**R-M3**、**R-M4b**、**R-C1b**（本阶段不包含 R-C3） | 独立应用提供监控（含红绿灯）、操作查询与一键停止 |
| **阶段 3**（数据获取） | **R-A1**、**R-A4**、**R-A2**、**R-A5**、**R-A3**、**R-M6**、**R-M7**、**R-H2** | 账户、持仓、市值、账户执行交易与辅助行情、复盘页、历史统计等数据的获取（供策略与监控使用）；双 IB 账户与统一 Portfolio；含未成交订单事件驱动可观测（R-A5） |
| **阶段 4**（策略与回测） | **R-B1**、**R-B2** | 交易策略框架建立、策略创建与回测（PnL 优化与 Guard 验证） |
| **阶段 5**（自动对冲与监控） | **R-C2**、**R-C3** | 基于成熟策略的自动交易对冲与监控（暂停/恢复、一键平敞口等） |
| **实时行情与联动**（R-RM*，可选/阶段 3 之后） | **R-RM1**、**R-RM2**、**R-RM3** | 守护双线（心跳+事件）；Redis 行情缓存；Redis Pub/Sub 或 Streams 联动；监控订阅并推前端；步骤与验收见下文「实时行情与联动」 |
| **期权发现**（R-OD1，阶段 3 扩展） | **R-OD1** | Research 下 Option Discovery 入口；第一步 UI 与占位 API，后续接入 IB 到期/询价；步骤与验收见下文「期权发现（Option Discovery）」 |
| **期权结构细化**（R-OS1，后续） | **R-OS1** | 结构类型对应明确腿模式与可选盈亏模型；Structure 页校验/引导；阶段与验收在立项时定。 |

**需求编号 → 产品需求文档与验收/Test Case 链接**（便于从需求编号反查描述与验证位置）：

| 需求编号 | 产品需求文档（说明章节） | 本计划验收与 Test Case 位置 |
|----------|--------------------------|-----------------------------|
| R-M1a / R-M1b | [REQUIREMENTS.md](REQUIREMENTS.md) §2.1、§6（R-M1） | 下文「需求与阶段一一对应及详细验收标准」R-M1a/R-M1b 行；阶段 1/2「验证标准」表及「本阶段 Test Case 清单」 |
| R-M2 | 同上 §2.2、§6 | 同上 R-M2 行；阶段 2 验证标准与 Test Case 清单 |
| R-M3 | 同上 §2.1、§6 | 同上 R-M3 行；阶段 2 验证标准与 Test Case 清单 |
| R-M4a / R-M4b | 同上 §2.3、§6（R-M4） | 同上 R-M4a/R-M4b 行；阶段 1/2 验证标准与 Test Case 清单 |
| R-C1a / R-C1b | 同上 §1.2、§6（R-C1） | 同上 R-C1a/R-C1b 行；阶段 1/2 验证标准与 Test Case 清单 |
| R-H1 | 同上 §1.1、§6 | 同上 R-H1 行；阶段 1 验证标准与 Test Case 清单 |
| R-A1 | 同上 §3.1、§6 | 同上 R-A1 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-A4 | 同上 §3.1.1、§6 | 同上 R-A4 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-A2 | 同上 §3.3、§6 | 同上 R-A2 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-A5 | 同上 §3.3.1、§6 | 同上 R-A5 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-A3 | 同上 §3.4、§6 | 同上 R-A3 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-M6 | 同上 §3.2、§6 | 同上 R-M6 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-M7 | 同上 §2.5、§6 | 同上 R-M7 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-H2 | 同上 §4.1、§6 | 同上 R-H2 行；**阶段 3** 验证标准与 Test Case 清单 |
| R-B1 / R-B2 | 同上 §4.2、§6 | 同上 R-B1/R-B2 行；**阶段 4** 验证标准与 Test Case 清单 |
| R-C2 | 同上 §1.3、§6 | 同上 R-C2 行；**阶段 5** 验证标准与 Test Case 清单 |
| R-C3 | 同上 §5、§6 | 同上 R-C3 行；**阶段 5**（依赖 R-A1、持仓与策略边界等），验证标准与 Test Case 待该阶段规划时补全 |
| **R-RM1 / R-RM2 / R-RM3** | 本文档 §6（R-RM*）与下文「实时行情与联动」步骤 | 下文「实时行情与联动」步骤；验收标准见该节 |
| **R-OD1** | [REQUIREMENTS.md](REQUIREMENTS.md) §2.6 | 下文「期权发现（Option Discovery）」步骤；验收标准见该节 |
| **R-OS1** | [REQUIREMENTS.md](REQUIREMENTS.md) §4.4 | 下文「期权结构细化」步骤（后续）；验收标准待阶段规划时定。 |

---

## 需求与阶段一一对应及详细验收标准

下表给出 **每个需求（含子项）** 的 **唯一完成阶段** 与 **详细验收标准**。阶段验收时，仅核对**本阶段**对应行，全部通过则阶段通过。

### 监控类（R-M*）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-M1a** | 状态可观测·写出侧：守护程序将运行状态写入 sink，供外部读取（不依赖控制台）。 | **阶段 1** | ① 守护程序在 heartbeat 或 _eval_hedge 后向 sink 写入 snapshot。② 不依赖控制台即可从 sink（SQLite 或 FileSink）读到**当前状态**与**时间戳**。③ snapshot 至少含：daemon_state、trading_state、symbol、spot、bid/ask、净 delta、股票持仓、option 腿数、daily_hedge_count、daily_pnl、data_lag_ms、config 摘要（或等价）、ts。 |
| **R-M1b** | 状态可观测·读与展示：通过独立应用或接口查看当前运行状态（持仓、FSM、指标、配置摘要）。 | **阶段 2** | ① 独立应用提供 GET /status（或等效）。② 通过该接口能拿到**当前运行状态**（持仓、FSM 状态、指标、配置摘要等），无需查看守护程序控制台。 |
| **R-M2** | 状态自检：可对守护程序发起自检，得到健康结论（ok/degraded/blocked）与 block_reasons。 | **阶段 2** | ① 守护程序或 sink 中能产出 **self_check** 结果（总体结论：ok / degraded / blocked）。② 若不可对冲，能产出 **block_reasons**（如 data_stale、risk_halt、PAUSE_COST 等）。③ GET /status 或 sink 当前视图中可读到上述自检结果，供监控控制台或独立应用展示。 |
| **R-M3** | 红绿灯监控：监控界面须提供红/黄/绿状态指示，一目了然识别运行是否正常。 | **阶段 2** | ① 独立应用 GET /status 返回中 **必须含 status_lamp**（或等效字段），取值为 green / yellow / red 之一。② **绿** = 自检结论 ok；**黄** = degraded；**红** = blocked。③ 操作者仅凭该字段即可判断“运行正常 / 降级 / 异常或阻塞”，无需解读原始 self_check 或日志。 |
| **R-M4a** | 操作可查·写出侧：守护程序将执行过的操作（尤其持仓变化）写入 sink，供外部查询。 | **阶段 1** | ① 守护程序在发生**对冲意图、下单、成交、撤单**等时，向 sink **操作/事件表**写入一条记录。② 每条记录至少含：时间、类型、方向（BUY/SELL）、数量、价格（若已成交）、状态/原因（如 D2/D3、block_reason）等。③ 外部可从 sink 读到上述记录。 |
| **R-M4b** | 操作可查·读与查询：通过独立应用或接口查询执行过的操作（尤其涉及持仓变化）。 | **阶段 2** | ① 独立应用提供 **GET /operations**（或等效），支持按时间范围或类型筛选。② 通过该接口能返回**涉及持仓变化的操作列表**，供审计与排障。 |

| **R-M6** | 标的与持仓当前市价可获取：监控页须能获取并展示交易标的与持仓的当前市价（spot/last/mid 等），供评估持仓盈亏、期权虚实与风险；对自动交易程序为必备能力。 | **阶段 3** | ① 守护程序在运行中从 IB（或既有数据源）拉取**交易标的**的当前市价（如 spot、bid/ask 或 last/mid），并写入 sink/daemon_auto_status_current。② GET /status（或等效）返回的当前视图中**包含标的市价**（如 spot 等），可供监控页读取并展示。③ 若有持仓数据（R-A1），监控页能结合持仓与市价展示（如持仓+当前价、盈亏、期权虚实等）；多标的/多腿时各标的市价可区分获取。 |
| **R-M7** | 复盘与风控分析页面：提供独立于实时监控的复盘与风控分析页面，用于查看账户执行交易、辅助行情（如 K 线）及风险模型评估。 | **阶段 3** | ① 监控应用提供**独立页面或路由**（如「复盘」/「风控」），与当前交易监控页**分离**，通过导航切换。② 复盘页可展示**账户执行交易记录**（R-A2 数据）、**辅助行情**（R-A3，如 K 线或 OHLC）及基于历史数据的风险/统计视图。③ 不要求与 R-M5 同屏；数据由 GET /executions（或等效）及 K 线/行情接口提供。④ Performance 页计算与展示的细化验收见本文档步骤 3.8 与阶段 3 验收清单。 |

### 交易基础（R-A*）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-A1** | 账户与持仓可获取：自动交易程序能从 IB 获取当前账户基本信息与当前持仓，作为下一步自动交易对冲的基本能力。 | **阶段 3** | ① 守护程序在连接 IB 后能通过 IB API **请求并获取当前账户基本信息**（至少含账户标识、Balance/NetLiquidation 等权益类汇总，以 IB 提供为准）。② 守护程序能 **获取当前持仓**（至少含本策略涉及的标的如股票、期权腿的持仓数量与方向），可供内部对冲逻辑与风控使用。③ 上述数据在运行周期内可持续更新（如每次 heartbeat 或按配置间隔请求），异常或断连时行为明确（重试或降级）。 |
| **R-A4** | 双 IB 账户与统一 Portfolio：支持两账户；Host 账户自动+行情，第二账户仅手动；统一 Portfolio 展示与管理。 | **阶段 3** | ① 配置可指定 Host 账户（如 `ib_host_account_id`），未配置时行为与现有一致（取 managed accounts 首个）。② 守护进程仅对 Host 账户执行对冲与行情相关逻辑；R-C3 一键平敞口仅针对 Host 账户。③ 监控/复盘页可展示两账户的持仓、执行、Performance 按账户拆分；GET /status 的 accounts、GET /executions、GET /performance 支持多账户。 |
| **R-A2** | 账户执行交易可获取：从 IB 获取当前账户的执行/成交记录（含手动与机器），用于事后复盘与风控。 | **阶段 3** | ① 能从 IB API **获取账户执行/成交记录**（如 executions、fills 或报表接口），含手动与机器交易。② 数据可同步或按需拉取并**写入 sink 或独立表**；独立应用提供**查询接口**（如 GET /executions 或 /trades），支持按时间范围等筛选。③ 每条记录至少含时间、标的、方向、数量、成交价、手续费等；若 IB 支持可区分来源（手动/机器）。 |
| **R-A5** | 未成交订单可观测（事件驱动）：以事件驱动方式获取并展示当前未成交订单（Limit 挂单等）。 | **阶段 3** | ① 守护进程连接 IB 后订阅 **orderStatusEvent**、**openOrderEvent**（及可选 execDetailsEvent），维护当前 open orders 列表。② open orders 状态**写入 sink**（如 PG 表）或经联动通道推送；独立应用提供 **GET /open-orders**（或等效），返回当前挂单列表（至少含标的、方向、数量、限价、状态、已成交/剩余等）。③ 监控页可展示挂单列表；数据以事件驱动更新为主（可辅以轮询）。④ 可选：支持 **reqAllOpenOrders** 或等效，使 TWS 手动挂单亦可见。 |
| **R-A3** | 复盘辅助行情可获取：为复盘与风控分析提供辅助行情数据（K 线、报价等）；支持股票与期权、Watchlist 落库、多周期（1 D / 1 min / 5 mins / 1 hour）、智能拉取、Watchlist 报价写入 contract_quote_live。 | **阶段 3** | ① 存在**数据源**（IB）并可**按标的与周期**拉取**K 线**（开高低收、成交量）；股票存 **stock_day** / **stock_min**，期权存 **option_day** / **option_min**。② **Watchlist** 表落库，支持 CRUD；市场数据页标的候选 = 持仓 + Watchlist。③ 首次拉取可请求全部历史，后续根据**最新一根 K 线时间**智能决定 duration。④ GET /bars（或等效）支持 sec_type、period、标的参数，可读取上述表。⑤ Watchlist 与持仓的**报价**可获取，拉取后写入 **contract_quote_live**，供前端展示。⑥ **非实时拉取**（如 backfill）**经队列入队**，由**独立 Worker 进程**（或当前实现的同进程 worker）执行；API 入队返回 job_id，GET /bars/jobs、GET /bars/jobs/{id} 可查状态与结果。 |

### 控制类（R-C*）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-C1a** | 一键停止·信号与控制文件：从进程外通过信号或控制文件停止守护程序（含优雅退出）；停止后不再下发任何新单。 | **阶段 1** | ① `run_engine.py` 注册 SIGTERM/SIGINT → `app.stop()`，主循环通过 asyncio 安全退出。② 本机或 SSH 发 SIGTERM/SIGINT 后，守护程序 **100% 在数秒内优雅退出**，且停止后不再下发任何新单。③（若实现 1.3）存在控制文件且内容为 stop 时，守护程序在**轮询周期内**执行 request_stop() 并退出。 |
| **R-C1b** | 一键停止·独立应用发停止：通过独立应用在局域网内发起停止，无需登录控制台。 | **阶段 2** | ① 独立应用提供 **POST /control/stop**（或等效），通过写控制文件或调本地 API 触发停止。② 在局域网内通过该接口可使守护程序在**预期时间内**优雅退出，无需登录控制台。 |
| **R-C2** | 细粒度控制：暂停/恢复自动对冲；暂停期间不下新单，监控与自检仍可用。 | **阶段 5** | ① 守护程序支持控制通道 **pause/resume**（如轮询控制文件或 API 的 trading_paused）。② 发 **pause** 后，守护程序在 pause 期间 **不下任何新对冲单**。③ 发 **resume** 后，行为与未 pause 时一致，可继续正常对冲。④ 暂停期间守护程序仍运行，监控与自检（若已实现）仍可用。 |
| **R-C3** | 一键平敞口：异常或红时可一键平掉本策略管理的对冲敞口；仅针对本守护程序负责的对冲仓位，不触碰其他头寸；**仅针对主账户**，不触碰第二账户。 | **阶段 5**（依赖 R-A1、持仓与策略边界等） | ① 控制通道支持 **flatten** 指令（控制文件或 API）。② 守护程序收到 flatten 后：先停止接受新对冲 → 根据**主账户**当前持仓（R-A1）与目标（0 或与期权 delta 匹配）计算平仓量 → 仅对**主账户**下发平仓单 → 将此次操作写入 sink 操作记录。③ 独立应用提供 **POST /control/flatten**（或等效）。④ 发 flatten 后，**主账户上本策略管理的对冲敞口**被平掉，且操作表有对应记录。⑤ **不触碰**主账户内非本策略头寸及**第二账户**。*实现依赖：R-A1 账户与持仓可获取、策略边界与平仓逻辑等，故安排在阶段 3 之后。* |

### 历史与统计（R-H*）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-H1** | 状态可扩展为带历史：写入接口支持“当前 + 历史”，避免先文件后迁库。 | **阶段 1** | ① sink 表结构或写入接口 **同时支持**“当前视图”（单行或最新 ts）与“历史表”（append 或按间隔采样）。② 后续增加历史查询或统计时，**无需修改**守护程序写逻辑，仅增加读/聚合即可。③ 配置可选择 sink 类型与路径（如 SQLite 路径），守护程序按配置写入。 |
| **R-H2** | 历史统计：基于历史数据做胜率、盈亏分布、按日/周/月汇总、对冲次数与滑点等。 | **阶段 3** | ① 存在**独立脚本或模块**（如 `scripts/check/stats_from_history.py` 或 `src/stats/`），**只读**阶段 1 sink 写入的历史表。② 数据来源与守护程序写出一致，**不跑** FSM/Guard/StateClassifier。③ 输出至少包含：**按日/周对冲次数**、**盈亏分布或汇总**；可选滑点、按月汇总等。④ 统计可**离线运行**，不依赖守护进程在线。⑤ Performance 页计算逻辑与按日/周/月汇总、胜率、盈亏分布的细化验收见本文档步骤 3.8 与阶段 3 验收清单。 |

### 回测（R-B*）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-B1** | 策略 PnL 优化：在历史数据上对比不同参数的理论 P&L、收益曲线、回撤等，优化策略回报。 | **阶段 4** | ① 存在**回测入口**（如 `scripts/backtest.py` 或回测模式），**不**连接 IB、**不**下真实单。② 数据源为**历史回放**（从历史表或回放文件按时间序喂入）。③ 输出包含 **理论 P&L、收益曲线、回撤**；可对比不同参数组合。④ 回测输出记录本 run 使用的 **gates 参数或 config_version/config_hash**，便于与实盘配置对应。 |
| **R-B2** | 安全边界验证：Guard/边界参数可验证；不同参数下对冲与拦截次数及原因可复盘。 | **阶段 4** | ① 回测**复用**与实盘相同的 StateClassifier、TradingFSM、ExecutionGuard、gamma_scalper_intent、apply_hedge_gates。② 输出包含每 tick **是否对冲、方向/数量、block reason**（被哪一 guard 拦截及原因）。③ 可复盘**不同参数**下：对冲次数、被各 guard 拦截次数及原因，用于 Guard/边界参数评估与微调。 |

### 实时行情与联动（R-RM*）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-RM1** | 守护程序双线：心跳循环 + IB 事件订阅；行情以事件驱动更新。 | **阶段 3 之后或按需** | ① 守护进程同时维护心跳循环（写 PG、轮询控制）与 IB 事件回调（tick/持仓/订单）。② 行情与持仓更新以 IB 事件驱动为主，轮询仅用于控制通道。 |
| **R-RM2** | 行情写入 Redis；唯一写入方为守护进程；监控不写 Redis 行情。 | **阶段 3 之后或按需** | ① 事件订阅所得行情写入 Redis 缓存（key/TTL 见设计文档 §2.3）。② 仅守护进程写 Redis 行情；监控 Server 不写。③ 无 Redis 时可降级为仅 PG + GET /status 轮询。 |
| **R-RM3** | 联动机制：守护写 Redis 后通过 Redis Pub/Sub 或 Streams 通知监控；监控订阅后读 Redis 并推前端。 | **阶段 3 之后或按需** | ① 守护在写 Redis 后发布通知（Pub/Sub 或 XADD）。② 监控 Server 订阅该通道；收到后读 Redis（或消息体）并向前端推送（WebSocket/SSE 或 GET /quotes）。③ 守护与监控仅需同连 Redis，不直连。 |

### 研究与发现（R-OD1）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-OD1** | 期权发现入口：Research 下提供 Option Discovery 子页，可选标的（来自 Watchlist STK）与到期日，为按到期询价与机会发现提供入口；第一步为 UI 与占位 API。 | **Option Discovery 步骤（第一步）** | ① Research 二级菜单新增「Option Discovery」。② 新页面：标的选择（来自 Watchlist STK）、到期选择（占位）、占位表格/说明（By expiration – Option quotes & IV coming next）。③ 后端 GET /research/option-expirations?symbol=... 返回 { symbol, expirations }（可空或 mock）。④ 通过 Research 进入 Option Discovery 页，可选标的、见到期占位与说明，API 可调通。 |

### 期权结构细化（R-OS1）

| 需求编号 | 需求简述 | 完成阶段 | 详细验收标准 |
|----------|----------|----------|----------------|
| **R-OS1** | 期权结构细化：每种结构类型对应明确腿模式与可选盈亏模型，便于校验、风控与监控。 | **后续（待定）** | 待阶段规划时补充。预计包含：① 各 structure_type 有腿 schema；② Structure 页按类型约束/引导；③ 可选后端校验与盈亏模型关联。 |

---

## 一、分步推进计划（阶段步骤与检查方式）

### 设计原则：状态暴露与历史数据

需求文档已明确 **历史数据与统计、回测** 为待实现需求。为避免“先写状态文件、后整体迁库”的大重构，采用：

- **统一写入抽象**：守护程序不直接写“状态文件”或“数据库”，而是调用 **状态 sink 接口**（例如 `write_snapshot(snapshot_dict)`）。sink 由配置选择，可替换为文件实现、SQLite 实现、Redis 实现等。
- **Phase 1 即支持“当前 + 历史”的存储**：优先实现 **SQLite sink**（单文件、无额外服务、天然支持“当前行 + 历史表”），监控读“当前”；后续统计直接查同一库的历史表。若希望零依赖先跑通，可同时提供 **FileSink**（仅写当前状态到 JSON），但监控与统计统一改为“从 SQLite 读”后，FileSink 仅作可选/调试用。

---

### 阶段 1：状态 sink + 最小控制（必须先做）

**详细执行计划**：[阶段 1 执行计划](plans/phase1-execution-plan.md)（实施步骤、代码锚点、文件变更、数据流与验收）。

**本阶段实现并验收的需求**：**R-M1a**、**R-M4a**、**R-C1a**、**R-H1**（均仅在本阶段完成，验收边界清晰）。  
**各需求详细验收标准**：见上文「需求与阶段一一对应及详细验收标准」表中 R-M1a、R-M4a、R-C1a、R-H1 对应行。

**目标**：守护程序通过可扩展的 sink 写出状态与操作记录；支持从进程外停止（信号 + 可选控制文件）。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **1.1** | **状态 sink 抽象与实现**：引入 `StatusSink` 接口（如 `write_snapshot(snapshot: dict)`）。**首选 SQLiteSink**：单文件 SQLite，表含当前视图（单行/最新 ts）+ 可选历史表（append）。snapshot 含 daemon_state、trading_state、symbol、spot、bid/ask、净 delta、股票持仓、option 腿数、daily_hedge_count、daily_pnl、data_lag_ms、config 摘要、ts。**R-M4a**：同一 sink 含操作/事件表，在对冲意图、下单、成交、撤单等发生时写入记录（时间、类型、方向、数量、价格、状态/原因）。config 指定 `status.sink`、路径。**可选 FileSink**：仅写当前状态到 JSON。 | 守护程序 heartbeat/_eval_hedge 后写 snapshot；持仓相关操作写操作记录；外部可从 SQLite/文件读当前状态与操作 | R-M1a、R-M4a、R-H1 |
| **1.2** | **信号处理停止**：`run_engine.py` 注册 SIGTERM/SIGINT → `app.stop()`（asyncio 安全通知主循环），优雅退出。 | kill/Ctrl+C 可停止守护程序 | R-C1a |
| **1.3** | **（可选）控制文件**：heartbeat 轮询控制文件（路径可配置），内容为 `stop` 则 `request_stop()`。 | 写控制文件即可触发停止 | R-C1a |

**里程碑**

- StatusSink 抽象落地，默认 SQLiteSink 写入当前状态（及可选历史）与操作记录；守护进程可配置 sink 类型与路径。
- SIGTERM/SIGINT 触发优雅停止；若实现 1.3，控制文件可触发停止。

**运行环境验证**（本阶段引入并验收）：项目已包含 IB 连接代码，阶段 1 验收时除 sink 与信号外，需确认运行环境可用：**(1) PostgreSQL** 表结构（按 [DATABASE.md](DATABASE.md) §2 用 psql 或启动守护进程验证）；**(2) IB TWS/Gateway 连通性**（启动守护进程或直连 TWS 验证）。详见 [阶段 1 执行计划](plans/phase1-execution-plan.md)。

**检查方式**

1. 按阶段 1 执行计划验收清单与 [DATABASE.md](DATABASE.md) §2 核对：配置（postgres）、Sink 接口、PostgreSQL 表与列、IB 连通性；可选验证 SIGTERM 停止。
2. 启动守护进程（配置 `status.sink` 及 PostgreSQL/路径），运行一段时间。
3. 从 sink（PostgreSQL 或 SQLite）查当前表，确认有最新 daemon_state、trading_state、spot、ts 等；若有操作发生，查操作表有对应记录。
4. 对本机进程发 SIGTERM/SIGINT，确认进程在数秒内退出且无异常栈。
5. 若实现 1.3：写控制文件，确认守护进程在下一 heartbeat 内停止。

**验证标准（测试标准）**：与「需求与阶段一一对应及详细验收标准」表中本阶段各需求一致；以下为阶段 1 的逐条核对清单。

| # | 需求 | 验收条 | 通过条件 |
|---|------|--------|----------|
| 1 | R-M1a | ①②③ | 守护程序写 snapshot 至 sink；可从 sink 读当前状态与 ts；snapshot 含规定字段 |
| 2 | R-M4a | ①②③ | 对冲/下单/成交/撤单时写操作记录；记录含时间/类型/方向/数量/价格/原因；外部可读 |
| 3 | R-H1 | ①②③ | sink 支持当前+历史；扩展历史无需改写逻辑；配置可选 sink 类型与路径 |
| 4 | R-C1a | ①②③ | 信号停止 100% 生效、数秒内退出；若做 1.3 则控制文件在轮询周期内触发停止 |

**本阶段 Test Case 清单**（阶段验收须全部通过）：

| Test Case ID | 对应需求 | 验收条 | 可执行步骤（通过条件） |
|--------------|----------|--------|------------------------|
| TC-1-R-M1a-1 | R-M1a | ① | 启动守护程序（配置 status.sink: sqlite + 路径），heartbeat 或 _eval_hedge 后向 sink 写入 snapshot |
| TC-1-R-M1a-2 | R-M1a | ② | 不依赖控制台，从 sink（SQLite 或 FileSink）读到当前状态与时间戳 |
| TC-1-R-M1a-3 | R-M1a | ③ | snapshot 至少含：daemon_state、trading_state、symbol、spot、bid/ask、净 delta、股票持仓、option 腿数、daily_hedge_count、daily_pnl、data_lag_ms、config 摘要（或等价）、ts |
| TC-1-R-M4a-1 | R-M4a | ① | 在对冲意图、下单、成交、撤单发生时，守护程序向 sink 操作/事件表写入一条记录 |
| TC-1-R-M4a-2 | R-M4a | ② | 每条记录至少含：时间、类型、方向（BUY/SELL）、数量、价格（若已成交）、状态/原因（如 D2/D3、block_reason） |
| TC-1-R-M4a-3 | R-M4a | ③ | 外部可从 sink 读到上述操作记录 |
| TC-1-R-H1-1 | R-H1 | ① | sink 表结构或写入接口同时支持“当前视图”与“历史表”（append 或按间隔采样） |
| TC-1-R-H1-2 | R-H1 | ② | 后续增加历史查询或统计时，无需修改守护程序写逻辑，仅增加读/聚合即可 |
| TC-1-R-H1-3 | R-H1 | ③ | 配置可选择 sink 类型与路径（如 SQLite 路径），守护程序按配置写入 |
| TC-1-R-C1a-1 | R-C1a | ①② | run_engine.py 注册 SIGTERM/SIGINT → app.stop()；对本机进程发 SIGTERM/SIGINT，守护程序在数秒内优雅退出且停止后不再下发任何新单 |
| TC-1-R-C1a-2 | R-C1a | ③ | （若实现 1.3）存在控制文件且内容为 stop 时，守护程序在轮询周期内执行 request_stop() 并退出 |

**阶段通过条件**：上表 **R-M1a、R-M4a、R-H1、R-C1a** 的验收条**全部通过**（若实现 1.3 则 R-C1a 含第③条）；即上述 **Test Case 全部通过**。通过后可进入阶段 2。

**阶段 1 完成后**：状态与操作通过 sink 写出（默认 SQLite）；监控/统计后续基于同一存储，无需重构写路径。

---

### 阶段 2：独立监控/控制应用（读 sink + 红绿灯 + 操作查询 + 安全控制）

**本阶段实现并验收的需求**：**R-M1b**、**R-M2**、**R-M3**、**R-M4b**、**R-C1b**；与阶段 1 无重叠，验收边界清晰。**R-C3（一键平敞口）** 依赖阶段 3 及后续能力（账户/持仓、策略边界等），不在本阶段验收，延后至**阶段 5**。  
**各需求详细验收标准**：见上文「需求与阶段一一对应及详细验收标准」表中 R-M1b、R-M2、R-M3、R-M4b、R-C1b 对应行。

**目标**：独立应用读 sink 输出，提供状态与红绿灯、操作查询，以及**一键停止**（安全控制）；平敞口（R-C3）留待**阶段 5**实现。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **2.1** | **独立应用**：新建入口（如 `scripts/run_server.py`），读阶段 1 sink（优先 SQLite/PostgreSQL 当前视图）。`GET /status` 返回 JSON，**须含 status_lamp**（基于 self_check 的 ok/degraded/blocked → green/yellow/red）；`GET /operations`（或等效）按时间/类型筛选；`POST /control/stop`（写控制通道或调本地 API）。*控制通道可预留 `flatten` 写入位，但 R-C3 不在本阶段实现。* | 独立进程：读 sink；GET /status（含红绿灯）、GET /operations、POST /control/stop | R-M1b、R-M2、R-M3、R-M4b、R-C1b |
| **2.2** | **配置与文档**：sink 路径、控制通道、监控应用端口等写入 config 与 README/docs。 | 配置示例与文档更新 | — |
| **2.3** | **R-C3 不在本阶段**：一键平敞口依赖 R-A1（账户与持仓）及策略边界等，安排在**阶段 5**；本阶段仅需控制通道可扩展（如 daemon_control 表已支持 command=flatten，守护进程消费后暂打日志或忽略即可）。 | 控制通道形态就绪；R-C3 验收不纳入阶段 2 | — |

**控制通道（阶段 2）**：采用 **PostgreSQL 表 `daemon_control`**（见 [DATABASE.md](DATABASE.md) §2.4），以支持**监控与交易分离（RE-5）**。表列 `command` 可取 `stop`、`flatten` 等；守护进程每次 heartbeat 轮询并消费。**本阶段仅验收 `stop`**；`flatten` 由独立应用写入表（接口预留），守护进程消费后暂打日志，R-C3 平仓逻辑在**阶段 5**实现。

**里程碑**

- 独立应用可读 sink 当前视图与操作表；GET /status 含 status_lamp（green/yellow/red）；GET /operations 可查询执行操作；POST /control/stop 可停止守护进程。
- 配置与文档完整，新环境可仅按文档部署“守护进程 + 独立应用”。

**检查方式**

1. 守护进程已运行且阶段 1 sink 已写入，启动独立应用。
2. curl/浏览器 GET /status：确认返回含 status_lamp，且绿/黄/红与自检结论一致。
3. GET /operations：确认返回近期执行操作列表（类型、时间、方向、数量等）。
4. curl POST /control/stop：确认守护进程在预期时间内停止。
5. 按文档在新环境从零配置，跑通“守护进程 + 独立应用”一次。

**验证标准（测试标准）**：与「需求与阶段一一对应及详细验收标准」表中本阶段各需求一致；以下为阶段 2 的逐条核对清单。

| # | 需求 | 验收条 | 通过条件 |
|---|------|--------|----------|
| 1 | R-M1b | ①② | GET /status 可获取当前运行状态（持仓、FSM、指标、配置摘要），无需控制台 |
| 2 | R-M2 | ①②③ | self_check（ok/degraded/blocked + block_reasons）可读且可供展示 |
| 3 | R-M3 | ①②③ | GET /status 含 status_lamp: green\|yellow\|red，与自检一致，一目了然 |
| 4 | R-M4b | ①② | GET /operations 支持筛选并返回涉及持仓变化的操作列表 |
| 5 | R-C1b | ①② | POST /control/stop 可使守护程序在预期时间内优雅退出 |
| 6 | 文档与部署 | — | 按文档在新环境可复现“状态+红绿灯+操作查询+停止” |

**本阶段 Test Case 清单**（阶段验收须全部通过）：

| Test Case ID | 对应需求 | 验收条 | 可执行步骤（通过条件） |
|--------------|----------|--------|------------------------|
| TC-2-R-M1b-1 | R-M1b | ① | 独立应用提供 GET /status（或等效） |
| TC-2-R-M1b-2 | R-M1b | ② | 通过该接口能拿到当前运行状态（持仓、FSM 状态、指标、配置摘要等），无需查看守护程序控制台 |
| TC-2-R-M2-1 | R-M2 | ①②③ | 守护程序或 sink 能产出 self_check（ok/degraded/blocked）；若不可对冲能产出 block_reasons；GET /status 或 sink 可读到自检结果 |
| TC-2-R-M3-1 | R-M3 | ①②③ | GET /status 返回含 status_lamp（green/yellow/red）；绿=ok、黄=degraded、红=blocked；操作者仅凭该字段即可判断运行状态 |
| TC-2-R-M4b-1 | R-M4b | ① | 独立应用提供 GET /operations（或等效），支持按时间范围或类型筛选 |
| TC-2-R-M4b-2 | R-M4b | ② | 通过该接口能返回涉及持仓变化的操作列表，供审计与排障 |
| TC-2-R-C1b-1 | R-C1b | ①② | 独立应用提供 POST /control/stop（或等效）；在局域网内通过该接口可使守护程序在预期时间内优雅退出，无需登录控制台 |
| TC-2-DOC | 文档与部署 | — | 按文档在新环境从零配置，跑通“守护进程 + 独立应用”一次 |

**阶段通过条件**：上表 **R-M1b、R-M2、R-M3、R-M4b、R-C1b** 及 TC-2-DOC 验收条**全部通过**。R-C3 不纳入阶段 2 验收。通过后可进入阶段 3。

**阶段 2 完成后**：监控与控制由独立应用完成；状态来源与未来统计一致，无二次迁移。

---

### 阶段 3：数据获取（账户、持仓、市值、账户执行交易、辅助行情、复盘页与统计）

**本阶段实现并验收的需求**：**R-A1**、**R-A2**、**R-A3**、**R-M6**、**R-M7**、**R-H2**。  
**各需求详细验收标准**：见上文「需求与阶段一一对应及详细验收标准」表中 R-A1、R-A2、R-A3、R-M6、R-M7、R-H2 对应行。

**目标**：完成账户、持仓、标的市价、**账户执行交易**、**复盘辅助行情（如 K 线）**、**复盘与风控分析页面**及历史统计等**数据的获取与展示**，供策略与监控使用。包含：(1) 守护程序从 IB 获取账户与持仓（R-A1）、标的市价并写入 status 供监控展示（R-M6）；(2) 获取账户执行/成交记录（R-A2）与辅助行情（R-A3），并提供**独立复盘页**（R-M7）；(3) **非实时市场数据拉取（如 K 线 backfill）经队列 + 独立 Worker 进程执行**（见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§4.4）；(4) 基于历史数据产出统计报表（R-H2）。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **3.1** | **账户与持仓**：连接 IB 后请求账户摘要与当前持仓；可选写入 sink 供 GET /status 展示；按配置间隔更新，断连行为与 RE-7 一致。 | 守护程序内可读账户/持仓；GET /status 可选展示 | R-A1 |
| **3.2** | **标的市价**：heartbeat 或按间隔向 IB 请求标的行情（spot、bid/ask），写入 daemon_auto_status_current；GET /status 含市价；监控页可展示持仓+当前价、盈亏、期权虚实。 | GET /status 含 spot 等；监控页可展示标的与持仓市价 | R-M6 |
| **3.3** | **账户执行交易**：从 IB 获取账户执行/成交（executions、fills 或报表）；写入 sink 或独立表；独立应用提供 GET /executions（或 /trades），支持按时间筛选。 | 可查询账户级执行/成交记录，供复盘与风控 | R-A2 |
| **3.4** | **复盘辅助行情（R-A3 扩展）**：K 线**股票与期权分表**——股票日线 **stock_day**、股票分钟/小时线 **stock_min**（1 min、5 mins、1 hour）；期权日线 **option_day**、期权分钟/小时线 **option_min**。从 IB 拉取并 UPSERT；**Watchlist** 表落库（CRUD），市场数据页标的 = 持仓 + Watchlist。**智能拉取**：首次可请求全部历史，后续根据最新一根 K 线时间决定 duration。GET /bars 支持 sec_type、period、标的（或 contract_key）；**报价**：Watchlist 与持仓的报价拉取后写入 **contract_quote_live**，供前端展示。 | 复盘页与市场数据页可读股票/期权 K 线；Watchlist 持久化；报价落库 | R-A3 |
| **3.5** | **非实时市场数据拉取 Worker**（[ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§4.4）：backfill 等非实时拉取**不入 API 进程同步执行**，而是**入队 + 独立 Worker 进程**。队列推荐 PostgreSQL 表或 Redis+RQ；Worker 单独进程从队列取任务、串行执行并遵守 IB Pacing（如任务间间隔 2s）。API：POST /bars/backfill 入队并返回 **job_id**；GET /bars/jobs、GET /bars/jobs/{id} 查询状态与结果；前端轮询 job 状态并在完成后刷新 coverage。 | 独立 Worker 进程；API 入队与 job 查询；前端轮询 job 状态 | R-A3 |
| **3.6** | **复盘与风控分析页面**：监控应用内新增独立页面或路由（如「复盘」/「风控」），与实时监控页分离；展示执行交易、辅助行情及风险/统计视图。 | 通过导航可进入复盘页，不与 R-M5 同屏 | R-M7 |
| **3.7** | **历史与统计**：独立脚本/模块只读历史表，产出按日/周对冲次数、盈亏分布或汇总等；可离线运行。 | 统计报表或 JSON（至少按日/周对冲次数、盈亏相关） | R-H2 |
| **3.8** | **Performance 计算与展示（R-M7/R-H2 细化）**：GET /performance 当前为 stub，需完成资本与资金流口径后依次实现 Realized/Unrealized/Transaction 与 %；验收以本文档阶段 3 验收清单与 GET /performance 实现为准。 | GET /performance 返回 Realized/Unrealized/Transaction 与 %；Performance 页分块展示 | R-M7、R-H2 |
| **3.9** | **未成交订单（R-A5）**：守护进程订阅 IB **orderStatusEvent**、**openOrderEvent**（及可选 execDetailsEvent）；在回调中维护 open orders 列表并写入 sink（如 `daemon_open_orders` 表或现有状态写入）；可选连接时/按需 **reqAllOpenOrders()**；独立应用提供 **GET /open-orders**；监控页展示挂单列表及状态。 | GET /open-orders 可查当前挂单；监控页可展示；事件驱动更新 | R-A5 |

**里程碑**

- 账户、持仓、标的市价可获取并供监控与对冲逻辑使用；**账户执行交易**与**辅助行情（K 线）**可获取并供复盘页使用；**非实时拉取（backfill）经队列 + 独立 Worker 进程执行**，API 入队返回 job_id，可查 job 状态；**复盘与风控分析页面**可独立于监控页访问；历史统计可产出报表。
- **当前部分已落地**：R-A1、R-M6 已实现（见下方实现说明）；R-A2、R-A3、R-M7、R-H2 待实现；**backfill 队列与 Worker** 可为同进程 asyncio 先行实现，再演进为独立 Worker 进程 + PG 表或 RQ。

**检查方式**

1. 启动守护程序并连接 IB，确认能读到账户标识、Balance/NetLiquidation、当前持仓；GET /status 含 account_*、spot、accounts_fetched_at。
2. 监控页可展示标的与持仓市价、盈亏、期权虚实等。
3. **R-A2**：GET /executions（或 /trades）可返回账户执行/成交记录，支持按时间筛选。
4. **R-A3**：可获取本策略标的的 K 线/OHLC，复盘页或 GET /bars 可读。
5. **非实时拉取 Worker**：POST /bars/backfill 入队并返回 job_id；独立 Worker 进程（或当前实现的同进程 worker）串行执行；GET /bars/jobs、GET /bars/jobs/{id} 可查状态与结果；前端可轮询并刷新 coverage。
6. **R-M7**：监控应用内可通过导航进入「复盘」/「风控」页，与实时监控页分离；页内可查看执行交易、辅助行情及风险/统计视图。
7. （R-H2）运行统计脚本，确认从历史表只读并产出按日/周对冲次数、盈亏汇总。
8. **R-A5**：守护运行且存在挂单时，GET /open-orders 返回列表；监控页展示挂单列表；状态变更（如成交/撤单）后列表更新可验证。

**验证标准（测试标准）**：与「需求与阶段一一对应及详细验收标准」表中 R-A1、R-A2、R-A3、R-M6、R-M7、R-H2 一致。

| # | 需求 | 验收条 | 通过条件 |
|---|------|--------|----------|
| 1 | R-A1 | ①②③ | 能获取账户基本信息；能获取当前持仓供对冲使用；更新与异常行为明确 |
| 2 | R-A2 | ①②③ | 能从 IB 获取账户执行/成交；写入存储并有查询接口；记录含时间/标的/方向/数量/成交价等 |
| 3 | R-A3 | ①②③④⑤⑥ | 股票/期权 K 线分表可拉取并写入；Watchlist 落库 CRUD；智能 duration；GET /bars 可读；Watchlist 报价写入 contract_quote_live；**非实时拉取（如 backfill）经队列入队、由独立 Worker 进程（或当前同进程 worker）执行，API 入队返回 job_id，GET /bars/jobs、GET /bars/jobs/{id} 可查状态与结果** |
| 4 | R-M6 | ①②③ | 标的市价写入 sink/status；GET /status 含市价；监控页可展示标的与持仓市价（含盈亏/虚实等） |
| 5 | R-M7 | ①②③ | 有独立复盘/风控页与导航；页内可展示执行交易、辅助行情、风险/统计视图；与 R-M5 分离 |
| 6 | R-H2 | ①②③④ | 只读历史表；数据与 sink 一致；输出含按日/周对冲次数、盈亏分布或汇总；可离线运行 |
| 7 | R-A5 | ①②③④ | 守护订阅 orderStatusEvent/openOrderEvent 并维护写 sink；GET /open-orders 返回挂单列表且字段满足；监控页展示；可选 reqAllOpenOrders |

**本阶段 Test Case 清单**（阶段验收须全部通过）：

| Test Case ID | 对应需求 | 验收条 | 可执行步骤（通过条件） |
|--------------|----------|--------|------------------------|
| TC-3-R-A1-1 | R-A1 | ① | 守护程序连接 IB 后能请求并获取当前账户基本信息（账户标识、Balance/NetLiquidation 等） |
| TC-3-R-A1-2 | R-A1 | ② | 守护程序能获取当前持仓（策略涉及标的的数量与方向），可供内部对冲逻辑使用 |
| TC-3-R-A1-3 | R-A1 | ③ | 账户与持仓在运行中可持续更新；IB 断连或异常时行为明确（重试/降级，不阻塞） |
| TC-3-R-A2-1 | R-A2 | ①②③ | 能从 IB 获取账户执行/成交记录；数据写入存储；GET /executions 或 /trades 可查询且记录含时间/标的/方向/数量/成交价等 |
| TC-3-R-A3-1 | R-A3 | ①②③④⑤ | 股票/期权 K 线存 stock_day/stock_min/option_day/option_min；Watchlist 表 CRUD；首次拉取全历史、后续智能 duration；GET /bars 支持 sec_type/period/标的；Watchlist 与持仓报价拉取后写入 contract_quote_live，复盘页或市场数据页可读 |
| TC-3-R-A3-2 | R-A3 | ⑥ | 非实时拉取（backfill）经队列入队；API 返回 job_id；GET /bars/jobs、GET /bars/jobs/{id} 可查状态与结果；独立 Worker 进程（或同进程 worker）串行执行并遵守 IB Pacing；前端可轮询 job 并刷新 coverage |
| TC-3-R-M6-1 | R-M6 | ① | 守护程序在运行中从 IB 拉取标的市价（spot 等）并写入 daemon_auto_status_current/sink |
| TC-3-R-M6-2 | R-M6 | ② | GET /status 返回中含标的市价（如 status.spot 或等价字段），可供监控页读取 |
| TC-3-R-M6-3 | R-M6 | ③ | 监控页能结合持仓与市价展示（如持仓+当前价、盈亏、期权虚实等）；多标的时市价可区分 |
| TC-3-R-M7-1 | R-M7 | ①②③ | 监控应用提供复盘/风控独立页面或路由；通过导航可进入；页内可展示执行交易、辅助行情、风险/统计视图，与 R-M5 分离 |
| TC-3-R-H2-1 | R-H2 | ①②③④ | 独立脚本/模块只读历史表；输出含按日/周对冲次数与盈亏相关；可离线运行 |
| TC-3-R-A5-1 | R-A5 | ①② | 守护进程订阅 orderStatusEvent、openOrderEvent（及可选 execDetailsEvent），维护 open orders 列表并写入 sink |
| TC-3-R-A5-2 | R-A5 | ② | GET /open-orders（或等效）返回当前挂单列表，至少含标的、方向、数量、限价、状态、已成交/剩余等 |
| TC-3-R-A5-3 | R-A5 | ③ | 监控页展示挂单列表；数据以事件驱动更新为主（可辅以轮询），状态变更后列表更新可验证 |

**阶段通过条件**：R-A1、R-A2、R-A5、R-A3、R-M6、R-M7、R-H2 验收条全部通过，即上述 Test Case 全部通过。通过后可进入阶段 4。

**阶段 3 实现说明（部分已落地）**：  
- **R-A1**：`IBConnector.get_managed_accounts()`、`get_account_summary(account)`；Store 存 account_summary、accounts_data；CONNECTED 时拉取，RUNNING 后**每 1 小时**拉取；sink/GET /status 可选展示 account_id、account_net_liquidation 等。`_refresh_positions(account)` 与账户同间隔；断连时 WAITING_IB 不拉取，重连后再次拉取。  
- **R-M6**：**每次心跳**向 IB 拉取标的现价并写入 `daemon_auto_status_current.spot`；GET /status 含 `status.spot`；监控页 IB 账户区块有刷新按钮（POST /control/refresh_accounts）、1 小时自动刷新、accounts_fetched_at 展示。  
- **R-A2**：待实现（从 IB 获取账户执行/成交，写入存储，GET /executions 或 /trades）。  
- **R-A3**：待实现（扩展：股票/期权 K 线分表 stock_day、stock_min、option_day、option_min；Watchlist 落库与 CRUD；智能拉取 duration；GET /bars 支持 sec_type/period/标的；Watchlist 报价写入 contract_quote_live；**非实时拉取经队列+独立 Worker 进程**，API 入队返回 job_id，GET /bars/jobs、GET /bars/jobs/{id}；当前可实现为同进程 asyncio worker，再演进为独立进程+PG 表或 RQ）。  
- **R-M7**：待实现（监控应用内复盘/风控独立页面或路由，与 R-M5 分离）。  
- **R-H2**：待实现（独立脚本/模块只读历史表，产出按日/周对冲次数、盈亏汇总等）。

---

### 阶段 4：交易策略框架与回测

**本阶段实现并验收的需求**：**R-B1**、**R-B2**。  
**各需求详细验收标准**：见上文「需求与阶段一一对应及详细验收标准」表中 R-B1、R-B2 对应行。

**目标**：建立交易策略框架、支持策略创建与**回测**（历史数据驱动、不连 IB、不下真实单），用于策略 PnL 优化与 Guard/安全边界验证。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **4.1** | **回测入口**：独立入口（如 `scripts/backtest.py`）或回测模式；数据源为历史回放；复用 StateClassifier、TradingFSM、ExecutionGuard、gamma_scalper_intent、apply_hedge_gates。 | 可运行的回测；输出理论 P&L、收益曲线、回撤；记录 config/gates 或 hash | R-B1 |
| **4.2** | **Guard 验证**：输出每 tick 是否对冲、方向/数量、block reason；可复盘不同参数下对冲与拦截次数及原因。 | 回测输出含决策与 block reason；支持多组参数对比 | R-B2 |

**里程碑**：有可运行的回测入口；用历史数据驱动同一套核心逻辑；输出足以支持策略回报优化与 Guard/边界参数评估。

**验证标准（测试标准）**：与 R-B1、R-B2 表中验收条一致。**本阶段 Test Case 清单**：TC-4-R-B1-*（不连 IB、历史回放、输出 P&L/曲线/回撤、记录 config/gates）；TC-4-R-B2-*（复用核心逻辑、输出对冲与 block reason、可复盘不同参数）。**阶段通过条件**：R-B1、R-B2 全部验收条通过。通过后可进入阶段 5。

---

### 阶段 5：自动交易对冲与监控（基于成熟策略）

**本阶段实现并验收的需求**：**R-C2**、**R-C3**。  
**各需求详细验收标准**：见上文「需求与阶段一一对应及详细验收标准」表中 R-C2、R-C3 对应行。

**目标**：在阶段 1/2 监控与控制基础上，完成**基于成熟策略的自动交易对冲与监控**：细粒度控制（暂停/恢复）、一键平敞口（安全兜底），以及监控与对冲逻辑的完善。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **5.1** | **暂停/恢复**：控制通道支持 pause/resume；pause 期间零新单，resume 后行为一致；暂停期间监控与自检仍可用。 | 独立应用可发 pause/resume；守护进程行为符合验收条 | R-C2 |
| **5.2** | **一键平敞口**：控制通道支持 flatten；守护程序根据当前账户/持仓与目标计算平仓量并下单，写入操作记录；独立应用 POST /control/flatten；不触碰非本策略头寸。 | 发 flatten 后本策略对冲敞口被平掉；操作表有记录 | R-C3 |

**里程碑**：支持 pause/resume；支持一键平敞口（R-C3）；监控与自动对冲可稳定运行。**阶段通过条件**：R-C2、R-C3 验收条全部通过（R-C3 的 Test Case 待该阶段规划时补全）。

---

### 实时行情与联动（R-RM*，可选；建议阶段 3 之后）

**本步骤实现并验收的需求**：**R-RM1**、**R-RM2**、**R-RM3**。

**目标**：守护进程双线（心跳 + IB 事件订阅）；事件订阅所得行情写入 Redis；通过 Redis Pub/Sub 或 Streams 联动监控端；监控订阅后读 Redis 并推前端，使 UI 可获得近实时行情。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **RM.1** | **守护进程**：在 IB tick/持仓回调中写 Redis（行情缓存）+ 发布联动通知（Pub/Sub 或 Streams）；配置 Redis 连接与开关。 | 守护写 Redis + 发布；无 Redis 时降级 | R-RM1、R-RM2 |
| **RM.2** | **监控 Server**：订阅 Redis 联动通道；收到通知后读 Redis（或解析消息体），推送给前端（WebSocket/SSE 或 GET /quotes）。 | 监控可推送行情；不写 Redis 行情 | R-RM3 |
| **RM.3** | **前端**：消费监控推送或轮询 GET /quotes，展示行情墙/ticker 等。 | UI 可展示近实时行情 | — |

**里程碑**：守护双线运行且写 Redis + 发布；监控订阅并推前端；UI 可展示由守护事件驱动的行情。**检查方式**：按上文「需求与阶段一一对应及详细验收标准」表中 R-RM1/R-RM2/R-RM3 验收条执行。**阶段通过条件**：R-RM1、R-RM2、R-RM3 对应验收条全部通过。

---

### 期权发现（Option Discovery，R-OD1；阶段 3 扩展）

**本步骤实现并验收的需求**：**R-OD1**（第一步）。

**目标**：在 Research 下提供 Option Discovery 入口页，为按到期询价与机会发现打基础；第一步仅 UI 与占位 API，后续接入 IB reqSecDefOptParams 与期权快照。

| 步骤 | 内容 | 可交付物 | 对应需求 |
|------|------|----------|----------|
| **OD.1（第一步）** | Research 二级菜单新增「Option Discovery」；新页面：标的选择（来自 Watchlist STK）、到期选择（占位）、占位表格/说明（By expiration – Option quotes & IV coming next）；后端 GET /research/option-expirations?symbol=... 返回 { symbol, expirations }（可空或 mock）。 | 可通过 Research 进入 Option Discovery 页，可选标的、见到期占位与说明；API 可调通 | R-OD1 |
| **OD.2（已实现）** | 后端接入 IB reqSecDefOptParams，返回真实到期与 strikes；前端到期下拉绑定该 API，展示错误与 strikes。 | 到期列表来自 IB；API 返回 expirations + strikes；前端可选到期、显示错误 | R-OD1 扩展 |
| **OD.3（后续）** | 期权快照任务（选定标的+到期+有限 strike，pacing）与发现逻辑；可选「加入 Watchlist」。 | 按到期询价与机会发现 | R-OD1 扩展 |

**第一步验收**：按上文「需求与阶段一一对应及详细验收标准」表中 R-OD1 验收条 ①～④ 执行。**第一步通过条件**：全部通过。

---

### 期权结构细化（R-OS1；后续）

**本步骤实现并验收的需求**：**R-OS1**（阶段与验收在立项时确定）。

**目标**：将结构类型从“标签”升级为带腿约束与盈亏语义的建模基础；为后续 Structure 页细化、风控按结构配置、按结构统计与回测做预留。

**需求与意义**：见 [REQUIREMENTS.md](REQUIREMENTS.md) §4.4。

**后续实施时预计包含**：① 为各 structure_type 定义腿 schema；② Structure 页面按类型预填/约束/引导（custom 保持自由）；③ 可选后端校验与可选盈亏模型关联。**阶段归属与详细验收标准**在启动该改造时再写入本表与阶段步骤。

---

**按需项**（不绑定阶段 3/4/5）：可选 Redis/PostgreSQL sink 扩展；部署与进程管理（systemd/supervisor、文档）。

---

### 策略与安全边界落库（Strategy & gate_safety tables；阶段 3 扩展 / 阶段 4 前）

**本步骤实现并验收的需求**：与 [REQUIREMENTS.md](REQUIREMENTS.md) §4.3（策略与安全边界数据模型与落库）对应；为阶段 4 回测与策略版本管理提供 DB 基础。

**目标**：策略三层（structure / opportunity / portfolio）与安全边界四层（gate_safety_strategy / state / intent / guard）表落库；settings 存当前生效 id；监控端 Reader 支持从 DB 按 gate_safety_strategy_id 组装 gates；可选地守护进程在 active_gate_safety_strategy_id 非空时从 DB 加载 gates。

| 步骤 | 内容 | 可交付物 | 验收 |
|------|------|----------|------|
| **SG.1** | DDL：创建 strategy_structure、strategy_opportunity、strategy_allocation、gate_safety_strategy、gate_safety_strategy_earnings_dates、gate_safety_state、gate_safety_intent、gate_safety_guard；settings 增加 active_strategy_structure_id、active_gate_safety_strategy_id。 | 执行 db_refresh_schema 后上述表存在且符合 [DATABASE.md](docs/DATABASE.md) §2.24 | ① TC-策略落库-1：表存在性检查 |
| **SG.2** | Reader：get_gates_by_id(conn, gate_safety_strategy_id) 从 DB 组装为与 config["gates"] 同形的字典；get_active_gate_safety_strategy_id、get_active_strategy_structure_id 从 settings 读取。StatusReader 暴露上述接口。 | 监控端可按 id 读取 gates；可读当前生效 id | ② TC-策略落库-2：Reader 返回结构与 get_hedge_config 兼容 |
| **SG.3**（可选） | 守护进程：启动时若 settings.active_gate_safety_strategy_id 非空，则从 DB 加载 gates 并注入 config，否则回退文件。 | 实盘可优先使用 DB 中的安全边界集 | ③ TC-策略落库-3：守护进程使用 DB gates 时 hedge 参数正确 |
| **SG.4**（可选） | API 与种子：POST /config/active-strategy 写入 active_*；脚本从 config.yaml 的 gates 生成一条 gate_safety_* 种子数据。 | 可从前端或 API 切换当前生效；可一键从现有 config 落一条边界集 | — |

**验收标准**：① 执行 db_refresh_schema 后 strategy_*、gate_safety_* 表及 settings 两列存在。② Reader 提供 get_gates_by_id(conn, gate_safety_strategy_id)，返回可与 get_hedge_config 兼容的扁平 dict 或 gates 子树；settings 可读写 active_*。③（可选）守护进程在 active_gate_safety_strategy_id 非空时使用 DB gates。**通过条件**：①、② 必须通过；③、SG.4 可选。

**阶段 A（Phase A）**：在 SG.1–SG.4 基础上，完成「只读闭环 + 后台管理与监控」：Reader 扩展（get_structure_by_id、list_structures、list_gate_safety_sets、get_gate_safety_name、get_strategy_history）；守护进程启动时若 active_strategy_structure_id 非空则从 DB 加载 structure 并注入 config[\"active_strategy_structure\"]；PostgresSink 在 append_history=True 时同步写入 strategy_history（strategy_structure_id 来自 settings，state_summary 为 snapshot 子集）；GET /status 返回 active_strategy_structure_id、active_gate_safety_strategy_id 及对应 name；新增 GET /strategies/structures、GET /strategies/structures/{id}、GET /strategies/history、GET /strategies/gate-safety。验收：守护进程使用 DB structure 时 config 含 active_strategy_structure；GET /status 含当前生效策略/边界 id 与 name；发生对冲相关操作后 strategy_history 有新增行；GET /strategies/* 可返回数据。详见 .cursor/plans 中 Phase A 计划。

**Phase A 监控端 UI（Strategy 管理页）**：监控前端在 Research 下新增 Strategy 子页，提供结构策略列表、安全边界列表、策略历史表及 Set active 操作；Status 页 Strategy 面板展示当前生效结构/边界名称并提供「Manage»」进入 Research → Strategy。验收：通过 Research → Strategy 可查看列表与历史、可设置当前生效；Status 面板显示当前生效名称并可跳转 Strategy 页。

---

### 历史统计与回测：和自动交易逻辑的落地关系（小结）

| 能力 | 与自动交易代码的关系 | 代码落地 |
|------|----------------------|----------|
| **历史统计** | **不跑** FSM/Guard/StateClassifier；只读 sink 写入的历史 snapshot，做聚合与报表。 | 独立脚本/模块，只读 DB + 可选 config；与守护程序同仓库。 |
| **回测** | **复用** StateClassifier、TradingFSM、ExecutionGuard、gamma_scalper_intent、apply_hedge_gates；数据源 = 历史回放，执行 = 模拟（产出 PnL/收益曲线与决策、block reason，不下单）。**首要用于策略 PnL 优化**，兼做 Guard 验证。 | 独立入口或“回测模式”；同一套核心逻辑，注入历史数据、替换 connector/place_order 为只写结果。 |

---

## 三、实施顺序与依赖

```
阶段 1（1.1 sink + 1.2 信号停止 + 1.3 可选控制文件）
    │
    └──→ 阶段 2（2.1 独立应用 + 2.2 配置与文档；R-C3 延后至阶段 5）
              │
              └──→ 阶段 3（数据获取：R-A1、R-M6、R-H2）
              │
              └──→ 阶段 4（策略与回测：R-B1、R-B2）
              │
              └──→ 阶段 5（自动对冲与监控：R-C2、R-C3）
```

- **阶段 1** 一次做好 sink 抽象与写出（当前+历史+操作），后续换 sink 或加读者均不重构守护程序写逻辑。
- **阶段 2** 依赖阶段 1 的 sink 输出；独立应用只读“sink 写到哪里就去哪里”。
- **阶段 3** 完成账户、持仓、市值、交易历史与统计等**数据获取**，为策略与监控提供数据基础；当前 R-A1、R-M6 已实现，R-H2 待实现。
- **阶段 4** 建立策略框架与回测，只读历史 DB 或回放数据，复用 FSM/Guard，不连 IB、不下真实单。
- **阶段 5** 在成熟策略与数据基础上，完成自动交易对冲与监控（暂停/恢复、一键平敞口等）。

---

## 四、各阶段文档结构说明

每个阶段（含 3.1–3.5 子步）均按以下结构编写，便于执行与验收：

| 要素 | 说明 |
|------|------|
| **本阶段实现并验收的需求** | 本阶段交付并需验收的产品需求编号（R-M*/R-C*/R-H*/R-B*）；**详细验收标准**以「需求与阶段一一对应及详细验收标准」表中对应行为准。 |
| **里程碑** | 本阶段完成时达成的可检查成果（一句话或要点列表）。 |
| **检查方式** | 如何测试、如何检查（操作步骤或测试场景）。 |
| **验证标准（测试标准）** | 本阶段的逐条核对清单，与总表中本阶段各需求的验收条一致；**阶段通过条件** = 本阶段负责的需求在总表中的验收条全部通过。 |

**唯一权威验收依据**：各需求的**详细验收标准**以本文档「需求与阶段一一对应及详细验收标准」表为准；产品需求见 **docs/REQUIREMENTS.md**；运行环境与部署约束见 **docs/ARCHITECTURE.md §2**；架构与组件映射见 **docs/ARCHITECTURE.md**。

---

## 五、待确认或可调整项

1. **Sink 首选**：阶段 1 默认 **SQLiteSink**（当前+历史），可选 FileSink 调试；若希望先仅文件再迁 SQLite，需在阶段 1 仍保留 sink 抽象。
2. **历史写入频率**：历史表“每次 heartbeat 写一行”或“每 N 秒/每次 _eval_hedge”—实现时定，影响表体积与统计粒度。
3. **控制文件**：阶段 1 是否做 1.3（控制文件停止），还是仅 1.2（信号停止）、由阶段 2 独立应用写控制文件时再实现轮询。
4. **R-C3 阶段**：一键平敞口**依赖 R-A1（账户与持仓）及策略边界、平仓逻辑等**，故**不在阶段 2 验收**，安排在**阶段 5**；独立应用控制接口已预留 POST /control/flatten 与 daemon_control 表，守护进程侧平仓逻辑待阶段 5 实现。
5. **阶段 3/4/5 顺序**：阶段 3（数据获取）为策略与监控的数据基础；阶段 4（策略与回测）依赖阶段 1 历史表，可与阶段 3 的 R-H2 排期配合；阶段 5（自动对冲与监控）依赖阶段 3 的 R-A1 等。

---

## 六、分阶段实施方法（推荐）

按阶段写代码时，建议采用以下方式，便于验收与回溯。

### 6.1 原则

| 原则 | 说明 |
|------|------|
| **一阶段一验收** | 只在一个阶段内开发，完成该阶段**全部 Test Case 通过**后再进入下一阶段；不跨阶段混做。 |
| **以 Test Case 为检查清单** | 每完成一个步骤（如 1.1、1.2），立刻对照本阶段「本阶段 Test Case 清单」执行一遍；阶段结束前再完整跑一遍全部 TC。 |
| **小步提交** | 按步骤或按需求提交（如 `feat(sink): StatusSink 接口 + SQLiteSink`、`feat(sink): GsTrading 写入 snapshot`、`feat(ctrl): run_engine 注册 SIGTERM/SIGINT`），便于回滚与 code review。 |
| **先接口后实现** | 阶段 1：先定 `StatusSink` 接口与 snapshot/operations 数据结构，再实现 SQLiteSink，最后在 GsTrading 中挂接；阶段 2：先定独立应用 API（GET /status、GET /operations、POST /control/stop），再实现读 sink 与写控制文件。 |

### 6.2 阶段内推荐顺序（以阶段 1 为例）

1. **接口与配置**：定义 `StatusSink` 抽象（如 `write_snapshot(snapshot: dict)`、`write_operation(record: dict)`）；在 config 中增加 `status.sink`、`status.path`（及可选 `control.file`）。  
2. **SQLiteSink 实现**：建表（当前视图表 + 历史表 + 操作表）；实现写入与可选“当前行 upsert + 历史 append”。  
3. **守护程序挂接**：在 GsTrading 的 heartbeat / _eval_hedge 后调用 sink 写 snapshot；在对冲意图、下单、成交、撤单处写操作记录。  
4. **信号停止**：在 `run_engine.py` 中注册 SIGTERM/SIGINT，通过 `loop.call_soon_threadsafe` 或等效方式安全调用 `app.stop()`。  
5. **（可选）控制文件**：heartbeat 中轮询控制文件，若为 `stop` 则 `request_stop()`。  
6. **验收**：按「检查方式」与「本阶段 Test Case 清单」逐条执行，全部通过后打 tag 或合并分支，再进入阶段 2。

### 6.3 分支与发布建议

- **分支**：可按阶段开分支（如 `phase-1-sink-and-signals`），阶段验收通过后合并到 `main`；或直接在 `main` 上小步提交。  
- **Tag**：阶段验收通过后打 tag（如 `phase-1-done`），便于与「阶段 1 已完成」对应。  
- **文档**：每阶段完成后更新 README/docs（如阶段 1 完成后说明如何配置 sink、如何用 sqlite3 查看状态；阶段 2 完成后说明如何启动独立应用与调用 API）。

### 6.4 可选：Test Case 自动化

- 阶段 1：验收按 [阶段 1 执行计划](plans/phase1-execution-plan.md) 验收清单**人工执行**（配置、Sink 接口、PostgreSQL 表结构、IB 连通性、SIGTERM 停止）；无专用自检脚本。
- 阶段 2：可对独立应用做 HTTP 测试（如 `curl` 或 pytest-requests）：GET /status 含 status_lamp、GET /operations 返回列表、POST /control/stop 后守护进程退出。  
- 自动化不必一次做完；先用手动执行 Test Case 清单，通过后再逐步把关键步骤固化为脚本或用例，便于回归。

---

*本文档已按最新运行环境与产品需求、结合当前项目功能代码重组；每阶段均标明实现的需求、里程碑与测试标准，可作为开发与评审依据。*
