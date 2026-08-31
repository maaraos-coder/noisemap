import math

from noise_app.engine import (
    Source,
    Receiver,
    Barrier,
    PropagationSettings,
    energetic_sum_db,
    geometric_divergence_db,
    level_at_point,
)


def test_decibel_sum_equal_levels():
    value = energetic_sum_db([60.0, 60.0])
    assert abs(value - 63.0103) < 0.01


def test_geometric_divergence_10m():
    value = geometric_divergence_db(10.0)
    assert abs(value - 31.0) < 0.01


def test_level_decreases_with_distance():
    settings = PropagationSettings(alpha_db_per_km=0.0)
    src = Source("S", -33.45, -70.65, lw_db=100.0)

    near = Receiver("R1", -33.45, -70.6499)
    far = Receiver("R2", -33.45, -70.6490)

    lat0, lon0 = -33.45, -70.65

    l1 = level_at_point([src], near.lat, near.lon, near.height_m, [], settings, lat0, lon0)
    l2 = level_at_point([src], far.lat, far.lon, far.height_m, [], settings, lat0, lon0)

    assert l1 > l2
