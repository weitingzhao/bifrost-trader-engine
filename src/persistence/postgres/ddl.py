"""PostgreSQL DDL: current schema (CREATE TABLE IF NOT EXISTS + indexes only)."""


def _ensure_tables(conn, log=None, log_table=None) -> None:
    """Apply full DDL (per DATABASE.md). CREATE IF NOT EXISTS and index DDL only.
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
        _log("account_sync_control, account_sync_run_status, account_sync_heartbeat")
        _log_table("account_sync_control", "Account Sync Daemon control commands")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_sync_control (
                id bigserial PRIMARY KEY,
                command text NOT NULL,
                created_at timestamptz DEFAULT now(),
                consumed_at timestamptz
            )
        """
        )
        _log_table(
            "account_sync_run_status",
            "Account Sync Daemon run status (single row). Default suspended=false.",
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_sync_run_status (
                id integer PRIMARY KEY DEFAULT 1,
                suspended boolean NOT NULL DEFAULT false,
                heartbeat_interval_sec real DEFAULT 5.0,
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            """
            INSERT INTO account_sync_run_status (id, suspended, heartbeat_interval_sec)
            VALUES (1, false, 5.0)
            ON CONFLICT (id) DO NOTHING
        """
        )
        _log_table("account_sync_heartbeat", "Account Sync Daemon heartbeat and sync stats")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_sync_heartbeat (
                id integer PRIMARY KEY DEFAULT 1,
                last_ts timestamptz,
                last_sync_version bigint DEFAULT 0,
                accounts_synced integer DEFAULT 0,
                positions_synced integer DEFAULT 0,
                executions_synced integer DEFAULT 0,
                open_orders_synced integer DEFAULT 0,
                stream_lag bigint DEFAULT 0,
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            """
            INSERT INTO account_sync_heartbeat (id, last_ts) VALUES (1, now())
            ON CONFLICT (id) DO NOTHING
        """
        )

        _log("settings (account/stream + flex + active strategy refs; IB host/port/client IDs in config YAML)")
        _log_table("settings", "App settings (account IDs, stream accounts, Flex, active strategy refs)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id integer PRIMARY KEY DEFAULT 1,
                ib_host_account_id text,
                stream_host_account_id text,
                stream_secondary_account_id text,
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
            INSERT INTO settings (id) VALUES (1)
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
                bar_time date NOT NULL,
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
        # Migrate: if bar_time is still timestamptz from an older schema, convert to date.
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'stock_day'
                      AND column_name = 'bar_time'
                      AND data_type = 'timestamp with time zone'
                ) THEN
                    TRUNCATE stock_day;
                    ALTER TABLE stock_day ALTER COLUMN bar_time TYPE date USING bar_time::date;
                END IF;
            END $$
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_day_symbol_time ON stock_day (symbol, bar_time DESC)"
        )
        # R-A3 + Massive: source dimension (ib / tv / massive), extended OHLC fields
        cur.execute(
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'stock_day'
              ) THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_day' AND column_name = 'source'
                ) THEN
                  ALTER TABLE stock_day ADD COLUMN source text;
                  UPDATE stock_day SET source = 'ib' WHERE source IS NULL;
                  ALTER TABLE stock_day ALTER COLUMN source SET NOT NULL;
                  ALTER TABLE stock_day ALTER COLUMN source SET DEFAULT 'ib';
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_day' AND column_name = 'vwap'
                ) THEN
                  ALTER TABLE stock_day ADD COLUMN vwap double precision;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_day' AND column_name = 'trade_count'
                ) THEN
                  ALTER TABLE stock_day ADD COLUMN trade_count bigint;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_day' AND column_name = 'adjusted'
                ) THEN
                  ALTER TABLE stock_day ADD COLUMN adjusted boolean;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_day' AND column_name = 'extras'
                ) THEN
                  ALTER TABLE stock_day ADD COLUMN extras jsonb;
                END IF;
                IF EXISTS (
                  SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_day_symbol_bar_time_key'
                ) THEN
                  ALTER TABLE stock_day DROP CONSTRAINT stock_day_symbol_bar_time_key;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname = 'stock_day_symbol_bar_time_source_key'
                ) THEN
                  ALTER TABLE stock_day ADD CONSTRAINT stock_day_symbol_bar_time_source_key
                    UNIQUE (symbol, bar_time, source);
                END IF;
              END IF;
            END $$
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_day_symbol_source_time ON stock_day (symbol, source, bar_time DESC)"
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
        cur.execute(
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'stock_min'
              ) THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_min' AND column_name = 'source'
                ) THEN
                  ALTER TABLE stock_min ADD COLUMN source text;
                  UPDATE stock_min SET source = 'ib' WHERE source IS NULL;
                  ALTER TABLE stock_min ALTER COLUMN source SET NOT NULL;
                  ALTER TABLE stock_min ALTER COLUMN source SET DEFAULT 'ib';
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_min' AND column_name = 'vwap'
                ) THEN
                  ALTER TABLE stock_min ADD COLUMN vwap double precision;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_min' AND column_name = 'trade_count'
                ) THEN
                  ALTER TABLE stock_min ADD COLUMN trade_count bigint;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_min' AND column_name = 'adjusted'
                ) THEN
                  ALTER TABLE stock_min ADD COLUMN adjusted boolean;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_min' AND column_name = 'extras'
                ) THEN
                  ALTER TABLE stock_min ADD COLUMN extras jsonb;
                END IF;
                IF EXISTS (
                  SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_min_symbol_period_bar_time_key'
                ) THEN
                  ALTER TABLE stock_min DROP CONSTRAINT stock_min_symbol_period_bar_time_key;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname = 'stock_min_symbol_period_bar_time_source_key'
                ) THEN
                  ALTER TABLE stock_min ADD CONSTRAINT stock_min_symbol_period_bar_time_source_key
                    UNIQUE (symbol, period, bar_time, source);
                END IF;
              END IF;
            END $$
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_min_sym_per_src_time ON stock_min (symbol, period, source, bar_time DESC)"
        )
        _log("tickers table (Massive reference universe)")
        _log_table("tickers", "Ticker symbol reference (All Tickers)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS tickers (
                tickers_id bigserial PRIMARY KEY,
                ticker text NOT NULL UNIQUE,
                name text,
                market text,
                locale text,
                primary_exchange text,
                instrument_type text,
                active boolean,
                currency_name text,
                currency_symbol text,
                base_currency_name text,
                base_currency_symbol text,
                cik text,
                composite_figi text,
                share_class_figi text,
                last_updated_utc timestamptz,
                delisted_utc timestamptz,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS tickers_ticker ON tickers (ticker)")
        # Rename legacy Massive reference tables (idempotent; fresh DBs use CREATE below).
        cur.execute(
            """
            DO $$
            BEGIN
              IF to_regclass('public.ticker_reference_details') IS NOT NULL
                 AND to_regclass('public.ticker_overview') IS NULL THEN
                ALTER TABLE ticker_reference_details RENAME TO ticker_overview;
              END IF;
              IF to_regclass('public.ticker_instrument_types') IS NOT NULL
                 AND to_regclass('public.ticker_types') IS NULL THEN
                ALTER TABLE ticker_instrument_types RENAME TO ticker_types;
                IF EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ticker_types'
                    AND column_name = 'ticker_instrument_types_id'
                ) THEN
                  ALTER TABLE ticker_types RENAME COLUMN ticker_instrument_types_id TO ticker_types_id;
                END IF;
                IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ticker_instrument_types_code') THEN
                  ALTER INDEX ticker_instrument_types_code RENAME TO ticker_types_code;
                END IF;
              END IF;
            END $$;
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ticker_overview (
                tickers_id bigint PRIMARY KEY REFERENCES tickers(tickers_id) ON DELETE CASCADE,
                sector text NOT NULL DEFAULT '',
                industry text NOT NULL DEFAULT '',
                exchange text,
                list_date date,
                ticker_root text,
                sic_description text,
                market_cap double precision,
                total_employees integer,
                address_line1 text,
                address_city text,
                address_state text,
                postal_code text,
                phone text,
                description text,
                icon_url text,
                logo_url text,
                overview_updated_at timestamptz
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ticker_types (
                ticker_types_id bigserial PRIMARY KEY,
                code text NOT NULL,
                description text,
                asset_class text NOT NULL DEFAULT '',
                locale text NOT NULL DEFAULT '',
                created_at timestamptz DEFAULT now(),
                UNIQUE (code, asset_class, locale)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS ticker_types_code ON ticker_types (code)"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ticker_related_tickers (
                ticker_related_tickers_id bigserial PRIMARY KEY,
                from_tickers_id bigint NOT NULL REFERENCES tickers(tickers_id) ON DELETE CASCADE,
                to_symbol text NOT NULL,
                rank integer NOT NULL DEFAULT 0,
                fetched_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (from_tickers_id, to_symbol)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS ticker_related_from ON ticker_related_tickers (from_tickers_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS ticker_related_to_symbol ON ticker_related_tickers (to_symbol)"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS job_ticker_reference_state (
                sync_kind text PRIMARY KEY,
                last_cursor text,
                status text,
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS tickers_active ON tickers (active) WHERE active IS NOT NULL"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS tickers_primary_exchange ON tickers (primary_exchange)"
        )
        cur.execute("CREATE INDEX IF NOT EXISTS tickers_instrument_type ON tickers (instrument_type)")
        # One-time: migrate legacy ``stocks`` / ``stock_related_tickers`` / ``job_stock_reference_state`` → new tables.
        cur.execute(
            """
            DO $$
            BEGIN
              IF to_regclass('public.stocks') IS NULL THEN
                RETURN;
              END IF;
              IF EXISTS (SELECT 1 FROM tickers LIMIT 1) THEN
                DROP TABLE IF EXISTS stock_related_tickers CASCADE;
                DROP TABLE IF EXISTS stocks CASCADE;
                DROP TABLE IF EXISTS job_stock_reference_state CASCADE;
                RETURN;
              END IF;

              INSERT INTO tickers (
                ticker, name, market, locale, primary_exchange, instrument_type, active,
                currency_name, currency_symbol, base_currency_name, base_currency_symbol,
                cik, composite_figi, share_class_figi, last_updated_utc, delisted_utc,
                created_at, updated_at
              )
              SELECT
                upper(trim(symbol)),
                name,
                market,
                locale,
                primary_exchange,
                instrument_type,
                active,
                currency_name,
                NULL,
                NULL,
                NULL,
                cik,
                composite_figi,
                share_class_figi,
                NULL,
                NULL,
                COALESCE(created_at, now()),
                COALESCE(reference_updated_at, created_at, now())
              FROM stocks;

              INSERT INTO ticker_overview (
                tickers_id, sector, industry, exchange, list_date, ticker_root, sic_description,
                market_cap, total_employees, address_line1, address_city, address_state, postal_code,
                phone, description, icon_url, logo_url, overview_updated_at
              )
              SELECT
                t.tickers_id,
                '',
                '',
                s.exchange,
                s.list_date,
                s.ticker_root,
                s.sic_description,
                s.market_cap,
                s.total_employees,
                s.address_line1,
                s.address_city,
                s.address_state,
                s.postal_code,
                s.phone,
                s.description,
                s.icon_url,
                s.logo_url,
                COALESCE(s.reference_updated_at, now())
              FROM tickers t
              INNER JOIN stocks s ON t.ticker = upper(trim(s.symbol));

              IF to_regclass('public.stock_related_tickers') IS NOT NULL THEN
                INSERT INTO ticker_related_tickers (from_tickers_id, to_symbol, rank, fetched_at)
                SELECT t.tickers_id, r.to_symbol, r.rank, r.fetched_at
                FROM stock_related_tickers r
                INNER JOIN stocks s ON s.stocks_id = r.from_stocks_id
                INNER JOIN tickers t ON t.ticker = upper(trim(s.symbol));
              END IF;

              IF to_regclass('public.job_stock_reference_state') IS NOT NULL THEN
                INSERT INTO job_ticker_reference_state (sync_kind, last_cursor, status, updated_at)
                SELECT
                  CASE sync_kind WHEN 'universe_stocks' THEN 'universe_tickers' ELSE sync_kind END,
                  last_cursor,
                  status,
                  updated_at
                FROM job_stock_reference_state
                ON CONFLICT (sync_kind) DO NOTHING;
              END IF;

              DROP TABLE IF EXISTS stock_related_tickers CASCADE;
              DROP TABLE IF EXISTS stocks CASCADE;
              DROP TABLE IF EXISTS job_stock_reference_state CASCADE;
            END $$;
            """
        )
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
                vwap double precision,
                source text NOT NULL DEFAULT 'ib',
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, expiry, strike, option_right, bar_time, source)
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
                vwap double precision,
                source text NOT NULL DEFAULT 'ib',
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, expiry, strike, option_right, period, bar_time, source)
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
                massive_option_ticker text,
                exercise_style text,
                shares_per_contract integer,
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
        _log_table("option_expiration_cache", "Cached option expirations per underlying (Massive REST + TTL)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_expiration_cache (
                option_expiration_cache_id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                source text NOT NULL DEFAULT 'massive',
                last_seen_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(),
                UNIQUE (symbol, expiry, source)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_expiration_cache_symbol_updated "
            "ON option_expiration_cache (symbol, updated_at DESC)"
        )
        _log_table("option_snapshots", "Option snapshot (point-in-time quote, RANGE partitioned by snapshot_ts)")
        cur.execute(
            """
            DO $snap_part$
            DECLARE
              tbl_kind char;
              m_start date;
              m_end date;
              part_name text;
            BEGIN
              -- Check if the table exists at all
              SELECT relkind INTO tbl_kind FROM pg_class
              WHERE relname = 'option_snapshots' AND relnamespace = 'public'::regnamespace;

              IF tbl_kind IS NULL THEN
                -- Fresh install: create as partitioned table directly
                CREATE SEQUENCE IF NOT EXISTS option_snapshots_option_snapshots_id_seq;
                CREATE TABLE option_snapshots (
                    option_snapshots_id bigint NOT NULL DEFAULT nextval('option_snapshots_option_snapshots_id_seq'),
                    contract_key text NOT NULL,
                    snapshot_ts timestamptz NOT NULL,
                    last double precision,
                    bid double precision,
                    ask double precision,
                    mid double precision,
                    iv double precision,
                    delta double precision,
                    gamma double precision,
                    theta double precision,
                    vega double precision,
                    open_interest integer,
                    underlying_price double precision,
                    underlying_ticker text,
                    day_open double precision,
                    day_high double precision,
                    day_low double precision,
                    day_close double precision,
                    day_previous_close double precision,
                    day_change double precision,
                    day_change_percent double precision,
                    day_volume bigint,
                    day_vwap double precision,
                    day_last_updated timestamptz,
                    break_even_price double precision,
                    fmv double precision,
                    fmv_last_updated timestamptz,
                    source text NOT NULL DEFAULT 'ib',
                    created_at timestamptz DEFAULT now(),
                    PRIMARY KEY (option_snapshots_id, snapshot_ts)
                ) PARTITION BY RANGE (snapshot_ts);
                ALTER SEQUENCE option_snapshots_option_snapshots_id_seq OWNED BY option_snapshots.option_snapshots_id;
                -- Create default partition for current month and next 3 months
                FOR i IN 0..3 LOOP
                  m_start := date_trunc('month', now())::date + (i || ' months')::interval;
                  m_end   := m_start + interval '1 month';
                  part_name := 'option_snapshots_y' || to_char(m_start, 'YYYY') || 'm' || to_char(m_start, 'MM');
                  EXECUTE format(
                    'CREATE TABLE IF NOT EXISTS %I PARTITION OF option_snapshots FOR VALUES FROM (%L) TO (%L)',
                    part_name, m_start, m_end
                  );
                END LOOP;
                -- Default partition for anything outside defined ranges
                CREATE TABLE IF NOT EXISTS option_snapshots_default PARTITION OF option_snapshots DEFAULT;

              ELSIF tbl_kind = 'r' THEN
                -- Existing non-partitioned table: migrate to partitioned
                RAISE NOTICE 'Migrating option_snapshots from heap to RANGE partition on snapshot_ts ...';

                -- 0. Align legacy heap column set with current DDL (migrate_opt block runs later in _ensure_tables;
                -- without these, INSERT ... SELECT by name fails on older DBs that only had mid + created_at.)
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_snapshots' AND column_name = 'iv'
                ) THEN
                  ALTER TABLE option_snapshots ADD COLUMN iv double precision;
                  ALTER TABLE option_snapshots ADD COLUMN delta double precision;
                  ALTER TABLE option_snapshots ADD COLUMN gamma double precision;
                  ALTER TABLE option_snapshots ADD COLUMN theta double precision;
                  ALTER TABLE option_snapshots ADD COLUMN vega double precision;
                  ALTER TABLE option_snapshots ADD COLUMN open_interest integer;
                  ALTER TABLE option_snapshots ADD COLUMN underlying_price double precision;
                  ALTER TABLE option_snapshots ADD COLUMN source text NOT NULL DEFAULT 'ib';
                END IF;

                -- 1. Create new partitioned parent
                CREATE SEQUENCE IF NOT EXISTS option_snapshots_new_id_seq;
                CREATE TABLE option_snapshots_new (
                    option_snapshots_id bigint NOT NULL DEFAULT nextval('option_snapshots_new_id_seq'),
                    contract_key text NOT NULL,
                    snapshot_ts timestamptz NOT NULL,
                    last double precision,
                    bid double precision,
                    ask double precision,
                    mid double precision,
                    iv double precision,
                    delta double precision,
                    gamma double precision,
                    theta double precision,
                    vega double precision,
                    open_interest integer,
                    underlying_price double precision,
                    underlying_ticker text,
                    day_open double precision,
                    day_high double precision,
                    day_low double precision,
                    day_close double precision,
                    day_previous_close double precision,
                    day_change double precision,
                    day_change_percent double precision,
                    day_volume bigint,
                    day_vwap double precision,
                    day_last_updated timestamptz,
                    break_even_price double precision,
                    fmv double precision,
                    fmv_last_updated timestamptz,
                    source text NOT NULL DEFAULT 'ib',
                    created_at timestamptz DEFAULT now(),
                    PRIMARY KEY (option_snapshots_id, snapshot_ts)
                ) PARTITION BY RANGE (snapshot_ts);

                -- 2. Create monthly partitions covering existing data + future
                SELECT date_trunc('month', COALESCE(min(snapshot_ts), now()))::date INTO m_start
                FROM option_snapshots;
                m_end := (date_trunc('month', now()) + interval '4 months')::date;

                WHILE m_start < m_end LOOP
                  part_name := 'option_snapshots_new_y' || to_char(m_start, 'YYYY') || 'm' || to_char(m_start, 'MM');
                  EXECUTE format(
                    'CREATE TABLE IF NOT EXISTS %I PARTITION OF option_snapshots_new FOR VALUES FROM (%L) TO (%L)',
                    part_name, m_start, (m_start + interval '1 month')::date
                  );
                  m_start := (m_start + interval '1 month')::date;
                END LOOP;
                CREATE TABLE IF NOT EXISTS option_snapshots_new_default PARTITION OF option_snapshots_new DEFAULT;

                -- 3. Copy data (must list columns by name: legacy heaps often had created_at before iv/greeks
                -- from ALTER TABLE ... ADD COLUMN, so SELECT * would misalign types.)
                INSERT INTO option_snapshots_new (
                    option_snapshots_id,
                    contract_key,
                    snapshot_ts,
                    last,
                    bid,
                    ask,
                    mid,
                    iv,
                    delta,
                    gamma,
                    theta,
                    vega,
                    open_interest,
                    underlying_price,
                    underlying_ticker,
                    day_open,
                    day_high,
                    day_low,
                    day_close,
                    day_previous_close,
                    day_change,
                    day_change_percent,
                    day_volume,
                    day_vwap,
                    day_last_updated,
                    break_even_price,
                    fmv,
                    fmv_last_updated,
                    source,
                    created_at
                )
                SELECT
                    option_snapshots_id,
                    contract_key,
                    snapshot_ts,
                    last,
                    bid,
                    ask,
                    mid,
                    iv,
                    delta,
                    gamma,
                    theta,
                    vega,
                    open_interest,
                    underlying_price,
                    NULL::text,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::bigint,
                    NULL::double precision,
                    NULL::timestamptz,
                    NULL::double precision,
                    NULL::double precision,
                    NULL::timestamptz,
                    source,
                    created_at
                FROM option_snapshots;

                -- 4. Set sequence to continue after max id
                PERFORM setval('option_snapshots_new_id_seq',
                  GREATEST(
                    (SELECT COALESCE(max(option_snapshots_id), 0) FROM option_snapshots_new),
                    1
                  )
                );

                -- 5. Swap tables
                DROP MATERIALIZED VIEW IF EXISTS option_snapshots_latest;
                ALTER TABLE option_snapshots RENAME TO option_snapshots_old;
                ALTER TABLE option_snapshots_new RENAME TO option_snapshots;

                -- Rename partitions to standard naming
                FOR part_name IN
                  SELECT tablename FROM pg_tables
                  WHERE schemaname = 'public' AND tablename LIKE 'option_snapshots_new_%'
                LOOP
                  EXECUTE format('ALTER TABLE %I RENAME TO %I',
                    part_name, replace(part_name, '_new_', '_'));
                END LOOP;

                -- Rename and reassign sequence
                ALTER SEQUENCE option_snapshots_new_id_seq RENAME TO option_snapshots_option_snapshots_id_seq;
                ALTER SEQUENCE option_snapshots_option_snapshots_id_seq OWNED BY option_snapshots.option_snapshots_id;
                ALTER TABLE option_snapshots ALTER COLUMN option_snapshots_id SET DEFAULT nextval('option_snapshots_option_snapshots_id_seq');

                -- Drop old table (data already copied)
                DROP TABLE IF EXISTS option_snapshots_old;
                RAISE NOTICE 'Migration complete: option_snapshots is now RANGE partitioned.';

              ELSE
                -- Already partitioned (relkind = 'p'), ensure future partitions exist
                FOR i IN 0..3 LOOP
                  m_start := date_trunc('month', now())::date + (i || ' months')::interval;
                  m_end   := m_start + interval '1 month';
                  part_name := 'option_snapshots_y' || to_char(m_start, 'YYYY') || 'm' || to_char(m_start, 'MM');
                  IF to_regclass('public.' || part_name) IS NULL THEN
                    EXECUTE format(
                      'CREATE TABLE %I PARTITION OF option_snapshots FOR VALUES FROM (%L) TO (%L)',
                      part_name, m_start, m_end
                    );
                  END IF;
                END LOOP;
              END IF;
            END $snap_part$;
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_snapshots_contract_key_ts ON option_snapshots (contract_key, snapshot_ts DESC)"
        )

        _log("option_snapshots_latest materialized view (created after migrate_opt when base columns exist)")
        _log("migrate option_* tables for Massive (R-A6): source column, snapshots greeks")
        cur.execute(
            """
            DO $migrate_opt$
            BEGIN
              IF to_regclass('public.option_day') IS NOT NULL THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_day' AND column_name = 'source'
                ) THEN
                  ALTER TABLE option_day ADD COLUMN source text NOT NULL DEFAULT 'ib';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname = 'option_day_symbol_expiry_strike_option_right_bar_time_key'
                ) THEN
                  ALTER TABLE option_day DROP CONSTRAINT option_day_symbol_expiry_strike_option_right_bar_time_key;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname = 'option_day_bar_uidx'
                ) THEN
                  ALTER TABLE option_day ADD CONSTRAINT option_day_bar_uidx
                    UNIQUE (symbol, expiry, strike, option_right, bar_time, source);
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_day' AND column_name = 'vwap'
                ) THEN
                  ALTER TABLE option_day ADD COLUMN vwap double precision;
                END IF;
              END IF;

              IF to_regclass('public.option_min') IS NOT NULL THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_min' AND column_name = 'source'
                ) THEN
                  ALTER TABLE option_min ADD COLUMN source text NOT NULL DEFAULT 'ib';
                END IF;
                IF EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname = 'option_min_symbol_expiry_strike_option_right_period_bar_time_key'
                ) THEN
                  ALTER TABLE option_min DROP CONSTRAINT option_min_symbol_expiry_strike_option_right_period_bar_time_key;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname = 'option_min_bar_uidx'
                ) THEN
                  ALTER TABLE option_min ADD CONSTRAINT option_min_bar_uidx
                    UNIQUE (symbol, expiry, strike, option_right, period, bar_time, source);
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_min' AND column_name = 'vwap'
                ) THEN
                  ALTER TABLE option_min ADD COLUMN vwap double precision;
                END IF;
              END IF;

              IF to_regclass('public.option_contracts') IS NOT NULL THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_contracts' AND column_name = 'massive_option_ticker'
                ) THEN
                  ALTER TABLE option_contracts ADD COLUMN massive_option_ticker text;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_contracts' AND column_name = 'exercise_style'
                ) THEN
                  ALTER TABLE option_contracts ADD COLUMN exercise_style text;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_contracts' AND column_name = 'shares_per_contract'
                ) THEN
                  ALTER TABLE option_contracts ADD COLUMN shares_per_contract integer;
                END IF;
                IF EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_contracts' AND column_name = 'cfi'
                ) THEN
                  ALTER TABLE option_contracts DROP COLUMN cfi;
                END IF;
                IF EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_contracts' AND column_name = 'primary_exchange'
                ) THEN
                  ALTER TABLE option_contracts DROP COLUMN primary_exchange;
                END IF;
              END IF;

              IF to_regclass('public.option_snapshots') IS NOT NULL THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_snapshots' AND column_name = 'iv'
                ) THEN
                  ALTER TABLE option_snapshots ADD COLUMN iv double precision;
                  ALTER TABLE option_snapshots ADD COLUMN delta double precision;
                  ALTER TABLE option_snapshots ADD COLUMN gamma double precision;
                  ALTER TABLE option_snapshots ADD COLUMN theta double precision;
                  ALTER TABLE option_snapshots ADD COLUMN vega double precision;
                  ALTER TABLE option_snapshots ADD COLUMN open_interest integer;
                  ALTER TABLE option_snapshots ADD COLUMN underlying_price double precision;
                  ALTER TABLE option_snapshots ADD COLUMN source text NOT NULL DEFAULT 'ib';
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_snapshots' AND column_name = 'underlying_ticker'
                ) THEN
                  ALTER TABLE option_snapshots ADD COLUMN underlying_ticker text;
                END IF;
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_snapshots' AND column_name = 'day_open'
                ) THEN
                  ALTER TABLE option_snapshots ADD COLUMN day_open double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_high double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_low double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_close double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_previous_close double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_change double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_change_percent double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_volume bigint;
                  ALTER TABLE option_snapshots ADD COLUMN day_vwap double precision;
                  ALTER TABLE option_snapshots ADD COLUMN day_last_updated timestamptz;
                  ALTER TABLE option_snapshots ADD COLUMN break_even_price double precision;
                  ALTER TABLE option_snapshots ADD COLUMN fmv double precision;
                  ALTER TABLE option_snapshots ADD COLUMN fmv_last_updated timestamptz;
                END IF;
              END IF;

              -- Recreate option_snapshots_latest when base table has Massive day-bar columns but MV does not (upgrade path).
              IF to_regclass('public.option_snapshots') IS NOT NULL THEN
                IF EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'option_snapshots' AND column_name = 'day_close'
                ) AND (
                  NOT EXISTS (
                    SELECT 1 FROM pg_matviews
                    WHERE schemaname = 'public' AND matviewname = 'option_snapshots_latest'
                  )
                  OR NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'option_snapshots_latest' AND column_name = 'day_close'
                  )
                ) THEN
                  DROP MATERIALIZED VIEW IF EXISTS option_snapshots_latest;
                  EXECUTE $mvos$
                    CREATE MATERIALIZED VIEW option_snapshots_latest AS
                    SELECT DISTINCT ON (contract_key)
                      contract_key, snapshot_ts, last, bid, ask, mid,
                      iv, delta, gamma, theta, vega, open_interest, underlying_price,
                      underlying_ticker,
                      day_open, day_high, day_low, day_close,
                      day_previous_close, day_change, day_change_percent,
                      day_volume, day_vwap, day_last_updated,
                      break_even_price, fmv, fmv_last_updated,
                      source, created_at
                    FROM option_snapshots
                    ORDER BY contract_key, snapshot_ts DESC
                  $mvos$;
                  CREATE UNIQUE INDEX IF NOT EXISTS option_snapshots_latest_ck
                    ON option_snapshots_latest (contract_key);
                END IF;
              END IF;
            END
            $migrate_opt$;
            """
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

        _log("job_massive_backfill, option_open_interest_daily, option_trades, massive_corporate_action (R-A6)")
        _log_table("job_massive_backfill", "Massive async sync job queue")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS job_massive_backfill (
                job_massive_backfill_id bigserial PRIMARY KEY,
                kind text NOT NULL,
                payload jsonb NOT NULL DEFAULT '{}'::jsonb,
                status text NOT NULL DEFAULT 'pending',
                result jsonb,
                celery_task_id text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS job_massive_backfill_status_created ON job_massive_backfill (status, created_at)"
        )
        cur.execute(
            """
            DO $jmb_hash$
            BEGIN
              IF to_regclass('public.job_massive_backfill') IS NOT NULL THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'job_massive_backfill' AND column_name = 'payload_hash'
                ) THEN
                  ALTER TABLE job_massive_backfill ADD COLUMN payload_hash text;
                END IF;
              END IF;
            END $jmb_hash$;
            """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS job_massive_backfill_dedup
            ON job_massive_backfill (kind, payload_hash)
            WHERE status IN ('pending', 'running') AND payload_hash IS NOT NULL
            """
        )

        _log_table("report_option_max_pain_daily", "Max Pain daily report (R-A6)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS report_option_max_pain_daily (
                report_option_max_pain_daily_id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                trade_date date NOT NULL,
                max_pain_strike double precision NOT NULL,
                underlying_close double precision,
                total_oi integer,
                computation_detail jsonb,
                source text NOT NULL DEFAULT 'massive',
                created_at timestamptz DEFAULT now(),
                UNIQUE (symbol, expiry, trade_date, source)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS report_max_pain_symbol_date ON report_option_max_pain_daily (symbol, trade_date DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS report_max_pain_symbol_expiry_date ON report_option_max_pain_daily (symbol, expiry, trade_date DESC)"
        )

        _log_table(
            "report_option_atm_iv_daily",
            "Daily ATM IV rollup per symbol/expiry (Option Discovery IV cone fast path)",
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS report_option_atm_iv_daily (
                report_option_atm_iv_daily_id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                trade_date date NOT NULL,
                source text NOT NULL DEFAULT 'massive',
                atm_iv double precision,
                iv_call double precision,
                iv_put double precision,
                strike double precision,
                underlying_price double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE (symbol, expiry, trade_date, source)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS report_atm_iv_symbol_expiry_date ON report_option_atm_iv_daily (symbol, expiry, trade_date DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS report_atm_iv_symbol_date ON report_option_atm_iv_daily (symbol, trade_date DESC)"
        )

        _log_table("option_open_interest_daily", "Option daily open interest (Massive)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_open_interest_daily (
                option_open_interest_daily_id bigserial PRIMARY KEY,
                contract_key text NOT NULL,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                trade_date date NOT NULL,
                open_interest integer NOT NULL,
                source text NOT NULL DEFAULT 'massive',
                created_at timestamptz DEFAULT now(),
                UNIQUE (contract_key, trade_date, source)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_oi_daily_contract_date ON option_open_interest_daily (contract_key, trade_date DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_oi_daily_symbol_date ON option_open_interest_daily (symbol, trade_date DESC)"
        )
        _log_table("option_trades", "Option trades ticks (Massive Developer tier)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_trades (
                option_trades_id bigserial PRIMARY KEY,
                contract_key text NOT NULL,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                trade_ts timestamptz NOT NULL,
                price double precision NOT NULL,
                size integer NOT NULL,
                exchange text,
                conditions text,
                massive_trade_id text NOT NULL,
                source text NOT NULL DEFAULT 'massive',
                created_at timestamptz DEFAULT now(),
                UNIQUE (massive_trade_id)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_trades_contract_ts ON option_trades (contract_key, trade_ts DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_trades_symbol_ts ON option_trades (symbol, trade_ts DESC)"
        )
        _log_table("massive_corporate_action", "Corporate actions cache (Massive)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS massive_corporate_action (
                massive_corporate_action_id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                action_type text NOT NULL,
                ex_date date,
                record_date date,
                payment_date date,
                ratio_from double precision,
                ratio_to double precision,
                amount double precision,
                currency text,
                description text,
                source text NOT NULL DEFAULT 'massive',
                created_at timestamptz DEFAULT now(),
                UNIQUE (symbol, action_type, ex_date, source)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS massive_corp_action_symbol_ex ON massive_corporate_action (symbol, ex_date DESC)"
        )

        # ── Executions: raw tables + account_executions view ──
        # TWS and Flex stored separately; view merges (Flex authoritative, TWS fills gaps).
        # Match key: exec_id (IB Execution ID = Flex ibExecID).
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

        # TWS-only "on the fly" rows: drop any TWS execution already covered by account_executions_final.
        # Match (1) exact contract_key trim equality; (2) STK rows where keys differ only in trailing
        # pipes — IB builds "SYM|STK||||" while Flex uses "SYM|STK|||"; (3) same account + symbol when
        # TWS sec_type is STK and final row is equity-like (e.g. Flex assetCategory FUND vs IB STK).
        _exec_canonical_cols_t = ", ".join(
            f"t.{c.strip()}" for c in _EXEC_CANONICAL_COLS.split(",") if c.strip()
        )
        # Equity-like final rows (excludes OPT — same ticker can name a stock and an option).
        _fly_final_equity_sec_types = (
            "'STK', 'EQUITY', 'FUND', 'ETF', 'ETN', 'ADR', 'CORP', 'STOCK', 'REIT', 'WAR'"
        )
        # Prefer f.sec_type; if null/blank (some Flex rows), infer from contract_key segment 2.
        _fly_f_sec_norm = (
            "upper(trim(COALESCE("
            "NULLIF(trim(COALESCE(f.sec_type, '')), ''), "
            "NULLIF(trim(split_part(COALESCE(f.contract_key, ''), '|', 2)), '')"
            ")))"
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
                  AND (
                    (
                      NULLIF(trim(COALESCE(t.contract_key, '')), '') IS NOT NULL
                      AND NULLIF(trim(COALESCE(f.contract_key, '')), '') IS NOT NULL
                      AND trim(COALESCE(f.contract_key, '')) = trim(COALESCE(t.contract_key, ''))
                    )
                    OR (
                      upper(trim(COALESCE(t.sec_type, ''))) = 'STK'
                      AND upper(trim(COALESCE(f.sec_type, ''))) = 'STK'
                      AND NULLIF(trim(COALESCE(t.contract_key, '')), '') IS NOT NULL
                      AND NULLIF(trim(COALESCE(f.contract_key, '')), '') IS NOT NULL
                      AND rtrim(trim(COALESCE(t.contract_key, '')), '|') = rtrim(trim(COALESCE(f.contract_key, '')), '|')
                    )
                    OR (
                      upper(trim(COALESCE(t.sec_type, ''))) = 'STK'
                      AND {_fly_f_sec_norm} IN ({_fly_final_equity_sec_types})
                      AND NULLIF(trim(COALESCE(t.symbol, '')), '') IS NOT NULL
                      AND upper(trim(COALESCE(t.symbol, ''))) = upper(trim(COALESCE(f.symbol, '')))
                    )
                  )
            )
        """
        )
        _log("account_executions_fly(view: TWS minus final-covered contracts, no BAG)")

        # One execution row (unified account_executions_id) may attribute quantity to multiple strategy_instance rows.
        _log_table(
            "account_execution_instance_allocation",
            "Execution to strategy_instance quantity splits (R-A2 extension)",
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_execution_instance_allocation (
                account_execution_instance_allocation_id bigserial PRIMARY KEY,
                account_id text NOT NULL,
                account_executions_id bigint NOT NULL,
                strategy_instance_id bigint NOT NULL REFERENCES strategy_instance(strategy_instance_id) ON DELETE RESTRICT,
                allocated_quantity double precision NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (account_executions_id, strategy_instance_id)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_exec_inst_alloc_account_exec_id "
            "ON account_execution_instance_allocation (account_id, account_executions_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_exec_inst_alloc_strategy_instance_id "
            "ON account_execution_instance_allocation (strategy_instance_id)"
        )

        # OPT exercise / assignment: link option execution row(s) to underlying STK fills (performance book).
        _log_table(
            "account_execution_option_stock_link",
            "Option leg to underlying stock execution(s); slippage vs close_price computed in API reader",
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_execution_option_stock_link (
                account_execution_option_stock_link_id bigserial PRIMARY KEY,
                account_id text NOT NULL,
                option_account_executions_id bigint NOT NULL,
                stock_account_executions_id bigint NOT NULL,
                role text,
                note text,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (option_account_executions_id, stock_account_executions_id),
                CONSTRAINT account_execution_option_stock_link_role_chk CHECK (
                    role IS NULL OR lower(trim(role)) IN ('exercise', 'assignment')
                )
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_exec_opt_stock_link_option "
            "ON account_execution_option_stock_link (account_id, option_account_executions_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_exec_opt_stock_link_stock "
            "ON account_execution_option_stock_link (account_id, stock_account_executions_id)"
        )

        conn.commit()
