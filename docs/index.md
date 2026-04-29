# Bifrost Trader Engine

基于 Interactive Brokers 的 NVDA 21–35 DTE 近 ATM 跨式 Gamma scalping 交易守护程序。

---

## 文档索引

**文档首页即本页**。项目文档分为「核心文档」与「项目资源」两组；Agent 与协作者按任务类型到对应区块查找。

---

### 1. 核心文档

| 文档 | 说明 |
|------|------|
| **[产品需求](REQUIREMENTS.md)** | 产品功能需求（守护程序、监控、金融数据采集、策略编辑/回测/历史统计、策略应用）与环境部署约束（R-DV*） |
| **[系统架构设计](ARCHITECTURE.md)** | 全盘架构：运行环境与部署约束（§2，含 Dev/Prod 隔离 §2.8 与**调试拓扑下单 TWS、共享 Redis 行情**）、三大组成部分、**多进程 FastAPI（§4.0）**、非实时数据拉取 Worker（§2.7、§4.4）、组件划分、数据流、部署视图（§6）、需求→组件映射 |
| **[业务域设计](DOMAIN_DESIGN.md)** | 全项目域划分规范：Trading / Portfolio / Research 及支撑域的定义、边界规则、三层（UI / API / src）映射与重构优先级 |
| **[能力评估与进度](plans/CAPABILITY_TRACKING.md)** | 达成自动交易所需的各方面能力维度及当前进度，分项跟踪短板与进度；与需求对应 |

---

### 2. 项目资源

实现与调参时查阅的专项文档（数据与存储、FSM、状态空间、风险与边界）：

| 文档 | 说明 |
|------|------|
| **[数据库设计（PostgreSQL）](DATABASE.md)** | 与 PostgreSQL 交互的唯一设计说明：连接配置、表结构、写入策略、变更记录。策略实例与交易归属表结构见 §2.24.11 |
| **[FSM 状态流转](fsm/linkage.md)** | Daemon、Trading、Hedge 三状态机图示与串联说明 |
| **[状态空间](research/STATE_SPACE_MAPPING.md)** | O、D、M、L、E、S 与代码/配置的对应关系 |
| **[配置安全分类（风险模型）](research/CONFIG_SAFETY_TAXONOMY.md)** | 配置中的安全边界分类与风险维度 |
| **[Guard 微调与影响](research/GUARD_TUNING_AND_IMPACT.md)** | Guard/边界参数微调方法、后果分析、block reason 与回测验证 |
| **[组合级模型化回报与风险（R-M8）](plans/PORTFOLIO_RISK_RETURN.md)** | Model Analysis：CAR、DTE 年化、Delta、压力矩阵；与 R-M7 会计绩效分离；分阶段落地 |
| **[SEPA 股票筛选实施方案（R-A8）](plans/SEPA_IMPLEMENTATION_PLAN.md)** | SEPA 分阶段实施方案（计算、CRS、批量效率、API/UI），含每阶段目标、验收标准与风险/降级策略 |
| **[Massive API 覆盖比对（Options）](plans/massive-api-coverage.md)** | Polygon/Massive Options 官方接口与项目实现、Capability、pytest 对照；MkDocs 侧打开 HTML/CSV，监控 UI（Settings → Feed → Massive Option）内嵌同源查看器 |
| **[Massive API 覆盖比对（Stocks）](plans/massive-stocks-api-coverage.md)** | Polygon/Massive Stocks 官方接口（参考数据、K 线聚合、快照、Trades & Quotes、技术指标、WS、Flat Files）与项目实现对照；监控 UI（Settings → Feed → Massive Stock）内嵌同源查看器 |
| **[Linux SSH 部署](deploy/linux-ssh.md)** | 本机 `rsync` + 远端 venv/npm build、`bifrost_ssh.sh`（经 SSH 同步与 `systemctl`）、`deploy/systemd` 单元与首次上线顺序；可选 **`deploy/nginx`** 将 80/443 反代至 Monitor 与各域 API 端口（见 [ARCHITECTURE.md](ARCHITECTURE.md) §4.0） |

**Reference（部署初始化数据）**：**reference/init/** 目录可放置一次性 SQL 脚本；执行顺序见 [reference/init/README.md](../reference/init/README.md)。当前无必跑脚本，仅需执行 `scripts/db/db_refresh_schema.py`；Flex 默认范围由 settings.flex_default_range_days 控制。

Cursor 规则：监控页面 UI 的修改原则与 Skote 参考路径见 **.cursor/rules/monitoring-ui.mdc**。界面与代码使用英文、沟通使用中文等约定见 **.cursor/rules/language.mdc**。

---

## 项目组成与启动

项目分为 **Engine**（自动交易守护程序）、**多个 FastAPI 后端进程**（`backend/*`，监控与各业务域）、**Celery Worker**、**Frontend** 与辅助 **MkDocs / Docs API**。**运行脚本均在 `scripts/` 目录下**，从项目根目录执行。域划分与端口键见 **[ARCHITECTURE.md](ARCHITECTURE.md) §4.0**、**[DOMAIN_DESIGN.md](DOMAIN_DESIGN.md) §6.1**；合并后 YAML 中 `server` 段示例见 **`config/config.dev.yaml.example`**。

**全功能本地开发**：通常需 **Monitor** + 前端实际调用的各域 API（如 Ops、Trading、Research 等）+ **Frontend**；仅浏览状态页时可只起 Monitor。

| 组成部分 | 说明 | 运行脚本与命令（项目根目录） |
|----------|------|------------------------------|
| **Engine** | 自动交易守护程序，执行对冲、写状态与心跳；运行在**守护程序主机**（Mac Mini 或 Linux）。**目标架构**：不直连 TWS，消费 Redis（IB Ingestor / IB Account Agent）并经 **IB Operator** RPC 执行；见 [REQUIREMENTS.md](REQUIREMENTS.md) §3.6、[ARCHITECTURE.md](ARCHITECTURE.md) §2.11。 | **[scripts/systemd/run_engine.py](../scripts/systemd/run_engine.py)**：`python scripts/systemd/run_engine.py`（默认 `config/config.dev.yaml`）或 `python scripts/systemd/run_engine.py config/config.yaml` |
| **Monitor API** | 监控与控制：读 PostgreSQL，GET /status、GET /operations、POST /control/* 等；**不提供**守护进程启动。端口 **`server.port`**（未配置时 `run_server.py` 默认 **8765**）。 | **[scripts/run_server.py](../scripts/run_server.py)**：`python scripts/run_server.py` 或 `python scripts/run_server.py config/config.yaml` |
| **分域 FastAPI（按需）** | Research、Ops、Trading、Strategy、Portfolio、Market、Docs 等独立进程，代码在 **`backend/<domain>/`**。 | **`run_server_massive.py`**（Research，`server.massive_port`）、**`run_server_ops.py`**（`ops_port`）、**`run_server_trading.py`**（`trading_port`）、**`run_server_strategy.py`**（`strategy_port`）、**`run_server_portfolio.py`**（`portfolio_port`）、**`run_server_market.py`**（`market_port`）、**`run_server_docs.py`**（`docs_port`）；均为 `python scripts/<script>.py`，配置选择方式同 Monitor。 |
| **Celery Worker（可选）** | 非实时拉取（`bars`、`massive` 等队列），**Celery + Redis**；bars 任务写 **job_bars_backfill**，须 **单进程**（`--pool=solo` 或 `--concurrency=1`）以免争用 IB `client_id`。见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§4.4。 | **[scripts/systemd/run_celery.py](../scripts/systemd/run_celery.py)**：`python scripts/systemd/run_celery.py`；或直接 `celery -A src.workers.celery_app worker -l info -Q bars --pool=solo`、`celery -A src.workers.celery_app worker -l info -Q massive --pool=solo` |
| **Massive WS（可选）** | Massive（Polygon）Options WebSocket 长驻 ingest；与 IB 独立。见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.10.2。 | **[scripts/systemd/run_massive_ws.py](../scripts/systemd/run_massive_ws.py)**：`python scripts/systemd/run_massive_ws.py` 或 `python scripts/systemd/run_massive_ws.py --config config/config.yaml` |
| **Frontend** | 监控 UI；按页面调用多个后端基址（见前端 env / 代理配置）。 | **[scripts/run_frontend.sh](../scripts/run_frontend.sh)**：`./scripts/run_frontend.sh dev`（端口见 `frontend.port`，默认 5173）、`build`、`install` |
| **Docs（MkDocs）** | 文档站点。 | `python scripts/docs/fsm_build_docs.py` → `mkdocs build`；`mkdocs serve` 或 **`python scripts/run_mkdocs.py`**（默认 http://127.0.0.1:8000） |

其他常用脚本：`scripts/db/db_refresh_schema.py`、`scripts/db/db_release_dblock.py`、`scripts/check/ib/check_ib_connect.py` 等；详见 [README.md](../README.md)。
