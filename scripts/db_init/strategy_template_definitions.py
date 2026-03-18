"""Shared dimension rows and strategy template definitions for seed (strategy_dim, strategy_template*)."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

# (dim_type, code, display_label, sort_order)
DIM_ROWS: List[Tuple[str, str, str, int]] = [
    ("direction", "bullish", "Bullish", 0),
    ("direction", "bearish", "Bearish", 1),
    ("direction", "neutral", "Neutral", 2),
    ("structure", "single_leg", "Single leg", 0),
    ("structure", "vertical", "Vertical spread", 1),
    ("structure", "calendar", "Calendar spread", 2),
    ("structure", "diagonal", "Diagonal spread", 3),
    ("structure", "straddle", "Straddle / strangle", 4),
    ("structure", "condor", "Condor", 5),
    ("structure", "butterfly", "Butterfly", 6),
    ("structure", "ratio", "Ratio spread", 7),
    ("structure", "custom", "Custom", 8),
    ("coverage", "covered", "Covered", 0),
    ("coverage", "naked", "Naked", 1),
    ("coverage", "cash_secured", "Cash secured", 2),
    ("coverage", "synthetic", "Synthetic", 3),
    ("risk", "defined", "Defined risk", 0),
    ("risk", "undefined", "Undefined risk", 1),
    ("volatility", "long_vol", "Long volatility", 0),
    ("volatility", "short_vol", "Short volatility", 1),
    ("volatility", "vol_neutral", "Volatility neutral", 2),
    ("time", "weekly", "Weekly", 0),
    ("time", "monthly", "Monthly", 1),
    ("time", "leaps", "LEAPS", 2),
    ("time", "flex", "Flex DTE", 3),
]

SUBTYPE_EXPLANATION = (
    "Configurable parameters (strategy_structure_meta). "
    "Underlying is stock by default. Option strike is resolved when the structure is applied; "
    "set below to constrain (e.g. OTM %)."
)

# Template dict keys: template_code, display_name, dim_*, sort_order, legs [(role,dir,right,qty)],
# optional: explanation, typical_use, example, nature, characteristics[], meta_params[(key,label,default,kind,so)]
TEMPLATES: List[Dict[str, Any]] = [
    {
        "template_code": "covered_call_otm",
        "display_name": "OTM Covered Call",
        "dim_direction": "bullish",
        "dim_structure": "vertical",
        "dim_coverage": "covered",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "monthly",
        "sort_order": 0,
        "example": "Long 100 NVDA, Sell NVDA 1M 10% OTM Call",
        "typical_use": "Enhance income on long-term stock holdings; the most common type.",
        "explanation": SUBTYPE_EXPLANATION,
        "nature": None,
        "legs": [("underlying", "long", None, 1), ("call", "short", "C", 1)],
        "characteristics": ["Collect premium", "Cap upside", "Provide downside buffer"],
        "meta_params": [
            ("call_strike_rule", "Call strike rule", "normal_otm", "fixed", 0),
            ("otm_pct", "OTM % (call strike)", "10", "percent", 1),
        ],
    },
    {
        "template_code": "covered_call_atm",
        "display_name": "ATM Covered Call",
        "dim_direction": "neutral",
        "dim_structure": "vertical",
        "dim_coverage": "covered",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "monthly",
        "sort_order": 1,
        "example": "Long NVDA, Sell NVDA ATM Call",
        "typical_use": "Short-term lock gains; preparing to sell stock; commonly used by funds.",
        "explanation": SUBTYPE_EXPLANATION,
        "nature": None,
        "legs": [("underlying", "long", None, 1), ("call", "short", "C", 1)],
        "characteristics": ["Very high premium", "Nearly lock in gains", "High assignment risk"],
        "meta_params": [("call_strike_rule", "Call strike rule", "atm", "fixed", 0)],
    },
    {
        "template_code": "covered_call_itm",
        "display_name": "ITM Covered Call",
        "dim_direction": "bearish",
        "dim_structure": "vertical",
        "dim_coverage": "covered",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "monthly",
        "sort_order": 2,
        "example": "NVDA = 100, Sell 90 Call",
        "typical_use": "Want to sell stock but also capture time value.",
        "explanation": SUBTYPE_EXPLANATION,
        "nature": "Synthetic limit sell",
        "legs": [("underlying", "long", None, 1), ("call", "short", "C", 1)],
        "characteristics": ["Very high premium", "Similar to selling stock early"],
        "meta_params": [
            ("call_strike_rule", "Call strike rule", "itm", "fixed", 0),
            ("itm_pct", "ITM % (optional)", None, "percent", 1),
        ],
    },
    {
        "template_code": "covered_call_deep_otm",
        "display_name": "Deep OTM Covered Call",
        "dim_direction": "bullish",
        "dim_structure": "vertical",
        "dim_coverage": "covered",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "monthly",
        "sort_order": 3,
        "example": "Sell 20% OTM Call",
        "typical_use": "Enhance income for very long-term holders; many long-term investors use this.",
        "explanation": SUBTYPE_EXPLANATION,
        "nature": None,
        "legs": [("underlying", "long", None, 1), ("call", "short", "C", 1)],
        "characteristics": ["Small premium", "Minimal impact on upside"],
        "meta_params": [
            ("call_strike_rule", "Call strike rule", "deep_otm", "fixed", 0),
            ("otm_pct", "OTM % (call strike)", "20", "percent", 1),
        ],
    },
    {
        "template_code": "cash_secured_put",
        "display_name": "Cash Secured Put",
        "dim_direction": "bullish",
        "dim_structure": "single_leg",
        "dim_coverage": "cash_secured",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "monthly",
        "sort_order": 10,
        "legs": [("put", "short", "P", 1)],
    },
    {
        "template_code": "iron_condor",
        "display_name": "Iron Condor",
        "dim_direction": "neutral",
        "dim_structure": "condor",
        "dim_coverage": "naked",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "monthly",
        "sort_order": 11,
        "legs": [
            ("put", "long", "P", 1),
            ("put", "short", "P", 1),
            ("call", "short", "C", 1),
            ("call", "long", "C", 1),
        ],
    },
    {
        "template_code": "straddle_strangle",
        "display_name": "Straddle / Strangle",
        "dim_direction": "neutral",
        "dim_structure": "straddle",
        "dim_coverage": "naked",
        "dim_risk": "undefined",
        "dim_volatility": "long_vol",
        "dim_time": "monthly",
        "sort_order": 12,
        "legs": [("call", "long", "C", 1), ("put", "long", "P", 1)],
    },
    {
        "template_code": "leaps",
        "display_name": "LEAPS",
        "dim_direction": "bullish",
        "dim_structure": "single_leg",
        "dim_coverage": "naked",
        "dim_risk": "undefined",
        "dim_volatility": "long_vol",
        "dim_time": "leaps",
        "sort_order": 13,
        "legs": [("call", "long", "C", 1)],
    },
    {
        "template_code": "calendar_spread",
        "display_name": "Calendar Spread",
        "dim_direction": "neutral",
        "dim_structure": "calendar",
        "dim_coverage": "naked",
        "dim_risk": "defined",
        "dim_volatility": "short_vol",
        "dim_time": "flex",
        "sort_order": 14,
        "legs": [("call", "short", "C", 1), ("call", "long", "C", 1)],
    },
    {
        "template_code": "custom",
        "display_name": "Custom",
        "dim_direction": None,
        "dim_structure": "custom",
        "dim_coverage": None,
        "dim_risk": None,
        "dim_volatility": None,
        "dim_time": None,
        "sort_order": 99,
        "legs": [],
    },
]


def upsert_strategy_dims(cur) -> None:
    for dim_type, code, display_label, sort_order in DIM_ROWS:
        cur.execute(
            """
            INSERT INTO strategy_dim (dim_type, code, display_label, sort_order)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (dim_type, code) DO UPDATE SET
                display_label = EXCLUDED.display_label,
                sort_order = EXCLUDED.sort_order
            """,
            (dim_type, code, display_label, sort_order),
        )


def upsert_strategy_templates(cur) -> None:
    for t in TEMPLATES:
        cur.execute(
            """
            INSERT INTO strategy_template (
                template_code, display_name, dim_direction, dim_structure, dim_coverage,
                dim_risk, dim_volatility, dim_time, explanation, typical_use, example, nature,
                sort_order, is_active
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true)
            ON CONFLICT (template_code) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                dim_direction = EXCLUDED.dim_direction,
                dim_structure = EXCLUDED.dim_structure,
                dim_coverage = EXCLUDED.dim_coverage,
                dim_risk = EXCLUDED.dim_risk,
                dim_volatility = EXCLUDED.dim_volatility,
                dim_time = EXCLUDED.dim_time,
                explanation = EXCLUDED.explanation,
                typical_use = EXCLUDED.typical_use,
                example = EXCLUDED.example,
                nature = EXCLUDED.nature,
                sort_order = EXCLUDED.sort_order,
                updated_at = now()
            """,
            (
                t["template_code"],
                t["display_name"],
                t.get("dim_direction"),
                t.get("dim_structure"),
                t.get("dim_coverage"),
                t.get("dim_risk"),
                t.get("dim_volatility"),
                t.get("dim_time"),
                t.get("explanation"),
                t.get("typical_use"),
                t.get("example"),
                t.get("nature"),
                t["sort_order"],
            ),
        )
        cur.execute(
            "SELECT strategy_template_id FROM strategy_template WHERE template_code = %s",
            (t["template_code"],),
        )
        tid = cur.fetchone()[0]
        cur.execute("DELETE FROM strategy_template_leg WHERE strategy_template_id = %s", (tid,))
        for so, leg in enumerate(t.get("legs") or []):
            role, direction, option_right, qty = leg
            cur.execute(
                """
                INSERT INTO strategy_template_leg
                    (strategy_template_id, sort_order, role, direction, option_right, quantity_default)
                VALUES (%s,%s,%s,%s,%s,%s)
                """,
                (tid, so, role, direction, option_right, qty),
            )
        cur.execute("DELETE FROM strategy_template_characteristic WHERE strategy_template_id = %s", (tid,))
        for so, text in enumerate(t.get("characteristics") or []):
            cur.execute(
                """
                INSERT INTO strategy_template_characteristic
                    (strategy_template_id, sort_order, characteristic_text)
                VALUES (%s,%s,%s)
                """,
                (tid, so, text),
            )
        cur.execute("DELETE FROM strategy_template_param WHERE strategy_template_id = %s", (tid,))
        for meta_key, display_label, default_value_text, param_kind, pso in t.get("meta_params") or []:
            cur.execute(
                """
                INSERT INTO strategy_template_param
                    (strategy_template_id, meta_key, display_label, default_value_text, param_kind, sort_order)
                VALUES (%s,%s,%s,%s,%s,%s)
                """,
                (tid, meta_key, display_label, default_value_text, param_kind, pso),
            )
