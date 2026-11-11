# NoiseMap: motor de propagación CNOSSOS-EU §2.5

Este directorio prepara el servicio de cálculo externo **NoiseModelling** de la
Université Gustave Eiffel. No reemplaza la API Python de NoiseMap ni su
interfaz MapLibre, que siguen desplegadas por separado.

## 1. Servicio de cómputo (Render)

Importar `deploy/noisemodelling/render-blueprint.yaml` como un **Blueprint
independiente** para crear `noisemap-cnossos-engine`. NO sustituir
`render.yaml` del repositorio.

La configuración usa la imagen pública oficial de
`ghcr.io/universite-gustave-eiffel/noisemodelling:main`, con:
- plan de al menos **2 GB RAM** (compute **de pago**);
- disco persistente de 5 GB en `/srv/noisemodelling/workspace`;
- límite JVM de 1536 MB;
- autenticación habilitada por defecto; secreto de cifrado aleatorio;
- un solo proceso para evitar corrupción de la base H2.

**Precauciones:** la etiqueta `:main` es mutable; para producción formal
seleccionar un digest OCI específico después de verificar compatibilidad y
casos de referencia. No habilitar `UNSECURE_MODE` ni exponer WPS con cuentas
administrativas a alumnos. Cada usuario que ejecute scripts/SQL en el servicio
requiere permisos mínimos y control de acceso. Verificar precio del servicio
y almacenamiento antes de activar el Blueprint. La API Python de Render
existente se despliega independientemente.

## 2. Primera activación

1. Verificar que el servicio Render informa estado **Live** y acceso HTTPS.
2. Revisar logs de la primera ejecución y realizar el registro seguro del
   administrador de NoiseModelling usando TOTP.
3. Acceder al Builder de NoiseModelling mediante la URL protegida.
4. Crear proyecto de prueba y consultar
   `/builder/ows?service=WPS&request=GetCapabilities&version=1.0.0`
   con la sesión autenticada. La URL /builder/ows implementa el WPS estándar.
5. Abrir la exportación ZIP de NoiseMap (`Escenario para NoiseModelling`);
   reproyectar GeoJSON desde EPSG:4326 a un CRS **métrico**, atribuir altitudes,
   geometrías y absorciones acústicas de suelo.
6. Importar las tablas espaciales con el bloque oficial `Import_File`.
   Mapear las fuentes puntuales (segmentos de carretera) y sus bandas de
   potencia a `SOURCES_GEOM` y `LW_ROADS` según el esquema de entrada de
   la versión instalada (nombres PK, THE_GEOM, IDSOURCE, HZ63…HZ8000).
   Crear RECEIVERS y BUILDINGS, y configurar DEM y GROUND_TYPE si se dispone.
7. Ejecutar **Noise_level_from_source** para cada uno de los tres períodos
   con `tableSources`, `tableSourcesEmission`, `tableBuilding`,
   `tableReceivers`, `confDiffVertical`, `confDiffHorizontal`,
   `confMaxSrcDist` y los parámetros meteorológicos revisados.
8. Exportar niveles por receptor, bandas y período. Solo entonces combinar
   Lday, Levening y Lnight a Lden (12/4/8 horas; +0/+5/+10 dB).

En una simulación de fachada hay que decidir explícitamente el tratamiento
de la reflexión en la fachada propia, la distancia del receptor a la fachada,
la cota sobre terreno, y la meteorología. **El ZIP de NoiseMap es un intercambio
GIS y no una ejecución de los pasos 6–8.**

## 3. Integración en la interfaz de NoiseMap

La app en Vercel sigue calculando niveles de receptor con su motor educativo,
aunque la emisión vial incorpora el método CNOSSOS §2.2. La propagación
reglamentaria debe ejecutarse en este servicio, y el resultado solo debe
mostrar la etiqueta CNOSSOS-EU §2.5 después de pruebas verificables.

El Builder incluye una pestaña Python que genera solicitudes WPS compatibles
con el endpoint protegido `/builder/ows`. Es el contrato recomendado para
automatizar una etapa posterior sin acceso directo a SQL ni credenciales en
el navegador de los alumnos.

## 4. Validación requerida

- Verificar con casos de referencia oficiales de NoiseModelling
  trayectoria directa, suelo, meteorología homogénea/favorable,
  difracción y reflexión, bandas de octava.
- Comparar el espectro emitido por NoiseMap con las tablas importadas
  sin sumar dos veces la potencia de segmentos ni correcciones de suelo.
- Ensayar superficies absorbentes, barreras y edificios, receptores exteriores
  de diferentes pisos, errores de SRID/altitud y escenarios vacíos.
- Publicar metodología, versión/digest del motor y parámetros por corrida.

**No confundir** servicio NoiseModelling instalado con integración validada
de predicción CNOSSOS-EU en la app. Son etapas distintas.

Fuentes: documentación oficial
https://noisemodelling.readthedocs.io/en/latest/Architecture.html
https://noisemodelling.readthedocs.io/en/latest/Builder.html
y repositorio https://github.com/Universite-Gustave-Eiffel/NoiseModelling
