"""Canonical structure type definitions and default legs (R-OS1, industry-aligned).

Single source of truth for structure_type leg schemas. Used by default-legs API
and by strategy_structure_write validation.
"""

from typing import Any, Dict, List, Optional

# Display order: Covered Call, Cash Secured Put, Iron Condor, Straddle/Strangle, LEAPS, Calendar Spread, custom.
STRUCTURE_TYPES = (
    "covered_call",
    "cash_secured_put",
    "iron_condor",
    "straddle_strangle",
    "leaps",
    "calendar_spread",
    "custom",
)

# Per-type leg templates: list of dicts with role, direction, option_right (None = stock leg).
# Empty list means no fixed structure (custom or not yet defined).
_COVERED_CALL_LEGS = [
    {"role": "underlying", "direction": "long", "option_right": None, "quantity": 1, "strike": None, "expiration": ""},
    {"role": "call", "direction": "short", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
]

_STRADDLE_STRANGLE_LEGS = [
    {"role": "call", "direction": "long", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
    {"role": "put", "direction": "long", "option_right": "P", "quantity": 1, "strike": None, "expiration": ""},
]

_CASH_SECURED_PUT_LEGS = [
    {"role": "put", "direction": "short", "option_right": "P", "quantity": 1, "strike": None, "expiration": ""},
]

_IRON_CONDOR_LEGS = [
    {"role": "put", "direction": "long", "option_right": "P", "quantity": 1, "strike": None, "expiration": ""},
    {"role": "put", "direction": "short", "option_right": "P", "quantity": 1, "strike": None, "expiration": ""},
    {"role": "call", "direction": "short", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
    {"role": "call", "direction": "long", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
]

_LEAPS_LEGS = [
    {"role": "call", "direction": "long", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
]

_CALENDAR_SPREAD_LEGS = [
    {"role": "call", "direction": "short", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
    {"role": "call", "direction": "long", "option_right": "C", "quantity": 1, "strike": None, "expiration": ""},
]

_TYPE_DEFAULT_LEGS: Dict[str, List[Dict[str, Any]]] = {
    "straddle_strangle": _STRADDLE_STRANGLE_LEGS,
    "cash_secured_put": _CASH_SECURED_PUT_LEGS,
    "covered_call": _COVERED_CALL_LEGS,
    "iron_condor": _IRON_CONDOR_LEGS,
    "leaps": _LEAPS_LEGS,
    "calendar_spread": _CALENDAR_SPREAD_LEGS,
    "custom": [],
}


def get_default_legs(structure_type: str) -> List[Dict[str, Any]]:
    """Return default legs for the given structure type. Compatible with StructureLeg shape."""
    key = (structure_type or "").strip().lower()
    legs = _TYPE_DEFAULT_LEGS.get(key, [])
    # Return a copy so callers do not mutate shared data.
    return [dict(leg) for leg in legs]


def get_schema(structure_type: str) -> Optional[Dict[str, Any]]:
    """Return schema for the type (leg_count, legs with locked flags). None for custom/unknown."""
    key = (structure_type or "").strip().lower()
    if key == "custom" or key not in _TYPE_DEFAULT_LEGS:
        return None
    legs = _TYPE_DEFAULT_LEGS.get(key, [])
    if not legs:
        return {"leg_count": 0, "legs": []}
    return {
        "leg_count": len(legs),
        "legs": [
            {
                "role": leg.get("role"),
                "direction": leg.get("direction"),
                "option_right": leg.get("option_right"),
                "locked": True,
            }
            for leg in legs
        ],
    }


def validate_legs(structure_type: str, legs: List[Any]) -> None:
    """Validate legs against the structure type. Raises ValueError if invalid. custom is not validated."""
    key = (structure_type or "").strip().lower()
    if key == "custom":
        return
    expected = _TYPE_DEFAULT_LEGS.get(key, [])
    if not expected:
        # No schema defined for this type; skip validation.
        return
    if not isinstance(legs, list):
        raise ValueError("legs must be an array")
    if len(legs) != len(expected):
        raise ValueError(
            f"structure_type {structure_type} requires exactly {len(expected)} leg(s), got {len(legs)}"
        )
    for i, (exp, got) in enumerate(zip(expected, legs)):
        if not isinstance(got, dict):
            raise ValueError(f"leg {i} must be an object")
        for field in ("role", "direction", "option_right"):
            exp_val = exp.get(field)
            got_val = got.get(field)
            if exp_val is None:
                if got_val in (None, ""):
                    continue
                raise ValueError(f"leg {i}: {field} must be empty for {structure_type} (stock leg), got {got_val!r}")
            got_norm = (str(got_val).strip() if got_val is not None else "").upper()
            exp_norm = (str(exp_val).strip()).upper()
            if got_norm != exp_norm:
                raise ValueError(
                    f"leg {i}: {field} must be {exp_val!r} for {structure_type}, got {got_val!r}"
                )
