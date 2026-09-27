import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Layer, Marker, NavigationControl, Source } from 'react-map-gl/maplibre'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

const COLORS = [
  '#2c7bb6', '#00a6ca', '#00ccbc', '#90eb9d',
  '#ffff8c', '#f9d057', '#f29e2e', '#e76818', '#d7191c'
]

const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
}

const initialSources = [
  {
    id: crypto.randomUUID(),
    name: 'Fuente 1',
    lat: -33.45670,
    lon: -70.64860,
    height_m: 1.5,
    lw_db: 100,
    dc_db: 0,
    enabled: true
  }
]

const initialReceivers = [
  {
    id: crypto.randomUUID(),
    name: 'Receptor 1',
    lat: -33.45695,
    lon: -70.64790,
    height_m: 1.5
  }
]

const defaultPolygon = [
  [-33.4580, -70.6502],
  [-33.4580, -70.6468],
  [-33.4557, -70.6468],
  [-33.4557, -70.6502]
]

function polygonGeoJSON(points) {
  if (!points || points.length < 3) {
    return {
      type: 'FeatureCollection',
      features: []
    }
  }

  const ring = [...points.map(([lat, lon]) => [lon, lat])]
  ring.push(ring[0])

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {}
    }]
  }
}

function barriersGeoJSON(barriers) {
  return {
    type: 'FeatureCollection',
    features: barriers
      .filter(b => b.enabled)
      .map(b => ({
        type: 'Feature',
        properties: { id: b.id, name: b.name },
        geometry: {
          type: 'LineString',
          coordinates: [[b.lon_a, b.lat_a], [b.lon_b, b.lat_b]]
        }
      }))
  }
}

function levelColor(value, vmin, vmax) {
  const t = Math.max(0, Math.min(1, (value - vmin) / Math.max(vmax - vmin, 0.001)))
  const scaled = t * (COLORS.length - 1)
  const i = Math.floor(scaled)
  const j = Math.min(COLORS.length - 1, i + 1)
  const f = scaled - i

  const rgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ]

  const a = rgb(COLORS[i])
  const b = rgb(COLORS[j])
  return a.map((x, k) => Math.round(x + (b[k] - x) * f))
}

function rasterDataUrl(levels, vmin, vmax) {
  if (!levels?.length) return null

  const height = levels.length
  const width = levels[0].length
  const scale = 5

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true

  levels.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value === null || Number.isNaN(value)) {
        ctx.clearRect(x * scale, y * scale, scale, scale)
        return
      }
      const [r, g, b] = levelColor(value, vmin, vmax)
      ctx.fillStyle = `rgba(${r},${g},${b},0.72)`
      ctx.fillRect(x * scale, y * scale, scale, scale)
    })
  })

  return canvas.toDataURL('image/png')
}

function IconButton({ active, title, children, onClick }) {
  return (
    <button
      className={`tool-button ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function App() {
  const mapRef = useRef(null)

  const [mode, setMode] = useState('navigate')
  const [sources, setSources] = useState(initialSources)
  const [receivers, setReceivers] = useState(initialReceivers)
  const [barriers, setBarriers] = useState([])
  const [polygon, setPolygon] = useState(defaultPolygon)
  const [draftPolygon, setDraftPolygon] = useState([])
  const [barrierStart, setBarrierStart] = useState(null)

  const [resolution, setResolution] = useState(48)
  const [height, setHeight] = useState(1.5)
  const [alpha, setAlpha] = useState(2)
  const [frequency, setFrequency] = useState(500)
  const [vmin, setVmin] = useState(35)
  const [vmax, setVmax] = useState(80)

  const [result, setResult] = useState(null)
  const [calculating, setCalculating] = useState(false)
  const [dirty, setDirty] = useState(true)
  const [selected, setSelected] = useState(null)
  const [panelOpen, setPanelOpen] = useState(true)

  const barrierData = useMemo(() => barriersGeoJSON(barriers), [barriers])
  const polygonData = useMemo(() => polygonGeoJSON(polygon), [polygon])
  const draftData = useMemo(() => polygonGeoJSON(draftPolygon), [draftPolygon])

  const rasterUrl = useMemo(
    () => rasterDataUrl(result?.levels, vmin, vmax),
    [result, vmin, vmax]
  )

  useEffect(() => {
    setDirty(true)
  }, [sources, barriers, polygon, resolution, height, alpha, frequency, vmin, vmax])

  const onMapClick = (event) => {
    const { lat, lng } = event.lngLat

    if (mode === 'source') {
      const item = {
        id: crypto.randomUUID(),
        name: `Fuente ${sources.length + 1}`,
        lat,
        lon: lng,
        height_m: 1.5,
        lw_db: 100,
        dc_db: 0,
        enabled: true
      }
      setSources(prev => [...prev, item])
      setSelected({ type: 'source', id: item.id })
      return
    }

    if (mode === 'receiver') {
      const item = {
        id: crypto.randomUUID(),
        name: `Receptor ${receivers.length + 1}`,
        lat,
        lon: lng,
        height_m: 1.5
      }
      setReceivers(prev => [...prev, item])
      setSelected({ type: 'receiver', id: item.id })
      return
    }

    if (mode === 'barrier') {
      if (!barrierStart) {
        setBarrierStart([lat, lng])
      } else {
        const item = {
          id: crypto.randomUUID(),
          name: `Barrera ${barriers.length + 1}`,
          lat_a: barrierStart[0],
          lon_a: barrierStart[1],
          lat_b: lat,
          lon_b: lng,
          height_m: 3,
          enabled: true
        }
        setBarriers(prev => [...prev, item])
        setBarrierStart(null)
        setSelected({ type: 'barrier', id: item.id })
      }
      return
    }

    if (mode === 'area') {
      setDraftPolygon(prev => [...prev, [lat, lng]])
    }
  }

  const calculate = async () => {
    if (polygon.length < 3 || !sources.some(s => s.enabled)) return

    setCalculating(true)
    try {
      const response = await fetch(`${API_BASE}/api/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources,
          barriers,
          polygon,
          settings: {
            resolution,
            receiver_height_m: height,
            alpha_db_per_km: alpha,
            frequency_hz: frequency,
            vmin,
            vmax
          }
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      setResult(data)
      setDirty(false)
    } catch (error) {
      console.error(error)
      alert('No fue posible calcular el mapa. Revisa que el backend FastAPI esté disponible.')
    } finally {
      setCalculating(false)
    }
  }

  const finishArea = () => {
    if (draftPolygon.length >= 3) {
      setPolygon(draftPolygon)
      setDraftPolygon([])
      setMode('navigate')
    }
  }

  const cancelDrawing = () => {
    setDraftPolygon([])
    setBarrierStart(null)
    setMode('navigate')
  }

  const selectedObject = (() => {
    if (!selected) return null
    if (selected.type === 'source') return sources.find(x => x.id === selected.id)
    if (selected.type === 'receiver') return receivers.find(x => x.id === selected.id)
    if (selected.type === 'barrier') return barriers.find(x => x.id === selected.id)
    return null
  })()

  const patchSelected = (patch) => {
    if (!selected) return

    if (selected.type === 'source') {
      setSources(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'receiver') {
      setReceivers(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'barrier') {
      setBarriers(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    }
  }

  const removeSelected = () => {
    if (!selected) return
    if (selected.type === 'source') {
      setSources(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'receiver') {
      setReceivers(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'barrier') {
      setBarriers(prev => prev.filter(x => x.id !== selected.id))
    }
    setSelected(null)
  }

  const imageCoordinates = result?.bounds
    ? [
        [result.bounds[0][1], result.bounds[1][0]],
        [result.bounds[1][1], result.bounds[1][0]],
        [result.bounds[1][1], result.bounds[0][0]],
        [result.bounds[0][1], result.bounds[0][0]]
      ]
    : null

  return (
    <div className="app-shell">
      <Map
        ref={mapRef}
        initialViewState={{
          longitude: -70.6484,
          latitude: -33.45685,
          zoom: 16.7
        }}
        mapStyle={OSM_STYLE}
        onClick={onMapClick}
        cursor={mode === 'navigate' ? 'grab' : 'crosshair'}
        doubleClickZoom={mode !== 'area'}
      >
        <NavigationControl position="bottom-left" />

        {rasterUrl && imageCoordinates && (
          <Source
            id="noise-raster"
            type="image"
            url={rasterUrl}
            coordinates={imageCoordinates}
          >
            <Layer
              id="noise-raster-layer"
              type="raster"
              paint={{
                'raster-opacity': 0.92,
                'raster-resampling': 'linear',
                'raster-fade-duration': 0
              }}
            />
          </Source>
        )}

        <Source id="calculation-area" type="geojson" data={polygonData}>
          <Layer
            id="calculation-area-fill"
            type="fill"
            paint={{
              'fill-color': '#0b63ce',
              'fill-opacity': 0.03
            }}
          />
          <Layer
            id="calculation-area-line"
            type="line"
            paint={{
              'line-color': '#0b63ce',
              'line-width': 2.5,
              'line-dasharray': [2, 1.5]
            }}
          />
        </Source>

        {draftPolygon.length >= 2 && (
          <Source id="draft-area" type="geojson" data={draftData}>
            <Layer
              id="draft-area-line"
              type="line"
              paint={{ 'line-color': '#0b63ce', 'line-width': 3 }}
            />
          </Source>
        )}

        <Source id="barriers" type="geojson" data={barrierData}>
          <Layer
            id="barriers-line"
            type="line"
            paint={{
              'line-color': '#6f42c1',
              'line-width': 5
            }}
          />
        </Source>

        {sources.map(source => (
          <Marker
            key={source.id}
            longitude={source.lon}
            latitude={source.lat}
            draggable
            onDragEnd={e => {
              const { lat, lng } = e.lngLat
              setSources(prev => prev.map(x =>
                x.id === source.id ? { ...x, lat, lon: lng } : x
              ))
            }}
            onClick={e => {
              e.originalEvent.stopPropagation()
              setSelected({ type: 'source', id: source.id })
            }}
          >
            <div className="map-marker source-marker" title={source.name}>S</div>
          </Marker>
        ))}

        {receivers.map(receiver => (
          <Marker
            key={receiver.id}
            longitude={receiver.lon}
            latitude={receiver.lat}
            draggable
            onDragEnd={e => {
              const { lat, lng } = e.lngLat
              setReceivers(prev => prev.map(x =>
                x.id === receiver.id ? { ...x, lat, lon: lng } : x
              ))
            }}
            onClick={e => {
              e.originalEvent.stopPropagation()
              setSelected({ type: 'receiver', id: receiver.id })
            }}
          >
            <div className="map-marker receiver-marker" title={receiver.name}>R</div>
          </Marker>
        ))}

        {barriers.flatMap(barrier => ([
          <Marker
            key={`${barrier.id}-a`}
            longitude={barrier.lon_a}
            latitude={barrier.lat_a}
            draggable
            onDragEnd={e => {
              const { lat, lng } = e.lngLat
              setBarriers(prev => prev.map(x =>
                x.id === barrier.id ? { ...x, lat_a: lat, lon_a: lng } : x
              ))
            }}
          >
            <div
              className="barrier-handle"
              onClick={e => {
                e.stopPropagation()
                setSelected({ type: 'barrier', id: barrier.id })
              }}
            />
          </Marker>,
          <Marker
            key={`${barrier.id}-b`}
            longitude={barrier.lon_b}
            latitude={barrier.lat_b}
            draggable
            onDragEnd={e => {
              const { lat, lng } = e.lngLat
              setBarriers(prev => prev.map(x =>
                x.id === barrier.id ? { ...x, lat_b: lat, lon_b: lng } : x
              ))
            }}
          >
            <div
              className="barrier-handle"
              onClick={e => {
                e.stopPropagation()
                setSelected({ type: 'barrier', id: barrier.id })
              }}
            />
          </Marker>
        ]))}
      </Map>

      <header className="brand-bar">
        <div className="brand-left">
          <img src="https://raw.githubusercontent.com/maaraos-coder/noisemap/main/assets/logo_uc.png" alt="Pontificia Universidad Católica de Chile" />
        </div>
        <div className="brand-center">
          <strong>DIPLOMADO EN ACÚSTICA DE LA EDIFICACIÓN</strong>
          <span>Noise Map Lab</span>
        </div>
        <div className="brand-right">
          <img src="https://raw.githubusercontent.com/maaraos-coder/noisemap/main/assets/logo_decon_uc.png" alt="DECON UC" />
        </div>
      </header>

      <div className="map-toolbar">
        <IconButton active={mode === 'navigate'} title="Navegar" onClick={() => setMode('navigate')}>↔</IconButton>
        <IconButton active={mode === 'source'} title="Agregar fuente" onClick={() => setMode('source')}>S</IconButton>
        <IconButton active={mode === 'receiver'} title="Agregar receptor" onClick={() => setMode('receiver')}>R</IconButton>
        <IconButton active={mode === 'barrier'} title="Dibujar barrera" onClick={() => setMode('barrier')}>╱</IconButton>
        <IconButton active={mode === 'area'} title="Dibujar área de cálculo" onClick={() => {
          setDraftPolygon([])
          setMode('area')
        }}>▱</IconButton>

        {mode === 'area' && draftPolygon.length >= 3 && (
          <button className="tool-action" onClick={finishArea}>Cerrar área</button>
        )}

        {(mode === 'area' || barrierStart) && (
          <button className="tool-action ghost" onClick={cancelDrawing}>Cancelar</button>
        )}
      </div>

      <aside className={`control-panel ${panelOpen ? '' : 'collapsed'}`}>
        <button className="panel-toggle" onClick={() => setPanelOpen(x => !x)}>
          {panelOpen ? '‹' : '›'}
        </button>

        {panelOpen && (
          <>
            <h2>Modelo acústico</h2>

            <label>
              Resolución
              <span>{resolution} × {resolution}</span>
            </label>
            <input
              type="range"
              min="18"
              max="80"
              step="2"
              value={resolution}
              onChange={e => setResolution(Number(e.target.value))}
            />

            <label>
              Altura del mapa
              <span>{height.toFixed(1)} m</span>
            </label>
            <input
              type="range"
              min="0.5"
              max="10"
              step="0.1"
              value={height}
              onChange={e => setHeight(Number(e.target.value))}
            />

            <label>
              Absorción atmosférica
              <span>{alpha.toFixed(1)} dB/km</span>
            </label>
            <input
              type="range"
              min="0"
              max="10"
              step="0.1"
              value={alpha}
              onChange={e => setAlpha(Number(e.target.value))}
            />

            <label>
              Frecuencia
              <select value={frequency} onChange={e => setFrequency(Number(e.target.value))}>
                {[63,125,250,500,1000,2000,4000,8000].map(f => (
                  <option key={f} value={f}>{f} Hz</option>
                ))}
              </select>
            </label>

            <div className="scale-settings">
              <label>
                Mínimo
                <input type="number" value={vmin} onChange={e => setVmin(Number(e.target.value))} />
              </label>
              <label>
                Máximo
                <input type="number" value={vmax} onChange={e => setVmax(Number(e.target.value))} />
              </label>
            </div>

            <button
              className="calculate-button"
              disabled={calculating}
              onClick={calculate}
            >
              {calculating ? 'Calculando…' : dirty ? 'CALCULAR MAPA' : 'MAPA ACTUALIZADO'}
            </button>

            <div className="summary-row">
              <span>{sources.length} fuentes</span>
              <span>{receivers.length} receptores</span>
              <span>{barriers.length} barreras</span>
            </div>

            {result && (
              <div className="result-card">
                <small>Rango calculado</small>
                <strong>
                  {result.min_level?.toFixed(1)} – {result.max_level?.toFixed(1)} dB
                </strong>
              </div>
            )}
          </>
        )}
      </aside>

      <div className="noise-legend">
        <div className="legend-title">dB</div>
        <div className="legend-scale">
          <div className="legend-gradient" />
          <div className="legend-labels">
            {[vmax, vmax - (vmax-vmin)*.25, vmax - (vmax-vmin)*.5, vmax - (vmax-vmin)*.75, vmin].map((v, i) => (
              <span key={i}>{Math.round(v)}</span>
            ))}
          </div>
        </div>
      </div>

      {selectedObject && (
        <div className="object-card">
          <button className="close-card" onClick={() => setSelected(null)}>×</button>
          <h3>{selectedObject.name}</h3>

          {selected.type === 'source' && (
            <>
              <label>Potencia sonora Lw [dB]</label>
              <input
                type="number"
                value={selectedObject.lw_db}
                onChange={e => patchSelected({ lw_db: Number(e.target.value) })}
              />
              <label>Altura [m]</label>
              <input
                type="number"
                step="0.1"
                value={selectedObject.height_m}
                onChange={e => patchSelected({ height_m: Number(e.target.value) })}
              />
              <label>Directividad Dc [dB]</label>
              <input
                type="number"
                step="0.5"
                value={selectedObject.dc_db}
                onChange={e => patchSelected({ dc_db: Number(e.target.value) })}
              />
            </>
          )}

          {selected.type === 'receiver' && (
            <>
              <label>Altura [m]</label>
              <input
                type="number"
                step="0.1"
                value={selectedObject.height_m}
                onChange={e => patchSelected({ height_m: Number(e.target.value) })}
              />
            </>
          )}

          {selected.type === 'barrier' && (
            <>
              <label>Altura superior [m]</label>
              <input
                type="number"
                step="0.1"
                value={selectedObject.height_m}
                onChange={e => patchSelected({ height_m: Number(e.target.value) })}
              />
            </>
          )}

          <button className="delete-button" onClick={removeSelected}>Eliminar</button>
        </div>
      )}

      {mode === 'barrier' && barrierStart && (
        <div className="status-pill">Selecciona el segundo extremo de la barrera</div>
      )}

      {mode === 'area' && (
        <div className="status-pill">
          Haz clic para agregar vértices · {draftPolygon.length} puntos
        </div>
      )}

      <footer className="map-footer">
        Motor educativo · No sustituye una implementación validada de ISO 9613-2
      </footer>
    </div>
  )
}

export default App
