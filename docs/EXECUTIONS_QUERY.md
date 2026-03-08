# GET /executions 查询说明

点击日历某一天时，前端会请求该日的执行记录。**按“服务器日历日”**（America/Chicago）计算时间范围，与服务器/DB 时区一致。

## Trade History（Ledger）背后用的 Query

- **前端**：`PositionPnlPage` 的 Trade History 调用 `fetchExecutions(undefined, undefined, 0)`，即 **不传** `since_ts` / `until_ts`，传 `limit=0` 表示**不限制条数**。
- **API**：`GET /executions?limit=0`
- **后端**：`limit=0` 时视为无限制，`reader.get_executions(..., limit=None)` 不加 LIMIT，返回**全部**匹配记录。

等价 SQL（Trade History 实际用的就是这条）：

```sql
SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
       e.symbol, e.sec_type, e.side, e.quantity, e.price,
       c.commission, e.source,
       e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
       c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra
FROM account_executions e
LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
ORDER BY e.exec_time DESC NULLS LAST;
```

当 `limit=0` 时不加 `LIMIT` 子句，返回全部记录。因此 Trade History 会显示库里**所有**执行记录（仍按 exec_time 倒序）。若某条仍不显示，可检查前端 Ledger 的 Symbol/Expiry 等过滤条件。

## 取当天交易记录和配对记录在哪里？Query 长什么样？（一条窗口 SQL + 一条按时间）

- **代码位置**：`servers/reader.py` 的 `get_executions`（按时间取当天）、`get_executions_with_opt_pairs_single_query`（一条 CTE+窗口 SQL）、`get_executions_with_opt_pairs`（串联并做配对）。
- **第一条**：按时间取当天 executions（见下方「后端 SQL（第一条）」）。
- **第二条（一条 SQL）**：CTE day_keys = 当天 OPT 的 (symbol, expiry, strike, account_id) 去重；all_legs = 这些合约的全部 OPT 腿（不限日期）+ in_selected_day、side_norm（BUY/SELL）；numbered = ROW_NUMBER() 按 side_norm 得 opt_pair_rn。配对为 BUY↔SELL（同一合约方向相反）。范围仅限「当天有 OPT 的合约」，不会过大。

## 为什么用服务器（Chicago）时间？

服务器在 Chicago 时间，`exec_time` 存的是 Chicago（CST/CDT）。前端固定用 **America/Chicago** 计算“某日”的 00:00～23:59 再转成 Unix 传给 API，这样无论用户浏览器在哪，点 3/6 看到的都是“Chicago 的 3/6”这一天的记录。

## API 请求

- **URL**: `GET /executions`
- **Query 参数**:
  - `since_ts`: 该日 **America/Chicago** 00:00:00 的 Unix 秒
  - `until_ts`: 该日 **America/Chicago** 23:59:59 的 Unix 秒
  - `account_id`: 可选
  - `limit`: 前端单日请求传 500
  - `include_opt_pairs`: 可选，为 `true` 时后端做 BUY↔SELL 配对，返回 `opt_pairs` 且每条 execution 带 `paired_execution_ids`

## 后端 SQL（第一条：reader.get_executions）

```sql
SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
       e.symbol, e.sec_type, e.side, e.quantity, e.price,
       c.commission, e.source,
       e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
       c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra
FROM account_executions e
LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
WHERE extract(epoch from e.exec_time) >= %s
  AND extract(epoch from e.exec_time) <= %s
  -- AND e.account_id = %s  仅当 API 传入 account_id 时加上
ORDER BY e.exec_time DESC NULLS LAST
LIMIT %s
```

## 后端 SQL（第二条：一条 CTE + 窗口，reader.get_executions_with_opt_pairs_single_query）

范围仅限「当天有 OPT 的合约」的全部 OPT 腿，带 in_selected_day、opt_pair_rn；配对按 **side**（BUY↔SELL），与 option_right 无关。

```sql
WITH day_keys AS (
  SELECT DISTINCT e.symbol, e.expiry, COALESCE(e.strike::text,'') AS strike_s, e.account_id
  FROM account_executions e
  WHERE extract(epoch from e.exec_time) >= %s AND extract(epoch from e.exec_time) <= %s
    AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    -- AND e.account_id = %s  可选
),
all_legs AS (
  SELECT e.id, ..., extract(epoch from e.exec_time) AS time, ...,
         (extract(epoch from e.exec_time) >= %s AND extract(epoch from e.exec_time) <= %s) AS in_selected_day,
         upper(trim(COALESCE(e.side,''))) AS side_norm
  FROM account_executions e
  INNER JOIN day_keys k ON e.symbol = k.symbol AND e.expiry = k.expiry
    AND COALESCE(e.strike::text,'') = k.strike_s AND e.account_id = k.account_id
  LEFT JOIN account_execution_commissions c ON ...
  WHERE upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
),
numbered AS (
  SELECT all_legs.*,
         ROW_NUMBER() OVER (PARTITION BY symbol, expiry, strike, account_id, side_norm ORDER BY time ASC NULLS LAST) AS opt_pair_rn
  FROM all_legs WHERE side_norm IN ('BUY', 'SELL')
)
SELECT * FROM numbered ORDER BY time ASC NULLS LAST LIMIT %s
```

## 条件小结

| 条件 | 说明 |
|------|------|
| **exec_time** | 必须落在 `[since_ts, until_ts]`；前端按 **America/Chicago** 的该日 00:00～23:59 计算该范围，与服务器/DB 时区一致 |
| **account_id** | API 传了才过滤；Performance 页点某日时**不传**，即查所有账户 |
| **limit** | 单日请求用 500；该范围内记录超过 500 条时只返回按时间 **DESC** 的前 500 条 |

## 前端展示的额外过滤

- **“All Option executions on this day”** 表格只显示 **sec_type = 'OPT'** 的行。
- API 返回的 STK、FOP 等类型不会出现在该表格中。
- 若 API 返回 10 条、只有 2 条是 OPT，则表格只显示 2 条；其余 8 条可在 DB 里用下面等价 SQL 核对。

## 在库里核对 2026-03-06（-0600 示例）

若 DB 存的是带时区的时间（如 -0600），按**本地日**等价于“3/6 00:00 -0600 ～ 3/6 23:59:59 -0600”：

```sql
-- 3/6 在 -0600 的范围内（PostgreSQL 用 AT TIME ZONE 转成 timestamptz 再比）
SELECT id, account_id, exec_time, symbol, sec_type, side, quantity, price
FROM account_executions
WHERE exec_time >= '2026-03-06 00:00:00'::timestamp AT TIME ZONE 'America/Chicago'
  AND exec_time <  '2026-03-07 00:00:00'::timestamp AT TIME ZONE 'America/Chicago'
ORDER BY exec_time DESC
LIMIT 500;
```

或直接用 UTC 边界（3/6 00:00 -0600 = 3/6 06:00 UTC，3/6 23:59 -0600 = 3/7 05:59 UTC）：

```sql
SELECT id, account_id, exec_time, symbol, sec_type, side, quantity, price
FROM account_executions
WHERE exec_time >= '2026-03-06 06:00:00+00'
  AND exec_time <  '2026-03-07 06:00:00+00'
  AND (sec_type IS NULL OR upper(trim(sec_type)) = 'OPT')
ORDER BY exec_time DESC
LIMIT 500;
```

若库里 OPT 行数多于页面上的 2 条，请检查：
1. **sec_type**：是否都是 `OPT`（有无空格、大小写）。
2. **exec_time 时区**：是否按 UTC 存；若按本地时间存，同一“日历日”可能落在不同 UTC 日。
3. **account_id**：页面未按账户过滤，若有多账户，应都能看到。

---

## 在库里查 NVDA strike 190（找不到记录时用）

Trade History 只请求最近 100 条（无时间范围），若 NVDA 190 不在其中，可在库里直接查：

```sql
-- 所有 NVDA、strike=190 的执行记录（不限时间）
SELECT id, account_id, exec_time, symbol, sec_type, side, quantity, price,
       expiry, strike, option_right, contract_key
FROM account_executions
WHERE upper(trim(symbol)) = 'NVDA'
  AND (strike = 190 OR strike = 190.0)
ORDER BY exec_time DESC;
```

若结果为空，说明库里没有 symbol=NVDA 且 strike=190 的行；若有结果但 Trade History 里看不到，说明这些记录的 exec_time 较旧，不在“最近 100 条”内，可考虑前端增大 limit 或加按 symbol/strike 的过滤。

---

## BUY↔SELL 配对逻辑（后端实现，一条窗口 SQL + 一条按时间）

点击某一天时，前端请求 **GET /executions?include_opt_pairs=true**。后端会：

1. **按时间取当天**：`get_executions(since_ts, until_ts)` → 当天全部类型的 executions。
2. **一条窗口 SQL**：`get_executions_with_opt_pairs_single_query` 用 CTE day_keys → all_legs（带 side_norm=BUY/SELL）→ numbered（按 side_norm 的 ROW_NUMBER），只拉「当天有 OPT 的合约」的全部 OPT 腿；配对为 **BUY↔SELL**（同一 symbol/expiry/strike/account_id，方向相反）。
3. **配对**：对上述结果在内存里做 BUY↔SELL 配对（同 opt_pair_rn 的 BUY 与 SELL FIFO 配对），得到 opt_pairs 和 pair_map；给当天 executions 挂上 paired_execution_ids。
4. **返回**：executions（当天）+ opt_pairs。

前端用 `opt_pairs` 渲染「Counted as Realized」表格；若无 `opt_pairs` 则退化为前端 computeOptPairsFromExecutions。

---

## Match 的 account_executions 查找逻辑（以及 id=1287 查不到时怎么试）

### 后端配对键（reader._compute_opt_pair_map_and_pairs）

- **分组键**：`(symbol, expiry, strike, account_id)`。注意：**没有** `option_right`（C/P），同一 strike 下的 CALL 和 PUT 会在同一组里。
- **配对规则**：同一组内按 `exec_time` 升序，BUY 与 SELL **FIFO 配对**（一条 BUY 配一条 SELL，方向相反即可）。
- **day_keys 范围**：只取「当天有 OPT 的合约」的 `(symbol, expiry, strike, account_id)`，再拉这些键的**全部 OPT 腿**（可跨日）做配对。

所以若 id=1287（NVDA 20260306 190 CALL）找不到 Match，可能原因包括：
1. **account_id**：该条或配对腿的 `account_id` 为空/不一致，导致不在同一 group。
2. **时间范围**：当天请求的 since_ts/until_ts 下，没有把 1287 所在合约算进 day_keys（例如 1287 不在当天、或当天该合约没有 OPT），则 all_legs 里没有该合约的腿，自然配不上。
3. **同组对腿**：同 (symbol, expiry, strike, account_id) 下没有**反向**的 BUY/SELL 可与 1287 配对（数量或顺序导致）。

### 在库里试：id=1287 的「配对腿」候选（与当前后端一致）

下面 SQL：先取 id=1287 的 symbol/expiry/strike/account_id/side，再找**同 (symbol, expiry, strike, account_id)、反向 side、OPT** 的其它 execution，即**当前后端逻辑**下可能和 1287 配成一对的候选（不含 option_right）。

```sql
-- 1) 看 id=1287 这条本身
SELECT id, account_id, exec_time, symbol, sec_type, side, quantity, price,
       expiry, strike, option_right, contract_key
FROM account_executions
WHERE id = 1287;

-- 2) 与当前后端一致：同 symbol, expiry, strike, account_id，反向 side，OPT → 配对腿候选
WITH base AS (
  SELECT id, account_id, symbol, expiry, strike, side
  FROM account_executions
  WHERE id = 1287
)
SELECT e.id, e.account_id, e.exec_time, e.symbol, e.sec_type, e.side, e.quantity, e.price,
       e.expiry, e.strike, e.option_right, e.contract_key
FROM account_executions e
JOIN base b
  ON e.symbol IS NOT DISTINCT FROM b.symbol
 AND e.expiry IS NOT DISTINCT FROM b.expiry
 AND COALESCE(e.strike::text, '') = COALESCE(b.strike::text, '')
 AND COALESCE(e.account_id, '') = COALESCE(b.account_id, '')
 AND upper(trim(COALESCE(e.side, ''))) != upper(trim(COALESCE(b.side, '')))
WHERE e.id != 1287
  AND upper(trim(COALESCE(e.sec_type, ''))) = 'OPT'
ORDER BY e.exec_time ASC NULLS LAST;
```

若第 2 段查不到行，说明库里**没有**与 1287 同 (symbol, expiry, strike, account_id) 且反向 side 的 OPT 记录，所以后端不会产生包含 1287 的 Match。

### 若希望「同 Symbol, expiry, strike, rights, account_id」才配对（含 option_right）

若你希望只有**同一 option_right（CALL 对 CALL、PUT 对 PUT）**才算配对腿，可以用下面查询（与当前后端不一致，仅供核对数据）：

```sql
-- 同 symbol, expiry, strike, option_right, account_id，反向 side → 配对腿候选（含 rights）
WITH base AS (
  SELECT id, account_id, symbol, expiry, strike, option_right, side
  FROM account_executions
  WHERE id = 1287
)
SELECT e.id, e.account_id, e.exec_time, e.symbol, e.sec_type, e.side, e.quantity, e.price,
       e.expiry, e.strike, e.option_right, e.contract_key
FROM account_executions e
JOIN base b
  ON e.symbol IS NOT DISTINCT FROM b.symbol
 AND e.expiry IS NOT DISTINCT FROM b.expiry
 AND COALESCE(e.strike::text, '') = COALESCE(b.strike::text, '')
 AND upper(trim(COALESCE(e.option_right, ''))) = upper(trim(COALESCE(b.option_right, '')))
 AND COALESCE(e.account_id, '') = COALESCE(b.account_id, '')
 AND upper(trim(COALESCE(e.side, ''))) != upper(trim(COALESCE(b.side, '')))
WHERE e.id != 1287
  AND upper(trim(COALESCE(e.sec_type, ''))) = 'OPT'
ORDER BY e.exec_time ASC NULLS LAST;
```

- 若**第 2 段（当前后端逻辑）**有结果而 **Performance 页仍没有 Match**：多半是**当天请求的时间范围**没有覆盖 1287，或 limit 截断导致 1287/配对腿未进当天的 executions 或 day_keys。
- 若**第 2 段**无结果、**第 3 段（含 option_right）**有结果：说明库里存在「同 symbol/expiry/strike/account_id、同 option_right、反向 side」的腿，但当前后端**没有**按 option_right 分组，若需要 CALL-only 配对，需在后端把分组键改为含 option_right。
