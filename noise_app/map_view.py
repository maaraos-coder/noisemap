from __future__ import annotations

import math
import folium
from branca.colormap import LinearColormap


def level_colormap(vmin: float, vmax: float) -> LinearColormap:
    # Conventional noise-map style palette.
    return LinearColormap(
        colors=["#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d",
                "#ffff8c", "#f9d057", "#f29e2e", "#e76818", "#d7191c"],
        vmin=vmin,
        vmax=vmax,
        caption="Nivel calculado [dB]",
    )


def make_map(
    center_lat: float,
    center_lon: float,
    zoom: int,
    sources,
    receivers,
    barriers,
    grid_results=None,
    vmin: float = 35.0,
    vmax: float = 80.0,
    pending_barrier_start=None,
):
    m = folium.Map(
        location=[center_lat, center_lon],
        zoom_start=zoom,
        tiles="OpenStreetMap",
        control_scale=True,
        prefer_canvas=True,
    )

    cmap = level_colormap(vmin, vmax)

    if grid_results:
        for item in grid_results:
            level = item["level_db"]
            if not math.isfinite(level):
                continue
            folium.CircleMarker(
                location=[item["lat"], item["lon"]],
                radius=7,
                stroke=False,
                fill=True,
                fill_opacity=0.56,
                fill_color=cmap(level),
                tooltip=f"{level:.1f} dB",
            ).add_to(m)
        cmap.add_to(m)

    for b in barriers:
        if not b.enabled:
            continue
        folium.PolyLine(
            [[b.lat_a, b.lon_a], [b.lat_b, b.lon_b]],
            weight=6,
            opacity=0.9,
            tooltip=f"{b.name} · h={b.height_m:.1f} m",
        ).add_to(m)

    if pending_barrier_start:
        folium.CircleMarker(
            location=[pending_barrier_start["lat"], pending_barrier_start["lon"]],
            radius=7,
            tooltip="Inicio de barrera: seleccione el segundo punto",
        ).add_to(m)

    for s in sources:
        if not s.enabled:
            continue
        folium.Marker(
            [s.lat, s.lon],
            popup=(
                f"<b>{s.name}</b><br>"
                f"Lw={s.lw_db:.1f} dB<br>"
                f"h={s.height_m:.1f} m<br>"
                f"Dc={s.dc_db:+.1f} dB"
            ),
            tooltip=f"🔊 {s.name}",
            icon=folium.Icon(icon="volume-up", prefix="fa"),
        ).add_to(m)

    for r in receivers:
        folium.Marker(
            [r.lat, r.lon],
            popup=f"<b>{r.name}</b><br>h={r.height_m:.1f} m",
            tooltip=f"📍 {r.name}",
            icon=folium.Icon(icon="home", prefix="fa"),
        ).add_to(m)

    folium.LayerControl().add_to(m)
    return m
