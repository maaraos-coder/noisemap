"""Regression tests for facade-position checks and self-reflection suppression.

Scenarios are synthetic planar rectangles, not reference cases for
regulatory CNOSSOS-EU propagation.
"""
from dataclasses import replace
import math
import pytest

from backend.main import (
    RoadIn, BuildingIn, ReceiverIn, ReceiverPreviewRequest, GridSettings,
    facade_audit, FacadeAuditRequest, receiver_preview, _barriers_with_buildings,
)
from noise_app.facade_audit import facade_geometry_audit


# At latitude -33.45: around 0.00001 latitude = 1.11 m.
LAT=-33.45
LON=-70.65
# Facade south face is the road-facing wall.
BUILDING=[
    [LAT, LON],
    [LAT, LON+0.0002],
    [LAT+0.0001,LON+0.0002],
    [LAT+0.0001,LON]
]
ROAD=[
    [LAT-0.00012,LON-0.0001],
    [LAT-0.00012,LON+0.0003],
]


def road(**kwargs):
    return RoadIn(
        id="street",name="Pasaje",points=ROAD,
        q_light_vph=80,q_medium_vph=3,q_heavy_vph=1,
        **kwargs,
    )


def building(**kwargs):
    return BuildingIn(id="residence",name="Edificio",points=BUILDING,
                      height_m=20,reflection_percent=90,**kwargs)


def receiver(lat=LAT-0.0000009, lon=LON+0.0001, height=7):
    return ReceiverIn(id="room",name="Fachada exterior",lat=lat,
                      lon=lon,height_m=height)


def test_receiver_10cm_in_front_of_street_side():
    a=facade_geometry_audit(ROAD,BUILDING,receiver().lat,receiver().lon,7)
    assert a["valid_for_incident_facade_demo"]
    assert a["facade_edge_index"]==1
    assert abs(a["receiver_to_facade_m"]-0.10) < 0.02
    assert 10 < a["facade_to_road_m"] < 20
    assert a["receiver_street_side"]
    assert not a["receiver_inside_building"]


def test_receiver_inside_building_rejected():
    a=facade_geometry_audit(ROAD,BUILDING,LAT+0.00001,LON+0.0001,7)
    assert a["receiver_inside_building"]
    assert not a["valid_for_incident_facade_demo"]


def test_receptor_far_from_facade_rejected():
    a=facade_geometry_audit(ROAD,BUILDING,LAT-0.00005,LON+0.0001,7)
    assert not a["valid_for_incident_facade_demo"]
    assert a["receiver_to_facade_m"]>5


def test_receptor_behind_building_rejected():
    a=facade_geometry_audit(ROAD,BUILDING,LAT+0.0001009,LON+0.0001,7)
    assert not a["valid_for_incident_facade_demo"]
    assert not a["receiver_street_side"]


def test_façade_audit_endpoint_geometry():
    out=facade_audit(FacadeAuditRequest(road=road(),building=building(),
                                      receiver=receiver()))
    assert out["road_id"]=="street"
    assert out["building_id"]=="residence"


def test_incident_mode_retains_non_target_facades_reflections():
    from backend.main import _barriers_with_buildings
    b=_barriers_with_buildings([],[building()],None,LAT,LON)
    assert len(b)==4
    target=next(x for x in b if x.name=="Edificio · fachada 1")
    other=next(x for x in b if x.name=="Edificio · fachada 2")
    assert target.reflection_percent==90
    assert other.reflection_percent==90
    own=replace(target,reflection_percent=0.0)
    assert own.enabled and own.reflection_percent==0
    assert other.reflection_percent==90


def test_wrong_facade_selected_must_error():
    from fastapi import HTTPException
    payload=ReceiverPreviewRequest(
        roads=[road()],buildings=[building()],receiver=receiver(),
        settings=GridSettings(reflections_enabled=True),
        facade_exclude_building_id="residence",
        facade_exclude_edge_index=2,
    )
    with pytest.raises(HTTPException) as e:
        receiver_preview(payload)
    assert e.value.status_code == 422


def test_incident_prediction_not_greater_than_with_self_reflection():
    setting=GridSettings(reflections_enabled=True, ground_factor=0)
    standard=receiver_preview(ReceiverPreviewRequest(
        roads=[road()], buildings=[building()], receiver=receiver(),
        settings=setting
    ))
    incident=receiver_preview(ReceiverPreviewRequest(
        roads=[road()], buildings=[building()], receiver=receiver(),
        settings=setting,
        facade_exclude_building_id="residence",
        facade_exclude_edge_index=1
    ))
    assert standard["level_db"] is not None
    assert incident["level_db"] is not None
    assert standard["level_db"] >= incident["level_db"]-0.001
    assert standard["level_db"]-incident["level_db"] <= 10
