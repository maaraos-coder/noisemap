import proj4 from 'proj4'
export function convertPoint(row, system='wgs', zone=19, hemisphere='south') {
  if(row.some(v=>String(v).trim()==='')) throw Error('Complete todas las coordenadas.')
  let [a,b]=row.map(Number)
  if(!Number.isFinite(a)||!Number.isFinite(b)) throw Error('Coordenadas no numéricas.')
  if(system==='utm') {
    if(!Number.isInteger(Number(zone))||zone<1||zone>60||a<100000||a>900000||b<0||b>10000000) throw Error('Zona o coordenadas UTM fuera de rango.')
    const [lon,lat]=proj4(`+proj=utm +zone=${zone} ${hemisphere==='south'?'+south':''} +datum=WGS84 +units=m +no_defs`,'EPSG:4326',[a,b]); a=lat;b=lon
  }
  if(!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a)>90||Math.abs(b)>180) throw Error('Latitud o longitud fuera de rango.')
  return [a,b]
}

export function toUTM(lat,lon,zone,hemisphere) {
 return proj4('EPSG:4326',`+proj=utm +zone=${zone} ${hemisphere==='south'?'+south':''} +datum=WGS84 +units=m +no_defs`,[lon,lat])
}
export function validateGeometry(points,type) {
 const polygon=['building','polygon','auxiliary'].includes(type)
 if(!polygon) return
 const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
 const origin=points[0]
 const area=points.reduce((sum,a,i)=>sum+cross(origin,a,points[(i+1)%points.length]),0)
 if(Math.abs(area)<1e-14) throw Error('El polígono tiene área nula.')
 const on=(a,b,c)=>Math.abs(cross(a,b,c))<1e-14&&c[0]>=Math.min(a[0],b[0])-1e-14&&c[0]<=Math.max(a[0],b[0])+1e-14&&c[1]>=Math.min(a[1],b[1])-1e-14&&c[1]<=Math.max(a[1],b[1])+1e-14
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++) {
  if(j===i+1||(i===0&&j===points.length-1)) continue
  const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length]
  if((cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)) throw Error('Los lados del polígono se cruzan.')
 }
}

