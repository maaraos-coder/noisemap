"""Regression tests for roadmap engine and explicitly nonnormative receiver previews."""
import math
import pytest
from noise_app.road_scenario import DEFAULT_TRAFFIC, lden


def test_lden_period_weighting():
    assert lden(60,55,50)==pytest.approx(60.0,abs=1e-10)


def test_emission_flow_scaling():
    pytest.importorskip("phonometry")
    from noise_app.cnossos_emission import calculate_road_emission
    base={"day":{"light":100,"medium":2,"heavy":1,"motorcycles":2},
          "evening":{"light":50,"medium":1,"heavy":0,"motorcycles":1},
          "night":{"light":10,"medium":0,"heavy":0,"motorcycles":1}}
    src=calculate_road_emission(base,50)
    doubled={k:{vehicle:2*count for vehicle,count in data.items()}
             for k,data in base.items()}
    dst=calculate_road_emission(doubled,50)
    assert dst["day"]["a_weighted_line_power_db_per_m"]-src["day"]["a_weighted_line_power_db_per_m"]==pytest.approx(10*math.log10(2),abs=1e-5)
    assert len(src["day"]["line_power_db_per_m"])==8


def test_illustrative_receiver_drops_with_distance(monkeypatch):
    from noise_app import road_receiver_demo as demo
    fixed={"day":{"line_power_db_per_m":[80.0]*8},
           "evening":{"line_power_db_per_m":[78.0]*8},
           "night":{"line_power_db_per_m":[74.0]*8}}
    monkeypatch.setattr(demo,"calculate_road_emission",lambda *args,**kwargs:fixed)
    closer=demo.illustrative_free_field_levels(DEFAULT_TRAFFIC,30,5,13)
    farther=demo.illustrative_free_field_levels(DEFAULT_TRAFFIC,30,50,13)
    assert closer["lden_dba"]>farther["lden_dba"]
    assert closer["method"].endswith("(NOT CNOSSOS-EU 2.5)")


def test_illustrative_grid_is_not_normative(monkeypatch):
    from noise_app import road_receiver_demo as demo
    fixed={key:{"line_power_db_per_m":[80.0]*8} for key in ("day","evening","night")}
    monkeypatch.setattr(demo,"calculate_road_emission",lambda *args,**kwargs:fixed)
    grid=demo.illustrative_lden_grid(DEFAULT_TRAFFIC,30,13,grid_size=30)
    assert grid["levels_dba"].shape==(30,30)
    assert "NOT CNOSSOS" in grid["status"]
    assert math.isfinite(float(grid["levels_dba"][0,0]))
