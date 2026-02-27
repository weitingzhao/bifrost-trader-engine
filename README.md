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

**On the trading machine** (same host as TWS/IB):

```bash
python scripts/run_engine.py config/config.yaml
```

Run as a daemon via systemd, supervisor, or Docker.

### Phase 2: Status server (monitoring and control)

The **status server** (monitoring and control) is a **separate process** from the trading daemon (RE-5). **Default deployment** is **cross-host**: status server on one machine (monitoring host), daemon (`run_engine.py`) on another (trading host, same machine as IB). The daemon must run on the same machine as IB; the status server can run anywhere that can reach PostgreSQL. Control (stop/flatten/suspend/resume) uses **PostgreSQL** (`daemon_control`, `daemon_run_status`); no shared filesystem is required. Run the status server; it reads PostgreSQL (`status_current`, `operations`) and exposes HTTP API.

**Config** (in `config/config.yaml`):

- `status.sink: "postgres"` and `status.postgres`: same as Phase 1; control uses the same DB and tables (see [docs/DATABASE.md](docs/DATABASE.md) §2.4–2.5).
- `status_server.port`: HTTP port (default 8765).
- **API only**: Port 8765 serves FastAPI (GET /status, GET /operations, POST /control/*). **Monitoring UI** is the separate frontend in `frontend/` (e.g. `cd frontend && npm run dev` then open the dev server URL, or build and deploy the frontend elsewhere; it calls this API). **Start** the daemon on the **daemon host** (Mac Mini or Linux server): run `python scripts/run_engine.py config/config.yaml`. TWS runs on a dedicated Mac Mini; the daemon connects to it (same machine or over network from Linux). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §6.1 and §2.3–2.4 (run environment).

**Start**:

```bash
python scripts/run_server.py
# or
python scripts/run_server.py config/config.yaml
```

**Examples** (replace `<host>` with `localhost` or the server IP):

```bash
# Current status and lamp (green/yellow/red)
curl http://<host>:8765/status

# Operations list (optional: ?since_ts=...&until_ts=...&type=fill&limit=50)
curl http://<host>:8765/operations?limit=10

# Request daemon stop (inserts into daemon_control; daemon exits on next heartbeat)
curl -X POST http://<host>:8765/control/stop

# Suspend/resume hedging (updates daemon_run_status; daemon skips maybe_hedge when suspended)
curl -X POST http://<host>:8765/control/suspend
curl -X POST http://<host>:8765/control/resume
```

## Run environment and operations

- **Single account**: TWS with one account; auto-trading (this daemon) and manual trading share the account (different API `client_id`). **Deployment**: TWS runs on a **dedicated Mac Mini** only; you remote into that Mac Mini (e.g. from MacBook Air) for manual trading. The **daemon** runs on that Mac Mini or on a **separate Linux server**, connecting to TWS for market data and orders (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2.3).

## Architecture

The system has **three parts**: (1) **auto-trading** daemon, (2) **monitoring & control** (separate app), (3) **backtest-based safety boundary tuning** (reuse FSM/Guard on historical replay). Full system architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Product requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

- **Auto-trading**: IB Connector, Store, Portfolio (parse 21–35 DTE near ATM → delta), Gamma Scalper (|Δ| > threshold → hedge), Risk Guard (cooldown, daily limits, earnings blackout), Daemon (single process, single asyncio loop; on ticker/heartbeat run maybe_hedge).
- **Monitoring & control**: Daemon writes state via a sink (e.g. SQLite); a **separate** app reads it and exposes HTTP/CLI and sends stop/pause (see run environment doc).
- **Backtest**: Same StateClassifier + FSM + Guard, fed by historical replay; no live orders; used primarily to **optimize strategy PnL** (theory P&L, curve, drawdown) and to validate/tune Guard/boundary parameters (see docs/PLAN_NEXT_STEPS.md).

## State space (O,D,M,L,E,S)

The engine uses a six-dimensional state space for hedge gating. See [docs/STATE_SPACE_MAPPING.md](docs/STATE_SPACE_MAPPING.md) for the state space table → code mapping, threshold config and defaults, and when TargetPosition is output vs SAFE_MODE.

## License

Private / use at your own risk.
