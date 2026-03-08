# Portfolio menu → page mapping

Each secondary item under the **Portfolio** menu is implemented in its own page file and rendered by a single page component:

| Menu label      | View id   | Page component    | File                  |
|-----------------|-----------|-------------------|------------------------|
| Accounts        | `accounts`| `AccountsPage`    | `AccountsPage.tsx`     |
| Positions       | `open`    | `PositionsPage`   | `PositionsPage.tsx`    |
| Performance     | `performance` | `PerformancePage` | `PerformancePage.tsx` |
| Trade History   | `ledger`  | `TradeHistoryPage`| `TradeHistoryPage.tsx`|
| Transfer & Pay  | `transfer`| `TransferPayPage` | `TransferPayPage.tsx`  |

Routing: in `App.tsx`, when `activeTab === 'replay'`, `portfolioView` selects which page is rendered.

Note: Trade History UI (ledger view) is currently implemented inside `PositionsPage.tsx`; `TradeHistoryPage` renders it via `<PositionsPage currentView="ledger" />`. To make the implementation fully self-contained in `TradeHistoryPage.tsx`, the ledger section would need to be moved out of PositionsPage (e.g. with a shared `replayShared.ts` for helpers).
