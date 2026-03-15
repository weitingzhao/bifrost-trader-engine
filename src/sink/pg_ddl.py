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
        _log("account, account_positions, contract_quote_live")
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
        _log_table("contract_quote_live", "Last prices for positions/watchlist")
        # R-M6: 每个持仓标的当前价（按 contract_key 聚合），供监控页逐行展示与计算盈亏
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS contract_quote_live (
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
        _log("stocks table (symbol reference)")
        _log_table("stocks", "Stock symbol reference")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS stocks (
                stocks_id bigserial PRIMARY KEY,
                symbol text NOT NULL UNIQUE,
                name text,
                exchange text,
                created_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS stocks_symbol ON stocks (symbol)")
        _log("option_day, option_min tables + indexes")
        _log_table("option_day", "Option daily OHLC bars")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_day (
                option_day_id bigserial PRIMARY KEY,
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
                option_min_id bigserial PRIMARY KEY,
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
        _log("option_contracts, option_snapshots")
        _log_table("option_contracts", "Option contract definitions (contract_key)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_contracts (
                option_contracts_id bigserial PRIMARY KEY,
                contract_key text NOT NULL UNIQUE,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                created_at timestamptz DEFAULT now()
            )
            """
        )
        for col_def in (
            "contract_key text",
            "symbol text",
            "expiry text",
            "strike double precision",
            "option_right text",
            "created_at timestamptz DEFAULT now()",
        ):
            cur.execute(f"ALTER TABLE option_contracts ADD COLUMN IF NOT EXISTS {col_def}")
        cur.execute("CREATE INDEX IF NOT EXISTS option_contracts_contract_key ON option_contracts (contract_key)")
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_contracts_symbol_expiry_strike_right ON option_contracts (symbol, expiry, strike, option_right)"
        )
        _log_table("option_snapshots", "Option snapshot (point-in-time quote)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_snapshots (
                option_snapshots_id bigserial PRIMARY KEY,
                contract_key text NOT NULL,
                snapshot_ts timestamptz NOT NULL,
                last double precision,
                bid double precision,
                ask double precision,
                mid double precision,
                created_at timestamptz DEFAULT now()
            )
            """
        )
        for col_def in (
            "contract_key text",
            "snapshot_ts timestamptz",
            "last double precision",
            "bid double precision",
            "ask double precision",
            "mid double precision",
            "created_at timestamptz DEFAULT now()",
        ):
            cur.execute(f"ALTER TABLE option_snapshots ADD COLUMN IF NOT EXISTS {col_def}")
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_snapshots_contract_key_ts ON option_snapshots (contract_key, snapshot_ts DESC)"
        )
        conn.commit()
        _log("preference_position_categories, preference_position_category_tags")
        _log_table("preference_position_categories", "Position category definitions (preference)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS preference_position_categories (
                id bigserial PRIMARY KEY,
                name text NOT NULL,
                description text,
                sort_order integer,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        _log_table("preference_position_category_tags", "Position-to-category mapping (preference)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS preference_position_category_tags (
                account_id text NOT NULL,
                contract_key text NOT NULL,
                category_id integer NOT NULL REFERENCES preference_position_categories(id) ON DELETE CASCADE,
                created_at timestamptz DEFAULT now(),
                PRIMARY KEY (account_id, contract_key)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS preference_position_category_tags_category_id ON preference_position_category_tags (category_id)"
        )
        _log("preference_market_streams_symbol_order")
        _log_table("preference_market_streams_symbol_order", "Market Streams symbol order per category (preference)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS preference_market_streams_symbol_order (
                category_name text NOT NULL,
                symbol text NOT NULL,
                sort_order integer NOT NULL DEFAULT 0,
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (category_name, symbol)
            )
            """
        )
        conn.commit()
        _log("reference_us_holidays")
        _log_table("reference_us_holidays", "US market holidays")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS reference_us_holidays (
                exchange text NOT NULL DEFAULT 'NYSE',
                holiday_date date NOT NULL,
                label text,
                created_at timestamptz DEFAULT now(),
                PRIMARY KEY (exchange, holiday_date)
            )
            """
        )
        _log("settings_ib_flex")
        _log_table("settings_ib_flex", "IB Flex query config")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings_ib_flex (
                id serial PRIMARY KEY,
                sort_order integer NOT NULL DEFAULT 0,
                query_label text,
                purpose text DEFAULT 'cash_transactions',
                query_host_id text NOT NULL,
                query_secondary_id text
            )
            """
        )
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
                version integer NOT NULL DEFAULT 1,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                notes text
            )
            """
        )
        cur.execute("ALTER TABLE strategy_structure ADD COLUMN IF NOT EXISTS notes text")
        cur.execute("ALTER TABLE strategy_structure DROP COLUMN IF EXISTS legs")
        cur.execute("ALTER TABLE strategy_structure DROP COLUMN IF EXISTS constraints")
        cur.execute("ALTER TABLE strategy_structure DROP COLUMN IF EXISTS metadata")
        _log_table("strategy_structure_leg", "Structure strategy leg (one row per leg)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_structure_leg (
                strategy_structure_leg_id bigserial PRIMARY KEY,
                strategy_structure_id bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) ON DELETE CASCADE,
                sort_order integer NOT NULL DEFAULT 0,
                role text,
                direction text,
                option_right text,
                quantity integer NOT NULL DEFAULT 1,
                strike double precision,
                expiration text,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_structure_leg_structure_id ON strategy_structure_leg (strategy_structure_id)"
        )
        _log_table("strategy_structure_constraint", "Structure strategy constraint (typed key-value)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_structure_constraint (
                strategy_structure_constraint_id bigserial PRIMARY KEY,
                strategy_structure_id bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) ON DELETE CASCADE,
                constraint_type text NOT NULL,
                constraint_value_text text,
                constraint_value_int integer,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_structure_constraint_structure_id ON strategy_structure_constraint (strategy_structure_id)"
        )
        _log_table("strategy_structure_meta", "Structure strategy metadata key-value")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_structure_meta (
                strategy_structure_meta_id bigserial PRIMARY KEY,
                strategy_structure_id bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id) ON DELETE CASCADE,
                meta_key text NOT NULL,
                meta_value_text text,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (strategy_structure_id, meta_key)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_structure_meta_structure_id ON strategy_structure_meta (strategy_structure_id)"
        )
        _log_table("strategy_opportunity", "Opportunity strategy")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_opportunity (
                strategy_opportunity_id bigserial PRIMARY KEY,
                name text NOT NULL,
                strategy_structure_id bigint NOT NULL REFERENCES strategy_structure(strategy_structure_id),
                default_gate_safety_strategy_id bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id),
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("ALTER TABLE strategy_opportunity ADD COLUMN IF NOT EXISTS scope_type text")
        cur.execute("ALTER TABLE strategy_opportunity DROP COLUMN IF EXISTS symbol_scope")
        cur.execute("ALTER TABLE strategy_opportunity DROP COLUMN IF EXISTS entry_conditions")
        _log_table("strategy_opportunity_symbol", "Opportunity strategy symbols")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_opportunity_symbol (
                strategy_opportunity_symbol_id bigserial PRIMARY KEY,
                strategy_opportunity_id bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE CASCADE,
                symbol text NOT NULL,
                sort_order integer NOT NULL DEFAULT 0,
                UNIQUE (strategy_opportunity_id, symbol)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_opportunity_symbol_opportunity_id ON strategy_opportunity_symbol (strategy_opportunity_id)"
        )
        _log_table("strategy_opportunity_entry_condition", "Opportunity strategy entry conditions")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_opportunity_entry_condition (
                strategy_opportunity_entry_condition_id bigserial PRIMARY KEY,
                strategy_opportunity_id bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE CASCADE,
                condition_type text NOT NULL,
                value_text text,
                value_numeric double precision,
                sort_order integer NOT NULL DEFAULT 0
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_opportunity_entry_condition_opportunity_id ON strategy_opportunity_entry_condition (strategy_opportunity_id)"
        )
        _log_table("strategy_allocation", "Strategy allocation")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_allocation (
                strategy_allocation_id bigserial PRIMARY KEY,
                name text NOT NULL,
                gate_safety_strategy_id bigint REFERENCES gate_safety_strategy(gate_safety_strategy_id),
                max_positions integer,
                max_bp_pct numeric,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        _log_table("strategy_allocation_opportunity", "Allocation-opportunity junction")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_allocation_opportunity (
                strategy_allocation_id bigint NOT NULL REFERENCES strategy_allocation(strategy_allocation_id) ON DELETE CASCADE,
                strategy_opportunity_id bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE CASCADE,
                sort_order integer NOT NULL DEFAULT 0,
                PRIMARY KEY (strategy_allocation_id, strategy_opportunity_id)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_allocation_opportunity_opportunity_id "
            "ON strategy_allocation_opportunity (strategy_opportunity_id)"
        )
        _log_table("strategy_history", "Strategy run / state history")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_history (
                strategy_history_id bigserial PRIMARY KEY,
                strategy_structure_id bigint REFERENCES strategy_structure(strategy_structure_id),
                ts timestamptz NOT NULL,
                state_summary jsonb,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        # Migration: ensure columns exist (e.g. if table was created by older schema or manually)
        cur.execute(
            "ALTER TABLE strategy_history ADD COLUMN IF NOT EXISTS ts timestamptz NOT NULL DEFAULT now()"
        )
        cur.execute(
            "ALTER TABLE strategy_history ADD COLUMN IF NOT EXISTS strategy_structure_id bigint REFERENCES strategy_structure(strategy_structure_id)"
        )
        cur.execute(
            "ALTER TABLE strategy_history ADD COLUMN IF NOT EXISTS state_summary jsonb"
        )
        cur.execute(
            "ALTER TABLE strategy_history ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_history_ts ON strategy_history (ts DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_history_structure_id ON strategy_history (strategy_structure_id)"
        )
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS active_strategy_structure_id bigint")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS active_gate_safety_strategy_id bigint")
        _log("watchlist, job_bars_backfill")
        _log_table("watchlist", "Watchlist items (STK/OPT)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS watchlist (
                contract_key text NOT NULL PRIMARY KEY,
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
            "SELECT 1 FROM information_schema.columns WHERE table_schema = %s AND table_name = %s AND column_name = %s",
            ("public", "watchlist", "id"),
        )
        if cur.fetchone():
            cur.execute("ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_pkey")
            cur.execute("ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_contract_key_key")
            cur.execute("ALTER TABLE watchlist DROP COLUMN IF EXISTS id")
            cur.execute("ALTER TABLE watchlist ADD PRIMARY KEY (contract_key)")
        cur.execute(
            "ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS category_id integer REFERENCES preference_position_categories(id) ON DELETE SET NULL"
        )
        cur.execute(
            "ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS optionable boolean DEFAULT false"
        )
        _log_table("job_bars_backfill", "Backfill job queue (Celery worker)")
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
