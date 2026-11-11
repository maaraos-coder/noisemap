"""Educational road receiver model: CNOSSOS-EU emission + simplified propagation.

This is NOT the section 2.5 CNOSSOS-EU propagation method. Used only
as a clearly marked preliminary free-field teaching estimate; it excludes
ground impedances, favorable/unfavorable meteorology, reflections, barriers,
diffraction and actual three-dimensional road/facade geometry.
"""
from __future__ import annotations
import math
from .cnossos_emission import calculate_road_emission, BANDS
from .road_scenario import lden

A_WEIGHT = (-26.2,-16.1,-8.6,-3.2,0.0,1.2,1.0,-1.1)
SOURCE_HEIGHT_M = 0.05

def illustrative_free_field_levels(
    traffic:dict, speed_kmh:float, horizontal_distance_m:float,
    receiver_height_m:float, road_length_m:float=250.0,
    element_length_m:float=5.0, slope_percent:float=0.0,
    temperature_c:float=20.0,
    surface:str="reference road surface"
)->dict:
    """Finite straight road, receptor opposite midpoint, all geometry in metres."""
    for label, value in {
        "horizontal_distance_m":horizontal_distance_m,
        "receiver_height_m":receiver_height_m,
        "road_length_m":road_length_m,
        "element_length_m":element_length_m}.items():
        if not math.isfinite(value) or value<=0:
            raise ValueError(f"{label}: debe ser positivo y finito")
    if road_length_m>10000 or element_length_m<1 or road_length_m/element_length_m>2000:
        raise ValueError("La discretización de la vía excede los límites docentes")
    emissions=calculate_road_emission(
        traffic,speed_kmh=speed_kmh,
        slope_percent=slope_percent,temperature_c=temperature_c,
        surface=surface)
    n=math.ceil(road_length_m/element_length_m)
    dx=road_length_m/n
    h=receiver_height_m-SOURCE_HEIGHT_M
    # Convert each line segment's sound power to far-field free-space pressure;
    # the source model includes its own reference road surface.
    distances=[math.sqrt(horizontal_distance_m**2+h**2+
                         ((i+0.5)*dx-road_length_m/2)**2)
               for i in range(n)]
    geometry=sum(dx/(4*math.pi*r*r) for r in distances)
    # Geometric transfer for 1pW re 20 microPa, far-field: -10log10(4*pi*r²).
    # Propagation is intentionally simplified; NOT the official CNOSSOS chain.
    attenuation=10*math.log10(geometry)
    period_levels={}
    band_levels={}
    for period,entry in emissions.items():
        src=entry["line_power_db_per_m"]
        if all(v is None for v in src):
            period_levels[period]=None
            band_levels[period]=[None]*len(BANDS)
            continue
        by_band=[float(v)+attenuation if v is not None else None for v in src]
        band_levels[period]=by_band
        power=sum(10**((v+w)/10) for v,w in zip(by_band,A_WEIGHT) if v is not None)
        period_levels[period]=10*math.log10(power) if power>0 else None
    if any(v is None for v in period_levels.values()):
        # A period without traffic has zero acoustic energy, not -infinity in JSON.
        # For finite Lden combination, omit its zero term.
        contributions=[
            (12,0,"day"),(4,5,"evening"),(8,10,"night")
        ]
        total=sum(hours*10**((period_levels[p]+penalty)/10)
                  for hours,penalty,p in contributions if period_levels[p] is not None)
        result_lden=10*math.log10(total/24) if total>0 else None
    else:
        result_lden=lden(period_levels["day"],period_levels["evening"],period_levels["night"])
    return {
        "method":"CNOSSOS-EU 2021 road-source emission + DIDACTIC free-field spreading (NOT CNOSSOS-EU 2.5)",
        "bands_hz":list(BANDS),
        "emission_per_m":emissions,
        "receiver_period_levels_dba":period_levels,
        "receiver_spectra_db":band_levels,
        "lden_dba":result_lden,
        "geometry":{"horizontal_distance_m":horizontal_distance_m,
                    "receiver_height_m":receiver_height_m,
                    "road_length_m":road_length_m,"segments":n},
        "omissions":["CNOSSOS propagation 2.5","ground effect","meteorology",
                     "buildings and reflections","diffraction/barriers",
                     "terrain and 3D road positioning","atmospheric absorption"],
    }


def illustrative_lden_grid(
    traffic:dict, speed_kmh:float, receiver_height_m:float,
    road_length_m:float=250.0, cross_road_extent_m:float=100.0,
    grid_size:int=45, element_length_m:float=5.0,
    slope_percent:float=0.0, temperature_c:float=20.0,
    surface:str="reference road surface"
)->dict:
    """Non-georeferenced illustrative Lden raster about a straight source line.

    x runs along the road, and y is distance perpendicular to it. This is a
    free-field classroom visualization, not CNOSSOS-EU section 2.5.
    """
    import numpy as np
    if not (20<=grid_size<=120):
        raise ValueError("La grilla debe tener entre 20 y 120 puntos por eje.")
    if road_length_m<=0 or cross_road_extent_m<=1 or receiver_height_m<=0:
        raise ValueError("Geometría inválida para grilla de calle.")
    emissions=calculate_road_emission(
        traffic,speed_kmh=speed_kmh,
        slope_percent=slope_percent,temperature_c=temperature_c,
        surface=surface)
    count=math.ceil(road_length_m/element_length_m)
    if count>1500:
        raise ValueError("Exceso de segmentos en la vía.")
    step=road_length_m/count
    xs=np.linspace(-road_length_m/2,road_length_m/2,grid_size)
    # Raster's first row is furthest from the road, for a clear map convention.
    ys=np.linspace(cross_road_extent_m,2.0,grid_size)
    X,Y=np.meshgrid(xs,ys)
    segment_x=(np.arange(count)+0.5)*step-road_length_m/2
    h=receiver_height_m-SOURCE_HEIGHT_M
    rsq=(X[:,:,None]-segment_x[None,None,:])**2+Y[:,:,None]**2+h*h
    geometric_transfer=np.sum(step/(4*math.pi*rsq),axis=2)
    period_levels={}
    for period,source in emissions.items():
        bands=source["line_power_db_per_m"]
        if all(val is None for val in bands):
            continue
        weighted_power=sum(10**((value+weight)/10)
                           for value,weight in zip(bands,A_WEIGHT)
                           if value is not None)
        if weighted_power>0:
            period_levels[period]=weighted_power*geometric_transfer
    total=np.zeros((grid_size,grid_size),dtype=float)
    for period,(hours,penalty) in {
        "day":(12,0),"evening":(4,5),"night":(8,10)}.items():
        if period in period_levels:
            total+=hours/24*10**(penalty/10)*period_levels[period]
    levels=np.where(total>0,10*np.log10(np.maximum(total,1e-20)),np.nan)
    return {
        "levels_dba":levels,"extent_x_m":(float(xs[0]),float(xs[-1])),
        "extent_y_m":(float(ys[-1]),float(ys[0])),
        "status":"Illustrative free-field CNOSSOS emission; NOT CNOSSOS propagation 2.5",
    }
