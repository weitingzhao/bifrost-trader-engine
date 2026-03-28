"""Cross-cutting utilities shared by app, config, daemon, monitor, and scripts.

This package is **not** the trading runtime kernel: that lives under ``src.daemon.core``
(Store, FSM state, classifier). Use ``src.core`` only for config merging, Redis URL helpers, etc.
"""
