# 业务域设计 (Domain Design)

> **文档定位：** 本文档定义项目各业务域的边界与职责，是 UI、Backend API、src 源码三层重构的统一指导规范。
> **优先级：** 高于具体实现决策，低于 REQUIREMENTS.md 中的产品功能需求。
> **维护原则：** 任何涉及新增域或调整域边界的决策，须先更新本文档并经审阅确认。

---

## 一、核心判断标准：三个问题

在划分任何功能、模块、页面、API 端点的归属时，用以下三个问题来判断：

| 问题 | 对应域 |
|------|--------|
| **「我做了什么动作？」**（历史成交事实） | Trading |
| **「我现在持有什么？风险敞口如何？」**（当前持仓状态） | Portfolio |
| **「市场里有什么？」**（与持仓无关的市场结构分析） | Research |

---

## 二、全域总览

本项目共划分 **7 个业务域**：

```
┌─────────────────────────────────────────────────────────┐
│                    应用全域总览                           │
│                                                          │
│  核心交易三域                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Trading  │  │Portfolio │  │ Research │               │
│  │ 执行域   │  │  组合域  │  │  研究域  │               │
│  └──────────┘  └──────────┘  └──────────┘               │
│                                                          │
│  支撑域                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Strategy │  │  Market  │  │ Monitor  │  │  Ops   │  │
│  │ 策略域   │  │  行情域  │  │  监控域  │  │ 运维域 │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 三、核心交易三域详细定义

### 3.1 Trading 域（执行域）

**一句话定义：** 记录和查询「我做了什么交易动作」的历史事实。

**分析对象：** 历史成交记录（已发生、不可改变的事实）
**时态：** 过去时
**行业对应：** OMS（Order Management System）/ Execution Management

#### 职责边界

| 属于 Trading 的 | 不属于 Trading 的 |
|----------------|-----------------|
| 成交记录 CRUD（account_executions） | 当前持仓快照（→ Portfolio） |
| 从 IB/Flex 同步成交数据 | 实时 Greeks 计算（→ Portfolio） |
| 资金流水（cash transactions） | 期权链 OI 分析（→ Research） |
| 基于成交的 Realized PnL 统计 | 策略模板/结构定义（→ Strategy） |
| 成交记录的策略归因标注 | 市场行情订阅（→ Market） |
| IB commission 回报处理 | |

#### 关键判断规则
- **归因（Attribution）** 属于 Trading：它是对历史成交记录打标签，不是在管理当前持仓。
- **Realized PnL** 属于 Trading；**当前持仓的 Unrealized PnL 及组合层面绩效归因** 属于 Portfolio。
- 资金流水（Transfer & Pay）属于 Trading：它是账户层面的现金成交事实。

---

### 3.2 Portfolio 域（组合域）

**一句话定义：** 描述「我现在持有什么、风险状态如何」的当前快照与分析。

**分析对象：** 我自己的持仓（必须依赖 account_id）
**时态：** 当下（实时或准实时）
**行业对应：** PMS（Portfolio Management System）/ RMS（Risk Management System）

#### 职责边界

| 属于 Portfolio 的 | 不属于 Portfolio 的 |
|------------------|-------------------|
| 当前持仓列表（positions） | 历史成交流水（→ Trading） |
| 账户信息与资产快照 | 无持仓依赖的市场分析（→ Research） |
| 组合 Greeks（Delta/Gamma/Theta/Vega 汇总） | 策略实例生命周期管理（→ Strategy） |
| Payoff 曲线与压力测试 | 行情实时订阅（→ Market） |
| 持仓分类管理（position categories） | |
| 账户层面组合模型分析（model-analysis） | |

#### 关键判断规则
- **「这个分析需要 account_id 作为输入」** 通常是 Portfolio 的强信号。
- `portfolio_model.py`（`/portfolio/model-analysis`）属于 Portfolio：它计算的是「你账户内的」payoff 和 Greeks，不是市场整体结构。
- 持仓分类（`/position-categories`）属于 Portfolio：它是对「你持有的仓位」的管理工具。

---

### 3.3 Research 域（研究域）

**一句话定义：** 分析「市场里有什么结构和机会」，与是否持仓无关。

**分析对象：** 市场本身（OI、期权链、波动率结构、历史 Bars 等）
**时态：** 历史 + 现在（分析视角）
**行业对应：** Alpha Research Platform / Quant Research

#### 职责边界

| 属于 Research 的 | 不属于 Research 的 |
|-----------------|------------------|
| Max Pain 计算（基于市场 OI） | 对我持仓的分析（→ Portfolio） |
| 期权链发现与分析（Option Discovery） | 历史成交记录（→ Trading） |
| IV 期限结构分析 | 实时下单（→ Daemon/Engine） |
| 历史 Bars 数据管理与覆盖 | 策略模板配置（→ Strategy） |
| Massive/Polygon 数据集成 | |
| 回测（Backtest） | |
| 股票/期权数据覆盖度检查 | |

#### 关键判断规则
- **「这个分析不需要知道我是否持仓」** 是 Research 的判断标准。
- `reports.py` 的 Max Pain 端点属于 Research：任何人查任何标的都可以，与账户无关。
- Massive 数据集成属于 Research：它是外部市场数据源，供研究使用。

---

## 四、支撑域定义

### 4.1 Strategy 域（策略域）

**定义：** 管理策略的生命周期配置——从抽象模板到具体实例。不执行交易，不分析持仓，只定义「应该怎么做」的规则体系。

**行业对应：** Strategy Configuration / Alpha Strategy Lifecycle Management

| 归属内容 |
|---------|
| 策略模板（Templates）：腿结构、参数定义 |
| 策略结构（Structures）：具体期权腿组合 |
| 策略机会（Opportunities）：标的 + 结构的绑定 |
| 策略实例（Instances）：某次实际开仓的生命周期 |
| 资金分配（Allocations）：多机会的资金比例规则 |
| 安全门控（Gate Safety）：风控参数配置集合 |

### 4.2 Market 域（行情域）

**定义：** 实时行情的接入、订阅与分发。是数据管道，不做业务判断。

| 归属内容 |
|---------|
| 实时报价订阅（Redis-backed quotes） |
| 市场数据读取（index data, IB market data） |
| Watchlist 管理（要监控哪些标的） |
| Market Streams 实时看板 |

### 4.3 Monitor 域（监控域）

**定义：** 系统自身的运行状态监控与 Daemon 控制。不涉及业务数据分析。

| 归属内容 |
|---------|
| Daemon 状态查询与控制（start/stop/suspend） |
| 系统健康检查（health check, self check） |
| 运行日志流式查看 |
| API 服务状态总览 |

### 4.4 Ops 域（运维域）

**定义：** 后台任务（Celery）的调度、监控与管理。

| 归属内容 |
|---------|
| Celery worker 状态与扩缩容 |
| Bars 数据回填任务队列管理 |
| 任务执行历史与 audit log |

---

## 五、域间边界规则汇总

### 5.1 Trading ↔ Portfolio 边界

```
Trading                          Portfolio
──────────────────────────────────────────────────────
成交发生（fill）      →  聚合为持仓净值（net position）
Realized PnL         →  Unrealized PnL + 组合层面绩效
策略归因标注         →  策略实例持仓视图

判断规则：
  数据写入在 Trading，组合聚合查询在 Portfolio
  有 execution_id 的操作 → Trading
  有 position_snapshot 的操作 → Portfolio
```

### 5.2 Portfolio ↔ Research 边界

```
Portfolio                        Research
──────────────────────────────────────────────────────
分析「我的」持仓      vs  分析「市场的」结构
需要 account_id       vs  不需要 account_id
Payoff（我的组合）    vs  Max Pain（全市场 OI）
持仓压力测试          vs  IV 期限结构（市场层面）

判断规则：
  是否依赖 account_id：是 → Portfolio，否 → Research
```

### 5.3 Strategy ↔ Trading 边界

```
Strategy                         Trading
──────────────────────────────────────────────────────
定义「应该怎么做」    vs  记录「已经做了什么」
策略实例（开仓记录）  vs  成交执行（fill 记录）
Gate Safety 配置      vs  ExecutionGuard 运行时检查

判断规则：
  配置/定义 → Strategy
  历史事实 → Trading
```

---

## 六、三层架构映射

### 6.1 Backend FastAPI 域映射

各域为**独立 FastAPI 应用**（`backend/<domain>/app.py`），由 **`scripts/run_server*.py`** 启动；端口键在合并后的 YAML **`server`** 段，示例默认值见 **`config/config.dev.yaml.example`** / **`config/config.yaml.example`**。总览亦见 **[ARCHITECTURE.md](ARCHITECTURE.md) §4.0**。

| 域 | FastAPI 包 | 配置端口键 | 启动脚本 | 示例默认端口 |
|----|------------|------------|----------|--------------|
| Monitor | `backend/monitor/` | `server.port` | `scripts/run_server.py` | 8765（代码默认，可 YAML 覆盖） |
| Research | `backend/research/` | `server.massive_port` | `scripts/run_server_massive.py` | 8766 |
| Docs | `backend/docs/` | `server.docs_port` | `scripts/run_server_docs.py` | 8767 |
| Ops | `backend/ops/` | `server.ops_port` | `scripts/run_server_ops.py` | 8768 |
| Trading | `backend/trading/` | `server.trading_port` | `scripts/run_server_trading.py` | 8769 |
| Strategy | `backend/strategy/` | `server.strategy_port` | `scripts/run_server_strategy.py` | 8770 |
| Portfolio | `backend/portfolio/` | `server.portfolio_port` | `scripts/run_server_portfolio.py` | 8771 |
| Market | `backend/market/` | `server.market_port` | `scripts/run_server_market.py` | 8772 |

**`backend/massive/`**：Polygon/Massive 相关能力（任务、SSE 等）可作为**库**被 Research 或其它进程引用，**不一定**单独占用 HTTP 端口。

**路由归属**：原单体 `monitor` 下的 `executions`、`strategies`、`portfolio_model`、`market`、`quotes`、`watchlist`、`research` 等已按上表迁入对应包；系统级配置（IB、Flex、active-strategy）等仍多在 **Monitor**。**具体路径以各 `backend/*/routers/` 为准**。

### 6.2 src/ 源码域映射

| src 子目录 | 归属域 | 说明 |
|-----------|--------|------|
| `src/daemon/` | Monitor（运行时） | Daemon 核心逻辑，不归属业务域 |
| `src/connector/` | 基础设施 | IB 连接器，被多域共用 |
| `src/persistence/` | 基础设施 | 数据持久层，被多域共用 |
| `src/portfolio/` | Portfolio + Trading | positions/model → Portfolio；reader/executions → Trading |
| `src/monitor/reader/` | Trading + Portfolio + Strategy | 按 reader 模块细分 |
| `src/monitor/services/` | Strategy | strategy_parsing, option_strategy_templates |
| `src/monitor/integrations/` | Market + Portfolio | ib_clients → Market；index_data → Market |
| `src/bars/` | Research（数据）+ Ops（任务） | Bars 历史回填与任务实现（`backfill.py`、`tasks.py`） |
| `src/core/sse/` | 基础设施 | SSE 队列工具（如 `queue_utils.py`） |
| `src/vendor/massive/` | Research | Polygon 数据源 |

### 6.3 Frontend 页面域映射

| 页面 | 当前文件 | 归属域 |
|------|---------|--------|
| Live（实时行情看板） | `LivePage.tsx` | Market |
| Market Data | `MarketDataPage.tsx` | Market |
| Watchlist | `WatchlistPage.tsx` | Market |
| Positions（当前持仓） | `PositionsPage.tsx` | Portfolio |
| Accounts | `AccountsPage.tsx` | Portfolio |
| Model Analysis | `ModelAnalysisPage.tsx` | Portfolio |
| Research Risk Analysis | `ResearchRiskAnalysisPage.tsx` | Portfolio（分析我的组合风险） |
| Trade History | `TradeHistoryPage.tsx` | Trading |
| Performance | `PerformancePage.tsx` | Trading |
| Transfer & Pay | `TransferPayPage.tsx` | Trading |
| Option Discovery | `OptionDiscoveryPage.tsx` | Research |
| Backtest | `BacktestPage.tsx` | Research |
| Stock/Option Coverage | `StockCoveragePage/OptionCoveragePage.tsx` | Research |
| Feed Massive | `FeedMassiveOptionPage.tsx` | Research |
| Strategy Structure | `StrategyStructurePage.tsx` | Strategy |
| Strategy Opportunity | `StrategyOpportunityPage.tsx` | Strategy |
| Strategy Instances | `StrategyInstancesPage.tsx` | Strategy（**子视图**，非独立产品文档；与 Structure / Opportunity 等同组） |
| Strategy Allocation | `StrategyAllocationPage.tsx` | Strategy |
| Gates Config | `GatesConfigPage.tsx` | Strategy |
| Daemon Status | `DaemonStatusPage.tsx` | Monitor |
| Status | `StatusPage.tsx` | Monitor |
| Server/API Status | `ServerStatusPage.tsx` 等 | Monitor |
| Celery | `CeleryPage.tsx` | Ops |
| Data（Bars管理） | `DataPage.tsx` | Ops（数据运维）|
| Settings | `SettingsPage.tsx` | Config（横切关注点） |

---

## 七、重构优先级建议

### 阶段一（基础清理）：servers/ → src/

**已完成**：历史 `servers/` 下 bars、SSE、reader、portfolio_model 等已迁入 **`src/bars/`**、**`src/core/sse/`**、**`src/monitor/reader/`**、**`src/portfolio/model/`** 等；HTTP 入口迁至 **`backend/*`**，Celery 应用为 **`backend.workers.celery_app`**。

### 阶段二（backend 域拆分）

**已落地**：各业务域 FastAPI 应用与 `run_server_*.py` 已按 §6.1 就位；后续仅为**持续收敛**（路由微调、文档与 OpenAPI 合并、运维模板）。

### 阶段三（src 重组）：按域重整 src/ 内部结构

**可选 / 进行中**：在 backend 稳定后，可将 `src/monitor/reader/` 中的读取模块进一步按域归类，减轻 monitor reader 体量：

```
src/monitor/reader/ 中的模块按域归类：
  strategy_*.py, template_config_*.py  →  src/strategy/reader/
  executions.py, performance.py        →  src/trading/reader/
  portfolio相关                         →  src/portfolio/reader/（已有）
  market.py, status.py, common.py      →  src/monitor/reader/（保留）
```

---

## 八、未来扩展的域边界预留

随着项目演进，以下功能的域归属预判：

| 未来功能 | 归属域 | 理由 |
|---------|--------|------|
| 自动止损/止盈规则 | Strategy | 属于「应该怎么做」的配置 |
| 期权到期处理流程 | Trading | 到期是一种执行事实 |
| 跨账户组合分析 | Portfolio | 分析「我们持有的」 |
| 波动率曲面建模 | Research | 市场结构分析 |
| 实时 PnL 推送 | Portfolio | 当前持仓状态的实时反映 |
| A股交易接入 | Trading + Market | 成交归 Trading，行情归 Market |

---

*本文档创建于 2026-03-27，基于对 Trading / Portfolio / Research 域边界的深度讨论。*
