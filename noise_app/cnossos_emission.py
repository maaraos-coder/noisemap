"""CNOSSOS-EU **road emission** adapter (Directive 2015/996 as amended 2021/1226).

Uses the independently maintained phonometry coefficient database and its
road_source_power implementation. This is deliberately limited to section 2.2:
spectral source-line power IS NOT a sound pressure level at a facade.
"""
from __future__ import annotations
import math

CATEGORIES = {"light": "1", "medium": "2", "heavy": "3", "motorcycles": "4b"}
BANDS = (63, 125, 250, 500, 1000, 2000, 4000, 8000)

def cnossos_emission_available() -> tuple[bool,str]:
    try:
        from phonometry.environment.sources.cnossos_road import road_source_power, RoadTraffic
        return True, "Motor de emisión CNOSSOS-EU disponible (phonometry, tablas F de 2021)."
    except Exception as exc:
        return False, ("Emisión CNOSSOS-EU no disponible en este entorno: "
                       f"{type(exc).__name__}. Instalar phonometry con Python >=3.12.")

def calculate_road_emission(period_flows: dict, speed_kmh: float,
                            slope_percent: float = 0.0,
                            temperature_c: float = 20.0,
                            surface: str = "reference road surface") -> dict:
    """Return CNOSSOS-EU sound power per metre for all three traffic periods.

    Parameters are traffic categories in vehicles/hour, speed in km/h. A missing
    category or a zero flow contributes nothing. Output is eight octave bands.
    The result cannot be used as Lday/Levening/Lnight without propagation.
    """
    import numpy as np
    from phonometry.environment.sources.cnossos_road import road_source_power, RoadTraffic, RoadVehicleCategory
    if not (math.isfinite(speed_kmh) and speed_kmh > 0):
        raise ValueError("La velocidad debe ser positiva y finita.")
    results={}
    for period in ("day","evening","night"):
        vals=period_flows[period]
        streams=[]
        for label,category in CATEGORIES.items():
            q=float(vals[label])
            if not math.isfinite(q) or q < 0:
                raise ValueError(f"Flujo inválido para {label}: {q}")
            if q:
                streams.append(RoadTraffic(category=RoadVehicleCategory(category),
                                           flow_rate=q,speed_kmh=float(speed_kmh)))
        if streams:
            value=road_source_power(streams, surface=surface,
                                    temperature_c=float(temperature_c),
                                    road_slope_percent=float(slope_percent))
            bands=[float(v) for v in value.total_line_power]
            total=float(value.a_weighted_line_power)
        else:
            bands=[None]*len(BANDS)
            total=None
        results[period]={"frequencies_hz":list(BANDS),"line_power_db_per_m":bands,
                         "a_weighted_line_power_db_per_m":total}
    return results
