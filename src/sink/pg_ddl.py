"""Schema and migrations for PostgreSQL sink. Implements docs/DATABASE.md; single entry point _ensure_tables(conn, log=None)."""

import psycopg2

def _ensure_tables(conn, log=None, log_table=None) -> None:
    """Create daemon_auto_status_current, daemon_auto_status_history, daemon_auto_operations if not exist (per DATABASE.md §2).
    If log is callable, it is called with a short step name before each DDL section (for progress/debug).
    If log_table is callable, it is called as log_table(table_name, purpose) before each table is created/updated.
    """
    def _log(msg: str) -> None:
        if callable(log):
            log(msg)
    def _log_table(name: str, purpose: str) -> None:
        if callable(log_table):
            log_table(name, purpose)
    try:
        conn.rollback()
    except Exception:
        pass
    with conn.cursor() as cur:
        _log("daemon_auto_status_current, daemon_auto_status_history, daemon_auto_operations")
        _log_table("daemon_auto_status_current", "Daemon auto-trading current status snapshot (single row)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_auto_status_current (
                daemon_auto_status_current_id integer PRIMARY KEY DEFAULT 1,
                daemon_state text,
                trading_state text,
                symbol text,
                spot double precision,
                bid double precision,
                ask double precision,
                net_delta double precision,
                stock_position integer,
                option_legs_count integer,
                daily_hedge_count integer,
                daily_pnl double precision,
                data_lag_ms double precision,
                config_summary text,
                ts double precision
            )
        """
        )
        _log_table("daemon_auto_status_history", "Daemon auto-trading status snapshot history")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_auto_status_history (
                daemon_auto_status_history_id bigserial PRIMARY KEY,
                daemon_state text,
                trading_state text,
                symbol text,
                spot double precision,
                bid double precision,
                ask double precision,
                net_delta double precision,
                stock_position integer,
                option_legs_count integer,
                daily_hedge_count integer,
                daily_pnl double precision,
                data_lag_ms double precision,
                config_summary text,
                ts double precision
            )
            """
        )
        _log_table("daemon_auto_operations", "Daemon auto-trading operations log")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_auto_operations (
                daemon_auto_operations_id bigserial PRIMARY KEY,
                ts double precision,
                type text,
                side text,
                quantity integer,
                price double precision,
                state_reason text
            )
        """
        )
        _log("daemon_control, daemon_run_status, daemon_heartbeat")
        _log_table("daemon_control", "Daemon control commands (stop, refresh, etc.)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_control (
                id bigserial PRIMARY KEY,
                command text NOT NULL,
                created_at timestamptz DEFAULT now(),
                consumed_at timestamptz
            )
        """
        )
        _log_table("daemon_run_status", "Run suspended flag (single row)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_run_status (
                id integer PRIMARY KEY DEFAULT 1,
                suspended boolean NOT NULL DEFAULT false,
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            """
            INSERT INTO daemon_run_status (id, suspended) VALUES (1, false)
            ON CONFLICT (id) DO NOTHING
        """
        )
        _log_table("daemon_heartbeat", "Daemon heartbeat and IB/subscription status")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_heartbeat (
                id integer PRIMARY KEY DEFAULT 1,
                last_ts timestamptz NOT NULL DEFAULT now(),
                hedge_running boolean NOT NULL DEFAULT false
            )
        """
        )
        cur.execute(
            """
            INSERT INTO daemon_heartbeat (id, last_ts, hedge_running) VALUES (1, now(), false)
            ON CONFLICT (id) DO NOTHING
        """
        )
        _log_table("daemon_open_orders", "R-A5: open/unfilled orders snapshot")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_open_orders (
                id bigserial PRIMARY KEY,
                order_id integer NOT NULL,
                perm_id integer,
                account_id text,
                symbol text,
                sec_type text,
                action text,
                total_quantity numeric,
                filled numeric,
                remaining numeric,
                limit_price numeric,
                status text,
                contract_key text,
                updated_ts timestamptz DEFAULT now()
            )
        """
        )
        _log("settings + ib_client_id columns")
        _log_table("settings", "App settings (IB config, stream accounts, etc.)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id integer PRIMARY KEY DEFAULT 1,
                ib_host text NOT NULL DEFAULT '127.0.0.1',
                ib_port_type text NOT NULL DEFAULT 'tws_paper'
            )
        """
        )
        cur.execute(
            """
            INSERT INTO settings (id, ib_host, ib_port_type) VALUES (1, '127.0.0.1', 'tws_paper')
            ON CONFLICT (id) DO NOTHING
        """
        )
        # 兼容旧库：若存在 ib_client_id_worker 且无 ib_client_id_worker_market，则重命名列
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'ib_client_id_worker')
                   AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'ib_client_id_worker_market')
                THEN
                    ALTER TABLE settings RENAME COLUMN ib_client_id_worker TO ib_client_id_worker_market;
                END IF;
            END $$;
            """
        )
        for col, default in (
            ("ib_client_id_daemon", 1),
            ("ib_client_id_listener", 2),
            ("ib_client_id_account", 100),
            ("ib_client_id_markets", 101),
            ("ib_client_id_worker_market", 500),
        ):
            cur.execute(
                f"ALTER TABLE settings ADD COLUMN IF NOT EXISTS {col} integer DEFAULT {default}"
            )
        cur.execute(
            "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_host_account_id text"
        )
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS stream_host_account_id text")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS stream_secondary_account_id text")
        cur.execute(
            "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib2_host text"
        )
        cur.execute(
            "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib2_port_type text DEFAULT 'tws_paper'"
        )
        for col, default in (
            ("ib2_client_id_listener", 3),
            ("ib2_client_id_account", 102),
        ):
            cur.execute(
                f"ALTER TABLE settings ADD COLUMN IF NOT EXISTS {col} integer DEFAULT {default}"
            )
        # Second IB has no market data subscription; remove column if present (see DATABASE.md §2.9)
        cur.execute("ALTER TABLE settings DROP COLUMN IF EXISTS ib2_client_id_markets")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_host_token text")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_secondary_token text")
        cur.execute("ALTER TABLE settings DROP COLUMN IF EXISTS flex_default_range_preset")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS flex_default_range_days integer DEFAULT 30")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS flex_init_range_days integer DEFAULT 360")
        _log("account, account_positions, instrument_prices")
        _log_table("account", "Account summaries")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account (
                account_id text PRIMARY KEY,
                updated_at timestamptz DEFAULT now(),
                net_liquidation double precision,
                total_cash double precision,
                buying_power double precision,
                summary_extra jsonb
            )
        """
        )
        _log_table("account_positions", "Positions per account")
        # account_positions: (account_id, contract_key) 为主键，无 id；天然按主键 INSERT/UPDATE，仅删除已平仓行
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_positions (
                account_id text NOT NULL,
                contract_key text NOT NULL,
                symbol text,
                sec_type text,
                exchange text,
                currency text,
                position double precision,
                avg_cost double precision,
                expiry text,
                strike double precision,
                option_right text,
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (account_id, contract_key)
            )
        """
        )
        for col_def in (
            "expiry text",
            "strike double precision",
            "option_right text",
            "contract_key text",
        ):
            name, typ = col_def.split(None, 1)
            cur.execute(
                f"ALTER TABLE account_positions ADD COLUMN IF NOT EXISTS {name} {typ}"
            )
        cur.execute(
            """
            UPDATE account_positions SET contract_key = symbol || '|' || COALESCE(sec_type,'') || '|' || COALESCE(expiry,'') || '|' || COALESCE(strike::text,'') || '|' || COALESCE(option_right,'')
            WHERE contract_key IS NULL OR contract_key = ''
        """
        )
        cur.execute(
            """
            DROP INDEX IF EXISTS account_positions_account_symbol_sectype_key
        """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS account_positions_account_contract_key
            ON account_positions (account_id, contract_key)
        """
        )
        _log_table("instrument_prices", "Last prices for positions/watchlist")
        # R-M6: 每个持仓标的当前价（按 contract_key 聚合），供监控页逐行展示与计算盈亏
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS instrument_prices (
                contract_key text PRIMARY KEY,
                symbol text,
                sec_type text,
                expiry text,
                strike double precision,
                option_right text,
                last double precision,
                bid double precision,
                ask double precision,
                mid double precision,
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        _log("account_executions, account_execution_commissions")
        _log_table("account_executions", "Execution/transaction records")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_executions (
                account_executions_id bigserial PRIMARY KEY,
                account_id text,
                exec_id text,
                exec_time timestamptz,
                symbol text,
                sec_type text,
                side text,
                quantity double precision,
                price double precision,
                source text,
                raw_extra jsonb,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS account_executions_exec_id_key ON account_executions (exec_id) WHERE exec_id IS NOT NULL AND exec_id != ''"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_executions_account_time ON account_executions (account_id, exec_time DESC)"
        )
        _log_table("account_execution_commissions", "Commission records")
        # R-A2 §2.11.1: CommissionReport 表，与 account_executions 通过 exec_id 关联
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_execution_commissions (
                exec_id text PRIMARY KEY,
                commission double precision,
                currency text,
                realized_pnl double precision,
                yield_ double precision,
                yield_redemption_date integer,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        # §2.21: account_transactions (Flex cash transactions for Performance Phase 0)
        _log("account_transactions")
        _log_table("account_transactions", "Cash/transaction records")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_transactions (
                account_transactions_id bigserial PRIMARY KEY,
                account_id text NOT NULL,
                ts timestamptz NOT NULL,
                amount double precision NOT NULL,
                type text NOT NULL,
                currency text,
                description text,
                flex_transaction_id text,
                flex_type text,
                flex_code text,
                asset_category text,
                asset_subcategory text,
                symbol text,
                conid bigint,
                security_id text,
                security_id_type text,
                listing_exchange text,
                report_date date,
                available_for_trading_date date,
                fx_rate_to_base double precision,
                raw_extra jsonb,
                created_at timestamptz DEFAULT now(),
                UNIQUE(account_id, ts, amount, type)
            )
        """
        )
        # Backwards-compatible schema evolution: add new columns if table already existed without them.
        for col_def in (
            "flex_transaction_id text",
            "flex_type text",
            "flex_code text",
            "asset_category text",
            "asset_subcategory text",
            "symbol text",
            "conid bigint",
            "security_id text",
            "security_id_type text",
            "listing_exchange text",
            "report_date date",
            "available_for_trading_date date",
            "fx_rate_to_base double precision",
            "raw_extra jsonb",
        ):
            col_name = col_def.split()[0]
            cur.execute(
                f"ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS {col_def}"
            )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_transactions_account_ts ON account_transactions (account_id, ts DESC)"
        )
        _log("stock_day table + index (may block if API/worker use stock_day)")
        _log_table("stock_day", "Stock daily OHLC bars")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_day (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_day_symbol_time ON stock_day (symbol, bar_time DESC)"
        )
        _log("stock_min table + index")
        _log_table("stock_min", "Stock minute OHLC bars")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_min (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                period text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, period, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_min_symbol_period_time ON stock_min (symbol, period, bar_time DESC)"
        )
        _log("option_day, option_min tables + indexes")
        _log_table("option_day", "Option daily OHLC bars")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_day (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, expiry, strike, option_right, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_day_symbol_expiry_strike_right_time ON option_day (symbol, expiry, strike, option_right, bar_time DESC)"
        )
        _log_table("option_min", "Option minute OHLC bars")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_min (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                period text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, expiry, strike, option_right, period, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_min_symbol_expiry_strike_right_period_time ON option_min (symbol, expiry, strike, option_right, period, bar_time DESC)"
        )
        # Release earlier DDL locks before the final watchlist/backfill DDL step.
        conn.commit()
        _log("watchlist, job_bars_backfill")
        _log_table("watchlist", "Watchlist items (STK/OPT)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS watchlist (
                id bigserial PRIMARY KEY,
                contract_key text NOT NULL UNIQUE,
                symbol text,
                sec_type text,
                expiry text,
                strike double precision,
                option_right text,
                display_label text,
                source text,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS watchlist_contract_key ON watchlist (contract_key)"
        )
        _log_table("job_bars_backfill", "Backfill job queue (Celery worker)")
        # 阶段 3 非实时拉取 Worker：backfill 任务队列表（见 docs/DATABASE.md §2.18）；表名 job_ 前缀为 Celery/任务表约定
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS job_bars_backfill (
                job_bars_backfill_id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                period text NOT NULL DEFAULT '1 D',
                years double precision,
                days integer,
                override_days double precision,
                status text NOT NULL DEFAULT 'pending',
                result jsonb,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS job_bars_backfill_status_created ON job_bars_backfill (status, created_at)"
        )
        for col, default in (("skip_ib", "false"), ("api_interval_sec", "10")):
            cur.execute(
                f"ALTER TABLE job_bars_backfill ADD COLUMN IF NOT EXISTS {col} {'boolean' if col == 'skip_ib' else 'integer'} DEFAULT {default}"
            )
        cur.execute("ALTER TABLE job_bars_backfill ADD COLUMN IF NOT EXISTS span_hours double precision DEFAULT NULL")
        conn.commit()
        _log("position_categories, position_category_tags")
        _log_table("position_categories", "Position category definitions")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS position_categories (
                id bigserial PRIMARY KEY,
                name text NOT NULL,
                description text,
                sort_order integer,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        _log_table("position_category_tags", "Position-to-category mapping")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS position_category_tags (
                account_id text NOT NULL,
                contract_key text NOT NULL,
                category_id integer NOT NULL REFERENCES position_categories(id) ON DELETE CASCADE,
                created_at timestamptz DEFAULT now(),
                PRIMARY KEY (account_id, contract_key)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS position_category_tags_category_id ON position_category_tags (category_id)"
        )
        cur.execute(
            "ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS category_id integer REFERENCES position_categories(id) ON DELETE SET NULL"
        )
        cur.execute(
            "ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS optionable boolean DEFAULT false"
        )
        _log("market_streams_symbol_order")
        _log_table("market_streams_symbol_order", "Market Streams symbol order per category")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS market_streams_symbol_order (
                category_name text NOT NULL,
                symbol text NOT NULL,
                sort_order integer NOT NULL DEFAULT 0,
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (category_name, symbol)
            )
            """
        )
        conn.commit()
        _log("us_market_holidays")
        _log_table("us_market_holidays", "US market holidays")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS us_market_holidays (
                exchange text NOT NULL DEFAULT 'NYSE',
                holiday_date date NOT NULL,
                label text,
                created_at timestamptz DEFAULT now(),
                PRIMARY KEY (exchange, holiday_date)
            )
            """
        )
        _log("flex_accounts")
        _log_table("flex_accounts", "Flex query config")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS flex_accounts (
                id serial PRIMARY KEY,
                sort_order integer NOT NULL DEFAULT 0,
                query_label text,
                purpose text DEFAULT 'cash_transactions',
                query_host_id text NOT NULL,
                query_secondary_id text
            )
            """
        )
        # Migrate from old schema: query_id_cash_transactions -> query_id, add query_label/purpose
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'flex_accounts' AND column_name = 'query_id_cash_transactions'
                    """
                )
                if cur2.fetchone():
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_id text")
                    cur2.execute("UPDATE flex_accounts SET query_id = query_id_cash_transactions WHERE query_id IS NULL OR query_id = ''")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_label text")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS purpose text DEFAULT 'cash_transactions'")
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS query_id_cash_transactions")
            conn.commit()
        except Exception:
            conn.rollback()
        # Ensure new columns exist for tables created before migration
        for col_def in [
            ("query_id", "text"),
            ("query_label", "text"),
            ("purpose", "text DEFAULT 'cash_transactions'"),
        ]:
            try:
                cur.execute(f"ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS {col_def[0]} {col_def[1]}")
                conn.commit()
            except Exception:
                conn.rollback()
        # Migrate: token -> settings (ib_flex_host_token, ib_flex_secondary_token); account_label -> account_is_host (bool); drop token, account_label
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'flex_accounts' AND column_name = 'token'
                    """
                )
                if cur2.fetchone():
                    cur2.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_host_token text")
                    cur2.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_secondary_token text")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS account_is_host boolean NOT NULL DEFAULT true")
                    # Backfill settings: first two distinct tokens by sort_order, id
                    cur2.execute(
                        """
                        UPDATE settings SET
                          ib_flex_host_token = (SELECT token FROM (
                            SELECT token, ROW_NUMBER() OVER (ORDER BY min_so, min_id) AS rn
                            FROM (SELECT token, MIN(sort_order) AS min_so, MIN(id) AS min_id FROM flex_accounts GROUP BY token) x
                          ) y WHERE rn = 1),
                          ib_flex_secondary_token = (SELECT token FROM (
                            SELECT token, ROW_NUMBER() OVER (ORDER BY min_so, min_id) AS rn
                            FROM (SELECT token, MIN(sort_order) AS min_so, MIN(id) AS min_id FROM flex_accounts GROUP BY token) x
                          ) y WHERE rn = 2)
                        WHERE id = 1
                        """
                    )
                    cur2.execute(
                        "UPDATE flex_accounts SET account_is_host = (token = (SELECT ib_flex_host_token FROM settings WHERE id = 1))"
                    )
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS token")
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS account_label")
            conn.commit()
        except Exception:
            conn.rollback()
        # Ensure account_is_host exists (for tables created before token migration)
        try:
            cur.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS account_is_host boolean NOT NULL DEFAULT true")
            conn.commit()
        except Exception:
            conn.rollback()
        # Migrate: account_is_host + query_id -> query_host_id + query_secondary_id (one row per label/purpose, both IDs)
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'flex_accounts' AND column_name = 'account_is_host'
                    """
                )
                if cur2.fetchone():
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_host_id text")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_secondary_id text")
                    cur2.execute("UPDATE flex_accounts SET query_host_id = query_id WHERE account_is_host = true AND (query_host_id IS NULL OR query_host_id = '')")
                    cur2.execute("UPDATE flex_accounts SET query_secondary_id = query_id WHERE account_is_host = false AND (query_secondary_id IS NULL OR query_secondary_id = '')")
                    # Collapse to one row per purpose: keep min(sort_order), merge query_host_id and query_secondary_id
                    cur2.execute(
                        """
                        CREATE TEMP TABLE flex_accounts_merged AS
                        SELECT MIN(sort_order) AS sort_order, purpose,
                               MAX(query_label) AS query_label,
                               MAX(query_host_id) AS query_host_id,
                               MAX(query_secondary_id) AS query_secondary_id
                        FROM flex_accounts
                        GROUP BY purpose
                        """
                    )
                    cur2.execute("DELETE FROM flex_accounts")
                    cur2.execute(
                        """
                        INSERT INTO flex_accounts (sort_order, query_label, purpose, query_host_id, query_secondary_id)
                        SELECT sort_order, query_label, purpose,
                               COALESCE(NULLIF(TRIM(query_host_id), ''), ''),
                               NULLIF(TRIM(query_secondary_id), '')
                        FROM flex_accounts_merged
                        WHERE NULLIF(TRIM(query_host_id), '') IS NOT NULL
                        """
                    )
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS account_is_host")
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS query_id")
            conn.commit()
        except Exception:
            conn.rollback()
        # Ensure query_host_id / query_secondary_id exist for tables created before this migration
        for col_def in [
            ("query_host_id", "text"),
            ("query_secondary_id", "text"),
        ]:
            try:
                cur.execute(f"ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS {col_def[0]} {col_def[1]}")
                conn.commit()
            except Exception:
                conn.rollback()
        # Strategy & gate_safety tables (DATABASE.md §2.24)
        _log("gate_safety_*, strategy_*, settings active_*")
        _log_table("gate_safety_strategy", "Safety boundary set root + strategy layer")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gate_safety_strategy (
                gate_safety_strategy_id bigserial PRIMARY KEY,
                name text NOT NULL,
                version integer NOT NULL DEFAULT 1,
                structure_type text,
                is_active boolean NOT NULL DEFAULT true,
                min_dte integer NOT NULL,
                max_dte integer NOT NULL,
                atm_band_pct double precision NOT NULL,
                blackout_days_before integer NOT NULL,
                blackout_days_after integer NOT NULL,
                trading_hours_only boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        _log_table("gate_safety_strategy_earnings_dates", "Strategy layer earnings blacklist dates")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gate_safety_strategy_earnings_dates (
                gate_safety_strategy_id bigint NOT NULL REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE,
                holiday_date date NOT NULL,
                PRIMARY KEY (gate_safety_strategy_id, holiday_date)
            )
            """
        )
        _log_table("gate_safety_state", "State layer")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gate_safety_state (
                gate_safety_strategy_id bigint PRIMARY KEY REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE,
                epsilon_band integer NOT NULL,
                threshold_hedge_shares integer NOT NULL,
                max_delta_limit integer NOT NULL,
                vol_window_min integer NOT NULL,
                stale_ts_threshold_ms integer NOT NULL,
                wide_spread_pct double precision NOT NULL,
                extreme_spread_pct double precision NOT NULL,
                data_lag_threshold_ms integer NOT NULL
            )
            """
        )
        _log_table("gate_safety_intent", "Intent layer")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gate_safety_intent (
                gate_safety_strategy_id bigint PRIMARY KEY REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE,
                min_hedge_shares integer NOT NULL,
                cooldown_seconds integer NOT NULL,
                max_hedge_shares_per_order integer NOT NULL,
                min_price_move_pct double precision NOT NULL
            )
            """
        )
        _log_table("gate_safety_guard", "Guard layer")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gate_safety_guard (
                gate_safety_strategy_id bigint PRIMARY KEY REFERENCES gate_safety_strategy(gate_safety_strategy_id) ON DELETE CASCADE,
                max_daily_hedge_count integer NOT NULL,
                max_position_shares integer NOT NULL,
                max_daily_loss_usd double precision NOT NULL,
                max_net_delta_shares integer NOT NULL,
                max_spread_pct double precision NOT NULL,
                paper_trade boolean NOT NULL DEFAULT true
            )
            """
        )
        _log_table("strategy_structure", "Structure strategy")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_structure (
                strategy_structure_id bigserial PRIMARY KEY,
                name text NOT NULL,
                structure_type text NOT NULL,
                legs jsonb NOT NULL,
                constraints jsonb,
                version integer NOT NULL DEFAULT 1,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                metadata jsonb
            )
            """
        )
        _log_table("strategy_opportunity", "Opportunity strategy")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_opportunity (
                strategy_opportunity_id bigserial PRIMARY KEY,
                name text NOT NULL,
                strategy_structure_id bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id),
                default_gate_safety_strategy_id bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id),
                symbol_scope jsonb,
                entry_conditions jsonb,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        _log_table("strategy_portfolio", "Portfolio strategy")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_portfolio (
                strategy_portfolio_id bigserial PRIMARY KEY,
                name text NOT NULL,
                strategy_opportunity_ids jsonb NOT NULL,
                gate_safety_strategy_id bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id),
                portfolio_limits jsonb,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS active_strategy_structure_id bigint")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS active_gate_safety_strategy_id bigint")
        conn.commit()
        # Migrate from legacy daemon_ib_config if present (one-time, safe to skip if table missing)
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    UPDATE settings s SET ib_host = d.ib_host, ib_port_type = d.ib_port_type
                    FROM daemon_ib_config d WHERE d.id = 1 AND s.id = 1
                """
                )
            conn.commit()
        except Exception:
            conn.rollback()
        # R-A2 extended: add columns to account_executions for full IB / Flex data（含期权字段与 Flex Trades 字段）
        # 不再在 account_executions 添加 commission/realized_pnl/currency，已迁至 account_execution_commissions
        for _col, sql in [
            ("expiry", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS expiry text"),
            ("strike", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS strike double precision"),
            ("option_right", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS option_right text"),
            ("exchange", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS exchange text"),
            ("order_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS order_id bigint"),
            ("cum_qty", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS cum_qty double precision"),
            ("contract_key", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS contract_key text"),
            ("currency", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS currency text"),
            ("asset_category", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS asset_category text"),
            ("sub_category", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS sub_category text"),
            ("description", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS description text"),
            ("conid", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS conid bigint"),
            ("security_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS security_id text"),
            ("security_id_type", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS security_id_type text"),
            ("cusip", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS cusip text"),
            ("isin", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS isin text"),
            ("figi", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS figi text"),
            ("listing_exchange", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS listing_exchange text"),
            ("underlying_conid", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_conid bigint"),
            ("underlying_symbol", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_symbol text"),
            ("underlying_security_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_security_id text"),
            ("underlying_listing_exchange", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_listing_exchange text"),
            ("issuer", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS issuer text"),
            ("issuer_country_code", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS issuer_country_code text"),
            ("trade_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS trade_id text"),
            ("related_trade_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS related_trade_id text"),
            ("report_date", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS report_date date"),
            ("trade_date", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS trade_date date"),
            ("settle_date_target", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS settle_date_target date"),
            ("transaction_type", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS transaction_type text"),
            ("multiplier", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS multiplier double precision"),
            ("principal_adjust_factor", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS principal_adjust_factor text"),
            ("proceeds", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS proceeds double precision"),
            ("taxes", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS taxes double precision"),
            ("net_cash", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS net_cash double precision"),
            ("close_price", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS close_price double precision"),
            ("open_close_indicator", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS open_close_indicator text"),
            ("notes", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS notes text"),
            ("cost", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS cost double precision"),
            ("fifo_pnl_realized", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS fifo_pnl_realized double precision"),
            ("mtm_pnl", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS mtm_pnl double precision"),
            ("trade_money", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS trade_money double precision"),
            ("fx_rate_to_base", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS fx_rate_to_base double precision"),
            ("acct_alias", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS acct_alias text"),
            ("model", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS model text"),
        ]:
            try:
                cur.execute(sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()
                if getattr(e, "pgcode", None) != "42701":
                    raise
        # R-A2 §2.11.1 迁移：commission/realized_pnl/currency 迁至 account_execution_commissions，从 account_executions 删除
        # 若 account_executions 仍有这三列，先拷贝数据再 DROP
        try:
            cur.execute(
                """
                INSERT INTO account_execution_commissions (exec_id, commission, currency, realized_pnl)
                SELECT exec_id, commission, currency, realized_pnl
                FROM account_executions
                WHERE exec_id IS NOT NULL AND exec_id != ''
                  AND (commission IS NOT NULL OR realized_pnl IS NOT NULL OR currency IS NOT NULL)
                ON CONFLICT (exec_id) DO UPDATE SET
                  commission = COALESCE(EXCLUDED.commission, account_execution_commissions.commission),
                  currency = COALESCE(EXCLUDED.currency, account_execution_commissions.currency),
                  realized_pnl = COALESCE(EXCLUDED.realized_pnl, account_execution_commissions.realized_pnl)
                """
            )
            conn.commit()
        except psycopg2.ProgrammingError as e:
            conn.rollback()
            if getattr(e, "pgcode", None) != "42703":
                raise
        for drop_sql in [
            "ALTER TABLE account_executions DROP COLUMN IF EXISTS commission",
            "ALTER TABLE account_executions DROP COLUMN IF EXISTS realized_pnl",
            "ALTER TABLE account_executions DROP COLUMN IF EXISTS currency",
        ]:
            try:
                cur.execute(drop_sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()
                if getattr(e, "pgcode", None) != "42703":  # 42703 = undefined_column
                    raise
        # RE-7: add columns if not exist (each ALTER in its own transaction so duplicate_column doesn't abort the rest)
        for _col, sql in [
            (
                "ib_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN ib_connected boolean DEFAULT false",
            ),
            (
                "ib_client_id",
                "ALTER TABLE daemon_heartbeat ADD COLUMN ib_client_id integer",
            ),
            (
                "next_retry_ts",
                "ALTER TABLE daemon_heartbeat ADD COLUMN next_retry_ts timestamptz",
            ),
            (
                "seconds_until_retry",
                "ALTER TABLE daemon_heartbeat ADD COLUMN seconds_until_retry smallint",
            ),
            (
                "graceful_shutdown_at",
                "ALTER TABLE daemon_heartbeat ADD COLUMN graceful_shutdown_at timestamptz",
            ),
            (
                "heartbeat_interval_sec",
                "ALTER TABLE daemon_heartbeat ADD COLUMN heartbeat_interval_sec smallint",
            ),
            (
                "redis_quotes_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN redis_quotes_connected boolean DEFAULT false",
            ),
            (
                "event_subscribe_ticker",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_ticker boolean DEFAULT false",
            ),
            (
                "event_subscribe_positions",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_positions boolean DEFAULT false",
            ),
            (
                "event_subscribe_fills",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_fills boolean DEFAULT false",
            ),
            (
                "event_subscribe_commission",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_commission boolean DEFAULT false",
            ),
            (
                "listener_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN listener_connected boolean DEFAULT false",
            ),
            (
                "listener_client_id",
                "ALTER TABLE daemon_heartbeat ADD COLUMN listener_client_id integer",
            ),
            (
                "listener_2_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN listener_2_connected boolean DEFAULT false",
            ),
            (
                "listener_2_client_id",
                "ALTER TABLE daemon_heartbeat ADD COLUMN listener_2_client_id integer",
            ),
            (
                "last_control_message",
                "ALTER TABLE daemon_heartbeat ADD COLUMN last_control_message text",
            ),
            (
                "subscribed_tickers",
                "ALTER TABLE daemon_heartbeat ADD COLUMN subscribed_tickers text[]",
            ),
            (
                "run_status_heartbeat_interval",
                "ALTER TABLE daemon_run_status ADD COLUMN heartbeat_interval_sec smallint",
            ),
        ]:
            try:
                cur.execute(sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()  # clear aborted state so next ALTER can run
                if (
                    e.pgcode != "42701"
                ):  # 42701 = duplicate_column (column already exists)
                    raise
