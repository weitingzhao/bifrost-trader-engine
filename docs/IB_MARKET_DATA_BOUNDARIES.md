# IB 数据获取服务边界（Market Data & Historical Data）

本文档整理 Interactive Brokers TWS API 在**市场数据订阅**与**历史数据请求**上的官方限制与合法参数组合，供监控端 Market 页 Fetch 逻辑与后端拉取实现遵守。  
官方来源：  
[TWS API Historical Data Limitations](https://interactivebrokers.github.io/tws-api/historical_limitations.html)、  
[Historical Market Data](https://interactivebrokers.github.io/tws-api/historical_data.html)、  
[Streaming Market Data](https://interactivebrokers.github.io/tws-api/market_data.html)、  
[Historical Bar Data](https://interactivebrokers.github.io/tws-api/historical_bars.html)。  
文档注明可切换至 [IBKR Campus](https://ibkrcampus.com/ibkr-api-page/trader-workstation-api/) 获取最新说明。

---

## 1. 历史数据请求限制（Pacing）

- **同时未完成请求数**：最多 **50** 个；实践中建议更少以提高稳定性。
- **10 分钟内**：最多 **60** 次历史数据请求。
- **同一 Contract + Exchange + Tick Type**：**2 秒内**最多 **6** 次请求。
- **相同请求**：**15 秒内**不能重复（identical request）。
- 使用 `BID_ASK` 类型时，每次请求计为 **2** 次。

违反上述限制会触发 **Pacing Violation**，可能被限流或断开。  
结论：前端/后端应对“同一 symbol+period+duration”的重复请求做节流（例如 15 秒内不重复），并避免短时间大量请求。

---

## 2. Step Size：Duration 与 Bar Size 的合法组合

历史请求的 **duration** 与 **barSizeSetting** 必须落在下表组合内，否则可能被拒或返回空。  
原则：单次请求只返回“几千根 bar”量级，由 duration/bar 比例约束。

| Duration       | Allowed Bar Sizes        |
|----------------|--------------------------|
| 60 S           | 1 sec – 1 min            |
| 120 S          | 1 sec – 2 min            |
| 1800 S (30 min)| 1 sec – 30 min           |
| 3600 S (1 hr)  | 5 sec – 1 hr             |
| 14400 S (4 hr) | 10 sec – 3 hr            |
| 28800 S (8 hr) | 30 sec – 8 hr           |
| **1 D**        | **1 min – 1 day**        |
| 2 D            | 2 min – 1 day            |
| **1 W**        | **3 min – 1 week**       |
| 1 M            | 30 min – 1 month         |
| 1 Y            | 1 day – 1 month          |

Duration 单位：S=秒，D=天，W=周，M=月，Y=年。

**对本项目 Bar 类型的约束**（仅使用 1 min / 5 mins / 1 hour / 1 day）：

- **1 min**：仅当 duration = **1 D** 时合法；**不能**使用 5 D、1 W 等（会超出 step size）。
- **5 mins**：可与 1 D、2 D、1 W 等组合；**5 D** 未在表中列出，建议用 **1 D** 或 **1 W**。
- **1 hour**：可与 1 D、1 W 等组合；同样不建议使用未列出的 5 D。
- **1 day**：可与 1 D、2 D、1 W、1 M、1 Y 组合；例如 30 D + 1 day 合法。

---

## 3. 历史数据不可用情形

- **≤30 秒的 bar**：超过 **6 个月**的历史不可用。
- **期权 / FOP / 权证 / 结构性产品**：无 EOD；过期后历史也不可用。
- **期货**：过期超过 **2 年**不可用。
- **标的迁所、停牌等**：迁所前或停牌期间数据可能不可用。
- **Combo**：无单独存储，返回为各腿汇总。

---

## 4. 实时行情（Market Data Lines）

- 接收实时 Top-of-Book、Depth 或历史数据，均需对应标的的 **Level 1 行情订阅**（及账户/权限满足要求）。
- **Market Data Lines**：每用户默认最多 **100** 条同时订阅（可扩展）；一次实时或历史请求会占用 line。
- 历史数据与 Level 1 订阅要求一致；无订阅时可能无数据或延迟。

---

## 5. 与本项目 Fetch 逻辑的对应关系

| 项目 Period | 建议 Duration（单次请求） | 说明 |
|-------------|---------------------------|------|
| 1 D         | 30 D（或 1 W / 1 M / 1 Y）| 符合 step size，bar 数在几千以内。 |
| 1 min       | **仅 1 D**                | 1 min 在官方表中仅支持 1 D duration。 |
| 5 mins      | 1 D 或 1 W                | 避免使用未列出的 5 D。 |
| 1 hour      | 1 D 或 1 W                | 同上。 |

- **Smart duration**：在“只补缺失区间”时，若 period 为 1 min，后端应**强制 duration 不超过 1 D**，否则会触发 step size 违规。
- **节流**：同一 (symbol, period, duration) 15 秒内不重复请求；后端已有 120 秒内存缓存时可保留，并建议前端对“Fetch bars”做 15 秒防重复点击。

以上边界在实现 Market 页 Fetch 与监控端 `MarketIbClient`/`IBConnector.get_historical_bars_async` 时应严格遵守。

---

## 6. 实现（配置与限流）

边界条件的**项目内配置**、**Worker/API 用量计量**、**与边界比对及限流**、以及**监控暴露**的详细设计与分步实现，见 **[plans/ib-pacing-implementation-plan.md](plans/ib-pacing-implementation-plan.md)**。
