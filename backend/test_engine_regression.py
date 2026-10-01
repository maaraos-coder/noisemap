import math
import unittest

from noise_app.engine import (
    Barrier,
    geometric_divergence_db,
    meteorological_correction_db,
    multiple_barrier_attenuation_db,
    xy_to_latlon,
)

from backend.main import BuildingIn, SourceIn, _buildings_diffraction_attenuation_db

class EngineRegressionTests(unittest.TestCase):
    def test_geometric_divergence_at_10_m(self):
        self.assertAlmostEqual(geometric_divergence_db(10.0), 31.0, places=6)

    def test_cmet_zero_inside_near_field(self):
        self.assertEqual(
            meteorological_correction_db(20.0, 1.5, 1.5, 3.0),
            0.0,
        )

    def test_cmet_long_term_distance(self):
        value = meteorological_correction_db(100.0, 1.5, 1.5, 3.0)
        self.assertAlmostEqual(value, 2.1, places=6)

    def test_compound_two_screen_path_is_finite(self):
        lat0 = 0.0
        lon0 = 0.0
        a1_lat, a1_lon = xy_to_latlon(10.0, -5.0, lat0, lon0)
        b1_lat, b1_lon = xy_to_latlon(10.0, 5.0, lat0, lon0)
        a2_lat, a2_lon = xy_to_latlon(20.0, -5.0, lat0, lon0)
        b2_lat, b2_lon = xy_to_latlon(20.0, 5.0, lat0, lon0)

        barriers = [
            Barrier("B1", a1_lat, a1_lon, b1_lat, b1_lon, height_m=3.0),
            Barrier("B2", a2_lat, a2_lon, b2_lat, b2_lon, height_m=3.0),
        ]

        attenuation = multiple_barrier_attenuation_db(
            0.0, 0.0, 1.5,
            30.0, 0.0, 1.5,
            barriers,
            lat0, lon0,
            frequency_hz=500.0,
            max_barrier_db=20.0,
            ground_attenuation_db_value=0.0,
        )

        self.assertTrue(math.isfinite(attenuation))
        self.assertGreater(attenuation, 0.0)
        self.assertLessEqual(attenuation, 20.0)


    def test_compound_two_building_path_is_finite(self):
        lat0 = 0.0
        lon0 = 0.0

        def ll(x, y):
            lat, lon = xy_to_latlon(x, y, lat0, lon0)
            return [lat, lon]

        buildings = [
            BuildingIn(
                id="B1",
                name="Edificio 1",
                points=[ll(8, -4), ll(12, -4), ll(12, 4), ll(8, 4)],
                height_m=8.0,
                enabled=True,
                reflection_percent=20.0,
            ),
            BuildingIn(
                id="B2",
                name="Edificio 2",
                points=[ll(18, -5), ll(22, -5), ll(22, 5), ll(18, 5)],
                height_m=10.0,
                enabled=True,
                reflection_percent=20.0,
            ),
        ]
        source = SourceIn(
            id="S1",
            name="Fuente",
            lat=ll(0, 0)[0],
            lon=ll(0, 0)[1],
            height_m=1.5,
            lw_db=100.0,
        )
        r_lat, r_lon = ll(30, 0)

        attenuation = _buildings_diffraction_attenuation_db(
            source,
            r_lat,
            r_lon,
            1.5,
            buildings,
            500.0,
            lat0,
            lon0,
            None,
            0.0,
            0.0,
            20.0,
        )

        self.assertTrue(math.isfinite(attenuation))
        self.assertGreater(attenuation, 0.0)
        self.assertLessEqual(attenuation, 20.0)

if __name__ == "__main__":
    unittest.main()
