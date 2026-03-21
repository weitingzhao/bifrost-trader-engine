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

Trade ledger has four top-level tabs: **Strategy | Instance | Options | Stocks**. **Strategy** groups option trades from `account_executions_final` by `strategy_opportunity_id` (unassigned → “No opportunity”), then **nested by `strategy_instance_id`** (unassigned → “No instance” under that opportunity). Per-instance `instance_allocations` are expanded with the same pro-rata qty/PnL as the Instance tab; contract groups are built **per instance** under each opportunity. **Instance** groups by whether they have attribution via `strategy_instance_id` **or** `instance_allocations` (With instance — collapsed per-instance groups). Contract/PnL aggregates under each instance use **per-instance allocated quantity** and pro-rata PnL/commission when splits exist (`sliceExecutionForInstanceOptView`). Open vs closed contract rows are derived from **net quantity per contract** in `buildOptExecutionGroups`: **absolute quantity with `side`** (compatible with signed reader qty and with positive qty + side). Per-instance slices use allocation-weighted rows (`sliceExecutionForInstanceOptView`) before grouping. Rows with neither go to No instance (Closed/Open sub-tabs). Options shows the full Closed/Open view. Stocks uses canonical executions. Grouping is mostly frontend; GET /executions returns `instance_allocations` where present.
