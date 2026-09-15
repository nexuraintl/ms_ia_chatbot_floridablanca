# Base de conocimiento del Estatuto Tributario

Cómo el asistente responde preguntas tributarias con fundamento en el **Acuerdo Municipal
020 del 31 de julio de 2026**, que compila el Estatuto Tributario del Municipio de
Floridablanca (290 páginas de PDF, 726 artículos).

Documento hermano: [MANUAL.md](MANUAL.md) para la operación del servicio y
[../SECURITY.md](../SECURITY.md) para el análisis de seguridad.

---

## 1. Qué cambió respecto a la versión anterior

Antes, el conocimiento del asistente era un archivo de 6 intenciones
(`src/config/NewFaqConfig.json`, 12 KB) compilado dentro del bundle del navegador. El
frontend emparejaba la pregunta por palabras clave, elegía **una** intención y armaba con
ella la instrucción de sistema que enviaba al proxy.

Eso tenía tres problemas:

1. **Cobertura.** Seis intenciones no cubren un estatuto de 726 artículos.
2. **Operación.** Cambiar una respuesta obligaba a recompilar el frontend y volver a
   desplegar.
3. **Confianza.** La instrucción de sistema es la sección de máxima autoridad para el
   modelo y la construía el navegador. Cualquier cliente podía hacer `POST /api/ai/chat`
   con el bloque «información oficial» que se le ocurriera.

Ahora el conocimiento vive en el servidor (`server/knowledge/`), se recupera por
relevancia y **el servidor arma la instrucción de sistema**. El cliente sigue enviando el
historial de la conversación y el contexto de la página; ninguno de los dos decide qué
información oficial se le entrega al modelo.

---

## 2. El pipeline de extracción

El PDF del Acuerdo **no tiene capa de texto**: son 290 imágenes escaneadas a ~200 DPI, una
por página. Sin OCR no hay ni un carácter que extraer.

```
PDF escaneado
   │  tools/knowledge/ocr_pdf.py          OCR con Windows.Media.Ocr (es-ES), ~90 s
   ▼
geom.jsonl  (texto + coordenadas de cada palabra)
   │  tools/knowledge/build_corpus.py     limpieza, troceado por artículo, tablas
   ▼
server/knowledge/corpus.json  +  tools/knowledge/out/*.json
   │  tools/knowledge/export_excel.py     libro de revisión para la entidad
   ▼
Base_conocimiento_Estatuto_Tributario_Floridablanca.xlsx
```

Para volver a generarlo todo:

```bash
python tools/knowledge/ocr_pdf.py "ruta/al/Acuerdo.pdf" scratch/geom.jsonl
python tools/knowledge/build_corpus.py scratch/geom.jsonl server/knowledge/corpus.json
python tools/knowledge/export_excel.py server/knowledge/corpus.json tools/knowledge/out/revision.xlsx
```

### Por qué el OCR nativo de Windows

No hay Tesseract ni poppler en el entorno de desarrollo, y `Windows.Media.Ocr` trae el
idioma `es-ES` instalado. Procesa las 290 páginas en 88 segundos, sin coste, sin instalar
nada y sin que el documento salga del equipo. Se accede desde Python con el paquete
`winsdk`.

Consecuencia: **el pipeline de OCR solo corre en Windows**. Es un paso de preparación que
se ejecuta cuando cambia el Estatuto, no en el despliegue ni en CI, así que no limita el
funcionamiento del servicio. Para portarlo a Linux basta sustituir `ocr_pdf.py` por una
implementación con Tesseract que emita el mismo JSONL; nada más del pipeline cambia.

### Por qué se guardan las coordenadas de cada palabra

Porque 84 de las 290 páginas son una sola tabla: las **tarifas de ICA por actividad
económica CIIU**. El OCR por líneas devuelve el texto en orden de lectura y pierde la
asociación fila-columna, así que las tarifas quedan como números sueltos sin dueño. Con la
posición de cada palabra la tabla se reconstruye: columna de código (x < 30% del ancho),
columna de descripción, columna de tarifa (x > 78%), y se agrupan por fila visual con una
tolerancia de 30 px.

El umbral de columna se decide **por patrón y no solo por posición**: el escaneo está
ligeramente inclinado y el borde izquierdo de la columna de descripción se desplaza a lo
largo de la página. Con un umbral puramente posicional en 26% del ancho, las líneas que
empezaban en x=439 px (25,8%) se clasificaban como código y se perdían actividades enteras.

---

## 3. Las tablas matriciales no salen del OCR

Las tablas de varias columnas de datos —tarifas de predial por estrato y rango de avalúo,
delineación urbana por destinación, sobretasa bomberil por estrato— **no son
reconstruibles de forma fiable** por este OCR. Se pierden celdas y se parten valores: en la
tabla de predios urbanizables, un `25` se leyó como `2` en una columna y `5` en la
siguiente, y en la tabla habitacional faltaba el valor de estrato 5 de la primera fila.

Para una entidad de hacienda eso no es un detalle: una tarifa mal leída es una liquidación
mal informada. Esas cinco tablas se transcribieron por **lectura visual de la página
escaneada, celda por celda**, y viven en
`tools/knowledge/manual/tablas_verificadas.json`, fuera del OCR:

| Tabla | Artículo | Página |
|---|---|---|
| Predial, sector habitacional e institucional | 33 | 17 |
| Predial, predios no habitacionales | 33 | 18 |
| Predial, urbanizables no urbanizados y lotes | 33 | 18 |
| Delineación urbana por m² y destinación | 157 | 141 |
| Sobretasa bomberil por estrato | 325 | 182 |

---

## 4. Controles de calidad sobre las tarifas de ICA

Las 1.125 filas de tarifas de ICA sí vienen del OCR, así que el pipeline las audita:

- **Coma decimal repuesta.** La tarifa de ICA está acotada por la Ley 14 de 1983 y ninguna
  llega a 12 por mil. Un valor de dos dígitos por encima de ese techo solo puede ser una
  coma que el OCR no vio: `45` es `4,5` y `72` es `7,2`. Se repusieron 3 comas, todas
  registradas en el informe y en el Excel.
- **Monotonía por rango.** Dentro de una actividad, la tarifa no puede decrecer al subir el
  rango de ingresos. Esa comprobación es la que delató las 3 comas perdidas.
- **Tarifas ausentes.** En 41 filas el OCR no reconoció el dígito (impresión débil). **No
  se infieren**: quedan vacías, marcadas `sin dato`, y el asistente tiene instrucción
  expresa de no completarlas. Están listadas en la hoja «Por revisar» del Excel para que la
  entidad las transcriba.

---

## 5. Formato del corpus

`server/knowledge/corpus.json` contiene 1.275 fragmentos. Cada uno declara **de dónde sale
y con cuánta confianza**, y esa etiqueta viaja al modelo dentro del prompt:

| `confianza` | Qué es | Cuántos |
|---|---|---|
| `curada` | Pregunta y respuesta redactada, citada al articulado | 102 |
| `verificada` | Tabla transcrita a mano y revisada celda por celda | 5 |
| `ocr_texto` | Prosa del articulado reconocida por OCR | 788 |
| `ocr_geometria` | Tarifa de ICA reconstruida por posición de columna | 380 |

El troceado de la prosa es **un fragmento por artículo**, que es la unidad natural de un
estatuto: cada artículo es autocontenido y se cita por su número. Los artículos largos se
parten por párrafo (`PARÁGRAFO`, literales, numerales) con un tope de 2.600 caracteres, de
modo que ningún fragmento supere el presupuesto del prompt.

### Detección de artículos

El corpus cubre los **726 artículos sin un solo hueco**. Dos decisiones lo hacen posible:

- La cabecera se reconoce **sensible a mayúsculas**: en el documento un artículo se titula
  `ARTÍCULO 33.` en versales, mientras que una referencia en el cuerpo se escribe «el
  artículo 60 de la Ley 1430». Ignorar la caja convertía cada referencia en un artículo
  nuevo.
- El número debe **ascender** dentro de una ventana de 40. Así se descarta la única
  cabecera falsa que quedaba: una referencia al `ARTICULO 908 DEL ESTATUTO TRIBUTARIO
  NACIONAL` en la página 123. Lo descartado queda registrado en el informe, nunca se
  descarta en silencio.

---

## 6. Recuperación

`server/knowledge/retriever.js` implementa **BM25 léxico** sobre los 1.275 fragmentos. El
índice se construye una vez por proceso (64 ms) y una consulta se resuelve en menos de un
milisegundo.

BM25 y no embeddings, por ahora, por tres razones: el vocabulario de una consulta
tributaria coincide literalmente con el del Estatuto («predial», «reteica», «paz y salvo»);
no hay coste ni latencia por consulta; y el texto del ciudadano no sale hacia un tercero
para vectorizarlo. El módulo es sustituible sin tocar el resto si la recuperación semántica
llega a hacer falta.

Sobre BM25 se aplican cuatro políticas, todas calibradas contra este corpus:

**Ponderación por campo.** El epígrafe pesa ×3 y el tema ×2 frente al cuerpo, porque el
epígrafe describe el asunto del artículo mejor que su redacción.

**Ventaja de lo curado (×1,4).** Ante la misma consulta, BM25 prefiere el documento que
repite más veces el término: para «¿qué es la UVT?» ganaba una tabla de tarifas llena de
«UVT» en lugar de la respuesta escrita para explicarlo. Una respuesta curada está redactada
en el lenguaje del ciudadano y fue revisada por la entidad, así que en empate debe ganar.

**Cita de artículo (+12).** Preguntar «¿qué dice el artículo 33?» es una petición explícita,
no una coincidencia léxica. El empujón se da al texto de la norma y no a las preguntas
curadas que la citan: quien pide un artículo por número quiere el artículo.

**Barrera de especificidad.** Un resultado que solo casa por vocabulario genérico («días»,
«término») no es una coincidencia de contenido. Se exige que al menos un término coincidente
aparezca en menos del 15% del corpus, pero **solo cuando la consulta tiene tres o más
términos**: con una o dos palabras la consulta *es* el término, y exigir especificidad ahí
dejaba sin respuesta «¿qué es la UVT?».

### Con qué se consulta: la conversación, no solo el último mensaje

La primera versión recuperaba usando únicamente el último mensaje del ciudadano, y eso
rompía los seguimientos. Medido sobre el corpus:

| Consulta | Fragmentos recuperados |
|---|---|
| «quiero que me des detalles de ese artículo» | **0** |
| «cuáles son los requisitos» | 2, ninguno pertinente (exenciones de predial y degüello de ganado) |

Con cero fragmentos, las reglas de fundamentación hacen exactamente lo que deben: el
modelo dice que no tiene el dato y pregunta a qué artículo se refiere. Visto desde la
conversación parece que «pierde el contexto», pero el modelo sí tiene el historial; lo que
faltaba era el fundamento, porque la consulta de recuperación no lo pedía.

`buildRetrievalQueries` en `server/aiProxy.js` devuelve **dos consultas separadas**:

- `query`: el mensaje actual, más los artículos que el asistente acababa de citar cuando el
  mensaje es claramente un seguimiento —nombra un artículo sin decir cuál, o es corto y
  trae un demostrativo («de ese», «más detalles»)—. Un mensaje largo con un «más» suelto se
  trata como consulta nueva y no arrastra nada.
- `contextQuery`: el mensaje anterior del ciudadano. Solo uno: con más turnos, un cambio de
  tema arrastraría demasiado ruido.

**Van separadas porque mezclarlas fallaba.** Concatenadas en una sola cadena, el mensaje
anterior ganaba por número de términos: ante «y de ICA?» tras una pregunta de predial, los
fragmentos de predial casaban cinco términos y el único término nuevo no tenía nada que
hacer. El resultado medido eran cuatro fragmentos de predial y cero de ICA, y con las
reglas de fundamentación el modelo respondía con una evasiva. Correcto por la razón
equivocada.

Con las dos consultas, la recuperación tiene tres pasos:

1. **El mensaje actual fija el tema.** Se traen 12 candidatos.
2. **El mensaje anterior reordena dentro del tema.** Se vuelve a puntuar solo sobre esos
   candidatos y se suman los dos puntajes. Esto es lo que transfiere el *aspecto*: con una
   sola palabra, los doce fragmentos de ICA puntúan casi igual (3,11 a 2,92) y BM25 no
   tiene con qué distinguir; cuál sirve lo dice el turno anterior. Tras preguntar por
   tarifas, «y de ICA?» trae primero «¿Qué tarifa de ICA le aplica a mi actividad?»; tras
   preguntar quién paga, trae «¿Quién debe pagar el ICA?».
3. **Se añaden dos fragmentos del tema anterior**, para no perder el hilo. Van al final: si
   el presupuesto de caracteres no alcanza, lo que se conserva es la respuesta a lo que se
   acaba de preguntar.

En este paso la barrera de especificidad se apaga: el conjunto ya está acotado por tema, y
ahí la barrera descartaría todos los candidatos en lugar de ordenarlos.

El plural es significativo al citar: `citedArticles` lee «artículos 106 y 107» como dos
artículos, y «artículo 33 y 5 por mil» como uno solo, porque ahí el 5 no es un artículo.

### Singular y plural

El tokenizador reduce el plural castellano al singular. Sin eso, «tarifas» y «tarifa» son
términos distintos para BM25: el ciudadano pregunta por «las tarifas» y el fragmento que
las trae dice «la tarifa», y no casan. Fue lo que impidió durante una iteración que el
aspecto se transfiriera.

No pretende ser correcto lingüísticamente —«analisis» queda en «analisi»— sino
**consistente**: la misma regla se aplica a la consulta y al corpus, así que la
coincidencia se produce aunque la raíz no sea una palabra.

La lista de palabras vacías incluye las de cortesía («hola», «gracias», «buenas»), que no
tienen significado tributario. No incluye «día», «tarde» ni «favor», que el Estatuto sí
usa: «días hábiles», «pagar tarde», «saldo a favor».

### Cuánto contexto se envía

Las bandas de `CONFIDENCE_BANDS` deciden cuántos fragmentos entran:

| Puntaje del mejor resultado | Fragmentos |
|---|---|
| ≥ 8 | 4 |
| ≥ 2 | 2 |
| < 2 | 0 |

**Con una excepción: la cobertura.** Si el corpus conoce todos los términos de la consulta,
no se recorta por banda. Una consulta de una palabra puntúa bajo por ser corta, no por ser
irrelevante: «y de ICA?» deja un solo término y el corpus lo conoce (cobertura 1), mientras
que «qué tal el clima» deja dos y solo conoce uno (cobertura 0,5). El puntaje no las separa;
la cobertura sí. Recortar a dos fragmentos en el primer caso era lo que dejaba a «y de ICA?»
con el aspecto equivocado.

**No existe un umbral que separe la charla de una consulta real.** Medido sobre este
corpus, las consultas sin contenido tributario puntúan entre 0 y 6,4, y las reales entre
2,2 y 22,5: se solapan. Una pregunta legítima de una sola palabra puntúa más bajo que un
saludo de tres.

Los dos errores no cuestan lo mismo. Recuperar de más en un saludo gasta unos miles de
caracteres de entrada; no recuperar en una pregunta real deja al ciudadano sin la norma que
la responde. Por eso el piso es bajo —2— y lo que las bandas gradúan es *cuánto* contexto
se envía, no *si* se envía. Un saludo sin vocabulario del dominio («hola», «gracias»)
puntúa 0 y no arrastra nada; uno que comparte alguna palabra arrastra dos fragmentos como
máximo.

---

## 7. Cómo se arma el prompt

`server/knowledge/promptBuilder.js` reparte el presupuesto de caracteres: primero las
reglas, y lo que sobra para el conocimiento.

```
maxSystemChars (12.000)
├─ BASE_RULES          ~2.400   comportamiento, tono, enlaces, límites de seguridad
├─ GROUNDING_RULES     ~1.700   fundamentación en el Estatuto (solo si hay fragmentos)
├─ margen                 250
└─ bloque de conocimiento  resto   fragmentos completos, nunca cortados
```

El tope del proxy pasó de 8.000 a 12.000 caracteres. **Eso no sube el coste máximo por
petición**: el techo que lo fija es `maxTotalInputChars` (24.000), que no cambió; lo que
cambia es el reparto entre instrucción e historial.

El corte del bloque se decide **por fragmento completo**. El proxy recorta con `slice`, así
que un bloque que no cupiera se cortaría a mitad de frase; decidir el corte aquí evita
entregarle al modelo un artículo truncado como si estuviera entero.

### Las reglas de fundamentación

Son la parte de seguridad de la función. El modelo sabe de impuestos colombianos por su
entrenamiento y responderá sin fuente si no se le prohíbe expresamente. En materia
tributaria una cifra inventada es una liquidación mal informada. Las reglas exigen:

- Toda afirmación normativa debe salir del bloque; si el dato no está, decirlo y remitir a
  la Secretaría de Hacienda.
- Citar el artículo del que sale la regla.
- Nunca calcular, redondear ni deducir cifras; nunca liquidar el impuesto del ciudadano.
- Un fragmento marcado `sin dato` no se completa. Uno marcado «tabla escaneada» se cita
  invitando a confirmarlo en la factura.
- **Nunca dar fechas de vencimiento ni porcentajes de descuento por pronto pago**: el
  Estatuto no fija el calendario tributario, lo fija la Secretaría de Hacienda por
  resolución anual (artículos 18 y 35).
- No dar el valor de la UVT en pesos si no aparece en el bloque: lo reajusta la DIAN cada
  año (artículos 13 y 14).

Cuando el corpus está cargado pero la consulta no casa con nada, se envían las reglas base
más un aviso explícito de que no hay información oficial para esa consulta y que no debe
afirmar datos normativos. Es el caso que evita que un «no encontré nada» se convierta en
una respuesta inventada con aire de oficial.

### Duplicación de `BASE_RULES`

El texto de comportamiento está en dos sitios: `server/knowledge/promptRules.js` (la ruta
de producción) y `src/adapters/ai/systemPrompt.js` (la ruta de desarrollo con clave local,
donde el navegador llama a Gemini directamente). No se comparte un módulo porque la imagen
de Docker solo copia `dist/` y `server/`: un `import` desde `server/` hacia afuera rompería
el contenedor.

La divergencia se evita con una prueba: `tests/run-knowledge-tests.mjs` compara los dos
textos y falla si dejan de ser idénticos.

---

## 8. Preguntas y respuestas curadas

`tools/knowledge/manual/preguntas.json` tiene 102 preguntas escritas a partir del
articulado, cada una con sus palabras clave y los artículos de los que sale la respuesta.
Cubren predial, paz y salvo, exclusiones y exenciones, ICA, RIT, ReteICA, avisos y tableros,
delineación urbana, nomenclatura, alumbrado público, plusvalía, publicidad exterior,
espectáculos, sanciones e intereses, acuerdos de pago, prescripción, devoluciones, cobro
coactivo, recursos y derechos del contribuyente.

Cada pregunta declara la **vigencia** de su respuesta:

- `estable`: definiciones, requisitos, procedimientos, tarifas fijadas en el Acuerdo.
- `volatil`: lo que caduca cada año. Son tres —calendario y descuentos del predial,
  incentivo del ICA y valor de la UVT— y **su respuesta no da la cifra**: explica quién la
  fija y remite a la factura y a la Secretaría. Es la forma de que el asistente no quede
  desactualizado el 1 de enero.

El Excel de revisión (`tools/knowledge/export_excel.py`) exporta las 102 con una columna
para que la entidad marque «Sí / No / Ajustar» y otra para su corrección. Ese libro es el
paso de aprobación antes de publicar.

---

## 9. Límites conocidos

- **41 tarifas de ICA sin dato** (3,6% de 1.125). El asistente lo dice en lugar de
  estimarlas. Se resuelven transcribiéndolas desde el PDF; están listadas en el Excel.
- **Todo el articulado viene de OCR.** La prosa tolera bien un error de reconocimiento
  porque el modelo lee el contexto, pero una cifra suelta no. De ahí que las cifras
  citables estén en las tablas verificadas y que las reglas prohíban afirmar valores que no
  estén literalmente en el bloque.
- **Artefactos de OCR en ordinales.** El volado se lee como cero: «1°» aparece como «10».
  Se corrigió en las respuestas curadas; en el articulado permanece. No se aplicó una
  sustitución automática porque «artículo 60 de la Ley 1430» es una referencia legítima y
  corregirla la rompería.
- **Un solo municipio.** El corpus es de Floridablanca. Ver la sección siguiente.

---

## 10. Actualizar el Estatuto o añadir otro municipio

**Cuando cambie el Acuerdo:** volver a correr el pipeline con el PDF nuevo, revisar el
informe de extracción (`tools/knowledge/out/informe_extraccion.json`) por si aparecen
huecos de numeración, re-transcribir las tablas matriciales que hayan cambiado y revisar las
preguntas marcadas `volatil`. Las pruebas de integridad del corpus fallan si la numeración
o las tablas verificadas se rompen.

**Para un segundo municipio** hacen falta tres cosas, ninguna de ellas en el motor de
recuperación:

1. Su corpus, generado con el mismo pipeline desde su propio estatuto.
2. Selección del corpus por `tenantId`: hoy `corpusStore.js` carga un único
   `corpus.json`, y habría que resolver la ruta por tenant.
3. La configuración del tenant (`src/config/chatbotConfig.json`): datos del municipio,
   `allowedLinkHosts` con sus dominios `.gov.co` y sus respuestas rápidas.

El troceado, la auditoría de tarifas, el recuperador y las reglas de fundamentación no
cambian: son independientes del municipio.
