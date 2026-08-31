# Noise Map Lab — V1

MVP educativo de una aplicación web de mapas de ruido, preparada para GitHub y Streamlit Cloud.

## Qué incluye esta versión

- Mapa real con OpenStreetMap/Folium.
- Alta interactiva mediante clic de:
  - fuentes puntuales;
  - receptores;
  - barreras rectas de dos puntos.
- Edición de parámetros en tablas.
- Mapa de niveles calculado sobre una grilla.
- Suma energética de múltiples fuentes.
- Cálculo en receptores.
- Desglose por fuente:
  - divergencia geométrica;
  - absorción atmosférica;
  - atenuación simplificada por barrera.
- Descarga CSV de resultados en receptores.
- Motor separado de la interfaz para facilitar una migración futura a React/MapLibre.

## Importante: alcance acústico

Esta V1 es un **prototipo educativo y no una implementación validada de ISO 9613-2**.

Usa una estructura compatible con el enfoque general:

`Lp = Lw + Dc - Adiv - Aatm - Abar`

con:

`Adiv = 20 log10(r) + 11`

La absorción atmosférica se ingresa como un coeficiente configurable en dB/km.

La pérdida por barrera usa una aproximación didáctica basada en diferencia de camino/Fresnel y se limita a 20 dB por trayectoria. No incluye todavía todas las condiciones geométricas, suelo, meteorología, reflexiones ni reglas completas de ISO 9613-2:2024.

**No utilizar esta versión para informes regulatorios, peritajes o decisiones profesionales.**

## Estructura

```text
noise-map-lab-v1/
├── app.py
├── noise_app/
│   ├── __init__.py
│   ├── engine.py
│   └── map_view.py
├── tests/
│   └── test_engine.py
├── requirements.txt
├── .gitignore
└── README.md
```

## Ejecutar localmente

```bash
python -m venv .venv
```

### Windows

```bash
.venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```

### macOS / Linux

```bash
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

## Subir a GitHub

1. Crea un repositorio nuevo.
2. Copia estos archivos al repositorio.
3. Ejecuta:

```bash
git init
git add .
git commit -m "Noise Map Lab V1"
git branch -M main
git remote add origin URL_DE_TU_REPOSITORIO
git push -u origin main
```

## Desplegar en Streamlit Community Cloud

1. Sube el proyecto a GitHub.
2. En Streamlit Community Cloud crea una nueva app.
3. Selecciona el repositorio.
4. Main file: `app.py`.
5. Deploy.

## Controles rápidos

En la barra lateral selecciona qué quieres agregar:

- `Fuente`: el siguiente clic en el mapa crea una fuente.
- `Receptor`: el siguiente clic crea un receptor.
- `Barrera (2 clics)`: primer clic fija A y segundo clic fija B.

Los objetos pueden editarse después en las tablas.

## Próxima versión sugerida

V0.2 / V2:

- cálculo por bandas 63 Hz–8 kHz;
- ponderación A;
- efecto de suelo;
- ISO 9613-2:2024 implementada y validada por casos de prueba;
- fuentes lineales y de área;
- edificios;
- reflexiones;
- topografía;
- isolíneas reales;
- comparación de escenarios;
- exportación GeoJSON/JSON;
- vista del camino acústico fuente–barrera–receptor;
- frontend MapLibre/React si se decide separar la UI de Streamlit.
