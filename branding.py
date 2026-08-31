from pathlib import Path
import base64
import streamlit as st


def _img_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("utf-8")


def render_brand_header():
    """Encabezado institucional del Diplomado en Acústica."""
    base = Path(__file__).resolve().parent
    uc_path = base / "assets" / "logo_uc.png"
    decon_path = base / "assets" / "logo_decon_uc.png"

    if not uc_path.exists() or not decon_path.exists():
        st.warning("No se encontraron los logos institucionales en la carpeta assets.")
        return

    uc = _img_b64(uc_path)
    decon = _img_b64(decon_path)

    st.markdown(
        f"""
        <style>
        .noise-brand {{
            display: grid;
            grid-template-columns: minmax(180px, 1fr) minmax(300px, 2fr) minmax(160px, 1fr);
            align-items: center;
            gap: 22px;
            width: 100%;
            padding: 14px 22px;
            margin: 0 0 18px 0;
            background: #ffffff;
            border: 1px solid rgba(15, 61, 108, 0.12);
            border-radius: 14px;
            box-shadow: 0 4px 18px rgba(0,0,0,0.05);
        }}

        .noise-brand-left {{
            display:flex;
            align-items:center;
            justify-content:flex-start;
        }}

        .noise-brand-left img {{
            max-height:82px;
            width:auto;
            object-fit:contain;
        }}

        .noise-brand-center {{
            text-align:center;
            line-height:1.12;
        }}

        .noise-brand-title {{
            color:#0b3768;
            font-size:clamp(1.45rem,2.2vw,2.35rem);
            font-weight:800;
            letter-spacing:.01em;
            margin:0;
        }}

        .noise-brand-subtitle {{
            color:#46515d;
            font-size:clamp(.9rem,1.15vw,1.12rem);
            margin-top:7px;
            font-weight:500;
        }}

        .noise-brand-right {{
            display:flex;
            justify-content:flex-end;
            align-items:center;
        }}

        .noise-brand-right img {{
            max-height:52px;
            max-width:200px;
            width:auto;
            object-fit:contain;
        }}

        @media (max-width:800px) {{
            .noise-brand {{
                grid-template-columns:1fr;
                text-align:center;
                padding:14px;
                gap:12px;
            }}
            .noise-brand-left,
            .noise-brand-right {{
                justify-content:center;
            }}
            .noise-brand-left img {{max-height:70px;}}
            .noise-brand-right img {{max-height:45px;}}
        }}
        </style>

        <div class="noise-brand">
            <div class="noise-brand-left">
                <img src="data:image/png;base64,{uc}" alt="Pontificia Universidad Católica de Chile">
            </div>

            <div class="noise-brand-center">
                <div class="noise-brand-title">DIPLOMADO EN ACÚSTICA</div>
                <div class="noise-brand-subtitle">Noise Map Lab · Mapa de Ruido</div>
            </div>

            <div class="noise-brand-right">
                <img src="data:image/png;base64,{decon}" alt="DECON UC">
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )
