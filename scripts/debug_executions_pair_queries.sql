-- 在库里直接执行：一条 SQL（CTE + 窗口函数）取出「当天有 OPT 的合约」的全部 OPT 腿，
-- 并标 in_selected_day、opt_pair_rn。配对按 side：BUY↔SELL（同一合约方向相反）。范围仅限当天出现过的合约键。
--
-- 用法：把下面 since_ts / until_ts 换成 3/6 的 Unix 秒（或直接用时间字面量），
--       在 DBeaver / psql 中执行。
--
-- 3/6 America/Chicago 00:00 与 3/7 00:00 的 Unix 秒（示例，需按实际时区算）：
-- 可先用：SELECT extract(epoch from '2026-03-06 00:00:00'::timestamp AT TIME ZONE 'America/Chicago');
--        SELECT extract(epoch from '2026-03-07 00:00:00'::timestamp AT TIME ZONE 'America/Chicago');

WITH day_range AS (
  SELECT
    extract(epoch from '2026-03-06 00:00:00'::timestamp AT TIME ZONE 'America/Chicago') AS since_ts,
    extract(epoch from '2026-03-07 00:00:00'::timestamp AT TIME ZONE 'America/Chicago') AS until_ts
),
day_keys AS (
  SELECT DISTINCT e.symbol, e.expiry, COALESCE(e.strike::text,'') AS strike_s, e.account_id
  FROM account_executions e
  CROSS JOIN day_range d
  WHERE extract(epoch from e.exec_time) >= d.since_ts AND extract(epoch from e.exec_time) < d.until_ts
    AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
),
all_legs AS (
  SELECT e.id, e.account_id, e.exec_time, e.symbol, e.sec_type, e.side, e.quantity, e.price,
         e.expiry, e.strike, e.option_right,
         (extract(epoch from e.exec_time) >= (SELECT since_ts FROM day_range)
          AND extract(epoch from e.exec_time) < (SELECT until_ts FROM day_range)) AS in_selected_day,
         upper(trim(COALESCE(e.side,''))) AS side_norm
  FROM account_executions e
  INNER JOIN day_keys k ON e.symbol = k.symbol AND e.expiry = k.expiry
    AND COALESCE(e.strike::text,'') = k.strike_s AND e.account_id = k.account_id
  WHERE upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
),
numbered AS (
  SELECT all_legs.*,
         ROW_NUMBER() OVER (PARTITION BY symbol, expiry, strike, account_id, side_norm ORDER BY extract(epoch from exec_time) ASC NULLS LAST) AS opt_pair_rn
  FROM all_legs
  WHERE side_norm IN ('BUY', 'SELL')
)
SELECT * FROM numbered ORDER BY extract(epoch from exec_time) ASC NULLS LAST;

-- =============================================================================
-- Trade History 只拉最近 100 条（无 since_ts/until_ts）。找 NVDA strike 190 用下面：
-- =============================================================================
-- SELECT id, account_id, exec_time, symbol, sec_type, side, quantity, price,
--        expiry, strike, option_right, contract_key
-- FROM account_executions
-- WHERE upper(trim(symbol)) = 'NVDA'
--   AND (strike = 190 OR strike = 190.0)
-- ORDER BY exec_time DESC;
