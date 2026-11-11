"""Full CNOSSOS-EU road SOURCE emission adapter, §2.2 (not propagation §2.5).

Delegates spectral calculations to the independently tested MIT-licensed
`phonometry` library, instead of maintaining an incomplete second set of
Appendix F tables here. Requires Python 3.12+.

Correctly applies road-surface, temperature, studded tyres, slope and
junction corrections. A two-way road splits each vehicle category by
direction and reverses the slope. Distances to junctions are supplied per
source-line segment, not to the receiver.
"""
from __future__ import annotations

import math

CATEGORIES = (
    ("q_light_vph", "speed_light_kmh", "LIGHT"),
    ("q_medium_vph", "speed_medium_kmh", "MEDIUM_HEAVY"),
    ("q_heavy_vph", "speed_heavy_kmh", "HEAVY"),
    ("q_moped_vph", "speed_moped_kmh", "MOPEDS"),
    ("q_motorcycle_vph", "speed_motorcycle_kmh", "MOTORCYCLES"),
)

# Appendix F, Table F-4 (EU 2021/1226).
SURFACES = (
    "reference road surface",
    "1-layer ZOAB",
    "2-layer ZOAB",
    "2-layer ZOAB (fine)",
    "SMA-NL5",
    "SMA-NL8",
    "brushed down concrete",
    "optimised brushed down concrete",
    "fine broomed concrete",
    "worked surface",
    "hard elements in herringbone",
    "hard elements not in herringbone",
    "quiet hard elements",
    "thin layer A",
    "thin layer B",
)


def _as_float(road, field, default):
    return float(getattr(road, field, default))


def line_emission_cnossos(road, temperature_c: float, junction_distance_m=None):
    """Returns 8 line-emission octave values in dB re 1pW/m.

    A fully silent line returns [-inf]*8. All other values finite.
    `road` can be a RoadIn or any object with equivalent attributes.
    """
    import numpy as np
    from phonometry.environment.sources.cnossos_road import (
        RoadTraffic, RoadVehicleCategory, JunctionType, road_source_power,
    )
    slope = _as_float(road, "road_slope_percent", 0)
    if not math.isfinite(slope) or abs(slope) > 12:
        raise ValueError("Pendiente fuera de rango [-12 %, 12 %].")
    temperature = float(temperature_c)
    if not math.isfinite(temperature):
        raise ValueError("Temperatura no finita.")
    surface = getattr(road, "road_surface", "reference road surface")
    if surface not in SURFACES:
        raise ValueError("Superficie vial no reconocida.")
    studded = _as_float(road, "studded_fraction", 0)
    months = _as_float(road, "studded_months", 0)
    if not 0 <= studded <= 1 or not 0 <= months <= 12:
        raise ValueError("Neumáticos con clavos: fracción 0–1 y meses 0–12.")
    junction_type = getattr(road, "junction_type", "none")
    if junction_type not in ("none", "crossing", "roundabout"):
        raise ValueError("Tipo de intersección inválido.")
    if junction_distance_m is not None and (not math.isfinite(junction_distance_m) or junction_distance_m < 0):
        raise ValueError("Distancia a intersección inválida.")
    junction = (None if junction_type == "none" or junction_distance_m is None
                else getattr(JunctionType, junction_type.upper()))
    directions = (1, -1) if getattr(road, "road_two_way", False) else (1,)
    spectra = []
    for direction in directions:
        traffic = []
        for flow_key, speed_key, category_name in CATEGORIES:
            q = _as_float(road, flow_key, 0)
            v = _as_float(road, speed_key, 50)
            if not math.isfinite(q) or not math.isfinite(v) or q < 0 or v <= 0:
                raise ValueError("Flujos y velocidades deben ser finitos y válidos.")
            if q == 0:
                continue
            category = getattr(RoadVehicleCategory, category_name)
            traffic.append(RoadTraffic(
                category=category, flow_rate=q / len(directions),
                speed_kmh=v, studded_fraction=studded if category_name == "LIGHT" else 0.0,
            ))
        if not traffic:
            continue
        kwargs = dict(surface=surface, temperature_c=temperature,
                      road_slope_percent=direction * slope,
                      studded_months=months)
        if junction is not None:
            kwargs.update(junction_distance=float(junction_distance_m),
                          junction_type=junction)
        value = road_source_power(traffic, **kwargs)
        bands = np.asarray(value.total_line_power, dtype=float)
        if bands.shape != (8,) or not np.all(np.isfinite(bands)):
            raise ValueError("El motor CNOSSOS devolvió bandas inválidas.")
        spectra.append(bands)
    if not spectra:
        return np.full(8, -np.inf, dtype=float)
    return 10 * np.log10(np.sum(np.power(10., np.stack(spectra)/10), axis=0))
