# Noise Map Lab V3 — React + MapLibre + FastAPI

Esta rama conserva la app Streamlit existente y agrega una nueva arquitectura pensada para una experiencia de mapa similar a dBmap.

## Arquitectura

- Frontend: React + Vite + MapLibre
- Backend: FastAPI
- Motor acústico: Python existente en `noise_app/engine.py`

## Funciones de la V3

- Controles flotantes sobre el mapa.
- Escala vertical de ruido.
- Fuente y receptor arrastrables.
- Barreras con extremos arrastrables.
- Área de cálculo dibujable por vértices.
- Cálculo del raster solo cuando el usuario lo solicita.
- Raster continuo sobre OpenStreetMap.
- Panel flotante para editar parámetros de fuente, receptor o barrera.
- Branding del Diplomado en Acústica de la Edificación.

## Desarrollo local

### Backend

Desde la raíz:

```bash
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite redirige `/api` al backend local en el puerto 8000.

## Producción

Frontend:
- Vercel o Netlify.
- Build: `npm run build`
- Output: `dist`
- Root directory: `frontend`

Backend:
- Render, Railway, Fly.io u otro servicio Python.
- Start command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`

En producción define en el frontend:

```text
VITE_API_BASE_URL=https://TU-BACKEND
```

## Alcance acústico

La V3 cambia principalmente la experiencia de usuario y conserva el motor educativo existente. Todavía no es una implementación completa y validada de ISO 9613-2.


<!-- Deployment trigger: Vercel production branch -->
