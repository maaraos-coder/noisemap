// Visual annotations only. These objects are never part of an acoustic request.
export function opacity(value, fallback = 0.64) {
  if (value === null || value === '' || value === undefined) return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback
}

export function polygonPoints(points) {
  if (!Array.isArray(points)) throw new Error('Se requieren al menos tres vértices.')
  const ring = points.map(point => {
    if (!Array.isArray(point) || point.length !== 2 || point.some(v => v === null || !['string','number'].includes(typeof v) || (typeof v==='string' && !v.trim()))) throw new Error('Cada vértice necesita latitud y longitud.')
    const [lat, lon] = point.map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Revisa el rango de las coordenadas.')
    return [lat, lon]
  })
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop()
  if (ring.length < 3 || new Set(ring.map(p => p.join(','))).size !== ring.length) throw new Error('Usa al menos tres vértices distintos, sin repetir puntos.')
  const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
  const on = (a,b,c) => cross(a,b,c) === 0 && c[0]>=Math.min(a[0],b[0]) && c[0]<=Math.max(a[0],b[0]) && c[1]>=Math.min(a[1],b[1]) && c[1]<=Math.max(a[1],b[1])
  const intersects = (a,b,c,d) => (cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)
  for (let i=0;i<ring.length;i++) for (let j=i+1;j<ring.length;j++) {
    if (j===i+1 || (i===0 && j===ring.length-1)) continue
    if (intersects(ring[i],ring[(i+1)%ring.length],ring[j],ring[(j+1)%ring.length])) throw new Error('Los lados del polígono no deben cruzarse.')
  }
  const origin=ring[0]
  const area=ring.reduce((sum,p,i) => { const q=ring[(i+1)%ring.length]; return sum+(p[0]-origin[0])*(q[1]-origin[1])-(q[0]-origin[0])*(p[1]-origin[1]) },0)
  if (Math.abs(area)<1e-14) throw new Error('El polígono debe encerrar una superficie.')
  return ring
}

export function restoreVisuals(data) {
  if (data.auxiliaryPolygons != null && !Array.isArray(data.auxiliaryPolygons)) throw new Error('La lista de polígonos auxiliares no es válida.')
  const polygons=(data.auxiliaryPolygons || []).map((item,index) => ({
    id:String(item.id || `auxiliary-${index}`), name:String(item.name || 'Polígono auxiliar'),
    points:polygonPoints(item.points), color:/^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#2563eb',
    fillOpacity:opacity(item.fillOpacity,0.2), visible:item.visible!==false,
  }))
  if (new Set(polygons.map(p=>p.id)).size!==polygons.length) throw new Error('Hay polígonos auxiliares con identificadores repetidos.')
  return { polygons, noiseOpacity:opacity(data.noiseOpacity) }
}

export function auxiliaryGeoJSON(polygons) {
  return {type:'FeatureCollection',features:polygons.filter(p=>p.visible!==false).map(p=>({
    type:'Feature', properties:{id:p.id,color:p.color,fillOpacity:p.fillOpacity},
    geometry:{type:'Polygon',coordinates:[[...p.points,p.points[0]].map(([lat,lon])=>[lon,lat])]},
  }))}
}
