# CNOSSOS-EU en NoiseMap · estado técnico comprobable

## Incluido en la rama de integración

- Emisión **CNOSSOS-EU §2.2** para 1/2/3/4a/4b según tablas F-1 a F-4
  consolidadas con la Directiva Delegada (UE) 2021/1226. Motor externo:
  [phonometry](https://github.com/jmrplens/phonometry), licencia MIT, revisión
  de Git fijada en backend/requirements.txt, Python 3.13.
- Correcciones por temperatura, pendiente longitudinal, bidireccionalidad
  (cada mitad con pendiente de signo contrario), pavimento, neumáticos
  con clavos y cercanía a cruce semaforizado/rotonda. Los parámetros son
  explícitos en el editor vial.
- Segmentación del trazado y emisión espectral 63 a 8000 Hz. La corrección
  por intersección se evalúa usando la distancia de cada segmento al centro
  del cruce definido por abscisa desde el inicio del trazado.
- Consulta independiente de Lw′ en dB re 1 pW/m:
  POST `/api/cnossos/road-emission` (no es nivel de presión).
- Flujos editables para Lday (12 h), Levening (4 h), Lnight (8 h),
  acumulación energética Lden 0/5/10 dB y descarga JSON.
- Intercambio geoespacial: `POST /api/cnossos/export-noisemodelling`
  genera ZIP con escenario JSON y GeoJSON para tres períodos, edificios,
  barreras y receptores. Los archivos EPSG:4326 se **deben reproyectar**
  a un CRS métrico apropiado e importar a la configuración 3D del motor.
- Pruebas CI de potencia espectral, correcciones, geometrias y build.

## NO está terminado: propagación CNOSSOS-EU §2.5

Los valores en receptores y los mapas actuales pasan por el motor de
propagación docente preexistente de NoiseMap. **No constituyen un cálculo
CNOSSOS-EU §2.5**, aunque las potencias de las fuentes sí se calculen con
el método de emisión CNOSSOS-EU.

Para resultados de propagación completos se requiere ejecutar el motor
NoiseModelling (Universite Gustave Eiffel, GPLv3) o uno equivalente,
reproyectar/georreferenciar DEM y edificaciones, ajustar coberturas de suelo,
reflectancia, condiciones meteorológicas y trayectorias, y validar con casos
de referencia antes de etiquetar los mapas como reglamentarios. NoiseModelling
necesita un servicio Java adicional con suficientes CPU y memoria. Vercel
aloja el **frontend**, y Render aloja actualmente el backend Python; el ZIP
exportado NO ejecuta el motor Java ni sustituye la importación a su esquema
H2/Spatial.

## Reglas de uso docente

- Pasaje Chimbote: flujos son **supuestos**, no aforos reales.
- Potencias en dB re 1 pW/m, no confundir con dB(A) de presión de fachada.
- Para la fachada, ubicar el receptor a la altura exterior de la vivienda
  elegida y documentar el criterio de reflexión de fachada.
- Solo etiquetar como regulatorio después de validar geometría,
  meteorología, emisiones, propagación, periodos de referencia y datos
  anuales reales. La app conserva `normative:false` en su exportación Lden.

## Fuentes

- Directiva 2002/49/CE y anexo II reemplazado por (UE) 2015/996.
- Directiva Delegada (UE) 2021/1226, tablas F-1 / F-4.
- Documentación API phonometry, `cnossos_road`.
- NoiseModelling: https://noisemodelling.readthedocs.io/en/latest/
