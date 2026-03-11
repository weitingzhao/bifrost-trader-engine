# Guard 与边界条件：微调方式与影响分析建议

本文档说明当前项目中与**安全相关的 Guard 和边界条件**分布在何处、如何**微调**、微调后的**后果与影响**，以及如何**观察与分析**这些影响。便于你在不破坏安全的前提下做参数优化。

---

## 1. Guard 与边界条件分布总览

| 层级 | 位置 | 作用 | 配置来源 |
|------|------|------|----------|
| **状态分类** | `StateClassifier`（delta / market / liquidity / system） | 把连续量变成离散状态 O,D,M,L,E,S；决定何时进入 NEED_HEDGE、PAUSE_* 等 | gates.state（delta, market, liquidity, system） |
| **Trading FSM 门控** | `TradingGuard`（trading_fsm 用） | 纯谓词：data_ok、in_no_trade_band、cost_ok、liquidity_ok 等，决定状态迁移 | 同上 + gates.intent.hedge, risk |
| **下单前门控** | `ExecutionGuard` + `apply_hedge_gates` | 真正发单前的最后一道：cooldown、每日次数、仓位上限、熔断、盘前盘后、earnings 黑名单等 | gates.guard.risk, gates.strategy.earnings |

- **微调**：上述参数均在 `config.yaml`（及 `gates.*`）中配置，且守护程序支持**热重载**（`_reload_config_loop`），改配置文件即可生效，无需重启。
- **影响**：改小阈值 → 更容易触发“需要对冲”或“允许下单”；改大阈值 → 更保守，更少对冲或更多被拦。

---

## 2. 按维度列出可调参数与微调方向

### 2.1 Delta（净 delta → 是否对冲）

| 参数 | 默认 | 含义 | 微调方向 | 影响 |
|------|------|------|----------|------|
| `epsilon_band` | 10 | \|net_delta\| ≤ 此值视为“无感区”，不触发对冲 | 增大 → 无感区变宽，少对冲；减小 → 更敏感，多对冲 | 直接影响进入 NEED_HEDGE 的频率 |
| `threshold_hedge_shares` | 25 | \|net_delta\| ≥ 此值才进入 HEDGE_NEEDED | 增大 → 更少进入“需要对冲”；减小 → 更早对冲 | 与 epsilon 一起决定 D 状态（IN_BAND / MINOR / HEDGE_NEEDED / FORCE_HEDGE） |
| `max_delta_limit` | 500 | \|net_delta\| ≥ 此值进入 FORCE_HEDGE（可绕过 cooldown） | 增大 → 很少强制对冲；减小 → 更早强制 | 极端偏离时的强制对冲门槛 |

### 2.2 市场与流动性（数据新鲜度、价差）

| 参数 | 默认 | 含义 | 微调方向 | 影响 |
|------|------|------|----------|------|
| `stale_ts_threshold_ms` | 5000 | 行情时间戳超过此毫秒视为 STALE | 增大 → 更容忍延迟；减小 → 更容易判为 stale | M 状态；stale 时可能不进 MONITOR 或进 PAUSE_* |
| `wide_spread_pct` / `extreme_spread_pct` | 0.1 / 0.5 | 价差占 mid 的百分比，划分 L0/L1/L2/L3 | 增大 → 更容忍宽 spread；减小 → 更容易 PAUSE_LIQ | L 状态；L2/L3 时不应发单（should_output_target=False） |
| `data_lag_threshold_ms` | 1000 | 事件延迟超过此值 → S=DATA_LAG | 增大 → 更容忍 lag；减小 → 更容易 S1 | S 状态；S 非 OK 时不输出 target |

### 2.3 执行与成本门控（intent / hedge）

| 参数 | 默认 | 含义 | 微调方向 | 影响 |
|------|------|------|----------|------|
| `min_hedge_shares` | 10 | 意图数量 &lt; 此值不送单 | 增大 → 更少小单；减小 → 允许更小单 | apply_hedge_gates 直接过滤 |
| `cooldown_sec` | 60 | 两次对冲之间最少间隔（秒） | 增大 → 对冲更稀疏；减小 → 更频繁 | ExecutionGuard.allow_hedge 拦 |
| `max_hedge_shares_per_order` | 500 | 单笔最大股数 | 增大 → 单笔可更大；减小 → 更保守 | 策略层 cap |
| `min_price_move_pct` | 0.2 | 与上次对冲价相比，价格变动不足此百分比则不发单（成本门） | 增大 → 更少“无意义”对冲；减小 → 更易发单 | TradingGuard.is_cost_ok / ExecutionGuard.allow_hedge |

### 2.4 风险与熔断（ExecutionGuard）

| 参数 | 默认 | 含义 | 微调方向 | 影响 |
|------|------|------|----------|------|
| `max_daily_hedge_count` | 50 | 每日最多对冲次数 | 增大 → 允许多做；减小 → 更严 | 超限后 allow_hedge 返回 False |
| `max_position_shares` | 2000 | 对冲后股票仓位绝对值上限 | 增大 → 允许更大敞口；减小 → 更严 | 超限拦单 |
| `max_daily_loss_usd` | 5000 | 当日亏损达此值触发熔断 | 增大 → 更晚熔断；减小 → 更早熔断 | 熔断后 _circuit_breaker=True，所有对冲被拦 |
| `max_spread_pct` | 可选 | 价差超过此值不发单 | 增大 → 更容忍宽 spread；减小 → 更严 | allow_hedge 拦 |
| `max_net_delta_shares` | 可选 | 净 delta 绝对值上限（若实现） | - | - |
| `earnings_blackout_*` | 前后 3/1 天 | 财报日前后禁止对冲 | 改天数或 dates | 黑名单内 allow_hedge 返回 False |
| `trading_hours_only` | true | 仅 RTH 允许对冲 | 关 → 盘前盘后也可对冲 | 非 RTH 时拦单 |

---

## 3. 微调操作方式

1. **改配置**：编辑 `config/config.yaml`（或你使用的配置文件），在 `gates.state`、`gates.intent`、`gates.guard` 下修改对应键。参考 `config/config.yaml.example`。
2. **热重载**：保存文件后，守护程序会在下一轮 `_reload_config_loop` 检测 mtime 变化并调用 `_reload_config`，从而更新 `ExecutionGuard.update_config()` 和传入 TradingFSM / StateClassifier 的 config。**无需重启进程**。
3. **建议**：一次只改一类或一个参数，观察一段时间再改下一个，便于归因。

---

## 4. 微调后的后果与影响分析

### 4.1 你关心的问题

- **某次为什么没对冲？** 可能是：D 未到 HEDGE_NEEDED（epsilon/threshold 太大）、L 或 S 不 OK、被 ExecutionGuard 拦（cooldown、daily_count、spread、min_price_move、熔断等）。
- **某次为什么对冲了？** 说明所有门控都通过；若你觉得不该冲，需要收紧对应参数。
- **改某个阈值后，整体对冲次数、延迟、滑点会怎样？** 见下表。

### 4.2 典型调整的定性影响

| 调整 | 预期效果 | 风险/注意 |
|------|----------|-----------|
| 增大 epsilon_band 或 threshold_hedge_shares | 对冲次数减少，延迟略增，少交手续费 | 净 delta 暴露时间变长，波动大时偏离更大 |
| 减小 cooldown_sec | 对冲更及时，次数可能增多 | 更容易过度交易、滑点与手续费上升 |
| 增大 min_price_move_pct | 减少“价格几乎没动就再对冲” | 在窄幅震荡时可能迟迟不对冲，delta 敞口久 |
| 减小 max_daily_hedge_count / max_position_shares | 更保守，单日/单边风险更小 | 可能过早用满额度，尾盘无法对冲 |
| 减小 max_daily_loss_usd | 熔断更早，单日亏损封顶更严 | 正常波动也可能触发熔断，整天停对冲 |

### 4.3 如何获得“影响数据”以便分析

- **现状**：Guard 拦单时，`apply_hedge_gates` 仅返回 `None`，**未把 block 原因写入日志或状态**；ExecutionGuard 返回 `(False, reason)`，但 reason 未持久化。
- **建议**：
  1. **记录“被拦原因”**：在 `apply_hedge_gates` 或调用处，当 `allowed is False` 时打一条日志（如 `logger.debug("hedge blocked: %s", reason)`），或写入状态 sink（见 PLAN_NEXT_STEPS）。这样后续可统计：今日被 cooldown / max_daily_hedge_count / spread_too_wide 等各拦了多少次。
  2. **状态 sink 中带上 guard 信息**：若实现阶段 1 的 StatusSink，可在 snapshot 中增加“最近一次 block reason”或“本周期内各 reason 计数”，便于监控与事后分析。
  3. **历史与统计（阶段 3）**：用 SQLite 历史表做“按日/周：对冲次数、被拦次数（按 reason 分）、平均延迟、滑点”。据此可量化“调大 cooldown 后，拦单次数与对冲次数的变化”。

---

## 5. 建议的微调与复盘流程

1. **基线**：在改参数前，用当前配置跑一段时间（或已有历史），记录：每日对冲次数、被拦次数（若已实现上述日志/sink）、典型 delta 与价差分布。
2. **单参数调整**：一次改一个参数（如只把 cooldown_sec 从 60 改为 45），保持其余不变。
3. **观察窗口**：至少观察一个完整交易日，或若干次 tick/heartbeat 周期，看 FSM 状态分布、对冲次数、是否有“该冲未冲”或“不该冲却冲”的个案。
4. **归因**：若未对冲，查日志或状态里的 block reason；若对冲了但你不满意，看是哪个门控“放行”了（可考虑在决策路径打少量 debug 日志）。
5. **回滚**：若效果不好，把参数改回并再次热重载即可。

---

## 6. 回测：策略 PnL 优化与 Guard 参数验证

- **需求文档**（`REQUIREMENTS.md` §4 回测）已明确：回测 **首要用于策略回报 PnL 优化**（对比不同参数下的理论 P&L、收益曲线、回撤等），同时用于 Guard 参数的有效性与合理性验证；**回测**（用历史数据离线回放同一套 classify → FSM → guard，不下单）是推荐手段。
- **与微调的关系**：实盘/模拟盘调参前，可先用回测对比多组参数下的 **理论 P&L、收益曲线、对冲次数、拦截原因分布**，再选一组上线；调参后也可用新历史数据回测做“假如当时用这组参数会怎样”的对比，既优化策略回报，也验证 Guard 行为。
- **实现依赖**：回测依赖历史数据存储（阶段 1 的 StatusSink + 历史表，或阶段 3 的历史与统计）；回放时只需读历史 tick/快照，注入到 StateClassifier + TradingFSM + ExecutionGuard 的同一套逻辑，不连 TWS、不真实下单。具体排期见分步计划（**阶段 4**）。

---

## 7. 与现有文档的关系

- **CONFIG_SAFETY_TAXONOMY.md**：从“边界分类”和配置结构角度说明各 section 的含义。
- **本文档**：从“如何微调、微调后会发生什么、如何观察影响”的角度补充，并建议“记录 block reason + 用状态/历史做简单统计 + 回测验证”，以便数据驱动的调参。
- **REQUIREMENTS.md**：§4 将回测列为 Guard 参数验证的产品需求。

若你愿意，可以在实现 StatusSink 或阶段 3 历史统计时，把“guard block reason”作为首批字段之一；回测模块则可复用同一套 guard 与 FSM 逻辑，仅数据源改为历史回放。
