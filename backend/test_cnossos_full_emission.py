"""CNOSSOS-EU §2.2 integration regression tests using phonometry.

These are source-emission tests only; the app's receiver propagation remains
educational and is not certified CNOSSOS-EU §2.5.
"""
import math
from types import SimpleNamespace

import numpy as np

from backend.main import RoadIn, _road_to_equivalent_sources
from noise_app.cnossos_adapter import line_emission_cnossos


def road(**patch):
    return RoadIn(
        id="a", name="Prueba", points=[[-33.45,-70.65],[-33.451,-70.65]],
        q_light_vph=300, q_medium_vph=20, q_heavy_vph=8,
        q_moped_vph=5, q_motorcycle_vph=12,
        **patch,
    )


def test_reference_surface_agrees_with_legacy_f1_at_reference_speed():
    from backend.main import _cnossos_road_line_spectrum
    r = road(road_two_way=False, speed_light_kmh=70, speed_medium_kmh=70,
             speed_heavy_kmh=70, speed_moped_kmh=70, speed_motorcycle_kmh=70)
    expected = _cnossos_road_line_spectrum(r, 20)
    actual = line_emission_cnossos(r, 20)
    np.testing.assert_allclose(actual, expected, atol=1e-8, rtol=0)


def test_pavement_changes_spectral_emission():
    a = line_emission_cnossos(road(), 20)
    b = line_emission_cnossos(road(road_surface="1-layer ZOAB"), 20)
    assert np.max(np.abs(a-b)) > 0.05


def test_incline_and_bidirectionality_change_emission():
    flat = line_emission_cnossos(road(), 20)
    steep_one_way = line_emission_cnossos(road(road_slope_percent=8, road_two_way=False), 20)
    steep_both = line_emission_cnossos(road(road_slope_percent=8, road_two_way=True), 20)
    assert np.max(np.abs(flat-steep_one_way)) > 0.1
    assert np.max(np.abs(steep_both-steep_one_way)) > 0.01


def test_junction_near_road_changes_emission():
    r = road(junction_type="crossing",junction_chainage_m=30)
    near = line_emission_cnossos(r, 20, 15)
    far = line_emission_cnossos(r, 20, 150)
    assert np.max(np.abs(near-far)) > 0.1


def test_studded_tyres_change_rolling_noise():
    r = road(studded_fraction=.5, studded_months=5)
    assert np.max(np.abs(line_emission_cnossos(r, 10)-line_emission_cnossos(road(), 10))) > 0.01


def test_segmentation_preserves_energy_of_line_in_reference_no_junction():
    r = road(road_two_way=False)
    spectrum = line_emission_cnossos(r, 20)
    segments = _road_to_equivalent_sources(r, 20)
    assert len(segments) > 2
    length = math.fsum(
        math.hypot((r.points[i+1][0]-r.points[i][0])*111132,
                   (r.points[i+1][1]-r.points[i][1])*111132*math.cos(math.radians(r.points[i][0])))
        for i in range(len(r.points)-1)
    )
    for freq in (63,500,8000):
        segment_total = 10*math.log10(sum(
            10**(seg.octave_levels[str(freq)]/10) for seg in segments
        ))
        assert abs(segment_total - (spectrum[(63,125,250,500,1000,2000,4000,8000).index(freq)]
                                      + 10*math.log10(length))) < .1


def test_noise_modelling_export_includes_all_periods_and_geometries():
    from io import BytesIO
    from zipfile import ZipFile
    import json
    from noise_app.noisemodelling_export import package_scenario
    from backend.main import ReceiverIn, BuildingIn, BarrierIn
    r=road()
    counts={
        "day":{"light":100,"medium":4,"heavy":1,"moped":5,"motorcycle":6},
        "evening":{"light":40,"medium":2,"heavy":0,"moped":1,"motorcycle":3},
        "night":{"light":5,"medium":0,"heavy":0,"moped":0,"motorcycle":2},
    }
    receiver=ReceiverIn(id="rec",name="Fachada",lat=-33.4505,lon=-70.6504,height_m=7)
    building=BuildingIn(id="b",name="Edificio",points=[
        [-33.45,-70.65],[-33.45,-70.6501],[-33.4501,-70.6501]
    ],height_m=12)
    barrier=BarrierIn(id="w",name="Pantalla",lat_a=-33.45,lon_a=-70.65,
                      lat_b=-33.4501,lon_b=-70.65,height_m=3)
    result=package_scenario(r,counts,[receiver],[building],[barrier],20)
    with ZipFile(BytesIO(result)) as z:
        assert len(z.namelist()) == 9
        for period in ("DAY","EVENING","NIGHT"):
            data=json.loads(z.read(f"LW_ROADS_{period}.geojson"))
            assert data["features"]
            assert all("LW63" in f["properties"] and "LW8000" in f["properties"]
                       for f in data["features"])
        assert len(json.loads(z.read("RECEIVERS.geojson"))["features"]) == 1
        assert len(json.loads(z.read("BUILDINGS.geojson"))["features"]) == 1
        assert len(json.loads(z.read("WALLS.geojson"))["features"]) == 1
        assert json.loads(z.read("scenario.json"))["normative_result"] is False
