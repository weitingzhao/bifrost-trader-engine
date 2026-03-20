# Portfolio menu → page mapping

Each secondary item under the **Portfolio** menu is implemented in its own page file and rendered by a single page component. The header dropdown groups them as **Overview** (Accounts, Positions, Performance) and **Activity & cash** (Trade ledger, Transfer & Pay).

| Menu label      | View id   | Page component    | File                  |
|-----------------|-----------|-------------------|------------------------|
| Accounts        | `accounts`| `AccountsPage`    | `AccountsPage.tsx`     |
| Positions       | `open`    | `PositionsPage`   | `PositionsPage.tsx`    |
| Performance     | `performance` | `PerformancePage` | `PerformancePage.tsx` |
| Trade ledger    | `ledger`  | `TradeHistoryPage`| `TradeHistoryPage.tsx`|
| Transfer & Pay  | `transfer`| `TransferPayPage` | `TransferPayPage.tsx`  |

Routing: in `App.tsx`, when `activeTab === 'replay'`, `portfolioView` selects which page is rendered.

Note: Trade ledger UI is implemented in `LedgerView`; `TradeHistoryPage` hosts it. Older notes referred to Trade History as the same `ledger` route.

Trade ledger has three top-level tabs: **Instance | Options | Stocks**. Instance groups option trades from `account_executions_final` by whether they have a `strategy_instance_id` (With instance — collapsed per-instance groups) or not (No instance — Closed/Open sub-tabs). Options shows the full Closed/Open view. Stocks uses canonical executions. This is a frontend-only grouping; no additional API is involved.
