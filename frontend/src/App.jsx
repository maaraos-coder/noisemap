import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Map, { Layer, Marker, NavigationControl, Source } from 'react-map-gl/maplibre'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''
// Deployment sync: keep Vercel production aligned with the latest v3-react-maplibre changes.

const NOISE_COLOR_BANDS = [
  { min:-Infinity, max:35, color:'#c7e9b4', name:'Verde claro' },
  { min:35, max:40, color:'#6cc04a', name:'Verde' },
  { min:40, max:45, color:'#2f9d5d', name:'Verde oscuro' },
  { min:45, max:50, color:'#ffd400', name:'Amarillo' },
  { min:50, max:55, color:'#d9a300', name:'Ocre' },
  { min:55, max:60, color:'#ff8c1a', name:'Naranja' },
  { min:60, max:65, color:'#f05a28', name:'Cinabrio' },
  { min:65, max:70, color:'#e51c2a', name:'Carmín' },
  { min:70, max:75, color:'#b13f7a', name:'Rojo lila' },
  { min:75, max:80, color:'#4d67b1', name:'Azul' },
  { min:80, max:Infinity, color:'#363a9a', name:'Azul oscuro' }
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

const initialSources = []
const initialReceivers = []
const defaultPolygon = []

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

function buildingsGeoJSON(buildings) {
  return {
    type: 'FeatureCollection',
    features: buildings
      .filter(building => building.enabled && building.points?.length >= 3)
      .map(building => {
        const ring = building.points.map(([lat, lon]) => [lon, lat])
        ring.push(ring[0])
        return {
          type: 'Feature',
          properties: {
            id: building.id,
            name: building.name,
            height_m: building.height_m
          },
          geometry: { type: 'Polygon', coordinates: [ring] }
        }
      })
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


function roadsGeoJSON(roads) {
  return {
    type: 'FeatureCollection',
    features: roads
      .filter(road => road.enabled && road.points?.length >= 2)
      .map(road => ({
        type: 'Feature',
        properties: { id: road.id, name: road.name },
        geometry: {
          type: 'LineString',
          coordinates: road.points.map(([lat, lon]) => [lon, lat])
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

function pointInPolygon2D(lat, lon, points) {
  if (!points?.length) return false
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const yi = Number(points[i][0])
    const xi = Number(points[i][1])
    const yj = Number(points[j][0])
    const xj = Number(points[j][1])
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

function segmentIntersectionLatLon(source, receiver, barrier) {
  const p1 = [Number(source.lon), Number(source.lat)]
  const p2 = [Number(receiver.lon), Number(receiver.lat)]
  const q1 = [Number(barrier.lon_a), Number(barrier.lat_a)]
  const q2 = [Number(barrier.lon_b), Number(barrier.lat_b)]
  const rx = p2[0] - p1[0]
  const ry = p2[1] - p1[1]
  const sx = q2[0] - q1[0]
  const sy = q2[1] - q1[1]
  const cross = (ax, ay, bx, by) => ax * by - ay * bx
  const den = cross(rx, ry, sx, sy)
  if (Math.abs(den) < 1e-12) return null
  const qpx = q1[0] - p1[0]
  const qpy = q1[1] - p1[1]
  const t = cross(qpx, qpy, sx, sy) / den
  const u = cross(qpx, qpy, rx, ry) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return {
    t,
    u,
    lat: Number(source.lat) + t * (Number(receiver.lat) - Number(source.lat)),
    lon: Number(source.lon) + t * (Number(receiver.lon) - Number(source.lon))
  }
}

function barrierCrossingsForPair(source, receiver, barriers, totalHorizontal) {
  return barriers
    .filter(barrier => barrier.enabled)
    .map(barrier => {
      const hit = segmentIntersectionLatLon(source, receiver, barrier)
      if (!hit) return null
      const sourceToBarrier = totalHorizontal * hit.t
      const barrierToReceiver = totalHorizontal * (1 - hit.t)
      return {
        barrier,
        ...hit,
        sourceToBarrier,
        barrierToReceiver
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t)
}

function distancePairsGeoJSON(pairs) {
  return {
    type: 'FeatureCollection',
    features: pairs.map(pair => ({
      type: 'Feature',
      properties: { id: pair.id },
      geometry: {
        type: 'LineString',
        coordinates: [[pair.source.lon, pair.source.lat], [pair.receiver.lon, pair.receiver.lat]]
      }
    }))
  }
}

function levelColor(value) {
  const numeric = Number(value)
  const band = NOISE_COLOR_BANDS.find(item => numeric >= item.min && numeric < item.max)
    || NOISE_COLOR_BANDS[NOISE_COLOR_BANDS.length - 1]
  const hex = band.color
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ]
}

function bilinearMatrixValue(levels, x, y) {
  const rows = levels?.length || 0
  const cols = rows ? (levels[0]?.length || 0) : 0
  if (!rows || !cols) return null

  const xx = Math.max(0, Math.min(cols - 1, Number(x)))
  const yy = Math.max(0, Math.min(rows - 1, Number(y)))
  const x0 = Math.floor(xx)
  const y0 = Math.floor(yy)
  const x1 = Math.min(cols - 1, x0 + 1)
  const y1 = Math.min(rows - 1, y0 + 1)
  const tx = xx - x0
  const ty = yy - y0

  const samples = [
    [levels[y0]?.[x0], (1 - tx) * (1 - ty)],
    [levels[y0]?.[x1], tx * (1 - ty)],
    [levels[y1]?.[x0], (1 - tx) * ty],
    [levels[y1]?.[x1], tx * ty]
  ]

  let weighted = 0
  let totalWeight = 0
  samples.forEach(([value, weight]) => {
    const numeric = Number(value)
    if (value != null && Number.isFinite(numeric) && weight > 0) {
      weighted += numeric * weight
      totalWeight += weight
    }
  })

  return totalWeight > 1e-9 ? weighted / totalWeight : null
}

function cleanDisplayLevels(levels, bounds, sources = [], barriers = []) {
  if (!levels?.length || !levels[0]?.length || !bounds || !barriers?.length) return levels

  const rows = levels.length
  const cols = levels[0].length
  const south = Number(bounds[0]?.[0])
  const west = Number(bounds[0]?.[1])
  const north = Number(bounds[1]?.[0])
  const east = Number(bounds[1]?.[1])
  if (![south, west, north, east].every(Number.isFinite)) return levels

  const meanLat = (south + north) / 2
  const metersPerLat = 111320
  const metersPerLon = 111320 * Math.max(Math.cos(meanLat * Math.PI / 180), 1e-6)

  const toXY = (lat, lon) => ({
    x: (Number(lon) - west) * metersPerLon,
    y: (Number(lat) - south) * metersPerLat
  })

  const sourceXY = sources
    .filter(item => item?.enabled !== false)
    .map(item => toXY(item.lat, item.lon))

  const barrierXY = barriers
    .filter(item => item?.enabled !== false)
    .map(item => ({
      a: toXY(item.lat_a, item.lon_a),
      b: toXY(item.lat_b, item.lon_b)
    }))

  const pointSegmentDistance = (p, a, b) => {
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    if (len2 <= 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
  }

  const cellDx = Math.abs((east - west) * metersPerLon) / Math.max(cols - 1, 1)
  const cellDy = Math.abs((north - south) * metersPerLat) / Math.max(rows - 1, 1)
  const cellDiag = Math.hypot(cellDx, cellDy)
  const nearBarrierDistance = Math.max(6, 3.2 * cellDiag)
  const sourceKeepDistance = Math.max(6, 2.5 * cellDiag)

  let working = levels.map(row => [...row])

  // Two robust passes are enough to remove a tiny one/two-cell high island
  // created by gridding next to a barrier, while preserving the large-scale
  // shadow. Only upward outliers are corrected; real attenuation valleys are
  // never filled in.
  for (let pass = 0; pass < 2; pass += 1) {
    const next = working.map(row => [...row])

    for (let row = 2; row < rows - 2; row += 1) {
      for (let col = 2; col < cols - 2; col += 1) {
        const value = Number(working[row]?.[col])
        if (!Number.isFinite(value)) continue

        const lat = north - (row / Math.max(rows - 1, 1)) * (north - south)
        const lon = west + (col / Math.max(cols - 1, 1)) * (east - west)
        const p = toXY(lat, lon)

        if (!barrierXY.some(seg => pointSegmentDistance(p, seg.a, seg.b) <= nearBarrierDistance)) continue
        if (sourceXY.some(src => Math.hypot(p.x - src.x, p.y - src.y) <= sourceKeepDistance)) continue

        const near = []
        const wide = []
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            if (dr === 0 && dc === 0) continue
            const n = Number(working[row + dr]?.[col + dc])
            if (!Number.isFinite(n)) continue
            wide.push(n)
            if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1) near.push(n)
          }
        }
        if (near.length < 6 || wide.length < 16) continue

        const sortedNear = [...near].sort((a, b) => a - b)
        const sortedWide = [...wide].sort((a, b) => a - b)
        const medianNear = sortedNear[Math.floor(sortedNear.length / 2)]
        const medianWide = sortedWide[Math.floor(sortedWide.length / 2)]
        const q75Wide = sortedWide[Math.floor(sortedWide.length * 0.75)]

        // A real contour peak has supporting high neighbours. A display
        // speckle does not. Clamp only when both local medians reject the peak.
        const highSupport = near.filter(n => n >= value - 1.5).length
        const isolatedHigh = (
          value - medianNear >= 2.0 &&
          value - medianWide >= 2.0 &&
          value - q75Wide >= 1.0 &&
          highSupport <= 2
        )

        if (isolatedHigh) {
          next[row][col] = Number(Math.max(medianNear, medianWide).toFixed(3))
        }
      }
    }

    working = next
  }

  return working
}

function barrierCrossingCellMask(levels, bounds, barriers = []) {
  const mask = new Set()
  if (!levels?.length || !levels[0]?.length || !bounds || !barriers?.length) return mask

  const rows = levels.length
  const cols = levels[0].length
  const south = Number(bounds[0]?.[0])
  const west = Number(bounds[0]?.[1])
  const north = Number(bounds[1]?.[0])
  const east = Number(bounds[1]?.[1])
  if (![south, west, north, east].every(Number.isFinite)) return mask

  const cross = (ax, ay, bx, by) => ax * by - ay * bx
  const intersects = (p1, p2, q1, q2) => {
    const rx = p2[0] - p1[0]
    const ry = p2[1] - p1[1]
    const sx = q2[0] - q1[0]
    const sy = q2[1] - q1[1]
    const den = cross(rx, ry, sx, sy)
    if (Math.abs(den) < 1e-14) return false
    const qpx = q1[0] - p1[0]
    const qpy = q1[1] - p1[1]
    const t = cross(qpx, qpy, sx, sy) / den
    const u = cross(qpx, qpy, rx, ry) / den
    return t >= 0 && t <= 1 && u >= 0 && u <= 1
  }

  const rowLat = row => north - (row / Math.max(rows - 1, 1)) * (north - south)
  const colLon = col => west + (col / Math.max(cols - 1, 1)) * (east - west)

  barriers.filter(item => item?.enabled !== false).forEach(barrier => {
    const a = [Number(barrier.lon_a), Number(barrier.lat_a)]
    const b = [Number(barrier.lon_b), Number(barrier.lat_b)]
    if (![...a, ...b].every(Number.isFinite)) return

    const minLon = Math.min(a[0], b[0])
    const maxLon = Math.max(a[0], b[0])
    const minLat = Math.min(a[1], b[1])
    const maxLat = Math.max(a[1], b[1])

    const col0 = Math.max(0, Math.min(cols - 2, Math.floor((minLon - west) / Math.max(east - west, 1e-12) * (cols - 1)) - 1))
    const col1 = Math.max(0, Math.min(cols - 2, Math.ceil((maxLon - west) / Math.max(east - west, 1e-12) * (cols - 1)) + 1))
    const row0 = Math.max(0, Math.min(rows - 2, Math.floor((north - maxLat) / Math.max(north - south, 1e-12) * (rows - 1)) - 1))
    const row1 = Math.max(0, Math.min(rows - 2, Math.ceil((north - minLat) / Math.max(north - south, 1e-12) * (rows - 1)) + 1))

    for (let row = row0; row <= row1; row += 1) {
      for (let col = col0; col <= col1; col += 1) {
        const left = colLon(col)
        const right = colLon(col + 1)
        const top = rowLat(row)
        const bottom = rowLat(row + 1)

        const endpointInside = point => (
          point[0] >= left && point[0] <= right &&
          point[1] >= bottom && point[1] <= top
        )
        const tl = [left, top]
        const tr = [right, top]
        const br = [right, bottom]
        const bl = [left, bottom]
        const hit = endpointInside(a) || endpointInside(b) ||
          intersects(a, b, tl, tr) ||
          intersects(a, b, tr, br) ||
          intersects(a, b, br, bl) ||
          intersects(a, b, bl, tl)

        if (hit) mask.add(`${row}:${col}`)
      }
    }
  })

  return mask
}

function nearestMatrixValue(levels, x, y) {
  const rows = levels?.length || 0
  const cols = rows ? (levels[0]?.length || 0) : 0
  if (!rows || !cols) return null
  const col = Math.max(0, Math.min(cols - 1, Math.round(Number(x))))
  const row = Math.max(0, Math.min(rows - 1, Math.round(Number(y))))
  const value = Number(levels[row]?.[col])
  return Number.isFinite(value) ? value : null
}

function rasterDataUrl(levels, vmin, vmax, bounds = null, barriers = []) {
  if (!levels?.length || !levels[0]?.length) return null

  const rows = levels.length
  const cols = levels[0].length
  const crossingCells = barrierCrossingCellMask(levels, bounds, barriers)
  const scale = 8
  const width = Math.max(2, cols * scale)
  const height = Math.max(2, rows * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(width, height)

  for (let py = 0; py < height; py += 1) {
    const gy = (py / Math.max(height - 1, 1)) * (rows - 1)
    for (let px = 0; px < width; px += 1) {
      const gx = (px / Math.max(width - 1, 1)) * (cols - 1)
      const cellRow = Math.max(0, Math.min(rows - 2, Math.floor(gy)))
      const cellCol = Math.max(0, Math.min(cols - 2, Math.floor(gx)))
      const crossesBarrier = crossingCells.has(`${cellRow}:${cellCol}`)

      // A barrier is a physical discontinuity in the sound field. Do not
      // bilinearly blend values from opposite sides of a screen, because that
      // visually leaks high levels into the acoustic shadow.
      const value = crossesBarrier
        ? nearestMatrixValue(levels, gx, gy)
        : bilinearMatrixValue(levels, gx, gy)
      const index = (py * width + px) * 4

      if (value == null || !Number.isFinite(value)) {
        image.data[index + 3] = 0
        continue
      }

      const [r, g, b] = levelColor(value, vmin, vmax)
      image.data[index] = r
      image.data[index + 1] = g
      image.data[index + 2] = b
      image.data[index + 3] = 178
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

function noiseIsolinesGeoJSON(levels, bounds, vmin, vmax, interval = 5, barriers = []) {
  const empty = { type: 'FeatureCollection', features: [] }
  if (!levels?.length || !levels[0]?.length || !bounds || levels.length < 2 || levels[0].length < 2) return empty

  const rows = levels.length
  const cols = levels[0].length
  const south = Number(bounds[0]?.[0])
  const west = Number(bounds[0]?.[1])
  const north = Number(bounds[1]?.[0])
  const east = Number(bounds[1]?.[1])
  if (![south, west, north, east].every(Number.isFinite)) return empty

  const crossingCells = barrierCrossingCellMask(levels, bounds, barriers)

  const bottom = Math.ceil(Number(vmin) / interval) * interval
  const top = Math.floor(Number(vmax) / interval) * interval
  const thresholds = []
  for (let value = bottom; value <= top; value += interval) thresholds.push(value)

  const pointAt = (row, col) => ([
    west + (col / (cols - 1)) * (east - west),
    north - (row / (rows - 1)) * (north - south)
  ])

  const interpolate = (p1, v1, p2, v2, threshold) => {
    const denom = Number(v2) - Number(v1)
    const t = Math.abs(denom) < 1e-9 ? 0.5 : Math.max(0, Math.min(1, (threshold - Number(v1)) / denom))
    return [
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t
    ]
  }

  const features = []
  thresholds.forEach(threshold => {
    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < cols - 1; col += 1) {
        // Contours must not interpolate through a physical screen. The barrier
        // layer itself visually closes this narrow gap on the map.
        if (crossingCells.has(`${row}:${col}`)) continue

        const vTL = levels[row]?.[col]
        const vTR = levels[row]?.[col + 1]
        const vBR = levels[row + 1]?.[col + 1]
        const vBL = levels[row + 1]?.[col]
        if (![vTL, vTR, vBR, vBL].every(v => v != null && Number.isFinite(Number(v)))) continue

        const pTL = pointAt(row, col)
        const pTR = pointAt(row, col + 1)
        const pBR = pointAt(row + 1, col + 1)
        const pBL = pointAt(row + 1, col)
        const intersections = []
        const cross = (v1, v2) => (
          (Number(v1) < threshold && Number(v2) >= threshold) ||
          (Number(v2) < threshold && Number(v1) >= threshold)
        )

        if (cross(vTL, vTR)) intersections.push({ edge:'top', point:interpolate(pTL, vTL, pTR, vTR, threshold) })
        if (cross(vTR, vBR)) intersections.push({ edge:'right', point:interpolate(pTR, vTR, pBR, vBR, threshold) })
        if (cross(vBR, vBL)) intersections.push({ edge:'bottom', point:interpolate(pBR, vBR, pBL, vBL, threshold) })
        if (cross(vBL, vTL)) intersections.push({ edge:'left', point:interpolate(pBL, vBL, pTL, vTL, threshold) })

        const addSegment = (a, b) => {
          const [r,g,bv] = levelColor(threshold, vmin, vmax)
          features.push({
            type:'Feature',
            properties:{
              level_db:threshold,
              major: Math.abs(threshold % 10) < 1e-9 ? 1 : 0,
              line_color:`rgb(${r},${g},${bv})`
            },
            geometry:{ type:'LineString', coordinates:[a.point, b.point] }
          })
        }

        if (intersections.length === 2) {
          addSegment(intersections[0], intersections[1])
        } else if (intersections.length === 4) {
          const byEdge = Object.fromEntries(intersections.map(item => [item.edge, item]))
          const center = (Number(vTL) + Number(vTR) + Number(vBR) + Number(vBL)) / 4
          if (center >= threshold) {
            addSegment(byEdge.top, byEdge.left)
            addSegment(byEdge.right, byEdge.bottom)
          } else {
            addSegment(byEdge.top, byEdge.right)
            addSegment(byEdge.bottom, byEdge.left)
          }
        }
      }
    }
  })

  return { type:'FeatureCollection', features }
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

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180
  const toDeg = r => r * 180 / Math.PI
  const p1 = toRad(Number(lat1))
  const p2 = toRad(Number(lat2))
  const dl = toRad(Number(lon2) - Number(lon1))
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

function angularDifferenceDegrees(a, b) {
  return Math.abs((Number(a) - Number(b) + 180) % 360 - 180)
}

function polylineLengthMeters(points) {
  if (!points || points.length < 2) return 0
  return points.slice(1).reduce((sum, point, index) => (
    sum + haversineMeters(
      points[index][0], points[index][1],
      point[0], point[1]
    )
  ), 0)
}


const A_CORRECTIONS = {63:-26.2,125:-16.1,250:-8.6,500:-3.2,1000:0,2000:1.2,4000:1.0,8000:-1.1}

const OCTAVE_BANDS = [63,125,250,500,1000,2000,4000,8000]
const DEFAULT_CONTROL_BANDS = {63:0,125:0,250:0,500:0,1000:0,2000:0,4000:0,8000:0}
const DEFAULT_ENCLOSURE_TL = {63:10,125:15,250:20,500:25,1000:30,2000:35,4000:35,8000:35}
const DEFAULT_SILENCER_IL = {63:3,125:6,250:10,500:15,1000:20,2000:22,4000:20,8000:16}
const ENCLOSURE_ABSORPTION_PRESETS = {
  unlined:{63:0.02,125:0.02,250:0.03,500:0.04,1000:0.05,2000:0.05,4000:0.05,8000:0.05},
  low:{63:0.04,125:0.06,250:0.10,500:0.16,1000:0.22,2000:0.28,4000:0.30,8000:0.30},
  medium:{63:0.08,125:0.15,250:0.30,500:0.50,1000:0.65,2000:0.75,4000:0.80,8000:0.80},
  high:{63:0.15,125:0.30,250:0.55,500:0.72,1000:0.84,2000:0.90,4000:0.92,8000:0.92}
}
const ENCLOSURE_FACES = [
  ['front','Frente'], ['back','Fondo'], ['left','Izquierda'],
  ['right','Derecha'], ['roof','Techo'], ['floor','Piso']
]

function defaultEnclosureFaces() {
  return Object.fromEntries(ENCLOSURE_FACES.map(([key]) => [key, {
    state: 'closed',
    opening_pct: 25,
    acoustic_mode: 'rw',
    rw_db: 30,
    tl_db: { ...DEFAULT_ENCLOSURE_TL }
  }]))
}

function bandValue(values, freq, fallback = 0) {
  const raw = values?.[freq] ?? values?.[String(freq)]
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function estimatedTlFromRw(rw, freq) {
  const offsets = {63:-25,125:-16,250:-7,500:0,1000:3,2000:4,4000:4,8000:4}
  const bands = OCTAVE_BANDS
  const f = Math.max(Number(freq || 500), 1)
  if (f <= bands[0]) return Math.max(0, Number(rw || 0) + offsets[bands[0]])
  if (f >= bands[bands.length-1]) return Math.max(0, Number(rw || 0) + offsets[bands[bands.length-1]])
  let i = 0
  while (i < bands.length - 1 && f > bands[i+1]) i++
  const f0=bands[i], f1=bands[i+1]
  const t=(Math.log(f)-Math.log(f0))/(Math.log(f1)-Math.log(f0))
  const off=offsets[f0]+t*(offsets[f1]-offsets[f0])
  return Math.max(0, Number(rw || 0) + off)
}

function enclosureFaceForBearing(source, bearing) {
  const relative = (Number(bearing) - Number(source.enclosure_azimuth_deg || 0) + 360) % 360
  if (relative < 45 || relative >= 315) return 'front'
  if (relative < 135) return 'right'
  if (relative < 225) return 'back'
  return 'left'
}

function faceTransmissionAttenuation(source, faceName, freq) {
  const faces = source.enclosure_faces || defaultEnclosureFaces()
  const face = faces[faceName] || defaultEnclosureFaces()[faceName]
  if ((face.state || 'closed') === 'open') return 0
  const tl = (face.acoustic_mode || 'rw') === 'spectrum'
    ? bandValue(face.tl_db, freq)
    : estimatedTlFromRw(face.rw_db ?? source.enclosure_rw_db ?? 30, freq)
  const tauPanel = Math.pow(10, -tl / 10)
  if ((face.state || 'closed') === 'partial') {
    const opening = Math.max(0, Math.min(1, Number(face.opening_pct || 0) / 100))
    return -10 * Math.log10(Math.max((1-opening)*tauPanel + opening, 1e-12))
  }
  return tl
}

function nominalSourceControlAttenuation(source, freq, faceName = 'front') {
  const kind = source.noise_control_type || 'none'
  if (kind === 'none') return 0
  if (kind === 'direct') {
    if (source.spectrum_mode === 'octaves') return bandValue(source.control_reduction_db, freq)
    return Math.max(0, Number(source.control_direct_db ?? 0))
  }
  if (kind === 'silencer') return bandValue(source.silencer_il_db, freq)
  if (['enclosure','semi','enclosure_silencer'].includes(kind)) {
    const faceAtt = faceTransmissionAttenuation(source, faceName, freq)
    if (kind !== 'enclosure_silencer') return faceAtt
    const vent = Math.max(0, Math.min(1, Number(source.enclosure_vent_pct || 0) / 100))
    const tauFace = Math.pow(10, -faceAtt / 10)
    const tauSil = Math.pow(10, -bandValue(source.silencer_il_db, freq) / 10)
    return -10 * Math.log10(Math.max((1-vent)*tauFace + vent*tauSil, 1e-12))
  }
  return 0
}

function sourceControlLabel(kind) {
  return ({
    none: 'Sin tratamiento',
    direct: 'Reducción directa',
    silencer: 'Silenciador / conducto',
    enclosure: 'Encierro completo',
    semi: 'Semiencierro',
    enclosure_silencer: 'Encierro + silenciador'
  })[kind || 'none'] || 'Sin tratamiento'
}

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
  if (source.course_power_pending || source.lw_db == null || source.lw_db === '') {
    return {
      main: 'Lw pendiente',
      sub: 'Ingresa potencia'
    }
  }
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


const COURSE3_STAGE8_PRESETS = {
  'c3l1-s8-a': {
    title: 'Etapa 8 · A · Excavación y movimiento de tierras',
    sources: [
      { id:'EX-01', name:'EX-01 · Excavadora hidráulica', x:12, y:21, height_m:1.5 },
      { id:'CF-01', name:'CF-01 · Cargador frontal', x:28, y:19, height_m:1.5 },
      { id:'CT-01', name:'CT-01 · Camión tolva articulado', x:41, y:10, height_m:1.5 }
    ]
  },
  'c3l1-s8-b': {
    title: 'Etapa 8 · B · Obra gruesa a nivel de piso',
    sources: [
      { id:'MX-01', name:'MX-01 · Camión mixer', x:9, y:11, height_m:1.5 },
      { id:'BH-01', name:'BH-01 · Bomba de hormigón', x:21, y:17, height_m:1.5 },
      { id:'VI-01', name:'VI-01 · Vibrador de inmersión', x:31, y:23, height_m:1.0 }
    ]
  },
  'c3l1-s8-c': {
    title: 'Etapa 8 · C · Obra gruesa en altura',
    sources: [
      { id:'BM-01', name:'BM-01 · Bomba + mixer a 5° piso', x:10, y:12, height_m:1.5 },
      { id:'VI-02', name:'VI-02 · Vibrador de inmersión', x:29, y:23, height_m:15.0 },
      { id:'GT-01', name:'GT-01 · Grúa torre', x:34, y:26, height_m:24.0 }
    ]
  },
  'c3l1-s10': {
    title: 'Etapa 10 · Caso integrador final',
    width_m: 70,
    height_m: 55,
    sources: []
  }
}

function coursePresetLocalToLatLon(x, y, lat0, lon0) {
  const radius = 6371000
  const lat = Number(lat0) + (Number(y) / radius) * 180 / Math.PI
  const latMid = ((lat + Number(lat0)) / 2) * Math.PI / 180
  const lon = Number(lon0) + (Number(x) / (radius * Math.max(Math.cos(latMid), 1e-9))) * 180 / Math.PI
  return [lat, lon]
}

function buildCourseStage8Preset(scenarioKey, originLat, originLon) {
  const preset = COURSE3_STAGE8_PRESETS[scenarioKey]
  if (!preset) return null

  const sourceItems = preset.sources.map(item => {
    const [lat, lon] = coursePresetLocalToLatLon(item.x, item.y, originLat, originLon)
    return {
      id: item.id,
      name: item.name,
      lat,
      lon,
      height_m: item.height_m,
      lw_db: null,
      dc_db: 0,
      enabled: true,
      spectrum_mode: 'broadband',
      single_frequency_hz: 500,
      octave_levels: {},
      course_power_pending: true,
      adjust_db: 0,
      time_active_pct: 100,
      noise_control_type: 'none',
      control_global_db: 0,
      control_direct_db: 0,
      control_reduction_db: { ...DEFAULT_CONTROL_BANDS },
      silencer_il_db: { ...DEFAULT_SILENCER_IL },
      enclosure_tl_db: { ...DEFAULT_ENCLOSURE_TL },
      enclosure_leak_pct: 0,
      enclosure_vent_pct: 10,
      enclosure_length_m: 2,
      enclosure_width_m: 2,
      enclosure_height_m: 2.5,
      enclosure_azimuth_deg: 0,
      enclosure_rw_db: 30,
      enclosure_faces: defaultEnclosureFaces(),
      enclosure_lining_mode: 'unlined',
      enclosure_absorption_coeff: { ...ENCLOSURE_ABSORPTION_PRESETS.unlined },
      enclosure_vent_area_m2: 0.10,
      enclosure_vent_face: 'back',
      semi_opening_pct: 25,
      semi_opening_azimuth_deg: 0,
      semi_opening_angle_deg: 90,
      course_local_x_m: item.x,
      course_local_y_m: item.y
    }
  })

  const commonReceivers = []

  // El predio didáctico se representa con líneas auxiliares, NO como área de cálculo.
  // Así el alumno debe aprender a dibujar posteriormente su propia área de cálculo.
  const widthM = Number(preset.width_m || 50)
  const heightM = Number(preset.height_m || 40)
  const boundaryXY = [[0,0],[widthM,0],[widthM,heightM],[0,heightM]]
  const boundaryPoints = boundaryXY.map(([x,y]) => coursePresetLocalToLatLon(x,y,originLat,originLon))
  const accessories = boundaryPoints.map((point, index) => {
    const next = boundaryPoints[(index + 1) % boundaryPoints.length]
    return {
      id: `course-boundary-${index + 1}`,
      name: `Límite predio ${index + 1}`,
      kind: 'measurement',
      lat_a: point[0],
      lon_a: point[1],
      lat_b: next[0],
      lon_b: next[1],
      height_m: 0,
      course_boundary: true
    }
  })

  return {
    title: preset.title,
    sources: sourceItems,
    receivers: commonReceivers,
    accessories,
    polygon: [],
    boundaryPoints,
    center: coursePresetLocalToLatLon(widthM/2,heightM/2,originLat,originLon)
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
  const coursePresetLoadedRef = useRef(false)
  const projectFileInputRef = useRef(null)
  const cutCanvasRef = useRef(null)
  const objectCardRef = useRef(null)

  const [mode, setMode] = useState('navigate')
  const [mapZoom, setMapZoom] = useState(1.35)
  const [sources, setSources] = useState(initialSources)
  const [receivers, setReceivers] = useState(initialReceivers)
  const [barriers, setBarriers] = useState([])
  const [buildings, setBuildings] = useState([])
  const [buildingDraft, setBuildingDraft] = useState([])
  const [buildingFacadeIndex, setBuildingFacadeIndex] = useState(0)
  const [roads, setRoads] = useState([])
  const [roadDraft, setRoadDraft] = useState([])
  const [accessories, setAccessories] = useState([])
  const [contours, setContours] = useState([])
  const [contourDraft, setContourDraft] = useState([])
  const [polygon, setPolygon] = useState(defaultPolygon)
  const [draftPolygon, setDraftPolygon] = useState([])
  const [barrierStart, setBarrierStart] = useState(null)
  const [barrierHover, setBarrierHover] = useState(null)
  const [lineStart, setLineStart] = useState(null)
  const [lineHover, setLineHover] = useState(null)
  const [rayMode, setRayMode] = useState('off')
  const [distanceMode, setDistanceMode] = useState('off')
  const [distanceOpen, setDistanceOpen] = useState(false)
  const [distanceSourceId, setDistanceSourceId] = useState('')
  const [distanceReceiverId, setDistanceReceiverId] = useState('')
  const [cutOpen, setCutOpen] = useState(false)
  const [cutStart, setCutStart] = useState(null)
  const [cutEnd, setCutEnd] = useState(null)
  const [cutResult, setCutResult] = useState(null)
  const [cutLoading, setCutLoading] = useState(false)
  const [cutError, setCutError] = useState('')
  const [cutMaxHeight, setCutMaxHeight] = useState(30)
  const [cutModeType, setCutModeType] = useState('pair')
  const [cutSourceId, setCutSourceId] = useState('')
  const [cutReceiverId, setCutReceiverId] = useState('')
  const [searchOpen, setSearchOpen] = useState(true)
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
  const [locationMessage, setLocationMessage] = useState('Busca una dirección, pega coordenadas GPS o usa tu ubicación actual.')
  const [globalSettings, setGlobalSettings] = useState({
    prediction_model: 'ISO 9613-2:2024',
    a_weighting: true,
    ground_factor: 0,
    temperature_c: 15,
    humidity_pct: 70,
    c0_db: 0,
    barrier_limit: true,
    vertical_edge_diffraction: true,
    limit_distance: true,
    convex_path: true,
    reflection_order: 'first',
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
  const [receiverPreview, setReceiverPreview] = useState(null)
  const [receiverPreviewLoading, setReceiverPreviewLoading] = useState(false)
  const [receiverPreviewError, setReceiverPreviewError] = useState('')
  const [dirty, setDirty] = useState(true)
  const [selected, setSelected] = useState(null)
  const [controlEditorOpen, setControlEditorOpen] = useState(false)
  const [treatmentTab, setTreatmentTab] = useState('geometry')
  const [sourceCardPos, setSourceCardPos] = useState(null)
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
    buildings: true,
    roads: true,
    accessories: true,
    contours: true,
    rays: true,
    area: true
  })

  const barrierData = useMemo(() => barriersGeoJSON(barriers), [barriers])
  const buildingData = useMemo(() => buildingsGeoJSON(buildings), [buildings])
  const buildingDraftData = useMemo(() => lineGeoJSON(buildingDraft), [buildingDraft])
  const buildingDraftPolygonData = useMemo(() => polygonGeoJSON(buildingDraft), [buildingDraft])
  const selectedBuildingData = useMemo(() => {
    if (selected?.type !== 'building') return { type: 'FeatureCollection', features: [] }
    const building = buildings.find(item => item.id === selected.id)
    return building ? buildingsGeoJSON([building]) : { type: 'FeatureCollection', features: [] }
  }, [selected, buildings])
  const roadData = useMemo(() => roadsGeoJSON(roads), [roads])
  const roadDraftData = useMemo(() => lineGeoJSON(roadDraft), [roadDraft])
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
  const linePreviewData = useMemo(() => {
    if (!lineStart || !lineHover) return { type: 'FeatureCollection', features: [] }
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [[lineStart[1], lineStart[0]], [lineHover[1], lineHover[0]]]
        }
      }]
    }
  }, [lineStart, lineHover])
  const accessoryData = useMemo(() => accessoriesGeoJSON(accessories), [accessories])
  const contourData = useMemo(() => contoursGeoJSON(contours), [contours])
  const contourDraftData = useMemo(() => lineGeoJSON(contourDraft), [contourDraft])
  const rayData = useMemo(() => raysGeoJSON(sources, receivers, rayMode), [sources, receivers, rayMode])
  const cutLineData = useMemo(
    () => lineGeoJSON([cutStart, cutEnd].filter(Boolean)),
    [cutStart, cutEnd]
  )
  const distancePairs = useMemo(() => {
    if (distanceMode === 'off') return []

    if (distanceMode === 'selected') {
      const source = sources.find(item => item.id === distanceSourceId)
      const receiver = receivers.find(item => item.id === distanceReceiverId)
      if (!source || !receiver || !source.enabled || receiver.visible === false) return []
      const horizontal = haversineMeters(source.lat, source.lon, receiver.lat, receiver.lon)
      const vertical = Number(receiver.height_m || 0) - Number(source.height_m || 0)
      return [{
        id: `${source.id}:${receiver.id}`,
        source,
        receiver,
        horizontal,
        distance3d: Math.sqrt(horizontal * horizontal + vertical * vertical),
        barrierCrossings: barrierCrossingsForPair(source, receiver, barriers, horizontal)
      }]
    }

    const pairs = []
    sources.filter(item => item.enabled).forEach(source => {
      receivers.filter(item => item.visible !== false).forEach(receiver => {
        const horizontal = haversineMeters(source.lat, source.lon, receiver.lat, receiver.lon)
        const vertical = Number(receiver.height_m || 0) - Number(source.height_m || 0)
        pairs.push({
          id: `${source.id}:${receiver.id}`,
          source,
          receiver,
          horizontal,
          distance3d: Math.sqrt(horizontal * horizontal + vertical * vertical),
          barrierCrossings: barrierCrossingsForPair(source, receiver, barriers, horizontal)
        })
      })
    })
    return pairs
  }, [distanceMode, distanceSourceId, distanceReceiverId, sources, receivers, barriers])
  const distanceData = useMemo(() => distancePairsGeoJSON(distancePairs), [distancePairs])
  const polygonData = useMemo(() => polygonGeoJSON(polygon), [polygon])
  const draftData = useMemo(() => polygonGeoJSON(draftPolygon), [draftPolygon])

  const displayLevels = useMemo(
    () => cleanDisplayLevels(result?.levels, result?.bounds, sources, barriers),
    [result, sources, barriers]
  )

  const rasterUrl = useMemo(
    () => rasterDataUrl(displayLevels, vmin, vmax, result?.bounds, barriers),
    [displayLevels, vmin, vmax, result, barriers]
  )

  const noiseIsolines = useMemo(
    () => noiseIsolinesGeoJSON(displayLevels, result?.bounds, vmin, vmax, 5, barriers),
    [displayLevels, result, vmin, vmax, barriers]
  )

  const legendTicks = useMemo(
    () => [85,80,75,70,65,60,55,50,45,40,35],
    []
  )

  useEffect(() => {
    setDirty(true)
  }, [sources, receivers, barriers, buildings, roads, contours, polygon, resolution, height, alpha, frequency, globalSettings])

  useEffect(() => {
    // Wake the free Render instance in the background as soon as the app opens.
    // This reduces the wait when the user performs the first calculation.
    let cancelled = false
    const wake = async () => {
      try {
        await fetch(`${API_BASE}/api/health`, {
          method: 'GET',
          cache: 'no-store'
        })
      } catch (error) {
        if (!cancelled) console.debug('Backend warm-up pendiente:', error)
      }
    }
    wake()
    return () => { cancelled = true }
  }, [])

  const onMapMouseMove = event => {
    const { lat, lng } = event.lngLat
    if (mode === 'barrier' && barrierStart) {
      setBarrierHover([lat, lng])
    }
    if (mode === 'line' && lineStart) {
      setLineHover([lat, lng])
    }
  }

  const runSelectedPairCut = async () => {
    const sourceId = cutSourceId || distanceSourceId
    const receiverId = cutReceiverId || distanceReceiverId
    const source = sources.find(item => item.id === sourceId)
    const receiver = receivers.find(item => item.id === receiverId)
    if (!source || !receiver) {
      setCutError('Selecciona una fuente y un receptor para generar la sección transversal.')
      setCutOpen(true)
      return
    }

    setCutModeType('pair')
    setCutSourceId(source.id)
    setCutReceiverId(receiver.id)
    setDistanceSourceId(source.id)
    setDistanceReceiverId(receiver.id)

    const startPoint = [Number(source.lat), Number(source.lon)]
    const endPoint = [Number(receiver.lat), Number(receiver.lon)]
    setCutStart(startPoint)
    setCutEnd(endPoint)
    setMode('navigate')
    await runAcousticCut(startPoint, endPoint)
  }

  const runAcousticCut = async (startPoint = cutStart, endPoint = cutEnd) => {
    if (!startPoint || !endPoint) return

    setCutLoading(true)
    setCutError('')
    setCutOpen(true)
    try {
      const response = await fetch(`${API_BASE}/api/acoustic-cut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources,
          roads,
          barriers,
          buildings,
          contours,
          start: startPoint,
          end: endPoint,
          max_height_m: cutMaxHeight,
          horizontal_samples: 56,
          vertical_samples: 32,
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
            c0_db: globalSettings.c0_db,
            max_barrier_db: globalSettings.barrier_limit ? 20 : 80,
            reflections_enabled: globalSettings.reflection_order !== 'none'
          }
        })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.detail || `HTTP ${response.status}`)
      setCutResult(data)
    } catch (error) {
      console.error('Corte acústico:', error)
      setCutResult(null)
      setCutError(error.message || 'No fue posible calcular el corte acústico.')
    } finally {
      setCutLoading(false)
    }
  }

  const onMapClick = event => {
    const { lat, lng } = event.lngLat

    if (mode === 'cut') {
      if (!cutStart) {
        setCutStart([lat, lng])
        setCutEnd(null)
        setCutResult(null)
      } else {
        const endPoint = [lat, lng]
        setCutEnd(endPoint)
        setMode('navigate')
        runAcousticCut(cutStart, endPoint)
      }
      return
    }

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
        time_active_pct: 100,
        noise_control_type: 'none',
        control_global_db: 0,
        control_direct_db: 0,
        control_reduction_db: { ...DEFAULT_CONTROL_BANDS },
        silencer_il_db: { ...DEFAULT_SILENCER_IL },
        enclosure_tl_db: { ...DEFAULT_ENCLOSURE_TL },
        enclosure_leak_pct: 0,
        enclosure_vent_pct: 10,
        enclosure_length_m: 2,
        enclosure_width_m: 2,
        enclosure_height_m: 2.5,
        enclosure_azimuth_deg: 0,
        enclosure_rw_db: 30,
        enclosure_faces: defaultEnclosureFaces(),
        enclosure_lining_mode: 'unlined',
        enclosure_absorption_coeff: { ...ENCLOSURE_ABSORPTION_PRESETS.unlined },
        enclosure_vent_area_m2: 0.10,
        enclosure_vent_face: 'back',
        semi_opening_pct: 25,
        semi_opening_azimuth_deg: 0,
        semi_opening_angle_deg: 90
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
        setLineHover([lat, lng])
      } else {
        const item = {
          id: crypto.randomUUID(),
          name: `Línea auxiliar ${accessories.length + 1}`,
          kind: 'measurement',
          lat_a: lineStart[0],
          lon_a: lineStart[1],
          lat_b: lat,
          lon_b: lng,
          height_m: 0
        }
        setAccessories(prev => [...prev, item])
        setSelected({ type: 'accessory', id: item.id })
        setLineStart(null)
        setLineHover(null)
      }
      return
    }

    if (mode === 'road') {
      setRoadDraft(prev => [...prev, [lat, lng]])
      return
    }

    if (mode === 'contour') {
      setContourDraft(prev => [...prev, [lat, lng]])
      return
    }

    if (mode === 'building') {
      setBuildingDraft(prev => [...prev, [lat, lng]])
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
        camera: mapRef.current ? {
          longitude: mapRef.current.getCenter().lng,
          latitude: mapRef.current.getCenter().lat,
          zoom: mapRef.current.getZoom(),
          bearing: mapRef.current.getBearing(),
          pitch: mapRef.current.getPitch()
        } : null,
        sources,
        receivers,
        barriers,
        buildings,
        roads,
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
      setBuildings(Array.isArray(data.buildings) ? data.buildings : [])
      setRoads(Array.isArray(data.roads) ? data.roads : [])
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
      setLineHover(null)
      setProjectMessage(
        data.result
          ? 'Proyecto cargado con su último cálculo. Si modificas algo, vuelve a calcular el mapa.'
          : 'Proyecto cargado correctamente.'
      )

      if (
        data.camera &&
        Number.isFinite(Number(data.camera.longitude)) &&
        Number.isFinite(Number(data.camera.latitude))
      ) {
        mapRef.current?.jumpTo({
          center: [Number(data.camera.longitude), Number(data.camera.latitude)],
          zoom: Number.isFinite(Number(data.camera.zoom)) ? Number(data.camera.zoom) : 16,
          bearing: Number.isFinite(Number(data.camera.bearing)) ? Number(data.camera.bearing) : 0,
          pitch: Number.isFinite(Number(data.camera.pitch)) ? Number(data.camera.pitch) : 0
        })
      } else if (data.polygon.length >= 3) {
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

  const calculate = async (scenarioOverride = null) => {
    const hasScenarioOverride = Boolean(scenarioOverride?.__profileScenario)
    const calcSources = hasScenarioOverride ? scenarioOverride.sources : sources
    const calcReceivers = hasScenarioOverride ? scenarioOverride.receivers : receivers
    const calcBarriers = hasScenarioOverride ? scenarioOverride.barriers : barriers

    if (!calcSources.some(s => s.enabled)) return

    const pendingCourseSources = calcSources.filter(
      s => s.enabled && (s.course_power_pending || s.lw_db == null || s.lw_db === '')
    )
    if (pendingCourseSources.length) {
      alert(
        'Antes de calcular, ingresa el LwA de: ' +
        pendingCourseSources.map(s => s.name).join(', ') +
        '. Estos valores deben provenir de tu conversión de la Etapa 8.'
      )
      return
    }

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
      sources: calcSources,
      receivers: calcReceivers,
      barriers: calcBarriers,
      buildings,
      roads,
      contours,
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
        c0_db: globalSettings.c0_db,
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

  const finishRoad = () => {
    if (roadDraft.length < 2) return
    const item = {
      id: crypto.randomUUID(),
      name: `Vía ${roads.length + 1}`,
      points: roadDraft,
      enabled: true,
      q_light_vph: 800,
      q_medium_vph: 40,
      q_heavy_vph: 30,
      speed_light_kmh: 50,
      speed_medium_kmh: 50,
      speed_heavy_kmh: 50
    }
    setRoads(prev => [...prev, item])
    setRoadDraft([])
    setSelected({ type: 'road', id: item.id })
    setMode('navigate')
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

  const finishBuilding = () => {
    if (buildingDraft.length < 3) return
    const item = {
      id: crypto.randomUUID(),
      name: `Edificio ${buildings.length + 1}`,
      points: buildingDraft,
      height_m: 10,
      enabled: true,
      reflection_percent: 20,
      receiver_start_height_m: 1.5,
      receiver_spacing_m: 3,
      receiver_offset_m: 1
    }
    setBuildings(prev => [...prev, item])
    setBuildingDraft([])
    setBuildingFacadeIndex(0)
    setSelected({ type: 'building', id: item.id })
    setMode('navigate')
  }

  const addFacadeReceivers = building => {
    const pts = building?.points || []
    if (pts.length < 3) return

    const edgeIndex = Math.max(0, Math.min(pts.length - 1, Number(buildingFacadeIndex) || 0))
    const a = pts[edgeIndex]
    const b = pts[(edgeIndex + 1) % pts.length]
    const midLat = (Number(a[0]) + Number(b[0])) / 2
    const midLon = (Number(a[1]) + Number(b[1])) / 2

    const centroidLat = pts.reduce((sum, point) => sum + Number(point[0]), 0) / pts.length
    const centroidLon = pts.reduce((sum, point) => sum + Number(point[1]), 0) / pts.length
    let dLat = midLat - centroidLat
    let dLon = (midLon - centroidLon) * Math.cos(midLat * Math.PI / 180)
    const norm = Math.hypot(dLat, dLon) || 1
    dLat /= norm
    dLon /= norm

    const metersPerDegLat = 111320
    const offsetM = Math.max(0.1, Number(building.receiver_offset_m) || 1)
    const lat = midLat + (dLat * offsetM) / metersPerDegLat
    const lon = midLon + (dLon * offsetM) / (metersPerDegLat * Math.max(Math.cos(midLat * Math.PI / 180), 0.2))

    const maxHeight = Math.max(0.5, Number(building.height_m) || 10)
    const startHeight = Math.max(0.1, Math.min(maxHeight, Number(building.receiver_start_height_m) || 1.5))
    const spacing = Math.max(0.1, Number(building.receiver_spacing_m) || 3)

    const associated = receivers.filter(receiver => receiver.building_id === building.id)
    const maxExistingSequence = associated.reduce((maxValue, receiver) => {
      const match = String(receiver.name || '').match(/^RE(\d+)$/i)
      return match ? Math.max(maxValue, Number(match[1])) : maxValue
    }, 0)

    const newReceivers = []
    let sequence = maxExistingSequence + 1
    for (let h = startHeight; h <= maxHeight + 0.001; h += spacing) {
      newReceivers.push({
        id: crypto.randomUUID(),
        name: `RE${sequence}`,
        lat,
        lon,
        height_m: Number(h.toFixed(2)),
        visible: true,
        height_mode: 'facade',
        building_id: building.id,
        facade_index: edgeIndex
      })
      sequence += 1
    }

    setReceivers(prev => [...prev, ...newReceivers])
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
    setBuildingDraft([])
    setContourDraft([])
    setRoadDraft([])
    setBarrierStart(null)
    setBarrierHover(null)
    setLineStart(null)
    setLineHover(null)
    if (mode === 'cut') {
      setCutStart(null)
      setCutEnd(null)
      setCutResult(null)
      setCutError('')
      setCutOpen(false)
    }
    setMode('navigate')
  }


  const goToLocation = (latValue, lonValue, zoom = 18, closeDialog = false) => {
    const lat = Number(latValue)
    const lon = Number(lonValue)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setLocationMessage('Las coordenadas ingresadas no son válidas.')
      return
    }

    mapRef.current?.flyTo({
      center: [lon, lat],
      zoom,
      duration: 900,
      essential: true
    })
    setLocationMessage(`Ubicación seleccionada: ${lat.toFixed(6)}, ${lon.toFixed(6)}`)
    if (closeDialog) setSearchOpen(false)
  }

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocationMessage('Este navegador no permite obtener la ubicación actual.')
      return
    }

    setLocationMessage('Obteniendo ubicación…')
    navigator.geolocation.getCurrentPosition(
      position => {
        const { latitude, longitude } = position.coords
        goToLocation(latitude, longitude, 18, true)
      },
      error => {
        console.error(error)
        setLocationMessage(
          error.code === 1
            ? 'No se autorizó el acceso a la ubicación. Puedes buscar una dirección o pegar coordenadas GPS.'
            : 'No fue posible obtener la ubicación. Puedes buscar una dirección o pegar coordenadas GPS.'
        )
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    )
  }

  const fitProject = () => {
    const points = []

    sources.forEach(item => points.push([Number(item.lon), Number(item.lat)]))
    receivers.forEach(item => points.push([Number(item.lon), Number(item.lat)]))
    barriers.forEach(item => {
      points.push([Number(item.lon_a), Number(item.lat_a)])
      points.push([Number(item.lon_b), Number(item.lat_b)])
    })
    buildings.forEach(item => item.points?.forEach(([lat, lon]) => points.push([Number(lon), Number(lat)])))
    roads.forEach(item => item.points?.forEach(([lat, lon]) => points.push([Number(lon), Number(lat)])))
    accessories.forEach(item => {
      points.push([Number(item.lon_a), Number(item.lat_a)])
      points.push([Number(item.lon_b), Number(item.lat_b)])
    })
    contours.forEach(item => item.points?.forEach(([lat, lon]) => points.push([Number(lon), Number(lat)])))
    polygon.forEach(([lat, lon]) => points.push([Number(lon), Number(lat)]))

    const valid = points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    if (!valid.length) {
      setLocationMessage('Aún no hay objetos en el proyecto para ajustar la vista.')
      return
    }

    if (valid.length === 1) {
      mapRef.current?.flyTo({ center: valid[0], zoom: 18, duration: 700 })
      return
    }

    const lons = valid.map(point => point[0])
    const lats = valid.map(point => point[1])
    mapRef.current?.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 90, duration: 900, maxZoom: 18 }
    )
  }

  const normalizePhotonResults = payload => {
    return (payload?.features || []).map(feature => {
      const coordinates = feature?.geometry?.coordinates || []
      const props = feature?.properties || {}
      if (coordinates.length < 2) return null

      const parts = []
      const house = props.housenumber
      const street = props.street || props.name
      if (street) parts.push(house ? `${street} ${house}` : String(street))
      for (const key of ['district', 'city', 'county', 'state', 'country']) {
        const value = props[key]
        if (value && !parts.includes(String(value))) parts.push(String(value))
      }

      return {
        display_name: parts.join(', ') || 'Resultado de búsqueda',
        lat: Number(coordinates[1]),
        lon: Number(coordinates[0]),
        type: props.type || ''
      }
    }).filter(item => item && Number.isFinite(item.lat) && Number.isFinite(item.lon))
  }

  const searchLocationDirectly = async query => {
    // Browser-side fallback: keeps location search working even if Render
    // cannot reach the external geocoding providers.
    const providers = [
      async () => {
        const response = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=es`
        )
        if (!response.ok) throw new Error(`Photon HTTP ${response.status}`)
        return normalizePhotonResults(await response.json())
      },
      async () => {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&addressdetails=1&q=${encodeURIComponent(query)}`,
          { headers: { 'Accept-Language': 'es' } }
        )
        if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`)
        const payload = await response.json()
        return payload.map(item => ({
          display_name: item.display_name || 'Resultado de búsqueda',
          lat: Number(item.lat),
          lon: Number(item.lon),
          type: item.type || ''
        })).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon))
      }
    ]

    for (const provider of providers) {
      try {
        const results = await provider()
        if (results.length) return results.slice(0, 5)
      } catch (error) {
        console.debug('Geocodificador directo no disponible:', error)
      }
    }
    return []
  }


  useEffect(() => {
    if (coursePresetLoadedRef.current) return

    const params = new URLSearchParams(window.location.search)
    const scenarioKey = params.get('scenario')
    if (!COURSE3_STAGE8_PRESETS[scenarioKey]) return

    coursePresetLoadedRef.current = true
    let cancelled = false

    const loadCoursePreset = async () => {
      setLocationMessage('Cargando escenario didáctico de la Etapa 8…')
      setSearchText('Parque Bicentenario de Cerrillos, Santiago, Chile')

      const results = await searchLocationDirectly('Parque Bicentenario de Cerrillos, Santiago, Chile')
      if (cancelled) return

      const origin = results[0]
      if (!origin) {
        setLocationMessage(
          'No fue posible ubicar automáticamente Parque Bicentenario de Cerrillos. Usa Buscar y luego vuelve a abrir el escenario.'
        )
        return
      }

      // El geocodificador entrega un punto de referencia dentro del Parque
      // Bicentenario de Cerrillos. El rectángulo didáctico 50 × 40 m se centra
      // en ese punto para mantenerlo dentro de un paño amplio y evitar calles.
      const presetConfig = COURSE3_STAGE8_PRESETS[scenarioKey]
      const halfWidth = Number(presetConfig?.width_m || 50) / 2
      const halfHeight = Number(presetConfig?.height_m || 40) / 2
      const [originLat, originLon] = coursePresetLocalToLatLon(
        -halfWidth, -halfHeight, Number(origin.lat), Number(origin.lon)
      )
      const preset = buildCourseStage8Preset(scenarioKey, originLat, originLon)
      if (!preset) return

      setSources(preset.sources)
      setReceivers(preset.receivers)
      setBarriers([])
      setBuildings([])
      setRoads([])
      setAccessories(preset.accessories || [])
      setContours([])
      setPolygon([])
      setResult(null)
      setSelected(null)
      setMode('navigate')
      setDraftPolygon([])
      setSearchOpen(false)
      setPanelOpen(false)
      setResultsOpen(false)
      setProjectOpen(false)
      setDirty(true)
      setGlobalSettings(prev => ({
        ...prev,
        a_weighting: true,
        ground_factor: 0,
        temperature_c: 15,
        humidity_pct: 70,
        c0_db: 0
      }))
      setLocationMessage(
        scenarioKey === 'c3l1-s10'
          ? preset.title + ' cargado. Solo se entrega la demarcación del predio. Debes crear fuentes, receptores y área de cálculo según tu estrategia de modelación.'
          : preset.title + ' cargado. El predio está demarcado con líneas auxiliares y las fuentes ya tienen posición y altura. Ingresa los LwA, agrega tus receptores y después dibuja tú mismo el área de cálculo.'
      )

      window.setTimeout(() => {
        if (!mapRef.current) return
        const allPoints = [...(preset.boundaryPoints || [])]
        const lats = allPoints.map(p => Number(p[0]))
        const lons = allPoints.map(p => Number(p[1]))
        mapRef.current.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 90, duration: 900, maxZoom: 19 }
        )
      }, 350)
    }

    loadCoursePreset().catch(error => {
      console.error('Preset Etapa 8:', error)
      if (!cancelled) {
        setLocationMessage('No fue posible cargar automáticamente el escenario didáctico.')
      }
    })

    return () => { cancelled = true }
  }, [])

  const runSearch = async () => {
    const q = searchText.trim()
    if (!q) {
      setLocationMessage('Escribe una dirección, lugar o coordenadas.')
      return
    }

    const coordinateMatch = q.match(/^\\s*(-?\\d+(?:\\.\\d+)?)\\s*[,; ]\\s*(-?\\d+(?:\\.\\d+)?)\\s*$/)
    if (coordinateMatch) {
      const lat = Number(coordinateMatch[1])
      const lon = Number(coordinateMatch[2])
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        setLocationMessage('Las coordenadas deben estar entre ±90° de latitud y ±180° de longitud.')
        return
      }
      setSearchResults([{ display_name: `Coordenadas ${lat.toFixed(6)}, ${lon.toFixed(6)}`, lat, lon }])
      goToLocation(lat, lon, 18)
      return
    }

    setSearching(true)
    setLocationMessage('Buscando ubicación…')

    let results = []
    let backendFailed = false

    try {
      const response = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(q)}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      results = data.results || []
      backendFailed = Boolean(data.service_error)
    } catch (error) {
      console.debug('Búsqueda backend no disponible:', error)
      backendFailed = true
    }

    if (!results.length) {
      results = await searchLocationDirectly(q)
    }

    setSearchResults(results)

    if (results[0]) {
      goToLocation(results[0].lat, results[0].lon, 17)
      setLocationMessage('Selecciona un resultado para comenzar a trabajar en ese lugar.')
    } else if (backendFailed) {
      setLocationMessage('No fue posible consultar los buscadores geográficos. Puedes intentar nuevamente o pegar coordenadas GPS.')
    } else {
      setLocationMessage('No se encontraron resultados. Prueba agregando ciudad y país, por ejemplo: “San Francisco 335, Santiago, Chile”.')
    }

    setSearching(false)
  }

  const selectedObject = (() => {
    if (!selected) return null
    if (selected.type === 'source') return sources.find(x => x.id === selected.id)
    if (selected.type === 'receiver') return receivers.find(x => x.id === selected.id)
    if (selected.type === 'barrier') return barriers.find(x => x.id === selected.id)
    if (selected.type === 'building') return buildings.find(x => x.id === selected.id)
    if (selected.type === 'road') return roads.find(x => x.id === selected.id)
    if (selected.type === 'accessory') return accessories.find(x => x.id === selected.id)
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
            sources: sources.map(item =>
              item.id === source.id ? source : item
            ),
            roads,
            barriers: barriers.map(item =>
              item.id === barrier.id ? barrier : item
            ),
            buildings,
            contours,
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
              c0_db: globalSettings.c0_db,
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
    buildings,
    roads,
    contours,
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

  const saveProfileChangesToMap = async () => {
    if (!profileDraft || selected?.type !== 'barrier') return
    const coords = draftProfileCoordinates(profileDraft)
    if (!coords) return

    const selectedBarrierId = selected.id

    const nextSources = sources.map(item =>
      item.id === profileSourceId
        ? {
            ...item,
            lat: coords.source.lat,
            lon: coords.source.lon,
            height_m: Number(profileDraft.source_height_m)
          }
        : item
    )

    const nextReceivers = receivers.map(item =>
      item.id === profileReceiverId
        ? {
            ...item,
            lat: coords.receiver.lat,
            lon: coords.receiver.lon,
            height_m: Number(profileDraft.receiver_height_m),
            height_mode: 'specify'
          }
        : item
    )

    const nextBarriers = barriers.map(item =>
      item.id === selectedBarrierId
        ? { ...item, height_m: Number(profileDraft.barrier_height_m) }
        : item
    )

    // Commit exactly the same geometry that was previewed in the profile.
    setSources(nextSources)
    setReceivers(nextReceivers)
    setBarriers(nextBarriers)
    setDirty(true)
    setBarrierProfileOpen(false)
    setProfileDraft(null)

    // Recalculate with the newly committed objects immediately. Passing the
    // explicit scenario avoids React's asynchronous state update from causing
    // the old source/receiver/barrier geometry to be sent to the API.
    await calculate({
      __profileScenario: true,
      sources: nextSources,
      receivers: nextReceivers,
      barriers: nextBarriers
    })
  }

  useEffect(() => {
    if (selected?.type !== 'receiver' || !selectedObject) {
      setReceiverPreview(null)
      setReceiverPreviewLoading(false)
      setReceiverPreviewError('')
      return
    }

    let cancelled = false
    setReceiverPreview(null)
    setReceiverPreviewError('')
    const timer = setTimeout(async () => {
      setReceiverPreviewLoading(true)
      try {
        const response = await fetch(`${API_BASE}/api/receiver-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sources,
            roads,
            receiver: selectedObject,
            barriers,
            buildings,
            contours,
            settings: {
              resolution,
              receiver_height_m: selectedObject.height_m,
              alpha_db_per_km: alpha,
              frequency_hz: frequency,
              vmin,
              vmax,
              prediction_model: globalSettings.prediction_model,
              a_weighting: globalSettings.a_weighting,
              ground_factor: globalSettings.ground_factor,
              temperature_c: globalSettings.temperature_c,
              humidity_pct: globalSettings.humidity_pct,
              c0_db: globalSettings.c0_db,
              max_barrier_db: globalSettings.barrier_limit ? 20 : 80,
              reflections_enabled: globalSettings.reflection_order !== 'none'
            }
          })
        })
        const data = await response.json()
        if (!response.ok) {
          const detail = Array.isArray(data?.detail)
            ? data.detail.map(item => item?.msg || JSON.stringify(item)).join(' · ')
            : typeof data?.detail === 'object' && data?.detail !== null
              ? JSON.stringify(data.detail)
              : data?.detail
          throw new Error(detail || `HTTP ${response.status}`)
        }
        if (!cancelled) setReceiverPreview(data)
      } catch (error) {
        console.error('Vista previa de receptor:', error)
        if (!cancelled) {
          setReceiverPreview(null)
          setReceiverPreviewError(error.message || 'No fue posible actualizar el nivel puntual.')
        }
      } finally {
        if (!cancelled) setReceiverPreviewLoading(false)
      }
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    selected,
    selectedObject,
    sources,
    barriers,
    buildings,
    roads,
    contours,
    alpha,
    frequency,
    vmin,
    vmax,
    resolution,
    globalSettings
  ])

  const selectedReceiverResult = selected?.type === 'receiver'
    ? result?.receiver_results?.find(item => item.id === selected.id)
    : null


  useEffect(() => {
    const canvas = cutCanvasRef.current
    if (!canvas || !cutResult?.levels?.length || !cutStart || !cutEnd) return

    const width = 920
    const heightPx = 430
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    canvas.width = width * dpr
    canvas.height = heightPx * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, heightPx)

    const margin = { left: 58, right: 22, top: 22, bottom: 48 }
    const plotW = width - margin.left - margin.right
    const plotH = heightPx - margin.top - margin.bottom
    const levels = cutResult.levels
    const rows = levels.length
    const cols = levels[0]?.length || 0
    if (!rows || !cols) return

    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(margin.left, margin.top, plotW, plotH)

    // Render the acoustic field from the calculated nodes using bilinear
    // interpolation before applying the 5 dB colour classes. This keeps the
    // standard discrete palette while removing the visible calculation cells.
    const fieldCanvas = document.createElement('canvas')
    const fieldW = Math.max(2, Math.round(plotW))
    const fieldH = Math.max(2, Math.round(plotH))
    fieldCanvas.width = fieldW
    fieldCanvas.height = fieldH
    const fieldCtx = fieldCanvas.getContext('2d')
    const fieldImage = fieldCtx.createImageData(fieldW, fieldH)

    for (let py = 0; py < fieldH; py += 1) {
      const gy = (py / Math.max(fieldH - 1, 1)) * (rows - 1)
      for (let px = 0; px < fieldW; px += 1) {
        const gx = (px / Math.max(fieldW - 1, 1)) * (cols - 1)
        const value = bilinearMatrixValue(levels, gx, gy)
        const index = (py * fieldW + px) * 4
        if (value == null || !Number.isFinite(value)) {
          fieldImage.data[index + 3] = 0
          continue
        }
        const [r, g, b] = levelColor(value, vmin, vmax)
        fieldImage.data[index] = r
        fieldImage.data[index + 1] = g
        fieldImage.data[index + 2] = b
        fieldImage.data[index + 3] = 205
      }
    }
    fieldCtx.putImageData(fieldImage, 0, 0)
    ctx.drawImage(fieldCanvas, margin.left, margin.top, plotW, plotH)

    const zMin = Number(cutResult.z_min_m)
    const zMax = Number(cutResult.z_max_m)
    const distanceM = Math.max(1, Number(cutResult.distance_m))
    const xFor = d => margin.left + (Number(d) / distanceM) * plotW
    const yFor = z => margin.top + (1 - (Number(z) - zMin) / Math.max(zMax - zMin, 0.001)) * plotH

    // Terrain silhouette.
    const terrain = cutResult.terrain_profile || []
    if (terrain.length) {
      ctx.beginPath()
      ctx.moveTo(xFor(terrain[0].distance_m), yFor(terrain[0].elevation_m))
      terrain.slice(1).forEach(item => ctx.lineTo(xFor(item.distance_m), yFor(item.elevation_m)))
      ctx.lineTo(xFor(distanceM), margin.top + plotH)
      ctx.lineTo(margin.left, margin.top + plotH)
      ctx.closePath()
      ctx.fillStyle = 'rgba(70,79,88,0.72)'
      ctx.fill()
      ctx.beginPath()
      terrain.forEach((item, index) => {
        const x = xFor(item.distance_m)
        const y = yFor(item.elevation_m)
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.strokeStyle = '#26313b'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    const toLocalXY = (lat, lon) => {
      const meanLat = ((Number(cutStart[0]) + Number(cutEnd[0])) / 2) * Math.PI / 180
      const metersPerDegLat = 111320
      const metersPerDegLon = 111320 * Math.max(Math.cos(meanLat), 0.2)
      const x = (Number(lon) - Number(cutStart[1])) * metersPerDegLon
      const y = (Number(lat) - Number(cutStart[0])) * metersPerDegLat
      return [x, y]
    }
    const [abx, aby] = toLocalXY(cutEnd[0], cutEnd[1])
    const abLen2 = Math.max(abx * abx + aby * aby, 1)
    const projectToCut = (lat, lon) => {
      const [px, py] = toLocalXY(lat, lon)
      const tRaw = (px * abx + py * aby) / abLen2
      const t = Math.max(0, Math.min(1, tRaw))
      const cross = Math.abs(px * aby - py * abx) / Math.sqrt(abLen2)
      return { t, cross }
    }

    // Show sources and receivers that lie close to the A-B vertical plane.
    const cutToleranceM = 8
    sources.filter(item => item.enabled).forEach(source => {
      const projected = projectToCut(source.lat, source.lon)
      const isSelectedPairSource = source.id === (cutSourceId || distanceSourceId)
      if (projected.cross > cutToleranceM && !isSelectedPairSource) return
      const terrainIndex = Math.min(
        terrain.length - 1,
        Math.max(0, Math.round(projected.t * Math.max(terrain.length - 1, 0)))
      )
      const ground = terrain[terrainIndex]?.elevation_m ?? zMin
      const z = Number(ground) + Number(source.height_m || 0)
      const x = margin.left + projected.t * plotW
      const y = yFor(z)

      ctx.beginPath()
      ctx.arc(x, y, 6, 0, Math.PI * 2)
      ctx.fillStyle = '#d93648'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#7d2430'
      ctx.font = '700 10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(source.name || 'F', x, y - 10)
      if (projected.cross > cutToleranceM) {
        ctx.font = '600 8px system-ui, sans-serif'
        ctx.fillStyle = '#8b4a53'
        ctx.fillText(`offset lateral ${projected.cross.toFixed(1)} m`, x, y + 15)
      }
    })

    receivers.filter(item => item.visible !== false).forEach(receiver => {
      const projected = projectToCut(receiver.lat, receiver.lon)
      const isSelectedPairReceiver = receiver.id === (cutReceiverId || distanceReceiverId)
      if (projected.cross > cutToleranceM && !isSelectedPairReceiver) return
      const terrainIndex = Math.min(
        terrain.length - 1,
        Math.max(0, Math.round(projected.t * Math.max(terrain.length - 1, 0)))
      )
      const ground = terrain[terrainIndex]?.elevation_m ?? zMin
      const z = Number(ground) + Number(receiver.height_m || 0)
      const x = margin.left + projected.t * plotW
      const y = yFor(z)

      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#0b63ce'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#0b3768'
      ctx.font = '700 10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(receiver.name || 'R', x, y - 10)
      if (projected.cross > cutToleranceM) {
        ctx.font = '600 8px system-ui, sans-serif'
        ctx.fillStyle = '#315d8f'
        ctx.fillText(`offset lateral ${projected.cross.toFixed(1)} m`, x, y + 15)
      }
    })

    const activeCutSourceId = cutSourceId || distanceSourceId
    const activeCutReceiverId = cutReceiverId || distanceReceiverId
    const selectedCutSource = sources.find(item => item.id === activeCutSourceId)
    const selectedCutReceiver = receivers.find(item => item.id === activeCutReceiverId)
    if (selectedCutSource && selectedCutReceiver) {
      const srcProj = projectToCut(selectedCutSource.lat, selectedCutSource.lon)
      const recProj = projectToCut(selectedCutReceiver.lat, selectedCutReceiver.lon)
      const srcTerrainIndex = Math.min(
        terrain.length - 1,
        Math.max(0, Math.round(srcProj.t * Math.max(terrain.length - 1, 0)))
      )
      const recTerrainIndex = Math.min(
        terrain.length - 1,
        Math.max(0, Math.round(recProj.t * Math.max(terrain.length - 1, 0)))
      )
      const srcGround = terrain[srcTerrainIndex]?.elevation_m ?? zMin
      const recGround = terrain[recTerrainIndex]?.elevation_m ?? zMin
      const sx = margin.left + srcProj.t * plotW
      const sy = yFor(Number(srcGround) + Number(selectedCutSource.height_m || 0))
      const rx = margin.left + recProj.t * plotW
      const ry = yFor(Number(recGround) + Number(selectedCutReceiver.height_m || 0))

      // Draw the source-side control measure in the F-R section.
      const controlType = selectedCutSource.noise_control_type || 'none'
      if (controlType !== 'none') {
        const direction = rx >= sx ? 1 : -1
        const boxW = 34
        const boxH = 28
        const left = sx - boxW / 2
        const top = sy - boxH / 2
        const right = sx + boxW / 2
        const bottom = sy + boxH / 2

        ctx.save()
        ctx.lineWidth = 2
        ctx.strokeStyle = '#24364b'
        ctx.fillStyle = 'rgba(255,255,255,.74)'

        if (controlType === 'enclosure' || controlType === 'enclosure_silencer') {
          ctx.fillRect(left, top, boxW, boxH)
          ctx.strokeRect(left, top, boxW, boxH)
        }

        if (controlType === 'semi') {
          const bearingToReceiver = bearingDegrees(
            selectedCutSource.lat,
            selectedCutSource.lon,
            selectedCutReceiver.lat,
            selectedCutReceiver.lon
          )
          const faceName = enclosureFaceForBearing(selectedCutSource, bearingToReceiver)
          const face = {
            ...defaultEnclosureFaces()[faceName],
            ...(selectedCutSource.enclosure_faces?.[faceName] || {})
          }
          const isOpen = face.state === 'open'
          const isPartial = face.state === 'partial'

          ctx.fillRect(left, top, boxW, boxH)
          ctx.beginPath()
          ctx.moveTo(left, top)
          ctx.lineTo(right, top)
          ctx.moveTo(left, bottom)
          ctx.lineTo(right, bottom)
          const closedX = direction > 0 ? left : right
          ctx.moveTo(closedX, top)
          ctx.lineTo(closedX, bottom)
          if (!isOpen) {
            const receiverSideX = direction > 0 ? right : left
            if (isPartial) ctx.setLineDash([4,3])
            ctx.moveTo(receiverSideX, top)
            ctx.lineTo(receiverSideX, bottom)
            ctx.setLineDash([])
          }
          ctx.stroke()

          ctx.fillStyle = '#8a5200'
          ctx.font = '700 8px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(
            `${faceName} · ${isOpen ? 'abierta' : isPartial ? `parcial ${face.opening_pct || 0}%` : 'cerrada'}`,
            sx,
            top - 15
          )
        }

        if (controlType === 'silencer' || controlType === 'enclosure_silencer') {
          const ductStart = controlType === 'enclosure_silencer'
            ? (direction > 0 ? right : left)
            : sx + direction * 8
          const silW = 24
          const silH = 12
          const silCenter = ductStart + direction * 20
          const silLeft = silCenter - silW / 2
          const silTop = sy - silH / 2

          ctx.strokeStyle = '#445b73'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(ductStart, sy)
          ctx.lineTo(direction > 0 ? silLeft : silLeft + silW, sy)
          ctx.stroke()
          ctx.fillStyle = 'rgba(235,242,248,.94)'
          ctx.fillRect(silLeft, silTop, silW, silH)
          ctx.strokeRect(silLeft, silTop, silW, silH)
          ctx.fillStyle = '#32485e'
          ctx.font = '800 7px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('SIL', silCenter, sy + 2.5)
        }

        if (controlType === 'direct') {
          ctx.fillStyle = 'rgba(255,255,255,.90)'
          ctx.fillRect(sx - 20, sy - 26, 40, 13)
          ctx.strokeStyle = '#5f6f7f'
          ctx.lineWidth = 1
          ctx.strokeRect(sx - 20, sy - 26, 40, 13)
        }

        ctx.fillStyle = '#24364b'
        ctx.font = '800 8px system-ui, sans-serif'
        ctx.textAlign = 'center'
        const controlLabel = ({
          direct: 'Reducción directa',
          silencer: 'Silenciador',
          enclosure: 'Encierro',
          semi: 'Semiencierro',
          enclosure_silencer: 'Encierro + SIL'
        })[controlType] || 'Control'
        ctx.fillText(controlLabel, sx, top - 5)
        ctx.restore()
      }

      ctx.save()
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(rx, ry)
      ctx.strokeStyle = 'rgba(55,65,81,.72)'
      ctx.lineWidth = 1.6
      ctx.setLineDash([6, 5])
      ctx.stroke()
      ctx.setLineDash([])

      const mx = (sx + rx) / 2
      const my = (sy + ry) / 2
      const horizontal = haversineMeters(
        selectedCutSource.lat,
        selectedCutSource.lon,
        selectedCutReceiver.lat,
        selectedCutReceiver.lon
      )
      ctx.fillStyle = 'rgba(255,255,255,.92)'
      ctx.fillRect(mx - 28, my - 9, 56, 17)
      ctx.fillStyle = '#374151'
      ctx.font = '700 9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`${horizontal.toFixed(1)} m`, mx, my + 3)
      ctx.restore()
    }

    // Building solids intersected by the A-B cut.
    const sampleCount = 180
    buildings.filter(building => building.enabled && building.points?.length >= 3).forEach(building => {
      let activeStart = null
      const spans = []
      for (let i = 0; i <= sampleCount; i += 1) {
        const t = i / sampleCount
        const lat = cutStart[0] + (cutEnd[0] - cutStart[0]) * t
        const lon = cutStart[1] + (cutEnd[1] - cutStart[1]) * t
        const inside = pointInPolygon2D(lat, lon, building.points)
        if (inside && activeStart == null) activeStart = t
        if ((!inside || i === sampleCount) && activeStart != null) {
          const endT = inside && i === sampleCount ? t : Math.max(activeStart, (i - 1) / sampleCount)
          spans.push([activeStart, endT])
          activeStart = null
        }
      }

      spans.forEach(([t1, t2]) => {
        const centerT = (t1 + t2) / 2
        const terrainIndex = Math.min(
          terrain.length - 1,
          Math.max(0, Math.round(centerT * Math.max(terrain.length - 1, 0)))
        )
        const ground = terrain[terrainIndex]?.elevation_m ?? zMin
        const roof = Number(ground) + Number(building.height_m || 0)
        const x1 = margin.left + t1 * plotW
        const x2 = margin.left + t2 * plotW
        const yRoof = yFor(roof)
        const yGround = yFor(ground)
        ctx.fillStyle = 'rgba(49,56,63,0.90)'
        ctx.fillRect(x1, yRoof, Math.max(2, x2 - x1), Math.max(1, yGround - yRoof))
        ctx.strokeStyle = '#111827'
        ctx.lineWidth = 1
        ctx.strokeRect(x1, yRoof, Math.max(2, x2 - x1), Math.max(1, yGround - yRoof))

        ctx.fillStyle = '#111827'
        ctx.font = '700 9px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(building.name || 'Edificio', (x1 + x2) / 2, Math.max(margin.top + 12, yRoof - 6))
        ctx.font = '600 8px system-ui, sans-serif'
        ctx.fillText(`${Number(building.height_m || 0).toFixed(1)} m`, (x1 + x2) / 2, Math.max(margin.top + 23, yRoof + 11))
      })
    })

    // Acoustic barriers intersected by the section line.
    const cross2D = (ax, ay, bx, by) => ax * by - ay * bx
    const segmentIntersection = (p1, p2, q1, q2) => {
      const rx = p2[0] - p1[0]
      const ry = p2[1] - p1[1]
      const sx = q2[0] - q1[0]
      const sy = q2[1] - q1[1]
      const den = cross2D(rx, ry, sx, sy)
      if (Math.abs(den) < 1e-9) return null
      const qpx = q1[0] - p1[0]
      const qpy = q1[1] - p1[1]
      const t = cross2D(qpx, qpy, sx, sy) / den
      const u = cross2D(qpx, qpy, rx, ry) / den
      if (t < 0 || t > 1 || u < 0 || u > 1) return null
      return { t, u }
    }

    barriers.filter(barrier => barrier.enabled).forEach(barrier => {
      const ba = toLocalXY(barrier.lat_a, barrier.lon_a)
      const bb = toLocalXY(barrier.lat_b, barrier.lon_b)
      const hit = segmentIntersection([0, 0], [abx, aby], ba, bb)
      if (!hit) return

      const t = hit.t
      const terrainIndex = Math.min(
        terrain.length - 1,
        Math.max(0, Math.round(t * Math.max(terrain.length - 1, 0)))
      )
      const ground = terrain[terrainIndex]?.elevation_m ?? zMin
      const top = Number(ground) + Number(barrier.height_m || 0)
      const x = margin.left + t * plotW
      const yGround = yFor(ground)
      const yTop = yFor(top)

      ctx.save()
      ctx.strokeStyle = '#6f42c1'
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(x, yGround)
      ctx.lineTo(x, yTop)
      ctx.stroke()

      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, yGround)
      ctx.lineTo(x, yTop)
      ctx.stroke()

      ctx.fillStyle = '#5b36a8'
      ctx.font = '700 9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(barrier.name || 'Barrera', x, Math.max(margin.top + 12, yTop - 8))
      ctx.font = '600 8px system-ui, sans-serif'
      ctx.fillText(`${Number(barrier.height_m || 0).toFixed(1)} m`, x, Math.max(margin.top + 23, yTop + 10))
      ctx.restore()
    })

    // Grid and axes.
    ctx.font = '11px system-ui, sans-serif'
    ctx.fillStyle = '#52606d'
    ctx.strokeStyle = 'rgba(82,96,109,0.18)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 5; i += 1) {
      const x = margin.left + i * plotW / 5
      const d = distanceM * i / 5
      ctx.beginPath()
      ctx.moveTo(x, margin.top)
      ctx.lineTo(x, margin.top + plotH)
      ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText(`${d.toFixed(0)} m`, x, margin.top + plotH + 20)
    }
    for (let i = 0; i <= 5; i += 1) {
      const z = zMin + (zMax - zMin) * i / 5
      const y = yFor(z)
      ctx.beginPath()
      ctx.moveTo(margin.left, y)
      ctx.lineTo(margin.left + plotW, y)
      ctx.stroke()
      ctx.textAlign = 'right'
      ctx.fillText(`${z.toFixed(1)} m`, margin.left - 8, y + 4)
    }

    ctx.fillStyle = '#26313b'
    ctx.textAlign = 'center'
    ctx.font = '600 11px system-ui, sans-serif'
    ctx.fillText('Distancia a lo largo del corte A–B', margin.left + plotW / 2, heightPx - 8)
    ctx.save()
    ctx.translate(14, margin.top + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('Cota / altura [m]', 0, 0)
    ctx.restore()

    ctx.fillStyle = '#0f172a'
    ctx.font = '700 11px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(cutModeType === 'pair' ? 'F' : 'A', margin.left + 4, margin.top + 15)
    ctx.textAlign = 'right'
    ctx.fillText(cutModeType === 'pair' ? 'R' : 'B', margin.left + plotW - 4, margin.top + 15)
  }, [cutResult, cutStart, cutEnd, buildings, barriers, sources, receivers, cutSourceId, cutReceiverId, distanceSourceId, distanceReceiverId, cutModeType, vmin, vmax])

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
    } else if (selected.type === 'building') {
      setBuildings(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'road') {
      setRoads(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'accessory') {
      setAccessories(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    } else if (selected.type === 'contour') {
      setContours(prev => prev.map(x => x.id === selected.id ? { ...x, ...patch } : x))
    }
  }

  const patchEnclosureFace = (faceName, patch) => {
    if (!selectedObject || selected?.type !== 'source') return
    const baseFaces = selectedObject.enclosure_faces || defaultEnclosureFaces()
    patchSelected({
      enclosure_faces: {
        ...defaultEnclosureFaces(),
        ...baseFaces,
        [faceName]: {
          ...(defaultEnclosureFaces()[faceName] || {}),
          ...(baseFaces[faceName] || {}),
          ...patch
        }
      }
    })
  }
  const setSourceTreatmentType = type => {
    if (!selectedObject || selected?.type !== 'source') return
    const baseFaces = { ...defaultEnclosureFaces(), ...(selectedObject.enclosure_faces || {}) }
    const hasOpening = Object.values(baseFaces).some(face => ['open','partial'].includes(face?.state))
    if (type === 'semi' && !hasOpening) {
      baseFaces.front = { ...baseFaces.front, state:'open', opening_pct:100 }
    }
    patchSelected({ noise_control_type:type, enclosure_faces:baseFaces })
    if (['enclosure','semi','enclosure_silencer'].includes(type)) setTreatmentTab('geometry')
    else setTreatmentTab('surfaces')
  }


  const removeSelected = () => {
    if (!selected) return
    if (selected.type === 'barrier') {
      setBarrierProfileOpen(false)
      setBarrierProfile(null)
    }
    if (selected.type === 'source') {
      setControlEditorOpen(false)
      setSources(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'receiver') {
      setReceivers(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'barrier') {
      setBarriers(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'building') {
      setBuildings(prev => prev.filter(x => x.id !== selected.id))
      setReceivers(prev => prev.filter(x => x.building_id !== selected.id))
    } else if (selected.type === 'road') {
      setRoads(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'accessory') {
      setAccessories(prev => prev.filter(x => x.id !== selected.id))
    } else if (selected.type === 'contour') {
      setContours(prev => prev.filter(x => x.id !== selected.id))
    }
    setSelected(null)
  }

  const removeCalculationArea = () => {
    if (!polygon.length) return
    const confirmed = window.confirm('¿Eliminar completamente el área de cálculo?')
    if (!confirmed) return

    setPolygon([])
    setDraftPolygon([])
    setResult(null)
    setMode('navigate')
    setSelected(null)
  }

  useEffect(() => {
    const handleKeyDown = event => {
      const activeTag = document.activeElement?.tagName
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)

      if (event.key === 'Escape') {
        if (barrierStart || lineStart || draftPolygon.length || buildingDraft.length || contourDraft.length || roadDraft.length || (mode === 'cut' && cutStart)) {
          cancelDrawing()
        } else if (selected) {
          setSelected(null)
        }
        return
      }

      if (event.key === 'Delete' && mode === 'edit-area' && polygon.length && !editing) {
        event.preventDefault()
        removeCalculationArea()
        return
      }

      if (event.key === 'Delete' && selected && !editing) {
        event.preventDefault()
        removeSelected()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, barrierStart, lineStart, draftPolygon, buildingDraft, contourDraft, roadDraft, mode, polygon, cutStart])

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
          longitude: 0,
          latitude: 12,
          zoom: 1.35,
          bearing: 0,
          pitch: 0
        }}
        mapStyle={OSM_STYLE}
        onClick={onMapClick}
        onMouseMove={onMapMouseMove}
        onMove={event => setMapZoom(Number(event.viewState?.zoom ?? event.target?.getZoom?.() ?? mapZoom))}
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


        {layers.raster && noiseIsolines.features.length > 0 && (
          <Source id="noise-isolines" type="geojson" data={noiseIsolines}>
            <Layer
              id="noise-isolines-line"
              type="line"
              paint={{
                'line-color': ['get', 'line_color'],
                'line-opacity': 1,
                'line-width': [
                  'case',
                  ['==', ['get', 'major'], 1],
                  1.7,
                  1.25
                ]
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

        {mode === 'area' && draftPolygon.map(([lat, lon], index) => (
          <Marker
            key={`draft-area-vertex-${index}`}
            longitude={lon}
            latitude={lat}
            anchor="center"
            draggable
            onDragEnd={e => {
              const { lat: newLat, lng: newLon } = e.lngLat
              setDraftPolygon(prev =>
                prev.map((point, i) => i === index ? [newLat, newLon] : point)
              )
            }}
            onClick={e => e.originalEvent.stopPropagation()}
          >
            <div
              className={`area-draft-vertex ${index === 0 ? 'first' : ''}`}
              title={index === 0 ? 'Inicio del área de cálculo · arrastra para mover' : `Vértice ${index + 1} · arrastra para mover`}
            >
              <span>{index + 1}</span>
              {index === 0 && <b>INICIO</b>}
            </div>
          </Marker>
        ))}

        {mode === 'barrier' && barrierStart && barrierHover && (
          <Source id="barrier-preview" type="geojson" data={barrierPreviewData}>
            <Layer
              id="barrier-preview-line"
              type="line"
              paint={{
                'line-color': '#6f42c1',
                'line-width': 4,
                'line-dasharray': [2, 1.5],
                'line-opacity': 0.95
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
              id="barriers-casing"
              type="line"
              paint={{
                'line-color': '#35205f',
                'line-width': 7,
                'line-opacity': 0.95
              }}
            />
            <Layer
              id="barriers-line"
              type="line"
              paint={{
                'line-color': '#8a4de0',
                'line-width': 4.5,
                'line-opacity': 1
              }}
            />
          </Source>
        )}

        {layers.buildings && (
          <Source id="buildings" type="geojson" data={buildingData}>
            <Layer
              id="buildings-fill"
              type="fill"
              paint={{
                'fill-color': '#7c8793',
                'fill-opacity': 0.18
              }}
            />
            <Layer
              id="buildings-line"
              type="line"
              paint={{
                'line-color': '#26313b',
                'line-width': 3.2,
                'line-opacity': 0.98
              }}
            />
          </Source>
        )}

        {layers.buildings && selected?.type === 'building' && (
          <Source id="selected-building" type="geojson" data={selectedBuildingData}>
            <Layer
              id="selected-building-fill"
              type="fill"
              paint={{
                'fill-color': '#111827',
                'fill-opacity': 0.08
              }}
            />
            <Layer
              id="selected-building-line"
              type="line"
              paint={{
                'line-color': '#111827',
                'line-width': 4.5,
                'line-opacity': 1
              }}
            />
          </Source>
        )}

        {mode === 'building' && buildingDraft.length >= 2 && (
          <Source id="building-draft" type="geojson" data={buildingDraftData}>
            <Layer
              id="building-draft-line"
              type="line"
              paint={{
                'line-color': '#26313b',
                'line-width': 4,
                'line-dasharray': [2, 1.5],
                'line-opacity': 1
              }}
            />
          </Source>
        )}

        {mode === 'building' && buildingDraft.length >= 3 && (
          <Source id="building-draft-polygon" type="geojson" data={buildingDraftPolygonData}>
            <Layer
              id="building-draft-polygon-fill"
              type="fill"
              paint={{
                'fill-color': '#475569',
                'fill-opacity': 0.10
              }}
            />
            <Layer
              id="building-draft-polygon-line"
              type="line"
              paint={{
                'line-color': '#1f2937',
                'line-width': 3.2,
                'line-dasharray': [1.5, 1],
                'line-opacity': 1
              }}
            />
          </Source>
        )}

        {mode === 'building' && buildingDraft.map(([lat, lon], index) => (
          <Marker
            key={`building-draft-${index}`}
            longitude={lon}
            latitude={lat}
            anchor="center"
            onClick={e => e.originalEvent.stopPropagation()}
          >
            <div className={`building-draft-vertex ${index === 0 ? 'first' : ''}`}>
              <span>{index + 1}</span>
              {index === 0 && <b>INICIO</b>}
            </div>
          </Marker>
        ))}

        {layers.roads && (
          <Source id="roads" type="geojson" data={roadData}>
            <Layer
              id="roads-casing"
              type="line"
              paint={{ 'line-color': '#1f2937', 'line-width': 8, 'line-opacity': 0.9 }}
            />
            <Layer
              id="roads-line"
              type="line"
              paint={{ 'line-color': '#f8fafc', 'line-width': 4, 'line-opacity': 0.95 }}
            />
          </Source>
        )}

        {mode === 'road' && roadDraft.length >= 2 && (
          <Source id="road-draft" type="geojson" data={roadDraftData}>
            <Layer
              id="road-draft-line"
              type="line"
              paint={{ 'line-color': '#111827', 'line-width': 5, 'line-dasharray': [2, 1] }}
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

        {mode === 'line' && lineStart && lineHover && (
          <Source id="line-preview" type="geojson" data={linePreviewData}>
            <Layer
              id="line-preview-layer"
              type="line"
              paint={{
                'line-color': '#111827',
                'line-width': 2.8,
                'line-dasharray': [3, 2],
                'line-opacity': 0.95
              }}
            />
          </Source>
        )}

        {mode === 'line' && lineStart && (
          <Marker
            longitude={lineStart[1]}
            latitude={lineStart[0]}
            anchor="center"
            onClick={e => e.originalEvent.stopPropagation()}
          >
            <div className="aux-line-draft-handle start" title="Primer extremo" />
          </Marker>
        )}

        {mode === 'line' && lineStart && lineHover && (
          <Marker
            longitude={lineHover[1]}
            latitude={lineHover[0]}
            anchor="center"
          >
            <div className="aux-line-draft-handle end" title="Segundo extremo" />
          </Marker>
        )}

        {mode === 'line' && lineStart && lineHover && (
          <Marker
            longitude={lineHover[1]}
            latitude={lineHover[0]}
            anchor="bottom-left"
          >
            <div className="aux-line-live-measure">
              {haversineMeters(lineStart[0], lineStart[1], lineHover[0], lineHover[1]).toFixed(1)} m
            </div>
          </Marker>
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

        {layers.accessories && accessories.map(line => {
          const length = haversineMeters(line.lat_a, line.lon_a, line.lat_b, line.lon_b)
          const midLat = (Number(line.lat_a) + Number(line.lat_b)) / 2
          const midLon = (Number(line.lon_a) + Number(line.lon_b)) / 2
          const isSelected = selected?.type === 'accessory' && selected.id === line.id
          return (
            <Fragment key={line.id}>
              <Marker
                longitude={midLon}
                latitude={midLat}
                anchor="center"
                onClick={e => {
                  e.originalEvent.stopPropagation()
                  setSelected({ type: 'accessory', id: line.id })
                }}
              >
                <div className={`aux-line-distance-label ${isSelected ? 'selected' : ''}`}>
                  {length.toFixed(1)} m
                </div>
              </Marker>

              <Marker
                longitude={line.lon_a}
                latitude={line.lat_a}
                anchor="center"
                draggable
                onDragStart={() => setSelected({ type: 'accessory', id: line.id })}
                onDragEnd={e => {
                  const { lat, lng } = e.lngLat
                  setAccessories(prev => prev.map(item =>
                    item.id === line.id ? { ...item, lat_a: lat, lon_a: lng } : item
                  ))
                }}
                onClick={e => {
                  e.originalEvent.stopPropagation()
                  setSelected({ type: 'accessory', id: line.id })
                }}
              >
                <div className={`aux-line-handle ${isSelected ? 'selected' : ''}`} title="Extremo A · arrastra para ajustar" />
              </Marker>

              <Marker
                longitude={line.lon_b}
                latitude={line.lat_b}
                anchor="center"
                draggable
                onDragStart={() => setSelected({ type: 'accessory', id: line.id })}
                onDragEnd={e => {
                  const { lat, lng } = e.lngLat
                  setAccessories(prev => prev.map(item =>
                    item.id === line.id ? { ...item, lat_b: lat, lon_b: lng } : item
                  ))
                }}
                onClick={e => {
                  e.originalEvent.stopPropagation()
                  setSelected({ type: 'accessory', id: line.id })
                }}
              >
                <div className={`aux-line-handle ${isSelected ? 'selected' : ''}`} title="Extremo B · arrastra para ajustar" />
              </Marker>
            </Fragment>
          )
        })}

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


        {distanceMode !== 'off' && distancePairs.length > 0 && (
          <Source id="distance-fr-lines" type="geojson" data={distanceData}>
            <Layer
              id="distance-fr-line"
              type="line"
              paint={{
                'line-color': '#1f2937',
                'line-width': distanceMode === 'selected' ? 2.4 : 1.2,
                'line-opacity': distanceMode === 'selected' ? 0.85 : 0.45,
                'line-dasharray': [2, 1.5]
              }}
            />
          </Source>
        )}

        {distanceMode !== 'off' && distancePairs.slice(0, distanceMode === 'all' ? 40 : 1).map(pair => (
          <Marker
            key={`distance-label-${pair.id}`}
            longitude={(Number(pair.source.lon) + Number(pair.receiver.lon)) / 2}
            latitude={(Number(pair.source.lat) + Number(pair.receiver.lat)) / 2}
            anchor="center"
          >
            <div className={`distance-fr-label ${distanceMode === 'all' ? 'compact' : ''}`}>
              <strong>{pair.horizontal.toFixed(1)} m</strong>
              {distanceMode === 'selected' && (
                <span>{pair.source.name} ↔ {pair.receiver.name}</span>
              )}
            </div>
          </Marker>
        ))}

        {distanceMode !== 'off' && distancePairs.slice(0, distanceMode === 'all' ? 40 : 1).flatMap(pair =>
          (pair.barrierCrossings || []).slice(0, 3).map((crossing, index) => (
            <Marker
              key={`barrier-distance-${pair.id}-${crossing.barrier.id || index}`}
              longitude={(Number(crossing.lon) + Number(pair.receiver.lon)) / 2}
              latitude={(Number(crossing.lat) + Number(pair.receiver.lat)) / 2}
              anchor="center"
            >
              <div className={`distance-fr-label barrier-distance-label ${distanceMode === 'all' ? 'compact' : ''}`}>
                <strong>B–R {crossing.barrierToReceiver.toFixed(1)} m</strong>
                {distanceMode === 'selected' && (
                  <span>{crossing.barrier.name || 'Barrera'} → {pair.receiver.name}</span>
                )}
              </div>
            </Marker>
          ))
        )}

        {cutStart && (
          <Marker longitude={cutStart[1]} latitude={cutStart[0]} anchor="center">
            <div className={`cut-endpoint ${cutModeType === 'pair' ? 'source' : ''}`}>{cutModeType === 'pair' ? 'F' : 'A'}</div>
          </Marker>
        )}

        {cutEnd && (
          <Marker longitude={cutEnd[1]} latitude={cutEnd[0]} anchor="center">
            <div className={`cut-endpoint ${cutModeType === 'pair' ? 'receiver' : ''}`}>{cutModeType === 'pair' ? 'R' : 'B'}</div>
          </Marker>
        )}

        {cutStart && cutEnd && (
          <Source id="acoustic-cut-line" type="geojson" data={cutLineData}>
            <Layer
              id="acoustic-cut-line-layer"
              type="line"
              paint={{
                'line-color': '#111827',
                'line-width': 2.5,
                'line-dasharray': [3, 1.5],
                'line-opacity': 0.9
              }}
            />
          </Source>
        )}

        {layers.buildings && buildings.map(building => {
          if (!building.enabled || !building.points?.length) return null
          const lat = building.points.reduce((sum, p) => sum + Number(p[0]), 0) / building.points.length
          const lon = building.points.reduce((sum, p) => sum + Number(p[1]), 0) / building.points.length
          return (
            <Marker
              key={building.id}
              longitude={lon}
              latitude={lat}
              anchor="center"
              onClick={e => {
                e.originalEvent.stopPropagation()
                setBuildingFacadeIndex(0)
                setSelected({ type: 'building', id: building.id })
              }}
            >
              <div
                className={`building-label ${mapZoom < 17.5 ? 'compact' : ''} ${mapZoom < 16.5 ? 'dot-only' : ''}`}
                title={`${building.name} · ${Number(building.height_m).toFixed(1)} m`}
              >
                {mapZoom < 16.5 ? (
                  <span className="building-label-dot">E</span>
                ) : mapZoom < 17.5 ? (
                  <strong>{building.name}</strong>
                ) : (
                  <>
                    <strong>{building.name}</strong>
                    <span>{Number(building.height_m).toFixed(1)} m</span>
                  </>
                )}
              </div>
            </Marker>
          )
        })}

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
              if (distanceMode === 'selected') {
                setDistanceSourceId(source.id)
                setSelected(null)
                return
              }
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
              {(source.noise_control_type || 'none') !== 'none' && (
                <span className="source-control-badge" title={sourceControlLabel(source.noise_control_type)}>C</span>
              )}
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
              if (distanceMode === 'selected') {
                setDistanceReceiverId(receiver.id)
                setSelected(null)
                return
              }
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

        {layers.roads && roads.flatMap(road => {
          const markers = road.points.map(([lat, lon], index) => (
            <Marker
              key={`${road.id}-road-vertex-${index}`}
              longitude={lon}
              latitude={lat}
              draggable
              onDragEnd={e => {
                const { lat: newLat, lng: newLon } = e.lngLat
                setRoads(prev => prev.map(item =>
                  item.id === road.id
                    ? { ...item, points: item.points.map((p, i) => i === index ? [newLat, newLon] : p) }
                    : item
                ))
              }}
              onClick={e => {
                e.originalEvent.stopPropagation()
                setSelected({ type: 'road', id: road.id })
              }}
            >
              <div className="road-handle" title={`${road.name} · vértice ${index + 1}`} />
            </Marker>
          ))
          const mid = road.points[Math.floor(road.points.length / 2)]
          if (mid) {
            markers.push(
              <Marker
                key={`${road.id}-road-label`}
                longitude={mid[1]}
                latitude={mid[0]}
                anchor="bottom"
                onClick={e => {
                  e.originalEvent.stopPropagation()
                  setSelected({ type: 'road', id: road.id })
                }}
              >
                <div className="road-label">🛣 {road.name}</div>
              </Marker>
            )
          }
          return markers
        })}

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

        {selected?.type === 'building' && selectedObject?.points?.map(([lat, lon], index) => (
          <Marker
            key={`building-vertex-${selectedObject.id}-${index}`}
            longitude={lon}
            latitude={lat}
            draggable
            onDragEnd={e => {
              const { lat: newLat, lng: newLon } = e.lngLat
              setBuildings(prev => prev.map(item =>
                item.id === selectedObject.id
                  ? {
                      ...item,
                      points: item.points.map((point, i) => i === index ? [newLat, newLon] : point)
                    }
                  : item
              ))
            }}
            onClick={e => e.originalEvent.stopPropagation()}
          >
            <div className="building-edit-vertex" title={`Vértice ${index + 1}`}>{index + 1}</div>
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
          <IconButton active={mode === 'building'} title="Dibujar edificio como obstáculo acústico" icon="▦" label="Edificio" onClick={() => {
            setBuildingDraft([])
            setMode('building')
          }} />
          <IconButton active={mode === 'road'} title="Dibujar eje de una vía con tráfico conocido" icon="🛣" label="Tráfico vial" onClick={() => {
            setRoadDraft([])
            setMode('road')
          }} />
          <IconButton active={mode === 'line'} title="Línea auxiliar con medición en vivo; no participa en el cálculo acústico" icon="⌇" label="Auxiliar" onClick={() => {
            setLineStart(null)
            setLineHover(null)
            setMode('line')
          }} />
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
          {mode === 'edit-area' && polygon.length >= 3 && (
            <button
              type="button"
              className="bottom-context-action danger"
              onClick={removeCalculationArea}
              title="Eliminar completamente el área de cálculo"
            >
              <span className="context-icon">⌫</span>
              <span>Eliminar área</span>
            </button>
          )}
          {mode === 'road' && roadDraft.length >= 2 && (
            <button
              type="button"
              className="bottom-context-action finish"
              onClick={finishRoad}
              title="Finalizar eje vial"
            >
              <span className="context-icon">✓</span>
              <span>Finalizar vía</span>
            </button>
          )}

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

          {mode === 'building' && buildingDraft.length >= 3 && (
            <button
              type="button"
              className="bottom-context-action finish"
              onClick={finishBuilding}
              title="Cerrar edificio"
            >
              <span className="context-icon">✓</span>
              <span>Cerrar edificio</span>
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

          {(mode === 'road' || mode === 'contour' || mode === 'building' || mode === 'area' || mode === 'cut' || barrierStart || lineStart) && (
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

      {mode === 'building' && (
        <div className="area-drawing-guide building-drawing-guide">
          <strong>Edificio</strong>
          <span>
            {buildingDraft.length === 0
              ? 'Haz clic para marcar el primer vértice del edificio.'
              : buildingDraft.length < 3
                ? `Vértice ${buildingDraft.length} definido · agrega al menos ${3 - buildingDraft.length} más.`
                : `${buildingDraft.length} vértices definidos · la zona sombreada es la forma final. Pulsa “Cerrar edificio”.`}
          </span>
        </div>
      )}

      {mode === 'area' && (
        <div className="area-drawing-guide">
          <strong>Área de cálculo</strong>
          <span>
            {draftPolygon.length === 0
              ? 'Haz clic en el mapa para definir el primer vértice.'
              : draftPolygon.length < 3
                ? `Vértice ${draftPolygon.length} definido · agrega al menos ${3 - draftPolygon.length} más.`
                : `${draftPolygon.length} vértices definidos · pulsa “Cerrar área” cuando termines.`}
          </span>
        </div>
      )}

      {mode === 'cut' && (
        <div className="area-drawing-guide cut-drawing-guide">
          <strong>Corte acústico</strong>
          <span>{cutStart ? 'Ahora marca el punto B del corte.' : 'Marca el punto A del corte sobre el mapa.'}</span>
        </div>
      )}

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
          className={distanceMode !== 'off' || distanceOpen ? 'active' : ''}
          title="Mostrar distancias entre fuentes y receptores"
          onClick={() => {
            setDistanceOpen(v => !v)
            setSearchOpen(false)
            setSettingsOpen(false)
            setLayersOpen(false)
            setResultsOpen(false)
            setProjectOpen(false)
          }}
        >
          <span>↔</span><small>Dist. F–R</small>
        </button>
        <button
          type="button"
          className={mode === 'cut' || cutOpen ? 'active' : ''}
          title="Crear una visualización de corte acústico vertical"
          onClick={() => {
            setCutStart(null)
            setCutEnd(null)
            setCutResult(null)
            setCutError('')
            setCutModeType('pair')
            setCutSourceId(distanceSourceId || sources.find(item => item.enabled)?.id || '')
            setCutReceiverId(distanceReceiverId || receivers.find(item => item.visible !== false)?.id || '')
            setCutOpen(true)
            setMode('navigate')
            setDistanceOpen(false)
            setSearchOpen(false)
            setSettingsOpen(false)
            setLayersOpen(false)
            setResultsOpen(false)
            setProjectOpen(false)
          }}
        >
          <span>▥</span><small>Corte</small>
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

      {distanceOpen && (
        <div className="layers-popover distance-popover">
          <div className="project-popover-header">
            <div>
              <span className="eyebrow">DISTANCIAS F–R</span>
              <strong>Visualización</strong>
            </div>
            <button type="button" onClick={() => setDistanceOpen(false)}>×</button>
          </div>
          <div className="segmented distance-mode-segmented">
            {[
              ['off', 'Off'],
              ['selected', 'Seleccionados'],
              ['all', 'Todos']
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={distanceMode === value ? 'active' : ''}
                onClick={() => {
                  setDistanceMode(value)
                  if (value === 'selected') {
                    setDistanceSourceId('')
                    setDistanceReceiverId('')
                    setMode('navigate')
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {distanceMode === 'selected' && (
            <div className="distance-selection-help">
              <span className={distanceSourceId ? 'done' : ''}>
                1. {distanceSourceId ? sources.find(item => item.id === distanceSourceId)?.name : 'Selecciona una fuente'}
              </span>
              <span className={distanceReceiverId ? 'done' : ''}>
                2. {distanceReceiverId ? receivers.find(item => item.id === distanceReceiverId)?.name : 'Selecciona un receptor'}
              </span>
            </div>
          )}

          {distanceMode === 'selected' && distancePairs[0] && (
            <>
              <div className="distance-result-card">
                <div><span>Distancia horizontal</span><strong>{distancePairs[0].horizontal.toFixed(2)} m</strong></div>
                <div><span>Distancia geométrica 3D*</span><strong>{distancePairs[0].distance3d.toFixed(2)} m</strong></div>
                {(distancePairs[0].barrierCrossings || []).map((crossing, index) => (
                  <div className="distance-barrier-row" key={crossing.barrier.id || index}>
                    <span>{crossing.barrier.name || `Barrera ${index + 1}`}</span>
                    <strong>F–B {crossing.sourceToBarrier.toFixed(2)} m · B–R {crossing.barrierToReceiver.toFixed(2)} m</strong>
                  </div>
                ))}
                <small>*Considera las alturas configuradas de F y R; F–B y B–R son distancias horizontales medidas hasta la intersección con la barrera.</small>
              </div>
              <button
                type="button"
                className="distance-cut-button"
                onClick={() => {
                  setDistanceOpen(false)
                  runSelectedPairCut()
                }}
              >
                ▥ Ver corte F–R
              </button>
            </>
          )}

          {distanceMode === 'all' && (
            <div className="engine-note">
              Se muestran todas las conexiones fuente–receptor visibles. Las etiquetas se limitan a 40 pares para evitar saturar el mapa.
            </div>
          )}
        </div>
      )}

      {dirty && result && (
        <div className="dirty-chip floating-dirty" title="Cambió la geometría o un parámetro acústico y el mapa necesita actualizarse">
          ● Recalcular mapa
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
            ['buildings', 'Edificios'],
            ['roads', 'Tráfico vial'],
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
            Conserva fuentes, tráfico vial, receptores, barreras, edificios, topografía,
            espectros, configuración y último cálculo.
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

      {cutOpen && (
        <div className="floating-dialog acoustic-cut-dialog">
          <div className="dialog-header">
            <div>
              <span className="eyebrow">VISUALIZACIÓN</span>
              <h3>
                {cutModeType === 'pair' && cutSourceId && cutReceiverId
                  ? `Sección transversal F–R · ${sources.find(item => item.id === cutSourceId)?.name || 'Fuente'} → ${receivers.find(item => item.id === cutReceiverId)?.name || 'Receptor'}`
                  : 'Corte acústico A–B'}
              </h3>
            </div>
            <button onClick={() => {
              setCutOpen(false)
              setCutStart(null)
              setCutEnd(null)
              setCutResult(null)
              setCutError('')
            }}>×</button>
          </div>

          <div className="cut-pair-selector">
            <label>
              Fuente
              <select
                value={cutSourceId}
                onChange={e => {
                  setCutSourceId(e.target.value)
                  setCutResult(null)
                  setCutError('')
                }}
              >
                <option value="">Seleccionar fuente</option>
                {sources.filter(item => item.enabled).map(source => (
                  <option key={source.id} value={source.id}>{source.name}</option>
                ))}
              </select>
            </label>
            <span className="cut-pair-arrow">→</span>
            <label>
              Receptor
              <select
                value={cutReceiverId}
                onChange={e => {
                  setCutReceiverId(e.target.value)
                  setCutResult(null)
                  setCutError('')
                }}
              >
                <option value="">Seleccionar receptor</option>
                {receivers.filter(item => item.visible !== false).map(receiver => (
                  <option key={receiver.id} value={receiver.id}>{receiver.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="cut-pair-button primary"
              disabled={!cutSourceId || !cutReceiverId || cutLoading}
              onClick={runSelectedPairCut}
            >
              {cutLoading ? 'Calculando…' : 'Generar sección F–R'}
            </button>
          </div>

          <div className="cut-toolbar cut-toolbar-pair">
            <label>
              Altura máxima del corte
              <div>
                <input
                  type="number"
                  min="5"
                  max="300"
                  step="1"
                  value={cutMaxHeight}
                  onChange={e => setCutMaxHeight(Math.max(5, Math.min(300, Number(e.target.value) || 30)))}
                />
                <span>m</span>
              </div>
            </label>
            <button
              type="button"
              className="profile-open-button"
              disabled={!cutStart || !cutEnd || cutLoading}
              onClick={() => runAcousticCut()}
            >
              {cutLoading ? 'Calculando…' : 'Actualizar corte'}
            </button>
            <button
              type="button"
              className="cut-new-button"
              onClick={() => {
                setCutOpen(false)
                setCutStart(null)
                setCutEnd(null)
                setCutResult(null)
                setCutError('')
                setCutModeType('free')
                setMode('cut')
              }}
            >
              Corte libre
            </button>
          </div>

          {cutLoading && (
            <div className="cut-loading">Calculando distribución vertical de niveles…</div>
          )}

          {cutError && (
            <div className="topo-import-result error">{cutError}</div>
          )}

          {cutResult && !cutLoading && (
            <>
              <div className="cut-summary">
                <div><span>Longitud A–B</span><strong>{Number(cutResult.distance_m).toFixed(1)} m</strong></div>
                <div><span>Rango vertical</span><strong>{Number(cutResult.z_min_m).toFixed(1)}–{Number(cutResult.z_max_m).toFixed(1)} m</strong></div>
                <div><span>Niveles</span><strong>{cutResult.min_level != null ? Number(cutResult.min_level).toFixed(1) : '—'}–{cutResult.max_level != null ? Number(cutResult.max_level).toFixed(1) : '—'} {globalSettings.a_weighting ? 'dB(A)' : 'dB'}</strong></div>
              </div>

              <div className="cut-canvas-wrap">
                <canvas ref={cutCanvasRef} aria-label="Mapa de ruido en corte vertical A–B" />
              </div>

              <div className="cut-legend-row">
                <span>{vmin.toFixed(0)}</span>
                <div className="cut-gradient" />
                <span>{vmax.toFixed(0)} {globalSettings.a_weighting ? 'dB(A)' : 'dB'}</span>
              </div>

              <div className="engine-note">
                Vista de sección transversal: no modifica el proyecto. Con “Corte F–R” la sección se genera automáticamente entre la fuente y el receptor seleccionados, mostrando ambos a su altura real, la propagación por colores, terreno, edificios y barreras interceptadas.
              </div>
            </>
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
                          <td>{
                            contribution.source_kind === 'road'
                              ? 'Tráfico vial'
                              : contribution.mode === 'octaves'
                                ? 'Octavas'
                                : contribution.mode === 'single'
                                  ? 'Single'
                                  : 'Broadband'
                          }</td>
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
              <span className="eyebrow">UBICACIÓN DEL PROYECTO</span>
              <h3>¿Dónde quieres trabajar?</h3>
            </div>
            <button onClick={() => setSearchOpen(false)}>×</button>
          </div>

          <div className="location-intro">
            Busca cualquier dirección o lugar del mundo, pega coordenadas GPS o usa tu ubicación actual.
          </div>

          <div className="search-row">
            <input
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder="Ej. Gran Vía 32, Madrid o -33.4489, -70.6693"
              autoFocus
            />
            <button onClick={runSearch}>{searching ? '…' : 'Buscar'}</button>
          </div>

          <div className="location-actions">
            <button type="button" onClick={useCurrentLocation}>
              <span>⌖</span>
              <strong>Usar mi ubicación</strong>
            </button>
            <button type="button" onClick={fitProject}>
              <span>⛶</span>
              <strong>Ver proyecto completo</strong>
            </button>
          </div>

          <div className="location-message">{locationMessage}</div>

          <div className="search-results">
            {searchResults.slice(0, 5).map((item, index) => (
              <button
                key={index}
                onClick={() => goToLocation(item.lat, item.lon, 18, true)}
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
            <div className="future-note">Activo en el motor: G=0 representa suelo duro y G=1 suelo poroso. El cálculo se realiza por banda con la formulación de efecto de suelo del motor ISO.</div>
          </div>

          <div className="settings-section">
            <h4>Meteorología</h4>
            <div className="two-cols">
              <label>Temperatura [°C]
                <input type="number" value={globalSettings.temperature_c}
                  onChange={e => setGlobalSettings(s => ({ ...s, temperature_c: Number(e.target.value) }))} />
              </label>
              <label>Humedad [%]
                <input type="number" min="0" max="100" value={globalSettings.humidity_pct}
                  onChange={e => setGlobalSettings(s => ({ ...s, humidity_pct: Number(e.target.value) }))} />
              </label>
            </div>
            <label>C₀ largo plazo [dB]
              <input type="number" min="0" max="20" step="0.5" value={globalSettings.c0_db}
                onChange={e => setGlobalSettings(s => ({ ...s, c0_db: Number(e.target.value) }))} />
            </label>
            <div className="future-note">
              C₀ = 0 mantiene la condición favorable. Valores mayores aplican la corrección meteorológica de largo plazo Cmet según distancia y alturas de fuente/receptor.
            </div>
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
              </select>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={globalSettings.facade_1m}
                onChange={e => setGlobalSettings(s => ({ ...s, facade_1m: e.target.checked }))} />
              Fachada a 1 m
            </label>
            <div className="future-note">Activo en el motor: reflexión especular de primer orden mediante fuente imagen, descartando trayectorias reflejadas bloqueadas por otros obstáculos. La reflectividad se define en cada barrera.</div>
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
              <span><b>{buildings.length}</b> edificios</span>
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
        <div
          ref={objectCardRef}
          className={`object-card advanced-object-card ${selected?.type === 'source' ? 'source-card-movable' : ''}`}
          style={selected?.type === 'source' && sourceCardPos ? { left:sourceCardPos.x, top:sourceCardPos.y, right:'auto', bottom:'auto' } : undefined}
        >
          {selected?.type === 'source' && (
            <div
              className="object-drag-handle"
              draggable
              title="Arrastrar ventana de fuente"
              onDragEnd={e => {
                if (!e.clientX || !e.clientY || !objectCardRef.current) return
                const rect = objectCardRef.current.getBoundingClientRect()
                setSourceCardPos({
                  x:Math.max(8, Math.min(window.innerWidth - rect.width - 8, e.clientX - rect.width/2)),
                  y:Math.max(8, Math.min(window.innerHeight - rect.height - 8, e.clientY - 18))
                })
              }}
            >⋮⋮ Mover ficha</div>
          )}
          <button className="close-card" onClick={() => setSelected(null)}>×</button>
          <div className="object-type">
            {selected.type === 'source'
              ? 'FUENTE PUNTUAL'
              : selected.type === 'receiver'
                ? 'RECEPTOR'
                : selected.type === 'barrier'
                  ? 'BARRERA'
                  : selected.type === 'building'
                    ? 'EDIFICIO · OBSTÁCULO ACÚSTICO'
                    : selected.type === 'road'
                      ? 'TRÁFICO VIAL · CNOSSOS-EU'
                      : 'CURVA DE NIVEL'}
          </div>
          <h3>{selectedObject.name}</h3>

          {(selected.type === 'source' || selected.type === 'receiver' || selected.type === 'building') && (
            <>
              <label>Nombre</label>
              <input
                type="text"
                value={selectedObject.name}
                onChange={e => patchSelected({ name: e.target.value })}
                placeholder={selected.type === 'source' ? 'Nombre de la fuente' : selected.type === 'building' ? 'Nombre del edificio' : 'Nombre del receptor'}
              />
            </>
          )}

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

              {selectedObject.course_power_pending && (
                <div className="engine-note">
                  Etapa 8 · La posición y altura ya están definidas. Ingresa aquí el LwA que calculaste en el ejercicio antes de modelar.
                </div>
              )}

              {selectedObject.spectrum_mode === 'broadband' && (
                <div className="inline-field">
                  <span>LwA</span>
                  <input type="number" value={selectedObject.lw_db ?? ''}
                    placeholder="Ingresa LwA"
                    onChange={e => patchSelected({
                      lw_db: e.target.value === '' ? null : Number(e.target.value),
                      course_power_pending: e.target.value === ''
                    })} />
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

              <h4 className="subheading source-control-heading">Control de ruido</h4>
              <div className="control-launch-card">
                <div>
                  <span>Tratamiento aplicado</span>
                  <strong>{sourceControlLabel(selectedObject.noise_control_type)}</strong>
                </div>
                <button type="button" onClick={() => setControlEditorOpen(true)}>
                  Configurar tratamiento…
                </button>
              </div>
              {(selectedObject.noise_control_type || 'none') !== 'none' && (
                <div className="engine-note">
                  El tratamiento se configura en una ventana independiente. El mapa y el corte F–R usan la misma definición geométrica y espectral.
                </div>
              )}

              {nearestReceiverDistance && (
                <div className="distance-card">
                  <span>Receptor más cercano</span>
                  <strong>{nearestReceiverDistance.name}</strong>
                  <b>{nearestReceiverDistance.distance.toFixed(1)} m</b>
                </div>
              )}

              <div className="engine-note">
                El motor V4 propaga por frecuencia. Los encierros se resuelven mediante balance energético de superficies, absorción interior y radiación direccional; Single usa su frecuencia real y Broadband permanece como LwA sin inventar un espectro.
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

              {selectedObject.height_mode === 'facade' && (
                <div className="engine-note">
                  Receptor asociado a fachada de edificio · altura independiente respecto del terreno.
                </div>
              )}

              <h4 className="subheading">Resultado de presión sonora</h4>
              <div className="receiver-result">
                <span>
                  {receiverPreviewLoading
                    ? 'Actualizando…'
                    : receiverPreviewError
                      ? 'Vista previa no disponible'
                      : 'Nivel puntual en vivo'}
                </span>
                <strong>
                  {receiverPreview?.level_db != null
                    ? Number(receiverPreview.level_db).toFixed(2) + (globalSettings.a_weighting ? ' dB(A)' : ' dB')
                    : receiverPreviewLoading
                      ? '…'
                      : receiverPreviewError
                        ? '—'
                        : 'Sin calcular'}
                </strong>
              </div>

              {receiverPreview?.diagnostics?.length > 0 && (
                <div className="receiver-live-diagnostics">
                  <div>
                    <span>Distancia 3D F–R</span>
                    <strong>{Number(receiverPreview.diagnostics[0].distance_3d_m).toFixed(1)} m</strong>
                  </div>
                  <div>
                    <span>Adiv</span>
                    <strong>{Number(receiverPreview.diagnostics[0].a_div_db).toFixed(1)} dB</strong>
                  </div>
                  <div>
                    <span>Aatm</span>
                    <strong>{Number(receiverPreview.diagnostics[0].a_atm_db).toFixed(1)} dB</strong>
                  </div>
                  <div>
                    <span>Agr · suelo</span>
                    <strong>{Number(receiverPreview.diagnostics[0].a_gr_db).toFixed(1)} dB</strong>
                  </div>
                  <div>
                    <span>Abar</span>
                    <strong>{Number(receiverPreview.diagnostics[0].a_bar_db).toFixed(1)} dB</strong>
                  </div>
                  <div>
                    <span>Reflejado</span>
                    <strong>
                      {receiverPreview.diagnostics[0].lp_reflected_db != null
                        ? Number(receiverPreview.diagnostics[0].lp_reflected_db).toFixed(1) + ' dB'
                        : '—'}
                    </strong>
                  </div>
                  {contours.length > 0 && (
                    <div>
                      <span>Cota terreno receptor</span>
                      <strong>{Number(receiverPreview.diagnostics[0].receiver_ground_elevation_m).toFixed(1)} m</strong>
                    </div>
                  )}
                </div>
              )}

              {receiverPreviewError && (
                <div className="receiver-preview-error">
                  No se está mostrando el resultado anterior: {receiverPreviewError}
                </div>
              )}

              {receiverPreview?.bands_db && (
                <div className="receiver-spectrum">
                  {[63,125,250,500,1000,2000,4000,8000].map(freq => {
                    const value = receiverPreview.bands_db?.[String(freq)]
                    return (
                      <div key={freq}>
                        <span>{freq >= 1000 ? freq/1000 + 'k' : freq}</span>
                        <strong>{value != null ? Number(value).toFixed(1) : '—'}</strong>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="engine-note">
                Este nivel puntual incorpora distancia 3D, atmósfera, efecto de suelo, barreras y las cotas interpoladas de las curvas de nivel. El mapa de colores completo se actualiza solo al pulsar “Calcular mapa”.
              </div>
            </>
          )}

          {selected.type === 'building' && (
            <>
              <div className="status-toggle">
                <button className={!selectedObject.enabled ? 'active off' : ''} onClick={() => patchSelected({ enabled:false })}>Off</button>
                <button className={selectedObject.enabled ? 'active on' : ''} onClick={() => patchSelected({ enabled:true })}>On</button>
              </div>

              <div className="calculated-field">
                <span>Vértices</span>
                <strong>{selectedObject.points?.length || 0}</strong>
              </div>

              <label>Altura del edificio [m]</label>
              <input
                type="number"
                min="0.5"
                max="500"
                step="0.5"
                value={selectedObject.height_m}
                onChange={e => patchSelected({ height_m:Math.max(0.5, Number(e.target.value) || 0.5) })}
              />

              <h4 className="subheading">Comportamiento acústico</h4>
              <div className="engine-note">
                El contorno del edificio actúa como obstáculo: cada fachada se incorpora al cálculo como un borde vertical de la altura indicada. El interior del edificio no se pinta en la grilla de ruido.
              </div>

              <label>Reflexión de fachada</label>
              <div className="segmented">
                {[0,20,50,100].map(value => (
                  <button key={value}
                    className={(selectedObject.reflection_percent || 0) === value ? 'active' : ''}
                    onClick={() => patchSelected({ reflection_percent:value })}>
                    {value === 0 ? 'Ninguna' : value + '%'}
                  </button>
                ))}
              </div>

              <h4 className="subheading">Receptores en fachada</h4>

              <label>Fachada</label>
              <select
                value={Math.min(buildingFacadeIndex, Math.max(0, (selectedObject.points?.length || 1) - 1))}
                onChange={e => setBuildingFacadeIndex(Number(e.target.value))}
              >
                {(selectedObject.points || []).map((_, index) => (
                  <option key={index} value={index}>Fachada {index + 1}</option>
                ))}
              </select>

              <div className="building-receiver-config">
                <label>Primera altura [m]
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedObject.receiver_start_height_m ?? 1.5}
                    onChange={e => patchSelected({ receiver_start_height_m:Math.max(0.1, Number(e.target.value) || 0.1) })}
                  />
                </label>
                <label>Separación vertical [m]
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedObject.receiver_spacing_m ?? 3}
                    onChange={e => patchSelected({ receiver_spacing_m:Math.max(0.1, Number(e.target.value) || 0.1) })}
                  />
                </label>
                <label>Separación fachada [m]
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedObject.receiver_offset_m ?? 1}
                    onChange={e => patchSelected({ receiver_offset_m:Math.max(0.1, Number(e.target.value) || 0.1) })}
                  />
                </label>
              </div>

              <button
                type="button"
                className="profile-open-button"
                onClick={() => addFacadeReceivers(selectedObject)}
              >
                Crear receptores
              </button>

              <div className="engine-note">
                Tú defines la primera altura, la separación vertical y la distancia respecto de la fachada. Los receptores se nombran automáticamente RE1, RE2, RE3…
              </div>

              <h4 className="subheading">Receptores asociados</h4>
              {receivers.filter(receiver => receiver.building_id === selectedObject.id).length === 0 ? (
                <div className="building-receiver-empty">Aún no hay receptores asociados a este edificio.</div>
              ) : (
                <div className="building-receiver-list">
                  {receivers
                    .filter(receiver => receiver.building_id === selectedObject.id)
                    .map(receiver => (
                      <div className="building-receiver-row" key={receiver.id}>
                        <input
                          type="text"
                          value={receiver.name}
                          title="Nombre del receptor"
                          onChange={e => setReceivers(prev => prev.map(item =>
                            item.id === receiver.id ? { ...item, name:e.target.value } : item
                          ))}
                        />
                        <label>
                          <span>Altura</span>
                          <input
                            type="number"
                            min="0.1"
                            step="0.1"
                            value={receiver.height_m}
                            onChange={e => setReceivers(prev => prev.map(item =>
                              item.id === receiver.id
                                ? { ...item, height_m:Math.max(0.1, Number(e.target.value) || 0.1), height_mode:'facade' }
                                : item
                            ))}
                          />
                        </label>
                        <button
                          type="button"
                          className="building-receiver-visibility"
                          title={receiver.visible === false ? 'Mostrar receptor' : 'Ocultar receptor'}
                          onClick={() => setReceivers(prev => prev.map(item =>
                            item.id === receiver.id ? { ...item, visible:item.visible === false } : item
                          ))}
                        >
                          {receiver.visible === false ? '○' : '●'}
                        </button>
                        <button
                          type="button"
                          className="building-receiver-delete"
                          title="Eliminar receptor"
                          onClick={() => setReceivers(prev => prev.filter(item => item.id !== receiver.id))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}

          {selected.type === 'road' && (
            <>
              <div className="status-toggle">
                <button className={!selectedObject.enabled ? 'active off' : ''} onClick={() => patchSelected({ enabled:false })}>Off</button>
                <button className={selectedObject.enabled ? 'active on' : ''} onClick={() => patchSelected({ enabled:true })}>On</button>
              </div>

              <label>Nombre de la vía</label>
              <input type="text" value={selectedObject.name}
                onChange={e => patchSelected({ name:e.target.value })} />

              <div className="calculated-field">
                <span>Longitud modelada</span>
                <strong>{polylineLengthMeters(selectedObject.points).toFixed(1)} m</strong>
              </div>

              <h4 className="subheading">Tráfico conocido</h4>
              <div className="road-traffic-grid">
                <div className="road-traffic-head"><span>Categoría</span><span>veh/h</span><span>km/h</span></div>
                <div className="road-traffic-row">
                  <span>Livianos · Cat. 1</span>
                  <input type="number" min="0" value={selectedObject.q_light_vph}
                    onChange={e => patchSelected({ q_light_vph:Math.max(0, Number(e.target.value)) })} />
                  <input type="number" min="1" value={selectedObject.speed_light_kmh}
                    onChange={e => patchSelected({ speed_light_kmh:Math.max(1, Number(e.target.value)) })} />
                </div>
                <div className="road-traffic-row">
                  <span>Medianos · Cat. 2</span>
                  <input type="number" min="0" value={selectedObject.q_medium_vph}
                    onChange={e => patchSelected({ q_medium_vph:Math.max(0, Number(e.target.value)) })} />
                  <input type="number" min="1" value={selectedObject.speed_medium_kmh}
                    onChange={e => patchSelected({ speed_medium_kmh:Math.max(1, Number(e.target.value)) })} />
                </div>
                <div className="road-traffic-row">
                  <span>Pesados · Cat. 3</span>
                  <input type="number" min="0" value={selectedObject.q_heavy_vph}
                    onChange={e => patchSelected({ q_heavy_vph:Math.max(0, Number(e.target.value)) })} />
                  <input type="number" min="1" value={selectedObject.speed_heavy_kmh}
                    onChange={e => patchSelected({ speed_heavy_kmh:Math.max(1, Number(e.target.value)) })} />
                </div>
              </div>

              <div className="calculated-field">
                <span>Flujo total</span>
                <strong>{(
                  Number(selectedObject.q_light_vph || 0) +
                  Number(selectedObject.q_medium_vph || 0) +
                  Number(selectedObject.q_heavy_vph || 0)
                ).toFixed(0)} veh/h</strong>
              </div>

              <div className="engine-note">
                Emisión por octavas 63 Hz–8 kHz según CNOSSOS-EU, con fuente equivalente a 0,05 m sobre la calzada. La propagación utiliza el motor exterior educativo actual.
              </div>
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
              <div className="engine-note">La atenuación por barrera se calcula con la geometría F–B–R y depende de la frecuencia. La reflexión de primer orden está activa cuando la superficie tiene reflectividad mayor que 0%.</div>
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
                Esta curva participa en la interpolación del terreno utilizada para las cotas de fuentes, vías, receptores y barreras.
              </div>
            </>
          )}

          <button className="delete-button" onClick={removeSelected}>Eliminar elemento</button>
        </div>
      )}

      {controlEditorOpen && selected?.type === 'source' && selectedObject && (
        <div className="floating-dialog source-treatment-dialog treatment-redesign">
          <div className="dialog-header treatment-header">
            <div>
              <span className="eyebrow">FUENTE · CONTROL DE RUIDO</span>
              <h3>Configurar tratamiento de control de ruido</h3>
              <small>{selectedObject.name} · {selectedObject.spectrum_mode === 'single' ? `Single · ${selectedObject.single_frequency_hz} Hz` : selectedObject.spectrum_mode === 'octaves' ? 'Octavas' : 'Broadband · LwA'}</small>
            </div>
            <button onClick={() => setControlEditorOpen(false)}>×</button>
          </div>

          <div className="treatment-type-strip">
            {[
              ['none','◖','Sin tratamiento'],
              ['silencer','▰','Silenciador'],
              ['enclosure','▣','Encierro'],
              ['semi','◫','Semiencierro'],
              ['enclosure_silencer','▣◖','Encierro + silenciador'],
              ['direct','−dB','Reducción directa']
            ].map(([value,icon,label]) => (
              <button
                key={value}
                type="button"
                className={(selectedObject.noise_control_type || 'none') === value ? 'active' : ''}
                onClick={() => setSourceTreatmentType(value)}
              >
                <span className="treatment-type-icon">{icon}</span>
                <strong>{label}</strong>
              </button>
            ))}
          </div>

          {(() => {
            const faces = { ...defaultEnclosureFaces(), ...(selectedObject.enclosure_faces || {}) }
            const openFaces = ENCLOSURE_FACES.filter(([key]) => faces[key]?.state === 'open')
            const partialFaces = ENCLOSURE_FACES.filter(([key]) => faces[key]?.state === 'partial')
            const type = selectedObject.noise_control_type || 'none'
            if (!['enclosure','semi','enclosure_silencer'].includes(type)) return null
            return (
              <div className={`treatment-banner ${type === 'semi' ? 'info' : ''}`}>
                <b>{type === 'semi' ? 'Semiencierro' : type === 'enclosure' ? 'Encierro' : 'Encierro + silenciador'}</b>
                <span>
                  {type === 'semi'
                    ? (openFaces.length || partialFaces.length
                      ? ` · Cara(s) abierta(s): ${[...openFaces,...partialFaces].map(([,label]) => label).join(', ')}.`
                      : ' · No hay una cara abierta: defínela en Geometría o Superficies.')
                    : ' · Define la geometría y el comportamiento acústico de cada superficie.'}
                </span>
              </div>
            )
          })()}

          <div className="treatment-tabs">
            {[
              ['geometry','Geometría y orientación'],
              ['surfaces','Superficies (TL / Rw)'],
              ['examples','Vista 3D / Ejemplos'],
              ['results','Resultados']
            ].map(([value,label]) => (
              <button type="button" key={value} className={treatmentTab === value ? 'active' : ''} onClick={() => setTreatmentTab(value)}>{label}</button>
            ))}
          </div>

          {treatmentTab === 'geometry' && ['enclosure','semi','enclosure_silencer'].includes(selectedObject.noise_control_type || 'none') && (
            <div className="treatment-geometry-layout">
              <section className="treatment-panel geometry-controls-panel">
                <h4>Dimensiones del encierro</h4>
                <div className="geometry-input-stack">
                  <label>Largo (X)<div><input type="number" min="0.1" step="0.1" value={selectedObject.enclosure_length_m ?? 2} onChange={e => patchSelected({enclosure_length_m:Number(e.target.value)})}/><span>m</span></div></label>
                  <label>Ancho (Y)<div><input type="number" min="0.1" step="0.1" value={selectedObject.enclosure_width_m ?? 2} onChange={e => patchSelected({enclosure_width_m:Number(e.target.value)})}/><span>m</span></div></label>
                  <label>Alto (Z)<div><input type="number" min="0.1" step="0.1" value={selectedObject.enclosure_height_m ?? 2.5} onChange={e => patchSelected({enclosure_height_m:Number(e.target.value)})}/><span>m</span></div></label>
                </div>
                <h4>Orientación</h4>
                <label className="azimuth-field">Azimut de la cara frontal
                  <div><input type="number" min="0" max="359" step="1" value={selectedObject.enclosure_azimuth_deg ?? 0} onChange={e => patchSelected({enclosure_azimuth_deg:Number(e.target.value)})}/><span>°</span></div>
                </label>
                <div className="north-compass">
                  <span>N</span>
                  <div className="compass-circle"><i style={{transform:`rotate(${Number(selectedObject.enclosure_azimuth_deg || 0)}deg)`}}>↑</i></div>
                  <small>0° = Norte · sentido horario</small>
                </div>
              </section>

              <section className="treatment-panel">
                <h4>Vista en planta (arriba)</h4>
                {(() => {
                  const faces = { ...defaultEnclosureFaces(), ...(selectedObject.enclosure_faces || {}) }
                  const stateClass = key => `face-${faces[key]?.state || 'closed'}`
                  return (
                    <svg className="enclosure-plan-svg" viewBox="0 0 420 300" role="img" aria-label="Vista en planta del encierro">
                      <rect x="105" y="65" width="210" height="165" className="plan-body"/>
                      <line x1="105" y1="65" x2="315" y2="65" className={`plan-face back ${stateClass('back')}`}/>
                      <line x1="105" y1="230" x2="315" y2="230" className={`plan-face front ${stateClass('front')}`}/>
                      <line x1="105" y1="65" x2="105" y2="230" className={`plan-face left ${stateClass('left')}`}/>
                      <line x1="315" y1="65" x2="315" y2="230" className={`plan-face right ${stateClass('right')}`}/>
                      <line x1="210" y1="42" x2="210" y2="255" className="plan-axis"/>
                      <line x1="75" y1="147" x2="345" y2="147" className="plan-axis"/>
                      <text x="210" y="31" textAnchor="middle">Fondo (180°)</text>
                      <text x="210" y="278" textAnchor="middle" className="front-label">Frente (0°)</text>
                      <text x="57" y="151" textAnchor="middle">Izquierda</text>
                      <text x="365" y="151" textAnchor="middle">Derecha</text>
                      <text x="210" y="296" textAnchor="middle" className="plan-help">Azimut real: {Number(selectedObject.enclosure_azimuth_deg || 0).toFixed(0)}°</text>
                    </svg>
                  )
                })()}
                <div className="face-state-legend">
                  <span><i className="legend-closed"/> Cerrada</span>
                  <span><i className="legend-partial"/> Parcial</span>
                  <span><i className="legend-open"/> Abierta</span>
                </div>
              </section>

              <section className="treatment-panel">
                <h4>Vista 3D (isométrica)</h4>
                {(() => {
                  const faces = { ...defaultEnclosureFaces(), ...(selectedObject.enclosure_faces || {}) }
                  const c = key => `iso-face face-${faces[key]?.state || 'closed'}`
                  return (
                    <svg className="enclosure-iso-svg" viewBox="0 0 420 300" role="img" aria-label="Vista isométrica del encierro">
                      <polygon points="115,110 235,55 325,95 205,150" className={c('roof')}/>
                      <polygon points="115,110 205,150 205,250 115,210" className={c('left')}/>
                      <polygon points="205,150 325,95 325,195 205,250" className={c('right')}/>
                      <polygon points="115,110 235,55 235,155 115,210" className={c('back')}/>
                      <polygon points="205,150 325,95 325,195 205,250" className={`${c('front')} iso-front-highlight`}/>
                      <text x="274" y="70">Fondo</text>
                      <text x="64" y="167">Izquierda</text>
                      <text x="333" y="159">Derecha</text>
                      <text x="223" y="38">Techo</text>
                      <text x="258" y="274" className="front-label">Frente</text>
                      {faces.front?.state === 'open' && <text x="258" y="289" className="open-label">(abierta)</text>}
                    </svg>
                  )
                })()}
                <div className="orientation-note">La cara “Frente” es la referencia angular del encierro. Al girar el azimut, también cambia qué superficie queda enfrentada a cada receptor.</div>
              </section>

              <section className="treatment-panel lining-panel">
                <h4>Absorción interior</h4>
                <label className="compact-field">Revestimiento
                  <select value={selectedObject.enclosure_lining_mode || 'unlined'} onChange={e => {
                    const mode=e.target.value
                    patchSelected({
                      enclosure_lining_mode:mode,
                      enclosure_absorption_coeff:mode === 'custom'
                        ? (selectedObject.enclosure_absorption_coeff || {...ENCLOSURE_ABSORPTION_PRESETS.unlined})
                        : {...ENCLOSURE_ABSORPTION_PRESETS[mode]}
                    })
                  }}>
                    <option value="unlined">Sin revestimiento</option>
                    <option value="low">Absorción baja</option>
                    <option value="medium">Absorción media</option>
                    <option value="high">Absorción alta</option>
                    <option value="custom">Personalizada por bandas</option>
                  </select>
                </label>
                <div className="absorption-preview">
                  {OCTAVE_BANDS.map(freq => {
                    const coeff=(selectedObject.enclosure_lining_mode || 'unlined') === 'custom'
                      ? Number(selectedObject.enclosure_absorption_coeff?.[freq] ?? 0)
                      : Number(ENCLOSURE_ABSORPTION_PRESETS[selectedObject.enclosure_lining_mode || 'unlined']?.[freq] ?? 0)
                    return <label key={freq}><small>{freq>=1000?freq/1000+'k':freq}</small><input type="number" min="0" max="0.99" step="0.01" disabled={(selectedObject.enclosure_lining_mode || 'unlined') !== 'custom'} value={coeff.toFixed(2)} onChange={e => patchSelected({enclosure_absorption_coeff:{...(selectedObject.enclosure_absorption_coeff || {}),[freq]:Number(e.target.value)}})}/></label>
                  })}
                </div>
                <div className="orientation-note">Estos coeficientes representan la absorción acústica del revestimiento interior. Los presets son genéricos de diseño, no certificados de material.</div>
              </section>
            </div>
          )}

          {treatmentTab === 'surfaces' && ['enclosure','semi','enclosure_silencer'].includes(selectedObject.noise_control_type || 'none') && (
            <div className="treatment-panel surface-table-panel">
              <div className="surface-table-head">
                <span>Superficie</span><span>Estado</span><span>% abierta</span><span>Caracterización</span><span>Rw</span><span>TL por bandas</span>
              </div>
              {ENCLOSURE_FACES.map(([faceKey,faceLabel]) => {
                const defaults = defaultEnclosureFaces()[faceKey]
                const face = {...defaults,...(selectedObject.enclosure_faces?.[faceKey] || {})}
                return (
                  <div className={`surface-table-row ${face.state || 'closed'}`} key={faceKey}>
                    <strong>{faceLabel}</strong>
                    <select value={face.state || 'closed'} onChange={e => patchEnclosureFace(faceKey,{state:e.target.value})}>
                      <option value="closed">Cerrada</option>
                      <option value="open">Abierta</option>
                      <option value="partial">Parcial</option>
                    </select>
                    <input type="number" min="0" max="100" step="1" disabled={face.state !== 'partial'} value={face.state === 'open' ? 100 : face.state === 'partial' ? (face.opening_pct ?? 25) : 0} onChange={e => patchEnclosureFace(faceKey,{opening_pct:Number(e.target.value)})}/>
                    <select disabled={face.state === 'open'} value={face.acoustic_mode || 'rw'} onChange={e => patchEnclosureFace(faceKey,{acoustic_mode:e.target.value})}>
                      <option value="rw">Rw único</option>
                      <option value="spectrum">TL por bandas</option>
                    </select>
                    <input type="number" min="0" max="100" step="1" disabled={face.state === 'open' || face.acoustic_mode === 'spectrum'} value={face.rw_db ?? 30} onChange={e => patchEnclosureFace(faceKey,{rw_db:Number(e.target.value)})}/>
                    <div className="surface-band-cells">
                      {OCTAVE_BANDS.map(freq => (
                        <label key={freq}><small>{freq >= 1000 ? freq/1000+'k' : freq}</small><input type="number" min="0" max="100" step="0.5" disabled={face.state === 'open' || face.acoustic_mode !== 'spectrum'} value={face.acoustic_mode === 'spectrum' ? (face.tl_db?.[freq] ?? DEFAULT_ENCLOSURE_TL[freq]) : estimatedTlFromRw(face.rw_db ?? 30,freq).toFixed(0)} onChange={e => patchEnclosureFace(faceKey,{tl_db:{...(face.tl_db || DEFAULT_ENCLOSURE_TL),[freq]:Number(e.target.value)}})}/></label>
                      ))}
                    </div>
                  </div>
                )
              })}
              <div className="rw-explainer">Si usas un Rw único, la app genera un espectro TL estimado por octavas. Si dispones de un espectro medido o certificado, selecciona “TL por bandas”: ese dato tiene prioridad.</div>
            </div>
          )}

          {treatmentTab === 'examples' && (
            <div className="treatment-example-grid">
              <div className="example-card">
                <div className="example-enclosure closed-example"><span>F</span></div>
                <strong>Encierro completo</strong>
                <p>Todas las caras están cerradas. La atenuación hacia cada receptor depende del TL/Rw de la superficie que enfrenta esa dirección.</p>
              </div>
              <div className="example-card active-example">
                <div className="example-enclosure semi-example"><span>F</span><i>ABIERTO</i></div>
                <strong>Semiencierro</strong>
                <p>Una o más caras se dejan abiertas o parciales. La abertura se define por superficie, no por un porcentaje global ambiguo.</p>
              </div>
              <div className="example-card">
                <div className="example-enclosure silencer-example"><span>F</span><b>⇢</b></div>
                <strong>Encierro + silenciador</strong>
                <p>El cerramiento se combina con una vía de ventilación cuya pérdida de inserción se define por bandas.</p>
              </div>
            </div>
          )}

          {treatmentTab === 'results' && (
            <div className="treatment-results-layout">
              {['enclosure','semi','enclosure_silencer'].includes(selectedObject.noise_control_type || 'none') ? (
                <>
                  <div className="treatment-summary-panel">
                    <strong>Modelo físico del cerramiento</strong>
                    <div className="physics-flow">
                      <span>Lw fuente</span><b>→</b><span>campo interior</span><b>→</b><span>absorción + transmisión + aberturas</span><b>→</b><span>potencia por cada cara</span><b>→</b><span>propagación exterior</span>
                    </div>
                    <small>Las dimensiones, áreas, R/TL, aberturas, revestimiento interior y ventilación participan ahora en el balance energético. Cada superficie radia con una directividad continua respecto de su normal.</small>
                  </div>
                  <div className="engine-note">
                    El nivel final depende del receptor y no se resume correctamente con un único “−dB” de control. Revísalo en el receptor o recalculando el mapa.
                  </div>
                </>
              ) : (
                <div className="treatment-summary-panel">
                  <strong>Comportamiento usado por el motor</strong>
                  {selectedObject.spectrum_mode === 'broadband' ? (
                    <div className="single-control-result">
                      <span>Reducción global</span>
                      <b>−{Number(selectedObject.control_direct_db ?? 0).toFixed(1)} dB</b>
                    </div>
                  ) : selectedObject.spectrum_mode === 'single' ? (
                    <div className="single-control-result">
                      <span>{Number(selectedObject.single_frequency_hz || 500).toFixed(0)} Hz</span>
                      <b>−{Number(selectedObject.control_direct_db ?? 0).toFixed(1)} dB</b>
                    </div>
                  ) : (
                    <div className="rw-preview">
                      {OCTAVE_BANDS.map(freq => <span key={freq}><small>{freq >= 1000 ? freq/1000+'k' : freq}</small><b>−{nominalSourceControlAttenuation(selectedObject,freq).toFixed(1)}</b></span>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {['direct','silencer'].includes(selectedObject.noise_control_type || 'none') && treatmentTab !== 'results' && (
            <div className="treatment-panel simple-treatment-panel">
              {selectedObject.noise_control_type === 'direct' ? (
                <>
                  {selectedObject.spectrum_mode === 'broadband' && (
                    <>
                      <h4>Reducción directa global</h4>
                      <div className="direct-single-field">
                        <span>Reducción global declarada</span>
                        <div><input type="number" min="0" max="80" step="0.5" value={selectedObject.control_direct_db ?? 0} onChange={e => patchSelected({control_direct_db:Number(e.target.value)})}/><b>dB</b></div>
                      </div>
                      <div className="engine-note">Se descuenta el mismo valor del LwA global de la fuente. No se genera un espectro artificial.</div>
                    </>
                  )}
                  {selectedObject.spectrum_mode === 'single' && (
                    <>
                      <h4>Reducción directa a la frecuencia seleccionada</h4>
                      <div className="direct-single-field">
                        <span>{Number(selectedObject.single_frequency_hz || 500).toFixed(0)} Hz</span>
                        <div><input type="number" min="0" max="80" step="0.5" value={selectedObject.control_direct_db ?? 0} onChange={e => patchSelected({control_direct_db:Number(e.target.value)})}/><b>dB</b></div>
                      </div>
                      <div className="engine-note">Este valor se aplica únicamente a la frecuencia Single de la fuente.</div>
                    </>
                  )}
                  {selectedObject.spectrum_mode === 'octaves' && (
                    <>
                      <h4>Reducción directa por bandas</h4>
                      <div className="face-spectrum-grid">
                        {OCTAVE_BANDS.map(freq => (
                          <label key={freq}><span>{freq >= 1000 ? freq/1000+'k' : freq}</span>
                            <input type="number" min="0" max="80" step="0.5" value={selectedObject.control_reduction_db?.[freq] ?? 0}
                              onChange={e => patchSelected({control_reduction_db:{...(selectedObject.control_reduction_db || DEFAULT_CONTROL_BANDS),[freq]:Number(e.target.value)}})}/>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <h4>Pérdida de inserción del silenciador</h4>
                  <div className="face-spectrum-grid">
                    {OCTAVE_BANDS.map(freq => (
                      <label key={freq}><span>{freq >= 1000 ? freq/1000+'k' : freq}</span>
                        <input type="number" min="0" max="80" step="0.5" value={selectedObject.silencer_il_db?.[freq] ?? DEFAULT_SILENCER_IL[freq]}
                          onChange={e => patchSelected({silencer_il_db:{...(selectedObject.silencer_il_db || DEFAULT_SILENCER_IL),[freq]:Number(e.target.value)}})}/>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {(selectedObject.noise_control_type || 'none') === 'enclosure_silencer' && treatmentTab === 'surfaces' && (
            <div className="treatment-panel silencer-vent-panel">
              <h4>Ventilación con silenciador</h4>
              <div className="vent-geometry-grid">
                <label className="compact-field">Área de abertura [m²]
                  <input type="number" min="0" step="0.01" value={selectedObject.enclosure_vent_area_m2 ?? 0.10} onChange={e => patchSelected({enclosure_vent_area_m2:Number(e.target.value)})}/>
                </label>
                <label className="compact-field">Superficie donde se ubica
                  <select value={selectedObject.enclosure_vent_face || 'back'} onChange={e => patchSelected({enclosure_vent_face:e.target.value})}>
                    {ENCLOSURE_FACES.map(([key,label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
              </div>
              <div className="orientation-note">El área de ventilación se descuenta de la superficie seleccionada y se modela como una vía independiente con la pérdida de inserción del silenciador.</div>
              <div className="face-spectrum-grid">
                {OCTAVE_BANDS.map(freq => (
                  <label key={freq}><span>{freq >= 1000 ? freq/1000+'k' : freq}</span>
                    <input type="number" min="0" max="80" step="0.5" value={selectedObject.silencer_il_db?.[freq] ?? DEFAULT_SILENCER_IL[freq]} onChange={e => patchSelected({silencer_il_db:{...(selectedObject.silencer_il_db || DEFAULT_SILENCER_IL),[freq]:Number(e.target.value)}})}/>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="treatment-dialog-footer">
            <button className="secondary" type="button" onClick={() => setControlEditorOpen(false)}>Cerrar</button>
          </div>
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
                  disabled={calculating}
                >
                  {calculating ? 'Actualizando mapa…' : 'Actualizar cambios en el mapa'}
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

      {mode === 'road' && (
        <div className="status-pill">
          Tráfico vial · {roadDraft.length} vértices · dibuja el eje de la vía y pulsa “Finalizar vía”
        </div>
      )}

      {mode === 'line' && (
        <div className="status-pill">
          {lineStart
            ? `Línea auxiliar · ${lineHover ? haversineMeters(lineStart[0], lineStart[1], lineHover[0], lineHover[1]).toFixed(1) : '0.0'} m · clic para fijar el segundo extremo`
            : 'Línea auxiliar · clic para fijar el primer extremo'}
        </div>
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
        Emisión vial CNOSSOS-EU + motor de propagación exterior educativo · no constituye una cadena normativa CNOSSOS completa
      </footer>
    </div>
  )
}

export default App
