import {test} from 'node:test'
import assert from 'node:assert/strict'
import {convertPoint,toUTM,validateGeometry} from '../src/coordinates.js'
test('Santiago WGS84 / UTM 19S round trip',()=>{
 const ll=[-33.4569,-70.6483],utm=toUTM(...ll,19,'south')
 assert.ok(utm[0]>300000&&utm[0]<400000)
 assert.ok(utm[1]>6200000&&utm[1]<6400000)
 const actual=convertPoint(utm,'utm',19,'south')
 actual.forEach((v,i)=>assert.ok(Math.abs(v-ll[i])<1e-7))
})
test('rejects empty, non-finite, invalid geographic and UTM coordinates',()=>{
 for(const p of [['',0],[NaN,0],[Infinity,0],[91,0],[0,181]]) assert.throws(()=>convertPoint(p))
 assert.throws(()=>convertPoint([1,2],'utm',19,'south'))
 assert.throws(()=>convertPoint([350000,6300000],'utm',0,'south'))
})
test('rejects crossing and degenerate polygons, accepts valid footprint',()=>{
 assert.throws(()=>validateGeometry([[0,0],[1,1],[0,1],[1,0]],'polygon'))
 assert.throws(()=>validateGeometry([[0,0],[1,1],[2,2]],'building'))
 assert.doesNotThrow(()=>validateGeometry([[0,0],[0,1],[1,1],[1,0]],'building'))
})
