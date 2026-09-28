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


function sourceMarkerLabel(source, aWeighting) {
  if (source.spectrum_mode === 'single') {
    return {
      main: `${Number(source.lw_db).toFixed(1)} dB`,
      sub: `${Number(source.single_frequency_hz).toFixed(0)} Hz`
    }
  }

  if (source.spectrum_mode === 'octaves') {
    const total = sourceEquivalentLevel(source, aWeighting)
    return {
      main: `${total.toFixed(1)} ${aWeighting ? 'dB(A)' : 'dB'}`,
      sub: 'Octavas'
    }
  }

  return {
    main: `${Number(source.lw_db).toFixed(1)} dB(A)`,
    sub: 'Broadband'
  }
}


function profileGeometryReference(source, receiver, barrier) {
  const R = 6371000
  const lat0 = (source.lat + receiver.lat + barrier.lat_a + barrier.lat_b) / 4
  const lon0 = (source.lon + receiver.lon + barrier.lon_a + barrier.lon_b) / 4
  const lat0r = lat0 * Math.PI / 180

  const toXY = (lat, lon) => ({
    x: R * ((lon - lon0) * Math.PI / 180) * Math.cos(lat0r),
    y: R * ((lat - lat0) * Math.PI / 180)
  })
  const toLatLon = (x, y) => ({
    lat: lat0 + (y / R) * 180 / Math.PI,
    lon: lon0 + (x / (R * Math.max(Math.cos(lat0r), 1e-9))) * 180 / Math.PI
  })

  const s = toXY(source.lat, source.lon)
  const r = toXY(receiver.lat, receiver.lon)
  const a = toXY(barrier.lat_a, barrier.lon_a)
  const b = toXY(barrier.lat_b, barrier.lon_b)

  const vx = r.x - s.x
  const vy = r.y - s.y
  const total = Math.max(Math.hypot(vx, vy), 0.001)
  const ux = vx / total
  const uy = vy / total

  const wx = b.x - a.x
  const wy = b.y - a.y
  const den = vx * wy - vy * wx
  let t = 0.5

  if (Math.abs(den) > 1e-9) {
    const qx = a.x - s.x
    const qy = a.y - s.y
    const candidate = (qx * wy - qy * wx) / den
    if (Number.isFinite(candidate)) t = Math.max(0, Math.min(1, candidate))
  } else {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    t = Math.max(0, Math.min(1, ((mx - s.x) * vx + (my - s.y) * vy) / (total * total)))
  }

  const anchorX = s.x + vx * t
  const anchorY = s.y + vy * t

  return {
    lat0,
    lon0,
    ux,
    uy,
    anchorX,
    anchorY,
    source_to_barrier_m: total * t,
    source_to_receiver_m: total,
    toLatLon
  }
}

function draftProfileCoordinates(draft) {
  if (!draft?.geometryRef) return null
  const g = draft.geometryRef
  const fb = Math.max(0.1, Number(draft.source_to_barrier_m) || 0.1)
  const fr = Math.max(fb + 0.1, Number(draft.source_to_receiver_m) || fb + 0.1)

  const sx = g.anchorX - g.ux * fb
  const sy = g.anchorY - g.uy * fb
  const rx = g.anchorX + g.ux * (fr - fb)
  const ry = g.anchorY + g.uy * (fr - fb)

  return {
    source: g.toLatLon(sx, sy),
    receiver: g.toLatLon(rx, ry)
  }
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
  const projectFileInputRef = useRef(null)

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
  const [calculationStatus, setCalculationStatus] = useState('')
  const [dirty, setDirty] = useState(true)
  const [selected, setSelected] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [projectMessage, setProjectMessage] = useState('')
  const [barrierProfileOpen, setBarrierProfileOpen] = useState(false)
  const [profileSourceId, setProfileSourceId] = useState('')
  const [profileReceiverId, setProfileReceiverId] = useState('')
  const [barrierProfile, setBarrierProfile] = useState(null)
  const [barrierProfileLoading, setBarrierProfileLoading] = useState(false)
  const [profileDraft, setProfileDraft] = useState(null)
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

  const saveProject = () => {
    const payload = {
      format: 'NoiseMapUCProject',
      version: 1,
      saved_at: new Date().toISOString(),
      app_engine: 'V4 spectral',
      data: {
        sources,
        receivers,
        barriers,
        accessories,
        contours,
        polygon,
        rayMode,
        globalSettings,
        resolution,
        height,
        alpha,
        frequency,
        vmin,
        vmax,
        layers,
        result
      }
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `proyecto-mapa-ruido-${stamp}.noisemap.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setProjectMessage('Proyecto guardado. Conserva este archivo para continuar más adelante.')
  }

  const loadProjectFile = async event => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const payload = JSON.parse(text)

      if (payload?.format !== 'NoiseMapUCProject' || !payload?.data) {
        throw new Error('El archivo no corresponde a un proyecto válido de la herramienta.')
      }

      const data = payload.data
      if (!Array.isArray(data.sources) || !Array.isArray(data.receivers) || !Array.isArray(data.polygon)) {
        throw new Error('El proyecto está incompleto o dañado.')
      }

      setSources(data.sources)
      setReceivers(data.receivers)
      setBarriers(Array.isArray(data.barriers) ? data.barriers : [])
      setAccessories(Array.isArray(data.accessories) ? data.accessories : [])
      setContours(Array.isArray(data.contours) ? data.contours : [])
      setPolygon(data.polygon)
      setRayMode(data.rayMode || 'off')
      if (data.globalSettings) setGlobalSettings(data.globalSettings)
      if (Number.isFinite(Number(data.resolution))) setResolution(Number(data.resolution))
      if (Number.isFinite(Number(data.height))) setHeight(Number(data.height))
      if (Number.isFinite(Number(data.alpha))) setAlpha(Number(data.alpha))
      if (Number.isFinite(Number(data.frequency))) setFrequency(Number(data.frequency))
      if (Number.isFinite(Number(data.vmin))) setVmin(Number(data.vmin))
      if (Number.isFinite(Number(data.vmax))) setVmax(Number(data.vmax))
      if (data.layers) setLayers(data.layers)
      setResult(data.result || null)

      setSelected(null)
      setMode('navigate')
      setDraftPolygon([])
      setContourDraft([])
      setBarrierStart(null)
      setBarrierHover(null)
      setLineStart(null)
      setProjectMessage(
        data.result
          ? 'Proyecto cargado con su último cálculo. Si modificas algo, vuelve a calcular el mapa.'
          : 'Proyecto cargado correctamente.'
      )

      if (data.polygon.length >= 3) {
        const lats = data.polygon.map(p => Number(p[0])).filter(Number.isFinite)
        const lons = data.polygon.map(p => Number(p[1])).filter(Number.isFinite)
        if (lats.length && lons.length) {
          mapRef.current?.fitBounds(
            [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
            { padding: 90, duration: 900 }
          )
        }
      }
    } catch (error) {
      console.error(error)
      setProjectMessage(error.message || 'No fue posible abrir el proyecto.')
    } finally {
      event.target.value = ''
    }
  }

  const calculate = async () => {
    if (!sources.some(s => s.enabled)) return

    const cleanPolygon = polygon
      .map(point => [Number(point?.[0]), Number(point?.[1])])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
      .filter((point, index, arr) => (
        index === 0 ||
        point[0] !== arr[index - 1][0] ||
        point[1] !== arr[index - 1][1]
      ))

    const uniquePoints = new Set(cleanPolygon.map(([lat, lon]) => `${lat.toFixed(9)},${lon.toFixed(9)}`))
    if (cleanPolygon.length < 3 || uniquePoints.size < 3) {
      alert('El área de cálculo necesita al menos 3 vértices distintos.')
      return
    }

    setMode('navigate')
    setDraftPolygon([])
    setCalculating(true)
    setCalculationStatus('Preparando cálculo…')

    const payload = {
      sources,
      receivers,
      barriers,
      polygon: cleanPolygon,
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
    }

    const runRequest = async () => {
      const response = await fetch(`${API_BASE}/api/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        let detail = ''
        try {
          const errorPayload = await response.json()
          detail = errorPayload?.detail ? `: ${errorPayload.detail}` : ''
        } catch {
          // response body is not JSON
        }
        const error = new Error(`HTTP ${response.status}${detail}`)
        error.status = response.status
        throw error
      }

      return response.json()
    }

    try {
      // Render Free may need ~50 s to wake after inactivity.
      // Probe health first and keep retrying transient 502/503/504 responses.
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

      const wakeBackend = async () => {
        const delays = [0, 8000, 12000, 15000, 18000]
        let lastError = null

        for (let i = 0; i < delays.length; i += 1) {
          if (delays[i]) await wait(delays[i])
          setCalculationStatus(
            i === 0
              ? 'Iniciando motor acústico…'
              : `Despertando servidor… intento ${i + 1}/${delays.length}`
          )

          try {
            const health = await fetch(`${API_BASE}/api/health`, {
              method: 'GET',
              cache: 'no-store'
            })
            if (health.ok) return
            lastError = new Error(`Health HTTP ${health.status}`)
          } catch (error) {
            lastError = error
          }
        }

        throw lastError || new Error('El servidor no respondió al iniciar.')
      }

      await wakeBackend()
      setCalculationStatus('Calculando mapa de ruido…')

      let data
      const requestDelays = [0, 5000, 10000]
      let lastError = null

      for (let i = 0; i < requestDelays.length; i += 1) {
        if (requestDelays[i]) await wait(requestDelays[i])
        try {
          data = await runRequest()
          lastError = null
          break
        } catch (error) {
          lastError = error
          const retryable = !error.status || [502, 503, 504].includes(error.status)
          if (!retryable) throw error
          setCalculationStatus(`Reintentando cálculo… ${i + 2}/${requestDelays.length}`)
        }
      }

      if (!data) throw lastError || new Error('No se recibió respuesta del motor.')

      setPolygon(cleanPolygon)
      setResult(data)
      setDirty(false)
      setCalculationStatus('')
    } catch (error) {
      console.error('Error al calcular mapa:', error)
      setCalculationStatus('')
      alert(`No fue posible calcular el mapa. ${error.message || 'Error desconocido.'}`)
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

  useEffect(() => {
    if (selected?.type !== 'barrier') return
    if (!profileSourceId && sources[0]) setProfileSourceId(sources[0].id)
    if (!profileReceiverId && receivers[0]) setProfileReceiverId(receivers[0].id)
  }, [selected, sources, receivers, profileSourceId, profileReceiverId])

  useEffect(() => {
    if (!barrierProfileOpen || selected?.type !== 'barrier' || !profileDraft) return
    const sourceBase = sources.find(item => item.id === profileSourceId)
    const receiverBase = receivers.find(item => item.id === profileReceiverId)
    const barrierBase = barriers.find(item => item.id === selected.id)
    const coords = draftProfileCoordinates(profileDraft)
    if (!sourceBase || !receiverBase || !barrierBase || !coords) return

    const source = {
      ...sourceBase,
      lat: coords.source.lat,
      lon: coords.source.lon,
      height_m: Number(profileDraft.source_height_m)
    }
    const receiver = {
      ...receiverBase,
      lat: coords.receiver.lat,
      lon: coords.receiver.lon,
      height_m: Number(profileDraft.receiver_height_m),
      height_mode: 'specify'
    }
    const barrier = {
      ...barrierBase,
      height_m: Number(profileDraft.barrier_height_m)
    }

    let cancelled = false
    const load = async () => {
      setBarrierProfileLoading(true)
      try {
        const response = await fetch(`${API_BASE}/api/barrier-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source,
            receiver,
            barrier,
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
        const data = await response.json()
        if (!response.ok) throw new Error(data?.detail || `HTTP ${response.status}`)
        if (!cancelled) setBarrierProfile(data)
      } catch (error) {
        console.error(error)
        if (!cancelled) setBarrierProfile(null)
      } finally {
        if (!cancelled) setBarrierProfileLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [
    barrierProfileOpen,
    selected,
    profileSourceId,
    profileReceiverId,
    sources,
    receivers,
    barriers,
    profileDraft,
    resolution,
    height,
    alpha,
    frequency,
    vmin,
    vmax,
    globalSettings
  ])

  const updateProfileBarrierHeight = value => {
    const heightValue = Math.max(0.1, Number(value) || 0.1)
    setProfileDraft(prev => prev ? { ...prev, barrier_height_m: heightValue } : prev)
  }

  const updateProfileReceiverHeight = value => {
    const heightValue = Math.max(0.1, Number(value) || 0.1)
    setProfileDraft(prev => prev ? { ...prev, receiver_height_m: heightValue } : prev)
  }

  const updateProfileSourceHeight = value => {
    const heightValue = Math.max(0.1, Number(value) || 0.1)
    setProfileDraft(prev => prev ? { ...prev, source_height_m: heightValue } : prev)
  }

  const updateProfileSourceBarrierDistance = value => {
    const distance = Math.max(0.1, Number(value) || 0.1)
    setProfileDraft(prev => {
      if (!prev) return prev
      const fr = Math.max(Number(prev.source_to_receiver_m) || distance + 0.1, distance + 0.1)
      return { ...prev, source_to_barrier_m: distance, source_to_receiver_m: fr }
    })
  }

  const updateProfileSourceReceiverDistance = value => {
    setProfileDraft(prev => {
      if (!prev) return prev
      const min = Math.max(0.2, Number(prev.source_to_barrier_m) + 0.1)
      return { ...prev, source_to_receiver_m: Math.max(min, Number(value) || min) }
    })
  }

  const openBarrierProfile = () => {
    if (selected?.type !== 'barrier') return
    const source = sources.find(item => item.id === profileSourceId) || sources[0]
    const receiver = receivers.find(item => item.id === profileReceiverId) || receivers[0]
    const barrier = barriers.find(item => item.id === selected.id)
    if (!source || !receiver || !barrier) return

    if (!profileSourceId) setProfileSourceId(source.id)
    if (!profileReceiverId) setProfileReceiverId(receiver.id)

    const geometryRef = profileGeometryReference(source, receiver, barrier)
    setProfileDraft({
      source_height_m: Number(source.height_m),
      receiver_height_m: Number(receiver.height_m),
      barrier_height_m: Number(barrier.height_m),
      source_to_barrier_m: Math.max(0.1, geometryRef.source_to_barrier_m),
      source_to_receiver_m: Math.max(geometryRef.source_to_receiver_m, geometryRef.source_to_barrier_m + 0.1),
      geometryRef
    })
    setBarrierProfileOpen(true)
  }

  const saveProfileChangesToMap = () => {
    if (!profileDraft || selected?.type !== 'barrier') return
    const coords = draftProfileCoordinates(profileDraft)
    if (!coords) return

    setSources(prev => prev.map(item =>
      item.id === profileSourceId
        ? {
            ...item,
            lat: coords.source.lat,
            lon: coords.source.lon,
            height_m: Number(profileDraft.source_height_m)
          }
        : item
    ))

    setReceivers(prev => prev.map(item =>
      item.id === profileReceiverId
        ? {
            ...item,
            lat: coords.receiver.lat,
            lon: coords.receiver.lon,
            height_m: Number(profileDraft.receiver_height_m),
            height_mode: 'specify'
          }
        : item
    ))

    setBarriers(prev => prev.map(item =>
      item.id === selected.id
        ? { ...item, height_m: Number(profileDraft.barrier_height_m) }
        : item
    ))

    setDirty(true)
    setBarrierProfileOpen(false)
    setProfileDraft(null)
  }

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
    if (selected.type === 'barrier') {
      setBarrierProfileOpen(false)
      setBarrierProfile(null)
    }
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
              {(() => {
                const label = sourceMarkerLabel(source, globalSettings.a_weighting)
                return (
                  <div className="source-level-label">
                    <strong>{label.main}</strong>
                    <span>{label.sub}</span>
                  </div>
                )
              })()}
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
            <span>{calculating ? (calculationStatus || 'Calculando…') : dirty ? 'Calcular mapa' : 'Mapa actualizado'}</span>
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
            setProjectOpen(false)
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
            setProjectOpen(false)
          }}
        >
          <span>☷</span><small>Capas</small>
        </button>
        <button
          type="button"
          className={projectOpen ? 'active' : ''}
          title="Guardar o abrir proyecto"
          onClick={() => {
            setProjectOpen(v => !v)
            setSearchOpen(false)
            setSettingsOpen(false)
            setLayersOpen(false)
            setResultsOpen(false)
            setTopographyImportOpen(false)
          }}
        >
          <span>▣</span><small>Proyecto</small>
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
            setProjectOpen(false)
          }}
        >
          <span>▦</span><small>Resultados</small>
        </button>
        <button
          type="button"
          className={panelOpen ? 'active' : ''}
          title="Modelo acústico"
          onClick={() => {
            setPanelOpen(v => !v)
            setProjectOpen(false)
          }}
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
            setProjectOpen(false)
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


      <input
        ref={projectFileInputRef}
        type="file"
        accept=".json,.noisemap.json,application/json"
        onChange={loadProjectFile}
        style={{ display: 'none' }}
      />

      {projectOpen && (
        <div className="layers-popover project-popover">
          <div className="project-popover-header">
            <div>
              <span className="eyebrow">PROYECTO</span>
              <strong>Guardar / abrir</strong>
            </div>
            <button type="button" onClick={() => setProjectOpen(false)}>×</button>
          </div>

          <button type="button" className="project-menu-action primary" onClick={saveProject}>
            <span>↓</span>
            <div>
              <strong>Guardar proyecto</strong>
              <small>Descargar archivo .noisemap.json</small>
            </div>
          </button>

          <button
            type="button"
            className="project-menu-action"
            onClick={() => projectFileInputRef.current?.click()}
          >
            <span>↑</span>
            <div>
              <strong>Abrir proyecto</strong>
              <small>Cargar un proyecto guardado</small>
            </div>
          </button>

          <div className="project-help compact">
            Conserva fuentes, receptores, barreras, topografía, espectros,
            configuración y último cálculo.
          </div>

          {projectMessage && (
            <div className="project-message">{projectMessage}</div>
          )}
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
                      {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                        <th key={freq}>{freq >= 1000 ? freq/1000 + 'k' : freq}</th>
                      ))}
                      <th>Total {globalSettings.a_weighting ? 'dB(A)' : 'dB'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.receiver_results.map(row => (
                      <tr key={row.id}>
                        <td>{row.name}</td>
                        <td>{Number(row.height_m).toFixed(1)} m</td>
                        {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                          <td key={freq}>
                            {row.bands_db?.[String(freq)] != null
                              ? Number(row.bands_db[String(freq)]).toFixed(1)
                              : '—'}
                          </td>
                        ))}
                        <td><strong>{row.level_db != null ? row.level_db.toFixed(1) : '—'}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="results-subtitle">Contribución por fuente</h4>
              <div className="results-table-wrap contribution-wrap">
                <table className="results-table contribution-table spectral-contribution-table">
                  <thead>
                    <tr>
                      <th>Receptor</th>
                      <th>Fuente</th>
                      <th>Modo</th>
                      {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                        <th key={freq}>{freq >= 1000 ? freq/1000 + 'k' : freq}</th>
                      ))}
                      <th>Total {globalSettings.a_weighting ? 'dB(A)' : 'dB'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.receiver_results.flatMap(row =>
                      (row.contributions || []).map(contribution => (
                        <tr key={`${row.id}-${contribution.source_id}`}>
                          <td>{row.name}</td>
                          <td>{contribution.source_name}</td>
                          <td>{contribution.mode === 'octaves' ? 'Octavas' : contribution.mode === 'single' ? 'Single' : 'Broadband'}</td>
                          {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                            <td key={freq}>
                              {contribution.bands_db?.[String(freq)] != null
                                ? Number(contribution.bands_db[String(freq)]).toFixed(1)
                                : '—'}
                            </td>
                          ))}
                          <td><strong>{contribution.level_db != null ? Number(contribution.level_db).toFixed(1) : '—'}</strong></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="results-note">
                Las bandas 63–8000 Hz son niveles de presión sonora por banda en el receptor. El total aplica ponderación A cuando está activada. Broadband no inventa un espectro: si la fuente fue ingresada solo como LwA, sus celdas por banda aparecen como “—”.
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
              {calculating ? (calculationStatus || 'Calculando…') : dirty ? 'ACTUALIZAR MAPA' : 'MAPA ACTUALIZADO'}
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
                    <strong>{sourceEquivalentLevel(selectedObject, globalSettings.a_weighting).toFixed(1)} {globalSettings.a_weighting ? 'dB(A)' : 'dB'}</strong>
                  </div>
                  <div className="engine-note">
                    En el mapa se muestra este total energético sobre la F. El detalle por banda permanece en esta ficha.
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
                El motor V4 propaga las fuentes en octavas banda por banda. Single se calcula a su frecuencia y Broadband permanece como nivel global LwA sin inventar un espectro.
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
                    ? selectedReceiverResult.level_db.toFixed(1) + (globalSettings.a_weighting ? ' dB(A)' : ' dB')
                    : 'Sin calcular'}
                </strong>
              </div>

              {selectedReceiverResult?.bands_db && (
                <div className="receiver-spectrum">
                  {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                    <div key={freq}>
                      <span>{freq >= 1000 ? freq/1000 + 'k' : freq}</span>
                      <strong>
                        {selectedReceiverResult.bands_db[String(freq)] != null
                          ? Number(selectedReceiverResult.bands_db[String(freq)]).toFixed(1)
                          : '—'}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
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
              <h4 className="subheading barrier-profile-heading">Perfil acústico</h4>
              <div className="profile-selector-grid">
                <label>Fuente
                  <select value={profileSourceId} onChange={e => setProfileSourceId(e.target.value)}>
                    {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
                  </select>
                </label>
                <label>Receptor
                  <select value={profileReceiverId} onChange={e => setProfileReceiverId(e.target.value)}>
                    {receivers.map(receiver => <option key={receiver.id} value={receiver.id}>{receiver.name}</option>)}
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="profile-open-button"
                disabled={!sources.length || !receivers.length}
                onClick={openBarrierProfile}
              >
                Ver perfil acústico F–B–R
              </button>
              <div className="engine-note">La atenuación por barrera se calcula con la geometría F–B–R y depende de la frecuencia. Las reflexiones de superficie siguen almacenadas pero aún no forman parte del motor físico.</div>
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

      {barrierProfileOpen && selected?.type === 'barrier' && (
        <div className="floating-dialog barrier-profile-dialog">
          <div className="dialog-header">
            <div>
              <span className="eyebrow">BARRERA</span>
              <h3>Perfil acústico F–B–R</h3>
            </div>
            <button onClick={() => {
              setBarrierProfileOpen(false)
              setProfileDraft(null)
            }}>×</button>
          </div>

          <div className="profile-top-row">
            <label>Fuente
              <select value={profileSourceId} onChange={e => setProfileSourceId(e.target.value)}>
                {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
              </select>
            </label>
            <label>Receptor
              <select value={profileReceiverId} onChange={e => setProfileReceiverId(e.target.value)}>
                {receivers.map(receiver => <option key={receiver.id} value={receiver.id}>{receiver.name}</option>)}
              </select>
            </label>
          </div>

          {profileDraft && (
            <>
              <div className="profile-height-controls">
                <label>
                  Altura fuente
                  <div>
                    <input type="range" min="0.1" max="20" step="0.1"
                      value={profileDraft.source_height_m}
                      onChange={e => updateProfileSourceHeight(e.target.value)} />
                    <input type="number" min="0.1" max="20" step="0.1"
                      value={profileDraft.source_height_m}
                      onChange={e => updateProfileSourceHeight(e.target.value)} />
                    <span>m</span>
                  </div>
                </label>

                <label>
                  Altura barrera
                  <div>
                    <input type="range" min="0.1" max="20" step="0.1"
                      value={profileDraft.barrier_height_m}
                      onChange={e => updateProfileBarrierHeight(e.target.value)} />
                    <input type="number" min="0.1" max="20" step="0.1"
                      value={profileDraft.barrier_height_m}
                      onChange={e => updateProfileBarrierHeight(e.target.value)} />
                    <span>m</span>
                  </div>
                </label>

                <label>
                  Altura receptor
                  <div>
                    <input type="range" min="0.1" max="20" step="0.1"
                      value={profileDraft.receiver_height_m}
                      onChange={e => updateProfileReceiverHeight(e.target.value)} />
                    <input type="number" min="0.1" max="20" step="0.1"
                      value={profileDraft.receiver_height_m}
                      onChange={e => updateProfileReceiverHeight(e.target.value)} />
                    <span>m</span>
                  </div>
                </label>
              </div>

              <div className="profile-distance-controls">
                <label>
                  Distancia Fuente → Barrera
                  <div>
                    <input
                      type="range"
                      min="0.5"
                      max={Math.max(200, Number(profileDraft.source_to_receiver_m))}
                      step="0.5"
                      value={profileDraft.source_to_barrier_m}
                      onChange={e => updateProfileSourceBarrierDistance(e.target.value)}
                    />
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={Number(profileDraft.source_to_barrier_m).toFixed(1)}
                      onChange={e => updateProfileSourceBarrierDistance(e.target.value)}
                    />
                    <span>m</span>
                  </div>
                </label>

                <label>
                  Distancia Fuente → Receptor
                  <div>
                    <input
                      type="range"
                      min={Math.max(0.6, Number(profileDraft.source_to_barrier_m) + 0.1)}
                      max="400"
                      step="0.5"
                      value={profileDraft.source_to_receiver_m}
                      onChange={e => updateProfileSourceReceiverDistance(e.target.value)}
                    />
                    <input
                      type="number"
                      min={Math.max(0.2, Number(profileDraft.source_to_barrier_m) + 0.1)}
                      step="0.1"
                      value={Number(profileDraft.source_to_receiver_m).toFixed(1)}
                      onChange={e => updateProfileSourceReceiverDistance(e.target.value)}
                    />
                    <span>m</span>
                  </div>
                </label>

                <div className="profile-derived-distance">
                  <span>Barrera → Receptor</span>
                  <strong>{Math.max(0, Number(profileDraft.source_to_receiver_m) - Number(profileDraft.source_to_barrier_m)).toFixed(1)} m</strong>
                </div>
              </div>
            </>
          )}

          {barrierProfileLoading && <div className="profile-loading">Actualizando perfil…</div>}

          {barrierProfile && (() => {
            const total = Math.max(barrierProfile.horizontal_total_m || 1, 1)
            const bx = Math.max(0, Math.min(1, (barrierProfile.source_to_barrier_m || 0) / total))
            const maxH = Math.max(
              Number(barrierProfile.source_height_m) || 0,
              Number(barrierProfile.receiver_height_m) || 0,
              Number(barrierProfile.barrier_height_m) || 0,
              2
            ) * 1.25
            const x0 = 54
            const x1 = 706
            const groundY = 215
            const usableH = 165
            const sx = x0
            const rx = x1
            const barrierX = x0 + (x1 - x0) * bx
            const yFor = h => groundY - (Number(h) / maxH) * usableH
            const sy = yFor(barrierProfile.source_height_m)
            const ry = yFor(barrierProfile.receiver_height_m)
            const by = yFor(barrierProfile.barrier_height_m)
            return (
              <>
                <div className="profile-status">
                  <span className={barrierProfile.blocked ? 'blocked' : 'clear'}>
                    {barrierProfile.blocked ? 'Trayectoria bloqueada' : 'Línea de visión libre'}
                  </span>
                  {!barrierProfile.intersects && <span className="warning">La barrera seleccionada no intersecta directamente F–R</span>}
                </div>

                <div className="profile-svg-wrap">
                  <svg viewBox="0 0 760 270" role="img" aria-label="Perfil de fuente, barrera y receptor">
                    <line x1="35" y1={groundY} x2="725" y2={groundY} className="profile-ground" />

                    <line x1={sx} y1={sy} x2={rx} y2={ry} className="profile-los" />
                    <polyline points={`${sx},${sy} ${barrierX},${by} ${rx},${ry}`} className="profile-diffracted" />

                    <line x1={sx} y1={groundY} x2={sx} y2={sy} className="profile-height-line source" />
                    <line x1={barrierX} y1={groundY} x2={barrierX} y2={by} className="profile-barrier" />
                    <line x1={rx} y1={groundY} x2={rx} y2={ry} className="profile-height-line receiver" />

                    <circle cx={sx} cy={sy} r="7" className="profile-source-point" />
                    <path d={`M ${rx-7} ${ry+6} L ${rx} ${ry-7} L ${rx+7} ${ry+6} Z`} className="profile-receiver-point" />

                    <text x={sx} y={Math.max(18, sy - 16)} textAnchor="middle" className="profile-label">FUENTE</text>
                    <text x={barrierX} y={Math.max(18, by - 16)} textAnchor="middle" className="profile-label">BARRERA</text>
                    <text x={rx} y={Math.max(18, ry - 16)} textAnchor="middle" className="profile-label">RECEPTOR</text>

                    <text x={sx + 8} y={groundY - 8} className="profile-value">{Number(barrierProfile.source_height_m).toFixed(1)} m</text>
                    <text x={barrierX + 8} y={groundY - 8} className="profile-value">{Number(barrierProfile.barrier_height_m).toFixed(1)} m</text>
                    <text x={rx - 8} y={groundY - 8} textAnchor="end" className="profile-value">{Number(barrierProfile.receiver_height_m).toFixed(1)} m</text>

                    <line x1={sx} y1="243" x2={barrierX} y2="243" className="profile-dimension" />
                    <line x1={barrierX} y1="243" x2={rx} y2="243" className="profile-dimension" />
                    <text x={(sx + barrierX)/2} y="259" textAnchor="middle" className="profile-distance">{barrierProfile.source_to_barrier_m.toFixed(1)} m</text>
                    <text x={(barrierX + rx)/2} y="259" textAnchor="middle" className="profile-distance">{barrierProfile.barrier_to_receiver_m.toFixed(1)} m</text>
                  </svg>
                </div>

                <div className="profile-receiver-live">
                  <div>
                    <span>Nivel proyectado en {receivers.find(item => item.id === profileReceiverId)?.name || 'receptor'}</span>
                    <strong>
                      {barrierProfile.receiver_level_db != null
                        ? Number(barrierProfile.receiver_level_db).toFixed(1) + (globalSettings.a_weighting ? ' dB(A)' : ' dB')
                        : '—'}
                    </strong>
                  </div>
                  <div className="profile-live-bands">
                    {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                      <span key={freq}>
                        <small>{freq >= 1000 ? freq/1000 + 'k' : freq}</small>
                        <b>
                          {barrierProfile.receiver_bands_db?.[String(freq)] != null
                            ? Number(barrierProfile.receiver_bands_db[String(freq)]).toFixed(1)
                            : '—'}
                        </b>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="profile-metrics">
                  <div><span>Distancia F–R</span><strong>{barrierProfile.horizontal_total_m.toFixed(1)} m</strong></div>
                  <div><span>Altura LOS en barrera</span><strong>{barrierProfile.los_height_at_barrier_m.toFixed(2)} m</strong></div>
                  <div><span>Exceso de trayectoria δ</span><strong>{barrierProfile.path_difference_m.toFixed(3)} m</strong></div>
                  <div><span>Atenuación seleccionada</span><strong>{barrierProfile.selected_attenuation_db.toFixed(1)} dB</strong></div>
                </div>

                <h4 className="results-subtitle">Atenuación por banda de octava</h4>
                <div className="profile-band-grid">
                  {[63,125,250,500,1000,2000,4000,8000].map(freq => (
                    <div key={freq}>
                      <span>{freq >= 1000 ? freq/1000 + 'k' : freq} Hz</span>
                      <strong>{Number(barrierProfile.attenuation_by_band_db?.[String(freq)] ?? 0).toFixed(1)} dB</strong>
                    </div>
                  ))}
                </div>

                <div className="profile-note">
                  Estos cambios son una simulación previa. Modifica alturas y distancias y observa el nivel proyectado en el receptor. Solo se aplicarán al escenario cuando pulses “Actualizar cambios en el mapa”.
                </div>

                <button
                  type="button"
                  className="profile-save-map-button"
                  onClick={saveProfileChangesToMap}
                >
                  Actualizar cambios en el mapa
                </button>
              </>
            )
          })()}
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
