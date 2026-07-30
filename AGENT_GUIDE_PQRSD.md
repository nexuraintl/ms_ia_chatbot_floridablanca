# 🤖 Guía de Integración para Agentes IA y Desarrolladores

Esta guía técnica está diseñada para permitir que cualquier **Agente de IA**, **LLM** o **desarrollador** integre y consuma a la perfección los endpoints del microservicio RPA de PQRSD (Alcaldía de Floridablanca / Suite Neptuno).

---

## 📌 Información General del Servidor

* **Base URL**: `http://localhost:8000` (o la IP/dominio donde se despliegue el microservicio)
* **Formato de Comunicación**: REST / JSON / Multipart Form-Data
* **Swagger UI (Docs Interactivas)**: `http://localhost:8000/docs`
* **OpenAPI Schema**: `http://localhost:8000/openapi.json`

---

## 🛠️ Resumen de Endpoints Disponibles

| Endpoint | Método | Tipo de Payload | Descripción |
| :--- | :--- | :--- | :--- |
| `/api/v1/pqrsd/catalogos` | `GET` | N/A | Consulta en tiempo real las listas desplegables (Áreas, Tipos de PQRSD). |
| `/api/v1/pqrsd/consultar` | `POST` | `application/json` | Consulta el estado, detalles, anexos y flujo de un radicado existente. |
| `/api/v1/pqrsd/crear` | `POST` | `multipart/form-data` | Radica una nueva PQRSD en el portal oficial y genera radicado y código. |

---

## 1️⃣ Endpoint 1: Consultar PQRSD (`POST /api/v1/pqrsd/consultar`)

Permite consultar el estado y trazabilidad completa de una solicitud previamente radicada.

### 📥 Request Format
* **URL**: `POST /api/v1/pqrsd/consultar`
* **Header**: `Content-Type: application/json`

**Body JSON:**
```json
{
  "radicado": "2026488450",
  "codigo_autenticacion": "202UhXbRIu2026488450"
}
```

### 📤 Response Format (HTTP 200 OK)
```json
{
  "success": true,
  "found": true,
  "message": "Consulta realizada exitosamente",
  "datos_correspondencia": {
    "id": 488450,
    "radicado": "2026488450",
    "estado": "En revisión",
    "tipo_correspondencia": "Otro",
    "fecha_radicacion": "2026-07-29T07:10:00",
    "metodo_recepcion": "Portal web",
    "remitente": "ANÓNIMO",
    "email": "sincorreo@gmail.com",
    "asunto": "Prueba de Nexura",
    "respuesta": null
  },
  "anexos": [
    {
      "Procedencia": "Documento Adjunto",
      "NombreArchivo": "soporte.pdf"
    }
  ],
  "flujo": [
    {
      "Responsable": {
        "NombreConcatenado": "EDGAR MAURICIO PEÑUELA ARCE",
        "Cargo": "Secretaría General",
        "Area": "Secretaría General",
        "Email": "sec.general@floridablanca.gov.co"
      },
      "FechaAsignacionString": "29/07/26 7:10 a. m.",
      "FechaRespuestaString": ""
    }
  ]
}
```

### ⚠️ Caso No Encontrado
Si los datos de radicado o código son incorrectos, retorna `found: false`:
```json
{
  "success": true,
  "found": false,
  "message": "No se encontró un registro con los datos ingresados. Verifique Radicado y Código.",
  "datos_correspondencia": null,
  "anexos": [],
  "flujo": []
}
```

---

## 2️⃣ Endpoint 2: Crear / Radicar PQRSD (`POST /api/v1/pqrsd/crear`)

Permite enviar una nueva solicitud de PQRSD al portal oficial, adjuntando datos del formulario y archivos binarios opcionales.

### 📥 Request Format
* **URL**: `POST /api/v1/pqrsd/crear`
* **Header**: `Content-Type: multipart/form-data`

**Campos del Formulario (`Form`):**
| Campo | Tipo | Requerido | Descripción / Valor Ejemplo |
| :--- | :--- | :--- | :--- |
| `tipo_correspondencia_json_str` | `string (JSON)` | No (default Id 6) | `{"Id": 6, "Nombre": "Petición"}` |
| `dependencia_json_str` | `string (JSON)` | No (default Id 1) | `{"Id": 8, "Nombre": "Secretaría General"}` |
| `asunto` | `string` | **Sí** | `"Solicitud de información respecto al trámite..."` |
| `email` | `string` | **Sí** | `"usuario@ejemplo.com"` |
| `telefono_celular` | `string` | **Sí** | `"3001234567"` |
| `es_anonimo` | `boolean` | No (default `true`) | `true` para anónimo, `false` para identificado |
| `numero_identificacion` | `string` | Opcional | Cédula/NIT si `es_anonimo` es `false` |
| `placa` | `string` | Opcional | Placa del vehículo si aplica |
| `archivos` | `binary / file` | Opcional | Uno o múltiples archivos binarios adjuntos (`UploadFile`) |

### 📤 Response Format (HTTP 200 OK)
Retorna la información asignada por la Alcaldía:
```json
{
  "success": true,
  "radicado": "2026488452",
  "codigo_autenticacion": "2025jRhhE22026488452",
  "fecha_radicacion": "2026-07-29T07:10:00",
  "message": "Correspondencia registrada bajo el radicado 2026488452, con código de autenticación 2025jRhhE22026488452",
  "raw_response": { ... }
}
```

---

## 3️⃣ Endpoint Auxiliar: Obteniendo Catálogos (`GET /api/v1/pqrsd/catalogos`)

Utiliza este endpoint si necesitas obtener previamente la lista exacta de tipos de PQRSD o dependencias habilitadas en la Alcaldía:

```bash
GET http://localhost:8000/api/v1/pqrsd/catalogos
```

**Respuesta de Catálogos:**
```json
{
  "success": true,
  "tipos_correspondencia": [
    { "Id": 6, "Nombre": "Petición" },
    { "Id": 7, "Nombre": "Queja" }
  ],
  "dependencias_areas": [
    { "Id": 8, "Nombre": "Secretaría General" },
    { "Id": 1, "Nombre": "Despacho" }
  ]
}
```

---

## 💻 Ejemplos de Código para Agentes de IA e Integraciones

### 🐍 Python (usando `requests`)

#### Consultar:
```python
import requests

response = requests.post(
    "http://localhost:8000/api/v1/pqrsd/consultar",
    json={
        "radicado": "2026488450",
        "codigo_autenticacion": "202UhXbRIu2026488450"
    }
)
data = response.json()
print("Estado del radicado:", data["datos_correspondencia"]["estado"])
```

#### Radicar / Crear:
```python
import requests

data = {
    "asunto": "Petición sobre estado de vía pública",
    "email": "ciudadano@gmail.com",
    "telefono_celular": "3109876543",
    "es_anonimo": "true",
    "tipo_correspondencia_json_str": '{"Id": 6, "Nombre": "Petición"}',
    "dependencia_json_str": '{"Id": 8, "Nombre": "Secretaría General"}'
}

files = [
    ("archivos", ("foto_soporte.jpg", open("foto.jpg", "rb"), "image/jpeg"))
]

response = requests.post("http://localhost:8000/api/v1/pqrsd/crear", data=data, files=files)
res = response.json()
print("Radicado generado:", res["radicado"])
print("Código autenticación:", res["codigo_autenticacion"])
```

---

### 🟨 JavaScript / Node.js (usando `fetch`)

#### Consultar:
```javascript
const response = await fetch("http://localhost:8000/api/v1/pqrsd/consultar", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    radicado: "2026488450",
    codigo_autenticacion: "202UhXbRIu2026488450"
  })
});
const result = await response.json();
console.log(result);
```

---

## ⚙️ Manejo de Errores y Códigos HTTP

- `200 OK`: Petición procesada correctamente.
- `422 Unprocessable Entity`: Error de validación en los parámetros enviados (por ejemplo, falta el parámetro `asunto` o `email`).
- `502 Bad Gateway`: Error de conectividad con el portal oficial de la Alcaldía de Floridablanca.
