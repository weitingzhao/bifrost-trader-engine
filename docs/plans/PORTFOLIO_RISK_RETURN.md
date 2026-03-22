# 组合级策略回报与风险敞口（Model Analysis）

本文档为 **R-M8** 的专项产品规格，供前端/全栈按阶段落地。需求总述见 [REQUIREMENTS.md](../REQUIREMENTS.md) §2.6（R-M8）。

---

## 1. 目的与定位

- **目的**：在**明确模型假设**下，基于**当前真实持仓**与**账户摘要**（来自 IB），向操作者提供组合级 **Model Analysis**——理论盈亏边界、资本效率（Capital at risk）、方向敞口（Delta）、以及压力情景下的近似 P&amp;L；与 **R-M7** 中的会计绩效（Realized / Unrealized）**严格区分**。
- **非目标**：不提供投资建议、不自动推荐开仓、不输出无公式支撑的「收益区间」文案；**V1 不包含**假设加仓或策略生成器。

---

## 2. 与 R-M7（REAL PERFORMANCE）的边界

| 类型 | 含义 | 数据来源 |
|------|------|----------|
| **REAL** | 已实现 / 未实现盈亏、资金流、Performance 口径 | 成交、持仓市值、Transactions 等（R-M7） |
| **MODEL** | 假设情景、到期 payoff、希腊值、压力矩阵 | 模型 + 行情/IV + 持仓快照 |

**UI（英文）**：

- **REAL PERFORMANCE** 区块：沿用现有 Performance / 复盘展示。
- **MODEL ANALYSIS** 区块：独立视觉层级（建议区分背景色/标题），带 **warning 图标**，hover 或折叠展示 Disclaimer；**禁止**与 Real P&amp;L 混在同一汇总数字中。

**固定 Disclaimer（V1 必选，可微调用词）**：

```text
This analysis is hypothetical and based on model assumptions.
It does not represent actual performance and is not investment advice.
Options involve risk and may result in substantial losses.
```

Disclaimer 须在 Model 区域内**固定展示、不可完全隐藏**（允许折叠为短条，但需保留可见入口）。

---

## 3. 范围与账户模型

### 3.1 V1（锁死）

- **计算单元**：**单个选中的 IB Account** 下的**当前全 book**（股票 + 期权），与 Portfolio/Accounts 的**账户切换器**一致。
- **展开维度**：
  - **Portfolio（账户）** 级汇总；
  - **按 underlying** drill-down；
  - **按 position / 腿** 展开（与持仓表一致）。

### 3.2 与 R-A4（双账户、统一 Portfolio）

- **统一 Portfolio 展示**（两账户列表、切换）仍由 R-A4 / 现有页面满足。
- **R-M8 V1**：模型分析**每次仅针对当前选中账户**；**不对多账户合并**出单一模型指标（避免 IB 同步与时序问题）。
- **V2（可选）**：多账户合并的 Model 汇总（需单独定义合并规则与验收）。

### 3.3 「策略」含义（V1）

- **仅当前真实持仓**：归因、payoff、风险；**无** hypothetical 新开仓。
- **V1.5（可选）**：「假设策略卡片」——不改变 portfolio 快照，独立沙盒（若做需防与实盘混淆）。

---

## 4. 回报与资本：定义

### 4.1 时间维度（V1）

- **年化口径**：**按 DTE 的简单年化**（与日历月、252 交易日区分；V1 不采用日历月为主指标）。
- **公式（单情景、单资本分母）**：

\[
R_{\text{annual}} = \frac{\text{Profit}}{\text{Capital at risk}} \times \frac{365}{\text{DTE}}
\]

其中 **DTE** 为**自然日**距相关到期日的天数（与实现统一取整规则，例如 `ceil` 或 `floor`，并在 API 返回 `dte_days`）。

### 4.2 多到期、多标的（必须写死规则）

全账户存在**多个到期日、多个 underlying** 时：

- **账户级汇总**：不强制单一 DTE；采用 **按 underlying 分组**：
  - 每个 underlying 使用其**最远涉及到期**（或实现时选「最近重大到期」——须在实现说明中固定一种）计算该组的 **DTE** 与 payoff 边界；**账户级年化**可为各组指标的**展示列表**或**加权汇总**（权重默认：按该 underlying 的 **Capital at risk** 占全账户 CAR 比例）。
- **推荐默认（V1）**：**按 underlying 展示**一行「Max profit / Max loss / CAR / Annualized（该组 DTE）」；账户级给 **聚合 CAR** 与 **加权平均年化**（权重 = 各组 CAR），若某组 Unbounded，账户级标注 **Unbounded** 或排除该组后展示（须在 UI 说明）。

### 4.3 分母：Capital at risk（CAR）

**V1 必选分母为 CAR**（非 Net Liq 作为主展示；NL 可作为次要参考）。

**单腿类型参考（实现时须覆盖并写进 help）**：

| 结构直觉 | CAR 定义（示意） |
|----------|------------------|
| Cash-secured short put | `strike × 100 × contracts`（每腿） |
| Vertical / 有限风险价差 | 该结构 **max loss**（正值） |
| Covered stock + short call | **股票成本**参与部分（与 covered 数量对齐） |
| Naked short call | **Unbounded** 损失侧；CAR 展示为 **Not applicable** 或仅展示股票覆盖部分 + 警告 |
| Long option only | CAR 可为 **premium paid**（权利金支出）作为风险资本占位 |

**组合加总（V1）**：

- **默认**：各腿/各结构按上表算出 **非重叠 CAR** 后 **求和**（保守、可解释）；若多腿互抵，应用 **组合级 max loss 包络**（与 [frontend/src/utils/riskProfile.ts](../../frontend/src/utils/riskProfile.ts) 的到期 payoff 一致）作为**校验**：若包络 max loss **小于** 各腿 CAR 之和，以 **包络 max loss** 为账户级 **下行 CAR** 展示（并在 Explain 中说明「net portfolio max loss」）。

### 4.4 「理论最大」收益

- **有界结构**：到期 payoff 网格上的 **max profit**（与现有 `computeEnvelope` 语义对齐）。
- **上行无限（如净 long call）**：展示 **Unbounded**，**禁止**随意截断为例如 +100%；可提供 **采样网格上的 max** 作为补充指标并标明 **Sample max (not global)**。

### 4.5 Expected return / POP

- **前提**：**市场 IV** 可用且模型（如 Black-Scholes）明确。
- **无 IV**：**不展示** expected return / POP；UI 置灰并说明原因。
- **V1**：可作为 **可选子项**（实现顺序在核心 payoff + Delta + 压力测试之后）。

---

## 5. 风险指标

### 5.1 V1 必选

- **Delta**（组合净 Delta，期权 + 股票等价）。
- **Delta 美元等价**（例如 \(\Delta \times S \times\) 合约乘数 等，定义在实现中与 IB 约定一致）。
- **Max loss / Max gain**（到期 payoff 意义）、**Breakeven**（若有），与 `riskProfile` 一致。

### 5.2 V1.5（可选）

- Gamma、Vega、Theta（全组合或按 underlying）。

### 5.3 Buying Power / Margin

- **V1**：仅展示 IB 摘要中的 **Buying Power、Cash、Net Liquidation**（原始值），与现有账户数据一致。
- **V1 禁止**：自研 **margin 引擎** 或与 IB 逐美分对齐的占用率（坑大）。
- **V2（可选）**：**近似**保证金占用率，必须带 **Disclaimer** 与偏差说明。

---

## 6. 压力测试（V1 强烈建议纳入交付）

**固定情景（V1）**：

- **标的价格**：相对当前标的价格 **-10%、-5%、+5%、+10%**（每 underlying 使用当前 mid/last，来源 R-M6）。
- **IV**：**-5 vol**、**+5 vol**（绝对波动点，非相对百分比）。

**输出**：**P&amp;L matrix**（可按 underlying 分子矩阵；账户级为汇总）。

**IV 来源与降级**：

1. 优先：IB 提供的**合约级隐含波动率**或模型价反推 IV。
2. 若无 per-leg IV：**降级为仅标的维度**（underlying 冲击仍展示；IV 行隐藏或整表标记 **IV stress unavailable**）。

**实现注意**：全组合重估可用 **BS + 新 IV + 新 Spot** 或 **Delta-Gamma-Vega 近似**；须在文档/ API 中声明 **method**。

---

## 7. 数据降级链（Greeks / IV）

优先级：

1. **IB 实时/快照 Greeks**（若已订阅或接口可用）。
2. **本地 Black-Scholes** + 市场 IV（来自行情或 IB）。
3. **仅到期 intrinsic payoff**（无希腊值期望收益）。

**无 IV**：关闭 expected return；压力测试的 IV 行按 §6 降级。

---

## 8. 架构与计算位置

- **单一真源（SSOT）**：**服务端**（`servers/` / reader 层暴露的 API）计算并返回 Model 指标；避免前端与 Python 长期双算不一致。
- **演进**：逻辑模块先在 **app server 进程内**实现；若未来负载或复用需要，再抽 **独立 risk 进程**——**非 V1 强制**。
- **与现有前端**：`riskProfile.ts` 可作为 **对照/过渡**；收敛后以前端调用 **`GET /portfolio/model-analysis`**（见附录 A）为主。

---

## 9. 分阶段交付

| 阶段 | 内容 |
|------|------|
| **V1** | 单账户、全 book、underlying drill-down；CAR + DTE 年化；max gain/loss + Unbounded 规则；Delta + Delta $；压力矩阵（标的 ± 档 + IV ±5 vol，含降级）；REAL/MODEL UI 隔离；Disclaimer；IB BP/Cash 展示；服务端 SSOT |
| **V1.5** | 假设策略卡片（沙盒）；Gamma/Vega/Theta；分位数/P90 |
| **V2** | 多账户 Model 合并；近似 margin 占用；策略模板自动识别 |

---

## 10. 验收与测试

- **单元/快照**：已知结构（垂直价差、covered call、单腿 long call）手算 payoff 与 breakeven 对齐。
- **回归**：同一持仓下，服务端与（过渡期）`riskProfile.ts` 在**到期 payoff** 上误差在约定 epsilon 内。
- **压力矩阵**：spot ±10% 一行与仅 Delta 近似在浅冲击下量级合理（文档化容差）。

---

## 11. 开放决策（实现前可最终拍板）

- 多 underlying 时 **DTE** 取「每组最远到期」还是「最近到期」——本文 **§4.2** 已给推荐方向，最终以实现 README 为准。
- **Expected return** 是否纳入 V1 必交付：默认 **否（可选）**。

---

## 12. 依赖需求与代码

- **R-A1**（账户与持仓）、**R-M6**（市价）、账户表与 `account_positions`、Reader。
- 参考实现：[frontend/src/utils/riskProfile.ts](../../frontend/src/utils/riskProfile.ts)。

---

## 附录 A：V1 实现备注

### 代码路径

| 模块 | 路径 | 说明 |
|------|------|------|
| Payoff engine | `servers/portfolio_model/payoff.py` | Python port of `riskProfile.ts`；`RiskPosition` dataclass、`compute_risk_profile`、`compute_envelope`、grid rows、breakeven、naked call strip |
| Core orchestrator | `servers/portfolio_model/core.py` | DB fetch → group by underlying → payoff + CAR + DTE annual + BS IV/Delta + stress matrix → aggregate |
| Router | `servers/routers/portfolio_model.py` | `GET /portfolio/model-analysis?account_id=...` |
| Frontend page | `frontend/src/pages/ModelAnalysisPage.tsx` | Account selector、disclaimer、summary row、per-underlying table、drill-down detail、stress table |
| Unit tests | `tests/test_portfolio_model.py` | 30 tests: payoff, CAR, annualization, BS/IV roundtrip, delta, stress, greeks |

### API 字段总览

`GET /portfolio/model-analysis?account_id=<id>` 返回：

- `account_id`, `account_summary` (NLV / Cash / BP), `disclaimer`, `method`
- `per_underlying[]`：symbol, spot, dte_days, max_gain/loss, risk_type, breakeven_prices, net_premium, capital_at_risk (effective + explain + leg_details), annualized_return_on_car, greeks (delta + delta_dollars + degraded + per_leg), stress (scenarios + iv_stress_available)
- `account_rollups`：total_car, weighted_annualized_return, total_delta, total_delta_dollars
- `account_stress`：aggregated scenarios across underlyings

### DTE 取整

V1 使用**每组（underlying）最远到期日**作为 dte_basis。账户级加权年化使用 CAR 加权。

### IV 反推算法

Newton-Raphson（max 100 iterations, tol=1e-6）；失败时 leg delta 标记 null、汇总 `delta_degraded: true`。

### V1 不包含

Expected return / POP、多账户合并、自研 margin、独立 risk 进程、Gamma/Vega/Theta。

---

## 附录 B：未完成事项、已知问题与后续工作

> 便于从当前实现继续迭代时对齐预期。实现状态以代码与 [CAPABILITY_TRACKING.md](CAPABILITY_TRACKING.md) 能力 **22** 为准。

### B.1 相对 PRD 仍属「未做 / 部分」的能力

| 类别 | 说明 |
|------|------|
| **Expected return / POP** | §4.5：需稳定 IV 与明确模型；当前未输出；无 IV 时本就不应展示。 |
| **IB 作为 Greeks/IV 第一来源** | §7 优先级 1：当前实现以 **mid + 本地 BS 反推 IV** 为主；未接 IB 合约级 modelGreeks/IV 快照为首选路径。 |
| **Gamma / Vega / Theta** | §5.2 V1.5：未实现。 |
| **假设策略卡片（沙盒）** | §3.3 V1.5：未实现。 |
| **多账户 Model 合并** | §3.2 V2：未实现；V1 仍为单 `account_id`。 |
| **近似 margin 占用率** | §5.3 V2：未实现；V1 仅展示 IB 原始 BP/Cash/NLV。 |
| **独立 risk 进程 / 微服务** | §8：非 V1 强制；当前均在 app server 进程内。 |
| **按原始 position / contract 行展开** | §3.1：前端为 **按 underlying** 汇总行 + 展开 **模型指标详情**；若需与 `account_positions` **逐合约行** 完全对齐，需 API 增字段与 UI 列表。 |
| **REAL vs MODEL 同屏强对比** | §2：Model 为独立「Model Analysis」子页；若需在 **Accounts/Performance 同页** 并排 REAL，属产品增量。 |
| **文档 §8 API 路径** | 文中曾写 `portfolio-risk` 类路径；**实际端点**见附录 A：`GET /portfolio/model-analysis`。 |

### B.2 已知风险与技术债（建议继续解决）

| 问题 | 影响 | 建议方向 |
|------|------|----------|
| **IV 反推不稳定** | 深实值、近到期、价外极薄时间价值时 Newton-Raphson 易失败 | 边界条件与失败阈值；失败已降级；可补充 **IB 隐含波动率字段** 或 **宽限报价** 回退。 |
| **期权 mid/last 缺失** | 无法反推 IV → 腿级 `delta: null`、`iv_stress_available: false` | 确保 `contract_quote_live` 订阅/刷新；或接 IB 期权 **modelOption** 类数据。 |
| **CAR 启发式 vs 复杂多腿** | 非标准组合可能与主观「资本占用」不一致 | 用真实账户 + spreadsheet 做 **验收用例**；复杂结构在 UI Explain 中强化 **net_portfolio_max_loss** 说明。 |
| **账户级 stress 聚合** | 多标的场景矩阵按 key 相加，需理解 **非分散化** 含义 | 文档化「账户 stress = 各 underlying 情景 P&amp;L 之和」假设；若需相关性，属 V2+。 |
| **能力跟踪状态** | [CAPABILITY_TRACKING.md](CAPABILITY_TRACKING.md) 能力 22 为 **⏳ V1 已实现** | 产品验收通过后可将 **⏳** 改为 **✅** 并注明版本/日期。 |
| **部署** | 开发依赖 Vite 代理 `/portfolio` → 后端 | 生产若 **nginx 整站反代** 到 uvicorn（如 `deploy/nginx/bifrost-status.conf` 的 `location /`），一般无需单独配置；若静态资源与 API 分离部署，需核对 `/portfolio` 是否到达 app server。 |

### B.3 建议的下一步（按优先级）

1. **数据质量**：提高期权 **mid/last** 覆盖率；可选接入 **IB per-contract IV/Greeks**，减少纯 BS 反推依赖。  
2. **验收**：固定 2–3 个账户快照或构造持仓，对 **payoff / CAR / Delta / stress** 做 **手算或表格对照**（含 T+0 近到期边界）。  
3. **产品**：确认是否需要 **Expected return**（§4.5）与 **同屏 REAL**（§2）；若做，先锁公式与 IV 来源。  
4. **V1.5**：Gamma/Vega/Theta、假设策略沙盒——按 §9 拆分独立迭代。  
5. **V2**：多账户 Model 合并规则、近似 margin——单独 PRD 小节与数据契约。

### B.4 与 `riskProfile.ts` 的长期关系

- 服务端 `payoff.py` 已为 SSOT；前端 **Instance/Positions** 等处若仍调用 `riskProfile.ts`，长期应 **以 API 结果为准** 或抽共享规格，避免双算漂移（参见 §8、§10）。
