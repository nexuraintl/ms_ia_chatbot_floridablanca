# Manual del servicio — Chatbot de Atención Ciudadana

**Estándar de referencia:** GOB-GCP-STD-01
**Última actualización:** 2026-08-11

> **Campos marcados como `⚠️ PENDIENTE`**: requieren datos que solo el equipo puede
> confirmar (proyectos GCP, service accounts, URLs reales). No se han rellenado con
> valores inventados a propósito — un manual con datos ficticios es peor que uno
> incompleto, porque nadie sabe cuáles son de verdad.

---

## 1. Descripción funcional

| Campo | Valor |
|---|---|
| Nombre del servicio | `ia-chatbot-floridablanca` |
| Repositorio | `ms_ia_chatbot_floridablanca` (Azure DevOps) |
| Módulo | `ia` |
| Propósito | Asistente virtual embebible en portales municipales. Resuelve consultas de trámites, radica y consulta PQRSD, y genera la factura del Impuesto Predial mediante los microservicios RPA. |
| Tipo | Frontend embebible (React + Vite) servido como contenedor en Cloud Run |
| Responsable funcional | ⚠️ PENDIENTE |
| Responsable técnico | ⚠️ PENDIENTE |

### Naturaleza del servicio

Este servicio **no es un microservicio FastAPI**, a diferencia del resto de la
plataforma. Es un widget de navegador que se incrusta en portales de terceros mediante
una etiqueta `<script>`, y el contenedor de Cloud Run solo sirve el bundle estático más
los endpoints de infraestructura.

Esa diferencia condiciona qué partes de GOB-GCP-STD-01 aplican y cuáles no. El detalle
está en la sección 9.

### Funcionalidades

- Conversación libre con IA (Google Gemini) y catálogo local de preguntas frecuentes
- Consulta y generación de factura del Impuesto Predial (vía RPA)
- Radicación y consulta de PQRSD (vía RPA)
- Consulta de Sisbén (actualmente simulada)
- Registro de conversaciones como evidencia de atención — ver `REGISTRO_Y_IDENTIDAD.md`
- Identificación del ciudadano configurable por tenant

---

## 2. Arquitectura

| Componente | Valor |
|---|---|
| Proyecto GCP (QAM) | ⚠️ PENDIENTE |
| Proyecto GCP (PREM) | ⚠️ PENDIENTE |
| Proyecto GCP (PROD) | ⚠️ PENDIENTE |
| Servicio Cloud Run | `[ambiente]-ia-chatbot-floridablanca` |
| Región | ⚠️ PENDIENTE (`cloudbuild.yaml` usa `us-central1` como valor de partida) |
| Ingress | `internal-and-cloud-load-balancing` |
| Base de datos | Ninguna propia. La base de conocimiento es un archivo del repositorio (`server/knowledge/corpus.json`, 1,3 MB) que se carga en memoria al arrancar |
| Artifact Registry | ⚠️ PENDIENTE |

### ⚠️ Requisito de balanceador de carga

El ingress `internal-and-cloud-load-balancing` que exige el estándar hace que el
servicio **no sea alcanzable directamente desde el navegador de un ciudadano**.

Como este widget se incrusta en portales públicos, **necesita un balanceador de carga
externo por delante**. Sin él, el chatbot no cargará en los portales municipales. Es la
diferencia principal frente a un microservicio de backend, que solo recibe tráfico del
API Gateway.

### Dependencias

| Servicio | Uso | Criticidad |
|---|---|---|
| RPA Impuesto Predial | Consulta de predios y generación de factura. Protegido por IAM: se consume a través del proxy de este servicio | Alta |
| RPA PQRSD | Radicación y consulta de radicados. Protegido por IAM: ídem | Alta |
| Google Gemini API | Respuesta libre conversacional | Media — degrada a catálogo local |
| Base de conocimiento del Estatuto | Fundamenta las respuestas tributarias. Se recupera en el servidor y se inyecta en la instrucción de sistema | Media — sin ella el asistente responde sin citar el articulado. Ver `docs/BASE_CONOCIMIENTO.md` |
| Backend de conversaciones | Registro de la atención | ⚠️ PENDIENTE — sin definir |

### Diagrama de flujo

```
Navegador del ciudadano
  └─ Portal municipal (tercero)
       └─ <script> widget  ──────────▶  Cloud Run (este servicio)
            │                             └─ sirve dist/ + /health + /version
            │
            ├──▶ POST /api/ai/chat        proxy de Gemini (clave en el servidor)
            ├──▶ /rpa/factura/v1/...      proxy del RPA de factura
            ├──▶ /rpa/pqrsd/v1/...        proxy del RPA de PQRSD
            └──▶ Backend conversaciones   ⚠️ PENDIENTE
                        │
                        ▼
              Este mismo Cloud Run ─── Authorization: Bearer <identity token>
                        │              (uno por servicio; lo acuña el metadata server)
                        ├──▶ ms_rpa_factura   (X-Correlation-ID)
                        └──▶ ms_rpa_pqrsd     (X-Correlation-ID)
```

El navegador **no** llama a los RPA: exigen un identity token de Google y acuñarlo en el
cliente obligaría a publicar una llave de service account. Ver `docs/INTEGRACION_RPA.md`.

---

## 3. Endpoints

La lógica de conversación corre en el navegador, pero el contenedor sí expone dos proxies:
la clave de Gemini y los identity tokens de los RPA solo pueden vivir del lado del servidor.

| Método | Path | Descripción | Autenticación |
|---|---|---|---|
| GET | `/health` | Estado del servicio. `{"status": "UP", "dependencies": {...}}` | No |
| GET | `/version` | `service`, `version`, `environment` | No |
| POST | `/api/ai/chat` | Proxy de Gemini con control de gasto | Origen + límite por IP y cuota |
| GET·POST | `/rpa/factura/v1/*` | Proxy del RPA de Impuesto Predial | Origen + límite por IP + admisión |
| GET·POST | `/rpa/pqrsd/v1/*` | Proxy del RPA de PQRSD | Origen + límite por IP |
| GET | `/*` | Bundle estático del widget | No |

Los endpoints de infraestructura van **sin prefijo de versión**, según el estándar.

Los dos proxies son **listas blancas de rutas y métodos**, no túneles: detrás hay endpoints
que crean trámites oficiales irreversibles y gastan captchas pagados. El detalle de rutas
admitidas, diagnóstico y reglas de reintento está en `docs/INTEGRACION_RPA.md`.

---

## 4. Variables de entorno y secretos

### Variables del contenedor (runtime)

| Variable | Descripción | Tipo | Origen |
|---|---|---|---|
| `PORT` | Puerto de escucha | Configuración | Inyectada por Cloud Run |
| `SERVICE_NAME` | Nombre del servicio | Configuración | Env var |
| `SERVICE_VERSION` | SHA corto del commit desplegado | Configuración | Env var (Cloud Build) |
| `ENVIRONMENT` | `qam` / `prem` / `prod` | Configuración | Env var |
| `LOG_LEVEL` | Nivel mínimo de log | Configuración | Env var |
| `GOOGLE_CLOUD_PROJECT` | Proyecto GCP, para correlacionar trazas | Configuración | Env var |
| `RPA_FACTURA_URL` | URL del RPA de factura. Es también el `audience` del token: exacta y **sin barra final** | Configuración | Env var |
| `RPA_PQRSD_URL` | URL del RPA de PQRSD. Ídem | Configuración | Env var |
| `RPA_AUTH_MODE` | `metadata` / `gcloud` / `none` / `signed_jwt` | Configuración | Env var |
| `RPA_GATEWAY_URL` | Host del API Gateway. Vacío = directo a los Cloud Run | Configuración | Env var |
| `RPA_STARTUP_PROBE` | `strict` / `warn` / `off`. Corta el arranque ante una configuración inválida | Configuración | Env var |
| `RPA_RATE_LIMIT_PER_MINUTE` | Peticiones por minuto y por IP al proxy de los RPA | Configuración | Env var |
| `RPA_EFFECTFUL_LIMIT_PER_HOUR` | Trámites por hora y por IP | Configuración | Env var |
| `RPA_MAX_CONCURRENT_TRAMITES` | Trámites de factura simultáneos. 2 es el techo del servicio | Configuración | Env var |
| `RPA_MAX_UPLOAD_BYTES` | Tope del cuerpo de una radicación con anexos | Configuración | Env var |
| `GEMINI_API_KEY` | Clave de Gemini | **Secreto** | Secret Manager |
| `ALLOWED_ORIGINS` | Portales autorizados a invocar los proxies | Configuración | Env var |
| `TRUSTED_PROXY_HOPS` | Saltos de confianza en `X-Forwarded-For` | Configuración | Env var |
| `BASE_PATH` | Prefijo que RECIBE el servidor, ya recortado por el balanceador. Puede diferir de `VITE_BASE_PATH` | Configuración | Env var |

### Variables de compilación (`VITE_*`)

Se incrustan **literalmente** en el bundle durante el build.

| Variable | Descripción | Tipo |
|---|---|---|
| `VITE_SERVICE_NAME` | Nombre del servicio | Configuración |
| `VITE_SERVICE_VERSION` | Versión desplegada | Configuración |
| `VITE_ENVIRONMENT` | Ambiente | Configuración |
| `VITE_GOOGLE_CLOUD_PROJECT` | Proyecto GCP | Configuración |
| `VITE_BACKEND_ORIGIN` | Origen del backend propio. Vacío = mismo origen que sirve el widget | Configuración |
| `VITE_BASE_PATH` | Prefijo PÚBLICO, el que pide el navegador. En QAM incluye `/apig/qa` | Configuración |
| `VITE_AI_PROXY_URL` | Origen del proxy de IA si vive separado. Vacío = `VITE_BACKEND_ORIGIN` | Configuración |
| `VITE_AI_PROXY_ENABLED` | Usar el proxy del backend para la IA. Activo por omisión en un build de producción | Configuración |
| `VITE_CONVERSATION_API_URL` | Backend de conversaciones | Configuración |
| `VITE_PERSISTENCE_MODE` | `off` / `console` / `http` | Configuración |

**Retiradas:** `VITE_RPA_PREDIAL_API_URL` y `VITE_RPA_PQRSD_API_URL` ya no se leen. Los RPA
exigen IAM, así que sus URLs son variables de runtime del contenedor. Si siguen definidas, el
widget avisa por consola y las ignora.

### 🔴 Regla crítica sobre secretos

**Ninguna variable `VITE_*` puede contener un secreto.** Vite las sustituye por su valor
literal al compilar, así que quedan en un archivo JavaScript estático que cualquiera
puede descargar.

Esto no es teórico: se detectó y corrigió exactamente ese fallo con
`VITE_GEMINI_API_KEY` (ver `SECURITY.md`, hallazgo H-01). El pipeline de Azure DevOps
incluye un paso que **falla el build** si detecta una clave incrustada en `dist/`.

### Secretos en Secret Manager

| Secreto | Uso | Estado |
|---|---|---|
| `gemini-api-key` | Clave de Google Gemini, montada como `GEMINI_API_KEY` de runtime | **Opcional.** Requiere `roles/secretmanager.secretAccessor` para la SA de ejecución |

`_GEMINI_SECRET` viene **vacío** en `cloudbuild.yaml`, y con él vacío el despliegue no monta
ninguna clave. Es deliberado: crear el secreto exige permisos de Secret Manager que no todo
el equipo tiene, y un `--set-secrets` apuntando a un secreto inexistente tumba el despliegue
entero por una dependencia accesoria.

Sin la clave el chatbot funciona: el proxy responde `ai_unavailable` y el widget atiende con
el banco de preguntas frecuentes. Los trámites de predial y PQRSD no dependen de ella. Al
crear el secreto, se pone su nombre en `_GEMINI_SECRET` y sale una revisión nueva.

Los identity tokens de los RPA **no son un secreto que haya que guardar**: los acuña el
servidor de metadatos en cada renovación y nunca se persisten.

---

## 5. Identidad y permisos IAM

| Rol | Service account | Permisos requeridos |
|---|---|---|
| Ejecución | SA de compute por omisión: `<NÚMERO-PROYECTO>-compute@developer.gserviceaccount.com` | `roles/logging.logWriter`, `roles/cloudtrace.agent`, `roles/secretmanager.secretAccessor` sobre `gemini-api-key`, y **`roles/run.invoker` sobre los dos RPA** |
| Despliegue (`deploy-sa`) | ⚠️ PENDIENTE | `roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` |

### `roles/run.invoker` sobre los dos RPA

Es el permiso que hace falta para consumirlos. Sin él el token es válido y la respuesta es
**403**. Se concede una vez por ambiente, y no desde el pipeline: los RPA viven en su propio
proyecto y la cuenta de Cloud Build no puede modificar sus políticas.

El principal es la SA con la que corre el chatbot. Al no pasarse `--service-account` en el
despliegue, es la de compute por omisión del proyecto. Para verla:

```bash
gcloud run services describe qam-ia-chatbot-floridablanca --region=us-central1 --format="value(spec.template.spec.serviceAccountName)"
```

```bash
gcloud run services add-iam-policy-binding qam-rpa-factura --region=us-central1 --project=pre-qa-functions --member="serviceAccount:SA-DEL-CHATBOT@pre-qa-functions.iam.gserviceaccount.com" --role="roles/run.invoker"
```

```bash
gcloud run services add-iam-policy-binding qam-rpa-pqrsd --region=us-central1 --project=pre-qa-functions --member="serviceAccount:SA-DEL-CHATBOT@pre-qa-functions.iam.gserviceaccount.com" --role="roles/run.invoker"
```

Si el gateway de PREM/PROD exigiera un JWT auto-firmado, haría falta además
`roles/iam.serviceAccountTokenCreator` de la SA sobre sí misma. Está pendiente de confirmar
con plataforma: ver `docs/INTEGRACION_RPA.md`, sección 3.

---

## 6. Configuración de Cloud Run por ambiente

| Parámetro | QAM | PREM | PROD |
|---|---|---|---|
| Nombre | `qam-ia-chatbot-floridablanca` | `prem-ia-chatbot-floridablanca` | `prod-ia-chatbot-floridablanca` |
| Rama | `dev` / `qa` | `master` | `main` |
| min-instances | 0 | 1 | 1 |
| max-instances | 1 | 1 | 1 |
| CPU | 1 | 1 | 1 |
| Memoria | 512 Mi | 512 Mi | 512 Mi |
| Concurrencia | 80 | 80 | 80 |
| Timeout | 310s | 310s | 310s |
| Ingress | `internal-and-cloud-load-balancing` | ídem | ídem |

**Justificación de recursos:** el contenedor sirve archivos estáticos y reenvía peticiones;
no compila ni consulta bases de datos. 512 Mi y 1 CPU son holgados. `min-instances: 1` en
PREM y PROD evita que el ciudadano sufra el arranque en frío al abrir el chat.

**Por qué `max-instances: 1`.** El control de admisión que evita saturar el RPA de factura
—techo real de 2 trámites simultáneos— cuenta en la memoria del proceso, así que con varias
instancias el techo efectivo se multiplica. Con 80 peticiones concurrentes por instancia hay
capacidad de sobra para la atención; subirlo exige mover ese contador a Firestore o Redis.

**Por qué `timeout: 310s`.** Un stream SSE de un trámite dura hasta 300s del lado del RPA.
Con el timeout por omisión (300s) la plataforma cortaría la conexión justo antes de que
llegue el evento de cierre.

No hace falta `--no-cpu-throttling`: el seguimiento de un trámite ocurre dentro de una
petición, no en una tarea de fondo.

---

## 7. Observabilidad

### Formato de logs

JSON a stdout con el campo `severity`, según el estándar. Cada entrada incluye:

```json
{
  "severity": "INFO",
  "message": "request_completed",
  "timestamp": "2026-08-11T16:20:00.000Z",
  "service": "ia-chatbot-floridablanca",
  "version": "abc1234",
  "environment": "prem",
  "correlation_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "logging.googleapis.com/trace": "projects/<proyecto>/traces/<trace-id>",
  "method": "GET",
  "path": "/health",
  "status": 200,
  "duration_ms": 1.24
}
```

### Filtro de logs recomendado

```
resource.type="cloud_run_revision"
resource.labels.service_name="prem-ia-chatbot-floridablanca"
severity>=WARNING
```

Para seguir una atención ciudadana completa a través de los RPA:

```
jsonPayload.correlation_id="<el identificador>"
```

### Alertas sugeridas

| Alerta | Condición | Estado |
|---|---|---|
| Tasa de error 5xx | > 1% durante 5 min | ⚠️ PENDIENTE de crear |
| Latencia p95 | > 1 s durante 10 min | ⚠️ PENDIENTE de crear |
| Instancias al máximo | `max-instances` alcanzado | ⚠️ PENDIENTE de crear |

### Dashboard

⚠️ PENDIENTE — sin crear.

---

## 8. Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| `/health` y `/version` devuelven un 404 con HTML de Google | Ingress `internal-and-cloud-load-balancing` sin balanceador por delante: el tráfico no pasa del balanceador de Google | Es la causa más frecuente en el primer despliegue. Mientras no exista el LB externo, QAM se despliega con `_INGRESS: "all"`. PREM y PROD deben volver al valor del estándar. |
| La consola del portal dice `violates the following Content Security Policy directive: script-src` | La CSP del portal anfitrión no admite el origen del chatbot | No se arregla desde aquí: quien opere el portal debe añadir el origen del servicio a `script-src` y a `connect-src`. |
| El widget se monta pero SIN ESTILOS y la consola dice `violates ... Content Security Policy directive: "style-src"` | La CSP del portal no lista el host del chatbot en `style-src`. Un `<link>` a otro dominio queda bloqueado | Ya resuelto: el CSS viaja DENTRO de `embed.js` y se inyecta en un `<style>`, que entra por `'unsafe-inline'`. No hace falta tocar la CSP de ningún portal |
| El widget se monta pero SIN ESTILOS, y el CSS da 404 o `ERR_BLOCKED_BY_ORB` | `VITE_BASE_PATH` no es el prefijo público completo. El JS carga igual porque importa su chunk de forma relativa; el CSS va por ruta absoluta y se va al sitio equivocado | Poner en `VITE_BASE_PATH` el prefijo que pide el navegador, incluido `/apig/qa`, y recompilar: el valor queda dentro del bundle |
| El módulo se bloquea con `net::ERR_FAILED 200 (OK)` desde un portal | Un `<script type="module">` de otro origen exige CORS, y el origen del portal no está en `ALLOWED_ORIGINS` | Añadir el dominio del portal a `ALLOWED_ORIGINS`. El 200 engaña: el archivo llegó y el navegador lo descartó |
| El script del widget carga HTML en vez de JavaScript | La etiqueta apunta a `/src/embed.jsx`, que no existe en el contenedor: el servidor responde `index.html` a toda ruta desconocida | Usar `/assets/embed.js`, que es el punto de entrada compilado y **no lleva hash**, para que el portal no tenga que cambiar la etiqueta en cada despliegue. |
| Embebido en otro dominio, los trámites dan 404 | `VITE_BACKEND_ORIGIN` sin definir al compilar: `/rpa/...` resuelve contra el portal anfitrión | Compilar con `_BACKEND_ORIGIN` apuntando a la URL pública del chatbot. |
| Los trámites fallan con error de CORS | El RPA no admite `X-Correlation-ID` en `Access-Control-Allow-Headers` | Añadirlo en el RPA, o poner `observability.sendCorrelationId: false` en `chatbotConfig.json` como medida temporal |
| El chatbot responde siempre desde el catálogo local | Sin `GEMINI_API_KEY` en el contenedor, o clave inválida | Revisar que el secreto `gemini-api-key` esté montado y que la SA tenga `secretAccessor`. El log de arranque `ai_proxy_configured` trae `ai_enabled`. Sin clave degrada al catálogo a propósito. |
| El widget pide la clave de Gemini en el navegador estando desplegado | `VITE_AI_PROXY_ENABLED=false` en el build | Quitarla. En producción el proxy debe estar activo: la clave vive en el servidor (SECURITY.md, H-01). |
| El contenedor no arranca y el log dice `rpa_probe_fatal` con 403 | Falta `roles/run.invoker` de la SA sobre ese RPA | Conceder el rol (sección 5). Es lo que la sonda de arranque está ahí para detectar. |
| `rpa_probe_fatal` con 401 | `audience` equivocado: barra final sobrante, o el del otro servicio | Revisar `RPA_FACTURA_URL` y `RPA_PQRSD_URL`. Son la URL exacta, sin barra final, y una por servicio. |
| Los trámites fallan con `reason: rpa_ingress_blocked` | 404 con cuerpo HTML: respondió el balanceador de Google, no la aplicación | El ingress del RPA no admite este tráfico. En PREM y PROD hay que entrar por el gateway (`RPA_GATEWAY_URL`). |
| `reason: rpa_not_configured` | Falta `RPA_FACTURA_URL` o `RPA_PQRSD_URL` | Definirlas como variables de runtime, no como `VITE_*`. |
| Funciona en local pero no en Cloud Run, con la misma configuración | Los valores están solo en `.env`, que no entra a la imagen (`.dockerignore`) | La configuración del despliegue va en `--set-env-vars` de `cloudbuild.yaml` y en Secret Manager. `.env` es exclusivamente local. |
| El ciudadano recibe "estás en espera" | Techo de 2 trámites simultáneos del RPA de factura | Es el comportamiento correcto. Si pasa a menudo, el cuello está en el RPA, no aquí. |
| La consola avisa de `VITE_RPA_*_API_URL` ignorada | Variable de la etapa anterior | Quitarla del build. Apuntar el navegador directo a un Cloud Run con IAM da 403. |
| Arranque en frío perceptible | `min-instances: 0` | Subir a 1 en PREM y PROD |
| `/health` responde pero el widget da 404 | `dist/` ausente en la imagen | Revisar la etapa `builder` del Dockerfile |
| Los logs no se filtran por severidad | Campo `severity` ausente o mal escrito | Debe ser `severity`, nunca `level` ni `levelname` |
| Conversaciones sin registrar | `VITE_PERSISTENCE_MODE` en `off`, o modo `http` sin `VITE_CONVERSATION_API_URL` | Ver `REGISTRO_Y_IDENTIDAD.md`. Degrada a `off` a propósito para no enviar datos a un destino indefinido. |

---

## 9. Checklist de cumplimiento GOB-GCP-STD-01

### Cumple

| Ítem | Estado |
|---|---|
| Logging JSON a stdout con campo `severity` | ✅ |
| `timestamp` en cada entrada | ✅ |
| `logging.googleapis.com/trace` cuando hay contexto | ✅ |
| `correlation_id` en cada entrada | ✅ |
| Genera `X-Correlation-ID` si no viene | ✅ |
| Propaga `X-Correlation-ID` sin sobrescribir | ✅ |
| Devuelve `X-Correlation-ID` en la respuesta | ✅ |
| Parsea `X-Cloud-Trace-Context` (GCP) | ✅ |
| Parsea `traceparent` (W3C) | ✅ |
| Log `request_completed` con `duration_ms` | ✅ |
| `GET /health` → `{"status": "UP"}` | ✅ |
| `GET /version` con service, version, environment | ✅ |
| Endpoints de infraestructura sin prefijo de versión | ✅ |
| Dockerfile multi-stage | ✅ |
| Usuario no-root en la imagen final | ✅ |
| Respeta `$PORT` | ✅ |
| `.dockerignore` excluye `.env`, tests, `.git` | ✅ |
| `.env.example` sin credenciales reales | ✅ |
| Variables base declaradas | ✅ |
| `cloudbuild.yaml` con `$COMMIT_SHA` y sustituciones | ✅ |
| `azure-pipelines.yml` con bridge a GitHub | ✅ |
| `tests/` con cobertura de health, version y correlación | ✅ |
| Suite de la integración con los RPA, con respuestas simuladas | ✅ `tests/run-rpa-tests.mjs` |
| `docs/MANUAL.md` | ✅ (con campos pendientes marcados) |
| Nomenclatura `ms_[módulo]_[microservicio]` | ✅ en Azure DevOps |

### No aplica — el servicio no es FastAPI

| Ítem del estándar | Por qué no aplica |
|---|---|
| `api/main.py` | No hay aplicación FastAPI; el equivalente es `server/index.js` |
| `api/core/config.py` (pydantic-settings) | Equivalente: `src/config/environment.js` y variables del contenedor |
| `api/core/logging.py` | Equivalente: `server/logging.js` |
| `api/core/middleware.py` | Equivalente: `server/correlation.js` |
| `api/routers/health.py` | Equivalente: rutas `/health` y `/version` en `server/index.js` |
| `api/routers/v1/` | Los proxies (`/api/ai/chat`, `/rpa/*`) no son endpoints de negocio propios: reenvían a servicios que ya versionan su contrato |
| `openapi/openapi.yaml` | No hay API que contratar |
| `scripts/export_openapi.py` | Ídem |
| `requirements.txt` / `requirements-dev.txt` | Proyecto Node; el equivalente es `package.json` |
| `tests/test_health.py` (pytest) | Equivalente: `tests/run-server-tests.mjs` |

### Pendiente

| Ítem | Responsable |
|---|---|
| Datos de proyectos GCP, región y Artifact Registry | Equipo de plataforma |
| SA dedicada de ejecución (hoy se usa la de compute por omisión) | Equipo de plataforma |
| Balanceador de carga externo delante del Cloud Run | Equipo de plataforma |
| `roles/run.invoker` de la SA del chatbot sobre los dos RPA | Equipo de plataforma |
| URLs de los RPA en PREM y PROD | Pendiente de que esos servicios existan |
| Configuración de `x-google-issuer` del API Gateway | Solo si algún día se entra por gateway |
| Dashboard y alertas de Cloud Monitoring | Equipo de plataforma |
| RFC GS-F-007_V4.0 para PROD (GOB-GCP-GOB-04) | Responsable técnico |

---

## 10. Documentos relacionados

| Documento | Contenido |
|---|---|
| `docs/INTEGRACION_RPA.md` | Integración con los dos RPA: autenticación IAM, rutas, diagnóstico y reglas |
| `SECURITY.md` | Auditoría de seguridad y hallazgos, incluido H-01 (clave en el navegador) |
| `REGISTRO_Y_IDENTIDAD.md` | Registro de conversaciones, identificación e Ley 1581 de 2012 |
| `docs/BASE_CONOCIMIENTO.md` | Base de conocimiento del Estatuto Tributario: extracción, corpus y recuperación |
| `saas_architecture_guide.md` | Arquitectura multi-tenant del widget |
| `API_GUIDE_RPA_PREDIAL.md` | Contrato del RPA de Impuesto Predial |
| `AGENT_GUIDE_PQRSD.md` | Contrato del RPA de PQRSD |
