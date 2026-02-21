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
- **写入**：由守护程序在**每次 heartbeat** 时 upsert（或 replace）一行；列与 snapshot 字典一致。
- **列**（与 R-M1a 一致）：

| 列名 | 类型 | 说明 |
|------|------|------|
| daemon_state | text | DaemonFSM 状态，如 RUNNING |
| trading_state | text | TradingFSM 状态，如 MONITOR |
| symbol | text | 标的，如 NVDA |
| spot | double precision | 当前标的价格 |
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

- **主键/唯一**：单行表可无主键，或使用固定行 id（如 `id SERIAL PRIMARY KEY`），upsert 时更新该行。

### 2.2 表 `status_history`（状态历史）

- **用途**：按时间序保留状态快照，供阶段 3.1 历史统计与后续分析；R-H1 要求“当前 + 历史”同一 sink。
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
- **用 psql 查看**：连接后可直接查询三张表，例如：
  - 当前状态：`SELECT * FROM status_current;`
  - 最近历史：`SELECT * FROM status_history ORDER BY ts DESC LIMIT 20;`
  - 操作记录：`SELECT * FROM operations ORDER BY ts DESC LIMIT 20;`

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

若数据库已能连接，但 `python scripts/check/phase1.py` 报 **PostgreSQL schema (tables + columns)** 失败，说明当前库中尚未创建阶段 1 所需的三张表（或列不一致）。在项目根目录执行：

```bash
python scripts/init_phase1_db.py
```

脚本会按 `config/config.yaml` 中 `status.postgres` 连接当前库，并创建/校验 `status_current`、`status_history`、`operations` 三张表（与 `PostgreSQLSink` 使用的 DDL 一致）。完成后再次运行 `scripts/check/phase1.py` 即可通过 schema 检查。
   或（若用 pg_ctl）：`pg_ctl reload -D /path/to/data`。

4. **仍连不上时**：确认服务器防火墙放行 5432、且 config 里 `host`/`port`/`database`/`user`/`password` 与服务器实际一致。

---

## 5. 后续阶段与数据库的关联（预留）

以下为占位说明，具体表结构或字段在对应阶段实现时在本文档中补充。

- **阶段 2**：独立应用**只读** `status_current`、`operations`（GET /status、GET /operations）；若自检结果（self_check、status_lamp）由守护程序写入，可能增加列或单独表，届时在本文档 §5 增加。
- **阶段 3.1（历史统计）**：只读 `status_history`、`operations` 做聚合（按日/周对冲次数、盈亏等）；不新增表，仅查询。
- **阶段 3.5（回测）**：若回测结果需要落库，可新增 schema 或表（如 `backtest_runs`、`backtest_ticks`），在本文档 §6 增加。
- **其他**：控制指令、告警、用户配置等若未来落库，均在本文档中新增章节并注明引入阶段。

---

## 6. 变更记录

| 日期 | 变更内容 | 引入阶段 |
|------|----------|----------|
| （初版） | 新增 §1–§4：连接配置、阶段 1 三表（status_current、status_history、operations）、写入策略；§5 后续阶段预留。 | 阶段 1 |
| 阶段 1 落地 | 新增 §4：依赖（psycopg2-binary）、配置说明、psql 查看示例；§5/§6 章节号顺延。 | 阶段 1 |

---

*本文档与 [分步推进计划](PLAN_NEXT_STEPS.md)、[阶段 1 执行计划](plans/phase1-execution-plan.md) 及运行环境需求保持一致；所有数据库相关设计与改动以本文档为唯一引用。*
