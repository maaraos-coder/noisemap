from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from pathlib import Path
from dataclasses import replace
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
    xy_to_latlon,
    segment_intersection,
    barrier_attenuation_db,
    iso9613_2024_diffraction_dz_db,
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


def _dict_band_value(values: Dict[str, float], band_hz: float, default: float = 0.0) -> float:
    """Return a spectral value using logarithmic-frequency interpolation.

    Exact octave-band values are preserved. Frequencies between defined bands
    are interpolated in log(f), which is preferable to snapping Single mode to
    the nearest octave band.
    """
    if not values:
        return float(default)

    pts = []
    for band in OCTAVE_BANDS:
        raw = values.get(str(band), values.get(band))
        if raw is None:
            continue
        try:
            pts.append((float(band), max(0.0, float(raw))))
        except (TypeError, ValueError):
            continue
    if not pts:
        return float(default)

    f = max(float(band_hz), 1e-6)
    pts.sort()
    if f <= pts[0][0]:
        return pts[0][1]
    if f >= pts[-1][0]:
        return pts[-1][1]

    for (f0, v0), (f1, v1) in zip(pts, pts[1:]):
        if f0 <= f <= f1:
            if abs(f1 - f0) < 1e-12:
                return v0
            t = (math.log(f) - math.log(f0)) / (math.log(f1) - math.log(f0))
            return v0 + t * (v1 - v0)
    return float(default)

def _dict_band_value_signed(values: Dict[str, float], band_hz: float, default: float = 0.0) -> float:
    """Log-frequency interpolation that preserves signed spectral offsets."""
    if not values:
        return float(default)
    pts = []
    for band in OCTAVE_BANDS:
        raw = values.get(str(band), values.get(band))
        if raw is None:
            continue
        try:
            pts.append((float(band), float(raw)))
        except (TypeError, ValueError):
            continue
    if not pts:
        return float(default)
    f = max(float(band_hz), 1e-6)
    pts.sort()
    if f <= pts[0][0]:
        return pts[0][1]
    if f >= pts[-1][0]:
        return pts[-1][1]
    for (f0, v0), (f1, v1) in zip(pts, pts[1:]):
        if f0 <= f <= f1:
            t = (math.log(f) - math.log(f0)) / max(math.log(f1) - math.log(f0), 1e-12)
            return v0 + t * (v1 - v0)
    return float(default)



def _a_weighting_correction_db(frequency_hz: float) -> float:
    """IEC-style analytical A-weighting correction for an arbitrary frequency."""
    f = max(float(frequency_hz), 1e-6)
    f2 = f * f
    numerator = (12200.0 ** 2) * (f ** 4)
    denominator = (
        (f2 + 20.6 ** 2)
        * math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2))
        * (f2 + 12200.0 ** 2)
    )
    ra = numerator / max(denominator, 1e-30)
    return 20.0 * math.log10(max(ra, 1e-30)) + 2.0


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _angular_difference_deg(a: float, b: float) -> float:
    return abs((float(a) - float(b) + 180.0) % 360.0 - 180.0)


def _rw_estimated_tl_db(rw_db: float, band_hz: float) -> float:
    """Estimate an octave-band R/TL curve from a single Rw.

    The shape follows the ISO 717-1 reference-curve trend around 125-3150 Hz
    and is explicitly only a design estimate; 63 Hz and the upper octaves are
    extrapolated. A measured/certified spectrum should be preferred.
    """
    rw = max(0.0, float(rw_db or 0.0))
    offsets = {
        "63": -25.0,
        "125": -16.0,
        "250": -7.0,
        "500": 0.0,
        "1000": 3.0,
        "2000": 4.0,
        "4000": 4.0,
        "8000": 4.0,
    }
    return max(0.0, rw + _dict_band_value_signed(offsets, band_hz, 0.0))


ENCLOSURE_ABSORPTION_PRESETS = {
    # Generic room-side absorption coefficients for educational enclosure design.
    # These are not material certificates.
    "unlined": {
        "63": 0.02, "125": 0.02, "250": 0.03, "500": 0.04,
        "1000": 0.05, "2000": 0.05, "4000": 0.05, "8000": 0.05,
    },
    "low": {
        "63": 0.04, "125": 0.06, "250": 0.10, "500": 0.16,
        "1000": 0.22, "2000": 0.28, "4000": 0.30, "8000": 0.30,
    },
    "medium": {
        "63": 0.08, "125": 0.15, "250": 0.30, "500": 0.50,
        "1000": 0.65, "2000": 0.75, "4000": 0.80, "8000": 0.80,
    },
    "high": {
        "63": 0.15, "125": 0.30, "250": 0.55, "500": 0.72,
        "1000": 0.84, "2000": 0.90, "4000": 0.92, "8000": 0.92,
    },
}


def _enclosure_absorption_alpha(source, band_hz: float) -> float:
    mode = str(getattr(source, "enclosure_lining_mode", "unlined") or "unlined").lower()
    if mode == "custom":
        alpha = _dict_band_value(getattr(source, "enclosure_absorption_coeff", {}) or {}, band_hz, 0.05)
    else:
        alpha = _dict_band_value(ENCLOSURE_ABSORPTION_PRESETS.get(mode, ENCLOSURE_ABSORPTION_PRESETS["unlined"]), band_hz, 0.05)
    return min(max(float(alpha), 0.0), 0.99)


def _face_tl_db(source, face_name: str, band_hz: float) -> float:
    faces = getattr(source, "enclosure_faces", None) or {}
    face = faces.get(face_name) or {}
    mode = str(face.get("acoustic_mode", "rw") or "rw").lower()
    if mode == "spectrum":
        return _dict_band_value(face.get("tl_db") or {}, band_hz)
    return _rw_estimated_tl_db(
        float(face.get("rw_db", getattr(source, "enclosure_rw_db", 30.0)) or 0.0),
        band_hz,
    )


def _offset_latlon(lat: float, lon: float, east_m: float, north_m: float) -> tuple[float, float]:
    dlat = math.degrees(float(north_m) / 6_371_000.0)
    lat2 = float(lat) + dlat
    mean_lat = math.radians((float(lat) + lat2) / 2.0)
    dlon = math.degrees(float(east_m) / (6_371_000.0 * max(math.cos(mean_lat), 1e-9)))
    return lat2, float(lon) + dlon


def _enclosure_face_geometry(source) -> Dict[str, dict]:
    length = max(float(getattr(source, "enclosure_length_m", 2.0) or 2.0), 0.01)
    width = max(float(getattr(source, "enclosure_width_m", 2.0) or 2.0), 0.01)
    height = max(float(getattr(source, "enclosure_height_m", 2.5) or 2.5), 0.01)
    az = math.radians(float(getattr(source, "enclosure_azimuth_deg", 0.0) or 0.0))

    # Horizontal unit vectors, with azimuth measured clockwise from North.
    front = (math.sin(az), math.cos(az))
    right = (math.cos(az), -math.sin(az))

    center_z = max(float(source.height_m), height / 2.0)
    wall_z = center_z
    roof_z = center_z + height / 2.0
    floor_z = max(0.05, center_z - height / 2.0)

    specs = {
        "front": (front[0] * length / 2.0, front[1] * length / 2.0, wall_z, width * height, (front[0], front[1], 0.0)),
        "back": (-front[0] * length / 2.0, -front[1] * length / 2.0, wall_z, width * height, (-front[0], -front[1], 0.0)),
        "right": (right[0] * width / 2.0, right[1] * width / 2.0, wall_z, length * height, (right[0], right[1], 0.0)),
        "left": (-right[0] * width / 2.0, -right[1] * width / 2.0, wall_z, length * height, (-right[0], -right[1], 0.0)),
        "roof": (0.0, 0.0, roof_z, length * width, (0.0, 0.0, 1.0)),
        "floor": (0.0, 0.0, floor_z, length * width, (0.0, 0.0, -1.0)),
    }

    result = {}
    for name, (east, north, z, area, normal) in specs.items():
        lat, lon = _offset_latlon(source.lat, source.lon, east, north)
        result[name] = {
            "lat": lat,
            "lon": lon,
            "height_m": z,
            "area_m2": max(area, 1e-9),
            "normal": normal,
        }
    return result


def _face_open_fraction(face: dict) -> float:
    state = str(face.get("state", "closed") or "closed").lower()
    if state == "open":
        return 1.0
    if state == "partial":
        return min(max(float(face.get("opening_pct", 25.0) or 0.0) / 100.0, 0.0), 1.0)
    return 0.0


def _face_radiation_dc_db(
    face_geometry: dict,
    receiver_lat: float,
    receiver_lon: float,
    receiver_abs_z: float,
    source_ground_elevation_m: float,
) -> Optional[float]:
    """Lambertian half-space radiation from a panel/opening.

    Q(theta)=4*cos(theta), normalized so the pattern integrates to the face
    sound power over 4π. Returns None when the receiver lies behind the face.
    """
    sx, sy = latlon_to_xy(face_geometry["lat"], face_geometry["lon"], face_geometry["lat"], face_geometry["lon"])
    rx, ry = latlon_to_xy(receiver_lat, receiver_lon, face_geometry["lat"], face_geometry["lon"])
    dz = receiver_abs_z - (source_ground_elevation_m + float(face_geometry["height_m"]))
    distance = math.sqrt((rx - sx) ** 2 + (ry - sy) ** 2 + dz ** 2)
    if distance <= 1e-9:
        return 0.0

    ux, uy, uz = (rx - sx) / distance, (ry - sy) / distance, dz / distance
    nx, ny, nz = face_geometry["normal"]
    cos_theta = nx * ux + ny * uy + nz * uz
    if cos_theta <= 0.0:
        return None
    q = max(4.0 * cos_theta, 1e-12)
    return 10.0 * math.log10(q)


def _enclosure_virtual_sources(
    source,
    band_hz: float,
    input_lw_db: float,
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    source_ground_elevation_m: float,
    receiver_ground_elevation_m: float,
) -> list[Source]:
    """Convert an enclosure/semi-enclosure into radiating face sources.

    A diffuse-field energy balance is used inside the enclosure. Closed panel
    area contributes room-side absorption plus transmission loss; open area is
    an acoustic loss area of 1.0. External power from every face is then
    propagated independently with a smooth Lambertian directivity.
    """
    faces_cfg = getattr(source, "enclosure_faces", None) or {}
    geometry = _enclosure_face_geometry(source)
    alpha = _enclosure_absorption_alpha(source, band_hz)

    vent_area_requested = 0.0
    vent_face = str(getattr(source, "enclosure_vent_face", "back") or "back").lower()
    if (getattr(source, "noise_control_type", "") or "").lower() == "enclosure_silencer":
        vent_area_requested = max(float(getattr(source, "enclosure_vent_area_m2", 0.0) or 0.0), 0.0)
    if vent_face not in geometry:
        vent_face = "back"

    # Build effective loss area of the cavity and remember external transmission areas.
    path_data = {}
    loss_area = 0.0
    remaining_vent_area = vent_area_requested

    for face_name, geom in geometry.items():
        face = faces_cfg.get(face_name) or {}
        area = float(geom["area_m2"])
        open_fraction = _face_open_fraction(face)
        open_area = area * open_fraction
        panel_area = max(0.0, area - open_area)

        vent_area = 0.0
        if face_name == vent_face and remaining_vent_area > 0.0 and panel_area > 0.0:
            vent_area = min(panel_area, remaining_vent_area)
            panel_area -= vent_area
            remaining_vent_area -= vent_area

        tl = _face_tl_db(source, face_name, band_hz)
        tau_panel = 10.0 ** (-tl / 10.0)

        # Closed portion loses energy by internal lining absorption and by transmission.
        # An opening (including the vent inlet) removes incident diffuse-field energy
        # from the cavity. This keeps the energy balance bounded by the input power.
        panel_loss_coeff = min(1.0, alpha + tau_panel)
        loss_area += panel_area * panel_loss_coeff + open_area + vent_area

        external_area_tau = panel_area * tau_panel + open_area
        if vent_area > 0.0:
            il = _dict_band_value(getattr(source, "silencer_il_db", {}) or {}, band_hz)
            tau_silencer = 10.0 ** (-il / 10.0)
            external_area_tau += vent_area * tau_silencer

        path_data[face_name] = {
            "external_area_tau": external_area_tau,
            "geometry": geom,
        }

    loss_area = max(loss_area, 1e-9)
    receiver_abs_z = receiver_ground_elevation_m + float(receiver_height_m)
    virtual_sources = []

    for face_name, data in path_data.items():
        ratio = max(0.0, min(1.0, data["external_area_tau"] / loss_area))
        if ratio <= 1e-12:
            continue
        dc = _face_radiation_dc_db(
            data["geometry"],
            receiver_lat,
            receiver_lon,
            receiver_abs_z,
            source_ground_elevation_m,
        )
        if dc is None:
            continue

        face_lw = float(input_lw_db) + 10.0 * math.log10(max(ratio, 1e-12))
        virtual_sources.append(Source(
            name=f"{source.name} · {face_name}",
            lat=float(data["geometry"]["lat"]),
            lon=float(data["geometry"]["lon"]),
            height_m=float(data["geometry"]["height_m"]),
            lw_db=face_lw,
            dc_db=dc,
            enabled=source.enabled,
            ground_elevation_m=source_ground_elevation_m,
        ))

    return virtual_sources


def _source_control_attenuation_db(
    source,
    band_hz: float,
    receiver_lat: Optional[float] = None,
    receiver_lon: Optional[float] = None,
) -> float:
    """Source-side control for non-enclosure controls.

    Enclosures are handled explicitly as multiple radiating surfaces by
    _enclosure_virtual_sources(), rather than by subtracting a single TL.
    """
    kind = (getattr(source, "noise_control_type", "none") or "none").lower()
    if kind == "direct":
        mode = (getattr(source, "spectrum_mode", "broadband") or "broadband").lower()
        if mode in ("broadband", "single"):
            return max(0.0, float(getattr(source, "control_direct_db", 0.0) or 0.0))
        return _dict_band_value(source.control_reduction_db, band_hz)
    if kind == "silencer":
        return _dict_band_value(source.silencer_il_db, band_hz)
    return 0.0


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
        c0_db=getattr(base, "c0_db", 0.0),
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
    buildings=None,
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
    control_kind = (source_input.noise_control_type or "none").lower()
    enclosure_control = control_kind in ("enclosure", "semi", "enclosure_silencer")

    # Geometry of a source-receiver path does not change with frequency.
    # Reusing the adjusted barrier list avoids repeating line intersections and
    # terrain lookups for every octave band.
    static_path_barriers = None
    if not enclosure_control:
        static_path_barriers = _barriers_for_source_receiver_path(
            source_input.lat,
            source_input.lon,
            receiver_lat,
            receiver_lon,
            barriers,
            terrain_samples,
            lat0,
            lon0,
        )

    enclosure_path_cache: dict[tuple[float, float], list[Barrier]] = {}

    def propagate_at_frequency(lw_input: float, frequency_hz: float) -> float:
        band_settings = _settings_for_band(base_settings, frequency_hz)

        if enclosure_control:
            emitters = _enclosure_virtual_sources(
                source_input,
                frequency_hz,
                lw_input + adjustment,
                receiver_lat,
                receiver_lon,
                receiver_height_m,
                source_ground_elevation_m,
                receiver_ground_elevation_m,
            )
            if not emitters:
                return float("-inf")
            emitter_levels = []
            for emitter in emitters:
                emitter_key = (round(float(emitter.lat), 10), round(float(emitter.lon), 10))
                path_barriers = enclosure_path_cache.get(emitter_key)
                if path_barriers is None:
                    path_barriers = _barriers_for_source_receiver_path(
                        emitter.lat,
                        emitter.lon,
                        receiver_lat,
                        receiver_lon,
                        barriers,
                        terrain_samples,
                        lat0,
                        lon0,
                    )
                    enclosure_path_cache[emitter_key] = path_barriers
                emitter_levels.append(
                    level_at_point(
                        [emitter],
                        receiver_lat,
                        receiver_lon,
                        receiver_height_m,
                        path_barriers,
                        band_settings,
                        lat0,
                        lon0,
                        receiver_ground_elevation_m=receiver_ground_elevation_m,
                    )
                )
            lp = energetic_sum_db(emitter_levels)
            # Enclosure face sources can also be screened by buildings.
            building_losses = [
                _buildings_diffraction_attenuation_db(
                    emitter,
                    receiver_lat,
                    receiver_lon,
                    receiver_height_m,
                    buildings,
                    frequency_hz,
                    lat0,
                    lon0,
                    terrain_samples,
                    emitter.ground_elevation_m,
                    receiver_ground_elevation_m,
                    base_settings.max_barrier_db,
                )
                for emitter in emitters
            ]
            # A single combined correction is used for the educational model.
            # Use the weakest screening among active enclosure-face emitters so
            # one visible face does not get incorrectly hidden by another.
            building_att = min(building_losses, default=0.0)
            return lp - building_att

        control_att = _source_control_attenuation_db(
            source_input, frequency_hz, receiver_lat, receiver_lon
        )
        source_model = Source(
            name=source_input.name,
            lat=source_input.lat,
            lon=source_input.lon,
            height_m=source_input.height_m,
            lw_db=float(lw_input) + adjustment - control_att,
            dc_db=source_input.dc_db,
            enabled=source_input.enabled,
            ground_elevation_m=source_ground_elevation_m,
        )
        path_barriers = static_path_barriers if static_path_barriers is not None else barriers
        lp = level_at_point(
            [source_model],
            receiver_lat,
            receiver_lon,
            receiver_height_m,
            path_barriers,
            band_settings,
            lat0,
            lon0,
            receiver_ground_elevation_m=receiver_ground_elevation_m,
        )
        building_att = _buildings_diffraction_attenuation_db(
            source_model,
            receiver_lat,
            receiver_lon,
            receiver_height_m,
            buildings,
            frequency_hz,
            lat0,
            lon0,
            terrain_samples,
            source_ground_elevation_m,
            receiver_ground_elevation_m,
            base_settings.max_barrier_db,
        )
        return lp - building_att

    if mode == "octaves":
        bands_db = {}
        weighted_levels = []
        for band in OCTAVE_BANDS:
            lw = _source_band_level(source_input, band)
            if lw is None:
                bands_db[str(band)] = None
                continue

            lp = propagate_at_frequency(lw, band)
            if np.isfinite(lp):
                bands_db[str(band)] = round(float(lp), 3)
                weighted_levels.append(
                    float(lp) + (_a_weighting_correction_db(band) if base_settings.a_weighting else 0.0)
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
        lp = propagate_at_frequency(float(source_input.lw_db), frequency)
        total = (
            float(lp) + (_a_weighting_correction_db(frequency) if base_settings.a_weighting else 0.0)
            if np.isfinite(lp)
            else None
        )
        return {
            "total_db": total,
            "bands_db": {str(b): None for b in OCTAVE_BANDS},
            "single_level_db": round(float(lp), 3) if np.isfinite(lp) else None,
            "mode": "single",
            "frequency_hz": frequency,
        }

    # Broadband is entered as LwA. No artificial spectrum is created; propagation
    # and enclosure transfer are evaluated at the map calculation frequency.
    frequency = max(float(base_settings.frequency_hz), 1.0)
    lp = propagate_at_frequency(float(source_input.lw_db), frequency)
    return {
        "total_db": float(lp) if np.isfinite(lp) else None,
        "bands_db": {str(b): None for b in OCTAVE_BANDS},
        "mode": "broadband",
        "frequency_hz": frequency,
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
    buildings=None,
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
            buildings=buildings,
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
    noise_control_type: str = "none"
    # Legacy field retained only for loading older saved projects; the current
    # engine no longer uses a declared broadband reduction.
    control_global_db: float = Field(default=0.0, ge=0.0, le=80.0)
    control_direct_db: float = Field(default=0.0, ge=0.0, le=80.0)
    control_reduction_db: Dict[str, float] = {}
    silencer_il_db: Dict[str, float] = {}
    enclosure_tl_db: Dict[str, float] = {}
    enclosure_leak_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    enclosure_vent_pct: float = Field(default=10.0, ge=0.0, le=100.0)
    # Geometric enclosure / semi-enclosure model.
    enclosure_length_m: float = Field(default=2.0, gt=0.0, le=1000.0)
    enclosure_width_m: float = Field(default=2.0, gt=0.0, le=1000.0)
    enclosure_height_m: float = Field(default=2.5, gt=0.0, le=1000.0)
    enclosure_azimuth_deg: float = Field(default=0.0, ge=0.0, lt=360.0)
    enclosure_rw_db: float = Field(default=30.0, ge=0.0, le=100.0)
    enclosure_faces: Dict[str, Dict[str, Any]] = {}
    enclosure_lining_mode: str = "unlined"
    enclosure_absorption_coeff: Dict[str, float] = {}
    enclosure_vent_area_m2: float = Field(default=0.10, ge=0.0, le=1000.0)
    enclosure_vent_face: str = "back"
    # Legacy semi-enclosure fields retained for backward-compatible project loads.
    semi_opening_pct: float = Field(default=25.0, ge=0.0, le=100.0)
    semi_opening_azimuth_deg: float = Field(default=0.0, ge=0.0, lt=360.0)
    semi_opening_angle_deg: float = Field(default=90.0, gt=0.0, le=360.0)
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


class BuildingIn(BaseModel):
    id: str
    name: str
    points: List[List[float]]
    height_m: float = Field(default=10.0, gt=0.0, le=500.0)
    enabled: bool = True
    reflection_percent: float = Field(default=20.0, ge=0.0, le=100.0)


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
    c0_db: float = Field(default=0.0, ge=0.0, le=20.0)
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
    buildings: List[BuildingIn] = []
    contours: List[ContourIn] = []
    polygon: List[List[float]]
    settings: GridSettings = GridSettings()


class BarrierProfileRequest(BaseModel):
    source: SourceIn
    receiver: ReceiverIn
    barrier: BarrierIn
    # Full scenario is optional for backwards compatibility. When supplied,
    # the projected receptor level is calculated with the same sources,
    # traffic, barriers and buildings as the main map.
    sources: List[SourceIn] = []
    roads: List[RoadIn] = []
    barriers: List[BarrierIn] = []
    buildings: List[BuildingIn] = []
    contours: List[ContourIn] = []
    settings: GridSettings = GridSettings()


class ReceiverPreviewRequest(BaseModel):
    sources: List[SourceIn] = []
    roads: List[RoadIn] = []
    receiver: ReceiverIn
    barriers: List[BarrierIn] = []
    buildings: List[BuildingIn] = []
    contours: List[ContourIn] = []
    settings: GridSettings = GridSettings()


class AcousticCutRequest(BaseModel):
    sources: List[SourceIn] = []
    roads: List[RoadIn] = []
    barriers: List[BarrierIn] = []
    buildings: List[BuildingIn] = []
    contours: List[ContourIn] = []
    start: List[float]
    end: List[float]
    max_height_m: float = Field(default=30.0, gt=1.0, le=300.0)
    horizontal_samples: int = Field(default=56, ge=20, le=100)
    vertical_samples: int = Field(default=32, ge=12, le=80)
    settings: GridSettings = GridSettings()


def _segment_polygon_crossings_xy(
    sx: float, sy: float, rx: float, ry: float, polygon_xy: list[tuple[float, float]]
) -> list[dict]:
    """Ordered source-receiver crossings with a closed polygon boundary."""
    crossings = []
    n = len(polygon_xy)
    if n < 3:
        return crossings
    for i in range(n):
        a = polygon_xy[i]
        b = polygon_xy[(i + 1) % n]
        hit, t, u = segment_intersection((sx, sy), (rx, ry), a, b)
        if not hit:
            continue
        # Merge duplicate vertex hits.
        if any(abs(t - item["t"]) < 1e-7 for item in crossings):
            continue
        crossings.append({"t": float(t), "edge": i, "u": float(u)})
    return sorted(crossings, key=lambda item: item["t"])


def _polygon_perimeter_data(points_xy: list[tuple[float, float]]):
    lengths = []
    cumulative = [0.0]
    n = len(points_xy)
    for i in range(n):
        a = points_xy[i]
        b = points_xy[(i + 1) % n]
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        lengths.append(length)
        cumulative.append(cumulative[-1] + length)
    return lengths, cumulative, cumulative[-1]


def _point_on_polygon_perimeter(
    points_xy: list[tuple[float, float]],
    edge_lengths: list[float],
    cumulative: list[float],
    perimeter: float,
    s_value: float,
) -> tuple[float, float]:
    if not points_xy or perimeter <= 1e-9:
        return (0.0, 0.0)
    s_mod = float(s_value) % perimeter
    for i, length in enumerate(edge_lengths):
        if s_mod <= cumulative[i + 1] + 1e-12:
            local = 0.0 if length <= 1e-12 else (s_mod - cumulative[i]) / length
            a = points_xy[i]
            b = points_xy[(i + 1) % len(points_xy)]
            return (
                a[0] + local * (b[0] - a[0]),
                a[1] + local * (b[1] - a[1]),
            )
    return points_xy[-1]


def _route_side_sign(
    points_xy: list[tuple[float, float]],
    edge_lengths: list[float],
    cumulative: list[float],
    perimeter: float,
    start_s: float,
    route_length: float,
    sx: float,
    sy: float,
    rx: float,
    ry: float,
    direction: int,
) -> float:
    if route_length <= 1e-9:
        return 0.0
    midpoint_s = start_s + direction * route_length / 2.0
    px, py = _point_on_polygon_perimeter(
        points_xy, edge_lengths, cumulative, perimeter, midpoint_s
    )
    return (rx - sx) * (py - sy) - (ry - sy) * (px - sx)


def _building_diffraction_attenuation_db(
    source,
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    building,
    frequency_hz: float,
    lat0: float,
    lon0: float,
    terrain_samples,
    source_ground_elevation_m: float,
    receiver_ground_elevation_m: float,
    max_attenuation_db: float,
) -> float:
    """Finite 3-D building diffraction using roof and both lateral routes.

    A building is treated as a closed footprint/volume, not as independent
    barrier segments. If the direct source-receiver segment crosses the
    footprint below the roof, three diffracted paths are evaluated: over the
    roof and around each side of the footprint. Their transmitted energies are
    combined, which produces a continuous transition when the dominant path
    shifts from roof to either lateral route.
    """
    if not building.enabled or len(building.points) < 3:
        return 0.0

    polygon_xy = [
        latlon_to_xy(float(p[0]), float(p[1]), lat0, lon0)
        for p in building.points if len(p) >= 2
    ]
    if len(polygon_xy) < 3:
        return 0.0

    sx, sy = latlon_to_xy(source.lat, source.lon, lat0, lon0)
    rx, ry = latlon_to_xy(receiver_lat, receiver_lon, lat0, lon0)
    crossings = _segment_polygon_crossings_xy(sx, sy, rx, ry, polygon_xy)
    if len(crossings) < 2:
        return 0.0

    entry = crossings[0]
    exit_ = crossings[-1]
    if entry["t"] <= 0.0 or exit_["t"] >= 1.0 or entry["t"] >= exit_["t"]:
        return 0.0

    source_z = source_ground_elevation_m + float(source.height_m)
    receiver_z = receiver_ground_elevation_m + float(receiver_height_m)
    direct = math.sqrt((rx - sx) ** 2 + (ry - sy) ** 2 + (receiver_z - source_z) ** 2)
    if direct <= 1e-9:
        return 0.0

    # Resolve building support elevation at the actual entry/exit crossings
    # instead of using only the footprint centroid. This is more stable on
    # sloped terrain and keeps the roof geometry tied to the intercepted faces.
    vx, vy = rx - sx, ry - sy
    ex = sx + entry["t"] * vx
    ey = sy + entry["t"] * vy
    xx = sx + exit_["t"] * vx
    xy = sy + exit_["t"] * vy
    entry_lat, entry_lon = xy_to_latlon(ex, ey, lat0, lon0)
    exit_lat, exit_lon = xy_to_latlon(xx, xy, lat0, lon0)
    entry_base_z = _terrain_elevation(terrain_samples, entry_lat, entry_lon, lat0, lon0)
    exit_base_z = _terrain_elevation(terrain_samples, exit_lat, exit_lon, lat0, lon0)
    base_z = max(entry_base_z, exit_base_z)
    roof_z = base_z + float(building.height_m)

    los_entry_z = source_z + entry["t"] * (receiver_z - source_z)
    los_exit_z = source_z + exit_["t"] * (receiver_z - source_z)
    if roof_z <= max(los_entry_z, los_exit_z):
        return 0.0

    def attenuation_from_path(
        path_length: float,
        d_source_edge: float,
        d_edge_receiver: float,
        *,
        lateral: bool,
    ) -> float:
        delta = float(path_length) - direct
        return iso9613_2024_diffraction_dz_db(
            delta,
            d_source_edge,
            d_edge_receiver,
            direct,
            frequency_hz,
            lateral=lateral,
            max_db=max_attenuation_db,
        )

    # Two-edge roof route: source -> roof entry -> roof exit -> receiver.
    roof_path = (
        math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2 + (roof_z - source_z) ** 2)
        + math.hypot(xx - ex, xy - ey)
        + math.sqrt((rx - xx) ** 2 + (ry - xy) ** 2 + (receiver_z - roof_z) ** 2)
    )
    roof_first = math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2 + (roof_z - source_z) ** 2)
    roof_last = math.sqrt((rx - xx) ** 2 + (ry - xy) ** 2 + (receiver_z - roof_z) ** 2)
    roof_att = attenuation_from_path(
        roof_path,
        roof_first,
        roof_last,
        lateral=False,
    )

    # Lateral routes follow the footprint boundary between the entry and exit
    # crossings. This models diffraction around the two sides/corners of a
    # closed building instead of treating each facade as an independent screen.
    edge_lengths, cumulative, perimeter = _polygon_perimeter_data(polygon_xy)
    if perimeter <= 1e-9:
        return roof_att

    entry_s = cumulative[entry["edge"]] + entry["u"] * edge_lengths[entry["edge"]]
    exit_s = cumulative[exit_["edge"]] + exit_["u"] * edge_lengths[exit_["edge"]]
    forward = (exit_s - entry_s) % perimeter
    backward = perimeter - forward

    source_to_entry = math.sqrt(
        (ex - sx) ** 2 + (ey - sy) ** 2 + (los_entry_z - source_z) ** 2
    )
    exit_to_receiver = math.sqrt(
        (rx - xx) ** 2 + (ry - xy) ** 2 + (receiver_z - los_exit_z) ** 2
    )
    side_a_att = attenuation_from_path(
        source_to_entry + forward + exit_to_receiver,
        source_to_entry,
        exit_to_receiver,
        lateral=True,
    )
    side_b_att = attenuation_from_path(
        source_to_entry + backward + exit_to_receiver,
        source_to_entry,
        exit_to_receiver,
        lateral=True,
    )

    # Combine the three diffracted routes energetically instead of choosing
    # a hard minimum. A hard winner-switch creates cusps/"tongues" in the
    # isophones whenever the dominant path changes. The energetic combination
    # is continuous and also reflects that roof and both lateral paths can
    # contribute simultaneously. Cap at 0 dB so diffraction never amplifies
    # the unobstructed field.
    path_attenuations = (roof_att, side_a_att, side_b_att)
    relative_energy = sum(10.0 ** (-att / 10.0) for att in path_attenuations)
    combined_att = -10.0 * math.log10(max(relative_energy, 1e-12))
    return min(float(max_attenuation_db), max(0.0, combined_att))


def _buildings_diffraction_attenuation_db(
    source,
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    buildings,
    frequency_hz: float,
    lat0: float,
    lon0: float,
    terrain_samples,
    source_ground_elevation_m: float,
    receiver_ground_elevation_m: float,
    max_attenuation_db: float,
) -> float:
    """Compound 3-D screening by one or more building volumes.

    For a single intersected building the detailed roof + two-side model is
    retained. For several buildings, one ordered roof path and two coherent
    lateral paths (left/right of the direct S-R axis) are constructed through
    all intercepted footprints, then combined energetically.
    """
    active = [b for b in (buildings or []) if b.enabled and len(b.points) >= 3]
    if not active:
        return 0.0

    sx, sy = latlon_to_xy(source.lat, source.lon, lat0, lon0)
    rx, ry = latlon_to_xy(receiver_lat, receiver_lon, lat0, lon0)
    source_z = source_ground_elevation_m + float(source.height_m)
    receiver_z = receiver_ground_elevation_m + float(receiver_height_m)
    vx, vy = rx - sx, ry - sy
    direct = math.sqrt(vx * vx + vy * vy + (receiver_z - source_z) ** 2)
    if direct <= 1e-9:
        return 0.0

    intercepted = []
    for building in active:
        polygon_xy = [
            latlon_to_xy(float(p[0]), float(p[1]), lat0, lon0)
            for p in building.points if len(p) >= 2
        ]
        if len(polygon_xy) < 3:
            continue

        crossings = _segment_polygon_crossings_xy(sx, sy, rx, ry, polygon_xy)
        if len(crossings) < 2:
            continue
        entry = crossings[0]
        exit_ = crossings[-1]
        if entry["t"] <= 0.0 or exit_["t"] >= 1.0 or entry["t"] >= exit_["t"]:
            continue

        ex = sx + entry["t"] * vx
        ey = sy + entry["t"] * vy
        xx = sx + exit_["t"] * vx
        xy = sy + exit_["t"] * vy
        entry_lat, entry_lon = xy_to_latlon(ex, ey, lat0, lon0)
        exit_lat, exit_lon = xy_to_latlon(xx, xy, lat0, lon0)
        entry_base = _terrain_elevation(
            terrain_samples, entry_lat, entry_lon, lat0, lon0
        )
        exit_base = _terrain_elevation(
            terrain_samples, exit_lat, exit_lon, lat0, lon0
        )
        roof_z = max(entry_base, exit_base) + float(building.height_m)

        los_entry_z = source_z + entry["t"] * (receiver_z - source_z)
        los_exit_z = source_z + exit_["t"] * (receiver_z - source_z)
        if roof_z <= max(los_entry_z, los_exit_z):
            continue

        edge_lengths, cumulative, perimeter = _polygon_perimeter_data(polygon_xy)
        if perimeter <= 1e-9:
            continue

        entry_s = cumulative[entry["edge"]] + entry["u"] * edge_lengths[entry["edge"]]
        exit_s = cumulative[exit_["edge"]] + exit_["u"] * edge_lengths[exit_["edge"]]
        forward = (exit_s - entry_s) % perimeter
        backward = perimeter - forward

        forward_sign = _route_side_sign(
            polygon_xy, edge_lengths, cumulative, perimeter,
            entry_s, forward, sx, sy, rx, ry, +1,
        )
        backward_sign = _route_side_sign(
            polygon_xy, edge_lengths, cumulative, perimeter,
            entry_s, backward, sx, sy, rx, ry, -1,
        )

        # Preserve coherent left/right families even if polygon winding changes.
        if forward_sign >= backward_sign:
            left_detour, right_detour = forward, backward
        else:
            left_detour, right_detour = backward, forward

        intercepted.append({
            "building": building,
            "entry": entry,
            "exit": exit_,
            "entry_xy": (ex, ey),
            "exit_xy": (xx, xy),
            "roof_z": roof_z,
            "los_entry_z": los_entry_z,
            "los_exit_z": los_exit_z,
            "left_detour": left_detour,
            "right_detour": right_detour,
        })

    if not intercepted:
        return 0.0
    if len(intercepted) == 1:
        return _building_diffraction_attenuation_db(
            source,
            receiver_lat,
            receiver_lon,
            receiver_height_m,
            intercepted[0]["building"],
            frequency_hz,
            lat0,
            lon0,
            terrain_samples,
            source_ground_elevation_m,
            receiver_ground_elevation_m,
            max_attenuation_db,
        )

    intercepted.sort(key=lambda item: item["entry"]["t"])

    # ---- Compound roof route ----
    roof_points = [(sx, sy, source_z)]
    for item in intercepted:
        ex, ey = item["entry_xy"]
        xx, xy = item["exit_xy"]
        roof_points.append((ex, ey, item["roof_z"]))
        roof_points.append((xx, xy, item["roof_z"]))
    roof_points.append((rx, ry, receiver_z))

    roof_legs = [
        math.sqrt(
            (b[0] - a[0]) ** 2 +
            (b[1] - a[1]) ** 2 +
            (b[2] - a[2]) ** 2
        )
        for a, b in zip(roof_points, roof_points[1:])
    ]
    roof_path = sum(roof_legs)
    roof_delta = roof_path - direct
    roof_intermediate = sum(roof_legs[1:-1])
    wavelength = 343.0 / max(float(frequency_hz), 1.0)
    if roof_intermediate > 1e-9:
        ratio2 = (5.0 * wavelength / roof_intermediate) ** 2
        roof_c3 = (1.0 + ratio2) / (1.0 / 3.0 + ratio2)
    else:
        roof_c3 = 1.0

    roof_att = iso9613_2024_diffraction_dz_db(
        roof_delta,
        roof_legs[0],
        roof_legs[-1],
        direct,
        frequency_hz,
        lateral=False,
        c3=roof_c3,
        e_m=roof_intermediate,
        max_db=max_attenuation_db,
    )

    # ---- Coherent lateral routes ----
    first = intercepted[0]
    last = intercepted[-1]
    first_ex, first_ey = first["entry_xy"]
    last_xx, last_xy = last["exit_xy"]

    first_leg = math.sqrt(
        (first_ex - sx) ** 2 +
        (first_ey - sy) ** 2 +
        (first["los_entry_z"] - source_z) ** 2
    )
    last_leg = math.sqrt(
        (rx - last_xx) ** 2 +
        (ry - last_xy) ** 2 +
        (receiver_z - last["los_exit_z"]) ** 2
    )

    gap_length = 0.0
    for current, nxt in zip(intercepted, intercepted[1:]):
        cx, cy = current["exit_xy"]
        nx, ny = nxt["entry_xy"]
        gap_length += math.sqrt(
            (nx - cx) ** 2 +
            (ny - cy) ** 2 +
            (nxt["los_entry_z"] - current["los_exit_z"]) ** 2
        )

    left_path = (
        first_leg +
        gap_length +
        last_leg +
        sum(item["left_detour"] for item in intercepted)
    )
    right_path = (
        first_leg +
        gap_length +
        last_leg +
        sum(item["right_detour"] for item in intercepted)
    )

    left_att = iso9613_2024_diffraction_dz_db(
        left_path - direct,
        first_leg,
        last_leg,
        direct,
        frequency_hz,
        lateral=True,
        max_db=max_attenuation_db,
    )
    right_att = iso9613_2024_diffraction_dz_db(
        right_path - direct,
        first_leg,
        last_leg,
        direct,
        frequency_hz,
        lateral=True,
        max_db=max_attenuation_db,
    )

    path_attenuations = (roof_att, left_att, right_att)
    relative_energy = sum(10.0 ** (-att / 10.0) for att in path_attenuations)
    combined_att = -10.0 * math.log10(max(relative_energy, 1e-12))
    return min(float(max_attenuation_db), max(0.0, combined_att))



def _barriers_with_buildings(
    barrier_inputs: List[BarrierIn],
    buildings: List[BuildingIn],
    terrain_samples,
    lat0: float,
    lon0: float,
) -> List[Barrier]:
    result: List[Barrier] = []

    for b in barrier_inputs:
        ground = _terrain_elevation(
            terrain_samples,
            (b.lat_a + b.lat_b) / 2.0,
            (b.lon_a + b.lon_b) / 2.0,
            lat0,
            lon0,
        )
        result.append(Barrier(
            name=b.name,
            lat_a=b.lat_a,
            lon_a=b.lon_a,
            lat_b=b.lat_b,
            lon_b=b.lon_b,
            height_m=b.height_m,
            enabled=b.enabled,
            reflection_percent=b.reflection_percent,
            ground_elevation_m=ground,
        ))

    for building in buildings or []:
        if not building.enabled or len(building.points) < 3:
            continue

        pts = [
            [float(point[0]), float(point[1])]
            for point in building.points
            if len(point) >= 2
        ]
        if len(pts) < 3:
            continue

        for edge_index, (a, b) in enumerate(zip(pts, pts[1:] + pts[:1]), start=1):
            ground = _terrain_elevation(
                terrain_samples,
                (a[0] + b[0]) / 2.0,
                (a[1] + b[1]) / 2.0,
                lat0,
                lon0,
            )
            result.append(Barrier(
                name=f"{building.name} · fachada {edge_index}",
                lat_a=a[0],
                lon_a=a[1],
                lat_b=b[0],
                lon_b=b[1],
                height_m=building.height_m,
                enabled=True,
                reflection_percent=building.reflection_percent,
                ground_elevation_m=ground,
                free_end_a=False,
                free_end_b=False,
                diffraction_enabled=False,
            ))

    return result


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



def _barriers_for_source_receiver_path(
    source_lat: float,
    source_lon: float,
    receiver_lat: float,
    receiver_lon: float,
    barriers: List[Barrier],
    terrain_samples,
    lat0: float,
    lon0: float,
) -> List[Barrier]:
    """Return barriers with top geometry referenced to terrain at the exact S-R crossing.

    A long barrier can cross sloped terrain, so using the terrain elevation at
    its midpoint can give the wrong absolute top elevation for a particular
    source-receiver ray. Diffraction-enabled screens are therefore cloned with
    ground elevation evaluated at the actual line intersection. Reflection-only
    building facades retain their own facade ground reference.
    """
    sx, sy = latlon_to_xy(source_lat, source_lon, lat0, lon0)
    rx, ry = latlon_to_xy(receiver_lat, receiver_lon, lat0, lon0)
    adjusted: List[Barrier] = []

    for barrier in barriers:
        if not barrier.enabled or not getattr(barrier, "diffraction_enabled", True):
            adjusted.append(barrier)
            continue

        ax, ay = latlon_to_xy(barrier.lat_a, barrier.lon_a, lat0, lon0)
        bx, by = latlon_to_xy(barrier.lat_b, barrier.lon_b, lat0, lon0)
        hit, t, u = segment_intersection((sx, sy), (rx, ry), (ax, ay), (bx, by))
        if not hit or not (0.0 <= t <= 1.0 and 0.0 <= u <= 1.0):
            adjusted.append(barrier)
            continue

        hit_lat = float(source_lat) + float(t) * (float(receiver_lat) - float(source_lat))
        hit_lon = float(source_lon) + float(t) * (float(receiver_lon) - float(source_lon))
        hit_ground = _terrain_elevation(
            terrain_samples, hit_lat, hit_lon, lat0, lon0
        )
        adjusted.append(replace(barrier, ground_elevation_m=float(hit_ground)))

    return adjusted


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
        return {"results": [], "provider": None}

    headers = {
        "User-Agent": "NoiseMapLab-UC/3.2 (educational acoustic mapping; contact via project repository)",
        "Accept-Language": "es",
    }

    # 1) Primary provider: OpenStreetMap Nominatim.
    nominatim_error = None
    try:
        params = urlencode({
            "q": query,
            "format": "jsonv2",
            "limit": 8,
            "addressdetails": 1,
            "dedupe": 1,
        })
        request = Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers=headers,
        )
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))

        results = [
            {
                "display_name": item.get("display_name", ""),
                "lat": float(item["lat"]),
                "lon": float(item["lon"]),
                "type": item.get("type", ""),
            }
            for item in payload
            if "lat" in item and "lon" in item
        ]
        if results:
            return {"results": results[:5], "provider": "nominatim"}
    except Exception as exc:
        nominatim_error = str(exc)

    # 2) Fallback provider: Photon (OSM based). This helps when Nominatim
    # temporarily rejects/limits the request or does not resolve a street number.
    photon_error = None
    try:
        params = urlencode({"q": query, "limit": 8, "lang": "es"})
        request = Request(
            f"https://photon.komoot.io/api/?{params}",
            headers=headers,
        )
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))

        results = []
        for feature in payload.get("features", []):
            geometry = feature.get("geometry") or {}
            coordinates = geometry.get("coordinates") or []
            if len(coordinates) < 2:
                continue

            props = feature.get("properties") or {}
            parts = []
            house = props.get("housenumber")
            street = props.get("street") or props.get("name")
            if street:
                parts.append(f"{street} {house}".strip() if house else str(street))
            for key in ("district", "city", "county", "state", "country"):
                value = props.get(key)
                if value and str(value) not in parts:
                    parts.append(str(value))

            results.append({
                "display_name": ", ".join(parts) or query,
                "lat": float(coordinates[1]),
                "lon": float(coordinates[0]),
                "type": props.get("type", ""),
            })

        if results:
            return {"results": results[:5], "provider": "photon"}
    except Exception as exc:
        photon_error = str(exc)

    # Distinguish a genuine "no match" from a provider/network failure.
    provider_error = bool(nominatim_error and photon_error)
    return {
        "results": [],
        "provider": None,
        "service_error": provider_error,
        "detail": "No fue posible consultar los servicios de búsqueda." if provider_error else "",
    }




@app.post("/api/acoustic-cut")
def acoustic_cut(payload: AcousticCutRequest):
    if len(payload.start) < 2 or len(payload.end) < 2:
        raise HTTPException(status_code=400, detail="El corte necesita un punto A y un punto B.")

    lat_a, lon_a = float(payload.start[0]), float(payload.start[1])
    lat_b, lon_b = float(payload.end[0]), float(payload.end[1])
    lat0 = (lat_a + lat_b) / 2.0
    lon0 = (lon_a + lon_b) / 2.0

    ax, ay = latlon_to_xy(lat_a, lon_a, lat0, lon0)
    bx, by = latlon_to_xy(lat_b, lon_b, lat0, lon0)
    total_distance = math.hypot(bx - ax, by - ay)
    if total_distance < 1.0:
        raise HTTPException(status_code=400, detail="Los puntos A y B del corte están demasiado cerca.")

    all_sources = _expand_sources(
        payload.sources, payload.roads, payload.settings.temperature_c
    )

    terrain_samples = _build_terrain_samples(payload.contours, lat0, lon0)
    source_ground_elevations = {
        source.id: _terrain_elevation(terrain_samples, source.lat, source.lon, lat0, lon0)
        for source in all_sources
    }
    barriers = _barriers_with_buildings(
        payload.barriers,
        payload.buildings,
        terrain_samples,
        lat0,
        lon0,
    )

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
        ground_factor=payload.settings.ground_factor,
        reflections_enabled=payload.settings.reflections_enabled,
        c0_db=payload.settings.c0_db,
    )
    settings.a_weighting = payload.settings.a_weighting

    horizontal = []
    terrain_profile = []
    for i in range(payload.horizontal_samples):
        t = i / max(payload.horizontal_samples - 1, 1)
        lat = lat_a + (lat_b - lat_a) * t
        lon = lon_a + (lon_b - lon_a) * t
        ground = _terrain_elevation(terrain_samples, lat, lon, lat0, lon0)
        horizontal.append((t, lat, lon, ground))
        terrain_profile.append({
            "distance_m": round(total_distance * t, 3),
            "elevation_m": round(float(ground), 3),
        })

    min_ground = min(item[3] for item in horizontal)
    max_ground = max(item[3] for item in horizontal)
    z_min = min_ground
    z_max = max_ground + float(payload.max_height_m)
    z_values = np.linspace(z_min, z_max, payload.vertical_samples)

    levels = []
    finite = []
    # Return top -> bottom to paint directly to canvas/SVG.
    for z_abs in reversed(z_values):
        row = []
        for _, lat, lon, ground in horizontal:
            receiver_height = float(z_abs) - float(ground)
            if receiver_height <= 0.05:
                row.append(None)
                continue

            inside_solid = False
            for building in payload.buildings:
                if (
                    building.enabled
                    and len(building.points) >= 3
                    and point_in_polygon(lat, lon, building.points)
                    and z_abs <= ground + float(building.height_m)
                ):
                    inside_solid = True
                    break
            if inside_solid:
                row.append(None)
                continue

            value = _combined_spectral_level_at_point(
                all_sources,
                lat,
                lon,
                receiver_height,
                barriers,
                settings,
                lat0,
                lon0,
                terrain_samples=terrain_samples,
                receiver_ground_elevation_m=ground,
                source_ground_elevations=source_ground_elevations,
                buildings=payload.buildings,
            )
            if np.isfinite(value):
                value_f = round(float(value), 3)
                finite.append(value_f)
                row.append(value_f)
            else:
                row.append(None)
        levels.append(row)

    return {
        "distance_m": round(total_distance, 3),
        "z_min_m": round(float(z_min), 3),
        "z_max_m": round(float(z_max), 3),
        "levels": levels,
        "terrain_profile": terrain_profile,
        "min_level": min(finite) if finite else None,
        "max_level": max(finite) if finite else None,
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

    barriers = _barriers_with_buildings(
        payload.barriers,
        payload.buildings,
        terrain_samples,
        lat0,
        lon0,
    )

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
        ground_factor=payload.settings.ground_factor,
        reflections_enabled=payload.settings.reflections_enabled,
        c0_db=payload.settings.c0_db,
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
            buildings=payload.buildings,
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
                "c_met_db": round(float(diag.get("c_met_db", 0.0)), 3),
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
    source_z = source_ground + s.height_m
    receiver_z = receiver_ground + r.height_m

    sx, sy = latlon_to_xy(s.lat, s.lon, lat0, lon0)
    rx, ry = latlon_to_xy(r.lat, r.lon, lat0, lon0)
    ax, ay = latlon_to_xy(b.lat_a, b.lon_a, lat0, lon0)
    bx, by = latlon_to_xy(b.lat_b, b.lon_b, lat0, lon0)

    horizontal_total = math.hypot(rx - sx, ry - sy)
    hit, t, _ = segment_intersection((sx, sy), (rx, ry), (ax, ay), (bx, by))

    if hit:
        hit_lat = s.lat + t * (r.lat - s.lat)
        hit_lon = s.lon + t * (r.lon - s.lon)
        barrier_ground = _terrain_elevation(
            terrain_samples, hit_lat, hit_lon, lat0, lon0
        )
        barrier_x = max(0.0, min(horizontal_total, horizontal_total * t))
        los_z = source_z + t * (receiver_z - source_z)
    else:
        # For visualization only, project barrier midpoint onto the source-receiver axis.
        barrier_ground = _terrain_elevation(
            terrain_samples,
            (b.lat_a + b.lat_b) / 2.0,
            (b.lon_a + b.lon_b) / 2.0,
            lat0,
            lon0,
        )
        mx = (ax + bx) / 2.0
        my = (ay + by) / 2.0
        vx, vy = rx - sx, ry - sy
        denom = max(vx * vx + vy * vy, 1e-12)
        proj_t = ((mx - sx) * vx + (my - sy) * vy) / denom
        proj_t = max(0.0, min(1.0, proj_t))
        barrier_x = horizontal_total * proj_t
        los_z = source_z + proj_t * (receiver_z - source_z)

    barrier_top_z = barrier_ground + b.height_m

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
        c0_db=payload.settings.c0_db,
    )
    profile_settings.a_weighting = payload.settings.a_weighting

    # Keep the geometric profile metrics tied to the selected source/barrier,
    # but calculate the receptor level with the complete acoustic scenario so
    # the value shown here matches the receiver value on the main map.
    scenario_sources = list(payload.sources) if payload.sources else [s]
    scenario_roads = list(payload.roads)
    all_profile_sources = _expand_sources(
        scenario_sources,
        scenario_roads,
        payload.settings.temperature_c,
    )

    scenario_barrier_inputs = list(payload.barriers) if payload.barriers else [b]
    scenario_barriers = _barriers_with_buildings(
        scenario_barrier_inputs,
        payload.buildings,
        terrain_samples,
        lat0,
        lon0,
    )
    profile_source_ground_elevations = {
        source.id: _terrain_elevation(
            terrain_samples, source.lat, source.lon, lat0, lon0
        )
        for source in all_profile_sources
    }

    receiver_total = _combined_spectral_level_at_point(
        all_profile_sources,
        r.lat,
        r.lon,
        r.height_m,
        scenario_barriers,
        profile_settings,
        lat0,
        lon0,
        terrain_samples=terrain_samples,
        receiver_ground_elevation_m=receiver_ground,
        source_ground_elevations=profile_source_ground_elevations,
        buildings=payload.buildings,
    )

    # Preserve the per-band panel using the same full scenario.
    profile_band_values = {str(band): [] for band in OCTAVE_BANDS}
    for source in all_profile_sources:
        if not source.enabled:
            continue
        source_result = _source_spectral_result(
            source,
            r.lat,
            r.lon,
            r.height_m,
            scenario_barriers,
            profile_settings,
            lat0,
            lon0,
            terrain_samples=terrain_samples,
            receiver_ground_elevation_m=receiver_ground,
            source_ground_elevation_m=profile_source_ground_elevations.get(source.id),
            buildings=payload.buildings,
        )
        for band in OCTAVE_BANDS:
            value = source_result.get("bands_db", {}).get(str(band))
            if value is not None and np.isfinite(value):
                profile_band_values[str(band)].append(float(value))

    receiver_bands = {}
    for band in OCTAVE_BANDS:
        values = profile_band_values[str(band)]
        total_band = energetic_sum_db(values)
        receiver_bands[str(band)] = (
            round(float(total_band), 3)
            if values and np.isfinite(total_band)
            else None
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
            round(float(receiver_total), 2)
            if np.isfinite(receiver_total)
            else None
        ),
        "receiver_bands_db": receiver_bands,
        "receiver_mode": (
            "scenario"
            if payload.sources or payload.roads or payload.barriers or payload.buildings
            else s.spectrum_mode
        ),
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

    all_sources = _expand_sources(
        payload.sources, payload.roads, payload.settings.temperature_c
    )

    lats = [p[0] for p in polygon]
    lons = [p[1] for p in polygon]
    south, north = min(lats), max(lats)
    west, east = min(lons), max(lons)

    n = payload.settings.resolution
    lat_values = np.linspace(south, north, n)
    lon_values = np.linspace(west, east, n)

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=payload.settings.max_barrier_db,
        temperature_c=payload.settings.temperature_c,
        humidity_pct=payload.settings.humidity_pct,
        ground_factor=payload.settings.ground_factor,
        reflections_enabled=payload.settings.reflections_enabled,
        c0_db=payload.settings.c0_db,
    )
    settings.a_weighting = payload.settings.a_weighting

    lat0 = sum(lats) / len(lats)
    lon0 = sum(lons) / len(lons)
    terrain_samples = _build_terrain_samples(payload.contours, lat0, lon0)
    source_ground_elevations = {
        source.id: _terrain_elevation(terrain_samples, source.lat, source.lon, lat0, lon0)
        for source in all_sources
    }
    barriers = _barriers_with_buildings(
        payload.barriers,
        payload.buildings,
        terrain_samples,
        lat0,
        lon0,
    )

    def evaluate_grid_point(lat_f: float, lon_f: float) -> Optional[float]:
        if not point_in_polygon(lat_f, lon_f, polygon):
            return None
        if any(
            building.enabled
            and len(building.points) >= 3
            and point_in_polygon(lat_f, lon_f, building.points)
            for building in payload.buildings
        ):
            return None

        receiver_ground = _terrain_elevation(
            terrain_samples, lat_f, lon_f, lat0, lon0
        )
        level = _combined_spectral_level_at_point(
            all_sources,
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
            buildings=payload.buildings,
        )
        return round(float(level), 3) if np.isfinite(level) else None

    # Base acoustic grid.
    base_matrix: list[list[Optional[float]]] = []
    for lat in reversed(lat_values):
        row: list[Optional[float]] = []
        for lon in lon_values:
            row.append(evaluate_grid_point(float(lat), float(lon)))
        base_matrix.append(row)

    # Adaptive refinement around barrier/building edges. The returned field is
    # still regular for MapLibre, but the expensive ISO evaluation is repeated
    # only where strong spatial gradients are expected.
    obstacle_segments: list[tuple[float, float, float, float]] = []
    for item in payload.barriers:
        if item.enabled:
            ax, ay = latlon_to_xy(item.lat_a, item.lon_a, lat0, lon0)
            bx, by = latlon_to_xy(item.lat_b, item.lon_b, lat0, lon0)
            obstacle_segments.append((ax, ay, bx, by))
    for building in payload.buildings:
        if not building.enabled or len(building.points) < 3:
            continue
        pts_xy = [
            latlon_to_xy(float(p[0]), float(p[1]), lat0, lon0)
            for p in building.points if len(p) >= 2
        ]
        for idx in range(len(pts_xy)):
            ax, ay = pts_xy[idx]
            bx, by = pts_xy[(idx + 1) % len(pts_xy)]
            obstacle_segments.append((ax, ay, bx, by))

    def point_segment_distance(px: float, py: float, seg) -> float:
        ax, ay, bx, by = seg
        vx, vy = bx - ax, by - ay
        length2 = vx * vx + vy * vy
        if length2 <= 1e-12:
            return math.hypot(px - ax, py - ay)
        t_seg = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / length2))
        qx = ax + t_seg * vx
        qy = ay + t_seg * vy
        return math.hypot(px - qx, py - qy)

    def bilinear_base(row_f: float, col_f: float) -> Optional[float]:
        r0 = max(0, min(n - 1, int(math.floor(row_f))))
        c0 = max(0, min(n - 1, int(math.floor(col_f))))
        r1 = min(n - 1, r0 + 1)
        c1 = min(n - 1, c0 + 1)
        tr = max(0.0, min(1.0, row_f - r0))
        tc = max(0.0, min(1.0, col_f - c0))
        samples = (
            (base_matrix[r0][c0], (1.0 - tr) * (1.0 - tc)),
            (base_matrix[r0][c1], (1.0 - tr) * tc),
            (base_matrix[r1][c0], tr * (1.0 - tc)),
            (base_matrix[r1][c1], tr * tc),
        )
        if any(value is None for value, weight in samples if weight > 1e-9):
            return None
        weighted = sum(float(value) * weight for value, weight in samples if value is not None)
        total = sum(weight for value, weight in samples if value is not None)
        return round(weighted / total, 3) if total > 1e-9 else None

    matrix = base_matrix
    if obstacle_segments and n < 100:
        refined_n = min(100, 2 * n - 1)

        x0, y0 = latlon_to_xy(south, west, lat0, lon0)
        x1, y1 = latlon_to_xy(north, east, lat0, lon0)
        base_dx = abs(x1 - x0) / max(n - 1, 1)
        base_dy = abs(y1 - y0) / max(n - 1, 1)
        base_cell_diag = math.hypot(base_dx, base_dy)
        refinement_radius_m = max(6.0, min(30.0, 2.5 * base_cell_diag))

        refined_lats = np.linspace(south, north, refined_n)
        refined_lons = np.linspace(west, east, refined_n)
        refined_matrix: list[list[Optional[float]]] = []

        for row_index, lat in enumerate(reversed(refined_lats)):
            refined_row: list[Optional[float]] = []
            base_row_f = row_index * (n - 1) / max(refined_n - 1, 1)
            base_row_index = row_index // 2
            row_is_base = (row_index % 2 == 0)

            for col_index, lon in enumerate(refined_lons):
                # refined_n = 2*n-1, so every even/even refined node is exactly
                # an already-calculated base-grid node. Reuse it directly
                # instead of repeating the full acoustic calculation.
                if row_is_base and col_index % 2 == 0:
                    refined_row.append(base_matrix[base_row_index][col_index // 2])
                    continue

                lat_f = float(lat)
                lon_f = float(lon)
                base_col_f = col_index * (n - 1) / max(refined_n - 1, 1)

                px, py = latlon_to_xy(lat_f, lon_f, lat0, lon0)
                near_obstacle = any(
                    point_segment_distance(px, py, segment) <= refinement_radius_m
                    for segment in obstacle_segments
                )

                if near_obstacle:
                    # evaluate_grid_point performs the polygon/building masks,
                    # so avoid doing those checks twice here.
                    refined_row.append(evaluate_grid_point(lat_f, lon_f))
                    continue

                interpolated = bilinear_base(base_row_f, base_col_f)
                if interpolated is not None:
                    refined_row.append(interpolated)
                else:
                    refined_row.append(evaluate_grid_point(lat_f, lon_f))

            refined_matrix.append(refined_row)

        matrix = refined_matrix

    finite = [
        float(value)
        for row in matrix
        for value in row
        if value is not None and np.isfinite(value)
    ]

    receiver_results = []
    for receiver in payload.receivers:
        all_source_totals = []
        combined_band_levels = {str(b): [] for b in OCTAVE_BANDS}
        contribution_items = []
        receiver_ground = _terrain_elevation(
            terrain_samples, receiver.lat, receiver.lon, lat0, lon0
        )

        for source_input in all_sources:
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
                terrain_samples=terrain_samples,
                receiver_ground_elevation_m=receiver_ground,
                source_ground_elevation_m=source_ground_elevations.get(source_input.id),
                buildings=payload.buildings,
            )
            contribution_items.append((source_input, source_result))

            source_total = source_result.get("total_db")
            if source_total is not None and np.isfinite(source_total):
                all_source_totals.append(float(source_total))

            for band in OCTAVE_BANDS:
                band_value = source_result["bands_db"].get(str(band))
                if band_value is not None and np.isfinite(band_value):
                    combined_band_levels[str(band)].append(float(band_value))

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
            "contributions": _aggregate_contributions(contribution_items),
        })

    return CalculationResponse(
        bounds=[[south, west], [north, east]],
        levels=matrix,
        min_level=min(finite) if finite else None,
        max_level=max(finite) if finite else None,
        receiver_results=receiver_results,
    )
