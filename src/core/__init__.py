"""Cross-cutting utilities shared by app, config, daemon, monitor, and scripts.

This package is **not** the trading runtime kernel: that lives under ``src.daemon.core``
(Store, FSM state, classifier). Use ``src.core`` only for config merging, Redis URL helpers, etc.

``src.core.realtime`` — Redis quote keys/read/write/subscribe; depends only on redis and the stdlib
(no daemon/monitor/FastAPI). ``src.connector`` is process-agnostic IB wiring.
``src.persistence`` — StatusSink port and PostgreSQL (psycopg2); no daemon/monitor/FastAPI.
"""
