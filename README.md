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
- **hedge**: delta_threshold_shares (25), cooldown_sec (60), max_hedge_shares_per_order
- **earnings.dates**: list of `YYYY-MM-DD` earnings dates for blackout
- **risk**: max_daily_hedge_count, max_position_shares, max_daily_loss_usd, trading_hours_only, **paper_trade** (set `false` for live)

## Run

```bash
python scripts/run_engine.py
# or with config path
python scripts/run_engine.py config/config.yaml
```

Run as a daemon via systemd, supervisor, or Docker (single process, long-running).

## Architecture

- **IB Connector**: connect, positions, underlying ticker, place stock orders; optional subscriptions for ticker and position updates
- **State**: in-memory positions, spot, last_hedge_time, daily_hedge_count, daily_pnl
- **Portfolio**: parse IB positions → filter 21–35 DTE near ATM → portfolio delta (Black–Scholes)
- **Gamma Scalper**: |Δ| > 25 → propose BUY/SELL quantity
- **Risk Guard**: cooldown, max daily hedges, max position, earnings blackout, circuit breaker
- **Daemon**: event-driven loop; on ticker/position update or heartbeat (10s), run maybe_hedge

## State space (O,D,M,L,E,S)

The engine uses a six-dimensional state space for hedge gating. See [docs/STATE_SPACE_MAPPING.md](docs/STATE_SPACE_MAPPING.md) for the state space table → code mapping, threshold config and defaults, and when TargetPosition is output vs SAFE_MODE.

## License

Private / use at your own risk.
