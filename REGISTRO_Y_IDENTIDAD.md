# Registro de conversaciones e identificación del ciudadano

Estado: **implementado y probado, pendiente de apuntar al backend**.

El destino del almacenamiento aún no está definido (solo se sabe que estará alojado en
Cloud Run), así que todo está listo y desactivado por defecto. Para activarlo no hay que
tocar código: basta configuración.

```bash
npm run test:security
```

---

## 1. Cómo activarlo

### Desarrollo — ver qué se guardaría, sin backend

Crea `.env.local` (ya está en `.gitignore`):

```
VITE_PERSISTENCE_MODE=console
```

Los registros se imprimen en la consola del navegador y quedan inspeccionables en
`window.__aviChatbotRecords`. Nada sale del navegador.

### Producción — apuntar al backend

```
VITE_PERSISTENCE_MODE=http
VITE_CONVERSATION_API_URL=https://tu-servicio.a.run.app
```

Si pones `http` sin URL, el sistema **no** improvisa un destino: registra un error y se
queda en `off`. Es deliberado — mejor no guardar que enviar datos personales a un sitio
indeterminado.

### Modos disponibles

| Modo | Qué hace |
|---|---|
| `off` | No se guarda nada. **Valor por defecto.** |
| `console` | Imprime en consola lo que se enviaría. Solo desarrollo. |
| `http` | Envía al backend, con cola durable y reintentos. |

El valor por defecto es `off` a propósito: que un despliegue empiece a acumular
conversaciones con nombre y correo porque nadie desactivó la persistencia es el tipo de
error que en un proyecto público sale caro.

---

## 2. Contrato que debe exponer el backend

Dos endpoints:

```
POST {base}/api/v1/conversations
     cuerpo: ConversationEnvelope
     debe ser idempotente por conversationId (upsert, no insert)

POST {base}/api/v1/conversations/{conversationId}/messages
     cuerpo: { messages: ConversationMessageRecord[] }
     debe DEDUPLICAR por messageId
```

Las formas exactas están en [conversationRecord.js](src/domain/conversation/conversationRecord.js).
Para ver payloads reales, corre en modo `console` y mira `window.__aviChatbotRecords`.

### Cuatro requisitos que el frontend no puede garantizar

**1. Deduplicar por `messageId`.** El cliente reintenta hasta recibir confirmación, así
que sin deduplicación una red inestable produce mensajes repetidos. Un registro con
duplicados pierde valor como prueba.

- Firestore: `doc(messageId).set(...)`
- Postgres: clave única + `INSERT ... ON CONFLICT DO NOTHING`

**2. Estampar `receivedAt` con el reloj del servidor.** El `occurredAt` que envía el
cliente lo controla el navegador del usuario: puede ir atrasado, adelantado o cambiar a
mitad de conversación. No tiene valor probatorio. Conserva ambos — la diferencia entre
uno y otro es en sí misma una señal útil.

**3. Cifrado en reposo y política de retención.** Los registros llevan nombre, correo y
—con frecuencia— la cédula que el ciudadano escribió en el chat. En Firestore hay TTL
nativo; úsalo, para que la retención no dependa de un cron que alguien olvide.

**4. Límite de tasa por IP y CORS.** Es un endpoint público: el widget corre en el
navegador de cualquiera. Y **nunca confíes en el `tenantId` que envía el cliente** sin
cruzarlo contra el origen de la petición.

### Sobre la autenticación

Este endpoint no puede autenticarse desde el navegador sin exponer la credencial — es el
mismo problema que la clave de Gemini (ver [SECURITY.md](SECURITY.md), H-01). Lo viable
es que sea público, con límite de tasa y validación estricta del cuerpo.

---

## 3. Garantía de entrega: no se pierde nada

El registro es evidencia, así que perder un mensaje es peor que duplicarlo. El flujo es:

1. Escribir en la cola de IndexedDB ← **el registro ya está a salvo aquí**
2. Intentar enviarlo
3. Borrarlo de la cola **solo tras confirmación**

Nunca al revés. Si el paso 2 falla, se reintenta con retardo creciente (2s → 60s), y
sobrevive a una recarga o a un cierre de pestaña. También se vacía al pasar la pestaña a
segundo plano y al recuperar la conexión.

La entrega es **"al menos una vez"**, y de ahí viene el requisito de deduplicación.

Verificado en la suite (sección 18): con el backend caído los tres registros quedan en
cola y nada se entrega; al recuperarse se entregan los tres, la cabecera antes que sus
mensajes, en orden de secuencia, y un vaciado posterior no duplica.

**Límite conocido:** el widget se embebe en portales de terceros, así que la cola vive en
el origen del portal anfitrión. Su JavaScript puede leerla, y si el ciudadano limpia los
datos del sitio, desaparece. Por eso la cola es solo un búfer de entrega: **la copia con
valor probatorio es la del servidor.** Un registro sin confirmar todavía no es evidencia.

---

## 4. Identificación del ciudadano

Se configura por tenant en `src/config/chatbotConfig.json`:

```json
"identity": { "mode": "gate" }
```

| Modo | Comportamiento |
|---|---|
| `gate` | Formulario al abrir el chat. Teclado y botones bloqueados hasta entregarlo. **Actual.** |
| `gate_skippable` | Igual, con botón "Continuar sin registrarme". |
| `progressive` | Arranca anónimo; pide los datos solo al entrar a Predial o PQRSD. |
| `off` | No se piden. Conversación anónima. |

Está en `gate` porque es lo que se pidió: nombre y correo al empezar el chat. Cambiar de
modo es editar esa línea.

**Vale la pena medirlo.** Una puerta en el mensaje cero cuesta conversión: la mayoría de
ciudadanos entra a preguntar algo simple como cuándo vence el predial, que no requiere
identidad. `progressive` captura el mismo dato —porque Predial y PQRSD sí lo exigen— sin
frenar a quien solo viene a consultar. Si ves caídas de uso, ahí tienes la palanca.

En cualquier modo, la identidad **prellena** los formularios de Predial y PQRSD, así que
nunca se pide el correo dos veces.

### La identidad no se guarda en el navegador

Nombre y correo viven solo en memoria durante la sesión. No van a `localStorage` ni a
`sessionStorage` a propósito: ese almacenamiento pertenece al origen del portal
anfitrión, y su JavaScript podría leerlo. Guardar ahí datos del ciudadano sería
entregárselos a un tercero sin que nadie lo autorizara.

La consecuencia es que al recargar se vuelven a pedir. Es el precio correcto: la copia
que debe persistir es la del servidor, bajo control de la Alcaldía. Sí se conserva el
`conversationId` en `sessionStorage`, porque es un identificador opaco sin información
personal y evita que una recarga parta el registro en dos.

---

## 5. Autorización de tratamiento (Ley 1581 de 2012)

La casilla de autorización es **obligatoria y viene desmarcada**. Una casilla ya marcada
no es una manifestación de voluntad de nadie: es una que el ciudadano no llegó a tomar.
Por el mismo motivo el texto completo se muestra en pantalla y no detrás de un enlace.

Cada autorización se registra con lo necesario para **demostrarla**, que es lo que suele
olvidarse: un `consentGiven: true` no dice cuándo, ni a qué texto, ni para qué.

```json
{
  "noticeVersion": "2026-08-11.v1",
  "acceptedAt": "2026-08-11T15:57:06.899Z",
  "purposes": ["atender_solicitud", "notificar_resultado", "conservar_registro_atencion"],
  "mechanism": "formulario_identidad",
  "noticeChecksum": "fnv1a-e19e0f9a"
}
```

El aviso está **versionado** y lleva **huella del texto exacto**. Si alguien edita la
redacción sin subir la versión, la huella cambia y queda en evidencia; y las
autorizaciones antiguas siguen apuntando a la versión que la persona realmente leyó.

**Al cambiar el texto del aviso**, incrementa `PRIVACY_NOTICE_VERSION` en
[consentRecord.js](src/domain/consent/consentRecord.js).

### Lo que sigue siendo responsabilidad de la Alcaldía

El código deja el registro en condiciones. Lo que falta no es técnico:

1. **Publicar la Política de Tratamiento de Datos** y poner su URL en
   `identity.policyUrl`. Ahora está vacía y el enlace no se muestra.
2. **Definir el plazo de retención.** `persistence.retentionNoticeDays` está en 365 como
   valor de partida, no como decisión jurídica. Debe corresponder a la finalidad
   declarada.
3. **Atender derechos de acceso, corrección y supresión.** Un ciudadano puede exigir que
   se borren sus datos. Hace falta un procedimiento y alguien que lo ejecute.
4. **Valorar el registro en el RNBD** ante la Superintendencia de Industria y Comercio,
   según el volumen de titulares.
5. **Revisar la transferencia internacional.** GCP no tiene región en Colombia;
   `southamerica-east1` (São Paulo) es la más cercana. El artículo 26 de la Ley 1581
   restringe transferencias a países sin nivel adecuado de protección.

Nada de esto lo puede resolver el frontend, pero sin ello el registro no cumple.

---

## 6. Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Contrato de persistencia | [ConversationRepositoryPort.js](src/ports/ConversationRepositoryPort.js) |
| Forma de los registros | [conversationRecord.js](src/domain/conversation/conversationRecord.js) |
| Adaptador HTTP | [HttpConversationRepository.js](src/adapters/persistence/HttpConversationRepository.js) |
| Cola durable y reintentos | [OutboxConversationRepository.js](src/adapters/persistence/OutboxConversationRepository.js) |
| Selección de destino | [createConversationRepository.js](src/adapters/persistence/createConversationRepository.js) |
| Identidad y validación | [citizenIdentity.js](src/domain/identity/citizenIdentity.js) |
| Autorización | [consentRecord.js](src/domain/consent/consentRecord.js) |
| Modos de identificación | [useCitizenIdentity.js](src/hooks/useCitizenIdentity.js) |
| Formulario | [IdentityCard.jsx](src/components/molecules/IdentityCard.jsx) |

Para cambiar de destino de almacenamiento se escribe un adaptador nuevo y se registra en
`createConversationRepository`. Ni la aplicación ni los adaptadores existentes cambian.
