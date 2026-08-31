from __future__ import annotations

import math
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
    level_at_point,
    source_to_point_breakdown,
)
from noise_app.map_view import make_map


st.set_page_config(
    page_title="Noise Map Lab V1",
    page_icon="🔊",
    layout="wide",
)

st.markdown("""
<style>
.block-container {padding-top: 1.2rem; padding-bottom: 3rem;}
[data-testid="stMetricValue"] {font-size: 1.65rem;}
.small-note {opacity: .78; font-size: .9rem;}
</style>
""", unsafe_allow_html=True)


DEFAULT_CENTER = (-33.4569, -70.6483)


def init_state():
    if "sources" not in st.session_state:
        st.session_state.sources = [
            Source("Fuente 1", -33.45670, -70.64860, 1.5, 100.0, 0.0, True)
        ]
    if "receivers" not in st.session_state:
        st.session_state.receivers = [
            Receiver("Receptor 1", -33.45695, -70.64790, 1.5)
        ]
    if "barriers" not in st.session_state:
        st.session_state.barriers = []
    if "pending_barrier_start" not in st.session_state:
        st.session_state.pending_barrier_start = None
    if "last_processed_click" not in st.session_state:
        st.session_state.last_processed_click = None


def object_df(items, kind):
    if kind == "sources":
        columns = ["name", "lat", "lon", "height_m", "lw_db", "dc_db", "enabled"]
        return pd.DataFrame([
            {
                "name": x.name, "lat": x.lat, "lon": x.lon,
                "height_m": x.height_m, "lw_db": x.lw_db,
                "dc_db": x.dc_db, "enabled": x.enabled,
            } for x in items
        ], columns=columns)
    if kind == "receivers":
        columns = ["name", "lat", "lon", "height_m"]
        return pd.DataFrame([
            {"name": x.name, "lat": x.lat, "lon": x.lon, "height_m": x.height_m}
            for x in items
        ], columns=columns)
    columns = ["name", "lat_a", "lon_a", "lat_b", "lon_b", "height_m", "enabled"]
    return pd.DataFrame([
        {
            "name": x.name,
            "lat_a": x.lat_a, "lon_a": x.lon_a,
            "lat_b": x.lat_b, "lon_b": x.lon_b,
            "height_m": x.height_m, "enabled": x.enabled,
        } for x in items
    ], columns=columns)


def update_from_editor(df, kind):
    try:
        if kind == "sources":
            st.session_state.sources = [
                Source(
                    str(r["name"]), float(r["lat"]), float(r["lon"]),
                    float(r["height_m"]), float(r["lw_db"]),
                    float(r["dc_db"]), bool(r["enabled"])
                )
                for _, r in df.iterrows()
            ]
        elif kind == "receivers":
            st.session_state.receivers = [
                Receiver(
                    str(r["name"]), float(r["lat"]), float(r["lon"]),
                    float(r["height_m"])
                )
                for _, r in df.iterrows()
            ]
        else:
            st.session_state.barriers = [
                Barrier(
                    str(r["name"]),
                    float(r["lat_a"]), float(r["lon_a"]),
                    float(r["lat_b"]), float(r["lon_b"]),
                    float(r["height_m"]), bool(r["enabled"])
                )
                for _, r in df.iterrows()
            ]
    except (ValueError, TypeError):
        st.warning("Hay un valor inválido en la tabla. Corrígelo para actualizar el modelo.")


def add_map_click(mode, lat, lon):
    if mode == "Fuente":
        n = len(st.session_state.sources) + 1
        st.session_state.sources.append(Source(f"Fuente {n}", lat, lon))
    elif mode == "Receptor":
        n = len(st.session_state.receivers) + 1
        st.session_state.receivers.append(Receiver(f"Receptor {n}", lat, lon))
    else:
        if st.session_state.pending_barrier_start is None:
            st.session_state.pending_barrier_start = {"lat": lat, "lon": lon}
        else:
            a = st.session_state.pending_barrier_start
            n = len(st.session_state.barriers) + 1
            st.session_state.barriers.append(
                Barrier(f"Barrera {n}", a["lat"], a["lon"], lat, lon, 3.0, True)
            )
            st.session_state.pending_barrier_start = None


def get_center():
    pts = []
    pts += [(s.lat, s.lon) for s in st.session_state.sources]
    pts += [(r.lat, r.lon) for r in st.session_state.receivers]
    if not pts:
        return DEFAULT_CENTER
    return (
        sum(p[0] for p in pts) / len(pts),
        sum(p[1] for p in pts) / len(pts),
    )


init_state()

render_brand_header()

st.caption(
    "Prototipo educativo de propagación exterior. "
    "No es todavía una implementación ISO 9613-2 validada para uso profesional."
)

with st.sidebar:
    st.header("1 · Agregar objetos")
    click_mode = st.radio(
        "El siguiente clic en el mapa agrega:",
        ["Fuente", "Receptor", "Barrera (2 clics)"],
        index=0,
    )
    if st.session_state.pending_barrier_start:
        st.info("Barrera: ahora selecciona el segundo punto.")
        if st.button("Cancelar barrera"):
            st.session_state.pending_barrier_start = None
            st.rerun()

    st.divider()
    st.header("2 · Motor V1")
    alpha = st.number_input(
        "Absorción atmosférica α [dB/km]",
        min_value=0.0, max_value=50.0, value=2.0, step=0.1,
        help="Parámetro simplificado y editable en esta V1."
    )
    freq = st.select_slider(
        "Frecuencia para difracción [Hz]",
        options=[63, 125, 250, 500, 1000, 2000, 4000, 8000],
        value=500,
    )
    receiver_map_height = st.number_input(
        "Altura del mapa [m]",
        min_value=0.1, max_value=20.0, value=1.5, step=0.1,
    )

    st.divider()
    st.header("3 · Grilla")
    half_size = st.slider(
        "Semiancho del mapa [m]", 50, 750, 200, step=25
    )
    grid_n = st.slider(
        "Resolución (puntos por lado)", 15, 55, 31, step=2
    )
    vmin, vmax = st.slider(
        "Escala visual [dB]", 20, 100, (35, 80), step=1
    )

    st.divider()
    calculate_map = st.toggle("Mostrar mapa de ruido", value=True)
    if st.button("Reiniciar escenario", type="secondary"):
        for key in ["sources", "receivers", "barriers", "pending_barrier_start",
                    "last_processed_click"]:
            st.session_state.pop(key, None)
        init_state()
        st.rerun()

settings = PropagationSettings(
    alpha_db_per_km=float(alpha),
    frequency_hz=float(freq),
    max_barrier_db=20.0,
)

tab_map, tab_objects, tab_results, tab_method = st.tabs(
    ["🗺️ Mapa", "🧱 Objetos", "📊 Resultados", "🧮 Método"]
)

center_lat, center_lon = get_center()

grid_results = []
if calculate_map and st.session_state.sources:
    grid = build_grid(center_lat, center_lon, half_size, grid_n)
    with st.spinner("Calculando grilla..."):
        for lat, lon, _, _ in grid:
            lvl = level_at_point(
                st.session_state.sources,
                lat, lon, receiver_map_height,
                st.session_state.barriers,
                settings,
                center_lat, center_lon,
            )
            grid_results.append({"lat": lat, "lon": lon, "level_db": lvl})

with tab_map:
    c1, c2, c3 = st.columns(3)
    c1.metric("Fuentes", len(st.session_state.sources))
    c2.metric("Receptores", len(st.session_state.receivers))
    c3.metric("Barreras", len(st.session_state.barriers))

    m = make_map(
        center_lat, center_lon, 17,
        st.session_state.sources,
        st.session_state.receivers,
        st.session_state.barriers,
        grid_results=grid_results,
        vmin=float(vmin), vmax=float(vmax),
        pending_barrier_start=st.session_state.pending_barrier_start,
    )

    map_data = st_folium(
        m,
        height=650,
        use_container_width=True,
        returned_objects=["last_clicked"],
        key="noise_map",
    )

    last_clicked = (map_data or {}).get("last_clicked")
    if last_clicked:
        click_sig = (
            round(float(last_clicked["lat"]), 7),
            round(float(last_clicked["lng"]), 7),
            click_mode,
        )
        if click_sig != st.session_state.last_processed_click:
            st.session_state.last_processed_click = click_sig
            add_map_click(click_mode, click_sig[0], click_sig[1])
            st.rerun()

    st.markdown(
        '<div class="small-note">Consejo: selecciona el tipo de objeto en la barra '
        'lateral y luego haz clic en el mapa. La barrera se crea con dos clics.</div>',
        unsafe_allow_html=True,
    )

with tab_objects:
    st.subheader("Fuentes puntuales")
    src_df = object_df(st.session_state.sources, "sources")
    edited_src = st.data_editor(
        src_df,
        num_rows="dynamic",
        use_container_width=True,
        key="src_editor",
        column_config={
            "lw_db": st.column_config.NumberColumn("Lw [dB]", min_value=0.0, max_value=160.0),
            "dc_db": st.column_config.NumberColumn("Dc [dB]", min_value=-20.0, max_value=20.0),
            "height_m": st.column_config.NumberColumn("Altura [m]", min_value=0.0, max_value=100.0),
            "enabled": st.column_config.CheckboxColumn("Activa"),
        },
    )
    if st.button("Aplicar cambios de fuentes"):
        update_from_editor(edited_src, "sources")
        st.rerun()

    st.subheader("Receptores")
    rec_df = object_df(st.session_state.receivers, "receivers")
    edited_rec = st.data_editor(
        rec_df,
        num_rows="dynamic",
        use_container_width=True,
        key="rec_editor",
        column_config={
            "height_m": st.column_config.NumberColumn("Altura [m]", min_value=0.0, max_value=100.0),
        },
    )
    if st.button("Aplicar cambios de receptores"):
        update_from_editor(edited_rec, "receivers")
        st.rerun()

    st.subheader("Barreras")
    bar_df = object_df(st.session_state.barriers, "barriers")
    edited_bar = st.data_editor(
        bar_df,
        num_rows="dynamic",
        use_container_width=True,
        key="bar_editor",
        column_config={
            "height_m": st.column_config.NumberColumn("Altura superior [m]", min_value=0.0, max_value=100.0),
            "enabled": st.column_config.CheckboxColumn("Activa"),
        },
    )
    if st.button("Aplicar cambios de barreras"):
        update_from_editor(edited_bar, "barriers")
        st.rerun()

with tab_results:
    st.subheader("Niveles en receptores")

    receiver_rows = []
    breakdown_rows = []

    for rec in st.session_state.receivers:
        total = level_at_point(
            st.session_state.sources,
            rec.lat, rec.lon, rec.height_m,
            st.session_state.barriers,
            settings,
            center_lat, center_lon,
        )
        receiver_rows.append(
            {
                "Receptor": rec.name,
                "Lat": rec.lat,
                "Lon": rec.lon,
                "Altura [m]": rec.height_m,
                "Nivel total [dB]": round(total, 2) if math.isfinite(total) else None,
            }
        )

        for src in st.session_state.sources:
            if not src.enabled:
                continue
            d = source_to_point_breakdown(
                src, rec.lat, rec.lon, rec.height_m,
                st.session_state.barriers,
                settings,
                center_lat, center_lon,
            )
            breakdown_rows.append(
                {
                    "Receptor": rec.name,
                    "Fuente": src.name,
                    "Distancia [m]": round(d["distance_m"], 2),
                    "Lw [dB]": round(d["lw_db"], 2),
                    "Dc [dB]": round(d["dc_db"], 2),
                    "Adiv [dB]": round(d["a_div_db"], 2),
                    "Aatm [dB]": round(d["a_atm_db"], 2),
                    "Abar [dB]": round(d["a_bar_db"], 2),
                    "Lp contribución [dB]": round(d["lp_db"], 2),
                }
            )

    rdf = pd.DataFrame(receiver_rows)
    bdf = pd.DataFrame(breakdown_rows)

    st.dataframe(rdf, use_container_width=True, hide_index=True)

    if not rdf.empty:
        st.download_button(
            "Descargar receptores CSV",
            data=rdf.to_csv(index=False).encode("utf-8-sig"),
            file_name="receptores_noise_map_v1.csv",
            mime="text/csv",
        )

    st.subheader("Desglose por trayectoria")
    st.dataframe(bdf, use_container_width=True, hide_index=True)

with tab_method:
    st.subheader("Qué calcula esta V1")

    st.latex(r"L_p = L_w + D_c - A_{div} - A_{atm} - A_{bar}")
    st.latex(r"A_{div}=20\log_{10}(r)+11")
    st.latex(r"A_{atm}=\alpha\,r/1000")

    st.markdown(
        r"""
**Barrera:** la V1 detecta la intersección en planta entre la trayectoria
fuente–receptor y una barrera recta. Si la coronación supera la línea de
visión, calcula una diferencia de camino sobre la arista y aplica una
aproximación de difracción basada en número de Fresnel, limitada a 20 dB.

**Suma de fuentes:** las contribuciones se combinan energéticamente:

\[
L_{tot}=10\log_{10}\left(\sum_i 10^{L_i/10}\right)
\]

### Lo que todavía NO incluye

- efecto de suelo ISO;
- meteorología completa;
- cálculo espectral 63 Hz–8 kHz;
- ponderación A;
- reflexión en fachadas;
- edificios como obstáculos 3D;
- fuentes lineales o de área;
- topografía;
- difracción lateral;
- validación formal contra casos normalizados.

Por eso esta versión debe utilizarse **solo con fines educativos y de
desarrollo**, no como software regulatorio.
"""
    )
