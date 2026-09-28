from __future__ import annotations

from typing import Dict, List, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from pathlib import Path
import io
import json
import math
import tempfile
import zipfile

import numpy as np
import shapefile
import ezdxf
from pyproj import CRS, Transformer
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from noise_app.engine import (
    Barrier,
    PropagationSettings,
    Source,
    atmospheric_absorption_iso9613_db_per_m,
    energetic_sum_db,
    level_at_point,
    point_in_polygon,
    latlon_to_xy,
    segment_intersection,
    barrier_attenuation_db,
    source_to_point_breakdown,
)




OCTAVE_BANDS = (63, 125, 250, 500, 1000, 2000, 4000, 8000)
A_WEIGHTING_DB = {
    63: -26.2,
    125: -16.1,
    250: -8.6,
    500: -3.2,
    1000: 0.0,
    2000: 1.2,
    4000: 1.0,
    8000: -1.1,
}

# CNOSSOS-EU Table F-1 coefficients, consolidated with (EU) 2021/1226.
# Rows: AR, BR, AP, BP over octave bands 63 Hz .. 8 kHz.
CNOSSOS_ROAD_F1 = {
    "1": (
        (83.1, 89.2, 87.7, 93.1, 100.1, 96.7, 86.8, 76.2),
        (30.0, 41.5, 38.9, 25.7, 32.5, 37.2, 39.0, 40.0),
        (97.9, 92.5, 90.7, 87.2, 84.7, 88.0, 84.4, 77.1),
        (-1.3, 7.2, 7.7, 8.0, 8.0, 8.0, 8.0, 8.0),
    ),
    "2": (
        (88.7, 93.2, 95.7, 100.9, 101.7, 95.1, 87.8, 83.6),
        (30.0, 35.8, 32.6, 23.8, 30.1, 36.2, 38.3, 40.1),
        (105.5, 100.2, 100.5, 98.7, 101.0, 97.8, 91.2, 85.0),
        (-1.9, 4.7, 6.4, 6.5, 6.5, 6.5, 6.5, 6.5),
    ),
    "3": (
        (91.7, 96.2, 98.2, 104.9, 105.1, 98.5, 91.1, 85.6),
        (30.0, 33.5, 31.3, 25.4, 31.8, 37.1, 38.6, 40.6),
        (108.8, 104.2, 103.5, 102.9, 102.6, 98.5, 93.8, 87.5),
        (0.0, 3.0, 4.6, 5.0, 5.0, 5.0, 5.0, 5.0),
    ),
}
CNOSSOS_TEMP_K = {"1": 0.08, "2": 0.04, "3": 0.04}
CNOSSOS_REF_SPEED = 70.0
CNOSSOS_SOURCE_HEIGHT_M = 0.05


def _source_adjustment_db(source) -> float:
    duty = max(float(source.time_active_pct), 0.001) / 100.0
    return float(source.adjust_db) + 10.0 * math.log10(duty)


def _source_band_level(source, band_hz: int) -> Optional[float]:
    levels = source.octave_levels or {}
    for key in (str(band_hz), band_hz):
        if key in levels:
            try:
                return float(levels[key])
            except (TypeError, ValueError):
                return None
    return None


def _settings_for_band(base, band_hz: float) -> PropagationSettings:
    alpha_db_per_km = (
        atmospheric_absorption_iso9613_db_per_m(
            band_hz,
            temperature_c=base.temperature_c,
            humidity_pct=base.humidity_pct,
        )
        * 1000.0
    )
    return PropagationSettings(
        alpha_db_per_km=alpha_db_per_km,
        frequency_hz=float(band_hz),
        max_barrier_db=base.max_barrier_db,
        temperature_c=base.temperature_c,
        humidity_pct=base.humidity_pct,
        ground_factor=base.ground_factor,
        reflections_enabled=base.reflections_enabled,
    )


def _source_spectral_result(
    source_input,
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    barriers,
    base_settings,
    lat0: float,
    lon0: float,
    terrain_samples=None,
    receiver_ground_elevation_m: Optional[float] = None,
    source_ground_elevation_m: Optional[float] = None,
):
    adjustment = _source_adjustment_db(source_input)
    if source_ground_elevation_m is None:
        source_ground_elevation_m = _terrain_elevation(
            terrain_samples, source_input.lat, source_input.lon, lat0, lon0
        )
    if receiver_ground_elevation_m is None:
        receiver_ground_elevation_m = _terrain_elevation(
            terrain_samples, receiver_lat, receiver_lon, lat0, lon0
        )
    mode = (source_input.spectrum_mode or "broadband").lower()

    if mode == "octaves":
        bands_db = {}
        weighted_levels = []
        for band in OCTAVE_BANDS:
            lw = _source_band_level(source_input, band)
            if lw is None:
                bands_db[str(band)] = None
                continue

            source_model = Source(
                name=source_input.name,
                lat=source_input.lat,
                lon=source_input.lon,
                height_m=source_input.height_m,
                lw_db=lw + adjustment,
                dc_db=source_input.dc_db,
                enabled=source_input.enabled,
                ground_elevation_m=source_ground_elevation_m,
            )
            band_settings = _settings_for_band(base_settings, band)
            lp = level_at_point(
                [source_model],
                receiver_lat,
                receiver_lon,
                receiver_height_m,
                barriers,
                band_settings,
                lat0,
                lon0,
                receiver_ground_elevation_m=receiver_ground_elevation_m,
            )
            if np.isfinite(lp):
                bands_db[str(band)] = round(float(lp), 3)
                weighted_levels.append(
                    float(lp) + (A_WEIGHTING_DB[band] if base_settings.a_weighting else 0.0)
                )
            else:
                bands_db[str(band)] = None

        total = energetic_sum_db(weighted_levels)
        return {
            "total_db": float(total) if np.isfinite(total) else None,
            "bands_db": bands_db,
            "mode": "octaves",
        }

    if mode == "single":
        frequency = max(float(source_input.single_frequency_hz), 1.0)
        source_model = Source(
            name=source_input.name,
            lat=source_input.lat,
            lon=source_input.lon,
            height_m=source_input.height_m,
            lw_db=float(source_input.lw_db) + adjustment,
            dc_db=source_input.dc_db,
            enabled=source_input.enabled,
            ground_elevation_m=source_ground_elevation_m,
        )
        band_settings = _settings_for_band(base_settings, frequency)
        lp = level_at_point(
            [source_model],
            receiver_lat,
            receiver_lon,
            receiver_height_m,
            barriers,
            band_settings,
            lat0,
            lon0,
            receiver_ground_elevation_m=receiver_ground_elevation_m,
        )
        nearest_band = min(OCTAVE_BANDS, key=lambda b: abs(b - frequency))
        if np.isfinite(lp):
            total = float(lp) + (
                A_WEIGHTING_DB[nearest_band] if base_settings.a_weighting else 0.0
            )
        else:
            total = None
        return {
            "total_db": total,
            "bands_db": {
                str(b): (round(float(lp), 3) if b == nearest_band and np.isfinite(lp) else None)
                for b in OCTAVE_BANDS
            },
            "mode": "single",
            "frequency_hz": frequency,
        }

    # Broadband is entered as LwA in the current UI. It is propagated as a
    # broadband A-weighted quantity, so no artificial octave spectrum is invented.
    source_model = Source(
        name=source_input.name,
        lat=source_input.lat,
        lon=source_input.lon,
        height_m=source_input.height_m,
        lw_db=float(source_input.lw_db) + adjustment,
        dc_db=source_input.dc_db,
        enabled=source_input.enabled,
        ground_elevation_m=source_ground_elevation_m,
    )
    broadband_settings = PropagationSettings(
        alpha_db_per_km=base_settings.alpha_db_per_km,
        frequency_hz=base_settings.frequency_hz,
        max_barrier_db=base_settings.max_barrier_db,
        temperature_c=base_settings.temperature_c,
        humidity_pct=base_settings.humidity_pct,
        ground_factor=base_settings.ground_factor,
        reflections_enabled=base_settings.reflections_enabled,
    )
    lp = level_at_point(
        [source_model],
        receiver_lat,
        receiver_lon,
        receiver_height_m,
        barriers,
        broadband_settings,
        lat0,
        lon0,
        receiver_ground_elevation_m=receiver_ground_elevation_m,
    )
    return {
        "total_db": float(lp) if np.isfinite(lp) else None,
        "bands_db": {str(b): None for b in OCTAVE_BANDS},
        "mode": "broadband",
    }


def _combined_spectral_level_at_point(
    source_inputs,
    receiver_lat,
    receiver_lon,
    receiver_height_m,
    barriers,
    base_settings,
    lat0,
    lon0,
    terrain_samples=None,
    receiver_ground_elevation_m: Optional[float] = None,
    source_ground_elevations=None,
):
    totals = []
    for source_input in source_inputs:
        if not source_input.enabled:
            continue
        result = _source_spectral_result(
            source_input,
            receiver_lat,
            receiver_lon,
            receiver_height_m,
            barriers,
            base_settings,
            lat0,
            lon0,
            terrain_samples=terrain_samples,
            receiver_ground_elevation_m=receiver_ground_elevation_m,
            source_ground_elevation_m=(
                source_ground_elevations.get(source_input.id)
                if source_ground_elevations is not None else None
            ),
        )
        if result["total_db"] is not None and np.isfinite(result["total_db"]):
            totals.append(result["total_db"])
    return energetic_sum_db(totals)


ELEVATION_FIELD_CANDIDATES = (
    "cota", "elev", "elevation", "elevacion", "elevación",
    "altura", "altitude", "z", "contour", "nivel"
)


def _is_lon_lat(x: float, y: float) -> bool:
    return -180.0 <= x <= 180.0 and -90.0 <= y <= 90.0


def _pick_elevation_field(fields: list[str], requested: Optional[str]) -> Optional[str]:
    if requested and requested in fields:
        return requested
    lower = {name.lower(): name for name in fields}
    for candidate in ELEVATION_FIELD_CANDIDATES:
        if candidate in lower:
            return lower[candidate]
    for name in fields:
        lname = name.lower()
        if any(candidate in lname for candidate in ELEVATION_FIELD_CANDIDATES):
            return name
    return None


def _transformer_from_crs(source_crs: Optional[CRS]) -> Optional[Transformer]:
    if source_crs is None:
        return None
    target = CRS.from_epsg(4326)
    if source_crs == target:
        return None
    return Transformer.from_crs(source_crs, target, always_xy=True)


def _to_latlon_points(
    xy_points: list[tuple[float, float]],
    transformer: Optional[Transformer],
) -> list[list[float]]:
    result: list[list[float]] = []
    for x, y in xy_points:
        if transformer:
            lon, lat = transformer.transform(x, y)
        else:
            lon, lat = x, y
        if math.isfinite(lat) and math.isfinite(lon):
            result.append([float(lat), float(lon)])
    return result


def _geojson_lines(payload: dict, elevation_field: Optional[str]):
    features = payload.get("features", []) if payload.get("type") == "FeatureCollection" else [payload]
    all_fields: set[str] = set()
    for feature in features:
        all_fields.update((feature.get("properties") or {}).keys())
    fields = sorted(all_fields)
    chosen = _pick_elevation_field(fields, elevation_field)

    contours = []
    warnings = []
    idx = 1
    for feature in features:
        geom = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates") or []

        lines = []
        if gtype == "LineString":
            lines = [coords]
        elif gtype == "MultiLineString":
            lines = coords
        else:
            continue

        elevation = props.get(chosen) if chosen else None
        if elevation is None:
            # Try 3D Z coordinates if available.
            first = lines[0][0] if lines and lines[0] else None
            if first and len(first) >= 3:
                elevation = first[2]

        try:
            elevation_value = float(elevation) if elevation is not None else 0.0
        except (TypeError, ValueError):
            elevation_value = 0.0

        for line in lines:
            points = [[float(p[1]), float(p[0])] for p in line if len(p) >= 2]
            if len(points) < 2:
                continue
            contours.append({
                "name": f"Curva importada {idx}",
                "elevation_m": elevation_value,
                "points": points,
            })
            idx += 1

    if chosen is None:
        warnings.append("No se detectó un campo de cota; las curvas sin Z se importaron con cota 0 m.")

    return contours, fields, chosen, warnings


def _shapefile_lines(
    zip_bytes: bytes,
    elevation_field: Optional[str],
    source_epsg: Optional[int],
):
    warnings: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            archive.extractall(tmp_path)

        shp_files = list(tmp_path.rglob("*.shp"))
        if not shp_files:
            raise HTTPException(status_code=400, detail="El ZIP no contiene un archivo .shp.")

        shp_path = shp_files[0]
        reader = shapefile.Reader(str(shp_path))
        fields = [f[0] for f in reader.fields[1:]]
        chosen = _pick_elevation_field(fields, elevation_field)

        source_crs = None
        prj_path = shp_path.with_suffix(".prj")
        if prj_path.exists():
            try:
                source_crs = CRS.from_wkt(prj_path.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                warnings.append("No fue posible interpretar el .prj del Shapefile.")
        elif source_epsg:
            source_crs = CRS.from_epsg(source_epsg)
        else:
            warnings.append("El Shapefile no incluye .prj; se asumieron coordenadas WGS84.")

        transformer = _transformer_from_crs(source_crs)
        contours = []
        idx = 1

        for shape_record in reader.iterShapeRecords():
            shape = shape_record.shape
            record = shape_record.record.as_dict()
            elevation = record.get(chosen) if chosen else None

            parts = list(shape.parts) + [len(shape.points)]
            for i in range(len(parts) - 1):
                raw = shape.points[parts[i]:parts[i + 1]]
                if len(raw) < 2:
                    continue

                try:
                    elevation_value = float(elevation) if elevation is not None else None
                except (TypeError, ValueError):
                    elevation_value = None

                if elevation_value is None and getattr(shape, "z", None):
                    zs = shape.z[parts[i]:parts[i + 1]]
                    if zs:
                        elevation_value = float(zs[0])

                if elevation_value is None:
                    elevation_value = 0.0

                points = _to_latlon_points([(float(x), float(y)) for x, y in raw], transformer)
                if len(points) < 2:
                    continue

                contours.append({
                    "name": f"Curva importada {idx}",
                    "elevation_m": elevation_value,
                    "points": points,
                })
                idx += 1

        if chosen is None:
            warnings.append("No se detectó un campo de cota; se usó Z geométrico cuando estaba disponible.")

        return contours, fields, chosen, warnings


def _dxf_lines(
    file_bytes: bytes,
    elevation_field: Optional[str],
    source_epsg: Optional[int],
):
    warnings: list[str] = []
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = Path(tmp.name)

    try:
        doc = ezdxf.readfile(str(tmp_path))
    finally:
        tmp_path.unlink(missing_ok=True)

    msp = doc.modelspace()
    raw_entities: list[tuple[list[tuple[float, float]], float, str]] = []

    for entity in msp:
        etype = entity.dxftype()
        points: list[tuple[float, float]] = []
        elevation = 0.0

        if etype == "LINE":
            start = entity.dxf.start
            end = entity.dxf.end
            points = [(float(start.x), float(start.y)), (float(end.x), float(end.y))]
            elevation = float(start.z or end.z or 0.0)

        elif etype == "LWPOLYLINE":
            vertices = list(entity.get_points("xyseb"))
            points = [(float(v[0]), float(v[1])) for v in vertices]
            elevation = float(getattr(entity.dxf, "elevation", 0.0) or 0.0)

        elif etype in {"POLYLINE", "POLYLINE2D", "POLYLINE3D"}:
            vertices = list(entity.vertices)
            points = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in vertices]
            if vertices:
                elevation = float(vertices[0].dxf.location.z or 0.0)

        if len(points) >= 2:
            raw_entities.append((points, elevation, entity.dxf.layer))

    if not raw_entities:
        raise HTTPException(status_code=400, detail="El DXF no contiene LINE/POLYLINE utilizables como curvas de nivel.")

    sample_x, sample_y = raw_entities[0][0][0]
    source_crs = CRS.from_epsg(source_epsg) if source_epsg else None
    if source_crs is None and not _is_lon_lat(sample_x, sample_y):
        raise HTTPException(
            status_code=400,
            detail="El DXF usa coordenadas proyectadas. Indica el EPSG de origen (por ejemplo, UTM 19S suele ser EPSG:32719).",
        )

    transformer = _transformer_from_crs(source_crs)
    contours = []
    for idx, (raw_points, elevation, layer_name) in enumerate(raw_entities, start=1):
        points = _to_latlon_points(raw_points, transformer)
        if len(points) < 2:
            continue
        contours.append({
            "name": f"Curva DXF {idx} · {layer_name}",
            "elevation_m": elevation,
            "points": points,
        })

    warnings.append("En DXF la cota se obtiene del valor Z/elevación de cada entidad; si el dibujo usa cotas como texto, deberán convertirse a geometría/atributos.")
    return contours, ["Z/elevation", "layer"], "Z/elevation", warnings


app = FastAPI(
    title="Noise Map Lab API",
    version="4.0.0",
    description="Motor acústico educativo para la interfaz React + MapLibre.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SourceIn(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    height_m: float = 1.5
    lw_db: float = 100.0
    dc_db: float = 0.0
    enabled: bool = True
    spectrum_mode: str = "broadband"
    single_frequency_hz: float = 500.0
    octave_levels: Dict[str, float] = {}
    adjust_db: float = 0.0
    time_active_pct: float = 100.0
    parent_id: Optional[str] = None
    parent_name: Optional[str] = None
    source_kind: str = "point"


class RoadIn(BaseModel):
    id: str
    name: str
    points: List[List[float]]
    enabled: bool = True
    q_light_vph: float = Field(default=800.0, ge=0.0)
    q_medium_vph: float = Field(default=40.0, ge=0.0)
    q_heavy_vph: float = Field(default=30.0, ge=0.0)
    speed_light_kmh: float = Field(default=50.0, gt=0.0)
    speed_medium_kmh: float = Field(default=50.0, gt=0.0)
    speed_heavy_kmh: float = Field(default=50.0, gt=0.0)


class BarrierIn(BaseModel):
    id: str
    name: str
    lat_a: float
    lon_a: float
    lat_b: float
    lon_b: float
    height_m: float = 3.0
    enabled: bool = True
    reflection_percent: float = 0.0


class ReceiverIn(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    height_m: float = 1.5
    visible: bool = True
    height_mode: str = "map"


class GridSettings(BaseModel):
    resolution: int = Field(default=48, ge=18, le=100)
    receiver_height_m: float = Field(default=1.5, gt=0.0, le=500.0)
    alpha_db_per_km: float = Field(default=2.0, ge=0.0, le=50.0)
    frequency_hz: float = Field(default=500.0, ge=20.0, le=20000.0)
    vmin: float = 35.0
    vmax: float = 80.0
    prediction_model: str = "ISO 9613-2:2024"
    a_weighting: bool = True
    ground_factor: float = Field(default=0.0, ge=0.0, le=1.0)
    temperature_c: float = 15.0
    humidity_pct: float = Field(default=70.0, ge=0.0, le=100.0)
    max_barrier_db: float = 20.0
    reflections_enabled: bool = False


class ContourIn(BaseModel):
    id: Optional[str] = None
    name: str = "Curva"
    elevation_m: float = 0.0
    points: List[List[float]] = []


class CalculationRequest(BaseModel):
    sources: List[SourceIn]
    roads: List[RoadIn] = []
    receivers: List[ReceiverIn] = []
    barriers: List[BarrierIn] = []
    contours: List[ContourIn] = []
    polygon: List[List[float]]
    settings: GridSettings = GridSettings()


class BarrierProfileRequest(BaseModel):
    source: SourceIn
    receiver: ReceiverIn
    barrier: BarrierIn
    contours: List[ContourIn] = []
    settings: GridSettings = GridSettings()


class ReceiverPreviewRequest(BaseModel):
    sources: List[SourceIn] = []
    roads: List[RoadIn] = []
    receiver: ReceiverIn
    barriers: List[BarrierIn] = []
    contours: List[ContourIn] = []
    settings: GridSettings = GridSettings()


def _build_terrain_samples(contours, lat0: float, lon0: float):
    samples = []
    for contour in contours or []:
        points = contour.points or []
        if not points:
            continue
        # Keep long imported contours responsive while retaining their shape.
        stride = max(1, math.ceil(len(points) / 250))
        for point in points[::stride]:
            if len(point) < 2:
                continue
            x, y = latlon_to_xy(float(point[0]), float(point[1]), lat0, lon0)
            samples.append((x, y, float(contour.elevation_m)))

    if not samples:
        return None

    if len(samples) > 4000:
        step = math.ceil(len(samples) / 4000)
        samples = samples[::step]

    arr = np.asarray(samples, dtype=float)
    return arr[:, 0], arr[:, 1], arr[:, 2]


def _terrain_elevation(samples, lat: float, lon: float, lat0: float, lon0: float) -> float:
    if samples is None:
        return 0.0

    xs, ys, zs = samples
    if len(zs) == 0:
        return 0.0

    x, y = latlon_to_xy(float(lat), float(lon), lat0, lon0)
    dist2 = (xs - x) ** 2 + (ys - y) ** 2
    nearest = int(np.argmin(dist2))
    if dist2[nearest] < 0.25:
        return float(zs[nearest])

    k = min(12, len(zs))
    idx = np.argpartition(dist2, k - 1)[:k] if k < len(zs) else np.arange(len(zs))
    weights = 1.0 / np.maximum(dist2[idx], 1.0)
    return float(np.sum(weights * zs[idx]) / np.sum(weights))



def _cnossos_vehicle_spectrum(category: str, speed_kmh: float, temperature_c: float) -> np.ndarray:
    ar, br, ap, bp = CNOSSOS_ROAD_F1[category]
    v_true = max(float(speed_kmh), 0.1)
    v = max(v_true, 20.0)
    log_speed = math.log10(v / CNOSSOS_REF_SPEED)

    rolling = np.asarray(ar, dtype=float) + np.asarray(br, dtype=float) * log_speed
    rolling += CNOSSOS_TEMP_K[category] * (20.0 - float(temperature_c))

    propulsion = (
        np.asarray(ap, dtype=float)
        + np.asarray(bp, dtype=float) * ((v - CNOSSOS_REF_SPEED) / CNOSSOS_REF_SPEED)
    )

    energy = np.power(10.0, rolling / 10.0) + np.power(10.0, propulsion / 10.0)
    return 10.0 * np.log10(energy)


def _cnossos_road_line_spectrum(road: RoadIn, temperature_c: float) -> np.ndarray:
    flows = (
        ("1", road.q_light_vph, road.speed_light_kmh),
        ("2", road.q_medium_vph, road.speed_medium_kmh),
        ("3", road.q_heavy_vph, road.speed_heavy_kmh),
    )
    category_lines = []
    for category, q, speed in flows:
        if q <= 0.0:
            continue
        vehicle = _cnossos_vehicle_spectrum(category, speed, temperature_c)
        # CNOSSOS 2.2.1: true traffic speed is used in the flow term.
        line = vehicle + 10.0 * math.log10(float(q) / (1000.0 * float(speed)))
        category_lines.append(line)

    if not category_lines:
        return np.full(len(OCTAVE_BANDS), -np.inf, dtype=float)

    arr = np.vstack(category_lines)
    with np.errstate(divide="ignore"):
        return 10.0 * np.log10(np.sum(np.power(10.0, arr / 10.0), axis=0))


def _road_total_length_m(points: List[List[float]]) -> float:
    if len(points) < 2:
        return 0.0
    lat0 = sum(float(p[0]) for p in points) / len(points)
    lon0 = sum(float(p[1]) for p in points) / len(points)
    xy = [latlon_to_xy(float(p[0]), float(p[1]), lat0, lon0) for p in points]
    return sum(math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(xy, xy[1:]))


def _road_to_equivalent_sources(road: RoadIn, temperature_c: float) -> List[SourceIn]:
    if not road.enabled or len(road.points) < 2:
        return []

    line_spectrum = _cnossos_road_line_spectrum(road, temperature_c)
    if not np.any(np.isfinite(line_spectrum)):
        return []

    total_length = _road_total_length_m(road.points)
    target = max(5.0, total_length / 120.0)
    result: List[SourceIn] = []
    seg_index = 0

    for a, b in zip(road.points, road.points[1:]):
        lat_a, lon_a = float(a[0]), float(a[1])
        lat_b, lon_b = float(b[0]), float(b[1])
        lat0 = (lat_a + lat_b) / 2.0
        lon0 = (lon_a + lon_b) / 2.0
        ax, ay = latlon_to_xy(lat_a, lon_a, lat0, lon0)
        bx, by = latlon_to_xy(lat_b, lon_b, lat0, lon0)
        length = math.hypot(bx - ax, by - ay)
        if length <= 0.05:
            continue

        n = max(1, math.ceil(length / target))
        dl = length / n
        segment_spectrum = line_spectrum + 10.0 * math.log10(dl)

        for j in range(n):
            f = (j + 0.5) / n
            lat = lat_a + (lat_b - lat_a) * f
            lon = lon_a + (lon_b - lon_a) * f
            result.append(SourceIn(
                id=f"{road.id}:seg:{seg_index}",
                name=road.name,
                lat=lat,
                lon=lon,
                height_m=CNOSSOS_SOURCE_HEIGHT_M,
                lw_db=float(np.nanmax(segment_spectrum)),
                dc_db=0.0,
                enabled=True,
                spectrum_mode="octaves",
                octave_levels={
                    str(freq): float(level)
                    for freq, level in zip(OCTAVE_BANDS, segment_spectrum)
                },
                adjust_db=0.0,
                time_active_pct=100.0,
                parent_id=road.id,
                parent_name=road.name,
                source_kind="road",
            ))
            seg_index += 1
    return result


def _expand_sources(point_sources: List[SourceIn], roads: List[RoadIn], temperature_c: float):
    expanded = list(point_sources)
    for road in roads:
        expanded.extend(_road_to_equivalent_sources(road, temperature_c))
    return expanded


def _source_group_key(source: SourceIn):
    return (
        source.parent_id or source.id,
        source.parent_name or source.name,
        source.source_kind or "point",
    )


def _aggregate_contributions(items: list[tuple[SourceIn, dict]]) -> list[dict]:
    groups: dict[tuple[str, str, str], dict] = {}
    for source, result in items:
        key = _source_group_key(source)
        bucket = groups.setdefault(key, {
            "source_id": key[0],
            "source_name": key[1],
            "source_kind": key[2],
            "mode": "octaves" if key[2] == "road" else result.get("mode"),
            "levels": [],
            "bands": {str(b): [] for b in OCTAVE_BANDS},
        })
        total = result.get("total_db")
        if total is not None and np.isfinite(total):
            bucket["levels"].append(float(total))
        for band in OCTAVE_BANDS:
            value = result.get("bands_db", {}).get(str(band))
            if value is not None and np.isfinite(value):
                bucket["bands"][str(band)].append(float(value))

    output = []
    for bucket in groups.values():
        total = energetic_sum_db(bucket["levels"])
        bands = {}
        for band in OCTAVE_BANDS:
            values = bucket["bands"][str(band)]
            value = energetic_sum_db(values)
            bands[str(band)] = round(float(value), 2) if values and np.isfinite(value) else None
        output.append({
            "source_id": bucket["source_id"],
            "source_name": bucket["source_name"],
            "source_kind": bucket["source_kind"],
            "mode": bucket["mode"],
            "level_db": round(float(total), 2) if bucket["levels"] and np.isfinite(total) else None,
            "bands_db": bands,
        })
    return output


class CalculationResponse(BaseModel):
    bounds: List[List[float]]
    levels: List[List[Optional[float]]]
    min_level: Optional[float]
    max_level: Optional[float]
    receiver_results: List[dict] = []


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "4.0.0"}




@app.post("/api/topography/import")
async def import_topography(
    file: UploadFile = File(...),
    elevation_field: Optional[str] = Form(default=None),
    source_epsg: Optional[int] = Form(default=None),
):
    filename = (file.filename or "").lower()
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="El archivo está vacío.")

    try:
        if filename.endswith(".zip"):
            contours, fields, chosen, warnings = _shapefile_lines(
                data, elevation_field, source_epsg
            )
            source_type = "Shapefile ZIP"
        elif filename.endswith(".geojson") or filename.endswith(".json"):
            try:
                payload = json.loads(data.decode("utf-8"))
            except Exception as exc:
                raise HTTPException(status_code=400, detail="GeoJSON/JSON inválido.") from exc
            contours, fields, chosen, warnings = _geojson_lines(payload, elevation_field)
            source_type = "GeoJSON"
        elif filename.endswith(".dxf"):
            contours, fields, chosen, warnings = _dxf_lines(
                data, elevation_field, source_epsg
            )
            source_type = "DXF"
        else:
            raise HTTPException(
                status_code=400,
                detail="Formato no soportado. Usa .zip (Shapefile), .geojson/.json o .dxf.",
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No fue posible importar la topografía: {exc}") from exc

    if not contours:
        raise HTTPException(status_code=400, detail="No se encontraron líneas de curvas de nivel.")

    all_points = [point for contour in contours for point in contour["points"]]
    bounds = None
    if all_points:
        lats = [p[0] for p in all_points]
        lons = [p[1] for p in all_points]
        bounds = [[min(lats), min(lons)], [max(lats), max(lons)]]

    return {
        "source_type": source_type,
        "count": len(contours),
        "fields": fields,
        "elevation_field": chosen,
        "warnings": warnings,
        "bounds": bounds,
        "contours": contours,
    }


@app.get("/api/geocode")
def geocode(q: str):
    query = q.strip()
    if not query:
        return {"results": []}

    params = urlencode({
        "q": query,
        "format": "jsonv2",
        "limit": 5,
        "addressdetails": 1,
    })
    request = Request(
        f"https://nominatim.openstreetmap.org/search?{params}",
        headers={
            "User-Agent": "NoiseMapLab-UC/3.1 (educational acoustic mapping)",
            "Accept-Language": "es",
        },
    )
    try:
        with urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {"results": []}

    return {
        "results": [
            {
                "display_name": item.get("display_name", ""),
                "lat": float(item["lat"]),
                "lon": float(item["lon"]),
                "type": item.get("type", ""),
            }
            for item in payload
            if "lat" in item and "lon" in item
        ]
    }




@app.post("/api/receiver-preview")
def receiver_preview(payload: ReceiverPreviewRequest):
    all_sources = _expand_sources(
        payload.sources, payload.roads, payload.settings.temperature_c
    )
    if not all_sources:
        return {
            "level_db": None,
            "bands_db": {str(b): None for b in OCTAVE_BANDS},
            "contributions": [],
            "diagnostics": [],
        }

    lats = [payload.receiver.lat] + [s.lat for s in all_sources]
    lons = [payload.receiver.lon] + [s.lon for s in all_sources]
    lat0 = sum(lats) / len(lats)
    lon0 = sum(lons) / len(lons)
    terrain_samples = _build_terrain_samples(payload.contours, lat0, lon0)
    receiver_ground_elevation_m = _terrain_elevation(
        terrain_samples, payload.receiver.lat, payload.receiver.lon, lat0, lon0
    )
    source_ground_elevations = {
        source.id: _terrain_elevation(terrain_samples, source.lat, source.lon, lat0, lon0)
        for source in all_sources
    }

    barriers = [
        Barrier(
            name=b.name,
            lat_a=b.lat_a,
            lon_a=b.lon_a,
            lat_b=b.lat_b,
            lon_b=b.lon_b,
            height_m=b.height_m,
            enabled=b.enabled,
            reflection_percent=b.reflection_percent,
            ground_elevation_m=_terrain_elevation(
                terrain_samples,
                (b.lat_a + b.lat_b) / 2.0,
                (b.lon_a + b.lon_b) / 2.0,
                lat0,
                lon0,
            ),
        )
        for b in payload.barriers
    ]

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
        ground_factor=payload.settings.ground_factor,
        reflections_enabled=payload.settings.reflections_enabled,
    )
    settings.a_weighting = payload.settings.a_weighting

    totals = []
    band_values = {str(b): [] for b in OCTAVE_BANDS}
    diagnostics = []
    contribution_items = []

    for source in all_sources:
        if not source.enabled:
            continue

        result = _source_spectral_result(
            source,
            payload.receiver.lat,
            payload.receiver.lon,
            payload.receiver.height_m,
            barriers,
            settings,
            lat0,
            lon0,
            terrain_samples=terrain_samples,
            receiver_ground_elevation_m=receiver_ground_elevation_m,
            source_ground_elevation_m=source_ground_elevations.get(source.id),
        )
        contribution_items.append((source, result))

        if source.source_kind != "road":
            diagnostic_source = Source(
                name=source.name,
                lat=source.lat,
                lon=source.lon,
                height_m=source.height_m,
                lw_db=float(source.lw_db),
                dc_db=source.dc_db,
                enabled=source.enabled,
                ground_elevation_m=source_ground_elevations.get(source.id, 0.0),
            )
            diag = source_to_point_breakdown(
                diagnostic_source,
                payload.receiver.lat,
                payload.receiver.lon,
                payload.receiver.height_m,
                barriers,
                settings,
                lat0,
                lon0,
                receiver_ground_elevation_m=receiver_ground_elevation_m,
            )
            diagnostics.append({
                "source_id": source.id,
                "source_name": source.name,
                "distance_3d_m": round(float(diag["distance_m"]), 3),
                "a_div_db": round(float(diag["a_div_db"]), 3),
                "a_atm_db": round(float(diag["a_atm_db"]), 3),
                "a_gr_db": round(float(diag["a_gr_db"]), 3),
                "a_bar_db": round(float(diag["a_bar_db"]), 3),
                "lp_direct_db": round(float(diag["lp_direct_db"]), 3),
                "lp_reflected_db": (
                    round(float(diag["lp_reflected_db"]), 3)
                    if np.isfinite(diag["lp_reflected_db"]) else None
                ),
                "reflection_count": int(diag["reflection_count"]),
                "source_ground_elevation_m": round(float(diag["source_ground_elevation_m"]), 3),
                "receiver_ground_elevation_m": round(float(diag["receiver_ground_elevation_m"]), 3),
            })

        total = result.get("total_db")
        if total is not None and np.isfinite(total):
            totals.append(float(total))

        for band in OCTAVE_BANDS:
            value = result.get("bands_db", {}).get(str(band))
            if value is not None and np.isfinite(value):
                band_values[str(band)].append(float(value))

    total_level = energetic_sum_db(totals)
    bands_db = {}
    for band in OCTAVE_BANDS:
        values = band_values[str(band)]
        value = energetic_sum_db(values)
        bands_db[str(band)] = round(float(value), 3) if values and np.isfinite(value) else None

    return {
        "level_db": round(float(total_level), 3) if np.isfinite(total_level) else None,
        "bands_db": bands_db,
        "contributions": _aggregate_contributions(contribution_items),
        "diagnostics": diagnostics,
        "receiver_height_m": payload.receiver.height_m,
        "receiver_ground_elevation_m": round(float(receiver_ground_elevation_m), 3),
    }


@app.post("/api/barrier-profile")
def barrier_profile(payload: BarrierProfileRequest):
    s = payload.source
    r = payload.receiver
    b = payload.barrier

    lat0 = (s.lat + r.lat + b.lat_a + b.lat_b) / 4.0
    lon0 = (s.lon + r.lon + b.lon_a + b.lon_b) / 4.0

    terrain_samples = _build_terrain_samples(payload.contours, lat0, lon0)
    source_ground = _terrain_elevation(terrain_samples, s.lat, s.lon, lat0, lon0)
    receiver_ground = _terrain_elevation(terrain_samples, r.lat, r.lon, lat0, lon0)
    barrier_ground = _terrain_elevation(
        terrain_samples,
        (b.lat_a + b.lat_b) / 2.0,
        (b.lon_a + b.lon_b) / 2.0,
        lat0,
        lon0,
    )
    source_z = source_ground + s.height_m
    receiver_z = receiver_ground + r.height_m
    barrier_top_z = barrier_ground + b.height_m

    sx, sy = latlon_to_xy(s.lat, s.lon, lat0, lon0)
    rx, ry = latlon_to_xy(r.lat, r.lon, lat0, lon0)
    ax, ay = latlon_to_xy(b.lat_a, b.lon_a, lat0, lon0)
    bx, by = latlon_to_xy(b.lat_b, b.lon_b, lat0, lon0)

    horizontal_total = math.hypot(rx - sx, ry - sy)
    hit, t, _ = segment_intersection((sx, sy), (rx, ry), (ax, ay), (bx, by))

    if hit:
        barrier_x = max(0.0, min(horizontal_total, horizontal_total * t))
        los_z = source_z + t * (receiver_z - source_z)
    else:
        # For visualization only, project barrier midpoint onto the source-receiver axis.
        mx = (ax + bx) / 2.0
        my = (ay + by) / 2.0
        vx, vy = rx - sx, ry - sy
        denom = max(vx * vx + vy * vy, 1e-12)
        proj_t = ((mx - sx) * vx + (my - sy) * vy) / denom
        proj_t = max(0.0, min(1.0, proj_t))
        barrier_x = horizontal_total * proj_t
        los_z = source_z + proj_t * (receiver_z - source_z)

    d1_h = barrier_x
    d2_h = max(0.0, horizontal_total - barrier_x)
    direct = math.sqrt(horizontal_total ** 2 + (receiver_z - source_z) ** 2)
    via_top = (
        math.sqrt(d1_h ** 2 + (barrier_top_z - source_z) ** 2)
        + math.sqrt(d2_h ** 2 + (barrier_top_z - receiver_z) ** 2)
    )
    delta = max(0.0, via_top - direct) if hit and barrier_top_z > los_z else 0.0

    barrier_model = Barrier(
        name=b.name,
        lat_a=b.lat_a,
        lon_a=b.lon_a,
        lat_b=b.lat_b,
        lon_b=b.lon_b,
        height_m=b.height_m,
        enabled=b.enabled,
        ground_elevation_m=barrier_ground,
    )

    attenuation_by_band = {}
    for band in OCTAVE_BANDS:
        attenuation_by_band[str(band)] = round(
            barrier_attenuation_db(
                sx, sy, source_z,
                rx, ry, receiver_z,
                barrier_model,
                lat0, lon0,
                frequency_hz=float(band),
                max_barrier_db=payload.settings.max_barrier_db,
            ),
            2,
        )

    selected_frequency = (
        s.single_frequency_hz if s.spectrum_mode == "single"
        else payload.settings.frequency_hz
    )
    selected_attenuation = barrier_attenuation_db(
        sx, sy, source_z,
        rx, ry, receiver_z,
        barrier_model,
        lat0, lon0,
        frequency_hz=float(selected_frequency),
        max_barrier_db=payload.settings.max_barrier_db,
    )

    profile_settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
        ground_factor=payload.settings.ground_factor,
        reflections_enabled=payload.settings.reflections_enabled,
    )
    profile_settings.a_weighting = payload.settings.a_weighting

    receiver_projection = _source_spectral_result(
        s,
        r.lat,
        r.lon,
        r.height_m,
        [barrier_model],
        profile_settings,
        lat0,
        lon0,
        terrain_samples=terrain_samples,
        receiver_ground_elevation_m=receiver_ground,
    )

    return {
        "intersects": bool(hit),
        "blocked": bool(hit and barrier_top_z > los_z),
        "source_height_m": s.height_m,
        "receiver_height_m": r.height_m,
        "barrier_height_m": b.height_m,
        "source_ground_elevation_m": round(source_ground, 3),
        "receiver_ground_elevation_m": round(receiver_ground, 3),
        "barrier_ground_elevation_m": round(barrier_ground, 3),
        "source_absolute_z_m": round(source_z, 3),
        "receiver_absolute_z_m": round(receiver_z, 3),
        "barrier_top_absolute_z_m": round(barrier_top_z, 3),
        "horizontal_total_m": round(horizontal_total, 3),
        "source_to_barrier_m": round(d1_h, 3),
        "barrier_to_receiver_m": round(d2_h, 3),
        "los_height_at_barrier_m": round(los_z, 3),
        "direct_path_m": round(direct, 3),
        "diffracted_path_m": round(via_top, 3),
        "path_difference_m": round(delta, 4),
        "selected_frequency_hz": float(selected_frequency),
        "selected_attenuation_db": round(float(selected_attenuation), 2),
        "attenuation_by_band_db": attenuation_by_band,
        "receiver_level_db": (
            round(float(receiver_projection["total_db"]), 2)
            if receiver_projection.get("total_db") is not None
            and np.isfinite(receiver_projection["total_db"])
            else None
        ),
        "receiver_bands_db": receiver_projection.get("bands_db", {}),
        "receiver_mode": receiver_projection.get("mode"),
    }


@app.post("/api/calculate", response_model=CalculationResponse)
def calculate(payload: CalculationRequest):
    polygon = payload.polygon
    if len(polygon) < 3:
        return CalculationResponse(
            bounds=[[-33.457, -70.649], [-33.456, -70.648]],
            levels=[],
            min_level=None,
            max_level=None,
            receiver_results=[],
        )

    lats = [p[0] for p in polygon]
    lons = [p[1] for p in polygon]
    south, north = min(lats), max(lats)
    west, east = min(lons), max(lons)

    n = payload.settings.resolution
    lat_values = np.linspace(south, north, n)
    lon_values = np.linspace(west, east, n)

    barriers = [
        Barrier(
            name=b.name,
            lat_a=b.lat_a,
            lon_a=b.lon_a,
            lat_b=b.lat_b,
            lon_b=b.lon_b,
            height_m=b.height_m,
            enabled=b.enabled,
            reflection_percent=b.reflection_percent,
        )
        for b in payload.barriers
    ]

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
        ground_factor=payload.settings.ground_factor,
        reflections_enabled=payload.settings.reflections_enabled,
    )
    settings.a_weighting = payload.settings.a_weighting

    lat0 = sum(lats) / len(lats)
    lon0 = sum(lons) / len(lons)
    terrain_samples = _build_terrain_samples(payload.contours, lat0, lon0)
    source_ground_elevations = {
        source.id: _terrain_elevation(terrain_samples, source.lat, source.lon, lat0, lon0)
        for source in payload.sources
    }
    for barrier_model, barrier_input in zip(barriers, payload.barriers):
        barrier_model.ground_elevation_m = _terrain_elevation(
            terrain_samples,
            (barrier_input.lat_a + barrier_input.lat_b) / 2.0,
            (barrier_input.lon_a + barrier_input.lon_b) / 2.0,
            lat0,
            lon0,
        )

    matrix: list[list[Optional[float]]] = []
    finite: list[float] = []

    # Returned north -> south so the browser can paint it directly to canvas.
    for lat in reversed(lat_values):
        row: list[Optional[float]] = []
        for lon in lon_values:
            lat_f = float(lat)
            lon_f = float(lon)

            if not point_in_polygon(lat_f, lon_f, polygon):
                row.append(None)
                continue

            receiver_ground = _terrain_elevation(
                terrain_samples, lat_f, lon_f, lat0, lon0
            )
            level = _combined_spectral_level_at_point(
                payload.sources,
                lat_f,
                lon_f,
                payload.settings.receiver_height_m,
                barriers,
                settings,
                lat0,
                lon0,
                terrain_samples=terrain_samples,
                receiver_ground_elevation_m=receiver_ground,
                source_ground_elevations=source_ground_elevations,
            )

            if np.isfinite(level):
                value = round(float(level), 3)
                finite.append(value)
                row.append(value)
            else:
                row.append(None)

        matrix.append(row)

    receiver_results = []
    for receiver in payload.receivers:
        contributions = []
        all_source_totals = []
        combined_band_levels = {str(b): [] for b in OCTAVE_BANDS}

        for source_input in payload.sources:
            if not source_input.enabled:
                continue

            receiver_ground = _terrain_elevation(
                terrain_samples, receiver.lat, receiver.lon, lat0, lon0
            )
            source_result = _source_spectral_result(
                source_input,
                receiver.lat,
                receiver.lon,
                receiver.height_m,
                barriers,
                settings,
                lat0,
                lon0,
                terrain_samples=terrain_samples,
                receiver_ground_elevation_m=receiver_ground,
                source_ground_elevation_m=source_ground_elevations.get(source_input.id),
            )

            source_total = source_result.get("total_db")
            if source_total is not None and np.isfinite(source_total):
                all_source_totals.append(float(source_total))

            for band in OCTAVE_BANDS:
                band_value = source_result["bands_db"].get(str(band))
                if band_value is not None and np.isfinite(band_value):
                    combined_band_levels[str(band)].append(float(band_value))

            contributions.append({
                "source_id": source_input.id,
                "source_name": source_input.name,
                "mode": source_result.get("mode"),
                "level_db": round(float(source_total), 2)
                    if source_total is not None and np.isfinite(source_total)
                    else None,
                "bands_db": source_result.get("bands_db", {}),
            })

        total_level = energetic_sum_db(all_source_totals)
        receiver_bands = {}
        for band in OCTAVE_BANDS:
            values = combined_band_levels[str(band)]
            band_total = energetic_sum_db(values)
            receiver_bands[str(band)] = (
                round(float(band_total), 2) if values and np.isfinite(band_total) else None
            )

        receiver_results.append({
            "id": receiver.id,
            "name": receiver.name,
            "height_m": receiver.height_m,
            "ground_elevation_m": round(float(receiver_ground), 2) if payload.contours else 0.0,
            "level_db": round(float(total_level), 2) if np.isfinite(total_level) else None,
            "bands_db": receiver_bands,
            "contributions": contributions,
        })

    return CalculationResponse(
        bounds=[[south, west], [north, east]],
        levels=matrix,
        min_level=min(finite) if finite else None,
        max_level=max(finite) if finite else None,
        receiver_results=receiver_results,
    )
