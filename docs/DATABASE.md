# 数据库设计（PostgreSQL）

本文档是 **Bifrost Trader Engine** 与 PostgreSQL 交互的**唯一正式设计说明**。当前与未来所有阶段中，与数据库相关的表结构、写入策略、配置及变更均以此文档为准；各阶段执行计划、代码与文档可引用本文档的章节或表名。

**存储选型**：阶段 1 起采用 **PostgreSQL** 作为状态与操作持久化后端（不做 SQLite），需本地或 Docker 提供 PostgreSQL 实例。

---

## 1. 连接与配置

- **配置项**：在 `config/config.yaml` 的 root 配置 `postgres`：
  - `postgres.host`, `postgres.port`, `postgres.database`, `postgres.user`, `postgres.password`；或
  - 使用环境变量（如 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`）或 DSN。
- **代码入口**：`StatusSink` 实现（如 `PostgreSQLSink`）在守护程序启动时根据上述配置建立连接；需处理连接失败与重连（见各阶段实现说明）。
- **引用**：阶段 1 执行计划 → [plans/phase1-execution-plan.md](plans/phase1-execution-plan.md) 步骤 1、2。

---

## 2. 阶段 1 表结构（当前视图、历史、操作）

阶段 1 引入三张表：**当前状态**（单行）、**状态历史**（追加）、**操作记录**（仅对冲相关事件）。后续阶段如需新增表或字段，在本文档中增加对应章节并注明引入阶段。

### 2.1 表 `status_current`（当前视图）

- **用途**：仅保留一行“最新”运行状态快照，供监控（阶段 2 GET /status）与运维查看，无需查历史表。
- **写入**：由守护程序在**每次 heartbeat** 时 upsert（或 replace）一行；列与 snapshot 字典一致。**每次心跳**会向 IB 拉取标的现价并更新 `spot`，供监控页计算持仓盈亏与期权内在价值/虚实（ITM/OTM）。
- **列**（与 R-M1a 一致）：

| 列名 | 类型 | 说明 |
|------|------|------|
| daemon_state | text | DaemonFSM 状态，如 RUNNING |
| trading_state | text | TradingFSM 状态，如 MONITOR |
| symbol | text | 当前活跃标的；由守护进程根据持仓推导，无活跃标的时可为空 |
| spot | double precision | 当前标的价格（每心跳从 IB 拉取并写入） |
| bid | double precision | 买一 |
| ask | double precision | 卖一 |
| net_delta | double precision | 净 delta |
| stock_position | integer | 股票持仓（股） |
| option_legs_count | integer | 期权腿数 |
| daily_hedge_count | integer | 当日对冲次数 |
| daily_pnl | double precision | 当日 PnL（美元） |
| data_lag_ms | double precision | 数据延迟（毫秒） |
| config_summary | text | 配置摘要（如 gates 的 hash 或关键键） |
| ts | double precision 或 timestamptz | 快照时间戳 |

- **主键/唯一**：单行表使用固定行 id=1，upsert 时更新该行。

- **涉及库表**：上述列所在数据库与表为：配置中的 **PostgreSQL**（`config.postgres` 或环境变量 `PGHOST` 等，见 [ARCHITECTURE.md](ARCHITECTURE.md) §2 运行环境）。**账户相关数据**仅存于 **accounts**、**account_positions** 表（§2.7、§2.8），status_current/status_history 不再包含 account_* 或 accounts_snapshot 列；GET /status 的 `accounts` 从这两张表组装。同一库内还有 operations、daemon_control、daemon_heartbeat、daemon_run_status 等表。

### 2.2 表 `status_history`（状态历史）

- **用途**：按时间序保留状态快照，供**阶段 3**历史统计与后续分析；R-H1 要求“当前 + 历史”同一 sink。
- **写入**：仅在**有意义**时追加（见下文「写入策略」），例如发生对冲相关操作时或可选每心跳一条；纯无操作心跳不追加。
- **列**：与 `status_current` 列一致，另加自增主键便于分页与保留策略：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| daemon_state | text | 同 status_current |
| trading_state | text | 同 status_current |
| … | … | 其余同 status_current |
| ts | double precision 或 timestamptz | 快照时间戳 |

### 2.3 表 `operations`（操作记录）

- **用途**：记录与持仓变化相关的操作，供审计、排障与阶段 2 GET /operations 查询；R-M4a。
- **写入**：仅在对冲**意图发出、订单发出、成交、拒绝/撤单**时插入一行。
- **列**（与 R-M4a 一致）：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键（可选，便于分页） |
| ts | double precision 或 timestamptz | 操作时间戳 |
| type | text | hedge_intent \| order_sent \| fill \| reject \| cancel |
| side | text | BUY \| SELL |
| quantity | integer | 数量（股） |
| price | double precision | 价格（可选，成交时有） |
| state_reason | text | 状态/原因，如 D2、D3、block_reason |

### 2.4 表 `daemon_control`（阶段 2：控制通道，替代本地文件）

- **用途**：供监控服务（可运行在另一台主机，RE-5）向守护进程发送控制指令（stop/flatten/refresh_replay 等），替代本地控制文件，无需共享文件系统（如 NFS）。
- **写入**：监控应用在 POST /control/stop、POST /control/flatten、POST /control/retry_ib（RE-7）、**POST /control/refresh_replay** 时 **INSERT** 一行；**POST /control/refresh_accounts 不写本表**，由监控端用其维护的 AccountIbClient 直接向 IB 拉取并写 accounts/account_positions。守护进程在每次 heartbeat 轮询并 **消费**（标记 consumed_at）后执行对应逻辑。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| command | text NOT NULL | 指令：`stop`、`flatten`、`retry_ib`（RE-7）、`refresh_accounts`（守护进程消费后从 IB 拉取账户/持仓并写 DB，**监控页刷新不写此指令**）、`refresh_replay`（R-A2：仅从 IB 拉取执行记录写 account_executions，供复盘与风控 Tab 刷新） |
| created_at | timestamptz | 创建时间（默认 now()） |
| consumed_at | timestamptz | 守护进程消费时间；NULL 表示待处理 |

- **消费语义**：守护进程 `SELECT` 一条 `consumed_at IS NULL` 且 `id` 最小的行，执行对应 command 后 `UPDATE consumed_at = now()`，避免重复触发。监控与守护进程使用同一 PostgreSQL（root `postgres` 配置），故无跨机文件依赖。
- **过期不执行**：若指令的 `created_at` 早于当前时间超过约 60 秒（如上次运行遗留的 stop），守护进程仍会**消费**该行（标记 `consumed_at`）以清空队列，但**不执行**该指令，避免新启动的守护进程误执行“上一次”的停止。

### 2.7 表 `accounts`（阶段 3.0 R-A1：多账户摘要，由 accounts_snapshot 规范化）

- **用途**：存 IB 多账户摘要，便于按账户查询、更新与后续账户操作；由守护进程在写入 snapshot 时从内存中的 accounts_snapshot 同步写入（每账户一行）。**多账户时**：主账户用于守护进程对冲与行情（由 config 或 settings 的 `primary_account_id` 指定）；**所有账户**均写入本表，供统一 Portfolio 展示。
- **写入**：按 **account_id** 唯一键 upsert（`ON CONFLICT (account_id) DO UPDATE`），不删整表、不整表重插；仅更新该账户行。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_id | text PRIMARY KEY | 账户标识（如 U17113214） |
| updated_at | timestamptz | 最后更新时间 |
| net_liquidation | double precision | 净资产（来自 IB NetLiquidation） |
| total_cash | double precision | 总现金（TotalCashValue） |
| buying_power | double precision | 购买力（BuyingPower） |
| summary_extra | jsonb | 其他 IB summary 键值（未单独列出的 tag） |

### 2.8 表 `account_positions`（阶段 3 R-A1：多账户持仓，由 accounts_snapshot 规范化）

- **用途**：存每个账户的持仓明细，便于按账户/标的查询与后续风控、对冲逻辑。**多账户时**：主账户用于守护进程对冲与行情；**所有账户**的持仓均写入本表，供统一 Portfolio 展示。
- **主键**：**(account_id, contract_key)**，无自增 id；据此判断插入新行或更新现有行。
- **contract_key** 格式为 `symbol|sec_type|expiry|strike|right`，期权（OPT）用到期/行权价/权利区分合约，股票（STK）为 `symbol|STK|||`。
- **写入**：与 `accounts` 同步；对 snapshot 中每条持仓计算 contract_key 后 `INSERT ... ON CONFLICT (account_id, contract_key) DO UPDATE`；仅删除该账户下**不在当前 snapshot** 的行（平仓或移除的持仓），不整表清空。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_id | text NOT NULL | 所属账户（主键之一） |
| contract_key | text NOT NULL | 合约唯一键（主键之一）：symbol\|sec_type\|expiry\|strike\|right |
| symbol | text | 标的代码 |
| sec_type | text | 类型（STK/OPT 等） |
| exchange | text | 交易所 |
| currency | text | 币种 |
| position | double precision | 持仓数量 |
| avg_cost | double precision | 平均成本 |
| expiry | text | 期权到期（lastTradeDateOrContractMonth，YYYYMM/YYYYMMDD） |
| strike | double precision | 期权行权价 |
| option_right | text | 期权权利（C/P 或 CALL/PUT）；列名不用 right 因系 PostgreSQL 保留字 |
| updated_at | timestamptz | 最后更新时间 |

- **语义**：GET /status 的 `accounts` 从 **accounts** + **account_positions** 组装为 `[{ account_id, summary, positions }]` 形状；若表不存在或查询失败则返回空数组。GET /status 同时返回 **accounts_fetched_at**（Unix 秒，取 accounts 表 max(updated_at)），供监控页显示「数据来自 …，已过 N 分钟」。监控页「IB 账户」**刷新**由监控端维护的 **AccountIbClient** 直接向 IB 拉取账户/持仓并写入 accounts/account_positions，不写 daemon_control；该区块另有 **1 小时** 自动刷新（仅读 DB 更新展示）。

### 2.10 表 `instrument_prices`（阶段 3 R-M6：持仓标的当前价）

- **用途**：按 `contract_key`（同 `account_positions`）存放**每个持仓标的的当前价**，用于监控页逐行展示「当前价」并计算浮动盈亏。设计为**与账户无关**：同一合约在多个账户持有时仅存一行价格。
- **写入**：守护进程 **首次有持仓时** 或监控端 **Accounts Refresh** 时，按持仓标的从 IB 全量拉价并 Upsert 到本表；**每次心跳** 则用 Redis 中 Event 已写入的行情（Real-time ticker）更新本表，仅更新有 Redis 数据的标的，不再每心跳向 IB 拉价。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| contract_key | text PRIMARY KEY | 合约唯一键：`symbol\|sec_type\|expiry\|strike\|right`，与 `account_positions` 一致 |
| symbol | text | 标的代码 |
| sec_type | text | 类型（STK/OPT 等） |
| expiry | text | 期权到期（YYYYMM/YYYYMMDD） |
| strike | double precision | 期权行权价 |
| option_right | text | 期权权利（C/P 或 CALL/PUT） |
| last | double precision | 最新成交价（若 IB 提供） |
| bid | double precision | 买一 |
| ask | double precision | 卖一 |
| mid | double precision | 中间价：`(bid+ask)/2`，若无则回退为 last |
| updated_at | timestamptz | 最后更新时间 |

- **读取**：`servers/reader.get_accounts_from_tables()` 在读取 `account_positions` 时 LEFT JOIN 本表，将 `mid/last` 作为 `price` 字段下发到 `accounts[*].positions[*]`，前端据此逐行展示当前价并计算浮动盈亏；若某合约暂无价格，则对应行的 `price` 为 NULL，前端显示 `—`。**STK 回退**：若本表无该合约价格，reader 会从 **stock_day** 取该 symbol 按 `bar_time` 倒序的最新一根日线；若该根日线的日期为**当日**，则用**前一根**的 `close`（避免未收完的当日 K 线），否则用最新一根的 `close`，作为 `price` 与 `price_updated_at` 下发，并参与浮动盈亏与 Daily % / Daily $ 计算。

### 2.11 表 `account_executions`（阶段 3 R-A2：账户执行/成交记录）

- **用途**：存**账户级**执行/成交记录（含手动与机器），供复盘与风控（GET /executions、复盘页）查询；与 `operations`（仅本程序对冲事件）区分。对应 IB 的 **Execution** 结构，不含手续费/实现盈亏（见 §2.11.1）。
- **写入**：由守护程序周期从 IB 拉取 executions/fills，或独立脚本/服务拉取后写入；按 `exec_id` 去重（若 IB 提供），避免重复插入。手续费与实现盈亏写入 **account_execution_commissions**（§2.11.1）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| account_id | text | 账户标识 |
| exec_id | text | IB 执行 id（若有，用于去重，Flex 中为 ibExecID） |
| exec_time | timestamptz | 成交时间（TWS/Flex dateTime 解析后） |
| symbol | text | 标的 |
| sec_type | text | 类型（STK/OPT 等；Flex assetCategory 映射） |
| side | text | BUY / SELL（由 IB BOT/SLD 或 Flex buySell 映射） |
| quantity | double precision | 数量 |
| price | double precision | 成交价（TWS/Flex tradePrice） |
| source | text | 来源：**tws_event**（通过 IB TWS 事件流/reqExecutions 拉取的成交）、**flex_trades**（Flex Trades 报表）、**manual**（前端 Add Trade 手动补录）等 |
| expiry | text | 期权到期（YYYYMMDD，OPT 时；来自 TWS/Flex expiry） |
| strike | double precision | 期权行权价（OPT 时；来自 strike） |
| option_right | text | 期权权利 C/P（OPT 时；来自 right/putCall） |
| exchange | text | 交易所（Execution.exchange 或 Flex exchange） |
| order_id | bigint | IB 订单 id（Execution.orderId 或 Flex ibOrderID） |
| cum_qty | double precision | 累计成交量（仅 TWS live 提供时写入） |
| contract_key | text | 合约唯一键 symbol\|sec_type\|expiry\|strike\|right |
| currency | text | 成交货币（Flex currency） |
| asset_category | text | 资产大类（Flex assetCategory，如 STK/OPT） |
| sub_category | text | 资产子类（Flex subCategory，如 COMMON/ETF） |
| description | text | 标的描述（Flex description） |
| conid | bigint | IB 合约 ID（Flex conid） |
| security_id | text | 证券 ID（如 ISIN/CUSIP/FIGI，对应 securityID） |
| security_id_type | text | 证券 ID 类型（securityIDType，如 ISIN/CUSIP/FIGI） |
| cusip | text | CUSIP（若有） |
| isin | text | ISIN（若有） |
| figi | text | FIGI（若有） |
| listing_exchange | text | 上市交易所（Flex listingExchange） |
| underlying_conid | bigint | 标的合约 conid（期权等，Flex underlyingConid） |
| underlying_symbol | text | 标的代码（Flex underlyingSymbol） |
| underlying_security_id | text | 标的证券 ID（Flex underlyingSecurityID） |
| underlying_listing_exchange | text | 标的上市交易所（Flex underlyingListingExchange） |
| issuer | text | 发行人名称（Flex issuer，若有） |
| issuer_country_code | text | 发行人国家代码（Flex issuerCountryCode） |
| trade_id | text | Flex tradeID（成交行唯一 ID） |
| related_trade_id | text | Flex relatedTradeID（关联成交 ID） |
| report_date | date | 报表日期（Flex reportDate，YYYYMMDD） |
| trade_date | date | 交易日期（Flex tradeDate，YYYYMMDD） |
| settle_date_target | date | 目标结算日（Flex settleDateTarget） |
| transaction_type | text | 成交类型（Flex transactionType，如 ExchTrade） |
| multiplier | double precision | 合约乘数（Flex multiplier） |
| principal_adjust_factor | text | principalAdjustFactor（字符串保留原值） |
| proceeds | double precision | 收入（Flex proceeds，含符号） |
| taxes | double precision | 税费（Flex taxes） |
| net_cash | double precision | 净现金流（Flex netCash） |
| close_price | double precision | 成交时收盘价/参考价（Flex closePrice） |
| open_close_indicator | text | 开/平仓标记（Flex openCloseIndicator，O/C 等） |
| notes | text | 备注（Flex notes，用于 DRIP/特殊标记） |
| cost | double precision | 成本（Flex cost，含佣金） |
| fifo_pnl_realized | double precision | 实现盈亏（Flex fifoPnlRealized） |
| mtm_pnl | double precision | 市值盈亏（Flex mtmPnl） |
| trade_money | double precision | 成交金额（Flex tradeMoney） |
| fx_rate_to_base | double precision | 折算到基准货币的汇率（Flex fxRateToBase） |
| acct_alias | text | 账户别名（Flex acctAlias） |
| model | text | 账户/组合模型名称（Flex model） |
| raw_extra | jsonb | 其余 Execution/Flex 字段（permId、clientId、origTrade* 等）打包存入 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **索引**：建议 `(account_id, exec_time DESC)`、若用 exec_id 去重则 `UNIQUE(exec_id)` 或唯一索引。
- **读取**：独立应用 GET /executions 按 `since_ts`/`until_ts` 查询本表，并 **LEFT JOIN account_execution_commissions** 得到 commission、realized_pnl、currency；复盘页展示账户执行列表；**方向**由 `side` 正确显示（买/卖）。

### 2.11.1 表 `account_execution_commissions`（阶段 3 R-A2：CommissionReport）

- **用途**：存 IB **CommissionReport** 数据，与 `account_executions` 通过 `exec_id` 一对一关联；贴合 IB 将 Execution 与 CommissionReport 分开推送的结构。
- **写入**：拉取 executions 时若 Fill 带 commissionReport 则写入本表；或收到 **commissionReport 事件**（仅 live 成交）时 UPSERT。按 `exec_id` 唯一。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| exec_id | text PRIMARY KEY | 对应 account_executions.exec_id |
| commission | double precision | 手续费 |
| currency | text | 币种 |
| realized_pnl | double precision | 实现盈亏 |
| yield_ | double precision | IB yield（可选） |
| yield_redemption_date | integer | yyyymmdd 格式（可选） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **读取**：GET /executions 通过 LEFT JOIN 本表将 commission、realized_pnl、currency 拼回执行记录返回前端。

### 2.21 表 `account_transactions`（阶段 3 Performance Phase 0：资金流水，来自 IB Flex）

- **用途**：存**账户资金流水**（存款、取款、转账、股息等），数据来源为 **IB Flex Web Service**（Activity Flex Query 的 Cash Transactions 节）；供 Performance 页计算净资金流（net_cash_flow）、capital_base 与收益率分母。
- **写入**：监控端 **POST /transactions/fetch** 时，从 **flex_accounts** 与 **settings** 通过 `get_flex_config(purpose='cash_transactions')` 得到 (token, query_id) 列表（Host 与 Secondary 各 call），请求 Flex 报表，解析 Cash Transactions 后 UPSERT 到本表（按 account_id + ts + amount + type 去重，避免重复拉取导致重复计入）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| account_id | text NOT NULL | 账户标识 |
| ts | timestamptz NOT NULL | 交易时间（Flex Date/Time） |
| amount | double precision NOT NULL | 金额（正为流入、负为流出，与 Flex 一致） |
| type | text NOT NULL | 规范化类型：deposit / withdrawal / transfer / dividend / other（由 Flex Type 或 Code 映射） |
| currency | text | 币种 |
| description | text | Flex Description（可选） |
| flex_transaction_id | text | Flex transactionID（唯一流水 ID），用于对账与去重（辅助字段） |
| flex_type | text | 原始 Flex Type 文本（如 Payment In Lieu Of Dividends, Other Fees 等） |
| flex_code | text | 原始 Flex Code（如 WTH/DEP 等），若有 |
| asset_category | text | 资产大类（如 STK、OPT、CASH 等） |
| asset_subcategory | text | 资产子类（如 ETF 等） |
| symbol | text | 标的代码（如 PFF），若有 |
| conid | bigint | IB 合约 ID（conid），若有 |
| security_id | text | 证券 ID（如 ISIN/CUSIP/FIGI 等，对应 securityID） |
| security_id_type | text | 证券 ID 类型（securityIDType，如 ISIN/CUSIP/FIGI） |
| listing_exchange | text | 上市交易所（listingExchange），若有 |
| report_date | date | 报表日期（reportDate，通常为 YYYYMMDD） |
| available_for_trading_date | date | 资金可用日期（availableForTradingDate），若有 |
| fx_rate_to_base | double precision | Flex 报表中的 fxRateToBase，用于从币种折算到基准货币（若有多币种账户时有用） |
| raw_extra | jsonb | 其余 Flex 字段（如 acctAlias、model、issuerCountryCode 等）打包存入，便于未来扩展 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(account_id, ts, amount, type)`，便于 UPSERT 去重。
- **索引**：`(account_id, ts DESC)`，供按账户与时间范围查询净资金流。
- **读取**：`servers/reader.get_net_cash_flow(since_ts, until_ts, account_id)` 对本表 SUM(amount)；`get_transactions(...)` 返回明细供 Performance 页展示；GET /performance 的 net_cash_flow、capital_base 使用本表数据。

### 2.22 表 `us_market_holidays`（美股交易日历：NYSE 休市日）

- **用途**：存**美股（NYSE）休市日**，供 GET /market/trading-day 判断某日是否为交易日；Data 页据此仅在交易日将「(end)」标黄（需 Pull 时）。数据来源为美股休市日历（配置或外部数据源）。
- **写入**：通过 **Settings 页「US market holidays (NYSE)」** 或 API POST /market/holidays 添加/删除；亦可手动 INSERT。每年 NYSE 公布日历时在 Settings 中追加新年度。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| exchange | text NOT NULL | 交易所，默认 'NYSE' |
| holiday_date | date NOT NULL | 休市日期 |
| label | text | 可选说明（如 New Year's Day） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **主键**：**(exchange, holiday_date)**。
- **读取**：`servers/reader.get_is_us_trading_day(status_config, date_str)` 先判断周末再查本表；GET /market/trading-day 供前端 Data 页使用。

### 2.23 表 `flex_accounts`（Performance Phase 0：IB Flex 配置，Token 在 settings）

- **用途**：存 **Flex Query 行**（每行同一 Label/Purpose，对应 Host 与 Secondary 各一个 Query ID）；**Token 不存本表**，存于 **settings** 的 `ib_flex_host_token`（主 IB）、`ib_flex_secondary_token`（第二 IB）。每行 **query_host_id**（必填，用 Host token 拉取）、**query_secondary_id**（可选，用 Secondary token 拉取）；同一用途下系统会对两个 Query 各 call 一次，拿回相同结构的 response。供 POST /transactions/fetch 等按 purpose 拉取（如仅使用 purpose=cash_transactions 的行）。
- **写入**：通过 **Settings 页「IB Connection → Flex」** 或 API POST /config/flex 写入；Token 写入 settings，本表**整表替换**。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | serial PRIMARY KEY | 自增主键 |
| sort_order | integer NOT NULL DEFAULT 0 | 显示与拉取顺序 |
| query_label | text | Query 标签（如 "Cash Transactions"），可选 |
| purpose | text DEFAULT 'cash_transactions' | 用途：cash_transactions（资金流水）、trades（成交）等；POST /transactions/fetch 仅使用 purpose= cash_transactions 的行 |
| query_host_id | text NOT NULL | Flex Query ID（Host IB，用 settings.ib_flex_host_token 拉取） |
| query_secondary_id | text | Flex Query ID（第二 IB，用 settings.ib_flex_secondary_token 拉取）；可空表示该行仅拉 Host |

- **读取**：`servers.reader.get_flex_config(purpose=None)` 返回 `{ host_token, secondary_token, rows }`（rows 每项含 query_host_id、query_secondary_id、query_label、purpose）；`get_flex_config(purpose='cash_transactions')` 返回 `[{ token, query_id }, ...]`，每行若 query_host_id 非空则一条 (host_token, query_host_id)、若 query_secondary_id 非空则一条 (secondary_token, query_secondary_id)，供 POST /transactions/fetch 对 Host 与 Secondary 各 call。

### 2.24 表 `key_value_config`（Key-Value 映射，按 Group 分组供各下拉/选项复用）

- **用途**：存**按 Group 分组的 key-value**，供 Flex 默认区间、各类下拉选项等复用。每个 **Group**（见 §2.24.1）对应一个“选项集”（如 Flex range preset、未来其他下拉）；组内每条记录为 key（选项值）+ value（显示或存储值）+ 可选 description。
- **写入**：通过 **Settings 页「Key-Value Config」** 先维护 Group 列表，再在选中 Group 下增删改 key-value；或 API POST /config/key-value（需带 group_id 或 group_name）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| group_id | integer NOT NULL | 所属 Group（FK → key_value_group.id） |
| key | text NOT NULL | 键（组内唯一） |
| value | text NOT NULL | 值 |
| description | text | 可选说明 |
| updated_at | timestamptz | 最后更新时间（默认 now()） |

- **主键**：**(group_id, key)**。同一 key 可出现在不同 Group 中。
- **常用**：任意 Group 下键值对；后台 `get_key_value(key)` 按 key 查（任意组），`get_key_values_by_group(group_name)` 按组名查。Flex 默认范围已改为 settings.flex_default_range_days（整数天），不再用本表。
- **读取**：`get_key_value(key)`、`get_key_values_by_group(group_id)`、`get_all_key_values(group_id=None)`；GET /config/key-value/groups、GET /config/key-value?group_id=。

### 2.24.1 表 `key_value_group`（Key-Value 分组，供下拉/选项集复用）

- **用途**：存 **Group 列表**，每个 Group 对应一个选项集；Group 下有若干 key_value_config 行。Flex 默认范围已改为 settings.flex_default_range_days，不再用本表。
- **写入**：Settings 页 Key-Value Config 或 API POST/DELETE /config/key-value/groups。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | serial PRIMARY KEY | 自增主键 |
| name | text UNIQUE NOT NULL | 组名，供 API 与下拉识别 |
| description | text | 可选说明 |
| sort_order | integer DEFAULT 0 | 显示顺序（小者靠前） |
| created_at | timestamptz | 创建时间（默认 now()） |
| updated_at | timestamptz | 最后更新时间（默认 now()） |

- **读取**：`get_key_value_groups()`；GET /config/key-value/groups。删除 Group 时需同时删除该组下所有 key_value_config 行（或 CASCADE）。

### 2.12 表 `ohlc_bars`（已弃用，由 stock_day / stock_min / option_day / option_min 替代）

- **状态**：**弃用**。表名过于笼统，且股票与期权未区分。替代方案见 §2.13–§2.17。
- **替代**：股票日线 → **stock_day**（§2.13）；股票分钟/小时线 → **stock_min**（§2.14）；期权日线 → **option_day**（§2.15）；期权分钟/小时线 → **option_min**（§2.16）；自选/待操作标的列表 → **watchlist**（§2.17）。
- 新部署不再创建本表；已有数据可通过迁移脚本写入 stock_day / stock_min（仅股票），再择机删除本表。

### 2.13 表 `stock_day`（阶段 3 R-A3 扩展：股票日 K 线）

- **用途**：存**股票**的**日线** OHLC 数据，供复盘、回测与风控分析；数据源为 IB 历史数据。
- **写入**：监控端 POST /bars/fetch（或等效）按标的与周期 `1 D` 从 IB 拉取并 UPSERT；同一 (symbol, bar_time) 仅保留一行。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| symbol | text NOT NULL | 股票代码（如 NVDA） |
| bar_time | timestamptz NOT NULL | K 线周期起始时间（日线为当日 00:00 UTC 或交易所日） |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, bar_time)`，便于 UPSERT。
- **索引**：建议 `(symbol, bar_time DESC)`，供按标的与时间范围查询。
- **读取**：GET /bars?sec_type=STK&period=1 D 或复盘/市场数据页按 symbol、时间范围查询。

### 2.14 表 `stock_min`（阶段 3 R-A3 扩展：股票分钟/小时 K 线）

- **用途**：存**股票**的**分钟线、小时线** OHLC 数据（周期 1 min、5 mins、1 hour）；供复盘与短期回测。
- **写入**：同上，周期为 `1 min`、`5 mins`、`1 hour` 时写入本表。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| symbol | text NOT NULL | 股票代码 |
| period | text NOT NULL | 周期：'1 min' \| '5 mins' \| '1 hour' |
| bar_time | timestamptz NOT NULL | K 线周期起始时间 |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, period, bar_time)`。
- **索引**：建议 `(symbol, period, bar_time DESC)`。
- **读取**：GET /bars?sec_type=STK&period=1 min（或 5 mins、1 hour）按 symbol、时间范围查询。

### 2.15 表 `option_day`（阶段 3 R-A3 扩展：期权日 K 线）

- **用途**：存**期权**的**日线** OHLC 数据；期权按标的+到期+行权价+权利区分合约。
- **写入**：监控端按期权合约从 IB 拉取日线并 UPSERT；同一 (symbol, expiry, strike, option_right, bar_time) 仅保留一行。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| symbol | text NOT NULL | 标的代码（期权 underlying，如 NVDA） |
| expiry | text NOT NULL | 到期（lastTradeDateOrContractMonth，YYYYMM 或 YYYYMMDD） |
| strike | double precision NOT NULL | 行权价 |
| option_right | text NOT NULL | 权利：C/CALL 或 P/PUT |
| bar_time | timestamptz NOT NULL | K 线周期起始时间 |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, expiry, strike, option_right, bar_time)`。
- **索引**：建议 `(symbol, expiry, strike, option_right, bar_time DESC)`。
- **读取**：GET /bars?sec_type=OPT&period=1 D 并传 symbol+expiry+strike+right 或 contract_key 查询。

### 2.16 表 `option_min`（阶段 3 R-A3 扩展：期权分钟/小时 K 线）

- **用途**：存**期权**的**分钟线、小时线**（1 min、5 mins、1 hour）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| symbol | text NOT NULL | 标的代码（期权 underlying） |
| expiry | text NOT NULL | 到期（YYYYMM 或 YYYYMMDD） |
| strike | double precision NOT NULL | 行权价 |
| option_right | text NOT NULL | 权利 C/CALL 或 P/PUT |
| period | text NOT NULL | 周期：'1 min' \| '5 mins' \| '1 hour' |
| bar_time | timestamptz NOT NULL | K 线周期起始时间 |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, expiry, strike, option_right, period, bar_time)`。
- **索引**：建议 `(symbol, expiry, strike, option_right, period, bar_time DESC)`。

### 2.17 表 `watchlist`（阶段 3 R-A3 扩展：自选/待操作标的）

- **用途**：存用户「想操作的标的」列表（Watchlist），可含股票与期权；用于市场数据页拉取报价与 K 线的标的集合，服务重启后不丢失。
- **写入**：监控端通过 Watchlist CRUD API（POST/GET/DELETE /watchlist）增删改查；可从当前持仓、曾持仓或手动输入添加。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| contract_key | text NOT NULL UNIQUE | 合约唯一键：与 account_positions 一致，symbol\|sec_type\|expiry\|strike\|right |
| symbol | text | 标的代码 |
| sec_type | text | STK \| OPT |
| expiry | text | 期权到期（OPT 时） |
| strike | double precision | 期权行权价（OPT 时） |
| option_right | text | 期权权利 C/P（OPT 时） |
| display_label | text | 可选显示名（如 "NVDA 25/6 C 120"） |
| source | text | 来源：manual \| position \| execution |
| created_at | timestamptz | 创建时间（默认 now()） |

- **读取**：GET /watchlist 供市场数据页与报价请求使用；Watchlist 标的的报价写入 **instrument_prices**（与持仓共用），监控端拉取报价后 UPSERT 到 instrument_prices，供前端统一展示。

### 2.18 表 `bars_backfill_jobs`（阶段 3 非实时拉取 Worker：任务队列表）

- **用途**：非实时 K 线拉取（backfill）的**任务队列**；API 入队时 INSERT，独立 Worker 进程用 `SELECT ... FOR UPDATE SKIP LOCKED` 取 pending 任务并执行，完成后 UPDATE status 与 result。见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§4.4。
- **写入**：监控 API 在 POST /bars/backfill（queue=1）时 **INSERT** 一行 status='pending'；Worker 取任务时 **UPDATE** status='running'，执行结束后 **UPDATE** status='done'|'failed' 与 result（jsonb）。
- **消费语义**：Worker 使用 `SELECT id, symbol, period, years, days, override_days FROM bars_backfill_jobs WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED` 取一条，随后在同一事务内 `UPDATE ... SET status='running', updated_at=now() WHERE id=:id`，避免多 Worker 抢同一 job。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键（作为 job_id 返回给客户端） |
| symbol | text NOT NULL | 标的代码（如 NVDA） |
| period | text NOT NULL | 周期：'1 D' \| '1 min' \| '5 mins' \| '1 hour' |
| years | double precision | 拉取跨度（年），仅当无数据时用 |
| days | integer | 拉取跨度（天），仅当无数据时用 |
| override_days | double precision | 已有数据时覆盖最近 N 天 |
| status | text NOT NULL | pending \| running \| done \| failed |
| result | jsonb | 执行结果：{ ok, count?, message? } 或 { ok: false, error } |
| created_at | timestamptz | 创建时间（默认 now()） |
| updated_at | timestamptz | 最后更新时间（默认 now()） |

- **索引**：`(status, created_at)` 便于 Worker 按 pending 取最旧任务；GET /bars/jobs 按 id DESC 分页。
- **Trim**：可选保留最近 200 条，删除更旧记录，与内存队列"保留 200"行为一致。

### 2.19 表 `position_categories`（持仓分类：STK 分类标签定义）

- **用途**：存用户定义的**持仓分类**（如「股息回报」「短期持仓」等），用于对 **STK 持仓** 打标签并后续按分类跟踪回报。
- **写入**：监控端通过 GET/POST/PATCH/DELETE /position-categories 增删改查；分类可添加、修改、删除。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| name | text NOT NULL | 分类名称（如 Dividend、Short-term） |
| description | text | 可选说明 |
| sort_order | integer | 显示顺序（小者靠前），可选 |
| created_at | timestamptz | 创建时间（默认 now()） |
| updated_at | timestamptz | 最后更新时间（默认 now()） |

- **读取**：GET /position-categories 供前端下拉与「管理分类」使用；GET /status 的 accounts.positions 中通过 position_category_tags 关联带出 category_id、category（名称）。

### 2.20 表 `position_category_tags`（持仓→分类关联，一持仓一分类）

- **用途**：将 **position_categories** 中的分类 **Tag** 到 **account_positions** 的某条持仓上；仅对 STK 持仓有意义，用于按分类跟踪回报。
- **主键/唯一**：**(account_id, contract_key)** 唯一，即每条持仓至多一个分类。
- **写入**：监控端 PUT /position-categories/tag 时 UPSERT 或 DELETE（category_id 为 null 时删除 tag）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_id | text NOT NULL | 账户（与 account_positions 一致） |
| contract_key | text NOT NULL | 合约唯一键（与 account_positions 一致） |
| category_id | integer NOT NULL | 关联 position_categories.id |
| created_at | timestamptz | 创建时间（默认 now()） |

- **外键**：category_id → position_categories(id)；account_id + contract_key 对应 account_positions 中存在的行（应用层保证，或可选 FK）。
- **读取**：servers/reader.get_accounts_from_tables() 在读取 account_positions 时 LEFT JOIN 本表与 position_categories，将 category_id、category（名称）写入 positions[*]。

### 2.5 表 `daemon_run_status`（阶段 2：挂起/恢复状态，监控机写入、交易机轮询）

- **用途**：供监控机设置「挂起/恢复」交易流程（不下新对冲），交易机在每次 heartbeat 及 tick 时**只读**该表并据此决定是否执行 maybe_hedge；与 daemon_control 配合实现 RE-5（监控与交易分离）。启动守护程序仅在交易机执行，监控机不提供 subprocess/start。
- **写入**：监控应用在 POST /control/suspend 时 **UPDATE** `suspended = true`，POST /control/resume 时 **UPDATE** `suspended = false`（单行 id=1）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | integer | 主键，固定为 1（单行表） |
| suspended | boolean NOT NULL | true=挂起（不执行新对冲），false=运行 |
| updated_at | timestamptz | 最后更新时间 |

- **语义**：守护进程轮询 `SELECT suspended FROM daemon_run_status WHERE id = 1`，不消费、不修改；为 true 时跳过 _eval_hedge（heartbeat 仍写 status_current，但不调用 maybe_hedge）。

### 2.6 表 `daemon_heartbeat`（阶段 2：守护进程心跳，监控区分守护/对冲与 IB 连接）

- **用途**：守护进程（`run_engine.py`）每心跳更新此行，供监控端区分「守护进程是否存活」与**与 IB 连接状态与 Client ID**（RE-7）。
- **写入**：仅**稳定守护进程**在每次 heartbeat 循环中调用 sink 的 `write_daemon_heartbeat(hedge_running, ib_connected, ib_client_id)`；单进程模式或对冲应用不写此表。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | integer | 主键，固定为 1（单行表） |
| last_ts | timestamptz NOT NULL | 最后心跳时间 |
| hedge_running | boolean NOT NULL | 对冲子进程是否在运行 |
| ib_connected | boolean | 守护进程是否与 IB 保持连接（RE-7）；现有库通过 ALTER 追加，默认 false |
| ib_client_id | integer | 连接成功时占用的 Client ID；未连接时为 NULL（RE-7） |
| next_retry_ts | timestamptz | IB 未连接时，下次计划重试连接的时刻（RE-7）；已连接时为 NULL |
| seconds_until_retry | smallint | 守护进程写入的「距下次重试的秒数」（0～间隔+5），用于 UI 倒计时，避免守护机与监控机时钟不同步导致显示异常 |
| graceful_shutdown_at | timestamptz | 优雅退出时写入（SIGTERM/SIGINT 或消费 stop 后）；NULL 表示运行中或未优雅退出（如 kill -9）。监控可区分「已于某时停止」与「心跳超时/可能被强杀」 |

- **语义**：监控端读取 `last_ts`、`hedge_running`、`ib_connected`、`ib_client_id`、`next_retry_ts`、`seconds_until_retry`、`graceful_shutdown_at`（如 GET /status 的 `daemon_heartbeat`）；若 `last_ts` 在最近约 30 秒内则视为守护进程存活；若 `graceful_shutdown_at` 非空则表示守护进程已优雅退出，监控可显示「已于 … 停止」；`ib_connected` 为 true 时显示「已连接」及 `ib_client_id`；为 false 时显示「未连接」及 **下次重试时间**（优先用 `seconds_until_retry` 显示「约 N 秒后」），并支持监控端触发立即重试（`daemon_control` 写入 `retry_ib`）。

### 2.9 表 `settings`（阶段 2：统一设置表，单行多列，便于维护）

- **用途**：集中存放与守护程序/监控相关的**可持久化设置**，单行表（id=1），避免为每类设置单独建表。**IB 配置**（host、port_type、client_id、primary_account_id、第二 IB）**全部在 DB**，config.yaml 不再定义 client_id 或 primary_account_id；host/port 仅作 DB 无数据时的 fallback。**主账户**由 `ib_primary_account_id` 指定；**第二 IB**（不同 TWS 机器，手动交易账户）由 `ib2_*` 指定，用于统一 Portfolio（R-A4）。
- **写入**：监控应用在用户点击「保存」时通过 POST /config/ib 写入；StatusReader 的 `write_ib_config(...)` 执行 UPDATE。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | integer | 主键，固定为 1（单行表） |
| ib_host | text NOT NULL | 连接 IB 的主机（IP 或主机名），默认 '127.0.0.1' |
| ib_port_type | text NOT NULL | 端口类型：`tws_live`（7496）、`tws_paper`（7497）、`gateway`（4002）；默认 `tws_paper` |
| ib_client_id_daemon | integer | 守护进程（交易进程）连接 IB 使用的 Client ID（默认 1）；TWS 多连接时与手动/其他程序区分 |
| ib_client_id_listener | integer | 守护侧监听进程使用的 Client ID（预留，默认 2），避免与交易进程及监控端冲突 |
| ib_client_id_account | integer | 监控端拉取账户信息/执行记录（POST /executions/fetch）使用的 Client ID（默认 100） |
| ib_client_id_markets | integer | 监控端拉取市场数据/K 线（POST /bars/fetch）使用的 Client ID（默认 101） |
| ib_client_id_worker_market | integer | Celery worker（如 Bars 补全，worker_market）连接 IB 使用的 Client ID（默认 500），与 Daemon/Monitor 隔离，避免冲突 |
| ib_primary_account_id | text | 主账户 account_id（如 U17113214），用于对冲与行情；空则使用 TWS managed accounts 首个（R-A4） |
| ib2_host | text | 第二 IB 主机（不同 TWS 机器，手动交易账户）；空则未配置 |
| ib2_port_type | text | 第二 IB 端口类型（tws_live/tws_paper/gateway），默认 tws_paper |
| ib2_client_id_listener | integer | 第二 IB 监听 Client ID（默认 3），用于获取更新 |
| ib2_client_id_account | integer | 第二 IB 账户拉取 Client ID（默认 102） |
| ib_flex_host_token | text | IB Flex Web Service Token（主 IB）；与 flex_accounts 的 query_host_id 配合使用 |
| ib_flex_secondary_token | text | IB Flex Token（第二 IB）；与 flex_accounts 的 query_secondary_id 配合使用 |
| flex_default_range_days | integer | Default Flex Query 天数（如 30）；未传 from_date/to_date 时由后台按「昨日 − N 天」计算；默认 30 |
| flex_init_range_days | integer | Init Flex Query 天数（如 360），用于首次/全量拉取；默认 360 |

- **Client ID 使用场景**（与 Settings 页 Client IDs 表一致；双 IB 时 Host 与 Secondary 各一套，**市场数据仅 Host 有**，故无 `ib2_client_id_markets` 列）：

| 分组 | 角色 | 列名（Host） | 列名（Secondary） | 使用场景 |
|------|------|--------------|-------------------|----------|
| Daemon | Trading | ib_client_id_daemon | — | 守护进程交易连接 IB（下单、持仓、行情） |
| Daemon | Listener | ib_client_id_listener | ib2_client_id_listener | 守护进程/监控端第二条连接（事件、订阅） |
| Monitor | Account | ib_client_id_account | ib2_client_id_account | 监控端拉取账户摘要、执行记录（POST /executions/fetch 等） |
| Monitor | Market data | ib_client_id_markets | — | 监控端拉取市场数据/K 线（POST /bars/fetch）；仅主账户有数据订阅，第二 IB 无此列 |
| Celery | Market Data | ib_client_id_worker_market | — | Celery worker（如 Bars 补全）连接 IB，与 Daemon/Monitor 隔离 |

- **语义**：后台将 `ib_port_type` 映射为端口号：TWS Live → 7496，TWS Paper → 7497，Gateway → 4002。**config.yaml 不再定义 client_id 或 primary_account_id**，均由本表提供。守护进程启动时若 status sink 为 postgres 且该表有行，则优先使用此配置及 `ib_client_id_daemon`；否则使用 config 的 `ib.host`、`ib.port`（client_id 默认 1）。**主账户**：若本表 `ib_primary_account_id` 非空，守护进程使用该 account_id 作为对冲与行情账户；否则使用 TWS managed accounts 首个（R-A4）。**第二 IB**：若 `ib2_host` 非空，监控端创建 AccountIbClient2 连接第二 TWS，用于拉取该账户的持仓/执行，供统一 Portfolio；第二 IB 无 daemon、无 market data（无 `ib2_client_id_markets` 列）。**账户信息/成交** 与 **市场数据/K 线** 两个 API 分别使用 `ib_client_id_account`、`ib_client_id_markets`（仅 Host）；**Celery** 使用 `ib_client_id_worker_market`。**Flex**：`ib_flex_host_token` 与 `ib_flex_secondary_token` 由 Settings 页 Flex 区块或 POST /config/flex 写入。修改后**守护进程需重启**生效（client_id 在启动时读取）；API 与 Worker 的 client_id 每次启动或请求时从 settings 读取。

---

## 3. 阶段 1 写入策略

- **status_current**：每次 **heartbeat** 调用 `write_snapshot(snapshot, append_history=False)`，仅更新当前表。
- **status_history**：仅在 `append_history=True` 时追加；调用方（GsTrading）在**发生对冲相关操作**时（对冲意图、下单、成交、拒绝）传入 `append_history=True`，或可选每心跳一次。纯无操作心跳不追加历史。
- **operations**：仅在对冲意图、order_sent、fill、reject 四处插入记录。

上述策略的代码与配置说明见 [plans/phase1-execution-plan.md](plans/phase1-execution-plan.md)。

---

## 4. 依赖与本地查看（Phase 1）

- **Python 依赖**：阶段 1 使用 **psycopg2-binary** 连接 PostgreSQL，已在 `pyproject.toml` 中声明。安装环境后执行 `pip install -e .` 即可。
- **PostgreSQL 实例**：需本地或 Docker 提供 PostgreSQL；创建数据库与用户后，在 `config/config.yaml` 中配置 root `postgres`（或使用环境变量 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`）。不配置或未连接时守护程序照常运行，仅不写入状态与操作。
- **用 psql 查看**：连接后可直接查询各表，例如：
  - 当前状态：`SELECT * FROM status_current;`
  - 最近历史：`SELECT * FROM status_history ORDER BY ts DESC LIMIT 20;`
  - 操作记录：`SELECT * FROM operations ORDER BY ts DESC LIMIT 20;`
  - 控制指令（阶段 2）：`SELECT * FROM daemon_control ORDER BY id DESC LIMIT 10;`
  - 挂起/恢复状态（阶段 2）：`SELECT * FROM daemon_run_status WHERE id = 1;`
  - 守护进程心跳（阶段 2）：`SELECT * FROM daemon_heartbeat WHERE id = 1;`
  - 账户执行（阶段 3 R-A2）：`SELECT * FROM account_executions ORDER BY exec_time DESC LIMIT 50;`
  - K 线（阶段 3 R-A3 扩展）：股票日线 `SELECT * FROM stock_day WHERE symbol = 'NVDA' ORDER BY bar_time DESC LIMIT 30;`；股票分钟线 `SELECT * FROM stock_min WHERE symbol = 'NVDA' AND period = '1 min' ORDER BY bar_time DESC LIMIT 100;`；期权日线/分钟线见 option_day、option_min。
  - 统一设置（阶段 2）：`SELECT * FROM settings WHERE id = 1;`

### 4.1 连接失败：`no pg_hba.conf entry for host ...`

该错误表示 **PostgreSQL 服务器** 的访问控制（`pg_hba.conf`）未允许**客户端 IP** 连接。需要在**运行 PostgreSQL 的那台机器**上修改并重载配置。

1. **找到 `pg_hba.conf`**（在服务器 10.0.0.80 上）  
   例如：`/var/lib/pgsql/data/pg_hba.conf` 或 `show hba_file;` 在 psql 里查。

2. **增加一条允许规则**（按需选一种）  
   - 只允许你的客户端 IP（本机为 10.0.0.90）：
     ```text
     host    options_db    bifrost    10.0.0.90/32    scram-sha-256
     ```
   - 或允许整个内网网段：
     ```text
     host    options_db    bifrost    10.0.0.0/24    scram-sha-256
     ```
   若数据库名/用户不同，把 `options_db`、`bifrost` 改成你 config 里的 `database`、`user`。

3. **重载配置**（在服务器上）  
   ```bash
   sudo systemctl reload postgresql
   ```

### 4.2 表不存在或自检报 "Table 'status_current' missing or empty columns"

若数据库已能连接，但 **PostgreSQL schema（表或列）** 不符合要求，说明当前库中尚未创建阶段 1/2 所需的表（或列不一致）。在项目根目录执行：

```bash
python scripts/db_refresh_schema.py
```

脚本会按 `config/config.yaml` 中的 root `postgres` 配置连接当前库，并创建/补齐 `status_current`、`status_history`、`operations`、`daemon_control`、`daemon_run_status`、`daemon_heartbeat`、`settings`、**accounts**、**account_positions**、**instrument_prices**、**account_executions**、**account_execution_commissions**、**account_transactions**、**flex_accounts**、**stock_day**、**stock_min**、**option_day**、**option_min**、**watchlist**、**position_categories**、**position_category_tags** 等表（与 `PostgreSQLSink._ensure_tables` 一致；不再创建 ohlc_bars）。完成后可启动守护进程或通过 psql 验证表与列是否符合 [DATABASE.md](DATABASE.md) §2。**已有库**若之前建过 status_current 上的 account_id、account_net_liquidation、account_total_cash、account_buying_power、accounts_snapshot 列，可选择性执行 `ALTER TABLE status_current DROP COLUMN IF EXISTS account_id, ...` 等清理（不执行也可，代码已不再读写这些列）。

4. **仍连不上时**：确认服务器防火墙放行 5432、且 config 里 `host`/`port`/`database`/`user`/`password` 与服务器实际一致。

### 4.3 `daemon_heartbeat` 被锁：原因与避免

**现象**：对 `daemon_heartbeat` 的 UPDATE 或 SELECT 长时间阻塞，或 psql 执行 `UPDATE daemon_heartbeat SET ...` 一直等待。

**常见原因**：

1. **多个写入进程同时写同一行**：`daemon_heartbeat` 只有一行（id=1），若**同时**运行两个守护进程实例（如两个 `run_engine.py`），两个连接都会对同一行做 UPDATE，后执行的会等待前行释放行锁。若前一个事务一直未提交（例如进程卡死、崩溃前未 commit），锁会一直占用。
2. **连接未正常关闭且事务未结束**：进程被 kill -9 或崩溃时，若在 UPDATE 之后、COMMIT 之前，服务端可能仍认为该连接存活，行锁会保留到 TCP 超时或服务端检测到连接断开。
3. **长事务**：某连接在未提交的事务里对 `daemon_heartbeat` 做过写入或加锁（如 SELECT ... FOR UPDATE），会阻塞其他会话的 UPDATE。

**如何排查**（在能连上 PostgreSQL 的机器上）：

```sql
-- 查看当前谁在等待锁、谁持锁（PostgreSQL 9.6+）
SELECT pid, usename, state, query, wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = current_database()
  AND (query ILIKE '%daemon_heartbeat%' OR state = 'active');

-- 查看锁（锁类型与 relation）
SELECT l.pid, l.mode, l.granted, a.query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
JOIN pg_class c ON l.relation = c.oid
WHERE c.relname = 'daemon_heartbeat';
```

若发现某 `pid` 长时间占用锁且已无实际请求，可在确认安全后在该库执行 `SELECT pg_terminate_backend(<pid>);` 终止该后端（会断开对应连接并释放锁）。也可在项目根目录运行**强制释放锁脚本**（会列出并终止持有/等待上述表锁的其他后端）：

```bash
python scripts/db_release_dblock.py              # 列出并询问确认后终止
python scripts/db_release_dblock.py --dry-run    # 仅列出，不终止
python scripts/db_release_dblock.py --yes       # 不确认，直接终止
```

**如何避免**：

- **只保留一个写入者**：同一时间只运行 **一个** 守护进程（`run_engine.py`），不要同时跑两个会写 `daemon_heartbeat` 的进程。
- **短事务**：本仓库的 sink 已做到每次写心跳后立即 `commit()`，不长时间持锁；若自研或改代码，请勿在未提交事务中长时间持有对 `daemon_heartbeat` 的写入或显式锁。
- **锁等待超时**：PostgreSQLSink 连接后已设置 `lock_timeout = '5s'`，若 5 秒内拿不到行锁会报错并 rollback，不会无限阻塞；可根据需要调整超时或重试策略。
- **自动释放锁并重试**：若因上次守护进程异常退出导致 `daemon_heartbeat` 或 `daemon_run_status` 被锁，再次启动时若遇到 lock timeout，sink 会**自动**查询并终止持有/等待这两张表锁的其他后端（逻辑同 `scripts/db_release_dblock.py`，仅针对 `daemon_heartbeat` 与 `daemon_run_status`），然后重试连接或写入一次，无需手动执行 release 脚本。

---

## 5. 后续阶段与数据库的关联（预留）

以下为占位说明，具体表结构或字段在对应阶段实现时在本文档中补充。

- **阶段 2**：独立应用**只读** `status_current`、`operations`、`daemon_run_status`、`daemon_heartbeat`（GET /status 含 trading_suspended 与守护/对冲分开显示）；控制通道使用表 **daemon_control**（stop/flatten，见 §2.4）与 **daemon_run_status**（挂起/恢复，见 §2.5）。**daemon_heartbeat**（§2.6）由稳定守护进程写入，用于监控端区分守护进程存活与对冲程序是否在跑。启动守护程序仅在交易机执行，监控机不提供 subprocess/start。
- **阶段 3.1（历史统计）**：只读 `status_history`、`operations` 做聚合（按日/周对冲次数、盈亏等）；不新增表，仅查询。
- **阶段 3 R-A2/R-A3（复盘与风控）**：**account_executions**（§2.11）存账户执行/成交；**stock_day**、**stock_min**、**option_day**、**option_min**（§2.13–§2.16）存股票与期权 K 线；**watchlist**（§2.17）存自选标的。GET /executions、GET /bars、GET/POST/DELETE /watchlist 与复盘/市场数据页读上述表；写入由监控端或独立脚本在阶段 3 实现时接入。
- **阶段 4（回测）**：若回测结果需要落库，可新增 schema 或表（如 `backtest_runs`、`backtest_ticks`），在本文档 §6 增加。
- **其他**：控制指令、告警、用户配置等若未来落库，均在本文档中新增章节并注明引入阶段。

---

## 6. 变更记录

| 日期 | 变更内容 | 引入阶段 |
|------|----------|----------|
| （初版） | 新增 §1–§4：连接配置、阶段 1 三表（status_current、status_history、operations）、写入策略；§5 后续阶段预留。 | 阶段 1 |
| 阶段 1 落地 | 新增 §4：依赖（psycopg2-binary）、配置说明、psql 查看示例；§5/§6 章节号顺延。 | 阶段 1 |
| 控制通道改 DB | 新增 §2.4 表 daemon_control；控制指令由本地文件改为 PostgreSQL，支持监控与守护进程分离部署（RE-5）。 | 阶段 2 |
| 挂起/恢复状态 | 新增 §2.5 表 daemon_run_status；监控机写入、交易机轮询，实现挂起/恢复对冲；监控机移除 subprocess/start。 | 阶段 2 |
| 守护进程心跳 | 新增 §2.6 表 daemon_heartbeat；稳定守护进程每心跳写入，监控端区分守护/对冲并分开显示（RE-6）。 | 阶段 2 |
| IB 连接状态（RE-7） | daemon_heartbeat 增加 ib_connected、ib_client_id；daemon_control 支持 command=retry_ib；守护程序不假定 IB 已运行，可观测与重试。 | 阶段 2 |
| 阶段 3 R-A2/R-A3 | 新增 §2.11 表 account_executions（账户执行/成交）；§2.12 弃用 ohlc_bars，新增 §2.13–§2.17 表 stock_day、stock_min、option_day、option_min、watchlist（股票/期权 K 线与自选标的）；供复盘与风控页及 GET /executions、GET /bars、Watchlist CRUD、报价落库使用。 | 阶段 3 |
| 2026-03-03 R-A3 扩展 | 弃用 ohlc_bars；新增 stock_day、stock_min、option_day、option_min、watchlist；K 线读写改为分表；Watchlist CRUD 与智能拉取 duration。 | 阶段 3 |
| 2026-03-08 持仓分类 | 新增 §2.19 表 position_categories（STK 持仓分类定义）、§2.20 表 position_category_tags（持仓→分类 Tag）；GET /position-categories、PUT /position-categories/tag；GET /status 的 positions 带出 category_id/category。 | 阶段 3 扩展 |
| 2026-03-08 Flex Transaction | 新增 §2.21 表 account_transactions（IB Flex 资金流水）；POST /transactions/fetch 拉取 Flex Cash Transactions 写入；get_net_cash_flow/get_transactions 供 GET /performance 使用。 | 阶段 3 Performance Phase 0 |
| 2026-03-08 US market holidays | 新增 §2.22 表 us_market_holidays（NYSE 休市日）；GET /market/trading-day 判断是否交易日；Settings 页 US market holidays 管理添加/删除；Data 页「(end)」标黄仅交易日。 | 阶段 3 扩展 |
| 2026-03-08 Flex 一行双 Query ID | §2.23 flex_accounts 去掉 account_is_host、query_id，改为 query_host_id（必填）+ query_secondary_id（可选）；同一行同一 Label/Purpose，Host 与 Secondary 各一个 Query，Fetch 时两个都 call。 | 阶段 3 Performance Phase 0 |
| 2026-03-08 Flex 一 Token 多 Query | §2.23 flex_accounts 改为「一 Token 多 Query ID + Label」：列 query_id、query_label、purpose；同一 token 可多行；POST /transactions/fetch 仅用 purpose=cash_transactions；reader.get_flex_config(purpose) 支持按用途过滤。 | 阶段 3 Performance Phase 0 |
| 2026-03-08 Flex Token 入 settings | settings 增加 ib_flex_host_token、ib_flex_secondary_token；flex_accounts 去掉 token、account_label，改为 account_is_host (boolean)；GET /status flex_config 为 { host_token, secondary_token, rows }。 | 阶段 3 Performance Phase 0 |
| 2026-03-10 key_value_config | 新增 §2.24 表 key_value_config（Key-Value 映射）；Settings 页 Key-Value Config 维护；Flex 默认范围已改为 settings.flex_default_range_days（整数天），不再用本表。 | 阶段 3 扩展 |
| 2026-03-10 key_value_group | 新增 §2.24.1 表 key_value_group（Key-Value 分组）；key_value_config 增加 group_id，(group_id, key) 为主键；Settings 页 Key-Value Config 先维护 Group 列表，再按组维护 key-value；供未来各类下拉/选项集复用。 | 阶段 3 扩展 |

---

*本文档与 [分步推进计划](PLAN_NEXT_STEPS.md)、[阶段 1 执行计划](plans/phase1-execution-plan.md) 及运行环境需求保持一致；所有数据库相关设计与改动以本文档为唯一引用。*
