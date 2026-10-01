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

    def test_second_building_lateral_shift_is_continuous(self):
        lat0 = 0.0
        lon0 = 0.0

        def ll(x, y):
            lat, lon = xy_to_latlon(x, y, lat0, lon0)
            return [lat, lon]

        source = SourceIn(
            id="S1",
            name="Fuente",
            lat=ll(0, 0)[0],
            lon=ll(0, 0)[1],
            height_m=1.5,
            lw_db=100.0,
        )
        r_lat, r_lon = ll(35, 0)

        fixed = BuildingIn(
            id="B1",
            name="Edificio 1",
            points=[ll(8, -4), ll(12, -4), ll(12, 4), ll(8, 4)],
            height_m=8.0,
            enabled=True,
            reflection_percent=20.0,
        )

        values = []
        for offset in [0.0, 1.0, 2.0, 3.0, 4.0]:
            moved = BuildingIn(
                id="B2",
                name="Edificio 2",
                points=[
                    ll(20, -5 + offset),
                    ll(24, -5 + offset),
                    ll(24, 5 + offset),
                    ll(20, 5 + offset),
                ],
                height_m=10.0,
                enabled=True,
                reflection_percent=20.0,
            )
            attenuation = _buildings_diffraction_attenuation_db(
                source,
                r_lat,
                r_lon,
                1.5,
                [fixed, moved],
                500.0,
                lat0,
                lon0,
                None,
                0.0,
                0.0,
                20.0,
            )
            values.append(float(attenuation))

        print("compound-building lateral sweep:", values)
        self.assertTrue(all(math.isfinite(v) for v in values))
        self.assertTrue(all(0.0 <= v <= 20.0 for v in values))

        # While the direct S-R line still crosses both footprints, moving the
        # second building one metre at a time should not create a numerical
        # discontinuity. A 3 dB per metre guard is deliberately loose enough
        # to allow a real path switch but strict enough to catch cusps/jumps.
        step_changes = [abs(b - a) for a, b in zip(values, values[1:])]
        print("compound-building step changes:", step_changes)
        self.assertLessEqual(max(step_changes), 3.0)


    def test_second_building_moves_out_of_line_of_sight_smoothly(self):
        lat0 = 0.0
        lon0 = 0.0

        def ll(x, y):
            lat, lon = xy_to_latlon(x, y, lat0, lon0)
            return [lat, lon]

        source = SourceIn(
            id="S1",
            name="Fuente",
            lat=ll(0, 0)[0],
            lon=ll(0, 0)[1],
            height_m=1.5,
            lw_db=100.0,
        )
        r_lat, r_lon = ll(35, 0)

        fixed = BuildingIn(
            id="B1",
            name="Edificio 1",
            points=[ll(8, -4), ll(12, -4), ll(12, 4), ll(8, 4)],
            height_m=8.0,
            enabled=True,
            reflection_percent=20.0,
        )

        offsets = [0.0, 2.0, 4.0, 5.0, 5.5, 6.0, 6.5, 7.0, 8.0, 10.0]
        values = []

        for offset in offsets:
            moved = BuildingIn(
                id="B2",
                name="Edificio 2",
                points=[
                    ll(20, -5 + offset),
                    ll(24, -5 + offset),
                    ll(24, 5 + offset),
                    ll(20, 5 + offset),
                ],
                height_m=10.0,
                enabled=True,
                reflection_percent=20.0,
            )

            attenuation = _buildings_diffraction_attenuation_db(
                source,
                r_lat,
                r_lon,
                1.5,
                [fixed, moved],
                500.0,
                lat0,
                lon0,
                None,
                0.0,
                0.0,
                20.0,
            )
            values.append(float(attenuation))

        print("building exit sweep offsets:", offsets)
        print("building exit sweep attenuation:", values)

        self.assertTrue(all(math.isfinite(v) for v in values))
        self.assertTrue(all(0.0 <= v <= 20.0 for v in values))

        step_changes = [abs(b - a) for a, b in zip(values, values[1:])]
        print("building exit sweep step changes:", step_changes)

        # Near the geometric transition where the second footprint stops
        # intersecting the direct F-R line, the compound solver must not create
        # a large cusp. A 4 dB guard is intentionally permissive because a real
        # path family can disappear at the boundary.
        self.assertLessEqual(max(step_changes), 4.0)

        # Once B2 is clearly outside the direct S-R corridor, the result should
        # converge to the attenuation produced by B1 alone.
        single = _buildings_diffraction_attenuation_db(
            source,
            r_lat,
            r_lon,
            1.5,
            [fixed],
            500.0,
            lat0,
            lon0,
            None,
            0.0,
            0.0,
            20.0,
        )
        self.assertAlmostEqual(values[-1], float(single), places=6)


if __name__ == "__main__":
    unittest.main()
