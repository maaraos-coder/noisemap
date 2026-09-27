from __future__ import annotations

import hashlib
import json
import math

import numpy as np
import pandas as pd
import streamlit as st
from streamlit_folium import st_folium

from branding import render_brand_header
from noise_app.engine import (
    Source,
    Receiver,
    Barrier,
    PropagationSettings,
    build_grid,
    build_grid_from_polygon,
    level_at_point,
    source_to_point_breakdown,
)
from noise_app.map_view import make_map, rgba_from_grid


st.set_page_config(
    page_title="Noise Map Lab",
    page_icon="🔊",
    layout="wide",
)

st.markdown(
    """
    <style>
    .block-container {padding-top: 1.0rem; padding-bottom: 3rem;}
    [data-testid="stMetricValue"] {font-size: 1.65rem;}
    .small-note {opacity:.78;font-size:.9rem;}
    </style>
    """,
    unsafe_allow_html=True,
)

DEFAULT_CENTER = (-33.4569, -70.6483)


def init_state():
    defaults = {
        "sources": [
            Source("Fuente 1", -33.45670, -70.64860, 1.5, 100.0, 0.0, True)
        ],
        "receivers": [
            Receiver("Receptor 1", -33.45695, -70.64790, 1.5)
        ],
        "barriers": [],
        "pending_barrier_start": None,
        "last_processed_click": None,
        "calculation_polygon": None,
        "last_drawing_signature": None,
        "raster_cache": None,
        "raster_cache_key": None,
        "map_dirty": True,
    }

    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def invalidate_map():
    st.session_state.map_dirty = True


def object_df(items, kind):
    if kind == "sources":
        columns = ["name", "lat", "lon", "height_m", "lw_db", "dc_db", "enabled"]
        return pd.DataFrame(
            [
                {
                    "name": x.name,
                    "lat": x.lat,
                    "lon": x.lon,
                    "height_m": x.height_m,
                    "lw_db": x.lw_db,
                    "dc_db": x.dc_db,
                    "enabled": x.enabled,
                }
                for x in items
            ],
            columns=columns,
        )

    if kind == "receivers":
        columns = ["name", "lat", "lon", "height_m"]
        return pd.DataFrame(
            [
                {
                    "name": x.name,
                    "lat": x.lat,
                    "lon": x.lon,
                    "height_m": x.height_m,
                }
                for x in items
            ],
            columns=columns,
        )

    columns = [
        "name",
        "lat_a",
        "lon_a",
        "lat_b",
        "lon_b",
        "height_m",
        "enabled",
    ]
    return pd.DataFrame(
        [
            {
                "name": x.name,
                "lat_a": x.lat_a,
                "lon_a": x.lon_a,
                "lat_b": x.lat_b,
                "lon_b": x.lon_b,
                "height_m": x.height_m,
                "enabled": x.enabled,
            }
            for x in items
        ],
        columns=columns,
    )


def update_from_editor(df, kind):
    try:
        if kind == "sources":
            st.session_state.sources = [
                Source(
                    str(row["name"]),
                    float(row["lat"]),
                    float(row["lon"]),
                    float(row["height_m"]),
                    float(row["lw_db"]),
                    float(row["dc_db"]),
                    bool(row["enabled"]),
                )
                for _, row in df.iterrows()
            ]

        elif kind == "receivers":
            st.session_state.receivers = [
                Receiver(
                    str(row["name"]),
                    float(row["lat"]),
                    float(row["lon"]),
                    float(row["height_m"]),
                )
                for _, row in df.iterrows()
            ]

        else:
            st.session_state.barriers = [
                Barrier(
                    str(row["name"]),
                    float(row["lat_a"]),
                    float(row["lon_a"]),
                    float(row["lat_b"]),
                    float(row["lon_b"]),
                    float(row["height_m"]),
                    bool(row["enabled"]),
                )
                for _, row in df.iterrows()
            ]

        invalidate_map()
        return True

    except (ValueError, TypeError):
        st.error("Hay un valor inválido en la tabla.")
        return False


def add_map_click(mode, lat, lon):
    if mode == "Fuente":
        n = len(st.session_state.sources) + 1
        st.session_state.sources.append(Source(f"Fuente {n}", lat, lon))
        invalidate_map()

    elif mode == "Receptor":
        n = len(st.session_state.receivers) + 1
        st.session_state.receivers.append(Receiver(f"Receptor {n}", lat, lon))

    elif mode == "Barrera (2 clics)":
        if st.session_state.pending_barrier_start is None:
            st.session_state.pending_barrier_start = {"lat": lat, "lon": lon}
        else:
            start = st.session_state.pending_barrier_start
            n = len(st.session_state.barriers) + 1
            st.session_state.barriers.append(
                Barrier(
                    f"Barrera {n}",
                    start["lat"],
                    start["lon"],
                    lat,
                    lon,
                    3.0,
                    True,
                )
            )
            st.session_state.pending_barrier_start = None
            invalidate_map()


def drawing_to_polygon(drawing):
    if not drawing:
        return None

    geometry = drawing.get("geometry", {})
    if geometry.get("type") != "Polygon":
        return None

    coordinates = geometry.get("coordinates", [])
    if not coordinates:
        return None

    ring = coordinates[0]
    polygon = [[float(lat), float(lon)] for lon, lat in ring]
    return polygon if len(polygon) >= 4 else None


def get_center():
    if st.session_state.calculation_polygon:
        polygon = st.session_state.calculation_polygon
        return (
            sum(point[0] for point in polygon) / len(polygon),
            sum(point[1] for point in polygon) / len(polygon),
        )

    points = [(source.lat, source.lon) for source in st.session_state.sources]
    points += [(receiver.lat, receiver.lon) for receiver in st.session_state.receivers]

    if not points:
        return DEFAULT_CENTER

    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def model_hash(settings, map_height, grid_n, half_size, vmin, vmax):
    payload = {
        "sources": [source.__dict__ for source in st.session_state.sources],
        "barriers": [barrier.__dict__ for barrier in st.session_state.barriers],
        "settings": settings.__dict__,
        "map_height": map_height,
        "grid_n": grid_n,
        "half_size": half_size,
        "vmin": vmin,
        "vmax": vmax,
        "polygon": st.session_state.calculation_polygon,
    }
    raw = json.dumps(payload, sort_keys=True, default=float).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def calculate_raster(
    settings,
    map_height,
    grid_n,
    half_size,
    center_lat,
    center_lon,
    vmin,
    vmax,
):
    polygon = st.session_state.calculation_polygon

    if polygon:
        points, mask, bounds_tuple = build_grid_from_polygon(polygon, grid_n)
        south, west, north, east = bounds_tuple
        mask_array = np.array(mask, dtype=bool).reshape(grid_n, grid_n)
        levels = np.full((grid_n, grid_n), np.nan, dtype=float)

        for flat_index in np.flatnonzero(mask_array.ravel()):
            lat, lon = points[int(flat_index)]
            i = int(flat_index) // grid_n
            j = int(flat_index) % grid_n

            levels[i, j] = level_at_point(
                st.session_state.sources,
                lat,
                lon,
                map_height,
                st.session_state.barriers,
                settings,
                center_lat,
                center_lon,
            )

        rgba = rgba_from_grid(
            levels,
            vmin,
            vmax,
            polygon_mask=mask_array,
        )

        return {
            "rgba": rgba,
            "bounds": [[south, west], [north, east]],
            "levels": levels,
        }

    grid = build_grid(center_lat, center_lon, half_size, grid_n)
    levels = np.full((grid_n, grid_n), np.nan, dtype=float)
    lats = []
    lons = []

    for index, (lat, lon, _, _) in enumerate(grid):
        i = index // grid_n
        j = index % grid_n

        levels[i, j] = level_at_point(
            st.session_state.sources,
            lat,
            lon,
            map_height,
            st.session_state.barriers,
            settings,
            center_lat,
            center_lon,
        )
        lats.append(lat)
        lons.append(lon)

    rgba = rgba_from_grid(levels, vmin, vmax)

    return {
        "rgba": rgba,
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "levels": levels,
    }


init_state()
render_brand_header()

st.caption(
    "Prototipo educativo de propagación exterior. "
    "El motor actual todavía no constituye una implementación ISO 9613-2 "
    "validada para uso profesional."
)

with st.sidebar:
    st.header("1 · Dibujar y agregar")

    click_mode = st.radio(
        "Clic en el mapa:",
        ["Navegar", "Fuente", "Receptor", "Barrera (2 clics)"],
        index=0,
        help=(
            "Usa Navegar para mover o ampliar el mapa sin agregar objetos. "
            "Selecciona otro modo solo cuando quieras crear un elemento."
        ),
    )

    st.info(
        "Para definir el área de cálculo usa el rectángulo o polígono "
        "de la barra de herramientas del mapa."
    )

    if st.session_state.calculation_polygon:
        st.success("Área de cálculo dibujada.")
        if st.button("Borrar área de cálculo"):
            st.session_state.calculation_polygon = None
            st.session_state.last_drawing_signature = None
            invalidate_map()
            st.rerun()

    if st.session_state.pending_barrier_start:
        st.warning("Barrera: selecciona el segundo punto.")
        if st.button("Cancelar barrera"):
            st.session_state.pending_barrier_start = None
            st.rerun()

    st.divider()
    st.header("2 · Motor")

    alpha = st.number_input(
        "Absorción atmosférica α [dB/km]",
        min_value=0.0,
        max_value=50.0,
        value=2.0,
        step=0.1,
        help="Parámetro simplificado y editable en esta versión.",
    )

    freq = st.select_slider(
        "Frecuencia para difracción [Hz]",
        options=[63, 125, 250, 500, 1000, 2000, 4000, 8000],
        value=500,
    )

    receiver_map_height = st.number_input(
        "Altura del mapa [m]",
        min_value=0.1,
        max_value=20.0,
        value=1.5,
        step=0.1,
    )

    st.divider()
    st.header("3 · Resolución")

    grid_n = st.slider(
        "Resolución del raster",
        min_value=18,
        max_value=70,
        value=36,
        step=2,
        help="Mayor resolución entrega más detalle, pero aumenta el tiempo de cálculo.",
    )

    half_size = st.slider(
        "Semiancho si no dibujas área [m]",
        min_value=50,
        max_value=750,
        value=200,
        step=25,
    )

    vmin, vmax = st.slider(
        "Escala visual [dB]",
        min_value=20,
        max_value=100,
        value=(35, 80),
        step=1,
    )

    st.divider()

    calculate_pressed = st.button(
        "CALCULAR / ACTUALIZAR MAPA",
        type="primary",
    )

    if st.session_state.map_dirty and st.session_state.raster_cache is not None:
        st.caption(
            "Hay cambios pendientes. El mapa mantiene el último cálculo "
            "hasta que pulses CALCULAR / ACTUALIZAR MAPA."
        )

    if st.button("Reiniciar escenario", type="secondary"):
        for key in [
            "sources",
            "receivers",
            "barriers",
            "pending_barrier_start",
            "last_processed_click",
            "calculation_polygon",
            "last_drawing_signature",
            "raster_cache",
            "raster_cache_key",
            "map_dirty",
        ]:
            st.session_state.pop(key, None)
        init_state()
        st.rerun()


settings = PropagationSettings(
    alpha_db_per_km=float(alpha),
    frequency_hz=float(freq),
    max_barrier_db=20.0,
)

center_lat, center_lon = get_center()

current_key = model_hash(
    settings,
    receiver_map_height,
    grid_n,
    half_size,
    float(vmin),
    float(vmax),
)

if st.session_state.raster_cache_key not in (None, current_key):
    st.session_state.map_dirty = True

if calculate_pressed:
    with st.spinner("Calculando mapa de ruido..."):
        st.session_state.raster_cache = calculate_raster(
            settings,
            receiver_map_height,
            grid_n,
            half_size,
            center_lat,
            center_lon,
            float(vmin),
            float(vmax),
        )
        st.session_state.raster_cache_key = current_key
        st.session_state.map_dirty = False


tab_map, tab_objects, tab_results, tab_method = st.tabs(
    ["🗺️ Mapa", "🧱 Objetos", "📊 Resultados", "🧮 Método"]
)


with tab_map:
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Fuentes", len(st.session_state.sources))
    c2.metric("Receptores", len(st.session_state.receivers))
    c3.metric("Barreras", len(st.session_state.barriers))
    c4.metric(
        "Área",
        "dibujada" if st.session_state.calculation_polygon else "automática",
    )

    map_object = make_map(
        center_lat,
        center_lon,
        17,
        st.session_state.sources,
        st.session_state.receivers,
        st.session_state.barriers,
        raster=st.session_state.raster_cache,
        vmin=float(vmin),
        vmax=float(vmax),
        pending_barrier_start=st.session_state.pending_barrier_start,
        calculation_polygon=st.session_state.calculation_polygon,
    )

    map_data = st_folium(
        map_object,
        height=680,
        use_container_width=True,
        returned_objects=["last_clicked", "all_drawings"],
        key="noise_map_fast",
    )

    drawings = (map_data or {}).get("all_drawings") or []
    if drawings:
        latest = drawings[-1]
        signature = json.dumps(latest, sort_keys=True)

        if signature != st.session_state.last_drawing_signature:
            polygon = drawing_to_polygon(latest)
            if polygon:
                st.session_state.calculation_polygon = polygon
                st.session_state.last_drawing_signature = signature
                invalidate_map()
                st.rerun()

    if click_mode != "Navegar":
        last_clicked = (map_data or {}).get("last_clicked")

        if last_clicked:
            click_signature = (
                round(float(last_clicked["lat"]), 7),
                round(float(last_clicked["lng"]), 7),
                click_mode,
            )

            if click_signature != st.session_state.last_processed_click:
                st.session_state.last_processed_click = click_signature
                add_map_click(
                    click_mode,
                    click_signature[0],
                    click_signature[1],
                )
                st.rerun()

    st.caption(
        "El mapa de ruido se representa como una superficie raster continua. "
        "Al hacer zoom conserva la mancha de color y no se convierte en puntos aislados."
    )


with tab_objects:
    st.subheader("Fuentes puntuales")

    with st.form("form_sources"):
        edited_sources = st.data_editor(
            object_df(st.session_state.sources, "sources"),
            num_rows="dynamic",
            width="stretch",
            key="sources_editor",
            column_config={
                "lw_db": st.column_config.NumberColumn(
                    "Lw [dB]",
                    min_value=0.0,
                    max_value=160.0,
                ),
                "dc_db": st.column_config.NumberColumn(
                    "Dc [dB]",
                    min_value=-20.0,
                    max_value=20.0,
                ),
                "height_m": st.column_config.NumberColumn(
                    "Altura [m]",
                    min_value=0.0,
                    max_value=100.0,
                ),
                "enabled": st.column_config.CheckboxColumn("Activa"),
            },
        )
        apply_sources = st.form_submit_button("Aplicar cambios de fuentes")

    if apply_sources and update_from_editor(edited_sources, "sources"):
        st.rerun()

    st.subheader("Receptores")

    with st.form("form_receivers"):
        edited_receivers = st.data_editor(
            object_df(st.session_state.receivers, "receivers"),
            num_rows="dynamic",
            width="stretch",
            key="receivers_editor",
            column_config={
                "height_m": st.column_config.NumberColumn(
                    "Altura [m]",
                    min_value=0.0,
                    max_value=100.0,
                ),
            },
        )
        apply_receivers = st.form_submit_button("Aplicar cambios de receptores")

    if apply_receivers and update_from_editor(edited_receivers, "receivers"):
        st.rerun()

    st.subheader("Barreras")

    with st.form("form_barriers"):
        edited_barriers = st.data_editor(
            object_df(st.session_state.barriers, "barriers"),
            num_rows="dynamic",
            width="stretch",
            key="barriers_editor",
            column_config={
                "height_m": st.column_config.NumberColumn(
                    "Altura superior [m]",
                    min_value=0.0,
                    max_value=100.0,
                ),
                "enabled": st.column_config.CheckboxColumn("Activa"),
            },
        )
        apply_barriers = st.form_submit_button("Aplicar cambios de barreras")

    if apply_barriers and update_from_editor(edited_barriers, "barriers"):
        st.rerun()


with tab_results:
    st.subheader("Niveles en receptores")

    receiver_rows = []
    breakdown_rows = []

    for receiver in st.session_state.receivers:
        total = level_at_point(
            st.session_state.sources,
            receiver.lat,
            receiver.lon,
            receiver.height_m,
            st.session_state.barriers,
            settings,
            center_lat,
            center_lon,
        )

        receiver_rows.append(
            {
                "Receptor": receiver.name,
                "Lat": receiver.lat,
                "Lon": receiver.lon,
                "Altura [m]": receiver.height_m,
                "Nivel total [dB]": round(total, 2)
                if math.isfinite(total)
                else None,
            }
        )

        for source in st.session_state.sources:
            if not source.enabled:
                continue

            result = source_to_point_breakdown(
                source,
                receiver.lat,
                receiver.lon,
                receiver.height_m,
                st.session_state.barriers,
                settings,
                center_lat,
                center_lon,
            )

            breakdown_rows.append(
                {
                    "Receptor": receiver.name,
                    "Fuente": source.name,
                    "Distancia [m]": round(result["distance_m"], 2),
                    "Lw [dB]": round(result["lw_db"], 2),
                    "Dc [dB]": round(result["dc_db"], 2),
                    "Adiv [dB]": round(result["a_div_db"], 2),
                    "Aatm [dB]": round(result["a_atm_db"], 2),
                    "Abar [dB]": round(result["a_bar_db"], 2),
                    "Lp contribución [dB]": round(result["lp_db"], 2),
                }
            )

    receiver_df = pd.DataFrame(receiver_rows)
    breakdown_df = pd.DataFrame(breakdown_rows)

    st.dataframe(
        receiver_df,
        width="stretch",
        hide_index=True,
    )

    if not receiver_df.empty:
        st.download_button(
            "Descargar receptores CSV",
            data=receiver_df.to_csv(index=False).encode("utf-8-sig"),
            file_name="receptores_noise_map.csv",
            mime="text/csv",
        )

    st.subheader("Desglose por trayectoria")
    st.dataframe(
        breakdown_df,
        width="stretch",
        hide_index=True,
    )


with tab_method:
    st.subheader("Funcionamiento de esta versión")

    st.markdown(
        r"""
### Interfaz

- El área de cálculo puede dibujarse con **rectángulo o polígono**.
- El mapa calculado se muestra como **raster continuo**, no como marcadores circulares.
- El modo **Navegar** evita crear objetos accidentalmente.
- La grilla se recalcula solo al pulsar **CALCULAR / ACTUALIZAR MAPA**.
- Las tablas usan formularios para reducir recálculos innecesarios.

### Motor acústico actual

[
L_p = L_w + D_c - A_{div} - A_{atm} - A_{bar}
]

[
A_{div}=20log_{10}(r)+11
]

[
A_{atm}=alpha r/1000
]

Las contribuciones de varias fuentes se suman energéticamente.

### Alcance

Esta versión sigue siendo un prototipo educativo. Aún no incorpora el
modelo espectral completo, efecto de suelo, reflexiones, edificios,
topografía ni la validación formal de una implementación completa de
ISO 9613-2.
"""
    )
