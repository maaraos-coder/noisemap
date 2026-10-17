import { useRef, useState } from 'react'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import { auxiliaryGeoJSON } from './auxiliaryPolygons'

export function AuxiliaryPolygonLayer({ polygons, draft, selectedId, onSelect, onUpdate, onDraftUpdate, visible }) {
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
    {draft.map(([lat,lon],index)=><Marker key={`draft-${index}`} latitude={lat} longitude={lon} draggable
      onClick={e=>e.originalEvent.stopPropagation()}
      onDragEnd={e=>onDraftUpdate(index,[e.lngLat.lat,e.lngLat.lng])}>
      <button type="button" className="auxiliary-vertex" title={`Arrastrar vértice ${index+1}`}>{index+1}</button>
    </Marker>)}
    {selected?.points.map(([lat,lon],index)=><Marker key={`${selected.id}-${index}`} latitude={lat} longitude={lon} draggable
      onClick={e=>{e.originalEvent.stopPropagation();onSelect(selected.id)}}
      onDragEnd={e=>onUpdate(selected.id,{points:selected.points.map((p,i)=>i===index?[e.lngLat.lat,e.lngLat.lng]:p)})}>
      <button type="button" className="auxiliary-vertex" title={`Arrastrar vértice ${index+1}`}>{index+1}</button>
    </Marker>)}
  </>
}

export function AuxiliaryPolygonPanel({ polygon, onChange, onClose, onDelete, onEditCoordinates }) {
  const panelRef=useRef(null), dragRef=useRef(null)
  const [position,setPosition]=useState(null)
  function startDrag(e) {
    if(e.button!==0 || e.target.closest('button')) return
    const rect=panelRef.current.getBoundingClientRect()
    dragRef.current={dx:e.clientX-rect.left,dy:e.clientY-rect.top}
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function moveDrag(e) {
    if(!dragRef.current) return
    const rect=panelRef.current.getBoundingClientRect()
    setPosition({x:Math.max(8,Math.min(window.innerWidth-rect.width-8,e.clientX-dragRef.current.dx)),y:Math.max(8,Math.min(window.innerHeight-rect.height-8,e.clientY-dragRef.current.dy))})
  }
  return <div className="coord-backdrop"><section ref={panelRef} className="coord-panel auxiliary-polygon-panel" role="dialog" aria-modal="false" aria-label="Editar polígono auxiliar" style={position?{left:position.x,top:position.y,right:'auto'}:undefined}>
    <header className="coord-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={()=>{dragRef.current=null}} onPointerCancel={()=>{dragRef.current=null}}><div className="object-drag-handle">⋮⋮ Mover ficha</div><button type="button" onClick={onClose} aria-label="Cerrar polígono auxiliar">×</button></header><div className="coord-body"><div className="object-type">REFERENCIA VISUAL</div><h2>Polígono auxiliar</h2>
    <p>Referencia visual del predio o de otra zona. No actúa como edificio, barrera ni área de cálculo.</p>
    <label>Nombre<input value={polygon.name} onChange={e=>onChange({name:e.target.value})}/></label>
    <label>Color<input type="color" value={polygon.color} onChange={e=>onChange({color:e.target.value})}/></label>
    <label>Opacidad del relleno · {Math.round(polygon.fillOpacity*100)} %<input type="range" min="0" max="100" value={Math.round(polygon.fillOpacity*100)} onChange={e=>onChange({fillOpacity:Number(e.target.value)/100})}/></label>
    <label className="auxiliary-visibility"><input type="checkbox" checked={polygon.visible!==false} onChange={e=>onChange({visible:e.target.checked})}/> Mostrar polígono</label>
    <button type="button" onClick={onEditCoordinates}>Editar coordenadas</button>
    <p>Arrastra los vértices en el mapa o abre el editor para agregar, quitar y ordenar puntos. En el editor elige WGS84 (latitud/longitud) o UTM (Este/Norte, zona y hemisferio).</p>
    <button type="button" onClick={onDelete}>Eliminar este polígono</button>
  </div></section></div>
}
