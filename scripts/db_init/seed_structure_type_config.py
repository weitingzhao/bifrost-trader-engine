#!/usr/bin/env python3
"""Seed strategy_structure_type and related config tables with initial data.

Data matches current hardcoded values in structure_type_schema.py and
frontend strategyFormUtils.ts (Covered Call subtypes). Run after schema
refresh (e.g. python scripts/db_refresh_schema.py).

Usage:
  python scripts/db_init/seed_structure_type_config.py [--config PATH]
  --config  Config file path (default config/config.yaml)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed structure type config tables (strategy_structure_type, subtype, legs, etc.)."
    )
    parser.add_argument(
        "--config",
        default="config/config.yaml",
        help="Config file path",
    )
    args = parser.parse_args()
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    if not Path(config_path).exists():
        print(f"Config not found: {config_path}", file=sys.stderr)
        return 1

    try:
        import yaml
        import psycopg2
        from src.sink.postgres_sink import _get_conn_params
    except ImportError as e:
        print(f"Missing dependency: {e}", file=sys.stderr)
        return 1

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    pg = config.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print("postgres or PGHOST required.", file=sys.stderr)
        return 1

    params = _get_conn_params(config)
    params["connect_timeout"] = 10

    conn = None
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"Connect failed: {e}", file=sys.stderr)
        return 1

    try:
        with conn.cursor() as cur:
            # 1. strategy_structure_type (display order: Covered Call first, then Cash Secured Put, etc.)
            types_rows = [
                ("covered_call", "Covered Call", 0, True, None),
                ("cash_secured_put", "Cash Secured Put", 1, False, None),
                ("iron_condor", "Iron Condor", 2, False, None),
                ("straddle_strangle", "Straddle / Strangle", 3, False, None),
                ("leaps", "LEAPS", 4, False, None),
                ("calendar_spread", "Calendar Spread", 5, False, None),
                ("custom", "Custom", 6, False, None),
            ]
            for structure_type, display_label, sort_order, has_subtypes, type_explanation in types_rows:
                cur.execute(
                    """
                    INSERT INTO strategy_structure_type
                        (structure_type, display_label, sort_order, has_subtypes, type_explanation)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (structure_type) DO UPDATE SET
                        display_label = EXCLUDED.display_label,
                        sort_order = EXCLUDED.sort_order,
                        has_subtypes = EXCLUDED.has_subtypes,
                        type_explanation = EXCLUDED.type_explanation,
                        updated_at = now()
                    """,
                    (structure_type, display_label, sort_order, has_subtypes, type_explanation),
                )

            # 2. strategy_structure_type_leg (default legs per type; custom has none)
            legs_per_type = [
                ("covered_call", [
                    ("underlying", "long", None, 1),
                    ("call", "short", "C", 1),
                ]),
                ("straddle_strangle", [
                    ("call", "long", "C", 1),
                    ("put", "long", "P", 1),
                ]),
                ("cash_secured_put", [
                    ("put", "short", "P", 1),
                ]),
                ("iron_condor", [
                    ("put", "long", "P", 1),
                    ("put", "short", "P", 1),
                    ("call", "short", "C", 1),
                    ("call", "long", "C", 1),
                ]),
                ("leaps", [
                    ("call", "long", "C", 1),
                ]),
                ("calendar_spread", [
                    ("call", "short", "C", 1),
                    ("call", "long", "C", 1),
                ]),
            ]
            for structure_type, legs in legs_per_type:
                for sort_order, (role, direction, option_right, qty) in enumerate(legs):
                    cur.execute(
                        """
                        INSERT INTO strategy_structure_type_leg
                            (structure_type, sort_order, role, direction, option_right, quantity_default)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (structure_type, sort_order) DO UPDATE SET
                            role = EXCLUDED.role,
                            direction = EXCLUDED.direction,
                            option_right = EXCLUDED.option_right,
                            quantity_default = EXCLUDED.quantity_default
                        """,
                        (structure_type, sort_order, role, direction, option_right, qty),
                    )

            # 3. strategy_structure_subtype (Covered Call only: otm, atm, itm, deep_otm)
            subtype_explanation = (
                "Configurable parameters (strategy_structure_meta). "
                "Underlying is stock by default. Option strike is resolved when the structure is applied; "
                "set below to constrain (e.g. OTM %)."
            )
            subtypes_rows = [
                ("covered_call", "otm", "OTM Covered Call",
                 "Long 100 NVDA, Sell NVDA 1M 10% OTM Call",
                 "Enhance income on long-term stock holdings; the most common type.",
                 subtype_explanation, None, 0),
                ("covered_call", "atm", "ATM Covered Call",
                 "Long NVDA, Sell NVDA ATM Call",
                 "Short-term lock gains; preparing to sell stock; commonly used by funds.",
                 subtype_explanation, None, 1),
                ("covered_call", "itm", "ITM Covered Call",
                 "NVDA = 100, Sell 90 Call",
                 "Want to sell stock but also capture time value.",
                 subtype_explanation, "Synthetic limit sell", 2),
                ("covered_call", "deep_otm", "Deep OTM Covered Call",
                 "Sell 20% OTM Call",
                 "Enhance income for very long-term holders; many long-term investors use this.",
                 subtype_explanation, None, 3),
            ]
            for (structure_type, subtype, display_label, example, typical_use,
                 sub_expl, nature, sort_order) in subtypes_rows:
                cur.execute(
                    """
                    INSERT INTO strategy_structure_subtype
                        (structure_type, subtype, display_label, example, typical_use,
                         subtype_explanation, nature, sort_order)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (structure_type, subtype) DO UPDATE SET
                        display_label = EXCLUDED.display_label,
                        example = EXCLUDED.example,
                        typical_use = EXCLUDED.typical_use,
                        subtype_explanation = EXCLUDED.subtype_explanation,
                        nature = EXCLUDED.nature,
                        sort_order = EXCLUDED.sort_order,
                        updated_at = now()
                    """,
                    (structure_type, subtype, display_label, example, typical_use,
                     sub_expl, nature, sort_order),
                )

            # 4. strategy_structure_subtype_characteristic (one row per characteristic; replace per subtype)
            characteristics_data = [
                ("covered_call", "otm", [
                    "Collect premium",
                    "Cap upside",
                    "Provide downside buffer",
                ]),
                ("covered_call", "atm", [
                    "Very high premium",
                    "Nearly lock in gains",
                    "High assignment risk",
                ]),
                ("covered_call", "itm", [
                    "Very high premium",
                    "Similar to selling stock early",
                ]),
                ("covered_call", "deep_otm", [
                    "Small premium",
                    "Minimal impact on upside",
                ]),
            ]
            for structure_type, subtype, items in characteristics_data:
                cur.execute(
                    "DELETE FROM strategy_structure_subtype_characteristic WHERE structure_type = %s AND subtype = %s",
                    (structure_type, subtype),
                )
                for sort_order, text in enumerate(items):
                    cur.execute(
                        """
                        INSERT INTO strategy_structure_subtype_characteristic
                            (structure_type, subtype, sort_order, characteristic_text)
                        VALUES (%s, %s, %s, %s)
                        """,
                        (structure_type, subtype, sort_order, text),
                    )

            # 5. strategy_structure_subtype_meta_param
            # call_strike_rule uses conceptual buckets; specific % comes from otm_pct/itm_pct params.
            meta_param_rows = [
                ("covered_call", "otm", "call_strike_rule", "Call strike rule", "normal_otm", "fixed", 0),
                ("covered_call", "otm", "otm_pct", "OTM % (call strike)", "10", "percent", 1),
                ("covered_call", "atm", "call_strike_rule", "Call strike rule", "atm", "fixed", 0),
                ("covered_call", "itm", "call_strike_rule", "Call strike rule", "itm", "fixed", 0),
                ("covered_call", "itm", "itm_pct", "ITM % (optional)", None, "percent", 1),
                ("covered_call", "deep_otm", "call_strike_rule", "Call strike rule", "deep_otm", "fixed", 0),
                ("covered_call", "deep_otm", "otm_pct", "OTM % (call strike)", "20", "percent", 1),
            ]
            for structure_type, subtype, meta_key, display_label, default_value_text, param_kind, sort_order in meta_param_rows:
                cur.execute(
                    """
                    INSERT INTO strategy_structure_subtype_meta_param
                        (structure_type, subtype, meta_key, display_label, default_value_text, param_kind, sort_order)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (structure_type, subtype, meta_key) DO UPDATE SET
                        display_label = EXCLUDED.display_label,
                        default_value_text = EXCLUDED.default_value_text,
                        param_kind = EXCLUDED.param_kind,
                        sort_order = EXCLUDED.sort_order
                    """,
                    (structure_type, subtype, meta_key, display_label, default_value_text, param_kind, sort_order),
                )

            # 6. strategy_structure_subtype_rule (infer subtype from meta)
            rule_rows = [
                ("covered_call", "otm", "call_strike_rule", "normal_otm"),
                ("covered_call", "atm", "call_strike_rule", "atm"),
                ("covered_call", "itm", "call_strike_rule", "itm"),
                ("covered_call", "deep_otm", "call_strike_rule", "deep_otm"),
            ]
            for structure_type, subtype, meta_key, meta_value_text in rule_rows:
                cur.execute(
                    """
                    INSERT INTO strategy_structure_subtype_rule
                        (structure_type, subtype, meta_key, meta_value_text)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (structure_type, meta_key, meta_value_text) DO UPDATE SET
                        subtype = EXCLUDED.subtype
                    """,
                    (structure_type, subtype, meta_key, meta_value_text),
                )

        conn.commit()
        print("Seed completed: strategy_structure_type, type_leg, subtype, characteristic, meta_param, rule.")
        return 0
    except Exception as e:
        conn.rollback()
        print(f"Seed failed: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
