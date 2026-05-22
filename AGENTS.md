# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Language

**与本项目用户的所有对话一律使用中文。** All agent dialogue, explanations, summaries, and replies must be in Chinese, regardless of global language settings.

- UI strings and code identifiers: English only
- Code comments: Chinese or English (no preference)
- Documentation: Chinese or English as the project owner prefers

## Project Overview

Bifrost Trader Engine is a gamma scalping trading daemon for NVDA 21–35 DTE near-ATM straddle positions via Interactive Brokers. The system is split into a Python backend (daemon + multiple FastAPI microservices) and a React/TypeScript frontend monitoring UI.

## Commands

### Backend (Python)

```bash
# Install dependencies (from project root)
pip install -e .

# Run all tests
pytest

# Run tests without live IB connection
pytest -m 'not ib'

# Run a single test file
pytest tests/path/to/test_file.py -v

# Initialize/refresh PostgreSQL schema
python scripts/db/db_refresh_schema.py

# Verify IB connection
python scripts/check/ib/check_ib_connect.py
```

### Running Services (from project root)

```bash
# Trading engine daemon
python scripts/systemd/run_engine.py [config/config.yaml]

# Monitor/Control API (default port 8765)
python scripts/run_server.py

# Domain-specific APIs
python scripts/run_server_ops.py         # port 8768
python scripts/run_server_trading.py     # port 8769
python scripts/run_server_portfolio.py   # port 8771
python scripts/run_server_market.py      # port 8772
python scripts/run_server_research.py    # port 8773
python scripts/run_server_massive.py     # port 8766

# Celery worker
python scripts/systemd/run_celery.py

# Edge services
python scripts/systemd/run_ib_ingestor.py
python scripts/systemd/run_ib_account_agent.py
python scripts/systemd/run_ib_operator.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev      # Dev server at port 5173
npm run build    # Production build (includes sync:massive-coverage step)
```

### Environment Selection

Config resolves based on `BIFROST_ENV` env var or `--prod` flag:
- Dev: `config/config.dev.yaml`
- Prod: `config/config.prod.yaml`
- Template with all defaults: `config/config.yaml.example`

## Architecture

### System Topology

```
Mac Mini (TWS) ←── IB API ──→ IB Ingestor → Redis
                              IB Account Agent → Redis
                              IB Operator ← RPC ← Daemon

Linux Server:
  Daemon (run_engine.py) → reads Redis, writes PostgreSQL
  Monitor API (run_server.py) → reads PostgreSQL → Frontend
  Celery Workers → async bar/Polygon data backfill

Frontend (React SPA) → HTTP → multiple FastAPI backends
```

### Backend Daemon (`src/`)

The daemon (`src/daemon/app/gs_trading.py: GsTrading`) is a **single asyncio process** with:
- **FSMs**: `DaemonFSM` (lifecycle) → `TradingFSM` (activity) → `HedgeFSM` (execution)
- **ExecutionGuard**: risk filter (cooldown, daily limits, position/loss limits)
- **StatusSink** → `PostgreSQLSink`: writes `daemon_control`, `daemon_run_status`, `snapshots`
- **State space** dimensions: O (order), D (delta band), M (market), L (liquidity), E (event window), S (system)

IB integration is decoupled into edge services: the daemon reads quotes/account state from Redis and sends orders via RPC to `run_ib_operator.py`.

### Backend APIs (`backend/<domain>/app.py`)

Each domain is an independent FastAPI app on its own port. Pattern:
- `GET /status` — read-only health
- `GET /operations` — transaction log
- `POST /control/{action}` — daemon control signal
- `GET /quotes/stream` — SSE subscription

### Frontend (`frontend/src/`)

- **Stack**: Next.js 15 App Router (`frontend/src/app/`), React 19, Tailwind 4, shadcn/Radix
- **Entry**: `app/layout.tsx` → `providers.tsx` (`initApiRouting`, React Query, `AppProvider`)
- **Routes**: `app/(trading)/**` thin pages wrapping `views/*` components
- **API clients**: domain modules under `api/` (avoid new imports from deprecated `api/index.ts` barrel)
- **Real-time**: SSE for quotes and system messages; React Query for global monitor polls only
- **Styling**: `design-tokens.css` + `shadcn-tokens.css` + retiring `legacy.css` — see `docs/plans/LEGACY_CSS_RETIREMENT.md`. New UI: Tailwind + `@/components/ui/*`; use `PageSection`, `SectionPageTitle`, `Button`. Run `npm run lint:legacy-classes` and `npm run css:metrics` from `frontend/`.
- **UI reference**: Skote Admin template (visual only; do not copy code/deps)

### Key Docs (authoritative references)

- `docs/ARCHITECTURE.md` — system design, deployment topology, Dev/Prod isolation
- `docs/REQUIREMENTS.md` — product requirements (R-M*, R-C*, R-H*, R-B*, R-A*, R-DV*)
- `docs/DATABASE.md` — PostgreSQL schema (authoritative); all schema changes must be documented here with a §6 change log entry
- `docs/plans/CAPABILITY_TRACKING.md` — capability progress and gaps

**The core document triangle** (`REQUIREMENTS.md` ↔ `ARCHITECTURE.md` ↔ `CAPABILITY_TRACKING.md`) is modified **only** when the project owner explicitly requests a change. Keep all three consistent after any change.

## Database Conventions

- Table prefixes: `strategy_` (option structures/opportunities), `gate_safety_` (risk boundary config), `job_` (Celery queue), `preference_` (user preferences)
- PK naming: `<table_name>_id` for multi-row tables; `id` for single-row tables (e.g. `settings`, `daemon_heartbeat`)
- FK columns match the referenced PK name exactly
- `gate_safety_*` tables: scalar columns only — no jsonb/json
- Dev/Prod use separate databases: `bifrost_dev` vs `bifrost_prod`

## Service Ports

| Service | Port |
|---------|------|
| Frontend (Vite dev) | 5173 |
| Monitor API | 8765 |
| Massive (Research) | 8766 |
| Docs API | 8767 |
| Ops API | 8768 |
| Trading API | 8769 |
| Strategy API | 8770 |
| Portfolio API | 8771 |
| Market API | 8772 |
| Research API | 8773 |
