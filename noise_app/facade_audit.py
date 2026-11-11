"""Geometry checks for educational facade Lden scenarios.

All input positions are [latitude, longitude] WGS84; local tangent plane
approximation is used for short (building scale) distances. This is not a
normative CNOSSOS-EU receiver-position validation engine.
"""
from __future__ import annotations

import math

M_PER_DEG_LAT=111132.92


def _xy(lat, lon, lat0, lon0):
    return ((lon-lon0)*111320*math.cos(math.radians(lat0)),
            (lat-lat0)*M_PER_DEG_LAT)


def _closest(p,a,b):
    vx=b[0]-a[0]
    vy=b[1]-a[1]
    denom=vx*vx+vy*vy
    t=max(0.0,min(1.0,((p[0]-a[0])*vx+(p[1]-a[1])*vy)/denom)) if denom>1e-12 else 0.0
    foot=(a[0]+t*vx,a[1]+t*vy)
    return math.hypot(p[0]-foot[0],p[1]-foot[1]),foot,t


def _inside(point,vertices):
    # Ray crossing, independent of ring winding.
    inside=False
    for a,b in zip(vertices,vertices[1:]+vertices[:1]):
        if (a[1]>point[1]) != (b[1]>point[1]):
            x=(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]
            if x>point[0]:
                inside=not inside
    return inside


def facade_geometry_audit(road_points, building_points, receiver_lat,receiver_lon,
                          receiver_height_m, offset_min_m=0.05, offset_max_m=2.0):
    """Identify nearest wall, closest road, and street-side receiver.

    A chosen point is invalid as a facade receptor if inside the building,
    or if the road is on the opposite side of the candidate facade.
    The recommended 0.1 m offset is not an enforced regulatory claim.
    """
    if len(road_points)<2 or len(building_points)<3:
        raise ValueError("Se requiere calle y edificio con geometrías suficientes.")
    lat0=receiver_lat
    lon0=receiver_lon
    r=(0.0,0.0)
    vertices=[_xy(float(p[0]),float(p[1]),lat0,lon0) for p in building_points]
    # A closing duplicate must not create a spurious 0-length wall.
    if math.hypot(vertices[0][0]-vertices[-1][0],vertices[0][1]-vertices[-1][1])<0.01:
        vertices=vertices[:-1]
    if len(vertices)<3:
        raise ValueError("Polígono de edificio no válido.")
    street=[_xy(float(p[0]),float(p[1]),lat0,lon0) for p in road_points]
    edges=[]
    for i,(a,b) in enumerate(zip(vertices,vertices[1:]+vertices[:1]),start=1):
        if math.dist(a,b)<0.01:
            continue
        dist,foot,t=_closest(r,a,b)
        edges.append((dist,i,a,b,foot,t))
    if not edges:
        raise ValueError("Edificio sin fachadas válidas.")
    distance,index,a,b,foot,t=min(edges,key=lambda e:e[0])
    # Which street segment is nearest to the projection on the facade?
    nearest_road=min((_closest(foot,x,y)[0],_closest(foot,x,y)[1])
                      for x,y in zip(street,street[1:]) if math.dist(x,y)>=0.01)
    road_distance,road_foot=nearest_road
    ex=b[0]-a[0]
    ey=b[1]-a[1]
    # Cross product sign determines the half-plane on a wall's infinite line.
    cross_receiver=ex*(r[1]-a[1])-ey*(r[0]-a[0])
    cross_road=ex*(road_foot[1]-a[1])-ey*(road_foot[0]-a[0])
    inside=_inside(r,vertices)
    street_side=(cross_receiver*cross_road>1e-6)
    near_edge=(0.02<=t<=0.98)
    valid_offset=offset_min_m<=distance<=offset_max_m
    altitude_ok=0.5<=float(receiver_height_m)<=150
    warnings=[]
    if inside:
        warnings.append("El receptor está dentro del polígono del edificio.")
    if not street_side:
        warnings.append("El receptor no está al mismo lado de la fachada que la calle.")
    if not valid_offset:
        warnings.append("Distancia receptor-fachada fuera de 0,05–2 m; para ejercicios de exposición considera 0,1 m.")
    if not near_edge:
        warnings.append("El receptor está cerca de una esquina: posibles efectos de difracción o fachada adyacente.")
    if not altitude_ok:
        warnings.append("Verifica la altura de receptor sobre el terreno.")
    return {
        "facade_edge_index":index,
        "receiver_to_facade_m":round(distance,3),
        "facade_to_road_m":round(road_distance,3),
        "receiver_height_m":round(float(receiver_height_m),3),
        "receiver_inside_building":inside,
        "receiver_street_side":street_side,
        "facade_projection_fraction":round(t,3),
        "valid_for_incident_facade_demo":bool(not inside and street_side and valid_offset and near_edge and altitude_ok),
        "warnings":warnings,
        "method":"Proyección local horizontal y segmento de fachada más cercano; diagnóstico académico."
    }
