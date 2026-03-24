# 数据库升级扩展计划

期权 Massive Feed 的 PostgreSQL 表结构升级方案。基于现有 [DATABASE.md](../../DATABASE.md) §2.16 表定义，补全分区/保留策略、Gold 层派生表、迁移流程。

**前置阅读**：[ARCHITECTURE_AND_RESEARCH.md](ARCHITECTURE_AND_RESEARCH.md) §1（三层模型）。  
**索引**：[README.md](README.md)。

---

## 1. 现有表盘点

| 表名 | 层次 | 说明 | 增长预估 |
|------|------|------|----------|
| `option_contracts` | Silver 维表 | 合约定义，按 `contract_key` UNIQUE | 低增长（千级/标的） |
| `option_snapshots` | Silver 事实 | 每次快照一行，`(contract_key, snapshot_ts DESC)` | **高增长**——每次 Discovery Load 写 100–250 行 |
| `option_open_interest_daily` | Silver 事实 | EOD OI by (contract_key, trade_date, source) | 日级增长，可控 |
| `option_trades` | Silver 事实 | 逐笔成交（Developer 预留） | 极高增长（开启后） |
| `option_day` / `option_min` | Silver 事实 | K 线 | 与回填范围线性 |
| `job_massive_backfill` | 运维 | 任务队列 | 低增长，文档建议 trim 200 |
| `massive_corporate_action` | Silver 缓存 | 公司行动 | 低增长 |

---

## 2. 升级项

### 2.1 `option_snapshots` 保留策略

**问题**：当前每次写入 INSERT 新行，无自动清理；随 Discovery 使用频率增长，数据量膨胀。

**方案选项**（待项目 owner 决策）：

| 方案 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| **A. 时间分区（推荐）** | `PARTITION BY RANGE (snapshot_ts)`，按月或按周建分区；旧分区 `DETACH` + 归档或 `DROP` | 查询自动裁剪、管理粒度清晰 | 需维护分区创建脚本 |
| **B. 定时 DELETE** | cron 删除 > N 天的行 | 简单 | 大表 DELETE 锁与 vacuum 成本 |
| **C. 保留 latest 视图** | 物化视图 `option_snapshots_latest`（`DISTINCT ON contract_key`），历史进冷表 | 热路径极快 | 需定期 REFRESH |

**已实施 A + C 组合**：`option_snapshots` 已迁移为 `PARTITION BY RANGE (snapshot_ts)` 按月分区 + 物化视图 `option_snapshots_latest`。

### 2.2 可选 Raw 层：`option_snapshot_raw`

**Owner 决策**：当前阶段不建。今后如需审计或重放再议。

### 2.3 Max Pain 派生表：`report_option_max_pain_daily`

| 列 | 类型 | 说明 |
|----|------|------|
| report_option_max_pain_daily_id | bigserial | PK |
| symbol | text NOT NULL | 标的 |
| expiry | text NOT NULL | 到期 |
| trade_date | date NOT NULL | OI 截止日 |
| max_pain_strike | double precision NOT NULL | Max Pain 行权价 |
| underlying_close | double precision | 标的收盘价 |
| total_oi | integer | 该到期日 OI 合计 |
| computation_detail | jsonb | 各 strike 的 pain value（可选，便于前端 drill-down） |
| source | text NOT NULL DEFAULT 'massive' | 数据来源 |
| created_at | timestamptz | 写入时间 |

- **唯一约束**：`UNIQUE(symbol, expiry, trade_date, source)`。
- **索引**：`(symbol, trade_date DESC)`、`(symbol, expiry, trade_date DESC)`。
- **写入**：日批 Worker 在 OI 拉取后计算并 UPSERT。

### 2.4 物化视图：`option_snapshots_latest`（可选）

```sql
CREATE MATERIALIZED VIEW option_snapshots_latest AS
SELECT DISTINCT ON (contract_key)
    contract_key, snapshot_ts, last, bid, ask, mid,
    iv, delta, gamma, theta, vega, open_interest, underlying_price, source
FROM option_snapshots
ORDER BY contract_key, snapshot_ts DESC;

CREATE UNIQUE INDEX ON option_snapshots_latest (contract_key);
```

定期 `REFRESH MATERIALIZED VIEW CONCURRENTLY option_snapshots_latest;`（Worker 或 cron 触发）。

### 2.5 `job_massive_backfill` 去重字段

新增可选列 `payload_hash`（text, SHA256 of canonical payload JSON），加 UNIQUE 或 partial index `WHERE status IN ('pending','running')`，实现同 payload 任务防重。

---

## 3. 迁移流程

- 所有 DDL 变更通过 `scripts/db_refresh_schema.py` 管理——该脚本检测表是否存在并做增量 ALTER/CREATE。
- 新增表（`max_pain_daily`）、新增列（`payload_hash`）均为 additive，无需 DROP 现有表；迁移可在 Prod 低峰执行。
- 分区改造需评估现有 `option_snapshots` 数据量——若已有百万行以上，建议先建新分区表 `option_snapshots_v2` 并批量迁移，再 rename swap。
- **回滚**：所有新增表/列/视图均可 `DROP` 回退，不影响现有功能。

---

## 4. 决策记录（已锁定）

| 编号 | 问题 | 决策 |
|------|------|------|
| DB-1 | `option_snapshots` 分区键 | **`snapshot_ts`**（RANGE 按月分区） |
| DB-2 | 历史保留天数 | **90 天热数据** + 旧分区 DETACH 归档 |
| DB-3 | 是否建 raw 层 | **当前不建**（`option_snapshot_raw`），今后再议 |
| DB-4 | `computation_detail` JSONB | **需要**——支持前端 Max Pain drill-down |
| 2.1 | 保留策略方案 | **A + C**：时间分区 + 物化视图 `option_snapshots_latest` |
| 2.2 | Bronze raw 层 | **不建** |
| 2.3 | Max Pain 表名 | **`report_option_max_pain_daily`** |
| 2.5 | Job 去重 | `payload_hash` + 部分唯一索引 |
