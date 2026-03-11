# Live 页 Market Streams 过滤逻辑与数据来源

## 1. 列表来源（Symbol 列表）

Market Streams 表格中的 **Symbol 列表** 是以下三部分的 **并集**（去重、排序）：

| 来源 | 说明 |
|------|------|
| **Watchlist** | 后台 `GET /status` 返回的 `subscribed_tickers`（来自 Watchlist 的 STK + 策略标的） |
| **Primary 持仓** | 在 **Settings → IB Connection → Stream Accounts → Primary** 中配置的 account_id 下，当前 **持仓表里 STK、数量非 0** 的 symbol |
| **Secondary 持仓** | 在 **Settings → IB Connection → Stream Accounts → Secondary** 中配置的 account_id 下，当前 **持仓表里 STK、数量非 0** 的 symbol |

即：**Stream 列表 = Watchlist ∪ Primary 账户持仓 symbol ∪ Secondary 账户持仓 symbol**。

## 2. 持仓数据从哪里来

- Live 页使用的 `status.accounts` 来自 **GET /status**。
- 后台 `get_status` 里 `payload["accounts"] = reader.get_accounts_from_tables()`，即 **从数据库** 读取 `accounts` 与 `account_positions` 表。
- 数据库里的账户/持仓是由 **Refresh accounts** 写进去的：  
  **Status 页（或其它入口）** 调用 **POST /control/refresh_accounts** → 监控端用 **AccountIbClient（Host IB）** 拉取主 TWS 的账户与持仓，若配置了 **第二 IB**（Settings 里 `ib2_host` 非空），还会用 **AccountIbClient2** 拉取第二 TWS 的账户与持仓，合并后写入 DB。

因此：

- **Secondary 要出现在 Live 上，必须**：  
  1. Settings 里配置了 **第二 IB**（`ib2_host` 等），这样监控会创建 `account_ib_client_2`；  
  2. 至少执行过一次 **Refresh accounts**，把第二 IB 的账户/持仓拉下来并写入 DB；  
  3. **Stream Accounts → Secondary** 里填的 account_id，与第二 IB 返回并写入 DB 的 **account_id 一致**（比较时已做 trim + 忽略大小写）。

## 3. Account 列（每行属于哪个 Stream 账户）

对表格里每一个 symbol，会看 **当前持仓** 里该 symbol 出现在哪些 account_id 上，再和 Settings 里的 Primary/Secondary 做匹配（trim + 忽略大小写）：

- **Primary**：仅匹配到 Stream Primary account_id；
- **Secondary**：仅匹配到 Stream Secondary account_id；
- **Both**：同时匹配到 Primary 和 Secondary；
- **Wishlist**：没有匹配到任一 Stream 账户（即只在 Watchlist 里，或只在其它未配置为 Stream 的账户里有持仓）。

## 4. 前端过滤（Account 下拉）

- **All**：显示全部行；
- **Primary**：只显示 `streamCategory === 'primary'` 的行；
- **Secondary**：只显示 `streamCategory === 'secondary'` 的行；
- **Wishlist**：只显示 `streamCategory === null` 的行。

## 5. Secondary 持仓不显示的常见原因

1. **未配置第二 IB**  
   Settings → IB Connection 里 **Second IB** 的 Host 未填，则不会创建 `account_ib_client_2`，Refresh accounts 只会拉主 TWS，DB 里没有 Secondary 账户。

2. **未执行 Refresh accounts**  
   配置了第二 IB 后，需要至少执行一次 **Refresh accounts**（例如在 Status 页或 Accounts 页），才会把第二 TWS 的账户/持仓写入 DB；否则 `status.accounts` 里没有 Secondary 账户。

3. **Stream Secondary account_id 与 DB 不一致**  
   Settings → Stream Accounts → Secondary 填的必须和第二 IB 实际返回的 account_id 一致（例如 TWS 显示 `DU12345`，就填 `DU12345`）。前端已用 **trim + 忽略大小写** 比较，空格或大小写不会导致不匹配；但 ID 本身必须一致。

4. **第二 IB 连接失败**  
   Refresh accounts 时若 AccountIbClient2 连接失败，只会写入 Host 的账户，Secondary 仍不会进 DB；可查看监控/后台日志确认是否有 `AccountIbClient2` 报错。

## 6. Secondary 持仓具体从哪里取（无单独 Secondary 查询）

**Live 页和 Primary 用的是同一套数据**：`status.accounts` 来自 GET /status，后台用 **同一组查询** 读出「所有账户」及其持仓，没有按 Primary/Secondary 拆成两条查询。

- **读路径**：`servers/reader/accounts.py` 的 `get_accounts_from_tables(conn)`  
  1. 查所有账户：  
     `SELECT account_id, updated_at, net_liquidation, total_cash, buying_power, summary_extra FROM accounts ORDER BY account_id`  
  2. 对上面得到的 **每一个** `account_id`，查该账户持仓：  
     `SELECT ap.account_id, ap.symbol, ap.sec_type, ap.exchange, ap.currency, ap.position, ap.avg_cost, ... FROM account_positions ap ... WHERE ap.account_id = %s ORDER BY ap.contract_key`  
  所以：只要 Secondary 账户在表 `accounts` 里，它的持仓就会在 `account_positions` 里被查出来，和 Primary 一起放进 `status.accounts`。**若选 Secondary 没有记录，说明当前 DB 里要么没有 Secondary 这条 account，要么该 account 下没有 STK 持仓。**

- **写路径（Secondary 如何进 DB）**：只有 **Refresh accounts** 会写：  
  **POST /control/refresh_accounts** →  
  `AccountIbClient.fetch_accounts_snapshot()`（Host TWS）→ 得到列表 1；  
  若 Settings 里配置了第二 IB（`ib2_host` 非空），再 `AccountIbClient2.fetch_accounts_snapshot()`（第二 TWS）→ 得到列表 2；  
  合并为 `accounts_list = 列表1 + 列表2` →  
  `sync_accounts_snapshot_to_db(control_via_db, accounts_list)`（在 `servers/reader/accounts.py`）→  
  内部调用 `_sync_accounts_snapshot_to_tables(conn, accounts_list)`（`src/sink/accounts_sync.py`），对列表中 **每个** account 做：  
  - 写入/更新 `accounts`（按 `account_id` upsert）；  
  - 写入/更新/删除 `account_positions`（按 `account_id` + `contract_key`，并删除该 account 下已不在 snapshot 里的持仓）。  
  因此：**Secondary 账户和其持仓只有在执行过 Refresh accounts 且第二 IB 连接成功时才会出现在 `accounts` / `account_positions`。**

**排查「选 Secondary 没有一条记录」建议**：  
1. 在 **Accounts 页** 或直接看 **GET /status** 的 `accounts` 数组里，是否有一个元素的 `account_id` 与你 Settings 里 **Stream Accounts → Secondary** 填的完全一致（忽略大小写和首尾空格）。  
2. 若没有，说明 DB 里没有该 Secondary 账户 → 检查 Second IB 是否配置、是否执行过 Refresh accounts、第二 IB 是否连接成功（看监控/后台日志）。  
3. 若有该 account 但 `positions` 为空或没有 STK，则 Stream 里选 Secondary 也会是 0 条（前端只统计 STK、数量非 0 的持仓）。
