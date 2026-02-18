# Bifrost Trader Engine

Gamma scalping trading daemon for NVDA 21-35 DTE near-ATM straddle (Interactive Brokers).

## Documentation

- **[FSM](fsm/linkage.md)** – State machine diagrams and linkage (Daemon, Trading, Hedge)
- **[State Space](STATE_SPACE_MAPPING.md)** – O, D, M, L, E, S mapping
- **[Config Safety](CONFIG_SAFETY_TAXONOMY.md)** – Configuration taxonomy

## Build Docs

Run from **project root** (where `mkdocs.yml` lives):

```bash
# Generate FSM markdown from source
python scripts/build_fsm_docs.py

# Build MkDocs site
mkdocs build

# Serve locally (from project root)
mkdocs serve
```
