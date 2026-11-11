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

## Tránsito y Lden · Curso 5 / Laboratorio 2

La pestaña **🚗 Tránsito y Lden** contiene tres niveles de cálculo claramente diferenciados:

1. **Emisión vial CNOSSOS-EU, sección 2.2:** integra `phonometry` y su base de coeficientes por bandas de octava 63 Hz–8 kHz, incluidas tablas F-1/F-4 modificadas por 2021/1226. Para usarlo, el entorno necesita Python 3.12+ y la dependencia `phonometry`. Salida: Lw' de la fuente vial por metro de trazado, **no un nivel en receptor**.
2. **Estimación docente en receptor y mapa esquemático:** discretiza una vía recta y suma geométricamente las contribuciones en espacio libre. Produce Lday, Levening, Lnight, Lden y una grilla ilustrativa (no georreferenciada). **NO implementa el método de propagación CNOSSOS-EU sección 2.5**; omite efecto de suelo, meteorología, edificios, difracción, reflexiones, absorción atmosférica y topografía. No se debe utilizar para afirmar cumplimiento normativo.
3. **Combinación energética Lden:** si el usuario dispone de Lday, Levening y Lnight de un modelo validado, calcula Lden mediante los períodos 12/4/8 horas y las penalizaciones 0/+5/+10 dB. Puede exportar los resultados y las hipótesis como JSON.

El escenario académico predeterminado se refiere a **Pasaje Chimbote**, próximo a la fachada sur de la vivienda CH-A-P05-S03 (Torre A), con **flujos docentes supuestos**. El valor predeterminado de velocidad es 30 km/h; no son aforos ni niveles medidos.

**Para obtener un mapa CNOSSOS-EU completo** falta integrar y validar un motor de propagación 2.5 como NoiseModelling de Université Gustave Eiffel, con geometría GIS, edificios, suelo, condiciones favorables/desfavorables, reflexiones y pruebas de referencia. El motor puntual original de la pestaña «Mapa» no es equivalente a dicha propagación.

### Flujo de trabajo con SONARA

Exporta el JSON de receptor → importa los niveles en la Etapa 6 del Curso 5 · Laboratorio 2 → documenta si se trata de una estimación preliminar o de resultados de un motor CNOSSOS validado → utiliza SONARA para calcular y mejorar el aislamiento de fachada → consulta el requisito Clase B de ISO/TS 19488:2021. Un Lden calculado a partir de una propagación simplificada **no demuestra conformidad normativa**.

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
