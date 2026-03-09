# Flex Web Service 配置与资金流水（Performance Phase 0）

## 配置模型：Token 在 settings，flex_accounts 一行双 Query ID

- **Token**：存于 **settings** 表两列：**ib_flex_host_token**（主 IB）、**ib_flex_secondary_token**（第二 IB）。不在 flex_accounts 中重复存储。
- **flex_accounts**：仅存「Query 行」：每行同一 **Label / Purpose**，对应 **query_host_id**（Host IB 的 Flex Query ID，必填）、**query_secondary_id**（第二 IB 的 Query ID，可选）。同一用途下系统每次对 Host 与 Secondary **各 call 一次**，拿回相同结构的 response。
- **purpose**：用途标识，如 `cash_transactions`（资金流水）、`trades`（成交）。**POST /transactions/fetch** 仅使用 `purpose = cash_transactions` 的行；`get_flex_config(purpose='cash_transactions')` 返回 `(token, query_id)` 扁平列表，对 Host 与 Secondary 各 call。

### Settings 页（推荐）

在 **Settings → IB Connection → Flex** 中配置：

- **Host token**、**Secondary token**：对应 settings 的 ib_flex_host_token、ib_flex_secondary_token。
- **每一行**：**Query ID (Host)**（必填）、**Query ID (Secondary)**（可选）、**Query Label**（可选）、**Purpose**（Cash Transactions / Trades）。同一行表示同一种 Flex 查询，Fetch 时两个 Query 都会调用。
- 数据写入 **settings**（两 token）与 **flex_accounts**（行，见 [DATABASE.md](DATABASE.md) §2.23、§2.9）。

## 使用

1. **拉取资金流水**：调用 **POST /transactions/fetch**（Transfer & Pay 页「Fetch from IB」）。
   - 仅使用 **purpose = cash_transactions** 的配置行；每行根据 query_host_id / query_secondary_id 与 settings 中的 token 得到 (token, query_id) 列表，对 Host 与 Secondary **各 call 一次**。
   - **不传日期**：默认请求 **从今天起往前 365 天**（to_date=今天，from_date=今天−365），并显式传 fd/td 给 Flex，保证每次都是“最近 365 天”的数据。
   - **传日期**：body 可带 `{"from_date": "yyyymmdd", "to_date": "yyyymmdd"}` 覆盖；**起止日期间隔不得超过 366 天**（IB 限制）。需要更长区间时分多次请求（例如按年或按 365 天分段）。
2. **Performance 页**：GET /performance 从 `account_transactions` 汇总 **net_cash_flow**（可按 account_id 筛选），并返回 **transaction** 与 **transactions** 明细。

## 表与 API

- 表结构见 [DATABASE.md](DATABASE.md) §2.21（account_transactions）、§2.23（flex_accounts）、§2.9（settings：ib_flex_host_token、ib_flex_secondary_token）。
- **flex_accounts** 与 **account_transactions** 均存于同一 PostgreSQL（config 的 `postgres`）；Token 存于 **settings**，flex_accounts 为「一行双 Query ID」配置，account_transactions 为拉取后写入的流水。
- 唯一约束 `(account_id, ts, amount, type)` 用于 account_transactions 去重；多账户拉取时同一账户不会重复计入。
