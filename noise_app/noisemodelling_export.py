"""Transparent interchange package for the NoiseModelling CNOSSOS-EU engine.

GeoJSON source/receiver/building/wall layers in EPSG:4326, plus spectra
and assumptions. NOT an automatic NoiseModelling simulation: the external
engine must reproject geometry to a metric CRS and configure/validate
propagation §2.5. Only public project geometry is included.
"""
from __future__ import annotations
from dataclasses import replace
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
import json
import math

from .cnossos_adapter import line_emission_cnossos

BANDS = (63, 125, 250, 500, 1000, 2000, 4000, 8000)
PERIODS = ("day", "evening", "night")
TRAFFIC_FIELDS = {
    "light": "q_light_vph",
    "medium": "q_medium_vph",
    "heavy": "q_heavy_vph",
    "moped": "q_moped_vph",
    "motorcycle": "q_motorcycle_vph",
}


def feature(geometry_type, coordinates, properties):
    return {"type": "Feature",
            "geometry": {"type": geometry_type, "coordinates": coordinates},
            "properties": properties}


def collection(features):
    return {"type": "FeatureCollection", "features": features}


def package_scenario(road, flows, receivers, buildings, barriers,
                     temperature_c=20.0):
    """Build a ZIP of GIS layers and precise period traffic assumptions.

    road: a Pydantic RoadIn; others: Pydantic objects with lat/lon or points.
    Assumes their coordinate tuples are [lat,lon], converted to GeoJSON [lon,lat].
    """
    from backend.main import _road_to_equivalent_sources
    data = {}
    for period in PERIODS:
        counts = flows.get(period)
        if not isinstance(counts, dict):
            raise ValueError("Se requieren flujos por día, tarde y noche.")
        changes = {}
        for key, attr in TRAFFIC_FIELDS.items():
            val = float(counts.get(key, 0))
            if not math.isfinite(val) or val < 0:
                raise ValueError(f"Flujo inválido {period}/{key}")
            changes[attr] = val
        current = road.model_copy(update=changes)
        generated = _road_to_equivalent_sources(current, temperature_c)
        data[period] = collection([
            feature("Point", [s.lon, s.lat],
                    {"ID": s.id, "NAME": s.name, "PERIOD": period,
                     "ZSOURCE": 0.05,
                     **{f"LW{hz}": s.octave_levels[str(hz)] for hz in BANDS}})
            for s in generated
        ])
    layers = {
        "RECEIVERS": collection([
            feature("Point", [r.lon, r.lat],
                    {"ID": r.id, "NAME": r.name, "ZREL": r.height_m})
            for r in receivers
        ]),
        "BUILDINGS": collection([
            feature("Polygon",
                    [[[float(p[1]), float(p[0])] for p in b.points] +
                      ([[float(b.points[0][1]), float(b.points[0][0])]]
                       if b.points and b.points[-1] != b.points[0] else [])],
                    {"ID": b.id, "NAME": b.name, "HEIGHT": b.height_m})
            for b in buildings if b.enabled and len(b.points) >= 3
        ]),
        "WALLS": collection([
            feature("LineString",
                    [[b.lon_a, b.lat_a], [b.lon_b, b.lat_b]],
                    {"ID": b.id, "NAME": b.name, "HEIGHT": b.height_m})
            for b in barriers if b.enabled
        ]),
        "ROADS": collection([
            feature("LineString",
                    [[float(p[1]),float(p[0])] for p in road.points],
                    {"ID": road.id, "NAME": road.name, "SURFACE": road.road_surface,
                     "SLOPE_PCT": road.road_slope_percent,
                     "TWO_WAY": road.road_two_way})
        ]),
    }
    metadata = {
        "schema": "noisemap-cnossos-geodata-v1",
        "method_source": "CNOSSOS-EU 2.2 / 2021/1226, phonometry",
        "method_receiver": "NOT RUN, must be simulated in external NoiseModelling CNOSSOS-EU §2.5",
        "normative_result": False,
        "crs": "EPSG:4326",
        "road": road.model_dump(mode="json"),
        "traffic": flows,
        "temperature_c": temperature_c,
        "periods_h": {"day": 12, "evening": 4, "night": 8},
        "penalty_db": {"day": 0, "evening": 5, "night": 10},
    }
    readme = """NoiseMap -> NoiseModelling · intercambio CNOSSOS-EU
========================================================
Todas las capas GeoJSON están en EPSG:4326 (lon/lat).
IMPORTANTE: reproyectar a CRS métrico apropiado ANTES de calcular
la propagación con NoiseModelling; asignar cotas/DEM al entorno 3D.

LW_ROADS_DAY / EVENING / NIGHT contienen fuentes puntuales equivalentes
generadas por discretización del eje de calle y potencia por bandas de
octava (dB re 1 pW). Cada período es un escenario distinto.
ZSOURCE=0.05 m sobre la rasante. No aplicar doble reflexión del pavimento.

BUILDINGS: polígonos y altura, RECEIVERS: altura relativa al terreno,
WALLS: barreras lineales y altura. Se deben transformar/importar a
las tablas de entrada esperadas por la versión de NoiseModelling instalada.
La estructura NO es una base H2 lista para cálculo directo.

La propagación CNOSSOS-EU 2.5 NO ha sido ejecutada en este ZIP.
No usar esta salida para demostrar cumplimiento regulatorio.
"""
    buf=BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as z:
        for period, content in data.items():
            z.writestr(f"LW_ROADS_{period.upper()}.geojson",
                       json.dumps(content, ensure_ascii=False))
        for name, content in layers.items():
            z.writestr(f"{name}.geojson", json.dumps(content, ensure_ascii=False))
        z.writestr("scenario.json", json.dumps(metadata, ensure_ascii=False, indent=2))
        z.writestr("LEEME_NOISEMODELLING.txt", readme)
    return buf.getvalue()
