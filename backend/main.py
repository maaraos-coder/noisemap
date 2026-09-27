from __future__ import annotations

from typing import List, Optional

import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from noise_app.engine import (
    Barrier,
    PropagationSettings,
    Source,
    level_at_point,
    point_in_polygon,
)


app = FastAPI(
    title="Noise Map Lab API",
    version="3.0.0",
    description="Motor acústico educativo para la interfaz React + MapLibre.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SourceIn(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    height_m: float = 1.5
    lw_db: float = 100.0
    dc_db: float = 0.0
    enabled: bool = True


class BarrierIn(BaseModel):
    id: str
    name: str
    lat_a: float
    lon_a: float
    lat_b: float
    lon_b: float
    height_m: float = 3.0
    enabled: bool = True


class GridSettings(BaseModel):
    resolution: int = Field(default=48, ge=18, le=100)
    receiver_height_m: float = Field(default=1.5, gt=0.0, le=50.0)
    alpha_db_per_km: float = Field(default=2.0, ge=0.0, le=50.0)
    frequency_hz: float = Field(default=500.0, ge=20.0, le=20000.0)
    vmin: float = 35.0
    vmax: float = 80.0


class CalculationRequest(BaseModel):
    sources: List[SourceIn]
    barriers: List[BarrierIn] = []
    polygon: List[List[float]]
    settings: GridSettings = GridSettings()


class CalculationResponse(BaseModel):
    bounds: List[List[float]]
    levels: List[List[Optional[float]]]
    min_level: Optional[float]
    max_level: Optional[float]


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "3.0.0"}


@app.post("/api/calculate", response_model=CalculationResponse)
def calculate(payload: CalculationRequest):
    polygon = payload.polygon
    if len(polygon) < 3:
        return CalculationResponse(
            bounds=[[-33.457, -70.649], [-33.456, -70.648]],
            levels=[],
            min_level=None,
            max_level=None,
        )

    lats = [p[0] for p in polygon]
    lons = [p[1] for p in polygon]
    south, north = min(lats), max(lats)
    west, east = min(lons), max(lons)

    n = payload.settings.resolution
    lat_values = np.linspace(south, north, n)
    lon_values = np.linspace(west, east, n)

    sources = [
        Source(
            name=s.name,
            lat=s.lat,
            lon=s.lon,
            height_m=s.height_m,
            lw_db=s.lw_db,
            dc_db=s.dc_db,
            enabled=s.enabled,
        )
        for s in payload.sources
    ]

    barriers = [
        Barrier(
            name=b.name,
            lat_a=b.lat_a,
            lon_a=b.lon_a,
            lat_b=b.lat_b,
            lon_b=b.lon_b,
            height_m=b.height_m,
            enabled=b.enabled,
        )
        for b in payload.barriers
    ]

    settings = PropagationSettings(
        alpha_db_per_km=payload.settings.alpha_db_per_km,
        frequency_hz=payload.settings.frequency_hz,
        max_barrier_db=20.0,
    )

    lat0 = sum(lats) / len(lats)
    lon0 = sum(lons) / len(lons)

    matrix: list[list[Optional[float]]] = []
    finite: list[float] = []

    # Returned north -> south so the browser can paint it directly to canvas.
    for lat in reversed(lat_values):
        row: list[Optional[float]] = []
        for lon in lon_values:
            lat_f = float(lat)
            lon_f = float(lon)

            if not point_in_polygon(lat_f, lon_f, polygon):
                row.append(None)
                continue

            level = level_at_point(
                sources,
                lat_f,
                lon_f,
                payload.settings.receiver_height_m,
                barriers,
                settings,
                lat0,
                lon0,
            )

            if np.isfinite(level):
                value = round(float(level), 3)
                finite.append(value)
                row.append(value)
            else:
                row.append(None)

        matrix.append(row)

    return CalculationResponse(
        bounds=[[south, west], [north, east]],
        levels=matrix,
        min_level=min(finite) if finite else None,
        max_level=max(finite) if finite else None,
    )
