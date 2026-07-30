# Guía de integración — API RPA Impuesto Predial

Para agentes / desarrolladores que van a consumir este servicio desde un chatbot o una integración
externa. Todo lo de acá está verificado contra el código (`app.py`, `rpa_bot.py`, `clients_config.py`).

---

## 1. Lo primero que tenés que entender

Este servicio **no es una API de base de datos: es un robot que navega el portal del municipio**.
Cada consulta abre un navegador, resuelve un reCAPTCHA, entra a la ventanilla virtual, genera la
factura, la descarga y opcionalmente reserva un link de pago PSE.

**Un trámite tarda entre 25 y 45 segundos.** No es optimizable: ~32 de esos segundos son el servidor
del portal calculando la liquidación (en Floridablanca la deuda va de 1994 a hoy).

Cinco cosas que hay que interiorizar antes de escribir código:

1. **Nunca dejes al usuario esperando en silencio.** Hay que ir contándole qué pasa (§6).
2. **No prometas el monto antes de tenerlo.** El monto confiable llega en el evento `pdf_ready`.
   Antes de eso el portal muestra `$0` de forma transitoria — si lo leés antes, le decís al usuario
   que debe cero pesos cuando debe 66 millones.
3. **Poné el timeout del cliente HTTP en 180s o más.** No hay timeout del lado del servidor y en el
   peor camino (con reintentos internos) un trámite puede pasar de 10 minutos. Un read-timeout de 60s
   va a abandonar trámites que iban a terminar bien — y el PDF se genera igual, huérfano.
4. **No se puede cancelar un trámite en curso.** No hay endpoint para abortar. Pensalo antes de
   lanzarlo.
5. **El throughput máximo son 2 trámites simultáneos** (`RPA_WORKERS`). El tercero espera en cola
   —no falla, pero suma. No lances 20 consultas en paralelo esperando 20 respuestas en 40s.

---

## 2. ¿Qué modo de entrega uso?

Hay tres formas de pedir la misma factura. El flujo interno es idéntico; lo único que cambia es
**cuándo te respondo**.

| Modo | Cómo | Respondo cuando... | Usalo si... |
|---|---|---|---|
| **Clásico** | `POST /api/generar_factura` | está TODO listo (factura + link de pago) | tenés una integración vieja, o querés una sola llamada y no te importan ~4s extra |
| **Rápido** | `POST /api/generar_factura?mode=fast` | el PDF ya está en disco (~4s antes) | **chatbot que solo muestra factura + QR** |
| **Streaming** | `POST /api/generar_factura?mode=async` → `GET /api/jobs/{id}/stream` | de inmediato (202), y después te mando cada evento en vivo | **chatbot que quiere contarle al usuario qué está pasando** ← recomendado |

> **Para un chatbot, usá `mode=async` + SSE.** Es la única forma de darle al usuario mensajes de
> progreso que sean **verdad** en vez de un temporizador inventado. Si tu plataforma no soporta SSE,
> usá `mode=fast` con mensajes por tiempo (§7).

El modo se puede pasar como query param (`?mode=fast`) **o** en el body (`"mode": "fast"`).
**El query param gana** si mandás los dos. Un valor desconocido (`?mode=turbo`) **no da error**:
cae en silencio al modo clásico.

---

## 3. Endpoints

Todos los bodies aceptan **form-urlencoded o JSON**, indistintamente (se decide por el header
`Content-Type`).

### 3.1 `GET /api/clientes`

Los municipios disponibles y los tipos de búsqueda válidos de cada uno. **Llamalo al arrancar** y usá
los `search_types` literales que devuelva: son distintos por municipio.

```json
{
  "status": "success",
  "clientes": [
    { "id": "apartado",      "name": "Apartadó (Antioquia)",      "search_types": ["Propietario", "Código Predial", "Dirección"] },
    { "id": "floridablanca", "name": "Floridablanca (Santander)", "search_types": ["Código Predial", "Número Cuenta", "Código NPN", "Código NUPRE", "Matrícula Inmobiliaria"] }
  ]
}
```

### 3.2 `POST|GET /api/prewarm?cliente=<id>`

Arranca la resolución del captcha **por adelantado**. Responde al instante, no espera nada.

**Llamalo en cuanto el usuario dice que quiere una factura**, antes de tener sus datos. Mientras el
usuario escribe la cédula, el token se resuelve, y al enviar la consulta el captcha ya no está en el
camino crítico. Ahorra entre 5 y 20 segundos.

- **`cliente` es un QUERY PARAM, incluso en el POST.** Si lo mandás en el body, se ignora.
- Es idempotente: llamarlo muchas veces no multiplica el gasto.
- Si no lo llamás, el trámite funciona igual (resuelve el captcha inline).
- ⚠️ **Un `cliente` con typo no da error**: cae a `apartado` y calienta ese. La única pista es el id
  que aparece dentro del `message` (`"Resolución anticipada iniciada para 'apartado'."`).

### 3.3 `POST /api/generar_factura`

| Parámetro | Dónde | Obligatorio | Notas |
|---|---|---|---|
| `search_type` | body | **sí** | Uno de los `search_types` del cliente (§3.1). Se valida: si no corresponde, **422 inmediato** |
| `search_value` | body | **sí** | La cédula / código / dirección |
| `phone` | body | *de facto sí* | Ver el aviso de abajo |
| `email` | body | *de facto sí* | Ver el aviso de abajo |
| `cliente` | body | no | Default `apartado` |
| `client_id` | body | no | Alias de `cliente`; solo se lee si `cliente` viene vacío |
| `q` | query | no | Alias de `cliente` con **prioridad máxima** |
| `mode` | query o body | no | `fast` \| `async`. Vacío o desconocido = clásico |

Precedencia del municipio: **`q` (query) → `cliente` (body) → `client_id` (body) → `apartado`**.
Un id desconocido **no da error**: cae a `apartado` en silencio, y ahí va a fallar la validación de
`search_type`. Mandá siempre el municipio explícito.

> ⚠️ **`phone` y `email` no son opcionales en la práctica.** Si los omitís, el bot escribe
> `3000000000` y `correo@ejemplo.com` en el formulario del portal, y **el municipio registra ese
> correo falso como dato de notificación del recibo en su sistema**. Tratalos como obligatorios.

#### Respuestas

**Éxito (200)** — modo clásico:

```json
{
  "status": "success",
  "message": "Factura descargada exitosamente.",
  "file": "C:\\...\\facturas_descargadas\\Factura3205346.pdf",
  "filename": "Factura3205346.pdf",
  "payment_url": "https://www.floridablanca.gov.co/loader.php?...",
  "payment_qr": "data:image/png;base64,iVBOR...",
  "amount": "66122546",
  "amount_pdf": "66122546",
  "timings": { "nav": 0.75, "paso_a": 11.5 }
}
```

- `file` es la ruta **absoluta en el servidor** — no te sirve como cliente. Usá `/facturas/{filename}`.
- `payment_url` y `payment_qr` son **independientes**: podés recibir la URL con el QR en `null`.
  Chequealos por separado.

**Éxito (200)** — modo rápido. Fijate en `payment_pending`:

```json
{
  "status": "success",
  "message": "Factura descargada exitosamente. El link de pago se está capturando.",
  "filename": "Factura3205346.pdf",
  "file": "C:\\...\\Factura3205346.pdf",
  "amount": "66122546",
  "payment_url": null,
  "payment_qr": null,
  "payment_pending": true,
  "job_id": "b3f1...",
  "poll": "/api/jobs/b3f1..."
}
```

> **`payment_pending: true` significa: mostrale la factura YA y pedí el QR después.** Hacé
> `GET /api/jobs/{job_id}` cada ~700ms hasta que `result.payment_url` aparezca (llega en ~4s).

**Múltiples predios (200)** — no es un error, ver §5.3.

**Error (500)**: `{"status": "error", "message": "<texto del portal>", "timings": {...}}` — ver §8.

**422**: falta un campo obligatorio, o `search_type` no corresponde al municipio.

**202 `pending`**, solo en modo rápido y solo si pasaron 120s sin PDF: el trámite **sigue vivo**,
seguilo por `poll`. **No lo reintentes.** (Ese contador arranca cuando se encola el trabajo, no
cuando el worker empieza — si había cola, se te puede agotar antes de que el trámite arranque.)

#### Modo async (202)

```json
{ "status": "accepted", "job_id": "b3f1...", "poll": "/api/jobs/b3f1...", "stream": "/api/jobs/b3f1.../stream" }
```

### 3.4 `GET /api/jobs/{job_id}`

Estado del trámite. **404** si no existe o expiró (los jobs viven 15 min tras la última actualización).

```json
{
  "id": "b3f1...",
  "status": "running",
  "created": 1785254632.5,
  "updated": 1785254658.1,
  "events": [ { "event": "started", "ts": 1785254632.5, "client_id": "floridablanca", "warm": true } ],
  "result": null,
  "message": null,
  "pdf": { "filename": "Factura3205346.pdf", "file": "C:\\...", "amount": "66122546" }
}
```

- **`status` es el ciclo de vida del JOB**: `running` | `done` | `error`.
- **`result.status` es el desenlace del TRÁMITE**: `success` | `multiple_predios` | `error`.
- **No los confundas:** un `multiple_predios` cierra el job en `done`, no en `error`.
  `job.status == "done"` **no** quiere decir que salió bien: mirá `result.status`.
- `pdf` aparece **solo después** del evento `pdf_ready`.
- `result` es `null` hasta que el trámite termina.

### 3.5 `GET /api/jobs/{job_id}/stream` (SSE)

`Content-Type: text/event-stream`. Cada evento:

```
data: {"event":"started","ts":1785254632.5,"client_id":"floridablanca","warm":true}

```

Al terminar, un evento de cierre con el resultado completo:

```
data: {"event":"done","ts":1785254678.2,"message":"Factura descargada exitosamente.","result":{...}}

```

Detalles que importan:

- **Podés conectarte tarde.** El stream reenvía todos los eventos que ya pasaron, así que no hay
  carrera entre el 202 y el `GET .../stream`.
- **Ignorá las líneas que empiezan con `:`** — son heartbeats (`: ping`) cada 10s para que un proxy
  no corte la conexión en los huecos largos. La mayoría de clientes SSE ya los descartan solos.
- **Cortá el bucle con `event` = `done`, `error` o `stream_timeout`.**
- `stream_timeout` (a los 300s) **no significa que el trámite falló**: solo se cerró el stream.
  Seguí con `GET /api/jobs/{id}`.
- Si usás `EventSource` del navegador y se reconecta, **vas a recibir todo el historial otra vez**
  (el cursor arranca en 0). Deduplicá por `ts` + `event`.
- **404** si el job no existe.

### 3.6 `POST /api/seleccionar_predio`

Segundo paso cuando la búsqueda devolvió varios predios.

| Parámetro | Dónde | Obligatorio |
|---|---|---|
| `session_id` | body | **sí** — el que vino en `multiple_predios` |
| `index` | body | **sí** — el campo `index` del predio elegido |
| `phone`, `email` | body | de facto sí (igual que §3.3) |
| `mode` | query o body | no — soporta `fast` y `async` |

- **404**: `"La sesión ha expirado por inactividad..."`. Las sesiones mueren a los **5 minutos**.
- **422**: `index` no entero, negativo, o fuera de rango. **Estos rechazos NO consumen la sesión**,
  así que podés corregir y reintentar.
- La sesión es de **un solo uso**: se consume al llamar con un índice válido. Un segundo intento con
  el mismo `session_id` da 404.
- ⚠️ **No acepta `q` ni `cliente`**: el municipio ya viene en la sesión.

### 3.7 `GET /facturas/{filename}`

El PDF. Armá la URL con el `filename` **que te devolvió la respuesta**.

> ⚠️ **No adivines el nombre.** En el camino normal lo pone el portal (`Factura3205346.pdf`), no el
> bot. Solo en un camino alterno es `factura_predial_<search_value>.pdf`.

Otras dos advertencias:

- **Las facturas se borran a los 30 minutos.** Si tu chatbot necesita conservarla, descargala.
- **Los nombres no son únicos.** Dos trámites del mismo predio se sobreescriben, y `/facturas/` no
  tiene autenticación: quien sepa un nombre de archivo puede bajar esa factura. Ver §9.

### 3.8 `POST /api/imprimir_factura`

Manda el PDF a una impresora **física del servidor**. No sirve para un chatbot; ignoralo.

---

## 4. Flujo recomendado para un chatbot (con SSE)

```
1. El usuario dice "quiero mi factura de predial"
   └── POST /api/prewarm?cliente=floridablanca          (fire and forget)

2. Le pedís lo que necesitás: tipo de búsqueda, código, teléfono, correo
   └── mientras habla, el captcha ya se está resolviendo

3. POST /api/generar_factura?mode=async   → job_id

4. GET /api/jobs/{job_id}/stream
   └── por cada evento, actualizás el mensaje al usuario (§6)

5. En pdf_ready     → ya podés decir el monto y enviar el PDF
6. En payment_ready → mandás el link/QR de pago (si vino)
7. En done          → cerrás
```

---

## 5. Los tres desenlaces posibles

### 5.1 Predio único → factura (el caso normal)

`search_done` con `outcome: "predio_unico"`, y después el flujo completo.

### 5.2 No se encontró nada

`search_done` con `outcome: "no_encontrado"` y después un error. **No reintentes**: el dato está mal.
Pedile al usuario que verifique y ofrecele otro tipo de búsqueda (si buscó por Código Predial,
proponele por Número de Cuenta).

### 5.3 Varios predios → hay que elegir

`search_done` con `outcome: "multiples_predios"`. El resultado trae `session_id` + `predios`:

```json
{
  "status": "multiple_predios",
  "session_id": "a1b2...",
  "predios": [
    { "index": 0, "data": { "Direccion": "CL 10 # 5-20", "Deuda actual": "$1.234.567", "Matricula": "300-12345" } },
    { "index": 1, "data": { "Direccion": "CR 8 # 3-15",  "Deuda actual": "$0",         "Matricula": "300-67890" } }
  ]
}
```

> ⚠️ **Cada predio es `{index, data}`, no un objeto plano.** Las columnas están dentro de `data`, y
> sus nombres son los encabezados que muestra el portal — **no están garantizados** y pueden variar
> por municipio (las que no tienen encabezado salen como `col_0`, `col_1`, …). No hardcodees nombres
> de columna: iterá `data` y mostrale al usuario lo que haya.

Es **frecuente al buscar por Propietario**: una persona puede tener varios inmuebles. Mostrale
dirección y deuda para que reconozca cuál es, y mandá el `index` del elegido a
`POST /api/seleccionar_predio`. **Tenés 5 minutos.**

---

## 6. Cronología real y qué decirle al usuario

Los tiempos son medidos. Cada evento es un hecho real del portal, así que los mensajes basados en
ellos son verdad — no un temporizador falso.

| # | Evento | Llega a los... | Qué pasó | Mensaje sugerido |
|---|---|---|---|---|
| 1 | `started` | 0s | Un worker tomó el trabajo | *"Listo, voy a buscar tu predio en el portal de la alcaldía. Esto toma alrededor de medio minuto."* |
| 2 | `portal_ready` | 0–7s | El portal cargó | *"Ya entré al portal…"* |
| 3 | `captcha_ready` | 0–20s ⚠️ | Se resolvió el reCAPTCHA | *"Pasé la validación de seguridad."* |
| 4 | `search_done` | +3–7s | El portal respondió la búsqueda | *"Encontré tu predio."* |
| 5 | `invoice_ready` | +8–20s | Se generó la liquidación | *"El portal está calculando tu liquidación. Es la parte más lenta: está sumando año por año."* |
| 6 | `pdf_ready` | +3–5s | **PDF en disco + monto real** | *"¡Listo! Tu factura quedó en $66.122.546. Te la envío."* |
| 7 | `payment_ready` | +4s | Link y QR de pago | *"Y acá tienes el link para pagar en línea por PSE."* |
| 8 | `done` | — | Fin | — |

**El paso 3 es el impredecible.** Lo resuelve un servicio externo y se ha medido entre 0.0s y 18.7s
para el mismo portal el mismo día. Con `/api/prewarm` suele ser ~0s.

### Campos de cada evento

Todos llevan `event` y `ts` (epoch en segundos), más:

| Evento | Campos extra |
|---|---|
| `started` | `client_id`, `warm` (fase 1) — o `fase: 2`, `predio_index` (fase 2) |
| `portal_ready` | `warm` |
| `captcha_ready` | `prewarmed`, `token_listo` |
| `search_done` | `outcome`: `predio_unico` \| `multiples_predios` \| `no_encontrado` |
| `invoice_ready` | *(ninguno — es solo un marcador de fase)* |
| `pdf_ready` | `filename`, `file`, **`amount`** |
| `payment_ready` | `payment_url`, `payment_qr` (cualquiera puede ser `null`) |
| `done` / `error` | `message`, `result` (los sintetiza el stream, no el flujo) |

> ⚠️ **`invoice_ready` no trae el monto, a propósito.** En ese instante el portal todavía muestra
> `$0`. El monto confiable es el de `pdf_ready`.

> ⚠️ **Un job de `/api/seleccionar_predio` NO emite `portal_ready`, `captcha_ready` ni
> `search_done`** — esa fase reusa la sesión ya abierta, así que se salta la navegación, el captcha y
> la búsqueda. Emite `started` con `fase: 2` y salta directo a `invoice_ready`. Si tu consumidor
> espera los cuatro primeros eventos, se cuelga en todos los trámites de múltiples predios.

### Mensajes de relleno mientras no llega nada

Entre `invoice_ready` y `pdf_ready` puede haber ~20s sin eventos. Si tu chat necesita mostrar algo,
rotá mensajes cada ~6s. **Que sean honestos sobre que se está esperando:**

- *"Sigo esperando al portal de la alcaldía…"*
- *"El portal está liquidando la deuda año por año, ya casi."*
- *"Esto es normal, el portal es lento con predios de muchos años."*

Lo que **no** hay que hacer: inventar porcentajes (*"45% completado"*) ni prometer tiempos exactos
(*"faltan 10 segundos"*). No hay forma de saberlo y queda peor cuando falla.

---

## 7. Si no podés usar SSE (solo `mode=fast`)

Perdés el progreso real, así que hay que caer a mensajes por tiempo. Mandá uno al empezar y después
uno cada ~8s mientras esperás la respuesta del POST:

| t | Mensaje |
|---|---|
| 0s | *"Voy a buscar tu predio en el portal. Tarda entre 30 y 45 segundos, te aviso en cuanto tenga la factura."* |
| 10s | *"Ya estoy dentro del portal, buscando tu predio…"* |
| 20s | *"Encontrado. Ahora el portal está calculando la liquidación, que es la parte lenta."* |
| 30s | *"Ya falta poco, generando el recibo…"* |

Cuando llegue el 200 con `payment_pending: true`: mandá la factura y el monto de una, y arrancá el
poll de `GET /api/jobs/{job_id}` para el QR.

---

## 8. Modos de falla y qué responder

Salvo los indicados, llegan como **500** con `{"status": "error", "message": "..."}`.

| Qué dice el `message` | Qué pasó | ¿Reintentar? | Qué decirle al usuario |
|---|---|---|---|
| `...Se esta procesando una transacción con la pasarela de pago...` | Ya se abrió una sesión de pago PSE para ESE predio | **No antes de 1 hora.** Es lo medido, aunque el portal diga "unos minutos" | *"Ya hay un pago en proceso para este predio. Si acabás de generar la factura, usá ese link; si no, hay que esperar un rato."* |
| `El botón 'Generar Factura' no se habilitó; el predio podría estar a paz y salvo o sin deuda pendiente.` | **El predio no debe nada** | No | *"¡Buenas noticias! Este predio está al día, no tiene deuda pendiente."* — no lo presentes como error |
| `Error del portal: No se encontró el valor de búsqueda: <valor>` | El código/cédula no existe en ese municipio | No | *"No encontré ese predio en <municipio>. ¿Verificamos el número, o lo buscamos por otro dato?"* |
| `El portal no permitió generar la factura: <texto>` | Regla de negocio del portal | No | Repetile el texto del portal, es informativo |
| `El portal abandonó la página de factura durante la generación del recibo` | El portal se cayó a mitad del trámite | **Sí**, una vez, tras ~30s | *"El portal se cortó a mitad del proceso. Lo intento de nuevo."* |
| `No apareció el popup de éxito con el botón 'Descargar recibo'...` | Timeout generando el recibo | **Sí**, una vez | Igual que el anterior |
| `El worker de CAPSOLVER retornó None o falló.` | Falló la resolución del captcha | **Sí**, de inmediato | *"Tuve un problema con la validación de seguridad, reintento."* |
| `Error esperando respuesta del portal: ...` | El portal no respondió la búsqueda | **Sí**, tras ~15s | *"El portal está lento. Reintento."* |
| **422** `'X' no es un tipo de búsqueda válido para 'Y'. Opciones: ...` | Mandaste un `search_type` de otro municipio | No — corregí el código | Usá el campo `search_types` de la respuesta |
| **422** `Los campos 'search_type' y 'search_value' son obligatorios.` | Bug tuyo | No | — |
| **422** `'index' fuera de rango` / `no puede ser negativo` / `debe ser un entero` | Índice mal | Sí, con el índice corregido — **la sesión sigue viva** | — |
| **404** `La sesión ha expirado por inactividad...` | Pasaron >5 min eligiendo predio | Rehacer desde la búsqueda | *"Se venció el tiempo para elegir. Hagamos la búsqueda otra vez."* |
| **404** `El job no existe o ya expiró.` | Pasaron >15 min | No | — |
| **500 sin JSON** (HTML de error) | El pool no arrancó, o Chromium murió | No — es un problema de infraestructura | *"Tengo un problema técnico, intentá en unos minutos."* |

**Regla general de reintentos:** máximo **un** reintento, y solo para los marcados arriba. Nunca en
bucle: cada intento abre un navegador, gasta un captcha pagado y **degrada el portal** (está medido:
facturas repetidas sobre el mismo predio hacen que la generación del recibo pase de 2.6s a 32s).

---

## 9. Trampas — leé esto antes de integrar

1. **`amount` es un string de pesos sin separadores**: `"66122546"` = $66.122.546. Sin decimales ni
   símbolo. Formatealo vos.
2. **`payment_url` puede venir `null` en un trámite exitoso**, y `payment_qr` puede ser `null` con
   `payment_url` poblada. Son independientes. La factura sirve igual.
3. **El monto de `invoice_ready` no existe.** Si tu código lo busca ahí, lee `undefined`. Es
   deliberado (§6).
4. **`job.status == "done"` no quiere decir que salió bien.** Mirá `job.result.status`.
5. **`predios[i]` es `{index, data}`**, y los nombres de columna dentro de `data` no están
   garantizados (§5.3).
6. **`filename` lo pone el portal.** No lo construyas (§3.7).
7. **Las facturas se borran a los 30 min** y los jobs a los 15. Descargá el PDF si lo necesitás después.
8. **`timings` no es un mapa de números.** Mezcla floats (`nav`, `paso_a`), booleanos (`warm_page`,
   `captcha_prewarmed`, `captcha_token_listo`, `amount_inestable`), un entero (`a3_7_intentos`) y un
   string (`b0_estado`). Y **las claves son condicionales**: varias desaparecen según el camino. Si
   iterás asumiendo números, rompe. Dos detalles útiles:
   - la **ausencia** de `captura_link_pago` es la señal machine-readable de que el pago PSE quedó
     bloqueado;
   - en una respuesta de `/api/seleccionar_predio`, `timings` **incluye las marcas de la búsqueda
     original** (otra petición HTTP, quizá minutos antes). Sumarlas para medir la fase 2 da un número
     inventado.
9. **No hay autenticación en ningún endpoint**, `/facturas/` sirve archivos estáticos y con
   `ALLOWED_ORIGINS` sin definir el CORS es `*`. Si esto sale a internet, ponelo detrás de un
   gateway con auth. `POST /api/imprimir_factura` dispara una impresión física sin credencial.
10. **Sin timeout de servidor y sin cancelación** (§1).
11. **`q` (query) pisa a `cliente` (body).** Elegí uno y sé consistente.
12. **Un `mode` desconocido cae al modo clásico en silencio** — vas a esperar 40s creyendo que pediste
    el rápido.
13. **Cada trámite deja gasto de CAPSOLVER corriendo ~300s** después (resolución especulativa para la
    siguiente consulta del mismo municipio). Es intencional y hace rápidas las ráfagas; se apaga con
    `RPA_PREWARM_ON_USE=0`.

---

## 10. Ejemplos

### curl — modo rápido

```bash
curl -s -X POST "http://localhost:8000/api/generar_factura?mode=fast" -d "search_type=Código NUPRE" -d "search_value=BWA0001HSYB" -d "phone=3101234567" -d "email=usuario@ejemplo.com" -d "cliente=floridablanca"
```

### curl — streaming

```bash
curl -s -N "http://localhost:8000/api/jobs/PEGAR_JOB_ID/stream"
```

### Python — chatbot con SSE

```python
import json
import requests

BASE = "http://localhost:8000"

# 1. Prewarm en cuanto el usuario muestra intención
requests.post(f"{BASE}/api/prewarm", params={"cliente": "floridablanca"}, timeout=10)

# 2. Lanzar el trámite
r = requests.post(f"{BASE}/api/generar_factura", params={"mode": "async"}, data={
    "search_type": "Código NUPRE",
    "search_value": "BWA0001HSYB",
    "phone": "3101234567",
    "email": "usuario@ejemplo.com",
    "cliente": "floridablanca",
}, timeout=30)
r.raise_for_status()
job_id = r.json()["job_id"]

MENSAJES = {
    "started":       "Voy a buscar tu predio en el portal de la alcaldía…",
    "portal_ready":  "Ya entré al portal.",
    "captcha_ready": "Pasé la validación de seguridad.",
    "search_done":   "Encontré tu predio.",
    "invoice_ready": "El portal está calculando tu liquidación; es la parte más lenta.",
}

# 3. Seguir el progreso en vivo. timeout generoso: no hay tope del lado del servidor.
with requests.get(f"{BASE}/api/jobs/{job_id}/stream", stream=True, timeout=310) as s:
    for linea in s.iter_lines(decode_unicode=True):
        # Las líneas vacías separan eventos; las que empiezan con ':' son heartbeats.
        if not linea or not linea.startswith("data: "):
            continue
        evt = json.loads(linea[6:])
        tipo = evt["event"]

        if tipo in MENSAJES:
            enviar_al_usuario(MENSAJES[tipo])

        elif tipo == "pdf_ready":
            monto = int(evt["amount"]) if evt.get("amount") else None
            if monto is not None:
                enviar_al_usuario(f"¡Listo! Tu factura es de ${monto:,}".replace(",", "."))
            enviar_archivo(f"{BASE}/facturas/{evt['filename']}")

        elif tipo == "payment_ready":
            if evt.get("payment_url"):        # puede venir null
                enviar_al_usuario(f"Podés pagar en línea acá: {evt['payment_url']}")

        elif tipo == "error":
            enviar_al_usuario(traducir_error(evt.get("message", "")))
            break

        elif tipo in ("done", "stream_timeout"):
            break
```

### Python — múltiples predios

```python
r = requests.post(f"{BASE}/api/generar_factura", data={
    "search_type": "Propietario", "search_value": "64741384", "cliente": "apartado",
    "phone": "3001234567", "email": "usuario@ejemplo.com",
}, timeout=180)
data = r.json()

if data["status"] == "multiple_predios":
    # OJO: cada predio es {"index": N, "data": {...}} y las columnas no están garantizadas.
    for p in data["predios"]:
        d = p["data"]
        resumen = " · ".join(f"{k}: {v}" for k, v in list(d.items())[:3] if v)
        enviar_al_usuario(f"[{p['index']}] {resumen}")

    indice = pedir_eleccion_al_usuario()   # ¡tenés 5 minutos!

    r2 = requests.post(f"{BASE}/api/seleccionar_predio", params={"mode": "fast"}, data={
        "session_id": data["session_id"], "index": indice,
        "phone": "3001234567", "email": "usuario@ejemplo.com",
    }, timeout=180)
    # Un 422 acá (índice malo) NO consume la sesión: podés corregir y reintentar.
```

---

## 11. Levantar el servidor

```bash
venv/Scripts/python.exe app.py
```

Queda en `http://localhost:8000` (frontend en `/`, API en `/api/*`). Variables útiles:

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | `8000` | Puerto |
| `RPA_WORKERS` | `2` | Trámites simultáneos. Cada uno es un Chromium (~150-300MB) |
| `CAPSOLVER_API_KEY` | — | **Obligatoria.** Sin ella no se resuelve el captcha |
| `ALLOWED_ORIGINS` | `*` | CORS. Restringilo en producción |
| `RPA_CAPTURE_PAYMENT_LINK` | `1` | En `0` no reserva PSE (útil para probar sin bloquear predios) |
| `RPA_ACTIVITY_WINDOW` | `300` | Segundos que un municipio queda "caliente" tras una consulta |
| `RPA_PREWARM_ON_USE` | `1` | En `0` corta el gasto especulativo de CAPSOLVER |
| `RPA_STREAM_HEARTBEAT` | `10` | Segundos entre `: ping` del SSE |

**Un solo worker de uvicorn.** El pool de navegadores vive en el proceso; con `--workers 2` tendrías
dos pools duplicando la RAM.
