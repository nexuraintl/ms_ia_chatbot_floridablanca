# Registro de chats en MySQL

Actualizado el 6 de octubre de 2026.

El esquema proporcionado por el usuario se obtuvo con el conector de Google Drive:
[archivo SQL original](https://drive.google.com/file/d/1GrLP9Hp5HSELJK0AMSpPWYmZTFwCWJIo/view).
La copia local está en [sql/chat.sql](sql/chat.sql). Se leyó el archivo; no se
ejecutó el CREATE TABLE ni se modificó una base remota.

## Estado

El servidor y el widget están adaptados al esquema. La configuración de QA ya identifica la VM MySQL/MariaDB, el secreto DB_PASS y el
conector VPC. Cloud Build activa `http` y el widget usa el origen de su backend si
no hay una URL de conversaciones explícita. La conexión y escritura en la instancia
real todavía deben verificarse; las pruebas automáticas usan un pool simulado.

- Base: `ia_chatbot_floridablanca`.
- Tabla: `chat`, una fila por conversación.
- Mensajes: JSON de objetos `{ id, sender, text, at }`; `at` es la recepción en UTC
  según el reloj del servidor, no el reloj del navegador.
- Identidad: `citizen_name`, `citizen_email`.
- Consentimiento: `consent_version`, `consent_at`; el esquema no conserva la huella
  ni todas las finalidades del objeto de consentimiento del frontend.
- Trámites iniciados: `rpa_flows`, derivados de los componentes de trámite del chat.
  No acredita que un RPA haya terminado correctamente.
- `duration_seconds`, `used_rpa`, `message_count` se generan en MySQL; no se escriben.

## Flujo y carga

**Widget → API de este servidor → MySQL.** Las credenciales nunca llegan al bundle.

Se guardan mensajes durante la conversación. Al abandonar la página se intenta
un último envío; el guardado no depende de recibir el evento de cierre del navegador.
La cola IndexedDB sobrevive a una recarga y recupera pendientes al arrancar.
Si IndexedDB no está disponible, la cola funciona en memoria y se pierde al cerrar.
Si se borran los datos del sitio, desaparece también la cola local.

El pool tiene un máximo de 5 conexiones por instancia por defecto, con hasta 50
solicitudes esperando conexión. El máximo total debe calcularse multiplicando
`DB_CONNECTION_LIMIT` por el máximo de instancias del servicio y comparándolo con
la capacidad disponible en MySQL. En cada tanda se bloquea la fila y se deduplica
por ID antes del commit. La cola envía tandas de hasta 50 elementos, cuando están
disponibles; en una conversación normal puede enviar un mensaje por petición.

La tabla guarda el historial como JSON y cada tanda vuelve a escribir ese arreglo.
Esto aumenta el costo de las conversaciones largas. Hay un límite de 2000 mensajes
o 8 MiB de JSON por conversación; superarlo responde 413 y exige intervención o
iniciar una conversación nueva. No se descartan automáticamente los pendientes.
Una carga alta debe medirse en la instancia real; el pool no sustituye esa medición.

## Configuración

En el servidor, mediante variables de runtime:

```dotenv
DB_HOST=<host-real>
DB_PORT=3306
DB_USER=<usuario>
DB_PASS=<secreto>
DB_NAME=ia_chatbot_floridablanca
DB_TABLE=chat
DB_TENANT_ID=floridablanca
DB_CONNECTION_LIMIT=5
DB_SSL_MODE=required
CONVERSATION_RATE_LIMIT_PER_MINUTE=120
```

`DB_PORT=3306` es el valor de ejemplo; confirmar el puerto real. TLS se verifica
por defecto. Si la instancia usa una CA propia, montar el certificado y configurar
`DB_SSL_CA_FILE`. Para un socket Unix de Cloud SQL montado por la infraestructura,
usar `DB_SOCKET_PATH` en lugar del host y configurar el modo de transporte según
ese canal. No se montan instancias ni se cambian permisos de infraestructura aquí.

Cloud Run debe recibir `DB_USER` y `DB_PASS` desde Secret Manager. El pipeline usa
`--update-env-vars` y `--update-secrets` para conservar los valores DB_* y las
referencias de secretos configuradas en el servicio. No se añadieron credenciales
al pipeline. La imagen incluye `mysql2` como dependencia de producción.

En el build del navegador, después de verificar el servidor:

```dotenv
VITE_PERSISTENCE_MODE=http
VITE_CONVERSATION_API_URL=https://<url-publica-del-servidor>
```

La URL debe ser la API del widget, nunca el host SQL. Al estar embebido en otro
portal, una ruta relativa usaría el origen de ese portal. Configurar también
`ALLOWED_ORIGINS` para los portales autorizados y `TRUSTED_PROXY_HOPS` para la
infraestructura que ya sirve el servicio.

Para ejecutar localmente con variables en `.env`, sin publicar credenciales:

```powershell
node --env-file=.env server/index.js
```

La tabla debe existir con el esquema confirmado. El servidor no crea ni migra
tablas automáticamente. Si no están completos los datos de conexión, las rutas
responden 503 `persistence_not_configured` y el resto del widget sigue funcionando.

## API y garantías

| Ruta POST | Operación |
|---|---|
| `/api/v1/conversations` | Abre la fila y actualiza identidad/consentimiento |
| `/api/v1/conversations/{id}/messages` | Añade mensajes nuevos sin duplicarlos |
| `/api/v1/conversations/{id}/close` | Marca el cierre al reiniciar la conversación |

Los POST reciben JSON y admiten preflight OPTIONS. Hay validación de tamaño,
origen, identificadores, tenant, emisor y longitud de texto, además de límite por IP.
La lectura de historiales está en la API administrativa y exige una credencial Bearer. El servidor fija el tenant;
una fila de otro tenant no puede actualizarse. La respuesta de éxito llega tras
el commit. Los errores SQL y los textos del ciudadano no se escriben en los logs
de esta API.

`redacted_at` impide que un reintento restaure una conversación suprimida. Esas
entregas se confirman como omitidas y no vuelven a introducir identidad ni texto.
La fecha inicial permanece estable. El contador y el ID se conservan en la sesión
del navegador, pero MySQL deduplica por ID y ordena por recepción.

El cierre al salir de la pestaña no se usa como señal fiable de fin: `ended_at`
se fija al reiniciar explícitamente el chat. Una política de cierre por inactividad
o de retención/supresión periódica requiere una tarea de servidor aún no incluida.

## Correcciones y validación

- IndexedDB confirma al completar la transacción y encola tandas atómicas.
- Los mensajes se marcan registrados después de encolarse; los fallidos conservan
  ID, secuencia y fecha para reintentar.
- La cabecera se encola antes de los mensajes; un cierre sigue a lo pendiente.
- Se recupera la cola de visitas anteriores al construir el repositorio.
- El inicio y la secuencia se mantienen al recargar la misma sesión.

`npm run test:conversations` cubre la API HTTP, validación, tenant, supresión,
deduplicación, rollback, sesión, reintentos y abortos de IndexedDB usando
`fake-indexeddb`. Las pruebas del repositorio SQL usan un pool simulado: no prueban
el protocolo MySQL, el DDL en un motor real, TLS ni la concurrencia de una instancia.
Build, lint y las pruebas del servidor también deben pasar antes del despliegue.
La suite de seguridad conserva un hallazgo previo sobre Gemini en modo desarrollo.

Para cerrar la integración faltan: comprobar esquema real con SHOW CREATE TABLE,
verificar conexión/TLS, guardar un chat de prueba y confirmar que su reenvío no
duplica mensajes. Esto se hará cuando se configuren los accesos de la instancia.

Referencias técnicas: [pool de mysql2](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool),
[bloqueos de fila InnoDB](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html),
[variables y secretos en gcloud run deploy](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy).

## Consulta y descarga administrativa

Abrir `<URL-publica-del-chatbot>/admin/chats/`. El panel permite paginar los chats,
filtrar por fechas UTC, correo exacto y uso de trámites RPA, y leer una conversación.
Los horarios se muestran en `America/Bogota`. El panel no cambia los registros.

| GET | Resultado |
|---|---|
| `/api/v1/admin/conversations` | JSON de resúmenes sin mensajes, con `items` y `nextCursor` |
| `/api/v1/admin/conversations/{id}` | JSON de una conversación y sus mensajes |
| `/api/v1/admin/conversations/export.csv` | Resúmenes para Excel; todos los chats del filtro hasta 10.000 |
| `/api/v1/admin/conversations/{id}/export.json` | Descarga de un chat completo |

Todas las rutas de datos exigen `Authorization: Bearer <clave-administrativa>`.
El servidor toma esa clave de `CONVERSATION_ADMIN_TOKEN`, entre 32 y 512 caracteres.
Ausente o demasiado corta: 503 `admin_not_configured`. Incorrecta: 401. No se usa
DB_PASS como clave administrativa, ni se reciben claves en parámetros de URL.

Configurar una clave aleatoria en Secret Manager y conceder a la service account
**existente** del chatbot acceso a ese secreto. Montarla como variable runtime
`CONVERSATION_ADMIN_TOKEN`. Se puede indicar el nombre del secreto en la sustitución
`_CONVERSATION_ADMIN_SECRET` del activador; vacía conserva la referencia runtime ya
configurada. El pipeline usa `--update-env-vars` y `--update-secrets` para preservar
el resto de la configuración. La clave nunca se incluye en variables VITE_, en el
repositorio, en el HTML o en logs. La comparte únicamente el equipo autorizado.
Este mecanismo es una clave compartida; no ofrece usuarios, roles ni auditoría por
persona. Para eso se requiere integrar identidad corporativa/IAP posteriormente.

La página pública contiene solo la pantalla de acceso. No guarda clave ni historiales
en localStorage o sessionStorage; al cerrar el acceso elimina la vista y cancela
peticiones pendientes. La API administrativa no hereda los orígenes públicos del
widget, tiene límite de 30 consultas por IP por minuto y respuestas `no-store`.

Filtros: `from=YYYY-MM-DD`, `to=YYYY-MM-DD` (día final inclusive, UTC), `email` exacto,
`usedRpa=true|false`, `limit` de 1 a 100 (50 por defecto), `cursor` devuelto en la
página previa. El tenant lo fija el servidor; no es un filtro aceptado. El cursor
usa fecha inicial e ID, sin OFFSET. La consulta del resumen no lee el JSON de mensajes.
CSV exporta la selección completa, no solo la página visible. Si supera 10.000 filas,
responde 413 `export_too_large` y pide acotar fechas; no trunca silenciosamente.
Incluye BOM UTF-8 y neutraliza fórmulas en las celdas de texto. Los datos suprimidos
no reaparecen en ninguna descarga. JSON incluye los mensajes del chat seleccionado.

Ejemplo con cliente HTTP: GET `<base>/api/v1/admin/conversations?from=2026-10-01&to=2026-10-06`
y cabecera `Authorization: Bearer <clave>`. Para descargar, usar las mismas cabeceras
en `/export.csv` o `/{id}/export.json`; el navegador del panel lo hace automáticamente.

### Prueba después del pipeline

1. Confirmar que `/version` contiene el commit publicado.
2. Configurar la clave administrativa y entrar al panel.
3. Si aparece `persistence_unavailable`, revisar conectividad VPC, privilegios de
   lectura/escritura de la tabla y TLS. `DB_SSL_MODE=required` verifica certificados
   por defecto. No se ha confirmado si la VM lo soporta; no se desactiva automáticamente.
   El arranque realiza una consulta sin filas para comprobar acceso y columnas. En
   Cloud Logging, `conversation_database_verified` confirma esa lectura; un fallo
   genera `conversation_persistence_unavailable` con un código conocido (por ejemplo,
   TLS o tabla ausente), nunca con contraseña, SQL, mensajes o datos de ciudadanos.
4. Verificar `SHOW CREATE TABLE chat` con un cliente autorizado. No se ejecuta DDL
   desde el servicio. Esquema esperado: `docs/sql/chat.sql`.
5. Iniciar un chat ficticio en el widget, enviar mensajes, recargar, confirmar en el
   panel que aparece una sola conversación sin duplicados y descargar CSV/JSON.

Validación local: suites de seguridad, servidor, RPA, conocimiento y conversaciones;
lint y build. Las pruebas del panel usan datos ficticios, no la base municipal.
