# Bifrost Trader Engine

Gamma scalping trading daemon for **NVDA** 21–35 DTE near-ATM straddle on Interactive Brokers. Single-process, event-driven: rehedges when |portfolio delta| > 25 shares, with 60s cooldown and strict risk limits.

## Phase 1 MVP

- **Single underlying**: NVDA only
- **Structure**: 21–35 DTE near ATM straddle (only these positions used for delta)
- **Hedge**: |Δ| > 25 shares → hedge; 60s cooldown after each hedge
- **Event window**: No hedge during earnings blackout (configurable days before/after)
- **Risk**: Max daily hedge count, max position size, max daily loss circuit breaker

## Requirements

- Python 3.10+
- IB Gateway or TWS running with API enabled
- `config/config.yaml` (copy from `config/config.yaml.example`)

## Install

From the project root:

```bash
python -m pip install -r requirements.txt
# or
python -m pip install -e .
```

**Windows** (if `pip` or `python` are not on PATH): run from project root `.\os\win\install.cmd` or `.\os\win\install.ps1`. See [os/win/README.md](os/win/README.md).

## Config

Copy `config/config.yaml.example` to `config/config.yaml`. Set:

- **ib**: host, port, client_id (or use env `IB_HOST`, `IB_PORT`, `IB_CLIENT_ID`)
- **symbol**: `NVDA`
- **hedge**: threshold_hedge_shares (25), cooldown_sec (60), max_hedge_shares_per_order
- **earnings.dates**: list of `YYYY-MM-DD` earnings dates for blackout
- **risk**: max_daily_hedge_count, max_position_shares, max_daily_loss_usd, trading_hours_only, **paper_trade** (set `false` for live)

## Run

```bash
python scripts/run_engine.py
# or with config path
python scripts/run_engine.py config/config.yaml
```

Run as a daemon via systemd, supervisor, or Docker (single process, long-running).

## Run environment and operations

- **Single account**: TWS with one account; auto-trading (this daemon) and manual trading share the account (different API `client_id`).
- **Daemon**: Single-process, single-thread; runs on the same machine as TWS. Monitoring and control are done by **separate app(s)** (see [docs/RUN_ENVIRONMENT_AND_REQUIREMENTS.md](docs/RUN_ENVIRONMENT_AND_REQUIREMENTS.md)).
- **Deployment**: Mac (all-in-one) or Linux server (TWS + daemon on server; manual trading via remote desktop). See the doc above for details.

## Architecture

The system has **three parts**: (1) **auto-trading** daemon, (2) **monitoring & control** (separate app), (3) **backtest-based safety boundary tuning** (reuse FSM/Guard on historical replay). Full system architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Requirements: [docs/RUN_ENVIRONMENT_AND_REQUIREMENTS.md](docs/RUN_ENVIRONMENT_AND_REQUIREMENTS.md) §2.

- **Auto-trading**: IB Connector, Store, Portfolio (parse 21–35 DTE near ATM → delta), Gamma Scalper (|Δ| > threshold → hedge), Risk Guard (cooldown, daily limits, earnings blackout), Daemon (single process, single asyncio loop; on ticker/heartbeat run maybe_hedge).
- **Monitoring & control**: Daemon writes state via a sink (e.g. SQLite); a **separate** app reads it and exposes HTTP/CLI and sends stop/pause (see run environment doc).
- **Backtest**: Same StateClassifier + FSM + Guard, fed by historical replay; no live orders; used primarily to **optimize strategy PnL** (theory P&L, curve, drawdown) and to validate/tune Guard/boundary parameters (see docs/PLAN_NEXT_STEPS.md).

## State space (O,D,M,L,E,S)

The engine uses a six-dimensional state space for hedge gating. See [docs/STATE_SPACE_MAPPING.md](docs/STATE_SPACE_MAPPING.md) for the state space table → code mapping, threshold config and defaults, and when TargetPosition is output vs SAFE_MODE.

## License

Private / use at your own risk.
