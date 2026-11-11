# CNOSSOS-EU · integración progresiva en NoiseMap

## Módulo disponible en esta rama

La emisión vial de la aplicación admite cinco subcategorías con coeficientes por
octava (63 Hz a 8 kHz) de la **tabla F-1 de la Directiva Delegada (UE)
2021/1226**: turismos 1, medianos 2, pesados 3, ciclomotores 4a y
motocicletas 4b. Las categorías 4a y 4b utilizan **solo emisión de
propulsión**. Los niveles se suman energéticamente y la potencia por metro se
convierte a fuentes segmentadas.

Los flujos para día, tarde y noche se editan de forma independiente; el Lden
aplica 12/4/8 horas y penalizaciones 0/5/10 dB. Las velocidades de cada
subcategoría son editables. Los valores de Pasaje Chimbote son únicamente
**supuestos docentes**, nunca datos medidos.

### Limitaciones actuales: NO es una implementación reglamentaria

- **Emisión §2.2 incompleta:** pendiente, neumáticos, aceleración en
  intersecciones, pavimentos diferentes del de referencia y otras
  correcciones todavía no están implementadas.
- **Propagación §2.5 no implementada íntegramente:** el motor de receptor
  actual no sustituye el cálculo CNOSSOS completo de trayectorias
  homogéneas/favorables, suelo, difracción, reflexiones y meteorología.
- No hay comparación exhaustiva con los casos de referencia de CNOSSOS-EU,
  ni cálculo certificado de indicadores anuales, ni modelo completo para
  ferrocarriles, industria o aeronaves.
- Los resultados JSON llevan `normative:false` y contienen los supuestos.

### Para concluir la integración completa

1. Elegir y desplegar un motor especializado de CNOSSOS-EU §2.5, por
   ejemplo **NoiseModelling** (requiere infraestructura de cálculo propia;
   Vercel solo aloja el frontend React).
2. Construir un modelo geométrico 3D consistente de calles, edificios,
   terreno, receptores, suelo y meteorología, con intercambio GeoJSON
   y sus parámetros espectrales.
3. Completar correcciones oficiales de fuente vial y luego los otros
   tipos de fuente definidos en la normativa.
4. Verificar emisión y propagación con conjuntos de referencia
   independientes de la implementación, incluyendo variantes con
   reflexiones, difracción y suelo.
5. Activar la opción «CNOSSOS-EU validado» únicamente tras completar y
   documentar las pruebas; mantener el modo docente separadamente.

## Referencias

- Directiva 2002/49/CE, anexo I, indicadores Lden/Lnight.
- Directiva (UE) 2015/996, anexo II.
- Directiva Delegada (UE) 2021/1226, especialmente tabla F-1 y
  modificaciones del método.
- NoiseModelling (Université Gustave Eiffel), motor acústico abierto.

No usar esta implementación parcial para demostrar cumplimiento regulatorio.
