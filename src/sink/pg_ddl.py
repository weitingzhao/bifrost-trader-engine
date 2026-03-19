"""PostgreSQL DDL: current schema only (CREATE TABLE IF NOT EXISTS + indexes).

Use an empty database or drop/recreate; existing tables are not altered to add missing columns.
"""


def _ensure_tables(conn, log=None, log_table=None) -> None:
    """Apply full DDL (per DATABASE.md). CREATE IF NOT EXISTS only — no incremental ALTER for old databases.
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
        _log(
            "daemon_auto_status_current, daemon_auto_status_history, daemon_auto_operations"
        )
        _log_table(
            "daemon_auto_status_current",
            "Daemon auto-trading current status snapshot (single row)",
        )
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
        _log_table(
            "daemon_auto_status_history", "Daemon auto-trading status snapshot history"
        )
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
        _log_table(
            "daemon_run_status",
            "Run suspended flag (single row). Default suspended=true so Trading Strategy and IB Trading Client stay off until Resume.",
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_run_status (
                id integer PRIMARY KEY DEFAULT 1,
                suspended boolean NOT NULL DEFAULT true,
                updated_at timestamptz DEFAULT now(),
                heartbeat_interval_sec smallint
            )
        """
        )
        cur.execute(
            """
            INSERT INTO daemon_run_status (id, suspended) VALUES (1, true)
            ON CONFLICT (id) DO NOTHING
        """
        )
        _log_table("daemon_heartbeat", "Daemon heartbeat and IB/subscription status")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_heartbeat (
                id integer PRIMARY KEY DEFAULT 1,
                last_ts timestamptz NOT NULL DEFAULT now(),
                hedge_running boolean NOT NULL DEFAULT false,
                ib_connected boolean DEFAULT false,
                ib_client_id integer,
                next_retry_ts timestamptz,
                seconds_until_retry smallint,
                graceful_shutdown_at timestamptz,
                heartbeat_interval_sec smallint,
                redis_quotes_connected boolean DEFAULT false,
                event_subscribe_ticker boolean DEFAULT false,
                event_subscribe_positions boolean DEFAULT false,
                event_subscribe_fills boolean DEFAULT false,
                event_subscribe_commission boolean DEFAULT false,
                listener_connected boolean DEFAULT false,
                listener_client_id integer,
                listener_2_connected boolean DEFAULT false,
                listener_2_client_id integer,
                event_subscribe_positions_ib2 boolean DEFAULT false,
                event_subscribe_fills_ib2 boolean DEFAULT false,
                event_subscribe_commission_ib2 boolean DEFAULT false,
                last_control_message text,
                subscribed_tickers text[],
                mock_hedging boolean DEFAULT true
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
                ib_port_type text NOT NULL DEFAULT 'tws_paper',
                ib_client_id_daemon integer NOT NULL DEFAULT 1,
                ib_client_id_listener integer NOT NULL DEFAULT 2,
                ib_client_id_account integer NOT NULL DEFAULT 100,
                ib_client_id_markets integer NOT NULL DEFAULT 101,
                ib_client_id_worker_market integer NOT NULL DEFAULT 500,
                ib_host_account_id text,
                stream_host_account_id text,
                stream_secondary_account_id text,
                ib2_host text,
                ib2_port_type text DEFAULT 'tws_paper',
                ib2_client_id_listener integer NOT NULL DEFAULT 3,
                ib2_client_id_account integer NOT NULL DEFAULT 102,
                ib_flex_host_token text,
                ib_flex_secondary_token text,
                flex_default_range_days integer NOT NULL DEFAULT 30,
                flex_init_range_days integer NOT NULL DEFAULT 360,
                active_strategy_structure_id bigint,
                active_gate_safety_strategy_id bigint,
                active_strategy_allocation_id bigint
            )
        """
        )
        cur.execute(
            """
            INSERT INTO settings (id, ib_host, ib_port_type) VALUES (1, '127.0.0.1', 'tws_paper')
            ON CONFLICT (id) DO NOTHING
        """
        )
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
        _log("account_execution_commissions")
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
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_contracts_contract_key ON option_contracts (contract_key)"
        )
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
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_snapshots_contract_key_ts ON option_snapshots (contract_key, snapshot_ts DESC)"
        )
        conn.commit()
        _log("preference_position_categories, preference_position_category_tags")
        _log_table(
            "preference_position_categories",
            "Position category definitions (preference)",
        )
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
        _log_table(
            "preference_position_category_tags",
            "Position-to-category mapping (preference)",
        )
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
        _log_table(
            "preference_market_streams_symbol_order",
            "Market Streams symbol order per category (preference)",
        )
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
                dim_direction text,
                dim_structure text,
                dim_coverage text,
                dim_risk text,
                dim_volatility text,
                dim_time text,
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
        _log_table(
            "gate_safety_strategy_earnings_dates",
            "Strategy layer earnings blacklist dates",
        )
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
        _log_table("strategy_dim", "Option strategy dimension enum (dim_type + code)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_dim (
                strategy_dim_id bigserial PRIMARY KEY,
                dim_type text NOT NULL,
                code text NOT NULL,
                display_label text NOT NULL,
                sort_order integer NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (dim_type, code)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_dim_dim_type ON strategy_dim (dim_type)"
        )
        _log_table(
            "strategy_template", "Flat option structure template (six dims + legs)"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_template (
                strategy_template_id bigserial PRIMARY KEY,
                template_code text NOT NULL UNIQUE,
                display_name text NOT NULL,
                dim_direction text,
                dim_structure text,
                dim_coverage text,
                dim_risk text,
                dim_volatility text,
                dim_time text,
                explanation text,
                typical_use text,
                example text,
                nature text,
                sort_order integer NOT NULL DEFAULT 0,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_template_sort ON strategy_template (sort_order)"
        )
        _log_table("strategy_template_leg", "Template default legs (one row per leg)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_template_leg (
                strategy_template_leg_id bigserial PRIMARY KEY,
                strategy_template_id bigint NOT NULL REFERENCES strategy_template(strategy_template_id) ON DELETE CASCADE,
                sort_order integer NOT NULL DEFAULT 0,
                role text,
                direction text,
                option_right text,
                quantity_default integer NOT NULL DEFAULT 1,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (strategy_template_id, sort_order)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_template_leg_template_id ON strategy_template_leg (strategy_template_id)"
        )
        _log_table("strategy_template_param", "Template meta param definition")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_template_param (
                strategy_template_param_id bigserial PRIMARY KEY,
                strategy_template_id bigint NOT NULL REFERENCES strategy_template(strategy_template_id) ON DELETE CASCADE,
                meta_key text NOT NULL,
                display_label text,
                default_value_text text,
                param_kind text,
                sort_order integer NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (strategy_template_id, meta_key)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_template_param_template_id ON strategy_template_param (strategy_template_id)"
        )
        _log_table("strategy_template_characteristic", "Template characteristic lines")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_template_characteristic (
                strategy_template_characteristic_id bigserial PRIMARY KEY,
                strategy_template_id bigint NOT NULL REFERENCES strategy_template(strategy_template_id) ON DELETE CASCADE,
                sort_order integer NOT NULL DEFAULT 0,
                characteristic_text text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_template_char_template_id ON strategy_template_characteristic (strategy_template_id)"
        )
        _log_table("strategy_structure", "Structure strategy")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_structure (
                strategy_structure_id bigserial PRIMARY KEY,
                name text NOT NULL,
                strategy_template_id bigint REFERENCES strategy_template(strategy_template_id),
                version integer NOT NULL DEFAULT 1,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                notes text
            )
            """
        )
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
        _log_table(
            "strategy_structure_constraint",
            "Structure strategy constraint (typed key-value)",
        )
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
                scope_type text,
                is_active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
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
        _log_table(
            "strategy_opportunity_entry_condition",
            "Opportunity strategy entry conditions",
        )
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
        _log_table(
            "strategy_instance", "Strategy instance (one open per opportunity/account)"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS strategy_instance (
                strategy_instance_id bigserial PRIMARY KEY,
                strategy_opportunity_id bigint NOT NULL REFERENCES strategy_opportunity(strategy_opportunity_id) ON DELETE RESTRICT,
                account_id text NOT NULL,
                opened_at timestamptz NOT NULL,
                label text,
                notes text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_instance_opportunity_id ON strategy_instance (strategy_opportunity_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_instance_account_opened ON strategy_instance (account_id, opened_at)"
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
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_history_ts ON strategy_history (ts DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS strategy_history_structure_id ON strategy_history (strategy_structure_id)"
        )
        _log("account_positions strategy columns removed")
        cur.execute("ALTER TABLE account_positions DROP COLUMN IF EXISTS strategy_opportunity_id")
        cur.execute("ALTER TABLE account_positions DROP COLUMN IF EXISTS strategy_instance_id")
        cur.execute("DROP INDEX IF EXISTS account_positions_strategy_opportunity_id")
        cur.execute("DROP INDEX IF EXISTS account_positions_strategy_instance_id")
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
                created_at timestamptz DEFAULT now(),
                category_id integer REFERENCES preference_position_categories(id) ON DELETE SET NULL,
                optionable boolean DEFAULT false
            )
        """
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
                updated_at timestamptz DEFAULT now(),
                skip_ib boolean DEFAULT false,
                api_interval_sec integer DEFAULT 10,
                span_hours double precision
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS job_bars_backfill_status_created ON job_bars_backfill (status, created_at)"
        )

        # ── Executions source-split: raw tables + single account_executions view ──
        # Phase 1 of executions migration: TWS and Flex stored separately;
        # canonical view merges them (Flex authoritative, TWS fills gaps).
        # Cross-source match key: exec_id (IB Execution ID = Flex ibExecID).
        _log("executions_raw_tws, executions_raw_flex, account_executions(view)")
        _log_table("executions_raw_tws", "Raw TWS/manual executions (tws_event, tws_client, manual)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS executions_raw_tws (
                executions_raw_tws_id bigserial PRIMARY KEY,
                account_id text,
                exec_id text,
                exec_time timestamptz,
                symbol text,
                sec_type text,
                side text,
                quantity double precision,
                price double precision,
                source text,
                expiry text,
                strike double precision,
                option_right text,
                exchange text,
                order_id bigint,
                cum_qty double precision,
                contract_key text,
                currency text,
                asset_category text,
                sub_category text,
                description text,
                conid bigint,
                security_id text,
                security_id_type text,
                cusip text,
                isin text,
                figi text,
                listing_exchange text,
                underlying_conid bigint,
                underlying_symbol text,
                underlying_security_id text,
                underlying_listing_exchange text,
                issuer text,
                issuer_country_code text,
                trade_id text,
                related_trade_id text,
                report_date date,
                trade_date date,
                settle_date_target date,
                transaction_type text,
                multiplier double precision,
                principal_adjust_factor text,
                proceeds double precision,
                taxes double precision,
                net_cash double precision,
                close_price double precision,
                open_close_indicator text,
                notes text,
                cost double precision,
                fifo_pnl_realized double precision,
                mtm_pnl double precision,
                trade_money double precision,
                fx_rate_to_base double precision,
                acct_alias text,
                model text,
                raw_extra jsonb,
                strategy_opportunity_id bigint,
                strategy_instance_id bigint,
                legacy_account_executions_id bigint,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS executions_raw_tws_exec_id_key "
            "ON executions_raw_tws (exec_id) WHERE exec_id IS NOT NULL AND exec_id != ''"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_tws_account_time "
            "ON executions_raw_tws (account_id, exec_time DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_tws_contract_key "
            "ON executions_raw_tws (account_id, contract_key) WHERE contract_key IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_tws_strategy_opportunity_id "
            "ON executions_raw_tws (strategy_opportunity_id) WHERE strategy_opportunity_id IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_tws_strategy_instance_id "
            "ON executions_raw_tws (strategy_instance_id) WHERE strategy_instance_id IS NOT NULL"
        )

        _log_table("executions_raw_flex", "Raw Flex executions (flex_trades source, authoritative)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS executions_raw_flex (
                executions_raw_flex_id bigserial PRIMARY KEY,
                account_id text,
                exec_id text,
                exec_time timestamptz,
                symbol text,
                sec_type text,
                side text,
                quantity double precision,
                price double precision,
                source text DEFAULT 'flex_trades',
                expiry text,
                strike double precision,
                option_right text,
                exchange text,
                order_id bigint,
                cum_qty double precision,
                contract_key text,
                currency text,
                asset_category text,
                sub_category text,
                description text,
                conid bigint,
                security_id text,
                security_id_type text,
                cusip text,
                isin text,
                figi text,
                listing_exchange text,
                underlying_conid bigint,
                underlying_symbol text,
                underlying_security_id text,
                underlying_listing_exchange text,
                issuer text,
                issuer_country_code text,
                trade_id text,
                related_trade_id text,
                report_date date,
                trade_date date,
                settle_date_target date,
                transaction_type text,
                multiplier double precision,
                principal_adjust_factor text,
                proceeds double precision,
                taxes double precision,
                net_cash double precision,
                close_price double precision,
                open_close_indicator text,
                notes text,
                cost double precision,
                fifo_pnl_realized double precision,
                mtm_pnl double precision,
                trade_money double precision,
                fx_rate_to_base double precision,
                acct_alias text,
                model text,
                raw_extra jsonb,
                strategy_opportunity_id bigint,
                strategy_instance_id bigint,
                legacy_account_executions_id bigint,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS executions_raw_flex_exec_id_key "
            "ON executions_raw_flex (exec_id) WHERE exec_id IS NOT NULL AND exec_id != ''"
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS executions_raw_flex_account_trade_id_key "
            "ON executions_raw_flex (account_id, trade_id) WHERE trade_id IS NOT NULL AND trade_id != ''"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_flex_account_time "
            "ON executions_raw_flex (account_id, exec_time DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_flex_contract_key "
            "ON executions_raw_flex (account_id, contract_key) WHERE contract_key IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_flex_trade_date "
            "ON executions_raw_flex (account_id, trade_date DESC) WHERE trade_date IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_flex_strategy_opportunity_id "
            "ON executions_raw_flex (strategy_opportunity_id) WHERE strategy_opportunity_id IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_flex_strategy_instance_id "
            "ON executions_raw_flex (strategy_instance_id) WHERE strategy_instance_id IS NOT NULL"
        )

        _log_table("executions_raw_journal", "Raw journal/manual-accounting executions (journal_closed, manual adjustments)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS executions_raw_journal (
                executions_raw_journal_id bigserial PRIMARY KEY,
                account_id text,
                exec_id text,
                exec_time timestamptz,
                symbol text,
                sec_type text,
                side text,
                quantity double precision,
                price double precision,
                source text,
                expiry text,
                strike double precision,
                option_right text,
                exchange text,
                order_id bigint,
                cum_qty double precision,
                contract_key text,
                currency text,
                asset_category text,
                sub_category text,
                description text,
                conid bigint,
                security_id text,
                security_id_type text,
                cusip text,
                isin text,
                figi text,
                listing_exchange text,
                underlying_conid bigint,
                underlying_symbol text,
                underlying_security_id text,
                underlying_listing_exchange text,
                issuer text,
                issuer_country_code text,
                trade_id text,
                related_trade_id text,
                report_date date,
                trade_date date,
                settle_date_target date,
                transaction_type text,
                multiplier double precision,
                principal_adjust_factor text,
                proceeds double precision,
                taxes double precision,
                net_cash double precision,
                close_price double precision,
                open_close_indicator text,
                notes text,
                cost double precision,
                fifo_pnl_realized double precision,
                mtm_pnl double precision,
                trade_money double precision,
                fx_rate_to_base double precision,
                acct_alias text,
                model text,
                raw_extra jsonb,
                strategy_opportunity_id bigint,
                strategy_instance_id bigint,
                legacy_account_executions_id bigint,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS executions_raw_journal_exec_id_key "
            "ON executions_raw_journal (exec_id) WHERE exec_id IS NOT NULL AND exec_id != ''"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_journal_account_time "
            "ON executions_raw_journal (account_id, exec_time DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_journal_contract_key "
            "ON executions_raw_journal (account_id, contract_key) WHERE contract_key IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_journal_strategy_opportunity_id "
            "ON executions_raw_journal (strategy_opportunity_id) WHERE strategy_opportunity_id IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS executions_raw_journal_strategy_instance_id "
            "ON executions_raw_journal (strategy_instance_id) WHERE strategy_instance_id IS NOT NULL"
        )

        _EXEC_CANONICAL_COLS = (
            "account_id, exec_id, exec_time, symbol, sec_type, side, quantity, price, source, "
            "expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, "
            "currency, asset_category, sub_category, description, conid, "
            "security_id, security_id_type, cusip, isin, figi, listing_exchange, "
            "underlying_conid, underlying_symbol, underlying_security_id, underlying_listing_exchange, "
            "issuer, issuer_country_code, trade_id, related_trade_id, report_date, trade_date, "
            "settle_date_target, transaction_type, multiplier, principal_adjust_factor, "
            "proceeds, taxes, net_cash, close_price, open_close_indicator, notes, cost, "
            "fifo_pnl_realized, mtm_pnl, trade_money, fx_rate_to_base, acct_alias, model, "
            "raw_extra, strategy_opportunity_id, strategy_instance_id, created_at"
        )
        cur.execute("DROP VIEW IF EXISTS executions_canonical")
        cur.execute(
            """
            SELECT c.relkind
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND c.relname = 'account_executions'
            LIMIT 1
            """
        )
        _ae_rel = cur.fetchone()
        _ae_relkind = _ae_rel[0] if _ae_rel else None
        if _ae_relkind == "v":
            cur.execute("DROP VIEW account_executions")
        elif _ae_relkind == "r":
            cur.execute("DROP TABLE account_executions")
        cur.execute(
            f"""
            CREATE OR REPLACE VIEW account_executions AS
            SELECT executions_raw_flex_id AS account_executions_id,
                   {_EXEC_CANONICAL_COLS}
            FROM executions_raw_flex
            UNION ALL
            SELECT -(executions_raw_tws_id) AS account_executions_id,
                   {_EXEC_CANONICAL_COLS}
            FROM executions_raw_tws t
            WHERE NOT EXISTS (
                SELECT 1 FROM executions_raw_flex f
                WHERE f.exec_id = t.exec_id
                  AND f.exec_id IS NOT NULL AND f.exec_id != ''
                  AND t.exec_id IS NOT NULL AND t.exec_id != ''
            )
            UNION ALL
            SELECT -(1000000000 + executions_raw_journal_id) AS account_executions_id,
                   {_EXEC_CANONICAL_COLS}
            FROM executions_raw_journal
        """
        )
        # Performance-book subset: Flex (authoritative fills) + journal adjustments only (no TWS gap-fill).
        cur.execute(
            f"""
            CREATE OR REPLACE VIEW account_executions_final AS
            SELECT executions_raw_flex_id AS account_executions_id,
                   {_EXEC_CANONICAL_COLS}
            FROM executions_raw_flex
            UNION ALL
            SELECT -(1000000000 + executions_raw_journal_id) AS account_executions_id,
                   {_EXEC_CANONICAL_COLS}
            FROM executions_raw_journal
        """
        )
        _log("account_executions_final(view: flex + journal only)")

        # TWS-only "on the fly" rows: drop any TWS execution whose (account_id, contract_key)
        # already appears in account_executions_final (Flex/Journal book covers that contract).
        _exec_canonical_cols_t = ", ".join(
            f"t.{c.strip()}" for c in _EXEC_CANONICAL_COLS.split(",") if c.strip()
        )
        cur.execute(
            f"""
            CREATE OR REPLACE VIEW account_executions_fly AS
            SELECT -(t.executions_raw_tws_id) AS account_executions_id,
                   {_exec_canonical_cols_t}
            FROM executions_raw_tws t
            WHERE upper(trim(COALESCE(t.sec_type, ''))) <> 'BAG'
              AND NOT EXISTS (
                SELECT 1
                FROM account_executions_final f
                WHERE f.account_id IS NOT DISTINCT FROM t.account_id
                  AND NULLIF(trim(COALESCE(t.contract_key, '')), '') IS NOT NULL
                  AND NULLIF(trim(COALESCE(f.contract_key, '')), '') IS NOT NULL
                  AND trim(COALESCE(f.contract_key, '')) = trim(COALESCE(t.contract_key, ''))
            )
        """
        )
        _log("account_executions_fly(view: TWS minus final-covered contracts, no BAG)")

        conn.commit()
