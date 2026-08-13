---
name: gobernanza-gcp
description: >
  Skill de Gobernanza GCP para NEXURA. Usar SIEMPRE cuando se trabaje con microservicios FastAPI
  sobre Cloud Run dentro del proyecto de Gobernanza GCP: documentar un microservicio nuevo o
  existente, verificar cumplimiento antes de generar documentación, completar o corregir
  documentación faltante, o incorporar un servicio a la plataforma. Este skill carga los estándares
  de gobernanza como reglas fijas y entiende el contexto del microservicio concreto para producir
  documentación precisa, completa y lista para aprobar. También activa cuando el usuario dice
  "documenta este servicio", "verifica si cumple con gobernanza", "genera el manual del servicio"
  o cualquier variante orientada a documentación de microservicios en la plataforma NEXURA GCP.
---

# gobernanza-gcp — Documentación de microservicios NEXURA

Este skill tiene dos fases secuenciales obligatorias:

1. **Verificación de cumplimiento** — revisar el microservicio contra los estándares antes de documentar.
2. **Generación de documentación** — producir los documentos requeridos usando el skill `docx-nexura`.

**Nunca generar documentación sin haber completado la verificación primero.**

---

## Contexto de la plataforma (embebido)

### Stack
- Runtime: FastAPI / Python sobre **Cloud Run**
- CI/CD: Azure DevOps → GitHub (bridge) → Cloud Build → Cloud Run
- Gateway: API Gateway ESPv2 con patrón `CONSTANT_ADDRESS`
- Imágenes: Artifact Registry (tag = commit SHA)
- Secretos: Secret Manager exclusivamente (cero credenciales en env vars planas)
- BD: MongoDB y/o MySQL vía VPC Access Connector (`private-ranges-only`)
- Observabilidad: Cloud Monitoring / Cloud Logging / Cloud Trace

### Ambientes y nomenclatura
| Ambiente | Rama Git | Prefijo Cloud Run | min-instances |
|----------|----------|-------------------|---------------|
| QAM      | dev/qa   | `qam-`            | 0             |
| PREM     | master   | `prem-`           | 1             |
| PROD     | main     | `prod-`           | 1             |

Formato de nombres:
- Repositorio: `ms_[módulo]_[microservicio]` (ej: `ms_ia_clasificador`)
- Servicio Cloud Run: `[ambiente]-[módulo]-[microservicio]` (ej: `prem-ia-clasificador`)
- Path en API Gateway: `/[módulo]/[microservicio]/...` (ej: `/ia/clasificador/v1/...`)

### Estándares activos
| Código | Área | Lo más importante |
|--------|------|-------------------|
| GOB-GCP-STD-01 | Repositorio | Estructura `/api`, logging JSON, Correlation-ID, `/v1` en endpoints de negocio, MANUAL.md |
| GOB-GCP-GOB-01 | API Gateway | `CONSTANT_ADDRESS`, security por operación, `operationId` único, audiences por ambiente |
| GOB-GCP-GOB-04 | Aprobación PROD | Ticket mesa servicios + RFC GS-F-007_V4.0 + PR ADO con aprobación Santiago + Angie |

---

## Fase 1: Verificación de cumplimiento

### Qué leer del microservicio

Antes de verificar, leer los siguientes archivos del repositorio (si existen):

```
api/main.py                     → middlewares registrados, routers incluidos
api/core/config.py              → variables de entorno declaradas
api/core/logging.py             → implementación del logging JSON
api/core/middleware.py          → implementación del Correlation-ID / trazabilidad
api/routers/health.py           → endpoints /health y /version
api/routers/v1/                 → endpoints de negocio versionados
.env.example                    → variables documentadas
README.md                       → sección de configuración / env vars
docs/MANUAL.md                  → manual operativo completado
openapi/openapi.yaml            → contrato OpenAPI exportado
Dockerfile                      → imagen multi-stage, usuario no-root, $PORT
requirements.txt                → dependencias de producción
cloudbuild.yaml                 → pipeline de build/deploy
azure-pipelines.yml             → pipeline de sincronización ADO→GitHub
```

Si el repositorio no está disponible como archivos locales, pedirle al usuario que los provea o que comparta el contenido relevante.

### Checklist de verificación GOB-GCP-STD-01

**Estructura del repositorio:**
- [ ] Código de aplicación dentro de `/api/` (no en la raíz)
- [ ] `api/main.py` — punto de entrada FastAPI
- [ ] `api/core/config.py` — configuración con `pydantic-settings`
- [ ] `api/core/logging.py` — logging JSON estructurado con campo `severity`
- [ ] `api/core/middleware.py` — middleware `CorrelationMiddleware`
- [ ] `api/routers/health.py` — endpoints `/health` y `/version` sin prefijo `/v1`
- [ ] `api/routers/v1/` — endpoints de negocio bajo `/v1`
- [ ] `openapi/openapi.yaml` — contrato OpenAPI exportado
- [ ] `scripts/export_openapi.py` — script de exportación del contrato
- [ ] `docs/MANUAL.md` — manual operativo completado (no el template vacío)
- [ ] `Dockerfile` — imagen multi-stage, usuario no-root, respeta `$PORT`
- [ ] `.env.example` — todas las variables documentadas, sin valores reales
- [ ] `requirements.txt` y `requirements-dev.txt`
- [ ] `tests/` — pruebas con pytest (mínimo: `/health`, `/version`, middleware)

**Logging y observabilidad:**
- [ ] Logging en JSON a stdout con campo `severity` mapeado a Cloud Logging
- [ ] `CorrelationMiddleware` registrado en `app.add_middleware()`
- [ ] Cada request genera o propaga `X-Correlation-ID`
- [ ] Header `X-Correlation-ID` devuelto en la respuesta
- [ ] Campo `logging.googleapis.com/trace` en logs cuando hay trace context
- [ ] `setup_logging()` llamado antes de crear la app FastAPI

**Variables de entorno:**
- [ ] Variables base presentes: `SERVICE_NAME`, `SERVICE_VERSION`, `ENVIRONMENT`, `LOG_LEVEL`, `GOOGLE_CLOUD_PROJECT`
- [ ] Variables de BD opcionales solo si el servicio las usa
- [ ] Secretos (`MONGO_URI`, `MYSQL_PASSWORD`) vacíos en `.env.example`
- [ ] Secretos documentados en `docs/MANUAL.md` sección 4 con nombre del secreto en Secret Manager

**Nomenclatura:**
- [ ] Repositorio nombrado `ms_[módulo]_[microservicio]`
- [ ] `SERVICE_NAME` en `.env.example` coincide con la convención

### Checklist de verificación GOB-GCP-GOB-01 (API Gateway)

Solo aplica si el microservicio está expuesto a través del API Gateway.

- [ ] YAML del gateway usa `path_translation: CONSTANT_ADDRESS`
- [ ] Cada operación tiene `security` definido (no solo a nivel global)
- [ ] `operationId` único en todo el YAML del gateway
- [ ] `x-google-audiences` configurado por ambiente (URL del gateway, no del Cloud Run)
- [ ] `x-google-issuer` apunta al service account correcto
- [ ] `x-google-jwks_uri` con guión bajo (excepción conocida — guión `-` rompe ESPv2)
- [ ] `address` en `x-google-backend` apunta a la URL del Cloud Run (no al gateway)
- [ ] Ingress del Cloud Run: `internal-and-cloud-load-balancing` (nunca `all`)

### Reporte de verificación

Al terminar la verificación, presentar un reporte estructurado:

```
## Reporte de cumplimiento — [nombre del servicio]

### ✅ Cumple
- [lista de ítems que pasan]

### ❌ No cumple / Faltante
- [ítem]: [descripción del problema] → [acción correctiva recomendada]

### ⚠️ No verificable (archivo no disponible)
- [lista de archivos no provistos]

### Resumen
- Ítems verificados: X
- Cumple: X | No cumple: X | No verificable: X
- Estado: APTO PARA DOCUMENTAR / REQUIERE CORRECCIONES PREVIAS
```

**Si el estado es REQUIERE CORRECCIONES PREVIAS**: listar las correcciones y esperar confirmación del usuario antes de continuar con la Fase 2. No generar documentación sobre un servicio con incumplimientos críticos sin que el usuario los haya aceptado o justificado.

**Incumplimientos críticos** (bloquean la documentación sin justificación):
- Credenciales en variables de entorno planas (secreto no en Secret Manager)
- Ingress del Cloud Run en modo `all`
- Ausencia total de logging estructurado
- `docs/MANUAL.md` vacío o con el template sin completar

---

## Fase 2: Generación de documentación

Una vez verificado el cumplimiento, generar los siguientes documentos.

### Documentos a producir

| Documento | Propósito | Cuándo generarlo |
|-----------|-----------|------------------|
| **MANUAL del servicio** | Manual operativo completo del microservicio | Siempre |
| **Ficha de incorporación al gateway** | Configuración del servicio en el API Gateway | Solo si el servicio usa API Gateway |
| **RFC pre-completado** | Borrador del RFC GS-F-007_V4.0 para PROD | Solo si el destino es PROD |

### Documento 1: Manual del servicio

Nombre de archivo: `AAAAMMDD_manual-[módulo]-[microservicio]_v1.docx`

Usar el skill `docx-nexura` para generar el documento con las siguientes secciones. **Completar con datos reales extraídos del repositorio** — no dejar placeholders del template sin completar.

**Secciones obligatorias:**

1. **Descripción funcional** — nombre, propósito, módulo, responsable funcional y técnico
2. **Arquitectura** — proyecto GCP, servicio Cloud Run (nombre + región), gateway y path que lo expone, dependencias, bases de datos
3. **Endpoints** — tabla completa extraída de `openapi/openapi.yaml` o de `api/routers/`; incluir método, path, descripción, autenticación requerida
4. **Variables de entorno y secretos** — tabla completa de `.env.example` y `README.md`; columnas: Variable, Descripción, Tipo (Configuración/Secreto), Origen (env var / Secret Manager)
5. **Identidad y permisos IAM** — SA de ejecución (`run-sa`), SA de despliegue (`deploy-sa`), roles asignados
6. **Configuración Cloud Run** — tabla por ambiente (QAM/PREM/PROD): min-instances, max-instances, CPU, memoria, concurrencia, justificación
7. **Observabilidad** — dashboard de Cloud Monitoring (link si existe), alertas configuradas, filtro de logs recomendado
8. **Troubleshooting** — tabla de síntomas frecuentes, causas y acciones (mínimo: 401 en gateway, cold start, error de BD)
9. **Checklist de cumplimiento** — resumen del reporte de verificación (Fase 1) en formato tabla

### Documento 2: Ficha de incorporación al gateway (si aplica)

Nombre de archivo: `AAAAMMDD_gateway-config-[módulo]-[microservicio]_v1.docx`

**Secciones:**
1. **Datos del servicio** — nombre Cloud Run, URL, región, proyecto GCP por ambiente
2. **Configuración en el YAML del gateway** — bloque completo del path del servicio en el YAML (como code block)
3. **Audiences JWT** — tabla por ambiente con el valor exacto del audience
4. **Checklist de validación** — basado en GOB-GCP-GOB-01

### Documento 3: RFC pre-completado (si destino es PROD)

Nombre de archivo: `AAAAMMDD_rfc-[módulo]-[microservicio]_v1.docx`

Pre-completar el RFC GS-F-007_V4.0 con la información del servicio según GOB-GCP-GOB-04:
- Encabezado con datos del microservicio
- Análisis de riesgos típicos de Cloud Run pre-rellenado
- Plan de rollback con el comando `gcloud run services update-traffic` específico del servicio
- Plan de pruebas con el endpoint `/health` y el endpoint de negocio principal
- Plan de fases estándar (3 fases)
- Matriz de impacto con estimación (generalmente Muy bajo o Bajo para microservicios nuevos)

---

## Instrucciones de uso del skill

### En un proyecto nuevo de Claude con un microservicio

1. Crear un proyecto en Claude.ai y agregar este skill.
2. Subir como archivos del proyecto los archivos clave del repositorio del microservicio (ver "Qué leer del microservicio").
3. Indicar: "Documenta el microservicio [nombre]" o "Verifica y documenta [nombre]".
4. El skill ejecuta Fase 1 (verificación), presenta el reporte, y con confirmación ejecuta Fase 2 (documentación).

### Información mínima requerida del usuario

Si los archivos no están disponibles, solicitar al usuario:
- Nombre del microservicio y módulo al que pertenece
- Proyecto GCP (QAM/PREM/PROD) y si está expuesto por API Gateway
- SA de ejecución y SA de despliegue
- Variables de entorno y secretos que usa
- Endpoints de negocio principales
- Si usa MongoDB, MySQL o ninguna BD

---

## Referencias rápidas

**Template estándar:** `https://github.com/nexuraintl/template_standard_CloudRun_Repo`

**Estructura de carpetas esperada:**
```
ms_[módulo]_[servicio]/
├── api/
│   ├── main.py
│   ├── core/
│   │   ├── config.py
│   │   ├── logging.py
│   │   └── middleware.py
│   ├── db/
│   │   ├── mongo.py        (opcional)
│   │   └── mysql.py        (opcional)
│   └── routers/
│       ├── health.py
│       └── v1/
│           └── [endpoints de negocio].py
├── docs/
│   └── MANUAL.md
├── openapi/
│   └── openapi.yaml
├── scripts/
│   └── export_openapi.py
├── tests/
├── Dockerfile
├── .env.example
├── requirements.txt
├── requirements-dev.txt
├── azure-pipelines.yml
└── cloudbuild.yaml
```

**Variables de entorno base (siempre requeridas):**
```
SERVICE_NAME, SERVICE_VERSION, ENVIRONMENT, LOG_LEVEL, GOOGLE_CLOUD_PROJECT
```

**Secretos que siempre van en Secret Manager (nunca en env vars planas):**
```
MONGO_URI, MYSQL_PASSWORD — y cualquier credencial, token o connection string con credenciales
```
