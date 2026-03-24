# Option 数据 Feed 落地架构与实施计划

期权 Massive（Polygon）数据 Feed 的**落地架构设计、研究结论与分项实施计划**。目标：建立业界通用水平的期权数据采集、存储与更新体系，支撑 **Option Discovery**、**合约实时监控**、**Max Pain 报表** 等数据挖掘产品。

**对应需求**：R-A6（外部研究数据源）、R-OD1（期权发现）。  
**对应架构**：[ARCHITECTURE.md](../../ARCHITECTURE.md) §2.10（Massive / Polygon）。  
**对应库表**：[DATABASE.md](../../DATABASE.md) §2.16（option_contracts、option_snapshots、option_open_interest_daily、option_trades、job_massive_backfill 等）。

---

## 文档清单

| 序号 | 文档 | 内容 |
|------|------|------|
| 0 | **本文 README.md** | 索引、阅读顺序、分阶段里程碑、与现有文档的关系 |
| 1 | [ARCHITECTURE_AND_RESEARCH.md](ARCHITECTURE_AND_RESEARCH.md) | 落地架构与研究：Bronze/Silver/Serving 分层、REST 与 WS 分工、对账与保留、IB 隔离边界、mermaid 全景图 |
| 2 | [DATABASE_PLAN.md](DATABASE_PLAN.md) | 数据库升级扩展：分区与保留策略、原始事件层、Max Pain 派生表、迁移与回滚 |
| 3 | [WEBSOCKET_PLAN.md](WEBSOCKET_PLAN.md) | WebSocket 落地：长驻 ingest 进程、Redis key 约定、重连与 gap-fill、监控指标 |
| 4 | [WORKER_PLAN.md](WORKER_PLAN.md) | Worker 扩展升级：队列隔离、cron 调度（日终 OI、对账）、任务去重、退避策略 |
| 5 | [FASTAPI_PLAN.md](FASTAPI_PLAN.md) | FastAPI 扩展：读路径缓存、job 合并、新增路由（SSE/WS 转发、对账 API）、健康检查 |
| 6 | [UI_CHECKLIST_AND_BACKFILL.md](UI_CHECKLIST_AND_BACKFILL.md) | UI 日粒度 Checklist、完成度展示、数据补全触发与 job 状态 |
| 7 | [MAX_PAIN_REPORT.md](MAX_PAIN_REPORT.md) | Max Pain 报表设计：输入假设、计算口径、表/API 形状、免责声明 |

---

## 推荐阅读顺序

1. **ARCHITECTURE_AND_RESEARCH** — 理解全景分层和隔离边界，是其余 6 份计划的理论依据。
2. **DATABASE_PLAN** — 存储是基础；所有采集/更新/报表都依赖表结构。
3. **WORKER_PLAN** — REST 采集与调度是最成熟的路径，优先完善。
4. **WEBSOCKET_PLAN** — 热层补全，与 Worker 互补。
5. **FASTAPI_PLAN** — 读路径优化，衔接 Worker/WS 与 UI。
6. **UI_CHECKLIST_AND_BACKFILL** + **MAX_PAIN_REPORT** — 产品层，依赖前置基础就绪。

---

## 分阶段里程碑

### P1：库表与幂等基础（优先）

- `option_snapshots` 保留策略与可选分区方案评估
- `job_massive_backfill` 任务去重（同 payload pending 合并）
- Max Pain 派生表 / 物化视图 DDL 设计
- 迁移脚本纳入 `db_refresh_schema.py` 工作流

### P2：Worker 调度与对账

- cron 调度框架（Celery Beat 或 APScheduler）：日终 OI、corporate action 定时拉取
- 交互 snapshot 与 bulk backfill 队列优先级隔离
- 日级对账任务（供应商摘要 vs 本地计数）

### P3：WebSocket 热层

- 长驻 ingest 进程（`scripts/run_massive_ws.py`）：Massive WS → Redis 最新态
- REST gap-fill：断线重连后补缺区间
- 分钟级抽样落 PG + EOD REST 校准

### P4：API 缓存与产品报表

- 读路径 stale-while-revalidate / 短 TTL Redis 缓存
- SSE / WS 推前端（contract_key 级订阅）
- UI 日粒度 Checklist 与数据补全入口
- Max Pain 报表 API 与前端

---

## 与现有文档关系

- 本套件**不修改** [REQUIREMENTS.md](../../REQUIREMENTS.md) 需求条文——仅在各计划中注明「对应 R-A6 / R-OD1」做追溯。
- 本套件**不重复** [ARCHITECTURE.md](../../ARCHITECTURE.md) §2.10 已有内容——而是在更细粒度上展开落地方案。§2.10 末尾有指向本目录的导航链接。
- [CAPABILITY_TRACKING.md](../CAPABILITY_TRACKING.md) 能力 23 末尾指向本文件，便于从进度视图跳转。
