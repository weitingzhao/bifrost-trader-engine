# 数据库设计（PostgreSQL）

本文档是 **Bifrost Trader Engine** 与 PostgreSQL 交互的**唯一正式设计说明**。当前与未来所有阶段中，与数据库相关的表结构、写入策略、配置及变更均以此文档为准；各阶段执行计划、代码与文档可引用本文档的章节或表名。

**存储选型**：阶段 1 起采用 **PostgreSQL** 作为状态与操作持久化后端（不做 SQLite），需本地或 Docker 提供 PostgreSQL 实例。

---

## 1. 连接与配置

- **配置项**：在 `config/config.yaml` 的 `status` 下配置：
  - `status.sink`: `"postgres"`（阶段 1 唯一实现的 sink 类型）。
  - `status.postgres`: 连接参数，例如：
    - `host`, `port`, `database`, `user`, `password`；或
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
| symbol | text | 标的，如 NVDA |
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

- **涉及库表**：上述列所在数据库与表为：配置中的 **status 用 PostgreSQL**（`config.status.postgres` 或环境变量 `PGHOST` 等，见 [ARCHITECTURE.md](ARCHITECTURE.md) §2 运行环境）。**账户相关数据**仅存于 **accounts**、**account_positions** 表（§2.7、§2.8），status_current/status_history 不再包含 account_* 或 accounts_snapshot 列；GET /status 的 `accounts` 从这两张表组装。同一库内还有 operations、daemon_control、daemon_heartbeat、daemon_run_status 等表。

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

- **用途**：供监控服务（可运行在另一台主机，RE-5）向守护进程发送控制指令（stop/flatten），替代本地控制文件，无需共享文件系统（如 NFS）。
- **写入**：监控应用（如 status server）在 POST /control/stop、POST /control/flatten、POST /control/retry_ib（RE-7）或 **POST /control/refresh_accounts** 时 **INSERT** 一行；守护进程在每次 heartbeat 轮询并 **消费**（标记 consumed_at）后执行对应逻辑。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | bigserial | 自增主键 |
| command | text NOT NULL | 指令：`stop`、`flatten`、`retry_ib`（RE-7）或 `refresh_accounts`（请求守护进程从 IB 拉取账户/持仓并写 DB） |
| created_at | timestamptz | 创建时间（默认 now()） |
| consumed_at | timestamptz | 守护进程消费时间；NULL 表示待处理 |

- **消费语义**：守护进程 `SELECT` 一条 `consumed_at IS NULL` 且 `id` 最小的行，执行对应 command 后 `UPDATE consumed_at = now()`，避免重复触发。监控与守护进程使用同一 PostgreSQL（status.postgres），故无跨机文件依赖。
- **过期不执行**：若指令的 `created_at` 早于当前时间超过约 60 秒（如上次运行遗留的 stop），守护进程仍会**消费**该行（标记 `consumed_at`）以清空队列，但**不执行**该指令，避免新启动的守护进程误执行“上一次”的停止。

### 2.7 表 `accounts`（阶段 3.0 R-A1：多账户摘要，由 accounts_snapshot 规范化）

- **用途**：存 IB 多账户摘要，便于按账户查询、更新与后续账户操作；由守护进程在写入 snapshot 时从内存中的 accounts_snapshot 同步写入（每账户一行）。
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

- **用途**：存每个账户的持仓明细，便于按账户/标的查询与后续风控、对冲逻辑。
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

- **语义**：GET /status 的 `accounts` 从 **accounts** + **account_positions** 组装为 `[{ account_id, summary, positions }]` 形状；若表不存在或查询失败则返回空数组。GET /status 同时返回 **accounts_fetched_at**（Unix 秒，取 accounts 表 max(updated_at)），供监控页显示「数据来自 …，已过 N 分钟」。监控页「IB 账户」**刷新**按钮写入 `daemon_control` 的 **refresh_accounts**，守护进程消费后从 IB 拉取账户/持仓并写 DB，再轮询 GET /status 直至 accounts_fetched_at 更新；该区块另有 **1 小时** 自动刷新（仅读 DB 更新展示）。

### 2.10 表 `instrument_prices`（阶段 3 R-M6：持仓标的当前价）

- **用途**：按 `contract_key`（同 `account_positions`）存放**每个持仓标的的当前价**，用于监控页逐行展示「当前价」并计算浮动盈亏。设计为**与账户无关**：同一合约在多个账户持有时仅存一行价格。
- **写入**：守护进程在每次 **heartbeat** 中，根据内存中的 `accounts_snapshot`（或等效结构）按 `contract_key` 聚合出标的集合，按标的从 IB 拉取当前价（股票/期权可区分逻辑），并通过 sink `write_instrument_prices` Upsert 到本表。
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

- **读取**：`servers/reader.get_accounts_from_tables()` 在读取 `account_positions` 时 LEFT JOIN 本表，将 `mid/last` 作为 `price` 字段下发到 `accounts[*].positions[*]`，前端据此逐行展示当前价并计算浮动盈亏；若某合约暂无价格，则对应行的 `price` 为 NULL，前端显示 `—`。

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

- **用途**：集中存放与守护程序/监控相关的**可持久化设置**，单行表（id=1），避免为每类设置单独建表。当前包含 IB 连接配置（主机与端口类型），供监控页「IB 连接」区编辑；守护进程**每次启动时**从该表读取并连接 IB。后续新增设置时在此表**增加列**即可。
- **写入**：监控应用在用户点击「保存」时通过 POST /config/ib 写入 `ib_host`、`ib_port_type`；StatusReader 的 `write_ib_config(status_config, ib_host, ib_port_type)` 执行 UPDATE。
- **列**：

| 列名 | 类型 | 说明 |
|------|------|------|
| id | integer | 主键，固定为 1（单行表） |
| ib_host | text NOT NULL | 连接 IB 的主机（IP 或主机名），默认 '127.0.0.1' |
| ib_port_type | text NOT NULL | 端口类型：`tws_live`（7496）、`tws_paper`（7497）、`gateway`（4002）；默认 `tws_paper` |

- **语义**：后台将 `ib_port_type` 映射为端口号：TWS Live → 7496，TWS Paper → 7497，Gateway → 4002。守护进程启动时若 status sink 为 postgres 且该表有行，则优先使用此配置；否则使用 config 中的 `ib.host` 与 `ib.port`。修改后**需重启守护程序**生效。将来其他设置（如告警阈值、显示偏好等）可在此表新增列并写入，无需再建新表。

---

## 3. 阶段 1 写入策略

- **status_current**：每次 **heartbeat** 调用 `write_snapshot(snapshot, append_history=False)`，仅更新当前表。
- **status_history**：仅在 `append_history=True` 时追加；调用方（GsTrading）在**发生对冲相关操作**时（对冲意图、下单、成交、拒绝）传入 `append_history=True`，或可选每心跳一次。纯无操作心跳不追加历史。
- **operations**：仅在对冲意图、order_sent、fill、reject 四处插入记录。

上述策略的代码与配置说明见 [plans/phase1-execution-plan.md](plans/phase1-execution-plan.md)。

---

## 4. 依赖与本地查看（Phase 1）

- **Python 依赖**：阶段 1 使用 **psycopg2-binary** 连接 PostgreSQL，已在 `pyproject.toml` 中声明。安装环境后执行 `pip install -e .` 即可。
- **PostgreSQL 实例**：需本地或 Docker 提供 PostgreSQL；创建数据库与用户后，在 `config/config.yaml` 中配置 `status.sink: "postgres"` 与 `status.postgres`（或使用环境变量 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`）。不配置或未连接时守护程序照常运行，仅不写入状态与操作。
- **用 psql 查看**：连接后可直接查询各表，例如：
  - 当前状态：`SELECT * FROM status_current;`
  - 最近历史：`SELECT * FROM status_history ORDER BY ts DESC LIMIT 20;`
  - 操作记录：`SELECT * FROM operations ORDER BY ts DESC LIMIT 20;`
  - 控制指令（阶段 2）：`SELECT * FROM daemon_control ORDER BY id DESC LIMIT 10;`
  - 挂起/恢复状态（阶段 2）：`SELECT * FROM daemon_run_status WHERE id = 1;`
  - 守护进程心跳（阶段 2）：`SELECT * FROM daemon_heartbeat WHERE id = 1;`
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

若数据库已能连接，但 `python scripts/check/phase1.py` 报 **PostgreSQL schema (tables + columns)** 失败，说明当前库中尚未创建阶段 1/2 所需的表（或列不一致）。在项目根目录执行：

```bash
python scripts/refresh_db_schema.py
```

脚本会按 `config/config.yaml` 中 `status.postgres` 连接当前库，并创建/补齐 `status_current`、`status_history`、`operations`、`daemon_control`、`daemon_run_status`、`daemon_heartbeat`、`settings`、**accounts**、**account_positions** 等表（与 `PostgreSQLSink._ensure_tables` 一致；status_current/status_history 不含 account 相关列）。完成后再次运行 `scripts/check/phase1.py` 即可通过 schema 检查。**已有库**若之前建过 status_current 上的 account_id、account_net_liquidation、account_total_cash、account_buying_power、accounts_snapshot 列，可选择性执行 `ALTER TABLE status_current DROP COLUMN IF EXISTS account_id, DROP COLUMN IF EXISTS account_net_liquidation, ...` 等清理（不执行也可，代码已不再读写这些列）。
   或（若用 pg_ctl）：`pg_ctl reload -D /path/to/data`。

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
python scripts/release_pg_locks.py              # 列出并询问确认后终止
python scripts/release_pg_locks.py --dry-run     # 仅列出，不终止
python scripts/release_pg_locks.py --yes         # 不确认，直接终止
```

**如何避免**：

- **只保留一个写入者**：同一时间只运行 **一个** 守护进程（`run_engine.py`），不要同时跑两个会写 `daemon_heartbeat` 的进程。
- **短事务**：本仓库的 sink 已做到每次写心跳后立即 `commit()`，不长时间持锁；若自研或改代码，请勿在未提交事务中长时间持有对 `daemon_heartbeat` 的写入或显式锁。
- **锁等待超时**：PostgreSQLSink 连接后已设置 `lock_timeout = '5s'`，若 5 秒内拿不到行锁会报错并 rollback，不会无限阻塞；可根据需要调整超时或重试策略。
- **自动释放锁并重试**：若因上次守护进程异常退出导致 `daemon_heartbeat` 或 `daemon_run_status` 被锁，再次启动时若遇到 lock timeout，sink 会**自动**查询并终止持有/等待这两张表锁的其他后端（逻辑同 `scripts/release_pg_locks.py`，仅针对 `daemon_heartbeat` 与 `daemon_run_status`），然后重试连接或写入一次，无需手动执行 release 脚本。

---

## 5. 后续阶段与数据库的关联（预留）

以下为占位说明，具体表结构或字段在对应阶段实现时在本文档中补充。

- **阶段 2**：独立应用**只读** `status_current`、`operations`、`daemon_run_status`、`daemon_heartbeat`（GET /status 含 trading_suspended 与守护/对冲分开显示）；控制通道使用表 **daemon_control**（stop/flatten，见 §2.4）与 **daemon_run_status**（挂起/恢复，见 §2.5）。**daemon_heartbeat**（§2.6）由稳定守护进程写入，用于监控端区分守护进程存活与对冲程序是否在跑。启动守护程序仅在交易机执行，监控机不提供 subprocess/start。
- **阶段 3.1（历史统计）**：只读 `status_history`、`operations` 做聚合（按日/周对冲次数、盈亏等）；不新增表，仅查询。
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

---

*本文档与 [分步推进计划](PLAN_NEXT_STEPS.md)、[阶段 1 执行计划](plans/phase1-execution-plan.md) 及运行环境需求保持一致；所有数据库相关设计与改动以本文档为唯一引用。*
