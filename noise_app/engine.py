from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable
import math
import numpy as np

EARTH_RADIUS_M = 6_371_000.0
SPEED_OF_SOUND_M_S = 343.0


@dataclass
class Source:
    name: str
    lat: float
    lon: float
    height_m: float = 1.5
    lw_db: float = 100.0
    dc_db: float = 0.0
    enabled: bool = True
    ground_elevation_m: float = 0.0


@dataclass
class Receiver:
    name: str
    lat: float
    lon: float
    height_m: float = 1.5


@dataclass
class Barrier:
    name: str
    lat_a: float
    lon_a: float
    lat_b: float
    lon_b: float
    height_m: float = 3.0
    enabled: bool = True
    ground_elevation_m: float = 0.0


@dataclass
class PropagationSettings:
    alpha_db_per_km: float = 2.0
    frequency_hz: float = 500.0
    max_barrier_db: float = 20.0
    temperature_c: float = 15.0
    humidity_pct: float = 70.0
    ground_factor: float = 0.0


def latlon_to_xy(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Local tangent-plane approximation, adequate for small teaching maps."""
    lat_r = math.radians(lat)
    lat0_r = math.radians(lat0)
    dlat = math.radians(lat - lat0)
    dlon = math.radians(lon - lon0)
    x = EARTH_RADIUS_M * dlon * math.cos((lat_r + lat0_r) / 2.0)
    y = EARTH_RADIUS_M * dlat
    return x, y


def xy_to_latlon(x: float, y: float, lat0: float, lon0: float) -> tuple[float, float]:
    lat = lat0 + math.degrees(y / EARTH_RADIUS_M)
    lat_mid = math.radians((lat + lat0) / 2.0)
    lon = lon0 + math.degrees(x / (EARTH_RADIUS_M * max(math.cos(lat_mid), 1e-9)))
    return lat, lon


def geometric_divergence_db(distance_m: float) -> float:
    r = max(float(distance_m), 1.0)
    return 20.0 * math.log10(r) + 11.0


def atmospheric_absorption_db(distance_m: float, alpha_db_per_km: float) -> float:
    return max(0.0, float(alpha_db_per_km)) * max(0.0, float(distance_m)) / 1000.0


def ground_attenuation_db(
    distance_m: float,
    source_height_m: float,
    receiver_height_m: float,
    ground_factor: float,
) -> float:
    """Educational ISO 9613-2 alternative ground-effect approximation.

    G=0 represents acoustically hard ground and produces no ground attenuation.
    G=1 applies the porous-ground alternative expression. Intermediate G values
    interpolate linearly. This intentionally remains a simplified teaching
    model rather than the full octave-band source/middle/receiver-region method.
    """
    g = min(1.0, max(0.0, float(ground_factor)))
    if g <= 0.0:
        return 0.0

    d = max(float(distance_m), 1.0)
    hm = max(0.0, (float(source_height_m) + float(receiver_height_m)) / 2.0)
    porous = 4.8 - (2.0 * hm / d) * (17.0 + 300.0 / d)
    return g * max(0.0, min(4.8, porous))



def atmospheric_absorption_iso9613_db_per_m(
    frequency_hz: float,
    temperature_c: float = 15.0,
    humidity_pct: float = 70.0,
    pressure_kpa: float = 101.325,
) -> float:
    """
    Atmospheric absorption coefficient approximation based on ISO 9613-1
    relaxation-frequency equations, returned in dB/m.

    This supports frequency-dependent educational propagation. It does not
    replace formal validation against a certified implementation.
    """
    f = max(float(frequency_hz), 1.0)
    t = float(temperature_c) + 273.15
    t0 = 293.15
    t01 = 273.16
    p = max(float(pressure_kpa), 1e-6)
    p0 = 101.325
    rh = min(100.0, max(0.0, float(humidity_pct)))

    # Molar concentration of water vapour (ISO-style formulation).
    h = rh * (10.0 ** (-6.8346 * ((t01 / t) ** 1.261) + 4.6151)) * (p0 / p)

    fr_o = (p / p0) * (
        24.0 + 4.04e4 * h * (0.02 + h) / max(0.391 + h, 1e-12)
    )
    fr_n = (p / p0) * ((t / t0) ** -0.5) * (
        9.0
        + 280.0
        * h
        * math.exp(-4.17 * (((t / t0) ** (-1.0 / 3.0)) - 1.0))
    )

    classical = 1.84e-11 * (p0 / p) * math.sqrt(t / t0)
    oxygen = (
        0.01275
        * math.exp(-2239.1 / t)
        / max(fr_o + (f * f / max(fr_o, 1e-12)), 1e-12)
    )
    nitrogen = (
        0.1068
        * math.exp(-3352.0 / t)
        / max(fr_n + (f * f / max(fr_n, 1e-12)), 1e-12)
    )
    molecular = ((t / t0) ** -2.5) * (oxygen + nitrogen)

    alpha_np_per_m = (f * f) * (classical + molecular)
    return 8.686 * alpha_np_per_m


def energetic_sum_db(levels_db: Iterable[float]) -> float:
    vals = [float(v) for v in levels_db if np.isfinite(v)]
    if not vals:
        return float("-inf")
    m = max(vals)
    return m + 10.0 * math.log10(sum(10.0 ** ((v - m) / 10.0) for v in vals))


def _cross(ax: float, ay: float, bx: float, by: float) -> float:
    return ax * by - ay * bx


def segment_intersection(
    p1: tuple[float, float],
    p2: tuple[float, float],
    q1: tuple[float, float],
    q2: tuple[float, float],
) -> tuple[bool, float, float]:
    """Returns (intersects, t, u) for two planar segments."""
    rx, ry = p2[0] - p1[0], p2[1] - p1[1]
    sx, sy = q2[0] - q1[0], q2[1] - q1[1]
    den = _cross(rx, ry, sx, sy)
    if abs(den) < 1e-9:
        return False, math.nan, math.nan

    qpx, qpy = q1[0] - p1[0], q1[1] - p1[1]
    t = _cross(qpx, qpy, sx, sy) / den
    u = _cross(qpx, qpy, rx, ry) / den
    return (0.0 <= t <= 1.0 and 0.0 <= u <= 1.0), t, u


def barrier_attenuation_db(
    sx: float,
    sy: float,
    sz: float,
    rx: float,
    ry: float,
    rz: float,
    barrier: Barrier,
    lat0: float,
    lon0: float,
    frequency_hz: float = 500.0,
    max_barrier_db: float = 20.0,
) -> float:
    """
    Educational single-edge diffraction approximation.

    This is NOT the full ISO 9613-2 barrier algorithm.
    """
    ax, ay = latlon_to_xy(barrier.lat_a, barrier.lon_a, lat0, lon0)
    bx, by = latlon_to_xy(barrier.lat_b, barrier.lon_b, lat0, lon0)

    hit, t, _ = segment_intersection((sx, sy), (rx, ry), (ax, ay), (bx, by))
    if not hit:
        return 0.0

    ix = sx + t * (rx - sx)
    iy = sy + t * (ry - sy)
    los_z = sz + t * (rz - sz)
    barrier_top_z = barrier.ground_elevation_m + barrier.height_m

    if barrier_top_z <= los_z:
        return 0.0

    d1_h = math.hypot(ix - sx, iy - sy)
    d2_h = math.hypot(rx - ix, ry - iy)
    direct = math.sqrt((rx - sx) ** 2 + (ry - sy) ** 2 + (rz - sz) ** 2)
    via_top = (
        math.sqrt(d1_h**2 + (barrier_top_z - sz) ** 2)
        + math.sqrt(d2_h**2 + (barrier_top_z - rz) ** 2)
    )
    delta = max(0.0, via_top - direct)
    if delta <= 0:
        return 0.0

    wavelength = SPEED_OF_SOUND_M_S / max(float(frequency_hz), 1.0)
    fresnel_n = max(0.0, 2.0 * delta / wavelength)
    attenuation = 10.0 * math.log10(3.0 + 20.0 * fresnel_n)
    return min(max_barrier_db, max(0.0, attenuation))


def source_to_point_breakdown(
    source: Source,
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    barriers: list[Barrier],
    settings: PropagationSettings,
    lat0: float,
    lon0: float,
    receiver_ground_elevation_m: float = 0.0,
) -> dict[str, float]:
    sx, sy = latlon_to_xy(source.lat, source.lon, lat0, lon0)
    rx, ry = latlon_to_xy(receiver_lat, receiver_lon, lat0, lon0)

    source_z = source.ground_elevation_m + source.height_m
    receiver_z = receiver_ground_elevation_m + receiver_height_m

    distance_m = math.sqrt(
        (rx - sx) ** 2
        + (ry - sy) ** 2
        + (receiver_z - source_z) ** 2
    )
    distance_m = max(1.0, distance_m)

    a_div = geometric_divergence_db(distance_m)
    a_atm = atmospheric_absorption_db(distance_m, settings.alpha_db_per_km)

    barrier_losses = [
        barrier_attenuation_db(
            sx, sy, source_z,
            rx, ry, receiver_z,
            b, lat0, lon0,
            frequency_hz=settings.frequency_hz,
            max_barrier_db=settings.max_barrier_db,
        )
        for b in barriers
        if b.enabled
    ]
    a_bar = max(barrier_losses, default=0.0)
    a_gr = ground_attenuation_db(
        distance_m,
        source.height_m,
        receiver_height_m,
        settings.ground_factor,
    )

    lp = source.lw_db + source.dc_db - a_div - a_atm - a_gr - a_bar

    return {
        "distance_m": distance_m,
        "lw_db": source.lw_db,
        "dc_db": source.dc_db,
        "a_div_db": a_div,
        "a_atm_db": a_atm,
        "a_gr_db": a_gr,
        "a_bar_db": a_bar,
        "source_ground_elevation_m": source.ground_elevation_m,
        "receiver_ground_elevation_m": receiver_ground_elevation_m,
        "lp_db": lp,
    }


def level_at_point(
    sources: list[Source],
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    barriers: list[Barrier],
    settings: PropagationSettings,
    lat0: float,
    lon0: float,
    receiver_ground_elevation_m: float = 0.0,
) -> float:
    contributions = []
    for source in sources:
        if not source.enabled:
            continue
        result = source_to_point_breakdown(
            source,
            receiver_lat,
            receiver_lon,
            receiver_height_m,
            barriers,
            settings,
            lat0,
            lon0,
            receiver_ground_elevation_m=receiver_ground_elevation_m,
        )
        contributions.append(result["lp_db"])
    return energetic_sum_db(contributions)


def build_grid(
    center_lat: float,
    center_lon: float,
    half_size_m: float,
    points_per_side: int,
) -> list[tuple[float, float, float, float]]:
    points_per_side = int(max(10, min(points_per_side, 80)))
    coords = []
    for y in np.linspace(-half_size_m, half_size_m, points_per_side):
        for x in np.linspace(-half_size_m, half_size_m, points_per_side):
            lat, lon = xy_to_latlon(float(x), float(y), center_lat, center_lon)
            coords.append((lat, lon, float(x), float(y)))
    return coords


def polygon_bounds(polygon: list[list[float]]) -> tuple[float, float, float, float]:
    """Return south, west, north, east for [lat, lon] polygon vertices."""
    lats = [p[0] for p in polygon]
    lons = [p[1] for p in polygon]
    return min(lats), min(lons), max(lats), max(lons)


def point_in_polygon(lat: float, lon: float, polygon: list[list[float]]) -> bool:
    """Ray-casting inclusion test. Polygon vertices use [lat, lon]."""
    x = lon
    y = lat
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        if (yi > y) != (yj > y):
            denom = (yj - yi) if abs(yj - yi) > 1e-15 else 1e-15
            x_cross = (xj - xi) * (y - yi) / denom + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def build_grid_from_polygon(
    polygon: list[list[float]],
    points_per_side: int,
) -> tuple[list[tuple[float, float]], list[bool], tuple[float, float, float, float]]:
    """Create a regular lat/lon raster grid over a user-drawn polygon bounding box."""
    south, west, north, east = polygon_bounds(polygon)
    n = int(max(12, min(points_per_side, 90)))
    lats = np.linspace(south, north, n)
    lons = np.linspace(west, east, n)

    points: list[tuple[float, float]] = []
    mask: list[bool] = []
    for lat in lats:
        for lon in lons:
            latf, lonf = float(lat), float(lon)
            points.append((latf, lonf))
            mask.append(point_in_polygon(latf, lonf, polygon))
    return points, mask, (south, west, north, east)
