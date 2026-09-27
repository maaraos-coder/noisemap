from __future__ import annotations

import numpy as np
import folium
from branca.colormap import LinearColormap
from folium.plugins import Draw


NOISE_COLORS = [
    "#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d",
    "#ffff8c", "#f9d057", "#f29e2e", "#e76818", "#d7191c",
]


def level_colormap(vmin: float, vmax: float) -> LinearColormap:
    return LinearColormap(
        colors=NOISE_COLORS,
        vmin=vmin,
        vmax=vmax,
        caption="Nivel calculado [dB]",
    )


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _level_to_rgba(
    levels: np.ndarray,
    vmin: float,
    vmax: float,
    alpha: int = 175,
) -> np.ndarray:
    """Convert level matrix to a continuous RGBA raster."""
    levels = np.asarray(levels, dtype=float)
    h, w = levels.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    stops = np.linspace(vmin, vmax, len(NOISE_COLORS))
    colors = np.array([_hex_to_rgb(c) for c in NOISE_COLORS], dtype=float)

    flat = levels.ravel()
    valid = np.isfinite(flat)
    clipped = np.clip(flat[valid], vmin, vmax)

    channels = [np.interp(clipped, stops, colors[:, ch]) for ch in range(3)]
    rgb = np.stack(channels, axis=1).astype(np.uint8)

    out = rgba.reshape(-1, 4)
    out[valid, :3] = rgb
    out[valid, 3] = alpha
    return rgba


def rgba_from_grid(level_matrix, vmin, vmax, polygon_mask=None):
    rgba = _level_to_rgba(np.asarray(level_matrix, dtype=float), vmin, vmax)
    if polygon_mask is not None:
        mask = np.asarray(polygon_mask, dtype=bool)
        rgba[~mask, 3] = 0

    # Grid rows are created south -> north, while an image starts at north.
    return np.flipud(rgba)


def make_map(
    center_lat: float,
    center_lon: float,
    zoom: int,
    sources,
    receivers,
    barriers,
    raster=None,
    vmin: float = 35.0,
    vmax: float = 80.0,
    pending_barrier_start=None,
    calculation_polygon=None,
):
    m = folium.Map(
        location=[center_lat, center_lon],
        zoom_start=zoom,
        tiles="OpenStreetMap",
        control_scale=True,
        prefer_canvas=True,
    )

    # The user can draw the calculation area directly over the base map.
    Draw(
        export=False,
        position="topleft",
        draw_options={
            "polyline": False,
            "polygon": {
                "allowIntersection": False,
                "shapeOptions": {"weight": 3, "fillOpacity": 0.08},
            },
            "rectangle": {
                "shapeOptions": {"weight": 3, "fillOpacity": 0.08},
            },
            "circle": False,
            "marker": False,
            "circlemarker": False,
        },
        edit_options={"edit": False, "remove": False},
    ).add_to(m)

    cmap = level_colormap(vmin, vmax)

    # Continuous image overlay: unlike CircleMarkers, it stays visually continuous on zoom.
    if raster is not None:
        image = raster.get("rgba")
        bounds = raster.get("bounds")
        if image is not None and bounds is not None:
            folium.raster_layers.ImageOverlay(
                image=image,
                bounds=bounds,
                opacity=1.0,
                interactive=False,
                cross_origin=False,
                zindex=2,
                pixelated=False,
                name="Mapa de ruido",
            ).add_to(m)
            cmap.add_to(m)

    if calculation_polygon:
        folium.Polygon(
            locations=calculation_polygon,
            weight=3,
            fill=True,
            fill_opacity=0.03,
            tooltip="Área de cálculo",
            name="Área de cálculo",
        ).add_to(m)

    for b in barriers:
        if not b.enabled:
            continue
        folium.PolyLine(
            [[b.lat_a, b.lon_a], [b.lat_b, b.lon_b]],
            weight=6,
            opacity=0.95,
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
