# Plan de mitigación de respuestas de florIA

Fecha: 7 de octubre de 2026.

## Objetivo

Resolver consultas del municipio con respuestas completas, útiles y sustentadas; consultar fuentes oficiales cuando el conocimiento disponible no alcance; conservar el rechazo a preguntas ajenas a la entidad y reducir las remisiones innecesarias a las dependencias.

Una respuesta breve debe terminar sus frases y responder lo solicitado. La brevedad es un requisito de redacción; alcanzar el límite técnico no convierte una respuesta incompleta en aceptable.

## Evidencia y alcance de la revisión

Se revisaron la conversación JSON entregada por el usuario, el checkout local `master` y la referencia local `azure/qa`, commit `079b1c3` del 6 de octubre de 2026. La raíz del workspace está en una versión anterior a varias funciones de QA. La copia de `output/playwright/lanzamiento-v2/source`, procedente de `e6cb83c`, tiene los mismos archivos relevantes de recuperación, proxy y enrutamiento que esa referencia de QA, comprobado con `git diff`.

Los resultados siguientes describen código disponible y reproducciones locales. Antes de implementar, hay que identificar la revisión que atendió la conversación. No se inspeccionaron logs de Gemini ni se confirmó la revisión desplegada. Las cifras y artículos citados por el bot en el JSON son respuestas bajo evaluación, no datos normativos validados por esta revisión.

| Hallazgo | Evidencia | Implicación |
| --- | --- | --- |
| Respuestas incompletas | En el acuerdo de pago termina en «Secretaría de»; en sanciones ICA termina en «tus». Cliente y proxy limitan la salida a 200 tokens. | El tope es una causa probable del corte; hace falta registrar `finishReason` para atribuirlo con certeza. |
| Se acepta cualquier respuesta con texto | El proxy toma el primer bloque de texto y devuelve éxito; `finishReason` solo se consulta si no hay texto. | No distingue una respuesta terminada de una generación interrumpida. |
| Recuperación sensible a la formulación | La pregunta de porcentaje de sanción ICA recuperó cero fragmentos; al agregar «según el estatuto tributario» recuperó seis, usando los contextos del chat. | El ciudadano tiene que descubrir cómo activar el conocimiento. |
| Calendario fuera del conocimiento disponible | El corpus revisado se centra en el Estatuto. El prompt prohíbe fechas concretas incluso en sus reglas de calendario. | Falta obtener la resolución anual y permitir respuestas sustentadas en ella. |
| El sitemap aporta enlaces, no lectura | Se conservan hasta 60 enlaces, se seleccionan tres y no se consultan sus contenidos. Además, se excluyen enlaces directos a PDF y otros documentos. | Conocer una URL no significa conocer su contenido. |
| No hay búsqueda web en la petición revisada | La petición a Gemini se reconstruye con contenidos, instrucciones y configuración; no incluye herramientas de búsqueda o lectura. | Un cambio de prompt por sí solo no puede habilitar esa capacidad. |
| Predial se abre ante una pregunta ICA | Con Predial pendiente, «Que multas puedo tener si no declaro industria y comercio» devuelve `viaActivation: true`, aunque `isFlowConfirmation` devuelve `false`. | El «si» condicional se trata como confirmación y esa vía omite la validación de pregunta. |
| Las fuentes quedan ocultas salvo petición expresa | Las reglas restringen los enlaces a solicitudes explícitas y prohíben añadir enlaces no pedidos. | Obstaculiza entregar el documento que sustenta una respuesta. |

La guardia temática de QA permite expresamente términos municipales, y las preguntas tributarias del JSON llegaron a ser respondidas. No hay evidencia de que esa guardia haya bloqueado estas consultas. El problema observado combina recuperación insuficiente, reglas demasiado restrictivas para las fuentes, ausencia de herramientas y fallos de enrutamiento.

## Fase 1: completar respuestas y corregir activaciones

Prioridad inmediata. No depende de incorporar fuentes nuevas.

1. Separar la longitud que se quiere mostrar del límite técnico de generación. Mantener respuestas breves y pedir una estructura proporcional a la consulta: respuesta directa, requisitos o pasos necesarios y fuente. Evaluar un margen técnico inicial de 512–768 tokens sin obligar a consumirlo. Modificar cliente y servidor coordinadamente: aumentar solo uno no cambia el límite efectivo.
2. Propagar y registrar `finishReason`, motivo de bloqueo, uso real y resultado de validación. Leer todos los bloques de texto pertinentes de la respuesta, excluyendo contenido interno cuando el proveedor lo distinga.
3. Ante `MAX_TOKENS`, no publicar el borrador incompleto. Realizar como máximo una reformulación más compacta, con la misma evidencia y un presupuesto controlado. No concatenar continuaciones a ciegas ni recortar por caracteres. Si falla la recuperación, entregar una respuesta breve y cerrada que explique lo confirmado y la limitación real.
4. Validar que la respuesta cubra los componentes solicitados. «Documentos y beneficios» requiere ambos; agregar una invitación al trámite no reemplaza el componente faltante. La puntuación final es una señal auxiliar, no una prueba suficiente de calidad.
5. Contabilizar todas las llamadas consumidas, incluida la generación descartada y el reintento. Conservar los límites de gasto, ajustando sus presupuestos con mediciones.
6. Exigir confirmación explícita del trámite mediante botón o expresiones completas. Eliminar coincidencias difusas de palabras cortas para acciones y aplicar la validación de confirmación también a `viaActivation`. Una pregunta o un cambio de servicio no debe abrir el trámite pendiente.

Criterio de salida: los dos ejemplos cortados producen respuestas completas y la pregunta ICA nunca abre Predial, incluso después de ofrecer ese trámite.

## Fase 2: separar alcance, seguridad y suficiencia de información

Tres decisiones independientes:

- **Alcance:** ¿la consulta corresponde a los servicios, territorio o competencias de la entidad? Considerar el significado y el contexto, no solo palabras permitidas o prohibidas.
- **Seguridad:** ¿se intenta cambiar instrucciones, revelar secretos o ejecutar acciones no autorizadas? El contenido leído en páginas y documentos sigue siendo evidencia, nunca una orden.
- **Información:** ¿hay fuentes suficientes y vigentes para responder? Si no hay, se recupera o busca información; no se rechaza una consulta municipal por falta de corpus.

Mantener rechazo a «¿cuál es el perro más grande del mundo?». Admitir «¿dónde esterilizan perros en Floridablanca?» y consultas similares aunque compartan vocabulario con temas de trivia. Ante ambigüedad real, preguntar únicamente el dato que cambia la respuesta.

Hacer cumplir la política en el backend para que no dependa de una guardia del navegador. Las reglas del sistema deben seguir vigentes incluso si el corpus falta o no carga. Revisar también el orden entre guardia y ejecución de flujos para evitar acciones antes de validar la intención.

Criterio de salida: el conjunto de preguntas ajenas conserva su rechazo y las municipales no se bloquean por ausencia de información.

## Fase 3: mejorar recuperación y memoria

1. Conservar el índice BM25 existente como base. Incorporar equivalencias del dominio: ICA/Industria y Comercio, vencimientos/calendario tributario, declarar tarde/extemporaneidad. Medir antes de añadir embeddings u otro servicio.
2. Normalizar y reformular consultas en lenguaje ciudadano usando su contexto, sin exigir «según el estatuto». La pregunta general de sanción puede requerir aclarar si se refiere a extemporaneidad, no declarar o inexactitud; no asumir automáticamente una única sanción.
3. Guardar estado semántico mínimo: municipio, servicio, año, intención y datos pendientes. En la secuencia «calendario 2026 → Industria y Comercio → ¿cuáles son esas fechas?» conservar ICA y 2026 aunque ya no aparezcan en los dos últimos mensajes.
4. Evaluar relevancia y cobertura de los fragmentos por componente solicitado. Si solo cubren parte de la consulta, buscar la parte faltante en lugar de producir una respuesta genérica.
5. Evitar arrastrar artículos o trámites cuando el ciudadano cambia de tema. Los fragmentos y respuestas anteriores no deben convertirse en prueba de vigencia.

Criterio de salida: variantes equivalentes recuperan evidencia suficiente sin frases especiales y las repreguntas mantienen impuesto y año correctos.

## Fase 4: consultar páginas y documentos oficiales

Implementar una secuencia controlada en servidor:

`consulta + contexto → validar alcance → recuperar conocimiento → buscar evidencia faltante → leer páginas/documentos → comprobar entidad y vigencia → responder con fuentes → validar integridad`

1. Crear un catálogo de fuentes por entidad, independiente del dominio donde se incrusta el widget. Incluir páginas de trámites, Estatuto, modificaciones, resoluciones de calendario y requisitos de acuerdos de pago. Registrar URL, entidad emisora, título, fecha de expedición, periodo aplicable y fecha de actualización del índice. Una fecha reciente de descarga no prueba vigencia.
2. Usar el sitemap para descubrir contenidos e incorporar los documentos asociados a las páginas. Admitir PDF y extraer sus textos y tablas; marcar o revisar errores de OCR antes de usar cifras.
3. Recuperar primero de fuentes oficiales indexadas. Si falta información o requiere actualización, ejecutar búsqueda web y leer los resultados oficiales pertinentes. Consultar fuentes nacionales, como DIAN, cuando corresponda a la competencia; no sustituir un calendario municipal por una norma nacional.
4. Elegir entre búsqueda y lectura propias en backend o herramientas de Gemini mediante una prueba pequeña con el modelo y endpoint utilizados. `Google Search` y `URL context` son capacidades distintas; hay que habilitarlas y preservar sus metadatos. Dar solo el mapa del sitio tampoco basta con URL context: no sigue automáticamente los enlaces anidados.
5. Aplicar los dominios permitidos y comprobar las URLs resueltas y redirecciones en código. Restringir accesos a redes privadas, limitar tamaños, tiempo, número de lecturas y búsquedas. Tratar los documentos recuperados como datos no confiables frente a instrucciones.
6. No enviar a búsquedas externas nombres, correos, documentos ni historial completo. Construir consultas públicas con municipio, impuesto, año y tema.
7. Actualizar las reglas normativas: permitir fechas, tarifas y requisitos cuando los sustente la fuente competente y vigente. La restricción correcta es no inventarlos; no prohibirlos incluso después de encontrar la resolución.
8. Mostrar citas breves y el enlace al documento aunque el usuario no haya pedido un link. La interfaz debe conservar las citas y validar los enlaces de salida, distinguiendo fuentes informativas de enlaces de pago.
9. Si hay documentos contradictorios o no se puede verificar vigencia, informar qué punto queda pendiente. Remitir solo cuando la información no es pública, requiere una decisión individual o las fuentes no permiten resolverla; explicar lo ya resuelto y el canal preciso para el punto restante.

Criterio de salida: para el calendario solicitado se entrega la fecha respaldada por su resolución y su enlace; se pide NIT, régimen u otro dato únicamente si esa fuente establece vencimientos diferentes según ese dato. Si no se encuentra una fuente válida, se explica la búsqueda fallida sin inventar fechas.

## Fase 5: evaluación y despliegue gradual

Preparar entre 40 y 60 conversaciones de evaluación con expectativas verificables, a partir del JSON anonimizado y variantes:

| Caso | Comportamiento requerido |
| --- | --- |
| Perro más grande del mundo | Rechazar por estar fuera del alcance municipal. |
| Esterilización de perros en el municipio | Buscar programa y fuente oficial; no bloquear por «perro». |
| Sanción ICA con y sin «según el estatuto» | Recuperar el tema y aclarar tipo de sanción si hace falta. |
| Calendario ICA 2026 y repreguntas | Mantener año/impuesto y consultar resolución aplicable. |
| Acuerdo de pago Predial: documentos y beneficios | Cubrir ambos componentes con requisitos confirmados. |
| Pregunta ICA después de oferta Predial | Responder ICA; no abrir formulario Predial. |
| `MAX_TOKENS`, bloqueo del proveedor y timeout | Diferenciar motivos y entregar una salida completa y fiel. |
| Documento antiguo, fuente contradictoria o sin resultados | No presentar información dudosa como vigente. |
| Página/PDF con instrucciones maliciosas | Usar solo evidencia pertinente; ignorar instrucciones. |
| Cuota agotada y respuesta local | Señalar el motivo al operador; no simular búsqueda ni actualización. |

Combinar pruebas deterministas del enrutamiento y contrato del proveedor con evaluación de respuestas reales. Repetir los casos críticos para medir variabilidad; comprobar evidencia y cobertura, no solo coincidencias de texto.

Registrar versión desplegada, decisión de alcance, tema/año, fuentes recuperadas, búsqueda realizada, cobertura, `finishReason`, reintentos, fallback, latencia y consumo. Evitar PII en logs. Medir remisiones innecesarias respecto a casos resolubles y no reducirlas a costa de inventar información.

Metas iniciales para el conjunto de aceptación: ninguna respuesta incompleta publicada, ningún formulario activado por una pregunta, todos los datos normativos concretos respaldados por fuente aplicable y al menos 90% de consultas públicas cubiertas por el conjunto de fuentes resueltas sin remisión innecesaria. Son objetivos a comprobar, no resultados ya obtenidos.

Desplegar en QA con funciones activables por configuración; comparar contra la misma batería y habilitar gradualmente. Mantener reversión a la revisión anterior si aparecen regresiones de alcance, enrutamiento o evidencia.

## Orden recomendado

1. Confirmar la revisión desplegada y fijar la batería base.
2. Corregir respuestas incompletas y confirmaciones de trámites.
3. Separar políticas y mejorar recuperación y contexto.
4. Incorporar calendario y requisitos oficiales; habilitar consulta web controlada.
5. Medir calidad, coste y latencia en QA antes del despliegue gradual.

No decidir un cambio de modelo hasta medir el comportamiento con evidencia, herramientas y contexto correctos. Si aun así falla, comparar modelos con las mismas preguntas, fuentes y presupuestos.

## Referencias técnicas consultadas

- [Google: motivos de finalización de generación](https://ai.google.dev/api/generate-content#FinishReason).
- [Google: fundamentación con Google Search](https://ai.google.dev/gemini-api/docs/google-search).
- [Google: lectura mediante URL context](https://ai.google.dev/gemini-api/docs/url-context).

Este documento es un plan de implementación. No modifica ni despliega el chatbot.
