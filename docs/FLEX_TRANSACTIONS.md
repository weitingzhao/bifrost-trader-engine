# Flex Web Service 配置与资金流水（Performance Phase 0）

## 配置

每个 IB 账户下可配置**多种用途的 Query ID**（例如 Cash Transactions、日后可能的 Trades 等）。当前仅使用「资金流水」用途，对应字段为 **query_id_cash_transactions**（Flex Activity Query 中勾选 Cash Transactions 节）。

### config.yaml（推荐）

- **多账户**：`flex.accounts` 为列表，每项一个 IB 账户的 `token` 与各用途的 Query ID；**query_id_cash_transactions** 用于拉取资金流水。示例：
  ```yaml
  flex:
    accounts:
      - token: "2262495377602963850000"
        query_id_cash_transactions: "1427948"
      - token: "<第二个IB的Token>"
        query_id_cash_transactions: "<该账户的Cash Transactions Query ID>"
        # 日后可增加：query_id_trades: "..." 等
  ```
- **单账户（兼容）**：若不写 `accounts` 或列表为空，则使用顶层 `flex.token` 与 `flex.query_id_cash_transactions`（或旧字段 `query_id`）作为唯一一条配置。
- **环境变量**：`IB_FLEX_TOKEN`、**IB_FLEX_QUERY_ID_CASH_TRANSACTIONS**（或旧名 `IB_FLEX_QUERY_ID`）仅覆盖第一个账户的对应项。

Token 与 Query ID 不在数据库中存储，仅通过 config 或环境变量传入。

## 使用

1. **拉取资金流水**：调用 **POST /transactions/fetch**。
   - **不传日期**：默认请求 **从今天起往前 365 天**（to_date=今天，from_date=今天−365），并显式传 fd/td 给 Flex，保证每次都是“最近 365 天”的数据。
   - **传日期**：body 可带 `{"from_date": "yyyymmdd", "to_date": "yyyymmdd"}` 覆盖；**起止日期间隔不得超过 366 天**（IB 限制）。需要更长区间时分多次请求（例如按年或按 365 天分段）。
2. **Performance 页**：GET /performance 从 `account_transactions` 汇总 **net_cash_flow**（可按 account_id 筛选），并返回 **transaction** 与 **transactions** 明细。

## 表与 API

- 表结构见 [DATABASE.md](DATABASE.md) §2.21。
- 唯一约束 `(account_id, ts, amount, type)` 用于去重；多账户拉取时同一账户不会重复计入。
