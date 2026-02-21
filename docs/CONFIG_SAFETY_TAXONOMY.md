# 配置安全边界分类

本文档分析各配置段落如何定义**安全边界**，并给出统一的分类方式。

**现状：** 已采用 **Option 2 (gates)**。配置使用 `gates.strategy`、`gates.state`、`gates.intent`、`gates.guard`。

## 当前配置：两组隐含分类（兼容旧版）

### 组 A —「业务 / 运行」

| Section   | 键 | 用途 |
|----------|-----|------|
| **structure** | min_dte, max_dte, atm_band_pct | 哪些持仓计入（DTE、ATM 带） |
| **risk**      | max_daily_hedge_count, max_position_shares, max_daily_loss_usd, max_net_delta_shares, max_spread_pct, trading_hours_only, paper_trade | 熔断、每日限制 |
| **earnings**  | blackout_days_before, blackout_days_after, dates | 日历黑名单（财报前后禁止对冲） |
| **greeks**    | risk_free_rate, volatility | 模型输入（Black–Scholes）— *不是边界* |

### 组 B —「状态空间阈值」

| Section   | 键 | 用途 |
|----------|-----|------|
| **delta**     | epsilon_band, threshold_hedge_shares, max_delta_limit | 将 net_delta 映射到 D 状态 |
| **market**    | vol_window_min, stale_ts_threshold_ms | 将数据新鲜度映射到 M 状态 |
| **liquidity** | wide_spread_pct, extreme_spread_pct | 将价差映射到 L 状态 |
| **hedge**     | min_hedge_shares, cooldown_seconds, max_hedge_shares_per_order, min_price_move_pct | 下单量、成本门控 |
| **system**    | data_lag_threshold_ms | 将延迟映射到 S 状态 |

**说明：** `greeks` 是**模型输入**，不是安全边界；用于 Black–Scholes，有效性由别处检查（如 S1 GREEKS_BAD）。

---

## 统一视角：除 greeks 外均为安全边界

除 `greeks` 外，每个段落都在回答：**「何时可以对冲？」** 或 **「何时必须拦截？」**

| 维度 | 问题 | 配置 |
|------|------|------|
| **持仓** | 哪些持仓计入？ | structure |
| **持仓** | delta 偏离多少才对冲？ | delta |
| **市场** | 数据是否够新？ | market.stale_ts_threshold_ms |
| **市场** | 价差是否可接受？ | liquidity |
| **系统** | 数据延迟是否可接受？ | system |
| **执行** | 下单量、cooldown、成本门控 | hedge |
| **风险** | 每日次数、仓位、亏损限制 | risk |
| **日历** | 黑名单日期 | earnings |

---

## 可选分类方式

### Option 1：按安全层级（纵深防御）

按边界在流水线中**何处**生效来组织：

```
safety:
  eligibility:     # 能否交易？
    structure:     # min_dte, max_dte, atm_band_pct
    calendar:      # earnings blackout
    trading_hours: # risk.trading_hours_only
  observation:     # 状态分类（连续量 → 离散）
    delta:         # epsilon_band, threshold_hedge_shares, max_delta_limit
    market:        # vol_window_min, stale_ts_threshold_ms
    liquidity:     # wide_spread_pct, extreme_spread_pct
    system:        # data_lag_threshold_ms
  execution:       # 如何对冲
    sizing:        # min_hedge_shares, max_hedge_shares_per_order, cooldown_seconds
    cost_gate:     # min_price_move_pct
  limits:          # 熔断
    daily:         # max_daily_hedge_count, max_daily_loss_usd
    position:      # max_position_shares, max_net_delta_shares
    spread:        # max_spread_pct (risk)
```

**优点：** 流水线顺序清晰（eligibility → observation → execution → limits）。  
**缺点：** 嵌套更深；`risk` 被拆到 limits 与 eligibility。

---

### Option 2：按门控类型（决策阶段）

按**何时**检查边界来组织（当前实现即此类）：

```
gates:
  strategy:   # 在考虑对冲之前
    structure: { min_dte, max_dte, atm_band_pct }
    earnings:  { blackout_days_before, blackout_days_after, dates }
    trading_hours_only: true
  state:       # 状态分类阈值 (O,D,M,L,E,S)
    delta:     { epsilon_band, threshold_hedge_shares, max_delta_limit }
    market:    { vol_window_min, stale_ts_threshold_ms }
    liquidity: { wide_spread_pct, extreme_spread_pct }
    system:    { data_lag_threshold_ms }
  intent:     # 对冲规模与成本
    hedge:     { min_hedge_shares, cooldown_seconds, max_hedge_shares_per_order, min_price_move_pct }
  guard:      # ExecutionGuard（下单前门控）
    risk:      { max_daily_hedge_count, max_position_shares, max_daily_loss_usd, max_net_delta_shares, max_spread_pct }
```

**优点：** 与代码一一对应（strategy gate → state gate → intent → guard）。  
**缺点：** `risk` 与 `hedge` 概念相近（都限制执行）。

---

### Option 3：按领域（被约束的对象）

按**约束什么**来组织：

```
boundaries:
  position:     # 组合 / delta
    structure:  { min_dte, max_dte, atm_band_pct }
    delta:      { epsilon_band, threshold_hedge_shares, max_delta_limit }
    limits:     { max_position_shares, max_net_delta_shares }  # 来自 risk
  market:       # 市场条件
    regime:     { vol_window_min, stale_ts_threshold_ms }
    liquidity:  { wide_spread_pct, extreme_spread_pct }
    spread:     { max_spread_pct }  # 来自 risk
  system:       # 健康
    data_lag:   { data_lag_threshold_ms }
  execution:    # 对冲单
    sizing:     { min_hedge_shares, max_hedge_shares_per_order, cooldown_seconds }
    cost:       { min_price_move_pct }
  daily:        # 累计限制
    count:      { max_daily_hedge_count }
    loss:       { max_daily_loss_usd }
  calendar:     # 黑名单
    earnings:   { blackout_days_before, blackout_days_after, dates }
```

**优点：** 按领域划分，每块约束一个概念。  
**缺点：** `risk` 被拆到 position、market、daily。

---

### Option 4：扁平 + 单一根（最小改动）

保持当前扁平结构，仅增加**概念根**和**注释**，不改结构：

```yaml
# === 安全边界（均定义「何时可对冲」） ===

# 资格：哪些持仓、何时
structure: { ... }
earnings:  { ... }

# 状态分类 (O,D,M,L,E,S 阈值)
delta:     { ... }
market:    { ... }
liquidity: { ... }
system:    { ... }

# 执行：规模与成本门控
hedge:     { ... }

# 熔断
risk:      { ... }

# 模型（非边界）
greeks:    { ... }
```

**优点：** 零迁移，仅文档化。  
**缺点：** 无结构统一。

---

## 建议

| 目标 | 选项 |
|------|------|
| **改动最小、心智模型清晰** | Option 4（仅文档） |
| **结构统一、与流水线对齐** | Option 2 (gates) |
| **按领域、便于扩展** | Option 3 (boundaries) |
| **纵深防御叙事** | Option 1 (safety layers) |

**建议路径：** 先采用 **Option 4**（在配置中加段落注释并保留本文档）。若后续要做结构统一，**Option 2 (gates)** 与现有代码流最一致：`parse_positions(structure)` → `StateClassifier(delta,market,liquidity,system)` → `gamma_scalper_intent(hedge)` → `ExecutionGuard(risk,earnings)`。

---

## 当前配置 → Option 2 (gates) 映射

若采用 Option 2，YAML 形态如下：

```yaml
gates:
  strategy:
    structure: { min_dte: 21, max_dte: 35, atm_band_pct: 0.03 }
    earnings:  { blackout_days_before: 3, blackout_days_after: 1, dates: [] }
    trading_hours_only: true
  state:
    delta:     { epsilon_band: 10, threshold_hedge_shares: 25, max_delta_limit: 500 }
    market:    { vol_window_min: 5, stale_ts_threshold_ms: 5000 }
    liquidity: { wide_spread_pct: 0.1, extreme_spread_pct: 0.5 }
    system:    { data_lag_threshold_ms: 1000 }
  intent:
    hedge:     { min_hedge_shares: 10, cooldown_seconds: 60, max_hedge_shares_per_order: 500, min_price_move_pct: 0.2 }
  guard:
    risk:      { max_daily_hedge_count: 50, max_position_shares: 2000, max_daily_loss_usd: 5000, ... }

# 以下不变（非 gates）
ib: { ... }
symbol: "NVDA"
greeks: { ... }
order: { ... }
```

代码侧：`get_hedge_config`、`get_state_space_config`、`_get_cfg` 从 `config["gates"]["guard"]["risk"]`、`config["gates"]["state"]["delta"]` 等读取。可同时兼容 `gates.X` 与顶层 `X`。
