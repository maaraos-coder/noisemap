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
):
    adjustment = _source_adjustment_db(source_input)
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
    )
    broadband_settings = PropagationSettings(
        alpha_db_per_km=base_settings.alpha_db_per_km,
        frequency_hz=base_settings.frequency_hz,
        max_barrier_db=base_settings.max_barrier_db,
        temperature_c=base_settings.temperature_c,
        humidity_pct=base_settings.humidity_pct,
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
    receiver_height_m: float = Field(default=1.5, gt=0.0, le=50.0)
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


class CalculationRequest(BaseModel):
    sources: List[SourceIn]
    receivers: List[ReceiverIn] = []
    barriers: List[BarrierIn] = []
    polygon: List[List[float]]
    settings: GridSettings = GridSettings()


class BarrierProfileRequest(BaseModel):
    source: SourceIn
    receiver: ReceiverIn
    barrier: BarrierIn
    settings: GridSettings = GridSettings()


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



@app.post("/api/barrier-profile")
def barrier_profile(payload: BarrierProfileRequest):
    s = payload.source
    r = payload.receiver
    b = payload.barrier

    lat0 = (s.lat + r.lat + b.lat_a + b.lat_b) / 4.0
    lon0 = (s.lon + r.lon + b.lon_a + b.lon_b) / 4.0

    sx, sy = latlon_to_xy(s.lat, s.lon, lat0, lon0)
    rx, ry = latlon_to_xy(r.lat, r.lon, lat0, lon0)
    ax, ay = latlon_to_xy(b.lat_a, b.lon_a, lat0, lon0)
    bx, by = latlon_to_xy(b.lat_b, b.lon_b, lat0, lon0)

    horizontal_total = math.hypot(rx - sx, ry - sy)
    hit, t, _ = segment_intersection((sx, sy), (rx, ry), (ax, ay), (bx, by))

    if hit:
        barrier_x = max(0.0, min(horizontal_total, horizontal_total * t))
        los_z = s.height_m + t * (r.height_m - s.height_m)
    else:
        # For visualization only, project barrier midpoint onto the source-receiver axis.
        mx = (ax + bx) / 2.0
        my = (ay + by) / 2.0
        vx, vy = rx - sx, ry - sy
        denom = max(vx * vx + vy * vy, 1e-12)
        proj_t = ((mx - sx) * vx + (my - sy) * vy) / denom
        proj_t = max(0.0, min(1.0, proj_t))
        barrier_x = horizontal_total * proj_t
        los_z = s.height_m + proj_t * (r.height_m - s.height_m)

    d1_h = barrier_x
    d2_h = max(0.0, horizontal_total - barrier_x)
    direct = math.sqrt(horizontal_total ** 2 + (r.height_m - s.height_m) ** 2)
    via_top = (
        math.sqrt(d1_h ** 2 + (b.height_m - s.height_m) ** 2)
        + math.sqrt(d2_h ** 2 + (b.height_m - r.height_m) ** 2)
    )
    delta = max(0.0, via_top - direct) if hit and b.height_m > los_z else 0.0

    barrier_model = Barrier(
        name=b.name,
        lat_a=b.lat_a,
        lon_a=b.lon_a,
        lat_b=b.lat_b,
        lon_b=b.lon_b,
        height_m=b.height_m,
        enabled=b.enabled,
    )

    attenuation_by_band = {}
    for band in OCTAVE_BANDS:
        attenuation_by_band[str(band)] = round(
            barrier_attenuation_db(
                sx, sy, s.height_m,
                rx, ry, r.height_m,
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
        sx, sy, s.height_m,
        rx, ry, r.height_m,
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
    )

    return {
        "intersects": bool(hit),
        "blocked": bool(hit and b.height_m > los_z),
        "source_height_m": s.height_m,
        "receiver_height_m": r.height_m,
        "barrier_height_m": b.height_m,
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
        )
        for b in payload.barriers
    ]

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
    )
    settings.a_weighting = payload.settings.a_weighting

    lat0 = sum(lats) / len(lats)
    lon0 = sum(lons) / len(lons)

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

            level = _combined_spectral_level_at_point(
                payload.sources,
                lat_f,
                lon_f,
                payload.settings.receiver_height_m,
                barriers,
                settings,
                lat0,
                lon0,
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

            source_result = _source_spectral_result(
                source_input,
                receiver.lat,
                receiver.lon,
                receiver.height_m,
                barriers,
                settings,
                lat0,
                lon0,
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
