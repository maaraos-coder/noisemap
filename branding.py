from pathlib import Path
import base64
import streamlit as st


def _img_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("utf-8")


def render_brand_header():
    """Encabezado institucional del Diplomado en Acústica de la Edificación."""
    base = Path(__file__).resolve().parent
    uc_path = base / "assets" / "logo_uc.png"
    decon_path = base / "assets" / "logo_decon_uc.png"

    if not uc_path.exists() or not decon_path.exists():
        return

    uc = _img_b64(uc_path)
    decon = _img_b64(decon_path)

    st.markdown(
        f"""
        <style>
        .noise-brand {{
            display:grid;
            grid-template-columns:minmax(205px,1fr) minmax(340px,2fr) minmax(180px,1fr);
            align-items:center;
            gap:24px;
            width:100%;
            padding:16px 24px;
            margin:0 0 12px 0;
            background:#fff;
            border:1px solid rgba(15,61,108,.12);
            border-radius:14px;
            box-shadow:0 4px 18px rgba(0,0,0,.05);
        }}
        .noise-brand-left{{display:flex;justify-content:flex-start;align-items:center}}
        .noise-brand-left img{{max-height:86px;max-width:100%;width:auto;object-fit:contain}}
        .noise-brand-center{{text-align:center;line-height:1.12}}
        .noise-brand-title{{
            color:#0b3768;
            font-size:clamp(1.25rem,2vw,2.15rem);
            font-weight:800;
            letter-spacing:.01em;
            margin:0
        }}
        .noise-brand-subtitle{{
            color:#46515d;
            font-size:clamp(.9rem,1.1vw,1.08rem);
            margin-top:7px;
            font-weight:500
        }}
        .noise-brand-right{{display:flex;justify-content:flex-end;align-items:center}}
        .noise-brand-right img{{max-height:54px;max-width:200px;width:auto;object-fit:contain}}
        @media(max-width:850px){{
            .noise-brand{{grid-template-columns:1fr;gap:10px;padding:14px}}
            .noise-brand-left,.noise-brand-right{{justify-content:center}}
            .noise-brand-left img{{max-height:70px}}
            .noise-brand-right img{{max-height:44px}}
        }}
        </style>

        <div class="noise-brand">
          <div class="noise-brand-left">
            <img src="data:image/png;base64,{uc}" alt="Pontificia Universidad Católica de Chile">
          </div>
          <div class="noise-brand-center">
            <div class="noise-brand-title">DIPLOMADO EN ACÚSTICA DE LA EDIFICACIÓN</div>
            <div class="noise-brand-subtitle">Noise Map Lab · Mapa de Ruido</div>
          </div>
          <div class="noise-brand-right">
            <img src="data:image/png;base64,{decon}" alt="DECON UC">
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )
