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
| **[系统架构设计](ARCHITECTURE.md)** | 全盘架构：运行环境与部署约束（§2，含 Dev/Prod 隔离 §2.8）、三大组成部分、非实时数据拉取 Worker（§2.7、§4.4）、组件划分、数据流、部署视图（§6）、需求→组件映射 |
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
| **[策略实例页面设计](plans/STRATEGY_INSTANCE_PAGE.md)** | 策略实例独立页面（列表 + 详情）的产品与实现边界、API 依赖、与现有页面关系 |
| **[组合级模型化回报与风险（R-M8）](plans/PORTFOLIO_RISK_RETURN.md)** | Model Analysis：CAR、DTE 年化、Delta、压力矩阵；与 R-M7 会计绩效分离；分阶段落地 |
| **[Linux SSH 部署](deploy/linux-ssh.md)** | 本机 `rsync` + 远端 venv/npm build、`bifrost_ssh.sh`（经 SSH 同步与 `systemctl`）、`deploy/systemd` 单元与首次上线顺序；可选 **`deploy/nginx`** 将 80 反代至 8765 |

**Reference（部署初始化数据）**：**reference/init/** 目录可放置一次性 SQL 脚本；执行顺序见 [reference/init/README.md](../reference/init/README.md)。当前无必跑脚本，仅需执行 `db_refresh_schema.py`；Flex 默认范围由 settings.flex_default_range_days 控制。

Cursor 规则：监控页面 UI 的修改原则与 Skote 参考路径见 **.cursor/rules/monitoring-ui.mdc**。界面与代码使用英文、沟通使用中文等约定见 **.cursor/rules/language.mdc**。

---

## 项目组成与启动

项目分为 **Engine**（自动交易守护程序）、**Server**（监控与控制 API）、**Frontend**（监控前端）与辅助 **Docs**（文档站点）。**运行脚本均在 `scripts/` 目录下**，从项目根目录执行。下表为唯一运行指引。

| 组成部分 | 说明 | 运行脚本与命令（项目根目录） |
|----------|------|------------------------------|
| **Engine** | 自动交易守护程序，连接 TWS、执行对冲、写状态与心跳；运行在**守护程序主机**（Mac Mini 或 Linux）。 | **[scripts/run_engine.py](../scripts/run_engine.py)**：`python scripts/run_engine.py config/config.yaml` |
| **Server** | 监控与控制独立进程，读 PostgreSQL，提供 GET /status、GET /operations、POST /control/*；默认运行在**监控机**，端口 8765。 | **[scripts/run_server.py](../scripts/run_server.py)**：`python scripts/run_server.py` 或 `python scripts/run_server.py config/config.yaml` |
| **Bars Worker（可选）** | 非实时 K 线拉取（backfill）的独立 Worker，使用 **Celery + Redis**；任务仍写入 job_bars_backfill 表，API 入队后返回 job_id，前端轮询 GET /bars/jobs/{id}。需 Redis（config.redis）与 root `postgres` 配置。**须单进程启动**（`--concurrency=1`）以便复用同一 IB client_id。见 [ARCHITECTURE.md](ARCHITECTURE.md) §2.7、§4.4。 | **[scripts/run_celery.py](../scripts/run_celery.py)**：`python scripts/run_celery.py` 或 `celery -A servers.celery_app worker -l info -Q bars --concurrency=1`。 |
| **Frontend** | 监控 UI，调用 Server API。 | **[scripts/run_frontend.sh](../scripts/run_frontend.sh)**：`./scripts/run_frontend.sh dev`（开发，端口见 `config/config.yaml` 的 `frontend.port`，默认 5173）、`./scripts/run_frontend.sh build`（构建到 `frontend/dist`）、`./scripts/run_frontend.sh install`（仅安装依赖） |
| **Docs** | 文档站点（MkDocs）。 | 生成 FSM：`python scripts/fsm_build_docs.py` → `mkdocs build`；本地预览：`mkdocs serve` 或 `python scripts/run_docs.py`（默认 http://127.0.0.1:8000） |

其他常用脚本（均在 `scripts/` 下）：`db_refresh_schema.py`、`db_release_dblock.py`、`scripts/check/ib/check_ib_connect.py` 等；详见 [README.md](../README.md)。
