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

const initialSources = [{
  id: crypto.randomUUID(),
  name: 'Fuente 1',
  lat: -33.45670,
  lon: -70.64860,
  height_m: 1.5,
  lw_db: 100,
  dc_db: 0,
  enabled: true,
  spectrum_mode: 'broadband',
  single_frequency_hz: 500,
  octave_levels: {63: 92, 125: 95, 250: 98, 500: 100, 1000: 98, 2000: 94, 4000: 90, 8000: 84},
  adjust_db: 0,
  time_active_pct: 100
}]

const initialReceivers = [{
  id: crypto.randomUUID(),
  name: 'Receptor 1',
  lat: -33.45695,
  lon: -70.64790,
  height_m: 1.5,
  visible: true,
  height_mode: 'map'
}]

const defaultPolygon = [
  [-33.4580, -70.6502],
  [-33.4580, -70.6468],
  [-33.4557, -70.6468],
  [-33.4557, -70.6502]
]

function polygonGeoJSON(points) {
  if (!points || points.length < 3) {
    return { type: 'FeatureCollection', features: [] }
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


function accessoriesGeoJSON(lines) {
  return {
    type: 'FeatureCollection',
    features: lines.map(line => ({
      type: 'Feature',
      properties: { id: line.id, name: line.name, kind: line.kind },
      geometry: { type: 'LineString', coordinates: [[line.lon_a, line.lat_a], [line.lon_b, line.lat_b]] }
    }))
  }
}

function raysGeoJSON(sources, receivers, rayMode) {
  if (rayMode === 'off') return { type: 'FeatureCollection', features: [] }
  const features = []
  sources.filter(s => s.enabled).forEach(source => {
    receivers.filter(r => r.visible !== false).forEach(receiver => {
      features.push({
        type: 'Feature',
        properties: { source: source.name, receiver: receiver.name, mode: rayMode },
        geometry: {
          type: 'LineString',
          coordinates: [[source.lon, source.lat], [receiver.lon, receiver.lat]]
        }
      })
    })
  })
  return { type: 'FeatureCollection', features }
}


function contoursGeoJSON(contours) {
  return {
    type: 'FeatureCollection',
    features: contours
      .filter(c => c.points?.length >= 2)
      .map(c => ({
        type: 'Feature',
        properties: {
          id: c.id,
          name: c.name,
          elevation_m: c.elevation_m
        },
        geometry: {
          type: 'LineString',
          coordinates: c.points.map(([lat, lon]) => [lon, lat])
        }
      }))
  }
}

function lineGeoJSON(points) {
  if (!points || points.length < 2) {
    return { type: 'FeatureCollection', features: [] }
  }
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: points.map(([lat, lon]) => [lon, lat])
      }
    }]
  }
}

function levelColor(value, vmin, vmax) {
  const t = Math.max(0, Math.min(1, (value - vmin) / Math.max(vmax - vmin, 0.001)))
  const scaled = t * (COLORS.length - 1)
  const i = Math.floor(scaled)
  const j = Math.min(COLORS.length - 1, i + 1)
  const f = scaled - i

  const rgb = hex => [
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
  const scale = 6
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  levels.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value === null || Number.isNaN(value)) {
        ctx.clearRect(x * scale, y * scale, scale, scale)
        return
      }
      const [r, g, b] = levelColor(value, vmin, vmax)
      ctx.fillStyle = `rgba(${r},${g},${b},0.70)`
      ctx.fillRect(x * scale, y * scale, scale, scale)
    })
  })

  return canvas.toDataURL('image/png')
}

function haversineMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) *
    Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa))
}


const A_CORRECTIONS = {63:-26.2,125:-16.1,250:-8.6,500:-3.2,1000:0,2000:1.2,4000:1.0,8000:-1.1}

function energeticTotal(values) {
  const finite = values.filter(v => Number.isFinite(v))
  if (!finite.length) return null
  const sum = finite.reduce((acc, v) => acc + Math.pow(10, v / 10), 0)
  return 10 * Math.log10(sum)
}

function sourceEquivalentLevel(source, aWeighting) {
  if (source.spectrum_mode === 'octaves') {
    const vals = Object.entries(source.octave_levels || {}).map(([f, level]) => {
      const correction = aWeighting ? (A_CORRECTIONS[Number(f)] || 0) : 0
      return Number(level) + correction
    })
    return energeticTotal(vals) ?? Number(source.lw_db)
  }
  if (source.spectrum_mode === 'single') {
    const nearest = Object.keys(A_CORRECTIONS)
      .map(Number)
      .sort((a,b) => Math.abs(a - source.single_frequency_hz) - Math.abs(b - source.single_frequency_hz))[0]
    const correction = aWeighting ? (A_CORRECTIONS[nearest] || 0) : 0
    return Number(source.lw_db) + correction
  }
  return Number(source.lw_db)
}

function IconButton({ active, title, icon, label, onClick }) {
  return (
    <button
      className={`tool-button ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
      type="button"
    >
      <span className="tool-icon">{icon}</span>
      <span className="tool-label">{label}</span>
    </button>
  )
}

function App() {
  const mapRef = useRef(null)

  const [mode, setMode] = useState('navigate')
  const [sources, setSources] = useState(initialSources)
  const [receivers, setReceivers] = useState(initialReceivers)
  const [barriers, setBarriers] = useState([])
  const [accessories, setAccessories] = useState([])
  const [contours, setContours] = useState([])
  const [contourDraft, setContourDraft] = useState([])
  const [polygon, setPolygon] = useState(defaultPolygon)
  const [draftPolygon, setDraftPolygon] = useState([])
  const [barrierStart, setBarrierStart] = useState(null)
  const [barrierHover, setBarrierHover] = useState(null)
  const [lineStart, setLineStart] = useState(null)
  const [rayMode, setRayMode] = useState('off')
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [topographyImportOpen, setTopographyImportOpen] = useState(false)
  const [topographyFile, setTopographyFile] = useState(null)
  const [topographyElevationField, setTopographyElevationField] = useState('')
  const [topographyEpsg, setTopographyEpsg] = useState('')
  const [topographyImporting, setTopographyImporting] = useState(false)
  const [topographyImportInfo, setTopographyImportInfo] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [globalSettings, setGlobalSettings] = useState({
    prediction_model: 'ISO 9613-2:2024',
    a_weighting: true,
    ground_factor: 0,
    temperature_c: 15,
    humidity_pct: 70,
    barrier_limit: true,
    vertical_edge_diffraction: true,
    limit_distance: true,
    convex_path: true,
    reflection_order: 'first-second',
    facade_1m: true,
    reflector_size_check: true
  })

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
  const [panelOpen, setPanelOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [layers, setLayers] = useState({
    raster: true,
    sources: true,
    receivers: true,
    barriers: true,
    accessories: true,
    contours: true,
    rays: true,
    area: true
  })

  const barrierData = useMemo(() => barriersGeoJSON(barriers), [barriers])
  const barrierPreviewData = useMemo(() => {
    if (!barrierStart || !barrierHover) return { type: 'FeatureCollection', features: [] }
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [[barrierStart[1], barrierStart[0]], [barrierHover[1], barrierHover[0]]]
        }
      }]
    }
  }, [barrierStart, barrierHover])
  const accessoryData = useMemo(() => accessoriesGeoJSON(accessories), [accessories])
  const contourData = useMemo(() => contoursGeoJSON(contours), [contours])
  const contourDraftData = useMemo(() => lineGeoJSON(contourDraft), [contourDraft])
  const rayData = useMemo(() => raysGeoJSON(sources, receivers, rayMode), [sources, receivers, rayMode])
  const polygonData = useMemo(() => polygonGeoJSON(polygon), [polygon])
  const draftData = useMemo(() => polygonGeoJSON(draftPolygon), [draftPolygon])

  const rasterUrl = useMemo(
    () => rasterDataUrl(result?.levels, vmin, vmax),
    [result, vmin, vmax]
  )

  const legendTicks = useMemo(() => {
    const top = Math.ceil(vmax / 5) * 5
    const bottom = Math.floor(vmin / 5) * 5
    const ticks = []
    for (let v = top; v >= bottom; v -= 5) ticks.push(v)
    return ticks
  }, [vmin, vmax])

  useEffect(() => {
    setDirty(true)
  }, [sources, barriers, contours, polygon, resolution, height, alpha, frequency, vmin, vmax, globalSettings])

  const onMapMouseMove = event => {
    if (mode === 'barrier' && barrierStart) {
      const { lat, lng } = event.lngLat
      setBarrierHover([lat, lng])
    }
  }

  const onMapClick = event => {
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
        enabled: true,
        spectrum_mode: 'broadband',
        single_frequency_hz: 500,
        octave_levels: {63: 92, 125: 95, 250: 98, 500: 100, 1000: 98, 2000: 94, 4000: 90, 8000: 84},
        adjust_db: 0,
        time_active_pct: 100
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
        height_m: 1.5,
        visible: true,
        height_mode: 'map'
      }
      setReceivers(prev => [...prev, item])
      setSelected({ type: 'receiver', id: item.id })
      return
    }

    if (mode === 'barrier') {
      if (!barrierStart) {
        setBarrierStart([lat, lng])
        setBarrierHover([lat, lng])
      } else {
        const item = {
          id: crypto.randomUUID(),
          name: `Barrera ${barriers.length + 1}`,
          lat_a: barrierStart[0],
          lon_a: barrierStart[1],
          lat_b: lat,
          lon_b: lng,
          height_m: 3,
          enabled: true,
          reflection_percent: 0
        }
        setBarriers(prev => [...prev, item])
        setBarrierStart(null)
        setBarrierHover(null)
        setSelected({ type: 'barrier', id: item.id })
      }
      return
    }

    if (mode === 'line') {
      if (!lineStart) {
        setLineStart([lat, lng])
      } else {
        const item = {
          id: crypto.randomUUID(),
          name: `Auxiliar gráfico ${accessories.length + 1}`,
          kind: 'measurement',
          lat_a: lineStart[0],
          lon_a: lineStart[1],
          lat_b: lat,
          lon_b: lng,
          height_m: 0
        }
        setAccessories(prev => [...prev, item])
        setLineStart(null)
      }
      return
    }

    if (mode === 'contour') {
      setContourDraft(prev => [...prev, [lat, lng]])
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
          sources: sources.map(source => ({
            ...source,
            lw_db: sourceEquivalentLevel(source, globalSettings.a_weighting)
          })),
          receivers,
          barriers,
          polygon,
          settings: {
            resolution,
            receiver_height_m: height,
            alpha_db_per_km: alpha,
            frequency_hz: frequency,
            vmin,
            vmax,
            prediction_model: globalSettings.prediction_model,
            a_weighting: globalSettings.a_weighting,
            ground_factor: globalSettings.ground_factor,
            temperature_c: globalSettings.temperature_c,
            humidity_pct: globalSettings.humidity_pct,
            max_barrier_db: globalSettings.barrier_limit ? 20 : 80,
            reflections_enabled: globalSettings.reflection_order !== 'none'
          }
        })
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

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

  const importTopography = async () => {
    if (!topographyFile) return

    setTopographyImporting(true)
    setTopographyImportInfo(null)

    try {
      const form = new FormData()
      form.append('file', topographyFile)
      if (topographyElevationField.trim()) {
        form.append('elevation_field', topographyElevationField.trim())
      }
      if (topographyEpsg.trim()) {
        form.append('source_epsg', topographyEpsg.trim())
      }

      const response = await fetch(`${API_BASE}/api/topography/import`, {
        method: 'POST',
        body: form
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data?.detail || `HTTP ${response.status}`)
      }

      const imported = (data.contours || []).map((item, index) => ({
        id: crypto.randomUUID(),
        name: item.name || `Curva importada ${contours.length + index + 1}`,
        elevation_m: Number(item.elevation_m || 0),
        points: item.points || []
      }))

      setContours(prev => [...prev, ...imported])
      setTopographyImportInfo(data)

      if (data.bounds?.length === 2) {
        const south = Number(data.bounds[0][0])
        const west = Number(data.bounds[0][1])
        const north = Number(data.bounds[1][0])
        const east = Number(data.bounds[1][1])
        mapRef.current?.fitBounds(
          [[west, south], [east, north]],
          { padding: 90, duration: 900 }
        )
      }

      if (imported[0]) {
        setSelected({ type: 'contour', id: imported[0].id })
      }
    } catch (error) {
      console.error(error)
      setTopographyImportInfo({
        error: error.message || 'No fue posible importar la topografía.'
      })
    } finally {
      setTopographyImporting(false)
    }
  }

  const finishContour = () => {
    if (contourDraft.length < 2) return
    const item = {
      id: crypto.randomUUID(),
      name: `Curva de nivel ${contours.length + 1}`,
      elevation_m: 500,
      points: contourDraft
    }
    setContours(prev => [...prev, item])
    setContourDraft([])
    setSelected({ type: 'contour', id: item.id })
    setMode('navigate')
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
    setContourDraft([])
    setBarrierStart(null)
    setBarrierHover(null)
    setLineStart(null)
    setMode('navigate')
  }


  const runSearch = async () => {
    const q = searchText.trim()
    if (!q) return

    const coordinateMatch = q.match(/^\\s*(-?\\d+(?:\\.\\d+)?)\\s*[,; ]\\s*(-?\\d+(?:\\.\\d+)?)\\s*$/)
    if (coordinateMatch) {
      const lat = Number(coordinateMatch[1])
      const lon = Number(coordinateMatch[2])
      mapRef.current?.flyTo({ center: [lon, lat], zoom: 18 })
      setSearchResults([{ display_name: `Coordenadas ${lat.toFixed(6)}, ${lon.toFixed(6)}`, lat, lon }])
      return
    }

    setSearching(true)
    try {
      const response = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(q)}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setSearchResults(data.results || [])
      if (data.results?.[0]) {
        mapRef.current?.flyTo({
          center: [Number(data.results[0].lon), Number(data.results[0].lat)],
          zoom: 17
        })
      }
    } catch (error) {
      console.error(error)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const selectedObject = (() => {
    if (!selected) return null
    if (selected.type === 'source') return sources.find(x => x.id === selected.id)
    if (selected.type === 'receiver') return receivers.find(x => x.id === selected.id)
    if (selected.type === 'barrier') return barriers.find(x => x.id === selected.id)
    if (selected.type === 'contour') return contours.find(x => x.id === selected.id)
    return null
  })()

  const selectedReceiverResult = selected?.type === 'receiver'
    ? result?.receiver_results?.find(item => item.id === selected.id)
    : null

  const nearestReceiverDistance = useMemo(() => {
    if (!selectedObject || selected?.type !== 'source' || receivers.length === 0) return null
    const distances = receivers.map(r => ({
      name: r.name,
      distance: haversineMeters(selectedObject.lat, selectedObject.lon, r.lat, r.lon)
    }))
    return distances.sort((a, b) => a.distance - b.distance)[0]
  }, [selectedObject, selected, receivers])

  const patchSelected = patch => {
    if (!selected) return

    if (selected.type === 'source') {
      setSources(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'receiver') {
      setReceivers(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'barrier') {
      setBarriers(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'contour') {
      setContours(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
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
    } else if (selected.type === 'contour') {
      setContours(prev => prev.filter(x => x.id !== selected.id))
    }
    setSelected(null)
  }

  useEffect(() => {
    const handleKeyDown = event => {
      const activeTag = document.activeElement?.tagName
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)

      if (event.key === 'Escape') {
        if (barrierStart || lineStart || draftPolygon.length || contourDraft.length) {
          cancelDrawing()
        } else if (selected) {
          setSelected(null)
        }
        return
      }

      if (event.key === 'Delete' && selected && !editing) {
        event.preventDefault()
        removeSelected()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, barrierStart, lineStart, draftPolygon, contourDraft])

  const imageCoordinates = result?.bounds
    ? [
        [result.bounds[0][1], result.bounds[1][0]],
        [result.bounds[1][1], result.bounds[1][0]],
        [result.bounds[1][1], result.bounds[0][0]],
        [result.bounds[0][1], result.bounds[0][0]]
      ]
    : null

  const updatePolygonVertex = (index, lat, lon) => {
    setPolygon(prev => prev.map((point, i) => i === index ? [lat, lon] : point))
  }

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
        onMouseMove={onMapMouseMove}
        cursor={mode === 'navigate' ? 'grab' : mode === 'edit-area' ? 'default' : 'crosshair'}
        doubleClickZoom={mode !== 'area'}
      >
        <NavigationControl position="bottom-left" />

        {layers.raster && rasterUrl && imageCoordinates && (
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

        {layers.area && (
          <Source id="calculation-area" type="geojson" data={polygonData}>
            <Layer
              id="calculation-area-fill"
              type="fill"
              paint={{ 'fill-color': '#0b63ce', 'fill-opacity': 0.02 }}
            />
            <Layer
              id="calculation-area-line"
              type="line"
              paint={{
                'line-color': '#0b63ce',
                'line-width': 2.2,
                'line-dasharray': [2, 1.5]
              }}
            />
          </Source>
        )}

        {draftPolygon.length >= 2 && (
          <Source id="draft-area" type="geojson" data={draftData}>
            <Layer
              id="draft-area-line"
              type="line"
              paint={{ 'line-color': '#0b63ce', 'line-width': 3 }}
            />
          </Source>
        )}

        {mode === 'barrier' && barrierStart && barrierHover && (
          <Source id="barrier-preview" type="geojson" data={barrierPreviewData}>
            <Layer
              id="barrier-preview-line"
              type="line"
              paint={{
                'line-color': '#6f42c1',
                'line-width': 3,
                'line-dasharray': [2, 1.5],
                'line-opacity': 0.85
              }}
            />
          </Source>
        )}

        {mode === 'barrier' && barrierStart && barrierHover && (
          <Marker
            longitude={barrierHover[1]}
            latitude={barrierHover[0]}
            anchor="bottom-left"
          >
            <div className="barrier-live-measure">
              {haversineMeters(
                barrierStart[0],
                barrierStart[1],
                barrierHover[0],
                barrierHover[1]
              ).toFixed(1)} m
            </div>
          </Marker>
        )}

        {layers.barriers && (
          <Source id="barriers" type="geojson" data={barrierData}>
            <Layer
              id="barriers-line"
              type="line"
              paint={{ 'line-color': '#6f42c1', 'line-width': 4.5 }}
            />
          </Source>
        )}


        {layers.contours && (
          <Source id="contours" type="geojson" data={contourData}>
            <Layer
              id="contours-line"
              type="line"
              paint={{
                'line-color': '#8b5a2b',
                'line-width': 2.2,
                'line-opacity': 0.9
              }}
            />
          </Source>
        )}

        {mode === 'contour' && contourDraft.length >= 2 && (
          <Source id="contour-draft" type="geojson" data={contourDraftData}>
            <Layer
              id="contour-draft-line"
              type="line"
              paint={{
                'line-color': '#8b5a2b',
                'line-width': 2.5,
                'line-dasharray': [2, 1.5]
              }}
            />
          </Source>
        )}

        {layers.accessories && (
          <Source id="accessories" type="geojson" data={accessoryData}>
            <Layer
              id="accessories-line"
              type="line"
              paint={{
                'line-color': '#222222',
                'line-width': 2,
                'line-dasharray': [3, 2]
              }}
            />
          </Source>
        )}

        {layers.rays && rayMode !== 'off' && (
          <Source id="source-receiver-rays" type="geojson" data={rayData}>
            <Layer
              id="source-receiver-rays-line"
              type="line"
              paint={{
                'line-color': rayMode === 'rays' ? '#111827' : '#0b63ce',
                'line-width': rayMode === 'rays' ? 1.5 : 2.5,
                'line-opacity': 0.65,
                'line-dasharray': rayMode === 'rays' ? [2, 2] : [1, 2]
              }}
            />
          </Source>
        )}

        {layers.sources && sources.map(source => (
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
            <div className="technical-marker source-marker" title={source.name}>
              <span className="source-wave wave-a" />
              <span className="source-wave wave-b" />
              <span className="source-core">F</span>
            </div>
          </Marker>
        ))}

        {layers.receivers && receivers.map(receiver => (
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
            <div className="technical-marker receiver-marker" title={receiver.name}>
              {(() => {
                const receiverResult = result?.receiver_results?.find(item => item.id === receiver.id)
                return receiverResult?.level_db != null ? (
                  <div className="receiver-level-label">
                    {receiverResult.level_db.toFixed(1)} {globalSettings.a_weighting ? 'dB(A)' : 'dB'}
                  </div>
                ) : null
              })()}
              <span className="receiver-ring" />
              <span className="receiver-core">R</span>
            </div>
          </Marker>
        ))}

        {layers.barriers && barriers.flatMap(barrier => ([
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

        {layers.contours && contours.map(contour => {
          const mid = contour.points[Math.floor(contour.points.length / 2)]
          if (!mid) return null
          return (
            <Marker
              key={`contour-label-${contour.id}`}
              longitude={mid[1]}
              latitude={mid[0]}
              anchor="center"
              onClick={e => {
                e.originalEvent.stopPropagation()
                setSelected({ type: 'contour', id: contour.id })
              }}
            >
              <div className="contour-label">{Number(contour.elevation_m).toFixed(0)} m</div>
            </Marker>
          )
        })}

        {mode === 'edit-area' && polygon.map(([lat, lon], index) => (
          <Marker
            key={`polygon-vertex-${index}`}
            longitude={lon}
            latitude={lat}
            draggable
            onDragEnd={e => {
              const { lat: newLat, lng: newLon } = e.lngLat
              updatePolygonVertex(index, newLat, newLon)
            }}
          >
            <div className="area-vertex" title={`Vértice ${index + 1}`} />
          </Marker>
        ))}
      </Map>

      <header className="brand-bar">
        <div className="brand-left">
          <img src="https://raw.githubusercontent.com/maaraos-coder/noisemap/main/assets/logo_uc.png" alt="Pontificia Universidad Católica de Chile" />
        </div>
        <div className="brand-center">
          <strong>HERRAMIENTA DE MAPA DE RUIDO</strong>
          <span>Diplomado en Acústica de la Edificación</span>
        </div>
        <div className="brand-right">
          <img src="https://raw.githubusercontent.com/maaraos-coder/noisemap/main/assets/logo_decon_uc.png" alt="DECON UC" />
        </div>
      </header>

      <div className="object-toolbar">
        <div className="object-toolbar-title">Agregar objetos</div>
        <div className="object-toolbar-actions">
          <IconButton active={mode === 'navigate'} title="Seleccionar / navegar" icon="✥" label="Seleccionar" onClick={() => setMode('navigate')} />
          <IconButton active={mode === 'source'} title="Agregar fuente puntual" icon="◉" label="Fuente (F)" onClick={() => setMode('source')} />
          <IconButton active={mode === 'receiver'} title="Agregar receptor" icon="⌖" label="Receptor (R)" onClick={() => setMode('receiver')} />
          <IconButton active={mode === 'barrier'} title="Dibujar barrera" icon="▰" label="Barrera" onClick={() => setMode('barrier')} />
          <IconButton active={mode === 'line'} title="Auxiliar gráfico: solo dibujo, no participa en el cálculo acústico" icon="⌇" label="Auxiliar" onClick={() => setMode('line')} />
          <IconButton active={mode === 'contour'} title="Dibujar curva de nivel y asignar cota" icon="≋" label="Curva nivel" onClick={() => {
            setContourDraft([])
            setMode('contour')
          }} />
          <IconButton
            active={topographyImportOpen}
            title="Importar curvas de nivel desde Shapefile ZIP, GeoJSON o DXF"
            icon="⇧"
            label="Importar topo"
            onClick={() => {
              setTopographyImportOpen(v => !v)
              setSearchOpen(false)
              setSettingsOpen(false)
              setLayersOpen(false)
            }}
          />
          <IconButton active={mode === 'area'} title="Dibujar área de cálculo" icon="▱" label="Área" onClick={() => {
            setDraftPolygon([])
            setMode('area')
          }} />
          <IconButton active={mode === 'edit-area'} title="Editar área de cálculo" icon="◇" label="Editar" onClick={() => setMode('edit-area')} />
          {mode === 'contour' && contourDraft.length >= 2 && (
            <button
              type="button"
              className="bottom-context-action finish"
              onClick={finishContour}
              title="Finalizar curva de nivel"
            >
              <span className="context-icon">✓</span>
              <span>Finalizar curva</span>
            </button>
          )}

          {mode === 'area' && draftPolygon.length >= 3 && (
            <button
              type="button"
              className="bottom-context-action finish"
              onClick={finishArea}
              title="Cerrar área de cálculo"
            >
              <span className="context-icon">✓</span>
              <span>Cerrar área</span>
            </button>
          )}

          {(mode === 'contour' || mode === 'area' || barrierStart || lineStart) && (
            <button
              type="button"
              className="bottom-context-action cancel"
              onClick={cancelDrawing}
              title="Cancelar dibujo actual"
            >
              <span className="context-icon">×</span>
              <span>Cancelar</span>
            </button>
          )}

          <button
            type="button"
            className={`bottom-calculate ${dirty ? 'dirty' : 'clean'}`}
            onClick={calculate}
            disabled={calculating}
            title="Calcular o actualizar el mapa de ruido"
          >
            <span className="calc-icon">▶</span>
            <span>{calculating ? 'Calculando…' : dirty ? 'Calcular mapa' : 'Mapa actualizado'}</span>
          </button>
          {selectedObject && (
            <button
              type="button"
              className="bottom-delete"
              onClick={removeSelected}
              title="Eliminar objeto seleccionado (Supr/Delete)"
            >
              <span className="delete-icon">⌫</span>
              <span>Eliminar</span>
            </button>
          )}
        </div>

      </div>

      <div className="utility-toolbar">
        <button
          type="button"
          className={searchOpen ? 'active' : ''}
          title="Buscar dirección o coordenadas"
          onClick={() => {
            setSearchOpen(v => !v)
            setSettingsOpen(false)
            setLayersOpen(false)
            setTopographyImportOpen(false)
          }}
        >
          <span>⌕</span><small>Buscar</small>
        </button>
        <button
          type="button"
          className={layersOpen ? 'active' : ''}
          title="Capas del mapa"
          onClick={() => {
            setLayersOpen(v => !v)
            setSearchOpen(false)
            setSettingsOpen(false)
            setTopographyImportOpen(false)
          }}
        >
          <span>☷</span><small>Capas</small>
        </button>
        <button
          type="button"
          className={resultsOpen ? 'active' : ''}
          title="Resultados en receptores"
          onClick={() => {
            setResultsOpen(v => !v)
            setSearchOpen(false)
            setSettingsOpen(false)
            setLayersOpen(false)
            setTopographyImportOpen(false)
          }}
        >
          <span>▦</span><small>Resultados</small>
        </button>
        <button
          type="button"
          className={panelOpen ? 'active' : ''}
          title="Modelo acústico"
          onClick={() => setPanelOpen(v => !v)}
        >
          <span>≋</span><small>Modelo</small>
        </button>
        <button
          type="button"
          className={settingsOpen ? 'active' : ''}
          title="Configuración global"
          onClick={() => {
            setSettingsOpen(v => !v)
            setSearchOpen(false)
            setLayersOpen(false)
            setTopographyImportOpen(false)
          }}
        >
          <span>⚙</span><small>General</small>
        </button>
      </div>

      {dirty && result && (
        <div className="dirty-chip floating-dirty" title="Hay cambios que aún no están reflejados en el mapa calculado">
          ● Cambios sin calcular
        </div>
      )}

      {layersOpen && (
        <div className="layers-popover">
          <div className="popover-title">Capas</div>
          {[
            ['raster', 'Mapa de ruido'],
            ['sources', 'Fuentes'],
            ['receivers', 'Receptores'],
            ['barriers', 'Barreras'],
            ['accessories', 'Líneas auxiliares'],
            ['contours', 'Curvas de nivel'],
            ['rays', 'Rayos fuente–receptor'],
            ['area', 'Área de cálculo']
          ].map(([key, label]) => (
            <label key={key} className="layer-row">
              <input
                type="checkbox"
                checked={layers[key]}
                onChange={() => setLayers(prev => ({ ...prev, [key]: !prev[key] }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}


      {topographyImportOpen && (
        <div className="floating-dialog topo-import-dialog">
          <div className="dialog-header">
            <div>
              <span className="eyebrow">TOPOGRAFÍA</span>
              <h3>Importar curvas de nivel</h3>
            </div>
            <button onClick={() => setTopographyImportOpen(false)}>×</button>
          </div>

          <div className="topo-format-note">
            Formatos: <b>ZIP Shapefile</b>, <b>GeoJSON</b> y <b>DXF</b>.
          </div>

          <label className="topo-file-field">
            Archivo
            <input
              type="file"
              accept=".zip,.geojson,.json,.dxf"
              onChange={e => {
                setTopographyFile(e.target.files?.[0] || null)
                setTopographyImportInfo(null)
              }}
            />
          </label>

          <div className="topo-import-grid">
            <label>
              Campo de cota
              <input
                type="text"
                value={topographyElevationField}
                onChange={e => setTopographyElevationField(e.target.value)}
                placeholder="Auto (COTA, ELEV, Z...)"
              />
            </label>
            <label>
              EPSG de origen
              <input
                type="number"
                value={topographyEpsg}
                onChange={e => setTopographyEpsg(e.target.value)}
                placeholder="Ej. 32719"
              />
            </label>
          </div>

          <div className="topo-help">
            Para Shapefile, sube un ZIP con .shp, .shx, .dbf y preferentemente .prj.
            El EPSG normalmente solo es necesario si falta el .prj o si el DXF usa coordenadas proyectadas.
          </div>

          <button
            type="button"
            className="topo-import-button"
            onClick={importTopography}
            disabled={!topographyFile || topographyImporting}
          >
            {topographyImporting ? 'Importando…' : 'Importar topografía'}
          </button>

          {topographyImportInfo?.error && (
            <div className="topo-import-result error">
              {topographyImportInfo.error}
            </div>
          )}

          {topographyImportInfo && !topographyImportInfo.error && (
            <div className="topo-import-result success">
              <strong>{topographyImportInfo.count} curvas importadas</strong>
              <span>
                {topographyImportInfo.source_type}
                {topographyImportInfo.elevation_field
                  ? ` · cota: ${topographyImportInfo.elevation_field}`
                  : ''}
              </span>
              {(topographyImportInfo.warnings || []).map((warning, index) => (
                <small key={index}>{warning}</small>
              ))}
            </div>
          )}
        </div>
      )}

      {resultsOpen && (
        <div className="floating-dialog results-dialog">
          <div className="dialog-header">
            <div>
              <span className="eyebrow">RESULTADOS</span>
              <h3>Receptores del mapa</h3>
            </div>
            <button onClick={() => setResultsOpen(false)}>×</button>
          </div>

          {!result?.receiver_results?.length ? (
            <div className="results-empty">
              Calcula el mapa para obtener niveles y contribuciones en los receptores.
            </div>
          ) : (
            <>
              <div className="results-table-wrap">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th>Receptor</th>
                      <th>Altura</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.receiver_results.map(row => (
                      <tr key={row.id}>
                        <td>{row.name}</td>
                        <td>{Number(row.height_m).toFixed(1)} m</td>
                        <td><strong>{row.level_db != null ? row.level_db.toFixed(1) : '—'} {globalSettings.a_weighting ? 'dB(A)' : 'dB'}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="results-subtitle">Contribución por fuente</h4>
              <div className="results-table-wrap contribution-wrap">
                <table className="results-table contribution-table">
                  <thead>
                    <tr>
                      <th>Receptor</th>
                      {sources.filter(s => s.enabled).map(source => (
                        <th key={source.id}>{source.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.receiver_results.map(row => (
                      <tr key={row.id}>
                        <td>{row.name}</td>
                        {sources.filter(s => s.enabled).map(source => {
                          const contribution = row.contributions?.find(item => item.source_id === source.id)
                          return (
                            <td key={source.id}>
                              {contribution?.level_db != null ? contribution.level_db.toFixed(1) : '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="results-note">
                Las contribuciones corresponden al nivel de cada fuente considerada individualmente en el mismo receptor y con las mismas barreras y parámetros del modelo.
              </div>
            </>
          )}
        </div>
      )}

      {searchOpen && (
        <div className="floating-dialog search-dialog">
          <div className="dialog-header">
            <div>
              <span className="eyebrow">UBICACIÓN</span>
              <h3>Buscar dirección o coordenadas</h3>
            </div>
            <button onClick={() => setSearchOpen(false)}>×</button>
          </div>
          <div className="search-row">
            <input
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder="Dirección, comuna o -33.45, -70.65"
            />
            <button onClick={runSearch}>{searching ? '…' : 'Buscar'}</button>
          </div>
          <div className="search-results">
            {searchResults.slice(0, 5).map((item, index) => (
              <button
                key={index}
                onClick={() => mapRef.current?.flyTo({ center: [Number(item.lon), Number(item.lat)], zoom: 18 })}
              >
                <strong>{item.display_name}</strong>
                <span>{Number(item.lat).toFixed(6)}, {Number(item.lon).toFixed(6)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="floating-dialog settings-dialog">
          <div className="dialog-header">
            <div>
              <span className="eyebrow">CONFIGURACIÓN GLOBAL</span>
              <h3>Modelo de predicción</h3>
            </div>
            <button onClick={() => setSettingsOpen(false)}>×</button>
          </div>

          <div className="settings-section">
            <label>Método general
              <select
                value={globalSettings.prediction_model}
                onChange={e => setGlobalSettings(s => ({ ...s, prediction_model: e.target.value }))}
              >
                <option>ISO 9613-2:2024</option>
                <option>ISO 9613-2:1996</option>
              </select>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={globalSettings.a_weighting}
                onChange={e => setGlobalSettings(s => ({ ...s, a_weighting: e.target.checked }))} />
              Ponderación A
            </label>
          </div>

          <div className="settings-section">
            <h4>Efecto de suelo</h4>
            <label>Factor de suelo (G)
              <input type="number" min="0" max="1" step="0.1" value={globalSettings.ground_factor}
                onChange={e => setGlobalSettings(s => ({ ...s, ground_factor: Number(e.target.value) }))} />
            </label>
            <div className="future-note">Preparado para el motor espectral; todavía no modifica el cálculo V3.</div>
          </div>

          <div className="settings-section two-cols">
            <label>Temperatura [°C]
              <input type="number" value={globalSettings.temperature_c}
                onChange={e => setGlobalSettings(s => ({ ...s, temperature_c: Number(e.target.value) }))} />
            </label>
            <label>Humedad [%]
              <input type="number" min="0" max="100" value={globalSettings.humidity_pct}
                onChange={e => setGlobalSettings(s => ({ ...s, humidity_pct: Number(e.target.value) }))} />
            </label>
          </div>

          <div className="settings-section">
            <h4>Atenuación por barreras</h4>
            {[
              ['barrier_limit', 'Aplicar límite de atenuación'],
              ['vertical_edge_diffraction', 'Difracción por borde vertical'],
              ['limit_distance', 'Limitar distancia'],
              ['convex_path', 'Trayectoria convexa']
            ].map(([key, label]) => (
              <label className="check-row" key={key}>
                <input type="checkbox" checked={globalSettings[key]}
                  onChange={e => setGlobalSettings(s => ({ ...s, [key]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>

          <div className="settings-section">
            <h4>Reflexiones</h4>
            <label>Orden
              <select value={globalSettings.reflection_order}
                onChange={e => setGlobalSettings(s => ({ ...s, reflection_order: e.target.value }))}>
                <option value="none">Ninguna</option>
                <option value="first">Primer orden</option>
                <option value="first-second">Primer y segundo orden</option>
              </select>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={globalSettings.facade_1m}
                onChange={e => setGlobalSettings(s => ({ ...s, facade_1m: e.target.checked }))} />
              Fachada a 1 m
            </label>
            <div className="future-note">La interfaz ya almacena estas opciones; las reflexiones se incorporarán al motor físico en la siguiente etapa.</div>
          </div>

          <div className="settings-section">
            <h4>Rayo fuente–receptor</h4>
            <div className="segmented">
              {['off','rays','waves'].map(value => (
                <button key={value} className={rayMode === value ? 'active' : ''}
                  onClick={() => setRayMode(value)}>
                  {value === 'off' ? 'Off' : value === 'rays' ? 'Rayos' : 'Ondas'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <aside className={`control-panel ${panelOpen ? 'open' : 'closed'}`}>
        {panelOpen && (
          <>
            <div className="panel-heading">
              <div>
                <span className="eyebrow">PROPAGACIÓN EXTERIOR</span>
                <h2>Modelo acústico</h2>
              </div>
              <span className={`model-state ${dirty ? 'dirty' : 'clean'}`}>
                {dirty ? 'Modificado' : 'Actualizado'}
              </span>
            </div>

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

            <div className="scale-section">
              <div className="scale-section-title">
                Escala de colores
                <span>{globalSettings.a_weighting ? 'dB(A)' : 'dB'}</span>
              </div>
              <div className="scale-settings">
                <label>
                  Límite inferior
                  <input type="number" value={vmin} onChange={e => setVmin(Number(e.target.value))} />
                </label>
                <label>
                  Límite superior
                  <input type="number" value={vmax} onChange={e => setVmax(Number(e.target.value))} />
                </label>
              </div>
              <div className="scale-help">
                Solo define los colores del mapa; no limita el cálculo acústico.
              </div>
            </div>

            <button
              className={`calculate-button ${dirty ? 'needs-update' : ''}`}
              disabled={calculating}
              onClick={calculate}
            >
              {calculating ? 'Calculando…' : dirty ? 'ACTUALIZAR MAPA' : 'MAPA ACTUALIZADO'}
            </button>

            <div className="summary-row">
              <span><b>{sources.length}</b> fuentes</span>
              <span><b>{receivers.length}</b> receptores</span>
              <span><b>{barriers.length}</b> barreras</span>
            </div>

            {result && (
              <div className="result-card">
                <small>Rango calculado</small>
                <strong>{result.min_level?.toFixed(1)} – {result.max_level?.toFixed(1)} dB</strong>
              </div>
            )}
          </>
        )}
      </aside>

      <div className="noise-legend">
        <div className="legend-title">{globalSettings.a_weighting ? 'dB(A)' : 'dB'}</div>
        <div
          className="legend-scale"
          style={{
            height: `${Math.max(205, legendTicks.length * 21)}px`,
            '--legend-steps': Math.max(1, legendTicks.length - 1)
          }}
        >
          <div className="legend-gradient" />
          <div className="legend-labels">
            {legendTicks.map(v => <span key={v}>{v}</span>)}
          </div>
        </div>
        <div className="legend-note">
          Nivel calculado · {globalSettings.a_weighting ? 'ponderación A' : 'sin ponderación A'}
        </div>
      </div>

      {selectedObject && (
        <div className="object-card advanced-object-card">
          <button className="close-card" onClick={() => setSelected(null)}>×</button>
          <div className="object-type">
            {selected.type === 'source'
              ? 'FUENTE PUNTUAL'
              : selected.type === 'receiver'
                ? 'RECEPTOR'
                : selected.type === 'barrier'
                  ? 'BARRERA'
                  : 'CURVA DE NIVEL'}
          </div>
          <h3>{selectedObject.name}</h3>

          {(selected.type === 'source' || selected.type === 'receiver') && (
            <div className="coordinate-row">
              <span>{selectedObject.lat.toFixed(6)}</span>
              <span>{selectedObject.lon.toFixed(6)}</span>
            </div>
          )}

          {selected.type === 'source' && (
            <>
              <div className="status-toggle">
                <button className={!selectedObject.enabled ? 'active off' : ''} onClick={() => patchSelected({ enabled:false })}>Off</button>
                <button className={selectedObject.enabled ? 'active on' : ''} onClick={() => patchSelected({ enabled:true })}>On</button>
              </div>

              <label>Altura [m]</label>
              <input type="number" step="0.1" value={selectedObject.height_m}
                onChange={e => patchSelected({ height_m:Number(e.target.value) })} />

              <div className="spectrum-tabs">
                {[
                  ['broadband','Broadband'],
                  ['single','Single'],
                  ['octaves','Octavas']
                ].map(([value,label]) => (
                  <button key={value}
                    className={selectedObject.spectrum_mode === value ? 'active' : ''}
                    onClick={() => patchSelected({ spectrum_mode:value })}>
                    {label}
                  </button>
                ))}
              </div>

              <h4 className="subheading">Niveles de potencia sonora</h4>

              {selectedObject.spectrum_mode === 'broadband' && (
                <div className="inline-field">
                  <span>LwA</span>
                  <input type="number" value={selectedObject.lw_db}
                    onChange={e => patchSelected({ lw_db:Number(e.target.value) })} />
                  <b>dB(A)</b>
                </div>
              )}

              {selectedObject.spectrum_mode === 'single' && (
                <>
                  <div className="inline-field">
                    <span>Frecuencia</span>
                    <input type="number" value={selectedObject.single_frequency_hz}
                      onChange={e => patchSelected({ single_frequency_hz:Number(e.target.value) })} />
                    <b>Hz</b>
                  </div>
                  <div className="inline-field">
                    <span>Nivel</span>
                    <input type="number" value={selectedObject.lw_db}
                      onChange={e => patchSelected({ lw_db:Number(e.target.value) })} />
                    <b>dB</b>
                  </div>
                  <div className="calculated-field">
                    <span>Equivalente {globalSettings.a_weighting ? 'A' : 'Z'}</span>
                    <strong>{sourceEquivalentLevel(selectedObject, globalSettings.a_weighting).toFixed(1)} dB</strong>
                  </div>
                </>
              )}

              {selectedObject.spectrum_mode === 'octaves' && (
                <>
                  <div className="octave-grid">
                    {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                      <label key={freq}>
                        <span>{freq >= 1000 ? freq/1000 + 'k' : freq}</span>
                        <input type="number"
                          value={selectedObject.octave_levels?.[freq] ?? ''}
                          onChange={e => patchSelected({
                            octave_levels:{
                              ...(selectedObject.octave_levels || {}),
                              [freq]:Number(e.target.value)
                            }
                          })} />
                      </label>
                    ))}
                  </div>
                  <div className="calculated-field">
                    <span>Total energético {globalSettings.a_weighting ? 'A' : 'Z'}</span>
                    <strong>{sourceEquivalentLevel(selectedObject, globalSettings.a_weighting).toFixed(1)} dB</strong>
                  </div>
                </>
              )}

              <div className="two-field-grid">
                <label>Ajuste [dB]
                  <input type="number" step="0.5" value={selectedObject.adjust_db}
                    onChange={e => patchSelected({ adjust_db:Number(e.target.value) })} />
                </label>
                <label>% tiempo activo
                  <input type="number" min="0.1" max="100" value={selectedObject.time_active_pct}
                    onChange={e => patchSelected({ time_active_pct:Number(e.target.value) })} />
                </label>
              </div>

              <label>Directividad Dc [dB]</label>
              <input type="number" step="0.5" value={selectedObject.dc_db}
                onChange={e => patchSelected({ dc_db:Number(e.target.value) })} />

              {nearestReceiverDistance && (
                <div className="distance-card">
                  <span>Receptor más cercano</span>
                  <strong>{nearestReceiverDistance.name}</strong>
                  <b>{nearestReceiverDistance.distance.toFixed(1)} m</b>
                </div>
              )}

              <div className="engine-note">
                Octavas y Single se reducen a un nivel equivalente para el motor V3. La propagación espectral por banda se incorporará en el motor V4.
              </div>
            </>
          )}

          {selected.type === 'receiver' && (
            <>
              <div className="status-toggle">
                <button className={selectedObject.visible === false ? 'active off' : ''} onClick={() => patchSelected({ visible:false })}>Oculto</button>
                <button className={selectedObject.visible !== false ? 'active on' : ''} onClick={() => patchSelected({ visible:true })}>Visible</button>
              </div>

              <div className="spectrum-tabs">
                <button className={selectedObject.height_mode === 'map' ? 'active' : ''} onClick={() => patchSelected({ height_mode:'map', height_m:height })}>Igualar mapa</button>
                <button className={selectedObject.height_mode === 'specify' ? 'active' : ''} onClick={() => patchSelected({ height_mode:'specify' })}>Especificar</button>
              </div>

              <label>Altura [m]</label>
              <input type="number" step="0.1" value={selectedObject.height_m}
                disabled={selectedObject.height_mode === 'map'}
                onChange={e => patchSelected({ height_m:Number(e.target.value) })} />

              <h4 className="subheading">Resultado de presión sonora</h4>
              <div className="receiver-result">
                <span>Nivel total</span>
                <strong>
                  {selectedReceiverResult?.level_db != null
                    ? selectedReceiverResult.level_db.toFixed(1) + ' dB'
                    : 'Sin calcular'}
                </strong>
              </div>
              <div className="engine-note">El resultado puntual se actualiza cada vez que calculas el mapa.</div>
            </>
          )}

          {selected.type === 'barrier' && (
            <>
              <div className="status-toggle">
                <button className={!selectedObject.enabled ? 'active off' : ''} onClick={() => patchSelected({ enabled:false })}>Off</button>
                <button className={selectedObject.enabled ? 'active on' : ''} onClick={() => patchSelected({ enabled:true })}>On</button>
              </div>
              <div className="calculated-field">
                <span>Longitud</span>
                <strong>{haversineMeters(selectedObject.lat_a, selectedObject.lon_a, selectedObject.lat_b, selectedObject.lon_b).toFixed(1)} m</strong>
              </div>
              <label>Altura superior [m]</label>
              <input type="number" step="0.1" value={selectedObject.height_m}
                onChange={e => patchSelected({ height_m:Number(e.target.value) })} />

              <h4 className="subheading">Reflexiones</h4>
              <div className="segmented">
                {[0,50,100].map(value => (
                  <button key={value}
                    className={(selectedObject.reflection_percent || 0) === value ? 'active' : ''}
                    onClick={() => patchSelected({ reflection_percent:value })}>
                    {value === 0 ? 'Ninguna' : value + '%'}
                  </button>
                ))}
              </div>
              <div className="engine-note">La atenuación por barrera sí participa en V3. La reflexión de la superficie queda almacenada para el motor con reflexiones.</div>
            </>
          )}

          {selected.type === 'contour' && (
            <>
              <div className="calculated-field">
                <span>Tipo</span>
                <strong>Topografía</strong>
              </div>
              <label>Cota [m s.n.m.]</label>
              <input
                type="number"
                step="0.1"
                value={selectedObject.elevation_m}
                onChange={e => patchSelected({ elevation_m: Number(e.target.value) })}
              />
              <div className="calculated-field">
                <span>Vértices</span>
                <strong>{selectedObject.points.length}</strong>
              </div>
              <div className="engine-note">
                Esta curva representa una cota del terreno. En la siguiente etapa se usará junto con las demás curvas para interpolar la superficie topográfica y obtener perfiles F–R.
              </div>
            </>
          )}

          <button className="delete-button" onClick={removeSelected}>Eliminar elemento</button>
        </div>
      )}

      {mode === 'barrier' && barrierStart && (
        <div className="status-pill barrier-length-pill">
          Barrera · {barrierHover
            ? haversineMeters(barrierStart[0], barrierStart[1], barrierHover[0], barrierHover[1]).toFixed(1)
            : '0.0'} m · selecciona el segundo extremo
        </div>
      )}

      {mode === 'line' && lineStart && (
        <div className="status-pill">Auxiliar gráfico · selecciona el segundo extremo · no afecta el cálculo acústico</div>
      )}

      {mode === 'contour' && (
        <div className="status-pill">
          Curva de nivel · {contourDraft.length} vértices · haz clic para seguir trazando y pulsa “Finalizar curva”
        </div>
      )}

      {mode === 'area' && (
        <div className="status-pill">
          Haz clic para agregar vértices · {draftPolygon.length} puntos
        </div>
      )}

      {mode === 'edit-area' && (
        <div className="status-pill">Arrastra los vértices azules para editar el área de cálculo</div>
      )}

      <footer className="map-footer">
        Motor educativo · No sustituye una implementación validada de ISO 9613-2
      </footer>
    </div>
  )
}

export default App
