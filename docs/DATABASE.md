# 数据库设计（PostgreSQL）

本文档是 **Bifrost Trader Engine** 与 PostgreSQL 交互的**唯一正式设计说明**。当前与未来所有阶段中，与数据库相关的表结构、写入策略、配置及变更均以此文档为准；各阶段执行计划、代码与文档可引用本文档的章节或表名。

**存储选型**：阶段 1 起采用 **PostgreSQL** 作为状态与操作持久化后端（不做 SQLite），需本地或 Docker 提供 PostgreSQL 实例。

---

## 1. 连接与配置

- **配置项**：在 `config/config.yaml` 的 root 配置 `postgres`：
  - `postgres.host`, `postgres.port`, `postgres.database`, `postgres.user`, `postgres.password`；或
  - 使用环境变量（如 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`）或 DSN。
- **代码入口**：`StatusSink` 实现（如 `PostgreSQLSink`）在守护程序启动时根据上述配置建立连接；需处理连接失败与重连（见各阶段实现说明）。
- **多环境（R-DV1）**：Dev 与 Prod 通过 **`postgres.database`**（及必要时 `postgres.host` / `postgres.user`）区分；同一 PostgreSQL 服务器上使用不同 database 名（如 `bifrost_dev` / `bifrost_prod`）。各环境独立执行迁移与种子，不跨环境混用。详见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.8。
- **引用**：产品需求 [REQUIREMENTS.md](REQUIREMENTS.md)；系统架构 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 2. 阶段 1 表结构（当前视图、历史、操作）

阶段 1 引入三张表：**当前状态**（单行）、**状态历史**（追加）、**操作记录**（仅对冲相关事件）。后续阶段如需新增表或字段，在本文档中增加对应章节并注明引入阶段。

### 2.1 表 `daemon_auto_status_current`（daemon 自动交易当前视图）

- **用途**：仅保留一行“最新”运行状态快照，供监控（阶段 2 GET /status）与运维查看，无需查历史表。
- **写入**：由守护程序在**每次 heartbeat** 时 upsert（或 replace）一行；列与 snapshot 字典一致。**每次心跳**会向 IB 拉取标的现价并更新 `spot`，供监控页计算持仓盈亏与期权内在价值/虚实（ITM/OTM）。
- **列**（与 R-M1a 一致）：

| 列名 | 类型 | 说明 |
|------|------|------|
| daemon_auto_status_current_id | integer | 主键，固定为 1（单行表） |
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

- **主键/唯一**：单行表使用固定行 daemon_auto_status_current_id=1，upsert 时更新该行。

- **涉及库表**：上述列所在数据库与表为：配置中的 **PostgreSQL**（`config.postgres` 或环境变量 `PGHOST` 等，见 [ARCHITECTURE.md](ARCHITECTURE.md) §2 运行环境）。**账户相关数据**仅存于 **account**、**account_positions** 表（§2.7、§2.8），daemon_auto_status_current/daemon_auto_status_history 不再包含 account_* 或 accounts_snapshot 列；GET /status 的 `accounts` 从这两张表组装。同一库内还有 daemon_auto_operations、daemon_control、daemon_heartbeat、daemon_run_status 等表。

### 2.2 表 `daemon_auto_status_history`（daemon 自动交易状态历史）

- **用途**：按时间序保留状态快照，供**阶段 3**历史统计与后续分析；R-H1 要求“当前 + 历史”同一 sink。
- **写入**：仅在**有意义**时追加（见下文「写入策略」），例如发生对冲相关操作时或可选每心跳一条；纯无操作心跳不追加。
- **列**：与 `daemon_auto_status_current` 数据列一致，主键采用「表名_id」约定（见 .cursor/rules/database-design.mdc）：

| 列名 | 类型 | 说明 |
|------|------|------|
| daemon_auto_status_history_id | bigserial | 自增主键 |
| daemon_state | text | 同 daemon_auto_status_current |
| trading_state | text | 同 daemon_auto_status_current |
| … | … | 其余同 daemon_auto_status_current |
| ts | double precision 或 timestamptz | 快照时间戳 |

### 2.3 表 `daemon_auto_operations`（daemon 自动交易操作记录）

- **用途**：记录与持仓变化相关的操作，供审计、排障与阶段 2 GET /operations 查询；R-M4a。
- **写入**：仅在对冲**意图发出、订单发出、成交、拒绝/撤单**时插入一行。
- **列**（与 R-M4a 一致）：

| 列名 | 类型 | 说明 |
|------|------|------|
| daemon_auto_operations_id | bigserial | 自增主键（便于分页） |
| ts | double precision 或 timestamptz | 操作时间戳 |
| type | text | hedge_intent \| order_sent \| fill \| reject \| cancel |
| side | text | BUY \| SELL |
| quantity | integer | 数量（股） |
| price | double precision | 价格（可选，成交时有） |
| state_reason | text | 状态/原因，如 D2、D3、block_reason |

### 2.4 表 `daemon_control`（阶段 2：控制通道，替代本地文件）

- **用途**：供监控服务（可运行在另一台主机，RE-5）向守护进程发送控制指令（stop/flatten/refresh_replay 等），替代本地控制文件，无需共享文件系统（如 NFS）。
- **写入**：监控应用在 POST /control/stop、POST /control/flatten、POST /control/retry_ib（RE-7）、**POST /control/refresh_replay** 时 **INSERT** 一行；**POST /control/refresh_accounts 不写本表**，由监控端用其维护的 AccountIbClient 直接向 IB 拉取并写 account/account_positions。守护进程在每次 heartbeat 轮询并 **消费**（标记 consumed_at）后执行对应逻辑。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| command | text NOT NULL | 指令：`stop`、`flatten`、`retry_ib`（RE-7）、`refresh_accounts`（守护进程消费后从 IB 拉取账户/持仓并写 DB，**监控页刷新不写此指令**）、`refresh_replay`（R-A2：仅从 IB 拉取执行记录写 account_executions，供复盘与风控 Tab 刷新） |
| created_at | timestamptz | 创建时间（默认 now()） |
| consumed_at | timestamptz | 守护进程消费时间；NULL 表示待处理 |

- **消费语义**：守护进程 `SELECT` 一条 `consumed_at IS NULL` 且 `id` 最小的行，执行对应 command 后 `UPDATE consumed_at = now()`，避免重复触发。监控与守护进程使用同一 PostgreSQL（root `postgres` 配置），故无跨机文件依赖。
- **过期不执行**：若指令的 `created_at` 早于当前时间超过约 60 秒（如上次运行遗留的 stop），守护进程仍会**消费**该行（标记 `consumed_at`）以清空队列，但**不执行**该指令，避免新启动的守护进程误执行“上一次”的停止。

### 2.7 表 `account`（阶段 3.0 R-A1：多账户摘要，由 accounts_snapshot 规范化）

- **表名**：账户摘要表名为 **`account`**（单数）。项目内已不再使用旧表名 `accounts`，**不提供**从 `accounts` 到 `account` 的迁移或向下兼容；建表与所有 SQL 仅使用 `account`。
- **用途**：存 IB 多账户摘要，便于按账户查询、更新与后续账户操作；由守护进程在写入 snapshot 时从内存中的 accounts_snapshot 同步写入（每账户一行）。**多账户时**：Host 账户用于守护进程对冲与行情（由 config 或 settings 的 `host_account_id` 指定）；**所有账户**均写入本表，供统一 Portfolio 展示。
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

- **用途**：存每个账户的持仓明细，便于按账户/标的查询与后续风控、对冲逻辑。**多账户时**：Host 账户用于守护进程对冲与行情；**所有账户**的持仓均写入本表，供统一 Portfolio 展示。
- **主键**：**(account_id, contract_key)**，无自增 id；据此判断插入新行或更新现有行。
- **contract_key** 格式为 `symbol|sec_type|expiry|strike|right`，期权（OPT）用到期/行权价/权利区分合约，股票（STK）为 `symbol|STK|||`。
- **写入**：与 `account` 同步；对 snapshot 中每条持仓计算 contract_key 后 `INSERT ... ON CONFLICT (account_id, contract_key) DO UPDATE`；仅删除该账户下**不在当前 snapshot** 的行（平仓或移除的持仓），不整表清空。
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

- **语义**：GET /status 的 `accounts` 从 **account** + **account_positions** 组装为 `[{ account_id, summary, positions }]` 形状；若表不存在或查询失败则返回空数组。GET /status 同时返回 **accounts_fetched_at**（Unix 秒，取 account 表 max(updated_at)），供监控页显示「数据来自 …，已过 N 分钟」。监控页「IB 账户」**刷新**由监控端维护的 **AccountIbClient** 直接向 IB 拉取账户/持仓并写入 account/account_positions，不写 daemon_control；该区块另有 **1 小时** 自动刷新（仅读 DB 更新展示）。
- **策略归属**：本表**不存** strategy_opportunity_id / strategy_instance_id。一个持仓（contract_key）可能归属多个策略——策略信息通过 account_executions 推导（见 §2.24.11）。GET /status 的 positions 通过子查询返回 `strategy_links[]`（DISTINCT per contract_key）。

### 2.10 表 `contract_quote_live`（阶段 3 R-M6：持仓标的当前价）

- **用途**：按 `contract_key`（同 `account_positions`）存放**每个持仓标的的当前价**，用于监控页逐行展示「当前价」并计算浮动盈亏。设计为**与账户无关**：同一合约在多个账户持有时仅存一行价格。
- **写入**：守护进程 **首次有持仓时** 或监控端 **Accounts Refresh** 时，按持仓标的从 IB 全量拉价并 Upsert 到本表；**每次心跳** 则用 Redis 中 Event 已写入的行情（Real-time ticker）更新本表，仅更新有 Redis 数据的标的，不再每心跳向 IB 拉价。代码与表名一致：写入由 `StatusSink.write_contract_quote_live`、Redis 同步由 `contract_quote_live.sync_contract_quote_live_from_redis` 等完成（模块 `src/app/contract_quote_live.py`）。
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

- **用途**：存**账户级**执行/成交记录（含手动与机器），供复盘与风控（GET /executions、复盘页）查询；与 `daemon_auto_operations`（仅本程序对冲事件）区分。对应 IB 的 **Execution** 结构，不含手续费/实现盈亏（见 §2.11.1）。
- **写入**：由守护程序周期从 IB 拉取 executions/fills，或独立脚本/服务拉取后写入；按 `exec_id` 去重（若 IB 提供），避免重复插入。手续费与实现盈亏写入 **account_execution_commissions**（§2.11.1）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_executions_id | bigserial | 自增主键 |
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
- **写入**：监控端 **POST /transactions/fetch** 时，从 **settings_ib_flex** 与 **settings** 通过 `get_flex_config(purpose='cash_transactions')` 得到 (token, query_id) 列表（Host 与 Secondary 各 call），请求 Flex 报表，解析 Cash Transactions 后 UPSERT 到本表（按 account_id + ts + amount + type 去重，避免重复拉取导致重复计入）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_transactions_id | bigserial | 自增主键 |
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

### 2.22 表 `reference_us_holidays`（美股交易日历：NYSE 休市日）

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

### 2.23 表 `settings_ib_flex`（Performance Phase 0：IB Flex 配置，Token 在 settings）

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

### 2.12 表 `ohlc_bars`（已弃用，由 stock_day / stock_min / option_day / option_min 替代）

- **状态**：**弃用**。表名过于笼统，且股票与期权未区分。替代方案见 §2.13–§2.17。
- **替代**：股票日线 → **stock_day**（§2.13）；股票分钟/小时线 → **stock_min**（§2.14）；期权日线 → **option_day**（§2.15）；期权分钟/小时线 → **option_min**（§2.16）；自选/待操作标的列表 → **watchlist**（§2.17）。
- 新部署不再创建本表；已有数据可通过迁移脚本写入 stock_day / stock_min（仅股票），再择机删除本表。

### 2.13 表 `stock_day`（阶段 3 R-A3 扩展：股票日 K 线）

- **用途**：存**股票**的**日线** OHLC 数据，供复盘、回测与风控分析；数据来源可为 **IB 历史拉取**、**Massive REST**（延迟数据，job kind `feed_stocks_aggregate`（历史行可能为 `stock_ohlc_sync`）、`POST /indices/refresh` 参考指数日线等），由 **`source`** 区分。
- **写入**：监控端 POST /bars/fetch（或等效）按标的与周期 `1 D` 从 IB 拉取并 UPSERT（`source='ib'`）；Massive Worker 写入 `source='massive'`（含 Daily Market Summary、Daily Ticker Summary、Previous Day、Custom Bars 日级等）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| symbol | text NOT NULL | 股票代码（如 NVDA） |
| bar_time | date NOT NULL | K 线日期（纯日期，不含时间；如 2026-01-15） |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| source | text NOT NULL | 数据来源：`ib` \| `massive` \| `tv` 等 |
| vwap | double precision | 可选，Massive 等提供的 VWAP |
| trade_count | bigint | 可选，成交笔数（如 API 字段 `n`） |
| adjusted | boolean | 可选，是否复权口径 |
| extras | jsonb | 可选，扩展字段（如盘前/盘后价） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, bar_time, source)`，便于多来源并存与 UPSERT。
- **索引**：`(symbol, bar_time DESC)`；补充 `(symbol, source, bar_time DESC)`（见 DDL）。
- **读取**：GET /bars?sec_type=STK&period=1 D 在应用层对同一 `(symbol, bar_time)` 按来源优先级去重（优先 `ib`，其次 `tv`，再 `massive`）；复盘/市场数据页按 symbol、时间范围查询。

### 2.14 表 `stock_min`（阶段 3 R-A3 扩展：股票分钟/小时 K 线）

- **用途**：存**股票**的**分钟线、小时线**等日内 OHLC 数据；供复盘与短期回测。来源由 **`source`** 区分（IB vs Massive 等）。
- **写入**：POST /bars/fetch 等写入 `source='ib'`；Massive Custom Bars（非 day/week/month timespan）由 job `feed_stocks_aggregate` 写入 `source='massive'`。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| symbol | text NOT NULL | 股票代码 |
| period | text NOT NULL | 周期：如 `1 min`、`5 min`、`1 hour`（与 Massive multiplier×timespan 映射一致） |
| bar_time | timestamptz NOT NULL | K 线周期起始时间 |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| source | text NOT NULL | 数据来源 |
| vwap | double precision | 可选 |
| trade_count | bigint | 可选 |
| adjusted | boolean | 可选 |
| extras | jsonb | 可选 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, period, bar_time, source)`。
- **索引**：建议 `(symbol, period, bar_time DESC)`；补充 `(symbol, period, source, bar_time DESC)`（见 DDL）。
- **读取**：GET /bars?sec_type=STK&period=1 min（或 5 mins、1 hour）按 symbol、时间范围查询，并对同键多来源去重（优先级同 `stock_day`）。

### 2.14.1 表 `tickers`（Massive 参考标的 / All Tickers）

- **用途**：股票标的参考主档；由 Massive REST `GET /v3/reference/tickers`（universe 任务）与 Ticker Overview 同步写入；供搜索、合并详情与期权 underlying 对齐。历史表名 `stocks` 已由迁移并入本表。
- **主键**：`tickers_id` (bigserial)；**唯一**：`ticker` (text NOT NULL)。
- **列（节选）**：`name`、`market`、`locale`、`primary_exchange`、`instrument_type`、`active`、货币与 FIGI/CIK 字段、`last_updated_utc`、`delisted_utc`、`created_at`、`updated_at` 等（见 DDL）。

- **索引**：`tickers_ticker`；可选 `tickers_active`、`tickers_primary_exchange`、`tickers_instrument_type`（由 DDL 创建）。

### 2.14.2 表 `ticker_overview`（Ticker Overview 扩展列）

- **用途**：存 `GET /v3/reference/tickers/{ticker}` 返回中的扩展字段（行业、地址、描述、品牌 URL 等）；与 `tickers` 一对一（`tickers_id` PK/FK ON DELETE CASCADE）。历史表名 `ticker_reference_details` 已重命名。
- **列（节选）**：`sector`、`industry`、`exchange`、`list_date`、`ticker_root`、`sic_description`、`market_cap`、`total_employees`、地址列、`phone`、`description`、`icon_url`、`logo_url`、`overview_updated_at`。

### 2.14.3 表 `ticker_types`（类型词典）

- **用途**：存 Massive `GET /v3/reference/tickers/types` 返回的类型码与描述；由任务 `feed_stocks_tickers_types`（兼容旧名 `ticker_reference_ticker_types` / `ticker_reference_instrument_types` / `stock_reference_instrument_types`）全量替换写入。历史表名 `ticker_instrument_types` 已重命名。
- **列**：`ticker_types_id` (bigserial PK)、`code` (text NOT NULL)、`description` (text)、`asset_class` (text NOT NULL DEFAULT '')、`locale` (text NOT NULL DEFAULT '')、`created_at` (timestamptz)。**UNIQUE (code, asset_class, locale)**。

### 2.14.4 表 `ticker_related_tickers`（关联标的边）

- **用途**：存 Related Companies API 的边：`from_tickers_id` → `tickers`，`to_symbol` 为关联代码（可尚未在 `tickers` 中存在）。
- **列**：`ticker_related_tickers_id` (bigserial PK)、`from_tickers_id` (bigint NOT NULL FK `tickers(tickers_id)` ON DELETE CASCADE)、`to_symbol` (text NOT NULL)、`rank` (integer)、`fetched_at` (timestamptz)。**UNIQUE (from_tickers_id, to_symbol)**。

### 2.14.5 表 `job_ticker_reference_state`（同步游标）

- **用途**：全市场 All Tickers 分页游标等状态；`sync_kind` 为主键（如 `universe_tickers`）。历史表名 `job_stock_reference_state` 已迁移。
- **列**：`sync_kind` (text PK)、`last_cursor` (text)、`status` (text)、`updated_at` (timestamptz)。

### 2.15 表 `option_day`（阶段 3 R-A3 扩展：期权日 K 线）

- **用途**：存**期权**的**日线** OHLC 数据；期权按标的+到期+行权价+权利区分合约。
- **写入**：监控端按期权合约从 IB 或 Massive（R-A6）拉取日线并 UPSERT；同一 (symbol, expiry, strike, option_right, bar_time, source) 仅保留一行。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| option_day_id | bigserial | 自增主键（符合「表名_id」约定） |
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
| vwap | double precision | 成交量加权平均价（可选；Massive `/v2/aggs` 的 `vw`） |
| source | text NOT NULL DEFAULT 'ib' | 数据来源：`ib` 或 `massive` |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, expiry, strike, option_right, bar_time, source)`。
- **索引**：建议 `(symbol, expiry, strike, option_right, bar_time DESC)`。
- **读取**：GET /bars?sec_type=OPT&period=1 D 并传 symbol+expiry+strike+right 或 contract_key 查询；可选 `source` 参数筛选。

### 2.16 表 `option_min`（阶段 3 R-A3 扩展：期权分钟/小时/秒 K 线）

- **用途**：存**期权**的**分钟线、小时线**（1 min、5 mins、1 hour）以及 Massive 的**秒级聚合**（1 sec）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| option_min_id | bigserial | 自增主键（符合「表名_id」约定） |
| symbol | text NOT NULL | 标的代码（期权 underlying） |
| expiry | text NOT NULL | 到期（YYYYMM 或 YYYYMMDD） |
| strike | double precision NOT NULL | 行权价 |
| option_right | text NOT NULL | 权利 C/CALL 或 P/PUT |
| period | text NOT NULL | 周期：'1 sec' \| '1 min' \| '5 mins' \| '1 hour' |
| bar_time | timestamptz NOT NULL | K 线周期起始时间 |
| open | double precision | 开 |
| high | double precision | 高 |
| low | double precision | 低 |
| close | double precision | 收 |
| volume | double precision | 成交量（可选） |
| vwap | double precision | 成交量加权平均价（可选；Massive `/v2/aggs` 的 `vw`） |
| source | text NOT NULL DEFAULT 'ib' | 数据来源：`ib` 或 `massive` |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, expiry, strike, option_right, period, bar_time, source)`。
- **索引**：建议 `(symbol, expiry, strike, option_right, period, bar_time DESC)`。

### 2.16.1 表 `option_contracts`（期权合约定义）

- **用途**：期权合约定义，按 contract_key（与 account_positions、contract_quote_live 一致）唯一标识。
- **列**：`option_contracts_id` (bigserial PK)、`contract_key` (text NOT NULL UNIQUE)、`symbol`、`expiry`、`strike`、`option_right`、`massive_option_ticker` (text, 可选, Massive/Polygon 供应商期权代码如 `O:NVDA250620C00120000`，便于 API 往返)、`exercise_style` (text, 可选, Massive `details.exercise_style`)、`shares_per_contract` (integer, 可选, Massive `details.shares_per_contract`)、`created_at`。索引 `(contract_key)`、`(symbol, expiry, strike, option_right)`。

#### Massive 字段与写入路径（列级健康度）

| 数据库列 | 参考 API `GET /v3/reference/options/contracts` | 链上 snapshot（`option_snapshots` 写入路径） | 备注 |
|----------|---------------------------------------------------|-----------------------------------------------|------|
| `contract_key` | 由 `underlying` + `expiration_date` + `strike_price` + `contract_type` 推导（`contract_key_from_parts` / `contract_key_from_reference_result`） | 同左 | 与 `symbol|OPT|expiry|strike|right` 一致 |
| `symbol` | 标的 = 请求 underlying | 同左 | |
| `expiry` | `expiration_date` / `expiration` → 规范为 8 位 `YYYYMMDD` | 同左 | |
| `strike` | `strike_price`（float） | `details.strike_price` | 写入侧对 strike 做 round 与 key 一致 |
| `option_right` | `contract_type` → `C`/`P` | `details.contract_type` | |
| `massive_option_ticker` | 响应 `ticker` | `details.ticker` / 根上 `ticker` | 参考 upsert 仅 COALESCE 更新 ticker |
| `exercise_style` | 参考列表**不写入** | snapshot `details` 填充 | 未跑链上 snapshot 时全表可空属预期 |
| `shares_per_contract` | 参考列表**不写入** | snapshot `details` 填充 | 同上 |

- **L1（仅 PostgreSQL）**：按标的汇总各列非空行数及占比（`exercise_style`、`shares_per_contract` 等）；不调用 Massive。低 `exercise_style`/`shares_per_contract` 覆盖率在「仅 reference 拉合约」阶段为常态，需结合是否已有链上快照解读。
- **L2（参考域）**：在可比到期与分页上限内，将参考 API 返回的每条合约与 `option_contracts` 同行比较 `symbol` / `expiry` / `strike` / `option_right` / `massive_option_ticker`（与 `upsert_option_contracts_from_reference_rows` 责任范围一致）。见 `GET /research/massive/option-contracts-reference-column-parity`。
- **L3（快照域，可选）**：若需校验 `exercise_style` / `shares_per_contract` 与某次 snapshot 一致，需行级来源或启发式（例如仅当存在 `option_snapshots` 行时再比较）；当前表无 `last_enriched_source` 等列，严谨 L3 需另议 schema 或接受子集校验。

### 2.16.2 表 `option_snapshots`（期权时点快照，含 Greeks/IV）

- **用途**：期权某时点快照：Greeks/IV、OI、Massive 链 `day` 条（OHLC 等）。**不在此表持久化** NBBO（last/bid/ask/mid）、`underlying_asset.price`、break-even、FMV（当前 Massive 档位不写入或不再落库）；展示用 mark 由 API 侧使用 `day_close` 等推导。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| option_snapshots_id | bigint | 序列自增，**非主键**（稳定行引用/排序） |
| contract_key | text NOT NULL | 合约唯一键 |
| snapshot_ts | timestamptz NOT NULL | 快照时间戳 |
| iv | double precision | 隐含波动率（可空；API `implied_volatility` 或 `greeks.iv`） |
| delta | double precision | Delta（可空） |
| gamma | double precision | Gamma（可空） |
| theta | double precision | Theta（可空） |
| vega | double precision | Vega（可空） |
| open_interest | integer | 快照时点的 OI（可空） |
| underlying_ticker | text | 标的代码（可空；Massive `underlying_asset.ticker`） |
| day_open / day_high / day_low / day_close | double precision | Massive 链快照 `day` 对象 OHLC |
| day_previous_close / day_change / day_change_percent | double precision | Massive `day` |
| day_volume | bigint | Massive `day.volume` |
| day_vwap | double precision | Massive `day.vwap` |
| day_last_updated | timestamptz | 由 Massive `day.last_updated`（纳秒）换算 |
| day_last_updated_day | date GENERATED STORED | `DATE(timezone('America/New_York', day_last_updated))`，可空；用于与 `stock_day` 对齐 |
| source | text NOT NULL DEFAULT 'ib' | 数据来源：`ib` 或 `massive` |
| created_at | timestamptz | 写入时间（默认 now()） |

- **主键**：`PRIMARY KEY (contract_key, snapshot_ts)`（业务自然键即主键；分区表主键须含分区键 `snapshot_ts`）。`option_snapshots_id` 为序列列，不参与主键。
- **存量迁移**：若旧库仍为 `PRIMARY KEY (option_snapshots_id, snapshot_ts)` 且另有 `UNIQUE (contract_key, snapshot_ts)`，`pg_ddl` 在无重复 `(contract_key, snapshot_ts)` 时会删除旧主键与冗余 UNIQUE，并建立新主键 `(contract_key, snapshot_ts)`。若仍有重复，须先运行 `scripts/db/dedupe_option_snapshots.py --apply`，再执行 schema 刷新。
- **分区**：`PARTITION BY RANGE (snapshot_ts)` 按月分区（命名如 `option_snapshots_y2026m03`）。`pg_ddl` 自动创建当月 + 未来 3 个月分区及 default 分区。已有非分区表的库在 `db_refresh_schema.py` 时自动迁移。
- **索引**：主键在 `(contract_key, snapshot_ts)` 上提供唯一索引（替代原非唯一索引 `option_snapshots_contract_key_ts`）；可选 `(underlying_ticker, day_last_updated_day)` 供 join。
- **写入合并**：Massive 链快照与 WS 采样均使用 `INSERT ... ON CONFLICT (contract_key, snapshot_ts) DO UPDATE` — 链快照以新 API 响应覆盖各列；WS 路径仅合并 Greeks/OI 等字段，对可空列使用 `COALESCE(EXCLUDED.*, option_snapshots.*)`，避免覆盖链快照已填充的 `day_*` / `underlying_ticker` 等列。
- **保留策略**：保留最近 **90 天**热数据；早于 90 天的月份分区 `ALTER TABLE ... DETACH PARTITION` 后归档（`pg_dump` / `COPY` 到冷存储）或 `DROP`。运维步骤见 `scripts/db/archive_option_snapshots.sh`（占位模板）。

#### 视图 `option_snapshots_with_underlying_day`

- **用途**：将 `option_snapshots` 与 **`stock_day`（`source = 'massive'`）** 按 `upper(trim(underlying_ticker)) = symbol` 且 `bar_time = day_last_updated_day` 左连接，输出标的日线 **OHLCVW** 及 **`sd.close AS underlying_price`**（供 EOD ATM IV / Max Pain 等读路径；无匹配行则 `underlying_price` 等为 NULL）。
- **定义**：`CREATE OR REPLACE VIEW option_snapshots_with_underlying_day AS SELECT os.*, sd.open AS u_open, ...`（见 `src/persistence/postgres/ddl.py`）。

#### 物化视图 `option_snapshots_latest`

- **用途**：按 `contract_key` 取最新一行的物化视图，加速 Discovery 读路径。
- **定义**：`CREATE MATERIALIZED VIEW option_snapshots_latest AS SELECT DISTINCT ON (contract_key) ... FROM option_snapshots ORDER BY contract_key, snapshot_ts DESC`，列集含 `day_*`、`day_last_updated_day`、`underlying_ticker` 等（**不含**已删除的报价/FMV 列）。
- **唯一索引**：`UNIQUE (contract_key)`——支持 `REFRESH MATERIALIZED VIEW CONCURRENTLY`。
- **刷新**：chain snapshot 写入成功后自动 `REFRESH CONCURRENTLY`（见 `src/massive/tasks.py`）。schema 升级时若基表新增列而 MV 未包含，`pg_ddl` 会 `DROP` 后按新列重建。

### 2.16.3 表 `option_open_interest_daily`（R-A6：期权日终 Open Interest）

- **用途**：存**期权合约的日终 Open Interest**，供期权分析（OI 变化、多空博弈等）。数据来源为 Massive（Starter 可获取日终 OI）。
- **写入**：Massive Worker 按标的/日期拉取日终 OI 后 UPSERT；同一 (contract_key, trade_date, source) 仅保留一行。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| option_open_interest_daily_id | bigserial | 自增主键（符合「表名_id」约定） |
| contract_key | text NOT NULL | 合约唯一键（与 option_contracts / account_positions 一致） |
| symbol | text NOT NULL | 标的代码（underlying） |
| expiry | text NOT NULL | 到期 |
| strike | double precision NOT NULL | 行权价 |
| option_right | text NOT NULL | 权利 C/P |
| trade_date | date NOT NULL | 交易日（OI 截止日） |
| open_interest | integer NOT NULL | 日终持仓量 |
| source | text NOT NULL DEFAULT 'massive' | 数据来源 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(contract_key, trade_date, source)`。
- **索引**：`(contract_key, trade_date DESC)`、`(symbol, trade_date DESC)`。
- **读取**：GET /research/option-oi 或嵌入 Option Discovery 表格的 OI 列。

### 2.16.4 表 `option_trades`（R-A6 Developer：期权逐笔成交，预留）

- **用途**：存**期权逐笔成交**数据，仅在 Massive **Options Developer** 订阅下可用（feature flag `massive.features.trades_enabled`）。**Starter 阶段仅建表不写入**。
- **写入**：Massive Worker 拉取 Trades 后 UPSERT；按 `massive_trade_id` 去重保证幂等。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| option_trades_id | bigserial | 自增主键（符合「表名_id」约定） |
| contract_key | text NOT NULL | 合约唯一键 |
| symbol | text NOT NULL | 标的代码（underlying） |
| expiry | text NOT NULL | 到期 |
| strike | double precision NOT NULL | 行权价 |
| option_right | text NOT NULL | 权利 C/P |
| trade_ts | timestamptz NOT NULL | 成交时间戳（纳秒精度可截断到微秒） |
| price | double precision NOT NULL | 成交价 |
| size | integer NOT NULL | 成交量（合约数） |
| exchange | text | 成交交易所（可空） |
| conditions | text | 成交条件代码（可空，Massive 条件 ID 数组序列化为文本） |
| massive_trade_id | text NOT NULL | Massive 供应商唯一成交 ID |
| source | text NOT NULL DEFAULT 'massive' | 数据来源 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(massive_trade_id)`。
- **索引**：`(contract_key, trade_ts DESC)`、`(symbol, trade_ts DESC)`。
- **读取**：`GET /research/option-trades?...` 仅当 feature flag 启用时返回数据；分页 + 时间范围。

### 2.16.5 表 `job_massive_backfill`（R-A6：Massive 异步任务队列）

- **用途**：Massive 数据拉取的**异步任务队列**，模式与 `job_bars_backfill`（§2.18）一致。API 入队时 INSERT，Massive Celery Worker 取 pending 任务执行，完成后 UPDATE status 与 result。表名采用 **`job_`** 前缀（database-design.mdc 约定）。
- **写入**：监控 API 在 `POST /research/massive/sync` 时 INSERT 一行 status='pending'；Worker 取任务时 UPDATE status='running'，执行结束后 UPDATE status='done'\|'failed' 与 result。
- **消费语义**：与 `job_bars_backfill` 一致——`SELECT ... WHERE status='pending' ORDER BY job_massive_backfill_id LIMIT 1 FOR UPDATE SKIP LOCKED`。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| job_massive_backfill_id | bigserial | 自增主键（作为 job_id 返回给客户端） |
| kind | text NOT NULL | 任务类型：`feed_options_aggregate`（期权 OHLC / 池化任务；历史行可能为 `aggregates`）\| `feed_option_snapshots`（期权链/单合约/统一快照拉取；历史行可能为 `snapshot`）\| `feed_options_trades_quotes`（期权 last trade / quotes / trades 代理；历史行可能为 `trades_quotes`）\| `feed_option_contracts`（期权 reference contracts list/detail/upsert/backfill；历史行可能为 `contracts`）\| `oi` \| `trades` \| `reference` \| `feed_stocks_corporate_action`（股票公司行动 → `massive_corporate_action`；历史行可能为 `corporate_action`）\| `feed_stocks_aggregate`（股票 OHLC 落库；历史行可能为 `stock_ohlc_sync`）\| `feed_stocks_tickers_reference_universe`（全市场 tickers 列表同步；历史行可能为 `ticker_reference_universe` / `stock_reference_universe`）\| `feed_stocks_tickers_overview`（标的详情/ ticker_overview；历史行可能为 `ticker_reference_overview`）\| `feed_stocks_tickers_related`（关联公司 peer；历史行可能为 `ticker_reference_related`）\| `feed_stocks_tickers_types`（`GET /v3/reference/tickers/types` → `ticker_types`；历史行可能为 `ticker_reference_ticker_types` / `ticker_reference_instrument_types` / `stock_reference_instrument_types`）\| `ticker_reference_*` / `stock_reference_*` 等 |
| payload | jsonb NOT NULL | 任务参数（如 { symbol, expiry, start_date, end_date } 等，仅参数） |
| status | text NOT NULL | pending \| running \| done \| failed |
| result | jsonb | 执行结果：{ ok, count?, message? } 或 { ok: false, error } |
| celery_task_id | text | Celery 任务 ID（可选，便于关联） |
| payload_hash | text | SHA-256 of `kind + canonical(payload)`；用于去重索引 |
| created_at | timestamptz | 创建时间（默认 now()） |
| updated_at | timestamptz | 最后更新时间（默认 now()） |

- **索引**：`(status, created_at)` 便于 Worker 取最旧 pending 任务；GET /research/massive/jobs 按 job_massive_backfill_id DESC 分页。
- **去重索引**：`UNIQUE (kind, payload_hash) WHERE status IN ('pending', 'running') AND payload_hash IS NOT NULL`——防止同一 payload 同时存在多条 pending/running 任务。
- **feed_stocks_aggregate（`mode: custom_bars`）**：`payload` 可为单标的 `ticker` **或** 批量 `symbols`（字符串数组，与 `ticker` 二选一；API 校验最多 50 个），共用 `start_ms` / `end_ms`；可选 `sync_all_periods: true` 时在同一时间窗内依次拉取 **1 D / 1 min / 5 mins / 1 hour**（忽略单次 `timespan`/`multiplier`）；否则按 `multiplier`+`timespan` 单次拉取。参考指数在库内可为 `^GSPC` 等，Worker 对 Polygon v2 aggs 会映射为 `I:SPX` 等，**写入仍用配置 symbol**。`result.summary` 可含 `symbols_requested`、`symbols_ok`、`failures`、`per_symbol`。
- **Trim**：可选保留最近 500 条。

### 2.16.5a 表 `report_option_max_pain_daily`（R-A6：Max Pain 日报表）

- **用途**：每日按标的/到期计算的 **Max Pain**（使期权买方总损失最大的行权价），基于 `option_open_interest_daily` 的 EOD OI 数据。属 Gold / 报表层，由日批 Worker 计算写入。
- **写入**：日终 OI 拉取完成后 Worker 计算并 UPSERT；`POST /research/massive/sync kind=report_option_max_pain` 手动触发（历史 `kind=max_pain` 仍接受并规范化为 `report_option_max_pain`）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| report_option_max_pain_daily_id | bigserial | 自增主键 |
| symbol | text NOT NULL | 标的代码 |
| expiry | text NOT NULL | 到期 |
| trade_date | date NOT NULL | OI 截止交易日 |
| max_pain_strike | double precision NOT NULL | Max Pain 行权价 |
| underlying_close | double precision | 标的收盘价（可空） |
| total_oi | integer | 该到期日 OI 合计（可空） |
| computation_detail | jsonb | 各 strike 的 pain value（便于前端 drill-down） |
| source | text NOT NULL DEFAULT 'massive' | 数据来源 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, expiry, trade_date, source)`。
- **索引**：`(symbol, trade_date DESC)`、`(symbol, expiry, trade_date DESC)`。
- **读取**：`GET /research/max-pain`、`GET /research/max-pain/latest`。

### 2.16.5b 表 `report_option_atm_iv_daily`（Option Discovery：ATM IV 日汇总）

- **用途**：按**交易日**、**标的 + 到期**预计算 **ATM IV**（及当日选取的 iv_call / iv_put / strike / underlying_price），供 `GET /research/iv-volatility-cone` 快速读取 IV Volatility Cone，避免每次请求对 `option_snapshots` 做大范围按日 DISTINCT 扫描。真源仍为 `option_snapshots`；本表为派生报表，由 Massive Worker 在 chain snapshot 成功后增量 UPSERT，或按需全量回填。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| report_option_atm_iv_daily_id | bigserial | 自增主键 |
| symbol | text NOT NULL | 标的代码 |
| expiry | text NOT NULL | 到期（YYYYMMDD） |
| trade_date | date NOT NULL | 交易日（美东日历日，与 cone 中 snap_day 一致） |
| source | text NOT NULL DEFAULT 'massive' | 数据来源：`massive` \| `ib` |
| atm_iv | double precision | 当日 ATM IV（可空：无有效 IV 时可不写或写空） |
| iv_call | double precision | ATM 附近 call IV（可空） |
| iv_put | double precision | ATM 附近 put IV（可空） |
| strike | double precision | 选取的 ATM strike（可空） |
| underlying_price | double precision | 用于选 ATM 的标的价格（可空） |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, expiry, trade_date, source)`。
- **索引**：`(symbol, expiry, trade_date DESC)`、`(symbol, trade_date DESC)`。
- **保留**：可与 `option_snapshots` 热数据窗口对齐（约 90 天），旧行可按运维策略归档或删除。

### 2.16.6 表 `massive_corporate_action`（R-A6：公司行动缓存）

- **用途**：缓存 Massive 返回的**公司行动**数据（股息、拆股、IPO、ticker 生命周期事件等），供期权分析时对照历史价格与合约调整。轻量缓存表，按需拉取。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| massive_corporate_action_id | bigserial | 自增主键 |
| symbol | text NOT NULL | 标的代码 |
| action_type | text NOT NULL | 行动类型：`dividend` \| `split` \| `ipo` \| `ticker_event` 等（含历史 `spinoff` / `rights` 占位） |
| ex_date | date | 除权日 |
| record_date | date | 登记日（可空） |
| payment_date | date | 支付日（可空） |
| ratio_from | double precision | 拆分比例分子（如 4:1 中的 4），可空 |
| ratio_to | double precision | 拆分比例分母（如 4:1 中的 1），可空 |
| amount | double precision | 股息金额或等价，可空 |
| currency | text | 币种，可空 |
| description | text | 说明文本，可空 |
| source | text NOT NULL DEFAULT 'massive' | 数据来源 |
| created_at | timestamptz | 写入时间（默认 now()） |

- **唯一约束**：`UNIQUE(symbol, action_type, ex_date, source)`。
- **索引**：`(symbol, ex_date DESC)`。

### 2.17 表 `watchlist`（阶段 3 R-A3 扩展：自选/待操作标的）

- **用途**：存用户「想操作的标的」列表（Watchlist），可含股票与期权；用于市场数据页拉取报价与 K 线的标的集合，服务重启后不丢失。
- **写入**：监控端通过 Watchlist CRUD API（POST/GET/DELETE /watchlist）增删改查；可从当前持仓、曾持仓或手动输入添加。
- **主键**：**contract_key**（与 account_positions、contract_quote_live 一致的合约唯一键；一行一合约，无需自增 id）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| contract_key | text NOT NULL PRIMARY KEY | 合约唯一键：symbol\|sec_type\|expiry\|strike\|right，与 account_positions 一致 |
| symbol | text | 标的代码 |
| sec_type | text | STK \| OPT |
| expiry | text | 期权到期（OPT 时） |
| strike | double precision | 期权行权价（OPT 时） |
| option_right | text | 期权权利 C/P（OPT 时） |
| display_label | text | 可选显示名（如 "NVDA 25/6 C 120"） |
| source | text | 来源：manual \| position \| execution |
| category_id | integer | 可选，关联 preference_position_categories.id；与 Accounts 的 Position Category 共用同一分类表，用于给 Watchlist 标的打分类标签 |
| optionable | boolean | 是否作为 Option Discovery 标的（有可交易期权）；默认 false，在 Watchlist 页「Option?」开关维护 |
| created_at | timestamptz | 创建时间（默认 now()） |

- **读取**：GET /watchlist 供市场数据页与报价请求使用；Watchlist 标的的报价写入 **contract_quote_live**（与持仓共用），监控端拉取报价后 UPSERT 到 contract_quote_live，供前端统一展示。

### 2.18 表 `job_bars_backfill`（阶段 3 非实时拉取 Worker：任务队列表）

- **用途**：非实时 K 线拉取（backfill）的**任务队列**；API 入队时 INSERT，独立 Worker 进程用 `SELECT ... FOR UPDATE SKIP LOCKED` 取 pending 任务并执行，完成后 UPDATE status 与 result。见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§4.4。表名采用 **`job_`** 前缀，与 .cursor/rules/database-design.mdc 中「Celery/任务表」约定一致。
- **写入**：监控 API 在 POST /bars/backfill（queue=1）时 **INSERT** 一行 status='pending'；Worker 取任务时 **UPDATE** status='running'，执行结束后 **UPDATE** status='done'|'failed' 与 result（jsonb）。
- **消费语义**：Worker 使用 `SELECT job_bars_backfill_id, symbol, period, years, days, override_days FROM job_bars_backfill WHERE status='pending' ORDER BY job_bars_backfill_id LIMIT 1 FOR UPDATE SKIP LOCKED` 取一条，随后在同一事务内 `UPDATE ... SET status='running', updated_at=now() WHERE job_bars_backfill_id=:id`，避免多 Worker 抢同一 job。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| job_bars_backfill_id | bigserial | 自增主键（作为 job_id 返回给客户端） |
| symbol | text NOT NULL | 标的代码（如 NVDA） |
| period | text NOT NULL | 周期：'1 D' \| '1 min' \| '5 mins' \| '1 hour' |
| years | double precision | 拉取跨度（年），仅当无数据时用 |
| days | integer | 拉取跨度（天），仅当无数据时用 |
| override_days | double precision | 已有数据时覆盖最近 N 天 |
| status | text NOT NULL | pending \| running \| done \| failed |
| result | jsonb | 执行结果：{ ok, count?, message? } 或 { ok: false, error } |
| created_at | timestamptz | 创建时间（默认 now()） |
| updated_at | timestamptz | 最后更新时间（默认 now()） |

- **索引**：`(status, created_at)` 便于 Worker 按 pending 取最旧任务；GET /bars/jobs 按 job_bars_backfill_id DESC 分页。
- **Trim**：可选保留最近 200 条，删除更旧记录，与内存队列"保留 200"行为一致。

### 2.19 表 `preference_position_categories`（偏好：持仓分类 STK 分类标签定义）

- **用途**：偏好类表。存用户定义的**持仓分类**（如「股息回报」「短期持仓」等），用于对 **STK 持仓** 打标签并后续按分类跟踪回报。
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

- **读取**：GET /position-categories 供前端下拉与「管理分类」使用；GET /status 的 accounts.positions 中通过 preference_position_category_tags 关联带出 category_id、category（名称）。

### 2.20 表 `preference_position_category_tags`（偏好：持仓→分类关联，一持仓一分类）

- **用途**：将 **preference_position_categories** 中的分类 **Tag** 到 **account_positions** 的某条持仓上；仅对 STK 持仓有意义，用于按分类跟踪回报。
- **主键/唯一**：**(account_id, contract_key)** 唯一，即每条持仓至多一个分类。
- **写入**：监控端 PUT /position-categories/tag 时 UPSERT 或 DELETE（category_id 为 null 时删除 tag）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_id | text NOT NULL | 账户（与 account_positions 一致） |
| contract_key | text NOT NULL | 合约唯一键（与 account_positions 一致） |
| category_id | integer NOT NULL | 关联 preference_position_categories.id |
| created_at | timestamptz | 创建时间（默认 now()） |

- **外键**：category_id → preference_position_categories(id)；account_id + contract_key 对应 account_positions 中存在的行（应用层保证，或可选 FK）。
- **读取**：servers/reader.get_accounts_from_tables() 在读取 account_positions 时 LEFT JOIN 本表与 preference_position_categories，将 category_id、category（名称）写入 positions[*]。

### 2.21 表 `preference_market_streams_symbol_order`（偏好：Market Streams 页 Symbol 自定义排序）

- **用途**：偏好类表。存储 Live 页 Market Streams 表格中，**按 Category 分组的 Symbol 显示顺序**。category_name 与 preference_position_categories.name 或前端展示的 "Uncategorized" 一致；同一 category 下按 sort_order 升序显示。
- **写入**：监控端在用户拖拽调整 Symbol 顺序后，PUT /position-categories/symbol-order 写入（按 category_name 整表替换该 category 的排序）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| category_name | text NOT NULL | 分类名（与 position 的 category 或 "Uncategorized" 一致） |
| symbol | text NOT NULL | 标的代码 |
| sort_order | integer NOT NULL | 显示顺序（0-based） |
| updated_at | timestamptz | 更新时间（默认 now()） |

- **主键**：(category_name, symbol)。
- **读取**：GET /position-categories/symbol-order 返回 `{ order: { [category_name]: string[] } }`，供前端 Market Streams 表格排序。

### 2.5 表 `daemon_run_status`（阶段 2：挂起/恢复状态，监控机写入、交易机轮询）

- **用途**：供监控机设置「挂起/恢复」交易流程（不下新对冲），交易机在每次 heartbeat 及 tick 时**只读**该表并据此决定是否执行 maybe_hedge；与 daemon_control 配合实现 RE-5（监控与交易分离）。**Engine 进程**由交易机上的 **systemd**（经 Ops `market-ingest` 控制）或手工 `run_engine.py` 拉起；**Monitor HTTP API 不 exec 引擎**（与「监控机不提供 subprocess/start」一致）。
- **写入**：监控应用在 POST /control/suspend 时 **UPDATE** `suspended = true`，POST /control/resume 时 **UPDATE** `suspended = false`（单行 id=1）。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | integer | 主键，固定为 1（单行表） |
| suspended | boolean NOT NULL | true=挂起（不执行新对冲），false=运行 |
| updated_at | timestamptz | 最后更新时间 |

- **语义**：守护进程轮询 `SELECT suspended FROM daemon_run_status WHERE id = 1`，不消费、不修改；为 true 时跳过 _eval_hedge（heartbeat 仍写 daemon_auto_status_current，但不调用 maybe_hedge）。
- **默认**：新建表/新插入行时 `suspended` 默认为 **true**，即 Trading Strategy 默认挂起；守护进程启动时若读到 suspended=true 则直接进入 WAITING_IB（不连接 IB Trading Client），直到用户在监控端点击 Resume 后才连接 Trading Client 并进入 RUNNING。**已有库**若之前已插入过 id=1 行（ON CONFLICT DO NOTHING 不会覆盖），需手动执行 `UPDATE daemon_run_status SET suspended = true WHERE id = 1` 方可采用「启动不连 Trading Client」行为。

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

### 2.6.1 表 `daemon_open_orders`（阶段 3 R-A5：未成交订单，事件驱动）

- **用途**：存守护进程当前可见的**未成交订单**快照（如 Limit 挂单），供监控端 GET /open-orders 或 GET /status 内嵌展示；每次 IB orderStatusEvent/openOrderEvent 回调后由守护进程**全量覆盖**写入。
- **写入**：仅**守护进程**在订阅 IB orderStatusEvent、openOrderEvent 后，于回调内根据 `ib.openTrades()` 生成列表并调用 sink 的 `write_open_orders(orders)`；采用 **TRUNCATE + INSERT** 或 **DELETE + INSERT** 全量替换，保证与当前 openTrades() 一致。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 主键（仅用于插入顺序） |
| order_id | integer | IB orderId |
| perm_id | integer | IB permId |
| account_id | text | 账户 |
| symbol | text | 标的 |
| sec_type | text | 合约类型（STK/OPT 等） |
| action | text | BUY / SELL |
| total_quantity | numeric | 订单总数量 |
| filled | numeric | 已成交数量 |
| remaining | numeric | 剩余数量 |
| limit_price | numeric | 限价（可为 NULL） |
| status | text | 状态（Submitted、PreSubmitted、Filled、Cancelled 等） |
| contract_key | text | 与 account_positions 一致的 contract_key |
| updated_ts | timestamptz | 本行更新时间 |

- **语义**：监控端读取全表（ORDER BY updated_ts DESC）得到当前挂单列表；无历史保留，仅当前快照。

### 2.9 表 `settings`（阶段 2：统一设置表，单行多列，便于维护）

- **用途**：集中存放与守护程序/监控相关的**可持久化设置**，单行表（id=1）。**IB 连接参数**（Host/Secondary IP、`port_type`、全部 `client_id`）**仅**来自 `config.yaml` 的 `ib.host` / `ib.secondary`（单一真源），**不**存入本表。本表保留：**Host 交易账户**（`ib_host_account_id`，R-A4）、Live 页 stream 账户标签、Flex token 与 Flex 天数、当前激活策略/边界 id 等。
- **写入**：POST /config/ib 仅更新 `ib_host_account_id`、`stream_host_account_id`、`stream_secondary_account_id`；Flex 由 POST /config/flex 等写入。
- **历史**：旧版曾在本表存放 `ib_host`、`ib_port_type`、`ib_client_id_*`、`ib2_*` 等列；已迁移完成的库不再包含这些列，代码亦不再读写。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | integer | 主键，固定为 1（单行表） |
| ib_host_account_id | text | Host 账户 account_id（如 U17113214），用于对冲与行情；空则使用 TWS managed accounts 首个（R-A4） |
| stream_host_account_id | text | Live 页 Market Streams Host 账户 ID，用于按账户分类/筛选；空则不显示 Account 列与筛选器 |
| stream_secondary_account_id | text | Live 页 Market Streams 次账户 ID；空则同上 |
| ib_flex_host_token | text | IB Flex Web Service Token（主 IB）；与 settings_ib_flex 的 query_host_id 配合使用 |
| ib_flex_secondary_token | text | IB Flex Token（第二 IB）；与 settings_ib_flex 的 query_secondary_id 配合使用 |
| flex_default_range_days | integer | Default Flex Query 天数（如 30）；默认 30 |
| flex_init_range_days | integer | Init Flex Query 天数（如 360）；默认 360 |
| active_strategy_structure_id | bigint | 当前激活策略结构（若有） |
| active_gate_safety_strategy_id | bigint | 当前激活安全边界集（若有） |
| active_strategy_allocation_id | bigint | 当前激活资金分配（若有） |

- **IB Client ID 与连接**（运行时均从 `config.yaml` 的 `get_effective_ib_config` 读取；与 `daemon_heartbeat.ib_client_id` 心跳列无关）：

| 分组 | 角色 | config.yaml 键（Host / Secondary） | 使用场景 |
|------|------|-------------------------------------|----------|
| Daemon | Trading | `client_id_daemon` / — | 主连接下单、持仓、行情 |
| Daemon | Listener | `client_id_listener` / `ib2_client_id_listener` | 事件、订阅；Secondary 无行情订阅 |
| Monitor | Operator (cmd RPC) | `client_id.operator` / `secondary.client_id.operator`（旧键 `account` 仍可读） | IB Operator / Secondary 账户侧连接；账户摘要、执行记录等 |
| Standalone | IB ingestor | `ib.host.client_id.ingestor`（旧键 `ib_market_ingest` 仍可读） / — | `scripts/systemd/run_ib_ingestor.py`、Redis `ib:ingester:*` |
| Celery | Market Data | `client_id.worker_market` / — | Bars 补全等 worker |

- **语义**：**第二 IB**（`ib.secondary`，扁平键为 `ib2_*`）用于统一 Portfolio 与 listener_connector_2；行情仍由 Host 承担。**Flex**：token 与 Query 行由 Settings 或 POST /config/flex 写入。修改 **YAML 中的 client_id 或 host** 后需**重启**相关进程。

### 2.24 策略与安全边界表（设计标准与具体表结构，未来实现）

以下为**策略三层**（结构 → 机会 → 组合）与**安全边界四层**（gates：strategy / state / intent / guard）的数据库设计终版。命名与主外键约定见 **.cursor/rules/database-design.mdc**；新增/变更表时须在本文档同步更新并记入 §6 变更记录。

**表名约定**：策略表以 **`strategy_`** 为前缀；安全边界表以 **`gate_safety_`** 为前缀。主键列名均为 **`<表名>_id`**（如 `strategy_structure_id`、`gate_safety_strategy_id`），外键列名与所引用主键列名一致。**gate_safety_*** 表不使用 json/jsonb，仅标量列。

#### 2.24.0 结构类型配置表（可配置 Structure 类型/子类型，无 JSON）

以下 6 张表用于可配置的「结构类型」与「子类型」定义，供 Structure 页 Add/Edit 时读取（类型列表、默认腿、子类型说明、meta 参数与反推规则）。全部为标量列与子表，无 json/jsonb。

##### 2.24.0a 表 `strategy_structure_type`（结构类型模板）

- **用途**：可配置的结构类型定义（如 covered_call、cash_secured_put），供类型列表、展示顺序、是否含子类型及类型级说明。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| structure_type | text PRIMARY KEY | 类型代码：covered_call、cash_secured_put、iron_condor、straddle_strangle、leaps、calendar_spread、custom |
| display_label | text NOT NULL | 展示名称（如 "Covered Call"） |
| sort_order | integer NOT NULL DEFAULT 0 | 列表/下拉展示顺序 |
| has_subtypes | boolean NOT NULL DEFAULT false | 是否有子类型（如 covered_call 为 true） |
| type_explanation | text | 类型级说明（可选） |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |

##### 2.24.0b 表 `strategy_structure_type_leg`（类型默认腿，一行一条）

- **用途**：每个结构类型的默认腿模板，替代代码中写死的 default legs。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_type_leg_id | bigserial PRIMARY KEY | 主键 |
| structure_type | text NOT NULL REFERENCES strategy_structure_type(structure_type) ON DELETE CASCADE | 所属结构类型 |
| sort_order | integer NOT NULL DEFAULT 0 | 腿顺序 |
| role | text | 腿角色（如 underlying、call、put） |
| direction | text | 方向（long/short） |
| option_right | text | 期权方向（C/P）；空表示股票腿 |
| quantity_default | integer NOT NULL DEFAULT 1 | 默认数量 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |

- **硬约束**：`role`、`direction`、`option_right` 的允许值由后端 allowlist 定义，与 param_kind / meta_key 等一致；写入时由 `structure_type_config_write.replace_structure_type_legs` 校验，允许值见 `servers/reader/structure_type_config_constants.py`（LEG_ROLE_ALLOWED、LEG_DIRECTION_ALLOWED、LEG_OPTION_RIGHT_ALLOWED）。
- **索引**：`(structure_type)`。**唯一约束**：`UNIQUE (structure_type, sort_order)`。

##### 2.24.0c 表 `strategy_structure_subtype`（子类型模板）

- **用途**：某结构类型下的子类型（如 covered_call 下的 otm、atm、itm、deep_otm），存展示标签、Example、Typical use、说明等。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| structure_type | text NOT NULL | 所属结构类型 |
| subtype | text NOT NULL | 子类型代码（如 otm、atm、itm、deep_otm） |
| display_label | text NOT NULL | 展示名称（如 "OTM Covered Call"） |
| example | text | Example 文案 |
| typical_use | text | Typical use 文案 |
| subtype_explanation | text | 子类型级说明（如 Configurable parameters…） |
| nature | text | 可选（如 "Synthetic limit sell"） |
| sort_order | integer NOT NULL DEFAULT 0 | 同类型下子类型展示顺序 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |
| PRIMARY KEY (structure_type, subtype) | | |
| FOREIGN KEY (structure_type) REFERENCES strategy_structure_type(structure_type) ON DELETE CASCADE | | |

- **索引**：`(structure_type)`。

##### 2.24.0d 表 `strategy_structure_subtype_leg`（子类型默认腿，一行一条）

- **用途**：为特定子类型定义专属的默认腿模板（可覆盖类型级默认腿）。若某 `(structure_type, subtype)` 无任何记录，则该子类型继承 `strategy_structure_type_leg` 的腿集。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_subtype_leg_id | bigserial PRIMARY KEY | 主键 |
| structure_type | text NOT NULL | 所属结构类型 |
| subtype | text NOT NULL | 所属子类型 |
| sort_order | integer NOT NULL DEFAULT 0 | 腿顺序（在该 subtype 内） |
| role | text | 腿角色（如 underlying、call、put），允许值由 `LEG_ROLE_ALLOWED` 控制 |
| direction | text | 方向（long/short），允许值由 `LEG_DIRECTION_ALLOWED` 控制 |
| option_right | text | 期权方向（C/P）；空表示股票腿，允许值由 `LEG_OPTION_RIGHT_ALLOWED` 控制 |
| quantity_default | integer NOT NULL DEFAULT 1 | 默认数量 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |

- **约束与索引**：
  - 约束：`UNIQUE (structure_type, subtype, sort_order)`。
  - 外键：`FOREIGN KEY (structure_type, subtype) REFERENCES strategy_structure_subtype(structure_type, subtype) ON DELETE CASCADE`。
  - 索引：`(structure_type, subtype)`。

##### 2.24.0e 表 `strategy_structure_subtype_characteristic`（子类型特点，一行一条）

- **用途**：子类型的 Characteristics 列表，每条一行。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_subtype_characteristic_id | bigserial PRIMARY KEY | 主键 |
| structure_type | text NOT NULL | 所属结构类型 |
| subtype | text NOT NULL | 所属子类型 |
| sort_order | integer NOT NULL DEFAULT 0 | 展示顺序 |
| characteristic_text | text NOT NULL | 一条特点文案 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| FOREIGN KEY (structure_type, subtype) REFERENCES strategy_structure_subtype(structure_type, subtype) ON DELETE CASCADE | | |

- **索引**：`(structure_type, subtype)`。

##### 2.24.0f 表 `strategy_structure_subtype_meta_param`（子类型可配置 meta 参数定义）

- **用途**：定义每个子类型在 Wizard 中要展示的 meta 参数（如 otm_pct、itm_pct、call_strike_rule），以及默认值、展示标签、参数种类。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_subtype_meta_param_id | bigserial PRIMARY KEY | 主键 |
| structure_type | text NOT NULL | 所属结构类型 |
| subtype | text NOT NULL | 所属子类型 |
| meta_key | text NOT NULL | 写入 strategy_structure_meta 的键 |
| display_label | text | 表单项标签 |
| default_value_text | text | 默认值 |
| param_kind | text | 参数种类：fixed、integer、percent 等 |
| sort_order | integer NOT NULL DEFAULT 0 | 表单项顺序 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| FOREIGN KEY (structure_type, subtype) REFERENCES strategy_structure_subtype(structure_type, subtype) ON DELETE CASCADE | | |

- **索引**：`(structure_type, subtype)`。**唯一约束**：`UNIQUE (structure_type, subtype, meta_key)`。

##### 2.24.0f 表 `strategy_structure_subtype_rule`（从 meta 反推子类型）

- **用途**：定义当 strategy_structure_meta 中某 key 为某 value 时对应的 subtype，用于 Edit 时根据已有 meta 还原子类型。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_subtype_rule_id | bigserial PRIMARY KEY | 主键 |
| structure_type | text NOT NULL | 所属结构类型 |
| subtype | text NOT NULL | 对应的子类型 |
| meta_key | text NOT NULL | 用于推断的 meta 键 |
| meta_value_text | text NOT NULL | 用于推断的 meta 值 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| FOREIGN KEY (structure_type, subtype) REFERENCES strategy_structure_subtype(structure_type, subtype) ON DELETE CASCADE | | |

- **索引**：`(structure_type, meta_key, meta_value_text)`。**唯一约束**：`UNIQUE (structure_type, meta_key, meta_value_text)`。

##### 2.24.0g Structure type config 硬约束（allowlist）

以下字段为下游 Wizard、子类型推断、分析与自动化所依赖，写入时**必须**落在后端 allowlist 内；未纳入的值不允许写入，避免“配置了却不生效”的误导。单一事实来源：`servers/reader/structure_type_config_constants.py`。

- **param_kind**（meta_param 表）：仅允许 `fixed`、`percent`（及未来约定的如 `integer`）。`fixed` 表示固定选项不编辑；`percent` 表示数字输入（如 Wizard 中 1–50）。新增取值需先修改常量并发布。
- **meta_key**（meta_param 与 infer rule）：按 `structure_type` 允许列表配置。当前仅 `covered_call` 有下游逻辑，允许 `call_strike_rule`、`otm_pct`、`itm_pct`；其余 type 允许列表为空，即暂不允许配置 meta（避免无效配置）。新增 key 需先在常量中登记。
- **meta_value_text**（infer rule 与 fixed 类 default_value_text）：对部分 `(structure_type, meta_key)` 仅允许枚举值。当前仅 `("covered_call", "call_strike_rule")` 有枚举：`normal_otm`、`atm`、`itm`、`deep_otm`，表示概念上的 OTM 档位，而非固定百分比；具体 `%` 由 `otm_pct` / `itm_pct` 这类数值参数控制。数值类 key（如 `otm_pct`、`itm_pct`）可不做枚举约束。新增枚举值需在常量中登记。

Type Config UI 通过 GET `/strategies/structure-types/param-kind-options`、`/structure-types/{type}/meta-key-options`、`/structure-types/{type}/meta-value-options?meta_key=...` 获取选项并仅允许下拉选择；写接口（PUT meta-params、PUT infer-rules）对非法值返回 400。

#### 2.24.1 表 `strategy_structure`（结构策略）

- **用途**：存期权结构策略（腿 + 约束），可被多条机会策略引用；支持类型如 straddle_strangle、cash_secured_put、iron_condor、leaps、calendar_spread、custom。腿、约束、元数据存于子表 strategy_structure_leg、strategy_structure_constraint、strategy_structure_meta，本表仅标量列 + notes。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_id | bigserial PRIMARY KEY | 主键 |
| name | text NOT NULL | 策略名称（如 "Straddle 21-35 DTE ATM"） |
| structure_type | text NOT NULL | straddle_strangle \| cash_secured_put \| covered_call \| iron_condor \| leaps \| calendar_spread \| custom |
| structure_subtype | text | 仅 covered_call 时使用：otm \| atm \| itm \| deep_otm；其他类型 NULL。供 Wizard Step 2 与列表展示，不参与业务校验。 |
| version | integer NOT NULL DEFAULT 1 | 版本号 |
| is_active | boolean NOT NULL DEFAULT true | 是否可用 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |
| notes | text | 备注（可选），标量列便于查询与数据挖掘 |

#### 2.24.1a 表 `strategy_structure_leg`（结构策略腿，一行一条腿）

- **用途**：存结构策略的每条腿，标量列便于筛选、聚合与数据挖掘；替代 strategy_structure.legs 的 JSON 存储。strike、expiration 为可选预设，null/空表示在应用结构时再解析（如 ATM、按 DTE/日历）。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_leg_id | bigserial PRIMARY KEY | 主键 |
| strategy_structure_id | bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) ON DELETE CASCADE | 所属结构策略 |
| sort_order | integer NOT NULL DEFAULT 0 | 腿顺序 |
| role | text | 腿角色 |
| direction | text | 方向（如 long/short） |
| option_right | text | 期权方向（C/P） |
| quantity | integer NOT NULL DEFAULT 1 | 数量 |
| strike | double precision | 行权价 |
| expiration | text | 到期（如 YYYYMMDD） |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |

- **索引**：`(strategy_structure_id)`。

#### 2.24.1b 表 `strategy_structure_constraint`（结构策略约束，类型化键值）

- **用途**：存结构策略的约束（如 same_expiry_legs、same_strike_legs），标量列便于按约束类型查询与统计。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_constraint_id | bigserial PRIMARY KEY | 主键 |
| strategy_structure_id | bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) ON DELETE CASCADE | 所属结构策略 |
| constraint_type | text NOT NULL | 约束类型（如 same_expiry_legs、same_strike_legs） |
| constraint_value_text | text | 约束值（文本） |
| constraint_value_int | integer | 约束值（整数） |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |

- **索引**：`(strategy_structure_id)`。

#### 2.24.1c 表 `strategy_structure_meta`（结构策略元数据键值）

- **用途**：存结构策略的键值型元数据（标签、备注键值等），替代 strategy_structure.metadata 的 JSON 存储，便于按 key 查询。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_structure_meta_id | bigserial PRIMARY KEY | 主键 |
| strategy_structure_id | bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) ON DELETE CASCADE | 所属结构策略 |
| meta_key | text NOT NULL | 键 |
| meta_value_text | text | 值（文本） |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| UNIQUE (strategy_structure_id, meta_key) | | 同一结构下键唯一 |

- **索引**：`(strategy_structure_id)`。

#### 2.24.2 表 `strategy_opportunity`（机会策略）

- **用途**：存机会策略，引用一条结构策略与可选默认安全边界；标的范围用 **scope_type** + 子表 **strategy_opportunity_symbol**，入场条件用子表 **strategy_opportunity_entry_condition**（便于按标的、条件类型做 SQL 查询与数据挖掘）。无 jsonb 列。
- **列**（仅标量）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_opportunity_id | bigserial PRIMARY KEY | 主键 |
| name | text NOT NULL | 机会策略名称 |
| strategy_structure_id | bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) | 引用的结构策略 |
| default_gate_safety_strategy_id | bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id) | 可选，默认安全边界集 |
| scope_type | text | 标的范围类型：watchlist_stk、explicit_symbols；NULL 表示未设置 |
| is_active | boolean NOT NULL DEFAULT true | 是否可用 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |

#### 2.24.2a 表 `strategy_opportunity_symbol`（机会策略标的，一行一标的）

- **用途**：存机会策略的标的列表，标量列便于按 symbol 查询与统计。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_opportunity_symbol_id | bigserial PRIMARY KEY | 主键 |
| strategy_opportunity_id | bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE CASCADE | 所属机会策略 |
| symbol | text NOT NULL | 标的代码 |
| sort_order | integer NOT NULL DEFAULT 0 | 顺序 |
| UNIQUE (strategy_opportunity_id, symbol) | | 同一机会下标的唯一 |

- **索引**：`(strategy_opportunity_id)`。

#### 2.24.2b 表 `strategy_opportunity_entry_condition`（机会策略入场条件，一行一条）

- **用途**：存机会策略的入场条件（类型 + 值），标量列便于按 condition_type、数值范围做筛选与聚合。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_opportunity_entry_condition_id | bigserial PRIMARY KEY | 主键 |
| strategy_opportunity_id | bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE CASCADE | 所属机会策略 |
| condition_type | text NOT NULL | 条件类型：iv_min、iv_max、dte_min、dte_max、earnings_blackout_days、min_volume 等 |
| value_text | text | 值（文本） |
| value_numeric | double precision | 值（数值） |
| sort_order | integer NOT NULL DEFAULT 0 | 顺序 |

- **索引**：`(strategy_opportunity_id)`。

#### 2.24.3 表 `strategy_allocation`（策略分配 / Allocations）

- **用途**：存策略分配（Allocations），包含多条机会策略（通过关联表 strategy_allocation_opportunity）与可选分配级安全边界及标量约束；无 jsonb 列，便于数据挖掘与策略统计。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_allocation_id | bigserial PRIMARY KEY | 主键 |
| name | text NOT NULL | 分配名称 |
| gate_safety_strategy_id | bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id) | 可选，分配级安全边界集 |
| max_positions | integer | 约束：最大持仓数，可选 |
| max_bp_pct | numeric | 约束：最大资金使用比例，可选 |
| is_active | boolean NOT NULL DEFAULT true | 是否可用 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |

- **机会策略列表**：由表 strategy_allocation_opportunity（§2.24.3a）按 sort_order 关联得到；Reader 组装为 strategy_opportunity_ids 数组供 API。
- **API 命名**：请求/响应中限额使用 **allocation_limits**（对象含 max_positions、max_bp_pct），与表列一致，避免与顶栏 Portfolio 混淆。

#### 2.24.3a 表 `strategy_allocation_opportunity`（分配–机会关联，一行一机会）

- **用途**：存策略分配与机会策略的多对多关系，支持 FK 与按 opportunity 反查 allocation。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_allocation_id | bigint NOT NULL REFERENCES strategy_allocation(strategy_allocation_id) ON DELETE CASCADE | 策略分配 |
| strategy_opportunity_id | bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE CASCADE | 机会策略 |
| sort_order | integer NOT NULL DEFAULT 0 | 顺序 |
| PRIMARY KEY (strategy_allocation_id, strategy_opportunity_id) | | 复合主键 |

- **索引**：`(strategy_allocation_id)`（建表时隐式或显式）、`(strategy_opportunity_id)` 便于反查。

#### 2.24.4 表 `gate_safety_strategy`（安全边界集根 + strategy 层）

- **用途**：安全边界集根表，同时存 gates.strategy 层参数（structure、earnings、trading_hours_only）；id 即 boundary_set_id，供 state/intent/guard 子表及 settings 引用。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| gate_safety_strategy_id | bigserial PRIMARY KEY | 边界集主键 |
| name | text NOT NULL | 边界集名称 |
| version | integer NOT NULL DEFAULT 1 | 版本号 |
| structure_type | text | 可选，关联结构类型（如 straddle_strangle） |
| is_active | boolean NOT NULL DEFAULT true | 是否可用 |
| min_dte | integer NOT NULL | structure：最小 DTE |
| max_dte | integer NOT NULL | structure：最大 DTE |
| atm_band_pct | double precision NOT NULL | structure：近 ATM 带（如 0.03） |
| blackout_days_before | integer NOT NULL | earnings：财报前 N 天禁止 |
| blackout_days_after | integer NOT NULL | earnings：财报后 N 天禁止 |
| trading_hours_only | boolean NOT NULL DEFAULT true | 是否仅交易时段 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |

#### 2.24.5 表 `gate_safety_strategy_earnings_dates`（strategy 层财报黑名单日期）

- **用途**：存 gates.strategy.earnings.dates[]，一行一个黑名单日期。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| gate_safety_strategy_id | bigint NOT NULL REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE | 所属边界集 |
| holiday_date | date NOT NULL | 黑名单日期（如财报日） |
| PRIMARY KEY (gate_safety_strategy_id, holiday_date) | | 复合主键 |

#### 2.24.6 表 `gate_safety_state`（state 层）

- **用途**：存 gates.state（delta、market、liquidity、system 阈值）。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| gate_safety_strategy_id | bigint PRIMARY KEY REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE | 所属边界集 |
| epsilon_band | integer NOT NULL | delta：\|net_delta\| ≤ 此值为 D0 IN_BAND |
| threshold_hedge_shares | integer NOT NULL | delta：D2 HEDGE_NEEDED 阈值 |
| max_delta_limit | integer NOT NULL | delta：D3 FORCE_HEDGE 上限 |
| vol_window_min | integer NOT NULL | market：波动率窗口最小 bar 数 |
| stale_ts_threshold_ms | integer NOT NULL | market：报价过期阈值(ms) |
| wide_spread_pct | double precision NOT NULL | liquidity：宽 spread 比例 |
| extreme_spread_pct | double precision NOT NULL | liquidity：极端 spread 比例 |
| data_lag_threshold_ms | integer NOT NULL | system：数据延迟阈值(ms) |

#### 2.24.7 表 `gate_safety_intent`（intent 层）

- **用途**：存 gates.intent.hedge（对冲规模与成本门控）。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| gate_safety_strategy_id | bigint PRIMARY KEY REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE | 所属边界集 |
| min_hedge_shares | integer NOT NULL | 最小对冲股数 |
| cooldown_seconds | integer NOT NULL | 对冲冷却(秒) |
| max_hedge_shares_per_order | integer NOT NULL | 单笔最大对冲股数 |
| min_price_move_pct | double precision NOT NULL | 最小价格变动% |

#### 2.24.8 表 `gate_safety_guard`（guard 层）

- **用途**：存 gates.guard.risk（下单前熔断与限制）。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| gate_safety_strategy_id | bigint PRIMARY KEY REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE | 所属边界集 |
| max_daily_hedge_count | integer NOT NULL | 每日最大对冲次数 |
| max_position_shares | integer NOT NULL | 最大净股票仓位(股) |
| max_daily_loss_usd | double precision NOT NULL | 当日亏损熔断(美元) |
| max_net_delta_shares | integer NOT NULL | 最大净 delta(股) |
| max_spread_pct | double precision NOT NULL | 允许下单的最大价差% |
| paper_trade | boolean NOT NULL DEFAULT true | 是否模拟盘 |

#### 2.24.9 表 `strategy_history`（策略运行/状态历史）

- **用途**：策略运行或状态历史记录，主键列为 **`strategy_history_id`**（符合「表名_id」约定）。
- **列**：`strategy_history_id` (bigserial PK)、`strategy_structure_id` (bigint FK)、`ts` (timestamptz)、`state_summary` (jsonb)、`created_at`。索引 `(ts DESC)`、`(strategy_structure_id)`。由 `pg_ddl._ensure_tables` 创建。
- **写入**：由守护进程在 `append_history=True` 时经 PostgresSink 写入；`strategy_structure_id` 来自 `settings.active_strategy_structure_id`；`state_summary` 为 snapshot 子集（daemon_state、trading_state、symbol、net_delta、daily_hedge_count、daily_pnl、config_summary）的 jsonb。

#### 2.24.10 settings 表扩展（当前生效的策略与安全边界）

在 **settings** 表（id=1 单行）上增加两列：

| 列名 | 类型 | 说明 |
|------|------|------|
| active_strategy_structure_id | bigint REFERENCES strategy_structure(strategy_structure_id) | 当前生效的结构策略；NULL 表示用 config 或默认 |
| active_gate_safety_strategy_id | bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id) | 当前生效的安全边界集；NULL 表示用 config.gates |

- **语义**：守护进程启动时若上述两列非空，则从对应表组装「结构」与「gates」；否则回退 config。写 snapshot 时可在 config_summary 中附带两 id 或 hash 便于追溯。
- **Allocations 层扩展预留**：后续若需策略分配（Allocations）层「当前生效」，可在 settings 增加 **active_strategy_allocation_id**（bigint REFERENCES strategy_allocation）；用于多账户/多策略组合时指定当前监控或执行的分配集；实现与验收见需求与 [plans/CAPABILITY_TRACKING.md](plans/CAPABILITY_TRACKING.md)。
- **后续重构预留**：Settings 表可能重构为仅承载系统级配置；active_strategy_structure_id / active_gate_safety_strategy_id（及可选 active_strategy_allocation_id）可迁至独立表（如 runtime_strategy_config 单行表）。迁出时仅需调整 reader 与 POST /config/active-strategy 的读写目标，API 路径与请求体可保持不变。

#### 2.24.11 策略实例与交易归属（Strategy Instance & Trade Attribution）

- **用途**：将成交归属到**机会策略**（strategy_opportunity）与可选**策略实例**（strategy_instance），便于按策略、按单笔开仓做 PnL 与 Performance calendar；为「按策略盈亏比」提供数据基础。
- **策略实例**：代表某条机会策略在某账户下的一次开仓；同一实例的多腿（多 contract_key）共享同一 `strategy_instance_id`。
- **归属原则**：**account_positions 不存策略归属**（一个持仓可能对应多个策略，无法用单一字段表达）。**主归属来源为 account_executions**（各 raw 表列）**与** §2.24.11d **`account_execution_instance_allocation`**：默认每条成交可带 strategy_opportunity_id / strategy_instance_id；若存在**分摊行**，则以分摊为准，单列 `strategy_instance_id` 应清空（避免双源不一致）。对持仓展示策略信息时，通过 `(account_id, contract_key)` 从 account_executions **并上**分摊表中的实例推导 DISTINCT 策略列表（`strategy_links`），一对多。

##### 2.24.11a 表 `strategy_instance`（策略实例）

- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_instance_id | bigserial PRIMARY KEY | 主键 |
| strategy_opportunity_id | bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE RESTRICT | 所属机会策略 |
| account_id | text NOT NULL | 账户标识（与 account_positions 一致） |
| opened_at | timestamptz NOT NULL | 开仓时间（代表该实例的创建/开仓时刻） |
| label | text | 可选标签（如 "Straddle 2025-03"） |
| notes | text | 备注 |
| created_at | timestamptz NOT NULL DEFAULT now() | 创建时间 |
| updated_at | timestamptz NOT NULL DEFAULT now() | 更新时间 |

- **索引**：`(strategy_opportunity_id)`、`(account_id, opened_at)`，便于按机会、按账户查询。

##### 2.24.11b `account_executions` 扩展（交易归属）

- **新增列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| strategy_opportunity_id | bigint REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE SET NULL | 归属机会策略；NULL 表示未归属（历史/手动/未知） |
| strategy_instance_id | bigint REFERENCES strategy_instance(strategy_instance_id) ON DELETE SET NULL | 归属策略实例；NULL 表示未归属或仅按 opportunity 统计 |

- **索引**：`(strategy_opportunity_id)`、`(strategy_instance_id)`，便于按策略/实例筛选与 Realized PnL 聚合。

- **读取**：GET /status 的 positions 通过子查询从 account_executions **与**分摊表（§2.24.11d）推导 `strategy_links[]`（DISTINCT strategy_opportunity_id + strategy_instance_id per contract_key），附带 opportunity 名称与 instance label；GET /executions 返回每条成交的 strategy 字段、`instance_allocations`（若有），并可按 strategy_instance_id 筛选（命中单列或任一分摊行）；**GET /performance**（默认 `source_scope=performance_book`）及 Performance 页相关 executions 请求均从 **`account_executions_final`** 视图读取（仅 flex + journal，不含 TWS 补洞行），无需在 SQL 中按 source 过滤；**Trade ledger（Portfolio → Trade ledger）** 的 **Instance** 与 **Options** 两个顶层 Tab 均通过 `GET /executions?source_scope=performance_book` 拉取 **`account_executions_final`** 构建分组（Instance Tab 按 `strategy_instance_id` 是否存在分为 With instance / No instance，前端分组，无新增 API）；前端不对 `source` 做过滤。GET /performance 或统计模块按 strategy_opportunity_id、strategy_instance_id 聚合 Realized（executions + commissions）与 Unrealized（positions + quote）；若成交存在分摊，Realized/commission 按各分摊行的 `|allocated_quantity|` 占比拆分至对应实例。
- **批量打标**：`PATCH /executions/strategy-attribution`（替代原 `PUT /positions/strategy`）：按 account_id + contract_key 或 execution_ids 批量更新 executions 的 strategy 字段（**整笔单列**；若目标成交已有 §2.24.11d 分摊行则拒绝更新）。`PUT /executions/{id}` 支持单条更新，并可写入/替换 `instance_allocations`。

##### 2.24.11c Position × Instance 归因读模型（净仓近似归因）

- **目的**：一个 `account_positions` 持仓可由多个 `strategy_instance` 的成交组成。本读模型将持仓按实例拆分，输出 `(account_id, contract_key, strategy_instance_id)` 粒度的归因行，替代前端单实例归属逻辑。
- **方法**：`net_estimated`——**执行来源**：若该持仓在 `account_executions_final`（flex+journal）上存在任意匹配成交，则**仅**用 final 成交聚合；否则**仅**用 `executions_raw_tws`。按 `(account_id, contract_key, strategy_instance_id)` 对**有符号**数量求和得到 `open_qty_est`（final 侧沿用 flex/tws_client 的 QTY 符号约定；TWS 原始表数量恒为正，由 side 决定符号）。**不再**按「与持仓同号」过滤实例，凡有成交的实例均返回一行。`attribution_ratio` 为该行 `|open_qty_est|` 占本合约所有归因行 `|open_qty_est|` 之和的比例；`unrealized_pnl_est ≈ (价 − avg_cost) × open_qty_est × 合约乘数`（与 OPT 100 乘数一致）。
- **实现**：方案 A（推荐，当前）——在 reader 查询时实时计算（`servers/reader/executions.py → get_position_instance_attribution`），不落表。方案 B（稳定后可选）——定时写入快照表 `position_instance_attribution`。
- **API**：`GET /executions/position-attribution?account_id=&sec_type=`，返回 `{ attributions: PositionInstanceAttribution[] }`。每行包含：
  - 位置维度：`account_id`, `contract_key`, `symbol`, `sec_type`, `expiry`, `strike`, `option_right`, `position_qty`
  - 归因维度：`strategy_instance_id`, `strategy_instance_label`, `strategy_opportunity_id`, `strategy_opportunity_name`, `strategy_instance_opened_at_epoch`, `structure_type`, `scope_type`, `strategy_structure_id`
  - 估算指标：`open_qty_est`, `attribution_ratio`, `unrealized_pnl_est`, `method="net_estimated"`
  - 透明度字段：`source_exec_count`, `is_mixed`, `has_unassigned`
- **前端**：`PositionsPage` 的 Opportunity Sheet 使用归因 API 构建 `instanceGroups` / `instanceAllGroups`，支持同一合约在多个实例下并存展示，并提供 `Attribution` 筛选器（Single / Mixed / Unassigned）。
- **局限**：净仓近似在频繁开平/滚仓场景存在偏差（与 FIFO lot 引擎相比）。返回的 `method` 字段与 UI 提示 `Estimated attribution (net)` 明确标识估算口径。

##### 2.24.11d 表 `account_execution_instance_allocation`（成交 → 多实例数量分摊）

- **用途**：IB/Flex 上**一笔**成交（`account_executions` 一行）在业务上需拆给**多个** `strategy_instance`（例如同一合约、两个实例各有一部分仓位，到期合并一笔平仓）。物理成交仍一行；本表存每个实例对应的**有符号数量** `allocated_quantity`。
- **逻辑外键**：`account_executions` 为 VIEW，无法建 FK。使用 `(account_id, account_executions_id)` 与 `executions_raw_*` 中行一致；`account_executions_id` 编码见 `pg_ddl`（Flex 正数、TWS/journal 负数分支）。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_execution_instance_allocation_id | bigserial PRIMARY KEY | 主键 |
| account_id | text NOT NULL | 账户 |
| account_executions_id | bigint NOT NULL | 与统一视图主键一致 |
| strategy_instance_id | bigint NOT NULL REFERENCES strategy_instance(strategy_instance_id) ON DELETE RESTRICT | 分摊到的实例 |
| allocated_quantity | double precision NOT NULL | 有符号数量；与 reader 中 flex/journal 的 QTY 规范化（`_QTY_NORM_*`，Sell 为负等）一致，且同一 `account_executions_id` 下各行的 **SUM(allocated_quantity)** 应等于该笔成交的规范化数量（应用层校验） |
| created_at / updated_at | timestamptz | 维护时间 |

- **唯一约束**：`UNIQUE (account_executions_id, strategy_instance_id)`。
- **与 §2.24.11b 互斥**：若某 `account_executions_id` 存在至少一行本分摊表记录，则以分摊为准；对应 raw 行上 `strategy_instance_id` 应置 NULL（`strategy_opportunity_id` 可保留或亦清空，由录入约定决定）。
- **删除**：删除 raw 成交行时一并删除本分摊表中 `account_executions_id` 匹配行。
- **Performance**：单笔 `realized_pnl`、`commission`（来自 `account_execution_commissions`）按各分摊行 `|allocated_quantity|` 占该笔总 `|allocated_quantity|` 的比例拆分至各实例；若占比为 0 则退回整笔记于单列（若存在）。

##### 2.24.11e 表 `account_execution_option_stock_link`（期权成交 → 标的股票成交）

- **用途**：将**行权/指派**产生的标的股票成交与对应期权成交（`account_executions_final` 中 `sec_type=OPT` 的一行）人工关联，用于 Trade Ledger 展示与 **相对 Flex `close_price` 的滑点**（API 计算 `signed_qty × (price − close_price)`，不写回 `realized_pnl`）。
- **逻辑外键**：`account_executions` 为 VIEW，不建 FK。两端 `account_executions_id` 均须能在 `account_executions_final` 中解析；应用层校验 OPT/STK、`account_id` 与标的 `symbol` 一致。
- **列**（无 json/jsonb）：

| 列名 | 类型 | 说明 |
|------|------|------|
| account_execution_option_stock_link_id | bigserial PRIMARY KEY | 主键 |
| account_id | text NOT NULL | 账户 |
| option_account_executions_id | bigint NOT NULL | 期权腿统一 id |
| stock_account_executions_id | bigint NOT NULL | 股票腿统一 id |
| role | text | 可选：`exercise` / `assignment`（CHECK） |
| note | text | 备注 |
| created_at | timestamptz | 创建时间 |

- **唯一约束**：`UNIQUE (option_account_executions_id, stock_account_executions_id)`（同一股票腿对同一期权腿仅一条）。
- **API**：`GET/POST/DELETE /executions/option-stock-links`、`GET /executions/stock-link-candidates`（见 trading router）。

---

## 3. 阶段 1 写入策略

- **daemon_auto_status_current**：每次 **heartbeat** 调用 `write_snapshot(snapshot, append_history=False)`，仅更新当前表。
- **daemon_auto_status_history**：仅在 `append_history=True` 时追加；调用方（GsTrading）在**发生对冲相关操作**时（对冲意图、下单、成交、拒绝）传入 `append_history=True`，或可选每心跳一次。纯无操作心跳不追加历史。
- **daemon_auto_operations**：仅在对冲意图、order_sent、fill、reject 四处插入记录。

上述策略的代码与配置详见 `PostgreSQLSink` 实现。

---

## 4. 依赖与本地查看（Phase 1）

- **Python 依赖**：阶段 1 使用 **psycopg2-binary** 连接 PostgreSQL，已在 `pyproject.toml` 中声明。安装环境后执行 `pip install -e .` 即可。
- **PostgreSQL 实例**：需本地或 Docker 提供 PostgreSQL；创建数据库与用户后，在 `config/config.yaml` 中配置 root `postgres`（或使用环境变量 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`）。不配置或未连接时守护程序照常运行，仅不写入状态与操作。
- **用 psql 查看**：连接后可直接查询各表，例如：
  - 当前状态：`SELECT * FROM daemon_auto_status_current;`
  - 最近历史：`SELECT * FROM daemon_auto_status_history ORDER BY ts DESC LIMIT 20;`
  - 操作记录：`SELECT * FROM daemon_auto_operations ORDER BY ts DESC LIMIT 20;`
- **API 与主键列名**：GET /status 返回的当前状态行包含主键列 `daemon_auto_status_current_id`；GET /operations 返回的每条记录包含主键列 `daemon_auto_operations_id`。程序与前端类型定义均使用上述列名，便于与表结构一致维护。
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

### 4.2 表不存在或自检报 "Table 'daemon_auto_status_current' missing or empty columns"

若数据库已能连接，但 **PostgreSQL schema（表或列）** 不符合要求，说明当前库中尚未创建阶段 1/2 所需的表（或列不一致）。在项目根目录执行：

```bash
python scripts/db/db_refresh_schema.py
```

脚本会按 `config/config.yaml` 中的 root `postgres` 配置连接当前库，并创建/补齐 §2 所列各表（与 `PostgreSQLSink._ensure_tables` 一致）。完成后可启动守护进程或通过 psql 验证表与列是否符合 [DATABASE.md](DATABASE.md) §2。

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
python scripts/db/db_release_dblock.py              # 列出并询问确认后终止
python scripts/db/db_release_dblock.py --dry-run    # 仅列出，不终止
python scripts/db/db_release_dblock.py --yes       # 不确认，直接终止
```

**如何避免**：

- **只保留一个写入者**：同一时间只运行 **一个** 守护进程（`run_engine.py`），不要同时跑两个会写 `daemon_heartbeat` 的进程。
- **短事务**：本仓库的 sink 已做到每次写心跳后立即 `commit()`，不长时间持锁；若自研或改代码，请勿在未提交事务中长时间持有对 `daemon_heartbeat` 的写入或显式锁。
- **锁等待超时**：PostgreSQLSink 连接后已设置 `lock_timeout = '5s'`，若 5 秒内拿不到行锁会报错并 rollback，不会无限阻塞；可根据需要调整超时或重试策略。
- **自动释放锁并重试**：若因上次守护进程异常退出导致 `daemon_heartbeat` 或 `daemon_run_status` 被锁，再次启动时若遇到 lock timeout，sink 会**自动**查询并终止持有/等待这两张表锁的其他后端（逻辑同 `scripts/db/db_release_dblock.py`，仅针对 `daemon_heartbeat` 与 `daemon_run_status`），然后重试连接或写入一次，无需手动执行 release 脚本。

---

## 5. 后续阶段与数据库的关联（预留）

以下为占位说明，具体表结构或字段在对应阶段实现时在本文档中补充。

- **阶段 2**：独立应用**只读** `daemon_auto_status_current`、`daemon_auto_operations`、`daemon_run_status`、`daemon_heartbeat`（GET /status 含 trading_suspended 与守护/对冲分开显示）；控制通道使用表 **daemon_control**（stop/flatten，见 §2.4）与 **daemon_run_status**（挂起/恢复，见 §2.5）。**daemon_heartbeat**（§2.6）由稳定守护进程写入，用于监控端区分守护进程存活与对冲程序是否在跑。**Engine 启动**由 Ops+systemd 或交易机手工执行；Monitor 不 subprocess 启动。
- **阶段 3.1（历史统计）**：只读 `daemon_auto_status_history`、`daemon_auto_operations` 做聚合（按日/周对冲次数、盈亏等）；不新增表，仅查询。
- **阶段 3 R-A2/R-A3（复盘与风控）**：**account_executions**（§2.11）存账户执行/成交；**stock_day**、**stock_min**、**option_day**、**option_min**（§2.13–§2.16）存股票与期权 K 线；**watchlist**（§2.17）存自选标的。GET /executions、GET /bars、GET/POST/DELETE /watchlist 与复盘/市场数据页读上述表；写入由监控端或独立脚本在阶段 3 实现时接入。
- **阶段 4（回测）**：若回测结果需要落库，可新增 schema 或表（如 `backtest_runs`、`backtest_ticks`），在本文档 §6 增加。
- **其他**：控制指令、告警、用户配置等若未来落库，均在本文档中新增章节并注明引入阶段。

---

## 6. 变更记录

| 日期 | 变更内容 | 引入阶段 |
|------|----------|----------|
| （初版） | 新增 §1–§4：连接配置、阶段 1 三表（daemon_auto_status_current、daemon_auto_status_history、daemon_auto_operations）、写入策略；§5 后续阶段预留。 | 阶段 1 |
| 阶段 1 落地 | 新增 §4：依赖（psycopg2-binary）、配置说明、psql 查看示例；§5/§6 章节号顺延。 | 阶段 1 |
| 控制通道改 DB | 新增 §2.4 表 daemon_control；控制指令由本地文件改为 PostgreSQL，支持监控与守护进程分离部署（RE-5）。 | 阶段 2 |
| 挂起/恢复状态 | 新增 §2.5 表 daemon_run_status；监控机写入、交易机轮询，实现挂起/恢复对冲；监控机移除 subprocess/start。 | 阶段 2 |
| 守护进程心跳 | 新增 §2.6 表 daemon_heartbeat；稳定守护进程每心跳写入，监控端区分守护/对冲并分开显示（RE-6）。 | 阶段 2 |
| IB 连接状态（RE-7） | daemon_heartbeat 增加 ib_connected、ib_client_id；daemon_control 支持 command=retry_ib；守护程序不假定 IB 已运行，可观测与重试。 | 阶段 2 |
| 阶段 3 R-A2/R-A3 | 新增 §2.11 表 account_executions（账户执行/成交）；§2.12 弃用 ohlc_bars，新增 §2.13–§2.17 表 stock_day、stock_min、option_day、option_min、watchlist（股票/期权 K 线与自选标的）；供复盘与风控页及 GET /executions、GET /bars、Watchlist CRUD、报价落库使用。 | 阶段 3 |
| 2026-03-03 R-A3 扩展 | 弃用 ohlc_bars；新增 stock_day、stock_min、option_day、option_min、watchlist；K 线读写改为分表；Watchlist CRUD 与智能拉取 duration。 | 阶段 3 |
| 2026-03-08 持仓分类 | 新增 §2.19 表 preference_position_categories（STK 持仓分类定义）、§2.20 表 preference_position_category_tags（持仓→分类 Tag）；GET /position-categories、PUT /position-categories/tag；GET /status 的 positions 带出 category_id/category。 | 阶段 3 扩展 |
| 2026-03-11 Market Streams 排序落库 | 新增 §2.21 表 preference_market_streams_symbol_order（按 category 的 Symbol 自定义排序）；GET/PUT /position-categories/symbol-order；需执行 db_refresh_schema.py 创建新表。 | 阶段 3 扩展 |
| 2026-03-08 Flex Transaction | 新增 §2.21 表 account_transactions（IB Flex 资金流水）；POST /transactions/fetch 拉取 Flex Cash Transactions 写入；get_net_cash_flow/get_transactions 供 GET /performance 使用。 | 阶段 3 Performance Phase 0 |
| 2026-03-08 US market holidays | 新增 §2.22 表 reference_us_holidays（NYSE 休市日）；GET /market/trading-day 判断是否交易日；Settings 页 US market holidays 管理添加/删除；Data 页「(end)」标黄仅交易日。 | 阶段 3 扩展 |
| 2026-03-08 Flex 一行双 Query ID | §2.23 settings_ib_flex 每行含 query_host_id（必填）+ query_secondary_id（可选）；同一 Label/Purpose 下 Host 与 Secondary 各一个 Query，Fetch 时两个都 call。 | 阶段 3 Performance Phase 0 |
| 2026-03-08 Flex 一 Token 多 Query | §2.23 settings_ib_flex：列 query_id、query_label、purpose；同一 token 可多行；POST /transactions/fetch 仅用 purpose=cash_transactions；reader.get_flex_config(purpose) 支持按用途过滤。 | 阶段 3 Performance Phase 0 |
| 2026-03-08 Flex Token 入 settings | settings 增加 ib_flex_host_token、ib_flex_secondary_token；settings_ib_flex 存 Query 行；GET /status flex_config 为 { host_token, secondary_token, rows }。 | 阶段 3 Performance Phase 0 |
| 2026-03-13 策略与安全边界表 | 新增 §2.24 策略与安全边界表（设计标准与具体表结构）：strategy_structure、strategy_opportunity、strategy_allocation；gate_safety_strategy、gate_safety_strategy_earnings_dates、gate_safety_state、gate_safety_intent、gate_safety_guard；settings 扩展 active_strategy_structure_id、active_gate_safety_strategy_id。主键列名采用「表名_id」；策略表 strategy_ 前缀、安全边界表 gate_safety_ 前缀；gate_safety 表无 json。标准见 .cursor/rules/database-design.mdc。 | 未来实现 |
| 2026-03-13 status_history 主键规范 | 表 status_history 主键列采用 `status_history_id`，符合 .cursor/rules/database-design.mdc「表名_id」约定（该表后已重命名为 daemon_auto_status_history）。 | — |
| 2026-03-13 daemon_auto 表重命名与主键规范 | 表 daemon 自动交易三表命名为 daemon_auto_status_current、daemon_auto_status_history、daemon_auto_operations；主键列为 daemon_auto_status_current_id、daemon_auto_status_history_id、daemon_auto_operations_id（符合 database-design.mdc）。由 _ensure_tables 建表；不再支持旧表名。§2.1–§2.3、§3、§4、§4.2。 | — |
| 2026-03-13 instrument_prices 重命名为 contract_quote_live | 表 instrument_prices 已弃用，当前仅使用 contract_quote_live（§2.10）；含义为按合约的实时报价缓存。代码已统一：模块 contract_quote_live.py、方法 write_contract_quote_live / sync_contract_quote_live_from_redis 等。旧表 instrument_prices 不再使用，若库中仍存在可手动迁移或删除。 | 阶段 3 R-M6 |
| 2026-03-13 Celery 任务表命名 | 表 `job_bars_backfill`（主键 `job_bars_backfill_id`）；Celery/任务队列表均使用 **`job_`** 前缀，主键为「表名_id」。§2.18、database-design.mdc；reader 层函数统一为 `job_bars_backfill_*`。 | 阶段 3 |
| 2026-03-13 strategy_history 主键规范 | 若存在表 strategy_history，主键列须为 `strategy_history_id`（§2.24.9 约定）；schema 由建表或手动维护，不提供列名迁移。 | — |
| 2026-03-13 表 accounts 重命名为 account | 表 `accounts` 重命名为 `account`（单数）；§2.7、所有引用该表名的 SQL 与文档同步。**当前约定**：仅使用表名 `account`，不兼容旧表名 `accounts`，pg_ddl 与 db_refresh_schema 均不包含对旧表名的迁移逻辑。 | — |
| 2026-03-13 account_executions/account_transactions 主键列名 | §2.11 account_executions、§2.21 account_transactions 主键列由 `id` 改为 `account_executions_id`、`account_transactions_id`（符合 database-design.mdc）。 | 阶段 3 |
| 2026-03-13 表 market_streams_symbol_order 重命名 | §2.21 表重命名为 preference_market_streams_symbol_order（偏好类）；不兼容旧表名，不提供迁移。 | — |
| 2026-03-13 表 position_categories/position_category_tags 重命名 | §2.19、§2.20 表重命名为 preference_position_categories、preference_position_category_tags（偏好类）；不兼容旧表名，不提供迁移。 | — |
| 2026-03-13 删除未使用的 public.stocks 表 | 项目内无任何逻辑依赖表 `public.stocks`；标的列表用 watchlist，股票 K 线用 stock_day/stock_min。若库中存在该表可安全执行 `DROP TABLE IF EXISTS public.stocks;`。 | — |
| 2026-03-14 表 settings_ib_flex | §2.23 IB Flex 配置表名为 `settings_ib_flex`（无旧表名兼容）。 | — |
| 2026-03-14 表 reference_us_holidays | §2.22 美股休市日表名为 `reference_us_holidays`。 | — |
| 2026-03-14 watchlist 主键改为 contract_key | §2.17 表 watchlist 主键由 `id` (bigserial) 改为 `contract_key` (text)；一行一合约，与 account_positions/contract_quote_live 一致；无向下兼容，pg_ddl 对已有表做一次性迁移。Reader/Router/前端删除仅按 contract_key。 | — |
| Phase A 策略与安全边界闭环 | Reader：get_structure_by_id、list_structures、get_strategy_history、list_gate_safety_sets、get_gate_safety_name；Daemon 从 DB 加载 active_strategy_structure；PostgresSink 在 append_history 时写入 strategy_history；GET /status 返回 active 策略/边界 id 与 name；GET /strategies/structures、/structures/{id}、/history、/gate-safety。§2.24.9 写入说明。 | Phase A |
| 策略结构表扩展（去 JSON 化） | 新增表 strategy_structure_leg、strategy_structure_constraint、strategy_structure_meta；strategy_structure 增加 notes 列；legs/constraints/metadata 保留兼容，新数据与数据挖掘优先使用子表与标量列。§2.24.1、§2.24.1a–c。 | — |
| strategy_structure 移除 JSON 列 | 表 strategy_structure 删除列 legs、constraints、metadata；读写仅通过子表与 notes。Reader 从子表组装 legs/constraints/metadata 供 API 与 daemon；Writer 只写主表标量 + notes 与三张子表。§2.24.1。 | — |
| 机会策略去 JSON（scope_type + 子表） | strategy_opportunity 增加 scope_type 列；新增子表 strategy_opportunity_symbol（一行一标的）、strategy_opportunity_entry_condition（一行一条条件）；新数据仅写子表。§2.24.2、§2.24.2a、§2.24.2b；database-design.mdc 更新。 | — |
| 机会策略移除 jsonb 列 | strategy_opportunity 表删除列 symbol_scope、entry_conditions（无历史数据需迁移）；pg_ddl 建表不再包含两列，并对已有表执行 DROP COLUMN IF EXISTS；Reader 仅从子表组装 symbols/entry_conditions。§2.24.2。 | — |
| 策略分配（strategy_allocation）| 表 strategy_allocation、strategy_allocation_opportunity；主键 strategy_allocation_id；无 jsonb，机会列表通过关联表与 sort_order；API 请求/响应使用 allocation_limits（max_positions、max_bp_pct）。§2.24.3、§2.24.3a。 | — |
| strategy_structure.structure_subtype | §2.24.1 表 strategy_structure 增加列 structure_subtype (text NULL)；covered_call 时存 otm/atm/itm/deep_otm，供 Edit Wizard 还原 Step 2 状态。 | — |
| 结构类型配置表（方案 A） | 新增 6 张表：strategy_structure_type、strategy_structure_type_leg、strategy_structure_subtype、strategy_structure_subtype_characteristic、strategy_structure_subtype_meta_param、strategy_structure_subtype_rule。由 _ensure_tables 创建；初始数据由 scripts/init/db_init/seed_structure_type_config.py 写入。§2.24.0、§2.24.0a–f。 | — |
| 策略实例与交易归属 | 新增表 strategy_instance（§2.24.11a）；account_executions 增加 strategy_opportunity_id、strategy_instance_id（§2.24.11b）。**account_positions 不存策略归属**（已移除 strategy_opportunity_id、strategy_instance_id 列）；持仓的策略信息通过 account_executions 推导 strategy_links[]。详见 §2.24.11a、§2.24.11b。 | 阶段 3 扩展 |
| 2026-03-19 Position×Instance 归因读模型 | §2.24.11c：净仓近似归因——GET /executions/position-attribution 将持仓按实例拆分（net_estimated），返回 open_qty_est / attribution_ratio / unrealized_pnl_est / is_mixed / has_unassigned；前端 PositionsPage Opportunity Sheet 改用该 API，同一合约可在多个实例下并存展示；新增 Attribution 筛选器（Single / Mixed / Unassigned）。实时读模型（不落表），见 servers/reader/executions.py。 | 阶段 3 扩展 |
| 2026-03-19 Executions 分源迁移 | 三张原始源表：`executions_raw_tws`（TWS/manual 源）、`executions_raw_flex`（Flex 源权威成交）、`executions_raw_journal`（journal_closed 人工会计调整）。`account_executions` 为统一只读视图（UNION ALL，Flex 优先覆盖 TWS，Journal 独立流）。**`account_executions_final`**：仅 UNION `executions_raw_flex` + `executions_raw_journal`（不含 TWS 补洞行），列与主键编码规则与全量视图中对应两分支一致。**`account_executions_fly`**：源为 `executions_raw_tws`，`account_executions_id = -(executions_raw_tws_id)`；排除 `sec_type = BAG`（多腿组合占位）；排除在 **`account_executions_final` 中已出现相同 `(account_id, contract_key)`（非空、trim 后相等）** 的 TWS 行。**GET /executions**、**GET /performance** 在 `source_scope=on_the_fly` 时读此视图。回填脚本 `scripts/db_backfill_executions_raw.py`。 | 阶段 3 扩展 |
| 2026-03-20 settings 移除 IB 连接列 | `settings` 表不再包含 `ib_host`、`ib_port_type`、`ib_client_id_*`、`ib2_*` 等列；IB 连接与 client_id 以 YAML `ib.host` / `ib.secondary` 为唯一真源；`pg_ddl` 新建库不含上述列。§2.9。 | 阶段 2 |
| 2026-03-21 Massive 期权研究数据（R-A6） | option_day / option_min 增加 `source` 列（text, DEFAULT 'ib'）并调整 UNIQUE 包含 source；option_min 周期增加 '1 sec'（Massive 秒聚合）；option_contracts 增加 `massive_option_ticker`（可选）；option_snapshots 扩展为含 Greeks/IV（iv/delta/gamma/theta/vega）+ OI + underlying_price + source；新增表 option_open_interest_daily（§2.16.3）、option_trades（§2.16.4，预留）、job_massive_backfill（§2.16.5）、massive_corporate_action（§2.16.6）。 | 期权研究阶段 |
| 2026-03-24 Massive/期权研究相关 DB 升级 | `job_massive_backfill` 增加 `payload_hash` 列 + 部分唯一索引（防重复 pending/running）。新增表 `report_option_max_pain_daily`（§2.16.5a，Max Pain 日报表，含 `computation_detail` jsonb）。`option_snapshots` 迁移为 `PARTITION BY RANGE (snapshot_ts)` 按月分区（新库直接分区建表，已有库自动迁移）。新增物化视图 `option_snapshots_latest`（`DISTINCT ON contract_key`，支持 `REFRESH CONCURRENTLY`）。90 天保留策略：旧分区 DETACH + 归档。 | 行为边界见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.10 |
| 2026-04-07 Engine Ops 启停与文档 | **无 schema 变更**。§2.5、§5 阶段 2 说明修订：Engine 由 Ops+systemd 或手工启动；Monitor 不 exec；`daemon_heartbeat.graceful_shutdown_at` 仍由进程优雅退出时写入（含 systemd SIGTERM）。 | — |
| 2026-04-09 Stock reference（Massive） | 扩展 §2.14.1 `stocks`（参考字段与 `reference_updated_at`）；新增 §2.14.2 `ticker_instrument_types`、§2.14.3 `stock_related_tickers`、§2.14.4 `job_stock_reference_state`。同步任务 kinds：`stock_reference_universe`、`stock_reference_overview`、`stock_reference_related`、`stock_reference_instrument_types`；Redis 键 `massive:ingestor:cache:*`。 | 研究 / Massive |
| 2026-04-10 Massive ticker reference 表名统一 | §2.14.1–2.14.5：`tickers`、`ticker_overview`（原 `ticker_reference_details`）、`ticker_types`（原 `ticker_instrument_types`，PK `ticker_types_id`）、`ticker_related_tickers`、`job_ticker_reference_state`；`pg_ddl` 内 DO 块重命名。任务 kind canonical：`ticker_reference_ticker_types`（旧名仍经 `normalize_ticker_ref_kind` 映射）；HTTP `GET /research/massive/reference/ticker-types`；Redis `massive:ingestor:cache:ticker_types:*`。 | 研究 / Massive |
| 2026-04-14 option_contracts 参考元数据 | `option_contracts` 增加 `exercise_style`、`shares_per_contract`、`cfi`、`primary_exchange`（均可空）；Massive `GET /v3/reference/options/contracts` 分页与 `GET /v3/snapshot/options/{underlying}` 链写入路径同步填充；`GET /research/massive/contracts-coverage` 增加各字段及「四列齐全」覆盖率。§2.16.1。 | 研究 / Massive |
| 2026-04-15 option_contracts 移除参考元数据列 | 删除 `exercise_style`、`shares_per_contract`、`cfi`、`primary_exchange`；`pg_ddl` 迁移块对上述列 `DROP COLUMN IF EXISTS`。§2.16.1。 | 研究 / Massive |
| 2026-04-15 report_option_atm_iv_daily | 新增表 `report_option_atm_iv_daily`（§2.16.5b）：按交易日汇总 ATM IV，加速 IV Volatility Cone；`pg_ddl` 建表与索引。 | Option Discovery |
| 2026-04-15 option_day / option_min vwap | `option_day`、`option_min` 增加可空列 `vwap`（Massive 聚合 `vw` 回填）；`pg_ddl` 迁移 `ADD COLUMN`；GET `/bars`（option）与 K 线前端展示。§2.15、§2.16。 | 期权研究 / Option Discovery |
| 2026-04-16 Massive chain snapshot 全量落库 | `option_contracts` 恢复 `exercise_style`、`shares_per_contract`（可空）。`option_snapshots` 增加 `underlying_ticker`、`day_*`（OHLC/量能/vwap/last_updated）、`break_even_price`、`fmv`/`fmv_last_updated`；`iv` 列语义对应 API `implied_volatility`。物化视图 `option_snapshots_latest` 列集同步；迁移路径在 `migrate_opt` 末尾按基表与 MV 差异重建 MV。Massive Worker 写入与 Research API / Option Discovery 读路径扩展。§2.16.1–2.16.2。 | Massive / Option Discovery |
| 2026-04-17 option_snapshots 收窄 + 标的视图 | 删除列 `last`、`bid`、`ask`、`mid`、`underlying_price`、`break_even_price`、`fmv`、`fmv_last_updated`；新增生成列 `day_last_updated_day`。新增视图 `option_snapshots_with_underlying_day`（左连 `stock_day`，`source=massive`，`underlying_price` = `stock_day.close`）。`option_snapshots_latest` 与 EOD 读路径（`get_option_snapshots_eod_per_day`）同步。§2.16.2。 | Massive / Option Discovery |
| 2026-04-18 option_contracts 列级覆盖与参考对拍 | §2.16.1 增补「Massive 字段与写入路径」与 L1/L2/L3 说明。`watchlist-db-coverage` / `contracts-coverage` 增加 `exercise_style`/`shares_per_contract` 非空计数与占比；新增 `GET/POST .../option-contracts-reference-column-parity`（L2，与 reference 分页上限一致）。无表结构变更。 | 研究 / Massive |
| 2026-04-18 option_snapshots 主键、幂等写入 | §2.16.2：主键为 `PRIMARY KEY (contract_key, snapshot_ts)`（`option_snapshots_id` 为序列列）；存量库由 `pg_ddl` 从旧 `(option_snapshots_id, snapshot_ts)` + 可选 `UNIQUE` 迁移；`DROP` 冗余索引 `option_snapshots_contract_key_ts`。去重脚本 `dedupe_option_snapshots.py`；链快照与 WS 为 `ON CONFLICT (contract_key, snapshot_ts) DO UPDATE`。 | Massive / Option Discovery |
| 2026-04-19 option_day 池化补齐任务 | `job_massive_backfill` 在 `kind=feed_options_aggregate`（历史行可能为 `aggregates`）下支持 `option_day_pool_row_gap`（v2 日线 aggs 补「有合约无 bar」）与 `option_day_pool_column_fill`（v1 open-close 刷新不完整行，可选再补 vwap）；`mode=open_close` 在 `persist=true` 时可 `UPDATE option_day`。无新表；环境变量 `BIFROST_OPTION_DAY_ROW_LOOKBACK_DAYS` 控制默认回溯窗口。 | Massive / Data Overview |
| 2026-04-19 Massive 期权快照任务 kind 更名 | `job_massive_backfill.kind`：期权链/单合约/统一快照 ingest 由 `snapshot` 更名为 **`feed_option_snapshots`**；`POST /research/massive/sync` 与 Worker 经 `normalize_ticker_ref_kind` 仍接受旧名；存量行仍可执行。§2.16。 | Massive |
| 2026-04-19 Massive 股票聚合 OHLC 任务 kind 更名 | `job_massive_backfill.kind`：股票 Massive REST OHLC 落库由 `stock_ohlc_sync` 更名为 **`feed_stocks_aggregate`**；API 与 Worker 经 `normalize_ticker_ref_kind` 仍接受旧名；路由键 `massive_stocks` / `massive_stocks_high` 不变。§2.16。 | Massive |
| 2026-04-19 Massive 快照按合约补列 + bars 池 expiry | `kind=feed_options_aggregate`（历史行可能为 `aggregates`）新增 `option_snapshots_pool_contract_fill`：按 `option_snapshots_latest` 语义选出 IV/Greeks/OI 可空合约，调用 `GET /v3/snapshot/options/{underlying}/{option_ticker}`，经 `apply_chain_snapshot_item` **UPSERT `option_snapshots`**（与链式快照列一致），并 `REFRESH` `option_snapshots_latest`。`kind=feed_option_snapshots` 且 `mode=contract`（旧 payload `snapshot_type` 仍兼容；历史 `kind=snapshot` 行 Worker 仍识别）在默认 persist 下同样落库。`option_day_pool_row_gap` / `option_min_pool_row_gap` 的 payload 可选 **`expiration_date`**，将行缺口池限制到单到期（Data Overview All gaps 表内「Fill row gap (expiry)」）。 | Massive / Data Overview |
| 2026-04-19 Massive 期权 bars 聚合任务 kind 更名 | `job_massive_backfill.kind`：期权 OHLC / 池化 ingest 由 `aggregates` 更名为 **`feed_options_aggregate`**；`POST /research/massive/sync` 与 Worker 经 `normalize_ticker_ref_kind` 仍接受旧名；路由 `massive` / `massive_high` 不变。§2.16。 | Massive |
| 2026-04-19 Massive 股票参考 related peers 任务 kind 更名 | `job_massive_backfill.kind`：关联公司 peer 拉取由 `ticker_reference_related` 更名为 **`feed_stocks_tickers_related`**；`normalize_ticker_ref_kind` 将 `ticker_reference_related` 与 `stock_reference_related` 映射至新名；路由仍为 `massive_stocks` / `massive_stocks_high`。§2.14 / §2.16。 | Massive |
| 2026-04-19 Massive 股票参考 overview 任务 kind 更名 | `job_massive_backfill.kind`：标的详情 / `ticker_overview` 拉取由 `ticker_reference_overview` 更名为 **`feed_stocks_tickers_overview`**；`normalize_ticker_ref_kind` 将 `ticker_reference_overview` 与 `stock_reference_overview` 映射至新名；路由仍为 `massive_stocks` / `massive_stocks_high`。§2.14 / §2.16。 | Massive |
| 2026-04-19 Massive 期权 Trade & Quotes 代理任务 kind 更名 | `job_massive_backfill.kind`：期权 last trade / quotes / historical trades 代理由 `trades_quotes` 更名为 **`feed_options_trades_quotes`**；`normalize_ticker_ref_kind` 仍接受旧名；路由仍为 `massive` / `massive_high`。§2.16。 | Massive |
| 2026-04-19 Massive 期权 reference contracts 任务 kind 更名 | `job_massive_backfill.kind`：期权合约参考 API 任务由 `contracts` 更名为 **`feed_option_contracts`**；`normalize_ticker_ref_kind` 仍接受旧名；路由仍为 `massive` / `massive_high`。§2.16。 | Massive |
| 2026-04-19 Massive 股票参考 universe 任务 kind 合并更名 | `job_massive_backfill.kind`：`ticker_reference_universe` 与 `stock_reference_universe` 合并规范名为 **`feed_stocks_tickers_reference_universe`**；`normalize_ticker_ref_kind` 将两旧名映射至新名；路由仍为 `massive_stocks` / `massive_stocks_high`。§2.16。 | Massive |
| 2026-04-19 Massive ticker types 任务 kind 合并更名 | `job_massive_backfill.kind`：`ticker_reference_ticker_types` 与 `ticker_reference_instrument_types` / `stock_reference_instrument_types` 合并规范名为 **`feed_stocks_tickers_types`**；`normalize_ticker_ref_kind` 将旧名映射至新名；路由仍为 `massive_stocks` / `massive_stocks_high`。§2.14 / §2.16。 | Massive |
| 2026-04-19 Massive 股票公司行动任务 kind 更名与 API | `job_massive_backfill.kind`：公司行动同步（dividends / splits / IPOs / ticker events → `massive_corporate_action`）规范名为 **`feed_stocks_corporate_action`**；`normalize_ticker_ref_kind` 将 `corporate_action` 映射至新名；REST 使用 `GET /stocks/v1/dividends`、`GET /stocks/v1/splits`（替代已弃用的 v3 reference），并补充 `GET /v3/reference/ipos`、`GET /v3/reference/tickers/{ticker}/events`。§2.16。 | Massive |

---

*本文档与 [REQUIREMENTS.md](REQUIREMENTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md) 及运行环境需求保持一致；所有数据库相关设计与改动以本文档为唯一引用。*
