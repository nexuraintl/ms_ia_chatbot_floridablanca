# Respuestas completas y consulta de fuentes oficiales

Implementación desde `azure/qa` (`079b1c3`), sin modificar el checkout anterior de `master`.

## Comportamiento

- Las respuestas siguen siendo breves. El margen técnico es de 768 tokens; no obliga a generar respuestas largas. Un corte, bloqueo, lista incompleta o respuesta que omite documentos/beneficios no se publica como una respuesta normal.
- Se permite una sola reformulación, de hasta 120 palabras, con las mismas fuentes. Si vuelve a fallar, se entrega una salida cerrada que reconoce que no hay un resultado confirmado. La validación es conservadora: no es una demostración automática de veracidad o de cobertura de cualquier pregunta imaginable.
- Toda llamada exitosa a Gemini se contabiliza, incluyendo descubrimiento de fuentes y borradores descartados. La cuota por sesión cuenta llamadas al proveedor; una consulta puede utilizar hasta tres: búsqueda, respuesta y reformulación. El presupuesto de tokens usa `usageMetadata` acumulado.
- El «si» condicional no confirma Predial. Las confirmaciones de acciones son expresiones completas; no se utiliza coincidencia difusa. Una pregunta que no renueva una oferta cancela el trámite pendiente.
- ICA/Industria y Comercio son equivalentes para recuperación. Se conserva un resumen de impuesto, aspecto y año, aun cuando se recorta el historial. El backend valida sus valores y los trata como datos, no como instrucciones. No existe memoria compartida entre ciudadanos.
- Una consulta de sanción ICA sin tipo pide aclarar si es extemporaneidad, no declarar o inexactitud. No se supone que siempre corresponde al artículo 519.
- Las reglas se construyen en servidor incluso sin corpus. El navegador no puede activar herramientas ni reemplazar las instrucciones. El contenido web y PDF se envía en bloques de datos delimitados.

## Consulta de fuentes

Se usa primero el corpus existente. Cuando faltan fragmentos, la cobertura es baja o la consulta requiere calendario/requisitos de acuerdo de pago, se activa el repositorio de fuentes.

El repositorio consulta el buscador público observado en el portal, lee documentos relevantes y puede buscar URLs mediante `google_search` de Gemini si no encuentra evidencia suficiente. Lee únicamente hosts autorizados. La URL de incrustación del widget no determina los dominios oficiales.

Las consultas externas se construyen con vocabulario público: municipio, impuesto, año y tema. No se envían nombres, documentos, correos ni historial al buscador. La generación principal conserva el contrato de conversación existente.

El lector exige HTTPS, rechaza credenciales, puertos alternativos, direcciones IP y redes privadas. Fija la dirección DNS a la conexión y vuelve a validar cada redirección. Limita bytes, tiempo, lecturas, resultados y caché. Los redirects de citas de Google solo se resuelven con el mismo lector y deben terminar en un dominio autorizado.

HTML se interpreta como datos sin ejecutar scripts. Se conservan filas de tablas y enlaces a PDFs. Los PDFs se procesan en un worker con límites de memoria, páginas y tiempo. Un PDF escaneado sin texto se identifica como `pdf_requires_ocr`; no se interpreta como evidencia textual. Los documentos normativos escaneados requieren el procedimiento OCR y revisión existente en `tools/knowledge/` antes de usarse como conocimiento confirmado.

Cada fuente conserva URL resuelta, título, emisor, fecha de lectura y fecha de publicación cuando existe en los metadatos. Una lectura reciente no prueba vigencia. Se excluyen documentos claramente de otro año cuando se consulta un calendario; las reglas exigen comprobar también impuesto, periodo y modificaciones en el contenido. Las fuentes DIAN se reservan para consultas de UVT y no sustituyen el calendario municipal.

Se permiten fechas cuando existe una resolución oficial aplicable; sin esa evidencia se bloquean fechas concretas de calendario. Se conservan las citas en Markdown y en `sources`. Una URL generada que no pertenece a las fuentes recuperadas o al catálogo autorizado provoca reformulación; no se publica a ciegas.

No se precargaron fechas de calendario ni requisitos de acuerdo de pago sin una fuente verificada. Las resoluciones concretas pueden añadirse al catálogo de runtime con `AI_SOURCE_URLS`. La accesibilidad y vigencia del contenido publicado por la entidad siguen siendo necesarias para resolver esas consultas.

## Configuración de runtime

| Variable | Valor por defecto / función |
| --- | --- |
| `AI_WEB_ENABLED` | `true`; `false` desactiva las lecturas y búsquedas adicionales. |
| `AI_SEARCH_ENABLED` | `true`; `false` desactiva Google y mantiene lectura del catálogo y buscador del portal. |
| `AI_SOURCE_HOSTS` | Lista de hosts oficiales autorizados. Un prefijo `.` admite subdominios del dominio exacto. |
| `AI_SOURCE_URLS` | URLs públicas del catálogo separadas por coma. Se validan contra los hosts autorizados. |
| `AI_PORTAL_SEARCH_URL` | Buscador del portal; parámetro público `q`. Debe ser una URL verificada. |
| `AI_RESPONSE_TIMEOUT_MS` | Hasta 55 segundos para el proceso completo. El cliente espera hasta 60 segundos. |
| `AI_REQUEST_TIMEOUT_MS` | Hasta 30 segundos por llamada al proveedor; también rige el plazo total. |

Para una prueba gradual en QA: comenzar con URLs verificadas de calendario y trámites; activar lecturas manteniendo Google apagado; después activar búsqueda y comparar las mismas conversaciones. Para revertir la consulta web, establecer `AI_WEB_ENABLED=false`. Las correcciones de corte y confirmación siguen funcionando.

La clave `GEMINI_API_KEY` sigue siendo solo de servidor. La ruta directa con clave local es de desarrollo: aplica reglas y reformulación, pero la consulta protegida de fuentes corresponde al proxy.

El catálogo local comprueba que la respuesta cubra el aspecto solicitado: una coincidencia con ICA no permite sustituir una sanción o un documento por la definición del impuesto. La aclaración del tipo de sanción también funciona sin IA. El lector distingue banners de portada y catálogos documentales de resoluciones leídas; un catálogo permite entregar su enlace y sección, pero no afirmar fechas ni vigencia anual. Si solo se pudo leer el catálogo, una petición de documento recibe ese enlace y la limitación concreta de la descarga, sin una remisión genérica.

## Diagnóstico y verificación

La respuesta del proxy incluye `diagnostics`: tema/año, fragmentos recuperados, estado de fuentes, búsqueda, motivo de finalización, intentos, reformulación y fallback. El evento `ai_reply_served` registra esos campos y consumo sin el texto del ciudadano. Las métricas de sesión exponen reformulaciones, búsquedas, citas y último diagnóstico. Los códigos de error distinguen respuestas HTTP, tiempos de espera y PDFs que requieren OCR.

Ejecutar:

```text
npm test
npm run lint
npm run build
```

`test:quality` incluye 48 consultas de alcance y pruebas de la conversación reportada, memoria, recuperación, cortes, fallbacks, citas, coste, HTML, PDF y protección de red. Las pruebas de Gemini usan respuestas simuladas. El lector se comprobó adicionalmente contra el portal público real.

Las pruebas locales no equivalen a validar respuestas reales del modelo ni a comprobar jurídicamente la vigencia de las resoluciones. La evaluación del proveedor real requiere una clave válida; el entorno local revisado no la tiene. Antes de desplegar, repetir las consultas con el modelo configurado y fuentes oficiales vigentes, y medir resolución sin remisión, coste y latencia.
