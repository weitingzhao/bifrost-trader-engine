# Initialization scripts (deployment)

One-time SQL scripts for system deployment. Run **after** `python scripts/db_refresh_schema.py` (so tables exist).

Currently there are no required init scripts: Flex default range is `settings.flex_default_range_days` (default 30), init range is `settings.flex_init_range_days` (default 360), both managed via Settings page.

## Reference

- Settings: [docs/DATABASE.md](../docs/DATABASE.md) §2.9 (`flex_default_range_days`, `flex_init_range_days`).
