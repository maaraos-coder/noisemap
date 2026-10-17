import { useEffect, useState } from 'react'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import { auxiliaryGeoJSON, polygonPoints } from './auxiliaryPolygons'

export function AuxiliaryPolygonLayer({ polygons, draft, selectedId, onSelect, onUpdate, visible }) {
  const selected=visible ? polygons.find(p=>p.id===selectedId && p.visible!==false) : null
  const draftGeometry=draft.length>=2 ? {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:draft.map(([lat,lon])=>[lon,lat])}}]} : {type:'FeatureCollection',features:[]}
  return <>
    <Source id="auxiliary-polygons" type="geojson" data={auxiliaryGeoJSON(visible ? polygons : [])}>
      <Layer id="auxiliary-polygons-fill" type="fill" paint={{'fill-color':['get','color'],'fill-opacity':['get','fillOpacity']}} />
      <Layer id="auxiliary-polygons-line" type="line" paint={{'line-color':['get','color'],'line-width':3}} />
    </Source>
    <Source id="auxiliary-polygon-draft" type="geojson" data={draftGeometry}>
      <Layer id="auxiliary-polygon-draft-line" type="line" paint={{'line-color':'#2563eb','line-width':3,'line-dasharray':[2,2]}} />
    </Source>
    {draft.map(([lat,lon],index)=><Marker key={`draft-${index}`} latitude={lat} longitude={lon}><span className="auxiliary-vertex">{index+1}</span></Marker>)}
    {selected?.points.map(([lat,lon],index)=><Marker key={`${selected.id}-${index}`} latitude={lat} longitude={lon} draggable
      onClick={e=>{e.originalEvent.stopPropagation();onSelect(selected.id)}}
      onDragEnd={e=>onUpdate(selected.id,{points:selected.points.map((p,i)=>i===index?[e.lngLat.lat,e.lngLat.lng]:p)})}>
      <button type="button" className="auxiliary-vertex" title={`Arrastrar vértice ${index+1}`}>{index+1}</button>
    </Marker>)}
  </>
}

export function AuxiliaryPolygonPanel({ polygon, onChange, onClose, onDelete }) {
  const [vertices,setVertices]=useState(polygon.points.map(p=>p.join(', ')).join('\n'))
  const [error,setError]=useState('')
  useEffect(()=>setVertices(polygon.points.map(p=>p.join(', ')).join('\n')),[polygon.points])
  return <section className="auxiliary-polygon-panel" aria-label="Editar polígono auxiliar">
    <header><h3>Polígono auxiliar</h3><button type="button" onClick={onClose} aria-label="Cerrar polígono auxiliar">×</button></header>
    <p>Referencia visual del predio o de otra zona. No actúa como edificio, barrera ni área de cálculo.</p>
    <label>Nombre<input value={polygon.name} onChange={e=>onChange({name:e.target.value})}/></label>
    <label>Color<input type="color" value={polygon.color} onChange={e=>onChange({color:e.target.value})}/></label>
    <label>Opacidad del relleno · {Math.round(polygon.fillOpacity*100)} %<input type="range" min="0" max="100" value={Math.round(polygon.fillOpacity*100)} onChange={e=>onChange({fillOpacity:Number(e.target.value)/100})}/></label>
    <label><input type="checkbox" checked={polygon.visible!==false} onChange={e=>onChange({visible:e.target.checked})}/> Mostrar polígono</label>
    <p>Arrastra sus vértices en el mapa. Para agregar o quitar vértices, modifica la lista de coordenadas.</p>
    <label>Vértices · una pareja latitud, longitud por línea<textarea rows="5" value={vertices} onChange={e=>setVertices(e.target.value)} /></label>
    <button type="button" onClick={()=>{try { const points=polygonPoints(vertices.trim().split(/\n+/).map(line=>line.split(',').map(v=>v.trim())));onChange({points});setError('') } catch(e) {setError(e.message)}}}>Aplicar vértices</button>
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={onDelete}>Eliminar este polígono</button>
  </section>
}
