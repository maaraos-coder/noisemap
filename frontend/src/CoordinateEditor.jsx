import React, {useRef, useState} from 'react'
import {convertPoint, validateGeometry, toUTM} from './coordinates.js'
import * as XLSX from 'xlsx'

const labels={source:'Fuente puntual',receiver:'Receptor',barrier:'Barrera',building:'Edificio',road:'Fuente lineal / tráfico',polygon:'Área de cálculo',accessory:'Línea auxiliar'}
export default function CoordinateEditor({initial, onClose, onPreview, onCommit}) {
 const [type,setType]=useState(initial?.type||'source'),[system,setSystem]=useState('wgs'),[zone,setZone]=useState(19),[hemisphere,setHemisphere]=useState('south')
 const panelRef=useRef(null), dragRef=useRef(null)
 const [position,setPosition]=useState(null)
 const obj=initial?.object
 const [rows,setRows]=useState(obj?.points || (obj?.lat_a!=null?[[obj.lat_a,obj.lon_a],[obj.lat_b,obj.lon_b]]:obj?.lat!=null?[[obj.lat,obj.lon]]:initial?.type==='accessory'?[['',''],['','']]:[['','']]))
 const [name,setName]=useState(obj?.name||''),[height,setHeight]=useState(obj?.height_m??1.5),[ground,setGround]=useState(obj?.ground_elevation_m??'')
 const [rectangle,setRectangle]=useState(false),[length,setLength]=useState(20),[width,setWidth]=useState(10),[angle,setAngle]=useState(0)
 const singlePoint=['source','receiver'].includes(type)||(type==='building'&&rectangle)
 const [error,setError]=useState(''),[ready,setReady]=useState(null),[batch,setBatch]=useState(null)
 const change=fn=>{setBatch(null);fn();setReady(null);onPreview(null);setError('')}
 function build(){
   if(batch) return batch
   let points=(singlePoint?rows.slice(0,1):rows).map(r=>convertPoint(r,system,Number(zone),hemisphere))
   if(rectangle&&type==='building') {
     if(!(Number(length)>0&&Number(width)>0&&Number.isFinite(Number(angle)))) throw Error('Dimensiones u orientación inválidas.')
     const [lat,lon]=points[0],t=Number(angle)*Math.PI/180
     if(Math.abs(lat)>85) throw Error('El rectángulo requiere una ubicación fuera de las regiones polares.')
     points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>{const e=x*width/2*Math.cos(t)+y*length/2*Math.sin(t),n=-x*width/2*Math.sin(t)+y*length/2*Math.cos(t);return [lat+n/111320,lon+e/(111320*Math.cos(lat*Math.PI/180))]})
   }
   const min=['source','receiver'].includes(type)?1:['barrier','road','accessory'].includes(type)?2:3
   if(points.length<min||(['source','receiver'].includes(type)&&points.length!==1)) throw Error(`Se requieren ${min} vértices${min===1?' exactamente':' como mínimo'}.`)
   if(type==='accessory'&&points.length!==2) throw Error('La línea auxiliar requiere un inicio y un término.')
   if(new Set(points.map(p=>p.join(','))).size!==points.length) throw Error('Hay vértices repetidos. No repita el vértice de cierre.')
   validateGeometry(points, type)
   if(!['polygon','accessory'].includes(type)&&(height===''||!Number.isFinite(Number(height))||Number(height)<=0)) throw Error('La altura debe ser positiva.')
   if(ground!==''&&!Number.isFinite(Number(ground))) throw Error('Cota inválida.')
   return [{type,object:{...obj,name:name||labels[type],points,height_m:type==='accessory'?0:Number(height),ground_elevation_m:ground===''?null:Number(ground)}}]
 }
 async function importFile(file){setBatch(null);setReady(null);onPreview(null);setError('');try{
   const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}),data=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''})
   if(!data.length) throw Error('El archivo no contiene filas.')
   const items=data.map((r,i)=>{try{const p=convertPoint(system==='wgs'?[r.lat,r.lon]:[r.easting,r.northing],system,Number(zone),hemisphere),h=r.height_m===''?1.5:Number(r.height_m??1.5),g=r.ground_elevation_m===''||r.ground_elevation_m==null?null:Number(r.ground_elevation_m),lw=r.lw_db===''?100:Number(r.lw_db??100);if(!Number.isFinite(h)||h<=0||(g!=null&&!Number.isFinite(g))||!Number.isFinite(lw)) throw Error('Altura, cota o potencia inválida');return {type,object:{name:String(r.name||`${labels[type]} ${i+1}`),points:[p],height_m:h,ground_elevation_m:g,lw_db:lw}}}catch(e){throw Error(`Fila ${i+2}: ${e.message}`)}})
   change(()=>setBatch(items))
 }catch(e){setError(e.message)}}
 function startDrag(e){
   if(e.target.closest('button')||e.button!==0)return
   const rect=panelRef.current.getBoundingClientRect()
   dragRef.current={dx:e.clientX-rect.left,dy:e.clientY-rect.top}
   e.currentTarget.setPointerCapture(e.pointerId)
 }
 function moveDrag(e){
   if(!dragRef.current)return
   const rect=panelRef.current.getBoundingClientRect()
   setPosition({x:Math.max(8,Math.min(window.innerWidth-rect.width-8,e.clientX-dragRef.current.dx)),y:Math.max(8,Math.min(window.innerHeight-rect.height-8,e.clientY-dragRef.current.dy))})
 }
 return <div className="coord-backdrop"><section ref={panelRef} className="coord-panel" role="dialog" aria-modal="false" aria-label="Ingreso de coordenadas" style={position?{left:position.x,top:position.y,right:'auto'}:undefined}>
 <header className="coord-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={()=>{dragRef.current=null}} onPointerCancel={()=>{dragRef.current=null}}>
 <div className="object-drag-handle">⋮⋮ Mover ficha</div><button aria-label="Cerrar coordenadas" onClick={()=>{onPreview(null);onClose()}}>×</button>
 </header><div className="coord-body"><div className="object-type">COORDENADAS · {labels[type].toUpperCase()}</div><h2>{obj?'Editar coordenadas':'Ingresar coordenadas'}</h2>
 <label>Objeto <select disabled={!!obj} value={type} onChange={e=>change(()=>{setType(e.target.value);if(e.target.value==='accessory')setRows([rows[0]||['',''],rows[1]||['','']]);if(['source','receiver'].includes(e.target.value))setRows([rows[0]||['','']]);setBatch(null);setRectangle(false)})}>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Sistema <select value={system} onChange={e=>change(()=>{setRows(rows.map(r=>{try{const [lat,lon]=convertPoint(r,system,Number(zone),hemisphere);return e.target.value==='wgs'?[lat,lon]:toUTM(lat,lon,zone,hemisphere)}catch{return ['','']}}));setSystem(e.target.value);setBatch(null)})}><option value="wgs">WGS84 — latitud / longitud</option><option value="utm">UTM — datum WGS84</option></select></label>
 {system==='utm'&&<div><label>Zona <input type="number" min="1" max="60" value={zone} onChange={e=>change(()=>setZone(e.target.value))}/></label><select aria-label="Hemisferio" value={hemisphere} onChange={e=>change(()=>setHemisphere(e.target.value))}><option value="south">Sur</option><option value="north">Norte</option></select></div>}
 <label>Nombre <input value={name} onChange={e=>change(()=>setName(e.target.value))}/></label>
 {type==='building'&&<label><input type="checkbox" checked={rectangle} onChange={e=>change(()=>{setRectangle(e.target.checked);if(e.target.checked)setRows([rows[0]||['','']])})}/>Centro + largo + ancho + orientación</label>}
 {rectangle&&type==='building'&&<div>{[['Largo (m)',length,setLength],['Ancho (m)',width,setWidth],['Orientación (° desde norte)',angle,setAngle]].map(([l,v,s])=><label key={l}>{l}<input type="number" value={v} onChange={e=>change(()=>s(e.target.value))}/></label>)}</div>}
 {singlePoint ? <div className="coord-point-fields">
 {[system==='wgs'?'Latitud':'Este (m)',system==='wgs'?'Longitud':'Norte (m)'].map((label,j)=><label key={j}>{label}<input type="number" step="any" value={rows[0]?.[j]??''} onChange={e=>change(()=>setRows([(rows[0]||['','']).map((v,k)=>k===j?e.target.value:v)]))}/></label>)}
 </div> : <>
 <table><thead><tr><th>{type==='accessory'?'Extremo':'Vértice'}</th><th>{system==='wgs'?'Latitud':'Este (m)'}</th><th>{system==='wgs'?'Longitud':'Norte (m)'}</th>{type!=='accessory'&&<th>Orden</th>}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td>{type==='accessory'?(i===0?'Inicio':'Término'):i+1}</td>{r.map((v,j)=><td key={j}><input aria-label={`V${i+1} ${j===0?'latitud o este':'longitud o norte'}`} type="number" step="any" value={v} onChange={e=>change(()=>setRows(rows.map((p,k)=>k===i?p.map((q,l)=>l===j?e.target.value:q):p)))}/></td>)}{type!=='accessory'&&<td><button aria-label={`Subir vértice ${i+1}`} disabled={!i} onClick={()=>change(()=>{const a=[...rows];[a[i-1],a[i]]=[a[i],a[i-1]];setRows(a)})}>↑</button><button aria-label={`Bajar vértice ${i+1}`} disabled={i===rows.length-1} onClick={()=>change(()=>{const a=[...rows];[a[i+1],a[i]]=[a[i],a[i+1]];setRows(a)})}>↓</button><button aria-label={`Eliminar vértice ${i+1}`} onClick={()=>change(()=>setRows(rows.filter((_,k)=>k!==i)))}>×</button></td>}</tr>)}</tbody></table>
 {type!=='accessory'&&<button onClick={()=>change(()=>setRows([...rows,['','']]))}>Agregar vértice</button>}
 </>}
 {!['polygon','accessory'].includes(type)&&<label>Altura sobre el terreno (m)<input type="number" step="any" value={height} onChange={e=>change(()=>setHeight(e.target.value))}/></label>}
 {['source','receiver'].includes(type)&&<><label>Cota absoluta del terreno (m; vacío = topografía del proyecto)<input type="number" step="any" value={ground} onChange={e=>change(()=>setGround(e.target.value))}/></label>{!obj&&<details className="coord-import"><summary>Carga masiva desde archivo</summary><p>Agrega varias fuentes o receptores a la vez desde una planilla CSV o Excel. Cada fila representa un objeto. Para ingresar solo uno, usa los campos de arriba.</p><label>Seleccionar archivo CSV o Excel<input type="file" accept=".csv,.xlsx,.xls" onChange={e=>e.target.files[0]&&importFile(e.target.files[0])}/><small>Columnas: name, {system==='wgs'?'lat, lon':'easting, northing'}, height_m, ground_elevation_m, lw_db (fuentes). {batch&&`${batch.length} objetos listos.`}</small></label></details>}</>}
 {error&&<p role="alert">{error}</p>}
 </div><footer><button className="coord-secondary" onClick={()=>{onPreview(null);onClose()}}>Cancelar</button><button className="coord-preview" onClick={()=>{try{const items=build();onPreview(items);setReady(items);setError('')}catch(e){setError(e.message)}}}>Ubicar y previsualizar</button><button className="coord-confirm" disabled={!ready} onClick={()=>{onCommit(ready,initial);onPreview(null);onClose()}}>Confirmar</button></footer>
 </section></div>
}
