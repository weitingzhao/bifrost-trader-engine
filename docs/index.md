# Bifrost Trader Engine

基于 Interactive Brokers 的 NVDA 21–35 DTE 近 ATM 跨式 Gamma scalping 交易守护程序。

## 文档索引

- **[系统架构设计](ARCHITECTURE.md)** – 全盘架构：三大组成部分、组件划分、数据流、部署视图、需求→组件→阶段映射（基于产品需求与分步计划）
- **[运行环境与需求](RUN_ENVIRONMENT_AND_REQUIREMENTS.md)** – 引擎如何运行、TWS/账户、部署（Mac vs Linux）、监控/控制设计；**产品需求分类**（RE-*/R-M*/R-C*/R-H*/R-B*）与分步计划阶段对应（运行与 Cursor Agent 的唯一定义）
- **[分步推进计划](PLAN_NEXT_STEPS.md)** – 当前进展与需求差距、分阶段计划（状态 sink、独立监控应用、历史与回测）、每阶段里程碑与验收标准
- **[数据库设计（PostgreSQL）](DATABASE.md)** – 与 PostgreSQL 交互的唯一设计说明：连接配置、表结构（status_current、status_history、operations）、写入策略、后续阶段预留与变更记录；所有阶段数据库相关设计与改动均引用本文档
- **[FSM](fsm/linkage.md)** – 状态机图示与串联说明（Daemon、Trading、Hedge）
- **[状态空间](STATE_SPACE_MAPPING.md)** – O、D、M、L、E、S 与代码/配置的对应关系
- **[配置安全分类](CONFIG_SAFETY_TAXONOMY.md)** – 配置中的安全边界分类
- **[Guard 微调与影响](GUARD_TUNING_AND_IMPACT.md)** – 安全 Guard 与边界的微调方法及后果分析（热重载、block reason 日志等）

### 计划与执行

- **[阶段评估与下一步](plans/PHASE_ASSESSMENT.md)** – 基于分步计划的阶段完成度评估、阶段 1/2 实现说明与建议下一步
- **[阶段 1 执行计划](plans/phase1-execution-plan.md)** – 阶段 1 详细 Todo、检查方式与 Test Case 清单
- **[阶段 2 执行计划](plans/phase2-execution-plan.md)** – 阶段 2 实现说明、验收清单与执行说明

## 构建文档

在**项目根目录**（存在 `mkdocs.yml` 的目录）下执行：

```bash
# 从源码生成 FSM 相关 Markdown
python scripts/build_fsm_docs.py

# 构建 MkDocs 站点
mkdocs build

# 本地预览（在项目根目录）
mkdocs serve
```
