# Integración con los microservicios RPA

Cómo el chatbot consume `ms_rpa_factura` y `ms_rpa_pqrsd` después de su migración a
GOB-GCP-STD-01: rutas nuevas y autenticación IAM obligatoria.

---

## 1. El cambio de fondo: el navegador ya no puede llamar a los RPA

Los dos servicios exigen un **identity token de Google (OIDC)**. Acuñarlo desde el
navegador requeriría una llave de service account en el cliente, es decir publicarla. Así
que el widget dejó de hablar con los RPA y habla con el backend de este mismo chatbot, que
pone el token.

```
Navegador del ciudadano
  └─ Portal municipal
       └─ <script> widget
            │
            ├──▶ POST /api/ai/chat            proxy de Gemini (clave en el servidor)
            ├──▶ GET  /rpa/factura/v1/...     proxy del RPA de factura
            └──▶ GET  /rpa/pqrsd/v1/...       proxy del RPA de PQRSD
                        │
                        ▼
              Cloud Run del chatbot  ──── Authorization: Bearer <identity token>
                        │                 (uno por servicio; lo acuña el metadata server)
                        ├──▶ ms_rpa_factura
                        └──▶ ms_rpa_pqrsd
```

Consecuencias que conviene tener presentes:

- `VITE_RPA_PREDIAL_API_URL` y `VITE_RPA_PQRSD_API_URL` **ya no se leen**. Si siguen
  definidas, el widget avisa por consola y las ignora.
- Las URLs de los RPA son ahora variables de **runtime** del contenedor
  (`RPA_FACTURA_URL`, `RPA_PQRSD_URL`), no de compilación. Como `VITE_*` no servirían de
  nada y además quedarían congeladas en la imagen — y renombrar `qa-rpa-pqrsd` a
  `qam-rpa-pqrsd` ya cambió una vez el hash del host.
- El PDF de la factura también está detrás de IAM. El backend lo descarga y lo reenvía; al
  ciudadano nunca se le entrega una URL que su navegador no podría abrir.

---

## 2. El audience es la URL del servicio, así que hay dos tokens

El `audience` de un identity token es la URL exacta del servicio destino. Son dos servicios
con dos URLs: **dos tokens**. Una caché única compartida funciona contra el primer servicio
y devuelve **401 en el segundo**, y ese 401 no menciona el audience, así que parece un
problema de permisos cuando es de formato.

`server/googleIdentity.js` cachea **por audience** y renueva 5 minutos antes de expirar.

Reglas que el código hace cumplir:

| Regla | Dónde se aplica |
|---|---|
| Nunca un token literal en el código ni en el entorno | No existe ninguna variable que lo acepte |
| Nunca una llave JSON de service account | El token lo acuña el servidor de metadatos |
| El audience es la URL exacta, **sin barra final** | `assertValidAudience()` lanza antes de salir a la red |
| Cada servicio con su token | La caché va indexada por audience |
| La URL viene del entorno | `resolveTargets()` no tiene ningún valor por omisión |

La barra final está cubierta por una prueba, porque es la trampa que más cuesta
diagnosticar: `tests/run-rpa-tests.mjs`, sección 1.

---

## 3. El mecanismo es una decisión por ambiente

`RPA_AUTH_MODE` elige cómo se obtiene el token. No hay ningún `if` de mecanismo sembrado
por el resto del código.

| Modo | Cuándo | Qué hace |
|---|---|---|
| `metadata` | Cloud Run directo (QAM), o gateway con `x-google-issuer: https://accounts.google.com` | Pide el token al servidor de metadatos. Equivale a `fetch_id_token(request, audience)` |
| `gcloud` | Solo desarrollo local contra los servicios reales | Acuña con la credencial del desarrollador, sin llaves y sin tokens en el entorno |
| `none` | Servicios locales sin IAM | No envía cabecera |
| `signed_jwt` | Gateway cuyo `x-google-issuer` es el email de la SA del cliente | **No implementado**: falla con instrucciones |

### El camino por gateway es OTRO mecanismo

En QAM los dos Cloud Run son alcanzables directo. En PREM y PROD el ingress es
`internal-and-cloud-load-balancing`: el Cloud Run **no** es alcanzable y hay que entrar por
API Gateway. Y ahí el esquema depende de cómo esté configurado el gateway:

| `x-google-issuer` del gateway | Qué usa el cliente | Estado en este repositorio |
|---|---|---|
| `https://accounts.google.com` | El mismo identity token, con audience = host del gateway | Soportado: `RPA_AUTH_MODE=metadata` + `RPA_GATEWAY_URL` |
| El email de la SA del cliente | JWT auto-firmado vía IAM Credentials `signJwt` | **Sin implementar** — `RPA_AUTH_MODE=signed_jwt` falla y explica por qué |

El segundo caso necesita la API de IAM Credentials y el rol
`roles/iam.serviceAccountTokenCreator` de la SA sobre sí misma. No se implementó a ciegas a
propósito: **hay que preguntarle a plataforma cuál de las dos configuraciones tiene el
gateway** antes de escribir ese código.

Con `RPA_GATEWAY_URL` definida, la ruta hacia arriba lleva el prefijo del servicio
(`/rpa/factura/...`, `/rpa/pqrsd/...`) y el audience pasa a ser el host del gateway.

---

## 4. Permisos

La service account con la que corre el chatbot necesita **`roles/run.invoker` sobre los dos
servicios**. Sin ese rol el token es válido y la respuesta es **403**.

```bash
gcloud run services add-iam-policy-binding qam-rpa-factura --region=us-central1 --project=pre-qa-functions --member="serviceAccount:SA-DEL-CHATBOT@pre-qa-functions.iam.gserviceaccount.com" --role="roles/run.invoker"
```

```bash
gcloud run services add-iam-policy-binding qam-rpa-pqrsd --region=us-central1 --project=pre-qa-functions --member="serviceAccount:SA-DEL-CHATBOT@pre-qa-functions.iam.gserviceaccount.com" --role="roles/run.invoker"
```

---

## 5. Falla al arrancar, no en el primer trámite

Un chatbot que arranca "bien" y falla recién cuando un ciudadano pide su factura es mucho
más caro de diagnosticar. En el arranque se sondea `/health` de los dos servicios **con
token**, y el resultado se distingue en dos clases:

| Clase | Qué la provoca | Qué pasa |
|---|---|---|
| Configuración | Variable ausente, URL inválida, 401, 403, 404 | **El contenedor no arranca.** No se arregla esperando |
| Disponibilidad | Timeout, 502, 5xx del portal | Log `CRITICAL` y el chatbot sigue en pie atendiendo con el banco de preguntas |

`RPA_STARTUP_PROBE` controla la política: `strict` (por omisión en cualquier ambiente
desplegado), `warn` o `off` (por omisión en `local`, donde lo normal es no tener los RPA
levantados).

`GET /health` sigue devolviendo `{"status": "UP"}` aunque un RPA esté caído —es la sonda con
la que Cloud Run decide si mata la instancia, y matarla no arregla el RPA— y añade el
detalle en `dependencies`.

---

## 6. Las rutas cambiaron

| Antes | Ahora | A través del proxy |
|---|---|---|
| `/api/generar_factura` | `/v1/generar_factura` | `/rpa/factura/v1/generar_factura` |
| `/api/seleccionar_predio` | `/v1/seleccionar_predio` | `/rpa/factura/v1/seleccionar_predio` |
| `/api/clientes` | `/v1/clientes` | `/rpa/factura/v1/clientes` |
| `/api/prewarm` | `/v1/prewarm` | `/rpa/factura/v1/prewarm` |
| `/api/jobs/{id}` y `/stream` | `/v1/jobs/{id}` y `/stream` | `/rpa/factura/v1/jobs/{id}` |
| `/facturas/{filename}` | `/v1/facturas/{filename}` | `/rpa/factura/v1/facturas/{filename}` |
| `/api/imprimir_factura` | **eliminado** | Fuera de la lista blanca |
| `/api/v1/pqrsd/...` | `/v1/pqrsd/...` | `/rpa/pqrsd/v1/pqrsd/...` |

El prefijo del proxy coincide a propósito con el del gateway. Así los campos `poll` y
`stream` que devuelve el servicio de factura sirven tal cual, vengan del Cloud Run directo o
de detrás del gateway.

### No se arman a mano las URLs de seguimiento

Las respuestas de `?mode=fast|async` traen `poll` y `stream` ya construidas y con el prefijo
correcto del ambiente. Concatenarlas a partir de `/v1/jobs/...` funciona contra el Cloud Run
directo y **se rompe detrás del gateway**. `resolveTrackingUrl()` las reasienta sobre el
proxy sin reconstruirlas, y rechaza cualquier ruta que no tenga la forma esperada.

### El proxy es una lista blanca, no un túnel

Solo pasan las rutas y los métodos que el chatbot necesita. Fuera quedan
`/v1/imprimir_factura` (eliminado, y disparaba una impresión física), `/openapi.json` y
`/docs`. La query también se filtra: solo `mode`, `cliente`, `client_id` y `q`. Cualquier
otro parámetro se descarta con un log, porque las URLs se registran en todos los saltos
intermedios y ahí no puede acabar un documento ni un teléfono.

---

## 7. Restricciones por vivir en Cloud Run

| Restricción | Cómo se resuelve aquí |
|---|---|
| Cloud Run corta la petición a los 300s | El trámite se lanza con `?mode=async` y se sigue por SSE. La petición del ciudadano no se sostiene esperando |
| El stream del RPA se cierra a los 300s | `--timeout=310s` en el despliegue, para que el evento `stream_timeout` llegue antes del corte de la plataforma. Al recibirlo, el widget pasa a consultar por `poll` |
| Estado de conversación entre instancias | Vive en el navegador (`session_id`, `job_id`). El proxy es sin estado, así que escalar no rompe un trámite en curso |
| CPU throttling | No aplica: el seguimiento ocurre dentro de una petición (el stream la mantiene abierta), no en una tarea de fondo. Si se añade una, hará falta `--no-cpu-throttling` |
| Techo de 2 trámites simultáneos en el RPA de factura | Control de admisión en el proxy: el tercero recibe 429 con `reason: rpa_queue_full` y una espera, en lugar de sumarse a la cola invisible del RPA |

### El límite del control de admisión

El contador vive en la memoria del proceso, así que **solo es un techo real con
`--max-instances=1`**, que es como está configurado el despliegue. Con varias instancias
cada una cuenta lo suyo y el techo efectivo se multiplica.

La versión distribuida necesita Firestore o Redis. `server/rpaAdmission.js` está aislado
para poder sustituirlo sin tocar el proxy.

---

## 8. Reglas que no se negocian

Estos servicios no son un sandbox: cada llamada exitosa produce un efecto real e
irreversible ante la alcaldía.

1. **`/v1/pqrsd/crear` genera un trámite oficial** que alguien tendrá que atender y que no
   se puede anular. Ante un 502 **no se reintenta**: el radicado pudo quedar creado y un
   reenvío lo duplicaría. La ruta está marcada `noRetry` en el proxy y el mensaje al
   ciudadano le dice que verifique antes de reenviar.
2. **`/v1/generar_factura` puede reservar una transacción PSE real**, y eso bloquea ese
   predio ~1 hora. Ninguna prueba automatizada toca el despliegue.
3. **Un solo reintento como máximo**, y solo para los fallos que `API_GUIDE_RPA_PREDIAL.md`
   §8 marca como reintentables. `classifyRetry()` es la única fuente de esa decisión, y el
   flujo consume el reintento una vez y no vuelve a preguntar. Nunca en bucle: cada intento
   abre un navegador, gasta un captcha pagado y degrada el portal (medido: facturas
   repetidas sobre el mismo predio llevan la generación de 2.6s a 32s).
4. **El PDF se descarga en el backend y se reenvía.** `/v1/facturas/{filename}` está detrás
   de IAM.
5. **Datos personales nunca en la query string.** Teléfono y correo van en el cuerpo, y el
   proxio filtra la query por lista blanca.
6. **Las facturas se borran a los 30 minutos** y los trámites a los 15. Si hay que conservar
   el PDF, se descarga.

---

## 9. Diagnóstico

| Código | Significado | Qué hacer |
|---|---|---|
| `401` | Token inválido, expirado o `audience` equivocado | Verificar que el audience sea la URL exacta del servicio **sin barra final**, y que sea la del servicio correcto. No compartir token entre los dos |
| `403` | Falta `roles/run.invoker` | Conceder el rol a la SA del chatbot sobre ese servicio |
| `404` con `{"detail":"Not Found"}` | La ruta no existe | Respondió la aplicación: comparar el path contra `/openapi.json` |
| `404` con HTML de Google | El ingress no permite este tráfico | En PREM y PROD hay que entrar por el gateway |
| `422` | Validación de entrada | Corregir los campos; la respuesta suele traer las opciones válidas |
| `502` | El portal de la alcaldía no respondió | Reintentable **salvo en `/crear`** (regla 1) |
| `504` | La plataforma cortó por tiempo | Usar `?mode=async` |

**Si el cuerpo del 404 es JSON, se llegó a la aplicación y solo está mal el path. Si es
HTML, no se pasó del balanceador de Google.** Esa distinción es la que más tiempo ahorra, y
el proxy ya la resuelve: `rpa_route_unknown` frente a `rpa_ingress_blocked`.

### Motivos que emite el proxy

Van en el campo `reason` de la respuesta y en los logs.

| `reason` | Significado |
|---|---|
| `rpa_not_configured` | Falta `RPA_FACTURA_URL` o `RPA_PQRSD_URL` |
| `rpa_auth_unavailable` | No se pudo acuñar el token. El log dice el motivo exacto |
| `rpa_unauthenticated` / `rpa_forbidden` | 401 / 403 del servicio |
| `rpa_ingress_blocked` | 404 con HTML: no se pasó el balanceador |
| `route_unknown` / `method_not_allowed` | La ruta o el método no están en la lista blanca |
| `rate_limited` | Límite por IP |
| `rpa_queue_full` | Techo de trámites simultáneos. Trae `queuePosition` y `retryAfterSeconds` |
| `payload_too_large` | Anexos por encima del tope |
| `rpa_upstream_timeout` / `rpa_upstream_unavailable` | El servicio no respondió |

Para cruzar un trámite entre el chatbot y los dos RPA: el `X-Correlation-ID` que emite el
widget viaja hacia arriba y vuelve en la respuesta. En el stream SSE viaja por query (`cid`),
porque `EventSource` no admite cabeceras propias.

---

## 10. Verificación antes de decir que funciona

Con `RPA_AUTH_MODE=gcloud` desde una máquina con `gcloud` autenticado, o desde el propio
Cloud Run:

```bash
gcloud auth print-identity-token --audiences="https://qam-rpa-factura-58937908768.us-central1.run.app" | xargs -I{} curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer {}" "https://qam-rpa-factura-58937908768.us-central1.run.app/health"
```

Lista mínima:

1. Los dos `/health` responden **200 con token** y **403 sin token**.
2. `/v1/clientes` responde 200 y lista municipios.
3. Un audience **con barra final da 401** — probarlo a propósito, es la trampa.
4. Un trámite completo en QAM con `RPA_CAPTURE_PAYMENT_LINK` desactivado del lado del
   servicio, para no reservar una transacción PSE real.
5. `npm test` en verde. La suite de RPA (121 verificaciones) cubre el contrato con
   respuestas simuladas y **no toca los servicios desplegados**.

---

## 11. Decisiones tomadas y lo que sigue abierto

### Resuelto

| Punto | Decisión |
|---|---|
| Service account del chatbot | La de compute por omisión, `<NÚMERO-PROYECTO>-compute@developer.gserviceaccount.com`. El despliegue no pasa `--service-account`, así que ése es el principal al que hay que conceder `roles/run.invoker` (sección 4). Cuando plataforma cree una SA dedicada, basta añadir el flag |
| Orígenes del CORS | `.floridablanca.gov.co` y `pruebas-se-floridablanca.nexura.com`. El segundo va explícito porque no cae bajo el comodín del primero |
| Mecanismo del token en QAM | `RPA_AUTH_MODE=metadata` contra los Cloud Run directos, que sí son alcanzables |

### Abierto, sin bloquear nada hoy

| Punto | Estado |
|---|---|
| URLs de **PREM y PROD** | Esos servicios todavía no existen. `_RPA_FACTURA_URL` y `_RPA_PQRSD_URL` se quedan vacías para esos ambientes y no se despliega allí; cuando existan, se rellenan las dos variables y no hay que tocar código |
| ¿Directo o por **API Gateway**? | Solo importa donde el ingress no permita tráfico directo, es decir en PREM y PROD. Al no existir, no hay decisión que tomar aún |
| Configuración de `x-google-issuer` del gateway | Ídem. Si resulta ser el email de la SA del cliente, hará falta implementar el JWT auto-firmado (`signJwt`); por eso `RPA_AUTH_MODE=signed_jwt` falla con instrucciones en vez de fingir. Ver sección 3 |
| Escalar por encima de una instancia | El control de admisión dejaría de ser un techo real. Exige mover el contador a Firestore o Redis, y subir `_MAX_INSTANCES` |

---

## 12. Documentos relacionados

| Documento | Contenido |
|---|---|
| `docs/MANUAL.md` | Manual del servicio y su despliegue |
| `API_GUIDE_RPA_PREDIAL.md` | Contrato del RPA de Impuesto Predial |
| `AGENT_GUIDE_PQRSD.md` | Contrato del RPA de PQRSD |
| `SECURITY.md` | Auditoría de seguridad y hallazgos |
