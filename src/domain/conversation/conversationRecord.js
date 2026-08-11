/**
 * Registro de conversación. Capa de dominio.
 *
 * Define la forma exacta de lo que se persiste. Al ser evidencia legal, el diseño
 * prioriza tres propiedades por encima de la comodidad:
 *
 *   1. IDEMPOTENCIA. Cada mensaje lleva un `messageId` estable. Si un reintento
 *      reenvía el mismo mensaje, el backend puede descartar el duplicado. Sin esto,
 *      una red inestable produce un historial con mensajes repetidos, y un registro
 *      con duplicados pierde credibilidad como prueba.
 *
 *   2. ORDEN VERIFICABLE. Cada mensaje lleva un `sequence` monótono dentro de su
 *      conversación. No se puede confiar en las marcas de tiempo del cliente para
 *      ordenar: el reloj del navegador lo controla el usuario y puede ir atrasado,
 *      adelantado o cambiar a mitad de conversación. La secuencia además permite
 *      detectar huecos, es decir, mensajes que nunca llegaron.
 *
 *   3. AISLAMIENTO MULTI-TENANT. `tenantId` va en cada registro, no solo en la
 *      conversación, para que ninguna consulta mal escrita pueda cruzar datos entre
 *      alcaldías.
 *
 * Sobre las marcas de tiempo: `occurredAt` es hora del CLIENTE y por tanto no es
 * confiable. El backend debe estampar su propio `receivedAt` al recibir el registro,
 * y ése es el que tiene valor probatorio. Se conservan ambos: la diferencia entre uno
 * y otro es en sí misma una señal útil.
 */

import { createMessageId } from "../messages/messageFactory.js";
import { truncate } from "../security/textSanitizer.js";

/**
 * Versión del esquema de los registros.
 * Incrementar ante cualquier cambio incompatible, para que el backend pueda migrar.
 */
export const RECORD_SCHEMA_VERSION = 1;

/** Tope de longitud del texto persistido por mensaje. */
const MAX_TEXT_LENGTH = 8000;

/**
 * @typedef {Object} ConversationMessageRecord
 * @property {number} schemaVersion
 * @property {string} tenantId
 * @property {string} conversationId
 * @property {string} messageId      Clave de idempotencia.
 * @property {number} sequence       Monótono dentro de la conversación, empieza en 0.
 * @property {string} occurredAt     ISO, reloj del cliente (no confiable).
 * @property {"user"|"bot"|"system"} sender
 * @property {string} text
 * @property {Object|null} metadata  Datos del mensaje que no son texto (adjuntos, formularios).
 */

/**
 * @typedef {Object} ConversationEnvelope
 * @property {number} schemaVersion
 * @property {string} tenantId
 * @property {string} conversationId
 * @property {string} startedAt
 * @property {import("../identity/citizenIdentity.js").CitizenIdentity|null} identity
 * @property {import("../consent/consentRecord.js").ConsentRecord|null} consent
 * @property {{pageUrl: string, locale: string}} context
 */

/**
 * Crea el identificador de una conversación.
 * @returns {string}
 */
export const createConversationId = () => createMessageId();

/**
 * Construye la cabecera de la conversación: los datos que no cambian mensaje a mensaje.
 * Se envía junto al primer registro y cada vez que la identidad o la autorización
 * cambian, de modo que el backend siempre pueda reconstruir el contexto.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.conversationId
 * @param {import("../identity/citizenIdentity.js").CitizenIdentity|null} [params.identity]
 * @param {import("../consent/consentRecord.js").ConsentRecord|null} [params.consent]
 * @param {string} [params.pageUrl]
 * @param {string} [params.startedAt]
 * @returns {ConversationEnvelope}
 */
export const createEnvelope = ({
  tenantId,
  conversationId,
  identity = null,
  consent = null,
  pageUrl = "",
  startedAt = new Date().toISOString()
}) => ({
  schemaVersion: RECORD_SCHEMA_VERSION,
  tenantId,
  conversationId,
  startedAt,
  identity,
  consent,
  context: {
    // La URL sitúa la atención, que es información útil en una auditoría.
    // Deliberadamente NO se recoge el user-agent ni la huella del dispositivo: no
    // aportan al registro de la atención y sí aumentarían la exposición.
    pageUrl: truncate(String(pageUrl || ""), 500),
    locale: "es-CO"
  }
});

/**
 * Construye el registro de un mensaje.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.conversationId
 * @param {number} params.sequence
 * @param {import("../messages/messageFactory.js").ChatMessage} params.message
 * @returns {ConversationMessageRecord}
 */
export const createMessageRecord = ({ tenantId, conversationId, sequence, message }) => ({
  schemaVersion: RECORD_SCHEMA_VERSION,
  tenantId,
  conversationId,
  // Se reutiliza el id del mensaje de la interfaz: así el registro y lo que el
  // ciudadano vio en pantalla son trazables entre sí, y el id ya es único.
  messageId: message.id,
  sequence,
  occurredAt: new Date().toISOString(),
  sender: message.sender,
  text: truncate(String(message.text ?? ""), MAX_TEXT_LENGTH),
  metadata: extractMetadata(message)
});

/**
 * Extrae los datos no textuales relevantes de un mensaje.
 *
 * No se persiste el mensaje entero a propósito: contiene props de React, callbacks y
 * los datos crudos de respuestas de los RPA (`pqrsdData`, `predios`), que abultarían
 * el registro y duplicarían información que ya vive en los sistemas de origen.
 *
 * @param {import("../messages/messageFactory.js").ChatMessage} message
 * @returns {Object|null}
 */
const extractMetadata = (message) => {
  const meta = {};

  if (message.customComponent) meta.component = message.customComponent;
  if (message.form?.type) meta.formType = message.form.type;
  if (message.attachment) {
    meta.attachment = {
      type: message.attachment.type,
      label: message.attachment.fileLabel || message.attachment.label || null
    };
  }
  if (message.buttonUrl) meta.hasActionButton = true;
  if (Array.isArray(message.quickReplies) && message.quickReplies.length > 0) {
    meta.quickRepliesOffered = message.quickReplies.length;
  }

  return Object.keys(meta).length > 0 ? meta : null;
};

/**
 * ¿Debe este mensaje formar parte del registro?
 *
 * Se excluyen los mensajes de bienvenida, que son texto fijo idéntico en toda
 * conversación y solo añadirían ruido a la evidencia.
 *
 * @param {import("../messages/messageFactory.js").ChatMessage} message
 * @returns {boolean}
 */
export const isRecordable = (message) => {
  if (!message?.sender) return false;
  if (typeof message.id === "string" && message.id.startsWith("welcome-")) return false;
  // Un mensaje sin texto ni componente no aporta nada al registro.
  return Boolean(message.text || message.customComponent || message.attachment);
};
