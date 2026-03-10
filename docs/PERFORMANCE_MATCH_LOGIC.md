# Performance page: Match / Realized logic

This doc explains how **Match** (R) and **Realized** are determined, and where to check when the page shows only Unrealized.

---

## 1. Backend: from data to `opt_pairs`

### Step 1 – Query 1 (`get_executions`)

- **Filter**: `trade_date` in `[since_date, until_date]` (from since_ts/until_ts in Chicago).
- **Result**: `day_executions` = all rows (STK + OPT) in that date range.

### Step 2 – Query 2 (`get_executions_with_opt_pairs_single_query`)

- **Filter**: Same `trade_date` range; only OPT.
- **CTEs**:
  - `day_keys`: distinct (symbol, expiry, strike, account_id) of OPT rows in that range.
  - `all_legs`: all OPT legs for those keys, still in same `trade_date` range; each row has `time` (exec_time epoch), `trade_date`, and other columns.
  - `numbered`: same legs with `opt_pair_rn` (FIFO within BUY/SELL per contract).
- **Result**: list of OPT legs (with `time`, `trade_date`, etc.).

### Step 3 – Pairing (`_compute_opt_pair_map_and_pairs(all_legs)`)

- **Group** by `(symbol, expiry, strike, account_id)`; only OPT with `side` in BUY/SELL.
- **Sort** each group by `time` (exec_time epoch) ascending.
- **FIFO match**:
  - **BUY**: matched only with **past SELLs** in the same group (already in `sell_queue`).
  - **SELL**: matched only with **past BUYs** in the same group (already in `buy_queue`).
- **Output**: `opt_pairs` = list of pairs, each with:
  - `leg_c_execution_id` = earlier leg (open),
  - `leg_p_execution_id` = later leg (close),
  - `symbol`, `expiry`, `strike`, `account_id`, `quantity`, `c_side`, `c_price`, `p_side`, `p_price`, `commission`, `net_pnl`.

So a **Match** exists only when, for the same contract, there is both a BUY and a SELL and they are matched in time order.

### Step 4 – Filter pairs by `trade_date` (Python)

- Build `id_to_trade_date`: for each leg in `all_legs`, use `trade_date`; if missing, derive date from `time` (exec_time) in America/Chicago.
- **filtered_pairs** = only pairs where **both** legs have `trade_date` in `[since_date, until_date]`.
- If a leg has no `trade_date` and derivation from `time` fails, that leg is not in `id_to_trade_date` → the pair is **dropped** (not returned).
- API returns: `{ "executions": day_executions, "opt_pairs": filtered_pairs }`.

---

## 2. Frontend: from `opt_pairs` to Realized / Unrealized

### When you click a day (e.g. 2026-03-06)

1. **dayExecs** = executions with `executionDateStr(e) === selectedDay` (i.e. `trade_date === '2026-03-06'` or fallback from time).
2. **relevantPairs** = `opt_pairs` where **at least one leg** has `executionDateStr(leg) === selectedDay` (i.e. that leg’s date is 2026-03-06).
3. **computeDayRealizedUnrealized(dayExecs, relevantPairs, execById)**:
   - For each contract (symbol/expiry/strike/account):
     - **pairedExecIds** = all `leg_c_execution_id` and `leg_p_execution_id` from `relevantPairs` for that contract.
     - **unmatchedExecs** = executions in that contract whose `id` is **not** in `pairedExecIds`.
     - **Realized** = sum of `net_pnl` of the pairs (+ PnL of unmatched if needed by your logic; in code, group PnL is `unmatchedExecs` PnL + sum of pair `net_pnl`; if there are pairs, the group is counted as realized).
     - **Unrealized** = PnL from executions that are not in any pair (or the complementary part).
   - If **relevantPairs** is empty for that day → no paired IDs → all executions are “unmatched” → all show as **Unrealized**.

So the page shows **only Unrealized** when either:

- Backend returns **no** (or too few) pairs in `opt_pairs`, or  
- Frontend keeps only **relevantPairs** for the selected day and that list is empty.

---

## 3. Where to check when everything is Unrealized

### A. Backend: is `opt_pairs` empty?

1. **Any pairs at all?**  
   - In `_compute_opt_pair_map_and_pairs`: pairing needs both BUY and SELL in the same (symbol, expiry, strike, account_id).  
   - If for every contract you only have BUYs or only SELLs, `opt_pairs` will be empty.

2. **Pairs dropped by `trade_date`?**  
   - If a leg has **NULL `trade_date`** and the fallback (date from `time` in Chicago) fails, that leg is not in `id_to_trade_date` and any pair containing it is dropped.  
   - **Check**: run Query 2 and look at `trade_date` and `time` for each row. Ensure either `trade_date` is set or `time` is valid so the fallback can run.  
   - Backend was updated so that when `trade_date` is NULL, it derives the date from `time` (Chicago); that reduces drops for legacy rows.

3. **Pair filter by date range**  
   - Only pairs whose **both** legs have `trade_date` (or derived date) in `[since_date, until_date]` are kept.  
   - If one leg is outside that range, the pair is not returned.

### B. Frontend: is `relevantPairs` empty for that day?

- **relevantPairs** = backend `opt_pairs` filtered to pairs where **at least one leg** has `executionDateStr(leg) === selectedDay`.  
- `executionDateStr(leg)` uses `trade_date` first; if missing, uses Chicago date from `time`.  
- So for 2026-03-06 you need at least one leg in each pair to have `trade_date === '2026-03-06'` (or that date from `time`).  
- If **all** pairs have both legs on other days (e.g. 2026-03-05), then for 2026-03-06 `relevantPairs` will be empty → everything Unrealized for that day.

### C. Quick checks

1. **Network**: Response of `GET /executions?since_ts=...&until_ts=...&include_opt_pairs=true` → is `opt_pairs` non-empty?
2. **Database**:  
   - For OPT rows in the window, do you have both BUY and SELL for the same (symbol, expiry, strike, account_id)?  
   - Is `trade_date` (or at least `exec_time`) populated so the backend can build pairs and dates?
3. **Frontend**: For the selected day, does the response contain pairs where at least one leg’s date (by `executionDateStr`) is that day? If not, that day will show only Unrealized.

---

## 4. Summary

- **Match** = same contract (symbol/expiry/strike/account), BUY and SELL matched in time order (FIFO), both legs in the requested trade_date range.  
- **Realized** on the page = PnL from those pairs that have at least one leg on the selected day.  
- **All Unrealized** usually means: no pairs returned for that day, or no pair has a leg on the selected day; check backend `opt_pairs` and frontend `relevantPairs` and the data (sides, `trade_date`/`time`) as above.
