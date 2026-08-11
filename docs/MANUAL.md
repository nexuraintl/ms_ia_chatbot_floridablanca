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
| Base de datos | Ninguna propia |
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
| RPA Impuesto Predial | Consulta de predios y generación de factura | Alta |
| RPA PQRSD | Radicación y consulta de radicados | Alta |
| Google Gemini API | Respuesta libre conversacional | Media — degrada a catálogo local |
| Backend de conversaciones | Registro de la atención | ⚠️ PENDIENTE — sin definir |

### Diagrama de flujo

```
Navegador del ciudadano
  └─ Portal municipal (tercero)
       └─ <script> widget  ──────────▶  Cloud Run (este servicio)
                                          └─ sirve dist/ + /health + /version
            │
            ├──▶ RPA Predial      (X-Correlation-ID)
            ├──▶ RPA PQRSD        (X-Correlation-ID)
            ├──▶ Gemini API       (clave en el navegador — ver SECURITY.md H-01)
            └──▶ Backend conversaciones  ⚠️ PENDIENTE
```

---

## 3. Endpoints

El contenedor expone únicamente endpoints de infraestructura. No hay endpoints de
negocio: la lógica corre en el navegador y consume los RPA directamente.

| Método | Path | Descripción | Autenticación |
|---|---|---|---|
| GET | `/health` | Estado del servicio. Devuelve `{"status": "UP"}` | No |
| GET | `/version` | `service`, `version`, `environment` | No |
| GET | `/*` | Bundle estático del widget | No |

Ambos endpoints de infraestructura van **sin prefijo de versión**, según el estándar.

> **Sobre `/v1`**: el estándar exige que los endpoints de negocio vivan bajo `/v1/`.
> Aquí no aplica porque el servicio no expone ninguno. Los endpoints versionados que
> consume el widget pertenecen a los RPA y están versionados en sus propios manuales.

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

### Variables de compilación (`VITE_*`)

Se incrustan **literalmente** en el bundle durante el build.

| Variable | Descripción | Tipo |
|---|---|---|
| `VITE_SERVICE_NAME` | Nombre del servicio | Configuración |
| `VITE_SERVICE_VERSION` | Versión desplegada | Configuración |
| `VITE_ENVIRONMENT` | Ambiente | Configuración |
| `VITE_GOOGLE_CLOUD_PROJECT` | Proyecto GCP | Configuración |
| `VITE_RPA_PREDIAL_API_URL` | URL del RPA de Predial | Configuración |
| `VITE_RPA_PQRSD_API_URL` | URL del RPA de PQRSD | Configuración |
| `VITE_CONVERSATION_API_URL` | Backend de conversaciones | Configuración |
| `VITE_PERSISTENCE_MODE` | `off` / `console` / `http` | Configuración |

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
| — | — | Este servicio no consume secretos desde el contenedor |

> **Excepción documentada:** la clave de Google Gemini se introduce desde el panel de
> control del chatbot y vive en el navegador del operador. No puede moverse a Secret
> Manager sin un proxy de backend. Ver `SECURITY.md`, H-01.

---

## 5. Identidad y permisos IAM

| Rol | Service account | Permisos requeridos |
|---|---|---|
| Ejecución (`run-sa`) | ⚠️ PENDIENTE | `roles/logging.logWriter`, `roles/cloudtrace.agent` |
| Despliegue (`deploy-sa`) | ⚠️ PENDIENTE | `roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` |

El servicio no accede a bases de datos ni a Secret Manager, así que su SA de ejecución
necesita permisos mínimos: solo escribir logs y trazas.

---

## 6. Configuración de Cloud Run por ambiente

| Parámetro | QAM | PREM | PROD |
|---|---|---|---|
| Nombre | `qam-ia-chatbot-floridablanca` | `prem-ia-chatbot-floridablanca` | `prod-ia-chatbot-floridablanca` |
| Rama | `dev` / `qa` | `master` | `main` |
| min-instances | 0 | 1 | 1 |
| max-instances | 10 | 10 | ⚠️ PENDIENTE (según tráfico esperado) |
| CPU | 1 | 1 | 1 |
| Memoria | 512 Mi | 512 Mi | 512 Mi |
| Concurrencia | 80 | 80 | 80 |
| Ingress | `internal-and-cloud-load-balancing` | ídem | ídem |

**Justificación de recursos:** el contenedor solo sirve archivos estáticos y responde
dos endpoints de infraestructura; no compila ni consulta bases de datos. 512 Mi y 1 CPU
son holgados. `min-instances: 1` en PREM y PROD evita que el ciudadano sufra el arranque
en frío al abrir el chat.

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
| El widget no carga en el portal | Ingress `internal-and-cloud-load-balancing` sin balanceador por delante | Verificar el LB externo. Es la causa más frecuente en el primer despliegue. |
| Los trámites fallan con error de CORS | El RPA no admite `X-Correlation-ID` en `Access-Control-Allow-Headers` | Añadirlo en el RPA, o poner `observability.sendCorrelationId: false` en `chatbotConfig.json` como medida temporal |
| El chatbot responde siempre desde el catálogo local | Sin clave de Gemini configurada, o clave inválida | Revisar el panel de control. Sin clave, degrada al catálogo local a propósito. |
| Los trámites apuntan a `localhost:8000` | `VITE_RPA_*_API_URL` sin definir al compilar | Redefinir las variables y reconstruir. La consola del navegador lo avisa con un error. |
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
| `api/routers/v1/` | El servicio no expone endpoints de negocio |
| `openapi/openapi.yaml` | No hay API que contratar |
| `scripts/export_openapi.py` | Ídem |
| `requirements.txt` / `requirements-dev.txt` | Proyecto Node; el equivalente es `package.json` |
| `tests/test_health.py` (pytest) | Equivalente: `tests/run-server-tests.mjs` |

### Pendiente

| Ítem | Responsable |
|---|---|
| Datos de proyectos GCP, región y Artifact Registry | Equipo de plataforma |
| Service accounts de ejecución y despliegue | Equipo de plataforma |
| Balanceador de carga externo delante del Cloud Run | Equipo de plataforma |
| Dashboard y alertas de Cloud Monitoring | Equipo de plataforma |
| RFC GS-F-007_V4.0 para PROD (GOB-GCP-GOB-04) | Responsable técnico |

---

## 10. Documentos relacionados

| Documento | Contenido |
|---|---|
| `SECURITY.md` | Auditoría de seguridad y hallazgos, incluido H-01 (clave en el navegador) |
| `REGISTRO_Y_IDENTIDAD.md` | Registro de conversaciones, identificación e Ley 1581 de 2012 |
| `saas_architecture_guide.md` | Arquitectura multi-tenant del widget |
| `API_GUIDE_RPA_PREDIAL.md` | Contrato del RPA de Impuesto Predial |
| `AGENT_GUIDE_PQRSD.md` | Contrato del RPA de PQRSD |
