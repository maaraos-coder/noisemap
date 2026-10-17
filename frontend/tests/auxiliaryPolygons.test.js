import test from 'node:test'
import assert from 'node:assert/strict'
import { auxiliaryGeoJSON, opacity, polygonPoints, restoreVisuals } from '../src/auxiliaryPolygons.js'

const points=[[-33.61,-70.57],[-33.611,-70.57],[-33.611,-70.569],[-33.61,-70.569]]

test('closes only the GeoJSON ring and preserves latitude-longitude input',()=>{
  const source=structuredClone(points)
  const polygon={id:'predio',points:source,color:'#2563eb',fillOpacity:0.2,visible:true}
  const geo=auxiliaryGeoJSON([polygon])
  assert.deepEqual(geo.features[0].geometry.coordinates[0][0],[-70.57,-33.61])
  assert.equal(geo.features[0].geometry.coordinates[0].length,5)
  assert.deepEqual(source,points)
  assert.equal(auxiliaryGeoJSON([{...polygon,visible:false}]).features.length,0)
})

test('rejects crossed, degenerate, repeated, nonfinite and out-of-range vertices',()=>{
  for(const bad of [points.slice(0,2),[points[0],points[2],points[1],points[3]],[[0,0],[1,1],[2,2]],
    [...points,points[1]],[[91,0],[0,1],[0,0]],[[NaN,0],[1,0],[0,1]],[[0,' '],[1,0],[0,1]]]) {
    assert.throws(()=>polygonPoints(bad))
  }
  assert.deepEqual(polygonPoints([...points,points[0]]),points)
})

test('projects round trip visual polygons and both independent opacity controls',()=>{
  const project={sources:[{lw_db:100}],polygon:points,result:{receiver_results:[67.7]},
    auxiliaryPolygons:[{id:'p',name:'Predio',points,color:'#d97706',fillOpacity:0.35,visible:false}],noiseOpacity:0.4}
  const before=structuredClone(project)
  const restored=restoreVisuals(JSON.parse(JSON.stringify(project)))
  assert.equal(restored.polygons[0].fillOpacity,0.35)
  assert.equal(restored.noiseOpacity,0.4)
  assert.equal(restored.polygons[0].visible,false)
  assert.deepEqual(project,before)
  assert.deepEqual(restoreVisuals({}),{polygons:[],noiseOpacity:0.64})
})

test('opacity supports transparent and opaque limits without changing data',()=>{
  assert.equal(opacity(0),0)
  assert.equal(opacity(1),1)
  assert.equal(opacity(9),1)
  assert.equal(opacity(-1),0)
  assert.equal(opacity(NaN),0.64)
  assert.equal(opacity(undefined),0.64)
})

test('invalid imported geometry and duplicate IDs are rejected before changing project state',()=>{
  assert.throws(()=>restoreVisuals({auxiliaryPolygons:[{points:[[1,2],[2,3]]}]}))
  assert.throws(()=>restoreVisuals({auxiliaryPolygons:[{id:'p',points},{id:'p',points}]}))
})
