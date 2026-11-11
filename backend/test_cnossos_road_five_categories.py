"""Regression checks for CNOSSOS-EU emission categories 4a and 4b.

Values from Appendix F, Table F-1 (EU 2021/1226). This validates emission
only; it does NOT validate CNOSSOS-EU propagation section 2.5.
"""
import math

import numpy as np
from backend.main import (
    CNOSSOS_ROAD_F1,
    RoadIn,
    _cnossos_vehicle_spectrum,
    _cnossos_road_line_spectrum,
)


def test_moped_and_motorcycle_use_only_propulsion():
    for category in ("4a", "4b"):
        coefficients = CNOSSOS_ROAD_F1[category]
        speed = 70
        actual = _cnossos_vehicle_spectrum(category, speed, 20)
        np.testing.assert_allclose(actual, coefficients[2], rtol=0, atol=1e-10)


def test_motorcycle_flow_adds_three_db_when_doubled():
    def spectrum(flow):
        road = RoadIn(
            id="moto", name="Moto", points=[[-33.45, -70.65], [-33.451, -70.65]],
            q_light_vph=0, q_medium_vph=0, q_heavy_vph=0,
            q_moped_vph=0, q_motorcycle_vph=flow,
            speed_motorcycle_kmh=70,
        )
        return _cnossos_road_line_spectrum(road, 20)
    np.testing.assert_allclose(
        spectrum(20) - spectrum(10),
        10 * math.log10(2), rtol=0, atol=1e-10,
    )


def test_all_five_categories_contribute_by_energy():
    base = dict(id="mixed", name="Mixed",
                points=[[-33.45, -70.65], [-33.451, -70.65]])
    all_flows = dict(q_light_vph=100, q_medium_vph=10,
                     q_heavy_vph=5, q_moped_vph=12, q_motorcycle_vph=8)
    combined = _cnossos_road_line_spectrum(RoadIn(**base, **all_flows), 20)
    single = []
    for key, value in all_flows.items():
        single.append(_cnossos_road_line_spectrum(
            RoadIn(**base, **{key: value},
                   speed_light_kmh=70, speed_medium_kmh=70,
                   speed_heavy_kmh=70, speed_moped_kmh=70,
                   speed_motorcycle_kmh=70),
            20))
    combined_at_70 = _cnossos_road_line_spectrum(
        RoadIn(**base, **all_flows,
               speed_light_kmh=70, speed_medium_kmh=70,
               speed_heavy_kmh=70, speed_moped_kmh=70,
               speed_motorcycle_kmh=70), 20)
    expected = 10 * np.log10(np.sum(10**(np.array(single)/10), axis=0))
    np.testing.assert_allclose(combined_at_70, expected, rtol=0, atol=1e-10)
    assert np.all(np.isfinite(combined))


def test_zero_traffic_does_not_create_sound():
    road = RoadIn(id="zero", name="zero",
                  points=[[-33.45,-70.65],[-33.451,-70.65]],
                  q_light_vph=0, q_medium_vph=0, q_heavy_vph=0,
                  q_moped_vph=0, q_motorcycle_vph=0)
    assert np.all(np.isneginf(_cnossos_road_line_spectrum(road, 20)))
