# 阶段 3 执行计划（数据获取：账户、持仓、市值、交易历史与统计）

与 [分步推进计划](../PLAN_NEXT_STEPS.md) **阶段 3（数据获取）** 一致。实现 **R-A1**（账户与持仓可获取）、**R-M6**（标的与持仓当前市价可获取）、**R-H2**（历史统计）。  
**数据库与表结构**：以 [DATABASE.md](../DATABASE.md) 为准；本文仅引用 accounts、account_positions、status_current（spot）、status_history、operations 等。

**阶段 3 目标**：将账户、持仓、市值、交易历史与统计等**数据的获取**作为本阶段目标，供策略与监控使用。**阶段 4** = 策略框架与回测（R-B1、R-B2）；**阶段 5** = 自动交易对冲与监控（R-C2、R-C3）。详见 PLAN_NEXT_STEPS。

---

## 范围与成功标准（阶段 3：数据获取）

- **交付物**：(1) 守护程序从 IB 获取**账户摘要**与**当前持仓**（R-A1），可供内部对冲与风控使用；(2) 守护程序拉取**标的市价**并写入 sink/status_current（R-M6）；GET /status 返回账户/持仓摘要与标的市价，供监控页展示；(3) 独立脚本/模块**只读历史表**产出统计（按日/周对冲次数、盈亏汇总等）（R-H2）；(4) 账户/持仓/市价的更新与 IB 断连行为明确（RE-7）。
- **成功标准**：[分步推进计划](../PLAN_NEXT_STEPS.md) 阶段 3 的全部 Test Case（TC-3-R-A1-*、TC-3-R-M6-*、TC-3-R-H2-*）通过；R-A1、R-M6、R-H2 验收条全部满足。

---

## 已实现（阶段 3 落地情况）

- **R-A1**：账户与持仓（见下「当前代码锚点」）；CONNECTED 时拉取，RUNNING 后每 1 小时拉取；断连 WAITING_IB 不拉取。
- **R-M6**：每次心跳拉取标的现价并写入 status_current.spot；GET /status 含 status.spot；监控页可展示标的与持仓市价、盈亏、期权虚实等。
- **R-H2**：已实现。`scripts/stats_from_history.py` 只读 status_history、operations 表，产出按日/周对冲次数、盈亏汇总；可离线运行（`python scripts/stats_from_history.py [--days N] [--format json|text]`）。

---

## Todo List（阶段 3 执行与验收清单）

完成一项勾选一项。**R-A1、R-M6、R-H2 实现项已勾选**；**正式验收**待执行并记录。

### 步骤 3.1：账户与持仓（R-A1）

- [x] **3.1.1** 守护程序连接 IB 后请求账户摘要（reqAccountSummary / accountValues），至少获取账户标识、TotalCashValue、NetLiquidation、BuyingPower 等。
- [x] **3.1.2** 账户数据写入 Store 并在 CONNECTED 时拉取；进入 RUNNING 后按配置间隔（如 1 小时）更新，不每心跳请求。
- [x] **3.1.3**（可选）snapshot/sink 写入 account_id、account_net_liquidation 等；GET /status 返回上述字段。

### 步骤 3.2：当前持仓（R-A1）

- [x] **3.2.1** 通过 IB API 请求当前持仓（reqPositions/positions），包含策略涉及标的的数量与方向。
- [x] **3.2.2** 持仓数据可供内部对冲逻辑与风控使用；与账户同间隔更新（如 1 小时）。
- [x] **3.2.3**（可选）持仓写入 accounts / account_positions 或 snapshot，GET /status 或监控页可展示。

### 步骤 3.3：更新与异常（R-A1）

- [x] **3.3.1** 账户与持仓在运行周期内按配置间隔或 heartbeat 更新；文档或配置说明更新频率。
- [x] **3.3.2** IB 断连/异常时行为明确：不阻塞、进入 WAITING_IB、可重试或降级，与 RE-7 一致。

### 步骤 3.4：标的与持仓市价（R-M6）

- [x] **3.4.1** 守护程序在 heartbeat 或按配置间隔向 IB 请求标的行情（spot、bid/ask 等），写入 status_current（如 spot 列）。
- [x] **3.4.2** GET /status 返回的当前视图中包含标的市价（如 status.spot），可供监控页读取。
- [x] **3.4.3** 监控页能结合持仓与市价展示（持仓+当前价、盈亏、期权虚实等）；多标的时市价可区分。

### 步骤 3.5：历史与统计（R-H2）

- [x] **3.5.1** 独立脚本或模块（如 `scripts/stats_from_history.py` 或 `src/stats/`）只读阶段 1 历史表，做聚合；不跑 FSM/Guard。
- [x] **3.5.2** 输出至少含：按日/周对冲次数、盈亏分布或汇总；可离线运行。

### 步骤 3.6：监控与控制（可选）

- [x] **3.6.1** 监控页「IB 账户」区块：刷新按钮（POST /control/refresh_accounts）、1 小时自动刷新、accounts_fetched_at 展示。
- [x] **3.6.2** 守护进程消费 refresh_accounts 后从 IB 拉取账户/持仓并写 DB；监控端轮询 GET /status 直至 accounts_fetched_at 更新。

### 步骤 3.7：文档与验收

- [x] **3.7.1** 文档：PLAN_NEXT_STEPS 阶段 3 实现说明、REQUIREMENTS.md §1.4/§1.5/§3、DATABASE.md accounts/account_positions。
- [ ] **3.7.2** **正式验收**：按 [PLAN_NEXT_STEPS](../PLAN_NEXT_STEPS.md) 阶段 3「检查方式」「验证标准」与「本阶段 Test Case 清单」执行，确认全部 TC-3-R-A1-*、TC-3-R-M6-*、TC-3-R-H2-* 通过并记录；更新阶段完成状态与项目里程碑时间线中的验收完成时间。

---

## 验收清单（阶段 3 Test Case 与验收条对应）

| Test Case ID | 需求 | 验收条 | 通过条件 | 验收结果 |
|--------------|------|--------|----------|----------|
| TC-3-R-A1-1 | R-A1 | ① | 守护程序连接 IB 后能请求并获取当前账户基本信息（账户标识、Balance/NetLiquidation 等） | 待执行 |
| TC-3-R-A1-2 | R-A1 | ② | 守护程序能获取当前持仓（策略涉及标的的数量与方向），可供内部对冲逻辑使用 | 待执行 |
| TC-3-R-A1-3 | R-A1 | ③ | 账户与持仓在运行中可持续更新；IB 断连或异常时行为明确（重试/降级，不阻塞） | 待执行 |
| TC-3-R-M6-1 | R-M6 | ① | 守护程序在运行中从 IB 拉取标的市价（spot 等）并写入 status_current/sink | 待执行 |
| TC-3-R-M6-2 | R-M6 | ② | GET /status 返回中含标的市价（如 status.spot），可供监控页读取 | 待执行 |
| TC-3-R-M6-3 | R-M6 | ③ | 监控页能结合持仓与市价展示（持仓+当前价、盈亏、期权虚实等）；多标的时市价可区分 | 待执行 |
| TC-3-R-H2-1 | R-H2 | ①②③④ | 独立脚本/模块只读历史表；输出含按日/周对冲次数与盈亏相关；可离线运行 | 待执行 |

**验收执行说明**：需守护程序连接 IB（TWS/Gateway）运行；status server 运行时可 curl GET /status 校验 account_*、accounts_snapshot、spot、accounts_fetched_at 等；监控页打开后校验 IB 账户区块与标的/持仓市价展示。可选自检脚本见「自检脚本（可选）」一节。

---

## 自检脚本（可选）

若已新增 `scripts/check/phase3_0.py`，可执行自动化校验（如 GET /status 含 account_id、spot、accounts_fetched_at 等字段）。当前**无** phase3_0.py 时，阶段 3 验收依赖上述验收清单**人工执行并记录**。

**建议**：编写 phase3_0.py 时至少校验：(1) GET /status 返回结构中含 `status.spot`；(2) 含 account 相关字段或 accounts_fetched_at；(3) 可选：在 daemon 运行且已连接 IB 时断言 spot 为合理数值、accounts 有数据。

---

## 当前代码锚点（阶段 3）

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 历史统计（R-H2） | scripts/stats_from_history.py | 只读 status_history、operations；产出按日/周对冲次数、盈亏汇总；可离线运行 |
| 账户摘要 | IBConnector / Store | `get_managed_accounts()`、`get_account_summary(account)`；`Store.set_account_summary`、`get_account_id`、`get_accounts_data` |
| 账户/持仓拉取时机 | gs_trading.py | CONNECTED 时 `_refresh_accounts_data()`；RUNNING 后按 1 小时间隔拉取账户与持仓 |
| 持仓 | IBConnector / Store | `_refresh_positions(account)`，与账户同间隔；供对冲与风控使用 |
| 标的市价 | gs_trading.py / status_current | 每次心跳拉取标的现价并写入 `status_current.spot`；GET /status 的 status.spot 来源于此 |
| GET /status 组装 | servers/ | 从 status_current、accounts、account_positions、daemon_heartbeat 等组装；见 [DATABASE.md](../DATABASE.md) §2.7、§2.8 |
| 刷新账户 | daemon_control | POST /control/refresh_accounts 写入 daemon_control；守护进程消费后拉取账户/持仓并写 DB |
| 断连行为 | gs_trading.py | 进入 WAITING_IB 时不拉取账户/持仓；重连后再次拉取 |

---

## 阶段 3 不包含

- **阶段 4**：R-B1、R-B2 策略框架与回测。
- **阶段 5**：R-C2 暂停/恢复、R-C3 一键平敞口（守护进程侧平仓逻辑未实现；接口已预留）。

---

## 与 PLAN_NEXT_STEPS / PHASE_ASSESSMENT 的对应

- **执行计划文档**：本文档即 `docs/plans/phase3-execution-plan.md`（阶段 3 数据获取），满足 [PHASE_ASSESSMENT.md](PHASE_ASSESSMENT.md)「五、阶段 3 执行计划与验收现状」中建议的 phase3-execution-plan。
- **验收依据**：阶段 3 验收以本文档「验收清单」+ [PLAN_NEXT_STEPS 阶段 3](../PLAN_NEXT_STEPS.md#阶段-3数据获取账户持仓市值交易历史与统计) 的验证标准与 TC 清单为准；通过后更新 PLAN_NEXT_STEPS 中阶段 3 的**验收完成时间**与**项目里程碑时间线**。
