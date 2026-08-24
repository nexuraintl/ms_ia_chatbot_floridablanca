---
name: gobernanza-gcp-code
description: >
  Skill para Claude Code. Analiza y corrige un repositorio de microservicio FastAPI/Cloud Run
  para que cumpla con los estándares de Gobernanza GCP de NEXURA. Ejecutar desde la raíz del
  repositorio del microservicio. Opera en dos fases: (1) análisis estructural y de contenido
  contra GOB-GCP-STD-01, (2) aplicación de correcciones con confirmación del desarrollador.
  Aplica a repositorios nuevos (creados desde el template) y existentes (migración).
  Activar con: "revisa este repo", "verifica cumplimiento", "aplica el estándar", "migra este servicio".
---

# gobernanza-gcp-code — Análisis y corrección de repositorios

Ejecutar **siempre desde la raíz del repositorio del microservicio**.
Opera en dos fases secuenciales. Nunca aplicar correcciones sin haber presentado el reporte primero.

---

## Fase 1: Análisis

### 1.1 Detección del tipo de repositorio

Antes de analizar, determinar si es un repo nuevo (basado en el template) o existente (a migrar):

```
Repo NUEVO si:
  - Clonado desde template_standard_CloudRun_Repo, O
  - Tiene la estructura /api completa y los archivos core del template

Repo EXISTENTE (migración) si:
  - El código de la aplicación está en la raíz (no en /api/), O
  - Faltan api/core/logging.py, api/core/middleware.py, O
  - No tiene estructura /v1 en routers
```

Indicar el tipo detectado en el reporte. Las correcciones para repos existentes son más extensas y se marcan con `[MIGRACIÓN]`.

---

### 1.2 Análisis estructural — verificar existencia de archivos

Leer el filesystem desde la raíz del repo. Verificar que existan los siguientes archivos:

**Núcleo de la aplicación:**
```
api/__init__.py
api/main.py
api/core/__init__.py
api/core/config.py
api/core/logging.py
api/core/middleware.py
api/routers/__init__.py
api/routers/health.py
api/routers/v1/__init__.py
```

**Infraestructura y documentación:**
```
docs/MANUAL.md
openapi/openapi.yaml         (o openapi/README.md si aún no se exportó)
scripts/export_openapi.py
Dockerfile
.dockerignore
.env.example
requirements.txt
requirements-dev.txt
```

**CI/CD:**
```
azure-pipelines.yml
cloudbuild.yaml
```

**Tests:**
```
tests/                       (directorio)
tests/test_health.py         (mínimo requerido)
```

Marcar cada archivo como ✅ presente / ❌ ausente.

---

### 1.3 Análisis de contenido

Para cada archivo presente, verificar lo siguiente:

#### `api/main.py`
- [ ] Importa y llama `setup_logging()` **antes** de crear la instancia `FastAPI`
- [ ] Registra `CorrelationMiddleware` con `app.add_middleware(CorrelationMiddleware)`
- [ ] Incluye `health.router` sin prefijo
- [ ] Los routers de negocio se incluyen con prefijo `/v1` o el router ya lo define internamente
- [ ] No hay lógica de negocio directamente en `main.py` (solo setup y registro)

#### `api/core/config.py`
- [ ] Usa `pydantic-settings` (`BaseSettings`)
- [ ] Declara las variables base: `service_name`, `service_version`, `environment`, `log_level`, `google_cloud_project`
- [ ] Usa `@lru_cache` en `get_settings()` para evitar re-lectura del `.env` por request
- [ ] Variables de BD (`mongo_uri`, `mysql_password`, etc.) declaradas con valor por defecto vacío `""`

#### `api/core/logging.py`
- [ ] Implementa un `logging.Formatter` que produce JSON a stdout
- [ ] El JSON incluye el campo `severity` (no `level` ni `levelname` directamente — debe ser el valor del levelname como string)
- [ ] Incluye `timestamp` en el log
- [ ] Inyecta `logging.googleapis.com/trace` cuando hay trace context disponible
- [ ] Inyecta `correlation_id` en cada log
- [ ] `setup_logging()` limpia los handlers de uvicorn y los redirige al formatter JSON (para que los logs de uvicorn también sean JSON)

#### `api/core/middleware.py`
- [ ] Implementa `BaseHTTPMiddleware` de Starlette
- [ ] Genera `X-Correlation-ID` con `uuid.uuid4()` si el header no viene en el request
- [ ] Propaga `X-Correlation-ID` si ya viene en el request (no sobreescribir)
- [ ] Devuelve `X-Correlation-ID` en el header de respuesta
- [ ] Parsea `X-Cloud-Trace-Context` (formato GCP: `TRACE_ID/SPAN_ID;o=TRACE_TRUE`)
- [ ] Parsea `traceparent` (formato W3C: `00-<trace-id>-<span-id>-<flags>`)
- [ ] Almacena el contexto de trace en un `ContextVar` accesible por el formatter de logging
- [ ] Registra un log `request_completed` con: método, path, status code, `duration_ms`, `correlation_id`

#### `api/routers/health.py`
- [ ] Define `GET /health` que retorna `{"status": "UP"}`
- [ ] Define `GET /version` que retorna `service`, `version`, `environment` desde `get_settings()`
- [ ] Ambos endpoints sin prefijo `/v1` (son endpoints de infraestructura)
- [ ] Sin autenticación requerida (no incluir en `security` del gateway)

#### `api/routers/v1/` — endpoints de negocio
- [ ] Todos los endpoints de negocio están bajo `/v1/` (en el prefijo del router o en el path)
- [ ] Ningún endpoint de negocio está en `api/routers/` directamente (solo `health.py`)
- [ ] Cada router de negocio usa `APIRouter` con `tags` definidos

#### `Dockerfile`
- [ ] Imagen base es Python (preferiblemente `python:3.11-slim` o similar)
- [ ] Build multi-stage (builder + imagen final, o al menos imagen slim)
- [ ] Usuario no-root en la imagen final (`RUN useradd` + `USER`)
- [ ] Respeta la variable `$PORT` de Cloud Run (`CMD` o `ENTRYPOINT` usa `${PORT:-8080}`)
- [ ] El comando de inicio usa `uvicorn api.main:app` (no `python api/main.py`)
- [ ] `.dockerignore` excluye `.env`, `__pycache__`, `tests/`, `.git`

#### `.env.example`
- [ ] Contiene todas las variables declaradas en `api/core/config.py`
- [ ] Variables base presentes: `SERVICE_NAME`, `SERVICE_VERSION`, `ENVIRONMENT`, `LOG_LEVEL`, `GOOGLE_CLOUD_PROJECT`
- [ ] Secretos (`MONGO_URI`, `MYSQL_PASSWORD`) están **vacíos o con placeholder** (`*****`) — nunca con valores reales
- [ ] Cada variable tiene un comentario explicativo
- [ ] No existe un archivo `.env` real commiteado en el repo

#### `docs/MANUAL.md`
- [ ] **No es el template vacío** — todas las secciones completadas con datos reales
- [ ] Sección 1 (Descripción funcional): nombre real, propósito, módulo, responsables
- [ ] Sección 2 (Arquitectura): proyecto GCP, nombre del Cloud Run, gateway que lo expone
- [ ] Sección 3 (Endpoints): tabla completa con los endpoints reales del servicio
- [ ] Sección 4 (Variables y secretos): mapeo real de variables a secretos de Secret Manager
- [ ] Sección 5 (IAM): `run-sa` y `deploy-sa` identificados
- [ ] Sección 6 (Despliegue): configuración de Cloud Run por ambiente (min/max instances, CPU, memoria)
- [ ] Sección 7 (Observabilidad): filtro de logs configurado con el nombre real del servicio

#### `requirements.txt`
- [ ] Incluye `fastapi`, `uvicorn[standard]`, `pydantic-settings`
- [ ] Si usa MongoDB: incluye `motor`
- [ ] Si usa MySQL: incluye `sqlalchemy`, `aiomysql` o `pymysql`
- [ ] Sin dependencias de desarrollo (pytest, httpx, etc.) — esas van en `requirements-dev.txt`
- [ ] Versiones pinneadas o con rangos (no sin versión)

#### `azure-pipelines.yml`
- [ ] Tiene trigger configurado para las ramas correctas
- [ ] Sincroniza al repositorio GitHub de nexuraintl (bridge para Cloud Build)
- [ ] Usa las variables de sustitución por ambiente

#### `cloudbuild.yaml`
- [ ] Define los pasos de build (docker build + push a Artifact Registry)
- [ ] Define el paso de deploy a Cloud Run
- [ ] Usa `$COMMIT_SHA` como tag de la imagen
- [ ] Define variables de sustitución (`_SERVICE_NAME`, `_REGION`, `_PROJECT_ID`, etc.)
- [ ] Timeout configurado

---

### 1.4 Formato del reporte

Al terminar el análisis, presentar el reporte con esta estructura:

```
# Reporte de cumplimiento GOB-GCP-STD-01
## Repositorio: [nombre] | Tipo: NUEVO / EXISTENTE (migración)
## Fecha: [fecha]

---

## 1. Archivos faltantes [X faltantes de Y requeridos]

| Archivo | Estado | Impacto |
|---------|--------|---------|
| api/core/middleware.py | ❌ Ausente | Crítico — sin Correlation-ID |
| tests/test_health.py   | ❌ Ausente | Medio — sin cobertura mínima |
| ...                    | ✅ Presente | — |

---

## 2. Problemas de contenido [X problemas encontrados]

### api/main.py
- ❌ [CRÍTICO] `CorrelationMiddleware` no registrado → requests sin Correlation-ID
- ⚠️  [MEDIO] Lógica de negocio directa en main.py (debería estar en un router)

### api/core/logging.py
- ❌ [CRÍTICO] Campo `severity` ausente en el JSON → logs no correlacionan en Cloud Logging
- ✅ Timestamp presente
- ✅ trace context inyectado correctamente

### .env.example
- ❌ [CRÍTICO] MONGO_URI contiene credencial real → riesgo de seguridad

### docs/MANUAL.md
- ❌ [CRÍTICO] Template sin completar — secciones 1, 2, 3, 4 vacías

---

## 3. Resumen ejecutivo

| Categoría        | Críticos | Medios | OK |
|------------------|----------|--------|----|
| Archivos         | 1        | 1      | 12 |
| Contenido        | 4        | 1      | 23 |
| **Total**        | **5**    | **2**  | **35** |

**Estado: REQUIERE CORRECCIONES**
Problemas críticos pendientes: 5
Problemas medios pendientes: 2

---

## 4. Plan de correcciones propuesto

### Correcciones automáticas (Claude Code puede aplicar directamente):
1. Crear `api/core/middleware.py` con implementación estándar
2. Agregar `app.add_middleware(CorrelationMiddleware)` en `api/main.py`
3. Corregir `api/core/logging.py` — agregar campo `severity`
4. Limpiar `MONGO_URI` en `.env.example`
5. Crear `tests/test_health.py` con estructura base

### Correcciones manuales (requieren información del desarrollador):
1. Completar `docs/MANUAL.md` — requiere datos reales del servicio
   Información necesaria: nombre real, propósito, proyecto GCP, endpoints de negocio, SAs de IAM

---

¿Aplico las correcciones automáticas? (s/n)
Para las correcciones manuales, ¿puedes proveer la información necesaria?
```

---

## Fase 2: Aplicación de correcciones

Solo ejecutar después de presentar el reporte y obtener confirmación.

### Reglas de aplicación

1. **Primero las correcciones automáticas**, en este orden:
   - Archivos completamente ausentes → crear desde el estándar
   - Archivos presentes con problemas → editar quirúrgicamente (no reescribir el archivo completo si solo hay un problema puntual)
   - Credenciales expuestas → limpiar inmediatamente (prioridad de seguridad)

2. **Para cada corrección aplicada**, reportar:
   ```
   ✅ Aplicado: [descripción de lo que se cambió]
   📁 Archivo: [ruta]
   🔧 Cambio: [qué se agregó / modificó / eliminó]
   ```

3. **No modificar** sin confirmación:
   - Lógica de negocio existente en routers
   - `requirements.txt` si hay versiones específicas ya definidas
   - `cloudbuild.yaml` o `azure-pipelines.yml` si ya tienen configuración de proyectos reales
   - `docs/MANUAL.md` — solo el desarrollador puede completarlo con datos reales; Claude puede generar el esqueleto pero no inventar datos

4. **Para repos existentes** (`[MIGRACIÓN]`), antes de mover código de la raíz a `/api/`:
   - Advertir que el cambio de rutas puede romper el API Gateway si ya está configurado
   - Pedir confirmación explícita antes de mover archivos
   - Sugerir hacerlo en una rama de migración

### Implementaciones estándar para archivos faltantes

Cuando un archivo crítico está ausente, crearlo con la implementación canónica del template de NEXURA:

#### `api/core/middleware.py` (si ausente)
Crear con la implementación completa de `CorrelationMiddleware`:
- `ContextVar` para el trace context
- `get_trace_context()` como función pública
- Parseo de `X-Cloud-Trace-Context` y `traceparent`
- Generación de `uuid4` para correlation-id si no viene en el request
- Header `X-Correlation-ID` en la respuesta
- Log `request_completed` con método, path, status, duration_ms

#### `api/core/logging.py` (si ausente o incompleto)
Crear/corregir con:
- `JsonFormatter` que produce: `severity`, `message`, `timestamp`, `logger`
- Inyección condicional de `logging.googleapis.com/trace`, `logging.googleapis.com/spanId`, `correlation_id` desde `get_trace_context()`
- `setup_logging(level)` que limpia handlers de uvicorn y aplica `JsonFormatter` al logger raíz

#### `api/routers/health.py` (si ausente)
```python
from fastapi import APIRouter
from api.core.config import get_settings

router = APIRouter(tags=["infra"])

@router.get("/health")
async def health() -> dict:
    return {"status": "UP"}

@router.get("/version")
async def version() -> dict:
    settings = get_settings()
    return {
        "service": settings.service_name,
        "version": settings.service_version,
        "environment": settings.environment,
    }
```

#### `tests/test_health.py` (si ausente)
Crear con pruebas mínimas:
- `test_health_ok` — GET /health retorna 200 y `{"status": "UP"}`
- `test_version_ok` — GET /version retorna 200 con los campos `service`, `version`, `environment`
- `test_correlation_id_header` — la respuesta incluye el header `X-Correlation-ID`
- `test_correlation_id_propagated` — si se envía `X-Correlation-ID` en el request, la respuesta devuelve el mismo valor

#### `.env.example` (si faltan variables o hay credenciales expuestas)
- Agregar variables faltantes con comentarios
- Reemplazar cualquier valor que parezca credencial real por `*****` o cadena vacía
- Detectar credenciales: valores que contengan `password`, `secret`, `token`, `key`, `mongodb+srv://`, `mysql://` con usuario:contraseña

---

### Verificación post-corrección

Después de aplicar todas las correcciones, ejecutar una segunda pasada del análisis (Fase 1 completa) y presentar el delta:

```
## Verificación post-corrección

| Problema original          | Estado      |
|----------------------------|-------------|
| middleware.py ausente      | ✅ Resuelto |
| severity ausente en logs   | ✅ Resuelto |
| MONGO_URI con credencial   | ✅ Resuelto |
| MANUAL.md vacío            | ⏳ Pendiente (manual) |

Problemas críticos resueltos: 4/5
Problemas críticos pendientes: 1 (MANUAL.md — requiere datos del desarrollador)

Estado final: APTO PARA REVISIÓN DE GOBERNANZA
(pendiente: completar MANUAL.md con datos reales del servicio)
```

---

## Referencia rápida — Estándar GOB-GCP-STD-01

### Estructura canónica esperada
```
ms_[módulo]_[servicio]/          ← raíz del repo (ejecutar skill desde aquí)
├── api/
│   ├── __init__.py
│   ├── main.py                  ← setup_logging() + CorrelationMiddleware + routers
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py            ← BaseSettings + get_settings() con @lru_cache
│   │   ├── logging.py           ← JsonFormatter con severity + trace context
│   │   └── middleware.py        ← CorrelationMiddleware + ContextVar
│   ├── db/
│   │   ├── mongo.py             ← opcional
│   │   └── mysql.py             ← opcional
│   └── routers/
│       ├── __init__.py
│       ├── health.py            ← GET /health + GET /version (sin /v1)
│       └── v1/
│           ├── __init__.py
│           └── [endpoints].py   ← lógica de negocio bajo /v1
├── docs/
│   └── MANUAL.md                ← completado con datos reales
├── openapi/
│   └── openapi.yaml             ← generado con scripts/export_openapi.py
├── scripts/
│   └── export_openapi.py
├── tests/
│   ├── test_health.py           ← mínimo: health, version, correlation-id
│   └── conftest.py
├── Dockerfile                   ← multi-stage, no-root, $PORT
├── .dockerignore
├── .env.example                 ← sin credenciales reales
├── .gitignore                   ← incluye .env
├── requirements.txt             ← solo deps de producción, pinneadas
├── requirements-dev.txt         ← pytest, httpx
├── azure-pipelines.yml
└── cloudbuild.yaml
```

### Variables de entorno base (siempre requeridas)
```
SERVICE_NAME          → nombre del servicio (se expone en /version y logs)
SERVICE_VERSION       → versión desplegada
ENVIRONMENT           → dev | qa | preprod | prod
LOG_LEVEL             → DEBUG | INFO | WARNING | ERROR | CRITICAL
GOOGLE_CLOUD_PROJECT  → proyecto GCP (para correlación de traces)
```

### Secretos — siempre en Secret Manager, nunca en variables de entorno planas
```
MONGO_URI             → cadena de conexión MongoDB con credenciales
MYSQL_PASSWORD        → contraseña MySQL
[cualquier token, API key, o connection string con credenciales]
```

### Convenciones críticas
- Logging: JSON a stdout, campo `severity` (no `level`), `logging.googleapis.com/trace` para correlación
- Endpoints de negocio: siempre bajo `/v1/` (o `/v{n}/`)
- Endpoints de infraestructura: `/health` y `/version` sin prefijo de versión
- Imagen Docker: respeta `$PORT` (`uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8080}`)
- Ingress Cloud Run: `internal-and-cloud-load-balancing` (verificar en Cloud Console o con gcloud — fuera del scope de este skill pero documentar si se detecta en cloudbuild.yaml)
