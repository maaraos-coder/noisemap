# Curso 5 · Laboratorio 2 — Auditoría del Lden incidente de fachada

## Objetivo y delimitación

Estimar la exposición al ruido de tránsito de una vivienda del Edificio
Chimbote, con fuentes de emisión **CNOSSOS-EU §2.2** y propagación
**educativa basada en ISO 9613-2:2024**, sin presentarla como resultado
reglamentario de **CNOSSOS-EU §2.5**.

El receptor exterior se sitúa **aproximadamente 0,1 m por delante de la
fachada expuesta**, a la altura del recinto de interés. El cálculo identifica
el muro receptor y excluye **solo** su reflexión especular, en lugar de
aplicar una resta arbitraria de 3 dB. Las demás superficies conservan
sus atributos de reflexión y pantalla. La exclusión de la reflexión de
fachada propia es el criterio del indicador Lden incidente de la
Directiva 2002/49/CE, anexo I; el criterio de distancia a fachada es
orientativo para el escenario docente y no acredita conformidad CNOSSOS.

## Operación en NoiseMap

1. Dibujar o importar **la calle** con su eje real y el **edificio**
   con polígono cerrado o abierto; revisar las posiciones en el mapa.
2. Crear un **receptor exterior** del lado de la calle, a unos 0,1 m
   de la cara exterior de la vivienda. Introducir altura sobre terreno
   del piso analizado. No ubicarlo dentro del edificio.
3. En la tarjeta de **vía**, introducir flujos medios horarios por
   vehículo y período (día/tarde/noche), velocidades y condiciones de
   superficie, pendiente y cruces. Para Pasaje Chimbote los flujos
   predeterminados son **supuestos docentes** y no aforos.
4. Seleccionar el edificio y receptor en **Auditoría del receptor en
   fachada**, y pulsar **Calcular Lden en receptor**. La auditoría muestra:
   distancia receptor-fachada, distancia fachada-calle, altura, muro
   seleccionado y si está del lado de la calle.
5. Si el receptor está mal ubicado, moverlo y repetir el cálculo.
   No forzar un valor Lden con un receptor detrás de la vivienda o
   dentro del edificio.
6. Exportar el JSON. El archivo registra receptor, edificio, muro,
   distancias, método de reflexión y Lday/Levening/Lnight/Lden.

## Conclusiones acústicas que sí puede sacar un alumno

- Cómo varía la exposición al cambiar velocidad, composición y
  volumen de tránsito o distancia y altura del receptor.
- Cómo influye elegir un receptor exterior frente a la calle frente
  a uno situado al lado opuesto del edificio.
- Cómo se ponderan los períodos con 12/4/8 horas y penalizaciones
  0/5/10 dB para obtener el indicador Lden.

## Limitaciones y validación

- Los tests geométricos automatizados utilizan un **edificio rectangular
  sintético**, no planos ni coordenadas verificadas del Edificio Chimbote.
- El cálculo de reflexión propia se limita al modelo especular de
  primer orden del motor; **no garantiza** que toda la reflexión difusa
  o el fenómeno de esquina estén descritos.
- La suma energética y espectros se calculan en el motor existente.
  No hay una validación independiente en dB frente a NoiseModelling
  §2.5 para este caso real. Por tanto no se informa desviación
  numérica respecto de CNOSSOS-EU.
- La Directiva 2002/49/CE considera el sonido **incidente** (sin
  reflejo de la propia fachada). El valor aproximado de `-3 dB`
  corresponde habitualmente a la **corrección de una medición**
  en fachada, no debe restarse a un cálculo que ya excluye dicha
  reflexión. Para mapas estratégicos de exposición existen criterios
  específicos de altura de receptor y asignación a fachadas.
- Para un caso real, verificar cotas, planos, orientación de fachada,
  altura real del receptor, características de pavimentos, tráfico
  medido representativo del año y metodología acústica.

Referencias: Directiva 2002/49/CE, anexo I; Directiva Delegada
2021/1226; documentación interna `CNOSSOS_IMPLEMENTACION.md`.

**Estado:** evaluación académica de exposición incidente; no
predicción CNOSSOS-EU §2.5 acreditada.
