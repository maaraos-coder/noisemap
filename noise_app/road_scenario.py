"""Educational road-traffic scenario helpers.

This module computes Lden aggregation correctly, but does NOT implement
CNOSSOS-EU road emission, octave-band attenuation or reflection.
Those require a validated CNOSSOS-EU engine. Do not label its outputs
as CNOSSOS-EU predictions.
"""
from __future__ import annotations
import math
from typing import Mapping

PERIODS = {"day": (12, 0), "evening": (4, 5), "night": (8, 10)}
DEFAULT_TRAFFIC = {
    "day": {"light": 650, "medium": 35, "heavy": 15, "motorcycles": 30},
    "evening": {"light": 400, "medium": 20, "heavy": 8, "motorcycles": 20},
    "night": {"light": 110, "medium": 5, "heavy": 2, "motorcycles": 5},
}

def lden(lday: float, levening: float, lnight: float) -> float:
    """Directive 2002/49/EC: 12 h day, 4 h evening (+5), 8 h night (+10)."""
    levels = {"day": lday, "evening": levening, "night": lnight}
    for value in levels.values():
        if not math.isfinite(float(value)):
            raise ValueError("All three period levels must be finite")
    power = sum(hours * 10**((float(levels[period])+penalty)/10)
                for period, (hours, penalty) in PERIODS.items())
    return 10*math.log10(power/24)

def validate_traffic(data: Mapping) -> None:
    for period in PERIODS:
        if period not in data:
            raise ValueError(f"Missing traffic period: {period}")
        for category in ("light","medium","heavy","motorcycles"):
            value=float(data[period].get(category,-1))
            if not math.isfinite(value) or value < 0:
                raise ValueError("Hourly counts must be non-negative finite numbers")

def describe_scope() -> str:
    return ("Traffic counts are scenario inputs only. Lday/Levening/Lnight must be "
            "predicted with a documented, validated environmental-noise engine "
            "before computing Lden; this tool does not invent them.")
