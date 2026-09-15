# Informe de seguridad — Chatbot Alcaldía de Floridablanca

Auditoría y endurecimiento realizados el **11 de agosto de 2026**.

Las pruebas son ejecutables y reproducibles:

```bash
npm run test:security
```

Estado actual: **159 de 160 verificaciones en verde**. La única que sigue en rojo
comprueba que la clave no sea visible en el navegador, y solo lo es en el **modo de
desarrollo** —sin proxy configurado—; con el proxy activo la clave no llega al cliente.
Ver H-01.

---

## Resumen por severidad

| ID | Severidad | Hallazgo | Estado |
|----|-----------|----------|--------|
| H-01 | **Crítico** | Clave de Gemini expuesta en el navegador | Cerrado: en un build de producción el widget usa siempre el proxy del backend |
| H-02 | **Alto** | Inyección de prompt vía DOM de la página anfitriona | Corregido (defensa en 5 capas) |
| H-03 | **Alto** | Sin lista blanca de destinos: phishing con apariencia oficial | Corregido |
| H-04 | **Alto** | Datos personales persistidos en claro en `token_usage.log` | Corregido |
| H-05 | **Medio** | `localhost:8000` en builds de producción y contenido mixto | Corregido (validación ruidosa) |
| H-06 | **Medio** | Endpoint `/api/log-tokens` sin validar origen ni limitar tasa | Corregido |
| H-07 | **Medio** | Código de autenticación de PQRSD visible en claro en logs | Corregido |
| H-08 | **Medio** | Adjuntos de PQRSD sin validación de tipo, tamaño ni cantidad | Corregido |
| H-09 | **Medio** | Datos de contacto inventados enviados al sistema oficial | Corregido |
| H-10 | **Bajo** | Mensajes de error internos mostrados al ciudadano | Corregido |
| H-11 | **Bajo** | Peticiones sin timeout; streams SSE sin cerrar | Corregido |

---

## H-01 · Clave de Gemini expuesta en el navegador (crítico)

**Qué pasaba.** `ChatContext` leía la clave de `import.meta.env.VITE_GEMINI_API_KEY`.
Vite sustituye toda variable `VITE_*` por su valor **literal** al compilar, así que la
credencial quedaba incrustada en `dist/assets/*.js` — un archivo estático que cualquiera
puede descargar. Además viajaba en la query string (`?key=...`), quedando registrada en
historiales, logs de proxy corporativo y cabeceras `Referer`.

Verificado empíricamente compilando con una clave de prueba: aparecía en claro dentro
del bundle.

**Qué se corrigió.**

1. La aplicación ya **no lee** `VITE_GEMINI_API_KEY`. La clave solo entra por el panel
   de control y queda en el navegador de quien la escribe.
2. Viaja en la cabecera `x-goog-api-key`, no en la URL.
3. Se verificó recompilando con la variable definida: ya no aparece en `dist/`.

**Trampa encontrada durante el arreglo.** Un helper aparentemente inocente —
`const readEnv = (name) => import.meta.env?.[name]` — reintroducía la fuga completa.
Vite solo puede sustituir accesos **estáticos**; ante un acceso con clave computada
incrusta el objeto de entorno **entero**, incluidas todas las variables. Al añadir
variables nuevas, leerlas siempre como `import.meta.env.VITE_NOMBRE_LITERAL`.

**Cierre definitivo: el proxy del backend, ya implementado.**

`server/aiProxy.js` expone `POST /api/ai/chat` en el mismo servicio de Cloud Run que sirve
el widget. La clave se monta desde Secret Manager como variable de **runtime**
(`GEMINI_API_KEY`), nunca como `VITE_*`, así que no entra en el bundle porque no existe
durante el build.

Para activarlo basta definir `VITE_AI_PROXY_URL` —vacío significa "mismo origen"— y el
secreto en el despliegue: `selectProviderId` elige entonces el adaptador `ai-proxy` y la
clave no vuelve a pasar por el navegador. El proxy tiene prioridad sobre cualquier clave
local, de modo que una credencial olvidada en el `localStorage` de un operador no puede
saltarse el control.

El proxy añade tres controles de gasto que **no eran posibles desde el cliente**, porque
requieren ver la IP y no fiarse de lo que diga el navegador:

| Control | Variable | Frena |
|---|---|---|
| Coste acotado por petición | (fijo en el código) | Un cliente modificado pidiendo respuestas caras |
| Ráfagas por IP | `AI_RATE_LIMIT_PER_MINUTE` | Bots y bucles de reintento |
| Cuota diaria por sesión | `AI_DAILY_QUOTA_PER_SESSION` | Consumo desproporcionado de un usuario |
| Techo diario de tokens | `AI_DAILY_TOKEN_CEILING` | Gasto total del servicio |

Detalle que decide si el límite por IP es real: detrás del balanceador de GCP la IP fiable
de `X-Forwarded-For` es la **penúltima** (`TRUSTED_PROXY_HOPS=2`). Tomar la primera —el
error habitual— deja el limitador en un adorno, porque el cliente escribe esa parte de la
cabecera. Ver `server/clientIdentity.js`.

**Modo de desarrollo (residual conocido).** Sin `VITE_AI_PROXY_URL`, el widget sigue
llamando a Gemini directamente con la clave que el operador escribe en el panel, y esa
clave es legible para quien use ese equipo. Es el modo pensado para desarrollo local y no
debería desplegarse. Si se usa así, siguen aplicando las acciones fuera del código:

- Restringir la clave por referente HTTP a los dominios de la Alcaldía.
- Restringirla a la API *Generative Language* únicamente.
- Fijar una cuota diaria baja, para acotar el gasto si se filtra.
- **Rotarla** si alguna vez se desplegó un build que la contenía.

---

## H-02 · Inyección de prompt vía DOM de la página anfitriona (alto)

**Qué pasaba.** `getPageContext()` leía `document.title`, el `<meta description>`, todos
los `<h1,h2,h3>` y los enlaces del portal, y lo concatenaba **dentro de
`systemInstruction`** — la sección de máxima autoridad para el modelo. Cualquier texto
que llegara al DOM de la página anfitriona se convertía en instrucción del sistema.

El vector no requiere XSS almacenado. Basta una página de resultados que refleje el
parámetro `?q=` dentro de un `<h2>`: se envía a la víctima
`https://portal.gov.co/buscar/?q=<payload>` y el widget embebido en esa página lee el
encabezado inyectado como si fuera una orden.

**Defensa aplicada, en cinco capas.** La inyección de prompt no tiene hoy una solución
completa, así que la estrategia es acumular barreras y —sobre todo— cerrar la salida:

1. **Separación de canal.** El contenido scrapeado sale de `systemInstruction` y viaja
   como turno de rol `user`, que el modelo trata con menos autoridad.
2. **Delimitación explícita** con marcadores inequívocos y un preámbulo que declara el
   bloque como no verificado.
3. **Saneamiento estructural**: se neutralizan corchetes de sección, vallas de bloque y
   etiquetas de rol (`system:`).
4. **Topes de longitud** en título, descripción, encabezados y enlaces, para que un
   anfitrión hostil no pueda empujar las instrucciones reales fuera de la ventana.
5. **Control de salida** (el decisivo): ver H-03.

**Sexta capa, añadida con la base de conocimiento.** Las cuatro primeras capas sacaban el
contenido del DOM de `systemInstruction`, pero la instrucción de sistema **la seguía
armando el navegador**: el proxy recibía el campo y lo reenviaba recortado a 8.000
caracteres. Un cliente modificado podía hacer `POST /api/ai/chat` con las reglas de
comportamiento y el bloque de «información oficial de la Alcaldía» que quisiera.

Ahora, cuando hay corpus cargado, `server/aiProxy.js` **descarta la instrucción del cliente
y arma la suya**: reglas base, reglas de fundamentación y los fragmentos del Estatuto que
recupera el servidor. El `systemInstruction` que llegue en el cuerpo pasa a ser un dato
ignorado. La consulta con la que se recupera se toma del último mensaje del ciudadano y
**se salta explícitamente el turno de datos de la página**, para que el DOM del portal
anfitrión no pueda elegir qué artículos del Estatuto se le entregan al modelo.

Verificado en `tests/run-knowledge-tests.mjs`, sección 6.

---

## H-03 · Sin lista blanca de destinos (alto)

**Qué pasaba.** `sanitizeUrl` validaba el **esquema** pero no el **destino**. Bloqueaba
`javascript:` correctamente, pero aprobaba cualquier `https://`. Combinado con H-02, un
atacante podía hacer que un chat institucional mostrara
`[Pagar aquí](https://pagos-floridablanca.tk/pse)` como enlace en negrita con
`target="_blank"`.

**Qué se corrigió.** `domain/security/urlPolicy.js` distingue dos niveles de confianza
según **quién propuso la URL**, no según su forma:

- `forModelOutput()` — enlaces dentro del texto generado por la IA. Aplica lista blanca
  de host (`chatbotConfig.json > security.allowedLinkHosts`, más el dominio de la página
  anfitriona). Un destino fuera de la lista **no** se convierte en `<a href>`: se
  muestra como texto con un aviso visible.
- `forBackendResource()` — enlaces devueltos por los RPA propios (factura PDF, pasarela
  PSE). Exige esquema seguro pero no filtra por dominio, porque bloquearlos rompería
  pagos legítimos. Avisa por consola si el host es inesperado.

Las entradas de la lista que empiezan por punto son comodines de sufijo: `.gov.co`
acepta `floridablanca.gov.co` pero **no** `floridablanca.gov.co.dominio-falso.com`.

---

## H-04 · Datos personales en claro en el log (alto — Ley 1581 de 2012)

**Qué pasaba.** `logTokenUsage` enviaba el mensaje del ciudadano sin modificar a
`/api/log-tokens`, y el plugin de Vite lo escribía tal cual en `token_usage.log`. Un
mensaje como *"mi cédula es 1098765432 y mi celular 3101234567"* quedaba persistido en
disco sin enmascarar.

Lo llamativo: las funciones `maskEmail`, `maskPhone` y `maskIdentification` **ya
existían** en el proyecto, pero solo se aplicaban al render visual de la consola — a lo
que se ve, no a lo que se guarda.

**Qué se corrigió.** `domain/security/piiRedactor.js` centraliza la redacción y se
aplica en el **borde de salida**, antes de que el dato abandone el navegador.
Verificado end-to-end: el archivo en disco ahora contiene
`310****567` y `a*****z@hotmail.com`.

---

## H-05 a H-11 · Resto de hallazgos

- **H-05.** Cada servicio hacía `import.meta.env.VITE_X || "http://localhost:8000"`. Sin
  la variable definida al compilar, el bundle de producción apuntaba a la máquina del
  propio ciudadano y los trámites fallaban en silencio. `config/environment.js` ahora
  valida y avisa con `console.error` en producción, y detecta contenido mixto
  (`http://` desde una página `https://`).
- **H-06.** El endpoint `/api/log-tokens` no comprobaba nada sobre el origen, y el
  servidor tenía `cors: true`. Cualquier web abierta mientras corría `npm run dev` podía
  escribir líneas arbitrarias en el log del desarrollador, sin límite, hasta llenar el
  disco. Se añadió validación de `Origin`, limitador de tasa por IP, rotación a los 5 MB
  y escritura asíncrona. El `cors: true` se restringió a orígenes locales.
- **H-07.** El código de autenticación de PQRSD es alfanumérico, así que ningún patrón
  numérico lo alcanzaba y aparecía en claro en la terminal. Se añadió `maskAuthCode`.
- **H-08.** Los adjuntos se aceptaban sin ninguna comprobación. Ahora se validan tipo,
  extensión, tamaño por archivo, tamaño total y cantidad, antes de subir.
- **H-09.** `handleSelectPredio` enviaba `phone: contextData.phone || "3000000000"` y
  `email: … || "correo@ejemplo.com"`. Es decir, si el contexto se perdía se registraban
  datos falsos en un sistema de notificación oficial y el ciudadano nunca recibía su
  factura. Ahora el flujo se detiene y lo explica.
- **H-10.** Los `catch` mostraban `error.message` crudo al ciudadano, exponiendo rutas y
  trazas internas. `domain/errors/rpaErrorTranslator.js` traduce los casos de negocio
  conocidos y sustituye todo lo demás por un texto genérico; el detalle solo va a consola.
- **H-11.** Ninguna petición tenía timeout (un cuelgue dejaba el chat en "escribiendo…"
  para siempre) y el cierre de los streams SSE se descartaba, dejando conexiones
  abiertas. Corregido en `adapters/http/httpClient.js` y `hooks/usePredialFlow.js`.

---

## Defectos funcionales encontrados de paso

No son de seguridad, pero eran fallos reales. Los detectó la propia suite de pruebas.

1. **Cinco ramas de código inalcanzables.** Tres en el proveedor mock, por deriva de
   contrato: `getPageContext()` emitía un string formateado que `queryMockGemini()`
   volvía a parsear con regex, y las etiquetas de ambos lados dejaron de coincidir
   (`[SECCIONES Y ENLACES…]` vs `[ENLACES RELEVANTES…]`, `- Título:` vs
   `- Título de la página:`). Dos más en `submitChatForm`: los tipos `predial` y `rpa`
   nunca podían activarse porque el único formulario que se creaba era `sisben`.
2. **La rama "¿dónde estoy?" era inalcanzable dos veces.** Además del desajuste de
   etiquetas, se evaluaba después de la petición de enlaces — y `"donde estoy"` contiene
   `"donde"`, que estaba en la lista de palabras de enlace.
3. **Falso positivo en la clasificación de FAQ.** La palabra clave `"ica"` se buscaba con
   `includes()` sobre todo el texto, así que casaba dentro de `"indica"` y `"aplica"`:
   *"me indica cómo aplicar"* se clasificaba como Impuesto ICA.
4. **`savedTokens` podía ser negativo.** Se calculaba como `150 - completionTokens` y se
   sumaba al acumulado, de modo que una respuesta larga **restaba** del "ahorro total".
5. **Identificadores de mensaje con riesgo de colisión.**
   `Math.random().toString(36).substr(2, 9)` — y los ids se usan como `key` de React.
6. **Fuga de temporizador.** El `setTimeout` del mensaje de seguimiento no se limpiaba al
   desmontar el widget.

La causa raíz común de (1) y (2) es la misma: dos módulos comunicándose mediante un
string formateado que cada lado interpretaba con expresiones regulares. El refactor lo
sustituye por un objeto estructurado, lo que elimina toda esa clase de fallo.

---

## Qué queda pendiente

1. **Crear el secreto `gemini-api-key` en Secret Manager** y dar
   `roles/secretmanager.secretAccessor` a la service account de ejecución, para activar el
   proxy (H-01). Mientras no exista, el proxy responde `ai_unavailable` y el widget atiende
   con el banco de preguntas frecuentes: no se cae, pero tampoco hay IA.
2. **Rotar la clave de Gemini** si algún build publicado la contenía, y restringirla en
   Google Cloud Console (H-01).
3. **Confirmar `_ALLOWED_ORIGINS` y `_TRUSTED_PROXY_HOPS`** en `cloudbuild.yaml` con los
   dominios reales de los portales y con la topología real del balanceador. Un
   `TRUSTED_PROXY_HOPS` incorrecto no produce ningún error visible: el límite por IP
   simplemente deja de aplicarse. El log de arranque `ai_proxy_configured` deja constancia
   del valor en uso.
4. **Rellenar `security.allowedLinkHosts`** en `src/config/chatbotConfig.json` con los
   dominios reales de la Alcaldía. Los valores actuales son una base razonable, no una
   lista verificada.
5. **Conceder `roles/run.invoker` a la service account del chatbot sobre los dos RPA**, y
   definir `RPA_FACTURA_URL` y `RPA_PQRSD_URL` como variables de RUNTIME con la URL exacta y
   sin barra final. Los dos servicios exigen un identity token de Google, así que el
   navegador ya no los llama: lo hace el backend a través de `/rpa/factura` y `/rpa/pqrsd`.
   Sin el rol, el token es válido y la respuesta es 403; con la barra final sobrante, 401.
   La sonda de arranque (`RPA_STARTUP_PROBE=strict`) detecta las dos cosas antes de que un
   ciudadano pida su factura. Ver `docs/INTEGRACION_RPA.md`.
6. **Añadir una Content-Security-Policy.** `index.html` no tiene ninguna, y el widget se
   embebe en portales de terceros. Requiere decidirla con quien opere el portal, por eso
   no se incluyó aquí.
7. **Revisar `services/apiMock.js`**: contiene datos de ciudadanos ficticios y carga
   imágenes desde `images.unsplash.com`. En un portal de gobierno eso filtra la IP del
   visitante a un tercero y rompe si no hay internet.
8. **Valorar un almacén compartido para la cuota diaria y para el control de admisión.**
   Los contadores viven en la memoria de cada instancia. El despliegue quedó en
   `max-instances=1` justamente por eso —el techo de 2 trámites simultáneos del RPA de
   factura solo es real con una instancia—, así que hoy los topes se cumplen; el día que haya
   que escalar, el tope efectivo se multiplica por el número de instancias y un escalado a
   cero los borra. `server/rateLimit.js` y `server/rpaAdmission.js` dejan el almacén detrás
   de una interfaz mínima para poder cambiarlo sin tocar la lógica.
