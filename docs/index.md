# Bifrost Trader Engine

基于 Interactive Brokers 的 NVDA 21–35 DTE 近 ATM 跨式 Gamma scalping 交易守护程序。

---

## 文档索引

**文档首页即本页**：按「流程相关 → AI Agent 工作流 → 项目资源」组织；Agent 与协作者可按任务类型到对应区块查找文档。

---

### 1. 流程相关

| 文档 | 说明 |
|------|------|
| **[产品需求](REQUIREMENTS.md)** | 产品功能需求按五类定义（守护程序、监控、金融数据采集、策略编辑/回测/历史统计、策略应用）；R-M*/R-C*/R-H*/R-B*/R-A*；验收与 Test Case 见分步计划 |
| **[系统架构设计](ARCHITECTURE.md)** | 全盘架构：**运行环境与部署约束**（§2）、三大组成部分、组件划分、数据流、部署视图、需求→组件→阶段映射 |
| **[分步推进计划](PLAN_NEXT_STEPS.md)** | 与需求对比的阶段划分、需求与阶段对应表、每阶段验收标准与 Test Case、阶段步骤与检查方式；**稳定文档**，仅在需求或架构变更时修改 |
| **[阶段评估与下一步](plans/PHASE_ASSESSMENT.md)** | 阶段完成度评估、**当前项目进展（阶段完成状态）**、**项目里程碑时间线**、评估结论与待办；每次阶段评估时更新 |
| **分阶段执行现状** | 各阶段详细 Todo、验收清单、代码锚点：**[阶段 1](plans/phase1-execution-plan.md)** · **[阶段 2](plans/phase2-execution-plan.md)** · **[阶段 3](plans/phase3-execution-plan.md)** |

---

### 2. AI Agent 工作流

| 文档 | 说明 |
|------|------|
| **[项目运行工作流](plans/PROJECT_WORKFLOW.md)** | 稳定三角（需求/架构/分步计划）、执行→评估→负责人决策的闭环；规范 AI 与人工的更新对象与决策路径。**Agent 执行计划或评估时先读本文** |

Cursor 规则 **.cursor/rules/project-workflow.mdc** 引用上述工作流；Agent 在参与规划、执行、阶段验收或文档更新时，应遵循该规则并在本区块查找工作流说明。监控页面 UI 的修改原则与 Skote 参考路径见 **.cursor/rules/monitoring-ui.mdc**。

---

### 3. 项目资源

实现与调参时查阅的专项文档（数据与存储、FSM、状态空间、风险与边界）：

| 文档 | 说明 |
|------|------|
| **[数据库设计（PostgreSQL）](DATABASE.md)** | 与 PostgreSQL 交互的唯一设计说明：连接配置、表结构（status_current、status_history、operations、daemon_control 等）、写入策略、阶段预留与变更记录 |
| **[FSM 状态流转](fsm/linkage.md)** | Daemon、Trading、Hedge 三状态机图示与串联说明 |
| **[状态空间](STATE_SPACE_MAPPING.md)** | O、D、M、L、E、S 与代码/配置的对应关系 |
| **[配置安全分类（风险模型）](CONFIG_SAFETY_TAXONOMY.md)** | 配置中的安全边界分类与风险维度 |
| **[Guard 微调与影响](GUARD_TUNING_AND_IMPACT.md)** | Guard/边界参数微调方法、后果分析、block reason 与回测验证 |

---

## 项目组成与启动

项目分为 **Engine**（自动交易守护程序）、**Server**（监控与控制 API）、**Frontend**（监控前端）与辅助 **Docs**（文档站点）。**运行脚本均在 `scripts/` 目录下**，从项目根目录执行。下表为唯一运行指引。

| 组成部分 | 说明 | 运行脚本与命令（项目根目录） |
|----------|------|------------------------------|
| **Engine** | 自动交易守护程序，连接 TWS、执行对冲、写状态与心跳；运行在**守护程序主机**（Mac Mini 或 Linux）。 | **[scripts/run_engine.py](../scripts/run_engine.py)**：`python scripts/run_engine.py config/config.yaml` |
| **Server** | 监控与控制独立进程，读 PostgreSQL，提供 GET /status、GET /operations、POST /control/*；默认运行在**监控机**，端口 8765。 | **[scripts/run_server.py](../scripts/run_server.py)**：`python scripts/run_server.py` 或 `python scripts/run_server.py config/config.yaml` |
| **Frontend** | 监控 UI，调用 Server API。 | **[scripts/run_frontend.sh](../scripts/run_frontend.sh)**：`./scripts/run_frontend.sh dev`（开发，端口见 `config/config.yaml` 的 `frontend.port`，默认 5173）、`./scripts/run_frontend.sh build`（构建到 `frontend/dist`）、`./scripts/run_frontend.sh install`（仅安装依赖） |
| **Docs** | 文档站点（MkDocs）。 | 生成 FSM：`python scripts/build_fsm_docs.py` → `mkdocs build`；本地预览：`mkdocs serve` 或 `python scripts/run_docs.py`（默认 http://127.0.0.1:8000） |

其他常用脚本（均在 `scripts/` 下）：`refresh_db_schema.py`、`release_pg_locks.py`、`check_ib_connect.py`、`check/phase1.py` 等；详见 [README.md](../README.md) 与各阶段执行计划。
