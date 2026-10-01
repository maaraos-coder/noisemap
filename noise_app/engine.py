from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional
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
    reflection_percent: float = 0.0
    # Stand-alone barriers have acoustically free vertical ends. Building
    # facades meet adjacent facades, so their endpoints must not fade to 0 dB.
    free_end_a: bool = True
    free_end_b: bool = True
    diffraction_enabled: bool = True


@dataclass
class PropagationSettings:
    alpha_db_per_km: float = 2.0
    frequency_hz: float = 500.0
    max_barrier_db: float = 20.0
    temperature_c: float = 15.0
    humidity_pct: float = 70.0
    ground_factor: float = 0.0
    reflections_enabled: bool = False
    c0_db: float = 0.0


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


def meteorological_correction_db(
    horizontal_distance_m: float,
    source_height_m: float,
    receiver_height_m: float,
    c0_db: float,
) -> float:
    """Long-term meteorological correction Cmet."""
    dp = max(float(horizontal_distance_m), 0.0)
    hs = max(float(source_height_m), 0.0)
    hr = max(float(receiver_height_m), 0.0)
    c0 = max(float(c0_db), 0.0)
    limit = 10.0 * (hs + hr)
    if dp <= limit or dp <= 1e-9 or c0 <= 0.0:
        return 0.0
    return c0 * max(0.0, 1.0 - limit / dp)


def ground_attenuation_db(
    distance_m: float,
    source_height_m: float,
    receiver_height_m: float,
    ground_factor: float,
    frequency_hz: float = 500.0,
) -> float:
    """ISO 9613-2:2024 §7.3.1 general ground-effect method.

    A single ground factor G is currently used for source, middle and receiver
    regions. G=0 hard ground, G=1 porous ground, intermediate values mixed.
    """
    dp = max(float(distance_m), 1e-6)
    hs = max(float(source_height_m), 0.0)
    hr = max(float(receiver_height_m), 0.0)
    g = min(1.0, max(0.0, float(ground_factor)))

    # ISO nominal octave bands are used for the tabulated ground terms.
    bands = (63, 125, 250, 500, 1000, 2000, 4000, 8000)
    f = min(bands, key=lambda b: abs(math.log(max(float(frequency_hz), 1.0) / b)))

    def aprime(h: float) -> float:
        return (
            1.5
            + 3.0 * math.exp(-0.12 * (h - 5.0) ** 2) * (1.0 - math.exp(-dp / 50.0))
            + 5.7 * math.exp(-0.09 * h * h) * (1.0 - math.exp(-2.8e-6 * dp * dp))
        )

    def bprime(h: float) -> float:
        return 1.5 + 8.6 * math.exp(-0.09 * h * h) * (1.0 - math.exp(-dp / 50.0))

    def cprime(h: float) -> float:
        return 1.5 + 14.0 * math.exp(-0.46 * h * h) * (1.0 - math.exp(-dp / 50.0))

    def dprime(h: float) -> float:
        return 1.5 + 5.0 * math.exp(-0.9 * h * h) * (1.0 - math.exp(-dp / 50.0))

    def end_region(h: float) -> float:
        if f == 63:
            return -1.5
        if f == 125:
            return -1.5 + g * aprime(h)
        if f == 250:
            return -1.5 + g * bprime(h)
        if f == 500:
            return -1.5 + g * cprime(h)
        if f == 1000:
            return -1.5 + g * dprime(h)
        return -1.5 * (1.0 - g)

    q = 0.0
    if dp > 30.0 * (hs + hr):
        q = 1.0 - 30.0 * (hs + hr) / dp

    a_s = end_region(hs)
    a_r = end_region(hr)
    if f == 63:
        a_m = -3.0 * q
    else:
        a_m = -3.0 * q * (1.0 - g)

    a_prime = a_s + a_r + a_m

    # ISO 9613-2:2024 Formulae (11)-(13): geometry correction makes the
    # ground influence vanish for very short horizontal source-receiver spans.
    k_geo = (
        dp * dp + (hs - hr) ** 2
    ) / max(dp * dp + (hs + hr) ** 2, 1e-12)
    energy_factor = 1.0 + (10.0 ** (-a_prime / 10.0) - 1.0) * k_geo
    return -10.0 * math.log10(max(energy_factor, 1e-12))


def iso9613_2024_diffraction_dz_db(
    path_difference_m: float,
    d_source_edge_m: float,
    d_edge_receiver_m: float,
    direct_distance_m: float,
    frequency_hz: float,
    *,
    lateral: bool = False,
    c2: float = 20.0,
    c3: float = 1.0,
    e_m: float = 0.0,
    max_db: float = 20.0,
) -> float:
    """ISO 9613-2:2024 §7.4.1 barrier attenuation Dz, Formulae (18)-(21)."""
    wavelength = SPEED_OF_SOUND_M_S / max(float(frequency_hz), 1.0)
    z = float(path_difference_m)
    z_min = -2.0 * wavelength / max(c2 * c3, 1e-12)
    if z <= z_min:
        return 0.0

    if lateral:
        k_met = 1.0
    else:
        denom = max(2.0 * (z - z_min), 1e-12)
        geometric = (
            (max(float(d_source_edge_m), float(d_edge_receiver_m)) + max(float(e_m), 0.0))
            * min(float(d_source_edge_m), float(d_edge_receiver_m))
            * max(float(direct_distance_m), 0.0)
            / denom
        )
        k_met = math.exp(-(1.0 / 2000.0) * math.sqrt(max(geometric, 0.0)))

    argument = 1.0 + (2.0 + (c2 / wavelength) * c3 * z) * k_met
    dz = 10.0 * math.log10(max(argument, 1.0))
    return min(float(max_db), max(0.0, dz))


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


def first_order_reflection_level_db(
    source: Source,
    receiver_lat: float,
    receiver_lon: float,
    receiver_height_m: float,
    barrier: Barrier,
    settings: PropagationSettings,
    lat0: float,
    lon0: float,
    receiver_ground_elevation_m: float = 0.0,
    all_barriers: Optional[list[Barrier]] = None,
) -> float:
    """Single specular reflection from a vertical finite barrier using image-source geometry."""
    if not barrier.enabled or barrier.reflection_percent <= 0.0:
        return float("-inf")

    sx, sy = latlon_to_xy(source.lat, source.lon, lat0, lon0)
    rx, ry = latlon_to_xy(receiver_lat, receiver_lon, lat0, lon0)
    ax, ay = latlon_to_xy(barrier.lat_a, barrier.lon_a, lat0, lon0)
    bx, by = latlon_to_xy(barrier.lat_b, barrier.lon_b, lat0, lon0)

    wx, wy = bx - ax, by - ay
    wall_len2 = wx * wx + wy * wy
    if wall_len2 < 1e-9:
        return float("-inf")

    # Source and receiver must be on the same side of the reflecting plane.
    side_s = _cross(wx, wy, sx - ax, sy - ay)
    side_r = _cross(wx, wy, rx - ax, ry - ay)
    if side_s * side_r <= 0.0:
        return float("-inf")

    # Mirror source across the infinite line containing the barrier.
    tproj = ((sx - ax) * wx + (sy - ay) * wy) / wall_len2
    px, py = ax + tproj * wx, ay + tproj * wy
    isx, isy = 2.0 * px - sx, 2.0 * py - sy

    hit, t_img, u_wall = segment_intersection(
        (isx, isy), (rx, ry), (ax, ay), (bx, by)
    )
    if not hit or not (0.0 <= u_wall <= 1.0):
        return float("-inf")

    source_z = source.ground_elevation_m + source.height_m
    receiver_z = receiver_ground_elevation_m + receiver_height_m
    reflection_z = source_z + t_img * (receiver_z - source_z)
    barrier_bottom_z = barrier.ground_elevation_m
    barrier_top_z = barrier_bottom_z + barrier.height_m
    if reflection_z < barrier_bottom_z or reflection_z > barrier_top_z:
        return float("-inf")

    reflection_x = isx + t_img * (rx - isx)
    reflection_y = isy + t_img * (ry - isy)

    def leg_blocked(x1, y1, z1, x2, y2, z2) -> bool:
        for other in (all_barriers or []):
            if not other.enabled or other is barrier:
                continue
            oa = latlon_to_xy(other.lat_a, other.lon_a, lat0, lon0)
            ob = latlon_to_xy(other.lat_b, other.lon_b, lat0, lon0)
            hit_other, t_other, _ = segment_intersection((x1, y1), (x2, y2), oa, ob)
            if not hit_other or t_other <= 1e-6 or t_other >= 1.0 - 1e-6:
                continue
            z_los = z1 + t_other * (z2 - z1)
            other_bottom = other.ground_elevation_m
            other_top = other_bottom + other.height_m
            if other_bottom <= z_los <= other_top:
                return True
        return False

    if leg_blocked(sx, sy, source_z, reflection_x, reflection_y, reflection_z):
        return float("-inf")
    if leg_blocked(reflection_x, reflection_y, reflection_z, rx, ry, receiver_z):
        return float("-inf")

    reflected_horizontal = math.hypot(rx - isx, ry - isy)
    reflected_distance = math.sqrt(
        reflected_horizontal ** 2 + (receiver_z - source_z) ** 2
    )
    reflected_distance = max(1.0, reflected_distance)

    a_div = geometric_divergence_db(reflected_distance)
    a_atm = atmospheric_absorption_db(reflected_distance, settings.alpha_db_per_km)
    a_gr = ground_attenuation_db(
        reflected_horizontal,
        source.height_m,
        receiver_height_m,
        settings.ground_factor,
        settings.frequency_hz,
    )
    c_met = meteorological_correction_db(
        reflected_horizontal,
        source.height_m,
        receiver_height_m,
        settings.c0_db,
    )
    reflection_fraction = min(1.0, max(1e-6, barrier.reflection_percent / 100.0))
    reflection_loss_db = -10.0 * math.log10(reflection_fraction)

    return source.lw_db + source.dc_db - a_div - a_atm - a_gr - c_met - reflection_loss_db


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
    ground_attenuation_db_value: float = 0.0,
) -> float:
    """ISO 9613-2:2024 §7.4 finite single-barrier screening.

    Top diffraction uses the 2024 Dz and Kmet formulation. Lateral diffraction
    around both vertical ends uses Kmet=1 and the three paths are combined
    energetically according to Formula (25).
    """
    ax, ay = latlon_to_xy(barrier.lat_a, barrier.lon_a, lat0, lon0)
    bx, by = latlon_to_xy(barrier.lat_b, barrier.lon_b, lat0, lon0)

    vx, vy = rx - sx, ry - sy
    wx, wy = bx - ax, by - ay
    wall_length = math.hypot(wx, wy)
    if wall_length < 1e-9:
        return 0.0

    den = _cross(vx, vy, wx, wy)
    if abs(den) < 1e-9:
        return 0.0

    qx, qy = ax - sx, ay - sy
    t = _cross(qx, qy, wx, wy) / den
    u = _cross(qx, qy, vx, vy) / den
    if t <= 0.0 or t >= 1.0:
        return 0.0

    ix = sx + t * vx
    iy = sy + t * vy
    los_z = sz + t * (rz - sz)
    barrier_top_z = barrier.ground_elevation_m + barrier.height_m
    if barrier_top_z <= los_z:
        return 0.0

    direct = math.sqrt(vx * vx + vy * vy + (rz - sz) ** 2)

    # Vertical-plane path over the top edge.
    dss_top = math.sqrt((ix - sx) ** 2 + (iy - sy) ** 2 + (barrier_top_z - sz) ** 2)
    dsr_top = math.sqrt((rx - ix) ** 2 + (ry - iy) ** 2 + (rz - barrier_top_z) ** 2)
    z_top = dss_top + dsr_top - direct
    dz_top = iso9613_2024_diffraction_dz_db(
        z_top, dss_top, dsr_top, direct, frequency_hz,
        lateral=False, max_db=max_barrier_db,
    )
    # Formula (16)/(17): positive ground attenuation is replaced by top-edge
    # screening, while negative ground effect is not subtracted.
    a_top = max(0.0, dz_top - max(float(ground_attenuation_db_value), 0.0))

    # ISO lateral paths around the two vertical end edges. At lateral edges
    # Kmet=1. A side path is relevant when it is longer than the direct path.
    edge_z = min(max(los_z, barrier.ground_elevation_m), barrier_top_z)

    def side_attenuation(ex: float, ey: float) -> float:
        dss = math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2 + (edge_z - sz) ** 2)
        dsr = math.sqrt((rx - ex) ** 2 + (ry - ey) ** 2 + (rz - edge_z) ** 2)
        z_side = dss + dsr - direct
        if z_side <= 0.0:
            return 0.0
        return iso9613_2024_diffraction_dz_db(
            z_side, dss, dsr, direct, frequency_hz,
            lateral=True, max_db=max_barrier_db,
        )

    a_side1 = side_attenuation(ax, ay)
    a_side2 = side_attenuation(bx, by)

    # ISO 9613-2:2024 §7.4.3 relevance criterion:
    # a lateral path is neglected when the maximum lateral deviation of its
    # supporting point from the direct S-R line exceeds 8 times the maximum
    # vertical deviation of the top-path supporting point.
    horizontal_direct = math.hypot(vx, vy)
    vertical_deviation = max(0.0, barrier_top_z - los_z)

    def lateral_deviation(ex: float, ey: float) -> float:
        if horizontal_direct <= 1e-9:
            return 0.0
        return abs(_cross(vx, vy, ex - sx, ey - sy)) / horizontal_direct

    lateral_limit = 8.0 * vertical_deviation
    side1_relevant = lateral_deviation(ax, ay) <= lateral_limit + 1e-9
    side2_relevant = lateral_deviation(bx, by) <= lateral_limit + 1e-9

    # Outside the projected finite barrier the direct line of sight is not
    # screened by this barrier.
    if u < 0.0 or u > 1.0:
        return 0.0

    energies = [10.0 ** (-a_top / 10.0)]
    if side1_relevant:
        energies.append(10.0 ** (-a_side1 / 10.0))
    if side2_relevant:
        energies.append(10.0 ** (-a_side2 / 10.0))

    a_bar = -10.0 * math.log10(max(sum(energies), 1e-12))
    return min(float(max_barrier_db), max(0.0, a_bar))


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

    a_gr = ground_attenuation_db(
        math.hypot(rx - sx, ry - sy),
        source.height_m,
        receiver_height_m,
        settings.ground_factor,
        settings.frequency_hz,
    )
    barrier_losses = [
        barrier_attenuation_db(
            sx, sy, source_z,
            rx, ry, receiver_z,
            b, lat0, lon0,
            frequency_hz=settings.frequency_hz,
            max_barrier_db=settings.max_barrier_db,
            ground_attenuation_db_value=a_gr,
        )
        for b in barriers
        if b.enabled and getattr(b, "diffraction_enabled", True)
    ]
    a_bar = max(barrier_losses, default=0.0)

    lp_direct = source.lw_db + source.dc_db - a_div - a_atm - a_gr - a_bar

    reflected_levels = []
    if settings.reflections_enabled:
        reflected_levels = [
            first_order_reflection_level_db(
                source,
                receiver_lat,
                receiver_lon,
                receiver_height_m,
                b,
                settings,
                lat0,
                lon0,
                receiver_ground_elevation_m=receiver_ground_elevation_m,
            )
            for b in barriers
            if b.enabled and b.reflection_percent > 0.0
        ]
    finite_reflections = [v for v in reflected_levels if np.isfinite(v)]
    lp_reflected = energetic_sum_db(finite_reflections) if finite_reflections else float("-inf")
    lp = energetic_sum_db([lp_direct] + finite_reflections)

    return {
        "distance_m": distance_m,
        "lw_db": source.lw_db,
        "dc_db": source.dc_db,
        "a_div_db": a_div,
        "a_atm_db": a_atm,
        "a_gr_db": a_gr,
        "a_bar_db": a_bar,
        "lp_direct_db": lp_direct,
        "lp_reflected_db": lp_reflected,
        "reflection_count": len(finite_reflections),
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
